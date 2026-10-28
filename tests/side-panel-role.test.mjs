import { test } from "node:test";
import assert from "node:assert/strict";

import { roleOfSourceKey, sidePanelRole } from "../supabase/functions/_shared/side-panel-role-core.mjs";

// As production holds the white side panels: each planner key maps to a
// Prepared panel holding its bare panel part and fittings.
const components = new Map([
  ["prep-left", { id: "prep-left", name: "Prepared Left Side Panel - White", part_number: "RR-PL" }],
  ["left", { id: "left", name: "Left Side Panel - White", part_number: "RR-L" }],
  ["holders", { id: "holders", name: "Bottom panel strong holders", part_number: "RR-H" }],
  ["prep-mid", { id: "prep-mid", name: "Prepared Mid Panel - White", part_number: "RR-PM" }],
  ["mid", { id: "mid", name: "Shared (Middle) Side Panel - White", part_number: "RR-M" }],
  ["right", { id: "right", name: "Right Side Panel - White", part_number: "RR-R" }],
]);
const mappings = [
  { source_key: "side_left_color_white", target_component_id: "prep-left" },
  { source_key: "side_middle_color_white", target_component_id: "prep-mid" },
  { source_key: "side_right_color_white", target_component_id: "right" },
];
const edges = [
  { parent_id: "prep-left", child_id: "left" },
  { parent_id: "prep-left", child_id: "holders" },
  { parent_id: "prep-mid", child_id: "mid" },
  { parent_id: "prep-mid", child_id: "holders" },
];
const role = (id) => sidePanelRole(id, { mappings, edges, components });

test("the planner key names the kind of side panel", () => {
  assert.deepEqual(["side_left_color_white", "side_middle_color_grey", "side_right_color_white", "door_left_397mm"].map(roleOfSourceKey), ["left_end", "mid", "right_end", null]);
});

test("the bare panel part has the role, worked", () => {
  assert.deepEqual(role("left"), { role: "left_end", worked: true });
  assert.deepEqual(role("mid"), { role: "mid", worked: true });
});

test("a panel mapped directly has the role, worked", () => {
  assert.deepEqual(role("right"), { role: "right_end", worked: true });
});

test("the Prepared panel points to its panel part", () => {
  assert.deepEqual(role("prep-left"), { role: "left_end", worked: false, panel: { id: "left", name: "Left Side Panel - White", part_number: "RR-L" } });
});

test("a fitting with \"panel\" in its name, and anything else, has no role", () => {
  assert.equal(role("holders"), null);
  assert.equal(role("pin"), null);
});

test("a Prepared panel without exactly one panel part gives no role to anything in it", () => {
  const noPanel = sidePanelRole("prep-mid", { mappings, edges: edges.filter((e) => e.child_id !== "mid"), components });
  assert.equal(noPanel, null);
});
