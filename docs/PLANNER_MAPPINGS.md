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

## Website planner catalog

The **Product BOM → Planner mappings** screen loads source keys automatically
through the Rushroom-only `listPlannerCatalog` action. PIM server-fetches the
public Website catalog from the required, nonsecret Edge Function environment
variable `WEBSITE_PLANNER_CATALOG_URL`; browsers do not call that URL directly.

The Website response contract is JSON with an `items` array. Each item must
contain `source_type`, `source_key`, and optional `label`; only the seven
documented source types and valid stable keys are accepted. PIM caps the
response at 512 KiB, limits it to 2,000 items, and stops the request after five
seconds. The configured URL must be credential-free HTTPS.

Catalog keys are grouped by source type. Selecting **Map this item** pre-fills
a new identity-only mapping. Website owns only source keys and labels; PIM owns
the selected `target_component_id` and mapping lifecycle. No cart, credentials,
or Operations data is accepted from or returned to Website. Its multiplicity is
always cart-derived in this MVP: a future Operations resolver will use repeated
cart rows and the cart's existing `qty` fields.

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
- `listPlannerCatalog` — Rushroom-only server fetch of Website source keys and
  labels; does not return the configured URL or credentials.
- `savePlannerMapping` — creates a mapping or a new revision of an active
  mapping. `mapping_id` is required for an edit.
- `deactivatePlannerMapping` — stops an active mapping from being resolved.

All actions require a Rushroom session. `organization_id` is derived only from
the signed session and `planner_mappings` is tenant-scoped through `makeTdb`.

## Version and release metadata

Every edit creates a new row with a higher `mapping_revision`, `supersedes_id`,
`release_label`, timestamp, and creator. The prior revision is retained but no
longer active. Deactivation retains the row with an explicit timestamp and
actor. A future authenticated Operations → PIM resolver should consume only
active latest mappings, then resolve `target_component_id` in its own tenant.
