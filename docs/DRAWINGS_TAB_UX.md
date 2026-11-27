# The Drawings tab — rename and UI/UX proposal

Status: PROPOSAL, 2026-11-25. Nothing here is built. Three independent
reviews of the tab (daily engineering use, release control and the supplier
boundary, PLM information architecture) were synthesised into this list; the
evidence lines point at the code as it stands (`assets/app.js`,
`renderDrawings` from line 12112).

## 1 What the tab is

The top-level tab called **Drawings** holds four things: the CAD Models
register (3D source, Rev letters), the Drawings register (controlled 2D
documents, Issue letters), the Surgery Templates register (physical jigs,
each a drawing of type `surgery_template` with faces and QR codes) and the
change-order test agent. The word "Drawings" then appears three times before
the first table row: the tab, the sub-tab, the card heading. Nobody looking
for a Fusion model or a jig has a reason to click "Drawings".

## 2 The name

| Candidate | Case | Verdict |
|---|---|---|
| **CAD & Drawings** | Literal. Names the two registers it holds. What an engineer says ("skicka CAD och ritningar"). Honest today with no other move. | **Recommended now** |
| **Engineering** | The department word; the owner of CAD, drawings and the BOM. Honest only once the Product BOM leaves "As Operated" (ROADMAP already flags that misfiling). Then: Parts · CAD Models · Drawings · Surgery Templates. | Recommended as the second step |
| Product Definition | PLM umbrella (Windchill/Teamcenter sense). Covers the BOM too, but abstract to a supplier and longer than every sibling tab. | Possible, not preferred |
| Design Data / Engineering Data | PLM-tool speak. Nobody at a furniture company calls a drawing "data". | No |
| Technical Documentation | In a CE portal this means the Annex IV technical file, which is the As Operated side. Misleads. | No |

Sub-tabs in data-flow order, since a drawing is made from a CAD revision:
**CAD Models · Drawings · Surgery Templates**, landing on CAD Models.
`supplier.html` keeps "Drawings": for a supplier the tab is only released
drawings, and nothing else should be offered there (see §4).

## 3 Structure

1. **One sub-tab bar, not three stacked ones.** Surgery Templates becomes a
   sub-tab. Today it is a chip in the row "Engineering | Surgery Templates |
   All" under the Drawings register, where selecting it throws the table
   away and renders a different screen with different objects. "All" (jig
   drawings mixed into the drawing list) is deleted; a template's own card
   already links its drawing. The chip "Engineering" goes with it, which also
   frees the word for the top tab later.
2. **No card heading repeating the sub-tab name.** The count moves into the
   toolbar ("51 models").
3. **The test agent lives with its subject.** The robot button moves from
   the sub-tab bar into the CAD Models toolbar beside Refresh, with the word
   "Test agent" next to the icon, and its panel mounts inside the CAD
   Models register. Today it is an unlabeled icon that opens above whichever
   register is showing, turns Release-green when active, and is visible
   while looking at surgery templates where it means nothing.

## 4 What the supplier gets

Today the supplier shell renders the Drawings | CAD Models bar, the Surgery
Templates chip, six status chips and the Free drawings chip, and the server
refuses or empties all of them (`listCadModels`, `listSurgeryTemplates` are
Rushroom-only; a supplier's `listDrawings` returns released issues only). A
supplier can click five things that only fail. For the supplier role: one
register, no sub-tab bar, no type bar, no status chips, no Free drawings
chip; columns Number · Title · Issue · Belongs to · Supplier drawing no.

## 5 The registers

### CAD Models

| Today | Proposed |
|---|---|
| ▶ · Part no. · Component · Formats · Rev · Status · Preview / Release / Fusion | ▶ · Part no. · Part · **Rev** (letter + chip, "F Released · G Draft" when two facts) · **Drawings** (each depicting drawing: number + released issue, then the §5.4 warning chips) · **Supplier sees** (Rev C, or —) · Updated · Preview / Fusion |
| Formats column (badges) | Inside the expanded row only; the register answers "is there a STEP" by the Preview button being enabled |
| Status column | Dropped: the chip in the Rev cell is the status |
| No sort, server order, cached | Sortable headers (the Drawings register already has the sorter), default newest update first, reload on window focus so a send from Fusion shows up without Refresh |
| Status filter Draft / Released | The five statuses, same chip row as Drawings |
| Amber notice paragraph explaining auto-stamp and release | Removed |

This makes the CAD register the part-centric coherence view STATUS_MODEL
§7 promises and §5.4 says should be here. `listCadModels` must return the
depicting drawings and `statusSummary` per model (the same helper
`getComponentCad` uses). The warnings exist today and are thrown away: the
expanded row calls `getComponentCad`, receives `summary`, and never reads it.

### Drawings

| Today | Proposed |
|---|---|
| Number · Title · Issue · Status · Belongs to · Supplier no. · Used on · Supplier (Yes/No) | Number · Title · **Issue** (letter + chip) · **Part** (name + part no.; "+2" only when used on more than one; "free" when unowned) · **Supplier sees** (Issue B, or —) |
| Search matches number and title only | Search matches number, title, part name, part number, supplier drawing no. in both registers, same placeholder |
| "Supplier" Yes/No | Replaced by the derived fact: a drawing with the flag on but no released issue is invisible to the supplier, and the column says Yes today |
| "Supplier no." / "Supplier ID" / "Supplier drawing number" (three names, one field) | "Supplier drawing no." everywhere; "Supplier issue" for their revision |
| "Belongs to · #2" | The counter goes; the drawing's role (depicts / installation / wiring) is the fact worth showing if any |
| Empty-state paragraphs | "No drawings." |

The drawing surface rail gains one row, **Made from**: "CAD Rev B ·
1a2b3c4d" when the issue records its source STEP (`source_cad_file_id` /
`source_sha256`), nothing otherwise. The portal stores this fact and no
screen shows it.

