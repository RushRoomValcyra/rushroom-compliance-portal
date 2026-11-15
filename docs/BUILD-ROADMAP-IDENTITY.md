# Build roadmap — one identity from CAD to installed product

Status: **draft for iteration, no development started** · 2026-11-15 · owner: Mathias · spans rushroom-compliance-portal (PIM / E&C Gateway), `@rushroomvalcyra/valcyra-core` + storefront/Studio (Johan), valcyra-order-operations (OO), Blender, Fusion, INSTALL/OS.

Companion documents: `PLANNER-KEY-FLOW.md` (sales side), `CAD-FILE-REPOSITORY.md` (engineering side; its "Carry forward" section supersedes its structure parts).

## What we are building, in one paragraph

A part has one identity everywhere: in Fusion, in Blender, in the portal, on an order. The portal mints it. Customers choose options whose keys the portal also mints; the core package carries them to Studio; OO resolves them through the portal into a frozen manufacturing BOM. Fusion keeps the engineering BOM alone; the portal keeps the manufacturing BOM alone; Blender has a geometry layer that follows Fusion and an option layer that follows the planner; the two meet at the sellable-option boundary. Changes flow one way, by identifier, through released revisions. AI finds the gaps; people close them.

## Principles every item must obey (and why)

| Principle | Why |
|---|---|
| The PIM mints identifiers — part numbers and planner keys. | A key invented downstream (a Studio object name) breaks an order path when someone renames an object. |
| BOM first: the node exists before its key, its CAD link, its Studio option. | Reverse-mapping from carts is how the "wrong order" came to exist. Creating a node is 20 seconds. |
| Released things are immutable; a change is the next revision. | Orders, suppliers and Blender point at them. Nothing is substituted silently (OO decision 0006). |
| Identity, not structure, crosses system boundaries. | Fusion, Blender and the PIM answer different questions; forcing their trees to match made every PLM rigid. |
| Changes are pulled by identifier, never pushed into someone's file. | The designer decides when; a push mid-work destroys work. |
| AI proposes, a person accepts, nothing is written silently. | The portal's existing rule; it is what makes AI trustworthy on master data. |
| Go to market first; today's keys and files ship as they are. | No re-keying, no re-modelling, no big-bang migration. |
| Every rule carries its reason, in the docs and in the UI. | A system only its author understands gets buried (IKEA). |

## Gates (where agreement is enforced; everything between stays loose)

| # | Gate | Frozen record |
|---|---|---|
| G1 | BOM node created | identity: UUID + part number |
| G2 | CAD revision released | exports, physical properties, revision letter ← Fusion version |
| G3 | Core release | sellable options pinned to PIM mapping revisions |
| G4 | Order resolved | MBOM snapshot with revisions (exists today) |
| G5 | Installation completed | as-built against the snapshot (INSTALL/OS) |

## Phase 0 — Decisions and alignment (no code) · now

| Item | Who | Done when |
|---|---|---|
| 0.1 Review both design docs, add reasons to every rule | Mathias + Claude | docs read as reasons; committed to `main` |
| 0.2 Johan: key grammar in the wild, `partKeys.js` location, core release cadence, what the website shows on a flagged cart room | Johan | written answers in the docs' open-question sections |
| 0.3 Johan: how Studio assets are produced from Blender; whether meshes are instanced | Johan | one paragraph in `CAD-FILE-REPOSITORY.md` |
| 0.4 Cut line: side-by-side list of Fusion sub-assemblies vs Studio swappable units | Mathias + Johan + whoever models | agreed list of option-level assemblies; which side moves where they differ |
| 0.5 Fusion hub: personal or team; who administers | Mathias | known; team hub if phase 3 is wanted |
| 0.6 `feet` / `back_cover`: keyed options or outside the BOM path | Mathias | decided |

Nothing in later phases starts before 0.1 and 0.4; 0.2 gates phase 2.

