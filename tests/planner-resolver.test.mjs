// Static contract guard for the isolated Operations → PIM resolver.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolvePlannerGraph } from "../supabase/functions/_shared/planner-resolver-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("resolver uses service auth and rejects browser/session-shaped payloads", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const docs = read("docs/PLANNER_MAPPINGS.md");
  for (const fragment of ['action === "resolvePlannerBom"', "OPERATIONS_PIM_RESOLVER_KEY", 'req.headers.get("authorization")', "constantTimeSecretEqual", "allowedKeys", "contract_version", "PLANNER_RESOLVER_MAX_REQUIREMENTS", "RUSHROOM_ORG_ID"]) {
    assert.ok(api.includes(fragment), `resolver auth/contract lacks ${fragment}`);
  }
  assert.ok(docs.includes("Authorization: Bearer <key>"), "resolver bearer header is undocumented");
  assert.ok(docs.includes("does not accept a browser session"), "service boundary is undocumented");
});

test("resolver handles mapping rules and returns an exploded BOM", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const core = read("supabase/functions/_shared/planner-resolver-core.mjs");
  for (const fragment of [
    'resolverTdb("planner_mappings")', 'resolverTdb("bom_edges")', 'is("effective_to", null)',
    "PLANNER_RESOLVER_MAX_DEPTH", "PLANNER_RESOLVER_MAX_EXPANSIONS", "resolvePlannerGraph",
  ]) assert.ok(api.includes(fragment), `resolver API lacks ${fragment}`);
  for (const fragment of ['mapping.quantity_rule === "fixed" ? Number(mapping.fixed_quantity) : requirement.quantity', '"bom_cycle"', "unresolved_requirements", "bom_entries", "mapping_evidence: { records }", '"partially_resolved"']) {
    assert.ok(core.includes(fragment), `resolver core lacks ${fragment}`);
  }
  assert.ok(!api.includes("X-Operations-PIM-Resolver-Key"), "legacy custom resolver header must not remain");
  assert.ok(!api.includes("blocking_errors, bom"), "legacy response fields must not remain in the resolver response");
});

test("an actively mapped leaf resolves with the requested cart quantity regardless of PIM lifecycle", () => {
  const result = resolvePlannerGraph({
    requirements: [{ source_type: "module", source_key: "M", quantity: 3 }],
    mappings: [{ id: "map-1", source_type: "module", source_key: "M", target_component_id: "part-1", quantity_rule: "cart_quantity", fixed_quantity: null, mapping_revision: 2 }],
    components: [{ id: "part-1", part_number: "RR-001", name: "Leaf part", unit_of_measure: "each", lifecycle_status: "inactive", type: "part" }],
    edges: [], maxDepth: 20, maxExpansions: 5000,
  });
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.unresolved_requirements, []);
  assert.deepEqual(result.bom_entries, [{ pim_component_id: "part-1", part_number: "RR-001", component_name: "Leaf part", unit: "each", type: "part", quantity: 3 }]);
  assert.equal(result.mapping_evidence.records[0].mapping_revision, 2);
});

