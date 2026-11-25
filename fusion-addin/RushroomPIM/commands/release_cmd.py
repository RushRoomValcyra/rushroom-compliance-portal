"""
Send to portal command (STATUS_MODEL.md §8).

Preconditions:
  1. The active component must be stamped (pim_component_id attribute present).
  2. The user must be connected (valid token).

Flow:
  1. The dialog shows the portal line for this part — "Rev F released ·
     G draft · Fusion v12" — read from getComponentCad (cad_model.
     current_revision / released_revision / status).
  2. User selects formats (f3z / step / glb).  The Revision field defaults to
     the letter parsed from the Fusion document name ("VALCYRA RevF …" → F);
     blank means "next letter".  "Release this revision" is off by default.
  3. On execute:
     a. Export each selected format to a temp directory.
     b. For each exported file:
        i.   Request a signed upload URL           (cadUploadUrl)
        ii.  PUT the file to Supabase Storage
        iii. Register it on the revision            (registerCadRevision,
             with fusion_revision_label and sha256; same letter for all formats)
     c. If "Release this revision" is ticked AND every selected format
        registered, call releaseCadRevision once with the revision_id from
        the last registerCadRevision response.  A partial export is never
        released — the engineer gets a draft and a message instead.
     d. Clean up the temp directory.
     e. Report: "Registered Rev G (STEP, GLB) — draft" or
        "— released, Rev F superseded".

Status words on screen follow the portal enum: Draft / Checked / Approved /
Released / Superseded.  "Rev" is the CAD letter, "Fusion v12" the save counter.

Physical properties (volume, area, mass) are read and shown in the dialog but
are NOT sent to the portal yet — the schema columns for them land in Phase 3.4.
"""
import os
import traceback

import adsk.core

from lib.auth import get_token
from lib.exports import (
    cleanup_tmpdir,
    export_formats,
    get_active_component,
    get_doc_name,
    get_fusion_version,
    get_physical_props,
    get_stamp,
    next_revision_letter,
    parse_revision_label,
)
from lib.portal import call, sha256_of, upload_file

BUTTON_ID = "RushroomPIM_Release"


def _superseded_letter(rel_r, prev_released, just_released):
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


def _cap(status):
    """'released' → 'Released'; None → 'Draft' (the portal's default)."""
    s = (status or "draft").strip()
    return s[:1].upper() + s[1:].lower()


def portal_line(cad_model, fusion_version=None):
    """
    Build the one-line portal summary from a getComponentCad cad_model:
      "Rev F released · G draft · Fusion v12"
    Facts that do not exist are left out; no model at all → "Not yet registered".
    """
    if not cad_model:
        return "Not yet registered in portal"
    released = cad_model.get("released_revision") or ""
    current = cad_model.get("current_revision") or ""
    status = (cad_model.get("status") or "draft").lower()
    parts = []
    if released:
        parts.append(f"Rev {released} released")
    if current and current != released:
        parts.append(f"{'Rev ' if not released else ''}{current} {status}")
    if not parts:
        parts.append("No revision yet")
    if fusion_version is not None:
        parts.append(f"Fusion v{fusion_version}")
    return " · ".join(parts)


