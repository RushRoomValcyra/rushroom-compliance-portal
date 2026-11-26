// Drawing from CAD — render jobs (docs/DRAWING_RENDER.md) — the portal side.
//
// The pure rules in _shared/render-job-core.mjs are checked by hand-worked
// cases (the six steps, the timeouts, the failure patch, the title block, the
// spec normaliser). The portal-api surface is checked without credentials
// (every action refuses an anonymous call) and statically (both tables are
// tenant-scoped and in migration 0062, every action is implemented and
// Rushroom-only, the issue is inserted through ONE helper from both the upload
// modal and the worker). The deployed copy may predate the actions; "unknown
// action" is tolerated as not-deployed, as cad-test-agent.test.mjs does.
//
// Phase 2 (docs/DYNAMIC_DRAWINGS.md §3, §5, §7): the spec is a governed
// document and a patch travels. Statically: insertDrawingRevision and
// replaceDraftRevisionFile are the ONLY writers of a drawing_revisions row's
// file; the iterate branch of finishDrawingRender never mints a letter; the
// stale-worker guard is there; the poll hands the worker body + patch as
// canonical strings; the six new actions are dispatched, Rushroom-only and
// never a supplier action; migration 0068 and TENANT_TABLES carry the three
// new tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { call } from "./config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const M = await import(new URL("../supabase/functions/_shared/render-job-core.mjs", import.meta.url));
const { STEPS, STEP_KEYS, WORKER_STEP_KEYS, PORTAL_STEP_KEYS, JOB_STATUSES, newSteps, normaliseSteps, setStep,
        skipRemaining, activeStep, failPatch, timeoutPatch, titleBlock, sha8, normaliseSpec, normaliseSpecName,
        lastSeen, CLAIM_TIMEOUT_MS, RUN_TIMEOUT_MS, CLAIM_TIMEOUT_ERROR, RUN_TIMEOUT_ERROR } = M;

const ACTIONS = ["requestDrawingRender", "getDrawingRenderJob", "listDrawingRenderJobs", "cancelDrawingRenderJob",
                 "pollDrawingRenderJob", "reportDrawingRenderStep", "finishDrawingRender",
                 "registerDrawingSpecs", "listDrawingSpecs"];
// Phase 2 — the spec document and the iteration loop (DYNAMIC_DRAWINGS §5.1).
const PHASE2_ACTIONS = ["getDrawingSpec", "applyDrawingSpecOps", "acceptDrawingIteration", "discardDrawingIteration",
                        "getDrawingRenderArtifacts", "drawingRenderUploadUrl"];

const T0 = "2026-11-25T10:00:00.000Z";
const T1 = "2026-11-25T10:01:00.000Z";

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
test("the six steps are in contract order: claim · download · render · verify · upload · register", () => {
  assert.deepEqual(STEP_KEYS, ["claim", "download", "render", "verify", "upload", "register"]);
  assert.deepEqual(WORKER_STEP_KEYS, ["download", "render", "verify", "upload"], "the worker reports steps 2–5");
  assert.deepEqual(PORTAL_STEP_KEYS, ["claim", "register"], "the portal sets claim and register");
  assert.deepEqual([...WORKER_STEP_KEYS, ...PORTAL_STEP_KEYS].sort(), [...STEP_KEYS].sort());
  for (const s of STEPS) assert.ok(s.label, `${s.key} has a label`);
  const fresh = newSteps();
  assert.equal(fresh.length, 6);
  assert.ok(fresh.every((s) => s.status === "pending" && s.detail === null && s.at === null && s.data === null));
  assert.deepEqual(JOB_STATUSES, ["requested", "running", "done", "failed", "timed_out", "cancelled"]);
});

test("setStep changes one step, keeps data, and skipRemaining leaves passed/failed alone", () => {
  let steps = setStep(newSteps(), "claim", "passed", "drawing-worker · MacBook", T0);
  steps = setStep(steps, "download", "passed", "sha ok", T1, { sha256: "abcd" });
  steps = setStep(steps, "render", "failed", "drawset exit 1", T1);
  assert.equal(steps[0].status, "passed");
  assert.equal(steps[0].detail, "drawing-worker · MacBook");
  assert.equal(steps[1].status, "passed");
  assert.deepEqual(steps[1].data, { sha256: "abcd" });
  assert.equal(steps[2].status, "failed");
  // data merges, never replaces.
  steps = setStep(steps, "download", "passed", null, T1, { pages: 1 });
  assert.deepEqual(steps[1].data, { sha256: "abcd", pages: 1 });
  assert.equal(steps[1].detail, "sha ok", "a null detail keeps the old one");
  const skipped = skipRemaining(steps, STEP_KEYS, T1);
  assert.equal(skipped[0].status, "passed");
  assert.equal(skipped[2].status, "failed");
  assert.ok(skipped.slice(3).every((s) => s.status === "skipped"));
  // An unknown key changes nothing; a partial list is brought to six.
  assert.deepEqual(setStep(steps, "nope", "passed"), steps);
  assert.equal(normaliseSteps([{ key: "render", status: "running" }]).length, 6);
  assert.equal(normaliseSteps([{ key: "render", status: "bogus" }])[2].status, "pending");
  assert.equal(normaliseSteps(null).length, 6);
});

