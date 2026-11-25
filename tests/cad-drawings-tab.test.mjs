// CAD & Drawings tab — the portal-api contract of docs/DRAWINGS_TAB_UX.md §10.
//
// Static tests over portal-api/index.ts: the three actions emit the added
// fields, listCadModels fetches the drawings in whole-register queries (never
// per model), and nothing that was there before is gone. The credentialed
// tests skip without TEST_RUSHROOM_PASSWORD, matching the harness convention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CREDS, call, loginShared } from "./config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const src = read("supabase/functions/portal-api/index.ts");

/** The body of one `if (action === "name")` block: from its head to the next
 *  action head at the same indentation. */
function actionBlock(name) {
  const head = `  if (action === "${name}")`;
  const start = src.indexOf(head);
  assert.notEqual(start, -1, `portal-api does not dispatch ${name}`);
  const rest = src.slice(start + head.length);
  const next = rest.search(/\n  if \(action === "/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The deployed copy may predate these fields; skip rather than fail. */
const notDeployed = (r) => /unknown action/i.test(r.json?.error ?? "");

test("listCadModels emits the §10 fields on every row", () => {
  const block = actionBlock("listCadModels");
  for (const field of ["drawings", "warnings: summary.warnings", "supplier_sees", "updated_at", "current_revision_id"]) {
    assert.ok(block.includes(field), `listCadModels does not emit ${field}`);
  }
  // Nothing removed: the fields the register already reads.
  for (const field of ["component_name", "part_number", "current_revision", "status", "current_status",
                       "released_revision", "revision_count", "formats", "preview_file"]) {
    assert.ok(new RegExp(`\\b${field}\\b`).test(block), `listCadModels lost ${field}`);
  }
});

test("listCadModels loads the drawings in three whole-register queries, not per model", () => {
  const block = actionBlock("listCadModels");
  // The three tables, each queried once with an .in(...) over all ids.
  assert.ok(/tdb\("drawing_components"\)[\s\S]*?\.in\("component_id", compIds\)/.test(block),
    "drawing_components must be read for all component ids at once");
  assert.ok(/tdb\("drawings"\)[\s\S]*?\.in\("id", drawingIds\)/.test(block),
    "drawings must be read for all drawing ids at once");
  assert.ok(block.includes("loadDrawingRevisions(tdb, drawingIds)"),
    "drawing_revisions must come through loadDrawingRevisions for all drawing ids");
  assert.equal((block.match(/tdb\("drawing_components"\)/g) || []).length, 1);
  assert.equal((block.match(/tdb\("drawings"\)/g) || []).length, 1);
  assert.equal((block.match(/loadDrawingRevisions\(/g) || []).length, 1);
  // The per-model map must not query drawing tables.
  const perModel = block.slice(block.indexOf("const enriched = await Promise.all"));
  assert.ok(!/tdb\("drawing/.test(perModel), "a drawing query inside the per-model map");
  assert.ok(!/loadDrawingRevisions/.test(perModel), "loadDrawingRevisions inside the per-model map");
});

test("listCadModels builds the warnings with statusSummary the way getComponentCad does", () => {
  const block = actionBlock("listCadModels");
  assert.ok(/statusSummary\(\{\s*drawings: summaryDrawings,\s*cad: \{ revisions:/.test(block),
    "statusSummary must receive { drawings, cad: { revisions } }");
  // Same per-drawing shape as getComponentCad: role, revisions with source facts.
  for (const key of ["source_sha256", "source_cad_file_id", 'l.role === "depicts"']) {
    assert.ok(block.includes(key), `listCadModels summary input lacks ${key}`);
  }
  // sha256 and created_at are selected: the warnings and updated_at depend on them.
  assert.ok(/tdb\("cad_model_files"\)\.select\("[^"]*sha256[^"]*created_at[^"]*"\)/.test(block),
    "cad_model_files select must carry sha256 and created_at");
  assert.ok(/tdb\("cad_model_revisions"\)\.select\("[^"]*created_at[^"]*"\)/.test(block),
    "cad_model_revisions select must carry created_at");
});

test("listCadModels orders drawings depicting first, then by drawing number", () => {
  const block = actionBlock("listCadModels");
  assert.ok(/role === "depicts" \? 0 : 1/.test(block), "depicting drawings must sort first");
  assert.ok(/drawing_number\)\.localeCompare\(/.test(block), "then by drawing number");
  for (const field of ["current_revision", "current_status", "released_revision", "is_supplier_visible", "title"]) {
    assert.ok(block.includes(field), `drawings rows lack ${field}`);
  }
});

test("listDrawings emits owner_part_number and supplier_sees", () => {
  const block = actionBlock("listDrawings");
  assert.ok(/owner_part_number: .*ownerMap\[d\.owner_component_id\]\?\.part_number/.test(block),
    "owner_part_number must come from the ownerMap's part_number");
  assert.ok(/supplier_sees: d\.is_supplier_visible && derived\.released \? derived\.released\.revision : null/.test(block),
    "supplier_sees is the released issue only when the drawing is supplier-visible");
  for (const field of ["owner_name", "parts_count", "is_free", "supplier_drawing_number", "node_sequence", "drawing_type"]) {
    assert.ok(block.includes(field), `listDrawings lost ${field}`);
  }
});

test("getDrawing emits source_cad per revision, by file id then by sha256", () => {
  const block = actionBlock("getDrawing");
  // Every revision carries source_cad; a supplier gets null, since the CAD
  // registry is Rushroom-only everywhere else.
  assert.ok(block.includes('source_cad: role === "rushroom" ? sourceCadOf(r) : null'), "every revision must carry source_cad, Rushroom only");
  assert.ok(/tdb\("cad_model_files"\)\.select\([^)]*\)\.in\("id", srcIds\)/.test(block), "lookup by source_cad_file_id");
  // The sha fallback is ordered oldest first: two files may share one sha
  // (a resend of unchanged geometry), and the drawing was made from the first.
  assert.ok(/tdb\("cad_model_files"\)\.select\([^)]*\)\s*\.in\("sha256", srcShas\)\.order\("created_at", \{ ascending: true \}\)/.test(block), "fallback by source_sha256, oldest first");
  assert.ok(/tdb\("cad_model_revisions"\)\.select\("id, revision"\)\.in\("id", srcRevIds\)/.test(block), "the CAD Rev letter");
  for (const key of ["cad_revision:", "file_name:", "sha_short:"]) {
    assert.ok(block.includes(key), `source_cad lacks ${key}`);
  }
  assert.ok(/\.slice\(0, 8\)/.test(block), "sha_short is the first eight hex characters");
  // Unresolved → null, never a half object.
  assert.ok(/if \(!f\) return null;/.test(block));
  // The payload shape is unchanged.
  assert.ok(block.includes("const payload: any = { drawing, revisions: shownRevisions, components };"));
});

test("listCadModels answers the §10 fields on the deployed function", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const r = await call("listCadModels", { token });
  if (notDeployed(r)) return t.skip("CAD registry not deployed yet");
  assert.equal(r.status, 200, `error: ${r.json?.error}`);
  const models = r.json?.cad_models || [];
  const first = models[0];
  if (!first) return t.skip("no CAD models in the tenant");
  if (!("drawings" in first)) return t.skip("deployed listCadModels predates §10");
  for (const m of models) {
    assert.ok(Array.isArray(m.drawings), `model ${m.id}: drawings is not an array`);
    assert.ok(Array.isArray(m.warnings), `model ${m.id}: warnings is not an array`);
    assert.ok("supplier_sees" in m && "updated_at" in m && "current_revision_id" in m, `model ${m.id} lacks a §10 field`);
    assert.equal(m.supplier_sees, m.released_revision, `model ${m.id}: supplier_sees differs from released_revision`);
    assert.ok(m.updated_at, `model ${m.id}: updated_at empty`);
    let sawOther = false;
    for (const d of m.drawings) {
      for (const key of ["id", "drawing_number", "title", "role", "current_revision", "current_status", "released_revision", "is_supplier_visible"]) {
        assert.ok(key in d, `model ${m.id} drawing ${d.id} lacks ${key}`);
      }
      if (d.role !== "depicts") sawOther = true;
      else assert.ok(!sawOther, `model ${m.id}: a depicting drawing sorts after a non-depicting one`);
    }
    for (const w of m.warnings) assert.ok(w.code && w.text, `model ${m.id}: a warning without code/text`);
  }
});

test("listDrawings answers owner_part_number and supplier_sees on the deployed function", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const r = await call("listDrawings", { token });
  if (notDeployed(r)) return t.skip("drawings not deployed yet");
  assert.equal(r.status, 200, `error: ${r.json?.error}`);
  const rows = r.json?.drawings || [];
  if (!rows.length) return t.skip("no drawings in the tenant");
  if (!("supplier_sees" in rows[0])) return t.skip("deployed listDrawings predates §10");
  for (const d of rows) {
    assert.equal(typeof d.owner_part_number, "string", `drawing ${d.id}: owner_part_number not a string`);
    if (d.is_free) assert.equal(d.owner_part_number, "", `free drawing ${d.id} carries an owner part number`);
    if (!d.is_supplier_visible || !d.released_revision) assert.equal(d.supplier_sees, null, `drawing ${d.id}: supplier_sees set without a visible released issue`);
    else assert.equal(d.supplier_sees, d.released_revision, `drawing ${d.id}: supplier_sees differs from the released issue`);
  }
});
