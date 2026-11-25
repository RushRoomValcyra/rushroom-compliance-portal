"""
Run portal test agent now.

Polls the portal once for a waiting CAD test run and executes it on the spot
(lib/test_agent_poller.poll_once — the same code path the 5 s poller uses),
then reports the outcome in a message box. For debugging the agent without
waiting for the poller; the portal's robot button is the normal trigger.
"""
import traceback

import adsk.core

from lib.auth import get_token, session_summary
from lib.test_agent_poller import poll_once

BUTTON_ID = "RushroomPIM_TestAgentNow"
TITLE = "Rushroom PIM"


class _CreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self, ui, handlers, log):
        super().__init__()
        self._ui = ui
        self._handlers = handlers
        self._log = log

    def notify(self, args):
        try:
            if not get_token():
                self._ui.messageBox("Not connected. Run 'Connect to Portal' first.", TITLE)
                args.isValidResult = False
                return
            inputs = args.command.commandInputs
            inputs.addTextBoxCommandInput("status", "", session_summary(), 1, True)
            on_exec = _ExecuteHandler(self._ui, self._log)
            args.command.execute.add(on_exec)
            self._handlers.append(on_exec)
        except Exception:
            self._ui.messageBox("RushroomPIM test agent error:\n" + traceback.format_exc(), TITLE)


class _ExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self, ui, log):
        super().__init__()
        self._ui = ui
        self._log = log

    def notify(self, args):
        try:
            app = adsk.core.Application.get()
            result = poll_once(app, self._log)
            self._ui.messageBox(summarise(result), TITLE)
        except Exception:
            self._ui.messageBox("Test agent failed:\n" + traceback.format_exc(), TITLE)
            args.isValidResult = False


def summarise(result) -> str:
    """One message for the finished run: status, then every failed step."""
    if result is None:
        return "No run is waiting in the portal."
    if result.get("busy"):
        return "A run is already executing."
    if result.get("error") and "status" not in result:
        return "Run could not be closed: %s" % result["error"]
    run = result.get("run") if isinstance(result.get("run"), dict) else result
    status = run.get("status") or "?"
    before = run.get("before") or {}
    lines = ["Run %s: %s" % (str(run.get("id", ""))[:8], status.upper())]
    if before.get("part_number"):
        lines.append("%s %s" % (before.get("part_number"), before.get("component_name") or ""))
    if run.get("error"):
        lines.append(str(run["error"]))
    failed = [s for s in (run.get("steps") or []) if s.get("status") == "failed"]
    for s in failed:
        lines.append("  %s: %s" % (s.get("label") or s.get("key"), s.get("detail") or "failed"))
    return "\n".join(lines)


class TestAgentCommand:
    def __init__(self, app, ui, handlers, log=None):
        self._app = app
        self._ui = ui
        self._handlers = handlers
        self._log = log or (lambda _m: None)
        self._def = None
        self._btn = None

    def register(self):
        cmd_defs = self._ui.commandDefinitions
        existing = cmd_defs.itemById(BUTTON_ID)
        if existing:
            existing.deleteMe()
        self._def = cmd_defs.addButtonDefinition(
            BUTTON_ID, "Run portal test agent now",
            "Poll the portal once for a waiting CAD test run and execute it")
        on_created = _CreatedHandler(self._ui, self._handlers, self._log)
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
