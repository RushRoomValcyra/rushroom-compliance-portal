# One status model for drawings and CAD models

_Design, 2026-11-24. Decided direction: status lives on the revision (ziirvass, 2026-11-24). Built 0060, step D 2026-11-25._

_Changed 2026-11-25 (ziirvass, DRAWINGS_TAB_UX.md §12): **three states.** Checked and Approved go; a revision is Draft · Released · Superseded on drawings and on CAD alike, and §5.1 is one table with one hand move, draft → released. Why: "as few statuses as possible, without losing control" — the controls that stop a bad release are the ones step D built (the release modal with the facts, the zero-file refusal, the released-by stamp, the Change Log), and the two review states had cost more than they guarded: found while testing step D, a draft issue reading "Approved 25/11/2026 · Checked 25/11/2026". The day a second engineer reviews another's drawing, the honest form is a "Reviewed by" stamp on the issue, not a state. The enum `drawing_status` keeps its five values and the `checked_*` / `approved_*` columns stay, unwritten, until the 0063 clean-up; `STATUSES` in `status-core.mjs` keeps the five words so an old row still renders. The §1 fault table and §9 (0060) stand as history and are not rewritten._

## 1 Why

"It is hopeless to have various statuses, versions and names without understanding what you are looking at" (ziirvass, 2026-11-24). Today the portal keeps a status on the drawing *and* on each drawing revision, a status on the CAD model *and* a release stamp on each CAD file, a Fusion version counter, an auto-counted CAD letter and a drawing issue letter — and the Fusion command called Release does not release. Each of these was reasonable on its own; together they let the portal print **released** next to something that is not.

The faults, from the code as of commit 4438a5f:

| Object | Status today | Fault |
|---|---|---|
| Drawing | `drawings.status` (draft → checked → approved → released → superseded), moved by `setDrawingStatus` | `addDrawingRevision` inserts a new draft revision and makes it current, but never touches `drawings.status`. A released drawing with a new issue in work still reads **released**. |
| Drawing revision | `drawing_revisions.status`, `released_at`; written only on release (current → released, earlier released → superseded) | Never `checked` or `approved`; the two status columns describe different things and nothing keeps them aligned. |
| CAD model | `cad_models.status` draft/released (free text), `current_revision` letter | `registerCadRevision` advances the letter and leaves `status = released`. `releaseCadModel` stamps `released_at` on every unreleased file of every letter, so an abandoned draft letter is "released" too. No superseded state. |
| CAD file | `released_at`, `fusion_version` | The letter is counted per export (A, B, C …) and has no relation to the design revision in the document name ("RevF") or to the drawing issue. |
| Fusion add-in | "Release to Portal", "Bulk release" | Export and register files; never release. Since 4438a5f the dialog warns about it. |

The pattern: status is kept on the object, but release is a property of a revision. Every "add a revision" silently leaves the object lying about its state.

## 2 Principle

**The revision is the controlled object. Objects only report.**

- A drawing revision and a CAD model revision have the same lifecycle, the same words and the same rules.
- A drawing or a CAD model has no status of its own. It reports two facts derived from its revisions: the **current** revision (newest letter) with its status, and the **released** revision (the one a supplier may build from), if any. Shown as *Issue F released · G draft*.
- One release action, same on both sides: release the current revision, supersede the previously released one, stamp who and when on that revision only.
- The portal assigns the letters, one step per send. The CAD letter and the drawing issue letter are separate sequences from the same alphabet; neither is derived from Fusion's save counter nor from the product generation in a document name.

## 3 Glossary — the three numbers

| Name | What it is | Who sets it | Where it shows |
|---|---|---|---|
| **Fusion version** `v11`, `v14` | Fusion's own save counter of the document (`dataFile.versionNumber`): every save, not monotonic across copies | Fusion, on every save | Only as metadata on a CAD file ("Fusion v14"), never as a revision. Gaps are normal: v12 and v13 were working iterations that never left the engineer's machine |
| **Revision** `Rev B` | The controlled revision of a part's CAD model in the portal: one step per **send to the portal**; a letter, A, B … Z, AA | The portal, at registration (next letter); the engineer may override forward | CAD Models tab, part card, Fusion dialog |
| **Issue** `Issue A` | The controlled revision of a drawing; a letter from the same alphabet, its own sequence | The portal, at `addDrawingRevision` (next letter); override forward | Drawings register, part card, title block |
| **Revision label** `RevF` in a document name | The **product generation** written into every Fusion document name of that generation (`VALCYRA RevF Door M …`, Rev F panels, Rev F drawings) | The engineer, by naming the document | Stored on the CAD revision as `fusion_revision_label` and shown next to it; never used for a letter — every Rev F part would otherwise start at F whether it changed once or five times |

