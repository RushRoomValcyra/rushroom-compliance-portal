// CAD change-order test agent (docs/TEST_AGENT.md) — the portal side.
//
// The pure rules in _shared/test-agent-core.mjs are checked by hand-worked
// cases (prediction + the five portal-side verdicts). The portal-api surface
// is checked without credentials (every action refuses an anonymous call) and
// statically (the table is tenant-scoped, every action is implemented). The
// deployed copy may predate the actions; "unknown action" is tolerated as
// not-deployed, as cad-revisions.test.mjs does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { call } from "./config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const M = await import(new URL("../supabase/functions/_shared/test-agent-core.mjs", import.meta.url));
const { STEPS, STEP_KEYS, FUSION_STEP_KEYS, PORTAL_STEP_KEYS, newSteps, setStep, skipRemaining,
        timeoutPatch, expectedOutcome, verifyRun, buildSnapshot, snapshotSupplierView,
        CLAIM_TIMEOUT_MS, RUN_TIMEOUT_MS, CLAIM_TIMEOUT_ERROR, RUN_TIMEOUT_ERROR } = M;

const ACTIONS = ["requestCadTestRun", "getCadTestRun", "listCadTestRuns", "cancelCadTestRun",
                 "pollCadTestRun", "reportCadTestStep", "finishCadTestRun"];

// ---------------------------------------------------------------------------
// Fixtures — one part, one CAD model, a released Rev A and a draft Rev B
// ---------------------------------------------------------------------------
const PART = "RR-202609-JKEDBREJ";
const DOC = `${PART} Drawer Front M`;
const T0 = "2026-11-25T10:00:00.000Z";
const T1 = "2026-11-25T10:01:00.000Z";

const file = (id, fusion_version, sha256, file_name = `${DOC}.step`) =>
  ({ id, format: "step", file_name, fusion_version, sha256 });

/** A snapshot of the part. revisions: [{ id, revision, status, files }]. */
function snap({ revisions, history_count = 12, drawings = [], fusion_document_name = DOC, model_status, at = T0 }) {
  const s = buildSnapshot({
    at,
    component: { part_number: PART, name: "Drawer Front M" },
    model: { fusion_document_id: "urn:adsk.wipprod:dm.lineage:x", fusion_document_name, status: model_status ?? null },
    revisions, drawings, historyCount: history_count, warnings: [],
  });
  if (model_status === undefined) {
    // Default to a coherent dual-write: the model reports its current revision.
    s.model_status = s.current ? s.current.status : "draft";
  }
  return s;
}

const REL_A = { id: "rev-a", revision: "A", status: "released", files: [file("f-a", 5, "aaaa")] };
const DRAFT_B = { id: "rev-b", revision: "B", status: "draft", files: [file("f-b", 7, "bbbb")] };
const DRAWINGS = [
  { id: "d1", drawing_number: "DRW-0007", is_supplier_visible: true,
    revisions: [{ id: "i-a", revision: "A", status: "superseded" }, { id: "i-b", revision: "B", status: "released" }] },
  { id: "d2", drawing_number: "DRW-0008", is_supplier_visible: true,
    revisions: [{ id: "i-c", revision: "A", status: "draft" }] },
];

const HISTORY_OK = [{ changed_at: T1, notes: "CAD revision B re-registered (step)" }];

/** Replace mode: Rev A released, Rev B draft → the send lands on B. */
const beforeReplace = snap({ revisions: [REL_A, DRAFT_B], drawings: DRAWINGS });
const afterReplace = snap({
  revisions: [REL_A, { ...DRAFT_B, files: [file("f-b", 8, "cccc")] }],
  drawings: DRAWINGS, history_count: 13, at: T1,
});
const sendReplace = { revision: "B", revision_id: "rev-b", file_id: "f-b", replaced: true, created: false,
                      sha256: "cccc", file_name: `${DOC}.step`, fusion_version: 8 };

