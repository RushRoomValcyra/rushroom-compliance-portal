// Static contract guard for the Pre Assemblies feature.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("migration 0050 adds is_stocked and target_stock_days to bom_components", () => {
  const sql = read("supabase/migrations/0050_pre_assemblies.sql");
  assert.ok(sql.includes("is_stocked"), "is_stocked column missing");
  assert.ok(sql.includes("target_stock_days"), "target_stock_days column missing");
  assert.ok(sql.includes("ALTER TABLE bom_components"), "must alter bom_components");
  assert.ok(sql.includes("DEFAULT false"), "is_stocked must default to false");
  assert.ok(sql.includes("target_stock_days <= 365"), "target_stock_days must be bounded");
});

test("API actions are rushroom-only and use correct fields", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  for (const action of ["listPreAssemblies", "listAssembliesForStocking", "setAssemblyStocked"]) {
    assert.ok(api.includes(`action === "${action}"`), `missing action: ${action}`);
    // Each action must check role before touching data
    const actionIdx = api.indexOf(`action === "${action}"`);
    const snippet = api.slice(actionIdx, actionIdx + 300);
    assert.ok(snippet.includes("rushroom"), `${action} must be gated to rushroom`);
  }
});

test("setAssemblyStocked validates type — only sub_assembly and finished_good allowed", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  assert.ok(api.includes('"sub_assembly", "finished_good"'), "type guard must name both valid types");
  assert.ok(api.includes("Only sub-assemblies and finished goods can be stocked"), "must return a meaningful error");
});

test("setAssemblyStocked validates target_stock_days range", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  assert.ok(api.includes("target_stock_days must be 1–365"), "range error message missing");
});

test("listAssembliesForStocking escapes ILIKE wildcards", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  // The ilike query must escape % _ \ to prevent injection
  assert.ok(api.includes("replace(/[%_\\\\]/g"), "ILIKE wildcard escape missing");
});

test("Stock tab is gated to rushroom in applyAccess", () => {
  const app = read("assets/app.js");
  assert.ok(app.includes('gate("tab-stock", "stock-panel", role === "rushroom")'), "stock tab not gated to rushroom");
});

test("stock panel is wired to renderStock", () => {
  const app = read("assets/app.js");
  assert.ok(app.includes('renderStock(role, stockPanel)'), "stockPanel not wired to renderStock");
  assert.ok(app.includes("async function renderStock("), "renderStock function missing");
});

test("renderStock calls all three API actions", () => {
  const app = read("assets/app.js");
  for (const action of ["listPreAssemblies", "listAssembliesForStocking", "setAssemblyStocked"]) {
    assert.ok(app.includes(`"${action}"`), `renderStock does not call ${action}`);
  }
});
