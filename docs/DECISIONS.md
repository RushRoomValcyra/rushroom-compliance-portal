# Rushroom — Architectural Decisions Log
_Append-only. Claude Code appends one entry here after every /ship._

---
**Date:** 2026-07-10
**Feature:** Dev system setup
**Decision:** Converted schema.sql to 6 numbered migration files in supabase/migrations/. Seeds moved to supabase/seed.sql. organization_id backfill removed from migration path — SET NOT NULL works because tables are empty at migration time, seeds insert with organization_id supplied directly.
**Why:** Fresh databases (new customers, local dev, CI) must apply migrations then seeds in order. Embedding seeds in migrations would insert dev data into customer databases on supabase db push.
**Files changed:** supabase/migrations/0001–0006, supabase/seed.sql, supabase/schema.sql

---
**Date:** 2026-07-10
**Feature:** Migration workflow verification
**Decision:** supabase db push --local confirmed working. All 6 migration files (0001–0006) apply cleanly to a fresh database. supabase db diff --local returns "No schema changes found" — local DB matches migrations exactly. All 25 tables present and correct.
**Why:** Needed to verify the documented workflow was proven, not just correct on paper. Local Docker + Supabase CLI used as test environment before touching production.
**Files changed:** none — verification only

---
**Date:** 2026-07-10
**Feature:** Production migration verification
**Decision:** Ran supabase migration repair --status applied 0001–0006 to register existing production schema under migration tracking. supabase db diff returns "No schema changes found" against production. NOTICE about trg_forbid_org_change is expected — trigger not yet applied (ships with PROP-012).
**Why:** Production DB was built via SQL Editor before migrations existed. Repair registers history without re-running SQL against live data.
**Files changed:** none — remote state change only

---
**Date:** 2026-07-10
**Feature:** Production migration verification — correction
**Decision:** Verified trg_forbid_org_change IS present on all 16 tenant tables in production (pg_trigger query returned all 16). Correcting the prior entry: the trigger is NOT pending — it shipped with PROP-012 Stage 5a (live 2026-07-09). The "NOTICE … trigger does not exist, skipping" seen during supabase db diff was the benign DROP TRIGGER IF EXISTS in migration 0006 firing against the throwaway shadow DB, not a signal about production. "No schema changes found" already implied prod matches the migrations (trigger included).
**Why:** Keep the append-only log accurate — the prior entry could leave the impression tenant-move protection is missing from prod, when it is in fact enforced on all 16 tenant tables.
**Files changed:** none — verification only

---
**Date:** 2026-08-25
**Feature:** PROP-013 — Product Information System (Vertical Integration Engine)
**Decision:** BOM display uses BFS in TypeScript (max_depth cap of 10); COGS rollup uses a server-side PostgreSQL recursive CTE via `db.rpc("compute_bom_cogs")`. The two are deliberately separate: BFS keeps the tree-render fast and depth-bounded; the SQL CTE handles multi-level cost aggregation with scenario overrides and landed-cost multipliers in one query. Cycle detection is a Postgres BEFORE INSERT trigger (not application code), so it fires regardless of how edges are inserted. Cost/pricing actions are gated by a `COST_ACTIONS` set that 403s supplier sessions before any data is read — no per-action role check needed. The `external_ref` field on `component_costs` is reserved as an ERP sync anchor for the future bought-platform financial thread.
**Why:** A single BFS-or-CTE approach would either be slow (deep recursive BFS per page load) or fragile (client-side cost rollup diverges from server truth under concurrency). Separating display and calculation keeps both correct. Trigger-based cycle detection avoids race conditions that application-level checks would miss under concurrent inserts.
**Files changed:** supabase/migrations/0007_product_information_system.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html

---
**Date:** 2026-08-25
**Feature:** BOM Tree UX redesign + API.post() generic escape hatch
**Decision:** Added `API.post(token, action, body)` as a thin generic wrapper on the private `call()` function inside `api.js`, rather than registering 22 named methods. BOM Tree now auto-loads via a new `listComponents` action that returns all components plus `root_ids` (components with no active parent edge), eliminating the UUID-paste flow. Tree renders client-side from a parallel `getBom` fetch per root, with ▶/▼ toggle, COGS heat-map border colours, and 2-level default expansion.
**Why:** Named methods on the API object would require 22 additions to `api.js` for every new action group; a generic escape hatch keeps `api.js` stable while new action groups are prototyped. The UUID-paste UX was a prototyping shortcut — auto-detecting roots server-side (edges table query) is a single cheap query and avoids burdening the user with internal IDs. Parallel `getBom` fetches per root keep each tree self-contained and independently expandable.
**Files changed:** assets/api.js, assets/app.js, supabase/functions/portal-api/index.ts, index.html

---
**Date:** 2026-08-26
**Feature:** BOM Tree — flat DFS renderer with position numbers and ASCII connectors
**Decision:** Replaced the nested-div recursive renderer with a flat DFS walk that builds a plain array of row objects, each carrying a hierarchical position number (root = "1", children = "1.1"/"1.2", grandchildren = "1.1.1"/"1.1.2"…) and an `ancestorLastFlags` array for connector computation. Rows render as a CSS-grid table (columns: Position | Component | Qty | Status | COGS% | Actions). Collapse/expand is a `Set` of collapsed posNums; hidden rows are filtered by prefix match. ASCII connectors (├─ / └─ / │ / spaces) are computed from `ancestorLastFlags` using a fixed 3-char-per-depth prefix, displayed in a `white-space:pre` monospace span.
**Why:** The previous nested-div approach caused uncontrolled horizontal overflow at depth ≥3 and had no position numbering. A flat array + grid layout renders identically at any depth (10, 20, 50 levels) without any overflow, because indentation is expressed as a text prefix inside a fixed grid column rather than actual DOM nesting. Position numbers let users unambiguously refer to nodes by number rather than name.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md

---
**Date:** 2026-08-26
**Feature:** "+ New Product/Component" modal — mode picker + document upload + AI autofill
**Decision:** Replaced the bare `openAddComponent` form with a modal that mirrors the Standards & Regulations "Add standard" flow: optional drag-and-drop upload zone, AI reads the file via a new `suggestComponentMetadata` action (Claude with JSON-schema output; `COMPONENT_META_SCHEMA`) and fills part_number/name/type/unit_of_measure/description automatically. A mode toggle ("Parent — Product/Assembly" vs "Child — Component/Part") pre-sets the type field accordingly. Document upload is optional; users can skip it and fill fields manually. After `addComponent` creates the DB row, the uploaded file remains in the documents bucket and can be linked via the Details panel later.
**Why:** The bare form required the user to know all field values in advance. Uploading a datasheet and having the AI suggest the name/part-number is the same workflow already in use for standards, so reusing the uploadZone + AI-read pattern keeps the UX consistent and avoids a separate manual step. The mode picker makes the Parent/Child distinction explicit at creation time, since `type` (finished_good vs purchased_part) determines BOM tree role without a separate flag.
**Files changed:** assets/app.js, supabase/functions/portal-api/index.ts, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html

---
**Date:** 2026-08-26
**Feature:** BOM component delete — hard delete for admin use
**Decision:** `deleteComponent` action hard-deletes in dependency order: nulls product_passport FK → deletes scenario overrides → scenarios → COGS snapshots → component_documents links → costs → landed factors → materials → versions → all BOM edges (both parent and child directions) → component row. Children of the deleted node become top-level roots; their own sub-trees are untouched. The frontend Delete button shows a context-aware confirm dialog ("has N children → will become roots") before calling the action. No soft-delete / versioning applied at this stage as requested.
**Why:** Admin cleanup needed before the system has real data. Soft-delete would require filtering "deleted" rows everywhere and adds complexity before the data model is stable. Hard delete is simpler and reversible only via DB backup at this stage.
**Files changed:** assets/app.js, supabase/functions/portal-api/index.ts, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html

---
**Date:** 2026-08-26
**Feature:** BOM component model — OEM number, new type enum, auto-generated part numbers, UOM removed
**Decision:** Added `oem_number` column to `bom_components` (migration 0008). Type enum changed from `raw_material/purchased_part/sub_assembly/finished_good` → `Product/Component/SparePart/Refurb` — existing rows migrated. `unit_of_measure` made nullable and removed from the UI (column kept in DB for historical data). Part numbers are pre-generated client-side as `RR-YYYYMM-XXXXXXXX` (8 random chars from a 32-char unambiguous set) and can be overridden by the user or by the AI document scan; the server also generates one if the field arrives empty. `suggestComponentMetadata` now extracts `oem_number` from datasheets alongside the part number.
**Why:** OEM numbers are distinct from internal part numbers (a supplier's order code vs Rushroom's catalogue ID). Type labels needed to reflect Rushroom's actual product taxonomy rather than a generic BOM vocabulary. UOM has no practical use in this compliance context. Auto-generated part numbers remove a manual step while keeping the field editable — the format encodes creation date for rough chronological ordering.
**Files changed:** supabase/migrations/0008_bom_type_oem.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html

---
**Date:** 2026-08-27
**Feature:** PROP-013 amendment — full compliance audit trail for bom_components
**Decision:** Added `bom_component_history` table (migration 0009) with two Postgres triggers: AFTER INSERT writes the initial creation snapshot; AFTER UPDATE fires only when tracked fields actually changed (WHEN clause on `IS DISTINCT FROM` for part_number, oem_number, name, description, type, lifecycle_status, notes). Each row stores the NEW (post-change) state — i.e. "from this timestamp, the component looked like this." The `component_id` column has no FK deliberately so history rows persist even after a component is hard-deleted; this is the regulatory evidence store. The `updateComponent` action now accepts type and part_number changes (both feed the trigger). The component detail panel fetches history via `getComponentChangelog` in a parallel Promise.all and renders field-level diffs (before → after) for every event, newest first.
**Why:** Regulatory compliance for a product that ships into the EU requires an immutable chain of evidence showing what the component looked like at every point in time — especially OEM number, part number, and type, which can change when a supplier revises their product. Trigger-based capture is the correct approach: it fires regardless of which code path mutates the row (API, future admin tools, migrations), whereas application-layer logging would silently miss out-of-band changes. Each history row answers "what did this component look like from changed_at onward?" making point-in-time reconstruction straightforward for auditors.
**Files changed:** supabase/migrations/0009_bom_component_history.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md

---
**Date:** 2026-08-27
**Feature:** PROP-013 amendment — extend audit trail to revision bumps and document links
**Decision:** `bumpComponentVersion` and `addComponentDocument` never touch `bom_components`, so the AFTER UPDATE trigger never fires for them. Fixed by having both actions explicitly insert a row into `bom_component_history` after their primary write, using two new `change_type` values: `version_bumped` (notes = "Revision X: summary") and `document_linked` (notes = "Document linked: label (category)"). Migration 0010 widens the CHECK constraint on `change_type` to allow these values. The frontend Change Log renderer now handles all four event types with distinct coloured badges (green = created, blue = updated, purple = revision, amber = document) and shows the `notes` field as the change description for non-field events.
**Why:** Users expected every revision and every document attachment to appear in the change log — that is the complete audit story. The AFTER UPDATE trigger approach works only for `bom_components` field mutations; side-table events (versions, documents) require explicit application-layer writes. This is the correct split: DB triggers for field changes (catches all paths including future admin tools), application writes for associated-table events (where the semantic meaning of "what changed" must be constructed, not just captured).
**Files changed:** supabase/migrations/0010_bom_history_revision_docs.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md