/** New-letter mode: only Rev A, released → the send mints B. */
const beforeNew = snap({ revisions: [REL_A], drawings: DRAWINGS });
const afterNew = snap({
  revisions: [REL_A, { id: "rev-b2", revision: "B", status: "draft", files: [file("f-b2", 6, "dddd")] }],
  drawings: DRAWINGS, history_count: 13, at: T1,
});
const sendNew = { revision: "B", revision_id: "rev-b2", file_id: "f-b2", replaced: false, created: true,
                  sha256: "dddd", file_name: `${DOC}.step`, fusion_version: 6 };

/** The reported steps with the save step's version numbers, as the add-in sends them. */
const saved = (version_before, version_after) =>
  [{ key: "save", status: "passed", detail: `v${version_before} → v${version_after}`, data: { version_before, version_after } }];

const verdict = (args) => {
  // Replace fixtures: the document was at v7 (the Rev B file) and the run saved v8.
  const v = verifyRun({ requestedAt: T0, historyRows: HISTORY_OK, steps: saved(7, 8), ...args });
  const byKey = Object.fromEntries(v.steps.map((s) => [s.key, s]));
  return { ...v, byKey };
};

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
test("the twelve steps are in contract order and split 7 Fusion / 5 portal", () => {
  assert.deepEqual(STEP_KEYS, ["claim", "open", "change", "save", "stamp", "export", "send",
                               "naming", "versioning", "status", "supplier", "changelog"]);
  assert.deepEqual([...FUSION_STEP_KEYS, ...PORTAL_STEP_KEYS], STEP_KEYS);
  for (const s of STEPS) assert.ok(s.label, `${s.key} has a label`);
  const fresh = newSteps();
  assert.equal(fresh.length, 12);
  assert.ok(fresh.every((s) => s.status === "pending" && s.detail === null && s.at === null));
});

test("setStep changes one step and skipRemaining leaves passed/failed alone", () => {
  let steps = setStep(newSteps(), "claim", "passed", "Mathias · Fusion 2.0.21", T0);
  steps = setStep(steps, "open", "failed", "document not found", T1);
  assert.equal(steps[0].status, "passed");
  assert.equal(steps[0].detail, "Mathias · Fusion 2.0.21");
  assert.equal(steps[1].status, "failed");
  const skipped = skipRemaining(steps, STEP_KEYS, T1);
  assert.equal(skipped[0].status, "passed");
  assert.equal(skipped[1].status, "failed");
  assert.ok(skipped.slice(2).every((s) => s.status === "skipped"));
  // An unknown key changes nothing.
  assert.deepEqual(setStep(steps, "nope", "passed"), steps);
});

test("timeouts: 120 s unclaimed → timed_out, 10 min running → failed", () => {
  const req = { status: "requested", requested_at: T0, steps: newSteps() };
  assert.equal(timeoutPatch(req, Date.parse(T0) + CLAIM_TIMEOUT_MS), null, "exactly at the limit is still fine");
  const to = timeoutPatch(req, Date.parse(T0) + CLAIM_TIMEOUT_MS + 1);
  assert.equal(to.status, "timed_out");
  assert.equal(to.error, CLAIM_TIMEOUT_ERROR);
  assert.ok(to.steps.every((s) => s.status === "skipped"));

  const running = { status: "running", requested_at: T0, claimed_at: T1,
                    steps: setStep(setStep(newSteps(), "claim", "passed", "x", T1), "open", "running", null, T1) };
  assert.equal(timeoutPatch(running, Date.parse(T1) + RUN_TIMEOUT_MS), null);
  const dead = timeoutPatch(running, Date.parse(T1) + RUN_TIMEOUT_MS + 1);
  assert.equal(dead.status, "failed");
  assert.equal(dead.error, RUN_TIMEOUT_ERROR);
  assert.equal(dead.steps[0].status, "passed", "the claim stays passed");
  assert.equal(dead.steps[1].status, "failed", "the step the add-in was on fails");
  assert.equal(dead.steps[1].detail, RUN_TIMEOUT_ERROR);
  assert.ok(dead.steps.slice(2).every((s) => s.status === "skipped"));
  // Finished runs are never touched.
  for (const status of ["passed", "failed", "cancelled", "timed_out"]) {
    assert.equal(timeoutPatch({ status, requested_at: "2020-01-01T00:00:00Z", claimed_at: "2020-01-01T00:00:00Z" }, Date.now()), null);
  }
});

