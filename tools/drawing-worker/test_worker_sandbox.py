#!/usr/bin/env python3
"""Sandbox mode of the drawing worker (docs/DRAWING_TEMPLATES.md §4, phase 1).

    python3 tools/drawing-worker/test_worker_sandbox.py

Standard library only. No network, no portal, no real drawset: the portal is a
recorder, the STEP is a file:// URL, the YAML writer is json.dumps and drawset
is a small script that writes a PDF, a PNG, the sidecars and a DRAWSET_SUMMARY
line, then exits with FAKE_DRAWSET_EXIT (0 or 3).
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import worker  # noqa: E402

FAKE_DRAWSET = textwrap.dedent('''
    import hashlib, json, os, sys
    spec_path = sys.argv[1]
    out = sys.argv[sys.argv.index("--out") + 1]
    png = sys.argv[sys.argv.index("--png") + 1]
    spec = json.load(open(spec_path, encoding="utf-8"))   # the test writes the temp spec as JSON
    step = spec["parts"][0]["step"]
    sha = hashlib.sha256(open(step, "rb").read()).hexdigest()
    name = spec["set_name"]
    code = int(os.environ.get("FAKE_DRAWSET_EXIT", "0"))
    pdf = os.path.join(out, "VALCYRA_Rev%s_%s.pdf" % (spec["issue"], name))
    open(pdf, "wb").write(b"%PDF-1.4 /Type /Page /Type /Page")
    json.dump({"dimension_list_sha256": "d" * 64, "geometry_sha256": "g" * 64,
               "steps": [{"sha256": sha, "product_id": "P"}]}, open(pdf + ".sources.json", "w"))
    json.dump([], open(os.path.join(out, "%s_dimensions.json" % name), "w"))
    json.dump([], open(os.path.join(out, "%s_entities.json" % name), "w"))
    open(os.path.join(png, "%s_s1.png" % name), "wb").write(b"PNG")
    ok = code == 0
    summary = {"pass": ok, "regression": "OK" if ok else "FAIL",
               "round_trip": {"n": 10, "mismatches": 0 if ok else 2}, "completeness_missing": [], "wall_flags": []}
    print("PDF: " + pdf)
    print("DRAWSET_SUMMARY " + json.dumps(summary, sort_keys=True))
    sys.exit(code)
''')

SPEC_BODY = json.dumps({"template": "flat_panel", "sheets": [{"views": ["front"]}]}, sort_keys=True, separators=(",", ":"))


class FakePortal:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    def call(self, action: str, **kwargs) -> dict:
        self.calls.append((action, kwargs))
        if action == "drawingRenderUploadUrl":
            return {"signedUrl": "https://example.invalid/put", "path":
                    "drawing-templates/items/ITEM/renders/%s/%s" % (kwargs["job_id"], kwargs["file_name"])}
        if action == "docUploadUrl":
            return {"signedUrl": "https://example.invalid/doc", "path": "docs/x.pdf"}
        if action == "finishDrawingRender":
            return {"job": {"status": "done"}} if "error" not in kwargs else {"job": {"status": "failed"}}
        return {}

    def actions(self) -> list[str]:
        return [a for a, _ in self.calls]

    def steps(self) -> list[tuple[str, str]]:
        return [(k["key"], k["status"]) for a, k in self.calls if a == "reportDrawingRenderStep"]

    def finish(self) -> dict:
        return [k for a, k in self.calls if a == "finishDrawingRender"][-1]


class SandboxTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="worker-sandbox-test-")
        self.drawset_dir = os.path.join(self.dir, "drawset")
        os.makedirs(self.drawset_dir)
        with open(os.path.join(self.drawset_dir, "drawset.py"), "w", encoding="utf-8") as f:
            f.write(FAKE_DRAWSET)
        self.step = os.path.join(self.dir, "part.step")
        with open(self.step, "wb") as f:
            f.write(b"ISO-10303-21; fake")
        self.step_sha = worker.sha256_of(self.step)
        self.cfg = dict(worker.DEFAULTS, drawset_dir=self.drawset_dir, python=sys.executable)
        self._saved = (worker.dump_yaml, worker.put_file, worker.tempfile.mkdtemp)
        self.puts: list[str] = []
        worker.dump_yaml = lambda data, cfg: json.dumps(data, default=str)
        worker.put_file = lambda url, path, ct: self.puts.append(url)
        made = []
        real_mkdtemp = self._saved[2]   # worker.tempfile is this module's tempfile: keep the real one

        def mkdtemp(prefix=""):
            d = real_mkdtemp(prefix=prefix, dir=self.dir)
            made.append(d)
            return d
        worker.tempfile.mkdtemp = mkdtemp
        self.made = made

    def tearDown(self):
        worker.dump_yaml, worker.put_file, worker.tempfile.mkdtemp = self._saved
        os.environ.pop("FAKE_DRAWSET_EXIT", None)
        shutil.rmtree(self.dir, ignore_errors=True)

    def job(self, **over) -> dict:
        j = {"id": "11111111-2222-3333-4444-555555555555", "mode": "sandbox", "template_item_id": "ITEM",
             "spec": "flat_panel", "spec_body": SPEC_BODY, "spec_body_sha256": worker.sha256_text(SPEC_BODY),
             "spec_patch": None, "title_block": {"drawing_number": "SANDBOX", "issue": "S", "title": "Side Panel Left"},
             "step_url": "file://" + self.step, "step_file_name": "part.step", "cad_sha256": self.step_sha,
             "drawing_id": None, "issue": None}
        j.update(over)
        return j

    def run_sandbox(self, code: int, **over) -> FakePortal:
        os.environ["FAKE_DRAWSET_EXIT"] = str(code)
        portal = FakePortal()
        worker.run_job(self.job(**over), portal, self.cfg)
        return portal

    def test_pass_uploads_sandbox_pdf_and_never_doc_upload(self):
        p = self.run_sandbox(0)
        self.assertNotIn("docUploadUrl", p.actions())
        self.assertEqual(p.steps(), [("download", "running"), ("download", "passed"), ("render", "running"),
                                     ("render", "passed"), ("verify", "running"), ("verify", "passed"),
                                     ("upload", "running"), ("upload", "passed")])
        names = [k["file_name"] for a, k in p.calls if a == "drawingRenderUploadUrl"]
        self.assertEqual(names[0], "sandbox.pdf")
        self.assertIn("dimensions.json", names)
        self.assertIn("entities.json", names)
        fin = p.finish()
        self.assertNotIn("error", fin)
        self.assertEqual(fin["file_name"], "sandbox.pdf")
        self.assertEqual(fin["storage_path"], fin["result"]["artifacts"]["pdf"])
        self.assertTrue(fin["storage_path"].endswith("/sandbox.pdf"))
        r = fin["result"]
        self.assertIs(r["verify_ok"], True)
        for k in ("pages", "dimension_list_sha256", "spec_sha256", "drawset_version", "verify_ok", "verify",
                  "artifacts", "source_sha256"):
            self.assertIn(k, r)
        self.assertEqual(r["spec_sha256"], worker.sha256_text(SPEC_BODY))
        self.assertEqual(r["source_sha256"], self.step_sha)
        self.assertNotIn(("register", "running"), p.steps())

    def test_exit_3_reports_verify_failed_and_still_uploads(self):
        p = self.run_sandbox(3)
        steps = p.steps()
        self.assertIn(("verify", "failed"), steps)
        self.assertNotIn(("verify", "passed"), steps)
        self.assertIn(("upload", "passed"), steps)
        verify_failed = [k for a, k in p.calls if a == "reportDrawingRenderStep" and k["key"] == "verify" and k["status"] == "failed"][0]
        self.assertIn("round trip", verify_failed["detail"])
        self.assertNotIn("docUploadUrl", p.actions())
        fin = p.finish()
        self.assertNotIn("error", fin)
        self.assertIs(fin["result"]["verify_ok"], False)
        self.assertEqual(fin["result"]["verify"]["regression"], "FAIL")
        self.assertTrue(fin["result"]["artifacts"]["pngs"])
        self.assertNotIn("register", [s for s, _ in steps])

    def test_exit_3_still_fails_an_issue_job(self):
        os.environ["FAKE_DRAWSET_EXIT"] = "3"
        p = FakePortal()
        worker.run_job(self.job(mode="issue", title_block={"drawing_number": "DRW-0001", "issue": "A", "title": "T"}),
                       p, self.cfg)
        self.assertNotIn(("verify", "passed"), p.steps())
        self.assertIn("round trip", p.finish()["error"])
        self.assertNotIn(("upload", "running"), p.steps())

    def test_unknown_mode_fails_before_download(self):
        p = self.run_sandbox(0, mode="preview")
        self.assertEqual(p.actions(), ["finishDrawingRender"])
        self.assertEqual(p.finish()["error"], "Unknown mode preview")

    def test_patch_refused(self):
        p = self.run_sandbox(0, spec_patch=json.dumps({"ops": []}), patch_sha256="x" * 64)
        self.assertEqual(p.actions(), ["finishDrawingRender"])
        self.assertEqual(p.finish()["error"], "Sandbox takes no patch")

    def test_spec_body_required(self):
        p = self.run_sandbox(0, spec_body=None)
        self.assertEqual(p.actions(), ["finishDrawingRender"])
        self.assertEqual(p.finish()["error"], "Sandbox needs a spec_body")

    def test_missing_png_still_fails_sandbox(self):
        # a non-verdict failure (no sheet PNGs) fails the job as today
        src = FAKE_DRAWSET.replace('open(os.path.join(png, "%s_s1.png" % name), "wb").write(b"PNG")', "pass")
        with open(os.path.join(self.drawset_dir, "drawset.py"), "w", encoding="utf-8") as f:
            f.write(src)
        p = self.run_sandbox(3)
        self.assertIn("PNG", p.finish()["error"])
        self.assertNotIn(("upload", "running"), p.steps())


if __name__ == "__main__":
    unittest.main(verbosity=2)
