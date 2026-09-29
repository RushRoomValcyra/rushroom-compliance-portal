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

test("resolver handles mapping rules and only returns a complete exploded BOM", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const core = read("supabase/functions/_shared/planner-resolver-core.mjs");
  for (const fragment of [
    'resolverTdb("planner_mappings")', 'resolverTdb("bom_edges")', 'is("effective_to", null)',
    "PLANNER_RESOLVER_MAX_DEPTH", "PLANNER_RESOLVER_MAX_EXPANSIONS", "resolvePlannerGraph",
  ]) assert.ok(api.includes(fragment), `resolver API lacks ${fragment}`);
  for (const fragment of ['mapping.quantity_rule === "fixed" ? Number(mapping.fixed_quantity) : requirement.quantity', '"bom_cycle"', 'component.lifecycle_status !== "released"', "unresolved_requirements", "bom_entries", "mapping_evidence: { records }", '"needs_mapping" : "failed"']) {
    assert.ok(core.includes(fragment), `resolver core lacks ${fragment}`);
  }
  assert.ok(!api.includes("X-Operations-PIM-Resolver-Key"), "legacy custom resolver header must not remain");
  assert.ok(!api.includes("blocking_errors, bom"), "legacy response fields must not remain in the resolver response");
});

test("mapped released leaf resolves with the requested cart quantity", () => {
  const result = resolvePlannerGraph({
    requirements: [{ source_type: "module", source_key: "M", quantity: 3 }],
    mappings: [{ id: "map-1", source_type: "module", source_key: "M", target_component_id: "part-1", quantity_rule: "cart_quantity", fixed_quantity: null, mapping_revision: 2 }],
    components: [{ id: "part-1", part_number: "RR-001", name: "Leaf part", unit_of_measure: "each", lifecycle_status: "released" }],
    edges: [], maxDepth: 20, maxExpansions: 5000,
  });
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.unresolved_requirements, []);
  assert.deepEqual(result.bom_entries, [{ pim_component_id: "part-1", part_number: "RR-001", component_name: "Leaf part", unit: "each", quantity: 3 }]);
  assert.equal(result.mapping_evidence.records[0].mapping_revision, 2);
});

test("missing mapping produces needs_mapping and never leaks a partial BOM", () => {
  const result = resolvePlannerGraph({
    requirements: [{ source_type: "module", source_key: "S", quantity: 1 }], mappings: [],
    components: [], edges: [], maxDepth: 20, maxExpansions: 5000,
  });
  assert.equal(result.status, "needs_mapping");
  assert.deepEqual(result.bom_entries, []);
  assert.deepEqual(result.unresolved_requirements, [{ source_type: "module", source_key: "S", quantity: 1, reason: "missing_or_inactive_mapping" }]);
});