// ---------------------------------------------------------------------------
// Snapshot and prediction
// ---------------------------------------------------------------------------
test("the snapshot carries what verifyRun needs", () => {
  const s = beforeReplace;
  assert.equal(s.part_number, PART);
  assert.equal(s.fusion_document_name, DOC);
  assert.deepEqual(s.current, { id: "rev-b", revision: "B", status: "draft", fusion_version: 7 });
  assert.deepEqual(s.released, { id: "rev-a", revision: "A", status: "released", fusion_version: 5 });
  assert.equal(s.history_count, 12);
  assert.equal(s.model_status, "draft");
  assert.deepEqual(s.revisions.map((r) => r.revision), ["A", "B"]);
  for (const r of s.revisions) for (const f of r.files) {
    for (const k of ["id", "format", "file_name", "fusion_version", "sha256"]) assert.ok(k in f, `file lacks ${k}`);
  }
});

test("supplier_view is released-only and respects is_supplier_visible", () => {
  assert.deepEqual(beforeReplace.supplier_view, {
    cad_released_revision: "A",
    drawings: [{ drawing_number: "DRW-0007", released_revision: "B" }],   // DRW-0008 has no released issue
  });
  const hidden = snapshotSupplierView({
    cadRevisions: [DRAFT_B],
    drawings: [{ ...DRAWINGS[0], is_supplier_visible: false }],
  });
  assert.deepEqual(hidden, { cad_released_revision: null, drawings: [] });
});

test("expectedOutcome: a draft current letter is replaced, Fusion version +1", () => {
  assert.deepEqual(expectedOutcome(beforeReplace), { mode: "replace", letter: "B", fusion_version: 8 });
  // checked / approved are still in work: the send replaces (registerCadRevision's rule).
  const checked = snap({ revisions: [REL_A, { ...DRAFT_B, status: "checked" }] });
  assert.equal(expectedOutcome(checked).mode, "replace");
});

test("expectedOutcome: a released or superseded current letter mints the next one", () => {
  assert.deepEqual(expectedOutcome(beforeNew), { mode: "new_letter", letter: "B", fusion_version: 6 });
  const z = snap({ revisions: [{ id: "z", revision: "Z", status: "released", files: [file("fz", 3, "zz")] }] });
  assert.deepEqual(expectedOutcome(z), { mode: "new_letter", letter: "AA", fusion_version: 4 });
  // No revision at all: Rev A, and no Fusion version to count from.
  assert.deepEqual(expectedOutcome(snap({ revisions: [] })), { mode: "new_letter", letter: "A", fusion_version: null });
  // A current letter without a STEP file cannot predict the version either.
  const noStep = snap({ revisions: [{ id: "r", revision: "A", status: "draft", files: [{ id: "g", format: "glb", file_name: "x.glb", fusion_version: 9, sha256: "g" }] }] });
  assert.deepEqual(expectedOutcome(noStep), { mode: "replace", letter: "A", fusion_version: null });
});

// ---------------------------------------------------------------------------
// verifyRun — happy paths
// ---------------------------------------------------------------------------
test("replace mode happy path: all five portal steps pass", () => {
  const v = verdict({ before: beforeReplace, after: afterReplace, expected: expectedOutcome(beforeReplace), send: sendReplace });
  assert.deepEqual(v.steps.map((s) => s.key), PORTAL_STEP_KEYS);
  assert.deepEqual(v.steps.map((s) => s.status), ["passed", "passed", "passed", "passed", "passed"], JSON.stringify(v.steps));
  assert.equal(v.passed, true);
  assert.equal(v.byKey.changelog.detail, "CAD revision B re-registered (step)");
});

