"""
CAD change-order test agent — the Fusion half (docs/TEST_AGENT.md).

The portal requests a run on one part; this module executes the Fusion-side
steps in the contract's fixed order and reports each one as it happens:

  open    the part document by its lineage urn, unmodified, named as the
          portal knows it
  change  replace the "PIM test agent" sketch (one line on the root XY plane)
  save    one new Fusion version, exactly one
  stamp   the root already carries pim_component_id == component_id (checked,
          never written here: a missing stamp is a finding)
  export  STEP named from the hub document name
  send    cadUploadUrl + upload + registerCadRevision; the answer goes to the
          portal as the `send` record so it can judge naming and versioning

Steps 8–12 (naming, versioning, status, supplier, changelog) are the portal's;
finishCadTestRun triggers them. A failure here marks the step failed, the rest
skipped, and still calls finishCadTestRun so the run closes. run_test never
raises — the poller runs it from a custom-event handler on the main thread
and a stray exception there would take the add-in down with it.

The step bodies mirror lib/project_import.import_file: same open/stamp/export/
send calls, same waits, same "close only what we opened".
"""
from __future__ import annotations
import os
import re
import time
import traceback

import adsk.core
import adsk.fusion

from .exports import (
    cleanup_tmpdir, export_formats, get_stamp, parse_revision_label, safe_file_stem,
)
from .portal import call, sha256_of, upload_file

FUSION_STEPS = ("open", "change", "save", "stamp", "export", "send")
SKETCH_NAME = "PIM test agent"
SAVE_WAIT_S = 90
PART_NUMBER = re.compile(r"^(RR-\d{6}-[A-Z0-9]{8})\b")


class StepFailed(Exception):
    """Raised inside a step body with the detail the portal should show."""


class RunClosed(Exception):
    """The portal no longer has this run as running (timed out, cancelled,
    deleted): nothing more may be saved or sent on its behalf."""


class ReportLost(Exception):
    """reportCadTestStep failed three times for a reason other than a closed run."""


_CLOSED = ("not running", "not found", "no longer running")


def _noop(_msg):
    pass


def _find_open(app, df):
    for i in range(app.documents.count):
        d = app.documents.item(i)
        if d.dataFile and d.dataFile.id == df.id:
            return d
    return None


def _wait_version(doc, v0: int, seconds: int = SAVE_WAIT_S) -> int:
    """doc.save() on a cloud document returns before the version exists; poll
    the DataFile until its versionNumber moves, at most `seconds`."""
    t0 = time.time()
    while time.time() - t0 < seconds:
        adsk.doEvents()
        time.sleep(1)
        if doc.dataFile.versionNumber > v0:
            break
    return doc.dataFile.versionNumber


def _run_field(run: dict, key: str):
    """A run field, read from the row first and from its `before` snapshot
    second — fusion_document_id / fusion_document_name / part_number live in
    the snapshot, component_id / cad_model_id on the row."""
    if run.get(key) not in (None, ""):
        return run.get(key)
    before = run.get("before") or {}
    return before.get(key)