The word **version** is reserved for Fusion's counter; the portal says revision and issue. The three numbers are independent: v11 becomes Rev A when sent, v14 becomes Rev B when sent, and a drawing of that part can be at Issue A throughout.

## 4 Data model

One enum for both lifecycles — `drawing_status` already exists; it is reused, not duplicated. Since 2026-11-25 three of its five values are the lifecycle:

`draft → released → superseded`

`checked` and `approved` remain in the enum (dropping a value is a migration, planned with the 0063 clean-up); no transition reaches them and no row uses them.

### 4.1 drawing_revisions (changed)

| Column | Change | Why |
|---|---|---|
| `status drawing_status` | unchanged; becomes the only status of a drawing | the revision is the controlled object |
| `released_at` | unchanged | |
| `released_by` | **new**, nullable | a state without who and when is half a state |
| `checked_at`, `checked_by`, `approved_at`, `approved_by` | added in 0060, **retired 2026-11-25**: stay, unwritten, until 0063 | no transition stamps them any more; a future "Reviewed by" is a stamp on the issue, not a state |
| `source_cad_file_id` → `cad_model_files(id)`, `source_sha256 VARCHAR(64)` | **new**, nullable | the STEP file a drawing was made from. `drawset.py` writes the STEP's sha256 into its `.sources.json`; with it on the revision the portal can say *this drawing is not from the released CAD* exactly, not by date |

### 4.2 drawings (changed)

| Column | Change |
|---|---|
| `status` | **dropped** (migration 0063, after the API stops reading it). The read actions return a derived `status` (= current revision's) and `released_revision` so the UI keeps one field name. |
| `current_revision_id` | unchanged |

### 4.3 cad_model_revisions (new) — mirrors drawing_revisions

| Column | Type |
|---|---|
| `id` | UUID PK |
| `organization_id` | UUID NOT NULL → organizations; added to `TENANT_TABLES` |
| `cad_model_id` | UUID NOT NULL → cad_models ON DELETE CASCADE |
| `revision` | VARCHAR(10) NOT NULL — the letter |
| `status` | `drawing_status` NOT NULL DEFAULT 'draft' |
| `fusion_revision_label` | VARCHAR(20) — "RevF" as found in the document name at registration |
| `fusion_version` | INTEGER — the save counter when the letter was first registered |
| `released_at`, `released_by` | as on drawing revisions |
| `checked_at`, `checked_by`, `approved_at`, `approved_by` | as on drawing revisions: retired 2026-11-25, unwritten, dropped with 0063 |
| `notes` | TEXT |
| `created_at`, `created_by` | |
| UNIQUE | (organization_id, cad_model_id, revision) |

### 4.4 cad_model_files (changed)

| Column | Change |
|---|---|
| `cad_model_revision_id` → cad_model_revisions | **new**, NOT NULL after backfill |
| `revision` | **dropped** (0063) — one source of truth for the letter |
| `released_at` | **dropped** (0063) — release is a property of the revision |
| `fusion_version`, `sha256`, `format`, `storage_path`, `file_name` | unchanged |
| UNIQUE | (organization_id, cad_model_revision_id, format) |

### 4.5 cad_models (changed)

| Column | Change |
|---|---|
| `status`, `current_revision` | **dropped** (0063) |
| `current_revision_id` → cad_model_revisions | **new**; same shape as `drawings.current_revision_id` |

Not changed: `surgery_templates.status` (active / retired — a rule set, not a document), `documents` / `document_versions`, `bom_components.lifecycle_status`.

## 5 Rules

### 5.1 Transitions — one table for both (three states since 2026-11-25)

| From | To | Who | Effect |
|---|---|---|---|
| draft | released | rushroom | `released_at/by`; the previously released revision → superseded; refused without a file, refused unless current |
| released | superseded | automatic, when a later revision is released | never by hand |
| superseded | — | | terminal |

`canTransition(kind, from, to)` in `status-core.mjs` has exactly these for both kinds. `setDrawingRevisionStatus` / `setDrawingStatus` / `setCadRevisionStatus` answer 400 "Cannot go from draft to checked" for the retired words. A row that still carries `checked` or `approved` (none does) has no exit: it is released by adding the next issue and releasing that.

Release, on both sides: only the **current** revision can be released (refused otherwise, 400 "Rev E is not the current revision; G is"). The previously released revision becomes superseded. `released_at/by` are stamped on that revision only. The BOM history gets one `drawing_released` / "CAD revision F released" event; the part's revision letter is **not** bumped by a release (today's rule, kept).