---
**Date:** 2026-08-28
**Feature:** PROP-013 amendment — unified Change Log from three canonical sources
**Decision:** `getComponentChangelog` was rewritten to merge three sources in a single Promise.all: (1) `bom_component_history` filtered to `created`/`updated` only — field-level trigger snapshots; (2) `bom_component_versions` — every revision ever bumped, including those that predate the audit trail; (3) `component_documents` — every document ever linked. All three are normalised to a common shape `{changed_at, changed_by, change_type, notes, …snapshot fields}` and sorted DESC by timestamp. The `bom_component_history` writes from `bumpComponentVersion` and `addComponentDocument` (added in 0010) are kept as a belt-and-suspenders raw audit store but are now superseded by canonical table reads in the API response.
**Why:** The trigger-only approach silently excluded history predating the trigger installation. A compliance audit trail must be complete regardless of when the system was instrumented — reading the canonical source tables (`bom_component_versions`, `component_documents`) guarantees no revision or document is ever missing from the log.
**Files changed:** supabase/functions/portal-api/index.ts, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-28
**Feature:** PROP-013 amendment — auto-incrementing revision numbering (A→B→…→Z→AA→AB…)
**Decision:** `bumpComponentVersion` no longer accepts a `revision` input. The server queries existing revisions for the component, finds the highest by a base-26 rank function (A=1, B=2, …, Z=26, AA=27, AB=28…), and computes the next one. The frontend shows a read-only "Next: X" preview badge computed with the same algorithm from the already-fetched version list; the server result is authoritative (the UNIQUE constraint on `(component_id, revision)` prevents races). The frontend bump form now only has a "What changed" summary field.
**Why:** Requiring the user to type the next revision letter was error-prone (skipping letters, reusing letters, wrong case). The revision sequence is mechanical and should be automatic. The server-side computation ensures correctness even if two sessions try to bump simultaneously — one succeeds, one gets a constraint error.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-28
**Feature:** PROP-013 amendment — guarantee Revision A in Change Log + unified canonical reads
**Decision:** Two changes shipped together. (1) `addComponent` now writes an explicit `version_bumped` history row for Revision A immediately after the initial version insert, so the component creation moment always appears in the Change Log even if `bom_component_history`'s INSERT trigger fired separately. (2) `getComponentChangelog` rewritten to merge three canonical sources in a single `Promise.all`: `bom_component_history` (field snapshots, created/updated only), `bom_component_versions` (all revisions ever), `component_documents` (all linked docs ever) — sorted by timestamp DESC. The canonical-table reads guarantee completeness regardless of when triggers were installed.
**Why:** Components created before migration 0009 (the audit trail migration) had no `bom_component_history` rows for their Revision A because the INSERT trigger wasn't yet live. Reading from `bom_component_versions` directly (the canonical revision source) ensures all revisions appear in the Change Log even for pre-trigger components. The belt-and-suspenders explicit write in `addComponent` closes any remaining gap for new components if the history insert were somehow slow or retried.
**Files changed:** supabase/functions/portal-api/index.ts, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-28
**Feature:** PROP-013 amendment — BOM unlimited depth via inline child creation
**Decision:** `openAddChildModal` (the `+ child` per-row button in the BOM tree) was rewritten with two tabs: "Link existing" (prior behavior — pick from the org's component list) and "Create new" (name + type + auto-generated part number; on submit, calls `addComponent` then `addBomEdge` in sequence). No new API actions; the existing `addComponent` + `addBomEdge` calls are composed client-side.
**Why:** The original modal only let you link already-existing components. To create a grandchild (1.1.1), users had to (1) create the component via the toolbar — which lands as a root — and then (2) locate it in a separate `+ child` modal. This two-step flow was non-obvious and felt like a depth limitation even though the backend supported unlimited depth. The inline "Create new" tab removes the intermediate step: click `+ child` on any node at any depth, pick "Create new", enter a name, and the component is created and linked in one round-trip pair.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-28
**Feature:** PROP-013 amendment — parent picker in "New Component" modal for Child mode
**Decision:** When "Child — Component / Part" is selected in the "+ New Product/Component" toolbar modal, a searchable parent picker appears and is required before submission. The picker lazy-loads the component list via `listComponents` on first tab switch; on submit, `addComponent` is called first, then `addBomEdge(selectedParentId, newId, qty=1)`. No new API actions.
**Why:** Previously, "Child" mode only changed the default type field — the new component still landed as an orphan root, requiring the user to separately find it in a `+ child` modal and link it. This was confusing: selecting "Child" strongly implies the component will be attached to something. Making parent selection mandatory in this flow closes the gap and matches user expectation.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-28
**Feature:** PROP-013 amendment — enforce BOM creation rules in UI
**Decision:** Removed the mode toggle ("Parent" / "Child") and parent picker from the `openAddComponent` toolbar modal. The toolbar button is now "+ New Product", the modal title is "New Product / Assembly", and a hint makes the rule explicit: top-level products/assemblies only. Child creation is exclusively via the `+ child` row button on any BOM tree node. No API changes; this is a frontend UX constraint only.
**Why:** Having two entry points for child creation (toolbar Child mode + per-row `+ child` button) caused confusion about where orphan components came from. The per-row `+ child` button already supports unlimited depth via the "Create new" tab added in the prior commit; making the toolbar button parents-only removes ambiguity and matches the mental model (toolbar = new top-level thing, row button = attach a subordinate).
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html

---
**Date:** 2026-08-28
**Feature:** PROP-013 amendment — close detail panel on empty BOM tree
**Decision:** `refreshTree` now hides and empties the component detail panel before returning early in both empty-state branches (no components at all, and no root_ids). The empty-state notice text was also corrected to reference "+ New Product" (matching the renamed toolbar button).
**Why:** After deleting the last component, the tree area showed "No components yet" but the previously-selected component's detail panel — history log, fields, actions — remained visible alongside it. This was visually inconsistent and could mislead a user into thinking data still existed.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html

---
**Date:** 2026-08-28
**Feature:** PROP-015 — Configure-to-Order Variant BOM (Product Families)
**Decision:** Introduced a "Super BOM" model: one BOM tree per product family rather than thousands of duplicate trees per SKU. The key mechanism is a `variant_condition JSONB` column on `bom_edges` — `NULL` means always included; `{"Power":"50W"}` means the edge is active only when Power=50W is selected. A `resolveVariant` BFS walks the tree filtering edges by condition match against a `selections` object. Configuration space is defined via `family_attributes` + `family_attribute_values` tables; named resolved configurations (SKUs) are stored in `saved_configurations`. A new `product_family` node type was added to the existing CHECK constraint on `bom_components.type`.
**Why:** Alternatives considered: (1) separate BOM tree per SKU — O(N×depth) storage, every shared-component change requires updating all trees; (2) module composition (sub-assemblies per variant) — still requires separate trees and loses the "one view of the full family" benefit. The Super BOM approach stores each component once; a change to a shared node propagates to every configuration automatically. Backward compatibility is fully preserved: existing `Product`-type roots have `variant_condition = NULL` on all their edges and are unaffected by the resolver logic.
**Files changed:** supabase/migrations/0011_variant_bom.sql (new), supabase/functions/portal-api/index.ts (TENANT_TABLES, addComponent/updateComponent type lists, getBom edge select, addBomEdge, deleteComponent cleanup, 9 new action handlers), assets/app.js (product_family TYPE_OPTS, renderBomTree edge condition tag + FAMILY badge, openAddChildModal condition picker, openComponentDetail family config section, new openConfigureModal), index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** PROP-015 bugfix — type dropdown showed only first option
**Decision:** `el(tag, attrs, kids)` takes a single third parameter; spreading an array with `...` into it silently discards all elements after the first. Both `openAddComponent` and `openAddChildModal` called `el("select", …, ...TYPE_OPTS.map(…))`, so the type dropdown only ever rendered "Product". Fixed by passing the mapped array directly (without spread).
**Why:** The `el()` helper uses `[].concat(kids)` internally to flatten arrays, so an array argument is correct — the spread was unnecessary and destructive.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** Edge function — CORS-safe error handling + null-guard inserts
**Decision:** Wrapped the entire `Deno.serve` handler body in a top-level try-catch that returns `json({ error: err.message }, 500)` — a CORS-compliant response — instead of letting Deno catch it and emit a raw 500 without CORS headers. Also null-guarded the two `maybeSingle()` inserts in `addComponent` (comp and ver): if either returns null with no error, the function now returns a 400 with a diagnostic message rather than throwing a `TypeError` on `.id`.
**Why:** Any unhandled exception in an action handler was producing a Deno-level 500 without `Access-Control-Allow-Origin`. Safari reports this as "Load failed"; Chrome as "Failed to fetch". The modal stayed open even though the DB write had already succeeded — the user saw an error but the component was silently created in the background. The outer try-catch ensures ALL future errors surface as readable JSON in the modal.
**Files changed:** supabase/functions/portal-api/index.ts, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** BOM toolbar — rename labels to "+ New BOM Node" / "Create BOM Node"
**Decision:** Toolbar button renamed from "+ New Product" to "+ New BOM Node"; modal title to "New BOM Node"; submit button to "Create BOM Node"; empty-state hint updated to match. Cache bumped v125→v127.
**Why:** The original labels implied only products could be created at the root level, but the toolbar now supports Product, Component, SparePart, Refurb, and Product Family types.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** Edge function — fix .catch() on tdb insert
**Decision:** The non-fatal `bom_component_history` write in `addComponent` used `.catch()` chained directly on `tdb().insert()`. Supabase query builders are thenable but not full Promises — they have no `.catch()` method, so this threw "is not a function" at runtime. Replaced with a `try { await ... } catch {}` block.
**Why:** Only became visible once the outer try-catch (previous commit) started surfacing errors as readable JSON instead of raw Deno 500s.
**Files changed:** supabase/functions/portal-api/index.ts, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** Move Product tab into As Operated as "Product BOM" subtab
**Decision:** Removed the top-level Product tab and panel from `index.html`. Added a "Product BOM" subtab inside As Operated, rendered lazily via the existing `renderProduct()` function, positioned between "Labels and Instructions" and "Supplier uploads". Cache bumped v127→v128.
**Why:** The BOM is part of the as-operated product record, not a standalone section. Placing it inside As Operated keeps the top-level nav lean and groups product-related information in one place.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** PROP-016 — BOM Tree sibling shortcut button
**Decision:** Added a `+sib` button to every non-root BOM row that opens `openAddChildModal` with the row's `parentNode` as the target, allowing the user to add a peer node without scrolling back to the parent. The `parentNode` reference is threaded through `walk()` via a new seventh parameter and stored on each row in `buildRows()`.
**Why:** Without the shortcut users had to scroll up to the parent row and click `+child` there — a high-friction workflow when building out multi-level trees. The sibling button eliminates that friction by passing the parent context down to the child row.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-29
**Feature:** PROP-017 — BOM Tree UX Polish (always-show QTY, Expand All / Collapse All, sticky header, compact action labels)
**Decision:** Four targeted changes to `renderBomTree`: (1) QTY cell now always renders `×N` (was hidden when N=1). (2) "Expand all" and "Collapse all" buttons added above the column header inside `render()`, sharing the `collapsed` Set and `buildRows()` closure directly. (3) Column header div gets `position:sticky;top:0;z-index:1` so it stays visible while scrolling a long tree. (4) Action button labels compacted to `⚙`, `+sib`, `+child`, `Detail`, `Del` with `title` tooltip attributes, saving horizontal space. Cache bumped v129→v130.
**Why:** The previous UI was ambiguous (a missing QTY could mean "not set" or "= 1"), scroll-heavy (no way to expand/collapse the whole tree at once), and the action buttons were wide enough to push the tree off-screen on narrow viewports. No new data model, API, or DB changes — purely presentation.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** BOM tree grid alignment fix + component cell redesign
**Decision:** Root cause of column misalignment: the actions column was `auto`-width, so rows with 3 buttons (root) vs 5 buttons (family non-root) resolved `1fr` differently, shifting every other column. Fixed by setting actions column to `12rem` in both header and row grid templates. Also: component cell redesigned — bold name is now on the first line with badges; part number drops to a second line in tiny monospace (previously the part number pushed the name right, making it hard to scan). COGS cells now show `—` instead of blank when no cost data. Rows highlight subtly on `mouseenter`. Cache bumped v130→v131.
**Why:** The `auto` column bug existed since the action button set was made conditional (sibling/configure buttons added in PROP-016/015). Each row is an independent CSS grid; `auto` resolves differently per row when content differs, so `1fr` is not the same width across rows — hence visual misalignment. Fixed-width column is the correct solution.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** BOM tree column centering — QTY, Status, COGS
**Decision:** Header labels for QTY, Status, COGS columns now use `text-align:center` (applied by index in the map, indices 2–4). Data cells: QTY span uses `display:block;text-align:center`; Status badge wrapped in `display:flex;justify-content:center` div; COGS value wrapped in `display:flex;justify-content:center` div. Cache bumped v131→v132.
**Why:** The values were left-aligned within their narrow fixed-width columns, making them hard to read at a glance — centering aligns them under their headers and reduces visual noise.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** BOM tree — propagate effective quantity down child paths
**Decision:** `walk()` now passes `qty * e.quantity` to children instead of `e.quantity`. This makes every displayed QTY the effective quantity from root to that node (e.g. if 1.1 is ×2 and 1.1.1 is ×3 per unit of 1.1, then 1.1.1 shows ×6). Cache bumped v132→v133.
**Why:** The previous behaviour showed only the edge quantity — the quantity on the single parent→child edge — which is meaningless to anyone reading the tree top-down. Effective quantity (accumulated product of all ancestor edge quantities) is what a BOM reader actually needs: it tells you how many of that part go into one unit of the root product.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** Rename product_family → "Dynamic BOM" in UI; hide ⚙ Configure button
**Decision:** Renamed the `product_family` type label from "Product Family (CTO)" to "Dynamic BOM" in the type picker, the tree badge from "FAMILY" to "DYNAMIC BOM", and the detail panel heading accordingly. The ⚙ Configure button (which opened the variant-attribute modal from PROP-015) is hidden from the BOM tree row — it will return when the order-import integration (PROP-018) is built. The empty-state hint for saved configurations now references PROP-018 instead of pointing to the Configure button.
**Why:** The PROP-015 configure modal manages abstract variant attributes (Power: 50W, Size: L) — not the actual components in the BOM. Users expected ⚙ to let them pick which components belong to the Dynamic BOM; instead it opened an unrelated attribute system. The term "Dynamic BOM" is already used elsewhere in Rushroom's digital stack (order system, bulk render pipeline) and correctly describes what this node type is. Components are added via `+child` as in any other BOM node — no special button needed.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** Dynamic BOM — restrict add-child UX (link-existing-only + block sub-child modifications)
**Decision:** In a Dynamic BOM tree (root node `type === "product_family"`): (1) `+child` and `+sib` on any node at depth > 0 are hidden — a Dynamic BOM picks existing BOM Nodes including their full sub-trees; you do not add or rearrange children inside those sub-trees from the Dynamic BOM context. (2) `+child` on the Dynamic BOM root (depth 0) passes `linkExistingOnly: true` to `openAddChildModal`, which hides the "Create new" tab — you can only link an existing component. (3) `+sib` on a direct child of the Dynamic BOM root (depth 1) is still visible and also passes `linkExistingOnly: true`. Cache bumped v134→v135.
**Why:** A Dynamic BOM is a pick-list of existing BOM Nodes. Creating new components from within the Dynamic BOM context would scatter master-data creation into an incidental workflow and break the rule that BOM Nodes are the single source of truth for component identity. Sub-tree management belongs on the component itself, not on a Dynamic BOM that happens to include it — otherwise the same component could have different children in different Dynamic BOMs, making compliance tracking impossible.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** BOM Node always-visible + "Used in" detail panel
**Decision:** `listComponents` now returns every component ID in `root_ids` — no longer filtered to only those without parent edges. Every BOM Node is an independent registry entry and always renders as its own standalone tree, regardless of whether it also appears as a child inside another component's tree. New `listParentsOf` API action returns all active bom_edges where the given component is the child, joined with parent component metadata. The component detail panel now shows a "Used in" section with a table of parent assemblies (name, part#, qty, reference designator).
**Why:** Adding a component as a child to another assembly was removing it from the standalone list — a consequence of the `root_ids` filter. Components (BOM Nodes) are the source of truth for compliance tracking; their position in a parent assembly is a relationship, not an identity. A screw used in 12 assemblies must remain visible as its own entry and must show where it is used, so compliance impact of a change can be traced upward. This is the standard "where used" query in PLM/ERP systems.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** Link document to BOM Node from detail panel
**Decision:** Added `openAddDocModal()` inside `openComponentDetail` — a "+ Link document" button in the Documents section heading opens a modal that fetches the document library via the existing `data` action, lets the user pick a version + category + label + supplier-visible flag, and calls `addComponentDocument`. On success, the detail panel refreshes in-place. No new API actions — `addComponentDocument` was already implemented on the backend but had no UI. Cache bumped v146 → v147.
**Why:** Documents need to be added to components after initial creation (test reports arrive later, declarations are issued later). The `data` action already returns all document versions so no new endpoint was needed. Linking (not uploading) is the correct model — files are managed in the As Operated tab, components reference them.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** Detail panel scroll-into-view on open
**Decision:** Added `panel.scrollIntoView({ behavior: "smooth", block: "nearest" })` immediately after `panel.style.display = ""` in `openComponentDetail`. Cache bumped v145 → v146.
**Why:** The detail panel sits below the BOM tree in DOM order. Opening it via double-click left it out of the viewport — users had to scroll manually to see it. `block: "nearest"` scrolls the minimum distance needed to make the panel fully visible without overshooting.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** BOM row UX — × delete button + double-click for detail
**Decision:** Replaced the "Del" text button with a compact red "×" symbol. Removed the "Detail" button entirely; the component detail panel now opens on double-click of any BOM row. Cache bumped v144 → v145.
**Why:** "Del" next to "Detail" created visual noise and risk of misclick. A × is universally understood as delete and takes less space. Double-click for detail is a standard desktop pattern — it keeps the action bar minimal (just +sib, +child, ×) while preserving full detail access without an extra button per row.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** PROP-020 fix — BOM tab grouping by hasChildren, not type field
**Decision:** Changed tab assignment from pure `type`-field matching to: `product_family` → Dynamic BOMs; `edges.length > 0` (has BOM children) OR `type === "Product"` → Assemblies; everything else → Components. Cache bumped v143 → v144.
**Why:** Nodes created before the type conventions were established (e.g., assemblies with `type: Component`) were landing in the wrong tab. A node with BOM children IS an assembly by structure regardless of how it was typed. Checking `edges.length` from the already-fetched tree data costs nothing extra and is structurally correct.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md

---
**Date:** 2026-08-29
**Feature:** PROP-020 — BOM List Split by Type + Delete label
**Decision:** Replaced the flat mixed product list in `bomTreeView` with three client-side tabs keyed on `bom_components.type`: Components (Component / SparePart / Refurb), Assemblies (Product), Dynamic BOMs (product_family). After `+ New BOM Node`, the UI switches to the Components tab (default type). Tab switching re-renders from cached tree data — no extra API calls. Delete confirmation button label changed from "Delete forever" → "Delete Permanently". Cache bumped v142 → v143.
**Why:** The flat list mixed standalone parts, product assemblies, and family templates, making newly created components invisible at the bottom of a long mixed list. Splitting by the explicit `type` field (an already-present user intent signal) groups items predictably without any schema or API changes. Pure frontend — the simplest correct fix.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md, docs/ROADMAP.md, docs/IDEAS.md

---
**Date:** 2026-08-29
**Feature:** PROP-019 — COGS Layer Removal
**Decision:** Removed the entire financial/COGS layer from the compliance portal: 5 DB tables (`component_costs`, `landed_cost_factors`, `cogs_snapshots`, `cost_scenarios`, `scenario_overrides`), 10 API actions (`getComponentCosts`, `upsertLandedCostFactor`, `computeCogs`, `compareCogs`, `createScenario`, `listScenarios`, `applyScenarioOverride`, `getScenarioResult`, `archiveScenario`, COST_ACTIONS gate), the Cost Canvas subtab, and the COGS column from the BOM tree grid.
**Why:** Financial analysis (COGS, cost scenarios, scenario simulation) belongs in ERP and financial tooling — not in a compliance portal. The BOM tree is the shared backbone that compliance, ERP, and the configurator all read from; adding financial logic to the compliance portal duplicated ERP responsibilities in the wrong layer. The BOM tree itself (bom_components, bom_edges, bom_component_versions, component_materials, component_documents, bom_component_history) is kept intact for compliance tracing, REACH/RoHS, and "where used" tracking. Cache bumped v140→v141.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, supabase/migrations/0012_remove_cogs_layer.sql, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md, docs/ROADMAP.md

---
**Date:** 2026-08-29
**Feature:** PROP-021 Layer 1 — Component Document Upload & Link
**Decision:** Added a new `uploadAndLinkComponentDocument` backend action that creates the `documents` row, `document_versions` row, and `component_documents` link in a single round-trip, returning the version ID from Postgres directly (`.select("id").maybeSingle()`) rather than querying back after the fact. Auto-numbers the version label when blank using the existing count-based pattern from `insertDocumentVersion`. The `openAddDocModal` frontend function was refactored into a two-tab modal (Link existing / Upload & link) using nested `renderLinkTab()` / `renderUploadTab()` functions sharing a common `tabBar()` renderer, avoiding code duplication. The "Add document" button label replaces the old "Link document" label since the modal now covers both flows.
**Why:** `addDocument` existed but returned only `{ok, id}` (document ID) — not the `document_version_id` needed to call `addComponentDocument`. Modifying `addDocument` to also return the version ID would have broken any callers relying on that exact shape. A dedicated combined action is cleaner, more atomic, and easier to audit than two separate round-trips.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md, docs/ROADMAP.md

---
**Date:** 2026-08-30
**Feature:** PROP-022 — BOM List Performance & Search
**Decision:** Eliminated the O(N) getBom-per-root pattern by (a) adding `has_children` to `listComponents` via a single `DISTINCT parent_id` query against `bom_edges`, and (b) replacing the full-tree-per-item list with lazy ▶ expand rows. Search is client-side (filter on already-loaded component list) rather than server-side, which avoids a round-trip and is instant for hundreds of items. Pagination is also client-side (slice of in-memory list), since the listComponents payload is small (6 fields × N rows, no tree data).
**Why:** The previous design called getBom for every root component on every page load just to classify tabs — O(N) API calls. For 1000 components this would make the BOM page unusable. The `has_children` flag resolves this in a single indexed query. No DB migration needed.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-30
**Feature:** PROP-023 — Component Lifecycle Status Rebuild
**Decision:** Replaced the 6 engineering-stage values (concept/specified/sourcing/approved/released/obsolete) with 4 operational states (active/inactive/replaced/flagged). Added `replacement_note TEXT` and `flag_reason TEXT` columns rather than a separate junction table — these are 1:1 with the component row and only ever populated for one status value at a time, so a junction table would add join complexity for zero benefit. The backend clears the irrelevant aux field on every status save so stale data never leaks. The status edit block lives in the component detail panel (not the tree row) to avoid cluttering the compact list view.
**Why:** The old 6-stage model described an engineering workflow (concept → release) that doesn't match how Rushroom actually operates the product. The 4-state model maps to observable operational facts: is this component being sold (active), not yet / under review (inactive), retired by something else (replaced), or under investigation (flagged)? Data migration is deterministic: concept/specified/sourcing → inactive (not yet in operation), approved/released → active, obsolete → replaced.
**Files changed:** supabase/migrations/0013_lifecycle_status_rebuild.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-30
**Feature:** Bug fix — Version history disappears after component version bump
**Decision:** Added an explicit application-level UPDATE (`SET is_current = FALSE WHERE component_id = ...`) in `bumpComponentVersion` before inserting the new version row, rather than relying solely on the Postgres trigger `fn_set_current_version`. Also changed the frontend bump form to `await openComponentDetail(componentId, token, panel, nodeData)` — passing `nodeData` and awaiting the refresh so the status section reads the actual component state.
**Why:** The `fn_set_current_version` AFTER INSERT trigger performs the same retire step, but does not fire reliably in Supabase's service-role RLS environment. When it failed silently, all version rows for the component had `is_current = TRUE` simultaneously — but `getComponentHistory` fetches with no `is_current` filter, so all rows should have appeared. The root issue turned out to be that the trigger was not reliably setting old rows to `is_current = FALSE`, leaving old rows invisible to queries that filtered on `is_current`. Doing the retire in application code (which runs as service role and always fires) resolves this. The missing `nodeData` arg caused the PROP-023 status section to always default to "inactive" on panel refresh after a bump.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-30
**Feature:** Bug fix — Component detail tables only showing first row (v152)
**Decision:** Removed the spread operator from all five `el("tbody", {}, ...rows)` calls in `openComponentDetail`, changing them to `el("tbody", {}, rows)`. No other changes.
**Why:** `el(tag, attrs, kids)` takes exactly three positional parameters; the spread operator was passing each row as a separate positional argument beyond the third, so only `rows[0]` was ever rendered. The data in the database was correct throughout — all version, document, material, used-in, and changelog rows existed. This was a pure frontend rendering bug. The v151 backend fix (explicit `is_current` retire) is also correct and harmless, but the missing rows were never a database problem.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-30
**Feature:** Bug fix — "Can't find variable: role" in component detail panel (v153)
**Decision:** Added `role` as a second parameter to `bomTreeView(token, role)` and updated the single call site in `renderProduct` from `bomTreeView(token)` to `bomTreeView(token, role)`. The `openComponentDetail` function (defined inside `bomTreeView`) closes over `role` to gate the status-edit block behind `if (role === "rushroom")`.
**Why:** `renderProduct(role, mount)` received `role` correctly but passed only `token` to `bomTreeView`, so `role` was never in scope for the inner functions. The status edit block added in PROP-023 introduced the first use of `role` inside `bomTreeView`, exposing the missing parameter.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-30
**Feature:** Bug fix — "Can't find variable: role" correct fix (v154)
**Decision:** Added `role` as an explicit 5th parameter to `openComponentDetail(componentId, token, panel, nodeData, role)` and updated all 7 call sites to pass it through. The two external entry points (`ondblclick` handlers inside `bomTreeView`) pass the `role` that `bomTreeView` now receives as its second param; the five internal recursive refresh calls forward `role` from the function's own parameter.
**Why:** `openComponentDetail` is a peer-level function inside the main app closure — the same scope level as `bomTreeView`, `statusOverviewView`, and `renderProduct`. It cannot close over `bomTreeView`'s local variables. The v153 fix incorrectly assumed nesting; this fix threads `role` as a value through the call chain instead, which works regardless of scope structure.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-30
**Feature:** Bug fix — "Can't find variable: role" complete fix (v155)
**Decision:** Added `role` as the 8th parameter to `renderBomTree` and updated its single call site inside `bomTreeView` to pass `role`. Combined with the v154 fix (role as 5th param on `openComponentDetail`), all three peer functions that reference `role` — `bomTreeView`, `renderBomTree`, `openComponentDetail` — now receive it explicitly. The full chain is: `renderProduct(role)` → `bomTreeView(token, role)` → `renderBomTree(..., role)` → `openComponentDetail(..., role)`.
**Why:** All three functions are defined at the same scope level inside the main app closure. None can close over another's local variables. `role` must be threaded explicitly as a parameter through the entire call chain. The PROP-023 status edit block was the first code inside these functions to use `role`, which is why this was never caught before.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, docs/DECISIONS.md

---
**Date:** 2026-08-30
**Feature:** PROP-024 Component Version History — Full State Access Per Revision
**Decision:** Store version snapshot as JSONB on `bom_component_versions` rather than adding version-scoped FK columns to `component_documents` / `component_materials`.
**Why:** Adding `component_version_id FK` to the document and material tables would require migrating all existing rows and changing how documents are linked (to a version, not a component). The JSONB approach is additive-only: one new nullable column, no schema changes to existing linking tables, no migration of existing data. The tradeoff is that documents added after a bump but before the next are not captured — acceptable for MVP and documented in the UI as "snapshot as of version creation."
**Files changed:** supabase/migrations/0014_version_snapshot.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-30
**Feature:** Bug fix — BOM tab classification type-only
**Decision:** Tab placement in `groupFiltered()` now uses only `c.type`; removed `|| c.has_children` from the Assemblies condition.
**Why:** `has_children` was added so that any component with children would surface in the Assemblies tab, but this caused Component-typed nodes to migrate tabs as soon as they got their first child — the wrong behaviour. Tab identity must be stable and reflect what the node *is* (its type), not what edges it has. `has_children` remains correct for driving the expand button.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-30
**Feature:** PROP-025 Structural BOM Tab Classification + Meaningful Type Values
**Decision:** Tab classification uses `has_children` (structural) rather than the `type` field; component type values renamed from Component/Product/SparePart/Refurb to part/raw_material/sub_assembly/finished_good/spare_part.
**Why:** The old type values ("Component", "Product") clashed with tab names and led to visually contradictory states — a node typed "Component" appearing in the Components tab with an expand arrow because it had children. Structural routing means the UI reflects reality: if it has children it IS an assembly, regardless of what type label it carries. Renaming types to manufacturing categories makes the badge meaningful without conflicting with tab terminology.
**Files changed:** supabase/migrations/0015_rename_component_types.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-30
**Feature:** PROP-026 Component Images — Paste, Drop, or Pick from Disk
**Decision:** Store component images in the existing `documents` bucket under a `component-images/` prefix rather than a dedicated `component-images` bucket.
**Why:** Creating a new bucket requires Supabase dashboard access and separate RLS bucket policies. Reusing the `documents` bucket with a path prefix achieves the same isolation at zero extra infra cost. Images are only exposed via 1-hour signed URLs (same as documents), keeping access control consistent.
**Files changed:** supabase/migrations/0016_component_images.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** Bug fix — BOM Node tree arrows cannot collapse after initial expand
**Decision:** Changed open-state check from `display !== "none" && display !== ""` to `display !== "none"` in the outer BOM Node list expand button.
**Why:** A freshly-rendered expanded tree has `style.display = ""` (the browser default for visible). The extra `!== ""` condition made this evaluate to `false`, so every click went into the expand branch and never collapsed. Empty string means visible — only `"none"` means hidden.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** Photos in New BOM Node creation modal
**Decision:** Queue images as `File` objects with local `createObjectURL` previews during the modal; upload them to Supabase Storage only after `addComponent` returns the new component ID. Upload failures are swallowed (best-effort) — the component was already created successfully.
**Why:** The signed upload URL requires a `component_id`, which doesn't exist until after creation. Queueing avoids a two-step UX while keeping the upload flow identical to the detail panel (`imageUploadUrl` → XHR PUT → `addComponentImage`). No new API actions needed.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** Inline photo thumbnails on BOM Node list rows with hover preview
**Decision:** One `listComponentThumbnails` request fetches the first image per component for the whole org, rather than N per-component requests.
**Why:** Fetching images individually per row would fire N concurrent API calls on every list load — one org-wide query deduplicates in JS and generates signed URLs only for components that have images. A single shared tooltip div (pointer-events:none) is repositioned on mouseenter rather than creating one tooltip element per row.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** Bug fix — BOM thumbnail hover tooltip invisible (stacking context)
**Decision:** Moved the tooltip `<div>` from `wrap` to `document.body`; assigned `id="bom-thumb-tooltip"` so re-renders remove the previous element before creating a new one.
**Why:** `position:fixed` is only viewport-relative when no ancestor has a CSS `transform`, `filter`, `will-change`, or `perspective`. Any such ancestor creates a new containing block that traps the fixed element inside it. Appending to `document.body` (which has no such ancestor) guarantees true viewport positioning regardless of the page's CSS.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** Click BOM list thumbnail to open full lightbox
**Decision:** Inline the lightbox overlay directly in the thumbnail's `onclick` handler rather than extracting the `openLightbox` helper from `openComponentDetail`.
**Why:** `openLightbox` is scoped inside `openComponentDetail` and extracting it would widen its scope for a single call site. The lightbox is three lines — duplicating it inline is the right call at this scale. `stopPropagation` prevents the row's `ondblclick` from firing; tooltip is hidden immediately on click to prevent visual overlap.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** PROP-027 — Shared Component Awareness (BOM Tree Refresh & Usage Indicators)
**Decision:** Aggregate parent counts in JS rather than a Postgres GROUP BY via RPC; re-fetch all expanded BOM trees in `refreshTree()` rather than targeted invalidation.
**Why:** JS aggregation over `bom_edges` is simpler (no migration, no RPC function) and sufficient at Rushroom's scale. Re-fetching all expanded trees on refresh is O(N parallel getBom calls) but N is typically 0–3 in practice; it ensures no stale data without complex cache-invalidation bookkeeping. A targeted "invalidate this root only" approach would require threading `expandedTrees` through the entire `openAddChildModal` call chain — not worth the complexity for now.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/IDEAS.md

---
**Date:** 2026-08-31
**Feature:** Fix — input fields match button height everywhere
**Decision:** Single base `.up-text` CSS rule (`min-height:44px; box-sizing:border-box; padding:0.5rem 0.75rem`) rather than per-element inline height fixes.
**Why:** The root cause was structural — `.btn` sets `min-height:44px` globally but `.up-text` had zero base CSS. One rule fixes all 9 occurrences simultaneously. Per-element fixes would be brittle and easy to miss on new inputs. Box-sizing included because inputs default to content-box, which causes width surprises when padding is added.
**Files changed:** assets/styles.css, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** Multi-image lightbox navigation in component image gallery
**Decision:** Refactored `openLightbox(url)` → `openLightbox(images[], startIndex)` rather than a separate navigator wrapper. Keyboard events cleaned up via `removeEventListener` on close.
**Why:** The array-based signature is the minimal change that supports N images — no second overlay, no separate state object. Keyboard listener is attached to `document` and explicitly removed on close (both Escape and backdrop click) to avoid stale handlers accumulating across opens. Arrows are omitted entirely when `images.length === 1` so the single-image case is visually clean.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** Multi-image lightbox in BOM list row thumbnails
**Decision:** Inline async fetch + duplicate multi-image lightbox code in `renderRootRow` onclick, rather than hoisting `openLightbox` to a shared scope.
**Why:** `openLightbox` is defined inside `openComponentDetail` — not accessible from `bomTreeView`/`renderRootRow`. Hoisting it to module scope would be a larger refactor with no other benefit yet. At this scale, duplicating ~30 lines of well-understood lightbox code is the safer, localised change; a future refactor can extract it when a third call site appears.
**Files changed:** assets/app.js, assets/config.js, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** Bug fix — deleteComponent blocked by component_images FK
**Decision:** Application-level cascade (fetch images → remove storage objects → delete DB rows) in `deleteComponent`, rather than adding `ON DELETE CASCADE` to the FK in a new migration.
**Why:** A DB-level cascade deletes the `component_images` rows but leaves the storage objects orphaned — the bucket accumulates unreachable files indefinitely. The application-level approach mirrors what `deleteComponentImage` already does for individual images. No schema change needed; the fix is one deploy of the edge function.
**Files changed:** supabase/functions/portal-api/index.ts

---
**Date:** 2026-08-31
**Feature:** Inline type editor in component detail panel
**Decision:** Reuse the existing `updateComponent` action (which already accepts `type`) rather than adding a dedicated `setComponentType` action. Mirror the lifecycle status editor pattern (dropdown + save button in the panel).
**Why:** `updateComponent` already validates the six valid type values server-side. A dedicated action would be dead weight. The status editor is the established pattern for inline field editing in the detail panel; mirroring it keeps the UI consistent and the code predictable.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** Fix — +child button on BOM list rows + Assemblies tab routing
**Decision:** Add +child directly to the root list row rather than only inside the expanded tree; route sub_assembly and finished_good to Assemblies tab by type rather than by has_children.
**Why:** The expand arrow (▶) gating on has_children created a chicken-and-egg problem — no way to add a first child to a new leaf node. Adding +child to the row breaks the loop with minimal code. Tab routing by type is more predictable: the user declares intent (sub_assembly) and the tab reflects it immediately, not only after the node acquires children.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** Fix — +child/+sib restricted to assembly types; type-only tab routing (v170–v172)
**Decision:** Type is the sole authority on tab placement and on whether a node can have children. part/raw_material/spare_part are always leaf nodes; sub_assembly/finished_good are always assembly containers. has_children plays no role in either decision.
**Why:** Allowing has_children to drive tab placement created a confusing mid-interaction jump (a part moved from Components to Assemblies the moment its first child was added). Restricting +child/+sib to assembly types enforces the intended BOM semantics in the UI: the user declares what something IS via the type field, and the system respects that declaration consistently.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** Fix — duplicate root row in BOM tree expansion (v173)
**Decision:** `renderBomTree`'s `buildRows()` walk starts from the root's children (not the root itself), numbering them 1, 2, 3… with `parentNode` set to the root node.
**Why:** The assembly root is already rendered as the list-row header; starting the DFS walk at the root caused it to appear a second time as position "1" inside its own expanded tree. Setting `parentNode = nodeMap[rootId]` for depth-0 children ensures +sib on those children correctly targets the parent assembly.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** Fix — assembly types visible in both Components and Assemblies tabs (v174)
**Decision:** `groupFiltered()` pushes `sub_assembly` and `finished_good` nodes into both `grouped.assemblies` and `grouped.components`, so they appear in both tabs simultaneously.
**Why:** A sub-assembly is still a component — it has a part number, lifecycle status, images, and a detail panel. Routing it exclusively to Assemblies made it invisible as a standalone record in the flat Components list. The correct model: Components tab is a universal flat list of every non-product-family node; Assemblies tab overlaps for assembly types to show the BOM tree view.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-08-31
**Feature:** Revert — restore exclusive tab routing (v175)
**Decision:** Tab routing is strictly exclusive: `part`/`raw_material`/`spare_part` → Components only; `sub_assembly`/`finished_good` → Assemblies only; `product_family` → Dynamic BOMs only.
**Why:** v174 added sub_assembly/finished_good to both tabs, which was semantically wrong. A sub-assembly is not a standalone part — it is an aggregation of parts. The Components tab should list only items that exist independently as leaf-node parts. When a node's type changes from part → sub_assembly, moving it from Components to Assemblies is correct and intentional behavior.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-01
**Feature:** PROP-028 — BOM Tree Terminology & Interaction Consistency
**Decision:** Rename "Components" tab → "Parts", "Component" column header → "Part", "+sib" button → "+part". The tooltip on +part retains "Add sibling" for precision.
**Why:** The tab that shows leaf-node types (part/raw_material/spare_part) should be called "Parts" — "Components" was ambiguous because sub-assemblies are also components of their parents in manufacturing terminology. "+sib" (sibling) is a computer-science tree term; "+part" describes the action in manufacturing vocabulary: add another part at the same level in the assembly.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-01
**Feature:** PROP-029 — Simplified type system (part / sub_assembly / finished_good)
**Decision:** Three types only. `finished_good` is a leaf node (Parts tab, no +child) — it is a bought-in complete product, never assembled by Rushroom. `raw_material`, `spare_part`, `product_family` removed from all type pickers; existing DB rows untouched. `+sib` label restored.
**Why:** The previous six-type system mixed manufacturing categories with structural roles. The simplified model maps directly to what Rushroom actually does: make parts, assemble sub-assemblies from parts, buy finished goods. Dynamic BOM is a separate concept (not a node type) — product families are built from existing sub-assemblies and parts.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-01
**Feature:** Fix — unlimited depth in Assemblies BOM tree (v178)
**Decision:** Within an Assemblies BOM tree, every row gets +child and +sib regardless of the node's type. Type controls only top-level tab placement, never child-add capability inside a tree.
**Why:** Restricting +child to sub_assembly/finished_good typed nodes made it impossible to build multi-level depth without first leaving the tree to change a node's type. The correct model: any node inside an assembly can have children; the tree is the place where structure is built freely. A new component created via +child is added to bom_components normally and appears in the Parts tab as a standalone record.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-01
**Feature:** Fix — Parts tab flat rows only (v179)
**Decision:** Expand arrow in `renderRootRow` requires `comp.type === "sub_assembly" || comp.type === "product_family"` in addition to `has_children`. Leaf-type nodes (part, finished_good) never show BOM tree expansion in the flat Parts list.
**Why:** When a part is used as a child inside an assembly it gains has_children=true in the DB. Without the type gate it rendered a BOM tree in the Parts tab — the wrong context. The Parts tab is the flat catalog; BOM trees belong in Assemblies.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-01
**Feature:** PLM dual-view — Parts = master catalog; Assemblies = has_children (v180)
**Decision:** Every non-product_family component appears in the Parts tab (master catalog). A component also appears in the Assemblies tab when has_children=true. The `type` field is a manufacturing-classification attribute only — it no longer determines tab placement. +child available on every component row (rushroom role). groupFiltered() pushes all to components; those with has_children also to assemblies.
**Why:** Standard PLM practice — every item is a part first (it has a part number and identity). Some parts also have a BOM (they are assemblies). These are not mutually exclusive. Routing by type forced users to choose one identity; routing by has_children lets the system reflect reality: a component naturally becomes an assembly the moment it gets its first child.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-01
**Feature:** Fix — Parts tab catalog-only; +child removed; sub_assembly always in Assemblies tab (v183)
**Decision:** `+child` in `renderRootRow` gated on `allowExpand` (false in Parts tab). `groupFiltered()` routes `sub_assembly` typed nodes to the Assemblies tab regardless of `has_children`.
**Why:** Adding a child to a part from the flat catalog was modifying an existing BOM structure without the user intending to — Parts tab is a read-only catalog, not a place to build structure. Removing `+child` from the Parts tab enforces this. The `groupFiltered` change is necessary to close the chicken-and-egg loop: a freshly created `sub_assembly` node has no children yet, so without the type-based route it would never appear in the Assemblies tab, leaving the user with no way to build it out. By routing on `type === "sub_assembly"` (regardless of `has_children`), the node is immediately available in Assemblies after creation, where `+child`/`+sib` work correctly.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-01
**Feature:** Fix — Parts tab tree-state restore guard (v182)
**Decision:** Added `allowExpand &&` to the `expandedTrees` restore condition inside `renderRootRow`. The expand-button suppression (v181) was correct but incomplete — the restore block that re-renders cached tree state on `renderAll()` had no corresponding guard, so a component expanded in the Assemblies tab would still show its full BOM tree when the Parts tab re-rendered (e.g. after `refreshTree()` fires post-child-add).
**Why:** `expandedTrees` is a shared in-memory map across all tabs. Suppressing the expand button prevents the user from manually expanding in Parts tab, but `refreshTree()` re-fetches BOM data for all previously-expanded ids and calls `renderAll()` — the restore block then fires unconditionally, undoing the v181 fix. The correct invariant is: the tree body never renders in Parts tab, not just the expand button. One `allowExpand &&` guard enforces it at the only place where `expandedTrees` state is consumed during render.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-01
**Feature:** Fix — Parts tab always flat; no BOM tree expansion (v181)
**Decision:** `renderRootRow` gains an `allowExpand` parameter (default `false`). `renderAll` passes `allowExpand = activeTab !== "components"`. The expand arrow is only rendered when `allowExpand && comp.has_children`. Parts tab is always flat regardless of `has_children` or `type`.
**Why:** The v180 PLM dual-view correctly placed all components in the Parts tab as a master catalog, but the has_children-based expand gate made some parts render BOM trees inside the flat catalog — e.g. a component typed "part" with has_children=true showed its entire assembly tree in the Parts tab. This made it impossible to find the isolated part without seeing structural context that belongs only in the Assemblies view. The `allowExpand` context parameter decouples the "is this component also an assembly?" question from "should this view show tree expansion?" — the Parts tab never needs tree expansion; its purpose is the flat catalog where you pick individual parts.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-02
**Feature:** PROP-030 — Manufacturing BOM: Postponement Routing & Work Orders (v184)
**Decision:** Routing lives on the product_family (not on individual components), steps are atomic physical actions with instruction_text + reference_document_id (not operation type alone), and variant_condition on steps uses the same JSONB containment pattern as bom_edges so different configurations trigger entirely different operation sequences. Work orders are per-order snapshots — immutable at creation time so routing definition changes never affect in-flight orders. Pull list split into "Pull & process" (components with processing steps) and "Pull & pack" (straight pick). Built as a separate "Manufacturing BOM" tab to protect the working Product BOM view.
**Why:** Rushroom operates a postponement manufacturing model (buy semi-finished panels generically, finalize to customer order). No ERP/MES licensing — full-stack IP ownership means MES-layer concepts belong in this system. Atomic steps with free-text instructions are needed because operations are dynamic and complex (one panel: drill + mill + insert two fasteners; another: CNC routing only). The snapshot model prevents in-flight work orders from being affected by routing definition changes.
**Files changed:** supabase/migrations/0017_manufacturing_bom.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-02
**Feature:** PROP-030 Schema Correction — component_routing_steps replaces family_routing_steps (v186)
**Decision:** Manufacturing steps are owned by a component scoped to a product family — compound scope (component_id, family_id) — not owned by the family. A purchased component can appear in multiple product families with entirely different manufacturing operations per family. `family_routing_steps` (family-scoped, with optional `applies_to_component_id` annotation) is replaced by `component_routing_steps` (compound scope: both columns NOT NULL, UNIQUE on (component_id, family_id, step_number)). `work_order_steps.applies_to_component_id` is replaced by `component_id`. UI flow changes from family→flat step list to family→component card grid (step counts per component per family)→per-component step editor. New action `listFamilyRoutingOverview` returns step counts for all components in a family in one query. `createWorkOrder` now iterates resolved components, fetches their steps from `component_routing_steps` WHERE component_id=comp AND family_id=family, and assigns flat global step numbers.
**Why:** The original schema modelled steps as "belonging to a product family, optionally annotated with a component". The user clarified that the correct model is the inverse: steps are owned by a component and only make sense within a particular family context. The same panel component SKU can be purchased generically and used in multiple product families — its drilling pattern for Family A differs from Family B. Family-scoped steps with `applies_to_component_id` as an annotation cannot enforce this — the same component can only have one set of steps globally. Migration 0018 drops and recreates all 0017 tables (no production data was present). No frontend API contract breakage — the old actions kept their names with updated signatures.
**Files changed:** supabase/migrations/0018_fix_routing_schema.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md

---
**Date:** 2026-09-02
**Feature:** PROP-030 architecture correction — product_family is not a BOM node type (v189)
**Decision:** Product families are a separate entity dimension, not a BOM component type. A product family = a named set of parts/assemblies (e.g. "LED Panel Series A"). The same component (e.g. "M4 screw") can belong to multiple families and have different manufacturing steps per family. This means: (1) a new `product_families` table independent of `bom_components`; (2) a `product_family_members` many-to-many table linking components to families; (3) `component_routing_steps.family_id` will FK to `product_families` rather than `bom_components`. The `product_family` BOM node type (used for Configure-to-Order variant BOMs) is a separate concept and stays — but is no longer creatable via the New BOM Node type picker and the PLM tab reverts to "Dynamic BOMs".
**Why:** The original PROP-030 implementation reused the existing `product_family` BOM node type as the scope for routing steps. This was wrong: Rushroom's postponement model requires that a purchased component (one article number, shared across families) can have different in-house operations depending on which product family it ends up in. That dependency is on the family concept, not on the Configure-to-Order BOM root node. Using the BOM root as the scope would mean only components directly in that BOM tree can have steps defined — breaking cross-family sharing of purchased components.
**Files changed:** assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md

---
**Date:** 2026-09-02
**Feature:** PROP-030 migration 0019 — product_families + product_family_members tables; component family tagging (v190)
**Decision:** Completed the architecture correction: `product_families` and `product_family_members` tables are live. `component_routing_steps.family_id` now references `product_families` (not `bom_components`). `work_orders.family_id` references `product_families`; `selections JSONB` column removed from `work_orders`. Work order pull list sourced directly from `product_family_members` — no BFS BOM resolution needed. Component detail panel gains a product family tagging section (multi-family chips with × remove + assign picker). Manufacturing Steps tab loads component card grid from `listFamilyMembers` instead of a BOM tree walk. Eight new API actions for product family CRUD and membership management.
**Why:** Finalises the PROP-030 schema so that (a) routing steps are correctly scoped to (component, product_family) where product_family is a first-class entity rather than a BOM node type, and (b) users can tag any part or assembly to one or more product families directly from the component detail panel — supporting Rushroom's postponement model where the same purchased SKU participates in multiple product families with different in-house processing. Removing `selections` simplifies the work order model — the pull list is deterministic from family membership, so variant configuration at work-order creation time is not needed.
**Files changed:** supabase/migrations/0019_product_families.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md

---
**Date:** 2026-09-13
**Feature:** PROP-031 — Rich Part Data Record (component_metadata)
**Decision:** One dedicated `component_metadata` table (UNIQUE on component_id) holding 28 nullable columns across 5 sections. Metadata is version-snapshotted into `bom_component_versions.version_snapshot` at every `bumpComponentVersion` call — no separate `component_metadata_versions` table needed. All future AI-extracted spec data (drawings, datasheets) writes to this same table, not a parallel structure. Overflow goes to a `custom_specs JSONB` column rather than schema additions.
**Why:** A single row per component avoids the fan-out query complexity of a key-value metadata store and keeps the 5-section schema explicit for DPP/ESPR Article 7 compliance. Snapshotting into the existing version_snapshot JSONB is zero-migration version control: the bump mechanism already runs; augmenting its payload adds no new tables. Separating compliance fields (WEEE, conflict minerals, recycled content, carbon footprint) as first-class columns — not freeform text — means DPP generation can be purely a query, not an NLP parse.
**Files changed:** supabase/migrations/0020_component_metadata.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-13
**Feature:** PROP-032 — make_or_buy sourcing field
**Decision:** `make_or_buy TEXT NOT NULL DEFAULT 'purchased' CHECK (…)` column on `bom_components` with four values: purchased / manufactured / assembled / subcontracted. Field is informational only — it does not gate BOM inclusion, MBOM membership, or manufacturing routing scope. Validated in `updateComponent` at the edge function (not a DB CHECK alone) so the error message is user-readable.
**Why:** Rushroom needs to see at a glance which parts arrive from suppliers vs which are built in-house. The four values map to Rushroom's actual procurement patterns (buy finished, make from raw, assemble sub-assemblies, subcontract to third party). Keeping it informational avoids gating logic that would need constant updating as sourcing decisions change; the field is the data, not the policy.
**Files changed:** supabase/migrations/0021_make_or_buy.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-13
**Feature:** Fix — deleteComponent FK cascade cleanup
**Decision:** `deleteComponent` now explicitly deletes rows in `work_order_components`, `component_routing_steps`, and `product_family_members` before the final `bom_components` delete. No ON DELETE CASCADE was added to the migration-defined FKs.
**Why:** ON DELETE CASCADE on manufacturing tables would silently wipe work order history when a component is deleted — an audit-trail concern. Explicit cleanup in application code makes the deletion sequence visible and auditable, and allows future hardening (e.g. blocking delete if an active work order references the component).
**Files changed:** supabase/functions/portal-api/index.ts

---
**Date:** 2026-09-13
**Feature:** Fix — type-only tab routing in groupFiltered()
**Decision:** `sub_assembly` typed components route exclusively to the Assemblies tab; all other types route to the Parts tab. `has_children` is no longer used as a tab-routing signal anywhere in `groupFiltered()`.
**Why:** The original `has_children`-based routing caused two bugs simultaneously: a freshly created `sub_assembly` with no children yet would appear in Parts (because has_children=false), and a `part`-typed component that happened to have children (gained via +child in the Assemblies tree) would spill into Assemblies. Type is a stable, user-assigned classification; `has_children` is derived structural state that changes as the tree is edited. Routing on type alone makes tab placement deterministic and immune to tree edits.
**Files changed:** assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-13
**Feature:** PROP-033 — Stocked Assembly Variants
**Decision:** Materialised stocked variants are first-class `bom_components` (type=sub_assembly), not a separate entity. Back-references (`source_family_id`, `source_config_id`) on `bom_components` link each variant to its origin. The `bom_edges` unique constraint is relaxed to a partial index (unconditional edges only) so variant-conditional edge pairs can coexist.
**Why:** Saved configurations are ephemeral records of attribute selections — they have no part number, lifecycle status, or orderable identity. Manufacturing, procurement, and order management all need a real component SKU. Making the materialised variant a standard `sub_assembly` means it participates in all existing workflows (BOM trees, work orders, product family membership) with zero special-casing. The partial unique index preserves the duplicate-edge guard for the common case (unconditional edges) while unlocking variant-conditional multiplicity needed for PROP-015-style multi-quantity scenarios.
**Files changed:** supabase/migrations/0022_stocked_variants.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-13
**Feature:** PROP-034 — Manufacturer vs Supplier
**Decision:** Added two columns (`manufacturer_name`, `manufacturer_part_number`) to `component_metadata` rather than creating a separate manufacturers table or a generic contacts table.
**Why:** The Rushroom use-case is a BOM-line-level annotation ("this part is made by X, bought from Y"), not a CRM-style company registry. A dedicated join table would add 2–3 extra queries per component load with no benefit at this scale. The simple column approach keeps `upsertComponentMetadata` as the single write surface for all procurement metadata and requires only one migration file (0023).
**Files changed:** supabase/migrations/0023_manufacturer_fields.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-13
**Feature:** PROP-035 — Component Variant Groups + Inline Name Editor
**Decision:** Each colour/finish/size variant is a distinct `bom_component` SKU; variant groups link siblings via a new many-to-many join (`component_variant_groups` + `component_variant_members`) without modifying the BOM tree structure.
**Why:** Alternatives considered: (a) a single abstract "panel" component with a colour attribute — rejected because it conflates the BOM tree node with a product catalogue concept and makes part numbers ambiguous; (b) an attribute column on `bom_components` — rejected because a single attribute can't express multi-dimensional variation (colour × size). The join-table approach keeps every variant as a first-class, stockable, orderable component while making sibling relationships navigable from the Overview tab. Stock/reorder tracking intentionally deferred to a future PROP — the group structure is the prerequisite, not the inventory numbers.
**Files changed:** supabase/migrations/0024_component_variant_groups.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, CLAUDE.md

---
**Date:** 2026-09-13
**Feature:** Inline Name / Part no. / OEM no. editor (UX fix)
**Decision:** Exposed `name`, `part_number`, and `oem_number` as editable fields in the Overview tab of the component detail panel, calling the existing `updateComponent` action.
**Why:** The BOM history trigger on `bom_components` already records every field change; renaming a node was previously impossible without delete-and-recreate, which would orphan all history, edge references, and document links. Surfacing the editor in the Overview tab (Rushroom-only) gives operators a safe in-place correction path. No new API action or migration needed.
**Files changed:** assets/app.js, index.html

---
**Date:** 2026-09-14
**Feature:** Bug fix — BOM tree `×` destroyed components instead of unlinking
**Decision:** The unlink-vs-delete branch keys on `parentNode`, not on `depth`. Registry deletion is reachable only from the card-header `×` (with its danger modal); the `×` inside a tree always unlinks.
**Why:** The tree deliberately does not render its own root — the root is the list-row header — so `buildRows()` seeds the root's direct children at `depth 0`. Branching on `depth > 0` therefore sent every *direct* child of an assembly down the destroy path, calling `deleteComponent` and cascading through `component_documents`, `component_materials`, `bom_component_versions`, component images (storage objects included) and routing rows; only grandchildren unlinked correctly. Re-indexing the walk to start at depth 1 was rejected: `depth` also drives the ASCII connector maths and the Dynamic BOM button rules, so shifting it would have moved a destructive bug into two cosmetic/behavioural ones. `parentNode` is the semantically correct discriminator — a row inside a tree has a parent by construction, so it can never be a registry root — and it is already computed and passed for every row. Seeded with an `{ id: rootId }` fallback so a missing root node cannot silently re-open the destructive path. `removeBomEdge` was never at fault: it soft-closes the edge via `effective_to` and does not touch `bom_components`.
**Files changed:** assets/app.js

---
**Date:** 2026-09-14
**Feature:** Cache-bust location correction + page version sync
**Decision:** `?v=N` is documented as living on the asset tags in `index.html`. CLAUDE.md and `.claude/commands/ship.md` corrected, and /ship Step 5 now enumerates the six asset tags. supplier.html, reset.html and verify.html synced to the current version.
**Why:** Both CLAUDE.md and the /ship command said the cache bust lived in `assets/config.js`, which carries no version string at all — a /ship run following that instruction would have bumped nothing and shipped stale assets. Enumerating the tags prevents the follow-on failure of bumping one tag and missing five. The three secondary pages had drifted to v105 and v72 while index.html was at v201, all loading the same shared `config.js` / `api.js` / `app.js`; since `?v` is only a browser cache key (Pages serves current assets at any `?v`), this stranded returning visitors on old cached copies rather than withholding code from new ones. Syncing converges them. Verified before bumping that supplier.js's `window.Portal` contract (`apiEnabled`, `renderApi`, `setupApiGate`, `wireTabs`) is still satisfied by app.js.
**Files changed:** CLAUDE.md, .claude/commands/ship.md, supplier.html, reset.html, verify.html

---
**Date:** 2026-09-14
**Feature:** PROP-036 — BOM Tree Editable Structure (depth semantics, shared-edit warning, stable order, move)
**Decision:** Four choices, each deliberate. **(1)** Permission guards in the tree renderer are named booleans, never `depth` comparisons. **(2)** Dynamic BOMs accept sub-tree edits and the blast radius is surfaced ("allow + warn"), reversing the previously documented restriction. **(3)** Sibling position is a stored `sort_order` on `bom_edges`, backfilled in gaps of 10. **(4)** Move is edge-scoped and keyed on `edge_id`, committing as close-then-insert.
**Why:** **(1)** The tree does not render its own root, so `buildRows()` seeds the root's children at `depth 0` and any guard written as `depth > 0` is one level off from intent — that mismatch destroyed a component in v202. Re-indexing the walk to start at 1 was rejected because `depth` also drives `connector()`'s ASCII maths and the Dynamic BOM button rules, which would have converted one destructive bug into two cosmetic ones. **(2)** The alternative — forbid the edit and send the user to the component's own tree — was rejected as not matching how the tree is read; but the edit cannot be made local, because there is no per-Dynamic-BOM copy of a sub-assembly and `+child` necessarily writes to the shared component. Permitting it while naming the other affected assemblies (via the existing `listParentsOf`) keeps editing where users expect it and makes sharing visible at the moment it matters instead of discovered later. Note the deliberate asymmetry with Move: Move genuinely touches only the assembly on screen, whereas `+child` is inherently global — same warning surface, different blast radius, and the wording must not conflate them. **(3)** `getBom` had no `ORDER BY` at all, so the "Pos." column was the array index of an unordered result and could reshuffle between loads; a BOM whose line numbers move on their own is unusable as a build instruction. Gaps of 10 allow an insert between neighbours without renumbering the sibling set. **(4)** Edge-scoping is the user's explicit rule and matches `removeBomEdge`'s existing behaviour. Keying on `edge_id` is not a preference but a requirement: PROP-033 replaced the unique constraint with a partial index covering unconditional edges only, so several conditional edges may legally exist between one pair and any pair-keyed action hits all of them — which is exactly the latent bug found in `removeBomEdge` and fixed here. Close-then-insert is required because `trg_check_bom_cycle` (migration 0007) is a `BEFORE INSERT` trigger: it must evaluate against the post-move ancestor set, or a legitimate re-parent inside the same branch is falsely rejected. The old edge is re-opened if the insert fails so a child is never left detached. Cycle detection was not rebuilt — the trigger already exists, contrary to an earlier reading of the migrations.
**Files changed:** supabase/migrations/0025_bom_edge_ordering.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, supplier.html, reset.html, verify.html, CLAUDE.md
**Status:** deployed 2026-09-15 (migrations 0025 + 0026 applied, `portal-api` redeployed). Add / remove / re-add and reordering confirmed working 2026-09-15. Reordering needed three fixes first: the guard hid the controls on single-child assemblies (v204); `el()` set `disabled="false"`, which disables a button, so all of them were inert (v205); and the Move picker was rebuilt for legibility (v208). Move confirmed against production 2026-09-15: three completed moves, each closing the old edge and inserting a new active one with quantity preserved and a fresh sort_order, each audited in `bom_component_history`. Live integrity checks returned 0 duplicate active unconditional pairs and 0 NULL sort_order. The rollback branch remains unexercised because no move has failed.

---
**Date:** 2026-09-14
**Feature:** Fix — cannot re-add a child removed the same day (migration 0026)
**Decision:** `bom_edges_unconditional_unique` is redefined from `(parent_id, child_id, effective_from) WHERE variant_condition IS NULL` to `(parent_id, child_id) WHERE variant_condition IS NULL AND effective_to IS NULL`. The invariant enforced is now "at most one *active* unconditional edge per parent→child pair".
**Why:** The old index covered every unconditional row, closed ones included. Removal soft-closes an edge (`effective_to = today`) but leaves the row with its original `effective_from`, so re-adding the same child to the same parent on the same day collided with the edge that had just been removed — and succeeded the following day, which made it look intermittent. Alternatives considered: (a) hard-delete the edge row on removal — rejected, it destroys the BOM history that `effective_from`/`effective_to` exist to preserve; (b) stamp the new edge with a later `effective_from` to dodge the collision — rejected as writing a false date into a time-versioned table purely to satisfy an index; (c) keep the key and catch the error in the UI — rejected, it leaves a legitimate operation permanently blocked for the rest of the day. Once closed edges are excluded, `effective_from` is unnecessary in the key: the real rule is about what is active now. The migration closes any pre-existing duplicate active edges (keeping the most recent) before creating the stricter index, because the old definition permitted two active edges between one pair when their `effective_from` differed and leftover data would otherwise fail index creation. **Provenance worth recording:** this was a second-order defect of the v202 delete fix. Removing a direct child previously hard-deleted the component and took its edges with it, so the collision could not arise; making removal correctly unlink is what left the closed row behind to block the re-add. The v202 fix was correct — this is what it uncovered.
**Files changed:** supabase/migrations/0026_bom_edge_active_unique.sql, supabase/functions/portal-api/index.ts
**Status:** deployed 2026-09-15 (migrations 0025 + 0026 applied, `portal-api` redeployed). Add / remove / re-add and reordering confirmed working 2026-09-15. Reordering needed three fixes first: the guard hid the controls on single-child assemblies (v204); `el()` set `disabled="false"`, which disables a button, so all of them were inert (v205); and the Move picker was rebuilt for legibility (v208). Move confirmed against production 2026-09-15: three completed moves, each closing the old edge and inserting a new active one with quantity preserved and a fresh sort_order, each audited in `bom_component_history`. Live integrity checks returned 0 duplicate active unconditional pairs and 0 NULL sort_order. The rollback branch remains unexercised because no move has failed.

---
**Date:** 2026-09-15
**Feature:** PROP-037 — Editable BOM quantity
**Decision:** Quantity is edited in place on the QTY cell via a new `setEdgeQuantity` action keyed on `edge_id`, audited in `bom_component_history`. The cell edits the *edge's own* quantity while continuing to display the rolled-up total beneath it when the two differ.
**Why:** Quantity was write-once: settable when a child was linked, unchangeable afterwards. The only correction available was unlink-and-re-add — exactly the delete-and-recreate pattern PROP-036 existed to eliminate, and the pattern that met the v202 delete bug. Keying on `edge_id` rather than `(parent_id, child_id)` follows PROP-036's rule and is required for the same reason: PROP-033 permits several conditional edges between one pair, so a pair-keyed patch would rewrite all of them. Edge-scoping is the substantive choice — a quantity belongs to a parent's *use* of a component, not to the component, so changing it must not touch other assemblies that happen to use the same part; this matches Move and `removeBomEdge`. **The non-obvious part is the display.** The QTY column has always rendered the rolled-up quantity (`qty × e.quantity` accumulated down the tree), not the edge's own value — an assembly using 2 of a part that itself uses 2 of a child shows ×4 at that depth. Binding an editor to the number on screen would therefore have silently written the roll-up back as the edge quantity, corrupting the BOM in a way that looks right on the next render. The walk now carries `edgeQty` separately: the cell edits `edgeQty` and shows `= N` underneath when the roll-up differs, so the number being edited is visibly distinct from the number being displayed. A rejected alternative was to make the column show edge quantity only — cleaner to implement, but it discards the roll-up, which is the figure that matters when reading a BOM as a pull list.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, supplier.html, reset.html, verify.html, CLAUDE.md
**Status:** confirmed against production 2026-09-15 — six quantity changes audited in `bom_component_history`, including edits at nested depth where the rolled-up figure differs from the edge value. The recorded old→new pairs are edge quantities (e.g. "Adjustable Legs … from 2 to 4"), not roll-ups, which is the specific corruption the `edgeQty` split was there to prevent.

---
**Date:** 2026-09-15
**Feature:** PROP-038 — Part categories
**Decision:** Categories are a managed, org-scoped table (`part_categories`) referenced by a nullable `bom_components.category_id`, surfaced as clickable chips with counts under the Parts tab. A category is **required on create** for any type that lands in the Parts tab, enforced in `addComponent` rather than only in the UI. Existing parts keep `category_id NULL` and appear under an `Uncategorised` chip.
**Why:** The Parts tab was a flat list whose only navigation was the search box. At the thousands of parts this range is heading for that is not a minor annoyance: it forces a hand off the mouse and a typed query for what should be one click, which is the specific complaint that prompted this. Chips with live counts make the structure visible and clickable. **Managed list over a CHECK constraint:** a fixed enum of the four starting categories would have been less code, but a growing furniture range will want Packaging, Textiles, Lighting — and each would then be a migration plus an edge-function deploy, for what is really a piece of data. Free-text tags were rejected for the opposite reason: multiple tags per part make chip counts ambiguous, and typos silently split a group in two, which defeats reliable clickable navigation. **Required on create, enforced server-side:** a UI-only rule would be bypassed by the add-child path and by any future caller, and the whole value of the feature collapses the moment a meaningful share of parts is untagged. **Existing rows are not backfilled** into a default category — that would assert classifications nobody made, producing wrong data that looks right; they stay NULL and the `Uncategorised` chip makes the backlog visible and clickable until it is worked through, then disappears on its own. **Deleting a category in use is refused** rather than nulling its parts, since silently dumping a group into Uncategorised loses the information about what they were.
**Files changed:** supabase/migrations/0027_part_categories.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, supplier.html, reset.html, verify.html, CLAUDE.md
**Status note:** built and statically checked; migration 0027 not yet applied, `portal-api` not yet redeployed, nothing exercised against the live database.

---
**Date:** 2026-09-15
**Feature:** Fix — one paste uploaded an image to two components (v212, then v213)
**Decision:** A document-level `paste` handler must yield to any modal stacked above it. Every full-screen overlay carries `data-modal-overlay`, and the component detail panel's image-paste handler returns early whenever one is present in the DOM.
**Why:** Two handlers were bound to `document` at once — the detail panel's, for its Images tab, and `openAddComponent`'s, for the New BOM Node photo queue. One Cmd+V fired both, so the image was queued onto the part being created *and* uploaded to whichever component's panel was still open behind the modal. Every duplicate pair in the data is exactly (open component, just-created component), 1.5–5 seconds apart. **v212 was a wrong diagnosis, kept because it fixed a real defect anyway:** the panel stored its unregister function in a single per-panel slot, so a second registration orphaned the first. That leak was real, but it was not this bug, and the v212 guard (`openDetailComponentId !== componentId`) could never have caught it — the panel legitimately *is* the open panel. The lesson worth keeping: the recurrence was only distinguishable from a false alarm by checking the deployed artifact (`index.html` served `?v=212` and the live `app.js` contained the guard), which ruled out "not deployed yet" and forced a second look at the diagnosis rather than a third patch on the same theory. Alternatives rejected: `stopImmediatePropagation` in the modal handler, which depends on registration order and the panel registers first; a counter of open modals, which needs every close path to decrement and there are four; checking `ev.defaultPrevented`, which is false when the panel's handler runs first. A DOM marker is order-independent and self-cleaning, since the attribute disappears with the overlay. **Rule for future modals:** any full-screen overlay must carry `data-modal-overlay`, or a paste meant for it will also reach the panel underneath.
**Files changed:** assets/app.js, .claude/commands/frontend.md (the documented Pages URL was wrong, which made the first deployment check return a 9KB stub and prove nothing)
**Status:** confirmed against production 2026-09-15 — the first upload after v213 produced a single row (12:41 UTC) where every prior paste produced a pair; `component_images` now holds 5 rows, one per component, with no duplicate pairs. The exact modal-over-panel path has not been deliberately re-run, so this is strong evidence rather than a targeted test.

---
**Date:** 2026-09-15
**Feature:** PROP-039 — AI field extraction into the component spec fields
**Decision:** `extractComponentSpecs` reads a datasheet, drawing or pasted screenshot and returns proposals — value, value *as printed* with its unit, verbatim evidence, and a confidence — which the user reviews and applies. The action never writes. Confident readings of *empty* fields are pre-ticked; a field the user has already filled is never pre-selected. Values with no matching column come back as `unmapped` and are stored in `custom_specs`.
**Why:** The spec record is ~28 fields per part and every one was being retyped from a datasheet that already stated it, which is slow and is exactly where transcription errors enter compliance data. Auto-applying was rejected outright: a wrong flame-retardant class or WEEE category is worse than an empty one, because it looks authoritative and gets exported into a DPP, and an extraction that is right 90% of the time silently corrupts one field in ten. Review-with-evidence keeps the speed while leaving the judgement where it belongs — the verbatim quote means a value can be checked without reopening the document. Pre-ticking only empty fields follows from the same principle: the system may offer to fill a gap, never to overrule a human. Units carry the highest risk of a plausible-looking error — a sheet quoting 1.2 kg against a `weight_g` column is a factor-of-1000 mistake that passes review unnoticed — so the model must return the printed form alongside the converted one, and coercion happens server-side so what is approved is exactly what is written. The `unmapped` list is the deliberate second half of the feature: information a document states but the schema cannot hold was previously discarded silently, and recurring homeless keys are the strongest available signal for which columns are actually missing. **Prerequisite fixed:** `fileBlock()` branched on extension and routed anything that was not pdf/docx/xlsx through `TextDecoder`, so a PNG became garbage text and the model was asked to read it — it did not error, it simply returned nothing useful. Screenshots are the primary source here, so a `type:"image"` block was a precondition, not an enhancement. **Bug found in passing:** `upsertComponentMetadata`'s whitelist never included `manufacturer_name` or `manufacturer_part_number`, so both PROP-034 fields had been silently discarded on every save since the day they shipped — the form accepted them, the columns existed, and nothing was written.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, supplier.html, reset.html, verify.html, CLAUDE.md
**Status note:** built and statically checked; `portal-api` not yet redeployed and nothing exercised against a real datasheet.

---
**Date:** 2026-09-15
**Feature:** PROP-040 — Promote a custom spec to a standard field
**Decision:** Promotion writes a row to an org-scoped `custom_spec_fields` catalogue rather than adding a column to `component_metadata`. Values stay in the existing `custom_specs` JSONB; the catalogue only decides how a key is labelled, typed, grouped and ordered. The prompt appears once a key is carried by 3+ components.
**Why:** A real typed column is the textbook answer and was rejected on operational grounds: every promotion would be a migration plus an edge-function deploy, so noticing "Diameter keeps appearing" while entering data could not be acted on in the moment — it would become a ticket, and the observation would be lost. The catalogue makes promotion a data operation with no deploy, which is the same trade already made for `part_categories`. It also makes promotion reversible: because values never move, demoting removes one row and the key simply renders as a custom spec again, where a column would have to be dropped and its data migrated back. The cost is real and worth stating: promoted fields are not typed or indexable at the database level and cannot be queried in SQL as first-class columns, so if a field later needs constraints, joins or reporting, it should graduate to a genuine column through a normal migration — the catalogue is where a field proves it deserves that, not a permanent substitute. **The 3+ threshold** is the point of the feature: a key on one part is a datasheet quirk, a key on three is a dimension of the data. Prompting on every captured value would train the user to dismiss the prompt, which is worse than not asking. Below the threshold the usage count is still shown, so the evidence is visible without an interruption.
**Files changed:** supabase/migrations/0028_custom_spec_fields.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, supplier.html, reset.html, verify.html, CLAUDE.md
**Status note:** built and statically checked; migration 0028 unapplied and `portal-api` not redeployed.

---
**Date:** 2026-09-15
**Feature:** Fix — two columns, one "OEM number" label
**Decision:** `component_metadata.manufacturer_part_number` is the single OEM number. The Overview tab, the Create BOM Node modal and AI fill all read and write it. `bom_components.oem_number` is retired from the UI, and its column is kept.
**Why:** Both columns were labelled "OEM number" on different tabs of the same panel, so a number entered in one place was invisible in the other and neither screen was wrong. AI fill made it visible by writing the metadata column while the Overview box stayed empty, but the divergence predated it — anything typed into Overview had been landing somewhere Procurement never showed. The metadata column wins because it preserves PROP-034's pairing: Manufacturer with their part number, Supplier with theirs. Making the component column canonical would have been less plumbing — it is older, and appears in `listComponents` — but it would leave "Manufacturer" sitting beside a number stored on a different table, which is the confusion that caused this. Keeping both with distinct labels was rejected: one identifier per part is the truth, and two boxes would go on diverging quietly. **The column is kept rather than dropped.** It holds what was entered before the reconciliation, and a migration that destroys the only record of a divergence removes the evidence of what happened. Migration 0029 backfills the metadata column from it, inserting a metadata row where none existed, and never overwrites a metadata value that is already set — where the two disagreed, the value shown in Procurement is the one that survives.
**Files changed:** supabase/migrations/0029_unify_oem_number.sql, assets/app.js, index.html, supplier.html, reset.html, verify.html, CLAUDE.md
**Status note:** built and statically checked; migration 0029 unapplied.

---
**Date:** 2026-09-15
**Feature:** Component detail panel — Relations tab
**Decision:** The Overview tab holds only the Properties card. A new Relations tab (second in the bar, with a count) collects Variant Group, Dynamic BOM configurations, Product families and Used in.
**Why:** Overview had accumulated five stacked sections, one per relationship feature shipped, so opening any component meant scrolling past the card you came to edit — and the problem was structural: every future relationship feature would land on the same tab and make it worse. Separating by *kind of question* fixes it durably: Overview answers "what is this part", Relations answers "what is it connected to". Two alternatives were rejected. A tab each for Variants, Families and Used in would reach twelve tabs, wrapping the bar on a laptop and turning a vertical hunt into a horizontal one. Collapsible sections would leave four headers still stacked above the fold and require remembering collapse state per component, which is fiddly to get right and annoying when wrong. The count on the tab label is the part that makes the move safe: hiding content behind a tab normally costs discoverability, and `Relations (3)` restores it without opening anything. The source callout stays on Overview deliberately — it is a warning about the component itself, not a relationship.
**Files changed:** assets/app.js, index.html, supplier.html, reset.html, verify.html, CLAUDE.md
**Status note:** built and statically checked; not yet exercised.

---
**Date:** 2026-09-15
**Feature:** Component detail panel opens as a centred overlay
**Decision:** The panel is mounted in a fixed, centred overlay appended to `document.body` rather than inline beneath the component list. Backdrop click and Escape close it. The overlay is deliberately **not** tagged `data-modal-overlay`, and Escape is ignored while any element carrying that attribute is present.
**Why:** Mounted inline, the panel sat below the list, so opening a component meant scrolling past every row — and the distance grew with the list, which is heading for thousands of parts. This is the second attempt at the problem: the Relations tab (v220) reorganised what was *inside* the panel, which helped, but the panel's position was the actual cause and no amount of internal tidying could reach it. **The two guards are the load-bearing part.** `data-modal-overlay` means "a modal is stacked above the detail panel, so the panel must not consume the paste" (v213); tagging the panel itself would have satisfied the letter of the pattern while silently breaking pasting into its own Images tab, because the panel would have been treated as a modal above itself. Escape is ignored while a real modal is open for the same reason in reverse — AI fill, Move and the category manager all sit above the panel, and a single Escape should dismiss the thing on top, not the surface beneath it. `openComponentDetail` retains the previous inline behaviour when a caller passes a panel without the overlay hooks, so the other mount points keep working unchanged rather than being migrated in the same commit.
**Files changed:** assets/app.js, index.html, supplier.html, reset.html, verify.html, CLAUDE.md
**Status note:** built and statically checked; not yet exercised.

---
**Date:** 2026-09-15
**Feature:** Component list scrolls in its own region
**Decision:** `treeArea` is an independent scroll region whose `max-height` is measured after every render and on resize. The toolbar, type tabs and category chips sit outside it and therefore stay in place without `position: sticky`.
**Why:** The page scrolled as one document, so the filters scrolled away with the list — at 21 parts a nuisance, at the thousands PROP-038 was built for it makes the filters unreachable exactly when they are needed. `position: sticky` on the controls was the obvious alternative and was rejected: it fails silently when any ancestor has `overflow` or a `transform`, and this file already carries a comment about that breaking the thumbnail tooltip, so it would be a fragile choice in this specific DOM. Taking the list out of page flow instead makes the controls stay put as a structural consequence rather than a CSS effect that has to keep holding. **The height is measured, not calculated in CSS,** because the category chips row exists only on the Parts tab: a hard-coded `calc(100vh - Npx)` would be correct there and wrong on Assemblies and Dynamic BOMs, and would drift again the next time a control is added above the list. The resize listener replaces any left by a previous mount — document- and window-level listeners have leaked twice in this file already this session, so registering defensively is now the house pattern rather than an afterthought.
**Files changed:** assets/app.js, index.html, supplier.html, reset.html, verify.html, CLAUDE.md
**Status note:** built and statically checked; not yet exercised.

---
**Date:** 2026-09-15
**Feature:** Detail panel — pinned header and tab bar, scrolling content
**Decision:** The panel is a flex column with `overflow:hidden`; the title row and tab bar are `flex-shrink:0`; the tab content sits in a wrapper carrying `flex:1; min-height:0; overflow-y:auto`.
**Why:** The whole panel scrolled, so on a long tab — Specifications with custom specs, or Change Log — the tab bar and the Close button scrolled out of reach, and returning meant scrolling back up through content just read. This is the same structural move as the component list (v222): take the scrolling region out of flow rather than pinning the controls with `position: sticky`, which fails silently when an ancestor has `overflow` or a `transform` — and this panel now *is* inside an overflow-hidden flex parent, so sticky would have been actively wrong here rather than merely fragile. **`min-height: 0` is the load-bearing line.** A flex child defaults to `min-height: auto` and refuses to shrink below its content, so without it the wrapper grows to fit, `overflow-y: auto` never has anything to clip, and the scroll silently lands on the page instead — the layout renders correctly and behaves exactly as it did before, which makes the omission hard to spot in review. Recorded because it will look like a redundant line to anyone tidying this CSS later.
**Files changed:** assets/app.js, index.html, supplier.html, reset.html, verify.html, CLAUDE.md
**Status note:** built and statically checked; not yet exercised.

---
**Date:** 2026-09-15
**Feature:** PROP-041 — Category-specific spec fields
**Decision:** Extend `custom_spec_fields` with `category_id` (NULL = all categories) and `options JSONB` plus a `choice` data type, rather than adding a per-category field mechanism. Migration 0030 seeds Head diameter, Thread / tube diameter, Head slot type and Head type against Fittings & Fasteners.
**Why:** Different part families genuinely need different attributes, and the alternative — every field on every part — produces a Specifications tab that is mostly dashes, which is the same dilution the category chips were built to prevent in the list. The catalogue already existed and already stored values in `custom_specs`, so scoping is two columns rather than a second system; a part-type-specific table would have duplicated the promotion, rendering and editing paths that PROP-040 just established. `choice` matters more than it looks: Head slot type is exactly the field where free text degrades into PZ2, Pz2 and "pozi 2" as separate values, which makes the data useless for filtering later — the same argument that rejected free-text tags for part categories in PROP-038. **Values persist in `custom_specs` independent of the category**, so re-categorising a part hides the rows without discarding what was recorded and moving it back restores them; the category controls display, never storage, which keeps a mis-categorisation from being destructive. A useful consequence of the PROP-039 design falls out for free: an AI-extracted `head_diameter_mm` arrives as unmapped, is accepted into `custom_specs`, and then renders as the labelled Head diameter field without any further work.
**Files changed:** supabase/migrations/0030_category_scoped_fields.sql, supabase/functions/portal-api/index.ts, assets/app.js, index.html, supplier.html, reset.html, verify.html, CLAUDE.md
**Status note:** built and statically checked; migration 0030 unapplied, `portal-api` not redeployed.

---
**Date:** 2026-09-16
**Feature:** PROP-042 — Duplicate a component
**Decision:** `duplicateComponent` copies the component row and its entire `component_metadata` row, and nothing else. No BOM children, no documents, no images. The part number is regenerated, the name gets " - copy", and `lifecycle_status` is forced to `inactive`.
**Why:** The real case is copying EURO Screw 13mm to make the 27.5mm — the value is in the spec record, which is the expensive part to re-enter, and everything else would have to be un-linked afterwards. **Documents and images are deliberately excluded**, and this is the load-bearing choice rather than a scope cut: a test report or supplier datasheet is evidence issued about one specific part, so duplicating those links would put a compliance document on a part it was never issued for — the kind of error that looks like diligence until someone relies on it. **The part number is always regenerated rather than derived** (no "-COPY" suffix) because it is unique per organization and is the string people scan and quote; a copy that resembles its source is a copy that will eventually be ordered by mistake. **Always inactive** because a copy has been reviewed by nobody, whatever the source's status — inheriting "active" would launder approval from one part to another. BOM children were considered and left out: for a plain part it changes nothing, and for an assembly it raises whether children are shared or themselves copied, which is a different feature (PROP-033 already materialises structure). The copy opens immediately after creation, since duplicating exists in order to change something.
**Files changed:** supabase/functions/portal-api/index.ts, assets/app.js, index.html, supplier.html, reset.html, verify.html, CLAUDE.md
**Status note:** built and statically checked; `portal-api` not redeployed.

---
**Date:** 2026-09-16
**Feature:** Performance — CORS preflight caching
**Decision:** `portal-api` sends `Access-Control-Max-Age: 86400`.
**Why:** Loads and saves had degraded to 10–14 seconds. The cause was that every request was preceded by an OPTIONS preflight, and on Supabase Edge Functions a preflight is a full invocation: the module is loaded and its imports resolved before execution reaches the `OPTIONS` short-circuit on the handler's first line. Measured over three hours: **302 OPTIONS at p50 1200 ms, p95 8820 ms, max 19.7 s**, against 669 POSTs at p50 535 ms. Half the traffic was preflights, and they were the slower half — a four-call list load was really eight invocations, four of them paying boot. `Access-Control-Max-Age` lets the browser reuse one preflight rather than repeating it per call. **What this episode is really about is method.** Three fixes preceded it, each addressing something genuinely wrong — per-image signed-URL round trips, a redundant action, full-size thumbnails decoded on first paint — and none of them touched the dominant cost, because none had been measured against the actual traffic. The answer only appeared after grouping the logs by HTTP method, which nothing in the code review would have suggested: the expensive requests were the ones carrying no application logic at all. Cold start was a plausible theory and was refuted by the data (requests after a >60 s gap were the *fastest* bucket), which is worth recording precisely because it sounded right.
**Files changed:** supabase/functions/portal-api/index.ts
**Status note:** deployed and re-measured? Not yet — needs a function deploy, then the same log query to confirm OPTIONS volume collapses.

---
**Date:** 2026-09-16
**Feature:** Correction — the slowdown is platform-side, not application code
**Decision:** The preceding entry claimed CORS preflights were the cause of the 10–15 second loads. That was wrong and is corrected here. Preflight caching is kept because it halves invocation count, but it is not the cause.
**Why:** Isolating the function from the application settles it. A POST carrying no valid token — rejected with 401 before any database or application work — takes **2.0 to 21.2 seconds** to first byte, measured with curl from a different machine and network than the user's. On the same project, at the same moment, the REST API answers an equivalent 401 in **39 ms**. Supporting measurements: the runtime reports `booted (time: 43ms)`, every PostgREST query the function makes completes in 9–66 ms at origin, and `function_logs` contains no errors at all — only boots and shutdowns, roughly one isolate per request. So the function is not doing slow work; it is slow to be given the chance to work. That is Edge Functions scheduling, not our code. **Why the earlier diagnosis was wrong, and it matters for next time:** the preflight finding was real — 302 OPTIONS against 669 POSTs, and preflights genuinely doubled the request count — but I attributed their latency to module boot without checking boot time, which turned out to be 43 ms. Half a correct observation plus an unverified mechanism reads exactly like a root cause. The check that settled it was the cheapest one available and should have come first: time the endpoint directly, from outside the application, and compare it against another service on the same project.
**Files changed:** none — this entry corrects the record
**Status — confirmed by Supabase (2026-09-16).** The cause is on their side; no application change was needed or made.

**Evidence:** Supabase's status page shows **API Gateway: Degraded Performance** for 2026-09-16. Edge Functions are served through that gateway, which matches the measurements exactly: the `/functions/v1/` route degraded from 2–3 s to **8.7–18.8 s** over twenty minutes while `/rest/v1/` on the same host held at 37–44 ms throughout. Nothing in this repository can fix it. The one thing that helps meanwhile is reducing how often the portal crosses that route — which is what the preflight caching does, halving invocations, and why it is kept despite not being the cause.

---
**Date:** 2026-09-16
**Feature:** Edge function split — portal-api / portal-ai / portal-cellar with a shared core
**Decision:** Split the single 5,624-line `portal-api` by *workload weight* rather than by domain. `portal-api` keeps 158 hot-path actions and depends only on `supabase-js`; `portal-ai` takes the 11 Anthropic actions plus the document parsing they need (`jszip`, `pdf-lib`); `portal-cellar` takes the 3 CELLAR actions and the SPARQL client. Cross-cutting concerns live once in `supabase/functions/_shared/`. The browser routes on action name from a table in `assets/api.js`, deriving sibling URLs from the single configured one.
**Why:** The single function loaded every dependency on every request — `createCellarService` was instantiated at *module scope*, so a login paid for the CELLAR client. Splitting by weight rather than by domain keeps the boundary meaningful: the question "does this action need a heavy dependency" has one answer per action, whereas a domain split would have put AI document extraction and plain component CRUD in the same function because both concern components. Routing client-side rather than proxying server-side avoids an extra hop — a proxy would have kept the hot path paying for a request it only forwards. **Moved actions return 421 with `moved_to` rather than disappearing**, because the alternative is a cached client posting to `portal-api` and being told "Unknown action", which reads as a bug in the feature rather than a stale page. The gate order in `_shared/handler.ts` reproduces the original exactly — OPTIONS, POST-only, TOKEN_SECRET, JSON parse, auth — since the tests assert that a protected action is rejected *before* dispatch, and tenancy stays session-derived so a body `organization_id` remains inert. **Honest limitation, recorded because the request was framed around it:** this does not fix the 4–10 s latency observed the same day. That is a Supabase API Gateway degradation, confirmed by Supabase — a 401 touching no database took 2–21 s while REST on the same host answered in 39 ms, and module boot measures 43 ms, so dependency weight was never the bottleneck. The split is justified by what it prevents rather than what it fixes today: `portal-api` can no longer grow a parsing dependency by accident, and `tests/routing-static.test.mjs` fails the build if it does.
**Files changed:** supabase/functions/_shared/{env,http,auth,tenant,domain,timing,handler}.ts, supabase/functions/portal-api/index.ts, supabase/functions/portal-ai/index.ts, supabase/functions/portal-cellar/{index,cellar-service}.ts, assets/api.js, tests/routing.test.mjs, tests/routing-static.test.mjs, CLAUDE.md
**Status note:** built; 63 tests / 27 pass / 0 fail / 36 skipped locally. Not deployed — the new functions do not exist in production yet.

---
**Date:** 2026-09-16
**Feature:** Sortable part list
**Decision:** A Sort bar under the category chips, one control per visible field, sorting the filtered set on a copy.
**Why:** The list is card rows rather than a table, so there is no column header to click and a bar is the honest equivalent. Sorting the *filtered* set means the order shown is the order of what is listed; sorting a **copy** matters because `items` can be the same array held in `allComponents`, and sorting in place would silently reorder the source for the other tabs. Empty values sort last in *both* directions — an unset category is missing rather than ordered before "A", and reversing should not parade blanks to the top. Ties break on part number so equal rows keep a stable order between renders, which is the same instability that made `getBom`'s unordered edge query a real bug in PROP-036.
**Files changed:** assets/app.js, index.html, supplier.html, reset.html, verify.html, CLAUDE.md
**Status note:** built and statically checked; not yet exercised.

---
**Date:** 2026-09-16
**Feature:** `listAssemblies` — external endpoint for Product BOM assemblies
**Decision:** A `listAssemblies` action on `portal-api` returning `{assemblies:[{id,name}], count}`, name-sorted, **including inactive assemblies** by default. Tokens may now also be presented as `Authorization: Bearer`, in addition to the existing body `token`.
**Why:** **Including inactive is the substantive choice, and it was checked rather than assumed.** The Assemblies tab groups purely on `type === "sub_assembly"` with no lifecycle filter (`groupFiltered` in `assets/app.js`), and all three assemblies in production currently carry `lifecycle_status = 'inactive'`. Filtering them out would return an empty list while the tab shows three — an endpoint quietly disagreeing with the screen it is named after, which is worse than either behaviour chosen deliberately. `include_inactive: false` narrows it for callers who want that, so the default follows the UI and the exception is explicit. **Only `id` and `name` are returned**: a narrow contract does not break integrations when columns are added to `bom_components`, and this table has gained five columns in the last week alone. **The Bearer header is additive, not a replacement** — the body token stays the primary path so nothing existing changes, but Postman and most integration tooling reach for a header first, and the endpoint was asked for precisely to be called that way. Tenancy is unchanged and untouchable: `tdb()` scopes every query to the organization on the signed session, so a body `organization_id` remains inert here as everywhere.
**Files changed:** supabase/functions/portal-api/index.ts, supabase/functions/_shared/handler.ts, assets/api.js, tests/assemblies.test.mjs, docs/API.md
**Status note:** built and statically checked; the unauthenticated tests pass against production, the credentialed ones skip without secrets. Needs a `portal-api` deploy.


---
**Date:** 2026-09-16
**Feature:** PROP-043 — Complete the BOM node audit trail

**Decision:** Document revisions become first-class BOM node events, but only a
`drawing` revision raises the node's revision number. Every other category
(datasheet, certificate, declaration) is audited without a bump. Approval and
release state stay out of scope.

**Why:** The Change Log advertised three sources and delivered two — not a missing
feature but a false claim, since the screen asserts "this is everything that
happened." Two causes, both silent. `getComponentChangelog` selected `created_at`
from `component_documents`, which has `uploaded_at`; only `histRes.error` was
checked, so PostgREST's rejection was discarded and the merge continued with zero
document rows. Every source now reports its own failure and the handler returns
`partial: true` with `sources_failed`, which the panel renders as a warning — an
audit trail that under-reports invisibly is more dangerous than one that admits a
gap. Separately, `addDocumentVersion` wrote only to `document_versions`, so a new
drawing revision left every node referencing it untouched.

The drawing-only bump is the substantive choice. Bumping on every category would
inflate revision numbers with events that are not changes to our part — a supplier
reissuing their datasheet is a change to their document. Bumping on none would
lose the link that matters most for compliance: which drawing revision a given
component revision was built against. Drawings define the physical part; that is
the line.

Migration 0031 must be applied *before* the deploy. The history insert is
deliberately non-fatal — an audit write must never block the upload it records —
so an unwidened CHECK would reject `document_revised` inside the try/catch and the
rows would vanish silently, recreating exactly the defect being removed.

Approval workflow was declined deliberately: `document_versions` has no status
column, and designing draft/review/released is its own proposal. Holding a
one-line column fix hostage to that design would have left the trail broken.

**Files changed:** supabase/migrations/0031_audit_document_revisions.sql,
supabase/functions/portal-api/index.ts (getComponentChangelog,
bumpComponentRevision extracted, recordDocumentRevision added, addDocumentVersion),
assets/app.js (document_revised badge, partial-source warning),
docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, index.html, supplier.html,
reset.html, verify.html, CLAUDE.md (v233 → v234)

---
**Date:** 2026-09-16
**Feature:** PROP-044 — Revise a drawing from the part

**Decision:** The part's Documents tab becomes the single screen for a drawing's
whole life — attach, see its revision, revise it. The Documents library stays as
the shared store, but is no longer a required stop. When a revision is uploaded
from a part, only *that* part's link advances to the new revision; other parts
linking the same document keep theirs and display a "newer revision available"
marker.

**Why:** The user could not find where to upload drawings. That was not a gap in
their understanding — production held zero `component_documents` rows, so the
flow had never been completed by anyone. Attaching happened on the part and
revising happened in a different top-level tab, with neither screen referencing
the other, and PROP-043's audit trail hung entirely off the unreachable half.

The link-advance rule is the substantive choice. Advancing every linked part
would silently change which drawing a part is built against, for parts whose
owner never asked — the failure mode is invisible and lands in a compliance
record. Advancing none would show the row as stale the instant the user revised
it from that very row, which reads as a bug. Advancing only the originating part
follows the one intent that is unambiguous, and turns the others into a visible
decision rather than a silent substitution.

Consequences are stated before the upload, not after. The drawing-only bump from
PROP-043 is only defensible if the user sees it coming at the moment it applies;
a rule that surprises people after the fact is indistinguishable from a bug. For
the same reason the outcome replaces the modal instead of firing a toast — a
revision bump changes the part's identity and should not vanish on a timer.

**Two PROP-043 defects fixed here:** `addDocumentVersion` passed `body.version`
to the audit, which is empty whenever the version is auto-numbered — the default
path — so every auto-numbered note read `v2 → new revision`. And the prior
revision was read from an unordered query filtered by version label, so an
arbitrary row was named as superseded, and a repeated label would drop the real
predecessor along with the new row. `insertDocumentVersion` now returns the
resolved label and the new row id; the lookup is ordered by `created_at` and
matched by id.

**Files changed:** supabase/functions/portal-api/index.ts (insertDocumentVersion,
addDocumentVersion, recordDocumentRevision, getComponentDocuments),
assets/app.js (panel Documents tab: revision column, shared-with column,
New revision modal, instructive empty state, tab count),
docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, index.html, supplier.html,
reset.html, verify.html, CLAUDE.md (v234 → v235)

---
**Date:** 2026-09-16
**Feature:** PROP-045 — Drawings as a first-class domain

**Decision:** Drawings get four tables, a top-level DRAWINGS tab, letter
revisions and an approval state. They do **not** reuse `document_versions`.
Suppliers can read drawings by default, gated through a single choke point.
`drawing` is removed from the component-document categories.

**Why not reuse `document_versions`:** the IDEAS entry proposed exactly that,
and reading the code showed it was wrong. `documents` drives the Documents
Library list, so a shared table would put every drawing back into the library
this carve-out exists to empty. It would also create two version chains over
one file — the drift risk the entry flagged and then walked into. What is
genuinely shared is the upload mechanism: same storage bucket, same signed-URL
action. Sharing the mechanism is not sharing the model. Drawing revisions are
letters, so `v1`/`v2` auto-numbering was never a saving either.

**Why suppliers see drawings, and how to take it back:** manufacturing partners
cannot build from a drawing they cannot open, so `is_supplier_visible` defaults
TRUE. The design constraint was the stated next step — selective access per
supplier — so every drawing read goes through `supplierDrawingScope`. Making it
selective is one function rather than an audit of every query for a forgotten
filter, which is the shape these mistakes actually take. Three levels of
switch-off, in descending cost: one constant kills the feature, one column
withholds one drawing with no deploy, and the future per-supplier table changes
one function. `drawingFileUrl` re-checks the parent drawing, because checking
only the revision row would serve the bytes of a drawing the supplier cannot
see listed. A withheld drawing answers 404, not 403 — a 403 confirms it exists.

**Why the old path is deleted rather than deprecated:** leaving `drawing` in the
document categories would let the weaker record be created by accident, and
muscle memory beats advice. Removing the option removes the failure.

**Why `drawing_dimensions` ships empty:** the AI extraction is imminent, and
this way it adds behaviour instead of schema. More importantly a tolerance
stack-up is an ordered path across dimensions on several drawings for several
parts — it needs a row type to reference at all. That requirement is precisely
what the 2026-09-02 entry did not anticipate when it concluded "drawing
intelligence is NOT a new tab or module", and it is why that conclusion no
longer holds.

**Found while building:** a table missing from `TENANT_TABLES` passes through
`makeTdb` unscoped — every tenant reads every row, and nothing errors. There was
no guard. `tests/tenant-tables.test.mjs` now asserts every migration-created
table carrying `organization_id` is listed; on its first run it flagged nine,
of which six were tables dropped by later migrations and three are account
tables that cross the tenant boundary by design, now allowlisted with reasons.

**Files changed:** supabase/migrations/0032_drawings_domain.sql,
supabase/functions/_shared/tenant.ts, supabase/functions/portal-api/index.ts
(8 actions + supplierDrawingScope, nextRevisionLetter, writeBomHistory,
recordDrawingEvent), assets/app.js (renderDrawings, openDrawingDetail,
addDrawingRevisionModal, newDrawingModal, part-panel Drawings tab, changelog
badges, drawing removed from CATS), index.html, supplier.html,
tests/tenant-tables.test.mjs, tests/drawings.test.mjs,
docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md, reset.html, verify.html,
CLAUDE.md (v235 → v236)

---
**Date:** 2026-09-17
**Feature:** PROP-046 — Node-first drawings, system-owned identity

**Decision:** The drawing creation flow starts from the BOM node (or an explicit
"free drawing"), takes the file in the same modal, and has the system assign both
the drawing number and the revision letter. The supplier's number, revision and
file name are recorded alongside, and nothing keys off them.

**Why:** PROP-045's modal asked the user to type a drawing number before it would
accept a file. Two consequences, both structural rather than cosmetic. Our
record's identity became whatever the supplier called the drawing, so changing
supplier meant carrying a dead supplier's numbering forever or renumbering and
breaking the trail. And the BOM node — the thing the entire compliance trail
hangs from — was reached last, after the drawing already existed.

Inverting it makes the first question the one that matters, and makes the
identity fields disappear from the form entirely. This is not a new pattern:
`bom_components` has always generated `part_number` and recorded `oem_number`
as the supplier's. Drawings were the outlier. Applying the same split one level
down means the team already understands it.

**Why adoption refuses an owned drawing:** re-homing a controlled drawing from
one part to another rewrites what a released revision was built against. That is
a real operation with real consequences and it deserves its own deliberate path;
letting it happen quietly inside "adopt" would make a destructive change look
like a tidy-up.

**Why AI cannot be load-bearing here:** `extractDrawingMeta`'s key enum has no
entry for our drawing number or our revision, so it is structurally incapable of
setting them — a misread is a typo, never a broken trail. The flow also
completes with zero extracted fields, which is the property that matters most:
drawings arrive as scans often enough that an AI-dependent modal would block
work outright. Extraction makes saving faster; it is never the reason saving is
possible.

**Why haiku:** reading a title block is exactly the metadata task CLAUDE.md says
opus must not be used for. Introducing `META_MODEL` also surfaced that *every*
AI call in the codebase has been running on opus, including several the same
rule covers. Those are recorded in ROADMAP rather than retrofitted here, because
changing five call sites while building a sixth is how two changes become one
unreviewable diff.

**On the existing row:** one drawing was created while testing PROP-045, with a
hand-typed number. The migration preserves that number as
`supplier_drawing_number` and makes it a free drawing rather than deleting it.
Discarding a user's row to tidy a migration is not a trade this system should
make, even for obvious test data.

**Files changed:** supabase/migrations/0033_drawing_ownership.sql,
supabase/functions/_shared/env.ts (META_MODEL),
supabase/functions/portal-ai/index.ts (extractDrawingMeta),
supabase/functions/portal-api/index.ts (createDrawingWithRevision, adoptDrawing,
generateDrawingNumber, listDrawings, moved-action guard),
assets/api.js (HEAVY_ROUTES), assets/app.js (three-step newDrawingModal,
adoptDrawingModal, register free filter + owner/supplier columns, detail
identity block, part-panel entry point, drawing_adopted badge),
tests/drawings.test.mjs, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md,
index.html, supplier.html, reset.html, verify.html, CLAUDE.md (v236 → v237)

---
**Date:** 2026-09-17
**Feature:** PROP-047 — Drawing viewing, one surface, file first

**Decision:** A drawing opened from a part replaces that part's panel rather
than opening over it, with a breadcrumb back. The file renders inside the
portal, taking the column that grows, and selecting a revision swaps it in
place. `viewer.js` gained `render(target, doc)` so one renderer serves both the
Library modal and the embedded surface.

**Why replace instead of stack:** three surfaces existed for one object — the
part panel, a drawing dialog over it, and the file in a browser tab outside the
portal. Each was full-screen, so closing one dropped the user into another they
had forgotten was open. Stacking is only coherent when the thing on top is
subordinate to the thing beneath; a drawing is not subordinate to a part, it is
a different subject, so it takes the surface and offers a way back.

**Why the file gets the space:** a drawing is mostly its drawing. The previous
layout gave a full screen to fields and put the file one more click away, in
another tab — which is backwards for a record whose entire content is the
image. The metadata became a 300px rail, collapsing below the drawing under
900px, because a fixed rail beside a shrinking viewer leaves neither usable.

**Why `render()` returns its disposer rather than storing it:** `viewer.js`
keeps a module-level `cleanup` slot on the assumption of one viewer at a time.
An embedded render writing to that slot would mean closing the Library modal
revokes the embedded drawing's blob URL, and the drawing goes blank with no
error. Returning the disposer lets both exist, and lets the surface dispose the
previous revision on every swap instead of leaking a blob per revision viewed.

**Image support was not an extra:** png/jpg/tiff fell through to "no inline
preview". Supplier drawings arrive as scans and photographs at least as often
as PDFs, so the format most likely to need a preview was the one that had none.

**Deliberately excluded:** row thumbnails. They need generation and caching — an
A0 assembly PDF is tens of megabytes, and a naive per-row render would fetch
every drawing on every list paint. Doing them properly means a migration and a
cache; doing them badly would make the list slower than the problem they solve.

**Files changed:** assets/viewer.js (render extracted, images, both exported),
assets/app.js (openDrawingSurface replaces openDrawingDetail; part panel mounts
it in place with a breadcrumb; register opens it standalone; row action renamed
to View), assets/styles.css (.drawing-surface and rail, .viewer-image),
tests/drawing-viewing.test.mjs, docs/SYSTEM_OVERVIEW.html, docs/ROADMAP.md,
index.html, supplier.html, reset.html, verify.html, CLAUDE.md (v246 → v247)

---
**Date:** 2026-09-21
**Feature:** PROP-049 — Parts workbook with pictures
**Decision:** Add ExcelJS as a second, lazy-loaded Excel writer for the parts catalogue export, and keep SheetJS for the flat/structure exports.

**Why:** The request was pictures in the Excel export. SheetJS cannot write images — not at 0.18.5, not at any version of the community build — so this was never a matter of passing another option to the existing writer. The choices were ExcelJS (948 KB), hand-assembling the xlsx zip with drawing XML, or `=IMAGE()` formulas.

`=IMAGE()` was ruled out first: it is Excel 365 only and needs a publicly reachable URL, while component images live in a private bucket behind signed URLs that expire in an hour. A workbook of dead links after lunch is worse than no pictures. Hand-assembling the zip would avoid the dependency but puts the OOXML drawing relationships in our maintenance path for one feature.

ExcelJS is 948 KB, which is not free — but it is fetched only when the button is pressed, from the same CDN pattern as the four libraries already lazy-loaded here, so it costs nothing on page load and nothing for anyone who never exports. Both writers coexist deliberately: the catalogue export is *a list of parts*, where each part is a thing with a photo; the Status Overview export is *a structure*, one row per occurrence, where a component used four times would carry its photo four times.

Two things were settled by running the code rather than reading the API. Sheet naming is the fragile part — Excel rejects the entire workbook for one illegal, blank, over-31-character or duplicated name, and a 64-part export is 64 chances to produce one — so `uniqueSheetName` was exercised against every forbidden character, blanks, nulls, 60-character names, repeated duplicates and the reserved name "History", and those cases are now tests. And reading a generated workbook back showed `wb.addImage()` appending a fresh media entry per call: embedding per sheet put identical bytes in the file twice. Registering each picture once and referencing the id from both sheets halved it.

`BOM_DETAIL_COLUMNS` exists as a separate seam from `BOM_EXPORT_COLUMNS` so per-part detail can grow without widening the Summary sheet — but it is deliberately limited to fields `listComponents` already returns, because a label with nothing behind it reads as "this part has no supplier" rather than "the export never carried that field". Specs, drawings and documents need a batched `getComponentDetail` action first; that is recorded in ROADMAP.

**Files changed:** assets/app.js, tests/export.test.mjs, docs/ROADMAP.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md, index.html, reset.html, verify.html, supplier.html, CLAUDE.md

---
**Date:** 2026-09-24
**Feature:** PROP-050 — Add-child picker: pictures and a resizable dialog
**Decision:** Promote `thumbMap` to module scope and give the dialog CSS `resize: both` with a flex layout, rather than passing thumbnails in as an argument or building a custom drag handle.

**Why:** Both halves of this had an obvious heavy answer and a cheaper correct one.

For the pictures, `thumbMap` was declared inside `bomTreeView`, and `openAddChildModal` is a sibling function rather than a nested one — so it could not see it. This codebase has already hit and solved exactly this, twice: `parentCountMap` and `partCategories` are module-scoped with a comment saying why. Threading thumbnails through the call site would have made a third pattern for the same problem. A test now pins the single declaration, because a re-introduced local would shadow the shared map and the picker would silently show no pictures at all — working code, empty result.

For the resizing, the native CSS handle is free and behaves the way people expect, so the work was not the dragging but making the extra height go somewhere useful: the dialog is a flex column, the picker is `flex: 1` instead of `max-height: 200px`, and the header and buttons are pinned. Dragging the dialog taller now lengthens the list rather than adding whitespace. One trap: `syncTabs` toggled the section with `style.display = ""`, which clears the property and drops it back to `block` — switching to *Create new* and back would have quietly broken the stretch. It sets `"flex"` explicitly, and that is a test.

Size is remembered in `localStorage` — a per-viewer convenience, which is what that store is for — with every read and write guarded, because it throws outright in a private window or with site data blocked, and an unguarded read would stop the dialog opening at all. The `ResizeObserver` disconnects when the dialog leaves the document.

`thumbBox()` also handles the case nobody would have reported until it looked broken: these are signed URLs that expire after an hour, so a page left open overnight would have shown a column of broken-image glyphs. The box is drawn first and the image placed inside it, so the fallback is the same cell either way.

**Files changed:** assets/app.js, tests/dialog-chrome.test.mjs, docs/ROADMAP.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md, index.html, supplier.html, reset.html, verify.html, CLAUDE.md

---
**Date:** 2026-09-24
**Feature:** PROP-051 — Add several children at once
**Decision:** Multi-select with a per-part tray carrying its own quantity and reference designator; validate the whole batch before writing anything; write the edges sequentially.

**Why:** Three choices in this, and each had a tempting cheaper version.

*Per-part quantity.* The obvious implementation keeps the existing single Quantity box and applies it to everything selected. That is wrong for the actual work: two legs and eight screws under the same panel is the normal case, and a shared quantity would have made multi-select produce incorrect BOMs rather than merely limited ones. Quantity and reference designator describe the **edge**, not the part, so they moved into the tray rows. The shared pair still exists, but now belongs to the *Create new* tab alone — two quantity boxes disagreeing about one edge is worse than one in an awkward place.

*Validate everything first.* A loop that validates each row as it writes would create three edges and then reject the fourth for a blank quantity, leaving the tree half-changed with the dialog still open over it and no clear way to tell what happened. The batch is now checked in full before the first request.

*Sequential writes.* This is correctness, not taste, and it was worth reading the server to establish: `addBomEdge` derives `sort_order` by selecting the current maximum among siblings and adding ten. `Promise.all` would have every call read the same maximum and land several children on the same position. Sequential writing also means children appear in the order they were picked.

Partial failure is reported rather than swallowed: the dialog says how many of how many were added, names the one that failed, and removes the successful ones from the tray — otherwise the natural retry (press the button again) duplicates every edge that already succeeded.

`submitBtn` moved above its old position beside the footer, because `paintTray()` sets its label during setup and a `const` used before its declaration throws. That ordering is a test; this file has hit the temporal dead zone three times.

Still open, recorded in ROADMAP: the picker offers parts that are already children of this parent. The server rejects the duplicate edge and the per-row error now surfaces it, but marking them unpickable needs the parent's current edges, which the modal is not given.

**Files changed:** assets/app.js, tests/dialog-chrome.test.mjs, docs/ROADMAP.md, docs/SYSTEM_OVERVIEW.html, docs/DECISIONS.md, index.html, supplier.html, reset.html, verify.html, CLAUDE.md