def run_test(run: dict, log=None) -> dict:
    """Execute the Fusion steps of one requested run and close it with
    finishCadTestRun. Returns the finish response, or {"error": ...}."""
    log = log or _noop
    run_id = run.get("id") or ""
    app = adsk.core.Application.get()

    def report(key, status, detail=None, data=None):
        kwargs = {"run_id": run_id, "key": key, "status": status}
        if detail is not None:
            kwargs["detail"] = str(detail)[:500]
        if data is not None:
            kwargs["data"] = data
        # A report that does not land is a run the portal cannot judge: retry
        # twice, then raise ReportLost so the step is marked failed here rather
        # than "not reported by the add-in" with the real cause hidden.
        last = None
        for attempt in range(3):
            try:
                call("reportCadTestStep", **kwargs)
                return
            except Exception as exc:
                last = exc
                log("test agent: reportCadTestStep %s/%s failed (%d): %s" % (key, status, attempt + 1, exc))
                if any(m in str(exc).lower() for m in _CLOSED):
                    raise RunClosed(str(exc))
                time.sleep(2)
        raise ReportLost("could not report step %s/%s: %s" % (key, status, last))

    # Shared state between steps.
    st = {"doc": None, "df": None, "root": None, "opened_here": False,
          "tmpdir": None, "step_path": None, "sha256": None, "file_name": None}
    component_id = _run_field(run, "component_id")
    cad_model_id = _run_field(run, "cad_model_id")
    fusion_document_id = _run_field(run, "fusion_document_id")
    fusion_document_name = _run_field(run, "fusion_document_name")
    part_number = _run_field(run, "part_number")

    # ---- step bodies: return the passed detail or raise StepFailed -------
    def step_open():
        if not fusion_document_id:
            raise StepFailed("run carries no fusion_document_id")
        df = app.data.findFileById(fusion_document_id)
        if df is None:
            raise StepFailed("DataFile not found for %s" % fusion_document_id)
        doc = _find_open(app, df)
        how = "already open"
        if doc is None:
            doc = app.documents.open(df, True)
            st["opened_here"] = True
            how = "opened"
        else:
            # export_formats reads app.activeProduct: the test document must be
            # the active one, or the STEP would come from whatever the engineer
            # has in front.
            doc.activate()
        st["doc"], st["df"] = doc, df
        if doc.isModified:
            raise StepFailed("document '%s' has unsaved changes" % df.name)
        if df.name != fusion_document_name:
            raise StepFailed("hub name '%s' != portal name '%s'" % (df.name, fusion_document_name))
        design = adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))
        if not design:
            raise StepFailed("document has no design product")
        st["root"] = design.rootComponent
        return "'%s' %s, v%s" % (df.name, how, df.versionNumber)

    def step_change():
        root = st["root"]
        removed = 0
        # Collect first: deleting while iterating a Fusion collection skips items.
        old = [root.sketches.item(i) for i in range(root.sketches.count)]
        for sk in old:
            if (sk.name or "").startswith(SKETCH_NAME):
                if sk.deleteMe():
                    removed += 1
        sketch = root.sketches.add(root.xYConstructionPlane)
        sketch.name = SKETCH_NAME
        sketch.sketchCurves.sketchLines.addByTwoPoints(
            adsk.core.Point3D.create(0, 0, 0), adsk.core.Point3D.create(1, 0, 0))
        return "sketch '%s' %s" % (SKETCH_NAME, "replaced" if removed else "added")

    def step_save():
        doc, df = st["doc"], st["df"]
        v0 = df.versionNumber
        if not doc.save("Test agent run %s" % run_id[:8]):
            raise StepFailed("Fusion refused the save (read-only or locked document?)")
        v1 = _wait_version(doc, v0)
        st["df"] = doc.dataFile
        if v1 <= v0:
            raise StepFailed("version did not increase within %d s (still v%s)" % (SAVE_WAIT_S, v0))
        if v1 > v0 + 1:
            raise StepFailed("v%s → v%s: more than one version" % (v0, v1))
        # The portal's versioning verdict reads these numbers from the step.
        return "v%s → v%s" % (v0, v1), {"version_before": v0, "version_after": v1}

    def step_stamp():
        root, doc = st["root"], st["doc"]
        have = (get_stamp(root).get("pim_component_id") or "").strip()
        if have == component_id:
            return "already stamped"
        if have:
            raise StepFailed("stamped with a different component id %s" % have)
        # The run checks the stamp, it does not create it: stamping here would
        # save a second version and hide a part that was never stamped.
        raise StepFailed("root is not stamped — run Stamp This Component or Import project first")

    def step_export():
        root, df = st["root"], st["df"]
        exported, tmpdir = export_formats(root, ["step"], file_stem=df.name)
        st["tmpdir"] = tmpdir
        path = exported.get("step")
        if not path:
            raise StepFailed("STEP export returned nothing")
        t0 = time.time()
        while time.time() - t0 < SAVE_WAIT_S and not (os.path.exists(path) and os.path.getsize(path) > 0):
            adsk.doEvents()
            time.sleep(1)
        if not (os.path.exists(path) and os.path.getsize(path) > 0):
            raise StepFailed("STEP file never appeared: %s" % os.path.basename(path))
        file_name = os.path.basename(path)
        expected = safe_file_stem(df.name) + ".step"
        if file_name != expected:
            raise StepFailed("file named '%s', expected '%s'" % (file_name, expected))
        st["step_path"], st["file_name"] = path, file_name
        st["sha256"] = sha256_of(path)
        return file_name

    def step_send():
        df, path, file_name = st["df"], st["step_path"], st["file_name"]
        if not cad_model_id:
            raise StepFailed("run carries no cad_model_id")
        parsed = parse_revision_label(df.name)
        label = parsed[0] if parsed else None
        fusion_version = df.versionNumber
        url_r = call("cadUploadUrl", fileName=file_name)
        upload_file(url_r["signedUrl"], path)
        reg = call("registerCadRevision", cad_model_id=cad_model_id, format="step",
                   storage_path=url_r["path"], file_name=file_name, revision=None,
                   fusion_revision_label=label, fusion_version=fusion_version,
                   sha256=st["sha256"])
        data = {
            "revision": reg.get("revision"),
            "revision_id": reg.get("revision_id"),
            "file_id": reg.get("id"),
            "replaced": bool(reg.get("replaced")),
            "created": bool(reg.get("created")),
            "sha256": st["sha256"],
            "file_name": file_name,
            "fusion_version": fusion_version,
        }
        detail = "Rev %s %s, v%s" % (
            data["revision"], "replaced" if data["replaced"] else "created", fusion_version)
        return detail, data

    bodies = {"open": step_open, "change": step_change, "save": step_save,
              "stamp": step_stamp, "export": step_export, "send": step_send}

    # ---- drive --------------------------------------------------------------
    failed_at = None
    try:
        for i, key in enumerate(FUSION_STEPS):
            try:
                report(key, "running")
            except RunClosed as exc:
                log("test agent %s: portal closed the run before %s: %s" % (run_id[:8], key, exc))
                return {"error": str(exc), "failed_step": key, "closed": True}
            except ReportLost as exc:
                # No contact with the portal: do not change the document on
                # behalf of a run nobody is recording.
                log("test agent %s: %s — %s" % (run_id[:8], key, exc))
                failed_at = key
                break
            # Run the body first; report afterwards, outside the handlers, so a
            # RunClosed from the report is caught by the one except below and
            # never escapes run_test.
            outcome = None     # ("passed", detail, data) | ("failed", detail, None)
            try:
                out = bodies[key]()
                detail, data = (out if isinstance(out, tuple) else (out, None))
                outcome = ("passed", detail, data)
            except StepFailed as exc:
                outcome = ("failed", str(exc), None)
            except Exception:
                tb = traceback.format_exc()
                log("test agent %s: %s raised\n%s" % (run_id[:8], key, tb))
                outcome = ("failed", tb.strip().splitlines()[-1][:300], None)
            try:
                status, detail, data = outcome
                if status == "passed":
                    report(key, "passed", detail, data)
                    log("test agent %s: %s passed — %s" % (run_id[:8], key, detail))
                else:
                    failed_at = key
                    report(key, "failed", detail)
                    log("test agent %s: %s FAILED — %s" % (run_id[:8], key, detail))
            except RunClosed as exc:
                log("test agent %s: portal closed the run at %s: %s" % (run_id[:8], key, exc))
                return {"error": str(exc), "failed_step": key, "closed": True}
            except ReportLost as exc:
                # The portal never heard of this step: fail it here (one more
                # try with the real cause) and stop, nothing more is sent.
                failed_at = key
                log("test agent %s: %s — %s" % (run_id[:8], key, exc))
                try:
                    report(key, "failed", str(exc)[:300])
                except (RunClosed, ReportLost):
                    pass
            if failed_at:
                try:
                    for rest in FUSION_STEPS[i + 1:]:
                        report(rest, "skipped")
                except (RunClosed, ReportLost):
                    pass
                break
    finally:
        if st["tmpdir"]:
            cleanup_tmpdir(st["tmpdir"])
        doc = st["doc"]
        if doc is not None and st["opened_here"]:
            # This run opened it, so nothing of the engineer's is in it: close
            # it even when a step left the test sketch unsaved, or every later
            # run on this part fails at open with "unsaved changes".
            try:
                doc.close(False)
            except Exception:
                pass

    try:
        return call("finishCadTestRun", run_id=run_id)
    except Exception as exc:
        log("test agent %s: finishCadTestRun failed: %s" % (run_id[:8], exc))
        return {"error": str(exc), "failed_step": failed_at}
