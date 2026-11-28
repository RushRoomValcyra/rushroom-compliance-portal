// Drawing Templates phase 1 — the portal-api surface (docs/DRAWING_TEMPLATES.md
// §4, §5.2, §10.2, §11). Static, no network: the eleven actions exist in
// portal-api, each starts with the Rushroom tier line and none is a supplier
// action; the part type history is written directly and checked; reference
// renders stay out of every list a person reads; the poll is the pump; finish
// treats a sandbox job before the verification guard; the worker mirrors the
// Base alone; a reference cannot be deleted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const API = "supabase/functions/portal-api/index.ts";
const src = read(API);

const ACTIONS = [
  "listPartTypes", "createPartType", "renamePartType", "retirePartType", "setComponentPartType",
  "listPartTypeReferenceCandidates", "setPartTypeReference", "listDrawingTemplates", "getDrawingTemplate",
  "getDrawingTemplateItem", "compareDrawingTemplateVersions",
];
/** One action's block: from its dispatch line to the next action's. */
function block(action) {
  const at = src.indexOf(`if (action === "${action}") {`);
  assert.ok(at >= 0, `portal-api does not implement ${action}`);
  const next = src.indexOf("if (action === ", at + 10);
  return src.slice(at, next > 0 ? next : undefined);
}
const between = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));

test("each of the eleven actions starts with the Rushroom tier line and none is a supplier action", () => {
  const supplier = src.match(/const SUPPLIER_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1];
  const writes = src.match(/const SUPPLIER_WRITES = new Set\(\[([\s\S]*?)\]\);/)[1];
  for (const a of ACTIONS) {
    const first = block(a).split("\n")[1].trim();
    assert.equal(first, 'if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);', `${a} does not start with the tier line`);
    assert.ok(!supplier.includes(`"${a}"`), `${a} is in SUPPLIER_ACTIONS`);
    assert.ok(!writes.includes(`"${a}"`), `${a} is in SUPPLIER_WRITES`);
  }
  // Nothing heavy: every action lives in portal-api only.
  for (const f of ["supabase/functions/portal-ai/index.ts", "supabase/functions/portal-cellar/index.ts"]) {
    const other = read(f);
    for (const a of ACTIONS) assert.ok(!other.includes(`"${a}"`), `${a} is also handled in ${f}`);
  }
});

