# Rushroom Compliance Portal — Roadmap
_Last updated: 2026-09-15 · Auto-maintained by /ship · state map for `/status`_

**Lifecycle:** Backlog → Next → Now → **Built (awaiting deploy)** → Shipped.
"Shipped" means *confirmed working against production*, not "code written" — code that
exists but has not been deployed and exercised lives in **Built**, because that is the
state where something looks done and silently is not.

## Now — In Progress
- PROP-021 Component Document Lifecycle — Layer 1 shipped (upload & link from component panel); Layers 2–4 (new revision, AI diff, data extraction) pending; PROP-014 must be reviewed before Layer 2 design
- PROP-012 Multi-tenant SaaS (organizations, memberships, invitations, platform_audit, ai_usage_events) — Stages 5b+6 remaining

## Built — Awaiting Deploy or Verification
_Code is committed but not yet live, or live but not yet exercised. Each line states what is still required._
- **PROP-041 Category-specific spec fields** — needs `supabase db push` (migration 0030) and the function deploy. Verify: open a Fittings & Fasteners part and check Physical shows Head diameter, Thread / tube diameter, Head slot type and Head type; open a Furniture panels part and check they are absent.
- **Detail panel + list UX batch (v219–v223)** — duplicate variant chips removed; Relations tab splits the relationship sections off Overview; the panel opens as a centred overlay instead of below the list; the component list scrolls in its own region with the filters pinned; the panel's header and tab bar pinned with only tab content scrolling. Needs `git push origin main` and a hard reload — frontend only, no migration or function deploy. Verify: open a component from the bottom of the Parts list (panel appears centred, page does not move), scroll Specifications (tab bar and Close stay visible), paste into Images (still uploads).

- **PROP-036 Move rollback branch** — shipped and in use, but the failure path (re-opening the closed edge when the insert is rejected) has never run, because no move has failed. Not provable without forcing a failure; left recorded rather than claimed.

## Next — Approved for Build
- PROP-014 Compliance–BOM Integration: Component Evidence Bridge — spec complete, awaiting "go ahead"

## Backlog — Ideas to Spec
- PROP-024 Component Version History — Full State Access Per Revision — written to IDEAS.md
- PROP-005 Generate DPP from compliance matrix
- PROP-009 Scheduled compliance scans + email alerts
- PROP-007 Multi-language support EN/DE/SV

## Discovered While Building
_Found mid-build, too small or too tangential for a PROP, too real to drop. Promote to Next, or delete once it stops mattering._

- **`assets/app.js` shared-state scoping** *(now four occurrences — worth acting on)* — `bomTreeView` holds list state in one closure while the modals that need it (`openAddChildModal`, `openComponentDetail`, `openMoveModal`) are sibling functions outside it. This has produced two real defects: `parentCountMap` threw a `ReferenceError` mid-handler (PROP-036), and `refreshTree` was unreachable from the detail panel (v211). Each fix was one line; the shape keeps recurring. Two more since: the image-paste listeners, and `meta` read ~170 lines above its own `const` (v218), which threw on every component open. None of these are caught by `node --check` or an esbuild parse, because they are all valid syntax. `openComponentDetail` is now long enough that declaration order is not visible while editing it — the fix is to hoist the shared state deliberately and split that function.
- **Bulk part tagging** — tolerable at 18 parts, painful at the thousands PROP-038 is built for. Needed if parts ever arrive by import.