## 6 Release

- **The row button.** A green primary Release sits on every draft row in a
  register of 51 drafts, and CAD goes draft → released in one native
  `confirm()`. Proposed: Release leaves the main row and lives in the
  expanded revision group, where the letter, chip, files and stamps are
  visible; it is not the primary colour.
- **A release modal with facts, not a confirm().** One fact per line, labels
  outside: Rev · Files (or "none") · Supersedes · Drawings of this part (each
  with its released issue) · Warnings (§5.4 chips) · Supplier will see. The
  data is one `getComponentCad` call the button already makes. The same
  modal serves drawing release from the surface.
- **Zero files.** The server lets a revision be released with no file
  (ROADMAP records the same for drawings). Proposed: refuse server-side.
- **Same discipline in both registers.** A drawing row gets the same
  expandable revision group as a CAD row (letter, chip, who/when, Mark
  checked / approved / released). Today one register releases in one click
  and the other in three screens.

## 7 Vocabulary and copy

- One chip set for both registers: All · Draft · Checked · Approved ·
  Released · Superseded, reading the current revision.
- "Part" as the heading in both registers (not "Component").
- Letters bare in cells, the word only in the header ("Issue" / "Rev").
- Drawing copy that says "Rev A" or "advances the revision letter of every
  part" is deleted (it also describes a model that no longer exists).
- Every `.notice` paragraph on the tab is removed; the amber class is
  reserved for the §5.4 warnings and a failed load. Empty states are a noun
  phrase.

## 8 New drawing modal

Three stacked steps with helper sentences and a review step that collects
projection angle, sheet size and scale, which no screen displays (ROADMAP
calls this the "accepted and displayed nowhere" pattern). Proposed: keep the
order part → file → review, lay the review as one row (Title · Supplier
drawing no. · Supplier issue · Supplier), labels above, "Free drawing" as a
bare checkbox, and drop the three undisplayed fields from the form and the
AI schema unless a place is chosen to show them.

## 9 Order of work

| Step | Scope | Effort |
|---|---|---|
| A | Rename the tab; one sub-tab bar with Surgery Templates; remove headings, notices, help copy; supplier shell reduced to its register; test agent into the CAD toolbar | small, frontend only |
| B | CAD register: Drawings + Supplier sees + Updated columns, sort, five-status filter, focus reload; `listCadModels` returns depicting drawings and summary | medium, frontend + portal-api |
| C | Drawings register: columns, search, Supplier sees, one name per field; "Made from" in the rail; `listDrawings` returns the owner's part number | small, frontend + portal-api |
| D | Release: modal with facts, button out of the main row, zero-file refusal, revision group on drawing rows | medium, frontend + portal-api |
| E | New drawing modal as one row; drop undisplayed fields | small |

A, B and C can go in one release. D changes behaviour and deserves its own.

## 10 Decision and contract — 2026-11-25

Decided by ziirvass: **CAD & Drawings**, steps A + B + C in one release.
`supplier.html` keeps "Drawings". Release (D) and the modal (E) wait.

### API additions (portal-api), backwards compatible — fields added, none removed

**`listCadModels`** — every row additionally carries:

| field | meaning |
|---|---|
| `drawings` | the drawings linked to the model's part through `drawing_components`: `[{ id, drawing_number, title, role, current_revision, current_status, released_revision, is_supplier_visible }]`, depicting first, then by number |
| `warnings` | `statusSummary({ drawings, cad }).warnings` for the part, the same computation `getComponentCad` makes: `[{ code, text, drawing_id? }]` |
| `supplier_sees` | the released Rev letter, or `null` (what a supplier may build from) |
| `updated_at` | the newest `created_at` among the model's revisions and files, else the model's `created_at` |
| `current_revision_id` | id of the current revision (saves the register one `getComponentCad` per release) |

Three more queries in total, not per model: `drawing_components` for all
component ids, `drawings` for those ids, `drawing_revisions` for those ids.

