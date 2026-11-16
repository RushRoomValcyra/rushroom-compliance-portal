"""
RushroomPIM Fusion add-in — Phase 3.1 of the identity programme.

Three commands, added to the Utilities workspace:
  Connect to Portal  — authenticates once per 8-hour session
  Stamp This Component  — searches the portal and writes pim_component_id +
                          pim_part_number attributes on the active component,
                          then registers this Fusion document as the CAD source
  Release to Portal  — exports .f3z / .step / .glb, uploads via signed URL,
                       and registers a revision letter in the portal registry

Install:
  Mac:  ~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/
  Win:  %APPDATA%\\Autodesk\\Autodesk Fusion 360\\API\\AddIns\\
  Copy the entire RushroomPIM/ folder into AddIns, then enable in
  Tools → Add-ins → Scripts and Add-ins → My Add-ins tab.
"""
import adsk.core
import adsk.fusion
import traceback

from commands.connect_cmd import ConnectCommand
from commands.stamp_cmd import StampCommand
from commands.release_cmd import ReleaseCommand

_app: adsk.core.Application = None
_ui: adsk.core.UserInterface = None
_commands = []
_handlers = []  # keep handlers alive so the GC doesn't destroy them


def run(context):
    global _app, _ui, _commands, _handlers
    try:
        _app = adsk.core.Application.get()
        _ui = _app.userInterface

        for Cmd in [ConnectCommand, StampCommand, ReleaseCommand]:
            cmd = Cmd(_app, _ui, _handlers)
            cmd.register()
            _commands.append(cmd)

    except Exception:
        if _ui:
            _ui.messageBox("RushroomPIM failed to start:\n" + traceback.format_exc())


def stop(context):
    global _commands, _handlers
    for cmd in _commands:
        try:
            cmd.unregister()
        except Exception:
            pass
    _commands.clear()
    _handlers.clear()