test("new_letter mode happy path: all five portal steps pass", () => {
  const v = verdict({ before: beforeNew, after: afterNew, expected: expectedOutcome(beforeNew), send: sendNew, steps: saved(5, 6),
                      historyRows: [{ changed_at: T1, notes: "CAD revision B registered (step)" }] });
  assert.deepEqual(v.steps.map((s) => s.status), ["passed", "passed", "passed", "passed", "passed"], JSON.stringify(v.steps));
  assert.equal(v.passed, true);
});

test("the document may be ahead of the last send: v11 registered, saved v13 → v14 passes", () => {
  // v12 and v13 never left the engineer's machine (STATUS_MODEL §5.3); the run
  // proves one save, one version, and that the file carries the saved version.
  const before = snap({ revisions: [REL_A, { ...DRAFT_B, files: [file("f-b", 11, "bbbb")] }], drawings: DRAWINGS });
  const after = snap({ revisions: [REL_A, { ...DRAFT_B, files: [file("f-b", 14, "cccc")] }], drawings: DRAWINGS, history_count: 13, at: T1 });
  const v = verdict({ before, after, expected: expectedOutcome(before), send: { ...sendReplace, fusion_version: 14 }, steps: saved(13, 14) });
  assert.equal(v.byKey.versioning.status, "passed", v.byKey.versioning.detail);
  // …but a file older than the last registered one never passes.
  const stale = snap({ revisions: [REL_A, { ...DRAFT_B, files: [file("f-b", 10, "cccc")] }], drawings: DRAWINGS, history_count: 13, at: T1 });
  const w = verdict({ before, after: stale, expected: expectedOutcome(before), send: { ...sendReplace, fusion_version: 10 }, steps: saved(9, 10) });
  assert.match(w.byKey.versioning.detail, /already v11/);
});

test("the first STEP on a draft letter is inserted, not replaced", () => {
  const glbOnly = { ...DRAFT_B, files: [{ id: "g-b", format: "glb", file_name: `${DOC}.glb`, fusion_version: 7, sha256: "gggg" }] };
  const before = snap({ revisions: [REL_A, glbOnly], drawings: DRAWINGS });
  const after = snap({ revisions: [REL_A, { ...glbOnly, files: [...glbOnly.files, file("f-b", 8, "cccc")] }], drawings: DRAWINGS, history_count: 13, at: T1 });
  const v = verdict({ before, after, expected: expectedOutcome(before), send: { ...sendReplace, replaced: false, created: false } });
  assert.equal(v.passed, true, JSON.stringify(v.steps));
  const wrong = verdict({ before, after, expected: expectedOutcome(before), send: sendReplace });
  assert.match(wrong.byKey.versioning.detail, /replaced is true although/);
});

test("naming expects the sanitised stem the add-in produces", () => {
  const doc = `${PART} Drawer Front (M) & Co`;
  const name = `${PART} Drawer Front _M_ _ Co.step`;
  const before = snap({ revisions: [REL_A, DRAFT_B], drawings: DRAWINGS, fusion_document_name: doc });
  const after = snap({ revisions: [REL_A, { ...DRAFT_B, files: [file("f-b", 8, "cccc", name)] }], drawings: DRAWINGS, history_count: 13, at: T1, fusion_document_name: doc });
  const v = verdict({ before, after, expected: expectedOutcome(before), send: { ...sendReplace, file_name: name } });
  assert.equal(v.byKey.naming.status, "passed", v.byKey.naming.detail);
});

test("a replaced file leaves a checked letter checked; a minted letter is a draft", () => {
  const checkedB = { ...DRAFT_B, status: "checked" };
  const before = snap({ revisions: [REL_A, checkedB], drawings: DRAWINGS });
  const after = snap({ revisions: [REL_A, { ...checkedB, files: [file("f-b", 8, "cccc")] }], drawings: DRAWINGS, history_count: 13, at: T1 });
  const v = verdict({ before, after, expected: expectedOutcome(before), send: sendReplace });
  assert.equal(v.byKey.status.status, "passed", v.byKey.status.detail);
  const dropped = snap({ revisions: [REL_A, { ...DRAFT_B, files: [file("f-b", 8, "cccc")] }], drawings: DRAWINGS, history_count: 13, at: T1 });
  assert.match(verdict({ before, after: dropped, expected: expectedOutcome(before), send: sendReplace }).byKey.status.detail, /expected checked/);
});

