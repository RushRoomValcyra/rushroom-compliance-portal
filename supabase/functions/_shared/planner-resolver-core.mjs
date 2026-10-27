// Pure resolver core: no HTTP, secrets, database, or tenant access. Keeping
// this separate makes the Operations contract executable with fixture tests.
//
// Contract v2 (Order Operations' item 0039) adds two things and changes nothing
// else: each tree node carries the operations defined on its component, and a
// stocked pre-assembly (preAssemblyIds, the same eligibility as
// listStockedAssemblies) is not expanded, because it is taken from the shelf
// as one unit. v1 answers stay exactly as before.
export function resolvePlannerGraph({ requirements, mappings, components, edges, maxDepth, maxExpansions, contractVersion = 1, preAssemblyIds = new Set(), operationsByComponent = new Map() }) {
  const v2 = contractVersion === 2;
  const mappingBySource = new Map(mappings.map((row) => [`${row.source_type}:${row.source_key}`, row]));
  const componentById = new Map(components.map((row) => [row.id, row]));
  const children = new Map();
  for (const edge of edges) children.set(edge.parent_id, [...(children.get(edge.parent_id) || []), edge]);
  const unresolvedByIdentity = new Map();
  const block = (source, quantity, reason) => {
    const key = `${source.source_type}:${source.source_key}`;
    if (!unresolvedByIdentity.has(key)) unresolvedByIdentity.set(key, { ...source, quantity, reason });
  };
  const records = [], leaves = new Map(), assembly_tree = []; let expansions = 0;
  for (const requirement of [...requirements].sort((a, b) => `${a.source_type}:${a.source_key}`.localeCompare(`${b.source_type}:${b.source_key}`))) {
    const source = { source_type: requirement.source_type, source_key: requirement.source_key };
    const mapping = mappingBySource.get(`${source.source_type}:${source.source_key}`);
    if (!mapping) { block(source, requirement.quantity, "missing_or_inactive_mapping"); continue; }
    const rootQuantity = mapping.quantity_rule === "fixed" ? Number(mapping.fixed_quantity) : requirement.quantity;
    records.push({ mapping_id: mapping.id, mapping_revision: mapping.mapping_revision, source, target_component_id: mapping.target_component_id, requested_quantity: requirement.quantity, resolved_quantity: Number.isFinite(rootQuantity) ? rootQuantity : null });
    // Preserve the exploded structure as a separate view of the same graph.
    // The flat leaf list below remains the inventory pick list; this tree is
    // for production to see which assemblies and sub-assemblies produced it.
    const walk = (componentId, quantity, depth, path) => {
      expansions++;
      if (expansions > maxExpansions) { block(source, requirement.quantity, "traversal_limit"); return null; }
      if (depth > maxDepth) { block(source, requirement.quantity, "max_depth_exceeded"); return null; }
      if (path.has(componentId)) { block(source, requirement.quantity, "bom_cycle"); return null; }
      const component = componentById.get(componentId);
      if (!component) { block(source, requirement.quantity, "missing_target"); return null; }
      // The active planner mapping is the publishing decision for this
      // integration. Component lifecycle remains PIM metadata and must not
      // prevent an explicitly mapped planner part from being exploded.
      const childEdges = children.get(componentId) || [];
      const node = {
        pim_component_id: componentId,
        part_number: component.part_number,
        component_name: component.name,
        component_type: component.type ?? "component",
        unit: component.unit_of_measure,
        quantity,
        children: [],
      };
      if (v2) node.operations = operationsByComponent.get(componentId) || [];
      if (v2 && preAssemblyIds.has(componentId)) {
        node.pre_assembly = true;
        leaves.set(componentId, (leaves.get(componentId) || 0) + quantity); return node;
      }
      // phantom_assembly (Kit) is a pick group — stop here so it appears as one
      // line in the pick list. Its children are picked together under it; Order
      // Operations fetches their identities separately when building the list.
      if (!childEdges.length || component.type === "phantom_assembly") {
        leaves.set(componentId, (leaves.get(componentId) || 0) + quantity); return node;
      }
      const nextPath = new Set(path); nextPath.add(componentId);
      for (const edge of childEdges) {
        const edgeQuantity = Number(edge.quantity);
        if (!Number.isFinite(edgeQuantity) || edgeQuantity <= 0) { block(source, requirement.quantity, "invalid_edge_quantity"); continue; }
        const child = walk(edge.child_id, quantity * edgeQuantity, depth + 1, nextPath);
        if (child) node.children.push(child);
      }
      return node;
    };
    if (!Number.isFinite(rootQuantity) || rootQuantity <= 0) { block(source, requirement.quantity, "invalid_mapping_quantity"); continue; }
    const root = walk(mapping.target_component_id, rootQuantity, 0, new Set());
    if (root) assembly_tree.push({
      source, mapping_id: mapping.id, mapping_revision: mapping.mapping_revision,
      requested_quantity: requirement.quantity, resolved_quantity: rootQuantity, root,
    });
  }
  const unresolved_requirements = [...unresolvedByIdentity.values()].sort((a, b) => `${a.source_type}:${a.source_key}`.localeCompare(`${b.source_type}:${b.source_key}`));
  const bom_entries = [...leaves.entries()].map(([id, quantity]) => {
    const component = componentById.get(id);
    const entry = { pim_component_id: id, part_number: component.part_number, component_name: component.name, unit: component.unit_of_measure, type: component.type, quantity };
    return v2 && preAssemblyIds.has(id) ? { ...entry, pre_assembly: true } : entry;
  }).sort((a, b) => `${a.part_number || ""}:${a.component_name}:${a.pim_component_id}`.localeCompare(`${b.part_number || ""}:${b.component_name}:${b.pim_component_id}`));
  const onlyMissingMappings = unresolved_requirements.length > 0
    && unresolved_requirements.every((item) => item.reason === "missing_or_inactive_mapping");
  // A partial result is intentionally limited to missing mappings. Graph/data
  // failures must remain failed rather than returning a potentially misleading
  // production pick list.
  const status = !unresolved_requirements.length && bom_entries.length
    ? "resolved"
    : onlyMissingMappings && bom_entries.length
      ? "partially_resolved"
      : onlyMissingMappings
        ? "needs_mapping"
        : "failed";
  return {
    contract_version: v2 ? 2 : 1,
    status,
    resolved_at: null,
    mapping_evidence: { records },
    unresolved_requirements,
    bom_entries: status === "resolved" || status === "partially_resolved" ? bom_entries : [],
    assembly_tree: status === "resolved" || status === "partially_resolved" ? assembly_tree : [],
  };
}