test("a mapped assembly is exploded through nested sub-assemblies to its leaf parts", () => {
  const result = resolvePlannerGraph({
    requirements: [{ source_type: "door", source_key: "door_left_588mm_color_white_handle_cutout_color_silver", quantity: 2 }],
    mappings: [{ id: "map-door", source_type: "door", source_key: "door_left_588mm_color_white_handle_cutout_color_silver", target_component_id: "door-assembly", quantity_rule: "cart_quantity", fixed_quantity: null, mapping_revision: 1 }],
    components: [
      { id: "door-assembly", part_number: "ASM-DOOR", name: "Prepared door", unit_of_measure: "each", type: "sub_assembly" },
      { id: "hardware-sub-assembly", part_number: "ASM-HW", name: "Door hardware set", unit_of_measure: "each", type: "sub_assembly" },
      { id: "door-panel", part_number: "PANEL-588", name: "Door panel", unit_of_measure: "each", type: "part" },
      { id: "hinge", part_number: "HINGE-01", name: "Hinge", unit_of_measure: "each", type: "part" },
      { id: "handle", part_number: "HANDLE-01", name: "Cutout handle insert", unit_of_measure: "each", type: "part" },
    ],
    edges: [
      { parent_id: "door-assembly", child_id: "door-panel", quantity: 1 },
      { parent_id: "door-assembly", child_id: "hardware-sub-assembly", quantity: 1 },
      { parent_id: "hardware-sub-assembly", child_id: "hinge", quantity: 3 },
      { parent_id: "hardware-sub-assembly", child_id: "handle", quantity: 1 },
    ],
    maxDepth: 20, maxExpansions: 5000,
  });
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.unresolved_requirements, []);
  assert.deepEqual(result.bom_entries, [
    { pim_component_id: "handle", part_number: "HANDLE-01", component_name: "Cutout handle insert", unit: "each", type: "part", quantity: 2 },
    { pim_component_id: "hinge", part_number: "HINGE-01", component_name: "Hinge", unit: "each", type: "part", quantity: 6 },
    { pim_component_id: "door-panel", part_number: "PANEL-588", component_name: "Door panel", unit: "each", type: "part", quantity: 2 },
  ]);
  assert.deepEqual(result.assembly_tree, [{
    source: { source_type: "door", source_key: "door_left_588mm_color_white_handle_cutout_color_silver" },
    mapping_id: "map-door", mapping_revision: 1, requested_quantity: 2, resolved_quantity: 2,
    root: {
      pim_component_id: "door-assembly", part_number: "ASM-DOOR", component_name: "Prepared door", component_type: "sub_assembly", unit: "each", quantity: 2,
      children: [
        { pim_component_id: "door-panel", part_number: "PANEL-588", component_name: "Door panel", component_type: "part", unit: "each", quantity: 2, children: [] },
        { pim_component_id: "hardware-sub-assembly", part_number: "ASM-HW", component_name: "Door hardware set", component_type: "sub_assembly", unit: "each", quantity: 2, children: [
          { pim_component_id: "hinge", part_number: "HINGE-01", component_name: "Hinge", component_type: "part", unit: "each", quantity: 6, children: [] },
          { pim_component_id: "handle", part_number: "HANDLE-01", component_name: "Cutout handle insert", component_type: "part", unit: "each", quantity: 2, children: [] },
        ] },
      ],
    },
  }]);
});

test("a wholly unmapped configuration produces needs_mapping without BOM entries", () => {
  const result = resolvePlannerGraph({
    requirements: [{ source_type: "module", source_key: "S", quantity: 1 }], mappings: [],
    components: [], edges: [], maxDepth: 20, maxExpansions: 5000,
  });
  assert.equal(result.status, "needs_mapping");
  assert.deepEqual(result.bom_entries, []);
  assert.deepEqual(result.unresolved_requirements, [{ source_type: "module", source_key: "S", quantity: 1, reason: "missing_or_inactive_mapping" }]);
});

test("missing mappings return a partial BOM for the requirements that do resolve", () => {
  const result = resolvePlannerGraph({
    requirements: [
      { source_type: "module", source_key: "M", quantity: 2 },
      { source_type: "door", source_key: "unmapped", quantity: 1 },
    ],
    mappings: [{ id: "map-1", source_type: "module", source_key: "M", target_component_id: "part-1", quantity_rule: "cart_quantity", fixed_quantity: null, mapping_revision: 2 }],
    components: [{ id: "part-1", part_number: "RR-001", name: "Leaf part", unit_of_measure: "each", lifecycle_status: "released", type: "part" }],
    edges: [], maxDepth: 20, maxExpansions: 5000,
  });
  assert.equal(result.status, "partially_resolved");
  assert.deepEqual(result.bom_entries, [{ pim_component_id: "part-1", part_number: "RR-001", component_name: "Leaf part", unit: "each", type: "part", quantity: 2 }]);
  assert.deepEqual(result.unresolved_requirements, [{ source_type: "door", source_key: "unmapped", quantity: 1, reason: "missing_or_inactive_mapping" }]);
});

test("phantom_assembly (Kit) stops the walk and appears as a single pick-group entry", () => {
  const result = resolvePlannerGraph({
    requirements: [{ source_type: "interior", source_key: "drawer-kit", quantity: 2 }],
    mappings: [{ id: "map-1", source_type: "interior", source_key: "drawer-kit", target_component_id: "kit-1", quantity_rule: "cart_quantity", fixed_quantity: null, mapping_revision: 1 }],
    components: [
      { id: "kit-1", part_number: "KIT-001", name: "Drawer Hardware Set", unit_of_measure: "set", lifecycle_status: "released", type: "phantom_assembly" },
      { id: "part-a", part_number: "RR-A", name: "Slide", unit_of_measure: "each", lifecycle_status: "released", type: "part" },
      { id: "part-b", part_number: "RR-B", name: "Screw", unit_of_measure: "each", lifecycle_status: "released", type: "part" },
    ],
    edges: [
      { parent_id: "kit-1", child_id: "part-a", quantity: 2 },
      { parent_id: "kit-1", child_id: "part-b", quantity: 8 },
    ],
    maxDepth: 20, maxExpansions: 5000,
  });
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.bom_entries, [
    { pim_component_id: "kit-1", part_number: "KIT-001", component_name: "Drawer Hardware Set", unit: "set", type: "phantom_assembly", quantity: 2 },
  ]);
});