test("failPatch fails the step the worker was on and skips the rest", () => {
  let steps = setStep(newSteps(), "claim", "passed", "w", T0);
  steps = setStep(steps, "download", "passed", "ok", T0);
  steps = setStep(steps, "render", "running", null, T0);
  assert.equal(activeStep(steps).key, "render");
  const p = failPatch(steps, "spec has 3 parts; a render job draws one part", T1);
  assert.equal(p.status, "failed");
  assert.equal(p.error, "spec has 3 parts; a render job draws one part");
  assert.equal(p.finished_at, T1);
  assert.equal(p.steps[1].status, "passed", "download stays passed");
  assert.equal(p.steps[2].status, "failed");
  assert.equal(p.steps[2].detail, "spec has 3 parts; a render job draws one part");
  assert.ok(p.steps.slice(3).every((s) => s.status === "skipped"));
  // Nothing running → the first pending step takes the failure.
  const q = failPatch(setStep(newSteps(), "claim", "passed", "w", T0), "worker crashed", T1);
  assert.equal(q.steps[1].key, "download");
  assert.equal(q.steps[1].status, "failed");
  // A finished list has nothing to fail; the patch still closes the job.
  const done = STEP_KEYS.reduce((s, k) => setStep(s, k, "passed", null, T0), newSteps());
  assert.equal(activeStep(done), null);
  assert.equal(failPatch(done, "late", T1).status, "failed");
});

test("timeouts: 120 s unclaimed → timed_out, 15 min running → failed", () => {
  assert.equal(CLAIM_TIMEOUT_MS, 120_000);
  assert.equal(RUN_TIMEOUT_MS, 900_000);
  const req = { status: "requested", requested_at: T0, steps: newSteps() };
  assert.equal(timeoutPatch(req, Date.parse(T0) + CLAIM_TIMEOUT_MS), null, "exactly at the limit is still fine");
  const to = timeoutPatch(req, Date.parse(T0) + CLAIM_TIMEOUT_MS + 1);
  assert.equal(to.status, "timed_out");
  assert.equal(to.error, CLAIM_TIMEOUT_ERROR);
  assert.match(to.error, /no drawing worker picked the job up/);
  assert.ok(to.steps.every((s) => s.status === "skipped"));

  const running = { status: "running", requested_at: T0, claimed_at: T1,
                    steps: setStep(setStep(newSteps(), "claim", "passed", "w", T1), "render", "running", null, T1) };
  assert.equal(timeoutPatch(running, Date.parse(T1) + RUN_TIMEOUT_MS), null);
  const dead = timeoutPatch(running, Date.parse(T1) + RUN_TIMEOUT_MS + 1);
  assert.equal(dead.status, "failed");
  assert.equal(dead.error, RUN_TIMEOUT_ERROR);
  assert.match(dead.error, /worker stopped reporting/);
  assert.equal(dead.steps[0].status, "passed", "the claim stays passed");
  assert.equal(dead.steps[1].status, "skipped", "download was never reported");
  assert.equal(dead.steps[2].status, "failed", "the step the worker was on fails");
  assert.equal(dead.steps[2].detail, RUN_TIMEOUT_ERROR);
  assert.ok(dead.steps.slice(3).every((s) => s.status === "skipped"));
  // Finished jobs are never touched.
  for (const status of ["done", "failed", "cancelled", "timed_out"]) {
    assert.equal(timeoutPatch({ status, requested_at: "2020-01-01T00:00:00Z", claimed_at: "2020-01-01T00:00:00Z" }, Date.now()), null);
  }
  assert.equal(timeoutPatch(null, Date.now()), null);
});

// ---------------------------------------------------------------------------
// Title block, specs
// ---------------------------------------------------------------------------
test("the title block carries the eight facts the worker writes on the sheet", () => {
  const tb = titleBlock({
    drawing: { drawing_number: "RR-DWG-202611-ABCDEFGH", title: "Side panel left" },
    job: { issue: "b" },
    component: { part_number: "RR-202609-JKEDBREJ", name: "Side Panel L" },
    revision: { revision: "c" },
    file: { sha256: "ABCDEF0123456789deadbeef" },
    at: "2026-11-25T14:30:00.000Z",
  });
  assert.deepEqual(tb, {
    drawing_number: "RR-DWG-202611-ABCDEFGH", issue: "B", title: "Side panel left",
    part_number: "RR-202609-JKEDBREJ", part_name: "Side Panel L", cad_revision: "C",
    cad_sha8: "abcdef01", date: "2026-11-25",
  });
  assert.deepEqual(Object.keys(tb), ["drawing_number", "issue", "title", "part_number", "part_name", "cad_revision", "cad_sha8", "date"]);
  assert.equal(sha8(null), null);
  // Nothing loaded → nulls, never a throw.
  const empty = titleBlock({ at: T0 });
  assert.equal(empty.drawing_number, null);
  assert.equal(empty.issue, null);
  assert.equal(empty.date, "2026-11-25");
});

