"""
Poller for the CAD change-order test agent (docs/TEST_AGENT.md).

A daemon thread wakes every 5 s and, while the add-in holds a valid portal
token, fires the custom event RushroomPIM_TestAgentPoll. Fusion delivers the
event on the main thread, where the handler asks the portal for a waiting run
(pollCadTestRun) and executes it (lib/test_agent.run_test).

The thread itself never touches the Fusion API — app.fireCustomEvent is the
one call a background thread may make. Everything that reads a document or
calls the portal happens in the handler.

Failures are written to debug.log through the log callable passed to start();
the poller never opens a dialog, since it runs while the engineer is working.
"""
from __future__ import annotations
import platform
import threading
import time
import traceback

import adsk.core

from .auth import get_token, load_config
from .portal import call
from .test_agent import run_test

EVENT_ID = "RushroomPIM_TestAgentPoll"
POLL_S = 5

_handlers = []        # handler + event kept alive here; Fusion holds no reference
_thread = None
_stop = threading.Event()
_log = None
busy = False          # re-entrancy guard: one run at a time on the main thread


def _noop(_msg):
    pass


def agent_name(app) -> str:
    """"Mathias · Fusion 2.0.x · MacBook" — what the portal stores as claimed_by."""
    cfg = load_config()
    who = cfg.get("name") or cfg.get("email") or "Fusion add-in"
    try:
        version = app.version
    except Exception:
        version = "?"
    return "%s · Fusion %s · %s" % (who, version, platform.node())


def poll_once(app, log=None):
    """Ask the portal for a waiting run and execute it. Main thread only.
    Returns the run_test result (the finished run, or {"error"}), None when
    nothing was waiting, or {"busy": True} while another run is executing."""
    global busy
    log = log or _log or _noop
    if busy:
        return {"busy": True}
    busy = True
    try:
        r = call("pollCadTestRun", agent=agent_name(app))
        run = r.get("run") if isinstance(r, dict) else None
        if not run:
            return None
        log("test agent: claimed run %s for %s" % (
            str(run.get("id", ""))[:8], (run.get("before") or {}).get("part_number", "?")))
        return run_test(run, log)
    finally:
        busy = False


class _PollHandler(adsk.core.CustomEventHandler):
    def __init__(self, app, log):
        super().__init__()
        self._app = app
        self._log = log

    def notify(self, args):
        try:
            if not get_token():
                return
            # Never while the engineer is inside a command (Send to portal, a
            # sketch, Import project): opening and saving documents would tear
            # the dialog down. The claim window is 120 s; the next tick is 5 s.
            if self._app.userInterface.activeCommand != "SelectCommand":
                return
            poll_once(self._app, self._log)
        except Exception:
            self._log("test agent poll failed:\n" + traceback.format_exc())


def _loop(app):
    while not _stop.is_set():
        try:
            if get_token():
                app.fireCustomEvent(EVENT_ID, "")
        except Exception:
            # Logging is file I/O, safe from any thread.
            (_log or _noop)("test agent thread: fireCustomEvent failed:\n" + traceback.format_exc())
        _stop.wait(POLL_S)


def start(app, log=None):
    """Register the custom event and start the 5 s thread. Idempotent."""
    global _thread, _log
    _log = log or _noop
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    try:
        app.unregisterCustomEvent(EVENT_ID)
    except Exception:
        pass
    event = app.registerCustomEvent(EVENT_ID)
    handler = _PollHandler(app, _log)
    event.add(handler)
    _handlers.extend([event, handler])
    _thread = threading.Thread(target=_loop, args=(app,), name="RushroomPIM-test-agent", daemon=True)
    _thread.start()
    _log("test agent poller started (every %d s)" % POLL_S)


def stop(app):
    """Stop the thread and unregister the event."""
    global _thread
    _stop.set()
    t = _thread
    _thread = None
    if t is not None:
        try:
            t.join(timeout=2)
        except Exception:
            pass
    try:
        app.unregisterCustomEvent(EVENT_ID)
    except Exception:
        pass
    _handlers.clear()