test("a send that reports only registerCadRevision's answer still verifies", () => {
  // The add-in may store the raw answer (id, not file_id; no file_name/sha).
  const raw = { ok: true, id: "f-b", revision: "B", revision_id: "rev-b", status: "draft", replaced: true, created: false, format: "step" };
  const v = verdict({ before: beforeReplace, after: afterReplace, expected: expectedOutcome(beforeReplace), send: raw });
  assert.equal(v.passed, true, JSON.stringify(v.steps));
});

// ---------------------------------------------------------------------------
// verifyRun — one defect per step
// ---------------------------------------------------------------------------
test("naming fails when the file is not named from the hub document name", () => {
  const after = snap({ revisions: [REL_A, { ...DRAFT_B, files: [file("f-b", 8, "cccc", "Drawer Front M v8.step")] }],
                       drawings: DRAWINGS, history_count: 13, at: T1 });
  const v = verdict({ before: beforeReplace, after, expected: expectedOutcome(beforeReplace),
                      send: { ...sendReplace, file_name: "Drawer Front M v8.step" } });
  assert.equal(v.byKey.naming.status, "failed");
  assert.match(v.byKey.naming.detail, /expected ".*\.step"/);
  assert.equal(v.byKey.versioning.status, "passed", "naming alone is at fault");
  assert.equal(v.passed, false);
});

test("naming fails when the run renamed the CAD model's document", () => {
  const after = { ...afterReplace, fusion_document_name: `${DOC} v8` };
  const v = verdict({ before: beforeReplace, after, expected: expectedOutcome(beforeReplace), send: sendReplace });
  assert.equal(v.byKey.naming.status, "failed");
  assert.match(v.byKey.naming.detail, /fusion_document_name changed/);
});

test("versioning fails when the save made more than one version, or the file is not the saved one", () => {
  const after = snap({ revisions: [REL_A, { ...DRAFT_B, files: [file("f-b", 9, "cccc")] }], drawings: DRAWINGS, history_count: 13, at: T1 });
  // The add-in saved twice (v7 → v9).
  const two = verdict({ before: beforeReplace, after, expected: expectedOutcome(beforeReplace), send: { ...sendReplace, fusion_version: 9 }, steps: saved(7, 9) });
  assert.equal(two.byKey.versioning.status, "failed");
  assert.match(two.byKey.versioning.detail, /v7 → v9, expected exactly one version/);
  // The save produced v8 but the registered file says v9.
  const other = verdict({ before: beforeReplace, after, expected: expectedOutcome(beforeReplace), send: { ...sendReplace, fusion_version: 9 } });
  assert.match(other.byKey.versioning.detail, /file is Fusion v9, the save produced v8/);
  // No save numbers at all: the portal cannot judge, so it fails.
  const none = verdict({ before: beforeReplace, after: afterReplace, expected: expectedOutcome(beforeReplace), send: sendReplace, steps: [] });
  assert.match(none.byKey.versioning.detail, /recorded no Fusion version numbers/);
  assert.equal(two.passed, false);
});

test("versioning fails when the sha256 did not change", () => {
  const after = snap({ revisions: [REL_A, { ...DRAFT_B, files: [file("f-b", 8, "bbbb")] }], drawings: DRAWINGS, history_count: 13, at: T1 });
  const v = verdict({ before: beforeReplace, after, expected: expectedOutcome(beforeReplace), send: { ...sendReplace, sha256: "bbbb" } });
  assert.equal(v.byKey.versioning.status, "failed");
  assert.match(v.byKey.versioning.detail, /sha256 unchanged/);
});