**`listDrawings`** — every row additionally carries `owner_part_number`
(the owner component's part number, `""` when free) and `supplier_sees`:
the released issue letter when `is_supplier_visible` and a released issue
exists, else `null`. The supplier role already receives released issues
only; for them `supplier_sees` equals `revision`.

**`getDrawing`** — every revision additionally carries `source_cad`:
`{ cad_revision, file_name, sha_short }` when `source_cad_file_id` resolves
to a `cad_model_files` row (its `cad_model_revisions.revision`), else when
`source_sha256` matches a file's `sha256`, else `null`. `sha_short` is the
first eight hex characters.

### Frontend (assets/app.js, index.html, supplier.html), cache v456

A. `index.html` tab text "CAD & Drawings" (ids unchanged). Rushroom shell:
one sub-tab bar CAD Models · Drawings · Surgery Templates, landing on CAD
Models; the type bar (Engineering / Surgery Templates / All) is deleted and
the Drawings register shows `drawing_type !== "surgery_template"` only;
Surgery Templates renders the existing template screen in its own content
element. Supplier shell: the drawings register alone, no sub-tab bar, no
status chips, no Free drawings chip, columns Number · Title · Issue · Part ·
Supplier drawing no. No `h3` headings inside the cards; counts in the
toolbar ("51 models", "3 drawings"). The test-agent button moves into the
CAD Models toolbar beside Refresh, labelled "Test agent" with the icon, not
primary-coloured when open; its panel mounts at the top of the CAD Models
content. Every `.notice` paragraph on the tab goes; empty states are "No CAD
models.", "No drawings.", "No templates.", "No revisions.". Part-card
cross-references say "CAD & Drawings".

B. CAD register columns: ▶ · Part no. · Part · Rev · Drawings · Supplier
sees · Updated · actions (Preview · Release · Fusion, unchanged for now).
Rev cell: letter + chip, two facts when `released_revision` differs from
`current_revision` ("F Released · G Draft"), no separate Status column.
Drawings cell: one line per drawing, `drawing_number` + released issue
letter (or "—"), then the `warnings` as amber chips (`statusWarningChip`).
Supplier sees: "Rev C" or "—". Updated: date, tabular. Sortable headers
(reuse the Drawings `head(label, key)` pattern), default `updated_at`
descending. Status filter chips: the five statuses, same row builder as the
Drawings register. Formats appear in the expanded row only. Both registers
reload when the window regains focus (`visibilitychange` → visible) if they
were loaded more than 30 s ago.

C. Drawings register columns: Number · Title · Issue (letter + chip, two
facts when needed) · Part (owner name, then part number in the mono style
the CAD register uses; "+N" when `parts_count > 1`; "free" when unowned) ·
Supplier sees ("Issue B" or "—"). Search matches number, title, owner name,
owner part number and supplier drawing number; placeholder "Search…" in
both registers. One name per field: "Supplier drawing no." and "Supplier
issue" in the rail and the New drawing modal; the rail visibility checkbox
is labelled "Supplier", label outside the box. Drawing surface rail gains
"Made from" → "CAD Rev B · 1a2b3c4d" when `source_cad` is set, nothing
otherwise. Capitalise statuses in the test-agent select. Letters bare in
cells, the word in the header.

## 11 Step D — release discipline (contract, 2026-11-25)

Decided by ziirvass: build D. CAD keeps the draft → released shortcut
(STATUS_MODEL §5.1: the Fusion flow has no checker); the UI stops making it
the primary action on the register, and every release, CAD or drawing, goes
through one modal that lays out the facts.

### API additions (portal-api), Rushroom only

**`previewRelease`** `{ kind: "cad" | "drawing", revision_id }` → the facts
the modal shows, computed with the same rules the release uses:

```
{
  kind, word: "Rev" | "Issue",
  object: { id, part_number, component_name, drawing_number?, title? },
  revision: { id, revision, status, created_at, checked_at, checked_by, approved_at, approved_by,
              files: [{ format, file_name, sha8, fusion_version }] },   // a drawing has one file
  can_release: boolean, refusal: string | null,   // "Issue B is not the current revision; C is",
                                                  // "Cannot go from draft to released", "Rev B has no file"
  supersedes: { id, revision, released_at } | null,
  related: kind == "cad"
    ? { drawings: [{ id, drawing_number, title, role, current_revision, current_status, released_revision,
                     made_from: { cad_revision, sha8 } | null }] }   // of the part; made_from = the released issue's source
    : { cad: { current_revision, current_status, released_revision, this_issue_made_from: { cad_revision, sha8 } | null } | null },
  warnings_now: [{ code, text, drawing_id? }],      // statusSummary today
  warnings_after: [{ code, text, drawing_id? }],    // statusSummary with this revision released (pure recomputation)
  supplier_now:   { cad_released_revision, drawings: [{ drawing_number, released_revision }] },
  supplier_after: { ... same shape, as it would be after the release }
}
```
`refusal` carries exactly the text the release would answer with; the modal
shows it in place of the Release button. `warnings_after` and
`supplier_after` are computed by feeding `statusSummary` / the supplier
view the revision list with this revision's status set to `released` and
the previously released one to `superseded`; nothing is written.

**Zero-file refusal** in `releaseRevisionRow` (so `releaseCadRevision`,
`setCadRevisionStatus`, `releaseCadModel`, `setDrawingRevisionStatus`,
`setDrawingStatus` and `registerCadRevision { release: true }` all get it): a
CAD revision with no file rows → 400 "Rev B has no file"; a drawing
revision without `storage_path` → 400 "Issue B has no file".

### Frontend (assets/app.js, v458)

- **One release modal**, `releaseModal(kind, revision_id, { onDone })`,
  `openModal` titled "Release Rev B · <part number> <part name>" / "Release
  Issue B · <drawing number> <title>". A `dl` with labels outside the values:
  Revision (letter, chip, checked/approved who+when when stamped) · Files
  (format badge + name + sha8, or "none") · Supersedes (letter + released
  date, or "—") · Drawings of this part (CAD: one line per drawing: number ·
  released issue or "—" · "made from Rev X" when known) / CAD of this part
  (drawing: released Rev and whether this issue was made from it) ·
  Warnings (the `warnings_after` chips, "none" when empty) · Supplier will
  see (`supplier_now` → `supplier_after`, "nothing" when empty). Buttons:
  Release (`btn-primary`) · Cancel. When `can_release` is false the Release
  button is replaced by the refusal text. Release posts `releaseCadRevision
  { cad_model_revision_id }` or `setDrawingRevisionStatus { drawing_revision_id,
  status: "released" }`, closes, calls onDone. Errors in a red line in the
  modal. No `confirm()` anywhere in the drawings/CAD code.
- **CAD register**: Release leaves the main row (Preview · Fusion remain).
  In the expanded revision group the current revision shows Release as
  `btn btn-xs` (not primary) when `canTransition` allows it, opening the
  modal; a released or superseded revision shows no button.
- **Drawings register**: every row gets the ▶ expander the CAD register has
  (Rushroom only). The group, loaded with `getDrawing` on first expand, lists
  one line per issue: letter · chip · who/when (checked, approved, released
  stamps) · file name · Open (the surface at that issue). The current issue
  carries its transitions as `btn btn-xs`: Mark checked / Mark approved /
  Back to draft, and Release through the modal. Clicking number or title
  still opens the surface.
- **Drawing surface**: the "Mark released" action opens the same modal; the
  other transitions stay direct.
- After a release both registers reload silently and an expanded row stays
  expanded.

## 12 Three states, and step E (contract, 2026-11-25)

Decided by ziirvass: "as few statuses as possible, without losing control".
Checked and Approved go. A revision is **Draft · Released · Superseded**, on
drawings and on CAD alike, and the controls that stop a bad release are the
ones built today: the release modal with the facts, the zero-file refusal,
the released-by stamp and the Change Log. The day a second engineer reviews
another's drawing, the honest form is a "Reviewed by" stamp on the issue,
not a state. Found while testing step D: a draft issue reading "Approved
25/11/2026 · Checked 25/11/2026" — what five states cost in a company of one.

### Rules (STATUS_MODEL §5.1 replaced)

| From | To | Who | Effect |
|---|---|---|---|
| draft | released | rushroom | `released_at/by`; the previously released revision → superseded; refused without a file, refused unless current |
| released | superseded | automatic | never by hand |
| superseded | — | | terminal |

`canTransition(kind, from, to)` in `status-core.mjs` has exactly these for
both kinds. `setDrawingRevisionStatus` / `setDrawingStatus` /
`setCadRevisionStatus` answer 400 "Cannot go from draft to checked" for the
retired words. The enum `drawing_status` keeps its five values (no row uses
checked or approved; dropping values is a later migration with the 0063
clean-up). The `checked_*` / `approved_*` columns stay, unwritten.

### Frontend

- Filter chips in both registers: All · Draft · Released · Superseded.
- The issue group (Drawings register) and the CAD revision group: no Mark
  checked / Mark approved / Back to draft; the current draft revision has
  Release (through the modal) only.
- The drawing surface rail: the same.
- The release modal's Revision line shows the chip and the created date;
  no checked/approved stamps.
- `REVISION_TRANSITIONS` in app.js mirrors the new table.
- Vocabulary: three words on screen, Draft · Released · Superseded;
  `drawingStatusChip` / `drawingStatusLabel` keep rendering the two retired
  words for any old row a future import might carry.

### Step E — the New drawing modal

One modal, three moments, no sentences:

1. **Part** — the part search and list as today (preselected and skipped
   when opened from a part), plus a bare checkbox **Free drawing**, label
   outside the box. Next.
2. **File** — the drop zone; the file is uploaded and read on landing as
   today. The "PDF or image…" sentence goes; the step pill row stays as the
   only orientation.
3. **Review** — ONE row, labels above the controls, in this order: Title ·
   Supplier drawing no. · Supplier issue · Supplier (checkbox). The
   confidence badge stays on a label when the AI read the field. Save.
   Projection angle, sheet size and scale are removed from the form, from
   `createDrawingWithRevision`'s accepted body, and from
   `extractDrawingMeta`'s key list and prompt in portal-ai (the columns stay
   on `drawings`, unwritten, until the 0063 clean-up). The identity note
   ("The drawing number and revision letter are assigned…") and the free
   drawing explanation are deleted.

