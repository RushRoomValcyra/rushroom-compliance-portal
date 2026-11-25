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
before and after. On start and every 5 min: `registerDrawingSpecs` from
`specs/*.yaml` (name = file stem, title, number of parts, the RR numbers in
the parts' STEP file names). Specs with more than one part are registered
but refused at render ("spec has N parts; a render job draws one part").

## Writes

| where | what |
|---|---|
| `tools/drawing-worker/worker.log` | every poll error, claim, step, finish; drawset's stdout/stderr at DEBUG (gitignored) |
| `$TMPDIR/drawing-worker-*/` | the STEP, the temp spec, `out/` with the PDF and `.sources.json`, `drawset.stdout.txt` / `drawset.stderr.txt`. Removed when the job is done; kept when it fails (the log names the folder) |
| the portal | the PDF under the documents bucket (`docUploadUrl`), the issue on the drawing (`finishDrawingRender`), the spec catalogue |

Nothing is written into the drawset folder.

## Check without the portal

```
python3 worker.py --catalogue                    # the registerDrawingSpecs body, from the real specs
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
