# Rushroom — Feature Ideas
_Raw ideas not yet turned into proposals. Add new ideas with /ideate._

---
### Product Information System — Vertical Integration Engine — 2026-08-25
_Revised 2026-08-25 (iteration 3): added cost simulation layer, component lifecycle statuses, cost maturity levels, and visual costing canvas._

**One sentence:** An unbounded-depth Bill of Materials with lifecycle statuses at every node, a named scenario/simulation layer for early NPD cost modelling, and a live visual canvas that lets anyone with access drag inputs and instantly see how COGS changes — all sitting on top of a BI cost-intelligence layer that feeds into but never replaces the procured financial ERP.

**Problem it solves:**  
*Compliance side:* REACH/RoHS and technical documentation today live at the product level (`product_passports`). Regulators increasingly expect substance data per article/component. A supplier changing one LED component can invalidate test reports or breach SVHC thresholds — but today there is no way to know which product version is affected or what share of COGS that component represents.

*Vertical integration side:* Without cost visibility at every assembly level, make-vs-buy decisions are gut feel. The system should answer "if we built this sub-assembly ourselves instead of buying it, what would the cost delta be?" at any node in the tree.

*NPD simulation side:* In early product development, most cost figures are estimates or rough quotes. Engineers and product managers need to explore "what if" questions — what if we swap the LED strip supplier? what if we bring the PSU in-house? — before any firm quote exists. Today this lives in a spreadsheet that no one keeps current. The simulation layer makes this an interactive, shared, version-tracked workspace with live visual feedback. The status model tells you exactly how confident each number is and how mature each component decision is.

*Landed cost:* Freight, duty, and currency effects are invisible. They live in the ERP-to-be or in someone's head. The BI layer captures these as explicit factors so they can be included in simulations and flagged clearly as estimates.

**Architecture intent:**  
Three layers, each with a clear role:

1. **PLM core** — system of record for physical product structure, component specs, versions, compliance data, and raw prices. Lives in Supabase. Append-only versioning throughout.

2. **BI / simulation layer** — derives landed costs, COGS rollups, and buy-vs-make deltas from the PLM core data. Named scenarios (`cost_scenarios`) let users fork the cost model, override any dimension, and compare results. The outputs are labelled directional intelligence, not accounting truth.

3. **ERP (procured, future)** — owns invoices, payments, P&L. This platform feeds it via `external_ref` fields on cost rows. When the ERP is live, it becomes authoritative for `actual` cost maturity rows; this system remains the home for estimates, simulations, and compliance data.

Financial accounting does not live here. Visual decision support does.

