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

for (const action of ACTIONS) {
  test(`${action} rejects an unauthenticated call`, async () => {
    const r = await call(action, {
      component_id: "x", cad_model_revision_id: "x", spec: "x", title: "x", job_id: "x",
      key: "download", status: "passed", agent: "test", specs: [],
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
