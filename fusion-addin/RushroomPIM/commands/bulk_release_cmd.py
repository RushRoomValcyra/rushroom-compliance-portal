"""
Send to portal (bulk) command (STATUS_MODEL.md §8).

Opens an HTML palette that lists every STAMPED component in the active
design, shows each one's portal facts — released letter, current letter and
its status — and sends them all in one pass.

Flow:
  1. Palette loads → Python scans the design for stamped components and calls
     getComponentCad for each to show "Rev F released · G draft".
  2. User picks formats (STEP + GLB default; f3z is document-level and
     attaches to the first component only — typically skipped in bulk) and
     optionally ticks "Release this revision" for the whole batch.
  3. User clicks "Send selected".
  4. Python processes each component in sequence:
       a. Ensure a cad_model record exists (linkCadDocument if needed).
       b. export_formats  →  cadUploadUrl  →  upload  →  registerCadRevision
          (with fusion_revision_label parsed from the document name and the
          file's sha256; every format of one component lands on one letter).
       c. If release is ticked and every requested format registered, call
          releaseCadRevision for that component's revision — one release per
          component, after its files.  A partial export stays draft.
       d. Send per-component progress back to the HTML.

The letter: the document name's RevX label is the default for every component
in the batch (one document, one design revision); when the name carries no
label the portal picks the next letter per component, as before.

f3z note: a Fusion archive (.f3z) is a DOCUMENT-level export — it captures
the whole file, not a single component.  Releasing 20 components in one
assembly would upload the same archive 20 times.  The bulk release therefore
attaches the f3z only to the first component in the batch (the assembly root
or whichever component the user has ticked), and only when the user explicitly
enables it.  Single-component releases via "Release to Portal" continue to
support f3z per-component normally.
"""
import json
import os
import traceback

import adsk.core
import adsk.fusion

from lib.auth import get_token
from lib.exports import (
    ATTR_GROUP, ATTR_COMPONENT_ID, ATTR_PART_NUMBER,
    cleanup_tmpdir, export_formats, get_doc_info, get_doc_name,
    get_fusion_version, get_stamp, parse_revision_label,
)
from lib.portal import call, sha256_of, upload_file

BUTTON_ID  = "RushroomPIM_BulkRelease"
PALETTE_ID = "RushroomPIM_BulkReleasePalette"

_ADDIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_UI_HTML   = os.path.join(_ADDIN_DIR, "commands", "bulk_release_ui.html")

_palette         = None
_palette_handler = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _scan_stamped() -> list:
    """Return all stamped components in the active design."""
    app    = adsk.core.Application.get()
    design = adsk.fusion.Design.cast(app.activeProduct)
    rows   = []
    for fc in design.allComponents:
        stamp = get_stamp(fc)
        if stamp["pim_component_id"]:
            rows.append({
                "fusion_name":       fc.name,
                "pim_component_id":  stamp["pim_component_id"],
                "pim_part_number":   stamp["pim_part_number"],
            })
    rows.sort(key=lambda r: r["fusion_name"].lower())
    return rows


def _enrich_with_portal_status(rows: list) -> list:
    """
    For each row, call getComponentCad and read the derived facts off cad_model:
      current_revision  — highest letter ("" when no revision)
      cad_status        — status of the current revision (draft/checked/approved/
                          released/superseded); "none" when no cad_model, "error"
                          when the portal could not be reached
      released_revision — the letter a supplier may build from, or ""
      revision_count    — len(revisions)
    One call per row; the design is small enough that this is acceptable.
    """
    enriched = []
    for row in rows:
        try:
            r  = call("getComponentCad", component_id=row["pim_component_id"])
            cm = r.get("cad_model") or {}
            enriched.append({
                **row,
                "current_revision":  cm.get("current_revision") or "",
                "released_revision": cm.get("released_revision") or "",
                "cad_status":        (cm.get("status") or "none") if cm else "none",
                "cad_model_id":      cm.get("id") or "",
                "revision_count":    len(r.get("revisions") or []),
                "file_count":        len(r.get("files") or []),
            })
        except Exception:
            enriched.append({
                **row, "current_revision": "", "released_revision": "",
                "cad_status": "error", "cad_model_id": "", "revision_count": 0, "file_count": 0,
            })
    return enriched


def _superseded_letter(rel_r: dict, prev_released, just_released):
    """
    Name the revision a release superseded.  The portal reports it as a letter
    (superseded_revision) or only as a count (superseded); in the latter case
    the letter that was released before this send is the one superseded.
    """
    rel_r = rel_r or {}
    letter = rel_r.get("superseded_revision")
    if isinstance(letter, str) and letter:
        return letter
    count = rel_r.get("superseded")
    if isinstance(count, str) and count:
        return count
    if count and prev_released and prev_released != just_released:
        return prev_released
    return None


# ---------------------------------------------------------------------------
# Palette event handler
# ---------------------------------------------------------------------------

