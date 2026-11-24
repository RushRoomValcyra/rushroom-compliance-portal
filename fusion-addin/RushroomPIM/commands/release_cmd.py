"""
Release to Portal command.

Preconditions:
  1. The active component must be stamped (pim_component_id attribute present).
  2. The user must be connected (valid token).

Flow:
  1. User selects formats (f3z / step / glb) and optionally a revision letter.
  2. On execute:
     a. Export each selected format to a temp directory.
     b. For each exported file:
        i.  Request a signed upload URL  (cadUploadUrl)
        ii. PUT the file to Supabase Storage
        iii.Register the revision         (registerCadRevision)
     c. Clean up the temp directory.
     d. Report the registered revision letter and formats.

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
    get_fusion_version,
    get_physical_props,
    get_stamp,
)
from lib.portal import call, upload_file

BUTTON_ID = "RushroomPIM_Release"


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

            # Fetch current portal status so the user knows what they're releasing into.
            cad_status = "unknown"
            cur_rev = ""
            try:
                cad_r = call("getComponentCad", component_id=stamp["pim_component_id"])
                if cad_r.get("cad_model"):
                    cad_status = cad_r["cad_model"].get("status") or "draft"
                    cur_rev = cad_r["cad_model"].get("current_revision") or ""
                else:
                    cad_status = "not registered"
            except Exception:
                pass

            status_text = {
                "draft":          f"DRAFT{(' · ' + cur_rev) if cur_rev else ''}",
                "released":       f"Released{(' · Rev ' + cur_rev) if cur_rev else ''}",
                "not registered": "Not yet registered in portal",
            }.get(cad_status, cad_status)
            inputs.addTextBoxCommandInput("portal_status", "Portal status", status_text, 1, True)

            if cad_status == "draft":
                inputs.addTextBoxCommandInput(
                    "draft_warning", "",
                    "⚠  DRAFT model — files will be registered but status stays DRAFT "
                    "until released in the portal (Drawings → CAD Models → Release).",
                    2, True,
                )

            # Format checkboxes
            inputs.addBoolValueInput("fmt_f3z",  "Export .f3z  (Fusion archive)", True, "", True)
            inputs.addBoolValueInput("fmt_step", "Export .step (neutral, for suppliers)", True, "", True)
            inputs.addBoolValueInput("fmt_glb",  "Export .glb  (Blender / Studio)", True, "", True)

            # Revision override — blank means "next letter"
            inputs.addStringValueInput("revision", "Revision (blank = next letter)", "")

            # Fusion version — auto-read
            fv = get_fusion_version()
            inputs.addTextBoxCommandInput(
                "fusion_version", "Fusion version",
                str(fv) if fv is not None else "(unsaved doc — no version number)",
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
            self._ui.messageBox("RushroomPIM Release error:\n" + traceback.format_exc())


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
            fusion_version = get_fusion_version()

            # 2. Export.
            pd = self._ui.createProgressDialog()
            pd.isCancelButtonShown = False
            pd.show("Rushroom PIM", "Exporting…", 0, len(formats) + 1, 0)
            pd.message = "Exporting formats from Fusion…"

            exported, tmpdir = export_formats(comp, formats)
            if not exported:
                pd.hide()
                raise RuntimeError(
                    "No formats were exported successfully. "
                    "Check that the document is saved and the component has geometry."
                )

            # 3. Upload + register each exported file.
            revision_registered = None
            pd.maximumValue = len(exported) * 2 + 1
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
                pd.message = f"Registering {fmt.upper()} revision…"
                pd.progressValue = step

                reg_r = call(
                    "registerCadRevision",
                    cad_model_id=cad_model_id,
                    format=fmt,
                    storage_path=storage_path,
                    file_name=file_name,
                    revision=revision_override,
                    fusion_version=fusion_version,
                )
                revision_registered = reg_r.get("revision", revision_registered)
                # All formats in one release share the same letter — pass it
                # explicitly after the first one so they all land in the same slot.
                if revision_override is None and revision_registered:
                    revision_override = revision_registered

            pd.progressValue = pd.maximumValue
            pd.hide()

            part_num = stamp.get("pim_part_number", "?")
            fmt_list = ", ".join(exported.keys()).upper()
            self._ui.messageBox(
                f"Released  {part_num}  →  Revision {revision_registered}\n\n"
                f"Formats registered: {fmt_list}\n\n"
                "The revision is now visible in the portal's CAD tab for this component.",
                "Rushroom PIM",
            )

        except Exception as ex:
            self._ui.messageBox(f"Release failed: {ex}", "Rushroom PIM")
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
            "Release to Portal",
            "Export and register a CAD revision in the Rushroom portal",
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