Context line at the top of steps 2 and 3: "Drawing for <part name>" or
"Free drawing", as a plain label.

## 13 Dynamic drawings, layer 1 — the Dimensions table, Render, Compare, Keep (contract, 2026-11-26)

Decided by ziirvass (`docs/DYNAMIC_DRAWINGS.md` §4.1, §6, §7 Phase 3; the
eleven §9 decisions as recommended). Layer 1 is one form writing one
operation: pick a dimension row on a draft, set a tolerance or a name, render
the same draft again, compare, keep. No AI, no viewer change, no new letter.
Everything in this section is Rushroom only; §13.6 is the supplier's whole
share of it; §13.8 (Phase 4) adds the sheet as the second way in. Server contract: `getDrawingSpec`, `applyDrawingSpecOps`,
`requestDrawingRender { mode: "iterate" }`, `acceptDrawingIteration`,
`discardDrawingIteration`, `getDrawingRenderArtifacts` in portal-api (commit
e6e91cf). Frontend: `openDrawingSurface` in assets/app.js, styles.css, cache
v467 on index.html and supplier.html.

### 13.1 Entry — the one render button, text by status

The rail keeps one button in the slot "New issue from CAD" held. Its text is
decided by the current issue's status and stated before the click; the user
never picks a letter.

| Current issue | Button | Posts | Result |
|---|---|---|---|
| draft C with `render_job_id` | **Re-render Issue C (draft)** | `requestDrawingRender { component_id, cad_model_revision_id, drawing_id, mode: "iterate", spec_patch_id }` | the candidate replaces C's file on Keep; still C, still Draft |
| released B (or superseded with a released current) | **New issue D from CAD** | `requestDrawingRender { …, mode: "issue", drawing_id }` as today | draft D; the accepted patch travels (origin `carry`) |
| draft without `render_job_id` (hand-uploaded) | **New issue from CAD** as today | mode `issue` | unchanged behaviour |