test("specs: the YAML stem is the name, parts an integer, part numbers upper-cased and unique", () => {
  assert.equal(normaliseSpecName("side_panel_left"), "side_panel_left");
  assert.equal(normaliseSpecName("door-m.v2"), "door-m.v2");
  assert.equal(normaliseSpecName("../etc"), null);
  assert.equal(normaliseSpecName("has space"), null);
  assert.equal(normaliseSpecName(""), null);
  assert.equal(normaliseSpecName("x".repeat(121)), null);
  const s = normaliseSpec({ name: "side_panel_left", title: "Side panel", parts: "1",
                            part_numbers: ["rr-202609-jkedbrej", "RR-202609-JKEDBREJ", "", null] });
  assert.deepEqual(s, { name: "side_panel_left", title: "Side panel", parts: 1, part_numbers: ["RR-202609-JKEDBREJ"] });
  assert.equal(normaliseSpec({ name: "door_m", parts: 3 }).parts, 3);
  assert.equal(normaliseSpec({ name: "door_m", parts: -1 }).parts, null);
  assert.equal(normaliseSpec({ name: "door_m", parts: "many" }).parts, null);
  assert.deepEqual(normaliseSpec({ name: "door_m" }).part_numbers, []);
  assert.equal(normaliseSpec({ name: "bad name" }), null);
  assert.equal(normaliseSpec(null), null);
  assert.equal(lastSeen([{ updated_at: T0 }, { updated_at: T1 }, { updated_at: "nope" }]), T1);
  assert.equal(lastSeen([]), null);
});

// ---------------------------------------------------------------------------
// portal-api surface — no credentials
// ---------------------------------------------------------------------------
const notDeployed = (r) => /unknown action/i.test(r.json?.error ?? "");

for (const action of [...ACTIONS, ...PHASE2_ACTIONS]) {
  test(`${action} rejects an unauthenticated call`, async () => {
    const r = await call(action, {
      component_id: "x", cad_model_revision_id: "x", spec: "x", title: "x", job_id: "x",
      key: "download", status: "passed", agent: "test", specs: [],
      drawing_id: "x", ops: [], file_name: "x.pdf",
    });
    if (notDeployed(r)) return;   // the deployed copy predates the render jobs
    assert.equal(r.status, 401, `${action} answered ${r.status} without a session`);
  });
}