test("versioning fails when a resend mints a new letter instead of replacing", () => {
  // The seam defect that started this: v8 should overwrite Rev B, not open Rev C.
  const after = snap({ revisions: [REL_A, DRAFT_B, { id: "rev-c", revision: "C", status: "draft", files: [file("f-c", 8, "cccc")] }],
                       drawings: DRAWINGS, history_count: 13, at: T1 });
  const send = { revision: "C", revision_id: "rev-c", file_id: "f-c", replaced: false, created: true, sha256: "cccc", file_name: `${DOC}.step`, fusion_version: 8 };
  const v = verdict({ before: beforeReplace, after, expected: expectedOutcome(beforeReplace), send });
  assert.equal(v.byKey.versioning.status, "failed");
  assert.match(v.byKey.versioning.detail, /landed on Rev C, expected the current Rev B/);
});

test("versioning fails in new_letter mode when the send overwrote instead of minting", () => {
  const send = { ...sendNew, created: false, replaced: true };
  const v = verdict({ before: beforeNew, after: afterNew, expected: expectedOutcome(beforeNew), send,
                      historyRows: [{ changed_at: T1, notes: "CAD revision B registered (step)" }] });
  assert.equal(v.byKey.versioning.status, "failed");
  assert.match(v.byKey.versioning.detail, /send\.created is not true/);
});

test("status fails when a released revision changed", () => {
  // The release moved: Rev B released by the send (and A superseded) — a draft send must never do that.
  const after = snap({ revisions: [{ ...REL_A, status: "superseded" }, { ...DRAFT_B, status: "released", files: [file("f-b", 8, "cccc")] }],
                       drawings: DRAWINGS, history_count: 13, at: T1 });
  const v = verdict({ before: beforeReplace, after, expected: expectedOutcome(beforeReplace), send: sendReplace });
  assert.equal(v.byKey.status.status, "failed");
  assert.match(v.byKey.status.detail, /released revision changed: Rev A → Rev B/);
  assert.match(v.byKey.status.detail, /expected draft/);
});

test("status fails when the dual-written model status disagrees with the current revision", () => {
  const after = { ...afterReplace, model_status: "released" };
  const v = verdict({ before: beforeReplace, after, expected: expectedOutcome(beforeReplace), send: sendReplace });
  assert.equal(v.byKey.status.status, "failed");
  assert.match(v.byKey.status.detail, /cad_models\.status "released" disagrees/);
});

test("supplier fails when the supplier view changed", () => {
  // The released CAD letter a supplier downloads moved from A to nothing.
  const after = { ...afterReplace, supplier_view: { cad_released_revision: null, drawings: afterReplace.supplier_view.drawings } };
  const v = verdict({ before: beforeReplace, after, expected: expectedOutcome(beforeReplace), send: sendReplace });
  assert.equal(v.byKey.supplier.status, "failed");
  assert.match(v.byKey.supplier.detail, /supplier view changed/);
  // Key order never counts as a change.
  const reordered = { ...afterReplace, supplier_view: { drawings: [{ released_revision: "B", drawing_number: "DRW-0007" }], cad_released_revision: "A" } };
  assert.equal(verdict({ before: beforeReplace, after: reordered, expected: expectedOutcome(beforeReplace), send: sendReplace }).byKey.supplier.status, "passed");
});

test("changelog fails without a matching history row after the request", () => {
  const base = { before: beforeReplace, after: afterReplace, expected: expectedOutcome(beforeReplace), send: sendReplace };
  const none = verdict({ ...base, historyRows: [] });
  assert.equal(none.byKey.changelog.status, "failed");
  assert.match(none.byKey.changelog.detail, /no bom_component_history row/);
  // A row from before the request does not count, however well it reads.
  const old = verdict({ ...base, historyRows: [{ changed_at: "2026-11-25T09:59:59Z", notes: "CAD revision B re-registered (step)" }] });
  assert.equal(old.byKey.changelog.status, "failed");
  // A row that says something else does not count either.
  const other = verdict({ ...base, historyRows: [{ changed_at: T1, notes: "CAD document linked: x" }] });
  assert.equal(other.byKey.changelog.status, "failed");
  assert.match(other.byKey.changelog.detail, /none says a CAD revision was registered/);
  // The count must grow too.
  const flat = verdict({ ...base, after: { ...afterReplace, history_count: 12 } });
  assert.equal(flat.byKey.changelog.status, "failed");
  assert.match(flat.byKey.changelog.detail, /history_count did not grow/);
});

