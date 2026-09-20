// Multi-tenant scoping. makeTdb() wraps the service-role client so every query
// against a tenant table is filtered by organization_id and every insert is
// stamped with it. Tenancy is ALWAYS derived from the session, never from the
// request body — the same rule in every function.
import { db } from "./env.ts";

export const RUSHROOM_ORG_ID = "11111111-1111-4111-8111-111111111111";
// A user's assigned role → their per-organization membership role.
const MEMBERSHIP_ROLE: Record<string, string> = {
  admin: "org_admin", internal: "manager", reviewer: "reviewer", supplier: "collaborator", installer: "collaborator",
};
const membershipRoleFor = (assigned: string) => MEMBERSHIP_ROLE[assigned] || "collaborator";

// --- Stage 2: central tenant scoping (module-level factory) ----------------
// Tenant tables carry organization_id; reads are filtered and writes are stamped
// with the caller's org. Global/account tables (users, eu_directives,
// directive_relations, cellar_cache, organizations, memberships) pass straight
// through. Build a per-request instance with makeTdb(orgId) — never a shared
// mutable global — so scoping can't race across concurrent requests. Use
// tdb(table) exactly like db.from(table) for tenant data.
export const TENANT_TABLES = new Set([
  // PROP-038: part categories (migration 0027)
  "part_categories",
  // PROP-040: promoted custom spec fields (migration 0028)
  "custom_spec_fields",
  "steps", "documents", "document_versions", "uploads", "standards", "standard_versions",
  "deviation_scans", "deviation_findings", "standard_clauses", "as_operates_interpretations",
  "product_passports", "passport_interpretation_links", "product_directive_applicability",
  "classification_log", "requirement_links", "document_statements",
  // PROP-013: Product Information System
  "bom_components", "bom_component_versions", "bom_edges", "bom_component_history",
  "component_materials", "component_documents",
  // PROP-015: Configure-to-Order Variant BOM
  "family_attributes", "family_attribute_values", "saved_configurations",
  // PROP-026: Component image gallery
  "component_images",
  // PROP-030: Manufacturing BOM + product families (migration 0019)
  "product_families", "product_family_members",
  "component_routing_steps", "work_orders", "work_order_steps", "work_order_components",
  // PROP-031: Component metadata (migration 0020)
  "component_metadata",
  // PROP-035: Component variant groups (migration 0024)
  "component_variant_groups", "component_variant_members",
  // PROP-045: Drawings domain (migration 0032). A table missing from this set
  // passes through makeTdb UNSCOPED — every tenant sees every row and nothing
  // errors. tests/tenant-tables.test.mjs guards the omission.
  "drawings", "drawing_revisions", "drawing_components", "drawing_dimensions",
  // PIM-owned Website Planner → PIM BOM registry (migration 0034)
  "planner_mappings",
]);
export function makeTdb(orgId: string) {
  const stamp = (rows: any) => Array.isArray(rows)
    ? rows.map((r) => ({ ...r, organization_id: orgId }))
    : { ...rows, organization_id: orgId };
  return function tdb(table: string): any {
    const b = db.from(table);
    if (!TENANT_TABLES.has(table)) return b;
    return {
      select: (...args: any[]) => (b.select as any)(...args).eq("organization_id", orgId),
      insert: (rows: any) => b.insert(stamp(rows)),
      upsert: (rows: any, opts?: any) => b.upsert(stamp(rows), opts),
      update: (patch: any) => b.update(patch).eq("organization_id", orgId),
      delete: () => b.delete().eq("organization_id", orgId),
    };
  };
}