## Phase 1 — Identity in the portal (PIM only) · first build, ~1 week

Smallest set that makes the identifier hard. Everything later leans on it.

| Item | Repo | Size | Why | Done when |
|---|---|---|---|---|
| 1.1 Part number immutable after creation | PIM | hours | an editable identifier is not one; every stamped file inherits it | `updateComponent` refuses a changed part number; panel field read-only; tests |
| 1.2 `cad_models` + `cad_model_files` tables, `TENANT_TABLES`, actions `linkCadDocument`, `registerCadRevision`, `getComponentCad`, `cadUploadUrl` | PIM | 1 day | the registry and archive, same shape as drawings | migration applied; guard tests pass |
| 1.3 CAD tab on the component panel: Fusion link, revisions list, downloads, `<model-viewer>` of the current letter | PIM | 1 day | the user-facing feature is "open in Fusion" and "see what was released" | visible on a component with a linked document |
| 1.4 "Parts without CAD" list, filtered by type | PIM | hours | the rule "every bought or built part has a CAD" enforced as a visible list, not a gate | BOM list chip; count on the dashboard |
| 1.5 Planner catalog read action returns `mapping_revision` + active flag | PIM | hours | the core needs it for G3 | `listPlannerCatalog` extended; test |
| 1.6 Import-from-cart and the gap check say a new key is a process gap | PIM | hours | demotes the reverse path from "normal" to "drift found" | wording in both modals |

Deploy per CLAUDE.md: `supabase db push` → `portal-api` → `git push origin main`.

## Phase 2 — Keys through the core (G3) · Johan + OO, parallel with phase 1

| Item | Repo | Size | Why | Done when |
|---|---|---|---|---|
| 2.1 Core option table built from the PIM catalog at release; release fails on a key with no active mapping | core / site | medium | Studio cannot show what the BOM cannot build | a core version carries key + mapping revision per option |
| 2.2 Studio objects emit the key, not the object name | site | small–medium | identifier, not a name | cart configurations contain catalog keys only |
| 2.3 OO arrival check against the core (0061 slice 3) + `checkPlannerBomGaps` per cart room; result on the Carts page and to the website | OO | medium | an unmapped key is caught at cart time, not after the order | a room with an unknown key is flagged before checkout |
| 2.4 Core's mapping-revision list recorded with `CORE_VERSION` on the order | OO | small | re-resolve to what was meant | column + stored per order |

No change to `resolvePlannerBom`. No re-keying.

## Phase 3 — CAD release path (G2) · ~2 weeks, the add-in is the risk

