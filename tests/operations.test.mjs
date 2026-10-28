// Operations on a component (migration 0052, Order Operations' item 0039):
// what we do to a part, and where. Static guards, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("operations belong to the component and say Hub or Site", () => {
  const sql = read("supabase/migrations/0052_operations_on_components.sql");
  assert.ok(sql.includes("ALTER COLUMN family_id DROP NOT NULL"), "family must become optional");
  assert.ok(/ADD COLUMN IF NOT EXISTS stage TEXT CHECK \(stage IS NULL OR stage IN \('hub', 'site'\)\)/.test(sql), "stage must be hub, site or empty");
  assert.ok(/UNIQUE INDEX[\s\S]*\(component_id, step_number\)[\s\S]*WHERE family_id IS NULL/.test(sql), "component operations need their own step order");
  assert.ok(sql.includes("ADD COLUMN IF NOT EXISTS drawing_id UUID REFERENCES drawings(id) ON DELETE SET NULL"), "the hole pattern is a drawing");
  assert.ok(sql.includes("jsonb_typeof(variant_condition) = 'object'"), "a condition is an object");
});

test("only Rushroom edits operations, through four actions", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const block = api.slice(api.indexOf('"listComponentOperations", "saveComponentOperation"'));
  assert.ok(block.startsWith('"listComponentOperations", "saveComponentOperation", "deleteComponentOperation", "moveComponentOperation"'));
  assert.ok(/if \(role !== "rushroom"\) return json\(\{ error: "Not authorised" \}, 403\);/.test(block.slice(0, 400)), "operations are Rushroom-only");
  assert.ok(block.includes('.is("family_id", null)'), "component operations are the ones without a family");
  assert.ok(block.includes("OPERATION_TYPES.includes(operation_type)"), "the operation type is checked");
  assert.ok(block.includes("operationCondition(body.condition)"), "the condition is checked");
});

test("a condition takes only face, size, interior and an item the module holds", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const fn = api.slice(api.indexOf("function operationCondition("), api.indexOf("function operationCondition(") + 1200);
  for (const rule of ['value === "left" || value === "right"', '["S", "M", "L"].includes', "Number(value) <= 20", "ITEM_KINDS.includes(value as string)", "else return undefined"]) {
    assert.ok(fn.includes(rule), `operationCondition lacks ${rule}`);
  }
});

test("the Operations section points to Order Operations' rules instead of an editor", () => {
  const app = read("assets/app.js");
  const row = app.slice(app.indexOf("function operationsRow()"), app.indexOf("function operationsRow()") + 1500);
  assert.ok(row.includes("ORDER_SURGERY_RULES_URL") && row.includes("See the rules in Order Operations"), "it links to the rules page");
  assert.ok(app.includes('const ORDER_SURGERY_RULES_URL = "https://valcyra-order-operations-staging.netlify.app/warehouse/order-surgery/rules";'));
  assert.ok(!app.includes('"saveComponentOperation"') && !app.includes('"listComponentOperations"'), "the card no longer edits operations");
  assert.ok(app.includes("operationsRow(),"), "the row must be mounted");
});

test("the card's Manufacturing tab holds pre-assembly and operations, after Drawings, for Rushroom only", () => {
  const app = read("assets/app.js");
  const tabs = app.slice(app.indexOf("const TAB_DEFS = ["), app.indexOf("const tabPanels = {};"));
  assert.ok(tabs.indexOf('id: "drawings"') < tabs.indexOf('id: "manufacturing"') && tabs.indexOf('id: "manufacturing"') < tabs.indexOf('id: "images"'),
    "Manufacturing sits right after Drawings");
  assert.ok(tabs.includes('...(role === "rushroom" ? [{ id: "manufacturing", label: "Manufacturing" }] : [])'), "only Rushroom sees it");
  const panel = app.slice(app.indexOf('tabPanels["manufacturing"] = '), app.indexOf('tabPanels["images"]'));
  assert.ok(panel.includes("preAssemblyRow(componentId, token)") && panel.includes("operationsRow()"), "both live in the Manufacturing tab");
  const properties = app.slice(app.indexOf("propertiesSection = el("), app.indexOf("propertiesSection = el(") + 2500);
  assert.ok(!properties.includes("preAssemblyRow(") && !properties.includes("operationsRow("), "Overview no longer holds them");
  assert.ok(app.includes('"Built ahead of orders"') && app.includes('"Operations at the hub and on site"'), "the tab has its two headings");
});

test("the API still accepts the planner's item kinds in a condition", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const kinds = ["drawer_set", "shelf", "hanger", "led_ramp", "beautybox", "removable_panel_back_full"];
  assert.ok(api.includes(`const ITEM_KINDS = ${JSON.stringify(kinds).replace(/,/g, ", ")};`), "the API accepts exactly these kinds");
});