## Shipped
_Confirmed working against production. Date is the verification date, not the commit date._
- **PROP-039 AI field extraction** (✨ AI fill reads a datasheet, drawing or pasted screenshot into the spec fields; proposals with as-printed value, evidence quote and confidence; never auto-written; unmapped values to custom_specs; `fileBlock` image support; ephemeral sources; cache v214–v215) — 2026-09-15, confirmed: extraction returned a correct OEM number from a datasheet image
- **OEM number unification** (two columns were both labelled "OEM number"; `component_metadata.manufacturer_part_number` is now the single source, read and written by Overview, the create modal and AI fill; `bom_components.oem_number` retired from the UI, column kept as history; migration 0029; v217 + v218 TDZ fix) — 2026-09-15, confirmed: migration applied, 0 unmigrated values, Overview and Procurement agree
- **PROP-040 Promote custom spec to standard field** (org-scoped `custom_spec_fields` catalogue; ＋ Make standard offered at 3+ parts; promoted fields render in their section, editable in place; values stay in custom_specs so promotion migrates nothing; migration 0028; cache v216) — 2026-09-15, **deployed; promotion flow not yet exercised** (no key has reached 3 parts yet)
- **Duplicate image paste fix** (v212 + v213) — one Cmd+V uploaded the same image to two components: the detail panel and the New BOM Node modal both bind `paste` to `document`, so the image went to the component being created *and* to whichever panel was open behind it. Overlays now carry `data-modal-overlay` and the panel yields to any modal above it; v212's per-panel listener leak was also real and is kept. — 2026-09-15, confirmed against production: the first upload after the fix produced a single row (12:41 UTC, *Elefant fastener*) where every prior paste produced a pair; 5 images, one per component, zero duplicate pairs. **Residual:** the specific path of pasting into the create modal while another panel is open behind it has not been re-run since the fix.
- **PROP-038 Part categories** (clickable chips with live counts under the Parts tab; org-scoped `part_categories` + `bom_components.category_id`; 5 API actions; ⚙ manager; category required on create, enforced server-side; migration 0027; cache v210, list-refresh-on-save v211) — 2026-09-15, confirmed against production: migration applied, 4 categories seeded, **20 parts categorised and 0 untagged**
- **PROP-037 Editable BOM quantity** (quantity could be set at link time and never changed — correcting one meant unlink + re-add; new `setEdgeQuantity` action, click-to-edit QTY cell, audited old→new in bom_component_history; edge-scoped so other assemblies keep their own quantities; the column shows the rolled-up quantity so the cell edits `edgeQty` and displays the roll-up separately; no migration; cache v209) — 2026-09-15, confirmed against production
- **PROP-036 BOM Tree Editable Structure** (depth-based permission guards replaced with named booleans — the v202 root cause; Dynamic BOMs now accept sub-tree edits with a shared-edit warning naming affected assemblies; `bom_edges.sort_order` + `↑`/`↓` reordering; edge-scoped `⇄` Move with server-side destination rules; `removeBomEdge` re-keyed on `edge_id`; 3 new API actions; migration 0025; cache v203) + **same-day re-add fix** (bom_edges_unconditional_unique covered closed rows, so removing a child and re-adding it the same day collided with the edge just removed; index rebuilt on active unconditional edges only; migration 0026; reorder controls shown on every tree row from v204 — they were gated on sibCount > 1 and so invisible on single-child assemblies) — 2026-09-15; reordering and Move both confirmed against production (3 moves verified in bom_edges + history; 0 duplicate active pairs, 0 NULL sort_order)
- **Bug fix — BOM tree delete unlinks instead of destroying** (tree `×` on a direct child of an assembly called `deleteComponent` and wiped the component from the registry; handler now branches on `parentNode` not `depth`, since the tree seeds the root's children at depth 0; registry delete stays on the card-header `×`) + **Cache-bust doc correction** (`?v=N` lives in index.html, not assets/config.js — CLAUDE.md and /ship command corrected; supplier.html v105 / reset.html + verify.html v72 synced to v201) — cache v202 — 2026-09-14
- **PROP-035 Component Variant Groups** (component_variant_groups + component_variant_members tables; 6 API actions: createVariantGroup, listVariantGroups, deleteVariantGroup, addVariantMember, removeVariantMember, listComponentVariants; sibling chip navigation in Overview tab; migration 0024; cache v199) + **Inline name editor** (name/part_number/oem_number editable in Overview tab without delete-and-recreate; cache v200) — 2026-09-13
- **PROP-034 Manufacturer vs Supplier** (manufacturer_name + manufacturer_part_number columns on component_metadata; Procurement section shows 4 fields in 2×2 grid; OEM number label consistent with Create modal; UUID header replaced with name + part number; migration 0023; cache v196–v198) — 2026-09-13
- **PROP-033 Stocked Assembly Variants** (materialiseConfiguration + listVariantsByFamily; source_family_id + source_config_id columns on bom_components; bom_edges partial unique index; "Stock" button on saved configs; Stocked Variants section in Dynamic BOM panel; stale-source callout on materialised components; migration 0022; cache v195) — 2026-09-13
- **PROP-032 make_or_buy — Sourcing Classification** (purchased/manufactured/assembled/subcontracted column on bom_components; color-coded badge on BOM list rows; inline editor in Overview tab; migration 0021; cache v192) — 2026-09-13
- **PROP-031 Rich Part Data Record — Structured Component Metadata** (component_metadata table, 28 columns, 5 sections; 9-tab component detail panel; version-snapshotted via bumpComponentVersion; getComponentMetadata + upsertComponentMetadata API actions; migration 0020; cache v191) — 2026-09-13
- **Fix — deleteComponent FK cleanup** (work_order_components, component_routing_steps, product_family_members deleted before final component delete; prevents FK violations from PROP-030 tables) — 2026-09-13
- **Fix — type-only tab routing in groupFiltered()** (sub_assembly → Assemblies tab exclusively; part → Parts tab; has_children no longer drives tab placement; cache v192) — 2026-09-13
- **PROP-030 Manufacturing BOM — Postponement Routing & Work Orders** (product_families + product_family_members tables; 8 product family API actions; component detail panel family tagging with multi-family chips; Manufacturing Steps loads from listFamilyMembers; work order creation from product_family_members pull list; migrations 0017+0018+0019; cache v190) — 2026-09-02
- **Fix — Parts tab catalog-only; +child removed; sub_assembly always in Assemblies tab** (+child gated on allowExpand so Parts tab has no structural actions; sub_assembly type routes to Assemblies tab regardless of has_children; cache v183) — 2026-09-01
- **Fix — Parts tab tree-state restore guard** (allowExpand guard added to expandedTrees restore block in renderRootRow; cached Assemblies-tab expansion no longer leaks into Parts tab on re-render; cache v182) — 2026-09-01
- **Fix — Parts tab always flat catalog; no BOM trees** (renderRootRow gains allowExpand param; Parts tab suppresses expand regardless of has_children; cache v181) — 2026-09-01
- **PLM dual-view — Parts = master catalog; Assemblies = has_children** (every component in Parts tab; Assemblies auto-populates from has_children; +child on all rows; type is classification metadata only; cache v180) — 2026-09-01
- **Fix — Parts tab flat rows only** (expand arrow gated on sub_assembly/product_family type to prevent parts with children expanding in Parts tab; cache v179) — 2026-09-01
- **Fix — unlimited depth in Assemblies BOM tree** (every tree row gets +child and +sib regardless of type; type controls tab placement only; cache v178) — 2026-09-01
- **PROP-029 — Simplified type system: part / sub_assembly / finished_good** (raw_material, spare_part, product_family removed from type pickers; finished_good is a leaf node in Parts tab; +sib label restored; cache v177) — 2026-09-01
- **PROP-028 BOM Tree Terminology Consistency** (Parts tab, Part column header, +part button; three string changes; no DB/API changes; cache v176) — 2026-09-01
- **Revert — restore exclusive tab routing** (v174 dual-tab logic was wrong; sub_assembly/finished_good belong in Assemblies only; Components tab shows isolated parts only; cache v175) — 2026-08-31
- **Fix — assembly types visible in both Components and Assemblies tabs** (sub_assembly and finished_good now appear in flat Components list AND in Assemblies BOM tree; groupFiltered() pushes to both; no migration; cache v174) — 2026-08-31
- **Fix — duplicate root row in BOM tree expansion** (renderBomTree buildRows() walk starts from root's children, not the root itself; parentNode set to root so +sib on depth-0 nodes targets the parent assembly; cache v173) — 2026-08-31
- **Fix — +child/+sib restricted to assembly types; type-only tab routing** (part/raw_material/spare_part are leaf nodes — no +child or +sib anywhere; sub_assembly/finished_good always route to Assemblies tab; has_children no longer drives tab placement; v170–v172) — 2026-08-31
- **Inline type editor in component detail panel** (Type dropdown + Save button in detail panel; calls updateComponent; panel refreshes on save; no new API action; cache v169) — 2026-08-31
- **Bug fix — deleteComponent blocked by component_images FK** (deleteComponent now fetches all component_images rows, removes storage objects, then deletes DB rows before the component; no migration) — 2026-08-31
- **Multi-image lightbox in BOM list row thumbnails** (async fetch of listComponentImages on thumbnail click; same ‹ › nav, keyboard, counter as detail panel; fallback to single image on error; cache v168) — 2026-08-31
- **Multi-image lightbox navigation in component gallery** (‹ › buttons + ← → keyboard; image counter "N / total"; openLightbox now takes images[] + startIndex; cache v167) — 2026-08-31
- **Fix — input fields match button height everywhere** (base `.up-text` CSS rule: min-height:44px, box-sizing:border-box; fixes 9 input+button rows; focus ring added; cache v166) — 2026-08-31
- **PROP-027 Shared Component Awareness** (listParentCounts action; refreshTree re-fetches expanded BOM trees after structural change; ↗ N badge on shared components; link-existing warning; cache v165) — 2026-08-31
- **Click BOM list thumbnail to open full lightbox** (same overlay as detail panel; click-to-dismiss; cache v164) — 2026-08-31
- **Bug fix — BOM thumbnail hover tooltip invisible** (`position:fixed` trapped by transformed ancestor; moved tooltip to `document.body` with stable id; z-index 9999; cache v163) — 2026-08-31
- **Inline photo thumbnails on BOM Node list rows** (`listComponentThumbnails` action; 36×36 thumbnail per row + 200×200 hover preview tooltip; viewport-aware positioning; cache v162) — 2026-08-31
- **Photos in New BOM Node modal** (same paste/drop/pick as detail panel; images queued locally then uploaded after component ID returned; cache v161) — 2026-08-31
- **Bug fix — BOM Node tree arrows cannot collapse** (`display !== ""` treated default-display as "not open"; fixed to `display !== "none"`; cache v160) — 2026-08-31
- **PROP-026 Component Images — Paste, Drop, or Pick from Disk** (component_images table; imageUploadUrl/addComponentImage/listComponentImages/deleteComponentImage; drop zone + paste handler + thumbnail grid with lightbox; cache v159) — 2026-08-30
- **PROP-025 Structural BOM tab classification + meaningful type values** (has_children drives tab routing; type values renamed to manufacturing categories: part/raw_material/sub_assembly/finished_good/spare_part; migration 0015; cache v158) — 2026-08-30
- **Bug fix — BOM tab classification uses type only** (`|| c.has_children` in `groupFiltered()` caused any Component-typed node that gained a child to be reclassified as an Assembly root; fixed to use `type` exclusively for tab placement; cache v157) — 2026-08-30
- **Bug fix — "Can't find variable: role" complete fix** (`renderBomTree` is also a peer function lacking `role`; added as 8th param and updated its call site; all three peer functions — `bomTreeView`, `renderBomTree`, `openComponentDetail` — now receive `role` explicitly from `renderProduct`; cache v155) — 2026-08-30
- **Bug fix — "Can't find variable: role" correct fix** (`openComponentDetail` is a peer function of `bomTreeView`, not nested — added `role` as explicit 5th param and updated all 7 call sites; v154 supersedes the incorrect v153 attempt) — 2026-08-30
- **Bug fix — "Can't find variable: role" incorrect attempt** (v153 added role to `bomTreeView` param but `openComponentDetail` is not nested inside it so it had no effect) (`role` not passed into `bomTreeView`; `renderProduct(role)` called `bomTreeView(token)` without it; fixed by adding `role` as second param; cache v153) — 2026-08-30
- **Bug fix — Component detail tables only showing first row** (all 5 tables in the component detail panel — Versions, Documents, Materials, Used In, Change Log — were silently showing only their first row; root cause: `el("tbody", {}, ...rows)` spread rows as positional args but `el(tag, attrs, kids)` only reads the 3rd param; fix: remove spread so arrays pass directly; cache v152) — 2026-08-30
- **Bug fix — Version history after bump** (explicit is_current retire in bumpComponentVersion application code; panel refresh awaits + passes nodeData; cache v151) — 2026-08-30
- **PROP-023 Component Lifecycle Status — Rebuild** (4 operational states: active/inactive/replaced/flagged; migration 0013 migrates all existing rows; replacement_note + flag_reason columns; inline status editor in component detail panel; cache v150) — 2026-08-30
- **PROP-022 BOM List Performance & Search** (lazy tree expansion, `has_children` from single edge query, search + 50-item pagination; cache v149) — 2026-08-30
- **PROP-021 Component Document Lifecycle — Layer 1** (direct upload & link from component detail panel via new `uploadAndLinkComponentDocument` action; two-tab modal replaces single-flow link modal; cache v148) — 2026-08-29
- **PROP-020 BOM List Split by Type** (Components / Assemblies / Dynamic BOMs tabs in BOM Tree view; delete button label "Delete Permanently"; cache v143) — 2026-08-29
- **PROP-019 COGS Layer Removal** (5 tables, 10 API actions, Cost Canvas subtab removed; BOM tree kept for compliance tracing; cache v141) — 2026-08-29
- **PROP-017 BOM Tree UX Polish** (always-show QTY, Expand All / Collapse All, sticky header, compact action labels) — 2026-08-29
- **PROP-016 BOM Tree — Add Sibling shortcut button** (`+sib` on every non-root row opens add-child modal with parent context) — 2026-08-29
- **PROP-015 Configure-to-Order Variant BOM** (product_family node type, variant_condition on bom_edges, family_attributes/values, saved_configurations, resolveVariant BFS filter, ⚙ Configure modal, condition picker in + child modal) — 2026-08-28
- **PROP-013 Product Information System — Vertical Integration Engine** (BOM tree, REACH/RoHS at component level, COGS simulation, Cost Canvas, Status Overview, full field-level audit trail with `bom_component_history`) — 2026-08-25 → 2026-08-27
- **Level 1 — Versioning & provenance** (immutable document/standard versions, audit trail, AI-assisted drafting, deviation scan) — live 2026-07-07
- **Level 2 — Clauses / Interpretations / Matrix / Passports** (PROP-001) — 2026-07-05
- **EU Directive Analyser (CELLAR)** — live 2026-07-07
- **Classification — Compliance Status dimension (Lifecycle × Scope)** — live 2026-07-07
- **Compliance Status board (Compliance Map)** — live 2026-07-07
- PROP-001 Level 2 Frontend UI ("Clauses & DPP" tab) — 2026-07-05
- PROP-006 AI-Suggested Compliance Status — by 2026-07-07
- PROP-008 Version control for interpretations (diff view) — by 2026-07-07
- PROP-011 Requirement Threads (requirement_links + document_statements) — 2026-07-08
