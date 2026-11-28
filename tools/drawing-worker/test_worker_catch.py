#!/usr/bin/env python3
"""Features and catch modes of the drawing worker (docs/DRAWING_TEMPLATES.md §3.9, §10.3 item 13; phase 2).

    python3 tools/drawing-worker/test_worker_catch.py

Standard library only. No network, no portal: the portal is a recorder, the STEP is a file:// URL and catch.py is
a small fake that answers the contract's shapes. One test at the end runs the REAL catch.py of the drawset folder
on a real STEP with the drawing venv, and is skipped when either is missing.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import worker  # noqa: E402
from test_worker_sandbox import FakePortal  # noqa: E402

FAKE_CATCH = textwrap.dedent('''
    import hashlib, json, os, sys
    cmd, src = sys.argv[1], sys.argv[2]
    out = sys.argv[sys.argv.index("--out") + 1]
    code = int(os.environ.get("FAKE_CATCH_EXIT", "0"))
    if code:
        sys.stderr.write("catch: ValueError: broken input\\n")
        sys.exit(code)
    if cmd == "features":
        sha = os.environ.get("FAKE_CATCH_SHA") or hashlib.sha256(open(src, "rb").read()).hexdigest()
        res = {"features_format": 1, "sha256": sha,
               "features": {"holes": [{"axis": "Z", "D": 5.0}], "walls": [], "floors": [], "thickness_axis": "Z"}}
    else:
        inp = json.load(open(src, encoding="utf-8"))
        res = {"features_format": 1, "candidates": [], "mark": inp.get("mark"),
               "parts": [{"key": p["key"], "cad_sha256": p.get("cad_sha256"),
                          "status": "ok" if p.get("features") else "no_features", "rules": [], "holes": []}
                         for p in inp["parts"]]}
    open(out, "w", encoding="utf-8").write(json.dumps(res))
''')

CATCH_INPUT = {"base": {"datums": {"x": "min", "y": "min", "inside_face": "max"}}, "edges": {}, "rules": [
    {"id": "r_pinfront", "name": "Pin pairs, front", "at_least": 2,
     "select": [{"t": "dia", "D": 5}, {"t": "place", "edge": "front", "op": "at", "v": 37}]}],
    "parts": [{"key": "C1", "label": "Side Panel Left", "cad_sha256": "a" * 64, "features": {"holes": []}},
              {"key": "C2", "label": "Side Panel Right", "cad_sha256": None, "features": None}],
    "mark": None}


class LogCapture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines: list[str] = []

    def emit(self, record):
        self.lines.append(record.getMessage())


class TemplateModesTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="worker-catch-test-")
        self.drawset_dir = os.path.join(self.dir, "drawset")
        os.makedirs(self.drawset_dir)
        with open(os.path.join(self.drawset_dir, "catch.py"), "w", encoding="utf-8") as f:
            f.write(FAKE_CATCH)
        with open(os.path.join(self.drawset_dir, "drawset.py"), "w", encoding="utf-8") as f:
            f.write("raise SystemExit('a features or catch job must not run drawset')\n")
        self.step = os.path.join(self.dir, "part.step")
        with open(self.step, "wb") as f:
            f.write(b"ISO-10303-21; fake")
        self.step_sha = worker.sha256_of(self.step)
        self.cfg = dict(worker.DEFAULTS, drawset_dir=self.drawset_dir, python=sys.executable)
        self._saved = (worker.put_file, worker.tempfile.mkdtemp)
        self.puts: list[str] = []
        worker.put_file = lambda url, path, ct: self.puts.append(url)
        real_mkdtemp = self._saved[1]
        self.made: list[str] = []

        def mkdtemp(prefix=""):
            d = real_mkdtemp(prefix=prefix, dir=self.dir)
            self.made.append(d)
            return d
        worker.tempfile.mkdtemp = mkdtemp
        self.logs = LogCapture()
        worker.log.addHandler(self.logs)
        worker.log.setLevel(logging.DEBUG)

    def tearDown(self):
        worker.put_file, worker.tempfile.mkdtemp = self._saved
        worker.log.removeHandler(self.logs)
        for k in ("FAKE_CATCH_EXIT", "FAKE_CATCH_SHA"):
            os.environ.pop(k, None)
        shutil.rmtree(self.dir, ignore_errors=True)

    def features_job(self, **over) -> dict:
        j = {"id": "aaaaaaaa-2222-3333-4444-555555555555", "mode": "features", "template_item_id": "ITEMFEAT",
             "component_id": "COMP-1", "step_url": "file://" + self.step, "step_file_name": "part.step",
             "cad_sha256": self.step_sha}
        j.update(over)
        return j

    def catch_job(self, **over) -> dict:
        j = {"id": "bbbbbbbb-2222-3333-4444-555555555555", "mode": "catch", "template_item_id": "ITEMCATCH",
             "catch_input": CATCH_INPUT}
        j.update(over)
        return j

    def go(self, job: dict) -> FakePortal:
        p = FakePortal()
        worker.run_job(job, p, self.cfg)
        return p

    # ---- features ----------------------------------------------------------
    def test_features_steps_and_result(self):
        p = self.go(self.features_job())
        self.assertEqual(p.steps(), [("download", "running"), ("download", "passed"), ("render", "running"),
                                     ("render", "passed"), ("verify", "skipped"), ("upload", "skipped")])
        self.assertNotIn("docUploadUrl", p.actions())
        self.assertNotIn("drawingRenderUploadUrl", p.actions())
        self.assertEqual(self.puts, [])
        fin = p.finish()
        self.assertEqual(set(fin), {"job_id", "result"})
        r = fin["result"]
        self.assertEqual(r["mode"], "features")
        self.assertEqual(r["features_format"], 1)
        self.assertEqual(r["cad_sha256"], self.step_sha)
        self.assertEqual(r["features"]["holes"], [{"axis": "Z", "D": 5.0}])
        self.assertIn("drawset_version", r)
        self.assertEqual(set(r), {"mode", "features_format", "features", "cad_sha256", "drawset_version"})
        render = [k for a, k in p.calls if a == "reportDrawingRenderStep" and k["key"] == "render" and k["status"] == "passed"][0]
        self.assertIn("1 holes", render["detail"])
        self.assertFalse(os.path.exists(self.made[0]))      # the temp folder is removed once the portal took it

    def test_features_sha_mismatch_fails_at_download(self):
        p = self.go(self.features_job(cad_sha256="f" * 64))
        self.assertEqual(p.finish()["error"], "STEP sha differs from the registry")
        self.assertNotIn(("render", "running"), p.steps())

    def test_features_engine_reading_another_step_fails(self):
        os.environ["FAKE_CATCH_SHA"] = "0" * 64
        p = self.go(self.features_job())
        self.assertIn("sha differs from the download", p.finish()["error"])

    def test_features_needs_step_url_and_item(self):
        p = self.go(self.features_job(step_url=None))
        self.assertEqual(p.actions(), ["finishDrawingRender"])
        self.assertEqual(p.finish()["error"], "Features needs a step_url")
        p = self.go(self.features_job(template_item_id=None))
        self.assertEqual(p.finish()["error"], "Features needs a template_item_id")
        p = self.go(self.features_job(spec_patch=json.dumps({"ops": []})))
        self.assertEqual(p.finish()["error"], "Features takes no patch")

    def test_features_log_names_the_part(self):
        self.go(self.features_job())
        claimed = [l for l in self.logs.lines if "claimed" in l][0]
        self.assertIn("mode features · COMP-1 · template item ITEMFEAT · part.step", claimed)
        self.assertNotIn("?", claimed)

    # ---- catch -------------------------------------------------------------
    def test_catch_steps_and_result(self):
        p = self.go(self.catch_job())
        self.assertEqual(p.steps(), [("download", "skipped"), ("render", "running"), ("render", "passed"),
                                     ("verify", "skipped"), ("upload", "skipped")])
        self.assertEqual(self.puts, [])
        fin = p.finish()
        self.assertEqual(set(fin), {"job_id", "result"})
        r = fin["result"]
        self.assertEqual(set(r), {"mode", "catch", "drawset_version"})
        self.assertEqual(r["mode"], "catch")
        self.assertEqual([x["status"] for x in r["catch"]["parts"]], ["ok", "no_features"])
        render = [k for a, k in p.calls if a == "reportDrawingRenderStep" and k["key"] == "render" and k["status"] == "passed"][0]
        self.assertIn("1 no_features · 1 ok · 1 rule", render["detail"])
        claimed = [l for l in self.logs.lines if "claimed" in l][0]
        self.assertIn("mode catch · template item ITEMCATC · 2 parts · 1 rule", claimed)

    def test_catch_input_as_a_string_is_read(self):
        p = self.go(self.catch_job(catch_input=json.dumps(dict(CATCH_INPUT, mark={"key": "C1", "hole_id": "H12"}))))
        r = p.finish()["result"]
        self.assertEqual(r["catch"]["mark"], {"key": "C1", "hole_id": "H12"})

    def test_catch_needs_input(self):
        for bad, msg in ((None, "Catch needs a catch_input"), ("[1]", "Catch needs a catch_input"), ("{oops", "Catch input is not JSON")):
            p = self.go(self.catch_job(catch_input=bad))
            self.assertEqual(p.actions(), ["finishDrawingRender"])
            self.assertEqual(p.finish()["error"], msg)

    def test_catch_engine_error_finishes_with_error(self):
        os.environ["FAKE_CATCH_EXIT"] = "2"
        p = self.go(self.catch_job())
        err = p.finish()["error"]
        self.assertIn("catch.py exit 2", err)
        self.assertIn("broken input", err)
        self.assertIn(("render", "running"), p.steps())
        self.assertNotIn(("render", "passed"), p.steps())

    def test_missing_catch_py_names_it(self):
        os.remove(os.path.join(self.drawset_dir, "catch.py"))
        p = self.go(self.catch_job())
        self.assertIn("catch.py not found", p.finish()["error"])

    # ---- the claimed line on sandbox jobs (it printed "?" for the part) ----
    def test_sandbox_claim_line_names_the_part(self):
        line = worker.claim_line({"id": "cccccccc-1", "mode": "sandbox", "template_item_id": "ITEMSBOX", "spec": "flat_panel",
                                  "title_block": {"drawing_number": "SANDBOX", "issue": "S", "part_name": "Side Panel Left",
                                                  "cad_revision": "B"}}, "sandbox")
        self.assertEqual(line, "job cccccccc: claimed · mode sandbox · Side Panel Left · template item ITEMSBOX · spec flat_panel · from CAD Rev B")
        line = worker.claim_line({"id": "cccccccc-1", "template_item_id": "ITEMSBOX", "spec": "flat_panel", "component_id": "COMP-9",
                                  "title_block": {"drawing_number": "SANDBOX", "issue": "S"}}, "sandbox")
        self.assertIn("· COMP-9 ·", line)

    def test_issue_claim_line_unchanged(self):
        line = worker.claim_line({"id": "dddddddd-1", "spec": "flat_panel", "spec_patch": "{}",
                                  "title_block": {"drawing_number": "DRW-0001", "issue": "A", "part_number": "RR-202609-G26N4P8A",
                                                  "cad_revision": "B"}}, "issue")
        self.assertEqual(line, "job dddddddd: claimed · mode issue · DRW-0001 Issue A · RR-202609-G26N4P8A · spec flat_panel + patch · from CAD Rev B")


VENV = worker.DEFAULTS["python"]
DRAWSET = worker.DEFAULTS["drawset_dir"]
REAL_STEP = os.path.join(DRAWSET, "step", "VALCYRA_RevB_Side_Panel_Left_RR-202609-G26N4P8A.step")


@unittest.skipUnless(os.path.exists(VENV) and os.path.exists(os.path.join(DRAWSET, "catch.py")) and os.path.exists(REAL_STEP),
                     "drawing venv, catch.py or the Rev B STEP is not on this machine")
class RealEngineTest(unittest.TestCase):
    """features then catch through the worker with the real catch.py: the features the worker posts are what the
    catch reads, and the seed's Pin pairs take 8 on Side Panel Left Rev B."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="worker-catch-real-")
        self.cfg = dict(worker.DEFAULTS, drawset_dir=DRAWSET, python=VENV)
        self._mk = worker.tempfile.mkdtemp
        real = self._mk
        worker.tempfile.mkdtemp = lambda prefix="": real(prefix=prefix, dir=self.dir)

    def tearDown(self):
        worker.tempfile.mkdtemp = self._mk
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_features_then_catch(self):
        sha = worker.sha256_of(REAL_STEP)
        p = FakePortal()
        worker.run_job({"id": "eeeeeeee-1", "mode": "features", "template_item_id": "I1", "component_id": "C-LEFT",
                        "step_url": "file://" + REAL_STEP, "step_file_name": os.path.basename(REAL_STEP), "cad_sha256": sha}, p, self.cfg)
        r = p.finish()["result"]
        self.assertEqual(r["cad_sha256"], sha)
        self.assertEqual(len(r["features"]["holes"]), 53)
        ci = {"base": {"datums": {"x": "min", "y": "min", "inside_face": "max"}}, "edges": {},
              "rules": CATCH_INPUT["rules"], "mark": {"key": "C-LEFT", "hole_id": "H22"},
              "parts": [{"key": "C-LEFT", "label": "Side Panel Left", "cad_sha256": sha, "features": r["features"]}]}
        p2 = FakePortal()
        worker.run_job({"id": "ffffffff-1", "mode": "catch", "template_item_id": "I2", "catch_input": ci}, p2, self.cfg)
        out = p2.finish()["result"]["catch"]
        part = out["parts"][0]
        self.assertEqual(part["status"], "ok")
        self.assertEqual(part["edges"]["reads"]["inside"], "most blind holes · 48 / 0")
        self.assertEqual(len(part["rules"][0]["taken"]), 8)
        self.assertEqual(out["mark"]["hole"]["id"], "H22")
        self.assertTrue(1 <= len(out["candidates"]) <= 6)


if __name__ == "__main__":
    unittest.main(verbosity=2)
