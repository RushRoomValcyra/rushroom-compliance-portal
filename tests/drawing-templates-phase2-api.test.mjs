// Drawing Templates phase 2 — the portal-api surface ("Rules he can see",
// docs/DRAWING_TEMPLATES.md §3, §4.4, §5.2, §10.2). Static over index.ts like
// the phase 1 api test, plus the pure helpers of render-job-core: the nine
// sandbox actions start with the Rushroom tier line and none is a supplier
// action; every sandbox write is rev-guarded; the pump hands out features and
// catch items without a render; finish caches features and stores the catch
// before the verification guard; a STEP upload queues its features.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  FEATURES_FORMAT, ITEM_PUMP_ORDER, pickNextItem, featuresFinishCheck, catchFinishCheck, buildCatchInput, newestReleasedStep,
  FEATURES_RETRY_COOLDOWN_MS, FEATURES_MAX_FAILS, FEATURES_FAIL_WINDOW_MS, featureKey, featureRetryBlocked, featureErrors,
} from "../supabase/functions/_shared/render-job-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const API = "supabase/functions/portal-api/index.ts";
const src = read(API);

const ACTIONS = [
  "createDrawingTemplateSandbox", "getDrawingTemplateSandbox", "applyDrawingTemplateOps", "removeDrawingTemplateOp",
  "renameDrawingTemplateSandbox", "setDrawingTemplateTryParts", "discardDrawingTemplateChange",
  "requestDrawingTemplateCatch", "getDrawingTemplateCatch",
];
const REV_GUARDED = [
  "applyDrawingTemplateOps", "removeDrawingTemplateOp", "renameDrawingTemplateSandbox",
  "setDrawingTemplateTryParts", "discardDrawingTemplateChange",
];
function block(action) {
  const at = src.indexOf(`if (action === "${action}") {`);
  assert.ok(at >= 0, `portal-api does not implement ${action}`);
  const next = src.indexOf("if (action === ", at + 10);
  return src.slice(at, next > 0 ? next : undefined);
}
const between = (a, b) => {
  const i = src.indexOf(a);
  assert.ok(i >= 0, `${a} not found`);
  return src.slice(i, src.indexOf(b, i));
};

test("each sandbox action starts with the Rushroom tier line and none is a supplier action", () => {
  const supplier = src.match(/const SUPPLIER_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1];
  const writes = src.match(/const SUPPLIER_WRITES = new Set\(\[([\s\S]*?)\]\);/)[1];
  for (const a of ACTIONS) {
    const first = block(a).split("\n")[1].trim();
    assert.equal(first, 'if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);', `${a} does not start with the tier line`);
    assert.ok(!supplier.includes(`"${a}"`), `${a} is in SUPPLIER_ACTIONS`);
    assert.ok(!writes.includes(`"${a}"`), `${a} is in SUPPLIER_WRITES`);
  }
  for (const f of ["supabase/functions/portal-ai/index.ts", "supabase/functions/portal-cellar/index.ts"]) {
    const other = read(f);
    for (const a of ACTIONS) assert.ok(!other.includes(`"${a}"`), `${a} is also handled in ${f}`);
  }
});

test("every sandbox write checks rev before writing and writes through the guarded update", () => {
  for (const a of REV_GUARDED) {
    const b = block(a);
    const check = b.indexOf("if (Number(body.rev) !== row.rev) return sandboxConflict(row);");
    assert.ok(check > 0, `${a} does not check rev`);
    const write = b.indexOf("await writeSandbox(tdb, row, {");
    assert.ok(write > check, `${a} writes before the rev check (or not through writeSandbox)`);
    assert.match(b, /if \(!next\) return sandboxConflict\(await loadSandbox\(tdb, row\.id\)\);/, `${a} ignores a lost race`);
    assert.match(b, /if \(row\.state !== "sandbox"\) return json\(\{ error: `Sandbox is \$\{row\.state\}` \}, 409\);/, `${a} writes a closed sandbox`);
  }
  const ws = between("async function writeSandbox(", "/** The sandbox row by id");
  assert.match(ws, /rev: row\.rev \+ 1/);
  assert.match(ws, /\.eq\("id", row\.id\)\.eq\("rev", row\.rev\)\.eq\("state", "sandbox"\)/, "the update is not guarded by rev and state");
  const conflict = between("function sandboxConflict(", "/** Write a sandbox guarded");
  assert.match(conflict, /rev: row\?\.rev \?\? null \}, 409\)/, "the 409 does not carry the row's rev");
});

