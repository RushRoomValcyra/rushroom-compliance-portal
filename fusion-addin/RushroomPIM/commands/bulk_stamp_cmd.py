"""
Bulk Stamp command.

Opens an HTML palette that lists every component in the active design,
auto-matches each one to a portal BOM entry by name, and lets the user
review and apply stamps in one pass.

Designed to be re-run as an audit tool: already-stamped components show
their current state; unmatched or conflicting ones are highlighted.

Matching logic (applied to the cleaned Fusion component name — version
suffix "_vN" and occurrence suffix ":N" are stripped before comparison):
  exact case-insensitive name match  → auto_match
  partial (one side is substr of other) → auto_match (medium confidence)
  multiple matches                   → ambiguous  (user must pick)
  no match                           → not_found  (user must search)
  already stamped + portal entry ok  → ok
  already stamped + portal entry gone → conflict
"""
import json
import os
import re
import traceback

import adsk.core
import adsk.fusion

from lib.auth import get_token
from lib.exports import ATTR_GROUP, ATTR_COMPONENT_ID, ATTR_PART_NUMBER
from lib.portal import call

BUTTON_ID = "RushroomPIM_BulkStamp"
PALETTE_ID = "RushroomPIM_BulkStampPalette"

_ADDIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_UI_HTML = os.path.join(_ADDIN_DIR, "commands", "bulk_stamp_ui.html")

_palette = None          # kept at module level so it survives command teardown
_palette_handler = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _clean(name: str) -> str:
    """Strip Fusion occurrence / version suffixes for name matching."""
    n = re.sub(r':\d+$', '', name)
    n = re.sub(r'[_\s]+v\d+(\.\d+)*$', '', n, flags=re.IGNORECASE)
    return n.strip().lower()


def _get_stamp(comp: adsk.fusion.Component) -> dict:
    def _v(k):
        a = comp.attributes.itemByName(ATTR_GROUP, k)
        return a.value if a else ""
    return {"pim_component_id": _v(ATTR_COMPONENT_ID), "pim_part_number": _v(ATTR_PART_NUMBER)}


def _set_stamp(comp: adsk.fusion.Component, cid: str, pn: str) -> None:
    comp.attributes.add(ATTR_GROUP, ATTR_COMPONENT_ID, cid)
    comp.attributes.add(ATTR_GROUP, ATTR_PART_NUMBER, pn)


def _scan() -> list:
    """
    Scan all components in the active design and match against portal.
    One API call (all portal components), then local matching.
    """
    app = adsk.core.Application.get()
    design = adsk.fusion.Design.cast(app.activeProduct)
    fusion_comps = list(design.allComponents)

    r = call("listComponents")
    portal_comps = [
        c for c in (r.get("components") or [])
        if c.get("lifecycle_status") not in ("replaced", "inactive")
    ]

    by_clean: dict = {}
    portal_by_id: dict = {}

    for pc in portal_comps:
        portal_by_id[pc["id"]] = pc
        cn = _clean(pc.get("name") or "")
        if cn:
            by_clean.setdefault(cn, []).append(pc)

    rows = []
    for fc in fusion_comps:
        stamp = _get_stamp(fc)
        fc_clean = _clean(fc.name)

        if stamp["pim_component_id"]:
            portal_entry = portal_by_id.get(stamp["pim_component_id"])
            rows.append({
                "fusion_name": fc.name,
                "stamp": stamp,
                "status": "ok" if portal_entry else "conflict",
                "proposed": portal_entry,
                "candidates": [],
            })
            continue

        exact = by_clean.get(fc_clean, [])

        if not exact:
            # Try partial / substring match
            exact = [
                pc for pc in portal_comps
                if fc_clean and (
                    fc_clean in _clean(pc.get("name") or "") or
                    _clean(pc.get("name") or "") in fc_clean
                )
            ]

        if len(exact) == 1:
            status = "auto_match"
        elif len(exact) > 1:
            status = "ambiguous"
        else:
            status = "not_found"

        rows.append({
            "fusion_name": fc.name,
            "stamp": stamp,
            "status": status,
            "proposed": exact[0] if len(exact) == 1 else None,
            "candidates": exact[:10] if len(exact) > 1 else [],
        })

    order = {"conflict": 0, "not_found": 1, "ambiguous": 2, "auto_match": 3, "ok": 4}
    rows.sort(key=lambda x: order.get(x["status"], 99))
    return rows


