# Planner key flow — BOM-first mapping between the PIM and Valcyra Studio

Status: **draft** · 2026-11-13 · owner: Mathias · systems: this repo (PIM / E&C Gateway), `@rushroomvalcyra/valcyra-core` (published from `valcyra-site/lib/core`), the storefront and Studio at valcyra.com, valcyra-order-operations (OO), INSTALL/OS.

## Decisions

| # | Decision | Consequence |
|---|---|---|
| D1 | **The PIM mints the planner key.** A key is an identifier assigned to a BOM node here, never a 3D object's name. | Studio, the cart and OO carry the key; none of them invent one. |
| D2 | **BOM first.** An option exists in Studio only after its BOM node exists and carries a key. | Creating the node is a 20-second job (new node, or copy an assembly); it is the first step of adding an option, not the last. |
| D3 | **Go to market with today's keys.** The keys already in the catalog stay as they are. One key per option-in-context is the target, reached option by option after launch, never by re-keying what ships. | No big-bang migration. New options follow the target shape from day one. |
| D4 | **A core release names the PIM mapping revisions it was built against.** | An order can always be re-resolved to what was meant when it was planned (`CORE_VERSION` on the order ↔ `mapping_revision` in the PIM). |
| D5 | **CAD and Blender are out of scope for the order path.** Fusion / Blender carry the PIM key only as a custom property, for traceability, in a later step. | Nothing in Studio's geometry pipeline changes for this design. |

## The chain

Every hop has one owner, one payload, one validation and one loud failure. Nothing is substituted silently (OO decision 0006 and the resolver contract already hold this line).

| Hop | Owner | Payload | Validated by | Fails as |
|---|---|---|---|---|
| 1. BOM node → key | PIM | `planner_mappings` row: `(source_type, source_key) → target_component_id`, quantity rule, `mapping_revision`; the key is auto-synced into `planner_catalog_entries` | `savePlannerMapping`: key grammar, one active mapping per key, target exists and is not a product family | 400 / 409 to the user in the component panel |
| 2. Catalog → core | PIM publishes, core consumes | The option table: for each key, its `source_type`, label, and the PIM mapping revision | A core release build that fails if a referenced key has no active mapping | The core does not release |
| 3. Core → Studio | Core | Studio reads options and their keys from the core; a planner object emits its **key**, not its name | Studio can only show what the core has | An option with no key cannot be shown |
| 4. Studio → cart → OO | Storefront server | Configuration verbatim (`PUT /api/v1/carts/{cartId}/items/{itemId}`), then the order intake | OO checks the configuration with the core on arrival (OO roadmap 0061 slice 3) **and** asks the PIM `checkPlannerBomGaps` for the keys in it | A room with an unmapped key is flagged in the cart, before checkout |
| 5. OO → PIM | OO | `resolvePlannerBom` contract v2: requirements `(source_type, source_key, quantity)` | PIM resolves through active mappings; assemblies expand, stocked pre-assemblies stay whole | `needs_mapping` holds the order (existing behaviour) |
| 6. PIM → OO → INSTALL/OS | PIM answers, OO stores | `bom_entries`, `assembly_tree`, operations, kept as an immutable snapshot with `CORE_VERSION` | Contract schema in OO | 502 `pim_resolver_unavailable` (existing) |

Hops 1, 5 and 6 exist and keep their contracts. Hops 2, 3 and 4 are what this design adds; today hop 3 emits object names and hop 4 does not check mappings.

## The key

- An identifier, minted in the PIM when the mapping is created. Readable by convention (lowercase, `_`-joined tokens, today's grammar: `module_m_color_white`, `drawer_set_l_color_white_handle_color_silver`), but its meaning is the mapping, not the spelling.
- Immutable once published in a core release. A change of meaning is a new mapping revision on the same key, or a new key; never an edit of the string.
- One active mapping per `(source_type, source_key)`. Many keys may point at the same BOM node (shared kits, aliases) — that is allowed and needed.
- Keys usually name an **assembly** (`sub_assembly`, `phantom_assembly`), not a part. The resolver expands it; the planner picks it by the attributes the key encodes, which often live on a child (handle colour on the handle part).

## The process for adding an option (BOM first)

1. **PIM** — create the BOM node (or copy the closest assembly) and give it its parts. ~20 s.
2. **PIM** — on the node's Overview, *Planner keys → + Assign planner key*: pick the key group, use *Suggest* or type the key in the existing grammar, Assign. The key is now in the catalog with an active mapping.
3. **Core** — the next core release picks the key up from the catalog (hop 2) and records the mapping revision.
4. **Studio** — shows the option; its object emits the key.
5. **OO** — nothing to do: the arrival check finds an active mapping, the resolver resolves.

Reverse paths stay as tools for catching drift, not as the way in: *Import / update planner keys* from a cart and the *BOM Mapping Check* show what Studio emits that the PIM does not know. Under this design a non-empty result is a process violation to fix, not a normal step.

## Phase 1 — go to market (now)

Smallest set of changes that makes the chain hold with today's catalog.

| Repo | Change | Size |
|---|---|---|
| PIM | Expose the catalog for the core: a read action returning `source_type`, `source_key`, label, `mapping_revision`, active flag. (`listPlannerCatalog` exists; add revision + active.) | small |
| PIM | Keep assigning from the component panel as the primary path (built). Make *Import from cart* and the gap check say explicitly that a new key found there is a process gap. | small |
| Core / site | Build the option table from the PIM catalog at release time; fail the release on a key with no active mapping (hop 2). Studio emits the key. | medium — Johan |
| OO | 0061 slice 3 (arrival check against the core) plus a `checkPlannerBomGaps` call per cart room; surface the result on the Carts page and to the website (hop 4). | medium |
| OO | Record the core's mapping-revision list with `CORE_VERSION` on the order (D4). | small |

No re-keying. No change to the resolver contract. No change to Studio's geometry.

## Phase 2 — one key per option-in-context (after launch)

- Each `(option × size × colour × …)` that is sold becomes its own BOM assembly with its own key, replacing keys whose meaning today depends on context OO adds later.
- Done option by option when an option is touched anyway; the old key stays active until no core release references it.
- The resolver's `condition` fields (`face`, `size`, `interior`, `contains`) shrink as context moves into the key.

## Open questions

1. **Key grammar in the wild.** OO's contract example shows `M_color_0` / `side_middle_color_0`; the keys imported into the PIM are `module_m_color_white` / `door_right_380mm_…`. Which does Studio emit today, and does the site transform names? — Johan.
2. **`feet` and `back_cover`.** PIM source types that OO never derives (`backCovers` is a counter, feet are absent). Decide whether they become keyed options or stay outside the BOM path.
3. **`partKeys.js`** (item kinds that operation `contains` conditions read) lives in the site, not the core. Move it into the core with the option table, or keep it separate?
4. **Core release cadence.** Hop 2 makes a core release depend on the PIM. Who triggers a release when a key is added, and is a release without the PIM reachable (offline build) acceptable?
5. **What the website shows** when hop 4 flags a room. Needs agreeing with the site before OO builds it (same open question as 0061 slice 3).

## Not in this design

- Pricing, stock, picking, Order Surgery rules, installer flows — unchanged, they consume the resolved BOM as today.
- A Fusion / Blender ↔ PIM link beyond a custom property (D5).
- Replacing OO's `CORE_VERSION` or the PIM's `mapping_revision` with a single new version scheme.
