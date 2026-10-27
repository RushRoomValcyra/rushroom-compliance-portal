// Pure core of the Operations → PIM pre-assembly actions (contract v1, see
// docs/PLANNER_MAPPINGS.md): no HTTP, secrets, database or tenant access.

export const ASSEMBLY_TYPES = ["sub_assembly", "finished_good"];

/**
 * What one unit of an assembly is made of, for building it ahead of orders.
 * Expands real BOM links until a part (no children) or another stocked
 * assembly, which is taken from the shelf as one unit. Kits (phantom
 * assemblies) hold no stock of their own, so they are expanded to their parts.
 * Callers pass only real links: no "In the box" links, no ended ones.
 * Returns { inputs } with quantities summed per component, or { error }.
 */
export function expandAssemblyInputs({ rootId, components, edges, maxDepth = 20, maxExpansions = 5000 }) {
  const byId = new Map(components.map((row) => [row.id, row]));
  const children = new Map();
  for (const edge of edges) children.set(edge.parent_id, [...(children.get(edge.parent_id) || []), edge]);

  const totals = new Map();
  let expansions = 0;
  let error = null;

  const walk = (componentId, quantity, depth, path) => {
    if (error) return;
    if (++expansions > maxExpansions) { error = "traversal_limit"; return; }
    if (depth > maxDepth) { error = "max_depth_exceeded"; return; }
    if (path.has(componentId)) { error = "bom_cycle"; return; }
    const component = byId.get(componentId);
    if (!component) { error = "missing_component"; return; }

    const links = children.get(componentId) || [];
    const isRoot = depth === 0;
    if (!isRoot && (links.length === 0 || component.is_stocked === true)) {
      totals.set(componentId, (totals.get(componentId) || 0) + quantity);
      return;
    }
    const nextPath = new Set(path).add(componentId);
    for (const link of links) {
      const linkQuantity = Number(link.quantity);
      if (!Number.isFinite(linkQuantity) || linkQuantity <= 0) { error = "invalid_edge_quantity"; return; }
      walk(link.child_id, quantity * linkQuantity, depth + 1, nextPath);
    }
  };

  walk(rootId, 1, 0, new Set());
  if (error) return { error };

  const inputs = [...totals].map(([id, quantity]) => {
    const row = byId.get(id);
    const number = String(row.part_number ?? "").trim();
    return {
      pim_component_id: id,
      article_number: number,
      name: String(row.name ?? "").trim() || number,
      unit: String(row.unit_of_measure ?? "").trim() || "ea",
      quantity,
    };
  }).sort((a, b) => a.article_number.localeCompare(b.article_number));

  return { inputs };
}

/** The shape Order Operations receives for one assembly or stocked assembly. */
export function articleOf(row) {
  const number = String(row.part_number ?? "").trim();
  return {
    pim_component_id: row.id,
    article_number: number,
    name: String(row.name ?? "").trim() || number,
    unit: String(row.unit_of_measure ?? "").trim() || "ea",
  };
}
