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
