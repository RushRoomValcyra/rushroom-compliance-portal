# Dynamic drawings — the spec as a governed document, edited from the sheet

Status: DESIGN + CONTRACT, 2026-11-26, nothing built. Follows DRAWING_RENDER.md
(render jobs, 2026-11-25) and the template decision of 2026-11-26 ("one spec
per part is unreasonable"). Asked for by ziirvass the same day: "plan for the
design and implementation of the dynamic drawings engine." Three designs were
drafted from different angles (smallest increments first; the spec as a
governed PLM document first; the Claude-Design-like interaction first), scored
against each other and merged; the challenges raised in that review are
answered one by one in §11.

## 1 Why

A drawing issue is a derived document, and since 2026-11-25 the portal records
what it was derived from: the STEP sha of a named CAD revision, the spec name,
drawset's dimension-list fingerprint. What the portal does **not** hold is the
spec itself. It is a YAML file in a folder on one Mac that is not under git,
and every change to how a part is annotated — a tolerance class, a datum, a
section, a named edge — is a text edit there followed by a re-render by hand.
With 51 parts and one template that is the wall: the engineer who wants a
tighter depth tolerance on two dowel holes has to leave the portal, edit a
file, and come back with a new letter.

The user asked for the opposite: "add a chat inside the create-a-drawing
functionality, so we can iterate the actual drawing inside the portal instead
of coding a new static script — change the tolerance on one certain
measurement; mark out an area of a drawing and prompt what the drawing engine
shall do, as Claude Design does."

The principle that makes this safe is already the house rule: **every number
on a drawing comes from the STEP, and the spec holds no dimension value**
(VALCYRA_STEP_to_2D_Drawing_Instruction.md §3: "if a value is needed and is
not in the STEP, stop and ask"). Geometry and annotation are therefore
separable terms. The chat edits the annotation term — the spec — and never the
drawing; a re-render then proves the result against the STEP the way every
render is proved today (round trip, completeness, regression). Nothing in this
design draws a line, moves a text or types a length. If a request cannot be
expressed as a spec operation, the answer is "that is code", named by file and
function, and it goes to the drawset backlog.

Three consequences follow and shape everything below:

1. The spec must become a **governed document in the portal** before anyone
   edits it there: immutable template versions, a per-drawing patch as a
   versioned record, both pinned on every rendered issue. A drawing you cannot
   regenerate from recorded inputs is not under configuration control,
   whatever the Released stamp says.
2. The portal owns the **patch**; the Mac owns the **function**. The template
   (`flat_panel.yaml`) and drawset stay where OCP runs; the per-drawing
   exception travels to the worker as data. One per part was rejected on
   2026-11-26; a patch over a house template is the only form that survives
   both a CAD revision and a template improvement.
3. AI is **optional, never load-bearing** (PROP-039, PROP-046). Clicking a
   dimension and typing a tolerance produces the same operation the dialogue
   would; both go through one validator, one render, one diff and one Keep.
   The model proposes; the vocabulary gate decides; drawset's verification
   decides again; the engineer decides last.

## 2 What exists

Facts the design stands on, with where they live.

**drawset** — `/Users/famqvick/Documents/Claude/Projects/VALCYRA Interiors/fusion_scripts/drawset.py`
(2 097 lines, not a git repository; backups live in a session scratchpad).

| fact | where |
|---|---|
| Pipeline: load → extract → frame → group → dimension list (data) → views → draw → verify → PDF + `.sources.json`; the spec carries only what STEP cannot | drawset.py:1-6 |
| Spec vocabulary is small and closed: `datums {x, y, inside_face, y_from_top_within}`, `edge_names`, `edge_band`, `tolerances` by kind (general, outline, hole_position, hole_depth, edge_bore_depth, pocket_depth, groove_width, groove_depth, counterbore_depth), `features[]` hole-class rows by `D`/`axis`/`only_at` with `name`/`dia_tol`/`depth_tol`, `pairs[]`, `ctq[]`, `views[]` of five kinds (edge, section, groove_section, detail, cup_section), `sheets[]` of five kinds | drawset.py:139-176, 535-549, 1310-1320, 1815-1826; specs/side_panel_left.yaml, specs/flat_panel.yaml |
| `features[].only_at: [[x,y]]` (±0.01 mm) is the only per-position override today; `tol_for(spec, kind)` is per kind; hole-position tolerance is read **once per face sheet** and printed in shared rows and stacks | drawset.py:539-549, 941, 949-996 |
| `Dims.add(sheet, feature, kind, value, text, tol, view)` registers every printed number; `Dims.json()` (sorted keys) is hashed into `dimension_list_sha256`. No paper coordinates, no artist handle | drawset.py:518-532, 1832-1836 |
| Feature ids `H%d`/`G%d`/`P%d` are TopExp enumeration indices: stable for one STEP sha, not across CAD revisions | drawset.py:297, 374, 422 |
| Placement is computed inline per sheet method (closures `X()`, `Y()`, `Xp()`, `M()` in paper mm, A3, origin bottom-left) and drawn by `door_dwg.dimh/dimv/leader`, which return nothing; ~40 call sites | drawset.py:130-137, 800-818, 935-983; door_dwg.py:51-71 |
| Template mode: `derive_template()` **overwrites** `spec['datums']` x/y/inside_face (line 673), `spec['views']` (705) and `spec['sheets']` (719); merges `edge_names` under user values (679); `setdefault`s `y_from_top_within` (674) | drawset.py:662-722, 731-739 |
| Verification: round trip recomputes every printed number from `part.f` + `spec['datums']` and ignores tol/text/view; completeness needs a kind set per feature; regression builds twice and compares `Dims.json()`; `main()` exits 0 even on FAIL | drawset.py:1937-1993, 2078-2093 |
| CLI `drawset.py <spec.yaml> [--out DIR] [--png DIR]`; `--png` writes 110 dpi PNGs and `<set_name>_dimensions.json`; loads the spec from a file path only | drawset.py:726-752, 1799-1838 |

**Worker** — `tools/drawing-worker/worker.py`, stdlib only, shells to the venv.

| fact | where |
|---|---|
| Resolves `specs/<name>.yaml` by the job's spec **name**; `build_temp_spec()` overlays `parts[0].step`, title, drawing_number, issue, date, set_name, change; never touches datums/tolerances/features/views/sheets | worker.py:284-321, 440-487 |
| `step_verify` greps stdout for `=== VERIFICATION ===`, any `FAIL`, `5 regression … OK`, `=== PASS ===`; reads `.sources.json` | worker.py:489-515 |
| `result` = `{ pages, dimension_list_sha256, spec_sha256 (of the YAML file), drawset_version, verify_ok }` | worker.py:555-564 |
| Catalogue registration every 5 min: name, title, parts, part_numbers; `template: bool` is dropped by `normaliseSpec` | worker.py:235-256; _shared/render-job-core.mjs:158-171 |

**Portal.**

| fact | where |
|---|---|
| `drawing_render_jobs.spec` TEXT (name), `issue` reserved at request, `result` jsonb; partial unique index: one open job per drawing | migrations/0062:49-50, 85-86 |
| `drawing_render_specs` is a catalogue (name, title, parts, part_numbers); `registerDrawingSpecs` **deletes** rows the Mac no longer lists | 0062:91-106; portal-api/index.ts:7619-7643 |
| `requestDrawingRender` always reserves the **next** letter; `insertDrawingRevision` (index.ts:1271) is the single rule for a new issue, called from `addDrawingRevision` (6213) and `finishDrawingRender` (7597); refuses a duplicate letter | index.ts:7395-7397, 1271-1320 |
| A draft's file may be replaced only for CAD today: STATUS_MODEL §5.2 bullet 4 and §5.3 bullet 2; no counterpart for `drawing_revisions` | docs/STATUS_MODEL.md:118-128 |
| Release: draft → released by hand, only the current revision, refused without a file; released → superseded automatic | STATUS_MODEL §5.1 |
| The PDF viewer is a plain `<iframe src=blobUrl>`; pdf.js 3.11.174 is lazy-loaded from CDN for text extraction only | assets/viewer.js:86-98; assets/app.js:137-163 |
| Drawing surface: `.drawing-surface` grid `minmax(0,1fr) 300px`; rail has status chip, Made from, Issues, `fromCadSlot`, `jobSlot` | app.js:14835-15073; styles.css:836-847 |
| portal-ai: every call uses `output_config.format = { type: "json_schema" }`, `SCAN_MODEL = claude-opus-4-8`, `META_MODEL = claude-haiku-4-5-20251001`, `meterAi` → `ai_usage_events`; suppliers denied; new actions go into `HEAVY_ROUTES` | portal-ai/index.ts:198-234, 1285-1334; _shared/env.ts:13-18; assets/api.js:38-56 |
| TENANT_TABLES already lists drawings, drawing_revisions, drawing_dimensions, drawing_render_jobs, drawing_render_specs; next migration is 0067 | _shared/tenant.ts:47-69; migrations/0066_uploads_identity.sql |
| Suppliers see released, `is_supplier_visible` issues only (`supplierHome`, `supplierFileUrl`); drafts never | docs/SUPPLIER_PORTAL.md §2-3; index.ts:6026-6049 |
| `drawing_dimensions` (0032) exists, empty, shaped for AI extraction | 0032:104-118; DECISIONS.md:906-912 |
| Only Side Panel Left has a drawing: Issue B released 2026-11-26, 233 dims, fingerprint a38c2186; 47 parts have none | ROADMAP.md:12, the drawing register |

## 3 The model

### 3.1 A drawing is a function of three inputs

```
PDF, dimension list  =  drawset( STEP sha,  template@version,  patch@seq )
```

The portal already records the first term. This design records the other two
and pins all three on the issue. Everything the user asked for is an edit to
the third term followed by a re-render; nothing else changes.

Why not edit the YAML through the chat: the YAML is on one laptop, not in
git, and `registerDrawingSpecs` deletes catalogue rows the Mac stops
offering. A controlled document needs an owner with history; the portal
already has tenancy, audit and the issue the spec belongs to. Why not move
drawset into the portal: OCP cannot run in an edge function
(DRAWING_RENDER §1). So: **the portal owns the patch and a copy of every
template body it has seen; the Mac owns the function.**

### 3.2 Template versions

When the worker registers its catalogue it now sends each YAML's parsed body.
The portal keeps every distinct body as an immutable row of
`drawing_spec_versions` (name, version, body jsonb, body_sha256). The
catalogue row (`drawing_render_specs`) gains `current_version_id` — what the
Mac offers **now**; the versions are the history. Deleting a catalogue row
can therefore never orphan a drawing: a render job is handed the body from
`drawing_spec_versions`, not a name.

A new template version never moves a drawing by itself. The rail shows
"flat_panel v3 available (pinned v2)" and **Rebase** is an explicit act per
drawing (a `carry` patch row on the new base, re-rendered, diffed). A
template edit is a potential mass change across 51 drawings; it must be a
visible decision, not a side effect of restarting the worker.

Legacy per-part specs (`side_panel_left`, `_right`, `_shared`) register as
versions with `kind = part_spec` and keep working untouched; a patch over them
is allowed but the template is preferred for every new drawing (§9).

### 3.3 The per-drawing patch

An overlay, never a full spec, stored as a snapshot per step in
`drawing_spec_patches` and pointed at by `drawings.spec_patch_id` (the
accepted one). Schema 1:

```json
{ "v": 1,
  "base": { "name": "flat_panel", "version": 2 },
  "tolerances": { "hole_depth": "+0.3 -0", "general": "ISO 2768-f" },
  "datums":     { "inside_face": "max", "y_from_top_within": 60 },
  "edge_names": { "y_max": "Top", "x_min": "Front" },
  "edge_band":  { "y_max": "2 mm ABS" },
  "features":   [ { "D": 8, "axis": "z", "name": "dowel", "dia_tol": "+0.1 -0", "depth_tol": "+0.5 -0", "only_at": [[37, 58.5]] } ],
  "pairs":      [ { "D": 5, "cc": 32 } ],
  "ctq":        [ { "a": { "D": 5, "column": "rearmost" }, "b": { "D": 5, "column": "frontmost" }, "within": 0.3, "label": "hinge line" } ],
  "overrides":  [ { "at": { "type": "hole", "axis": "z", "D": 5, "pos": [37, 58.5] }, "kind": "depth", "tol": "+0.5 -0" },
                  { "at": { "type": "hole", "axis": "z", "D": 5, "pos": [37, 58.5] }, "kind": "dia",   "name": "hinge cup" },
                  { "at": { "type": "groove", "axis": "x", "offset": 12 },           "kind": "groove_width", "tol": "±0.1" } ],
  "views":  { "set": { "A": { "scale": 5 } }, "add": [ { "kind": "section", "through": { "D": 8, "axis": "y", "open_at": "min" }, "normal": "x", "scale": 2 } ], "remove": [] },
  "sheets": { "set": { "2": { "scale": 2, "y_range": [0, 600] } }, "add": [], "remove": [] } }
```

Rules, enforced by one pure validator (`validateOps` / `applySpecOps` in
`supabase/functions/_shared/drawing-spec-core.mjs`, shared by portal-api,
portal-ai and the tests):

- **No field can hold a printed value.** Tolerance fields are strings matching
  the house grammar `±n`, `+n -n`, `+n -0`, `0 -n` (and `ISO 2768-[fmcv]` for
  `general`); a bare number in a tolerance or name field is refused. The only
  numbers the patch may carry are selectors and thresholds drawset already
  owns — `D`, `pos`, `only_at`, `cc`, `within`, `y_from_top_within`, `offset`,
  `scale`, `y_range`, `y_max_shown`/`y_min_shown`, `x_shown`, `box` — none of
  which is printed as a dimension; drawset prints what it measures in the
  STEP.
- Scales are validated against the house set (1, 2, 5, 10, 20 and 2:1, 5:1).
- Unknown keys are refused with the key named. `title`, `drawing_number`,
  `issue`, `date`, `set_name` are portal facts (`build_temp_spec` writes
  them) and are refused in a patch.
- The patch is **composed in the portal and merged in drawset**. The portal
  never materialises an "effective spec": `views`/`sheets` can only be applied
  after `derive_template` has run, and `features[].only_at` precedence lives
  in `feature_rule` — re-implementing either in JavaScript would be a second
  copy that drifts. The worker receives the base body and the patch as two
  keys; drawset does the merge (§5.4).

Ops in, snapshot out. An op (`set_tolerance`, `override_dimension`, …, §4.4)
carries intent and a reason and is what the dialogue, the audit and the diff
speak; the snapshot is what the worker needs and what an issue cites by sha.
Both are stored on the patch row: `operations` (the ops that made this seq
from seq−1) and `patch` (the result). Ops are never replayed.

### 3.4 How an issue points at its inputs

| where | what is pinned |
|---|---|
| `drawing_revisions` | `source_cad_file_id`, `source_sha256` (today) + `spec_version_id`, `spec_patch_id`, `render_job_id`, `dimension_list_sha256`, `geometry_sha256` (new) |
| `drawing_render_jobs` | `spec` (name, for display) + `spec_version_id`, `spec_patch_id`, `mode`, `replaces_revision_id`; `result` carries both hashes, `patch_sha256`, `spec_body_sha256`, artefact paths |
| `drawing_spec_patches` | the snapshot, its sha, the ops, origin, prompt/selection/proposal, status, `job_id` |
| `drawings` | `render_spec` (today) + `spec_patch_id` = the accepted patch |

A released issue is immutable with its pins: editing the drawing's patch later
creates new rows and never touches the released row. The next letter after a
release starts from the accepted patch (the pointer moves, nothing is
copied) and lists unmatched overrides first (§6).

### 3.5 Per-dimension addressing

"Change the tolerance on one certain measurement" needs an address for one
dimension. `H12` is not one: it is a TopExp enumeration index that renumbers
when the CAD changes (drawset.py:297). The address is geometric, the
convention `features[].only_at` already uses:

| feature | `at` |
|---|---|
| hole | `{ type: "hole", axis, D, pos: [p0, p1] }` — matched ±0.01 mm, same as `feature_rule` |
| groove | `{ type: "groove", axis, offset }` — drawset's own quantities (`groove_offset`, drawset.py:1455); grooves have no "centre" |
| pocket | `{ type: "pocket", at: [x, y] }` — floor centre |

plus a `kind` (dia, depth, pos_x, groove_width, …). drawset emits `at` on every
dimension-list row and every entity in the sidecar, so the browser resolves a
clicked row or box to an address without ever showing `H12`, and a patch
survives a CAD revision as long as the feature is still where it was. When it
is not, the override is **reported as unmatched and the render still
succeeds** (§5.4): after a CAD change the first render must produce a new
dimension list so the engineer has something to re-target against. The same
report covers an override that matches a feature but has no number to act on
(2026-11-26): a depth row that reads `through` or `into the Ø2` is a relation
to another feature, so drawset marks the row `relation: true` in the sidecar,
the rail opens no form on it, and a depth override aimed at it is listed with
the unmatched ones with its reason, never applied silently.

### 3.6 Two fingerprints

`dimension_list_sha256` = sha256 of `Dims.json()` over the seven existing
fields, **unchanged**: Issue B's a38c2186 stays reproducible and remains the
regression oracle for every drawset change. `at` and paper boxes travel in the
sidecars, not in the hashed fields. Because tol and text are hashed, this
fingerprint changes on a tolerance-only edit, so it stops meaning "same
drawing".

`geometry_sha256` = sha256 of sorted `[(feature, kind, value)]`, new, written
beside it in `.sources.json`. Equal geometry hashes under different dimension
hashes is the claim an iteration needs: *same geometry, different
annotation*. Both are shown; the diff strip says which moved.

### 3.7 The letter rule for an iterated draft

A letter is release-facing identity; a patch seq is editing history. An
iteration therefore **never mints a letter**. The rule, the drawing
counterpart of STATUS_MODEL §5.2 bullet 4 / §5.3 bullet 2 (a draft CAD
revision's file is replaced by the next send):

- A render in mode `iterate` targets the drawing's **current** issue, which
  must be `draft`. It renders a **candidate**; nothing on `drawing_revisions`
  changes until the engineer presses Keep.
- Keep calls `replaceDraftRevisionFile` (sibling of `insertDrawingRevision`,
  index.ts:1271), which re-checks `status = draft` and current, swaps
  `storage_path`, `file_name`, `source_cad_file_id`, `source_sha256` and the
  pins, and writes audit `drawing_draft_file_replaced`. The letter stays.
- The source facts move **with** the file. A draft rendered from CAD Rev B
  may be re-rendered from Rev C and keeps its letter; "Made from" then says
  Rev C. There is no rule that mints a new letter for a different CAD file,
  so no draft is ever left behind as a non-current orphan that §5.1 could
  never release.
- On a released or superseded issue the only action is **New issue from CAD**
  → next letter, as today, carrying the accepted patch.

Why candidate-then-Keep and not render-into-the-draft: the draft row is what
the release modal, the BOM history and "Made from" describe. A
verification-passing but wrong proposal must never be "the drawing", even for
the twenty seconds before the engineer looks. One extra click buys a row that
is never half-true, and a previous file that survives a wrong patch without a
20 s re-render.

## 4 The three layers

### 4.1 Layer 1 — click a dimension, change a property, no AI

The engineer picks a dimension (a row in the rail's Dimensions table, later a
box on the sheet) and changes **Tolerance** or **Name** in a one-row form.
The browser builds the op (`override_dimension` for one feature,
`set_tolerance` for a kind) and posts `applyDrawingSpecOps`. That is all
layer 1 is: a form writing one op through the same validator the dialogue
uses. Rows that cannot carry a per-feature override today (outline, pocket_*,
groove_* kinds other than width/depth, hole_position) offer the kind-level
tolerance instead, labelled so ("Tolerance for all pocket_depth").

### 4.2 Layer 2 — the dialogue: prose plus marked entities → operations

A prompt, the selected entities (full rows with `at`) and, when the engineer
dragged a rectangle, the region mapped to model coordinates on a face, go to
portal-ai `proposeDrawingSpecOps`. The answer is a **proposal**: operations
in words with a reason each, refusals naming where the change actually lives,
and questions when the ask is ambiguous. Nothing is applied until the
engineer accepts; accepted ops go through `applyDrawingSpecOps` exactly like a
form edit. The model never writes a patch, never sees a storage path, and
cannot widen the vocabulary: the op enum in its JSON schema and the
validator's op set are generated from one constant and a static test asserts
they are equal.

Refined 2026-11-27 in `docs/DRAWING_DIALOGUE.md` before Phase 5 is built: the
engineer chooses the **scope** of a turn (this callout · this drawing · the
template) on the prompt row, the vocabulary gains `set_sheet_plan` (face-sheet
order) and `override_dimension { from }` (a per-dimension datum on `pos_x` /
`pos_y`), and a template-scope Apply **promotes** a new immutable template
version proved on the asking drawing first.

### 4.3 Layer 3 — outside the vocabulary is code, and the chat says so

drawset's vocabulary is closed. The following are **not** spec operations and
are refused with the file and function named: a new dimension kind, a cone or
countersink callout, a slot class, a non-`x` section normal, a front/rear-edge
view, moving a text, the c/c–CTQ overprint on side panel sheet 3 (face_sheet
right y-stack column 0), a hole-position tolerance for a **single** hole
(`ptol` is per face sheet, drawset.py:941), suppressing one dimension (would
fail completeness when it is a feature's only home), a hole table, a NOTES
block, a non-standard scale, and any typed length. Refusals are recorded on
the turn with a category so recurring ones read out as the drawset backlog
(ROADMAP "Discovered While Building").

### 4.4 Operation schema

One constant `SPEC_VOCAB` in `drawing-spec-core.mjs` defines the ops; the AI
schema's enum and the validator are both generated from it.

| op | args | effect on the patch | notes |
|---|---|---|---|
| `set_tolerance` | `kind ∈ {general, outline, hole_position, hole_depth, edge_bore_depth, pocket_depth, groove_width, groove_depth, counterbore_depth}`, `tol` | `tolerances[kind] = tol` | `general` accepts `ISO 2768-[fmcv]` |
| `set_inside_face` | `side ∈ {min, max}` | `datums.inside_face` | applied **inside** `derive_template` for template renders (§5.4) |
| `set_datum` | `axis ∈ {x, y}`, `side` | `datums.x` / `datums.y` | same |
| `set_from_top_rule` | `within` (mm) | `datums.y_from_top_within` | a rule threshold, not a printed value |
| `name_edge` | `edge ∈ {x_min, x_max, y_min, y_max, z_min, z_max}`, `name` | `edge_names[edge]` | |
| `set_edge_band` | `edge`, `text \| null` | `edge_band[edge]` | overview sheet only |
| `set_hole_rule` | `D`, `axis`, `name?`, `dia_tol?`, `depth_tol?`, `only_at?` | upsert `features[]` row keyed `(D, axis, only_at)` | drawset's existing class rule |
| `remove_hole_rule` | `D`, `axis`, `only_at?` | remove that row | |
| `override_dimension` | `at`, `kind ∈ {dia, depth, groove_width, groove_depth, pocket_depth}`, `tol?`, `name?` | upsert `overrides[]` row keyed `(at, kind)` | `name` only with `kind = dia`; **no** `pos_*` kinds in v1 (§4.3) |
| `remove_override` | `at`, `kind` | remove | |
| `add_pair` / `remove_pair` | `D`, `cc`, `about?` | `pairs[]` | `cc` selects; the printed c/c is measured |
| `add_ctq` / `remove_ctq` | `a {D, column}`, `b {D, column}`, `within`, `label` / `label` | `ctq[]` | |
| `set_view` | `id`, `scale?`, `caption?`, `y_max_shown?`, `y_min_shown?`, `x_shown?`, `labels?` | `views.set[id]` | merged after derivation |
| `add_view` | `kind ∈ {edge, section, groove_section, detail, cup_section}` + that kind's knobs | `views.add[]` | id assigned by drawset (next letter) |
| `remove_view` | `id` | `views.remove[]` | completeness may fail → job fails, draft untouched |
| `set_sheet` | `sheet`, `scale?`, `orient?`, `y_range?`, `views?` | `sheets.set[sheet]` | after derivation |
| `add_sheet` / `remove_sheet` | `kind` + knobs / `sheet` | `sheets.add[]` / `remove[]` | |

Every op carries `reason` (≤160 chars). `applySpecOps(patch, ops)` returns
`{ patch, rejected: [{ op, reason }] }`; a rejected op is shown as a refusal
with `lives_in = portal`.

## 5 Contracts

### 5.1 portal-api — all Rushroom only; none added to `SUPPLIER_ACTIONS`

| action | body | returns / rule |
|---|---|---|
| `registerDrawingSpecs` (changed) | `{ agent, specs: [{ name, title, parts, part_numbers, template, body, body_sha256 }] }` | For each spec: if `(name, body_sha256)` is new, insert `drawing_spec_versions` with `version = max + 1`; set `drawing_render_specs.current_version_id`. Catalogue delete rule unchanged; versions are never deleted. `normaliseSpec` keeps `template` |
| `listDrawingSpecs` (changed) | `{}` | adds `version`, `body_sha256` per spec |
| `getDrawingSpec` (new) | `{ drawing_id }` | `{ template: { name, version, body_sha256, current_version, drift: bool }, patch: { seq, patch, patch_sha256, status, origin }, history: [{ seq, origin, status, operations, created_by, created_at, job_id }], artifacts: { dimensions_url, entities_url, png_urls[] } }` for the current issue's render job |
| `applyDrawingSpecOps` (new) | `{ drawing_id, ops[], parent_seq, origin ∈ {click, dialogue, carry, hand}, turn_id? }` | `validateOps` → `applySpecOps` → new `drawing_spec_patches` row `status = proposed`, `seq = parent_seq + 1`. **409** when `parent_seq` is not the latest (two engineers on one draft). Returns `{ patch_id, seq, patch, rejected[], touched: [{ feature, kind, at, sheet }] }` — `touched` is the join of the ops' `(at, kind)` against the current dimensions.json, so the blast radius shows before the 20 s job |
| `requestDrawingRender` (changed) | `{ component_id, cad_model_revision_id, spec, drawing_id?, title?, mode ∈ {issue, iterate}, spec_patch_id? }` | `issue` (default): as today, plus `spec_version_id` = the spec's current version and, when the drawing has an accepted patch, a new `carry` row copied onto this base. `iterate`: requires the drawing's current issue to be `draft`; `job.issue` = that letter (column stays NOT NULL), `replaces_revision_id` = that revision, `spec_patch_id` = the given row (must be `proposed`), row → `status = rendering`. Partial unique index still gives one open job per drawing |
| `pollDrawingRenderJob` (changed) | `{ agent }` | adds `mode`, `spec_body` (from `drawing_spec_versions`, canonical JSON), `spec_body_sha256`, `spec_patch` (object or null), `patch_sha256`, `png: true` |
| `reportDrawingRenderStep` | unchanged | |
| `finishDrawingRender` (changed) | `{ job_id, storage_path, file_name, sha256, source_sha256, result }` | **Guard**: when the job carried a patch and `result.patch_sha256` is missing or differs → job failed "worker predates spec patches; restart it" (an old worker renders the unpatched template as a silent no-op). `mode = issue`: `insertDrawingRevision` as today, then pins on the revision. `mode = iterate`: no revision change; artefacts and hashes on `result`; patch row → `candidate`; a verify failure → `failed` and the draft keeps its file and pins |
| `acceptDrawingIteration` (new) | `{ job_id }` | `replaceDraftRevisionFile(tdb, session, revision, { storage_path, file_name, source_cad_file_id, source_sha256, pins })` — refused unless the revision is `draft` **and** current (re-checked here, not at request); refused if a later patch row was accepted since. Sets `drawings.spec_patch_id`, patch row → `accepted`, audit `drawing_draft_file_replaced`, one `bom_component_history` line, **no** revision bump |
| `discardDrawingIteration` (new) | `{ job_id }` | patch row → `discarded`; candidate files removed from storage; the row stays as history |
| `getDrawingRenderArtifacts` (new) | `{ job_id }` | signed URLs (1 h) for `pdf`, `pngs[]`, `dimensions`, `entities` |
| `previewRelease` (changed) | as today | adds facts: `spec` (template name@version, patch seq, op count), `dimensions_vs_superseded` (`diffDimensionLists` counts), `geometry_same`, `unmatched_overrides`, warning `spec_not_recorded` for legacy name-only renders (never a block), warning `iteration_open` when a proposed/candidate row exists |

`insertDrawingRevision` and `replaceDraftRevisionFile` are the two and only
writers of a `drawing_revisions` row's file; `tests/drawing-render.test.mjs`
asserts it statically, as it does today for the single insert helper.

### 5.2 portal-ai — `proposeDrawingSpecOps`

Handler `supabase/functions/portal-ai/handlers/drawing-spec.ts` with the
`{ role, tdb, apiKey, model, meterAi }` pattern; dispatched in portal-ai
`index.ts` beside `extractDrawingMeta`; name added to
`HEAVY_ROUTES["portal-ai"]` in `assets/api.js`. Rushroom only.

| item | value |
|---|---|
| model | `SCAN_MODEL` (claude-opus-4-8). Reasoning over a closed grammar against a dimension list and free-text intent is not metadata; a plausible wrong tolerance is the failure PROP-039 warns about. No haiku step: there is nothing to classify before the one call |
| request | `thinking: { type: "adaptive" }`, `output_config: { effort: "medium", format: { type: "json_schema", schema } }`, `max_tokens: 4000`; system block marked for prompt caching (identical across turns) |
| body in | `{ drawing_id, prompt (≤2000), selection: { sheet?, entities: [{ feature, at, kind, value, text, tol, view }], region_model?: { face, x: [a,b], y: [a,b] } }, parent_seq }` |
| loaded by portal-ai | the current patch, template body (name, version, `derived` from the last render), the dimension list (all rows of the marked sheet and of marked features; the whole list only when nothing is marked; rows beyond 400 summarised per (kind, D)), a part summary (size, hole classes with count and depth, grooves, pockets), the last five accepted turns' (prompt, ops) |
| system prompt | `DRAWING_SPEC_PROMPT_V1`: the `SPEC_VOCAB` card rendered from the constant; the house rules from the instruction document that bind the spec (no value in the spec, tolerances on the dimension, no hole table, no NOTES, filled arrows, standard scales, one callout per hole); the known-code list of §4.3; three worked examples (override, kind tolerance, refusal); "if the request is not expressible as a listed operation, refuse with the category; never invent an operation" |
| output | the schema below; first text block `JSON.parse`d, fields coerced with `String()` and allow-lists as the other handlers do; `stop_reason = refusal` → 502 |
| side effects | one `drawing_spec_turns` row (prompt, selection, proposal, model, tokens, `accepted = null`); `meterAi` → `ai_usage_events` under `proposeDrawingSpecOps`. No patch is written |
| returns | `{ turn_id, proposal }` |

Output schema (strict, `additionalProperties: false` throughout):

```json
{ "summary": "string",
  "operations": [ { "op": "<enum from SPEC_VOCAB>", "args": { "...per-op properties..." },
                    "reason": "string", "targets": [ "feature ids from the dimension list" ] } ],
  "refusals":   [ { "request": "string",
                    "category": "needs_code | house_style | value_in_spec | not_in_step | ambiguous",
                    "lives_in": "drawset.py | step2d.py | door_dwg.py | STEP | house_rule | portal",
                    "detail": "string" } ],
  "questions":  [ "string" ] }
```

Acceptance is a portal-api call (`applyDrawingSpecOps` with `turn_id`), which
re-validates every op and drops failures with their reason echoed to the
card; `discardDrawingSpecTurn { turn_id }` sets `accepted = false`. No cost
figures are claimed here; the `ai_usage_events` row is the fact.

### 5.3 Worker — job payload and result

Poll → worker (added to today's `step_url`, `step_file_name`, `cad_sha256`,
`title_block`, `spec`):

| field | meaning |
|---|---|
| `mode` | `issue` \| `iterate` |
| `spec_body` | the template or spec body as JSON (from `drawing_spec_versions`); the worker dumps it to YAML with the existing `dump_yaml` and no longer opens `specs/<name>.yaml` |
| `spec_body_sha256` | sha of the canonical JSON; the worker hashes the JSON **it received**, before dumping, and echoes it |
| `spec_patch` | the patch snapshot or `null`; written under `patch:` in the temp YAML after `build_temp_spec`'s overlay |
| `patch_sha256` | sha of the canonical patch JSON; echoed the same way |
| `png` | always true: run drawset with `--png` so sheet PNGs exist |

Worker → `finishDrawingRender.result`:

| field | meaning |
|---|---|
| `pages`, `drawset_version`, `verify_ok` | as today |
| `dimension_list_sha256`, `geometry_sha256` | from `.sources.json` |
| `spec_body_sha256`, `patch_sha256` | echoed from the poll |
| `verify` | `{ round_trip: { n, mismatches }, completeness_missing: [], wall_flags: [], regression: "OK" }` from `DRAWSET_SUMMARY` |
| `unmatched_overrides` | `[ { at, kind, reason } ]` from `DRAWSET_SUMMARY` — no such feature in the STEP, or a relation row (`through`, `into the Ø…`) with no number to tolerance |
| `artifacts` | `{ pdf, pngs: [], dimensions, entities }` — storage paths under `drawings/<drawing_id>/renders/<job_id>/` in `DOC_BUCKET` |

`step_verify` parses the `DRAWSET_SUMMARY` line when present and falls back to
today's grep for one release; exit code 3 fails the step. `step_upload`
uploads PDF, PNGs and the two JSON sidecars. The worker stays stdlib-only and
interprets nothing in the patch.

### 5.4 drawset — patch, overrides, sidecars, summary, flags

All in `fusion_scripts/drawset.py` (first step: `git init` there and commit
the baseline; the Issue B fingerprint a38c2186 is the oracle).

| change | where | detail |
|---|---|---|
| `patch:` key honoured | `Set.__init__` 726-752 | `apply_patch(spec, patch)` after `derive_template`: `tolerances`, `edge_names`, `edge_band` merged (patch wins); `features`/`pairs`/`ctq` appended (`only_at` rows still win in `feature_rule`); `overrides` set; `views.set/add/remove` by id and `sheets.set/add/remove` by number applied to the lists derivation just wrote. For a non-template spec the same function runs after load |
| datums in a template render | `derive_template` 662-722 | Line 673 overwrites `datums` x/y/inside_face unconditionally, so pre-seeding is lost. `derive_template` gains one argument: `patch.get('datums')`. It computes `inside` from the blind-hole majority, then applies the patch's `inside_face`/`x`/`y`/`y_from_top_within` **before** deriving edge names, views and sheets, so a changed inside face re-derives everything that depends on it. No re-run, no stale derived lists |
| `override_for(spec, h, kind)` | beside `feature_rule` 535-549 | match `overrides[]` by `at` (hole: axis, D ±0.01, pos ±0.01; groove: axis, offset ±0.01; pocket: centre ±0.01) and `kind`. Consulted first in `hole_callout` (551-603: `dia_tol`, `depth_tol`, `name`) and at the groove/pocket tolerance sites. Unmatched rows are collected, **reported, and do not fail the build** |
| `at` on every Dims row | `Dims.add`/`add_pos` 518-532 | the item gets `at` built from the hole dict (`add_pos`) or passed explicitly at groove/pocket sites. `Dims.json()` **excludes** `at` and `box`: the seven hashed fields are untouched |
| entities sidecar | wrappers `dimh_`, `dimv_`, `leader_`, `text_` beside `dimv_fit` 201-207 | each takes the Dims item(s) just registered **explicitly** (never a text match — texts repeat on one sheet) plus the current sheet, calls door_dwg, and appends `{ feature, at, kind, text, box_mm: [x0,y0,x1,y1], anchor_mm }` (text extent from `len(text)` × font em, padded 2 mm). ~40 call sites change mechanically; face_sheet callout `items` (938-942) already hold qx/yy/txt. Each sheet also records `views: [{ id, kind, face?, bbox_mm, transform: { ox, oy, s, sx, p0, ya } }]` so a marquee maps back to model coordinates |
| sidecars always | `build()` 1829-1836 | `<set_name>_dimensions.json` (rows with `at`) and `<set_name>_entities.json` written beside the PDF whether or not `--png` is given; `--png` keeps writing sheet PNGs at 110 dpi |
| `geometry_sha256` | `build()` sources dict | sha256 of sorted `[(feature, kind, value)]`, beside `dimension_list_sha256` |
| machine summary + exit code | `main()` 2078-2093 | one stdout line `DRAWSET_SUMMARY {json}` with pass, round_trip, completeness_missing, wall_flags, regression, both hashes, unmatched_overrides, sheets, artifact paths; `sys.exit(3)` on verification or regression FAIL (2 stays part errors, 1 exceptions). Prose lines stay; no new line contains the word FAIL except the verdicts |
| `--patch FILE` | argparse | merge a JSON patch for hand tests: `drawset.py specs/flat_panel.yaml --patch p.json --out tmp --png tmp` must give the same `Dims.json()` as the worker path |

How verification keeps holding: tolerance, name, edge-name, view and sheet
edits are invisible to `expected()` (it reads neither tol nor text
formatting); datum edits change expected values and text together and must
still match STEP; a removed view that was a feature's only home fails
completeness and the job, before any file moves; regression (two builds) is
untouched because the patch is deterministic data.

### 5.5 Tables — migration `0067_drawing_spec_governance.sql`

New tables carry `organization_id UUID NOT NULL REFERENCES organizations`,
RLS enabled deny-all, and are added to `TENANT_TABLES` after
`"drawing_render_specs"` (`tests/tenant-tables.test.mjs` guards it).

**`drawing_spec_versions`** — immutable; no UPDATE path in code.

| column | type | meaning |
|---|---|---|
| id | uuid pk | |
| organization_id | uuid NOT NULL FK | |
| name | text NOT NULL | YAML stem |
| version | integer NOT NULL | 1, 2, … per name |
| kind | text CHECK (template \| part_spec) | |
| body | jsonb NOT NULL | parsed YAML, canonical |
| body_sha256 | char(64) NOT NULL | |
| registered_by | text | worker agent |
| created_at | timestamptz | |
| UNIQUE (organization_id, name, body_sha256); UNIQUE (organization_id, name, version) | | |

**`drawing_spec_patches`** — append-only, linear per drawing.

| column | type | meaning |
|---|---|---|
| id, organization_id | | |
| drawing_id | uuid NOT NULL FK drawings ON DELETE CASCADE | |
| seq | integer NOT NULL | 1, 2, … per drawing; UNIQUE (org, drawing_id, seq) |
| parent_id | uuid FK self | |
| spec_version_id | uuid NOT NULL FK drawing_spec_versions | the base |
| patch | jsonb NOT NULL | the snapshot (§3.3) |
| patch_sha256 | char(64) NOT NULL | canonical JSON |
| operations | jsonb NOT NULL | the ops that made this seq |
| origin | text CHECK (click \| dialogue \| carry \| hand) | |
| prompt, selection, proposal | text, jsonb, jsonb | provenance when origin = dialogue |
| turn_id | uuid FK drawing_spec_turns | |
| status | text CHECK (proposed \| candidate \| accepted \| discarded \| failed) | `rendering` is derivable from the job |
| job_id | uuid FK drawing_render_jobs ON DELETE SET NULL | |
| created_by, created_at | | |

**`drawing_spec_turns`** — every dialogue turn, including ones that produced
nothing.

| column | type |
|---|---|
| id, organization_id, drawing_id FK, drawing_revision_id FK | |
| prompt text, selection jsonb, proposal jsonb | |
| refusal_categories text[] | for the backlog query |
| model text, input_tokens int, output_tokens int | |
| accepted boolean NULL | NULL undecided, false discarded |
| created_by, created_at | |

**Columns added.**

| table | columns |
|---|---|
| `drawing_render_specs` | `current_version_id uuid FK drawing_spec_versions`, `template boolean` |
| `drawing_render_jobs` | `mode text NOT NULL DEFAULT 'issue' CHECK (issue \| iterate)`, `spec_version_id uuid FK`, `spec_patch_id uuid FK ON DELETE SET NULL`, `replaces_revision_id uuid FK drawing_revisions ON DELETE SET NULL` |
| `drawing_revisions` | `spec_version_id uuid FK`, `spec_patch_id uuid FK`, `render_job_id uuid FK drawing_render_jobs ON DELETE SET NULL`, `dimension_list_sha256 char(64)`, `geometry_sha256 char(64)` |
| `drawings` | `spec_patch_id uuid FK drawing_spec_patches ON DELETE SET NULL` |

`drawing_dimensions` is **not** written in v1 (§9).

## 6 Interaction

Everything lives on the drawing surface (`openDrawingSurface`, app.js ~14835),
Rushroom role only. DRAWINGS_TAB_UX rules hold: labels outside boxes, one-row
forms, no explanatory sentences, amber for warnings only, no input whose
value is shown nowhere.

**Who sees what.** A supplier sees released, supplier-visible issues through
`supplierHome` / `supplierFileUrl` and nothing else; candidates, patches,
turns and the dialogue are not in `SUPPLIER_ACTIONS`, portal-ai denies
suppliers by default, and artefacts under `renders/<job_id>/` are never
handed out by `supplierFileUrl`. A draft, iterated or not, does not exist for
a supplier.

**Entry.** When the current issue is `draft` and has `render_job_id`, the
rail's "New issue from CAD" button reads **Re-render Issue C (draft)**; on a
released issue it reads **New issue D from CAD**. The letter is decided by
the status, stated before the click, never chosen by the user.

**The Dimensions table (layer 1, first to ship).** Under Issues, a section
"Dimensions (233)" from the render's dimensions.json: Sheet · Feature · Kind ·
Value · Tol · View, with a filter box. Clicking a row opens one row under it:
Tolerance [ ] · Name [ ] · Apply · Cancel. Value is read-only, its label is
"from STEP" — the one place the no-values rule is visible. Apply posts
`applyDrawingSpecOps`; the rail shows **Patch (3)** — one line per op in words
("depth tol +0.5 −0 on Ø5 at (37, 58.5)") with × — and the sheet-side rows the
ops touch turn amber. **Render** starts the iterate job; the existing
`drawingRenderJobPanel` shows claim · download · render · verify · upload ·
register, the last reading "Candidate ready".

**Compare, Keep, Discard.** On done the file pane splits: current PDF left,
candidate right (same sheet, same zoom); under it a strip "233 → 233 · 2
tolerances changed · 0 values changed · geometry same as Issue B" (computed
by `diffDimensionLists` on `(at|feature, kind)`), the verification lines
verbatim, and unmatched overrides if any (amber). A changed value or a
different `geometry_sha256` is amber: datums or the STEP moved. **Keep** calls
`acceptDrawingIteration`: the PDF reloads, "Made from" and the pins update,
the letter is unchanged, the history list gains "#4 · click · 2 tolerances ·
14:32". **Discard** leaves the attempt in history and removes the candidate
files. A failed verification offers only Discard and Edit.

**The sheet (layer 1, second way in).** The file pane shows the render's
sheet PNGs with tabs 1 · 2 · 3 and an SVG overlay in sheet mm from
entities.json (linear mm→px from the PNG size; no pdf.js, no CDN; the PDF
stays the artefact of record and the iframe stays for issues without a
sidecar). Hover outlines an entity and shows its text; click opens the same
one-row form; shift-click adds; drag draws a marquee that selects every box
it touches **and keeps the rectangle** mapped through the sheet's view
transform to model coordinates ("inside face, x 40–120, y 300–380") — half
the useful asks are about what is not there yet.

**The dialogue (layer 2).** Chips for the selection, one prompt row, Send.
The reply is a card with three lists: *Operations* (one sentence each, with
reason, a checkbox per line), *Stays code* (amber: "Move the c/c text clear
of the CTQ value — drawset.py face_sheet, right y-stack column 0") and
*Questions* ("Two Ø5 classes in the marquee, depth 10 and 13 — both?").
**Apply** posts the checked ops through `applyDrawingSpecOps` with `turn_id`;
touched rows turn amber; Render as above. Discarding the card sets
`accepted = false` on the turn. The dialogue has no memory beyond what is on
screen; the patch rows and turns are the memory.

**Spec section of the rail.** "Template flat_panel v2 · Patch #4 · 6 ops".
Patch opens the history (seq, origin, status, ops, author; revert = a new seq
with the chosen seq's patch, never a delete). Template shows the body
read-only and, when `drift` is true, "v3 available · Rebase" (a `carry` row on
the new base, rendered as a candidate, diffed like any other).

**New issue from a released drawing.** Carries the accepted patch (origin
`carry`) onto the new draft; unmatched overrides after a CAD change are
listed first on the surface with one-click Drop (an op, audited). The
engineer's annotation decisions are product knowledge; a CAD revision must
neither throw them away nor pretend they still apply when a hole moved.

**Release gate.** The one release modal (previewRelease / releaseCheck,
DECISIONS 2026-11-25) gains facts, not blocks: "Spec flat_panel v2 + patch
#4", "vs Issue B: 2 tolerances changed · geometry same", "Unmatched overrides
0", amber "template changed since this patch" when `drift`, amber "iteration
open" when a proposed or candidate row exists, amber "spec not recorded" for
legacy name-only renders. Release stays by hand, only the current revision,
refused without a file; a released issue is immutable with its pins.

## 7 Implementation phases

In dependency order. Days are one engineer; the first user-visible value lands
at the end of Phase 3.

### Phase 0 — drawset under version control; the CLI stops speaking prose (1 day) — BUILT 2026-11-26

Goal: a reversible drawset and a machine-readable gate before anything grows.

Steps: `git init` in fusion_scripts, commit drawset.py, step2d.py,
door_dwg.py, specs/, the instruction doc · `DRAWSET_SUMMARY` line + exit 3 in
`main()` · `geometry_sha256` in `.sources.json` · worker `step_verify` parses
the summary, keeps the grep fallback, fails on exit 3.

Files: fusion_scripts/drawset.py · tools/drawing-worker/worker.py.

Verify: render Side Panel Left Rev B through today's modal: job done,
`result.geometry_sha256` present, `dimension_list_sha256` = a38c2186,
regression OK. A forced completeness failure exits 3 and the job fails on the
`verify` step with the missing list.

### Phase 1 — drawset learns patch, overrides and the sidecars (4 days) — BUILT 2026-11-26, all six proofs hold (ROADMAP)

Goal: everything the portal will ever ask drawset to do exists and is proved
on the Mac, with no portal change.

Steps: `apply_patch` after `derive_template`; `derive_template(spec, part,
patch_datums)` applies patch datums before deriving · `override_for` wired
into `hole_callout` and the groove/pocket tolerance sites; unmatched
collected and reported · `at` on every Dims row, excluded from `Dims.json()` ·
`dimh_`/`dimv_`/`leader_`/`text_` recorders taking the item explicitly; ~40
call sites; per-sheet `views[]` transforms · sidecars always written ·
`--patch FILE` · proof case: write `specs/side_panel_left.patch.json` by hand
(edge names, bands, features, pairs, ctq, views.add, sheets.set) and render
`flat_panel` + patch against Issue B's STEP.

Files: drawset.py · door_dwg.py · specs/flat_panel.yaml · the instruction doc
(patch and overrides vocabulary).

Verify: (a) `side_panel_left.yaml` with no patch still gives a38c2186 and
regression OK, and `Dims.json()` is byte-identical to Phase 0 (PDF bytes are
**not** compared — PdfPages embeds a creation date; PNGs and Dims.json are).
(b) One override `+0.5 -0` on a Ø5 depth: `dimension_list_sha256` changes,
`geometry_sha256` does not, round trip 0 mismatches. (c) An override at a
wrong position: PASS, `unmatched_overrides` has one entry, exit 0. (d) A patch
removing a section view: completeness lists the missing kinds, exit 3.
(e) Proof case: `geometry_sha256` of flat_panel + patch equals Issue B's and
`diffDimensionLists` by `(at, kind)` shows **0 value changes**; differences in
`view`/`sheet` strings and derived view ids are listed and read, not required
to be empty (§11, challenge 9). (f) entities.json has one box per Dims row
that prints text; overlaid on the PNGs the boxes sit on their numbers on
every sheet.

### Phase 2 — the spec becomes a governed document; a patch travels (4 days)

Goal: template bodies and patches are stored, versioned and pinned; a patch
reaches drawset through the worker and a candidate comes back; exercised by
tests and curl, no UI.

Steps: migration 0067 (§5.5), TENANT_TABLES · `_shared/drawing-spec-core.mjs`
(`SPEC_VOCAB`, `validateOps`, `applySpecOps`, `canonicalSha`,
`parseTolerance`, `diffDimensionLists`, `touchedEntities`) with
`tests/drawing-spec-core.test.mjs` · `registerDrawingSpecs` with bodies and
versions; worker sends parsed YAML · `requestDrawingRender` modes;
`pollDrawingRenderJob` body + patch; `finishDrawingRender` branches and the
stale-worker guard; `replaceDraftRevisionFile`; `acceptDrawingIteration`,
`discardDrawingIteration`, `getDrawingSpec`, `applyDrawingSpecOps` (409 on
stale parent), `getDrawingRenderArtifacts` · worker: use `spec_body`, write
`patch:`, `--png`, upload four artefact kinds, echo hashes · tests:
drawing-render.test.mjs (iterate never inserts a letter; two file writers
only; guard), tenant-tables, routing-static · docs: DRAWING_RENDER §3-5
tables, STATUS_MODEL §5.2 new bullet for `drawing_revisions`, DECISIONS
(letter rule for iterated drafts; spec truth in the portal; template + patch;
geometric addressing; AI proposes, validator admits).

Files: supabase/migrations/0067_drawing_spec_governance.sql ·
_shared/tenant.ts · _shared/drawing-spec-core.mjs ·
_shared/render-job-core.mjs · portal-api/index.ts · tools/drawing-worker/
worker.py · tests/drawing-spec-core.test.mjs · tests/drawing-render.test.mjs
· docs/DRAWING_RENDER.md · docs/STATUS_MODEL.md · docs/DECISIONS.md.

Verify: Side Panel Left: render a new draft Issue C with flat_panel (mode
issue; version and empty patch pinned). `applyDrawingSpecOps` with one
`override_dimension` → `requestDrawingRender iterate` → job done, artefacts
under `renders/<job_id>/`, patch row `candidate`, revision C unchanged.
`acceptDrawingIteration` → C's `storage_path`, `source_*`, pins and
`drawings.spec_patch_id` move; C still draft and current; audit row written.
A second `applyDrawingSpecOps` with a stale `parent_seq` → 409. A finish
without `patch_sha256` on a patched job → failed with the restart message.
`node --test tests/` green.

### Phase 3 — layer 1 in the rail: Dimensions table, form, compare, Keep (3 days)

Goal: the user's literal ask, end to end, without AI and without touching
the viewer: pick a row, set `+0.5 -0`, render, compare, keep.

Steps: `getDrawingSpec` + artefacts on surface open · Dimensions table with
filter; one-row form; Patch list with ×; touched rows amber · button text by
status · Render → `drawingRenderJobPanel` (reused; `_drSurfaceJobs`
continuity) · split compare + diff strip + verification lines + unmatched
list · Keep / Discard · Spec section (template, patch, history, revert) ·
styles.css rows and strip · `index.html` ?v= bump on app.js.

Files: assets/app.js · assets/styles.css · index.html.

Verify: on draft C click the Ø5 depth row, set `+0.5 -0`, Apply → "Patch (1)",
Render → ~25 s → strip reads "233 → 233 · 1 tolerance changed · geometry same
as Issue B", Keep → PDF shows the new tolerance, issue still C, still draft;
history shows #1 · click. Clicking a row on released Issue B opens nothing.

### Phase 4 — the sheet: PNG sheets, overlay, marquee (3 days) — BUILT and proven live 2026-11-26 (v469; DRAWINGS_TAB_UX §13.8; ROADMAP)

Goal: the sheet becomes the second way to reach the same control, and a
region can be marked for the dialogue.

Steps: `viewer.js` `renderSheets(target, { pngs, entities, onSelect })` —
PNG per sheet, SVG overlay in mm, hover, click, shift-click, marquee with
region→model via view transforms; iframe path untouched for files without a
sidecar · app.js: entity click → scroll table + open form; marquee → chips
"4 selected · Ø5 depth ×2, pos_x ×2" filtering the table · "Plain PDF"
toggle · `index.html` bumps on viewer.js and app.js · DRAWINGS_TAB_UX section.

Files: assets/viewer.js · assets/app.js · assets/styles.css · index.html ·
docs/DRAWINGS_TAB_UX.md.

Verify: on every sheet of draft C the overlay boxes sit on their numbers at
two zoom levels (title-block rectangle at frame origin (20,10) is the
calibration check); clicking the Ø5 depth callout opens the same form as the
row; a marquee over the right y-stack selects exactly those pos_y rows and
reports a model rectangle on the inside face; a hand-uploaded issue still
shows the iframe.

### Phase 5 — the dialogue and the refusal path (5 days, was 3) — design refined 2026-11-27, see `docs/DRAWING_DIALOGUE.md` (scope control, `set_sheet_plan`, `override_dimension { from }`, Promote, worker mirror; its §8 replaces the five proofs below; its §9 decided as recommended the same day)

Goal: prose plus marked entities become a reviewed proposal; anything outside
the vocabulary is named as code.

Steps: `portal-ai/handlers/drawing-spec.ts` (`DRAWING_SPEC_PROMPT_V1`,
loaders, SCAN_MODEL, adaptive thinking, json_schema, coercion, turn row,
meterAi) · dispatch; `HEAVY_ROUTES` · `applyDrawingSpecOps` with `turn_id`;
`discardDrawingSpecTurn` · app.js prompt row, proposal card, Apply/Discard,
turn history · tests: schema op-enum = `SPEC_VOCAB` op set; routing test that
`proposeDrawingSpecOps` is in HEAVY_ROUTES and absent from portal-api; golden
file of recorded model outputs through the validator · DECISIONS (AI proposes
over a closed grammar, never writes the spec); ROADMAP Discovered While
Building gets the refusal categories as the drawset feed.

Files: portal-ai/handlers/drawing-spec.ts · portal-ai/index.ts ·
_shared/drawing-spec-core.mjs · portal-api/index.ts · assets/api.js ·
assets/app.js · tests/routing-static.test.mjs ·
tests/drawing-spec-core.test.mjs · docs/DECISIONS.md · docs/ROADMAP.md.

Verify, five scripted prompts on draft C: (1) two Ø8 depth entities marked,
"tighten depth on these to +0.3/-0" → two `override_dimension` ops, Apply,
Render, strip shows 2 tolerance changes; (2) "general tolerance ISO 2768-f" →
`set_tolerance general`; (3) "move the c/c text clear of the CTQ" → refusal
`needs_code`, lives_in drawset.py face_sheet; (4) "change the 37 to 38" →
refusal `not_in_step`; (5) marquee over two Ø5 classes, "tighten these" → a
question, no ops. Each turn has an `ai_usage_events` row.

### Phase 6 — carry-forward, rebase, release facts, docs, first real issues (2 days)

Goal: the model survives a CAD revision and a template edit, the release
modal states what an issue was made from, and the 47 parts start entering
governed from their first letter.

Steps: `requestDrawingRender issue` carries the accepted patch (origin
`carry`), unmatched overrides first on the new draft with Drop · Rebase on
drift · `previewRelease` facts (§5.1) · `drawingRenderModal` unchanged but
every first issue pins version + empty patch · docs: SYSTEM_OVERVIEW.html
drawings section, ROADMAP Built (awaiting deploy), CLAUDE.md table count (32)
and cache version · render three of the 47 parts (one with grooves, one with
edge bores) through flat_panel; record refusals as drawset backlog.

Files: portal-api/index.ts · _shared/status-core.mjs · assets/app.js ·
docs/SYSTEM_OVERVIEW.html · docs/ROADMAP.md · CLAUDE.md.

Verify: re-stamp Side Panel Left as Rev C with one moved hole, New issue from
CAD → draft D carries the patch and shows exactly one unmatched override;
release D: the modal lists "flat_panel v1 + patch #5 · vs Issue B: 2 changed ·
geometry changed" and refuses nothing it did not refuse before; afterwards
`applyDrawingSpecOps` on D is refused ("Issue D is released; render the next
letter"). Registering an edited flat_panel.yaml creates v2; D stays pinned to
v1 and the rail offers Rebase.

Total: 22 days (20 until 2026-11-27; Phase 5 re-estimated at 5 in DRAWING_DIALOGUE). Deploy order per phase as always: `supabase db push` →
`supabase functions deploy portal-ai --no-verify-jwt` (Phase 5) →
`supabase functions deploy portal-api --no-verify-jwt` → `git push origin
main`; the worker must be restarted after Phase 2.

## 8 Risks and how each is held

| risk | held by |
|---|---|
| fusion_scripts is not in git; a bad drawset edit has no undo | Phase 0 step 1 is `git init` + baseline commit; a38c2186 and byte-identical `Dims.json()` are the oracle for every later commit |
| Geometric address breaks when a hole genuinely moves (> 0.01 mm) or changes class | unmatched overrides are a reported result, the render succeeds, the new draft lists them first with Drop; never a silent drop, never a failed first render after a CAD change |
| `dimension_list_sha256` now changes on tolerance-only edits and stops meaning "same drawing" | the seven hashed fields are untouched (oracle intact); `geometry_sha256` carries "same geometry"; both are shown and the strip says which moved; DECISIONS records the meaning |
| An AI proposal passes the schema yet breaks completeness (removes a view that is a feature's only home) | drawset is the gate: the job fails, the draft keeps its file and pins, the failed patch row stays visible; `touchedEntities` pre-warns when the removed kind is the only one for that feature |
| An AI op is schema-valid but geometrically wrong (right D, wrong axis) | the vocabulary gate cannot judge intent; the amber touched rows before render and the diff after are the defence, and Keep is the engineer's |
| Old worker during deploy renders the unpatched template as a silent no-op | `finishDrawingRender` refuses a result without a matching `patch_sha256` when the job carried a patch: "worker predates spec patches; restart it" |
| Keep races a release | `replaceDraftRevisionFile` re-checks `draft` and current inside the accept call and refuses otherwise, mirroring today's letter check in `finishDrawingRender` |
| Two engineers on one draft | `applyDrawingSpecOps` takes `parent_seq` and answers 409 on a stale parent; the partial unique index serialises renders |
| Text boxes in the sidecar are estimates (font em × length), off by a millimetre on dense stacks | boxes are hit targets, not truth; 2 mm padding; hover shows the resolved text before any op; the table row is always the other way in |
| Derived view ids (A, B-B) shift when a hole class appears or vanishes, so `set_view {id}` may land elsewhere | `getDrawingSpec` returns `derived` from the last render and `applyDrawingSpecOps` validates ids against it; a mismatch is reported like an unmatched override (§9 asks whether to address views by class) |
| Spec body as JSON must round-trip to YAML faithfully (null vs missing, `+0.3 -0` as a string) | canonical JSON both sides; `dump_yaml` via the venv's pyyaml; `spec_body_sha256` hashed over the JSON received, never the YAML written |
| Storage growth: PDF + PNGs + two JSON per iteration | Discard deletes candidate files; accepted iterations keep theirs (they are history); failed jobs keep only the summary; review after 100 iterations |
| Every turn is a Mac render (~25 s + poll), one per drawing, worker must be up | the job panel and the existing "No drawing worker" state are honest about it; layer-1 ops can be batched into one seq before Render (§9) |
| Scope creep: refusals become ad-hoc vocabulary | refusals are recorded with a category and go to ROADMAP as drawset items; the vocabulary changes only by a drawset change plus a `SPEC_VOCAB` change plus the static test |
| The 47 parts still have no drawing | the first-issue path is unchanged except for pins; rendering real issues is not blocked by any phase after 2 |

## 9 Open decisions for the user — all eleven decided as recommended, 2026-11-26 (DECISIONS.md)

1. **Batch layer-1 edits before rendering?** Apply-renders-immediately costs
   one ~25 s job per click; staging ops into one seq with "3 pending changes ·
   Render" is several clicks per sheet. *Recommendation:* stage, with the
   count visible and the pending seq shown honestly as `proposed`.
2. **Address views and sheets by derived id or by class?** Id is what the
   engineer reads on paper; class (`{D, depth, edge}`) survives a CAD change.
   *Recommendation:* store both, match by class, show id; v1 stores id and
   validates against `derived`.
3. **Per-hole position tolerance.** Out of the vocabulary in v1 (`ptol` per
   face sheet). Is it wanted enough to change the x-row/y-stack grouping in
   `face_sheet`, or is the kind-level tolerance the house rule anyway?
   *Recommendation:* kind-level is the house rule; revisit only if the
   refusal recurs.
4. **`drawing_dimensions`.** Load each render's list there (SQL diffs across
   issues, the tolerance-chain row type it was built for) or keep the sidecar
   (proposed)? *Recommendation:* sidecar until a consumer exists — the
   ROADMAP lesson on rows accepted and displayed nowhere.
5. **Legacy per-part specs.** Migrate side_panel_left/right/shared into
   flat_panel + patch (the proof case does Left) or keep them as `part_spec`
   versions? *Recommendation:* migrate when each gets its next issue, not as
   a batch.
6. **Template governance.** Do template versions need their own Draft →
   Released states, or is "registered by the worker" enough for a two-person
   company? *Recommendation:* immutable versions only, until a second person
   edits flat_panel.yaml.
7. **Release while an iteration is open.** Warn (proposed) or block?
   *Recommendation:* warn; a candidate is not the file being released.
8. **Template drift at release.** Amber fact (proposed) or block?
   *Recommendation:* fact — the issue was verified against the template that
   rendered it.
9. **PNG resolution.** 110 dpi is 0.23 mm/px on A3; the dense right y-stack
   is hard to hit. *Recommendation:* add `--png-dpi` and use 150 for the
   portal if Phase 4 shows misses.
10. **Who may accept.** Any Rushroom user (as release today) or the designer
    only? *Recommendation:* any Rushroom user until roles exist.
11. **Model pin.** CLAUDE.md pins claude-opus-4-8 for every call; this design
    follows it and makes no pricing claim. Changing the pin is a repo-wide
    decision, not a drawing-engine one.

## 10 Out of scope

Multi-part drawing sets (one STEP per `parts[]` label; DRAWING_RENDER §6).
~~Editing the house template itself from the portal (promote a patch into
flat_panel.yaml): a file on the Mac; the recurring-refusals list is the
backlog mechanism.~~ Brought into scope 2026-11-27 as **Promote**
(`docs/DRAWING_DIALOGUE.md` §5): a template-scope turn writes a new immutable
version and the Mac file becomes a mirror. Direct JSON editing of the patch as an escape hatch.
Sending PNG crops to the model (vision): the sidecar is complete and
reproducible. Suppressing a single dimension. New drawset feature classes
(cones, countersinks, slots), non-`x` sections, front/rear-edge views, the
c/c–CTQ overprint: drawset.py work, fed by the refusal categories. Running
the worker as a service; rendering on a server. GD&T.

## 11 Challenges from review, resolved

1. *`derive_template` overwrites datums x/y/inside_face (drawset.py:673), so a
   pre-seeded or post-applied datum op is lost or leaves derived lists
   stale.* Confirmed on the source. Resolved: `derive_template` takes the
   patch's datums and applies them **inside**, before deriving edge names,
   views and sheets (§5.4). Neither pre-seeding nor post-apply is used.
2. *Putting `key`/`at` in `Dims.json()` breaks a38c2186.* Resolved: the
   seven hashed fields are untouched; `at` and boxes live in the sidecars
   (§3.6).
3. *Per-hole `pos_*` overrides are a layout change, not a lookup
   (drawset.py:941).* Agreed; `pos_*` kinds are excluded from
   `override_dimension` and named as code (§4.3, §9.3).
4. *A JS-materialised "effective spec" contradicts post-derivation
   views/sheets and duplicates `feature_rule`.* Resolved: the portal never
   materialises; base body and patch travel separately and drawset merges
   (§3.3, §5.3).
5. *Unsourced pricing and model-id claims.* None are made; the
   `ai_usage_events` row is the only cost fact (§5.2).
6. *3.5 days for a phase that spans two repos, a migration, six actions and a
   UI.* Re-estimated: 20 days over seven phases (§7), with the drawset share
   alone at 5.
7. *A new letter for a draft rendered from another CAD file leaves a
   non-current orphan draft.* Resolved: an iteration never mints a letter;
   the source facts move with the file (§3.7).
8. *Linking entity boxes to Dims items by text match mis-links repeated
   texts.* Resolved: the recorders take the item explicitly (§5.4).
9. *The proof case (template + patch reproduces Issue B) requires the patch
   grammar to express the legacy spec's hand-written views and sheets, and
   derived ids/scales will differ.* Resolved: the proof is **geometry
   equality and zero value changes**, not an empty dimension-list diff;
   `views.add`/`sheets.set` are in Phase 1 so the legacy sheet plan can be
   expressed, and derived-id differences are listed and read (§7 Phase 1 e).
10. *Byte-identical PDFs before and after are not achievable.* Agreed;
    `Dims.json()` and PNGs are compared (§7 Phase 1 a).
11. *`drawing_render_jobs.spec` is NOT NULL and `issue` is reserved at
    request; an iterate job must carry both.* It does: `spec` = the base
    name, `issue` = the current draft's letter (§5.1).
12. *Worker `spec_sha256` is the YAML file's sha; a portal JSON sha compares
    nothing.* Resolved: the worker hashes the JSON it received and echoes
    `spec_body_sha256` / `patch_sha256`; the old `spec_sha256` is dropped
    from `result` (§5.3).
13. *A "Shown" checkbox needs completeness knowledge the browser lacks.*
    Removed: no suppress in v1 (§4.3, §10).
14. *Grooves have no "centre".* Addressed by `{ axis, offset }` (§3.5).
15. *Verify-7 failing the job on an unmatched override leaves no dimension
    list to re-target against after a CAD change.* Resolved: unmatched
    overrides are a reported result; only completeness and regression fail
    the job (§3.5, §5.4).
16. *Template body pinned by sha only, with the body on an un-versioned
    laptop.* Resolved: `drawing_spec_versions` stores every body the worker
    registers; the job is handed the body, not the name (§3.2).
17. *Storage layout and cleanup unstated.* Stated: `DOC_BUCKET`,
    `drawings/<drawing_id>/renders/<job_id>/`, Discard deletes candidates,
    accepted kept (§5.3, §8).
18. *`drawing_dimensions` repurposed before a consumer exists.* Not written
    in v1 (§5.5, §9.4).
19. *STATUS_MODEL section numbers.* The CAD replace rule is in §5.2 bullet 4
    and restated in §5.3 bullet 2; the drawing counterpart goes into §5.2 as
    a new bullet and the DECISIONS entry cites both (§3.7).
20. *110 dpi PNGs are coarse on the dense y-stack; five more uploads per
    iteration.* Uploads are counted in Phase 2's worker step; dpi is open
    decision 9 with a `--png-dpi` flag as the remedy.
