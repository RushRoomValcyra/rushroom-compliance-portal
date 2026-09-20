// Planner mapping contract — static and safe to run without credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("planner mappings have an additive versioned tenant-scoped model", () => {
  const sql = read("supabase/migrations/0034_planner_mappings.sql");
  const tenant = read("supabase/functions/_shared/tenant.ts");
  for (const field of ["organization_id", "source_type", "source_key", "target_component_id", "quantity_rule", "is_active", "mapping_revision", "release_label", "supersedes_id"]) {
    assert.ok(sql.includes(field), `migration is missing ${field}`);
  }
  assert.ok(sql.includes("planner_mappings_one_active_source"), "active source identity is not unique");
  assert.ok(tenant.includes('"planner_mappings"'), "planner mappings are not tenant-scoped");
});

test("planner mapping API is Rushroom-only and never resolves Website carts", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  for (const action of ["listPlannerMappings", "savePlannerMapping", "deactivatePlannerMapping"]) {
    assert.ok(api.includes(`action === "${action}"`), `${action} is missing`);
  }
  assert.ok(/role !== "rushroom"/.test(api), "Rushroom guard is missing");
  assert.ok(api.includes('tdb("planner_mappings")'), "planner mappings bypass tenant scoping");
  assert.ok(!/fetch\([^)]*cart/i.test(api), "PIM API must not fetch Website cart data");
});

test("editor documents every current Website planner source field", () => {
  const ui = read("assets/app.js");
  const docs = read("docs/PLANNER_MAPPINGS.md");
  for (const field of ["modules[].module", "modules[].interior[]", "sides.panels[]", "sides.feet", "doors[]", "covers[]", "backCovers"]) {
    assert.ok(docs.includes(field), `documentation is missing ${field}`);
  }
  assert.ok(ui.includes("Planner mappings"), "Rushroom editor is not reachable from Product BOM");
});

test("paste-only inspector extracts exact Website cart keys without persisting carts", () => {
  const ui = read("assets/app.js");
  const docs = read("docs/PLANNER_MAPPINGS.md");
  for (const fragment of ["inspectPlannerCartConfiguration", "raw?.configuration", "config.modules", "config.sides?.panels", "config.sides?.feet", "config.doors", "config.covers", "config.backCovers", '"BackCover"', "SOURCE_TYPE_LABELS", "Map this item", 'quantity_rule: "cart_quantity", fixed_quantity: null', '"Cart-derived"']) {
    assert.ok(ui.includes(fragment), `inspector is missing ${fragment}`);
  }
  assert.ok(!ui.includes("quantity.closest(\"label\")"), "modal must not inspect unattached controls");
  assert.ok(!ui.includes("current cart qty"), "cart quantities must not be shown in the identity importer");
  for (const key of ["S`, `M`, `L", "side_middle_color_0", "Door and cover mesh names are dynamic", "inspector's exact emitted key is authoritative", "Wildcards are stored as data but are **not", "not cart configurations"]) {
    assert.ok(docs.includes(key), `documentation is missing ${key}`);
  }
});