### 5.2 New revisions

- `addDrawingRevision` and `registerCadRevision` with a new letter create a **draft** revision and make it current. The object then reports *F released · G draft*. Nothing else changes — this is the fix for the fault in §1.
- A new letter must sort after every existing letter of that object. The order is **length first, then text** (`compareRevision` in `status-core.mjs`; "Z" < "AA"), the same order `nextRevisionLetter` has always used; the backfill in 0060 orders by `(length(revision), revision)` for the same reason. Labels that are not letters (old rows may carry "A1" or "REV-B": nothing ever validated them) sort by the same rule and are not rewritten. Out of order is refused: "Rev D is below the current G".
- An object with **no revision** reports `draft` and nothing released. Releasing or moving the status of such an object is refused (400 "no revision to release"): a status needs a thing to be the status of.
- Re-registering a format on a **draft** CAD revision **replaces** the file (new storage path, new sha256) — exporting again after a fix is the normal Fusion workflow. On a released or superseded revision it is refused: "Rev F is released; register the next letter".

### 5.3 Letter policy (CAD)

- `registerCadRevision` takes `revision` (letter, optional) and `fusion_revision_label` (metadata). With no letter the portal assigns the **next letter** after the model's current one — one step per send, whatever Fusion's save counter did in between. The label the add-in parses from the document name (`Rev([A-Z]{1,2})`, case-insensitive) is stored and shown, never used for the letter.
- A send while the current revision is still a draft lands on that same draft letter and replaces its files (§5.2): v15 overwrites v14 on Rev B. After a release the next send is C.
- A typed letter overrides, forward only: a letter lower than the current one is refused (§5.2). The dialog shows what will happen before the user confirms: "Next: Rev B · Rev A released · Fusion v14 · RevF (document label, recorded only)".
- **One letter per export, resolved once.** The add-in resolves the letter before the format loop (the label, the override, or the letter the first `registerCadRevision` answers with) and sends it on every format. Today the bulk command never passes a letter, so STEP lands on B and GLB on C — one export split over two letters, each with one file. The backfill does not try to merge such rows; they stay as they are and sort by the rule above.

### 5.4 Coherence between a part's drawing and its CAD

Computed in one pure function, `statusSummary(drawingsOfPart, cadModelWithRevisions)` in `_shared/status-core.mjs` (browser, server and tests share it, the `cost-math.mjs` pattern):