class _CreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self, ui, handlers):
        super().__init__()
        self._ui = ui
        self._handlers = handlers

    def notify(self, args):
        try:
            if not get_token():
                self._ui.messageBox(
                    "Not connected. Run 'Connect to Portal' first.", "Rushroom PIM"
                )
                args.isValidResult = False
                return

            comp = get_active_component()
            stamp = get_stamp(comp)
            if not stamp.get("pim_component_id"):
                self._ui.messageBox(
                    "This component is not stamped.\n"
                    "Run 'Stamp This Component' first to link it to a PIM entry.",
                    "Rushroom PIM",
                )
                args.isValidResult = False
                return

            cmd = args.command
            inputs = cmd.commandInputs

            # Current stamp — read-only info
            inputs.addTextBoxCommandInput(
                "stamp_info", "Component",
                f"{stamp.get('pim_part_number', '?')}  ({stamp['pim_component_id'][:8]}…)",
                1, True,
            )

            fv = get_fusion_version()

            # Portal line — what the engineer is sending into.
            cad_model = None
            portal_text = "Portal unreachable — status unknown"
            try:
                cad_r = call("getComponentCad", component_id=stamp["pim_component_id"])
                cad_model = (cad_r or {}).get("cad_model")
                portal_text = portal_line(cad_model, fv)
            except Exception:
                pass
            inputs.addTextBoxCommandInput("portal_status", "Portal", portal_text, 1, True)

            # Format checkboxes
            inputs.addBoolValueInput("fmt_f3z",  "Export .f3z  (Fusion archive)", True, "", True)
            inputs.addBoolValueInput("fmt_step", "Export .step (neutral, for suppliers)", True, "", True)
            inputs.addBoolValueInput("fmt_glb",  "Export .glb  (Blender / Studio)", True, "", True)

            # Revision — the portal assigns the next letter, one step per send,
            # independent of Fusion's save counter and of the RevX label in the
            # document name (that label is the product generation, metadata only).
            # Blank = next letter; a typed letter overrides, forward only (§5.3).
            doc_name = get_doc_name()
            parsed = parse_revision_label(doc_name)
            current = (cad_model or {}).get("current_revision") or ""
            current_status = (cad_model or {}).get("status") or ""
            released = (cad_model or {}).get("released_revision") or ""
            if current and current_status != "released":
                next_text = f"Rev {current} (draft, files replaced)"
            else:
                next_text = f"Rev {next_revision_letter(current)}"
            rev_input = inputs.addStringValueInput("revision", "Revision (blank = next)", "")
            rev_input.tooltip = "Blank: the portal assigns the next letter. Type a letter to override (forward only)."
            hint = f"Next: {next_text}"
            if released:
                hint += f" · Rev {released} released"
            if fv is not None:
                hint += f" · Fusion v{fv}"
            if parsed:
                hint += f" · {parsed[0]} (document label, recorded only)"
            inputs.addTextBoxCommandInput("revision_hint", "", hint, 1, True)

            # Release this revision — off by default (§8).
            inputs.addBoolValueInput("release", "Release this revision", True, "", False)

            # Fusion version — auto-read, metadata only
            inputs.addTextBoxCommandInput(
                "fusion_version", "Fusion version",
                f"v{fv}" if fv is not None else "(unsaved doc — no version number)",
                1, True,
            )

            # Physical properties preview (read-only; not sent to portal in this phase)
            props = get_physical_props(comp)
            if props:
                prop_txt = (
                    f"Volume: {props.get('volume_cm3', '?'):.2f} cm³  "
                    f"Area: {props.get('area_cm2', '?'):.2f} cm²  "
                    f"Mass: {props.get('mass_fusion_units', '?'):.4f} (Fusion units)"
                )
            else:
                prop_txt = "Physical properties unavailable for this component."
            inputs.addTextBoxCommandInput(
                "phys_props", "Physical properties (Phase 3.4)",
                prop_txt, 2, True,
            )

            on_exec = _ExecuteHandler(self._ui)
            cmd.execute.add(on_exec)
            self._handlers.append(on_exec)

        except Exception:
            self._ui.messageBox("RushroomPIM Send to portal error:\n" + traceback.format_exc())


