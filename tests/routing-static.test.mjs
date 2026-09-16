// Static routing test — no network, no credentials, always runs.
//
// The browser decides which Edge Function serves an action (assets/api.js), and
// the server decides which actions it implements. If those two lists drift, an
// action 404s or silently hits the wrong function. This test reads both sides
// off disk and asserts they agree, so the drift is caught at commit time rather
// than in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// These assertions are about what the code DOES, not what the comments say.
// Without stripping, a note explaining that jszip moved out reads as jszip
// still being present.
const code = (p) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
  .replace(/^\s*\/\/.*$/gm, "")        // whole-line comments
  .replace(/([^:])\/\/.*$/gm, "$1");    // trailing comments (leaves URLs alone)

/** Actions the client routes to each heavy function. */
function clientRoutes() {
  const src = read("assets/api.js");
  const block = src.match(/const HEAVY_ROUTES = \{([\s\S]*?)\n  \};/);
  assert.ok(block, "HEAVY_ROUTES not found in assets/api.js");
  const routes = {};
  const fnRe = /"([a-z-]+)":\s*new Set\(\[([\s\S]*?)\]\)/g;
  let m;
  while ((m = fnRe.exec(block[1]))) {
    routes[m[1]] = [...m[2].matchAll(/"([A-Za-z0-9_]+)"/g)].map((x) => x[1]);
  }
  return routes;
}

/** Actions a function actually implements. */
function serverActions(fn) {
  const src = read(`supabase/functions/${fn}/index.ts`);
  return new Set([...src.matchAll(/action === "([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
}

test("every client-routed action is implemented by the function it is sent to", () => {
  for (const [fn, actions] of Object.entries(clientRoutes())) {
    const implemented = serverActions(fn);
    for (const a of actions) {
      assert.ok(implemented.has(a), `assets/api.js routes "${a}" to ${fn}, which does not implement it`);
    }
  }
});

test("portal-api no longer implements the moved actions, but still names them", () => {
  const src = read("supabase/functions/portal-api/index.ts");
  for (const [fn, actions] of Object.entries(clientRoutes())) {
    for (const a of actions) {
      // The stale-client guard must remain: a "moved" reply, not silence.
      assert.ok(src.includes(`"${a}"`), `portal-api lost its moved-action guard for "${a}"`);
      assert.ok(new RegExp(`moved_to: "${fn}"`).test(src) || src.includes(`moved to ${fn}`),
        `portal-api does not point "${a}" at ${fn}`);
    }
  }
});

test("portal-api carries no heavy dependencies", () => {
  const src = code("supabase/functions/portal-api/index.ts");
  for (const dep of ["jszip", "pdf-lib", "cellar-service"]) {
    assert.ok(!src.includes(dep), `portal-api still imports ${dep} — the hot path pays for it on every call`);
  }
  for (const sym of ["JSZip", "PDFDocument"]) {
    assert.ok(!src.includes(sym), `portal-api still references ${sym}`);
  }
});

test("the heavy dependencies live in exactly one function each", () => {
  const ai = code("supabase/functions/portal-ai/index.ts");
  assert.ok(ai.includes("jszip") && ai.includes("pdf-lib"), "portal-ai should own document parsing");
  const cellar = code("supabase/functions/portal-cellar/index.ts");
  assert.ok(cellar.includes("cellar-service"), "portal-cellar should own the CELLAR client");
  assert.ok(!cellar.includes("jszip"), "portal-cellar should not pull in document parsing");
});

test("every function shares one auth, tenancy and CORS implementation", () => {
  for (const fn of ["portal-api", "portal-ai", "portal-cellar"]) {
    const src = read(`supabase/functions/${fn}/index.ts`);
    assert.ok(/_shared\/(auth|handler)\.ts/.test(src), `${fn} does not use the shared auth`);
    assert.ok(/_shared\/(http|handler)\.ts/.test(src), `${fn} does not use the shared CORS/JSON`);
    assert.ok(/_shared\/(tenant|handler)\.ts/.test(src), `${fn} does not use shared tenant scoping`);
  }
});

test("no function embeds a service-role key or secret literal", () => {
  for (const f of ["supabase/functions/_shared/env.ts", "supabase/functions/portal-api/index.ts",
                   "supabase/functions/portal-ai/index.ts", "supabase/functions/portal-cellar/index.ts",
                   "assets/api.js", "assets/config.js"]) {
    const src = code(f);
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(src), `${f} appears to contain a JWT literal`);
    assert.ok(!/service_role/i.test(src) || f.endsWith("env.ts"),
      `${f} mentions service_role outside the shared server-side client`);
  }
});

test("timing logs record phases, never payloads", () => {
  const src = read("supabase/functions/_shared/timing.ts");
  assert.ok(src.includes("total_ms"), "timing should record total request duration");
  for (const phase of ["db", "storage", "external", "docproc"]) {
    assert.ok(src.includes(`"${phase}"`), `timing is missing the ${phase} phase`);
  }
  for (const forbidden of ["body", "token", "password"]) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b\\s*[,:)]`).test(src.replace(/\/\/.*$/gm, "")),
      `timing.ts may be logging ${forbidden}`);
  }
});