Rules: **Re-render** is enabled only while **Patch (n)** holds a proposed
step (the server answers 409 "only a proposed patch renders" otherwise);
`cad_model_revision_id` is the current issue's **Made from** revision when
recorded, else the part's current CAD revision; `spec_patch_id` is the latest
proposed seq. While a render job is open the button is disabled, as today.

### 13.2 The Dimensions section

Under **Issues** in the rail, heading **Dimensions (233)** — the count from
the current issue's `dimensions.json` (`artifacts.dimensions_url` of
`getDrawingSpec`). An issue without a sidecar (a render before Phase 1, a
hand-uploaded PDF) shows **No dimensions.** and nothing else of §13.2–13.5.

| Column | Source | Notes |
|---|---|---|
| Sheet | `row.sheet` | bare number |
| Feature | `row.feature` | the drawset feature text ("Ø5 at (37, 58.5)") |
| Kind | `row.kind` | mono |
| Value (from STEP) | `row.value` | read-only; the label carries "from STEP" — the one place the no-typed-values rule is visible |
| Tol | `row.tol` | "—" when none; the template or kind tolerance is **not** filled in here |
| View | `row.view` | the view id |

Filter: one input above the table, placeholder **Search…** (same as the
registers), matching Feature · Kind · Tol · View; the heading count does
not change with the filter.

**The one-row form.** Clicking a row on a **draft** issue opens one row
directly under it, labels above the controls, in this order:

