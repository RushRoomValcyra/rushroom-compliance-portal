// Pure core of the Operations → PIM pre-assembly actions (contract v1, see
// docs/PLANNER_MAPPINGS.md): no HTTP, secrets, database or tenant access.

// Kits hold no stock of their own and a Dynamic BOM is never built, so neither
// can be built ahead of orders. Every other type can: assemblies and parts.
const NEVER_ELIGIBLE_TYPES = ["phantom_assembly", "product_family"];

export const canBeEligibleType = (type) => !NEVER_ELIGIBLE_TYPES.includes(type);

/**
 * Which components may be built ahead of orders (pre-assembly eligibility).
 * Automatic when something is fitted into it at the Hub (a real link with
 * fitting_stage = 'hub'): Hub fitting already says it is put together in the
 * hub, not at the customer. Otherwise only when marked by hand (is_stocked).
 * A replaced component is never eligible.
 * Returns Map id -> { marked, hub }, holding only eligible components.
 */
export function preAssemblyEligibility({ components, edges }) {
  const hubParents = new Set(edges.filter((edge) => edge.fitting_stage === "hub").map((edge) => edge.parent_id));
  const eligible = new Map();
  for (const row of components) {
    if (!canBeEligibleType(row.type) || row.lifecycle_status === "replaced") continue;
    const marked = row.is_stocked === true;
    const hub = hubParents.has(row.id);
    if (marked || hub) eligible.set(row.id, { marked, hub });
  }
  return eligible;
}

/**
 * What one unit of an assembly is made of, for building it ahead of orders.
 * Expands real BOM links until a part (no children) or another eligible
 * component (preAssemblyEligibility), which is taken from the shelf as one unit. Kits (phantom
 * assemblies) hold no stock of their own, so they are expanded to their parts.
 * Callers pass only real links (no "In the box" links, no ended ones), with
 * their fitting_stage.
 * Returns { inputs } with quantities summed per component, or { error }.
 */
export function expandAssemblyInputs({ rootId, components, edges, maxDepth = 20, maxExpansions = 5000 }) {
  const byId = new Map(components.map((row) => [row.id, row]));
  const children = new Map();
  for (const edge of edges) children.set(edge.parent_id, [...(children.get(edge.parent_id) || []), edge]);

  const eligible = preAssemblyEligibility({ components, edges });
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
    if (!isRoot && (links.length === 0 || eligible.has(componentId))) {
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

/** The shape Order Operations receives for one component it can build or use. */
export function articleOf(row) {
  const number = String(row.part_number ?? "").trim();
  return {
    pim_component_id: row.id,
    article_number: number,
    name: String(row.name ?? "").trim() || number,
    unit: String(row.unit_of_measure ?? "").trim() || "ea",
  };
}
