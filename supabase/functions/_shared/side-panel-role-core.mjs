// Pure core of the part card's Order Surgery table (Order Operations' item
// 0043): which kind of side panel a component is, from the planner's side
// panel mappings. No HTTP, secrets, database or tenant access.
//
// The hub works the bare side panel part before it is assembled into its
// Prepared panel (ziirvass, 2026-10-28), so the part has the role; the
// Prepared panel it sits in only points to it.

// A side panel part's name ("Left Side Panel - White", "Shared (Middle) Side
// Panel - White"); fittings such as "Bottom panel strong holders" are not.
// The same rule Order Operations uses to find the worked part.
export const PANEL_PART = /\b(side|mid) panel\b/i;

const ROLE_BY_KEY = [
  ["side_left", "left_end"],
  ["side_middle", "mid"],
  ["side_right", "right_end"],
];

export const roleOfSourceKey = (key) => ROLE_BY_KEY.find(([prefix]) => String(key).startsWith(prefix))?.[1] ?? null;

/**
 * The side panel role of one component, or null.
 * mappings: active side_panel planner mappings [{ source_key, target_component_id }];
 * edges: current, non-reference BOM edges [{ parent_id, child_id }];
 * components: Map id -> { id, name, part_number }.
 * Returns { role, worked: true } for the panel part (or a panel mapped
 * directly), { role, worked: false, panel } for the Prepared panel it sits in.
 */
export function sidePanelRole(componentId, { mappings, edges, components }) {
  for (const mapping of mappings) {
    const role = roleOfSourceKey(mapping.source_key);
    if (!role) continue;
    const target = mapping.target_component_id;
    const children = edges.filter((edge) => edge.parent_id === target).map((edge) => components.get(edge.child_id)).filter(Boolean);
    if (!children.length) {
      if (componentId === target) return { role, worked: true };
      continue;
    }
    const panels = children.filter((child) => PANEL_PART.test(child.name));
    if (panels.length !== 1) continue;
    const [panel] = panels;
    if (componentId === panel.id) return { role, worked: true };
    if (componentId === target) return { role, worked: false, panel: { id: panel.id, name: panel.name, part_number: panel.part_number ?? null } };
  }
  return null;
}