class _ExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self, ui):
        super().__init__()
        self._ui = ui

    def notify(self, args):
        tmpdir = None
        try:
            inputs = args.command.commandInputs
            comp = get_active_component()
            stamp = get_stamp(comp)
            cad_model_id = None
            prev_released = None   # letter released before this send — the one a release supersedes

            # 0. Resolve the cad_model record for this component.
            cad_r = call("getComponentCad", component_id=stamp["pim_component_id"])
            if not cad_r or not cad_r.get("cad_model"):
                # This should not happen if Stamp also called linkCadDocument,
                # but linkCadDocument may have been skipped (component_id missing).
                link_r = call(
                    "linkCadDocument",
                    component_id=stamp["pim_component_id"],
                )
                cad_model_id = link_r.get("id")
            else:
                cad_model_id = cad_r["cad_model"]["id"]
                prev_released = cad_r["cad_model"].get("released_revision") or None

            if not cad_model_id:
                raise RuntimeError("Could not find or create a CAD model record. Try Stamp again.")

            # 1. Determine which formats to export.
            formats = []
            if inputs.itemById("fmt_f3z").value:
                formats.append("f3z")
            if inputs.itemById("fmt_step").value:
                formats.append("step")
            if inputs.itemById("fmt_glb").value:
                formats.append("glb")
            if not formats:
                self._ui.messageBox("Select at least one format.", "Rushroom PIM")
                args.isValidResult = False
                return

            revision_override = inputs.itemById("revision").value.strip().upper() or None
            do_release = bool(inputs.itemById("release").value)
            fusion_version = get_fusion_version()
            parsed = parse_revision_label(get_doc_name())
            fusion_revision_label = parsed[0] if parsed else None

            # 2. Export.
            pd = self._ui.createProgressDialog()
            pd.isCancelButtonShown = False
            pd.show("Rushroom PIM", "Exporting…", 0, len(formats) + 1, 0)
            pd.message = "Exporting formats from Fusion…"

            exported, tmpdir = export_formats(comp, formats, file_stem=get_doc_name())
            if not exported:
                pd.hide()
                raise RuntimeError(
                    "No formats were exported successfully. "
                    "Check that the document is saved and the component has geometry."
                )
            missing = [f for f in formats if f not in exported]

            # 3. Upload + register each exported file.
            revision_registered = None
            revision_id = None
            replaced = []
            pd.maximumValue = len(exported) * 2 + (2 if do_release else 1)
            step = 0

            for fmt, file_path in exported.items():
                file_name = os.path.basename(file_path)
                step += 1
                pd.message = f"Uploading {file_name}…"
                pd.progressValue = step

                url_r = call("cadUploadUrl", fileName=file_name)
                signed_url = url_r["signedUrl"]
                storage_path = url_r["path"]

                upload_file(signed_url, file_path)

                step += 1
                pd.message = f"Registering {fmt.upper()}…"
                pd.progressValue = step

                reg_r = call(
                    "registerCadRevision",
                    cad_model_id=cad_model_id,
                    format=fmt,
                    storage_path=storage_path,
                    file_name=file_name,
                    revision=revision_override,
                    fusion_revision_label=fusion_revision_label,
                    fusion_version=fusion_version,
                    sha256=sha256_of(file_path),
                )
                revision_registered = reg_r.get("revision", revision_registered)
                revision_id = reg_r.get("revision_id", revision_id)
                if reg_r.get("replaced"):
                    replaced.append(fmt)
                # All formats in one send share the same letter — pass it
                # explicitly after the first one so they all land in the same slot.
                if revision_override is None and revision_registered:
                    revision_override = revision_registered

            # 4. Release — only when asked AND every selected format made it.
            released = False
            superseded = None
            release_note = ""
            if do_release:
                if missing:
                    release_note = (
                        f"\n\nNot released: {', '.join(missing).upper()} failed to export. "
                        "Fix and send again, then release."
                    )
                elif not revision_id:
                    release_note = (
                        "\n\nNot released: the portal did not return a revision id. "
                        "Release it in the portal (Drawings → CAD Models)."
                    )
                else:
                    step += 1
                    pd.message = f"Releasing Rev {revision_registered}…"
                    pd.progressValue = step
                    rel_r = call("releaseCadRevision", cad_model_revision_id=revision_id)
                    released = True
                    superseded = _superseded_letter(rel_r, prev_released, revision_registered)

            pd.progressValue = pd.maximumValue
            pd.hide()

            # 5. Report.
            part_num = stamp.get("pim_part_number", "?")
            fmt_list = ", ".join(exported.keys()).upper()
            if released:
                outcome = "released"
                if superseded:
                    outcome += f", Rev {superseded} superseded"
            else:
                outcome = "draft"
            msg = f"Registered Rev {revision_registered} ({fmt_list}) — {outcome}\n\n{part_num}"
            if replaced:
                msg += f"\nReplaced on the draft: {', '.join(replaced).upper()}"
            if missing and not do_release:
                msg += f"\nNot exported: {', '.join(missing).upper()}"
            msg += release_note
            self._ui.messageBox(msg, "Rushroom PIM")

        except Exception as ex:
            self._ui.messageBox(f"Send to portal failed: {ex}", "Rushroom PIM")
            args.isValidResult = False
        finally:
            if tmpdir:
                cleanup_tmpdir(tmpdir)


class ReleaseCommand:
    def __init__(self, app, ui, handlers):
        self._app = app
        self._ui = ui
        self._handlers = handlers
        self._def = None
        self._btn = None

    def register(self):
        cmd_defs = self._ui.commandDefinitions
        existing = cmd_defs.itemById(BUTTON_ID)
        if existing:
            existing.deleteMe()

        self._def = cmd_defs.addButtonDefinition(
            BUTTON_ID,
            "Send to portal",
            "Export this component and register the files on a CAD revision in the "
            "Rushroom portal; optionally release that revision",
        )
        on_created = _CreatedHandler(self._ui, self._handlers)
        self._def.commandCreated.add(on_created)
        self._handlers.append(on_created)

        self._btn = _add_to_panel(self._ui, BUTTON_ID)

    def unregister(self):
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
