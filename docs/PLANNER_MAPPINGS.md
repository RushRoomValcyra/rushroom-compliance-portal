# Planner mappings (PIM-owned)

This is the PIM registry that maps a stable Website planner source key to an
existing PIM component or sub-assembly ID. It deliberately does not read a
Website cart, call Operations, create orders, or hold credentials.

## Current Website cart fields

| Source type | Cart field | Example stable keys |
| --- | --- | --- |
| module | `modules[].module` | `S`, `M`, `L` |
| interior | `modules[].interior[]` | `Drawer_600_color_2` |
| side panel | `sides.panels[]` | `side_left_color_0`, `side_middle_color_0`, `side_right_color_0` |
| feet | `sides.feet` | `Foot` |
| door | `doors[]` | Exact emitted door mesh name with `_color_#` suffix — inspect to obtain it |
| cover | `covers[]` | Exact emitted cover mesh name with `_color_#` suffix — inspect to obtain it |
| back cover | `backCovers` | `BackCover` |

The key must be the source system's stable identifier, never a display name.
Side panel names are emitted through the Website's color helper, including
`side_left_color_#`, `side_middle_color_#`, and `side_right_color_#` where `#`
is `0` through `4`. Interior, door, and cover names can carry the same suffix.
Door and cover mesh names are dynamic, so do not guess a generic key: the
inspector's exact emitted key is authoritative. The suffix is part of the
current source key. Wildcards are stored as data but are **not resolved** in
this MVP; the inspector neither creates nor resolves a wildcard.

## Saved PIM planner catalog

`planner_catalog_entries` (migration `0035`) is a tenant-scoped PIM catalog of
source keys and labels. It is separate from `planner_mappings`: catalog entries
identify available planner keys; mappings identify the PIM `target_component_id`
for one of those keys.

On a normal **Product BOM → Planner mappings** visit, PIM loads the saved catalog
and groups keys by source type. The user can select **Map this item** without
pasting anything. To seed or update the catalog, **Import/update planner keys**
opens a local paste modal that accepts one cart item containing
`{ configuration: { ... } }` or the configuration object. The browser derives
the supported exact source keys, shows a preview, and sends only derived
`source_type`, `source_key`, and `label` items to PIM.

PIM never receives the raw cart JSON or cart quantities, and it does not call
Website or Operations. Imports are Rushroom-only, bounded to 2,000 source items,
and upsert the catalog per tenant/source type/key. Multiplicity remains
cart-derived in this MVP for a future Operations resolver.

## PIM editor and API

Rushroom users open **Product BOM → Planner mappings**. They can create a
mapping, select an existing PIM component or sub-assembly, save a new revision,
and deactivate a mapping. Source type and key are immutable after creation so a
source identity cannot quietly change its meaning. The database/API retain
quantity-rule support for future advanced use, but this MVP editor always saves
identity mappings with `cart_quantity`.

Actions on `portal-api`:

- `listPlannerMappings` — latest revision per source key by default; pass
  `include_history: true` for all revisions.
- `listPlannerCatalog` — lists the authenticated tenant's saved source keys.
- `importPlannerCatalog` — Rushroom-only upsert of bounded, derived source
  keys and labels; raw cart data is rejected by the API contract.
- `savePlannerMapping` — creates a mapping or a new revision of an active
  mapping. `mapping_id` is required for an edit.
- `deactivatePlannerMapping` — stops an active mapping from being resolved.

All actions require a Rushroom session. `organization_id` is derived only from
the signed session and `planner_mappings` is tenant-scoped through `makeTdb`.

## Operations → PIM resolver contract (Stage 1)

`resolvePlannerBom` is a dedicated service-to-service `portal-api` action for a
future Order Operations caller. It does not accept a browser session, cart JSON,
customer data, addresses, prices, or order IDs. It is pinned to the Rushroom
organization and requires the Edge Function environment variable named
`OPERATIONS_PIM_RESOLVER_KEY` (no value is stored in this repository). The
caller sends it as standard `Authorization: Bearer <key>`; PIM compares it in
constant time. An unset key returns `503`; an invalid key returns `401`.

The complete request body is:

```json
{
  "action": "resolvePlannerBom",
  "contract_version": 1,
  "requirements": [
    { "source_type": "module", "source_key": "M", "quantity": 2 }
  ]
}
```

Requirements are limited to 250 unique source identities and require positive,
finite numeric quantities. Duplicate identities and any unrecognised top-level
field are rejected. PIM resolves only active mappings. `cart_quantity` applies
the requested quantity; `fixed` applies the mapping's `fixed_quantity`.

Every valid response has exactly these top-level fields:

```json
{
  "contract_version": 1,
  "status": "resolved | partially_resolved | needs_mapping | failed",
  "resolved_at": "ISO timestamp or null",
  "mapping_evidence": { "records": [] },
  "unresolved_requirements": [],
  "bom_entries": []
}
```

`status: "resolved"` has a non-null `resolved_at`, no
`unresolved_requirements`, and at least one `bom_entries` row.
`partially_resolved` has `resolved_at: null`, at least one returned BOM row, and
one or more missing/inactive mappings. It is an incomplete working list, not a
released pick list. `needs_mapping` means no requirement could be resolved;
`failed` is a PIM data or graph blocker, such as a missing target, cycle,
too-deep expansion, or invalid edge. Component lifecycle does not block an
explicitly active planner mapping. Each unresolved requirement carries its exact
`source_type`, `source_key`, requested `quantity`, and machine-readable reason.
Active `bom_edges` are expanded recursively with depth/expansion bounds; a leaf
target stays a leaf and entries aggregate by PIM component. The active mapping,
not the component lifecycle field, controls whether a planner key resolves.

## Version and release metadata

Every edit creates a new row with a higher `mapping_revision`, `supersedes_id`,
`release_label`, timestamp, and creator. The prior revision is retained but no
longer active. Deactivation retains the row with an explicit timestamp and
actor. A future authenticated Operations → PIM resolver should consume only
active latest mappings, then resolve `target_component_id` in its own tenant.
