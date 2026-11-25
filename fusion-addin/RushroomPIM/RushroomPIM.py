"""
RushroomPIM Fusion add-in — Phase 3.1 of the identity programme.

Three commands, added to the Utilities workspace:
  Connect to Portal  — authenticates once per 8-hour session
  Stamp This Component  — searches the portal and writes pim_component_id +
                          pim_part_number attributes on the active component,
                          then registers this Fusion document as the CAD source
  Send to portal     — exports .f3z / .step / .glb, uploads via signed URL,
                       and registers them on a revision in the portal registry
  Import project to portal — the same for every part document of the active
                       project in one pass, matched by the part number that
                       leads the document name (lib/project_import.py)
  Run portal test agent now — polls the portal once for a waiting CAD test
                       run and executes it (docs/TEST_AGENT.md). The same
                       runs happen unattended: lib/test_agent_poller polls
                       every 5 s while connected.

Install:
  Mac:  ~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/
  Win:  %APPDATA%\\Autodesk\\Autodesk Fusion 360\\API\\AddIns\\
  Copy the entire RushroomPIM/ folder into AddIns, then enable in
  Tools → Add-ins → Scripts and Add-ins → My Add-ins tab.
"""
import adsk.core
import adsk.fusion
import os
import sys
import traceback

_app = None
_ui = None
_commands = []
_handlers = []  # keep handlers alive so the GC doesn't destroy them

ADDIN_DIR = os.path.dirname(os.path.abspath(__file__))
_DEBUG_LOG = os.path.join(ADDIN_DIR, "debug.log")


def _log(msg):
    try:
        with open(_DEBUG_LOG, "a", encoding="utf-8") as _f:
            _f.write(msg + "\n")
    except Exception:
        pass


class _DocumentOpenedHandler(adsk.core.DocumentEventHandler):
    """Auto-applies a pending stamp when a queued file is opened."""
    def __init__(self, ui):
        super().__init__()
        self._ui = ui

    def notify(self, args):
        try:
            import re
            from lib.pending_stamps import consume
            from lib.exports import ATTR_GROUP, ATTR_COMPONENT_ID, ATTR_PART_NUMBER
            from lib.portal import call

            doc = args.document
            if not doc or not doc.isValid:
                return

            # Match document name against the pending queue.
            # Must use the same normalisation as _clean() in bulk_stamp_cmd.py:
            # strip occurrence :N, strip version _vN, normalise _/- → space.
            raw = doc.name
            clean = re.sub(r':\d+$', '', raw)
            clean = re.sub(r'[_\s\-]+v\d+(\.\d+)*$', '', clean, flags=re.IGNORECASE)
            clean = re.sub(r'[_\-]', ' ', clean)
            clean = re.sub(r'\s+', ' ', clean).strip().lower()

            entry = consume(clean)
            if not entry:
                return

            # Safety check: the document name must contain the portal part number.
            # This prevents a name-match false positive from stamping the wrong
            # root component when unrelated files happen to clean to the same string.
            portal_pn = entry.get("portal_pn") or ""
            if portal_pn and portal_pn not in raw:
                # Put the entry back — it wasn't this file.
                from lib.pending_stamps import merge as _merge
                _merge({clean: entry})
                _log(f"auto-stamp skipped for {raw}: part# {portal_pn} not in filename")
                return

            design = adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))
            if not design:
                return

            root = design.rootComponent
            root.attributes.add(ATTR_GROUP, ATTR_COMPONENT_ID, entry["portal_id"])
            root.attributes.add(ATTR_GROUP, ATTR_PART_NUMBER, entry["portal_pn"])
            _log(f"auto-stamped {raw} → {entry['portal_pn']}")

            # Register the Fusion document link in the portal (non-fatal if offline/fails).
            try:
                fusion_doc_id = None
                fusion_proj_id = None
                df = doc.dataFile
                if df:
                    fusion_doc_id = df.id
                    try:
                        fusion_proj_id = df.parentFolder.parentProject.id
                    except Exception:
                        pass
                call(
                    "linkCadDocument",
                    component_id=entry["portal_id"],
                    fusion_document_id=fusion_doc_id,
                    fusion_document_name=raw,
                    fusion_project_id=fusion_proj_id,
                )
                _log(f"portal link registered for {raw}")
            except Exception:
                _log("portal linkCadDocument failed (non-fatal):\n" + traceback.format_exc())

        except Exception:
            _log("DocumentOpened handler error:\n" + traceback.format_exc())


def run(context):
    global _app, _ui, _commands, _handlers
    _log("=== run() called ===")
    _log("Python: " + sys.version)
    _log("ADDIN_DIR: " + ADDIN_DIR)
    if ADDIN_DIR not in sys.path:
        sys.path.insert(0, ADDIN_DIR)
    # Purge cached modules so toggling the add-in always loads fresh code from disk.
    _own = ("commands.", "lib.")
    for _k in [k for k in sys.modules if any(k.startswith(p) for p in _own)]:
        del sys.modules[_k]
    try:
        _app = adsk.core.Application.get()
        _ui = _app.userInterface

        # Imports are inside run() so any ImportError surfaces via messageBox
        from commands.connect_cmd import ConnectCommand
        from commands.stamp_cmd import StampCommand
        from commands.release_cmd import ReleaseCommand
        from commands.bulk_stamp_cmd import BulkStampCommand
        from commands.bulk_release_cmd import BulkReleaseCommand
        from commands.import_project_cmd import ImportProjectCommand
        from commands.test_agent_cmd import TestAgentCommand
        from lib import test_agent_poller
        _log("imports OK")

        for Cmd in [ConnectCommand, StampCommand, ReleaseCommand, BulkStampCommand, BulkReleaseCommand, ImportProjectCommand]:
            cmd = Cmd(_app, _ui, _handlers)
            cmd.register()
            _commands.append(cmd)
        cmd = TestAgentCommand(_app, _ui, _handlers, _log)
        cmd.register()
        _commands.append(cmd)
        _log("commands registered OK")

        # Test agent: poll the portal every 5 s while connected (docs/TEST_AGENT.md)
        test_agent_poller.start(_app, _log)
        _log("test agent poller registered")

        # Auto-stamp queued files on open
        on_doc_opened = _DocumentOpenedHandler(_ui)
        _app.documentOpened.add(on_doc_opened)
        _handlers.append(on_doc_opened)
        _log("documentOpened handler registered")

    except Exception:
        tb = traceback.format_exc()
        _log("FAILED:\n" + tb)
        if _ui:
            _ui.messageBox("RushroomPIM failed to start:\n" + tb)


def stop(context):
    global _commands, _handlers
    try:
        from lib import test_agent_poller
        test_agent_poller.stop(_app or adsk.core.Application.get())
    except Exception:
        _log("test agent poller stop failed:\n" + traceback.format_exc())
    for cmd in _commands:
        try:
            cmd.unregister()
        except Exception:
            pass
    _commands.clear()
    _handlers.clear()
