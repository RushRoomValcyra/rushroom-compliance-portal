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
});

test("only Rushroom edits operations, through four actions", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const block = api.slice(api.indexOf('"listComponentOperations", "saveComponentOperation"'));
  assert.ok(block.startsWith('"listComponentOperations", "saveComponentOperation", "deleteComponentOperation", "moveComponentOperation"'));
  assert.ok(/if \(role !== "rushroom"\) return json\(\{ error: "Not authorised" \}, 403\);/.test(block.slice(0, 400)), "operations are Rushroom-only");
  assert.ok(block.includes('.is("family_id", null)'), "component operations are the ones without a family");
  assert.ok(block.includes("OPERATION_TYPES.includes(operation_type)"), "the operation type is checked");
});

test("each component panel shows its operations", () => {
  const app = read("assets/app.js");
  assert.ok(app.includes("function operationsRow(componentId, token)"));
  assert.ok(app.includes("operationsRow(componentId, token),"), "the row must be mounted in the properties card");
  assert.ok(app.includes('"listComponentOperations"') && app.includes('"saveComponentOperation"'));
});