| Item | Where | Size | Why | Done when |
|---|---|---|---|---|
| 3.1 Fusion add-in: stamp Part Number + `pim_id` attribute from the portal; on release export `.f3z` / `.step` / `.glb`, read physical properties (volume, area, mass, bbox, material), upload via signed URL, register the revision | Fusion (Python) | 3–5 days | one gesture moves both clocks; properties ride on the part | a release in Fusion produces a letter in the portal with files and numbers |
| 3.2 Release trigger = Fusion milestone (or the add-in's own button) | Fusion | part of 3.1 | releasing must be deliberate, distinct from saving | decided and documented |
| 3.3 Release shows dependents: drawings, operations, active mappings whose assemblies contain the part, used-in | PIM | 1 day | a moved hole affects drill rules and a supplier already cutting | list on the CAD tab at release |
| 3.4 Physical properties stored per revision; material volume / mass / board area roll-ups through the MBOM; feeds cost (volume × material price) and DPP | PIM | 2 days | material questions answered where quantities live | totals per assembly and per order; cost module reads them |
| 3.5 Migration of `Serie D` / `Assets`: rename and stamp existing documents, link to nodes | Fusion + PIM | depends on count | no re-modelling, only identity | "parts without CAD" list empty for built parts |

## Phase 4 — Blender layers and pull (Johan) · after 0.3 and 3.1

| Item | Where | Size | Why | Done when |
|---|---|---|---|---|
| 4.1 Blender add-on: stamp `pim_id` / `pim_part_number` / `pim_revision` on import; "Check for CAD updates" → diff → per-part mesh swap in place, appearance preserved | Blender (Python) | 2–3 days | geometry layer follows Fusion automatically; designer chooses when | outdated parts listed and updated without losing materials or placement |
| 4.2 Option layer: collections = swappable units carrying the planner key; geometry nodes referenced, not owned | Blender | design + small | the planner's structure, separate from engineering's | every Studio option maps to one collection with a key |
| 4.3 Assembly-level GLB with hierarchy and identifier node names for option-level assemblies | Fusion add-in | small | a module update is a pull, not a rebuild | an option-level assembly imports as a tree |
| 4.4 Studio export pipeline reads identifiers and keys from Blender | site | Johan's call | traceability from a rendered object to a part and an option | a Studio object knows its part and its option |

## Phase 5 — Gap analytics (AI) · when phases 1 and 3 have data

| Item | Repo | Size | Why | Done when |
|---|---|---|---|---|
| 5.1 Unstamped Fusion documents → proposed part (name, geometry, project) | portal-ai | 1–2 days | clearing a backlog of hundreds is reviewing proposals, not typing | proposals with accept/reject; nothing written silently |
| 5.2 Parts without CAD → closest existing document | portal-ai | 1 day | same | same |
| 5.3 Probable duplicate documents / parts | portal-ai | 1 day | identity hygiene | same |
| 5.4 Blender objects without `pim_id` → match by name, size, position | Blender add-on + portal-ai | 1–2 days | the Blender column of the identity table is real | same |

The planner-key suggestion (`suggestPlannerKey`) already follows this pattern and ships today.

## Phase 6 — Later, only if wanted

- One key per option-in-context, option by option as each is touched (`PLANNER-KEY-FLOW.md` phase 2).
- Autodesk Platform Services: server-side pulls of versions, live Autodesk viewer (needs a team hub, an APS app, admin consent).
- EBOM vs MBOM report for a module: a query over stamped identifiers, built if someone asks.
- Drawing revision pointing at the CAD revision it was made from.
- INSTALL/OS as-built record against the order snapshot (G5) — its own design.

## Deliberately not built

- A structure sync or release-time reconciliation between Fusion and the PIM BOM.
- A PLM, a document-management system, or any second copy of native CAD files.
- Pushing geometry into Blender or Studio.
- Re-keying or re-modelling anything that ships today.

## Dependencies, drawn

```
0.1 docs ─┬─► 1.1 part number immutable ─► 1.2 registry ─► 1.3 CAD tab ─► 3.1 add-in ─┬─► 3.3 dependents
          │                                            └─► 1.4 no-CAD list            ├─► 3.4 properties / roll-ups
          │                                                                           └─► 3.5 migration ─► 5.x AI gaps
0.4 cut line ─────────────────────────────────────────────────────────────► 4.2 option layer ─► 4.3 assembly GLB
0.3 Johan (Studio from Blender) ───────────────────────────────────────────► 4.1 Blender pull ─► 4.4 Studio export
0.2 Johan (grammar, cadence) ─► 1.5 catalog action ─► 2.1 core table ─► 2.2 Studio emits keys
                                                     └─► 2.3 OO arrival check ─► 2.4 CORE_VERSION
```

## Gap analysis — the identifier in the portal today (2026-11-15, read from code)

What holds: `bom_components.id` is a UUID; `UNIQUE (organization_id, part_number)` since migration 0007; copies always get a fresh number (`copyComponent`); every part-number change is recorded by the history trigger (0009); planner keys are one-active-per-key; drawings use the same unique-number pattern. The foundation is sound. The gaps are all about *keeping* the identifier, not creating it.

| # | Gap | Evidence | Severity | Fix (phase) |
|---|---|---|---|---|
| G-1 | **Part number is editable.** Any non-empty string replaces it. | `updateComponent`, portal-api/index.ts:3833 | high — a stamped Fusion file, a Blender object, a supplier's STEP and an OO snapshot all keep the old number | refuse changes after creation; panel field read-only (1.1) |
| G-2 | **No format or normalisation.** Trim only; no regex, no case rule. `rr-…` and `RR-…` are two parts; a pasted number with inner spaces is accepted. | create 3613, update 3833, variant-from-configuration 5479 | medium | one server-side validator: `^RR-\d{6}-[A-Z2-9]{8}$` for generated numbers, an allow-list pattern for legacy/manual ones; upper-case on write (1.1) |
| G-3 | **Four generators of the same number.** Two in portal-api (3604, 5480) plus `copyComponent` (891), two `genPN()` in app.js (6258, 9027). The client may pass its own number to create. | grep | low today, medium later — drift in format is how identifiers stop being parseable | one server function; create ignores a client-supplied number unless explicitly "manual" (1.1) |
| G-4 | **Hard delete of a published identifier.** `deleteComponent` removes the row, its planner mappings and edges. OO snapshots, Fusion stamps and Blender properties keep pointing at a UUID that no longer exists. | 4359–4403 | high once anything external is stamped | delete only while unreferenced (no mapping ever, no CAD link, never in an OO snapshot); otherwise `lifecycle_status: replaced/inactive` and keep the row (1.x) |
| G-5 | **Two "their number" columns.** `bom_components.oem_number` (legacy) and `component_metadata.manufacturer_part_number` (0029 made it the one); the panel still writes both. | update 3832; panel saves both | low — confusion, not corruption | stop writing `oem_number`; drop the column later |
| G-6 | **Component revisions already exist** (`bom_component_versions`, letters A, B…, `bumpComponentVersion`). The CAD design introduced a second letter series. | 3622, 3873 | medium — two letter sequences on one part is exactly the ambiguity to avoid | CAD releases attach to the component revision (a CAD revision *is* a reason to bump), or the CAD letter is dropped and `cad_model_files` points at `bom_component_versions.id` (phase 3 design) |
| G-7 | **No external-identity table.** Nowhere to hold "this part is Fusion document X / Blender object Y / supplier's Z". | schema | by design, not yet built | `cad_models` (1.2); a general `component_external_ids (system, external_id)` may be cheaper than one table per system — decide in phase 1 |
| G-8 | **Name is still an identifier at one boundary**: a planner key is the Studio object's name until phase 2 lands. | OO `planner-bom-requirements.ts` | known, tracked | phase 2 |
| G-9 | **Identifier never leaves the portal in machine form.** Exports (drawings, supplier portal, resolver) carry `part_number` and `pim_component_id`, but no QR/label format is defined for the hub or installer. | — | low now; OO's 0058 QR labels will need it | define the label payload once: `RR-…` + UUID (phase 3 or OO) |

Order of attack: G-1, G-2, G-3 together (one day, phase 1.1); G-4 before any stamping (phase 1); G-6 decided in phase 3 design before the add-in writes a letter; G-5 opportunistic.

## Open questions carried from the design docs

1. Key grammar Studio emits today (`M_color_0` vs `module_m_color_white`) — Johan.
2. `partKeys.js` into the core or separate — Johan.
3. Core release cadence and offline builds — Johan.
4. What the website shows on a flagged cart room — Johan + OO.
5. `feet` / `back_cover` — Mathias.
6. Hub type — Mathias.
7. Purchased sub-assemblies (one STEP): one node or several — the BOM decides by how the hub handles it; CAD links to whatever exists.
8. Release gate for CAD: blocking on open dependents, or advisory — lean advisory.
9. Lifecycle alignment: BOM `lifecycle_status` vs CAD `draft | released | superseded` — align or keep separate.