test("apply: applyRuleOps all or nothing, 400 with the errors; marks stored; ops stored without marks", () => {
  const b = block("applyDrawingTemplateOps");
  assert.match(b, /applyRuleOps\(row\.body, ops\)/);
  assert.match(b, /if \(!applied\.ok\) \{[\s\S]*?\}, 400\);/);
  assert.match(b, /operations: \[\.\.\.prior, \.\.\.stored\], body: applied\.body, body_sha256: await canonicalSha\(applied\.body\)/);
  assert.match(b, /const \{ marks: _marks, \.\.\.rest \} = op/);
  assert.match(b, /tdb\("drawing_template_marks"\)\.insert\(markRows\)/);
  assert.ok(b.indexOf('tdb("bom_components").select("id").in("id", want)') < b.indexOf("writeSandbox("), "marked parts are checked after the write");
});

test("remove: the rest replayed from start_body; a broken replay refuses and names the change", () => {
  const b = block("removeDrawingTemplateOp");
  assert.match(b, /applyRuleOps\(row\.start_body, rest\)/);
  assert.match(b, /Taking out "\$\{lines\[index\]\}" breaks change \$\{broken \+ 1\}/);
  assert.ok(b.indexOf("breaks change") < b.indexOf("writeSandbox("), "the refusal comes after the write");
});

