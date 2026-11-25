# CAD change-order test agent

A robot button in the portal that proves the engineering change order path
end to end, on the real registry, in about a minute:

> change a part in Fusion → Fusion saves a new version → stamp → send to the
> portal → the portal registers the file on the right letter → the supplier
> still sees exactly what they saw before.

One run = one Fusion save + one STEP send on one chosen part. The run never
releases anything and never touches a released letter. What it changes in
Fusion is a sketch named `PIM test agent` with one line, on the root
component's XY plane, replaced on every run so the document never
accumulates more than one. That sketch is the "minor change": not on the
part's geometry, but enough to force a real new Fusion version.

## Why

The ECO path crosses three systems (Fusion, the add-in, the portal) and two
naming/versioning policies (Fusion's save counter vs the portal's letters,
STATUS_MODEL §5.3). Every defect found so far was a seam defect: a file named
from the wrong field, a resend minting a new letter, a release stamping every
file. None of them was visible from any one side. The test agent exercises
the seam itself and writes down what it saw, so a regression shows up as a
red step in the portal, not as a supplier building from the wrong file.

## Where

Portal → **Drawings** tab → the robot button at the right end of the
Drawings | CAD Models tab bar (Rushroom roles only). It opens a one-row
panel: part select · Run · Close. The panel shows the live step list while
the run executes and the before/after facts when it is done.

Fusion side: the add-in polls the portal every 5 s while connected and
executes a requested run on the main thread. "Run portal test agent now"
(Utilities panel) polls once immediately — the same code path, for
debugging.

## The three sides

```
portal (app.js)            portal-api                   Fusion add-in
──────────────             ──────────────               ──────────────
requestCadTestRun  ─────►  INSERT cad_test_runs
                           status=requested
getCadTestRun (2 s poll)                      ◄──────  pollCadTestRun (5 s)
                           requested→running            claims the run
                                              ◄──────  reportCadTestStep ×7
                                              ◄──────  finishCadTestRun
                           verify: after snapshot,
                           steps 8–12, passed/failed
getCadTestRun  ◄─────────  full run with steps
```

## Table — `cad_test_runs` (migration 0061)

Org-scoped (organization_id NOT NULL, in TENANT_TABLES, RLS enabled).