// ---------------------------------------------------------------------------
// static guarantees
// ---------------------------------------------------------------------------
test("drawing_render_jobs and drawing_render_specs are tenant-scoped and in migration 0062", () => {
  const src = read("supabase/functions/_shared/tenant.ts");
  const block = src.match(/export const TENANT_TABLES = new Set\(\[([\s\S]*?)\]\);/)[1].replace(/\/\/.*$/gm, "");
  assert.ok(/"drawing_render_jobs"/.test(block), "drawing_render_jobs missing from TENANT_TABLES");
  assert.ok(/"drawing_render_specs"/.test(block), "drawing_render_specs missing from TENANT_TABLES");

  const sql = read("supabase/migrations/0062_drawing_render_jobs.sql");
  const jobs = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS drawing_render_jobs ("), sql.indexOf("ALTER TABLE drawing_render_jobs ENABLE ROW LEVEL SECURITY"));
  assert.ok(jobs.length > 0, "drawing_render_jobs is not created with IF NOT EXISTS / RLS");
  assert.match(jobs, /organization_id\s+UUID NOT NULL REFERENCES organizations\(id\)/);
  for (const col of ["component_id", "cad_model_revision_id", "cad_file_id", "drawing_id", "created_drawing", "spec", "issue",
                     "status", "requested_by", "requested_at", "claimed_at", "claimed_by", "finished_at", "steps", "result",
                     "error", "created_at"]) {
    assert.ok(new RegExp(`^\\s+${col}\\s`, "m").test(jobs), `drawing_render_jobs column ${col} missing`);
  }
  assert.match(jobs, /CHECK \(status IN \('requested', 'running', 'done', 'failed', 'timed_out', 'cancelled'\)\)/);
  assert.match(jobs, /drawing_id\s+UUID REFERENCES drawings\(id\) ON DELETE/);
  assert.match(sql, /ON drawing_render_jobs \(organization_id, status, requested_at\)/, "the poll index is missing");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS \w+\s+ON drawing_render_jobs \(organization_id, drawing_id\) WHERE status IN \('requested', 'running'\)/,
    "the one-render-per-drawing partial unique index is missing");

  const specs = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS drawing_render_specs ("), sql.indexOf("ALTER TABLE drawing_render_specs ENABLE ROW LEVEL SECURITY"));
  assert.ok(specs.length > 0, "drawing_render_specs is not created with IF NOT EXISTS / RLS");
  assert.match(specs, /organization_id\s+UUID NOT NULL REFERENCES organizations\(id\)/);
  for (const col of ["name", "title", "parts", "part_numbers", "agent", "updated_at"]) {
    assert.ok(new RegExp(`^\\s+${col}\\s`, "m").test(specs), `drawing_render_specs column ${col} missing`);
  }
  assert.match(specs, /PRIMARY KEY \(organization_id, name\)/);
  assert.match(sql, /ALTER TABLE drawings ADD COLUMN IF NOT EXISTS render_spec TEXT/);
});

test("portal-api implements every render action, Rushroom only, through the shared core", () => {
  const src = read("supabase/functions/portal-api/index.ts");
  assert.match(src, /from "\.\.\/_shared\/render-job-core\.mjs"/, "portal-api does not import render-job-core");
  for (const a of ACTIONS) {
    const i = src.indexOf(`action === "${a}"`);
    assert.ok(i >= 0, `portal-api does not implement ${a}`);
    const block = src.slice(i, i + 400);
    assert.match(block, /if \(role !== "rushroom"\) return json\(\{ error: "Rushroom only" \}, 403\);/, `${a} is not Rushroom-only`);
  }
  // The claim is one guarded UPDATE, not a read-then-write.
  const poll = src.slice(src.indexOf('action === "pollDrawingRenderJob"'), src.indexOf('action === "reportDrawingRenderStep"'));
  assert.match(poll, /\.eq\("status", "requested"\)\.select\("\*"\)/, "the claim is not guarded by status = requested");
  // The STEP url is signed for one hour from the documents bucket.
  assert.match(poll, /db\.storage\.from\(DOC_BUCKET\)\.createSignedUrl\(stepFile\.storage_path, 3600\)/, "the STEP url is not a 1 h signed url");
  for (const k of ["step_url", "step_file_name", "cad_sha256", "title_block", "spec"]) {
    assert.ok(poll.includes(`${k}:`), `the poll answer lacks ${k}`);
  }
  // Reports are refused unless the job is running (409), for worker step keys only.
  const report = src.slice(src.indexOf('action === "reportDrawingRenderStep"'), src.indexOf('action === "finishDrawingRender"'));
  assert.match(report, /RENDER_WORKER_STEP_KEYS\.includes\(key\)/);
  assert.match(report, /not running` \}, 409\)/);
  // finish sets drawings.render_spec and the register step.
  const finish = src.slice(src.indexOf('action === "finishDrawingRender"'), src.indexOf('action === "registerDrawingSpecs"'));
  assert.match(finish, /render_spec: job\.spec/);
  assert.match(finish, /"register", "passed"/);
  assert.match(finish, /Rendered from CAD Rev \$\{[^}]+\} by drawset/);
  // register upserts on the primary key and removes what the worker no longer lists.
  const reg = src.slice(src.indexOf('action === "registerDrawingSpecs"'), src.indexOf('action === "listDrawingSpecs"'));
  assert.match(reg, /onConflict: "organization_id,name"/);
  assert.match(reg, /tdb\("drawing_render_specs"\)\.delete\(\)/);
});

test("one rule for a new issue: addDrawingRevision and finishDrawingRender both call insertDrawingRevision", () => {
  const src = read("supabase/functions/portal-api/index.ts");
  assert.ok(src.includes("async function insertDrawingRevision("), "the shared issue helper is missing");
  const add = src.slice(src.indexOf('action === "addDrawingRevision"'), src.indexOf('action === "linkDrawingToComponent"'));
  assert.match(add, /await insertDrawingRevision\(tdb, session, drawing, \{/, "addDrawingRevision bypasses insertDrawingRevision");
  assert.ok(!/tdb\("drawing_revisions"\)\.insert\(/.test(add), "addDrawingRevision still inserts the row itself");
  // Every response field of the old action survives.
  assert.match(add, /return json\(\{ ok: true, id: r\.id, revision: r\.revision, \.\.\.r\.audit \}\)/);
  const finish = src.slice(src.indexOf('action === "finishDrawingRender"'), src.indexOf('action === "registerDrawingSpecs"'));
  assert.match(finish, /await insertDrawingRevision\(tdb, session, drawing, \{/, "finishDrawingRender bypasses insertDrawingRevision");
  assert.match(finish, /revision: job\.issue/, "the rendered issue does not use the letter reserved at request");
  assert.match(finish, /source_cad_file_id: job\.cad_file_id/);
  assert.ok(!/tdb\("drawing_revisions"\)\.insert\(/.test(finish), "finishDrawingRender inserts the row itself");
  // The helper itself holds the §5.2 letter check and the audit fan-out.
  const helper = src.slice(src.indexOf("async function insertDrawingRevision("), src.indexOf("const RENDER_JOB_LIST_FIELDS"));
  assert.match(helper, /is below the current \$\{current\.revision\}/);
  assert.match(helper, /recordDrawingEvent\(tdb, session, drawing_id, "drawing_revised"/);
  assert.match(helper, /syncDrawingStatus\(tdb, drawing_id\)/);
});

test("a drawing the job created and that has no issue is deleted again on failure, timeout and cancel", () => {
  const src = read("supabase/functions/portal-api/index.ts");
  assert.ok(src.includes("async function removeEmptyRenderDrawing("), "the cleanup helper is missing");
  for (const a of ["cancelDrawingRenderJob", "finishDrawingRender"]) {
    const i = src.indexOf(`action === "${a}"`);
    const block = src.slice(i, src.indexOf("if (action ===", i + 10));
    assert.match(block, /removeEmptyRenderDrawing\(tdb, session/, `${a} does not clean up a created drawing`);
  }
  const expire = src.slice(src.indexOf("async function expireDrawingRenderJobs("), src.indexOf("async function withRenderJobContext("));
  assert.match(expire, /removeEmptyRenderDrawing\(tdb, session, job\)/, "an expired job does not clean up a created drawing");
});

test("the render-job core is pure: no Deno, Node or network APIs", () => {
  const src = read("supabase/functions/_shared/render-job-core.mjs")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\bDeno\b|\bprocess\.|\brequire\(|\bfetch\(|from "node:/.test(src), "render-job-core reaches outside pure JS");
});

test("the STATUS_MODEL clean-up is 0063 + 0064 now that 0062 is the render jobs", () => {
  const sm = read("docs/STATUS_MODEL.md");
  assert.ok(/\*\*0063 \+ 0064 — the clean-up, in two steps\*\*/.test(sm), "STATUS_MODEL.md does not name the two-step clean-up");
  assert.ok(/\*\*0064 — drop\*\*/.test(sm), "STATUS_MODEL.md does not number the drop migration 0064");
  assert.ok(!/\*\*dropped\*\* \((migration )?0062/.test(sm), "STATUS_MODEL.md still says a column is dropped in 0062");
  const m60 = read("supabase/migrations/0060_revision_status.sql");
  assert.ok(!/until 0062\b/.test(m60), "0060 still says the old columns stay until 0062");
  const api = read("supabase/functions/portal-api/index.ts");
  assert.ok(!/until (migration )?0062\b/.test(api), "portal-api still says the dual-write ends at 0062");
});

// ---------------------------------------------------------------------------
// Phase 2 — static guarantees (DYNAMIC_DRAWINGS §3.7, §5.1, §5.3, §7)
// ---------------------------------------------------------------------------
const API = "supabase/functions/portal-api/index.ts";

/** The text of a brace-balanced literal starting at src[open] === "{". */
function braceLiteral(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** The nearest enclosing owner of src[i]: an `async function NAME(` or an `action === "NAME"` gate. */
function ownerOf(src, i) {
  const before = src.slice(0, i);
  const fn = [...before.matchAll(/async function (\w+)\(/g)].pop();
  const act = [...before.matchAll(/action === "(\w+)"/g)].pop();
  if (!fn && !act) return null;
  if (!act || (fn && fn.index > act.index)) return fn[1];
  return act[1];
}

/** The object the write passes: an inline `{...}` or the literal a named const/let in the owner holds. */
function writtenLiteral(src, callEnd, ownerStart) {
  const after = src.slice(callEnd);
  const inline = after.match(/^\s*\{/);
  if (inline) return braceLiteral(src, callEnd + inline[0].length - 1);
  const name = after.match(/^\s*(\w+)\s*\)/)?.[1];
  if (!name) return after.slice(0, 200);
  const body = src.slice(ownerStart, callEnd);
  const decl = [...body.matchAll(new RegExp(`(?:const|let)\\s+${name}\\b[^=;]*=\\s*`, "g"))].pop();
  if (!decl) return "";
  const at = ownerStart + decl.index + decl[0].length;
  if (src[at] === "{") return braceLiteral(src, at);
  return src.slice(at, src.indexOf(";", at));
}

/** Every insert/update/upsert on drawing_revisions with its owner and whether it sets the file. */
function drawingRevisionWrites(src) {
  const out = [];
  for (const m of src.matchAll(/(?:tdb|db\.from)\("drawing_revisions"\)\s*\.(insert|update|upsert)\(/g)) {
    const owner = ownerOf(src, m.index);
    const ownerStart = Math.max(src.lastIndexOf(`async function ${owner}(`, m.index), src.lastIndexOf(`action === "${owner}"`, m.index));
    const literal = writtenLiteral(src, m.index + m[0].length, ownerStart).replace(/"[^"\n]*"/g, '""');
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ owner, kind: m[1], line, writesFile: /\bstorage_path\b/.test(literal) });
  }
  return out;
}

test("two file writers only: insertDrawingRevision and replaceDraftRevisionFile set a drawing_revisions row's storage_path", () => {
  const src = read(API);
  assert.ok(src.includes("async function insertDrawingRevision("), "insertDrawingRevision is missing");
  assert.ok(src.includes("async function replaceDraftRevisionFile("), "replaceDraftRevisionFile is missing");
  const writes = drawingRevisionWrites(src);
  assert.ok(writes.length >= 2, "no writes to drawing_revisions found — the scan is broken");
  const fileWriters = [...new Set(writes.filter((w) => w.writesFile).map((w) => w.owner))].sort();
  assert.deepEqual(fileWriters, ["insertDrawingRevision", "replaceDraftRevisionFile"],
    `a drawing_revisions row's file is written outside the two helpers: ${
      writes.filter((w) => w.writesFile && !["insertDrawingRevision", "replaceDraftRevisionFile"].includes(w.owner))
        .map((w) => `${w.owner} (${API}:${w.line}, .${w.kind})`).join(", ") || "none"}`);
  // Each helper writes the file exactly once: one insert, one update.
  assert.deepEqual(writes.filter((w) => w.owner === "insertDrawingRevision").map((w) => w.kind), ["insert"]);
  assert.deepEqual(writes.filter((w) => w.owner === "replaceDraftRevisionFile").map((w) => w.kind), ["update"]);
  // The two helpers are the only callers' route: every other action goes through them.
  const callers = [...src.matchAll(/await (insertDrawingRevision|replaceDraftRevisionFile)\(tdb, session, drawing, /g)]
    .map((m) => `${ownerOf(src, m.index)}→${m[1]}`).sort();
  assert.deepEqual(callers, ["acceptDrawingIteration→replaceDraftRevisionFile", "addDrawingRevision→insertDrawingRevision",
                             "createDrawingWithRevision→insertDrawingRevision", "finishDrawingRender→insertDrawingRevision"]);
});

test("replaceDraftRevisionFile keeps the letter and is guarded by draft + current at the write", () => {
  const src = read(API);
  const helper = src.slice(src.indexOf("async function replaceDraftRevisionFile("), src.indexOf("const renderArtifactPrefix"));
  assert.ok(helper.length > 0, "the helper is not before renderArtifactPrefix");
  const patch = braceLiteral(helper, helper.indexOf("{", helper.indexOf("const patch: Record<string, unknown> =")));
  assert.ok(!/\brevision\s*:/.test(patch), "the draft's letter is rewritten");
  assert.ok(!/\bstatus\s*:/.test(patch), "the draft's status is rewritten");
  assert.match(helper, /fresh\.status !== "draft"/, "a non-draft is not refused");
  assert.match(helper, /current\.id !== fresh\.id/, "a non-current draft is not refused");
  assert.match(helper, /\.update\(patch\)\s*\.eq\("id", fresh\.id\)\.eq\("status", "draft"\)/, "the write is not guarded by status = draft");
  for (const k of ["storage_path", "file_name", "source_cad_file_id", "source_sha256", "spec_version_id", "spec_patch_id",
                   "render_job_id", "dimension_list_sha256", "geometry_sha256"]) {
    assert.ok(new RegExp(`\\b${k}:`).test(patch), `the file swap does not carry ${k}`);
  }
  assert.match(helper, /action: "drawing_draft_file_replaced"/, "no platform_audit trace");
  assert.match(helper, /\{ bump: false \}/, "the letter did not move, so the BOM revision must not bump");
});

test("the iterate branch of finishDrawingRender never inserts a letter; the issue branch pins the spec", () => {
  const src = read(API);
  const finish = src.slice(src.indexOf('action === "finishDrawingRender"'), src.indexOf('action === "registerDrawingSpecs"'));
  const open = finish.indexOf('if (mode === "iterate") {');
  assert.ok(open >= 0, "finishDrawingRender has no iterate branch");
  const branch = braceLiteral(finish, finish.indexOf("{", open));
  assert.ok(!/insertDrawingRevision\(/.test(branch), "the iterate branch calls insertDrawingRevision");
  assert.ok(!/replaceDraftRevisionFile\(/.test(branch), "the iterate branch replaces the draft's file (that is Keep's job)");
  assert.ok(!/drawing_revisions"\)\s*\.(insert|update|upsert|delete)\(/.test(branch), "the iterate branch writes drawing_revisions");
  assert.ok(!/tdb\("drawings"\)\.update\(/.test(branch), "the iterate branch changes the drawing row");
  assert.match(branch, /job\.replaces_revision_id/, "the iterate branch does not check its target draft");
  assert.match(branch, /closeJobPatch\(tdb, job, "candidate"\)/, "the patch row does not become a candidate");
  assert.match(branch, /candidate: true/, "the job result does not say candidate");
  assert.match(branch, /return json\(\{ job: out \}\);\s*\}$/, "the iterate branch does not return before the issue path");
  // The issue path follows the branch: insertDrawingRevision, then the §3.4 pins on the new row.
  const issue = finish.slice(open + branch.length);
  assert.match(issue, /await insertDrawingRevision\(tdb, session, drawing, \{/, "the issue branch bypasses insertDrawingRevision");
  const pins = issue.slice(issue.indexOf('tdb("drawing_revisions").update({'), issue.indexOf("}).eq(\"id\", r.id)"));
  for (const k of ["spec_version_id: job.spec_version_id", "spec_patch_id: job.spec_patch_id", "render_job_id: job.id",
                   "dimension_list_sha256: facts.dimension_list_sha256", "geometry_sha256: facts.geometry_sha256"]) {
    assert.ok(pins.includes(k), `the new issue is not pinned with ${k}`);
  }
  assert.match(issue, /closeJobPatch\(tdb, job, "accepted"\)/, "a carried patch rendered into an issue is not accepted");
  assert.match(issue, /render_spec: job\.spec, spec_patch_id: job\.spec_patch_id/, "drawings.spec_patch_id does not follow the issue");
  // A failed iterate (verify, lost target, stale worker) marks the patch failed and leaves the draft alone.
  const fail = braceLiteral(finish, finish.indexOf("{", finish.indexOf("const fail = async")));
  assert.match(fail, /closeJobPatch\(tdb, job, "failed"\)/, "a failed job does not mark its patch failed");
  assert.ok(!/drawing_revisions/.test(fail), "a failed job touches drawing_revisions");
});

test("the stale-worker guard: a patched job without the patch's sha fails 'worker predates spec patches'", () => {
  const src = read(API);
  const finish = src.slice(src.indexOf('action === "finishDrawingRender"'), src.indexOf('action === "registerDrawingSpecs"'));
  assert.match(finish, /await fail\("worker predates spec patches; restart it"\)/, "the guard text is missing or not a failure");
  const guard = finish.slice(finish.indexOf("if (job.spec_patch_id) {"), finish.indexOf("worker predates spec patches"));
  assert.match(guard, /result\.patch_sha256|echoedPatchSha/, "the guard does not read the echoed patch sha");
  assert.match(guard, /pr\.patch_sha256/, "the guard does not compare with the stored patch sha");
  assert.match(finish, /\/\^\[0-9a-f\]\{64\}\$\/i/, "the echoed shas are not checked as 64 hex chars");
  assert.match(finish, /worker rendered another body of/, "a body sha that differs from the version's is not refused");
  assert.match(finish, /await fail\("drawset verification failed"\)/, "a verify FAIL does not fail the job");
  // The result carries the §5.3 facts: both fingerprints, both echoed shas, verify, unmatched overrides, artefact paths.
  const facts = braceLiteral(finish, finish.indexOf("{", finish.indexOf("const facts =")));
  for (const k of ["dimension_list_sha256", "geometry_sha256", "spec_body_sha256", "patch_sha256", "verify", "unmatched_overrides", "artifacts"]) {
    assert.ok(new RegExp(`\\b${k}\\b`).test(facts), `the finish result lacks ${k}`);
  }
  assert.match(finish, /normaliseRenderArtifacts\(job, result\.artifacts\)/, "artefact paths are not normalised to the job's folder");
});

test("pollDrawingRenderJob hands the worker mode, drawing_id, spec_body and spec_patch as canonical strings with their shas", () => {
  const src = read(API);
  assert.match(src, /from "\.\.\/_shared\/drawing-spec-core\.mjs"/, "portal-api does not import drawing-spec-core");
  const poll = src.slice(src.indexOf('action === "pollDrawingRenderJob"'), src.indexOf('action === "drawingRenderUploadUrl"'));
  assert.ok(poll.length > 0, "drawingRenderUploadUrl is not right after the poll");
  assert.match(poll, /spec_body = canonicalJson\(version\.body\)/, "the body is not sent as canonical JSON");
  assert.match(poll, /spec_body_sha256 = await canonicalSha\(spec_body\)/, "the body sha is not the sha of the string sent");
  assert.match(poll, /spec_patch = canonicalJson\(pr\.patch\)/, "the patch is not sent as canonical JSON");
  assert.match(poll, /patch_sha256 = await canonicalSha\(spec_patch\)/, "the patch sha is not the sha of the string sent");
  assert.match(poll, /spec_body_sha256 !== version\.body_sha256/, "a body that no longer hashes to its stored sha is not caught");
  assert.match(poll, /patch_sha256 !== pr\.patch_sha256/, "a patch that no longer hashes to its stored sha is not caught");
  const answer = braceLiteral(poll, poll.indexOf("{", poll.indexOf("job: {", poll.indexOf("return json({"))));
  for (const k of ["step_url", "step_file_name", "cad_sha256", "title_block", "spec", "mode", "drawing_id",
                   "spec_body", "spec_body_sha256", "spec_patch", "patch_sha256", "png"]) {
    assert.ok(new RegExp(`\\b${k}\\b\\s*[:,}]`).test(answer), `the poll answer lacks ${k}`);
  }
  assert.match(answer, /png: true/, "the worker is not asked for PNGs");
  assert.match(answer, /mode: job\.mode \|\| "issue"/, "mode does not default to issue for pre-0068 jobs");
});

test("the six Phase 2 actions are dispatched in portal-api, Rushroom-only, and never supplier actions", () => {
  const src = read(API);
  for (const a of PHASE2_ACTIONS) {
    const i = src.indexOf(`action === "${a}"`);
    assert.ok(i >= 0, `portal-api does not implement ${a}`);
    const block = src.slice(i, i + 400);
    assert.match(block, /if \(role !== "rushroom"\) return json\(\{ error: "Rushroom only" \}, 403\);/, `${a} is not Rushroom-only`);
  }
  const supplier = src.match(/const SUPPLIER_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1];
  for (const a of [...ACTIONS, ...PHASE2_ACTIONS]) {
    assert.ok(!supplier.includes(`"${a}"`), `${a} is in SUPPLIER_ACTIONS`);
  }
  // Nothing of this family is handled elsewhere: no new action outside its owning function.
  for (const f of ["supabase/functions/portal-ai/index.ts", "supabase/functions/portal-cellar/index.ts"]) {
    const other = read(f);
    for (const a of PHASE2_ACTIONS) assert.ok(!other.includes(`"${a}"`), `${a} is also handled in ${f}`);
  }
  // The artefact upload url: claimed-and-running jobs only, under the job's folder.
  const up = src.slice(src.indexOf('action === "drawingRenderUploadUrl"'), src.indexOf('action === "reportDrawingRenderStep"'));
  assert.match(up, /not running` \}, 409\)/, "an upload url is signed for a job that is not running");
  assert.match(up, /renderArtifactPrefix\(job\)/, "the artefact is not placed under the job's renders folder");
  assert.match(src, /`drawings\/\$\{job\.drawing_id\}\/renders\/\$\{job\.id\}\/`/, "the artefact prefix is not drawings/<drawing_id>/renders/<job_id>/");
  assert.match(up, /createSignedUploadUrl\(path\)/);
  // Keep goes through replaceDraftRevisionFile and refuses a candidate overtaken by a later accepted patch.
  const keep = src.slice(src.indexOf('action === "acceptDrawingIteration"'), src.indexOf('action === "discardDrawingIteration"'));
  assert.match(keep, /job\.mode !== "iterate"/);
  assert.match(keep, /pr\.status !== "candidate"/);
  assert.match(keep, /was accepted after this candidate/);
  assert.match(keep, /\.update\(\{ status: "accepted" \}\)\.eq\("id", pr\.id\)\.eq\("status", "candidate"\)/, "accepting is not guarded by status = candidate");
  // Discard keeps the row as history and removes the artefacts; a kept patch is never discarded.
  const discard = src.slice(src.indexOf('action === "discardDrawingIteration"'), src.indexOf('action === "getDrawingRenderArtifacts"'));
  assert.match(discard, /was kept; it cannot be discarded/);
  assert.match(discard, /\.update\(\{ status: "discarded" \}\)/);
  assert.match(discard, /removeRenderArtifacts\(job\)/);
  assert.ok(!/drawing_spec_patches"\)\.delete\(/.test(discard), "discard deletes the patch row");
  // applyDrawingSpecOps: a stale parent is a 409 with the latest seq.
  const apply = src.slice(src.indexOf('action === "applyDrawingSpecOps"'), src.indexOf('action === "acceptDrawingIteration"'));
  assert.match(apply, /parent_seq !== latestSeq/);
  assert.match(apply, /latest_seq: latestSeq \}, 409\)/);
  assert.match(apply, /validateOps\(/, "ops are not run through the shared validator");
});