test("create starts from emptyRuleBody; discard cancels queued items; the type page lists sandboxes", () => {
  const c = block("createDrawingTemplateSandbox");
  assert.match(c, /const start = emptyRuleBody\(\);/);
  assert.match(c, /start_body: start, operations: \[\], body: start/);
  assert.match(c, /created_by_label: actorLabel\(session\)/);
  const d = block("discardDrawingTemplateChange");
  assert.match(d, /writeSandbox\(tdb, row, \{ state: "discarded" \}\)/);
  assert.match(d, /update\(\{ status: "cancelled"[\s\S]*?\.eq\("change_id", row\.id\)\.eq\("status", "queued"\)/);
  assert.match(d, /return json\(\{ ok: true \}\);/);
  const g = block("getDrawingTemplate");
  assert.match(g, /\.eq\("state", "sandbox"\)\.order\("created_at", \{ ascending: false \}\)/);
  assert.match(g, /sandboxes, edges: describeEdges\(DEFAULT_EDGES\), rules: \[\]/);
});

test("getDrawingTemplateSandbox answers sandbox, part_type, parts, catch and marks", () => {
  const b = block("getDrawingTemplateSandbox");
  assert.match(b, /return json\(\{ sandbox, part_type, parts, catch: caught, marks: marks \|\| \[\] \}\);/);
  assert.match(b, /loadSandboxParts\(tdb, part_type, sandbox\.try_component_ids\)/);
  const view = between("function sandboxView(", "/** The 409 every sandbox write");
  assert.match(view, /changes: describeRuleOps\(row\.start_body, operations\)/);
  const parts = between("async function loadSandboxParts(", "/** Queue a `features` item");
  assert.match(parts, /eq\("status", "released"\)/, "the parts take unreleased CAD");
  assert.match(parts, /eq\("format", "step"\)/);
  assert.match(parts, /newestReleasedStep\(/);
  assert.match(parts, /features_format", FEATURES_FORMAT\)/);
});

test("the catch request: a sandbox only; features queued first; an older queued catch replaced", () => {
  const b = block("requestDrawingTemplateCatch");
  assert.match(b, /if \(row\.state !== "sandbox"\) return json\(\{ error: `Sandbox is \$\{row\.state\}` \}, 409\);/);
  const feats = b.indexOf("queueFeatureItems(tdb, session, parts)");
  const ins = b.indexOf('purpose: "catch"');
  assert.ok(feats > 0 && feats < ins, "features are not queued ahead of the catch");
  assert.match(b, /request: \{ body_sha256: row\.body_sha256 \?\? null, mark \}/);
  assert.match(b, /\.eq\("change_id", row\.id\)\.eq\("purpose", "catch"\)\.eq\("status", "queued"\)/);
  assert.match(b, /return json\(\{ item_id: item\.id, queued_features \}\);/);
  const g = block("getDrawingTemplateCatch");
  assert.match(g, /item\.purpose !== "catch"/);
  assert.match(g, /return json\(\{ item, job: job \?\? null \}\);/);
  const q = between("async function queueFeatureItems(", "/** The pump's half for");
  assert.match(q, /\.eq\("purpose", "features"\)\s*\.in\("status", \["queued", "running"\]\)/, "an open features item is queued twice");
  assert.match(q, /features_format", FEATURES_FORMAT\)/);
});

test("the pump: features and catch items go to pumpRuleItem; no render, no spec, no drawing", () => {
  const pump = between("async function pumpTemplateItem(", "/**\n * Fan a drawing event out");
  assert.match(pump, /if \(item\.purpose === "features" \|\| item\.purpose === "catch"\) return await pumpRuleItem\(tdb, item, agent, at, failItem\);/);
  assert.ok(pump.indexOf("pumpRuleItem(") < pump.indexOf('item.purpose !== "reference"'), "features and catch are failed as not built");
  const rule = between("async function pumpRuleItem(", "/** The pump (DRAWING_TEMPLATES");
  assert.match(rule, /mode: item\.purpose, template_item_id: item\.id/);
  assert.match(rule, /spec_version_id: null, spec: null, issue: null/);
  assert.match(rule, /component_id: isCatch \? null : item\.component_id/);
  assert.match(rule, /mode: "catch", id: job\.id, template_item_id: item\.id, catch_input/);
  assert.match(rule, /mode: "features", id: job\.id, template_item_id: item\.id/);
  assert.match(rule, /step_url: signed\.signedUrl, step_file_name: stepFile\.file_name/);
  assert.match(rule, /cad_sha256: item\.cad_sha256/);
  assert.match(rule, /createSignedUrl\(stepFile\.storage_path, 3600\)/);
  assert.match(rule, /buildCatchInput\(\{/);
  assert.match(rule, /item\.request\.body_sha256 !== change\.body_sha256/, "a catch runs on a body it was not asked for");
  assert.match(rule, /status: "queued", taken_at: null/, "a failed job insert does not put the item back");
});

test("finish: features and catch branch before the verification guard; cache upserted; item done", () => {
  const finish = block("finishDrawingRender");
  const branch = finish.indexOf('if (job.mode === "features" || job.mode === "catch") {');
  assert.ok(branch > 0, "finish has no features/catch branch");
  assert.ok(branch < finish.indexOf("result.verify_ok === false"), "the branch is after the verify_ok guard");
  assert.ok(branch > finish.indexOf("if (body.error != null"), "a worker error does not fail the item first");
  const body = finish.slice(branch, finish.indexOf("return json({ ok: true });", branch));
  assert.match(body, /featuresFinishCheck\(\{ result: res, itemCadSha: item\.cad_sha256 \}\)/);
  assert.match(body, /catchFinishCheck\(\{ result: res, itemParts: item\.parts \}\)/);
  assert.match(body, /tdb\("cad_feature_cache"\)\.upsert\(\{[\s\S]*?\}, \{ onConflict: "cad_file_id,sha256,features_format" \}\)/);
  assert.match(body, /summary = check\.catch;/);
  assert.ok(body.includes("Features cached · no drawing written") && body.includes("Catch stored · no drawing written"));
  for (const t of ["drawing_revisions", "drawings\")", "documents", "bom_component_history", "supplier_", "insertDrawingRevision("]) {
    assert.ok(!body.includes(t), `the features/catch branch touches ${t}`);
  }
});

test("a STEP upload queues its features item; never fatal to the send", () => {
  const b = block("registerCadRevision");
  const hook = b.indexOf('if (format === "step" && sha256 && fileId && model.component_id) {');
  assert.ok(hook > 0, "registerCadRevision does not queue features");
  assert.ok(hook > b.indexOf('tdb("cad_model_files").insert({'), "the features item is queued before the file row");
  const seg = b.slice(hook, hook + 600);
  assert.match(seg, /try \{[\s\S]*queueFeatureItems\(tdb, session, \[\{[\s\S]*\} catch/);
});

test("the new tables are only read through tdb", () => {
  for (const t of ["drawing_template_changes", "drawing_template_marks", "cad_feature_cache"]) {
    assert.ok(!new RegExp(`db\\.from\\("${t}"\\)`).test(src), `${t} is read with db.from (unscoped)`);
  }
});

// ---------------------------------------------------------------------------
// The pure helpers (render-job-core)
// ---------------------------------------------------------------------------
const SHA = "a".repeat(64);

test("FEATURES_FORMAT is 1 and equals catch.py's when the engine file is present", () => {
  assert.equal(FEATURES_FORMAT, 1);
  // The engine repo lives outside this one; check it only where it exists.
  const p = "/Users/famqvick/Documents/Claude/Projects/VALCYRA Interiors/fusion_scripts/catch.py";
  let py = null;
  try { py = readFileSync(p, "utf8"); } catch { /* not on this machine */ }
  if (py) {
    const m = py.match(/^FEATURES_FORMAT\s*=\s*(\d+)/m);
    assert.ok(m, "catch.py has no FEATURES_FORMAT constant");
    assert.equal(Number(m[1]), FEATURES_FORMAT, "catch.py and render-job-core disagree on FEATURES_FORMAT");
  }
});

test("the pump order puts features and catch first", () => {
  assert.deepEqual(ITEM_PUMP_ORDER.slice(0, 2), ["features", "catch"]);
  const items = [
    { id: "1", purpose: "reference", status: "queued", created_at: "2026-11-28T10:00:00Z" },
    { id: "2", purpose: "catch", status: "queued", created_at: "2026-11-28T10:01:00Z" },
    { id: "3", purpose: "features", status: "queued", created_at: "2026-11-28T10:02:00Z" },
  ];
  assert.equal(pickNextItem(items).id, "3");
});

test("featuresFinishCheck: the item's bytes, the portal's format, an object", () => {
  assert.deepEqual(featuresFinishCheck({ result: { cad_sha256: "b".repeat(64), features_format: 1, features: {} }, itemCadSha: SHA }),
    { error: "STEP changed while reading its features" });
  assert.match(featuresFinishCheck({ result: { cad_sha256: SHA, features_format: 2, features: {} }, itemCadSha: SHA }).error, /format 2/);
  assert.deepEqual(featuresFinishCheck({ result: { cad_sha256: SHA, features_format: 1, features: [] }, itemCadSha: SHA }), { error: "No features returned" });
  const ok = featuresFinishCheck({ result: { cad_sha256: SHA.toUpperCase(), features_format: 1, features: { holes: [] }, drawset_version: "3.2" }, itemCadSha: SHA });
  assert.deepEqual(ok, { features_format: 1, features: { holes: [] }, cad_sha256: SHA, drawset_version: "3.2" });
});

test("catchFinishCheck: one answer per part asked", () => {
  assert.deepEqual(catchFinishCheck({ result: {}, itemParts: [] }), { error: "No catch returned" });
  const parts = [{ component_id: "p1" }, { component_id: "p2" }];
  assert.match(catchFinishCheck({ result: { catch: { parts: [{ key: "p1" }] } }, itemParts: parts }).error, /1 of 2 parts/);
  const out = { features_format: 1, parts: [{ key: "p1" }, { key: "p2" }], candidates: [], mark: null };
  assert.deepEqual(catchFinishCheck({ result: { catch: out, drawset_version: "3.2" }, itemParts: parts }), { catch: out, drawset_version: "3.2" });
});

test("buildCatchInput: the contract's shape; missing features are null", () => {
  const input = buildCatchInput({
    datums: { x: "min", y: "min", inside_face: "max", y_from_top_within: 0 },
    rules: [{ id: "r_abcdef", name: "Lower pair", select: [], at_least: 2, measure: {} }],
    edges: { front: { test: "as_modelled" } },
    parts: [
      { component_id: "p1", cad_model_revision_id: "r1", cad_file_id: "f1", cad_sha256: SHA },
      { component_id: "p2", cad_model_revision_id: "r2", cad_file_id: "f2", cad_sha256: SHA },
    ],
    cache: new Map([[`f1:${SHA}`, { holes: [1] }]]),
    labels: new Map([["p1", "Side Panel Left"]]),
    mark: { component_id: "p1", hole_id: "H12" },
  });
  assert.deepEqual(input.base, { datums: { x: "min", y: "min", inside_face: "max" } });
  assert.deepEqual(input.parts, [
    { key: "p1", label: "Side Panel Left", cad_sha256: SHA, features: { holes: [1] } },
    { key: "p2", label: null, cad_sha256: SHA, features: null },
  ]);
  assert.deepEqual(input.mark, { key: "p1", hole_id: "H12" });
  assert.equal(input.rules.length, 1);
  assert.equal(buildCatchInput({ parts: [] }).mark, null);
});

test("newestReleasedStep: the highest letter that has a STEP with a sha", () => {
  const cmp = (a, b) => String(a).localeCompare(String(b));
  const stepOf = new Map([["ra", { id: "fa", sha256: SHA }], ["rc", { id: "fc", sha256: null }]]);
  assert.deepEqual(newestReleasedStep([{ id: "ra", revision: "A" }, { id: "rc", revision: "C" }], stepOf, cmp),
    { cad_model_revision_id: "ra", revision: "A", cad_file_id: "fa", cad_sha256: SHA });
  assert.equal(newestReleasedStep([], stepOf, cmp), null);
});

// --- review fixes: a failed features read, marks before the guarded write ----
test("a failed features read is not re-queued at once: the cooldown is read in queueFeatureItems", () => {
  const q = between("async function queueFeatureItems(", "/** The pump's half for");
  assert.match(q, /\.eq\("purpose", "features"\)\s*\.eq\("status", "failed"\)\.in\("cad_file_id", fileIds\)/, "failed features items are not read");
  assert.match(q, /\.gte\("created_at", new Date\(now - FEATURES_FAIL_WINDOW_MS\)\.toISOString\(\)\)/);
  const block_ = q.indexOf("for (const k of featureRetryBlocked((failed || []) as any[], now)) have.add(k);");
  assert.ok(block_ > 0, "the blocked keys do not count as covered");
  assert.ok(block_ < q.indexOf("for (const p of want)"), "the cooldown is applied after the rows are built");
  assert.match(q, /const key = featureKey\(p\.cad_file_id, p\.cad_sha256\);\s*if \(have\.has\(key\)\) continue;/);
});

test("featureRetryBlocked: ten minutes after a failure, or three failures in a day", () => {
  assert.equal(FEATURES_RETRY_COOLDOWN_MS, 600_000);
  assert.equal(FEATURES_MAX_FAILS, 3);
  const now = Date.parse("2026-11-28T12:00:00Z");
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const A = "a".repeat(64), B = "b".repeat(64);
  const fail = (file, sha, min, extra = {}) => ({ cad_file_id: file, cad_sha256: sha, status: "failed", finished_at: ago(min), created_at: ago(min + 1), ...extra });
  assert.equal(featureKey("f1", A.toUpperCase()), `f1:${A}`);
  // One failure 9 minutes ago blocks; 11 minutes ago does not.
  assert.deepEqual([...featureRetryBlocked([fail("f1", A, 9)], now)], [`f1:${A}`]);
  assert.deepEqual([...featureRetryBlocked([fail("f1", A, 11)], now)], []);
  // finished_at decides, created_at only when it is missing.
  assert.deepEqual([...featureRetryBlocked([fail("f1", A, 30, { finished_at: null, created_at: ago(5) })], now)], [`f1:${A}`]);
  // Three old failures block; two do not; other bytes of the same file are free.
  const three = [fail("f1", A, 60), fail("f1", A, 120), fail("f1", A, 180), fail("f1", B, 60), fail("f1", B, 120)];
  assert.deepEqual([...featureRetryBlocked(three, now)], [`f1:${A}`]);
  // A failure older than the window no longer counts.
  const old = [fail("f1", A, 60), fail("f1", A, 120), fail("f1", A, FEATURES_FAIL_WINDOW_MS / 60_000 + 5)];
  assert.deepEqual([...featureRetryBlocked(old, now)], []);
  // Only failed items count, and rows without a file or sha are ignored.
  assert.deepEqual([...featureRetryBlocked([fail("f1", A, 1, { status: "done" }), fail(null, A, 1), fail("f1", null, 1), null], now)], []);
  assert.deepEqual([...featureRetryBlocked(null, now)], []);
});

test("featureErrors: the newest features item per bytes, only when it failed", () => {
  const A = "a".repeat(64), B = "b".repeat(64);
  const it = (file, sha, status, at, error = null) => ({ cad_file_id: file, cad_sha256: sha, status, error, created_at: at });
  const m = featureErrors([
    it("f1", A, "failed", "2026-11-28T10:00:00Z", "old reason"),
    it("f1", A, "failed", "2026-11-28T11:00:00Z", "STEP changed while reading its features"),
    it("f2", A, "failed", "2026-11-28T10:00:00Z", "gone"),
    it("f2", A, "queued", "2026-11-28T11:00:00Z"),
    it("f3", B, "failed", "2026-11-28T10:00:00Z"),
  ]);
  assert.equal(m.get(`f1:${A}`), "STEP changed while reading its features");
  assert.ok(!m.has(`f2:${A}`), "a read that is queued again still shows the old failure");
  assert.equal(m.get(`f3:${B}`), "Failed");
  assert.equal(featureErrors(null).size, 0);
});

test("the sandbox parts carry features_error for a part without features", () => {
  const parts = between("async function loadSandboxParts(", "/** A sandbox's marks, oldest first");
  assert.match(parts, /has_features: false, features_error: null,/);
  assert.match(parts, /select\("cad_file_id, cad_sha256, status, error, created_at"\)\.eq\("purpose", "features"\)/);
  assert.match(parts, /const failed = featureErrors\(\(asked \|\| \[\]\) as any\[\]\);/);
  assert.match(parts, /r\.features_error = key && !r\.has_features \? failed\.get\(key\) \?\? null : null;/);
});

test("apply: marks are stored before the guarded write and taken out again when it loses", () => {
  const b = block("applyDrawingTemplateOps");
  const ins = b.indexOf('tdb("drawing_template_marks").insert(markRows).select("id")');
  const write = b.indexOf("await writeSandbox(tdb, row, {");
  const undo = b.indexOf('if (!next && markIds.length) await tdb("drawing_template_marks").delete().in("id", markIds);');
  const lost = b.indexOf("if (!next) return sandboxConflict(await loadSandbox(tdb, row.id));");
  assert.ok(ins > 0 && ins < write, "the marks are stored after the sandbox write");
  assert.ok(undo > write && undo < lost, "a lost write leaves its marks behind");
  assert.match(b, /if \(mErr\) return json\(\{ error: `Marks not saved: \$\{mErr\.message\}` \}, 500\);/);
  assert.ok(b.indexOf("Marks not saved") < write, "a marks failure is answered after the sandbox was written");
  assert.ok(!/Marks not saved[^\n]*sandbox: sandboxView/.test(b), "a failed apply still answers a sandbox");
});

test("apply and remove answer the sandbox's marks beside the sandbox, read as the page read does", () => {
  for (const a of ["applyDrawingTemplateOps", "removeDrawingTemplateOp"]) {
    assert.match(block(a), /return json\(\{ sandbox: sandboxView\(next\), marks: await loadSandboxMarks\(tdb, row\.id\) \}\);/, `${a} does not answer marks`);
  }
  const r = block("removeDrawingTemplateOp");
  assert.ok(r.indexOf('.delete().in("id", gone)') < r.indexOf("marks: await loadSandboxMarks"), "remove reads the marks before dropping the dead ones");
  assert.match(block("getDrawingTemplateSandbox"), /loadSandboxMarks\(tdb, row\.id\),/);
  const m = between("async function loadSandboxMarks(", "/** Queue a `features` item");
  assert.match(m, /tdb\("drawing_template_marks"\)\.select\(TEMPLATE_MARK_FIELDS\)\.eq\("change_id", changeId\)\.order\("created_at", \{ ascending: true \}\)/);
});
