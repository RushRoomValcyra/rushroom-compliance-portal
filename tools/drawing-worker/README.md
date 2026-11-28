# Drawing worker

Renders the portal's drawing jobs with `drawset.py` on the Mac that has the
geometry kernel. Contract: `docs/DRAWING_RENDER.md` §5.

## Start

```
cd tools/drawing-worker
cp config.example.json config.json        # once; edit paths if they differ
python3 worker.py
```

Stops with Ctrl-C: the job in hand finishes first; a second Ctrl-C aborts it
(the portal gets `finishDrawingRender { error: "worker stopped by hand" }`).

Needs: Fusion connected to the portal (the add-in's `config.json` holds the
session token; `PORTAL_TOKEN` in the environment overrides it), the drawset
folder with `drawset.py` and `specs/*.yaml`, and the `~/.venvs/valcyra-draw`
venv. Without a token the worker refuses to start. The loop itself runs on
the system `python3` with the standard library; the venv python is shelled
out to for drawset and, when `pyyaml` is not importable, for YAML.

## What it does

Every `poll_seconds`: `pollDrawingRenderJob`. On a job: `download` →
`render` → `verify` → `upload` → `finishDrawingRender`, each step reported
before and after. A job has a `mode`: `issue` (a new letter, as always),
`iterate` (a candidate for the current draft; nothing on the drawing changes
until the engineer presses Keep — `docs/DYNAMIC_DRAWINGS.md` §3.7) or
`sandbox` (a reference render, no drawing; below).

- `render` takes the spec body from the job (`spec_body`, the portal's copy
  of the template or spec as a JSON string, `docs/DYNAMIC_DRAWINGS.md` §3.2)
  and no longer opens `specs/<name>.yaml` — the file is read only for a
  portal that sends no body. `build_temp_spec` overlays the STEP path and
  the title-block facts as before; the job's `spec_patch` (a JSON string or
  null) is written under `patch:` in the temp YAML and merged by drawset
  after `derive_template`. drawset runs with `--png <tmp>/png` so sheet PNGs
  exist. The exact `spec_body` and `spec_patch` strings are sha256-hashed as
  received and echoed; the worker never canonicalises JSON and interprets
  nothing in the patch.
- `verify` reads drawset's `DRAWSET_SUMMARY` line (exit code 3 = rendered,
  verification failed, the summary names the first reason; `geometry_sha256`
  travels with `dimension_list_sha256`), records `summary.artifacts` (local
  pdf, pngs, `<set>_dimensions.json`, `<set>_entities.json`) and
  `unmatched_overrides`, and falls back to the prose block for a drawset
  without a summary. A patched job on a drawset that prints no summary fails
  here ("drawset predates spec patches") rather than rendering the unpatched
  template as a silent no-op.
- `upload`: mode `issue` uploads the PDF through `docUploadUrl` as today
  (that path stays the revision's `storage_path`) **and** uploads the PDF,
  every sheet PNG, `dimensions.json` and `entities.json` through
  `drawingRenderUploadUrl { job_id, file_name }` into
  `drawings/<drawing_id>/renders/<job_id>/`. Mode `iterate` does only the
  `renders/` uploads; the candidate PDF's `renders/` path is what
  `finishDrawingRender` receives as `storage_path`.
- `finishDrawingRender.result` carries `pages`, `drawset_version`,
  `verify_ok`, `dimension_list_sha256`, `geometry_sha256`,
  `spec_body_sha256`, `patch_sha256` (echoed), `verify { round_trip,
  completeness_missing, wall_flags, regression }`, `unmatched_overrides` and
  `artifacts { pdf, pngs[], dimensions, entities }` (storage paths).

On start and every 5 min: `registerDrawingSpecs` from `specs/*.yaml` (name =
file stem, title, number of parts, the RR numbers in the parts' STEP file
names, `template`, and `body` = the parsed YAML as a JSON object; the portal
keeps every distinct body as an immutable version and computes
`body_sha256` itself). Specs with more than one part are registered but
refused at render ("spec has N parts; a render job draws one part").

### Mode `sandbox` (a part type's reference render)

`docs/DRAWING_TEMPLATES.md` §4. The portal hands out a sandbox job from a
template item when no real job is waiting, so real work is always taken first.
The job draws a part on a template version and writes no drawing.

- Refused at claim, before download: a mode other than `issue`, `iterate`,
  `sandbox` (`Unknown mode <m>`); a sandbox job without `spec_body`
  (`Sandbox needs a spec_body`) or with a patch (`Sandbox takes no patch`).
- The title block is `SANDBOX` / `S` with the CAD revision letter, so the
  change line reads `From CAD Rev <letter>`; drawset runs with the same flags
  as for an issue, regression pass included.
- A failed verdict (exit 3, `pass: false`, regression `FAIL`) is a result:
  `verify` is reported **failed** with the reason, the sheets are still
  uploaded and `result.verify_ok` is `false`. Missing sidecars, PNGs or PDF
  and any other exit code fail the job as for an issue.
- `upload` goes through `drawingRenderUploadUrl` only, the PDF as
  `sandbox.pdf` (the portal files it under
  `drawing-templates/items/<item>/renders/<job>/`); never `docUploadUrl`.
  `storage_path` is that artefact PDF.
- The worker reports `download`, `render`, `verify`, `upload` and never
  `register`; the portal writes that step in `finishDrawingRender`.

Behaviour test (stdlib, no network): `python3 tools/drawing-worker/test_worker_sandbox.py`
(also run by `node --test tests/`).

**Restart the worker before the first reference is chosen.** A worker
started before sandbox mode claims the job, renders it and only then fails
at upload with `unknown job mode 'sandbox'`; the item fails and the
reference must be chosen again.

## Writes

| where | what |
|---|---|
| `tools/drawing-worker/worker.log` | every poll error, claim, step, finish; drawset's stdout/stderr at DEBUG (gitignored) |
| `$TMPDIR/drawing-worker-*/` | the STEP, the temp spec (with `patch:` when the job carries one), `out/` with the PDF, `.sources.json`, `<set>_dimensions.json` and `<set>_entities.json`, `png/` with one PNG per sheet, `drawset.stdout.txt` / `drawset.stderr.txt`. Removed when the job is done; kept when it fails (the log names the folder) |
| the portal | mode `issue`: the PDF under the documents bucket (`docUploadUrl`) and the issue on the drawing (`finishDrawingRender`); every mode: the PDF, the sheet PNGs, `dimensions.json` and `entities.json` under `drawings/<drawing_id>/renders/<job_id>/` (`drawingRenderUploadUrl`) (mode `sandbox`: `drawing-templates/items/<item>/renders/<job_id>/`, no drawing); the spec catalogue with bodies (`registerDrawingSpecs`) |

Nothing is written into the drawset folder.

## Check without the portal

```
python3 worker.py --catalogue                    # the registerDrawingSpecs body (with each spec's parsed body), from the real specs
python3 worker.py --dry-spec side_panel_left     # the temp spec that spec would render with
python3 worker.py --dry-spec doors_m             # "would fail at render: spec has 2 parts; ..."
```

## config.json

| key | meaning |
|---|---|
| `portal_url` | portal-api function URL |
| `token_file` | the add-in's `config.json`, relative to this folder |
| `drawset_dir` | folder with `drawset.py` and `specs/` |
| `python` | the venv interpreter drawset runs with |
| `poll_seconds` | poll interval |