**Component lifecycle status** (mirrors the compliance portal's step statuses):  
`bom_components.lifecycle_status`: `concept` → `specified` → `sourcing` → `approved` → `released` → `obsolete`  
These are the engineering gates. A component moves right as decisions are made and evidence collected.

**Cost maturity** (the confidence dimension on every price):  
`component_costs.cost_maturity`: `estimate` | `budgetary_quote` | `firm_quote` | `contracted` | `actual`  
The visual layer always shows cost maturity alongside every number — a COGS built from estimates looks different (amber, uncertainty band shown) than one built from contracted prices (green, no band).

**MVP scope:**  
1. **`bom_components`** — node table: `id`, `organization_id`, `part_number` (unique per org), `name`, `description`, `type` (raw_material | purchased_part | sub_assembly | finished_good), `unit_of_measure`, `revision`, `lifecycle_status` (concept | specified | sourcing | approved | released | obsolete), `created_at`.  
2. **`bom_edges`** — tree structure: `parent_id → bom_components`, `child_id → bom_components`, `quantity NUMERIC`, `reference_designator`, `effective_from`, `effective_to`. Unique on `(parent_id, child_id, effective_from)`. Unlimited depth; reuse of the same component in multiple assemblies is supported.  
3. **`bom_component_versions`** — immutable spec history (same pattern as `document_versions`).  
4. **`component_materials`** — substance rows per component: substance name, CAS, % w/w, REACH/RoHS status, SVHC flag.  
5. **`component_documents`** — documents per component with `category` enum (datasheet | drawing | test_report | declaration | quality_cert), FK → `document_versions`.  
6. **`component_costs`** — pricing rows: `component_id`, `supplier_name`, `unit_price NUMERIC`, `currency CHAR(3)`, `moq`, `effective_date`, `quote_reference`, `cost_maturity` (estimate | budgetary_quote | firm_quote | contracted | actual), `external_ref` (ERP line-item ref, populated when ERP goes live). Multiple rows per component for multi-supplier comparison. **Internal only.**  
7. **`landed_cost_factors`** — BI inputs per component: `factor_type` (freight | duty | currency_adjustment | overhead), `value NUMERIC`, `unit` (percent | fixed_amount), `currency`, `effective_date`, `notes`.  
8. **`cogs_snapshots`** — append-only COGS rollup: `root_component_id`, `scenario_id` (null = production BOM), `snapshot_date`, `total_cogs NUMERIC`, `currency`, `confidence_label` (computed from worst cost_maturity in the tree), `detail JSONB` (full tree breakdown with per-node contribution and maturity).  
9. **`cost_scenarios`** — named simulation workspaces: `id`, `organization_id`, `name`, `description`, `base_component_id` (BOM root), `status` (draft | published | archived), `created_by`, `created_at`. Scenarios are never the production BOM — they are what-if explorations.  
10. **`scenario_overrides`** — per-scenario, per-component overrides: `scenario_id`, `component_id`, `override_type` (unit_price | quantity | lifecycle_status | sourcing_mode | landed_factor), `value JSONB`. A scenario is the production BOM + this diff. Multiple overrides per component per scenario are allowed.  
11. **API actions:** `getBom`, `addComponent`, `updateComponent`, `setComponentStatus`, `getComponentHistory`, `addBomEdge`, `removeBomEdge`, `addComponentDocument`, `getComponentMaterials`, `upsertComponentMaterial`, `getComponentCosts`, `upsertComponentCost`, `upsertLandedCostFactor`, `computeCogs`, `compareCogs`, `createScenario`, `updateScenario`, `applyScenarioOverride`, `getScenarioResult` (returns full costed tree for the scenario), `listScenarios`, `archiveScenario`.  
12. **Supplier-facing:** can upload to `component_documents`; cannot read `component_costs`, `landed_cost_factors`, `cogs_snapshots`, `cost_scenarios`, or `scenario_overrides`.  
13. **Visual layer — "Product" tab, three sub-tabs:**  
    - **BOM tree view:** collapsible unlimited-depth tree. Each node shows lifecycle status badge (same colour system as compliance portal step statuses) and cost maturity badge. Nodes coloured by cost contribution as % of root COGS (heat-map: cool = small share, warm = large share). Click a node → component detail slide-in.  
    - **Cost canvas (simulation):** select a scenario or start from production. Controls: swap supplier, override unit price, change quantity, toggle sourcing mode (buy ↔ build-from-sub-BOM). Charts update live on every keystroke (client-side computation on the fetched tree — no round-trip for interactive edits; snapshot saved on explicit "Save").  
      - *Sorted cost bar:* all leaf components sorted by landed cost contribution, bars segmented by cost factor type (unit price, freight, duty, currency). Amber fill = estimate maturity; green = contracted.  
      - *Treemap:* hierarchical COGS breakdown by BOM level and type.  
      - *Scenario comparison:* side-by-side total COGS bars for up to 4 scenarios simultaneously.  
      - *Confidence band:* when any component in the tree is at `estimate` or `budgetary_quote` maturity, the total COGS figure shows a ±% uncertainty band derived from the proportion of estimated cost in the tree.  
    - **Status overview:** dashboard of lifecycle status distribution across the BOM (how many components are still at concept? how much of COGS is estimate vs firm quote?) — mirrors the compliance portal's action-plan progress view.

**Tables involved:**  
New: `bom_components`, `bom_edges`, `bom_component_versions`, `component_materials`, `component_documents`, `component_costs`, `landed_cost_factors`, `cogs_snapshots`, `cost_scenarios`, `scenario_overrides`  
Extended: `product_passports` (add FK `root_component_id → bom_components`)  
All new tables: `organization_id NOT NULL FK → organizations` (PROP-012 contract)

**Effort estimate:** 80–100 hours  
- Schema + migrations (10 new tables): 10 h  
- Recursive BOM CTE + core API actions (~20 actions): 20 h  
- Scenario system (create, override, resolve, snapshot): 12 h  
- Landed cost + COGS compute + confidence band logic: 10 h  
- Access-control (cost/scenario hiding, supplier gate): 6 h  
- UI — BOM tree with status badges + heat-map: 14 h  
- UI — Cost canvas (live simulation, 4 chart types): 20 h  
- UI — Status overview dashboard: 6 h  
- Tests: 10 h

**Risks:**  
- **Recursive query performance:** Materialise COGS into `cogs_snapshots` — never compute the full tree live. Load tree view 3 levels deep eagerly, expand on demand. Index `bom_edges` on `(parent_id, effective_to)`.  
- **Cycle prevention in `bom_edges`:** Enforce via a Postgres trigger that walks ancestors before insert. Without this, a recursive CTE on a cyclic graph is infinite.  
- **Simulation accuracy vs. false confidence:** The confidence band on estimates helps, but users must understand this is directional. Every simulation result must carry a `confidence_label` and a disclaimer. Do not label any simulation output "actual cost."  
- **Client-side simulation state:** Live chart updates happen on the client (no round-trip per keystroke). This requires the full costed tree to be held in memory on the client side. For large BOMs this may be expensive — lazy-load deep nodes, pre-compute sub-tree COGS server-side.  
- **Supplier visibility rules:** Every action handler returning component data must explicitly strip cost/scenario fields for supplier sessions at the edge function level — not in the UI.  
- **ERP sync boundary:** `component_costs.external_ref` is the future sync anchor. When the ERP goes live, decide whether ERP is authoritative (it pushes `actual` rows here) or this system is (it exports here to ERP). Design for the former.  
- **Chart library choice:** Vanilla JS + Chart.js handles bars and lines well. The treemap and BOM heat-map need custom SVG — do not reach for a heavy framework. Keep charting lightweight and self-contained.  
- **Status model discipline:** Lifecycle statuses only move forward (concept → released) by explicit user action, not automatically. Reversions (e.g. released → sourcing after a component re-qualification) must be tracked in `bom_component_versions` with a reason. This mirrors how the compliance portal handles step status changes.

**Related PROPs:**  
- PROP-001 (Level 2 / Passports — `product_passports` anchors to the BOM root; DPP can draw substance data from `component_materials`)  
- PROP-011 (Requirement Links — component documents link to standard clauses; full component→clause traceability for the Technical File)  
- PROP-012 (Multi-tenancy — all new tables carry `organization_id`; cost and scenario data are the most sensitive per-tenant data)

**Status:** Implemented as PROP-013 (2026-08-25)

---
### Compliance–BOM Integration: Component Evidence Bridge — 2026-08-25
**One sentence:** A typed evidence layer that links specific BOM component versions to the standard clauses they satisfy — with lab test report version management — so that a component revision automatically surfaces which compliance requirements need re-evidencing.

**Problem it solves:**  
The compliance portal today knows *which documents* interpret *which clauses* (`as_operates_interpretations`: `clause_id × document_version_id`). The BOM system will know *which components* exist and what their specs are. But neither system knows the critical link between them: **which component version is the physical thing that a test report was run on, and which standard clause does that test cover?**

Without this bridge:
- A lab test report uploaded as evidence for step 10 ("arrange LVD testing") is just a file. There is no machine-readable record of what component it tested or which clause it covers.
- When the LED strip assembly is revised (new `bom_component_versions` row), no system signals "your LVD test for EN 60598 clause 8.3 was on the old component — you may need to retest."
- A product manager cannot ask "which requirements does changing this component put at risk?" without manually reading all test reports.
- The Technical File audit trail (CE marking) cannot be automatically generated — the component→test report→clause chain is in someone's head.

This is the traceability layer that turns the BOM and the compliance portal into one coherent product record.

**Architecture intent:**  
A new `component_clause_evidence` table is the bridge:
```
bom_component_versions ──┐
                          ├── component_clause_evidence ── document_versions (test report)
standard_clauses ─────────┘
```
This is distinct from `as_operates_interpretations` (which links *documents* to *clauses* — a document-level interpretation) and from PROP-011's `requirement_links` (which links *text units* to *text units*). Component evidence links a *physical object at a specific revision* to a *requirement*, with an evidence document.

A Postgres trigger on `bom_component_versions` INSERT copies all `component_clause_evidence` rows for the previous version of that component to the new version with `status = pending_retest`. This is the automated re-test signal — no manual triage needed.

Lab test reports are a specific subtype of `component_documents` (planned in PIS). They carry additional structured fields: test lab name, accreditation number, test date, and test scope. These fields live as nullable columns on `component_documents` gated by `category = 'test_report'` — no separate table needed.

**MVP scope:**  
1. **Extend `component_documents`** (from PIS) with nullable test-report fields: `test_lab VARCHAR`, `accreditation_number VARCHAR`, `test_date DATE`, `test_scope TEXT`. Only populated when `category = 'test_report'`. No new table — these extend the existing row.  
2. **`component_clause_evidence`** — the bridge table:  
   - `id`, `organization_id NOT NULL`  
   - `component_version_id FK → bom_component_versions`  
   - `clause_id FK → standard_clauses`  
   - `document_version_id FK → document_versions` (the test report or declaration — must already exist in the document library)  
   - `evidence_type` ENUM: `lab_test_report | supplier_declaration | self_assessment | cert_of_conformity | type_approval`  
   - `coverage_scope TEXT` — what this evidence specifically demonstrates (e.g. "insulation resistance at 500V DC per clause 8.3.1")  
   - `status` ENUM: `valid | pending_retest | superseded | withdrawn`  
   - `reviewed_by UUID FK → users`, `reviewed_at TIMESTAMPTZ`  
   - `created_at`, `created_by`  
   - Unique on `(component_version_id, clause_id, document_version_id)`  
3. **Postgres trigger on `bom_component_versions` INSERT** — when a new version row is created for a component, SELECT all `valid` evidence rows with `evidence_type = 'lab_test_report'` for the previous version of that component and INSERT copies for the new version with `status = pending_retest`. Other evidence types (supplier_declaration, self_assessment, cert_of_conformity, type_approval) are NOT copied — they remain on the previous version only and must be explicitly re-linked if still applicable. Lab test reports are revision-specific; the others are evaluated case by case.  
4. **API actions:** `addComponentEvidence`, `updateEvidenceStatus`, `getComponentEvidence` (all evidence for a component version), `getClauseEvidence` (all component versions covering a clause), `listPendingRetest` (all `pending_retest` rows for the org — the re-test work queue), `dismissPendingRetest` (marks a specific evidence as `valid` again with a reason — for when the component change was irrelevant to that test).  
5. **Compliance portal integration — clauses view:** new "Component evidence" column on the standard clauses table. Shows a green tick (all linked component versions have `valid` evidence), amber warning (`pending_retest` exists), or blank (no component evidence — clause is covered at the document/product level only). Click the badge → evidence chain modal: component version → evidence type → test lab → test date → document.  
6. **BOM integration — component detail panel:** "Requirements covered" section lists every clause this component version has evidence for, with status badge and link to the evidence document. The lifecycle status transition `approved → released` surfaces a warning if any linked clause has `pending_retest` evidence (but does not block — engineer decides).  
7. **Re-test work queue view** — a dedicated panel (accessible from both the compliance tab and the BOM tab) listing all `pending_retest` evidence rows, grouped by component, with inline action to upload a new test report, link it, and mark as resolved.

**Tables involved:**  
New: `component_clause_evidence`  
Extended: `component_documents` (add test-report fields), `bom_component_versions` (trigger added)  
Read: `standard_clauses`, `document_versions`, `bom_component_versions`, `as_operates_interpretations` (for side-by-side display)  
All new tables: `organization_id NOT NULL FK → organizations` (PROP-012 contract)

**Effort estimate:** 28–36 hours  
- Schema + migration (`component_clause_evidence`, extend `component_documents`): 4 h  
- Postgres trigger (retest copy on new version): 3 h  
- API actions (6 new actions): 10 h  
- Compliance portal UI — clause evidence column + modal: 8 h  
- BOM UI — "requirements covered" section on component detail: 5 h  
- Re-test work queue view: 6 h  
- Tests: 4 h

**Risks:**  
- **Evidence explosion / noise:** A product may have 30 standards × 100+ clauses. Most clauses are not tested at the component level — they are evidenced by a product-level document (the DoC, the Technical File). Adding the component column to every clause would be mostly blank and confusing. Mitigate: only show the "Component evidence" column when at least one evidence row exists for clauses in that standard. Alternatively, let clauses be tagged `component_linked` (boolean) to opt in.  
- **Scope confusion with `as_operates_interpretations`:** An `as_operates_interpretations` row says "document version D interprets clause C as compliant." A `component_clause_evidence` row says "component version V is the physical thing tested to satisfy clause C, as evidenced by document D." These are different but both end up pointing at a clause. The UI must present them as complementary, not competing.  
- **Retest dismissal accountability:** `dismissPendingRetest` requires a written reason and is logged in `platform_audit` — this is the CE liability paper trail. MVP: single reviewer can dismiss (the person doing the assessment). Design for multi-reviewer later: the `component_clause_evidence` table should include a nullable `second_reviewer_id FK → users` and `second_reviewed_at` from day one, left null in the MVP. When the second-reviewer gate is activated, `dismissPendingRetest` sets status to `pending_second_review` (not directly to `valid`), and a second action `confirmRetest` finalises it. The enum status set must include `pending_second_review` in the schema even if the MVP never enters it.  
- **Test report traceability to storage:** A test report in `component_clause_evidence` references a `document_versions` row, which has a `storage_path` in the `documents` bucket. The upload flow for a test report (via the PIS component detail panel) must ensure the file ends up in the right bucket with a signed URL, same as the existing document upload flow.  
- **Cross-compliance scope:** A single test report (e.g. a combined LVD + EMC test report from a lab) may cover multiple clauses across multiple standards for the same component. `component_clause_evidence` supports this naturally — one `document_version_id` can appear in multiple rows with different `clause_id` values. The UI must make this easy to batch-link (select a test report, then tick all clauses it covers).

**Related PROPs:**  
- PIS / Vertical Integration Engine idea (above) — depends on `bom_component_versions` existing  
- PROP-001 (Level 2 / Passports — the `product_passports` DPP will eventually pull the full component evidence chain for ESPR Article 7 technical documentation)  
- PROP-011 (Requirement Links — `requirement_links` links text units to text units; `component_clause_evidence` links physical objects to requirements; complementary, not overlapping)  
- PROP-012 (Multi-tenancy — `organization_id` on all new tables; test reports are highly confidential per-tenant data)

**Status:** Raw idea

---
### Configure-to-Order Variant BOM (Product Families) — 2026-08-28
**One sentence:** Replaces the single-product BOM root with a Product Family node that defines configuration attributes (Size, Power, Color…), then uses conditional edges in the BOM tree to express which components are included for which combination — so one tree serves thousands of configurations without duplication.

**Problem it solves:**  
Rushroom sells configurable LED furniture: the same family ships in multiple sizes, power ratings, colors, and mounting options. With the current BOM model, every distinct configuration would need its own complete tree — hundreds or thousands of trees, all nearly identical. A single component change (e.g., new LED strip for 50 W variants) would require updating each affected tree separately, with no mechanism to check that all variants were covered. There is also no machine-readable record of which configurations share a given component, making REACH/RoHS impact analysis impossible.

The configure-to-order model solves this by storing ONE tree per product family and marking edges as either unconditional (present in all configurations) or conditional (only included when a specific attribute value is selected). The resolved BOM for any specific configuration is computed on demand — no duplication.

**Architecture: Super BOM with conditional edges**  
An edge in `bom_edges` with `variant_condition = NULL` is always included. An edge with `variant_condition = '{"Power": "50W", "Size": "L"}'` is included only when the selected configuration matches all listed conditions. `resolveVariant(family_id, selections)` runs the normal BFS but filters edges by condition match.

This means: N attributes × M values each = potentially M^N configurations, but only ONE BOM tree to maintain. Engineers author and version the family BOM; sales or compliance teams "configure" it to get a specific product BOM for a specific order or DoC.

**MVP scope:**  
1. **`bom_components.type` extension** — add `product_family` to the type enum (migration). A family node is always a root (no parent edge). UI treats it differently from `Product` (shows attribute panel instead of cost canvas).  
2. **`family_attributes`** — one row per configurable dimension per family: `{id, organization_id, family_id FK→bom_components, name, display_name, is_required BOOLEAN, sort_order}`. Example: `{name: "Power", display_name: "Power rating", is_required: true}`.  
3. **`family_attribute_values`** — valid options per attribute: `{id, organization_id, attribute_id FK→family_attributes, value, label, sort_order}`. Example: `{value: "30W", label: "30 W"}`, `{value: "50W", label: "50 W"}`.  
4. **`bom_edges.variant_condition JSONB` column** (nullable, migration, backward-compatible) — `NULL` = always included; `{"Power": "50W"}` = only when Power=50W is selected; multiple keys = all conditions must match (AND logic).  
5. **`saved_configurations`** — named resolved configurations: `{id, organization_id, family_id FK→bom_components, name, selections JSONB, description, created_by, created_at}`. Example: `{name: "Standard EU 50W White L", selections: {"Power": "50W", "Color": "White", "Size": "L"}}`. These are the units that get their own part number, DoC, and compliance record.  
6. **API actions:**  
   - `addFamilyAttribute(family_id, name, display_name, is_required)` / `listFamilyAttributes(family_id)`  
   - `addFamilyAttributeValue(attribute_id, value, label)` / `listFamilyAttributeValues(attribute_id)`  
   - `resolveVariant(family_id, selections JSONB)` — runs BFS on the family BOM, filters edges where `variant_condition IS NULL OR variant_condition <@ selections`, returns the effective component tree for that configuration  
   - `saveConfiguration(family_id, name, selections)` / `listConfigurations(family_id)` / `deleteConfiguration(id)`  
   - `addBomEdge` — extended to accept optional `variant_condition JSONB`  
7. **UI changes (Product tab):**  
   - A `product_family` root shows a "Configuration" sub-tab (attributes + valid values, editable).  
   - The `+ child` modal gets an optional "Only for configurations…" section (attribute value picker, multi-select, generates `variant_condition`).  
   - A "Configure" button on the family row opens an attribute selector; on submit, calls `resolveVariant` and renders the resulting filtered BOM tree in a read-only preview pane. An option to save this as a named configuration.  
   - The BOM tree visually distinguishes conditional edges (dashed line / grey badge showing the condition) from unconditional edges.

**Tables involved:**  
New: `family_attributes`, `family_attribute_values`, `saved_configurations`  
Extended: `bom_components.type` enum (add `product_family`), `bom_edges` (add `variant_condition JSONB` column)  
All new tables: `organization_id NOT NULL FK → organizations`

**Effort estimate:** 28–36 hours  
- Migration (enum + column + 3 new tables): 4 h  
- API actions (6 new + extend addBomEdge): 8 h  
- `resolveVariant` BFS filter logic: 4 h  
- UI — attribute definition panel on family node: 5 h  
- UI — conditional edge picker in `+ child` modal: 4 h  
- UI — Configure button + resolved BOM preview: 7 h  
- UI — saved configurations list + part-number generation per config: 4 h  
- Tests: 4 h

**Risks:**  
- **Condition logic complexity:** AND-only conditions (all keys must match) cover most real cases. OR logic (this edge is active for 30W OR 50W) requires a different schema (array of condition objects or a conditions_any_of array). Design the schema to allow this extension: `variant_condition = [{"Power": "30W"}, {"Power": "50W"}]` as an array means OR; a plain object means AND. MVP: only implement plain object (AND); leave array (OR) for later.  
- **Compliance implication per configuration:** Each `saved_configuration` is a distinct CE product (distinct DoC, distinct Technical File, distinct test scope). The system must eventually generate a per-configuration DoC and propagate compliance evidence from the family's shared components. This connects directly to PROP-014 (Component Evidence Bridge) — `component_clause_evidence` must be resolvable per configuration, not just per component.  
- **COGS per configuration:** `computeCogs` currently takes a `root_component_id`. It must be extended to accept optional `selections` so it rolls up cost only for components in the resolved variant BOM. Without this, cost simulation is meaningless for families.  
- **Part numbers on configurations:** A saved configuration needs its own part number or sales code (e.g., `RR-2026-L50W-WH`). This is separate from the family's part number and from the component part numbers inside the BOM. Design: `saved_configurations` gets an optional `part_number` column (unique per org), auto-suggested by the UI, overridable.  
- **Migration of existing BOM roots to Product vs. product_family:** Existing `Product` type roots stay as-is — they are single fixed configurations. Only explicitly created `product_family` nodes get the attribute/variant behavior. The distinction is opt-in.  
- **Variant condition validation:** When a user adds a `variant_condition` to an edge, the system should validate that all keys in the condition correspond to known `family_attributes.name` values for the ancestor family. The MVP can do this client-side; a DB constraint can be added later.

**Related PROPs:**  
- PROP-013 (Product Information System — provides the BOM foundation; this extends it without breaking existing single-product BOM trees)  
- PROP-014 (Compliance–BOM Integration — each resolved configuration is the unit that needs component clause evidence and a DoC; the evidence bridge must be variant-aware)  
- PROP-012 (Multi-tenancy — all new tables carry `organization_id`; configuration data is per-tenant and should never be cross-org visible)

**Status:** Raw idea

---
### BOM Tree — Add Sibling shortcut button — 2026-08-29

**One sentence:** Add a "+ sibling" button next to each non-root BOM row so users can add a peer node without having to locate and click the parent's "+ child" button.

**Problem it solves:** Multiple children per parent is already fully supported in the data model and API — but users don't discover it. The natural expectation is a button at the same visual level as the node you want to peer with. Currently the only way is to scroll back up, find the parent row, and click its "+ child" button.

**MVP scope:** On every non-root row, render a small "+ sibling" button alongside the existing row actions. Clicking it calls `openAddChildModal` with the **parent** of the current node as the target. No new API actions, no schema changes — pure frontend, reusing the existing `addBomEdge` flow. The parent ID is already available in the edge data loaded by `getBom`.

**Tables involved:** bom_edges, bom_components — existing, no changes needed.

**Effort estimate:** 1–2 hours (frontend only).

**Risks:** The row action area already has up to four buttons (+ child, ⚙ Configure, Details, Delete). A fifth button may crowd narrow viewports — may need icon-only style or an overflow menu for small screens.

**Related PROPs:** PROP-013 (BOM tree foundation).

**Status:** Raw idea

---
### BOM Tree UX Polish — column alignment, expand/collapse, action cleanup — 2026-08-29

**One sentence:** Fix column misalignment, add Expand All / Collapse All toolbar buttons, always show QTY, and compact the per-row action buttons so the tree is immediately readable.

**Problem it solves:** Looking at the current tree (see screenshot 2026-08-29):
- QTY shows nothing when qty=1, so the column looks broken — users don't know if quantity data is missing or just defaulted.
- STATUS badges drift slightly out of alignment because the grid column widths don't account for the tree connector varying in width at depth.
- There is no single-click way to collapse or expand the whole tree — users have to click each ▼ toggle individually on large BOMs.
- Four action buttons per row (+ sibling, + child, Details, Delete) make rows wide and visually noisy. On a 10-level BOM with 50 nodes this is overwhelming.
- The column headers (POS. / COMPONENT / QTY / STATUS / COGS) are not sticky, so they scroll off on long trees.

**MVP scope (4 specific changes):**
1. **Always show QTY** — display "1" instead of empty when qty = 1.
2. **Expand All / Collapse All** — two small buttons in the BOM Tree toolbar, next to Refresh. "Expand All" clears the collapsed Set; "Collapse All" adds every posNum with children to it.
3. **Sticky column header row** — make the POS / COMPONENT / QTY / STATUS / COGS header row `position: sticky; top: 0` so it stays visible while scrolling.
4. **Compact action buttons** — replace text labels with short symbols or a tighter layout: "⊕" (sibling), "↳" (child), "≡" (details), "✕" (delete) with tooltip titles. Or keep labels but reduce font size and padding further.

**Tables involved:** None — frontend only.

**Effort estimate:** 2–3 hours.

**Risks:** Compact icon-only buttons must still be accessible (aria-label). Sticky header requires knowing the offset from the subtab bar — use the existing `--header-h` CSS variable pattern already in the codebase.

**Related PROPs:** PROP-013 (BOM tree), PROP-016 (sibling button — already built, its button is one of the ones to compact).

**Status:** Raw idea

---
### Dynamic BOM — Order-Driven Configuration Import — 2026-08-29

**One sentence:** Rename "product_family" to "Dynamic BOM", deprecate in-portal configuration pre-building, and instead import a specific customer order's resolved BOM from the external storefront configurator — so compliance is tracked per concrete, ordered configuration rather than per hypothetical variant.

**Problem it solves:** PROP-015 assumes configurations are built and stored in the compliance portal ahead of time. In reality, Rushroom's 5m wardrobe system has 5,000+ possible configurations — the vast majority of which will never be ordered. Pre-building them in the portal wastes effort and creates phantom compliance records for products that don't exist. More importantly, compliance management must anchor to real orders: a specific customer received a specific configuration, and that configuration's components must be traceable to CE declarations, test reports, and regulatory requirements. The current model cannot do this — it tracks abstract families, not real shipped products.

**Real workflow:**
1. Customer configures a wardrobe on the storefront → order is created in the order system
2. The order system resolves the Dynamic BOM for that order (same logic as the bulk render pipeline already in Rushroom's stack)
3. The compliance portal imports that resolved BOM as a concrete configuration — linking to the component records already registered here
4. Compliance evidence (DoC, test scope, REACH declarations) is tracked against that concrete configuration

**MVP scope:**
- Rename the `product_family` type concept to "Dynamic BOM" in the UI (label change only, keep `product_family` in the DB as the type key until the full rework)
- Add a read-only "Imported Configurations" sub-view under a Dynamic BOM root that shows concretely ordered configurations (imported, not manually created)
- Build a `POST /importConfiguration` API action that accepts a minimal payload: `{ family_id, external_order_id, selections: { attr: value, … }, resolved_component_ids: [uuid, …] }` and creates a `saved_configuration` record linked to those component IDs
- Display the imported configuration as a flattened BOM with all component links resolved from the portal's own `bom_components` table

**What must be learned first (blocker):**
The exact shape of the external order system's Dynamic BOM payload is unknown. Before building the import endpoint, Rushroom must extract one real order from the order system and document: which fields identify a component, what the configuration selection looks like as a data structure, and whether the component IDs match the portal's part numbers or OEM numbers. This is the master data / ID alignment problem — the portal uses `part_number` and `oem_number`; the order system may use something entirely different.

**Tables involved:** `bom_components` (existing — the component registry), `bom_edges` (existing — tree structure), `saved_configurations` (existing — stores named configs), potentially a new `configuration_imports` table to track the external order ID, import timestamp, and raw payload for audit purposes.

**Effort estimate:** 2–4 hours for the import endpoint + UI, once the payload shape is known. Investigation/alignment of IDs with the external system: unknown — could be 0.5 hours or several days depending on data quality.

**Risks:**
- Component IDs / part numbers may not match between the order system and the compliance portal — requires a mapping layer or enforced shared master data
- The external Dynamic BOM may include components not yet registered in the compliance portal — the import must either fail gracefully or auto-register stubs for unknown parts
- The concept of "specific configuration" may not map cleanly to the portal's tree structure if the external BOM uses a flat list rather than a hierarchy
- Deprecating in-portal configuration building means PROP-015's configure modal and attribute/value tables become secondary tools (useful for exploration only, not for compliance records)

**Related PROPs:** PROP-015 (the in-portal variant BOM that this partially supersedes), PROP-013 (BOM tree foundation — components already registered here), PROP-014 (Compliance–BOM Integration — evidence must eventually be per concrete configuration, not per abstract family)

**Status:** Raw idea — blocked on learning the external order system's Dynamic BOM payload format

---
### Platform Architecture Map — BOM as Shared Backbone — 2026-08-29
**One sentence:** Define which domain belongs in which system before building further, so the BOM component registry in the compliance portal becomes the deliberate single source of truth for component master data — rather than each system growing its own copy.
**Problem it solves:** The BOM is already being used by three separate contexts: (1) compliance portal for regulatory tracing, (2) storefront configurator (colleagues) for customer-facing product configuration, (3) future operational systems (goods received, QC, order planning, picking, delivery, installation sequencing). Without a platform boundary decision, each team will build its own component registry, the IDs will diverge, and retroactive integration will be painful. COGS/financial analysis in the compliance portal is already an early symptom — it was built here because the BOM was here, not because compliance is the right home for financial data.
**MVP scope:** A written platform boundary decision (not code) that answers: which system owns which domain, what is the interface between them (API contract vs shared DB vs import), and what data lives where. The smallest deliverable is a decision record in DECISIONS.md and a platform map diagram in SYSTEM_OVERVIEW.html Section 1 (or a new Section 0.5). No code changes — this is architecture-first.
**Proposed domain map:**
- **Compliance portal (this system):** component registry (bom_components as shared master), BOM structure (bom_edges), regulatory compliance evidence, standards, declarations, REACH/RoHS at component level, document management, DPP. Acts as the parts library that other systems reference.
- **Storefront / order system (colleagues):** customer-facing product configurator, Dynamic BOM resolution per order, pricing, order management. Consumes component IDs from the compliance portal but does not own the component records.
- **Future operational system:** goods received, QC checks, order planning, picking, delivery planning, installation sequencing. Will be built on the BOM from the compliance portal — reads component and edge data, adds operational state (stock, location, sequence).
- **Engineering PLM (future, separate):** tolerances, dimensional specs, test routines, drawings, ECO (engineering change orders). Likely a dedicated tool (OpenBOM, Arena, or custom). Links to compliance portal via component part number as the shared key.
- **Financial analysis / ERP (future, separate):** product-level P&L, COGS simulation, landed cost, margin analysis. NOT in the compliance portal — the portal's COGS tables (component_costs, landed_cost_factors, cost_scenarios, cogs_snapshots) are candidates for removal or migration to an ERP once that system exists.
**Tables involved:** No new tables. Existing tables under review for potential removal/migration: component_costs, landed_cost_factors, cost_scenarios, scenario_overrides, cogs_snapshots (all PROP-013 financial tables). The Cost Canvas subtab is the UI surface of these.
**Effort estimate:** 2–4 hours for the platform map document + decision record. Code cleanup (removing COGS tables) is a separate decision and effort.
**Risks:** Removing COGS tables breaks the Cost Canvas UI and any data already entered — migration path needed. Keeping them creates ongoing maintenance cost and source-of-truth confusion. The component registry becoming the shared parts library requires that the order system and future operational systems agree to use compliance portal part_numbers/oem_numbers as the canonical ID — this is a master data governance decision that requires alignment across all teams.
**Related PROPs:** PROP-013 (built the cost/financial layer now in question), PROP-018 (Dynamic BOM import from order system — assumes ID alignment). This idea is a prerequisite to PROP-018 going well.
**Status:** Raw idea — needs cross-team discussion before any code decision

---
### Product List — Split by Type (Components / Assemblies / Dynamic BOMs) — 2026-08-29
**One sentence:** Replace the flat product list with three client-side tabs — Components, Assemblies, Dynamic BOMs — so each type has its own sorted group and newly created items surface in the right place immediately.

**Problem it solves:** The product list currently mixes isolated components (type: Component / SparePart / Refurb), product assemblies (type: Product, has BOM children), and Dynamic BOM families (type: product_family) in one unsorted flat list. When a user creates a new component via "+sib" in an embedded BOM, it lands at the bottom of this mixed list — invisible without scrolling. As the registry grows, finding any specific item becomes a scan. Splitting by type group removes the ambiguity, puts new items in a predictable place, and makes the intent of each entry immediately clear (part vs. product vs. family).

**MVP scope:** Client-side tab filter on the product list — same `getBom` / list API call, rendered into three tabs:
1. **Components** — `type IN (Component, SparePart, Refurb)` — the parts library; newly created nodes from "+sib" land here
2. **Assemblies** — `type = Product` — products with BOM trees; the compliance-relevant structured products
3. **Dynamic BOMs** — `type = product_family` — configure-to-order family templates
Each tab sorts alphabetically by name. The tab with newly created items is auto-selected after creation so the user lands on it. No schema changes, no new API actions — pure frontend.

**Tables involved:** `bom_components` — existing, no changes needed.

**Effort estimate:** 2–3 hours (frontend only).

**Risks:**
- A `Component` type node CAN be the root of a sub-assembly (it has children in `bom_edges`). The split is by `type` field, not by whether it has children — this may surprise users who expect "Assemblies" to mean any node with children. Mitigation: keep the label as "Components" (not "Parts") and document that moving a node to "Product" type signals it is a top-level finished product.
- Users accustomed to searching one flat list may miss the tab split on first use. Mitigation: show a badge count per tab, and default to the most-used tab (likely Components).
- The create-new-node flow (both from the modal and from "+sib") must know which tab to switch to after creation, based on the type selected in the form.

**Related PROPs:** PROP-013 (BOM tree foundation), PROP-015 (Dynamic BOM / product_family type — lands in its own tab), PROP-016 ("+sib" button — the trigger for this idea).

**Status:** Raw idea

---
### Component Document Lifecycle — Upload, Versioned Linking, AI Diff, Data Extraction — 2026-08-29
**One sentence:** Make component documents first-class objects with direct upload from the component panel, explicit revision tracking, AI-powered diff when a document is updated, and structured data extraction so test specs and substance declarations live in the database — not just as PDF attachments.

**Problem it solves:**
The current flow has four gaps:

1. **Friction to upload:** You must go to the As Operated tab, upload the file there, then come back to the BOM Node and link it. When you have a test report for a specific component, the natural place to upload it is the component panel.

2. **No revision signal:** `component_documents` links a document version to a component by `component_id` only — not to a specific component revision. When the component bumps from Rev B → Rev C, the old test reports stay linked with no flag that they may no longer apply to the new revision.

3. **No AI diff on document update:** When a new version of a linked document is uploaded, there is no summary of what changed — the user must read both PDFs manually. The As Operated tab already does this via AI (deviation scan / interpretation diff) — the same pattern should apply here.

4. **Data stays locked in PDFs:** In other parts of the portal, documents are "read in" — clauses into `standard_clauses`, interpretations into `as_operates_interpretations`, statements into `document_statements`. Component documents are not. A test report with a pass/fail result, lab accreditation, and test scope is just an opaque attachment.

**MVP scope — four layers, each independently shippable:**

**Layer 1 (2–3 h) — Direct upload from component panel:**
Add a "+ Upload & link" tab to the "Link document" modal. Calls existing `uploadDocument` + `addDocumentVersion` actions, then immediately links via `addComponentDocument`. No new DB tables. Document also appears in As Operated — nothing siloed.

**Layer 2 (3–4 h) — Revision-aware document validity:**
Add `component_revision TEXT` (populated at link time) and `needs_review BOOLEAN DEFAULT FALSE` to `component_documents`. When `addBomVersion` creates a new component revision, the edge function sets `needs_review = TRUE` on all prior-revision documents. UI shows amber "⚠ Review for Rev C" badge. User dismisses per-document with a reason logged to `bom_component_history`.

**Layer 3 (4–6 h) — AI diff when updating a document link:**
When the selected document version is a newer version of a document already linked to the component, the modal shows an AI-generated "What changed?" bullet list — calls `diffComponentDocumentVersions` using Haiku comparing two PDF texts. Reuses the same two-PDF comparison pattern already in the deviation scan.

**Layer 4 (8–12 h) — Structured data extraction:**
Per category, AI extracts key fields from the PDF and populates structured tables:
- `test_report` → test lab, accreditation number, test scope, test date, pass/fail → nullable columns on `component_documents` (aligns with PROP-014)
- `declaration` (REACH/RoHS) → substance list → upserts into `component_materials` with `source = 'declaration'`
- `datasheet` → key specs (voltage, current, power, temp range) → new `component_specs` table
All extractions shown for user review before saving — never auto-commit.

**Tables involved:**
Existing (extended): `component_documents` (add `component_revision`, `needs_review`, test-report fields), `component_materials` (declaration extraction)
New (Layer 4 only): `component_specs`: `{id, organization_id NOT NULL FK→organizations, component_id FK→bom_components, spec_name, spec_value, spec_unit, source_document_version_id FK→document_versions, created_at}`

**Effort estimate:** 17–25 h total (Layer 1: 2–3 h, Layer 2: 3–4 h, Layer 3: 4–6 h, Layer 4: 8–12 h). Each layer ships independently.

**Risks:**
- PDF extraction quality: Layer 4 depends on text-readable PDFs — scanned images will fail. Surface extraction failures clearly; raw PDF stays authoritative.
- needs_review noise: Frequent component revisions create constant amber warnings. Mitigate by only flagging `test_report` and `declaration` categories, not datasheets.
- Two revision axes: `component_revision` (which component rev the doc covers) vs. document version number. Must be clearly labelled in the UI to avoid confusion.
- Layer 4 accuracy: all AI-extracted data shown for user review before saving — never auto-commit.
- PROP-012: all new tables carry `organization_id NOT NULL`; extractions run server-side only.

**Related PROPs:**
- PROP-014 (Compliance–BOM Integration — Layer 2's revision validity is a lighter version of the `component_clause_evidence` pending_retest pattern)
- PROP-013 (PIS foundation — `component_documents` and `component_materials` defined here)
- PROP-011 (Requirement Links — `document_statements` is the established "read into DB" pattern this extends to component docs)
- PROP-012 (Multi-tenancy — `organization_id` required on `component_specs`)

**Status:** Raw idea — Layer 1 ready to build; Layers 2–4 depend on PROP-014 decisions

---
### Component Lifecycle Status — Rebuild as Active / Inactive / Replaced / Flagged — 2026-08-30
**One sentence:** Replace the six-stage engineering lifecycle (concept → specified → sourcing → approved → released → obsolete) with four operational states that reflect how Rushroom actually thinks about component health.

**Problem it solves:** The current statuses (`concept`, `specified`, `sourcing`, `approved`, `released`, `obsolete`) are engineering-phase markers borrowed from PLM software. They answer "where is this in the development pipeline?" Rushroom needs statuses that answer "what is this component's operational standing right now?" — and the new four-state model maps directly to decisions users actually make.

**The four states and their meaning:**
- **Active** — in production, currently sold/used. The default healthy state.
- **Inactive** — registered but not yet active: under development, under regulatory assessment, in procurement hold, not yet approved for production, or simply parked for future use. This is the "anything that isn't active yet" catch-all.
- **Replaced** — retired or superseded. Critically: replacement is NOT 1:1. A single component may be replaced by a completely re-engineered 3-part sub-assembly, or merged into a larger unit. A free-text `replacement_note` field captures the "what replaced it and why" narrative. Optionally: a `replacement_component_ids UUID[]` for when the successors are also in the registry.
- **Flagged** — needs attention NOW: a compliance concern, supplier quality issue, regulation change, pending re-assessment, or any user-defined alert. A `flag_reason` text field captures the specific concern. Flagged components should be visually prominent (red) and ideally surface in the Status Overview as a separate call-out.

**Migration from existing values:**
- `concept` → `inactive`
- `specified` → `inactive`
- `sourcing` → `inactive`
- `approved` → `active`
- `released` → `active`
- `obsolete` → `replaced` (best-guess default; user can correct)

**MVP scope:**
1. DB migration: add `replacement_note TEXT` + `flag_reason TEXT` columns to `bom_components`; UPDATE rows to map old values; update the CHECK constraint (if one exists) to new four values.
2. Backend `setComponentStatus`: new valid set `["active","inactive","replaced","flagged"]`; accept `replacement_note` and `flag_reason` in the same call.
3. Frontend `LIFECYCLE_COLORS`: 4 colors — `active=#2fa564`, `inactive=#8b93a1`, `replaced=#f59e0b`, `flagged=#e05454`; `STATUS_COLOR` in `bomTreeView` updated to match.
4. Component detail panel: status dropdown with 4 options; `replacement_note` text input appears when "Replaced" selected; `flag_reason` text input appears when "Flagged" selected.
5. Status Overview: update the `lcOrder` counter list to the 4 new statuses; "Flagged" bar shown first (or as a highlighted call-out) since it signals action required.

**Tables involved:** `bom_components`, `bom_component_history` (audit trail captures the transition — no schema change there)

**Effort estimate:** ~2 hours (migration + backend + frontend, no new tables)

**Risks:**
- If a CHECK constraint exists on `lifecycle_status` in Postgres, it must be dropped and re-added in the migration — otherwise the `UPDATE` to new values will fail.
- Old `bom_component_history` rows will contain legacy status values (`concept`, `released`, etc.) — these are historical snapshots and should be left as-is; the UI changelog reads them verbatim.
- The `updateComponent` action (which patches many fields) does NOT currently update `lifecycle_status` — this is intentional (`setComponentStatus` is the dedicated path). Keep this separation.
- Migration must be applied BEFORE deploying the backend, or the validation will reject the new status values in the window between deploy and migration.

**Related PROPs:** PROP-013 (introduced lifecycle_status), PROP-022 (BOM list — STATUS_COLOR must be updated there too)

**Status:** Raw idea

---
### Component Version History — Full State Access Per Revision — 2026-08-30
**One sentence:** Make each component revision a complete, inspectable historical record — documents, materials, spec summary, and description — not just a timestamp and a note.

**Problem it solves:**
Right now, bumping a version produces a row in the Versions table that says "Revision B — something changed — 2026-08-30." That's all. You cannot click into Rev B and see what documents were attached, what REACH/RoHS materials were declared, or what the description said. If Rev C is current, the Rev B state is effectively gone from the UI.

This matters for compliance: a test report linked to a component at Rev A may no longer apply at Rev C. A regulator or auditor asking "what was the component specification when you submitted the CE declaration in June?" should get a complete answer — not "it was Rev B, good luck."

The data to reconstruct history exists in the DB (documents and materials are linked to `component_id`), but there is no version-scoped query and no snapshot is taken at bump time. The timestamps on `component_documents` could theoretically be used to reconstruct what existed "before the bump" but this is brittle and not exposed in the UI.

**What already exists that could be extended:**
- `bom_component_versions` — the revision record, currently just `revision, spec_summary, is_current, created_at`
- `bom_component_history` — field-level snapshots of component metadata fields (part_number, name, description, lifecycle_status, etc.) written by Postgres triggers — but does NOT include documents or materials
- `component_documents` — links documents to `component_id`, no `component_version_id`
- `component_materials` — links substances to `component_id`, no `component_version_id`
- The Versions table UI renders all revisions — rows just aren't expandable yet

**MVP scope:**
1. **Migration:** Add `version_snapshot JSONB` column to `bom_component_versions`. Default NULL (backward compat — existing rows stay null, UI handles gracefully).
2. **Backend — `bumpComponentVersion`:** Before inserting the new version row, fetch the current component state and store it as the snapshot on the NEW row being inserted: `{ spec_summary, description, notes, lifecycle_status, documents: [{doc_name, version, category, label}], materials: [{substance_name, cas_number, percentage_w_w, reach_svhc, rohs_restricted}] }`. This captures "what existed when this revision was created" — i.e. the incoming state, not the outgoing.
   - Alternative (simpler read): fetch and store snapshot on the PREVIOUS version row (update its `version_snapshot` to capture what it held before being retired). Either approach works; storing on the new row is more consistent with immutability.
3. **Backend — `getComponentHistory`:** Include `version_snapshot` in the SELECT.
4. **Frontend — Versions table:** Clicking a revision row expands it inline (accordion) to show: spec summary, description/notes (from snapshot or from current `bom_component_history`), linked documents at that revision, materials at that revision. For rows with `version_snapshot = null` (created before this feature), show "Snapshot not available for this revision."
5. **No new tables.** No change to `component_documents` or `component_materials` schema.

**Tables involved:**
- `bom_component_versions` (add `version_snapshot JSONB` column — migration required)
- `bom_component_history`, `component_documents`, `component_materials` — read-only at bump time to build the snapshot

**Effort estimate:** 6–10 hours
- Migration (1 column): 0.5 h
- Backend snapshot fetch + store in `bumpComponentVersion`: 2 h
- Backend `getComponentHistory` update: 0.5 h
- Frontend expandable version rows + snapshot renderer: 3–6 h

**Risks:**
- **Snapshot timing:** Storing the snapshot on the NEW version row captures "what exists when this revision started" — documents and materials added AFTER the bump but before the next bump will not be in any snapshot. This is acceptable for the MVP; a more accurate approach (snapshot the outgoing state on the OLD row) requires an UPDATE to a row that was just retired, which conflicts with immutability conventions. Document this limitation clearly in the UI.
- **Snapshot size:** A component with 20 documents and 50 substance rows could produce a large JSONB blob. In practice Rushroom's components are small; for future-proofing, limit snapshot to name/version/category per document (not the full doc content) and key fields per material.
- **Backward compatibility:** Rows created before this feature have `version_snapshot = null`. The UI must handle this gracefully with a "snapshot not available" placeholder — not an error.
- **PROP-021 Layer 2 interaction:** PROP-021 Layer 2 proposes `needs_review BOOLEAN` on `component_documents` to flag documents after a bump. That is a live-state flag; this idea is a historical record. They are complementary and do not conflict.

**Related PROPs:**
- PROP-013 (PIS — `bom_component_versions`, `component_documents`, `component_materials` defined here)
- PROP-021 Layer 2 (revision-aware document validity — a lighter live-state flag; this idea adds the historical record layer)
- PROP-014 (Compliance–BOM Integration — test report evidence must be traceable to a specific component revision; this snapshot is the foundation for that traceability)

**Status:** Raw idea

---
### Component Images — Paste, Drop, or Pick from Disk — 2026-08-30
**One sentence:** Add a photo gallery to each component's detail panel, with Ctrl/Cmd+V clipboard paste as the primary upload method alongside file drop and file picker.

**Problem it solves:**
A part number and a name tell you what something is called. A photo tells you what it actually looks like — which connector type, which side the mounting holes are on, whether it is the version with or without the blue stripe. Right now there is no way to attach any visual reference to a component. Engineers working on compliance or assembly verification have to search part numbers in separate tabs or open spec PDFs just to confirm they are looking at the right part.

Clipboard paste is the killer feature here: take a screenshot of a component in a datasheet (Cmd+Shift+4 on Mac), switch to the portal, and Cmd+V drops it straight into the component. No export, no file picker, no rename. This is how Notion, Linear, and Figma handle it — it should work here too.

**What already exists that could be extended:**
- Supabase Storage is already live (`documents` bucket used by PROP-021)
- `uploadZone` widget already handles file-drop and file-picker UX
- Edge function already handles binary uploads to Storage with org-scoped paths
- `component_documents` table exists but is wrong for photos — it requires versioned document records (`document_versions`), which is unnecessary overhead for a visual reference image

**MVP scope:**
1. **New table `component_images`**: `id, organization_id, component_id, storage_path, file_name, content_type, uploaded_at, uploaded_by`. No versioning — images are add/delete only.
2. **Storage bucket**: use a new `component-images` bucket (or a `component-images/` prefix in the existing bucket) with org-scoped paths: `{org_id}/{component_id}/{uuid}.{ext}`.
3. **New API actions**: `uploadComponentImage` (accepts base64 data + filename + MIME type, uploads to Storage, inserts row), `listComponentImages` (returns signed URLs for all images on a component), `deleteComponentImage` (deletes from Storage and removes row).
4. **Frontend — component detail panel**: Image gallery section below the existing fields. Shows thumbnails in a 3-column grid. Click thumbnail → lightbox full-size view. Below the grid: paste zone with instruction "Paste (Ctrl+V / Cmd+V) or drop an image here", plus a "Choose file" button as fallback.
5. **Paste handler**: listen for `paste` event on the detail panel container. Check `event.clipboardData.items` for `image/*` MIME types. Convert the `DataTransferItem` to a Blob, read as base64, upload via `uploadComponentImage`. Show upload progress inline.
6. **Client-side size limit**: warn and reject if image exceeds 8 MB before upload. No server-side resize needed for MVP.

**Tables involved:**
- `component_images` (new — migration 0016)
- Supabase Storage: `component-images` bucket (new)

**Effort estimate:** 6–8 hours
- Migration + storage bucket: 0.5 h
- Backend (3 actions): 2 h
- Frontend gallery + paste handler + lightbox: 3.5–5 h

**Risks:**
- **Paste scope conflict:** A `paste` event listener on the panel could fire when the user pastes text into one of the panel's text inputs (name, description, notes). Must check that the paste event target is NOT an input/textarea before treating it as an image paste.
- **Clipboard image format:** Screenshots from macOS are PNG blobs. Images copied from a browser are sometimes `image/png`, sometimes `image/webp`. Both work fine with base64 upload. The filename should default to `screenshot-{timestamp}.png` when no filename is available.
- **Large files:** A retina screenshot can be 3–5 MB. 8 MB limit is generous enough for real use. If the user pastes a raw camera photo (20 MB+), the rejection message must be clear.
- **Signed URL expiry:** Supabase signed URLs expire. Use a generous TTL (1 hour) for the gallery view, or make the bucket policy public-read (simpler for internal tooling where all authenticated users are trusted).
- **PROP-012 multi-tenancy:** `organization_id` on `component_images`, path includes `{org_id}/` prefix in Storage. `tdb()` enforces org isolation on DB reads automatically.

**Related PROPs:**
- PROP-013 (PIS — `component_documents`, `component_materials` defined here; `component_images` follows the same tenant pattern)
- PROP-021 (Component Document Lifecycle — the upload infrastructure and `uploadZone` widget is reused; images are distinct from compliance documents)
- PROP-024 (Version History — version snapshots currently capture documents and materials; a future extension could include image references per revision)

**Status:** Raw idea

---
### Shared Component Awareness — BOM Tree Refresh & Usage Indicators — 2026-08-31
**One sentence:** After linking an existing component as a child, immediately reflect it in the BOM tree and show a "used in N assemblies" badge on shared components so their multi-context nature is always visible.

**Problem it solves:**
Two friction points emerge when a component appears in more than one place in the hierarchy:

1. **Stale tree display** — after using the "Link existing" tab to add CONFIRMAT as a child of Rail (1.2.1.1), the Left Side Panel tree does not update. The new node at 1.2.1.1.1 is invisible until the user reloads the page or manually collapses and re-expands the tree. The data is correct in the DB but the rendered tree is stale.

2. **Silent sharing** — CONFIRMAT at 1.1 and CONFIRMAT at 1.2.1.1.1 are the same record. Editing CONFIRMAT (name, materials, lifecycle status, documents) affects both positions. Nothing in the tree communicates this — the row looks identical to a component used in only one place. A user who doesn't know the data model will be surprised when a change they made to a "local" component propagates elsewhere.

Both issues are specific to the "link existing" flow, which creates a new `bom_edges` row pointing at an already-existing `bom_components` row. The "create new" flow does not have these problems.

**What already exists that could be extended:**
- `listParentsOf` action already fetches all assemblies that use a given component — used in the "Used in" section of the detail panel
- `refreshTree()` in `bomTreeView` already re-fetches `listComponents` + re-renders all expanded roots — just not called after `addBomEdge` succeeds
- `thumbMap` pattern in `bomTreeView` (a per-component map fetched once alongside `listComponents`) can be extended to carry a `parentCountMap`

**MVP scope:**
1. **Auto-refresh tree after `addBomEdge`** — in the frontend modal success handler, call `refreshTree()` (already exists). This re-fetches `listComponents` (which now returns `has_children=true` for the parent) and re-renders expanded roots. Cost: ~5 lines of code.
2. **New API action `listParentCounts`** — single query: `SELECT child_id AS component_id, COUNT(DISTINCT parent_id) AS parent_count FROM bom_edges WHERE organization_id = $org GROUP BY child_id HAVING COUNT(DISTINCT parent_id) > 1`. Returns `{component_id, parent_count}[]` — only components with more than one parent. Called alongside `listComponents` in `refreshTree()`.
3. **"Used in N assemblies" badge in tree rows** — in `renderRootRow`, if `parentCountMap[comp.id] > 1`, append a small inline chip after the component name: `↗ N` (styled like the existing `×qty` badge). Tooltip: "This component is used in N assemblies — changes affect all of them."
4. **Warning in "Link existing" tab** — after the user selects a component from the search dropdown in the add-child modal, if `parentCountMap[selected.id]` exists (> 1), show an inline callout: "⚠ Already used in [N] other assemblies. Linking it here means structural changes propagate everywhere it is used."

**Tables involved:**
- `bom_edges` (read-only — one new GROUP BY query)
- No new tables

**Effort estimate:** 3–5 hours
- `listParentCounts` backend action: 0.5 h
- Auto-refresh call in modal success handler: 0.5 h
- Badge rendering in `renderRootRow`: 1 h
- Warning in link-existing UI: 1–2 h

**Risks:**
- **`refreshTree()` cost:** Re-rendering re-fetches `listComponents` + `listComponentThumbnails` + re-renders all open expanded trees. On a BOM with many open sub-trees this can feel slow. For MVP this is acceptable; a targeted "refresh this root" would be the optimisation path later.
- **`listParentCounts` on large BOMs:** A single aggregation query is O(edges) — fast. Not a concern at Rushroom's scale.
- **DAG cycles:** The existing cycle-prevention trigger (if any) guards against infinite loops; this feature only reads edges, so no new cycle risk.
- **"Phantom" shared components:** A component linked as a child in five assemblies but with no structural significance (a generic M3 screw) will show "↗ 5" prominently. That may be noisy. The badge should be subtle (small, low-contrast) so it informs without alarming.

**Related PROPs:**
- PROP-013 (bom_edges, `listParentsOf` defined)
- PROP-022 (lazy tree, `listComponents`, `refreshTree` pattern)
- PROP-025 (has_children drives tab routing — after refresh, a newly promoted Assembly node correctly moves to the Assemblies tab)

**Status:** Raw idea

---
### BOM Tree — Terminology & Interaction Consistency — 2026-09-01
**One sentence:** Rename "Components" → "Parts" throughout the BOM Tree view, rename the COMPONENT column header inside assemblies to "Part", and replace the developer-term "+sib" button label with something users recognise.

**Problem it solves:**
Three terminology mismatches make the BOM Tree harder to learn than it needs to be:

1. **"Components" tab shows parts, not components.** The tab is labelled "Components" but it exclusively contains leaf-node types (`part`, `raw_material`, `spare_part`). In manufacturing language, a sub-assembly is also a "component" of its parent — so the label is misleading. The user's mental model is: isolated physical objects that haven't been assembled into anything are "parts"; assembled groups of parts are "sub-assemblies." The tab label should match: **"Parts"**.

2. **"COMPONENT" column header inside an assembly BOM tree.** When you expand a sub-assembly, the tree column header reads "COMPONENT". The items listed are parts. The column should read **"Part"** (matching the tab name and the user's vocabulary).

3. **"+sib" is a developer abbreviation users don't understand.** "+sib" (sibling) is a CS tree-traversal term. When a user sees it on a row, it is not obvious that clicking it opens a modal to add another part at the same level inside the parent assembly. A clearer label: **"+ part"** (since the parent is always a `sub_assembly` or `finished_good`, and what you're adding is another part or sub-assembly to sit beside the current row).

**On the "can't add a second child" confusion:**
The frontend has no guard on adding a second child — the +child button on the assembly header row is always available for `sub_assembly`/`finished_good` nodes. The backend constraint is `UNIQUE (parent_id, child_id, effective_from)`, which means: adding a *different* part as a second child works fine; adding the *same part twice on the same date* is rejected by Postgres with a unique-violation error. If adding a child fails, it is because the exact same component was selected again, not because a "second child" is forbidden.

**MVP scope:**
1. `TAB_DEFS` in `bomTreeView` (line 3444): change `label: "Components"` → `label: "Parts"`. One character change; the count suffix `(N)` remains.
2. `renderBomTree` column header (line 3811): change the string `"Component"` → `"Part"`. The `isDynamicBom` branch stays `"Configuration"` — no change there.
3. `+sib` button label in `renderBomTree` (line 3863): change `"+sib"` → `"+part"` (keep `title: "Add sibling"` as the tooltip for users who want the precise term).
4. No DB changes, no API changes, no migration.

**Tables involved:** None — frontend only (`assets/app.js`).

**Effort estimate:** 0.5 hours (three string changes, one line each).

**Risks:**
- Any user-facing documentation, screenshots, or onboarding text that says "Components tab" will be out of date — low risk since there is none yet.
- The word "Part" could be confused with a specific `type=part` node (vs `raw_material`, `spare_part`) — but the tab shows ALL leaf types, and in practice users already call all of them "parts." The consistency gain outweighs the edge-case ambiguity.

**Related PROPs:** PROP-020 (introduced the three-tab split and the column header), PROP-025 (established the type vocabulary: part/raw_material/sub_assembly/finished_good/spare_part).

**Status:** Raw idea — tiny effort, high clarity gain

---
### Manufacturing Routing — Postponement Model with Variant-Conditional Operations — 2026-09-01

**One sentence:** Attach an ordered, variant-conditional sequence of in-house operations to each Dynamic BOM product family so that resolving a customer configuration yields both the parts to pull from semi-finished stock AND the exact operation sequence to perform — enabling a full postponement manufacturing model where generic inventory is finalised to order.

**Business model context:**
Rushroom operates a postponement (hedging) model. Semi-finished panels are bought and stocked generically with their own article numbers. When a customer order arrives, the specific configuration is resolved — the right panels are pulled and a sequence of operations (cut, drill, mill, surface treat, assemble) is performed to finalise them before shipment. Nothing is stocked as a finished configuration. This is the same model Dell applied to PCs: maximum inventory fungibility, minimum committed stock, full customer configuration at the point of order.

**Key architectural truth:**
- The **semi-finished panel** = the postponement point. Purchased, stocked, compliance-tracked.
- The **routing** = what is done to it, determined by which configuration the customer ordered.
- The **configured output** = ephemeral — made and shipped, not stocked under a new article number.
- Different configurations within the same product family require **entirely different operation sequences** — not just different parameters on the same steps. A surface-treated config adds steps that a plain config never sees.

**Therefore:** routing steps live on the **product family (Dynamic BOM)**, not on individual purchased components. Each step carries a `variant_condition JSONB` (same pattern as `bom_edges.variant_condition`) — `NULL` = always performed; `{"Surface": "anodised"}` = only for that variant. Resolving a customer configuration produces two outputs: a resolved BOM (parts to pull) and a resolved routing (operations to perform), together forming a complete production order specification.

**Problem it solves today:**
- Operations are invisible — no record of what work sequence was performed per order
- Configurations that differ by process type (not just component selection) cannot be expressed in the current Dynamic BOM model — only `bom_edges` carry `variant_condition`, not operations
- A work order issued to the shop floor has no system backing — it exists only on paper or in someone's head
- Compliance cannot answer "which operations were performed on the panels in customer order #X, and did any of them involve SVHC process chemicals?"

**MVP scope:**
1. **New table `family_routing_steps`** — `{id, organization_id NOT NULL FK→organizations, family_id FK→bom_components (must be product_family type), step_number INTEGER, operation_type TEXT badge (drill/route/insert/attach/cut/surface_treat/inspect/other — visual categorisation only), instruction_text TEXT (the actual instruction: "Drill 4× Ø5mm holes per drilling template"), reference_document_id FK→document_versions NULLABLE (the PDF template, CNC drawing, or spec the operator opens on the shop floor), applies_to_component_id FK→bom_components NULLABLE (which panel/part this step acts on), variant_condition JSONB NULLABLE (null = always; same semantics as bom_edges.variant_condition), notes TEXT, created_at}`. Steps are atomic physical actions — one checkoff per action. The instruction_text is free-form; the reference_document_id links to the template or drawing from the document library.
2. **New API action `listFamilyRoutingSteps(family_id)`** — returns all routing steps for the family, ordered by step_number.
3. **New API action `upsertFamilyRoutingStep(...)`** and **`deleteFamilyRoutingStep(id)`**.
4. **Extend `resolveVariant(family_id, selections)`** — currently returns resolved component tree only. Extend to also return `resolved_routing: []` — steps where `variant_condition IS NULL OR variant_condition <@ selections`, ordered by step_number.
5. **New table `work_orders`** — `{id, organization_id NOT NULL, family_id FK→bom_components, external_order_id TEXT (from storefront), selections JSONB (the customer's configuration choices), status TEXT (planned/in_progress/completed/shipped), created_at, updated_at}`.
6. **New table `work_order_steps`** — snapshot of the resolved routing at order creation time (immutable after creation): `{id, work_order_id FK→work_orders, step_number, operation_name, operation_type, applies_to_component_id, notes, status (pending/in_progress/done), completed_at, completed_by}`. Snapshot — not a live reference — so changes to routing definition do not silently change in-flight orders.
7. **New table `work_order_components`** — snapshot of the resolved BOM at order creation time: `{id, work_order_id, component_id FK→bom_components, quantity}`.
8. **API actions:** `createWorkOrder(family_id, selections, external_order_id)` — calls resolveVariant internally, snapshots routing + BOM into work_order_steps + work_order_components; `listWorkOrders`; `getWorkOrder(id)`; `updateWorkOrderStepStatus(step_id, status)` (shop floor progression); `completeWorkOrder(id)`.
9. **Frontend — Dynamic BOM detail panel:** new "Routing" tab showing the step list. Steps editable (add/reorder/delete). variant_condition picker reuses the existing attribute/value selector from PROP-015.
10. **Frontend — Work Orders view** (new sub-tab in the Product tab): list of orders with status, configuration summary, and a detail view showing the resolved routing checklist + component pull list.

**Tables involved:**
- New: `family_routing_steps`, `work_orders`, `work_order_steps`, `work_order_components` — all with `organization_id NOT NULL FK→organizations`
- Extended: `resolveVariant` API action (return shape gains `resolved_routing`)

**Effort estimate:** 20–28 hours
- Migration (4 new tables): 2 h
- Backend routing CRUD actions (3): 3 h
- Extend `resolveVariant` to return routing: 2 h
- Backend work order actions (5): 5 h
- Frontend — routing tab on Dynamic BOM panel: 4 h
- Frontend — Work Orders list + detail view: 7–10 h
- Integration point with storefront `external_order_id`: 2 h

**Risks:**
- **Snapshot vs live routing:** Work order steps are snapshotted at creation — the right call for a production system (you cannot change what was planned after the order is in progress). Means a routing error discovered mid-production requires a new work order or a manual correction note, not an edit to the original.
- **REACH/process chemistry (Layer 2):** Operations like surface treatment (anodising, powder coat) involve process chemicals that may be SVHC-relevant. MVP captures operation type — linking specific chemicals to operation types for REACH compliance is the natural Layer 2 once routing is established.
- **Shop floor UX:** The Work Orders view needs to work on a tablet at the bench, not just a desktop. Mobile-first design for step progression (big tap targets, minimal scrolling). Not in MVP scope — desktop first, tablet-optimise in iteration 2.
- **Stock reservation:** The work order pull list tells the operator which stock items to take, but does not decrement inventory — there is no inventory ledger yet. That is a future module. MVP: the pull list is informational.
- **Cycle times and work centres:** Valid future additions (how long each step takes, which machine or bench it runs on) — add `estimated_minutes` and `work_centre TEXT` columns to `family_routing_steps` when needed. Schema is designed to accept them without breaking changes.

**Related PROPs:**
- PROP-015 (CTO Variant BOM — `variant_condition` pattern; `family_attributes`/`family_attribute_values` used by routing condition picker)
- PROP-018 (Dynamic BOM order import — `external_order_id` on work orders is the join key to the storefront order)
- PROP-014 (Compliance–BOM Integration — per-order routing record is the future anchor for process-chemical compliance evidence)
- PROP-012 (Multi-tenancy — `organization_id NOT NULL` on all four new tables)

**Status:** Raw idea — supersedes the earlier "manufactured part number" framing; correct model is variant-conditional routing on the product family, not routing on individual manufactured components

---
### Engineering Drawing Intelligence — Drawing-Driven Component Specs & Revision Signals — 2026-09-02

**One sentence:** When a technical drawing (PDF export) is uploaded for a component, AI extracts the title block, general tolerances, primary dimensions, and material callout into structured fields — and when a new drawing revision is uploaded, automatically surfaces what changed and whether compliance re-testing is likely needed.

**Problem it solves:**
Engineering drawings carry the authoritative specification for a component — dimensions, tolerances, material callouts, revision history. Right now they exist only as dead PDF attachments in `component_documents`. When a drawing changes:
- No system signals that the component's compliance test reports may no longer apply
- No system bumps the component revision automatically
- No system surfaces what actually changed between Rev A and Rev B
- The Technical File audit trail (CE marking) has no machine-readable link between "drawing says ±0.2mm on this hole" and "EN 60598 clause 8.3 requires this tolerance"

The result is that a compliance or engineering team member must manually read every changed drawing and decide whether re-testing is needed. At scale (30+ components × 5 standards) this is hours of work per ECO (Engineering Change Order). A CE marking consultant charges €2–5k per product to do exactly this mapping manually.

This is not a CAD integration. CAD files (SolidWorks .sldprt, CATIA .CATPart, Fusion 360 .f3d) are binary, proprietary, and expensive to parse reliably. The practical path is PDF drawing exports — Claude Vision reads these with high accuracy for text content. The extraction is a structured Claude API call, not a CAD file parser.

**What this makes possible:**
"You upload a PDF drawing. We tell you what revision it is, what tolerances it declares, and what material it calls out. When you upload a new revision, we tell you exactly what changed and whether that change is likely to require re-testing under your active compliance standards."

This positions the platform as an **Engineering and Compliance Portal** — genuinely connecting the engineering record (drawings, specs, revisions) to the compliance record (standards, clauses, test reports, declarations). That link is currently in someone's head or in a consultant's invoice.

**Architecture intent:**
Drawing intelligence is NOT a new tab or module. It is intelligence layered onto the existing component record. A component can already have `component_documents` with any category. Add `drawing` to the category enum. When a drawing is uploaded:
1. AI extracts structured fields → stored in `component_specs` (new table, see PROP-021 Layer 4)
2. Extracted revision letter is compared to current `bom_component_versions.revision` — if newer, surface a "Bump component revision to match drawing" prompt
3. If this is a second drawing upload for the same document, AI diffs the two and returns a structured change summary (what changed, what is unchanged, compliance risk flag)
4. Change summary is stored on the new `document_versions` row as `ai_diff_summary` (PROP-021 Layer 3 pattern) — no new table needed

The ECO (Engineering Change Order) flow is implicit: upload new drawing revision → diff fires → compliance re-test signals fire (PROP-014 `pending_retest` pattern) → component revision bump is suggested. This is not a formal ECO workflow (no approval gates, no state machine) — MVP is the signal, not the process.

**MVP scope:**
1. **Add `drawing` to `component_documents.category` enum** (migration — 1 line)
2. **New table `component_specs`**: `{id, organization_id NOT NULL FK→organizations, component_id FK→bom_components, source_document_version_id FK→document_versions, spec_name TEXT, spec_value TEXT, spec_unit TEXT NULLABLE, extraction_confidence TEXT (high|medium|low), created_at}` — one row per extracted field. The same table proposed in PROP-021 Layer 4; this is the trigger to build it.
3. **New API action `extractDrawingSpecs(document_version_id, component_id)`** — calls Claude claude-haiku-4-5-20251001 (cheap, fast) with the drawing PDF (base64) and a structured schema: `{revision: str, revision_date: str, drawn_by: str, material_callout: str, general_tolerance: str, surface_finish: str, primary_dimensions: [{label, value, unit}], notes: str}`. Stores results as `component_specs` rows. Returns extracted data for user review — never auto-commits.
4. **Frontend — component detail panel**: When a document with `category = drawing` is linked, a "Read drawing" button appears. Clicking it calls `extractDrawingSpecs` and shows a review panel: structured table of extracted fields, each with a confidence badge (high/medium/low), all pre-ticked for save, user can untick fields they don't trust. On confirm: saves to `component_specs`. The specs section in the component panel shows these rows as a neat key-value table.
5. **Revision diff**: When uploading a new version of a document that is already linked as `category = drawing` to this component, the upload modal auto-triggers `diffDrawingRevisions(old_document_version_id, new_document_version_id)` — calls Claude claude-haiku-4-5-20251001 with both PDFs and returns `{changed: [{field, old_value, new_value}], unchanged: [field], compliance_risk: "likely"|"unlikely"|"uncertain", risk_reason: str}`. Shown inline before the user confirms the new link. Stored as `ai_diff_summary` on the new `document_versions` row.
6. **Component revision prompt**: If the extracted drawing revision letter differs from the current component revision, show a yellow inline callout: "Drawing says Rev B — component is currently Rev A. Bump component revision?" One-click bump using existing `bumpComponentVersion`.

**Tables involved:**
- New: `component_specs` (organization_id NOT NULL FK→organizations, component_id, source_document_version_id, spec_name, spec_value, spec_unit, extraction_confidence)
- Extended: `component_documents.category` enum (add `drawing`); `document_versions.ai_diff_summary` (PROP-021 Layer 3 — add this column in the same migration)
- Read: `bom_component_versions` (current revision for comparison), `document_versions` (for diff), `component_documents` (to find linked drawings)
- All new tables: `organization_id NOT NULL FK → organizations`

**Effort estimate:** 14–20 hours
- Migration (1 table, 1 column, 1 enum value): 1 h
- Backend `extractDrawingSpecs` (Claude Haiku call + component_specs upsert): 3 h
- Backend `diffDrawingRevisions` (Claude Haiku call + store ai_diff_summary): 2 h
- Frontend — "Read drawing" button + review panel in component detail: 4–6 h
- Frontend — diff modal in upload flow: 3 h
- Frontend — component specs display table in component panel: 1–2 h
- Frontend — revision prompt callout: 1 h

**Risks:**
- **PDF text quality**: Digitally created PDFs from modern CAD tools (Fusion 360, SolidWorks PDF export) are fully text-readable — extraction is reliable. Scanned drawings or rasterised PDFs fail text extraction. Claude Vision handles scanned drawings better than pure OCR but accuracy drops. Surface this clearly: "Low confidence" badge means AI couldn't read the field — user must fill in manually.
- **Title block format variation**: Every company has a different title block layout. AI extraction does not depend on layout — it reads semantic meaning, not field position — but unusual formats (e.g. all-caps German DIN blocks, Japanese-style title blocks) may produce lower confidence on some fields.
- **GD&T symbols**: Geometric Dimensioning and Tolerancing (position, flatness, perpendicularity, circularity) requires interpreting symbols and datum references. MVP scope is limited to general tolerances (the tolerance block) and primary dimensions (LxWxH). Full GD&T parsing is out of scope — mark GD&T callouts as "not extracted, see drawing" in the specs table.
- **User trust in AI extraction**: Engineers are rightly skeptical of AI-extracted specs for parts where a wrong tolerance causes a safety incident. The review-before-save gate is non-negotiable. Never auto-commit. Add a clear disclaimer: "Extracted by AI — verify against drawing before use."
- **Compliance risk flag accuracy**: The `compliance_risk` field on the revision diff is an AI judgment call, not a regulatory ruling. It surfaces likely candidates for re-testing — it does not replace engineering judgment. Label it clearly as a prompt, not a decision.
- **`ai_diff_summary` column timing**: PROP-021 Layer 3 proposes this column. If PROP-021 Layer 3 ships before this, the column already exists. If this ships first, the migration adds it. Either order is safe — no conflict.

**Related PROPs:**
- PROP-021 Layer 3 (AI diff pattern — same two-PDF comparison approach; this extends it to drawings) and Layer 4 (component_specs table — this is the trigger to build it)
- PROP-014 (Compliance–BOM Integration — the revision diff's compliance_risk flag is the prompt to run the PROP-014 pending_retest flow; they work together)
- PROP-024 (Component Version History — drawing revision → component revision bump produces a version snapshot; the snapshot should include current specs)
- PROP-013 (PIS — component_documents, bom_component_versions, component_materials are the foundation)
- PROP-012 (Multi-tenancy — component_specs carries organization_id NOT NULL; drawings are highly confidential per-tenant IP)

**The bigger picture — Engineering and Compliance Portal:**
The platform already has: component registry (EBOM), BOM structure, manufacturing routing (MBOM lite), work orders (MES lite), compliance standards, and regulatory declarations. Adding drawing intelligence closes the last gap: the engineering record. The system becomes a single thread from "engineer uploads drawing" → "specs extracted" → "component record updated" → "compliance certificates checked" → "manufacturing steps verified" → "work order issued" → "declaration generated." No other SaaS product under €10k/year does this end-to-end for hardware startups. The positioning "Engineering and Compliance Portal" is accurate and defensible.

**Status:** Raw idea

---
### Portal UI Localisation — EN / SV / DE Language Settings — 2026-09-06

**One sentence:** A per-user language preference (English, Swedish, German) that switches all UI strings — navigation, button labels, status badges, error messages, field labels — while leaving compliance document content in its authored language.

**Problem it solves:**
Rushroom is a Swedish company likely to have Swedish and German-speaking staff, shop floor operators, and partners. The entire UI is currently hardcoded in English. Two distinct friction points:

1. **Shop floor and operations:** Work orders, manufacturing steps, and incoming inspection checklists are read and acted on by operators on the shop floor. English UI for Swedish-speaking operators is unnecessary cognitive overhead — especially under time pressure at the bench.
2. **Compliance and engineering:** Engineers navigating standards, deviation scans, and component records benefit from UI labels that match their natural language, even if the underlying compliance documents stay in English (EN is the standard language for EU regulatory content and that does not change).

**The two problems that must stay separated:**
- **UI language** (this idea) — button labels, navigation tabs, status strings, field names, error messages, modal titles. These are strings authored by us, stored in a catalog, swapped on language change. Clearly tractable.
- **Content language** — the actual text of standards, compliance documents, interpretations, and AI-generated analysis. These are authored documents, not UI strings. They stay in their authored language (typically English). This idea does NOT translate compliance content.

**MVP scope:**
1. **`language_preference` column on `users` table** — `TEXT NOT NULL DEFAULT 'en'` CHECK IN ('en','sv','de'). Migration only — one column.
2. **Org-level default: `default_language` on `organizations`** — `TEXT NOT NULL DEFAULT 'en'`. Fallback when user has not set a preference.
3. **New API action `updateUserLanguage(language)`** — updates `users.language_preference` for the current user. Simple single-column patch.
4. **String catalog: `assets/locales.js`** — a JS module exporting `const STRINGS = {en:{...}, sv:{...}, de:{...}}`. No library, no dependency. Approximately 200–300 keys covering: all navigation tabs and sub-tabs, all action button labels, all status badge strings (active/inactive/replaced/flagged, planned/in_progress/completed/shipped, etc.), all modal titles and field labels, all error messages. EN is the source; SV is the first translation (founders/team translate); DE second.
5. **`t(key)` helper in `assets/app.js`** — `const t = k => STRINGS[currentLang]?.[k] ?? STRINGS.en[k] ?? k`. Falls back to EN, then to the key itself — so missing translations are visible but never broken.
6. **Language initialisation on load** — on startup, fetch the user's `language_preference` from the session; set `currentLang` globally; re-render the UI. A `<select>` in the user settings area (or header) lets the user change language with immediate effect (no reload — re-render current view).
7. **Locale-aware number and date formatting** — replace all `toFixed()` and manual date strings with `Intl.NumberFormat(currentLocale)` and `Intl.DateTimeFormat(currentLocale)`. SV uses comma as decimal separator; this is the most visible formatting difference.

**What is deliberately out of scope:**
- Translating compliance document content, standard clause text, or AI-generated analysis
- RTL language support
- Server-side rendering of locale (all client-side)
- Machine translation of the string catalog (human translation by the team for SV; professional or human-reviewed for DE)

**AI output language gap (known issue, addressed incrementally):**
Claude currently generates all output in English — deviation scans, interpretation drafts, drawing extraction summaries, document diffs. If the UI is in Swedish, AI-generated text will still appear in English inline with a Swedish UI. This is jarring but not a blocker. The fix: pass `language_preference` to Claude prompts ("Respond in Swedish") when the user's language is not EN. Implement this as a Layer 2 enhancement after the string catalog is live — it requires updating every Claude call site in `portal-api/index.ts` to include the language instruction.

**Tables involved:**
- Extended: `users` (add `language_preference TEXT NOT NULL DEFAULT 'en'`), `organizations` (add `default_language TEXT NOT NULL DEFAULT 'en'`)
- New asset: `assets/locales.js` (string catalog — not a DB table)
- No new tables

**Effort estimate:** 14–20 hours
- Migration (2 columns): 0.5 h
- `updateUserLanguage` API action: 0.5 h
- String catalog — EN source + SV translation (~250 strings): 5–7 h
- `t()` helper + language initialisation in `assets/app.js`: 2 h
- Language picker UI (settings panel or header): 1 h
- `Intl.NumberFormat` / `Intl.DateTimeFormat` replacements throughout: 2 h
- DE translation (~250 strings, by team or reviewed MT): 3–5 h

**Risks:**
- **String catalog maintenance burden:** Every new UI element added to `app.js` must be added to all locale files. If a developer adds a string in English and forgets to add it to SV/DE, the fallback to EN is acceptable but inconsistent. Mitigation: a simple CI check that counts keys per locale and warns on mismatch.
- **Context-dependent strings:** Some strings change based on count ("1 component" vs "3 components") or gender (German grammatical gender on nouns). The simple `t(key)` approach handles neither. Mitigation: for plurals, add explicit keys (`component.count_one`, `component.count_other`); avoid grammatical gender in German by rephrasing to gender-neutral constructions.
- **AI output language gap:** Already described above. It is the most visible user-facing inconsistency in the MVP — set expectations with the team.
- **`currentLang` global state:** A global language variable works for a single-page vanilla JS app, but must be initialised before any UI renders. Load order matters — `locales.js` must load before `app.js` in `index.html`.
- **PROP-012 multi-tenancy:** Language preference is per-user, org-scoped naturally through the `users` table. No additional isolation logic needed.

**Related PROPs:**
- PROP-007 (this idea replaces the thin PROP-007 draft in SYSTEM_OVERVIEW — same PROP number should be used)
- PROP-012 (multi-tenancy — `users` and `organizations` tables already exist; these are the two tables being extended)
- PROP-021 / AI actions generally (Layer 2: pass language preference to Claude prompts to align AI output language with UI language)

**Status:** Raw idea

---
### Rich Part Data Record — Structured Component Metadata for PLM & DPP — 2026-09-13

**One sentence:** A dedicated `component_metadata` table captures structured physical, material, procurement, quality, and regulatory specs per component — version-snapshotted alongside revisions — so that the DPP generator can pull structured data directly without parsing documents.

**Problem it solves:**
Today a BOM node holds only name, part number, type, lifecycle status, and a description text field. Everything else — weight, dimensions, substrate material, surface treatment, incoming inspection method, country of origin — either does not exist in the system or lives as unstructured text in notes or attached PDF documents. This creates two compounding problems:

1. **PLM gap:** Engineers and buyers cannot answer basic questions from the system — "what does this part weigh?", "what's the surface treatment on this extrusion?", "what inspection method do we apply on incoming delivery?". They look it up in a PDF or ask someone.
2. **DPP rebuild risk:** ESPR Article 7 (Digital Product Passport, effective 2027) requires structured data at the component level — recycled content, carbon footprint, substances of concern, country of origin, HS code. If we store these as freeform document text now, we will need to re-enter every field manually when DPP reporting becomes mandatory. Building the structured fields now means the DPP generator reads from the database, not from PDFs.

**What already exists that overlaps:**
- `component_materials` already holds REACH/RoHS substance data at row level — this is one of the most important DPP data sets and it already structured. DO NOT duplicate substance declarations here.
- `bom_component_versions.version_snapshot JSONB` already captures a snapshot of component state at revision bump. This idea extends what gets snapshotted — metadata fields are included in the snapshot automatically.
- `component_specs` is proposed in two earlier ideas (Engineering Drawing Intelligence — dimension extraction from PDF drawings; PROP-021 Layer 4 — datasheet key-spec extraction). Both ideas write to a `component_specs` table. This idea consolidates: structured metadata lives in `component_metadata`, and AI extraction targets the same table. No separate `component_specs` table is needed.

**Metadata taxonomy — 5 sections:**

*1. Physical*
`weight_g NUMERIC` — net weight in grams (DPP, logistics)
`length_mm, width_mm, height_mm NUMERIC` — bounding box; LED furniture parts are well-described by L×W×H
`volume_cm3 NUMERIC` — computed or entered; relevant for packaging and material declarations
`unit_of_measure TEXT` — already on `bom_components`; move here or keep there (keep on `bom_components`, reference only)

*2. Material & finish*
`base_material TEXT` — substrate description ("6061-T6 aluminium", "HDPE", "304 stainless steel")
`surface_treatment TEXT` — ("anodized class II natural", "powder coated RAL 9003", "electrolytic zinc-nickel")
`color_specification TEXT` — RAL / NCS code or descriptive ("RAL 9003 signal white, gloss 60%")
`flame_retardant_class TEXT` — fire classification code where applicable (V-0, E30, etc.)

*3. Procurement & logistics*
`preferred_supplier_name TEXT` — informational; not a FK (suppliers not in DB yet)
`supplier_part_number TEXT` — supplier's own part number (distinct from `oem_number` on `bom_components`)
`lead_time_days INTEGER` — standard lead time in calendar days
`moq INTEGER` — minimum order quantity
`country_of_origin TEXT` — ISO 3166-1 alpha-2 ("SE", "DE", "CN"); required for DPP and customs declarations
`hs_code TEXT` — harmonised system commodity code (6 digits minimum, up to 10); required for CE/customs

*4. Quality & inspection*
`incoming_inspection_method TEXT CHECK IN ('none','visual','dimensional','functional','chemical','destructive','certificate_only')` — the method applied when this part arrives from a supplier. Drives the incoming inspection checklist (connects to the goods-receive / statistical control concept discussed separately).
`inspection_sample_size TEXT` — AQL level or fixed count ("AQL 2.5", "100%", "5 pcs")
`critical_to_quality TEXT` — free text; key CTQ characteristics stated by the engineer (e.g. "hole Ø6.0±0.05 — tolerance chain critical")
`has_cpk_requirement BOOLEAN DEFAULT false` — flag: this part requires a process capability study from supplier

*5. Regulatory & DPP*
`weee_category TEXT` — WEEE category code/name; required for WEEE reporting
`battery_regulation_applicable BOOLEAN DEFAULT false` — EU Battery Regulation 2023/1542 scope flag
`conflict_minerals_free BOOLEAN` — 3TG declaration (tantalum, tin, tungsten, gold)
`recycled_content_pct NUMERIC` — % recycled material by weight; ESPR data point
`carbon_footprint_kgco2e NUMERIC` — product carbon footprint per unit, kg CO₂ equivalent; ESPR data point
`carbon_footprint_source TEXT` — method or data source ("EPD", "supplier declaration", "Ecoinvent 3.9 estimate")
`end_of_life_instruction TEXT` — disassembly/recycling instruction text; feeds DPP Article 7(2)(h)
`repair_spare_part_available BOOLEAN DEFAULT true` — DPP repairability indicator

**Version control:**
`component_metadata` is a one-row-per-component table (keyed by `component_id UNIQUE`). It is NOT versioned independently. Instead, `bumpComponentVersion` already writes a `version_snapshot JSONB` on the new `bom_component_versions` row. That snapshot is extended to include a `metadata` key containing all `component_metadata` fields as they existed at bump time. Result: zero new tables for versioning, full history via the existing snapshot mechanism. The same approach used for documents and materials in PROP-024 applies here.

**MVP scope — what to build first:**
1. Migration: `component_metadata` table with all columns above, `component_id UUID UNIQUE NOT NULL FK→bom_components`, `organization_id NOT NULL FK→organizations`, RLS deny-all.
2. Two API actions: `getComponentMetadata(component_id)` → returns the row or nulls; `upsertComponentMetadata(component_id, fields...)` → inserts or updates the row.
3. Extend `bumpComponentVersion` to read `component_metadata` and fold it into `version_snapshot.metadata`.
4. Frontend — component detail panel: add three new tabs — **Specifications** (Physical + Material), **Quality**, **Regulatory**. Each tab shows read-only values with an Edit button that enables inline editing of the section. Save calls `upsertComponentMetadata`. A tab with no data shows a placeholder "No data entered yet" with an Add button instead.
5. Creation modal stays minimal (name + part number + type only). Engineers fill in metadata after creation in the detail panel.

**What deliberately stays out:**
- Substance declarations (REACH/RoHS) — these remain in `component_materials`, not duplicated here. The DPP generator reads both tables.
- Dimensional tolerances per feature — that is the Engineering Drawing Intelligence idea (drawing-extracted per-feature specs with tolerance_plus/minus). This idea captures the bounding-box dimensions only; feature-level tolerances are a Layer 2 extension.
- Supplier pricing — PROP-019 removed financial analysis from the portal. Procurement metadata (lead time, MOQ, preferred supplier) is logistics, not financial.
- Automatic DPP generation — this idea is the data layer; the DPP generator that reads and renders it is a separate PROP (referenced below).

**Tables involved:**
- New: `component_metadata` (one row per component; all structured fields)
- Extended (no schema change): `bom_component_versions.version_snapshot` (existing JSONB — just include metadata in the snapshot at bump time)
- API: two new actions (`getComponentMetadata`, `upsertComponentMetadata`), one extended action (`bumpComponentVersion`)
- Frontend: component detail panel (new tabs); no new pages

**Effort estimate:** 14–18 hours
- Migration (component_metadata, ~25 columns): 1 h
- `getComponentMetadata` + `upsertComponentMetadata` API actions: 2 h
- Extend `bumpComponentVersion` to snapshot metadata: 1 h
- Frontend — Specifications tab (Physical + Material sections, read/edit): 3 h
- Frontend — Quality tab (read/edit): 2 h
- Frontend — Regulatory tab (read/edit, boolean toggles + numeric fields): 3 h
- Frontend — tab navigation refactor in component detail panel: 1 h
- Testing + edge cases (null row, partial saves, version snapshot check): 2 h

**Risks:**
- **Column count:** 25+ columns on one table looks wide but is correct — structured columns are what makes DPP generation queryable. Resist the temptation to collapse into JSONB sections (loses type safety and queryability). Use `custom_specs JSONB` as the overflow valve.
- **Field ownership creep:** Without discipline, every team member will want to add one more column. Define a change process: new columns require a migration + a DPP justification.
- **Partial saves:** Users may fill in Physical but leave Regulatory blank for months. The system must tolerate a mix of NULL values gracefully — show "—" for empty fields, never block saves or creation on missing optional metadata.
- **`incoming_inspection_method` and the goods-receive feature:** This field is a property of the component (set by the engineer/quality manager), not a result of an inspection. It seeds the incoming inspection checklist (a future feature). The two must stay clearly separated in the UI.
- **DPP field accuracy:** `recycled_content_pct` and `carbon_footprint_kgco2e` will be supplier-declared or estimated. The system should store a `carbon_footprint_source` string to document the basis. Never present these as audited values.
- **PROP-012 multi-tenancy:** `component_metadata` carries `organization_id NOT NULL` like every other table. `upsertComponentMetadata` must verify the component belongs to the org before writing.

**Related PROPs:**
- PROP-013 (BOM tree foundation — `bom_components` is the parent table)
- PROP-024 (Component Version History — `version_snapshot` mechanism that metadata plugs into)
- PROP-021 Layer 4 (Datasheet AI extraction — writes `spec_name/value/unit` to `component_metadata` rather than a separate `component_specs` table; this idea defines where that data lands)
- Engineering Drawing Intelligence (IDEAS.md) — feature-level dimensional extraction from PDF drawings; complementary to the bounding-box dims here; both write to `component_metadata`
- PROP-005 (Generate DPP from compliance matrix — this idea is the component data source that DPP generation reads)
- PROP-014 (Compliance–BOM Integration — component evidence; the `component_metadata.incoming_inspection_method` feeds inspection checklists that generate evidence)
- PROP-012 (Multi-tenancy — `organization_id NOT NULL` on `component_metadata`)

**Status:** Raw idea

---
### Stocked Assembly Variants — Materialising Dynamic BOM Configurations as SKUs — 2026-09-13

**One sentence:** A "Materialise" action that converts a saved Dynamic BOM configuration into a first-class `bom_component` SKU — with its own part number, its own resolved BOM, and a back-reference to the source family — so pre-built assemblies can be stocked, pulled in work orders, and linked into other Dynamic BOMs.

**Problem it solves:**
Two distinct but related gaps prevent Rushroom from representing stocked assembly variants:

1. **Resolved configurations can't be pulled.** `saved_configurations` stores a resolved variant (e.g. "Side Panel - Design A"), but these are not `bom_components`. They have no part number, no `make_or_buy` flag, no lifecycle status, no lead time. They cannot be linked as a child in another Dynamic BOM, added to a `product_family_members` pull list, or referenced in a work order. A stocked variant IS a part number — it needs a full component record.

2. **No variant grouping.** If 50 side panel variants each become their own `bom_component`, they are 50 unrelated entries in the parts catalog. There is no machine-readable relationship between them — no "these are all generated from the same Dynamic BOM family with Design A through Design Z". When the source family BOM changes (a new screw type, a design dimension update), none of the 50 materialised SKUs receives any signal.

**What already exists that can be extended:**
- `saved_configurations` — named resolved configurations; serves as the source from which a materialised SKU is derived
- `bom_components` — the target; a materialised variant is a first-class row here
- `bom_edges.variant_condition` — already supports conditional edges; the resolved BOM for a configuration is the edges that pass `resolveVariant(family_id, selections)`
- `product_family_members` — pull list mechanism; a materialised SKU can be added as a family member once it has a `bom_components` id
- `make_or_buy` — a materialised assembled variant is `make_or_buy = 'assembled'` by default; a purchased one is `'purchased'`

**The key gap — no bridge from configuration to component:**
`resolveVariant` resolves the BOM tree for a given configuration, but there is no action that takes that resolved tree and creates a permanent `bom_component` record from it. That bridge — the "materialise" action — is the core thing missing.

**Design: two new nullable columns on `bom_components`:**
```
source_family_id  UUID FK→product_families  NULLABLE
source_config_id  UUID FK→saved_configurations  NULLABLE
```
These back-references let the Dynamic BOM family panel list all materialised variants. They also enable a "this SKU was generated from family X with config Y" audit trail — when the source family changes, a query immediately shows which SKUs were derived from it.

**MVP scope:**
1. **Migration:** Add `source_family_id` and `source_config_id` nullable columns to `bom_components`. No backfill needed — existing rows leave both null.
2. **New API action `materialiseConfiguration(saved_configuration_id, part_number, name, notes?)`** — server-side:
   - Validates: `saved_configuration_id` belongs to org; `part_number` is unique in org
   - Creates a new `bom_component` row with `make_or_buy = 'assembled'`, `lifecycle_status = 'inactive'` (user promotes to active when ready to stock), `source_family_id` and `source_config_id` set
   - Calls `resolveVariant(family_id, selections)` internally and copies the resolved `bom_edges` (with quantities) to the new component as its own BOM children
   - Returns the new `component_id`
3. **Variant group view on the Dynamic BOM family panel** — new "Stocked Variants" sub-section (below the BOM tree). Lists all `bom_components` where `source_family_id = this_family`. Shows part number, name, lifecycle status, `make_or_buy` badge, and a "Go to component" link. If the source config still exists in `saved_configurations`, shows the configuration summary.
4. **"Make Stocked Variant" button on saved_configurations rows** — opens a small modal: part number (pre-filled from family name + config summary, editable), name, notes. On confirm: calls `materialiseConfiguration`, redirects to the new component in the Parts catalog.
5. **New API action `listVariantsByFamily(family_id)`** — returns all `bom_components` with `source_family_id = family_id`. Used by the variant group view.
6. **Stale-source indicator:** When a Dynamic BOM family's BOM is edited AFTER a configuration was materialised, the materialised SKU's BOM may no longer match the source. Surface this as a soft warning on the stocked variant's Overview tab: "Source family was updated after this variant was materialised. Review BOM for changes." No automatic sync — user decides whether to manually update the copied edges or re-materialise.

**For variant-conditional quantities (same component, different qty per variant):**
This is the screw example (20 for Design A, 10 for Design B). The data model already supports it via multiple `bom_edges` for the same parent→child pair with different `variant_condition` values. The current blocker is the UI duplicate-child guard. Fix: allow multiple edges between the same parent and child when they have different `variant_condition` values. `resolveVariant` already filters correctly — only the edge whose condition matches is selected, yielding the right quantity. This is a small frontend + API guard change, no migration needed.

**How a stocked variant flows into work orders and Dynamic BOMs:**
- Once materialised, the SKU is a normal `bom_component` — it can be linked as a child in any BOM tree via `+child` / `addBomEdge`
- If the SKU is stocked and pulled ready-made for a larger assembly, it can be added to a `product_family_members` pull list for the parent product family
- Work orders for the parent family pull it from stock (Pull & pack — straight pick, no routing steps) rather than resolving its internal BOM on demand
- If it is assembled in-house for the order, its own `component_routing_steps` (per manufacturing family) define the operations

**Tables involved:**
- Extended: `bom_components` (add `source_family_id`, `source_config_id` nullable columns — migration)
- Read: `saved_configurations`, `product_families` (for back-reference and variant listing)
- Used: `bom_edges` (copied by materialise), `product_family_members` (if added to a family pull list)
- New actions: `materialiseConfiguration`, `listVariantsByFamily`

**Effort estimate:** ~6–8 hours
- Migration (2 nullable columns): 0.5 h
- `materialiseConfiguration` API action (resolve + copy edges + create component): 2 h
- `listVariantsByFamily` API action: 0.5 h
- Frontend — Stocked Variants sub-section on Dynamic BOM family panel: 2 h
- Frontend — "Make Stocked Variant" button + modal on saved_configurations: 1 h
- Frontend — stale-source indicator on Overview tab: 0.5–1 h
- Bonus: allow duplicate edges with different variant_conditions (frontend guard + API guard fix): 1 h

**Risks:**
- **Copied BOM divergence:** The materialised SKU's BOM is a copy — once copied, it is independent. If the source family BOM changes (new screw type, updated quantities), the SKU does not update automatically. The stale-source indicator is a soft prompt, not enforcement. For teams with many materialised variants and frequent BOM changes, this creates ongoing review overhead. A stricter design — "re-materialise always, never edit the copy" — is cleaner but removes the flexibility to maintain the stocked variant's BOM independently. MVP: soft indicator; enforce policy via process, not code.
- **Part number generation for 50 variants:** Manually typing a part number for each of 50 side panel variants is tedious. Auto-suggestion from family name + configuration axis values helps ("SP-A" for Side Panel Design A) but still requires human review. A naming template defined on the family ("SP-{Design}") could auto-generate part numbers — out of MVP scope.
- **Lifecycle status after materialise:** A fresh materialised SKU defaults to `inactive` (not yet in production). Someone must explicitly mark it `active` before it can be pulled in a work order. This is the right behaviour — but the user needs a clear callout ("newly created, currently inactive — activate when ready to stock").
- **source_config_id may become stale:** If the `saved_configuration` referenced by `source_config_id` is deleted, the back-reference goes nowhere. Use `ON DELETE SET NULL` on the FK — the SKU survives, just without the config link. `source_family_id` (FK to `product_families`) is the more durable reference.
- **`resolveVariant` scope:** If the Dynamic BOM family has hundreds of components in its BOM, copying all the resolved edges into the materialised SKU could create a large tree. This is correct behaviour (the materialised SKU IS that full assembly) but the user should be aware that editing 50 copies independently is maintenance overhead.

**Related PROPs:**
- PROP-015 (Configure-to-Order Variant BOM — `saved_configurations`, `resolveVariant`, `variant_condition` on edges; this idea depends on PROP-015 primitives)
- PROP-030 (Manufacturing BOM / Product Families — materialised SKUs participate in `product_family_members` pull lists for work orders)
- PROP-031 (Rich Part Data Record — materialised SKUs benefit from `component_metadata` for DPP and procurement; lead_time_days and make_or_buy are particularly relevant)
- PROP-032 (make_or_buy — materialised assembled variants default to `assembled`; purchased sub-assemblies use `purchased`)
- Ideas: "Dynamic BOM — Order-Driven Configuration Import" (complementary — that idea imports per-order configurations from the external system; this idea creates pre-stocked generic variants from the internal Dynamic BOM authoring flow)

**Status:** Raw idea

---
### BOM Tree — Depth-Semantics Audit & Dynamic BOM Button Rules — 2026-09-14
**One sentence:** Re-express every guard in the BOM tree renderer in terms of what it actually means (has a parent / is a Dynamic BOM child) instead of the `depth` integer, whose meaning silently shifted when the tree stopped rendering its own root.
**Problem it solves:** `buildRows()` seeds the root's children at `depth 0` because the root is drawn as the card header, not as a tree row. Every guard written as `depth > 0` or `depth === 0` therefore means one level off from what its author intended. This already caused a destructive bug (v202: the row `×` called `deleteComponent` on direct children of an assembly, wiping components from the registry). The same off-by-one is still live in two non-destructive places: `+child` is gated on `isDynamicBom ? depth === 0 : true`, so it appears on the *direct children* of a Dynamic BOM — exactly the sub-tree editing SYSTEM_OVERVIEW says must be impossible there ("a Dynamic BOM picks existing BOM Nodes including their full sub-trees; sub-tree management belongs on the component itself"). And `+sib` is gated on `parentNode && !isDynamicBom`, so it never appears in a Dynamic BOM at all, though Section 0 describes it as present on the family's direct children in link-existing-only mode. Code and documentation currently describe two different products.
**Decision (2026-09-14): a Dynamic BOM DOES accept sub-tree edits — option 3, "allow + warn".** `+child` and `+sib` stay available inside a Dynamic BOM, because the alternative (navigate away to the component's own tree) does not match how the tree is actually read and used. The hazard is not lost work but silent scope: there is no per-Dynamic-BOM copy of a sub-assembly, so adding a child writes an edge on the *shared* component and the change lands in every assembly and Dynamic BOM that uses it. The UI looks local; the effect is global. That directly contradicts the edge-scoped rule chosen for Move ("only affect what you are looking at"), and `+child` cannot honour it because it creates structure under a shared node rather than an edge on the row in front of you. So the edit is permitted and the blast radius is made visible at the moment of commit: the add-child modal calls the existing `listParentsOf` action (already powering the detail panel's "Used in" section) and states plainly which other assemblies this also changes, offering the `variant_condition` route (PROP-015) when a configuration-only difference was what was meant, or materialisation as a stocked variant SKU (PROP-033) when a genuinely separate thing was.
**MVP scope:** Encode the rule as a named boolean computed once per row (e.g. `isDynamicBomDirectChild`), never as a bare `depth` comparison. Grep `assets/app.js` for every remaining `depth` use, classify each as layout (the `connector()` ASCII maths — legitimately positional, leave alone) or permission (must be renamed), and fix Section 0 of SYSTEM_OVERVIEW to match whatever is decided. Ship with one throwaway Dynamic BOM exercised by hand.
**Tables involved:** None — pure frontend. No migration, no API change.
**Effort estimate:** 2–3 hours (1h decide + encode, 1h audit remaining `depth` uses, 1h doc reconciliation and manual test)
**Risks:** (a) Section 0 of SYSTEM_OVERVIEW currently documents the opposite rule ("+child and +sib on nodes at depth > 0 are hidden … sub-tree management belongs on the component itself") and must be rewritten when this ships, or the docs will contradict the code a second time. (b) `depth` legitimately drives `connector()` and the ancestor-last flag maths; renaming indiscriminately would break the tree glyphs. (c) Low blast radius otherwise: no data is written by either button, so a wrong call here is a UX annoyance, not a loss.
**Related PROPs:** PROP-015 (Dynamic BOM / product_family), PROP-016 (+sib button), PROP-017 (BOM tree UX polish), PROP-029 (finished_good leaf rule — also a `+child` visibility rule, same family of logic). Directly follows the v202 delete fix.
**Status:** Raw idea

---
### Component Soft Delete & Restore — Recoverable Registry Deletion — 2026-09-14
**One sentence:** Replace `deleteComponent`'s hard cascade with a `deleted_at` tombstone plus a Deleted tab that can restore a component and everything hanging off it.
**Problem it solves:** `deleteComponent` is irreversible and wide. It hard-deletes the `bom_components` row and cascades through `component_documents`, `component_materials`, `bom_component_versions`, `component_images` (including the storage objects), `work_order_components`, `component_routing_steps` and `product_family_members`. One misplaced click destroys a part's entire compliance record — its supplier declarations, RoHS/REACH evidence, revision history and uploaded drawings — with no undo. The v202 bug proved the cost is not hypothetical: a UI off-by-one routed ordinary unlink clicks into this path and a part was lost. Even with that bug fixed, the destructive path is one button away and guarded only by a confirm modal. For a system whose entire purpose is retaining compliance evidence for a 10-year statutory period, unrecoverable deletion is the wrong default.
**MVP scope:** Add `deleted_at TIMESTAMPTZ` and `deleted_by UUID` to `bom_components`. `deleteComponent` sets them instead of deleting, and stops cascading entirely — child rows simply stay put, which makes restore a single UPDATE rather than a re-insert of seven tables. Every read path filters `deleted_at IS NULL`. Add `listDeletedComponents` and `restoreComponent`, plus a "Deleted" tab beside Parts / Assemblies / Dynamic BOMs showing what was removed, by whom and when, with a Restore button. Keep a genuinely permanent `purgeComponent` behind a second confirmation for real removal. Edges need a decision: `bom_edges` already soft-closes via `effective_to`, so a restored component reappears as a standalone node with its former parent links closed — acceptable for an MVP, and honest about what was reversed.
**Tables involved:** `bom_components` (two new columns + partial unique index). Read-path filtering touches the ~20 `bom_components` queries in `portal-api/index.ts`. No new tables.
**Effort estimate:** 6–8 hours (1h migration, 2h rewrite `deleteComponent` + restore/purge actions, 2h audit and filter every read path, 2h Deleted tab UI, 1h testing)
**Risks:** (a) **Part-number collision — this shapes the design.** `bom_components` carries `UNIQUE (organization_id, part_number)`, so a tombstoned row keeps occupying its part number and re-creating the same number fails with a confusing constraint error. Mitigation: replace it with a partial unique index over `deleted_at IS NULL`, the same technique PROP-033 already used to relax the `bom_edges` constraint — precedent exists in this codebase. (b) **A missed read path shows ghosts.** Any of the ~20 queries left unfiltered will surface deleted components in pickers, BFS resolution or work-order pull lists. A single shared helper for the base query is safer than 20 hand-edited `.is("deleted_at", null)` calls. (c) Storage objects for images are no longer removed on delete, so disk grows until purge — acceptable, but `purgeComponent` must then do the storage cleanup the current code does. (d) Scope creep: the same tombstone pattern invites being applied to documents, standards and passports. Resist for the MVP; components are where the loss actually happened.
**How this interacts with PROP-012:** `bom_components` already carries `organization_id NOT NULL` with the org-immutability trigger, so tombstones are tenant-scoped for free. Two rules must hold: `listDeletedComponents` and `restoreComponent` filter on `organizationId` like every other action, and the partial unique index must stay scoped to `(organization_id, part_number)` so one tenant's tombstone can never block another tenant's part number. `deleted_by` references `users(id)`, which is a global table — fine, and it makes the platform audit trail legible across tenants.
**Related PROPs:** PROP-024 (Component Version History — full state access per revision; overlapping goal of recovering prior state, complementary rather than duplicate), PROP-013 (the `bom_component_history` audit trail, which already survives deletion because it has no FK to `bom_components` — the record that a delete happened is preserved today even though the data is not), PROP-033 (partial unique index precedent). Directly motivated by the v202 delete fix.
**Status:** Raw idea

---
### BOM Tree — Stable Sibling Order & Move Child Between Assemblies — 2026-09-14
**One sentence:** Give BOM edges a real stored position with `↑`/`↓` reordering, and add a select-then-place "Move…" action that re-parents a child to any destination the rules allow — no drag-and-drop.
**Problem it solves:** Editing a sub-assembly today is close to impossible without delete-and-recreate. Two separate gaps cause it. **(a) There is no stored position.** `bom_edges` has no `sort_order` column and `getBom` fetches child edges with no `.order()` clause at all, so the "Pos. 1, 2, 3" column is just the array index of an unordered Postgres result — sibling order is arbitrary and can silently reshuffle between loads. A BOM whose line numbers move on their own is not usable as a build instruction or a pull list. **(b) There is no way to re-parent.** A child linked under the wrong assembly can only be removed and re-added from scratch, which is exactly the flow that met the v202 delete bug. Drag-and-drop is the obvious answer and the wrong one here: a 5-column grid with a sticky header and collapsible depth makes hit-testing fiddly, it is unusable on a trackpad mid-tree, and it cannot express "move into a collapsed node". Select-then-place works at any depth, on any input device, and is how PLM tools actually do it.
**MVP scope:** Two independently shippable phases. **Phase A — order:** add `sort_order INT` to `bom_edges`, backfill deterministically (current arbitrary order frozen once, so nothing visibly jumps on deploy), order the `getBom` edge query by it, and add a `reorderBomEdge` action driven by `↑`/`↓` buttons that swap a row with its neighbour. Worth shipping alone — it fixes the reshuffling bug whether or not Move is ever built. **Phase B — move:** a `Move…` row action opens a picker of valid destinations only, committing through one `moveComponentToParent` action that closes the old edge, opens the new one, and writes a `bom_component_history` row. **Move is edge-scoped: a child that appears in several assemblies is moved only in the assembly currently being viewed, never in the others** — matching how `removeBomEdge` already behaves and how users read the tree they are looking at.
**Tables involved:** `bom_edges` (one new column + backfill + an index for ordered reads). No new tables, no change to `bom_components`.
**Effort estimate:** 8 hours total — Phase A ~3h (migration, backfill, ordered query, reorder action, two buttons), Phase B ~5h (destination-rule resolver, picker modal, move action, history row, testing)
**Risks:** (a) **Move must key on `edge_id`, not on `(parent_id, child_id)`.** PROP-033 replaced the old unique constraint with a partial index covering unconditional edges only, so multiple variant-conditional edges between the same pair are now legal by design. Any action keyed on the pair will hit all of them. This is not hypothetical: `removeBomEdge` currently issues a single UPDATE filtered on `parent_id` + `child_id` + `effective_to IS NULL` with no `variant_condition` filter and no limit, so in a Dynamic BOM where a child is linked under two variant conditions, removing one closes both. Worth fixing as its own small bug regardless of this feature. (b) **Cycle protection exists and must not be bypassed.** `trg_check_bom_cycle` (migration 0007) is a `BEFORE INSERT` trigger on `bom_edges` running a recursive-CTE ancestor walk, and `addBomEdge`'s catch of `"BOM cycle detected"` is live error handling for it. Phase B therefore does **not** need to build cycle detection — but it must commit a move as *close-the-old-edge-then-insert-the-new-one*, in that order, so the trigger evaluates against the post-move ancestor set. Inserting first can trip the guard on a legitimate re-parent within the same branch. Note the trigger fires on INSERT only, not UPDATE, so re-opening an edge by clearing `effective_to` would skip the check — Move must never do that. (c) Backfilling `sort_order` from an unordered read freezes whatever order happens to be current — acceptable, but it means the first deploy silently blesses an arbitrary order rather than a reviewed one. (d) The destination list must be computed server-side and re-validated on commit; a client-filtered list is a suggestion, not a permission.
**Destination rules to encode:** (1) not itself and not any descendant of the moving node — the cycle check above; (2) target must accept children, which excludes `finished_good` per PROP-029's leaf rule; (3) no duplicate unconditional edge to the same child, already enforced by PROP-033's partial index; (4) **Resolved 2026-09-14 — Dynamic BOM targets DO accept sub-tree edits (option 3, "allow + warn").** A move into or within a Dynamic BOM is permitted; where the destination is a shared component, the confirmation step names the other assemblies affected via `listParentsOf` before committing. Note the asymmetry this creates and keep it deliberate: **Move is edge-scoped** and genuinely only touches the assembly being viewed, whereas `+child` under a shared component is inherently global — same warning surface, different blast radius, and the wording must not imply otherwise.
**How this interacts with PROP-012:** `bom_edges` already carries `organization_id NOT NULL` with the org-immutability trigger. Both new actions must filter on `organizationId` like every other action, and the descendant/cycle walk must stay inside a single tenant — a cross-tenant walk would both leak structure and produce wrong answers.
**Related PROPs:** PROP-015 (variant-conditional edges — the reason edge_id keying is mandatory), PROP-033 (partial unique index; multiple edges per pair), PROP-029 (`finished_good` leaf rule), PROP-016/017 (BOM tree row actions and UX polish). Shared its open question with **BOM Tree — Depth-Semantics Audit** (2026-09-14) — resolved 2026-09-14 in favour of allow + warn for both — and is motivated by the same v202 delete incident.
**Status:** Raw idea

---
### AI Field Extraction — Fill the Specifications Tab from a Datasheet, Drawing or Screenshot — 2026-09-15
**One sentence:** Point the existing document-reading AI at the component detail panel's ~28 metadata fields, so a datasheet, drawing or pasted screenshot proposes values for review instead of being retyped by hand — and report every value it found that has no field to go in.
**Problem it solves:** PROP-031 added a rich part record — Physical, Material & Finish, Procurement, Quality, Regulatory/DPP — and every one of those fields is currently filled by hand, from a datasheet that already states them. That is slow, it is where transcription errors enter compliance data, and the tedium means fields quietly stay empty: the ESPR/DPP fields in particular only pay off if they are actually populated across the part range. The second half matters as much as the first: when a document states something the schema has nowhere to put, nobody finds out. Today that information is silently dropped; it should be surfaced, because recurring homeless values are the strongest available signal for which columns the schema is still missing.
**What already exists to extend:** Most of this is built. `suggestComponentMetadata` already reads an uploaded document and returns structured output from Claude against a JSON schema, and it is already wired into the "New BOM Node" modal's autofill. It proves the pattern end to end — prompt, `output_config.format.json_schema`, storage download, error handling. What it does *not* do is cover the metadata fields: its schema stops at `part_number`, `oem_number`, `name`, `type`, `description`. This idea is that same mechanism pointed at `component_metadata`. `custom_specs JSONB` (PROP-031) already exists as the overflow column and is the natural home for extracted values with no matching field.
**MVP scope:** A "Fill from document" button on the Specifications tab. It offers documents already linked to the component (`component_documents`) and images already attached (`component_images`), plus a drop zone for a new file. New action `extractComponentSpecs` (component_id, source) returns, per field: the proposed value, the value *as printed* including its unit, a short evidence snippet, and a confidence. The panel shows proposed values beside current ones, pre-ticks only high-confidence fields that are currently empty, and writes through the existing `upsertComponentMetadata` on accept. **Nothing is ever written without review.** Alongside the mapped fields it returns `unmapped`: values the document states that no field accommodates, each with a suggested key. Those are written into `custom_specs` so nothing is lost, and a later pass can count recurring keys across parts to propose real columns.
**Tables involved:** `component_metadata` (target, including `custom_specs`), `component_documents` and `component_images` (sources), `ai_usage_events` (metering — see PROP-012 below). No new table for the MVP; aggregating recurring unmapped keys into a "missing fields" report may want one later.
**Effort estimate:** 10–12 hours (3h schema + prompt for ~28 fields with units and evidence, 2h the action incl. image support, 4h review-and-apply UI, 1h wiring the two existing sources, 2h testing against real datasheets)
**Risks:** (a) **Images do not work today, and this is the headline use case.** `fileBlock()` branches on extension: `pdf` becomes a document block, `docx`/`xlsx` are text-extracted, and **everything else falls through to `TextDecoder`** — so a PNG or JPEG screenshot is decoded as raw bytes into garbage text and the model is asked to read it. It will not error; it will confidently return nothing useful. A `type: "image"` content block for png/jpeg/webp/gif is a prerequisite, not a nice-to-have, and it also unlocks the existing `component_images` photos as a source. (b) **Hallucinated values landing in compliance data.** A wrong flame-retardant class or WEEE category is worse than an empty one, because it looks authoritative and will be exported into a DPP. Mitigations: review-before-apply with no auto-write path, an evidence snippet per field so a claim can be checked against the document without opening it, and pre-ticking only high-confidence fields that are currently empty — never overwriting a human-entered value by default. (c) **Units.** "50" is meaningless without knowing whether the sheet said mm, cm or inches, and `weight_g` versus a sheet quoting kg is a factor-of-1000 error that will pass review unnoticed. The schema must carry the value *as printed* with its unit and make the conversion explicit in the UI. (d) **Multi-part catalogue pages.** A datasheet covering a family of screws will happily yield the wrong row. The model must name which part it matched and decline when the document does not clearly identify one. (e) **Cost.** `SCAN_MODEL` is `claude-opus-4-8` and a large PDF is not a cheap call. Extraction accuracy is worth it — this is not the classification-style work CLAUDE.md reserves for haiku — but a cheap haiku pre-check ("does this document describe this part at all?") would avoid spending opus tokens on an unrelated upload.
**How this interacts with PROP-012:** AI spend is metered per tenant through `ai_usage_events` with plan caps from Stage 4, so `extractComponentSpecs` must record usage and respect those caps like every other AI action rather than becoming an unmetered side door — it is the most token-hungry action in the product, since documents go into the prompt whole. Sources must be org-scoped: the component, the document and the image all have to belong to the caller's organization before anything is downloaded from storage.
**Related PROPs:** **PROP-031** (the metadata fields this fills, and `custom_specs` as the overflow). **PROP-021 Layer 4** — "data extraction" is already the planned fourth layer of Component Document Lifecycle; this is that layer, arriving from a different entry point (the Specifications tab rather than the document pipeline), and the two should be reconciled rather than built twice. **Engineering Drawing Intelligence** (2026-09-02) overlaps deliberately but differently: that idea is deep and drawing-specific (title block, tolerances, revision diffing, compliance re-test signals), this one is broad and shallow (any document, any field, review and apply) — this is the sensible first step, and the drawing work can specialise later on top of it. **PROP-014** (Component Evidence Bridge) is where extracted values would eventually need to cite their source document as evidence.
**Status:** Raw idea

---
### Complete the BOM Node Audit Trail — Document Revisions as First-Class Change Events — 2026-09-16
**One sentence:** Make every change that affects a BOM node appear in that node's Change Log — including new revisions of its drawings and documents — and bump the component revision when a drawing changes, with an optional approval flow layered on top.
**Problem it solves:** The premise behind this idea is correct and the system does not honour it: the Change Log is documented as merging three canonical sources — field snapshots, component revisions, and linked documents — but document events never arrive. Two independent reasons, both verified against production rather than inferred:

1. **The document query is broken and the error is swallowed.** `getComponentChangelog` selects `id, category, label, created_at, uploaded_by` from `component_documents`, but that table has no `created_at` — the column is `uploaded_at`. PostgREST rejects the query, `docRes.data` comes back null, and the handler only checks `histRes.error`. So the merge quietly proceeds with zero document entries. Confirmed by running the exact select: `ERROR 42703: column "created_at" does not exist`. The feature has never worked; it looks implemented because the code that intends it is right there.
2. **A new document revision never touches the component.** `addDocumentVersion` calls `insertDocumentVersion` and nothing else — it creates no `component_documents` row, writes no `bom_component_history` entry, and does not bump `bom_component_versions`. So even with reason 1 fixed, uploading Rev C of a drawing would still leave the BOM node's trail unchanged: the link row records the *first* attachment, not subsequent revisions.

The consequence for compliance is the point. A technical file has to show what a part looked like when it was assessed. Today the component revision trail (61 revisions) and the document revision trail (6 versions) are disconnected, so "Rev B was tested against drawing Rev 2" is not recorded anywhere and cannot be reconstructed after the fact.
**MVP scope:** Three steps, each independently useful. **(a) Fix the trail.** Correct the column name, and check `verRes.error`/`docRes.error` rather than only `histRes.error` — a silently empty source is the failure mode that hid this. **(b) Make document revisions component events.** When a new version is added to a document that is linked to a component, write a `bom_component_history` row (`change_type` widened to include `document_revised`) naming the document, the old and new revision, and who uploaded it. That alone makes the trail honest. **(c) Bump the node.** A new revision of a document whose `category = 'drawing'` triggers `bumpComponentVersion` on every component it is linked to, with `spec_summary` citing the drawing and its revision — so the component revision and the drawing revision are tied together at the moment they change, which is what makes "tested against Rev 2" reconstructable later. Non-drawing categories (datasheet, declaration) record a history row but do **not** bump: a supplier reissuing a datasheet is not a change to our part.
**Approval flow (deliberately separate, not MVP):** `document_versions` has no status column at all — `id, document_id, version, file_name, storage_path, notes, uploaded_by, created_at, source_document_version_id, source_standard_version_ids, organization_id`. So there is currently no way to express draft vs released, and the shop floor would consume whatever was uploaded last. A `status` (draft / released / superseded) plus an approver and timestamp would make release an explicit act — and only a transition to `released` would bump the component. That is a clean second phase; doing it first would block (a) and (b) behind a workflow debate.
**Tables involved:** `component_documents` (the broken join; `uploaded_at`), `document_versions` (status/approver in phase 2), `bom_component_history` (`change_type` CHECK widened — currently `created|updated|version_bumped|document_linked`), `bom_component_versions` (the bump). No new tables for the MVP.
**Effort estimate:** (a) ~1 hour · (b) ~3 hours · (c) ~3 hours · approval flow ~6–8 hours
**Risks:** (a) **Widening `change_type` needs a migration** — the CHECK constraint was already widened once (0010) and rejects unknown values, so writing `document_revised` without it fails at insert time, inside a try/catch that treats history writes as non-fatal. It would fail silently, which is exactly the class of bug this idea exists to remove. (b) **A drawing linked to many components fans out** — one revision could bump twenty nodes. Correct, but it should be visible: the bump summary must name the drawing so twenty revisions do not look like twenty unrelated edits. (c) **Retroactive gaps stay gaps.** Fixing the query surfaces existing `component_documents` rows from their `uploaded_at`, but the six existing `document_versions` were never linked to components, so no history can be invented for them — the trail becomes correct going forward, not backwards, and the docs should say so rather than implying completeness. (d) **Bumping on every drawing upload could be noisy** during design iteration; the approval flow is the answer, which is an argument for phase 2 following quickly rather than for delaying (c).
**How this interacts with PROP-012:** All four tables carry `organization_id NOT NULL` and go through `tdb()`, so the fan-out in (c) stays inside one tenant by construction. The only new care is that a document linked across components must bump only components in the same organization — which `tdb()` already enforces, provided the fan-out query uses it rather than the raw client.
**Related PROPs:** **PROP-021 Component Document Lifecycle** (*Now*) — Layers 2–4 are new revision, AI diff, data extraction; this idea is the audit half of Layer 2 and should be built with it rather than beside it. **PROP-013** — the Change Log this repairs. **PROP-014 Evidence Bridge** (*Next*) — once a drawing revision is a component event, "this revision invalidates that test report" becomes expressible. **Engineering Drawing Intelligence** (2026-09-02) — its revision-diff and re-test signals assume exactly the wiring described here, so this is its prerequisite. **PROP-024 Component Version History** — full state per revision, complementary.
**Status:** Raw idea


---
### Drawings as a First-Class Domain — Carve Engineering Drawings Out of Documents — 2026-09-16

**One sentence:** Give engineering drawings their own tables, their own top-level DRAWINGS tab and their own revision/approval semantics, reusing the document store only for the file bytes — so that AI interpretation, tolerance chains and drawing-to-drawing relationships have somewhere to live that is not a generic file-link table with a `category` column.

**Problem it solves:**

Today a drawing is a `documents` row + a `document_versions` row + a `component_documents` link whose `category` happens to be the string `"drawing"`. That models a *file attached to a part*. It does not model a drawing.

What a drawing actually is, and where each part of it has no home today:

| Drawing concept | Where it lives now |
|---|---|
| Drawing number (its own identity, independent of any part) | nowhere — `documents.name` is a free-text filename |
| Revision (Rev A/B/C, a controlled sequence) | `document_versions.version`, free text shared with datasheets |
| Approval state (draft → checked → approved → released → superseded) | nowhere — `document_versions` has no status column at all |
| Title block (drawn by, checked by, date, scale, projection angle, sheet N of M) | nowhere |
| Tolerance block / general tolerances | nowhere |
| Individual dimensions with nominal + upper/lower limits + datum | nowhere |
| Assembly drawing → detail drawing relationships | nowhere |
| Which BOM assembly a drawing depicts | nowhere — only a flat part link |

Six of eight have no home. The pattern of the last few weeks has been fields that are accepted and then displayed nowhere; this is the same failure one level up — an entire entity type with no schema, wearing a document's clothes.

**Why the 2026-09-02 entry said the opposite, and why that has changed:**

*Engineering Drawing Intelligence* (2026-09-02) states explicitly: "Drawing intelligence is NOT a new tab or module. It is intelligence layered onto the existing component record." That was the right call **for that scope** — extract a title block, diff two revisions, prompt a revision bump. All of that genuinely is a thin layer on a component.

It stops being right the moment tolerance chains enter. A stack-up analysis is an ordered path of dimensions across *several* drawings for *several* parts in one assembly, each with a nominal and a tolerance band, producing a computed worst-case and RSS result. That is a graph over dimension entities. There is no version of `component_documents` that holds it, and no amount of AI on top of a file-link table produces one. The 2026-09-02 entry did not anticipate that requirement; this entry does. The older entry is not wrong — it is **the payload that should land on this spine instead of on `component_documents`**.

**The window is open right now, and it will not stay open:**

`component_documents` currently holds **zero rows** in production (verified 2026-09-16 — it is also how PROP-044 was found). `document_versions` holds 6, `documents` 12, none of them drawings. There is no data to migrate, no link to rewrite, no user habit to unlearn. The same carve-out attempted after a year of drawings is a migration project with a re-linking script and a re-training problem. Doing it before the first drawing is uploaded costs a migration file and nothing else.

**Architecture intent — reuse the bytes, not the meaning:**

The mistake to avoid is a Drawings tab that re-implements upload, storage, signed URLs, retention and versioning for one category. None of that is drawing-specific.

- `drawings` is the entity: drawing number, title, current revision, status, projection angle, sheet size, scale.
- `drawing_revisions` is its controlled history, each row pointing at a `document_versions` row for the actual file. The document library keeps owning bytes; the drawings domain owns meaning.
- `drawing_components` links a drawing to the parts it depicts (many-to-many — a detail drawing shows one part, an assembly drawing shows a whole sub-assembly, a part may have detail + installation + wiring drawings).
- `drawing_dimensions` is the row type that makes tolerance chains possible later: nominal, upper, lower, datum, feature label, source revision. Empty in the MVP, populated by AI in the follow-on.

One domain, two entry points, deliberately cross-linked this time: a top-level **DRAWINGS** tab (the drawing register — every drawing, its revision, its status, which parts it is on), and a **Drawings** tab in the part panel showing the same records filtered to that part. The failure that produced PROP-044 was two screens with no route between them; the fix is not "one screen", it is "two screens that each name the other".

**What this does to the Documents tab:** `drawing` leaves the component document category list. Documents keeps datasheets, test reports, declarations, quality certs — things that genuinely are *files about a part*. That tab gets simpler, not more complex.

**What survives from PROP-043/044:** all of the semantics, none of the placement. The rule that a drawing revision advances the BOM node's revision while a datasheet revision does not, the `document_revised` history event, stating the consequence before upload and the outcome after — these move onto `drawing_revisions` unchanged. PROP-044's "New revision" modal is the seed of the drawings revision flow, not throwaway work.

**MVP scope — prove the spine, no AI:**

The value to prove is that drawings-as-entities is the right model. AI is the second step and it lands better on a real schema.

1. Migration: `drawings`, `drawing_revisions`, `drawing_components`, `drawing_dimensions` (created empty, so the AI step adds no schema). Every table `organization_id UUID NOT NULL FK → organizations`, RLS deny-all.
2. API: `listDrawings`, `getDrawing`, `createDrawing`, `addDrawingRevision`, `linkDrawingToComponent`, `unlinkDrawingFromComponent`, `setDrawingStatus`.
3. Top-level **DRAWINGS** tab: register list — drawing number, title, current revision, status, parts count. Filter by status, sort by number. Same list conventions as Parts (sticky filters, scrollable list) so it is not a new interaction language.
4. Part panel gains a **Drawings** tab: the drawings on this part, revision and status, plus "New revision" carrying the PROP-043 bump rule, and a link through to the register.
5. Approval state as a plain enum with explicit transitions — draft → checked → approved → released, and released → superseded when a newer revision is released. No approval *routing* (no assignees, no notifications, no gates). The state is the MVP; the workflow is not.

**Tables involved:**
- New: `drawings`, `drawing_revisions`, `drawing_components`, `drawing_dimensions` — all `organization_id NOT NULL`
- Read/reuse: `document_versions` (file bytes + storage path), `documents` (the library row), `bom_components`, `bom_component_versions`, `bom_component_history` (the PROP-043 audit events)
- Shrinks: `component_documents` loses the `drawing` category

**Effort estimate:** 14–18 hours
- Migration (4 tables, RLS, indexes): 2 h
- Backend (7 actions, tenant-scoped via `makeTdb`): 4 h
- DRAWINGS register tab (list, filters, detail): 4–5 h
- Part panel Drawings tab + revision flow (ports PROP-044): 3 h
- Status transitions + audit wiring into `bom_component_history`: 2 h

**Risks:**
- **Two places to upload a file.** The real risk of the carve-out: a user uploads a drawing through Documents anyway. Mitigated by removing `drawing` from the component document categories entirely, so the wrong path stops existing rather than merely being discouraged.
- **A second versioning concept.** `drawing_revisions` alongside `document_versions` is two version chains over one file. They must not drift: `drawing_revisions` is authoritative for drawing revision letters, `document_versions` for bytes. The rule needs to be written down and one direction of truth enforced in the API, or this becomes the next silent-mismatch bug.
- **Scope gravity.** Approval workflow, ECO process, GD&T parsing and tolerance stack-ups will all pull at this. The MVP is the register and the revision chain. Everything else is a later PROP landing on this schema — which is the entire point of building the schema first.
- **Empty-tab problem.** A DRAWINGS tab with nothing in it is worse than no tab. Ship with the part-panel entry point and an empty state that says how to add the first drawing, the way PROP-044 did for documents.
- **PROP-012 multi-tenancy:** drawings are among the most confidential per-tenant IP in the system. All four tables carry `organization_id NOT NULL`, scoped through `makeTdb` from the signed session, never from the request — same rule as everywhere, higher stakes.

**Related PROPs:**
- **Engineering Drawing Intelligence (2026-09-02)** — direct overlap and the main dependency relationship. That entry's AI extraction, revision diff and revision-bump prompt should be **rebased onto this schema**: extracted fields become `drawing_dimensions` + title-block columns instead of a generic `component_specs` table. Build this first; that second.
- **PROP-043 / PROP-044** — the revision-audit semantics and the revise-from-the-part flow port onto `drawing_revisions` directly.
- **PROP-021 Component Document Lifecycle** — Layers 2–4 were scoped over `component_documents`. With drawings carved out, Layer 4 (`component_specs`) may not be needed at all for drawings; it still applies to datasheets.
- **PROP-014 Compliance–BOM Integration** — a released drawing revision is exactly the trigger for a `pending_retest` signal; cleaner to fire from a drawing status transition than from a generic document upload.
- **PROP-024 Component Version History** — a version snapshot should cite the released drawing revision it was built against.

**Status:** Raw idea
