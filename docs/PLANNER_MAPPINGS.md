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
  "include_assembly_tree": true,
  "requirements": [
    { "source_type": "module", "source_key": "M", "quantity": 2 }
  ]
}
```

Requirements are limited to 250 unique source identities and require positive,
finite numeric quantities. Duplicate identities and any unrecognised top-level
field are rejected. PIM resolves only active mappings. `cart_quantity` applies
the requested quantity; `fixed` applies the mapping's `fixed_quantity`.

Every valid response has these top-level fields. `assembly_tree` is returned only
when the caller explicitly sets `include_assembly_tree: true`, keeping existing
service consumers compatible:

```json
{
  "contract_version": 1,
  "status": "resolved | partially_resolved | needs_mapping | failed",
  "resolved_at": "ISO timestamp or null",
  "mapping_evidence": { "records": [] },
  "unresolved_requirements": [],
  "bom_entries": [],
  "assembly_tree": []
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
When requested, `assembly_tree` preserves the unaggregated tree for each mapped
planner requirement. Every node carries its resolved quantity and children, so
an assembly and every nested sub-assembly remain visible alongside the flat
inventory pick list.

### Contract v2: operations and stocked pre-assemblies (2026-10-27)

Order Operations (its item 0039) asks with `"contract_version": 2`. The request
and every v1 field stay the same; `contract_version` in the answer is `2`, and:

- Every `assembly_tree` node carries `operations`: the component's own
  operations (`component_routing_steps` with no product family, migration
  0052), in step order, each
  `{ "id", "operation_type", "stage": "hub" | "site" | null, "instruction_text", "condition", "drawing": { "drawing_number", "title", "revision" } | null, "pim_component_id", "part_number", "component_name" }`.
  An empty list means nothing is done to it. `condition` says when it applies,
  in the planner's terms: `{ "face": "left" | "right", "size": "S" | "M" | "L", "interior": <planner interior code> }`,
  each key optional, `null` meaning always. Order Operations matches it against
  the module next to each face of the panel in the customer's configuration.
- A **stocked pre-assembly** (eligible: something fitted into it at Hub, or its
  checkbox ticked; the same rule as `listStockedAssemblies`) is not expanded.
  Its node has `"pre_assembly": true` and no children, and its `bom_entries` row
  has `"pre_assembly": true`: it is taken from the shelf as one unit. Its
  `operations` include those of every part inside it (each names its part), so
  a side panel taken from the shelf as its Prepared panel is still drilled.

A v1 request is answered exactly as before. Operations decide nothing about the
BOM: a drilled panel is the same article. Which panel needs which pattern is
worked out in `docs/hub-operations-matrix.xlsx` (face × module size × interior;
generated by `tools/build-hub-operations-matrix.py` from the planner's spec).

## Operations → PIM article lookup (contract v1)

Order Operations' receiving identifies each delivered article by its article number (its `docs/integrations/gateway-article-lookup.md` is the same contract seen from the caller). `lookupArticle` uses the same endpoint, key and boundary as the resolver above: `POST` to `portal-api` with `Authorization: Bearer <key>` checked against `OPERATIONS_PIM_RESOLVER_KEY`; it does not accept a browser session, and it always looks in the seed Rushroom organization.

Request, with no other keys:

```json
{ "action": "lookupArticle", "contract_version": 1, "article_number": "RR-LED-30W" }
```

- The article number is matched exactly, ignoring case and surrounding spaces.
- Product families (dynamic BOMs) and phantom assemblies are not articles and are never returned.

Answers, status 200:

```json
{ "contract_version": 1, "status": "found",
  "article": { "pim_component_id": "<bom_components.id>", "article_number": "RR-LED-30W", "name": "LED strip 30 W", "unit": "ea" } }
```

```json
{ "contract_version": 1, "status": "not_found" }
```

- `article_number` is the spelling stored here, `name` falls back to the article number when empty, and `unit` falls back to `ea` when `unit_of_measure` is empty.
- 400 for any other request shape, 401 for a wrong key, 503 when the key is not configured, 409 when two components share the number in different case, 502 when the data cannot be read.
- The matching rules live in `supabase/functions/_shared/article-lookup-core.mjs` and are tested by `tests/article-lookup.test.mjs`.

## Operations → PIM pre-assemblies (contract v1)

Order Operations builds eligible components ahead of orders (its item 0018). Two service actions, with the same endpoint, key and boundary as `lookupArticle`:

`listStockedAssemblies`, request `{ "action": "listStockedAssemblies", "contract_version": 1 }`, answers every component eligible for pre-assembly: something is fitted into it at the Hub (a real link with `fitting_stage = 'hub'`), or its card's checkbox is ticked (`is_stocked = true`). Parts count as well as assemblies; Kits, Dynamic BOMs and replaced components never do. How many to hold on hand is not kept here; Order Operations owns it (its decision 0012):

```json
{ "contract_version": 1, "assemblies": [
  { "pim_component_id": "<id>", "article_number": "RR-DOOR-L", "name": "Door left, handle fitted", "unit": "ea" } ] }
```

`resolveAssemblyInputs`, request `{ "action": "resolveAssemblyInputs", "contract_version": 1, "article_number": "RR-DOOR-L" }`, answers what **one unit** is made of:

```json
{ "contract_version": 1, "status": "resolved",
  "assembly": { "pim_component_id": "<id>", "article_number": "RR-DOOR-L", "name": "Door left, handle fitted", "unit": "ea" },
  "inputs": [ { "pim_component_id": "<id>", "article_number": "RR-HANDLE", "name": "Handle", "unit": "ea", "quantity": 1 } ] }
```

- Real BOM links only (no "In the box", none ended), expanded until a part or another eligible component, which is taken from the shelf as one unit. Kits (phantom assemblies) are expanded to their parts. Quantities are summed per component.
- `{ "contract_version": 1, "status": "not_found" }` for an unknown article number; 422 when it is a Kit or Dynamic BOM, has no inputs, or its BOM cannot be expanded (cycle, too deep); 409 when two components share the number.
- The eligibility rule and the expansion live in `supabase/functions/_shared/assembly-inputs-core.mjs` and is tested by `tests/assembly-inputs.test.mjs`.

## Version and release metadata

Every edit creates a new row with a higher `mapping_revision`, `supersedes_id`,
`release_label`, timestamp, and creator. The prior revision is retained but no
longer active. Deactivation retains the row with an explicit timestamp and
actor. A future authenticated Operations → PIM resolver should consume only
active latest mappings, then resolve `target_component_id` in its own tenant.