| Warning | Rule |
|---|---|
| `cad_draft_drawing_released` | a drawing with role `depicts` has a released issue and the CAD model has no released revision |
| `drawing_from_other_cad` | the released drawing revision records the CAD file it was made from (`source_cad_file_id`, or `source_sha256` from drawset's sidecar) and that file belongs to another CAD revision than the released one: "made from CAD Rev B; the released CAD is Rev C". Issue letters and CAD letters are never compared — they are separate sequences. Without a recorded source the portal says nothing |
| `cad_missing` | the part has released drawings and no CAD model |

Returned by `getComponentCad` as `summary` and shown on the part card and in the CAD Models tab. Warnings are information, never blocks: a supplier package is a human decision.

## 6 API

| Action | Change |
|---|---|
| `listDrawings`, `getDrawing` | `status` = current revision's status (derived); add `released_revision` (letter or null). The `body.status` filter applies to the derived status |
| `getSidePanelSurgery`, `listSupplierComponents` | both read `drawings.status` today and swallow errors (`{ data }` without `error`), so the drop in 0063 would silently empty the surgery template badges and the supplier BOM's drawing rows. Both derive the status from the current revision |
| **Suppliers** (`listDrawings`, `getDrawing`, `drawingFileUrl`, `listSupplierComponents` with role `supplier`) | **Changed policy.** Today a supplier sees every status and can open a draft file (`supplierDrawingScope` filters only `is_supplier_visible`). From now a supplier sees a drawing only when it has a **released** revision, sees only that revision (status Released, issue = the released letter), and `drawingFileUrl` refuses any other revision to a supplier. Without this the new default revision — the newest letter, which is a draft the moment a new issue is started — would put a supplier on an unreleased drawing |
| `addDrawingRevision` | unchanged signature; accepts `source_cad_file_id`, `source_sha256`; the new revision is draft and current |
| `setDrawingStatus` | kept as an alias for one release: acts on the current revision. New `setDrawingRevisionStatus {drawing_revision_id, status}` with the §5.1 table; stamps `released_at/by` |
| `createDrawingWithRevision`, `adoptDrawing` | unchanged: both leave the Rev A row at `draft` and never wrote `drawings.status`; `supplier_revision` ("their F") stays a label on the revision, not a status. Since 2026-11-25 `createDrawingWithRevision` (and the older `createDrawing`) no longer read `projection_angle`, `sheet_size`, `scale` from the body, and `extractDrawingMeta` in portal-ai no longer asks for them; the three `drawings` columns stay, unwritten, until 0063 |
| `linkCadDocument`, `cadUploadUrl`, `getComponentCad` | `getComponentCad` returns `cad_model` + `revisions[]` (each with `files[]`) + `summary` (§5.4); model-level `status`, `current_revision`, `released_revision` are derived |
| `registerCadRevision` | finds or creates the revision row (draft) from `revision` / `fusion_revision_label`; replace-or-refuse per §5.2; `release: true` releases that revision at the end, same rule as below |
| `releaseCadModel` | kept as an alias: releases the current revision. New `releaseCadRevision {cad_model_revision_id}` and `setCadRevisionStatus` with the §5.1 table |
| `listCadModels` | per model: `current_revision`, `current_status`, `released_revision`, `formats` of the current revision, `preview_file` of the released revision when there is one (else current) |

All Rushroom-only, as today. The alias actions are removed in the release after the frontend has moved.

## 7 UI — one vocabulary

| Place | Shows |
|---|---|
| Drawings register row | *Issue F released · G draft* (chip per fact); filter chips apply to the current revision |
| Drawing surface rail | the current revision's chip; its one action, Release, opens the release modal (DRAWINGS_TAB_UX.md §11); each revision row keeps its own chip (already so); the modal names the revision that will be superseded |
| Part card → Drawings tab | a status line at the top: **CAD** Rev F released · G draft · **Drawing** RR-… Issue F released, followed by the §5.4 warnings as amber chips; the drawing rows keep Revision + Status |
| Part card → CAD model block | same facts, plus "Fusion v12" on the current revision's files |
| CAD Models tab, main row | Rev column *F released · G draft*; **Release** on the row releases the current draft revision; Draft / Released filter chips read the current revision |
| CAD Models tab, expanded row | one group per revision: letter, status chip, who/when, files with format badge, Fusion version, sha, Preview / Download; Release per draft revision that is current |
| `supplier.html` | suppliers see released drawings only (new, see §6): the register and the supplier BOM's drawing rows show the released issue with a Released chip (`drawingStatusChip`, not the lifecycle colours), and the surface lists only released revisions |

The words on screen are the three lifecycle values capitalised: Draft, Released, Superseded. `drawingStatusChip` / `drawingStatusLabel` still render Checked and Approved for any old row a future import might carry. "Rev" for CAD, "Issue" for drawings, "Fusion v" for the counter.

## 8 Fusion add-in

| Command | Change |
|---|---|
| Release to Portal → **Send to portal** | Dialog: portal line *Rev F released · G draft · Fusion v12*; Revision field defaults to the letter parsed from the document name (editable; blank = next letter); **Release this revision** checkbox, default off. Registers every format with `fusion_revision_label` and `sha256`; when ticked, calls `releaseCadRevision` once at the end. The result box says what happened: "Registered Rev G (step, glb) — draft" or "— released, Rev F superseded". |
| Bulk release → **Send to portal (bulk)** | Same checkbox for the batch; the table already shows portal status per component — it gains released / current letters. |
| Stamp | unchanged |

`lib/portal.py` gains `sha256_of(path)`; `lib/exports.py` gains `parse_revision_label(doc_name)`.

## 9 Migration and rollout

Two migrations, so that a deployed API never reads a dropped column:

**0060 — add and backfill** (safe with the old API still running)
1. `cad_model_revisions` created; `TENANT_TABLES` updated (tests/tenant-tables guards it).
2. One row per distinct `(cad_model_id, revision)` in `cad_model_files`: `status = released` when any file of that letter has `released_at` (take the earliest as `released_at`), else `draft`. Where a model ends up with more than one released letter, the highest stays released and the others become superseded.
3. `cad_model_files.cad_model_revision_id` filled; it stays **nullable until 0063** — in the minute between `db push` and the function deploy the old `registerCadRevision` still inserts files without it, and a NOT NULL would make every Fusion send fail after the upload (orphaned storage objects). The new API always fills it. "Highest letter" uses `(length(revision), revision)`. `cad_models.current_revision_id` = that row.
4. `drawing_revisions`: new columns. Backfill of the fault in §1: where the current revision is `draft` and `drawings.status` is `checked` or `approved`, copy it to the revision (that is what the user set). Where `drawings.status` is `superseded` by hand and the current revision still says `released`, copy `superseded` to it. Where `drawings.status` is `released` or `superseded` and the drawing has **no** revision at all (placeholder surgery-template drawings from 0055, drawings made with `createDrawing` and released before a file was added: `setDrawingStatus` only wrote the revision row when one existed), there is nothing to carry the state: these report `draft` from now on and the migration lists them in a NOTICE so they can be given a revision by hand. The migration RAISEs a NOTICE with every count.
5. Nothing dropped.

Between 0060 and 0063 the API **dual-writes**: it stops reading `drawings.status`, `cad_models.status`, `cad_models.current_revision`, `cad_model_files.revision` and `cad_model_files.released_at`, but keeps writing them (the derived status, the letter, the release stamp), so that rolling the function back still works. The response shapes keep every field name the deployed page reads (`status`, `current_revision`, flat `files[]` with `released_at` in `getComponentCad`), so the API can be deployed before the page.

Deploy order: `supabase db push` → `supabase functions deploy portal-api --no-verify-jwt` → `git push origin main` → reload the add-in in Fusion.

**0063 — drop** (numbered 0061 when this was written; 0061 became `cad_test_runs`, docs/TEST_AGENT.md; 0062 became `drawing_render_jobs`, docs/DRAWING_RENDER.md), one release later: `drawings.status`, `cad_models.status`, `cad_models.current_revision`, `cad_model_files.revision`, `cad_model_files.released_at`; `cad_model_files.cad_model_revision_id` becomes NOT NULL; the alias actions and the dual writes go. Added 2026-11-25 to the same clean-up: `drawing_revisions` and `cad_model_revisions` lose `checked_at`, `checked_by`, `approved_at`, `approved_by`; `drawings` loses `projection_angle`, `sheet_size`, `scale`; the enum `drawing_status` loses `checked` and `approved` (after a check that no row carries them).

## 10 Tests

- `tests/status-model.test.mjs` (pure, always runs): the transition table (every from/to pair, both sides), `statusSummary` for each warning in §5.4 and for the clean case, letter ordering refusals.
- `tests/drawings.test.mjs`: the status test moves to revision semantics (a released drawing with a new draft issue reports `status = draft`, `released_revision = F`).
- `tests/tenant-tables.test.mjs`: picks up `cad_model_revisions` automatically.
- `tests/routing-static.test.mjs`: unchanged (no heavy imports added to portal-api).

## 11 Open questions

1. ~~CAD: is draft → released without checked/approved right, or should a CAD revision go through the same four steps as a drawing?~~ Answered 2026-11-25 the other way round: drawings take the CAD rule, draft → released for both (§5.1).
2. Is the `RevF` label in Fusion document names authoritative enough to be the default letter, or should the add-in always ask?
3. When a drawing is released with an issue letter different from the released CAD letter: warn (this design) or refuse?
4. Who may release? Today everyone with the `rushroom` role; nothing finer exists.