| Row kind | Form | Op posted |
|---|---|---|
| `dia` | **Tolerance** · **Name** · Apply · Cancel | `override_dimension { at, kind, tol?, name? }` |
| `depth` · `groove_width` · `groove_depth` · `pocket_depth` | **Tolerance** · Apply · Cancel | `override_dimension { at, kind, tol }` |
| any other kind in `TOLERANCE_KINDS` (`outline`, `hole_position`, `hole_depth`, `edge_bore_depth`, `counterbore_depth`, …) | **Tolerance for all pocket_depth** (the row's kind) · Apply · Cancel | `set_tolerance { kind, tol }` |
| a kind in neither list | nothing opens | — |

Tolerance is typed as drawset prints it (`±0.2`, `+0.5 -0`); the validator's
`parseTolerance` is the only check and its refusal is the red line. Every op
carries `reason` = the Patch line in words (§13.3). Apply posts
`applyDrawingSpecOps { drawing_id, ops: [op], parent_seq, origin: "click" }`
with `parent_seq` = the latest seq the surface loaded (0 when none).
Cancel closes the row. One form open at a time. Clicking a row on a
**released** or **superseded** issue opens nothing.

| Answer | On screen |
|---|---|
| 200 `{ seq, patch, rejected, touched }` | the form closes; Patch (n) gains the line; `touched` rows turn amber |
| 200 with `rejected[]` | the refusal reason in red under the form, the form stays |
| 400 `parent_seq required` / "no governed spec yet" | the text in red under the form |
| 409 stale parent | the surface repaints (`paint()`), the form reopens with its values, the text in red; from × or Revert (no form) the text stands under the Patch lines |

### 13.3 Patch (n)

Under the table, heading **Patch (3)** — what the latest snapshot holds on
top of the accepted one: the diff of `getDrawingSpec.latest.patch` against
`patch.patch`, keyed by kind (tolerances) and by `(at, kind)` (overrides).
The server composes every new seq on the latest row whatever its status
(`applyDrawingSpecOps`), so a candidate left by Edit, a failed render and a
discarded step stay in the lines until × or Keep clears them — nothing rides
into the next Render unseen. One line per difference in words, then **×**:

| Op | Line |
|---|---|
| `override_dimension` tol | "depth tol +0.5 −0 on Ø5 at (37, 58.5)" |
| `override_dimension` name | "name Hinge cup on Ø35 at (22, 100)" |
| `set_tolerance` | "pocket_depth tol ±0.2 for all" |
| `remove_override` | "remove depth tol on Ø5 at (37, 58.5)" |

**×** never deletes a row (the chain is append-only): on an
`override_dimension` line it posts `remove_override { at, kind }`, followed
by the accepted override again when the accepted patch had one at that
address (remove first: the server merges `override_dimension`); on a
`set_tolerance` line it posts `set_tolerance { kind, tol }` with the kind's
value from the accepted patch, or is absent when the accepted patch has none
for that kind; on a "remove …" line (an accepted override the latest
snapshot lacks) it posts that override again. A difference the one-row form
cannot make (a hole rule, a pair, a datum) lists without ×. The rows a line touches stay amber until the next Keep or
Discard. **Render** sits to the right of the heading and is the §13.1
Re-render button's twin: same post, same job panel; the heading reads
**Patch (0)** and Render is disabled when nothing is proposed.

### 13.4 Render and Compare

Render mounts the existing job panel (`drawingRenderJobPanel`,
`_drSurfaceJobs` continuity) in the rail's job slot: Claim · Download ·
Render · Verify · Upload · Register, the last reading **Candidate ready**
when `job.mode = "iterate"`. On done the file pane splits in two iframes,
captions as plain labels: **Issue C** (the current PDF) left, **Candidate**
(`getDrawingRenderArtifacts { job_id }.pdf`) right. Under the pane, in this
order:

1. **The strip.** "233 → 233 · 2 tolerances changed · 0 values changed ·
   geometry same as Issue C" — `diffDimensionLists(current, candidate)`
   keyed `(at | feature) + kind` (`PortalDrawingSpecCore` loaded the way
   `cost-math.mjs` is, else the copy in app.js naming the source);
   `counts.a → counts.b`, `tol_changed`, `value_changed`; "1 tolerance
   changed" in the singular; "+2 added · 1 removed" appended only when
   non-zero. The issue named is the one on the left. Geometry:
   `geometry_sha256` equal → "geometry same as Issue C"; different →
   "geometry differs from Issue C" in amber. A non-zero `value_changed` is
   amber: datums or the STEP moved, not a tolerance.
2. **Verification**, a `dl` with labels outside, from `job.result.verify`:
   Round trip (`round_trip`, "0 mismatches") · Completeness
   (`completeness_missing`, "0 missing") · Wall flags (`wall_flags`, "none"
   or the flags) · Regression (`regression`, "OK"). A non-zero, non-empty or
   FAIL value is amber.
3. **Unmatched overrides (n)**, amber, one line per `job.result.unmatched_overrides`
   entry in the §13.3 words; absent when none.
4. Buttons: **Keep** (`btn-primary`) · **Discard** · **Edit**. Keep stands
   on every `done` job — an amber verification line (a wall flag, a mismatch)
   is drawset's report on a passing render and never withholds it; only a
   `failed` job has no Keep. The compare mounted is the **newest** candidate
   (the job this session rendered when it is done, else the last of `open`);
   Edit dismisses that job alone, so a later render still gets its strip.

| Button | Posts | Then |
|---|---|---|
| Keep | `acceptDrawingIteration { job_id }` | `paint()`: the PDF reloads, **Made from** and the pins read the candidate, the letter and the Draft chip are unchanged, the history gains "#4 · click · 2 tolerances · 14:32", Patch (0) |
| Discard | `discardDrawingIteration { job_id }` | the candidate's files are removed (`files_removed`), the history line keeps the seq with status Discarded, the pane closes, Patch (0) |
| Edit | nothing | the pane closes; the candidate stays in the history as Candidate; the table's next Apply builds on its seq (`parent_seq` = its seq) |

A job that failed verification (`status = failed`, the Verify step red)
shows the strip, the verification lines and **Discard · Edit** only.
Errors from Keep or Discard (409 "was kept meanwhile", "Patch seq 5 was
accepted after this candidate") are the red line under the buttons; the
surface repaints on 409.

### 13.5 The Spec section

A rail section **Spec**, a `dl` with labels outside the values, from
`getDrawingSpec`:

| Label | Value | Rule |
|---|---|---|
| Template | "flat_panel v2" (`template.name`, `template.version`) | "—" when `template` is null (a legacy name-only render) |
| | "v3 available" amber after the version when `template.drift` | **Rebase** beside it is Phase 6 (a `carry` row on the new base); in v467 the amber text stands alone |
| Patch | "#4 · 6 ops" (`patch.seq`, the op count of `patch.operations`) | "—" when no accepted patch |
| History | one line per `history[]` row: "#4 · click · 2 tolerances · 14:32", then the status chip | origin words: click · dialogue · carry · hand; status words below |
| | **Revert** on an accepted, discarded, candidate or failed row that is not the latest | a new seq, never a delete, whose ops — rebuilt in the browser from the two snapshots (`drRevertOps`: remove before re-add where the server merges) — remake that row's patch; posted as ordinary `click` ops. Only the snapshots the server handed over (`patch`, `latest`, `open`) can be rebuilt; where they cannot (snapshot not loaded, a tolerance / datum / edge name that must go away, views, sheets) the button is disabled and carries the reason as its title |

Clicking Template shows the body read-only when the surface has it; v467
has `body_sha256` only, so the line is text. History is collapsed to the
last three lines with "all (12)" opening the rest.

Patch status words, one chip set, the `drawingStatusChip` colours reused:
**Proposed** (written, not rendered) · **Candidate** (rendered and verified,
compare open or left by Edit) · **Accepted** (the draft's file) ·
**Discarded** · **Failed** (render or verification failed; the draft
untouched). Amber is used for `drift`, a changed value, a different
geometry, a failed verification line and unmatched overrides — nothing else
in §13.

### 13.6 What a supplier sees

Nothing. The supplier shell (`supplier.html`) renders its one register of
released, supplier-visible issues (§4) and the released PDF through
`supplierFileUrl`. No Dimensions section, no Patch, no Spec, no Render,
no candidate, no PNG sheet, no sidecar: none of the §13 actions is in
`SUPPLIER_ACTIONS`, each answers 403 "Rushroom only", and a draft, iterated
or not, does not exist for a supplier. The `?v=467` bump on supplier.html is
cache hygiene, not a feature.

### 13.7 Vocabulary added

| Word | Where |
|---|---|
| Dimensions (n) · Value (from STEP) · Tol · View | the table |
| Tolerance · Name · Tolerance for all <kind> · Apply · Cancel | the form |
| Patch (n) · Render · × | the patch list |
| Re-render Issue C (draft) · New issue D from CAD | the entry button |
| Candidate ready | the job panel's last step |
| Issue C · Candidate | the split pane captions |
| n → m · k tolerances changed · v values changed · geometry same as Issue C / geometry differs from Issue C | the strip |
| Round trip · Completeness · Wall flags · Regression | verification |
| Unmatched overrides (n) | the amber list |
| 1 · 2 · 3 · Fit · 100% · Plain PDF · Sheets | the sheet bar (§13.8) |
| n selected · kind ×k · <face> face, x a–b, y c–d · × | the selection chips (§13.8) |
| Keep · Discard · Edit | compare buttons |
| Spec · Template · Patch · History · v3 available · Rebase · Revert | the Spec section |
| Proposed · Candidate · Accepted · Discarded · Failed | patch status chips |
| No dimensions. | empty state |

### 13.8 The sheet — PNG sheets, the overlay, the marquee (Phase 4, 2026-11-26, v469)

The second way to the same control (`DYNAMIC_DRAWINGS.md` §6 "The sheet",
§7 Phase 4). When the **current** issue was made by a render job and its job
left sheet PNGs and an entities sidecar (`getDrawingSpec.artifacts.png_urls`,
`entities_url`), the file pane shows the PNGs instead of the PDF iframe:
`PortalViewer.renderSheets` in `assets/viewer.js`. Any other file — an older
issue, a hand-uploaded PDF, a render before Phase 1 — takes the iframe path
unchanged. The PDF stays the artefact of record; **⤓ Download** still hands
it out.

| Element | Rule |
|---|---|
| Bar | tabs **1 · 2 · 3 · 4** (one per sheet), then **Fit** / **100%** (one button, the zoom it switches to on the next click is not stated; the active state marks 100%), then **Plain PDF** |
| Plain PDF | the iframe as before with one button **Sheets** above it; the choice is kept per drawing for the session |
| Overlay | an SVG in paper mm over the PNG (`viewBox` = `size_mm`, y flipped, strokes do not scale); the frame drawset draws at (20, 10) → (W−10, H−10) is drawn faintly on every sheet as the calibration box |
| Box | one rect per sidecar entity; a box with linked rows (`features` non-empty) outlines faintly and takes the pointer; hover outlines it in the accent and shows its text (native title); an unlinked box shows its text on hover and nothing else |
| Click | selects the box's linked rows (`row.entity` = the entity's index on `row.sheet`): the table narrows to them, the first scrolls into view and, on a draft, opens the §13.2 form — the same form, the same op |
| Shift-click | adds the box's rows to the selection; no form moves |
| Marquee | a drag draws a dashed rectangle; on release every box it touches is selected and the rectangle is kept, mapped through the sheet's face view to model coordinates |
| Chips | under the Search box: "4 selected · pos_y ×4", then the model rectangle "inside face, x 40–120, y 300–380" when the marquee crossed a face view, then **×** (clears; the table widens again) |
| Row → sheet | clicking a table row lights its box (and turns the sheet to it) whether or not the row opens a form |
| Touched | a box whose rows the patch touched is amber, like its rows |
| Compare | when the current issue shows sheets, **Candidate** shows the candidate's PNGs with the same overlay from the candidate's sidecar, the touched boxes amber; the two panes turn to the same sheet together; a candidate box selects its rows in the one table. A candidate without PNGs falls back to its PDF as in §13.4 |

The marquee's model rectangle is drawset's inverse of its own face-view
transform (`REC.view`: paper x = ox + (sx·x − p0)·s, paper y = oy +
(y − ya)·s); a marquee on a sheet with no face view, or outside its bbox,
keeps no rectangle. Nothing of this is in `SUPPLIER_ACTIONS` or
`supplier.html` (§13.6); the `?v=469` on supplier.html is cache hygiene.

### 13.9 The dialogue — Scope · Ask · the card · Promote (Phase 5, 2026-11-27, v470; v471 after the first-patch fix)

Decided in `docs/DRAWING_DIALOGUE.md` (its seven §9 decisions as recommended).
Under the selection chips in the Dimensions section, on a **draft** issue,
Rushroom only. Server contract: `proposeDrawingSpecOps` (portal-ai, SCAN_MODEL),
`applyDrawingSpecOps` with `origin: "dialogue"` and `turn_id`,
`promoteDrawingSpecOps`, `discardDrawingSpecTurn`, `getDrawingSpecVersion`
(portal-api); migration 0069; the worker mirrors `specs/<name>.yaml`.

| Element | Contract |
|---|---|
| **Scope** | label outside, one segmented row: **This callout · This drawing · Template flat_panel v1**. *This callout* is enabled only while the chips hold a selection and is preselected when something is marked; otherwise *This drawing*. *Template* is disabled on a per-part spec with the reason as its title ("side_panel_left is a per-part spec: migrate to flat_panel first"). The scope is a **ceiling** the engineer sets; the model never proposes a level |
| **Ask** | one input, placeholder **Ask…**, ≤ 2000 characters, Enter or **Send**; disabled while the call runs; an error in red under it |
| Send | `proposeDrawingSpecOps { drawing_id, prompt, scope, selection: { sheet, entities[], region_model }, parent_seq }` — the marked rows travel with their `at`; the marquee's model rectangle when there is one |
| **The card** | **Operations**: one line per admitted op in the Patch (n) wording, a checkbox (on), the reason in grey, the level badge (*callout · drawing · template*); under Template scope an op below its ceiling reads "stays on this drawing" in grey. **Stays code** (amber): "request — category · lives_in: detail" (categories needs_code · house_style · value_in_spec · not_in_step · ambiguous · relation · scope). **Questions**: one sentence each |
| **Apply** | the checked ops → `applyDrawingSpecOps` (`origin: "dialogue"`, `turn_id`, prompt, selection, proposal); touched rows and boxes amber; Patch (n) gains the lines; Render as in §13.3. Under Template scope with a template-level op checked the button reads **Promote to flat_panel v2** and posts `promoteDrawingSpecOps`: a new immutable version (`origin = portal`), this drawing carried onto it (`origin = carry`, status proposed), the surface repaints on the new version; other drawings show "v2 available" |
| **Discard** | `discardDrawingSpecTurn { turn_id }`; the card closes; the turn stays as declined |
| **From** (layer 1) | a position row on a hole (`pos_x`, `pos_x_far`, `pos_y`, `pos_y_top`) opens **From** [edge] · Apply · Cancel instead of a tolerance: the edge names come from the template and the patch ("front edge", "top edge"), the current edge is preselected, Apply posts `override_dimension { at, kind: pos_x \| pos_y, from }`. A relation row (c/c, CTQ) opens nothing, as before |
| Patch lines | "pos_y from top edge on Ø5 at (41, 1319)" · "sheets from the bottom" · a removed datum reads "remove pos_y datum on …"; × works as for any override; the sheet plan lists without ×. × on a kind-tolerance line the accepted patch has no value for posts `remove_tolerance` ("general tol back to the template"), found missing in the live proof: until then such a line could only be replaced, never unset. Revert can take a tolerance away the same way |
| Spec | Template reads "flat_panel v2 · promoted" when the pinned version came from a turn, then "3 on v2 · 48 on v1" in grey under it |
| Strip | a per-dimension datum move is one row gone and one new at the same address with the kind swapped (`pos_y` → `pos_y_top`, `pos_x` → `pos_x_far`): the strip says "k dimensions measured from the other edge" and counts only the rest as added / removed (amber). `geometry_sha256` moves on such a swap — truthfully: a dimension measured from the other edge is a different dimension |
| History | a promotion's seq reads "#7 · carry · 1 op · 1 promoted"; a dialogue seq "#8 · dialogue · 2 tolerances" |

Vocabulary added: **Scope · This callout · This drawing · Template · Ask… ·
Send · Operations · Stays code · Questions · Apply · Promote to flat_panel v2 ·
Discard · stays on this drawing · From · from the top edge / from the bottom
edge / from the left edge / from the right edge · sheets from the bottom /
from the top · k dimensions measured from the other edge · promoted · n on vN**.

What a supplier sees: nothing (§13.6 holds; none of the five actions is in
`SUPPLIER_ACTIONS`, portal-ai denies suppliers by default).

