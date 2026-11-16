"""
Stamp This Component command.

Searches the portal BOM for a matching component, writes pim_component_id and
pim_part_number attributes on the active Fusion component, and calls
linkCadDocument to register this Fusion document as the CAD source for that
component.

The search is text-based (name or part number). The user picks from a dropdown
of matches. If the component is already stamped the current values pre-fill.
"""
import adsk.core
import traceback

from lib.auth import get_token
from lib.exports import get_active_component, get_doc_info, get_stamp, set_stamp
from lib.portal import call

BUTTON_ID = "RushroomPIM_Stamp"


class _CreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self, ui, handlers):
        super().__init__()
        self._ui = ui
        self._handlers = handlers
        self._matches = []

    def notify(self, args):
        try:
            if not get_token():
                self._ui.messageBox(
                    "Not connected. Run 'Connect to Portal' first.", "Rushroom PIM"
                )
                args.isValidResult = False
                return

            cmd = args.command
            inputs = cmd.commandInputs
            comp = get_active_component()
            stamp = get_stamp(comp)

            inputs.addStringValueInput(
                "search", "Search (name or part number)",
                stamp.get("pim_part_number") or comp.name,
            )
            inputs.addTextBoxCommandInput(
                "hint", "",
                "Type a name or part number and click Search to find the BOM entry.", 2, True,
            )
            # Dropdown populated by the search handler.
            self._drop = inputs.addDropDownCommandInput(
                "pick", "Component", adsk.core.DropDownStyles.LabeledIconDropDownStyle,
            )
            self._drop.isVisible = False

            inputs.addTextBoxCommandInput(
                "current", "Current stamp",
                (f"{stamp['pim_part_number']}  ({stamp['pim_component_id']})"
                 if stamp.get("pim_component_id") else "not stamped"),
                1, True,
            )

            # Search button is a boolean toggle the user clicks to trigger search.
            self._search_btn = inputs.addBoolValueInput("do_search", "Search", False, "", False)

            on_changed = _ChangedHandler(self._ui, self._drop)
            cmd.inputChanged.add(on_changed)
            self._handlers.append(on_changed)

            on_exec = _ExecuteHandler(self._ui, on_changed)
            cmd.execute.add(on_exec)
            self._handlers.append(on_exec)

        except Exception:
            self._ui.messageBox("RushroomPIM Stamp error:\n" + traceback.format_exc())


class _ChangedHandler(adsk.core.InputChangedEventHandler):
    def __init__(self, ui, drop):
        super().__init__()
        self._ui = ui
        self._drop = drop
        self.matches = []  # list of { id, name, part_number }

    def notify(self, args):
        try:
            changed = args.input
            if changed.id != "do_search":
                return
            inputs = args.inputs
            search = inputs.itemById("search").value.strip()
            if not search:
                return
            r = call("listComponents", search=search)
            self.matches = [
                c for c in (r.get("components") or [])
                if c.get("lifecycle_status") not in ("replaced", "inactive")
            ]
            self._drop.listItems.clear()
            if not self.matches:
                self._drop.isVisible = False
                self._ui.messageBox(f"No active components found for '{search}'.", "Rushroom PIM")
                return
            for c in self.matches:
                label = f"{c['part_number']}  —  {c['name']}" if c.get("part_number") else c["name"]
                self._drop.listItems.add(label, False)
            self._drop.listItems.item(0).isSelected = True
            self._drop.isVisible = True
        except Exception as ex:
            self._ui.messageBox(f"Search failed: {ex}", "Rushroom PIM")


class _ExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self, ui, changed_handler):
        super().__init__()
        self._ui = ui
        self._changed = changed_handler  # holds self.matches

    def notify(self, args):
        try:
            inputs = args.command.commandInputs
            drop = inputs.itemById("pick")
            if not drop.isVisible or not self._changed.matches:
                self._ui.messageBox(
                    "Search for a component first, then select it.", "Rushroom PIM"
                )
                args.isValidResult = False
                return

            idx = next(
                (i for i in range(drop.listItems.count) if drop.listItems.item(i).isSelected), 0
            )
            chosen = self._changed.matches[idx]
            comp = get_active_component()
            doc_info = get_doc_info()

            # 1. Write PIM attributes onto the Fusion component.
            set_stamp(comp, chosen["id"], chosen.get("part_number", ""))

            # 2. Register this Fusion document as the CAD source in the portal.
            link_result = call(
                "linkCadDocument",
                component_id=chosen["id"],
                fusion_document_id=doc_info.get("fusion_document_id"),
                fusion_document_name=doc_info.get("fusion_document_name"),
                fusion_project_id=doc_info.get("fusion_project_id"),
            )

            part_num = chosen.get("part_number", chosen["id"][:8])
            already = link_result.get("updated", False)
            self._ui.messageBox(
                f"Stamped:  {part_num}  —  {chosen['name']}\n\n"
                + ("CAD document link updated in portal." if already else "CAD document linked in portal."),
                "Rushroom PIM",
            )
        except Exception as ex:
            self._ui.messageBox(f"Stamp failed: {ex}", "Rushroom PIM")
            args.isValidResult = False


class StampCommand:
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
            "Stamp This Component",
            "Link the active Fusion component to its PIM identity",
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
