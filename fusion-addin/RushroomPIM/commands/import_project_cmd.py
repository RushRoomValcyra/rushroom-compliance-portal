"""
Import project command.

Sends every part document of the active project to the portal in one pass
(lib/project_import.py): stamp by part number, export the chosen formats,
register them on one revision, optionally release. Works across files, where
the bulk commands work inside one design.

Dialog: folders (one per line, relative to the project root), formats,
"Release each revision", "Dry run" (list what would be sent, send nothing).
"""
import traceback

import adsk.core

from lib.auth import get_token
from lib.project_import import DEFAULT_FOLDERS, DEFAULT_FORMATS, run_import

BUTTON_ID = "RushroomPIM_ImportProject"


class _CreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self, ui, handlers):
        super().__init__()
        self._ui = ui
        self._handlers = handlers

    def notify(self, args):
        try:
            if not get_token():
                self._ui.messageBox("Not connected. Run 'Connect to Portal' first.", "Rushroom PIM")
                args.isValidResult = False
                return
            inputs = args.command.commandInputs
            inputs.addTextBoxCommandInput("folders", "Folders", "\n".join(DEFAULT_FOLDERS), 4, False)
            inputs.addBoolValueInput("fmt_step", "Export .step", True, "", "step" in DEFAULT_FORMATS)
            inputs.addBoolValueInput("fmt_glb", "Export .glb", True, "", "glb" in DEFAULT_FORMATS)
            inputs.addBoolValueInput("fmt_f3z", "Export .f3z", True, "", "f3z" in DEFAULT_FORMATS)
            inputs.addBoolValueInput("release", "Release each revision", True, "", False)
            inputs.addBoolValueInput("resend", "Resend parts whose current revision is released (new letter)", True, "", False)
            inputs.addBoolValueInput("dry_run", "Dry run (list only, send nothing)", True, "", True)
            on_exec = _ExecuteHandler(self._ui)
            args.command.execute.add(on_exec)
            self._handlers.append(on_exec)
        except Exception:
            self._ui.messageBox("RushroomPIM Import error:\n" + traceback.format_exc())


class _ExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self, ui):
        super().__init__()
        self._ui = ui

    def notify(self, args):
        try:
            inputs = args.command.commandInputs
            folders = [ln.strip() for ln in inputs.itemById("folders").text.splitlines() if ln.strip()]
            formats = [f for f in ("step", "glb", "f3z") if inputs.itemById("fmt_" + f).value]
            release = inputs.itemById("release").value
            resend = inputs.itemById("resend").value
            dry_run = inputs.itemById("dry_run").value
            if not formats and not dry_run:
                self._ui.messageBox("Select at least one format.", "Rushroom PIM")
                args.isValidResult = False
                return
            pd = self._ui.createProgressDialog()
            pd.isCancelButtonShown = False
            pd.show("Rushroom PIM", "Importing project…", 0, 1, 0)
            state = run_import(folders, formats, release, resend, dry_run)
            pd.hide()
            lines = ["%s  →  %s" % (r["part_number"], r["status"]) for r in state["results"]]
            sent = sum(1 for r in state["results"] if r["status"].startswith("sent") or r["status"] == "would send")
            self._ui.messageBox("%d of %d documents %s.\n\n%s" % (
                sent, state["total"], "would be sent" if dry_run else "sent", "\n".join(lines[:60])), "Rushroom PIM")
        except Exception:
            self._ui.messageBox("Import failed:\n" + traceback.format_exc(), "Rushroom PIM")
            args.isValidResult = False


class ImportProjectCommand:
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
            BUTTON_ID, "Import project to portal",
            "Send every part document of the active project to the portal: stamp by part number, export, register one revision")
        on_created = _CreatedHandler(self._ui, self._handlers)
        self._def.commandCreated.add(on_created)
        self._handlers.append(on_created)
        self._btn = _add_to_panel(self._ui, BUTTON_ID)

    def unregister(self):
        for obj in (self._btn, self._def):
            if obj:
                try:
                    obj.deleteMe()
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
        ctrl.isPromoted = False
    return ctrl