def _summary(rows: list) -> dict:
    s = dict(ok=0, auto_match=0, ambiguous=0, not_found=0, conflict=0, total=len(rows))
    for r in rows:
        if r["status"] in s:
            s[r["status"]] += 1
    return s


# ---------------------------------------------------------------------------
# Palette HTML event handler
# ---------------------------------------------------------------------------

class _PaletteHTMLHandler(adsk.core.HTMLEventHandler):
    def __init__(self, app, ui, handlers):
        super().__init__()
        self._app = app
        self._ui = ui
        self._handlers = handlers

    def _send(self, action: str, payload):
        global _palette
        if _palette:
            _palette.sendInfoToHTML(action, json.dumps(payload))

    def notify(self, args):
        try:
            ea = adsk.core.HTMLEventArgs.cast(args)
            action = ea.action
            data = json.loads(ea.data) if ea.data else {}

            if action in ("scan", "ready"):
                rows = _scan()
                self._send("scanDone", {"rows": rows, "summary": _summary(rows)})

            elif action == "apply":
                design = adsk.fusion.Design.cast(self._app.activeProduct)
                by_name = {c.name: c for c in design.allComponents}
                stamped = 0
                errors = []
                for row in data.get("rows", []):
                    fc = by_name.get(row.get("fusion_name"))
                    if fc and row.get("portal_id"):
                        try:
                            _set_stamp(fc, row["portal_id"], row.get("portal_pn", ""))
                            stamped += 1
                        except Exception as ex:
                            errors.append(f"{row['fusion_name']}: {ex}")
                    else:
                        errors.append(f"{row.get('fusion_name')}: not found in design")
                self._send("applyDone", {"stamped": stamped, "errors": errors})

            elif action == "search":
                query = data.get("query", "")
                r = call("listComponents", search=query)
                results = [
                    c for c in (r.get("components") or [])
                    if c.get("lifecycle_status") not in ("replaced", "inactive")
                ][:20]
                self._send("searchResults", {"fusion_name": data.get("fusion_name", ""), "results": results})

        except Exception:
            self._send("error", {"message": traceback.format_exc()})


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------

class _CreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self, app, ui, handlers):
        super().__init__()
        self._app = app
        self._ui = ui
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
            self._ui.messageBox("RushroomPIM BulkStamp error:\n" + traceback.format_exc())


class _ExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self, app, ui, handlers):
        super().__init__()
        self._app = app
        self._ui = ui
        self._handlers = handlers

    def notify(self, args):
        global _palette, _palette_handler
        try:
            palette = self._ui.palettes.itemById(PALETTE_ID)
            if palette:
                palette.isVisible = True
                # HTML is already loaded — tell it to re-scan
                palette.sendInfoToHTML("triggerScan", "{}")
            else:
                html_url = "file://" + _UI_HTML
                palette = self._ui.palettes.add(
                    PALETTE_ID, "Rushroom Bulk Stamp",
                    html_url, True, True, True, 1000, 660,
                )
                handler = _PaletteHTMLHandler(self._app, self._ui, self._handlers)
                palette.incomingFromHTML.add(handler)
                self._handlers.append(handler)
                _palette_handler = handler

            _palette = palette

        except Exception:
            self._ui.messageBox("BulkStamp failed:\n" + traceback.format_exc())


# ---------------------------------------------------------------------------
# Command registration
# ---------------------------------------------------------------------------

class BulkStampCommand:
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
            "Bulk Stamp",
            "Scan all design components and stamp them in one reviewed pass",
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