test("verifyRun never throws on an empty run", () => {
  const v = verifyRun({});
  assert.equal(v.passed, false);
  assert.equal(v.steps.length, 5);
  assert.ok(v.steps.every((s) => s.status === "failed" && typeof s.detail === "string"));
});

// ---------------------------------------------------------------------------
// portal-api surface — no credentials
// ---------------------------------------------------------------------------
const notDeployed = (r) => /unknown action/i.test(r.json?.error ?? "");

for (const action of ACTIONS) {
  test(`${action} rejects an unauthenticated call`, async () => {
    const r = await call(action, { component_id: "x", run_id: "x", key: "claim", status: "passed" });
    if (notDeployed(r)) return;   // the deployed copy predates the agent
    assert.equal(r.status, 401, `${action} answered ${r.status} without a session`);
  });
}

// ---------------------------------------------------------------------------
// static guarantees
// ---------------------------------------------------------------------------
test("cad_test_runs is tenant-scoped", () => {
  const src = read("supabase/functions/_shared/tenant.ts");
  const block = src.match(/export const TENANT_TABLES = new Set\(\[([\s\S]*?)\]\);/)[1].replace(/\/\/.*$/gm, "");
  assert.ok(/"cad_test_runs"/.test(block), "cad_test_runs missing from TENANT_TABLES");
  const sql = read("supabase/migrations/0061_cad_test_runs.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS cad_test_runs \(/);
  assert.match(sql, /organization_id\s+UUID NOT NULL REFERENCES organizations\(id\)/);
  assert.match(sql, /ALTER TABLE cad_test_runs ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ON cad_test_runs \(organization_id, status, requested_at\)/, "the poll index is missing");
  for (const col of ["component_id", "cad_model_id", "status", "requested_by", "requested_at", "claimed_at", "claimed_by",
                     "finished_at", "before", "after", "expected", "send", "steps", "error", "created_at"]) {
    assert.ok(new RegExp(`^\\s+${col}\\s`, "m").test(sql), `column ${col} missing`);
  }
});

test("portal-api implements every test-agent action, Rushroom only, through the shared core", () => {
  const src = read("supabase/functions/portal-api/index.ts");
  assert.match(src, /from "\.\.\/_shared\/test-agent-core\.mjs"/, "portal-api does not import test-agent-core");
  for (const a of ACTIONS) {
    const i = src.indexOf(`action === "${a}"`);
    assert.ok(i >= 0, `portal-api does not implement ${a}`);
    const block = src.slice(i, i + 400);
    assert.match(block, /if \(role !== "rushroom"\) return json\(\{ error: "Rushroom only" \}, 403\);/, `${a} is not Rushroom-only`);
  }
  for (const fn of ["expectedOutcome", "verifyRun", "newSteps", "timeoutPatch", "buildSnapshot"]) {
    assert.ok(new RegExp(`\\b${fn}\\(`).test(src), `portal-api never calls ${fn}`);
  }
  // The claim is one guarded UPDATE, not a read-then-write.
  const poll = src.slice(src.indexOf('action === "pollCadTestRun"'), src.indexOf('action === "reportCadTestStep"'));
  assert.match(poll, /\.eq\("status", "requested"\)\.select\("\*"\)/, "the claim is not guarded by status = requested");
});

test("the test-agent core is pure: no Deno, Node or network APIs", () => {
  const src = read("supabase/functions/_shared/test-agent-core.mjs")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\bDeno\b|\bprocess\.|\brequire\(|\bfetch\(|from "node:/.test(src), "test-agent-core reaches outside pure JS");
  assert.match(src, /from "\.\/status-core\.mjs"/, "the letter rule must come from status-core");
});
