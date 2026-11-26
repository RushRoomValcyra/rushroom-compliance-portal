# Drawing from CAD — render jobs

Status: DESIGN + CONTRACT, 2026-11-25. Decided by ziirvass: option 2 of the
three in the CAD & Drawings discussion ("generate from CAD in the portal,
rendered by a worker on the engineer's Mac"). Spec governance added
2026-11-26 (DYNAMIC_DRAWINGS.md Phase 2, migration 0068): §3–§5 carry the
versioned template body, the per-drawing patch and the `iterate` mode.

## 1 Why

A drawing is a derived document: every number on it comes from a STEP file
of a named CAD revision. The portal already models that (an issue records
`source_cad_file_id` / `source_sha256`, STATUS_MODEL §5.4 warns when the
released drawing was not made from the released CAD), and the generator
already exists (`drawset.py` + a YAML spec per part family, the house drawing
standard in `VALCYRA_STEP_to_2D_Drawing_Instruction.md`). What is missing is
the seam: today an engineer runs drawset by hand, finds the PDF, uploads it
through the New drawing modal, and the "made from" fact is never recorded.
After this, the engineer presses **Drawing from Rev B** on the CAD register,
and the issue that appears is provably derived from Rev B, with its sha, its
spec and its dimension-list fingerprint written down.

The geometry kernel (OCP) cannot run in an edge function, so the render runs
on the Mac that has it, as a worker that polls the portal: the same pattern
the test agent proved on 2026-11-25 (`cad_test_runs`).

## 2 The flow

```
portal (app.js)              portal-api                     drawing worker (Mac)
requestDrawingRender ──────► job requested                  polls every 5 s
  (part, CAD rev, drawing      (+ a new drawing row when     ◄── pollDrawingRenderJob
   new|existing, spec)          asked: number assigned now)       claims; gets STEP url,
getDrawingRenderJob (2 s)                                         title-block facts
                              ◄──────────────────────────── reportDrawingRenderStep ×5
                              ◄──────────────────────────── finishDrawingRender
                              issue registered on the drawing      (pdf uploaded, sha, result)
                              (next letter, source_cad_file_id,
                               source_sha256), job done
```

Steps, fixed keys: `claim` · `download` · `render` · `verify` · `upload` ·
`register`. The worker reports 2–5; `claim` is set by the poll and `register`
by `finishDrawingRender`.

What the engineer sees: in the CAD Models register, the expanded revision
group of every revision with a STEP file has a **Drawing from Rev X** button.
It opens a one-row modal: **Drawing** [New drawing · each drawing that depicts
this part] · **Title** (only for a new drawing) · **Spec** [the specs the
worker has registered, preselected from the drawing's last spec or by part
number] · **Render**. The revision group then shows the job's steps live;
when it is done the group and the Drawings column show the new issue
(draft). The drawing surface has the same action as **New issue from CAD**
under "+ New issue", preset to the drawing and its part's released CAD
revision (else the current one).

The worker is started by hand in a terminal (`tools/drawing-worker`), like
the add-in is started in Fusion. While it runs, the modal's Spec list is
live; when no worker has reported for 10 minutes the modal says so instead
of listing specs.

## 3 Tables (migration 0062; the STATUS_MODEL drop moves to 0063; spec governance in 0068)

**`drawing_render_jobs`** — org-scoped, in TENANT_TABLES, RLS deny-all.

| column | type | meaning |
|---|---|---|
| id | uuid pk | |
| organization_id | uuid NOT NULL FK organizations | |
| component_id | uuid NOT NULL FK bom_components | the part |
| cad_model_revision_id | uuid NOT NULL FK cad_model_revisions | the revision drawn from |
| cad_file_id | uuid NOT NULL FK cad_model_files | its STEP file |
| drawing_id | uuid FK drawings ON DELETE SET NULL | target drawing (existing or created by this job). Nullable: a failed job whose created drawing was removed stays readable, so the panel can show why it failed. Always set while requested/running |
| created_drawing | boolean NOT NULL default false | the job created the drawing row; a failed job with no issue deletes it again |
| spec | text NOT NULL | drawset spec name (`side_panel_left`) |
| issue | varchar(10) NOT NULL | the letter reserved at request: `nextRevisionLetter` of the drawing's issues; for `mode = iterate` the current draft's letter (nothing is minted) |
| mode | text NOT NULL default 'issue' CHECK | `issue` · `iterate` (0068). `issue` registers a new letter at finish; `iterate` renders a candidate for the drawing's current draft issue and changes no revision row |
| spec_version_id | uuid FK drawing_spec_versions | the template/spec body handed to the worker (0068) — never a name |
| spec_patch_id | uuid FK drawing_spec_patches ON DELETE SET NULL | the patch row rendered (0068): `iterate` = the given `proposed` row; `issue` = the `carry` row copied onto this base when the drawing has an accepted patch, else null |
| replaces_revision_id | uuid FK drawing_revisions ON DELETE SET NULL | `iterate` only: the draft issue whose file an accepted candidate replaces (0068) |
| status | text NOT NULL | `requested` · `running` · `done` · `failed` · `timed_out` · `cancelled` |
| requested_by / requested_at | | |
| claimed_at / claimed_by | | worker identity |
| finished_at | | |
| steps | jsonb NOT NULL default '[]' | `[{ key, label, status, detail, at, data }]` as cad_test_runs |
| result | jsonb | `{ drawing_revision_id, file_name, sha256, pages, dimension_list_sha256, spec_sha256, drawset_version, verify_ok }` + since 0068 `geometry_sha256`, `spec_body_sha256`, `patch_sha256`, `verify: { round_trip: { n, mismatches }, completeness_missing: [], wall_flags: [], regression }`, `unmatched_overrides: [{ at, kind }]`, `artifacts: { pdf, pngs: [], dimensions, entities }` (storage paths) |
| error | text | |
| created_at | | |

Indexes: `(organization_id, status, requested_at)`; partial unique
`(organization_id, drawing_id) WHERE status IN ('requested','running')` —
one render per drawing at a time (two parts may render at once).

**`drawing_render_specs`** — the worker's catalogue, so the modal can offer
specs without the worker being asked.

| column | type |
|---|---|
| organization_id | uuid NOT NULL FK |
| name | text NOT NULL — the YAML file stem |
| title | text |
| parts | integer — how many `parts:` the spec has |
| part_numbers | jsonb — the RR numbers found in the spec's `parts[].step` file names |
| agent | text — who registered it |
| updated_at | timestamptz |
| current_version_id | uuid FK drawing_spec_versions — the body the Mac offers **now** (0068); the versions are the history |
| template | boolean NOT NULL default false — a template names no part (0068) |
| PRIMARY KEY (organization_id, name) | |

**`drawings.render_spec`** text — the spec last used for this drawing;
preselected next time. **`drawings.spec_patch_id`** uuid FK
drawing_spec_patches ON DELETE SET NULL (0068) — the accepted patch; the
next letter starts from it.

**`drawing_revisions`** — pins added in 0068, written by `finishDrawingRender`
(`mode = issue`) and moved by `acceptDrawingIteration`; a released issue keeps
them for good.

| column | type | meaning |
|---|---|---|
| spec_version_id | uuid FK drawing_spec_versions | the template body the issue was drawn with |
| spec_patch_id | uuid FK drawing_spec_patches | the patch snapshot (null for a legacy name-only render) |
| render_job_id | uuid FK drawing_render_jobs ON DELETE SET NULL | the job whose artefacts are the issue's dimension list and entities |
| dimension_list_sha256 | char(64) | sha256 of `Dims.json()` — tol and text included, so it moves on an annotation edit |
| geometry_sha256 | char(64) | sha256 of sorted `[(feature, kind, value)]` — same geometry, different annotation when only the other hash moves |

### 3.1 Spec governance — three tables (migration 0068)

All three: `organization_id uuid NOT NULL FK organizations`, RLS enabled, no
policies, in `TENANT_TABLES` right after `"drawing_render_specs"`
(`tests/tenant-tables.test.mjs`).

**`drawing_spec_versions`** — immutable; no UPDATE path in code. One row per
distinct body the worker has ever registered under a name.

| column | type | meaning |
|---|---|---|
| id | uuid pk | |
| organization_id | uuid NOT NULL FK | |
| name | text NOT NULL | YAML stem |
| version | integer NOT NULL | 1, 2, … per name; `max + 1` when `(name, body_sha256)` is new |
| kind | text CHECK (template · part_spec) | |
| body | jsonb NOT NULL | the parsed YAML |
| body_sha256 | char(64) NOT NULL | sha256 of the canonical JSON (`canonicalSha`) |
| registered_by | text | worker agent |
| created_at | timestamptz | |
| UNIQUE (organization_id, name, body_sha256); UNIQUE (organization_id, name, version) | | |

**`drawing_spec_patches`** — append-only, linear per drawing; a snapshot per
step, never a full spec (DYNAMIC_DRAWINGS §3.3).

| column | type | meaning |
|---|---|---|
| id, organization_id | | |
| drawing_id | uuid NOT NULL FK drawings ON DELETE CASCADE | |
| seq | integer NOT NULL | 1, 2, … per drawing; UNIQUE (organization_id, drawing_id, seq) |
| parent_id | uuid FK self | seq − 1 |
| spec_version_id | uuid NOT NULL FK drawing_spec_versions | the base |
| patch | jsonb NOT NULL | the snapshot (`v: 1`, `base`, `tolerances`, `datums`, `edge_names`, `edge_band`, `features`, `pairs`, `ctq`, `overrides`, `views`, `sheets`) |
| patch_sha256 | char(64) NOT NULL | canonical JSON |
| operations | jsonb NOT NULL | the ops that made this seq from seq − 1; never replayed |
| origin | text CHECK (click · dialogue · carry · hand) | |
| prompt, selection, proposal | text, jsonb, jsonb | provenance when origin = dialogue |
| turn_id | uuid FK drawing_spec_turns | |
| status | text CHECK (proposed · candidate · accepted · discarded · failed) | `rendering` is derivable from `job_id` |
| job_id | uuid FK drawing_render_jobs ON DELETE SET NULL | |
| created_by, created_at | | |

**`drawing_spec_turns`** — every dialogue turn, including ones that produced
nothing (portal-ai `proposeDrawingSpecOps`, Phase 5; the table ships now).

| column | type |
|---|---|
| id, organization_id, drawing_id FK drawings, drawing_revision_id FK drawing_revisions | |
| prompt text, selection jsonb, proposal jsonb | |
| refusal_categories text[] | for the drawset backlog query |
| model text, input_tokens int, output_tokens int | |
| accepted boolean NULL | NULL undecided · true applied · false discarded |
| created_by, created_at | |

**Storage.** Every artefact of a job lives in `DOC_BUCKET` under
`drawings/<drawing_id>/renders/<job_id>/<file>`: the PDF, the sheet PNGs,
`dimensions.json`, `entities.json`. The PDF of a `mode = issue` job is **also**
uploaded through `docUploadUrl` as before, and that path stays the revision's
`storage_path`. An accepted iteration's `storage_path` is the `renders/` PDF.

Timeouts, lazy as for test runs: `requested` > 120 s → `timed_out` ("no
drawing worker picked the job up"); `running` > 15 min since claimed →
`failed` ("worker stopped reporting").

## 4 API — all Rushroom only, in portal-api

None of these is in `SUPPLIER_ACTIONS`. Rows marked *0068* changed or arrived
with spec governance (DYNAMIC_DRAWINGS §5.1).

| action | body | returns |
|---|---|---|
| `requestDrawingRender` *(0068)* | `{ component_id, cad_model_revision_id, spec, drawing_id?, title?, mode ∈ {issue, iterate} = issue, spec_patch_id? }` | the job. Validates: the revision belongs to the part's CAD model and has a STEP file; the spec is registered and has a `current_version_id`; `drawing_id` depicts the part, or `title` given → a new drawing is created now (engineering, owner = the part, `render_spec` = spec, no issue yet) and `created_drawing = true`. 400 when that drawing already has a job requested/running (partial unique index: one open job per drawing). `issue`: `issue` = next letter of the drawing (A for a new one); `spec_version_id` = the spec's current version; when the drawing has an accepted patch, a new `carry` patch row is copied onto this base and becomes `spec_patch_id`. `iterate`: requires `drawing_id`, the drawing's current issue must be `draft`; `issue` = that letter, `replaces_revision_id` = that revision, `spec_patch_id` = the given row (must be `proposed`, this drawing); no letter is minted |
| `getDrawingRenderJob` | `{ job_id }` | the job with `drawing_number`, `part_number`, `component_name`, `cad_revision` attached |
| `listDrawingRenderJobs` | `{ limit?, drawing_id?, component_id? }` | newest first |
| `cancelDrawingRenderJob` | `{ job_id }` | `requested` → `cancelled`; a drawing the job created with no issue is deleted; else 409 |
| `pollDrawingRenderJob` *(0068)* | `{ agent }` | oldest `requested` claimed (one guarded UPDATE as for test runs) and returned with everything the worker needs: `step_url` (signed, 1 h), `step_file_name`, `cad_sha256`, `title_block: { drawing_number, issue, title, part_number, part_name, cad_revision, cad_sha8, date }`, `spec`, and since 0068 `mode`, `drawing_id`, `spec_body` (canonical JSON **string** of the body in `drawing_spec_versions`), `spec_body_sha256`, `spec_patch` (canonical JSON string or null), `patch_sha256` (or null), `png: true`; `{ job: null }` when idle. Idle cost: one indexed select |
| `reportDrawingRenderStep` | `{ job_id, key, status, detail?, data? }` | step update; 409 unless `running` |
| `drawingRenderUploadUrl` *(new, 0068)* | `{ job_id, file_name }` | `{ signedUrl, path }` for `drawings/<drawing_id>/renders/<job_id>/<file_name>` in `DOC_BUCKET`; the job must be claimed and not closed. The worker uses it for every artefact |
| `finishDrawingRender` *(0068)* | `{ job_id, storage_path, file_name, sha256, source_sha256, result }` **or** `{ job_id, error }` | **Guard first**: a job that carried a patch whose `result.patch_sha256` is missing or differs → job `failed` "worker predates spec patches; restart it" (an old worker renders the unpatched template as a silent no-op). `mode = issue`: inserts the issue through `insertDrawingRevision` (letter = job.issue; refused if an issue was added meanwhile → job failed with that reason; `source_cad_file_id` = job.cad_file_id, `source_sha256` = the sha the worker rendered from — the value the poll handed it and it verified; a resend from Fusion during the job replaces the file row's sha in place, so the row is not the truth; notes "Rendered from CAD Rev X by drawset"), then pins `spec_version_id`, `spec_patch_id`, `render_job_id`, `dimension_list_sha256`, `geometry_sha256` on the revision, sets `drawings.render_spec`, step `register` passed, status `done`, `result.drawing_revision_id`. `mode = iterate`: no revision row changes; artefacts and hashes stay on `result`; the patch row → `candidate`; a verify failure → patch row `failed`, the draft keeps its file and pins. Failure: status `failed`, the running step failed with the error, remaining skipped; a drawing this job created and that has no issue is deleted |
| `acceptDrawingIteration` *(new, 0068)* | `{ job_id }` | Keep. `replaceDraftRevisionFile(tdb, session, revision, { storage_path, file_name, source_cad_file_id, source_sha256, pins })` — refused unless the revision is `draft` **and** current (re-checked here, not at request); refused if a later patch row was accepted since. Swaps the file and its facts, sets `drawings.spec_patch_id`, patch row → `accepted`, audit `drawing_draft_file_replaced`, one `bom_component_history` line, **no** letter change (STATUS_MODEL §5.2) |
| `discardDrawingIteration` *(new, 0068)* | `{ job_id }` | patch row → `discarded`; the candidate's files under `renders/<job_id>/` removed; the row stays as history |
| `getDrawingSpec` *(new, 0068)* | `{ drawing_id }` | `{ template: { name, version, body_sha256, current_version, drift }, patch: { seq, patch, patch_sha256, status, origin }, history: [{ seq, origin, status, operations, created_by, created_at, job_id }], artifacts: { dimensions_url, entities_url, png_urls[] } }` for the current issue's render job; `drift` = the catalogue offers a newer version than the pinned one |
| `applyDrawingSpecOps` *(new, 0068)* | `{ drawing_id, ops[], parent_seq, origin ∈ {click, dialogue, carry, hand}, turn_id? }` | `validateOps` → `applySpecOps` (both in `_shared/drawing-spec-core.mjs`) → new `drawing_spec_patches` row `status = proposed`, `seq = parent_seq + 1`, `parent_id` = that row. **409** when `parent_seq` is not the latest (two engineers on one draft). Returns `{ patch_id, seq, patch, rejected: [{ op, reason }], touched: [{ feature, kind, at, sheet }] }` — `touched` is `touchedEntities(ops, dims)` against the current `dimensions.json`, so the blast radius shows before the 20 s job |
| `getDrawingRenderArtifacts` *(new, 0068)* | `{ job_id }` | signed URLs (1 h) for `pdf`, `pngs[]`, `dimensions`, `entities` |
| `registerDrawingSpecs` *(0068)* | `{ agent, specs: [{ name, title, parts, part_numbers, template, body, body_sha256 }] }` | upserts the catalogue; for each spec, if `(name, body_sha256)` is new, inserts `drawing_spec_versions` with `version = max + 1` and `kind` = template · part_spec; sets `current_version_id`. Specs no longer in the list are deleted from the catalogue for this org; **versions are never deleted**, so a job or an issue always finds its body |
| `listDrawingSpecs` *(0068)* | `{}` | `{ specs, last_seen }` — `last_seen` = newest `updated_at`; each spec adds `version`, `body_sha256`, `template` |

`previewRelease` gains the spec facts (template name@version, patch seq,
`diffDimensionLists` counts against the superseded issue, `geometry_same`,
`unmatched_overrides`, warnings `spec_not_recorded` and `iteration_open`) in
Phase 6, not here.

The `addDrawingRevision` body is refactored into `insertDrawingRevision(tdb,
session, drawing, { revision?, storage_path, file_name, notes, source_cad_file_id,
source_sha256 })` so the action and `finishDrawingRender` share one rule (the
`releaseRevisionRow` pattern). `insertDrawingRevision` and
`replaceDraftRevisionFile` are the two and only writers of a
`drawing_revisions` row's file; `tests/drawing-render.test.mjs` asserts it
statically.

Patch validation (`validateOps`, DYNAMIC_DRAWINGS §3.3): a tolerance must
match the house grammar `±n` · `+n -n` · `+n -0` · `0 -n` (`ISO 2768-[fmcv]`
only for `general`); a bare number in a tolerance or name field is refused;
unknown keys are refused naming the key; `title`, `drawing_number`, `issue`,
`date`, `set_name` are portal facts and refused; scales ∈ {1, 2, 5, 10, 20};
override kinds ∈ {dia, depth, groove_width, groove_depth, pocket_depth},
`name` only with `dia`; every op carries `reason` (≤160 chars, may be empty).
The portal never materialises an effective spec: base body and patch travel
as two keys and drawset merges them.

## 5 The worker — `tools/drawing-worker/`

Python 3.13, the `~/.venvs/valcyra-draw` venv (OCP, matplotlib, pyyaml,
numpy, pymupdf). Files:

- `worker.py` — `python worker.py` runs until stopped. Every 5 s:
  `pollDrawingRenderJob`; on a job, run it. On start and every 5 min (the
  portal calls a worker absent after 10):
  `registerDrawingSpecs` from `specs/*.yaml` in the drawset folder (name =
  file stem, title = `title`, parts = len(`parts`), part_numbers = the
  `RR-\d{6}-[A-Z0-9]{8}` found in each `parts[].step`, `template` = the
  file carries `template:` and no `parts`, `body` = the parsed YAML,
  `body_sha256` = sha256 of its canonical JSON — the portal keeps every
  distinct body as a version, §3.1).
- `config.json` (gitignored; `config.example.json` committed):
  `{ "portal_url", "token_file": "../../fusion-addin/RushroomPIM/config.json",
  "drawset_dir": "/Users/famqvick/Documents/Claude/Projects/VALCYRA Interiors/fusion_scripts",
  "python": "/Users/famqvick/.venvs/valcyra-draw/bin/python", "poll_seconds": 5 }`.
  The token is the add-in's portal session (same engineer, same Mac);
  `PORTAL_TOKEN` in the environment overrides it. No password is ever stored
  by the worker.
- `README.md` — how to start it, what it writes where.

One job, in order (each step reported before and after):

1. `download` — GET `step_url` to a temp dir as `<step_file_name>`; sha256
   must equal `cad_sha256`, else the step fails ("STEP sha differs from the
   registry"). A file registered before the portal recorded shas has
   `cad_sha256 = null`: the download's sha becomes the fact, the step says
   so, and `finishDrawingRender` writes it onto the file row.
2. `render` — since 0068 the body comes from the poll: sha256 the
   `spec_body` string **as received**, parse it, dump it to YAML with the
   existing `dump_yaml` (the worker no longer opens `specs/<spec>.yaml` for a
   job); refuse specs with more than one `parts` entry ("spec has N parts; a
   render job draws one part") — multi-part sets stay a by-hand job for now;
   `build_temp_spec` writes `parts[0].step` = the absolute STEP path,
   `drawing_number` = title_block.drawing_number, `issue` = title_block.issue,
   `date` = today, `set_name` = drawing_number, `change` = `["From CAD Rev X
   · <sha8>", "Rendered by drawset", "<date>"]`, `title` kept from the spec
   (a template takes the job's drawing title); when `spec_patch` is not null
   its sha is taken the same way and the parsed object is written under
   `patch:` in the temp YAML — the worker interprets nothing in it; run
   `<python> drawset.py <tempspec> --out <tmpout> --png <tmpout>` with the
   drawset dir as cwd, capture stdout/stderr; exit code ≠ 0 → failed with the
   last lines (3 = verification or regression FAIL, 2 = part error).
3. `verify` — the `DRAWSET_SUMMARY {json}` stdout line when present (pass,
   round_trip, completeness_missing, wall_flags, regression, both hashes,
   unmatched_overrides, artifact paths); an older drawset falls back to the
   prose lines (`=== VERIFICATION ===` … and `5 regression … OK`, any `FAIL`
   → failed with the line). `<pdf>.sources.json` is read for
   `dimension_list_sha256`, `geometry_sha256` and the STEP sha (must equal
   `cad_sha256`).
4. `upload` — `mode = issue`: `docUploadUrl` with `file_name =
   "<drawing_number> Issue <L>.pdf"`, PUT the PDF, as before. Every mode:
   `drawingRenderUploadUrl` for the PDF, each sheet PNG, `dimensions.json`
   and `entities.json` → `drawings/<drawing_id>/renders/<job_id>/`.
5. `finishDrawingRender` with `sha256` of the PDF, `source_sha256` = the STEP
   sha it rendered from, `storage_path` = the `docUploadUrl` path (`issue`)
   or the `renders/` PDF path (`iterate`), and `result` as below.

Worker → `finishDrawingRender.result`:

| field | meaning |
|---|---|
| `pages`, `drawset_version`, `verify_ok` | as before (`drawset_version` = git short hash of the drawset folder, else the mtime of drawset.py) |
| `spec_sha256` | of the YAML the worker dumped, kept for the legacy readers |
| `dimension_list_sha256`, `geometry_sha256` | from `.sources.json` |
| `spec_body_sha256`, `patch_sha256` | the worker's own sha256 of the two strings the poll handed it — it never computes a canonical form; a missing or different `patch_sha256` on a patched job is the stale-worker guard in §4 |
| `verify` | `{ round_trip: { n, mismatches }, completeness_missing: [], wall_flags: [], regression: "OK" }` from `DRAWSET_SUMMARY` |
| `unmatched_overrides` | `[{ at, kind }]` from `DRAWSET_SUMMARY`; reported, never a failure |
| `artifacts` | `{ pdf, pngs: [], dimensions, entities }` — the `renders/<job_id>/` storage paths |

Any exception → `finishDrawingRender { job_id, error }`. The worker never
raises out of its loop; it logs to `tools/drawing-worker/worker.log`
(gitignored). A 409 "not running" from a report aborts the job (the portal
closed it).

## 6 Out of scope now

Multi-part drawing sets (one PDF for Door M Left/Right and Middle): the job
model carries one part and one STEP. The spec catalogue already reports
`parts`, so the modal can hide or mark multi-part specs; a later version
carries one STEP per `parts[]` label. Running the worker as a service
(launchd) rather than in a terminal. Rendering on a server.

## 7 First render — 2026-11-25

Side Panel Left (RR-202609-G26N4P8A), CAD Rev A released, spec
`side_panel_left`, requested from the CAD register as a new drawing: claim
→ download (175 860 bytes, sha b49e58a6; the file had been registered before
shas were recorded, so the worker recorded it and the portal wrote it onto
the file row) → render (16.5 s, four A3 sheets) → verify (drawset PASS,
dimension list d8471e84…, the same fingerprint the hand-run set of 2026-11-25
produced from the same STEP) → upload (108 125 bytes) → register. Result:
RR-DWG-202611-SM5H6XGG Issue A, draft, `source_cad_file_id` set,
`source_sha256` b49e58a6, title block reads the portal's number, Issue A
and "From CAD Rev A · b49e58a6"; the drawing rail says "Made from: CAD Rev
A · b49e58a6". 20 s end to end. The first attempt had failed on exactly
that missing sha; the failure path removed the drawing it had created.
