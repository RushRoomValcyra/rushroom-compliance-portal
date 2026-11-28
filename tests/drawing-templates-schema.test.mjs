// Drawing Templates phase 1 — the migration (docs/DRAWING_TEMPLATES.md §10.1).
// Static, no network: 0070 creates part_types and drawing_template_items as
// tenant tables (organization_id NOT NULL → organizations, RLS on), widens the
// history CHECK with part_type_changed, gives the render job mode 'sandbox'
// and its shape, seeds the seven types and marks flat_panel the Base.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = "supabase/migrations/0070_part_types_and_template_items.sql";
const raw = () => readFileSync(join(root, FILE), "utf8");
// Comments stripped: a value named only in a comment is not in the schema.
const sql = () => raw().replace(/^\s*--.*$/gm, "").replace(/--.*$/gm, "");
const table = (src, name) => {
  const m = src.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(m, `${name} is not created (or its CREATE TABLE does not end with ");" on its own line)`);
  return m[1];
};

test("0070 exists", () => {
  assert.ok(existsSync(join(root, FILE)), `${FILE} is missing`);
});

test("both new tables are tenant tables with RLS on", () => {
  const src = sql();
  for (const name of ["part_types", "drawing_template_items"]) {
    assert.match(table(src, name), /organization_id\s+UUID NOT NULL REFERENCES organizations\(id\)/, `${name} lacks organization_id NOT NULL → organizations`);
    assert.match(src, new RegExp(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;`), `${name} has no RLS`);
  }
});

test("the history CHECK carries all twelve change types, part_type_changed included", () => {
  const src = sql();
  const m = src.match(/ADD CONSTRAINT bom_component_history_change_type_check\s+CHECK \(change_type IN \(([\s\S]*?)\)\);/);
  assert.ok(m, "the history CHECK is not re-added");
  const values = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.deepEqual(values.sort(), [
    "cad_deleted", "created", "document_linked", "document_revised", "drawing_adopted", "drawing_deleted",
    "drawing_linked", "drawing_released", "drawing_revised", "part_type_changed", "updated", "version_bumped",
  ]);
  // Widened FIRST, before anything that could write the new value.
  assert.ok(src.indexOf("bom_component_history_change_type_check") < src.indexOf("CREATE TABLE IF NOT EXISTS part_types"));
});

test("the render job gains mode sandbox and a CHECK per mode", () => {
  const src = sql();
  assert.match(src, /ADD CONSTRAINT drawing_render_jobs_mode_check\s+CHECK \(mode IN \('issue', 'iterate', 'sandbox'\)\);/);
  const shape = src.match(/ADD CONSTRAINT drawing_render_jobs_mode_shape CHECK \(([\s\S]*?)\n\);/);
  assert.ok(shape, "the mode shape CHECK is missing");
  assert.match(shape[1], /mode IN \('issue','iterate'\) AND issue IS NOT NULL AND spec IS NOT NULL AND template_item_id IS NULL/);
  for (const k of ["template_item_id IS NOT NULL", "drawing_id IS NULL", "created_drawing = FALSE", "issue IS NULL",
                   "spec_patch_id IS NULL", "replaces_revision_id IS NULL", "spec_version_id IS NOT NULL"]) {
    assert.ok(shape[1].includes(k), `the sandbox shape lacks ${k}`);
  }
  assert.match(src, /ALTER COLUMN issue DROP NOT NULL/);
  assert.match(src, /ALTER COLUMN spec\s+DROP NOT NULL/);
  assert.match(src, /ADD COLUMN IF NOT EXISTS template_item_id UUID REFERENCES drawing_template_items\(id\) ON DELETE CASCADE/);
});

test("the CAD file FKs point at cad_model_files (there is no cad_files table)", () => {
  const src = sql();
  assert.ok(!/REFERENCES cad_files\(/.test(src), "a FK names cad_files");
  assert.match(table(src, "part_types"), /reference_cad_file_id\s+UUID REFERENCES cad_model_files\(id\)/);
  assert.match(table(src, "drawing_template_items"), /cad_file_id\s+UUID REFERENCES cad_model_files\(id\) ON DELETE CASCADE/);
});

test("the seven types are seeded once per organisation", () => {
  const src = sql();
  const seed = src.slice(src.indexOf("INSERT INTO part_types"), src.indexOf("ON CONFLICT (organization_id, key) DO NOTHING;") + 50);
  assert.ok(seed.includes("ON CONFLICT (organization_id, key) DO NOTHING"), "the seed is not idempotent");
  for (const [key, name] of [["side_panel", "Side panel"], ["shelf", "Shelf"], ["door", "Door"], ["plinth", "Plinth"],
                             ["back_panel", "Back panel"], ["bottom", "Bottom"], ["top", "Top"]]) {
    assert.match(seed, new RegExp(`\\('${key}',\\s*'${name}'`), `${name} is not seeded`);
  }
  assert.match(seed, /\('door',\s*'Door',\s*'door',/, "Door is not the door sheet family");
});

test("flat_panel becomes the Base; one Base and one rule set per type per org", () => {
  const src = sql();
  assert.match(src, /UPDATE drawing_render_specs SET level = 'base' WHERE name = 'flat_panel';/);
  assert.match(src, /CREATE UNIQUE INDEX IF NOT EXISTS idx_drawing_render_specs_one_base\s+ON drawing_render_specs \(organization_id\) WHERE level = 'base';/);
  assert.match(src, /ADD COLUMN IF NOT EXISTS portal_owned BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(src, /ADD COLUMN IF NOT EXISTS part_type_id UUID REFERENCES part_types\(id\);/, "bom_components lacks part_type_id");
});
