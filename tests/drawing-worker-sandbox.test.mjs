// Drawing Templates phase 1 — the worker's sandbox mode (docs/DRAWING_TEMPLATES.md §4,
// the phase-1 contract §4.5). Static guards over tools/drawing-worker/worker.py; the
// behaviour (exit 3 still uploads, unknown mode and patch refused before download) is
// exercised by tools/drawing-worker/test_worker_sandbox.py. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const w = read("tools/drawing-worker/worker.py");

// the body of a nested def inside run_job: from its line to the next def at the same indent
function inner(name) {
  const start = w.indexOf(`    def ${name}(`);
  assert.ok(start >= 0, `def ${name}`);
  const rest = w.slice(start + 1);
  const end = rest.search(/\n    def |\n    bodies = /);
  return rest.slice(0, end < 0 ? undefined : end);
}

test("worker accepts mode sandbox and refuses an unknown mode at claim, before download", () => {
  assert.match(w, /MODES = \("issue", "iterate", "sandbox"\)/);
  assert.match(w, /return "Unknown mode %s" % mode/);
  assert.match(w, /return "Sandbox takes no patch"/);
  const drive = w.slice(w.indexOf("# ---- drive"));
  assert.ok(drive.indexOf("claim_refusal(job, mode)") < drive.indexOf("for key in STEPS"), "the refusal comes before the first step");
});

test("sandbox never calls docUploadUrl and uploads its PDF as sandbox.pdf", () => {
  assert.match(w, /SANDBOX_PDF = "sandbox\.pdf"/);
  const up = inner("step_upload");
  assert.match(up, /file_name = SANDBOX_PDF if mode == "sandbox"/);
  const calls = up.match(/portal\.call\("docUploadUrl"/g) || [];
  assert.equal(calls.length, 1, "one docUploadUrl call");
  const guard = up.slice(0, up.indexOf('portal.call("docUploadUrl"'));
  assert.match(guard, /if mode == "issue":\s*\n(?:\s*#.*\n)*\s*r = $/, "docUploadUrl only under mode issue");
  assert.match(up, /if mode in \("iterate", "sandbox"\):\s*\n(?:\s*#.*\n)*\s*st\["storage_path"\] = art\["pdf"\]/, "storage_path is the artefact PDF");
});

test("a failed verdict is a result in sandbox: verify reported failed, the job goes on, verify_ok false", () => {
  assert.match(inner("verdict_failed"), /if mode != "sandbox":\s*\n\s*raise StepFailed\(reason\)/);
  assert.match(w, /if key == "verify" and st\.get\("verify_fail"\):\s*\n(?:\s*#.*\n)*\s*report\(key, "failed", detail, data\)/);
  assert.match(w, /"verify_ok": not st\.get\("verify_fail"\)/);
});

test("the worker never reports register and runs drawset with no new flag", () => {
  assert.match(w, /STEPS = \("download", "render", "verify", "upload"\)/);
  assert.doesNotMatch(w, /report\("register"/);
  assert.doesNotMatch(w, /--no-regression/);
  assert.match(w, /cmd = \[cfg\["python"\], "drawset\.py", temp_path, "--out", out_dir, "--png", png_dir\]/);
});

test("build_temp_spec still requires drawing_number and issue", () => {
  assert.match(w, /raise StepFailed\("title_block lacks drawing_number or issue"\)/);
});

// The behaviour itself: tools/drawing-worker/test_worker_sandbox.py, run here so
// `node --test tests/` fails when it does. Skipped when python3 is not on PATH.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
test("test_worker_sandbox.py passes", (t) => {
  const py = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (py.error) { t.skip("python3 not found"); return; }
  const script = fileURLToPath(new URL("../tools/drawing-worker/test_worker_sandbox.py", import.meta.url));
  const r = spawnSync("python3", [script], { encoding: "utf8", timeout: 120000, cwd: fileURLToPath(new URL("../tools/drawing-worker/", import.meta.url)) });
  assert.equal(r.status, 0, `test_worker_sandbox.py exited ${r.status}\n${r.stdout}\n${r.stderr}`);
});

// Phase 2: the features and catch modes (tools/drawing-worker/test_worker_catch.py).
test("test_worker_catch.py passes", (t) => {
  const py = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (py.error) { t.skip("python3 not found"); return; }
  const script = fileURLToPath(new URL("../tools/drawing-worker/test_worker_catch.py", import.meta.url));
  const r = spawnSync("python3", [script], { encoding: "utf8", timeout: 180000, cwd: fileURLToPath(new URL("../tools/drawing-worker/", import.meta.url)) });
  assert.equal(r.status, 0, `test_worker_catch.py exited ${r.status}\n${r.stdout}\n${r.stderr}`);
});
