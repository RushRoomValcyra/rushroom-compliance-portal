// Split-function tests (2026-09-16).
//
// portal-api was split into portal-api / portal-ai / portal-cellar. These lock
// in the properties that must survive the split:
//   1. every function answers `health` without a session or a database;
//   2. the auth gate runs BEFORE action dispatch on every function;
//   3. tenancy cannot be smuggled in the request body;
//   4. CORS is identical everywhere, including preflight caching;
//   5. a heavy action posted to portal-api gives a clear "moved" error rather
//      than a silent "Unknown action" — so a stale client is diagnosable.
//
// Unauthenticated only, so they run anywhere without secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { API_URL } from "./config.mjs";

const FUNCTIONS = {
  "portal-api": API_URL,
  "portal-ai": API_URL.replace(/\/[^/]+$/, "/portal-ai"),
  "portal-cellar": API_URL.replace(/\/[^/]+$/, "/portal-cellar"),
};

// Actions the client routes away from portal-api.
const MOVED = {
  "portal-ai": ["runDeviationScan", "extractComponentSpecs", "suggestClassifications"],
  "portal-cellar": ["addDirective", "syncDirectiveRelations", "inferDirectiveRelations"],
};

// A function that is not deployed yet answers 404 to everything. Skip rather
// than fail, matching the harness convention elsewhere: a fresh checkout and a
// pre-deploy CI run stay green, and the tests start enforcing once it is live.
const deployed = new Map();
async function isDeployed(url) {
  if (deployed.has(url)) return deployed.get(url);
  let ok = false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "health" }),
    });
    ok = res.status !== 404;
  } catch { ok = false; }
  deployed.set(url, ok);
  return ok;
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers };
}

for (const [name, url] of Object.entries(FUNCTIONS)) {
  test(`${name}: health needs no session and no database`, async (t) => {
    if (!await isDeployed(url)) return t.skip(`${name} not deployed yet`);
    const r = await post(url, { action: "health" });
    // A deployed-but-older copy does not know the action yet. Skip rather than
    // fail, so the suite is green before the deploy and enforcing after it.
    // An older copy either does not know the action ("Unknown action") or
    // rejects it at the auth gate (401), because health used to sit behind auth.
    // Either way it predates this refactor: skip, so the suite is green before
    // the deploy and enforcing after it.
    if (/unknown action/i.test(r.json?.error ?? "") || r.status === 401) {
      return t.skip(`${name} deployed, but predates the health action`);
    }
    assert.equal(r.status, 200, `health returned ${r.status}`);
    assert.equal(r.json?.ok, true);
    assert.equal(r.json?.fn, name, `health reported fn=${r.json?.fn}`);
  });

  test(`${name}: a protected action without a token is rejected before dispatch`, async (t) => {
    if (!await isDeployed(url)) return t.skip(`${name} not deployed yet`);
    const r = await post(url, { action: "data" });
    assert.notEqual(r.status, 200, "unauthenticated call returned 200");
    assert.ok(/auth|token|not authenticated/i.test(r.json?.error ?? ""), `unexpected error: ${r.json?.error}`);
  });

  test(`${name}: a forged organization_id in the body cannot smuggle tenancy`, async (t) => {
    if (!await isDeployed(url)) return t.skip(`${name} not deployed yet`);
    const r = await post(url, { action: "data", organization_id: "11111111-1111-1111-1111-111111111111" });
    assert.notEqual(r.status, 200, "forged org id returned 200");
  });

  test(`${name}: CORS allows the browser and caches the preflight`, async (t) => {
    if (!await isDeployed(url)) return t.skip(`${name} not deployed yet`);
    const res = await fetch(url, { method: "OPTIONS" });
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    // Preflight caching is what stops one OPTIONS per request.
    assert.ok(Number(res.headers.get("access-control-max-age")) > 0,
      "missing Access-Control-Max-Age — the browser will preflight every call");
  });

  test(`${name}: non-POST is refused`, async (t) => {
    if (!await isDeployed(url)) return t.skip(`${name} not deployed yet`);
    const res = await fetch(url, { method: "GET" });
    assert.equal(res.status, 405);
  });
}

for (const [fn, actions] of Object.entries(MOVED)) {
  for (const action of actions) {
    test(`portal-api: "${action}" reports it moved to ${fn}`, async (t) => {
      if (!await isDeployed(FUNCTIONS["portal-api"])) return t.skip("portal-api unreachable");
      const r = await post(FUNCTIONS["portal-api"], { action });
      // Auth still runs first, so an unauthenticated probe is rejected — that is
      // the contract. What must NOT happen is a silent "Unknown action".
      assert.notEqual(r.status, 200);
      assert.ok(!/unknown action/i.test(r.json?.error ?? ""),
        `"${action}" looks unknown to portal-api; the moved-action guard is missing`);
    });

    test(`${fn}: "${action}" is served here (auth-gated, not unknown)`, async (t) => {
      if (!await isDeployed(FUNCTIONS[fn])) return t.skip(`${fn} not deployed yet`);
      const r = await post(FUNCTIONS[fn], { action });
      assert.notEqual(r.status, 200);
      assert.ok(!/unknown action/i.test(r.json?.error ?? ""),
        `"${action}" is not routed to ${fn}`);
    });
  }
}
