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
  assert.ok(api.includes("Only sub-assemblies and finished goods can be eligible for pre-assembly"), "must return a meaningful error");
});

test("target days of stock are not kept here: 0051 drops them, and nothing reads them", () => {
  const sql = read("supabase/migrations/0051_target_days_to_operations.sql");
  assert.ok(sql.includes("DROP COLUMN IF EXISTS target_stock_days"), "0051 must drop target_stock_days");
  assert.ok(sql.includes("RAISE EXCEPTION"), "0051 must refuse to drop values silently");
  for (const path of ["supabase/functions/portal-api/index.ts", "assets/app.js"]) {
    assert.ok(!read(path).includes("target_stock_days"), `${path} still uses target_stock_days`);
  }
});

test("the tab and its buttons speak of eligibility, not stock", () => {
  const html = read("index.html");
  const app = read("assets/app.js");
  assert.ok(html.includes(">Pre-assembly eligibility</button>"), "tab label must be Pre-assembly eligibility");
  for (const label of ['"Mark eligible"', '"Remove eligibility"', '"Already eligible"']) {
    assert.ok(app.includes(label), `missing button or badge ${label}`);
  }
  for (const label of ['"Add to stock"', '"Remove from stock"', '"Already stocked"']) {
    assert.ok(!app.includes(label), `old stock wording ${label} is still there`);
  }
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