class _PaletteHTMLHandler(adsk.core.HTMLEventHandler):
    def __init__(self, app, ui, handlers):
        super().__init__()
        self._app      = app
        self._ui       = ui
        self._handlers = handlers

    def _send(self, action: str, payload):
        global _palette
        if _palette:
            _palette.sendInfoToHTML(action, json.dumps(payload))

    def notify(self, args):
        try:
            ea     = adsk.core.HTMLEventArgs.cast(args)
            action = ea.action
            data   = json.loads(ea.data) if ea.data else {}

            if action in ("scan", "ready"):
                rows = _scan_stamped()
                rows = _enrich_with_portal_status(rows)
                self._send("scanDone", {"rows": rows, "total": len(rows)})

            elif action == "releaseBatch":
                self._release_batch(data)

        except Exception:
            self._send("error", {"message": traceback.format_exc()})

    def _release_batch(self, data: dict):
        """
        Process a list of components: export → upload → register (→ release).
        Sends releaseProgress after each component.
        """
        component_ids   = data.get("component_ids") or []  # list of pim_component_id strings
        formats_enabled = set(data.get("formats") or ["step", "glb"])
        include_f3z     = data.get("include_f3z", False)
        do_release      = bool(data.get("release", False))

        if not component_ids:
            self._send("releaseDone", {"ok": 0, "errors": 0, "messages": ["Nothing selected."]})
            return

        app    = adsk.core.Application.get()
        design = adsk.fusion.Design.cast(app.activeProduct)

        # Build a lookup: pim_component_id → Fusion component
        comp_map: dict[str, adsk.fusion.Component] = {}
        for fc in design.allComponents:
            stamp = get_stamp(fc)
            cid   = stamp.get("pim_component_id")
            if cid and cid in component_ids:
                comp_map[cid] = fc

        doc_info       = get_doc_info()
        fusion_version = get_fusion_version()
        parsed         = parse_revision_label(get_doc_name())
        rev_label      = parsed[0] if parsed else None   # "RevF" as written in the name
        rev_letter     = parsed[1] if parsed else None   # "F" — default letter for the batch
        f3z_done       = False   # only upload the archive once per batch

        ok_count    = 0
        error_count = 0
        messages    = []

        for idx, cid in enumerate(component_ids):
            fc = comp_map.get(cid)
            if not fc:
                error_count += 1
                msg = f"Component {cid[:8]}… not found in design — skip"
                messages.append(msg)
                self._send("releaseProgress", {
                    "pim_component_id": cid, "done": False, "message": msg,
                    "index": idx, "total": len(component_ids),
                })
                continue

            part_num = get_stamp(fc).get("pim_part_number") or fc.name
            self._send("releaseProgress", {
                "pim_component_id": cid, "done": False, "message": f"Exporting {part_num}…",
                "index": idx, "total": len(component_ids),
            })

            tmpdir = None
            try:
                # 1. Ensure cad_model record exists; remember the released letter
                #    so a release can name what it superseded.
                r  = call("getComponentCad", component_id=cid)
                cm = r.get("cad_model") if r else None
                prev_released = None
                if not cm:
                    link_r = call("linkCadDocument", component_id=cid, **doc_info)
                    cad_model_id = link_r.get("id") or ""
                else:
                    cad_model_id  = cm["id"]
                    prev_released = cm.get("released_revision") or None

                if not cad_model_id:
                    raise RuntimeError("Could not get or create cad_model record")

                # 2. Determine formats for this component.
                # f3z is document-level — only do it once per batch run.
                fmts = list(formats_enabled - {"f3z"})
                if include_f3z and not f3z_done:
                    fmts = ["f3z"] + fmts

                if not fmts:
                    raise RuntimeError("No formats selected")

                # 3. Export.
                exported, tmpdir = export_formats(fc, fmts)
                if not exported:
                    raise RuntimeError("No formats exported — ensure the document is saved and has geometry")

                missing = [f for f in fmts if f not in exported]

                # 4. Upload + register each file — all on one letter.
                revision_registered = None
                revision_id         = None
                letter              = rev_letter
                for fmt, file_path in exported.items():
                    file_name    = os.path.basename(file_path)
                    url_r        = call("cadUploadUrl", fileName=file_name)
                    signed_url   = url_r["signedUrl"]
                    storage_path = url_r["path"]
                    upload_file(signed_url, file_path)

                    reg_r = call(
                        "registerCadRevision",
                        cad_model_id=cad_model_id,
                        format=fmt,
                        storage_path=storage_path,
                        file_name=file_name,
                        revision=letter,
                        fusion_revision_label=rev_label,
                        fusion_version=fusion_version,
                        sha256=sha256_of(file_path),
                    )
                    revision_registered = reg_r.get("revision", revision_registered)
                    revision_id         = reg_r.get("revision_id", revision_id)
                    # Pin the letter the portal chose so the next formats join it.
                    if letter is None and revision_registered:
                        letter = revision_registered

                if include_f3z and "f3z" in exported:
                    f3z_done = True

                # 5. Release this component's revision — only when every
                #    requested format registered.
                released   = False
                superseded = None
                note       = ""
                if do_release:
                    if missing:
                        note = f" — not released: {', '.join(missing).upper()} failed to export"
                    elif not revision_id:
                        note = " — not released: portal returned no revision id"
                    else:
                        rel_r = call("releaseCadRevision", cad_model_revision_id=revision_id)
                        released = True
                        superseded = _superseded_letter(rel_r, prev_released, revision_registered)

                if released:
                    outcome = "released" + (f", Rev {superseded} superseded" if superseded else "")
                else:
                    outcome = "draft"

                ok_count += 1
                self._send("releaseProgress", {
                    "pim_component_id": cid,
                    "done": True,
                    "revision": revision_registered or "?",
                    "released": released,
                    "superseded": superseded,
                    "formats": list(exported.keys()),
                    "message": f"{part_num}  →  Rev {revision_registered} — {outcome}{note}",
                    "index": idx,
                    "total": len(component_ids),
                })

            except Exception as ex:
                error_count += 1
                msg = f"{part_num}: {ex}"
                messages.append(msg)
                self._send("releaseProgress", {
                    "pim_component_id": cid, "done": False, "error": True,
                    "message": msg, "index": idx, "total": len(component_ids),
                })
            finally:
                if tmpdir:
                    cleanup_tmpdir(tmpdir)

        self._send("releaseDone", {
            "ok": ok_count, "errors": error_count, "messages": messages,
        })


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------

