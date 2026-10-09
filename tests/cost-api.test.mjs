// BOM cost simulation (PROP-072) — static safety checks, no credentials.
// Costs are planning numbers for Rushroom only: never on the supplier page,
// never in what Order Operations receives, always scoped to the tenant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const handler = read("supabase/functions/portal-api/handlers/costs.ts");
const api = read("supabase/functions/portal-api/index.ts");
const tenant = read("supabase/functions/_shared/tenant.ts");
const sql = read("supabase/migrations/0046_bom_cost_simulation.sql");

test("every cost action refuses any role but Rushroom, before anything else", () => {
  const fn = handler.slice(handler.indexOf("export async function handleCostAction"));
  const first = fn.split("\n").slice(1, 3).join("\n");
  assert.ok(/if \(ctx\.role !== "rushroom"\) return json\(\{ error: "Not authorised" \}, 403\);/.test(first), "the role check is not the first thing the handler does");
  assert.ok(/if \(COST_ACTIONS\.has\(action\)\) \{\s*return await handleCostAction\(action, body, \{ role, tdb,/.test(api), "cost actions are not dispatched through the guarded handler");
});

test("the three tables are tenant-scoped and closed", () => {
  for (const t of ["component_costs", "currency_rates", "cost_baselines"]) {
    assert.ok(tenant.includes(`"${t}"`), `${t} missing from TENANT_TABLES — every tenant would read every row`);
    assert.ok(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?organization_id\\s+UUID NOT NULL`).test(sql), `${t} lacks organization_id NOT NULL`);
    assert.ok(sql.includes(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`), `${t} has no RLS`);
  }
  assert.ok(/currency_rates_lookup\s+ON currency_rates \(organization_id, currency, valid_on DESC\)/.test(sql));
  assert.ok(/cost_baselines_by_root\s+ON cost_baselines \(organization_id, root_component_id, created_at DESC\)/.test(sql));
});

test("handlers read through tdb with named columns", () => {
  assert.ok(!/\bdb\.from\(/.test(handler), "a handler bypasses the tenant-scoped tdb");
  assert.ok(!/select\("\*"\)|select\(\)/.test(handler), "select * in the cost handler");
});

test("cost code never reaches the supplier page or Order Operations", () => {
  const supplier = read("supplier.html");
  assert.ok(!/cost-(math|forms|view)\.js/.test(supplier), "cost scripts are loaded on supplier.html");
  const resolver = read("supabase/functions/_shared/planner-resolver-core.mjs");
  assert.ok(!/cost/i.test(resolver), "the planner resolver mentions cost");
  const index = read("index.html");
  for (const f of ["cost-math.js", "cost-forms.js", "cost-view.js"]) {
    assert.ok(index.indexOf(f) > 0 && index.indexOf(f) < index.indexOf("assets/app.js"), `${f} must load before app.js`);
  }
});

test("the panel and toolbar only offer cost to Rushroom", () => {
  const app = read("assets/app.js");
  assert.ok(/role === "rushroom" && window\.PortalCost \? \[\{ id: "cost", label: "Cost" \}\]/.test(app));
  assert.ok(/role === "rushroom" && window\.PortalCost \? el\("button"/.test(app));
});
