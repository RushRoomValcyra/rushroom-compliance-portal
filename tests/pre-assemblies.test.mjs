// Static contract guard for pre-assembly eligibility (formerly the Stock tab).
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

test("the panel's eligibility actions are rushroom-only", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  for (const action of ["getPreAssemblyEligibility", "setAssemblyStocked"]) {
    const actionIdx = api.indexOf(`action === "${action}"`);
    assert.ok(actionIdx > 0, `missing action: ${action}`);
    assert.ok(api.slice(actionIdx, actionIdx + 200).includes('role !== "rushroom"'), `${action} must be gated to rushroom`);
  }
});

test("a Kit or Dynamic BOM cannot be marked", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  assert.ok(api.includes("flag && !canBeEligibleType(comp.type)"), "setAssemblyStocked must refuse types that are never built");
  assert.ok(api.includes("A Kit or Dynamic BOM cannot be built ahead of orders"), "must return a meaningful error");
});

test("target days of stock are not kept here: 0051 drops them, and nothing reads them", () => {
  const sql = read("supabase/migrations/0051_target_days_to_operations.sql");
  assert.ok(sql.includes("DROP COLUMN IF EXISTS target_stock_days"), "0051 must drop target_stock_days");
  assert.ok(sql.includes("RAISE EXCEPTION"), "0051 must refuse to drop values silently");
  for (const path of ["supabase/functions/portal-api/index.ts", "assets/app.js"]) {
    assert.ok(!read(path).includes("target_stock_days"), `${path} still uses target_stock_days`);
  }
});

test("eligibility is a checkbox in the component card, not a tab of its own", () => {
  const html = read("index.html");
  const app = read("assets/app.js");
  assert.ok(!html.includes("tab-stock") && !html.includes("stock-panel"), "the eligibility tab is still in index.html");
  for (const gone of ["renderStock", "listPreAssemblies", "listAssembliesForStocking"]) {
    assert.ok(!app.includes(gone), `assets/app.js still uses ${gone}`);
    assert.ok(!read("supabase/functions/portal-api/index.ts").includes(gone), `portal-api still has ${gone}`);
  }
  assert.ok(app.includes("preAssemblyRow(componentId, token)"), "the component card must show the pre-assembly checkbox");
  for (const action of ["getPreAssemblyEligibility", "setAssemblyStocked"]) {
    assert.ok(app.includes(`"${action}"`), `the checkbox does not call ${action}`);
  }
  assert.ok(app.includes("fitted at Hub."), "the card must say when eligibility is automatic");
});
