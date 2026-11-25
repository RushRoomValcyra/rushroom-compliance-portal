# Drawing from CAD — render jobs

Status: DESIGN + CONTRACT, 2026-11-25. Decided by ziirvass: option 2 of the
three in the CAD & Drawings discussion ("generate from CAD in the portal,
rendered by a worker on the engineer's Mac").

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

## 3 Tables (migration 0062; the STATUS_MODEL drop moves to 0063)

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
| issue | varchar(10) NOT NULL | the letter reserved at request: `nextRevisionLetter` of the drawing's issues |
| status | text NOT NULL | `requested` · `running` · `done` · `failed` · `timed_out` · `cancelled` |
| requested_by / requested_at | | |
| claimed_at / claimed_by | | worker identity |
| finished_at | | |
| steps | jsonb NOT NULL default '[]' | `[{ key, label, status, detail, at, data }]` as cad_test_runs |
| result | jsonb | `{ drawing_revision_id, file_name, sha256, pages, dimension_list_sha256, spec_sha256, drawset_version, verify_ok }` |
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
| PRIMARY KEY (organization_id, name) | |

**`drawings.render_spec`** text — the spec last used for this drawing;
preselected next time.

Timeouts, lazy as for test runs: `requested` > 120 s → `timed_out` ("no
drawing worker picked the job up"); `running` > 15 min since claimed →
`failed` ("worker stopped reporting").

## 4 API — all Rushroom only, in portal-api

| action | body | returns |
|---|---|---|
| `requestDrawingRender` | `{ component_id, cad_model_revision_id, spec, drawing_id? , title? }` | the job. Validates: the revision belongs to the part's CAD model and has a STEP file; the spec is registered; `drawing_id` depicts the part, or `title` given → a new drawing is created now (engineering, owner = the part, `render_spec` = spec, no issue yet) and `created_drawing = true`. 400 when that drawing already has a job requested/running. `issue` = next letter of the drawing (A for a new one). |
| `getDrawingRenderJob` | `{ job_id }` | the job with `drawing_number`, `part_number`, `component_name`, `cad_revision` attached |
| `listDrawingRenderJobs` | `{ limit?, drawing_id?, component_id? }` | newest first |
| `cancelDrawingRenderJob` | `{ job_id }` | `requested` → `cancelled`; a drawing the job created with no issue is deleted; else 409 |
| `pollDrawingRenderJob` | `{ agent }` | oldest `requested` claimed (one guarded UPDATE as for test runs) and returned with everything the worker needs: `step_url` (signed, 1 h), `step_file_name`, `cad_sha256`, `title_block: { drawing_number, issue, title, part_number, part_name, cad_revision, cad_sha8, date }`, `spec`; `{ job: null }` when idle. Idle cost: one indexed select |
| `reportDrawingRenderStep` | `{ job_id, key, status, detail?, data? }` | step update; 409 unless `running` |
| `finishDrawingRender` | `{ job_id, storage_path, file_name, sha256, source_sha256, result }` **or** `{ job_id, error }` | success: inserts the issue through the same code `addDrawingRevision` uses (letter = job.issue; refused if an issue was added meanwhile → job failed with that reason; `source_cad_file_id` = job.cad_file_id, `source_sha256` = the sha the worker rendered from (`source_sha256` in the body, the value the poll handed it and it verified; a resend from Fusion during the job replaces the file row's sha in place, so the row is not the truth), notes "Rendered from CAD Rev X by drawset"), sets `drawings.render_spec`, step `register` passed, status `done`, `result.drawing_revision_id`. Failure: status `failed`, the running step failed with the error, remaining skipped; a drawing this job created and that has no issue is deleted |
| `registerDrawingSpecs` | `{ agent, specs: [{ name, title, parts, part_numbers }] }` | upserts the catalogue; specs no longer in the list are deleted for this org |
| `listDrawingSpecs` | `{}` | `{ specs, last_seen }` — `last_seen` = newest `updated_at` |

The `addDrawingRevision` body is refactored into `insertDrawingRevision(tdb,
session, drawing, { revision?, storage_path, file_name, notes, source_cad_file_id,
source_sha256 })` so the action and `finishDrawingRender` share one rule (the
`releaseRevisionRow` pattern).

## 5 The worker — `tools/drawing-worker/`

Python 3.13, the `~/.venvs/valcyra-draw` venv (OCP, matplotlib, pyyaml,
numpy, pymupdf). Files:

- `worker.py` — `python worker.py` runs until stopped. Every 5 s:
  `pollDrawingRenderJob`; on a job, run it. On start and every 5 min (the
  portal calls a worker absent after 10):
  `registerDrawingSpecs` from `specs/*.yaml` in the drawset folder (name =
  file stem, title = `title`, parts = len(`parts`), part_numbers = the
  `RR-\d{6}-[A-Z0-9]{8}` found in each `parts[].step`).
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
   registry").
2. `render` — load `specs/<spec>.yaml`; refuse specs with more than one
   `parts` entry ("spec has N parts; a render job draws one part") — multi-part
   sets stay a by-hand job for now; write a temp spec with `parts[0].step` =
   the absolute STEP path, `drawing_number` = title_block.drawing_number,
   `issue` = title_block.issue, `date` = today, `set_name` =
   drawing_number, `change` = `["From CAD Rev X · <sha8>", "Rendered by
   drawset", "<date>"]`, `title` kept from the spec; run
   `<python> drawset.py <tempspec> --out <tmpout>` with the drawset dir as
   cwd, capture stdout/stderr; exit code ≠ 0 → failed with the last lines.
3. `verify` — drawset's own verification and regression lines in stdout
   (`=== VERIFICATION ===` … and `5 regression … OK`); any `FAIL` → failed
   with the line. The sidecar `<pdf>.sources.json` is read for
   `dimension_list_sha256` and the STEP sha (must equal `cad_sha256`).
4. `upload` — `docUploadUrl` with `file_name = "<drawing_number> Issue <L>.pdf"`,
   PUT the PDF.
5. `finishDrawingRender` with `sha256` of the PDF, `source_sha256` = the STEP
   sha it rendered from, and `result = { pages,
   dimension_list_sha256, spec_sha256 (of the original YAML), drawset_version
   (git short hash of the drawset folder when it is a repo, else the mtime
   of drawset.py), verify_ok: true }`.

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
