// The Manufacturing BOM screen (PROP-030) was retired on 2026-10-28: operations
// live on each part's Manufacturing tab and work orders run in Order
// Operations (its item 0039). Static guards, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const retired = ["listFamilyRoutingSteps", "listFamilyRoutingOverview", "upsertFamilyRoutingStep", "deleteFamilyRoutingStep",
  "reorderFamilyRoutingSteps", "createWorkOrder", "listWorkOrders", "getWorkOrder", "updateWorkOrderStepStatus", "updateWorkOrderStatus"];

test("the As Operated tab no longer offers the Manufacturing BOM screen", () => {
  const app = read("assets/app.js");
  assert.ok(!app.includes("function mBomView("), "the old screen is gone");
  assert.ok(!app.includes('label: "Manufacturing BOM"'), "its sub-tab is gone");
  for (const action of retired) assert.ok(!app.includes(`"${action}"`), `the page no longer calls ${action}`);
});

test("the old routing and work-order actions answer 410 with where the work lives now", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const block = api.slice(api.indexOf("const RETIRED_ACTIONS"), api.indexOf("if (Object.hasOwn(RETIRED_ACTIONS, action))") + 120);
  for (const action of retired) {
    assert.ok(block.includes(`${action}:`), `${action} is listed as retired`);
    assert.ok(!api.includes(`action === "${action}"`), `${action} has no handler left`);
  }
  assert.ok(block.includes("return json({ error: RETIRED_ACTIONS[action], retired: true }, 410)"));
  assert.ok(block.includes("Manufacturing tab") && block.includes("Order Operations"), "the refusals say where to go");
});

test("the configurator no longer looks up family routing", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  assert.ok(!api.includes("resolved_routing"), "resolveVariant's routing lookup never matched and is removed");
});
