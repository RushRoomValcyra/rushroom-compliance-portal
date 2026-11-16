"""
Connect to Portal command.
Signs in with email + password, stores the 8-hour token.
Fusion event handler objects must be kept in a module-level list (or the
caller's handlers list) to prevent Python's GC from destroying them.
"""
import adsk.core
import traceback

from lib.auth import load_config, save_config, save_session, session_summary
from lib.portal import call_public


BUTTON_ID = "RushroomPIM_Connect"
PANEL_ID = "UtilityPanel"
WORKSPACE_ID = "FusionSolidEnvironment"


class _CreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self, ui, handlers):
        super().__init__()
        self._ui = ui
        self._handlers = handlers

    def notify(self, args):
        try:
            cmd = args.command
            inputs = cmd.commandInputs
            cfg = load_config()

            inputs.addStringValueInput("email", "Email", cfg.get("email", ""))
            pw = inputs.addStringValueInput("password", "Password", "")
            # Fusion has no native password field; this shows in plain text.
            # A note is added to remind users not to use this on shared screens.
            inputs.addTextBoxCommandInput(
                "note", "",
                "Session lasts 8 hours. The password is not stored.", 2, True,
            )

            status_txt = inputs.addTextBoxCommandInput(
                "status", "", session_summary(), 1, True,
            )

            on_exec = _ExecuteHandler(self._ui)
            cmd.execute.add(on_exec)
            self._handlers.append(on_exec)
        except Exception:
            self._ui.messageBox("RushroomPIM Connect error:\n" + traceback.format_exc())


class _ExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self, ui):
        super().__init__()
        self._ui = ui

    def notify(self, args):
        try:
            inputs = args.command.commandInputs
            email = inputs.itemById("email").value.strip()
            password = inputs.itemById("password").value
            if not email or not password:
                self._ui.messageBox("Enter your email and password.", "Rushroom PIM")
                args.isValidResult = False
                return
            r = call_public("loginUser", email=email, password=password)
            if r.get("role") != "rushroom":
                self._ui.messageBox(
                    "Only Rushroom accounts can use this add-in.\n"
                    f"Your account role is: {r.get('role', 'unknown')}",
                    "Rushroom PIM",
                )
                args.isValidResult = False
                return
            save_session(r["token"], r["role"], r.get("name", ""), r.get("organization_id", ""))
            # Store email (not password) so the Connect dialog pre-fills it next time.
            cfg = load_config()
            cfg["email"] = email
            save_config(cfg)
            self._ui.messageBox(
                f"Connected as {r.get('name', email)}.\n"
                "Session is valid for 8 hours. The add-in is ready.",
                "Rushroom PIM",
            )
        except Exception as ex:
            self._ui.messageBox(f"Connection failed: {ex}", "Rushroom PIM")
            args.isValidResult = False


class ConnectCommand:
    def __init__(self, app, ui, handlers):
        self._app = app
        self._ui = ui
        self._handlers = handlers
        self._def = None
        self._btn = None

    def register(self):
        cmd_defs = self._ui.commandDefinitions
        # Remove a stale definition if present (e.g. after a hot-reload).
        existing = cmd_defs.itemById(BUTTON_ID)
        if existing:
            existing.deleteMe()

        self._def = cmd_defs.addButtonDefinition(
            BUTTON_ID,
            "Connect to Portal",
            "Sign in to the Rushroom E&C Portal",
        )
        on_created = _CreatedHandler(self._ui, self._handlers)
        self._def.commandCreated.add(on_created)
        self._handlers.append(on_created)

        self._btn = _add_to_panel(self._ui, BUTTON_ID, separator_before=False)

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


def _add_to_panel(ui, cmd_id, separator_before=False):
    ws = ui.workspaces.itemById(WORKSPACE_ID)
    if not ws:
        return None
    toolbar_panels = ws.toolbarPanels
    panel = toolbar_panels.itemById("UtilityPanel") or toolbar_panels.itemById("InspectPanel")
    if not panel:
        return None
    ctrl = panel.controls.itemById(cmd_id)
    if ctrl:
        ctrl.deleteMe()
    return panel.controls.addCommand(
        ui.commandDefinitions.itemById(cmd_id),
        "", False,
    )
