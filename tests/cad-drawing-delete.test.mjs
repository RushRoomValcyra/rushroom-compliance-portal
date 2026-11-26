// docs/STATUS_MODEL.md §5.5 — deleting CAD and drawings: admin only, rules by
// state, storage first, the current pointer handed on, a trace always.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const api = readFileSync(resolve(root, "supabase/functions/portal-api/index.ts"), "utf8");
const app = readFileSync(resolve(root, "assets/app.js"), "utf8");

function block(action) {
  const at = api.indexOf(`if (action === "${action}")`);
  assert.ok(at > 0, `portal-api has no ${action}`);
  const next = api.indexOf("\n  if (action === \"", at + 10);
  return api.slice(at, next > 0 ? next : undefined);
}
const describe = api.slice(api.indexOf("const describeDeletion = async"), api.indexOf('if (action === "previewDelete")'));

test("both actions are admin-only and accept exactly the four kinds", () => {
  for (const a of ["previewDelete", "deleteObject"]) {
    const b = block(a);
    assert.match(b, /^\s*if \(action === "[a-zA-Z]+"\) \{\n\s*if \(!isAdmin\) return json\(\{ error: "Admin only" \}, 403\);/m, `${a} must gate first`);
    assert.ok(b.includes("DELETE_KINDS.includes(kind)"), `${a} checks the kind`);
  }
  assert.match(api, /const DELETE_KINDS = \["drawing", "drawing_revision", "cad_model", "cad_revision"\];/);
});

test("the preview and the delete share one description, so the dialog shows what will happen", () => {
  assert.ok(block("previewDelete").includes("await describeDeletion(kind, id)"));
  assert.ok(block("deleteObject").includes("await describeDeletion(kind, id)"));
  assert.ok(block("previewDelete").includes("const { storage_paths: _sp, ...shown } = facts;"), "storage paths never reach the browser");
});

test("a released or superseded revision, or a fetched one, needs the letter typed back; a draft does not", () => {
  assert.ok(describe.includes('const governed = out.revisions.some((r: any) => r.status === "released" || r.status === "superseded");'));
  assert.ok(describe.includes("if (governed || out.supplier_fetches.count) {"));
  const b = block("deleteObject");
  assert.ok(b.includes('if (facts.confirm_with && String(body.confirm ?? "").trim() !== facts.confirm_with) {'), "the delete re-checks the typed confirmation");
  assert.ok(b.includes("if (facts.blocked) return json({ error: facts.blocked }, 409);"));
});

test("the supplier's fetches are counted from supplier_file_events through the tenant client", () => {
  assert.ok(describe.includes('await tdb("supplier_file_events").select("supplier_id, at").in(eventFilter.column, eventFilter.ids)'));
  assert.ok(describe.includes('eventFilter = { column: "drawing_revision_id"'));
  assert.ok(describe.includes('eventFilter = { column: "cad_file_id"'));
});

test("storage goes first, then the rows; a current revision hands its pointer on by the release rule", () => {
  const b = block("deleteObject");
  const rm = b.indexOf("db.storage.from(DOC_BUCKET).remove(facts.storage_paths)");
  const rows = b.indexOf('tdb("drawings").delete()');
  assert.ok(rm > 0 && rows > rm, "files are removed before any row");
  assert.ok(b.includes("const next = deriveObject(all).current;"), "a deleted current issue hands the pointer to the one that remains");
  assert.ok(b.includes("await syncCadModel(tdb, facts.object.cad_model_id);"), "a deleted CAD revision re-derives the model's current pointer");
  for (const tbl of ["drawings", "drawing_revisions", "cad_models", "cad_model_revisions"]) {
    assert.ok(b.includes(`tdb("${tbl}").delete()`), `${tbl} is deleted through the tenant client`);
  }
});

test("every deletion leaves a trace: one audit row and one history line per part", () => {
  const b = block("deleteObject");
  assert.ok(b.includes('action: kind.startsWith("cad") ? "cad_deleted" : "drawing_deleted"'));
  assert.ok(b.includes("revisions: facts.revisions, supplier_fetches: facts.supplier_fetches"), "the audit keeps every letter, file and sha");
  assert.ok(b.includes('await tdb("bom_component_history").insert({'));
  assert.ok(b.includes('change_type: kind.startsWith("cad") ? "cad_deleted" : "drawing_deleted"'));
});

test("the history CHECK knows the two deletion events (0067) and the insert's error is reported, not swallowed", () => {
  const mig = readFileSync(resolve(root, "supabase/migrations/0067_delete_history_events.sql"), "utf8");
  assert.match(mig, /ADD CONSTRAINT bom_component_history_change_type_check/);
  assert.ok(mig.includes("'drawing_deleted','cad_deleted'"));
  for (const ev of ["created", "updated", "version_bumped", "document_linked", "document_revised", "drawing_linked", "drawing_revised", "drawing_released", "drawing_adopted"]) {
    assert.ok(mig.includes(`'${ev}'`), `0067 keeps ${ev}`);
  }
  const b = block("deleteObject");
  assert.ok(b.includes('const { error: hErr } = await tdb("bom_component_history").insert({'));
  assert.ok(b.includes("history_errors.push("));
  assert.ok(b.includes("after: facts.after, history_errors });"));
});

test("the preview never carries a storage path, at any depth", () => {
  const b = block("previewDelete");
  assert.ok(b.includes("files: r.files.map(({ storage_path: _p, ...f }: any) => f)"));
});

test("a whole drawing a surgery template points at is refused before anything goes", () => {
  assert.ok(describe.includes('await tdb("surgery_templates").select("id, code").eq("drawing_id", d.id)'));
  assert.ok(describe.includes("Delete the template first."));
});

test("the dialog is admin-only in the UI and sits on the four objects", () => {
  assert.ok(app.includes("function deleteModal(kind, id, opts = {}) {"));
  for (const kind of ["cad_revision", "cad_model", "drawing_revision", "drawing"]) {
    assert.ok(app.includes(`deleteModal("${kind}",`), `no Delete for ${kind}`);
  }
  // Every call site sits within a few lines of an API.isAdmin() check.
  let at = -1, sites = 0;
  while ((at = app.indexOf('deleteModal("', at + 1)) !== -1) {
    sites++;
    const guard = app.lastIndexOf("API.isAdmin()", at);
    assert.ok(guard !== -1 && at - guard < 600, `a Delete button at offset ${at} is not behind API.isAdmin()`);
  }
  assert.ok(sites >= 4, "four Delete call sites");
  assert.ok(app.includes('await API.post(token, "deleteObject", { kind, id, confirm: confirmInp ? confirmInp.value.trim() : "" });'));
  assert.ok(app.includes('deleteBtn.disabled = confirmInp.value.trim() !== needs;'), "Delete stays disabled until the letter is typed");
});

test("a supplier session never reaches the delete actions", () => {
  const m = api.match(/const SUPPLIER_ACTIONS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m);
  assert.ok(!m[1].includes("deleteObject") && !m[1].includes("previewDelete"));
});