| column | type | meaning |
|---|---|---|
| id | uuid pk | |
| organization_id | uuid NOT NULL FK organizations | |
| component_id | uuid NOT NULL FK bom_components | the part under test |
| cad_model_id | uuid FK cad_models ON DELETE SET NULL | resolved at request time |
| status | text NOT NULL | `requested` · `running` · `passed` · `failed` · `timed_out` · `cancelled` |
| requested_by | uuid FK users | |
| requested_at | timestamptz NOT NULL default now() | |
| claimed_at | timestamptz | add-in picked it up |
| claimed_by | text | "Mathias · Fusion 2.0.x · MacBook" — whatever the add-in says |
| finished_at | timestamptz | |
| before | jsonb | registry snapshot at request (shape below) |
| after | jsonb | registry snapshot at finish |
| expected | jsonb | `{ mode: "replace" \| "new_letter", letter: "A", fusion_version: 12 }` — what the portal predicted before the run; `fusion_version` is the least version the file may carry (last registered + 1), the exact number comes from the save step |
| send | jsonb | the add-in's record of the send: registerCadRevision's answer (`revision`, `revision_id`, `file_id` = its `id`, `replaced`, `created`) plus what the add-in itself sent (`sha256`, `file_name`, `fusion_version`) |
| steps | jsonb NOT NULL default '[]' | `[{ key, label, status, detail, at, data }]`, status `pending` · `running` · `passed` · `failed` · `skipped`; `data` holds structured facts the add-in attached (the save step's `{ version_before, version_after }`) |
| error | text | the one-line reason when status is failed / timed_out |
| created_at | timestamptz NOT NULL default now() | |

Index on `(organization_id, status, requested_at)` — the poll query. A partial unique index on `(organization_id) WHERE status IN ('requested','running')` holds the one-run-at-a-time rule in the database.

### Snapshot shape (`before` / `after`)

```json
{
  "at": "2026-11-25T10:00:00Z",
  "part_number": "RR-202609-JKEDBREJ",
  "component_name": "Drawer Front M",
  "fusion_document_id": "urn:adsk.wipprod:dm.lineage:…",
  "fusion_document_name": "RR-202609-JKEDBREJ Drawer Front M",
  "current":  { "id": "…", "revision": "A", "status": "draft", "fusion_version": 7 },
  "released": null,
  "revisions": [ { "id": "…", "revision": "A", "status": "draft",
                   "files": [ { "id": "…", "format": "step", "file_name": "RR-… .step",
                                "fusion_version": 7, "sha256": "…" } ] } ],
  "model_status": "draft",
  "history_count": 12,
  "supplier_view": {
    "cad_released_revision": null,
    "drawings": [ { "drawing_number": "DRW-0007", "released_revision": "B" } ]
  },
  "warnings": [ { "code": "…", "text": "…" } ]
}
```

`supplier_view` is what the supplier role can reach for this part: the
released CAD letter (none → nothing) and, per linked drawing, its released
issue (none → the drawing is invisible). It is computed with the same rule the
supplier actions use — released only. `warnings` is `statusSummary(...).warnings`.

## Steps — fixed order, fixed keys

Fusion side, reported by the add-in with `reportCadTestStep` as they happen:

| # | key | passes when |
|---|---|---|
| 1 | `claim` | add-in claimed the run; detail = who/what Fusion |
| 2 | `open` | document found by `fusion_document_id`, opened (or already open, then activated so the export reads it) and **not modified**; its hub name equals `fusion_document_name`; Fusion version noted |
| 3 | `change` | earlier `PIM test agent` sketches removed; one new sketch with one line added on the root XY plane |
| 4 | `save` | `doc.save("Test agent run <id8>")` returned true and `dataFile.versionNumber` went up by exactly one within 90 s; the step's `data` is `{ version_before, version_after }` |
| 5 | `stamp` | root carries `pim_component_id == component_id` (already stamped → passed, detail "already stamped"; a wrong id → failed, the run does not restamp) |
| 6 | `export` | STEP exported with `file_stem = dataFile.name`, so the file is `safe_file_stem(name) + ".step"` (letters, digits, `-_. ` kept, the rest `_`, 120 characters); sha256 computed |
| 7 | `send` | `cadUploadUrl` + `registerCadRevision(format=step, fusion_version, sha256, fusion_revision_label)` answered ok; the answer is stored in `send` |

Portal side, computed by `finishCadTestRun`:

| # | key | passes when |
|---|---|---|
| 8 | `naming` | the sent file's `file_name == safe_file_stem(fusion_document_name) + ".step"` (same sanitiser as the add-in, `safeFileStem` in the core); `fusion_document_name` starts with the part number; `cad_models.fusion_document_name` unchanged by the run |
| 9 | `versioning` | the save step's `version_after == version_before + 1` and the file's `fusion_version == version_after` (the document may be ahead of the last send: v12 and v13 never left the engineer's machine); the file is never at or below the before file's version; file `sha256` differs from the before file; letter rule: `expected.mode == "replace"` → `send.revision == before.current.revision`, not `created`, and when the letter already had a STEP `send.replaced == true` with the same file id (a first STEP on the letter is inserted, `replaced == false`); `expected.mode == "new_letter"` → `send.revision == nextRevisionLetter(before letters)` and `send.created == true` |
| 10 | `status` | in replace mode `after.current.status == before.current.status` (a replaced file leaves a checked or approved letter alone, as registerCadRevision does), in new_letter mode `draft`; never released/superseded; `after.released` equals `before.released` (same id); at most one released revision; `after.model_status == after.current.status` (dual-write coherent) |
| 11 | `supplier` | `after.supplier_view` deep-equals `before.supplier_view` — a draft send changes nothing a supplier can reach |
| 12 | `changelog` | `bom_component_history` for the part gained a row after `requested_at` whose notes match `/CAD revision \w+ (re-)?registered \(step\)/` |

A Fusion-side failure marks that step `failed`, the remaining Fusion steps
`skipped`, and the add-in still calls `finishCadTestRun`; the portal then
skips 8–12 (status `failed`, `error` = the step's detail). A run that is
not claimed within **120 s** of `requested_at` becomes `timed_out` the next
time anyone reads it. A run that is `running` for more than **10 min**
becomes `failed` ("add-in stopped reporting").

## API — all `role === "rushroom"` only, all in portal-api

| action | body | returns |
|---|---|---|
| `requestCadTestRun` | `{ component_id }` | the run (`status: requested`, `before`, `expected`, `steps` all pending). 400 when another run is `requested`/`running` for the org (one at a time), 404 when the part has no CAD model or no `fusion_document_id` |
| `getCadTestRun` | `{ run_id }` | the run; applies the timeouts above lazily |
| `listCadTestRuns` | `{ limit? }` | last N runs (default 10) with component name/part number, newest first |
| `cancelCadTestRun` | `{ run_id }` | `requested` → `cancelled`; anything else 409 |
| `pollCadTestRun` | `{ agent? }` | the oldest `requested` run claimed for this caller: `requested → running`, `claimed_at`, `claimed_by = agent`, step `claim` passed; returns `{ run: null }` when nothing is waiting. Idle cost: one indexed select of the org's open runs (which also applies the timeouts) |
| `reportCadTestStep` | `{ run_id, key, status, detail?, data? }` | updates that step (status `running`/`passed`/`failed`/`skipped`); `data` is kept on the step and, when `key == "send"`, also merged into `send`. 409 when the run is not `running`, and the add-in then stops: it saves and sends nothing more for a run the portal has closed |
| `finishCadTestRun` | `{ run_id }` | takes the `after` snapshot, evaluates steps 8–12, sets `passed`/`failed`, `finished_at`; returns the run |

The pure parts — step keys and labels, `expectedOutcome(before)`,
`verifyRun({ before, after, expected, send, steps, historyRows })` → `{ steps, passed }`,
`snapshotSupplierView(...)` — live in `_shared/test-agent-core.mjs`, imported
by portal-api and by the tests. Nothing in them touches a database.

## Add-in

- `lib/test_agent.py` — `run_test(run: dict) -> dict`: executes steps 2–7,
  reports each with `reportCadTestStep`, calls `finishCadTestRun`, never
  raises. Uses `export_formats(root, ["step"], file_stem=df.name)`,
  `get_stamp`, `upload_file`, `sha256_of`, `parse_revision_label`.
- `lib/test_agent_poller.py` — `start(app, log)` registers a custom event
  `RushroomPIM_TestAgentPoll` and a daemon thread that fires it every 5 s
  while `get_token()` is truthy; the handler (main thread) calls
  `pollCadTestRun(agent=<name · Fusion version · hostname>)` and, when a run
  comes back, `run_test(run)`. The handler skips a tick while a command dialog
  is open (`activeCommand != "SelectCommand"`), so a run never tears down the
  engineer's dialog. `stop()` ends the thread and unregisters the event. A poll
  failure is logged to `debug.log`, never shown in a dialog.
- `commands/test_agent_cmd.py` — "Run portal test agent now": polls once and
  reports the result in a message box.
- `RushroomPIM.py` — starts/stops the poller with the add-in. It has to be the
  add-in that registers the custom event: an event registered from a script
  (the MCP bridge, a one-off run) is delivered only while that script is
  executing, so a poller started that way is deaf the moment the script ends.
  Found on the first run (2026-11-25): the thread fired every 5 s, nothing
  arrived, the run timed out. After a code change, stop and run the add-in
  from Utilities → Add-Ins; toggling it through accessibility flips the switch
  without restarting it.

## Portal UI

Robot button (inline SVG, same `svg()` helper as the other icons) at the right
of the Drawings | CAD Models tab bar. Panel directly under the bar:

```
Part  [RR-202609-JKEDBREJ Drawer Front M · Rev A draft ▾]   Rev A draft → files replaced on Rev A      [Run]  [×]
```

While running: the 12 steps as rows — name, state glyph, detail — refreshed
every 2 s from `getCadTestRun`. When finished: the same list, plus a
before/after table (letter · status · Fusion version · file name · sha256
short · supplier view). A `timed_out` run says the add-in did not pick it
up. The last runs are listed under the panel (`listCadTestRuns`, 5 rows:
when · part · result).

Labels outside boxes, no explanatory copy, one row of controls.

## Out of scope

Releasing, drawings, GLB. The agent proves the CAD send path; the release
path has its own rule (`releaseRevisionRow`) and its own tests.

## First run — 2026-11-25

Top Panel M (RR-202609-3T39YDLW), Rev A draft, document already open in
Fusion: all twelve steps green in 16.6 s. Fusion v5 → v6, sha256
27dde895… → 42088af7…, Rev A file replaced on the same row, supplier view
"nothing" before and after, Change Log row "CAD revision A re-registered
(step)". The run before it timed out for the reason recorded under
`RushroomPIM.py` above.
