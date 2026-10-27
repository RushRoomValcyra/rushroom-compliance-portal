// Contract guard and fixture tests for the Operations → PIM pre-assembly actions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { expandAssemblyInputs } from "../supabase/functions/_shared/assembly-inputs-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const components = [
  { id: "door", part_number: "RR-DOOR-L", name: "Door left", type: "sub_assembly", unit_of_measure: "ea", is_stocked: true },
  { id: "panel", part_number: "RR-PANEL", name: "Door panel", type: "part", unit_of_measure: "ea" },
  { id: "handle-set", part_number: "RR-HANDLE-SET", name: "Handle set", type: "sub_assembly", unit_of_measure: "ea", is_stocked: true },
  { id: "kit", part_number: "RR-HINGE-KIT", name: "Hinge kit", type: "phantom_assembly", unit_of_measure: "ea" },
  { id: "hinge", part_number: "RR-HINGE", name: "Hinge", type: "part", unit_of_measure: null },
  { id: "screw", part_number: "RR-SCREW", name: "", type: "part", unit_of_measure: "ea" },
  { id: "frame", part_number: "RR-FRAME", name: "Frame, not stocked", type: "sub_assembly", unit_of_measure: "ea", is_stocked: false },
];
const edges = [
  { parent_id: "door", child_id: "panel", quantity: 1 },
  { parent_id: "door", child_id: "handle-set", quantity: 1 },
  { parent_id: "door", child_id: "kit", quantity: 1 },
  { parent_id: "door", child_id: "frame", quantity: 1 },
  { parent_id: "kit", child_id: "hinge", quantity: 2 },
  { parent_id: "kit", child_id: "screw", quantity: 8 },
  { parent_id: "frame", child_id: "screw", quantity: 4 },
  { parent_id: "handle-set", child_id: "screw", quantity: 2 },
];

test("pre-assembly actions use service auth, real links only and the seed org, ahead of session auth", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const at = api.indexOf('action === "listStockedAssemblies" || action === "resolveAssemblyInputs"');
  const end = api.indexOf("// --- everything else requires a valid token");
  assert.ok(at > 0 && at < end, "pre-assembly actions must sit before session auth");
  const block = api.slice(at, end);
  for (const fragment of ["OPERATIONS_PIM_RESOLVER_KEY", "constantTimeSecretEqual", "allowedKeys", "makeTdb(RUSHROOM_ORG_ID)", '.eq("is_stocked", true)', '.is("effective_to", null)', '.eq("is_reference", false)', "expandAssemblyInputs"]) {
    assert.ok(block.includes(fragment), `pre-assembly actions lack ${fragment}`);
  }
  assert.ok(read("docs/PLANNER_MAPPINGS.md").includes('"action": "resolveAssemblyInputs"'), "contract is undocumented");
});

test("one unit's inputs: parts, stocked assemblies as one unit, kits and non-stocked assemblies expanded", () => {
  assert.deepEqual(expandAssemblyInputs({ rootId: "door", components, edges }).inputs, [
    { pim_component_id: "handle-set", article_number: "RR-HANDLE-SET", name: "Handle set", unit: "ea", quantity: 1 },
    { pim_component_id: "hinge", article_number: "RR-HINGE", name: "Hinge", unit: "ea", quantity: 2 },
    { pim_component_id: "panel", article_number: "RR-PANEL", name: "Door panel", unit: "ea", quantity: 1 },
    { pim_component_id: "screw", article_number: "RR-SCREW", name: "RR-SCREW", unit: "ea", quantity: 12 },
  ]);
});

test("the root is expanded even though it is stocked itself", () => {
  const result = expandAssemblyInputs({ rootId: "handle-set", components, edges });
  assert.deepEqual(result.inputs.map((input) => [input.article_number, input.quantity]), [["RR-SCREW", 2]]);
});

test("a cycle is reported, not followed forever", () => {
  const cyclic = [...edges, { parent_id: "panel", child_id: "door", quantity: 1 }];
  assert.deepEqual(expandAssemblyInputs({ rootId: "door", components: components.map((c) => c.id === "door" ? { ...c, is_stocked: false } : c), edges: cyclic }), { error: "bom_cycle" });
});

test("a bad link quantity is reported", () => {
  assert.deepEqual(expandAssemblyInputs({ rootId: "door", components, edges: [{ parent_id: "door", child_id: "panel", quantity: 0 }] }), { error: "invalid_edge_quantity" });
});