test("migration 0068 and TENANT_TABLES carry the three spec tables; the jobs and revisions take the Phase 2 columns", () => {
  const tenant = read("supabase/functions/_shared/tenant.ts");
  const block = tenant.match(/export const TENANT_TABLES = new Set\(\[([\s\S]*?)\]\);/)[1].replace(/\/\/.*$/gm, "");
  for (const t of ["drawing_spec_versions", "drawing_spec_patches", "drawing_spec_turns"]) {
    assert.ok(block.includes(`"${t}"`), `${t} missing from TENANT_TABLES`);
  }
  const sql = read("supabase/migrations/0068_drawing_spec_governance.sql");
  for (const t of ["drawing_spec_versions", "drawing_spec_patches", "drawing_spec_turns"]) {
    const create = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${t} (`);
    const rls = sql.indexOf(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    assert.ok(create >= 0 && rls > create, `${t} is not created with IF NOT EXISTS / RLS`);
    const body = sql.slice(create, rls);
    assert.match(body, /organization_id\s+UUID NOT NULL REFERENCES organizations\(id\)/, `${t} is not tenant-scoped`);
    assert.ok(!/CREATE POLICY/.test(body), `${t} has a policy; RLS is deny-all`);
  }
  assert.match(sql, /CHECK \(kind IN \('template', 'part_spec'\)\)/);
  assert.match(sql, /CHECK \(origin IN \('click', 'dialogue', 'carry', 'hand'\)\)/);
  assert.match(sql, /CHECK \(status IN \('proposed', 'candidate', 'accepted', 'discarded', 'failed'\)\)/);
  assert.match(sql, /UNIQUE \(organization_id, drawing_id, seq\)/);
  assert.match(sql, /mode\s+TEXT NOT NULL DEFAULT 'issue'\s+CHECK \(mode IN \('issue', 'iterate'\)\)/);
  for (const col of ["spec_version_id", "spec_patch_id", "replaces_revision_id"]) {
    assert.match(sql, new RegExp(`ALTER TABLE drawing_render_jobs[\\s\\S]*?ADD COLUMN IF NOT EXISTS ${col}\\s`), `drawing_render_jobs lacks ${col}`);
  }
  for (const col of ["spec_version_id", "spec_patch_id", "render_job_id", "dimension_list_sha256", "geometry_sha256"]) {
    assert.match(sql, new RegExp(`ALTER TABLE drawing_revisions[\\s\\S]*?ADD COLUMN IF NOT EXISTS ${col}\\s`), `drawing_revisions lacks ${col}`);
  }
  assert.match(sql, /ALTER TABLE drawings\s+ADD COLUMN IF NOT EXISTS spec_patch_id UUID REFERENCES drawing_spec_patches\(id\) ON DELETE SET NULL/);
  assert.match(sql, /render_job_id\s+UUID REFERENCES drawing_render_jobs\(id\) ON DELETE SET NULL/);
});