// Contract v2 (Order Operations' item 0039): operations on every node, and a
// stocked pre-assembly kept whole. v1 must not change.
const doorFixture = {
  requirements: [{ source_type: "door", source_key: "door_left", quantity: 2 }],
  mappings: [{ id: "map-door", source_type: "door", source_key: "door_left", target_component_id: "door-prepared", quantity_rule: "cart_quantity", fixed_quantity: null, mapping_revision: 1 }],
  components: [
    { id: "door-prepared", part_number: "RR-PD", name: "Prepared Door", unit_of_measure: "ea", type: "sub_assembly" },
    { id: "door-panel", part_number: "RR-D", name: "Door panel", unit_of_measure: "ea", type: "part" },
    { id: "handle", part_number: "RR-H", name: "Handle", unit_of_measure: "ea", type: "part" },
  ],
  edges: [
    { parent_id: "door-prepared", child_id: "door-panel", quantity: 1 },
    { parent_id: "door-prepared", child_id: "handle", quantity: 1 },
  ],
  maxDepth: 20, maxExpansions: 100,
};
const drill = { id: "op-1", operation_type: "drill", stage: "hub", instruction_text: "Customer holes", reference_document: null };

test("v1 is unchanged: no operations, no pre_assembly, pre-assemblies exploded", () => {
  const result = resolvePlannerGraph({ ...doorFixture, preAssemblyIds: new Set(["door-prepared"]), operationsByComponent: new Map([["door-panel", [drill]]]) });
  assert.equal(result.contract_version, 1);
  assert.deepEqual(result.bom_entries.map((e) => e.part_number), ["RR-D", "RR-H"]);
  assert.equal("operations" in result.assembly_tree[0].root, false);
  assert.equal("pre_assembly" in result.assembly_tree[0].root, false);
});

test("v2 puts each component's operations on its node", () => {
  const result = resolvePlannerGraph({ ...doorFixture, contractVersion: 2, operationsByComponent: new Map([["door-panel", [drill]]]) });
  assert.equal(result.contract_version, 2);
  const [panel, handle] = result.assembly_tree[0].root.children;
  assert.deepEqual(panel.operations, [drill]);
  assert.deepEqual(handle.operations, []);
  assert.deepEqual(result.assembly_tree[0].root.operations, []);
});

test("v2 keeps a stocked pre-assembly whole: one pick line from the shelf", () => {
  const result = resolvePlannerGraph({ ...doorFixture, contractVersion: 2, preAssemblyIds: new Set(["door-prepared"]) });
  const root = result.assembly_tree[0].root;
  assert.equal(root.pre_assembly, true);
  assert.deepEqual(root.children, []);
  assert.deepEqual(result.bom_entries.map((e) => [e.part_number, e.quantity, e.pre_assembly]), [["RR-PD", 2, true]]);
  assert.equal(result.status, "resolved");
});

test("v2 carries the operations of the parts inside a stocked pre-assembly", () => {
  const panelDrill = { ...drill, pim_component_id: "door-panel", part_number: "RR-D", component_name: "Door panel", condition: { face: "left", size: "L", interior: 1 } };
  const result = resolvePlannerGraph({
    ...doorFixture, contractVersion: 2, preAssemblyIds: new Set(["door-prepared"]),
    operationsByComponent: new Map([["door-panel", [panelDrill]]]),
  });
  const root = result.assembly_tree[0].root;
  assert.equal(root.pre_assembly, true);
  assert.deepEqual(root.operations, [panelDrill], "the panel inside is still drilled for the order");
});

test("the resolver action answers v1 and v2 and loads operations only for v2", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  assert.ok(api.includes("![1, 2].includes(body.contract_version)"), "resolver must accept contract_version 1 and 2");
  assert.ok(/if \(contractVersion === 2\) \{[\s\S]*?preAssemblyEligibility[\s\S]*?component_routing_steps[\s\S]*?\.is\("family_id", null\)/.test(api),
    "v2 must use the pre-assembly eligibility and the component's own operations");
  assert.ok(api.includes("contractVersion, preAssemblyIds, operationsByComponent"), "v2 inputs must reach the resolver core");
  assert.ok(api.includes("condition: op.variant_condition ?? null") && api.includes("drawing: op.drawing_id ?"), "v2 operations carry their condition and drawing");
  assert.ok(!/drawings[^\n]*storage_path|storage_path[^\n]*operationDrawings/.test(api), "the resolver never sends a storage path");
});