class _CreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self, app, ui, handlers):
        super().__init__()
        self._app      = app
        self._ui       = ui
        self._handlers = handlers

    def notify(self, args):
        try:
            if not get_token():
                self._ui.messageBox("Not connected. Run 'Connect to Portal' first.", "Rushroom PIM")
                args.isValidResult = False
                return
            cmd = args.command
            cmd.isAutoExecute = True
            on_exec = _ExecuteHandler(self._app, self._ui, self._handlers)
            cmd.execute.add(on_exec)
            self._handlers.append(on_exec)
        except Exception:
            self._ui.messageBox("RushroomPIM Send to portal (bulk) error:\n" + traceback.format_exc())


class _ExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self, app, ui, handlers):
        super().__init__()
        self._app      = app
        self._ui       = ui
        self._handlers = handlers

    def notify(self, args):
        global _palette, _palette_handler
        try:
            existing = self._ui.palettes.itemById(PALETTE_ID)
            if existing:
                try:
                    existing.deleteMe()
                except Exception:
                    pass

            html_url = "file://" + _UI_HTML
            palette  = self._ui.palettes.add(
                PALETTE_ID, "Rushroom — Send to portal (bulk)",
                html_url, True, True, True, 900, 620,
            )
            handler = _PaletteHTMLHandler(self._app, self._ui, self._handlers)
            palette.incomingFromHTML.add(handler)
            self._handlers.append(handler)
            _palette_handler = handler
            _palette = palette

        except Exception:
            self._ui.messageBox("Send to portal (bulk) failed:\n" + traceback.format_exc())


# ---------------------------------------------------------------------------
# Command registration
# ---------------------------------------------------------------------------

class BulkReleaseCommand:
    def __init__(self, app, ui, handlers):
        self._app      = app
        self._ui       = ui
        self._handlers = handlers
        self._def      = None
        self._btn      = None

    def register(self):
        cmd_defs = self._ui.commandDefinitions
        existing = cmd_defs.itemById(BUTTON_ID)
        if existing:
            existing.deleteMe()

        self._def = cmd_defs.addButtonDefinition(
            BUTTON_ID,
            "Send to portal (bulk)",
            "Export and register CAD files for all stamped components in one pass; "
            "optionally release each revision",
        )
        on_created = _CreatedHandler(self._app, self._ui, self._handlers)
        self._def.commandCreated.add(on_created)
        self._handlers.append(on_created)
        self._btn = _add_to_panel(self._ui, BUTTON_ID)

    def unregister(self):
        global _palette
        if _palette:
            try:
                _palette.deleteMe()
            except Exception:
                pass
            _palette = None
        if self._btn:
            try:
                self._btn.deleteMe()
            except Exception:
                pass
        if self._def:
            try:
                self._def.deleteMe()
            except Exception:
                pass


def _add_to_panel(ui, cmd_id):
    ws = ui.workspaces.itemById("FusionSolidEnvironment")
    if not ws:
        return None
    panel = ws.toolbarPanels.itemById("UtilityPanel") or ws.toolbarPanels.itemById("InspectPanel")
    if not panel:
        return None
    ctrl = panel.controls.itemById(cmd_id)
    if ctrl:
        ctrl.deleteMe()
    ctrl = panel.controls.addCommand(ui.commandDefinitions.itemById(cmd_id), "", False)
    if ctrl:
        ctrl.isPromoted = True
    return ctrl