test("setComponentPartType writes its history row directly and checks the error", () => {
  const b = block("setComponentPartType");
  assert.ok(b.includes('tdb("bom_component_history").insert({'), "the history row is not inserted directly");
  assert.ok(!b.includes("writeBomHistory("), "writeBomHistory swallows errors");
  assert.match(b, /change_type: "part_type_changed"/);
  assert.match(b, /if \(hErr\) \{/, "the history insert's error is not checked");
  assert.match(b, /reason: "History not written"/);
  assert.match(b, /Part type: \$\{nameOf\(from\)\} → \$\{nameOf\(targetId\)\}/);
  // The per-part rule (refused / unchanged / change) is partTypeChange, tested in drawing-template-core.
  assert.match(b, /partTypeChange\(comp \?\? null, targetId, refOf\.get\(cid\) \?\? null\)/);
  assert.match(b, /await tdb\("bom_components"\)\.update\(\{ part_type_id: from \}\)\.eq\("id", cid\)/, "a failed history insert does not roll the type back");
  assert.match(b, /ids\.length > 200/);
});

test("setPartTypeReference: the order of its checks, the cancel of queued items, the item on the Base", () => {
  const b = block("setPartTypeReference");
  const order = ["Part type is retired", "Choose a released revision", "Revision has no STEP file", "Part is of part type", "No Base template",
                 '"History not written" }, 500', "reference_component_id: comp.id", '"cancelled"', 'purpose: "reference"', "part_type_reference_set"];
  let last = -1;
  for (const k of order) {
    const i = b.indexOf(k);
    assert.ok(i > last, `${k} is missing or out of order`);
    last = i;
  }
  assert.match(b, /requested_by_label: actorLabel\(session\)/);
  assert.match(b, /spec_version_id: base\.spec\.current_version_id/);
});

test("reference renders stay out of the lists a person reads", () => {
  assert.match(block("listDrawingRenderJobs"), /\.is\("template_item_id", null\)/, "the last-10 panel lists item jobs");
  const describe = between("const describeDeletion = async", 'if (action === "previewDelete")');
  assert.match(describe, /\.in\("cad_file_id", fileIds\)\.is\("template_item_id", null\)/, "the CAD delete count includes item jobs");
});

test("the poll is the pump: only when no real job is requested; the claim is guarded", () => {
  const poll = block("pollDrawingRenderJob");
  const noTarget = poll.indexOf("if (!target) {");
  assert.ok(noTarget >= 0 && poll.indexOf("pumpTemplateItem(tdb, agent)") > noTarget, "the pump does not run on the no-job path");
  assert.ok(poll.indexOf("pumpTemplateItem(") < poll.indexOf('.eq("id", target.id).eq("status", "requested")'), "the pump runs after a real claim");
  const pump = between("async function pumpTemplateItem(", "/**\n * Fan a drawing event out");
  assert.match(pump, /update\(\{ status: "running", taken_at: at \}\)\s*\.eq\("id", next\.id\)\.eq\("status", "queued"\)\.select\("\*"\)/, "the item claim is not guarded by status = queued");
  assert.match(pump, /pickNextItem\(queued \|\| \[\]\)/);
  assert.match(pump, /mode: "sandbox", template_item_id: item\.id/);
  assert.match(pump, /status: "queued", taken_at: null/, "a failed job insert does not put the item back");
  assert.match(pump, /if \(item\.error\) \{ await failItem\(reason\); return null; \}/, "a second insert failure flaps instead of failing");
  assert.match(pump, /\.eq\("status", "running"\)\.is\("job_id", null\)\.lt\("taken_at"/, "an orphaned claim is never closed");
  assert.match(pump, /ITEM_PUMP_ORDER\.map\(/, "a full window is not read per purpose");
  assert.match(pump, /sandboxTitleBlock\(component\?\.name \?\? null, out\?\.cad_revision \?\? null\)/);
  assert.match(pump, /title_block: sandboxTitleBlock\(/);
  assert.match(pump, /createSignedUrl\(stepFile\.storage_path, 3600\)/);
});

test("finish: the sandbox branch sits before the verification guard and writes no drawing", () => {
  const finish = block("finishDrawingRender");
  const branch = finish.indexOf('if (job.mode === "sandbox") {');
  assert.ok(branch >= 0, "finishDrawingRender has no sandbox branch");
  assert.ok(branch < finish.indexOf("result.verify_ok === false"), "the sandbox branch is after the verify_ok guard");
  const body = finish.slice(branch, finish.indexOf("return json({ ok: true });", branch));
  // The three checks live in sandboxFinishCheck (tested in drawing-template-core); the branch fails on its error.
  assert.match(body, /sandboxFinishCheck\(\{/);
  assert.match(body, /if \("error" in check\) return await fail\(check\.error\);/);
  assert.ok(body.includes("Reference drawn · no drawing written"), "the sandbox branch lacks its register word");
  for (const t of ["drawing_revisions", "drawings\")", "documents", "bom_component_history", "supplier_"]) {
    assert.ok(!body.includes(t), `the sandbox branch touches ${t}`);
  }
  assert.ok(!body.includes("insertDrawingRevision("), "the sandbox branch registers an issue");
  // A failure of the job fails its item too.
  const fail = finish.slice(finish.indexOf("const fail = async"), finish.indexOf("if (body.error != null"));
  assert.match(fail, /drawing_template_items"\)\.update\(\{ status: "failed"/);
});

test("cancel refuses a reference render; expiry fails its item", () => {
  assert.match(block("cancelDrawingRenderJob"), /job\.mode === "sandbox"\) return json\(\{ error: "Reference renders cannot be cancelled" \}, 409\)/);
  const expire = between("async function expireDrawingRenderJobs(", "async function withRenderJobContext(");
  assert.match(expire, /template_item_id/);
  assert.match(expire, /drawing_template_items"\)\.update\(\{ status: "failed", error: patch\.error/);
});

test("the upload url serves a sandbox job under its item's folder", () => {
  const up = block("drawingRenderUploadUrl");
  assert.match(up, /job\.mode !== "sandbox" && !job\.drawing_id/);
  assert.match(src, /`drawing-templates\/items\/\$\{job\.template_item_id\}\/renders\/\$\{job\.id\}\/`/);
});

test("the worker mirrors the Base alone and never touches a portal-owned spec", () => {
  const tl = between("async function templateList(", "async function drawingsPerVersion(");
  assert.match(tl, /r\.level === "base"/, "templateList does not filter on level");
  const reg = block("registerDrawingSpecs");
  assert.match(reg, /tdb\("drawing_render_specs"\)\.delete\(\)\.eq\("portal_owned", false\)/, "the delete can remove a portal-owned row");
  assert.match(reg, /if \(owned\.has\(n\.name\)\) continue;/, "a portal-owned row is upserted");
  assert.match(reg, /level: n\.name === "flat_panel" \? "base" : "legacy"/);
});

test("a reference cannot be deleted: CAD revision and part", () => {
  const describe = between("const describeDeletion = async", 'if (action === "previewDelete")');
  assert.match(describe, /out\.blocked = `Reference of part type \$\{/);
  assert.match(describe, /reference_cad_model_revision_id/);
  const del = block("deleteComponent");
  const check = del.indexOf("Reference of part type");
  assert.ok(check > 0, "deleteComponent does not block a reference");
  assert.ok(check < del.indexOf(".delete()"), "the reference block comes after a write");
  // Earlier reference renders made from the deleted files lose their sheets too.
  const obj = block("deleteObject");
  const rm = obj.indexOf("removeRenderArtifacts(j)");
  assert.ok(rm > 0, "deleteObject leaves sandbox sheets behind");
  assert.ok(rm < obj.indexOf('tdb("cad_model_revisions").delete()'), "the sheets must be removed before the rows go");
});

test("the Change Log reads part_type_changed; listComponents and listDrawings carry the new fields", () => {
  const ev = src.match(/const HISTORY_EVENTS = \[([\s\S]*?)\];/)[1];
  assert.ok(ev.includes('"part_type_changed"'), "HISTORY_EVENTS lacks part_type_changed");
  assert.match(block("listComponents"), /category_id, part_type_id,/);
  const ld = block("listDrawings");
  assert.match(ld, /const labelOf = role === "rushroom" \? await templateLabelsByRevision\(tdb\) : null;/, "suppliers get the template label");
  assert.match(ld, /template_label:/);
});

test("both new tables are only read through tdb", () => {
  for (const t of ["part_types", "drawing_template_items"]) {
    assert.ok(!new RegExp(`db\\.from\\("${t}"\\)`).test(src), `${t} is read with db.from (unscoped)`);
  }
});
