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
from lib.pending_stamps import merge as merge_pending, load as load_pending, count as pending_count
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
    """
    Normalise a Fusion component name or portal component name to a
    comparable form for matching.

    Steps:
      1. Strip Fusion occurrence suffix  :N
      2. Strip version suffix            _vN / _v9.1 / _V9
      3. Normalise separators (_  -) → space
      4. Collapse whitespace, lowercase
    """
    n = re.sub(r':\d+$', '', name)
    n = re.sub(r'[_\s\-]+v\d+(\.\d+)*$', '', n, flags=re.IGNORECASE)
    n = re.sub(r'[_\-]', ' ', n)
    n = re.sub(r'\s+', ' ', n)
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
                "clean_name": fc_clean,
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
            "clean_name": fc_clean,
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


def _scan_project_files() -> tuple:
    """
    Return portal components annotated with their queue status.

    No Fusion data-panel walk — the portal is the source of truth.
    The queue key is the cleaned portal component name, which must match
    the cleaned filename when a .f3d file is opened (same _clean() logic).
    """
    _EXCLUDE_TYPES = {"finished_good", "product_family", "phantom_assembly", "sub_assembly"}

    r = call("listComponents")
    cat_r = call("listPartCategories")

    portal_comps = [
        c for c in (r.get("components") or [])
        if c.get("lifecycle_status") not in ("replaced", "inactive")
        and c.get("type") not in _EXCLUDE_TYPES
        and not c.get("has_children")
    ]

    categories = cat_r.get("categories") or []
    cat_by_id = {cat["id"]: cat["name"] for cat in categories}

    pending = load_pending()
    rows = []

    for pc in portal_comps:
        pc_name = pc.get("name") or ""
        pc_clean = _clean(pc_name)
        pc_pn = pc.get("part_number") or ""
        cat_id = pc.get("category_id") or None
        cat_name = cat_by_id.get(cat_id, "") if cat_id else ""

        status = "queued" if pc_clean in pending else "auto_match"

        rows.append({
            "fusion_name": pc_clean,
            "clean_name": pc_clean,
            "portal_name": pc_name,
            "category_id": cat_id,
            "category_name": cat_name,
            "stamp": {"pim_component_id": pc["id"], "pim_part_number": pc_pn},
            "status": status,
            "proposed": pc,
            "candidates": [],
        })

    rows.sort(key=lambda x: (x.get("category_name") or "zzz", x["fusion_name"]))
    return rows, False, categories


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

            elif action == "scanProject":
                rows, timed_out, categories = _scan_project_files()
                self._send("projectScanDone", {
                    "rows": rows,
                    "summary": _summary(rows),
                    "pending": pending_count(),
                    "timed_out": timed_out,
                    "categories": categories,
                })

            elif action == "queueStamps":
                entries = {}
                for row in data.get("rows", []):
                    key = _clean(row.get("fusion_name", ""))
                    if key and row.get("portal_id"):
                        entries[key] = {
                            "portal_id": row["portal_id"],
                            "portal_pn": row.get("portal_pn", ""),
                            "portal_name": row.get("portal_name", ""),
                        }
                total = merge_pending(entries)
                self._send("queueDone", {"queued": len(entries), "total": total})

            elif action == "getPending":
                self._send("pendingCount", {"count": pending_count()})

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
            # Always delete and recreate so the HTML file is freshly loaded.
            existing = self._ui.palettes.itemById(PALETTE_ID)
            if existing:
                try:
                    existing.deleteMe()
                except Exception:
                    pass

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
