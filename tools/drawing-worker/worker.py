#!/usr/bin/env python3
"""
Drawing worker — renders the portal's drawing jobs with drawset.py
(docs/DRAWING_RENDER.md §5).

    python3 worker.py                      run until Ctrl-C
    python3 worker.py --catalogue          print the spec catalogue (no network)
    python3 worker.py --dry-spec NAME      print the temp spec that NAME would
                                           render with (no network)

Every poll_seconds: pollDrawingRenderJob. On a job, in order, each step
reported running before and passed after:

  download  GET step_url to a temp dir as step_file_name; sha256 == cad_sha256
  render    specs/<spec>.yaml (one part only) -> temp spec with the absolute
            STEP path and the portal's title-block facts -> drawset.py
  verify    drawset's "=== VERIFICATION ===" block, "=== PASS ===" and the
            "5 regression ... OK" line; the .sources.json sidecar carries the
            dimension-list sha and the STEP sha (must equal cad_sha256)
  upload    docUploadUrl "<drawing_number> Issue <L>.pdf" + PUT
  finishDrawingRender { storage_path, file_name, sha256, result }

Any failure -> finishDrawingRender { job_id, error }; the portal marks the
running step failed and the rest skipped. A 409 from a report means the
portal closed the job (cancelled, timed out): the worker stops that job and
does not finish it. On start and every 10 min: registerDrawingSpecs from
specs/*.yaml.

The loop runs on the system python3 with the standard library only. The
venv python (OCP, matplotlib, pyyaml ...) is shelled out to for drawset and,
when pyyaml is not importable here, for reading and writing YAML.

Token: PORTAL_TOKEN in the environment, else "token" in the add-in's
config.json (token_file). Read again on every call, so a reconnect in Fusion
is picked up without restarting the worker. No password is ever stored.
"""
from __future__ import annotations

import argparse
import datetime
import glob
import hashlib
import json
import logging
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(HERE, "config.json")
LOG_FILE = os.path.join(HERE, "worker.log")

# config.example.json, verbatim: config.json overrides key by key.
DEFAULTS = {
    "portal_url": "https://iwoqujpwhsoywudjtsnj.supabase.co/functions/v1/portal-api",
    "token_file": "../../fusion-addin/RushroomPIM/config.json",
    "drawset_dir": "/Users/famqvick/Documents/Claude/Projects/VALCYRA Interiors/fusion_scripts",
    "python": "/Users/famqvick/.venvs/valcyra-draw/bin/python",
    "poll_seconds": 5,
}

STEPS = ("download", "render", "verify", "upload")   # claim and register are the portal's
PART_NUMBER = re.compile(r"RR-\d{6}-[A-Z0-9]{8}")
REGISTER_EVERY_S = 300          # registerDrawingSpecs on start and every 5 min (the portal calls a worker absent after 10)
REGISTER_RETRY_S = 60           # after a failed registration
DOWNLOAD_TIMEOUT_S = 120
DRAWSET_TIMEOUT_S = 600         # the portal fails a running job after 15 min; leave room for upload
UPLOAD_TIMEOUT_S = 180
CALL_TIMEOUT_S = 60
DETAIL_MAX = 600
_CLOSED = ("not running", "not found", "no longer running")

log = logging.getLogger("drawing-worker")


# ----------------------------------------------------------------- config, token

def load_config(path: str = CONFIG_FILE) -> dict:
    cfg = dict(DEFAULTS)
    cfg["_config_file"] = None
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            cfg.update(json.load(f))
        cfg["_config_file"] = path
    cfg["token_file"] = os.path.abspath(os.path.join(HERE, os.path.expanduser(str(cfg["token_file"]))))
    cfg["drawset_dir"] = os.path.abspath(os.path.expanduser(str(cfg["drawset_dir"])))
    cfg["python"] = os.path.expanduser(str(cfg["python"]))
    cfg["poll_seconds"] = max(1, int(cfg.get("poll_seconds") or DEFAULTS["poll_seconds"]))
    return cfg


def read_token(cfg: dict) -> tuple[str, dict]:
    """(token, add-in config). PORTAL_TOKEN wins; else the add-in's config.json.
    An expired add-in token counts as none."""
    env = os.environ.get("PORTAL_TOKEN", "").strip()
    if env:
        return env, {}
    try:
        with open(cfg["token_file"], encoding="utf-8") as f:
            tcfg = json.load(f)
    except Exception:
        return "", {}
    token = str(tcfg.get("token") or "").strip()
    expires = tcfg.get("token_expires_at")
    if token and expires and time.time() >= float(expires):
        return "", tcfg
    return token, tcfg


def agent_name(cfg: dict) -> str:
    """"Mathias · drawing worker · MacBook" — what the portal stores as claimed_by."""
    _, tcfg = read_token(cfg)
    who = tcfg.get("name") or tcfg.get("email") or "drawing worker"
    return "%s · drawing worker · %s" % (who, socket.gethostname())


# ----------------------------------------------------------------- portal client

class PortalError(RuntimeError):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


class Portal:
    """urllib POST {action, token, ...} to portal-api, the add-in's lib/portal.py shape."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.url = str(cfg["portal_url"])

    def token(self) -> str:
        tok, _ = read_token(self.cfg)
        if not tok:
            raise PortalError("no portal token: Connect to Portal in Fusion or set PORTAL_TOKEN", 401)
        return tok

    def call(self, action: str, **kwargs) -> dict:
        payload = {"action": action, "token": self.token(), **kwargs}
        req = urllib.request.Request(
            self.url, data=json.dumps(payload, default=str).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=CALL_TIMEOUT_S) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = {}
            try:
                body = json.loads(exc.read().decode("utf-8"))
            except Exception:
                pass
            raise PortalError(str(body.get("error") or "HTTP %d" % exc.code), exc.code)
        except urllib.error.URLError as exc:
            raise PortalError("portal unreachable: %s" % exc.reason)


def put_file(signed_url: str, path: str, content_type: str) -> None:
    with open(path, "rb") as f:
        data = f.read()
    req = urllib.request.Request(signed_url, data=data, headers={"Content-Type": content_type}, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=UPLOAD_TIMEOUT_S) as resp:
            if resp.status not in (200, 201):
                raise RuntimeError("upload returned HTTP %d" % resp.status)
    except urllib.error.HTTPError as exc:
        raise RuntimeError("upload failed: HTTP %d" % exc.code)


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# ----------------------------------------------------------------- yaml via venv

_YAML_LOAD = (
    "import json, sys, yaml\n"
    "d = yaml.safe_load(open(sys.argv[1], encoding='utf-8'))\n"
    "sys.stdout.write(json.dumps(d, default=str))\n"
)
_YAML_DUMP = (
    "import json, sys, yaml\n"
    "d = json.load(sys.stdin)\n"
    "sys.stdout.write(yaml.safe_dump(d, sort_keys=False, allow_unicode=True, width=120))\n"
)


def _venv(cfg: dict, code: str, args: list[str], stdin: str | None = None) -> str:
    # start_new_session: a Ctrl-C in the terminal must reach the worker only,
    # which finishes the running job before it stops; the child must not die.
    r = subprocess.run([cfg["python"], "-c", code] + args, input=stdin, capture_output=True, text=True, timeout=60,
                       start_new_session=True)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip().splitlines()[-1] if (r.stderr or r.stdout).strip() else "venv python exit %d" % r.returncode)
    return r.stdout


def load_yaml(path: str, cfg: dict) -> dict:
    try:
        import yaml  # type: ignore
    except ImportError:
        return json.loads(_venv(cfg, _YAML_LOAD, [path])) or {}
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def dump_yaml(data: dict, cfg: dict) -> str:
    try:
        import yaml  # type: ignore
    except ImportError:
        return _venv(cfg, _YAML_DUMP, [], stdin=json.dumps(data, default=str))
    return yaml.safe_dump(json.loads(json.dumps(data, default=str)), sort_keys=False, allow_unicode=True, width=120)


# ----------------------------------------------------------------- spec catalogue

def specs_dir(cfg: dict) -> str:
    return os.path.join(cfg["drawset_dir"], "specs")


def spec_catalogue(cfg: dict) -> list[dict]:
    """[{ name, title, parts, part_numbers }] for specs/*.yaml — the
    registerDrawingSpecs body. A spec that does not parse is logged and left out."""
    out = []
    for path in sorted(glob.glob(os.path.join(specs_dir(cfg), "*.yaml"))):
        name = os.path.splitext(os.path.basename(path))[0]
        try:
            spec = load_yaml(path, cfg)
        except Exception as exc:
            log.warning("spec %s skipped: %s", name, exc)
            continue
        parts = spec.get("parts") or []
        numbers: list[str] = []
        for p in parts:
            step = str(p.get("step", "")) if isinstance(p, dict) else ""
            for m in PART_NUMBER.findall(os.path.basename(step)):
                if m not in numbers:
                    numbers.append(m)
        title = spec.get("title")
        # a template (template: <kind>, no parts) is registered with no part numbers: it applies to any part
        out.append({"name": name, "title": str(title) if title is not None else None,
                    "parts": len(parts), "part_numbers": numbers, "template": bool(spec.get("template"))})
    return out


def register_specs(portal: Portal, cfg: dict, agent: str) -> None:
    if not os.path.isdir(specs_dir(cfg)):
        log.error("specs folder missing, nothing registered: %s", specs_dir(cfg))
        return
    specs = spec_catalogue(cfg)
    portal.call("registerDrawingSpecs", agent=agent, specs=specs)
    log.info("registered %d specs: %s", len(specs), ", ".join(s["name"] for s in specs) or "-")


# ----------------------------------------------------------------- temp spec

class StepFailed(Exception):
    """Raised inside a step body with the detail the portal should show."""


class JobClosed(Exception):
    """The portal no longer has this job as running (409): nothing more is
    reported or finished on its behalf."""


def safe_set_name(number: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", number).strip("_") or "drawing"


def build_temp_spec(spec: dict, step_path: str, title_block: dict, cad_sha256: str, today: str) -> dict:
    """The spec drawset renders: the original with parts[0].step = the
    downloaded STEP and the title-block facts from the portal. Multi-part
    specs are refused — a render job draws one part."""
    parts = spec.get("parts") or []
    template = bool(spec.get("template"))
    if template:
        # a template names no part: the job's STEP is the part, the job's title block names it
        if parts:
            raise StepFailed("template %s must not list parts" % spec.get("template"))
    elif len(parts) != 1:
        raise StepFailed("spec has %d parts; a render job draws one part" % len(parts))
    tb = title_block or {}
    number = str(tb.get("drawing_number") or "").strip()
    issue = str(tb.get("issue") or "").strip()
    if not number or not issue:
        raise StepFailed("title_block lacks drawing_number or issue")
    date = str(tb.get("date") or today)[:10]
    sha8 = str(tb.get("cad_sha8") or cad_sha256[:8])
    rev = str(tb.get("cad_revision") or "?")
    out = dict(spec)
    part = dict(parts[0]) if parts else {"label": str(tb.get("part_name") or tb.get("part_number") or "Part")}
    part["step"] = os.path.abspath(step_path)
    out["parts"] = [part]
    if template or not out.get("title"):
        title = str(tb.get("title") or tb.get("part_name") or tb.get("part_number") or "").strip()
        if not title:
            raise StepFailed("template render: title_block lacks title and part_name")
        out["title"] = title
    out["drawing_number"] = number
    out["issue"] = issue
    out["date"] = date
    out["set_name"] = safe_set_name(number)
    out["change"] = ["From CAD Rev %s · %s" % (rev, sha8), "Rendered by drawset", date]
    # a spec's title stays what the spec says; a template takes the job's drawing title (else the
    # part name); title_block (when the spec has none) is built by drawset from title + the part's size
    return out


def drawset_version(cfg: dict) -> str:
    """git short hash when the drawset folder is itself a repo, else drawset.py's mtime."""
    d = cfg["drawset_dir"]
    try:
        r = subprocess.run(["git", "-C", d, "rev-parse", "--show-toplevel", "--short", "HEAD"],
                           capture_output=True, text=True, timeout=10)
        lines = r.stdout.strip().splitlines()
        if r.returncode == 0 and len(lines) == 2 and os.path.realpath(lines[0]) == os.path.realpath(d):
            return "git " + lines[1]
    except Exception:
        pass
    try:
        m = os.path.getmtime(os.path.join(d, "drawset.py"))
        return "mtime " + datetime.datetime.fromtimestamp(m).isoformat(timespec="seconds")
    except Exception:
        return "unknown"


def count_pdf_pages(path: str) -> int:
    """Page objects in the PDF (matplotlib writes them uncompressed); 0 when none found."""
    try:
        with open(path, "rb") as f:
            data = f.read()
        return len(re.findall(rb"/Type\s*/Page(?![s/\w])", data))
    except Exception:
        return 0


def _tail(text: str, n: int = 5) -> str:
    lines = [l for l in (text or "").strip().splitlines() if l.strip()]
    return " | ".join(l.strip() for l in lines[-n:])


def _parse_summary(stdout: str):
    """drawset's machine-readable verdict (Phase 0 of DYNAMIC_DRAWINGS.md): the last DRAWSET_SUMMARY line, or None."""
    for line in reversed(stdout.splitlines()):
        if line.startswith("DRAWSET_SUMMARY "):
            try:
                return json.loads(line[len("DRAWSET_SUMMARY "):])
            except ValueError:
                return None
    return None


def _summary_reason(summary: dict) -> str:
    """The one line to show for a failed verdict, from the summary itself."""
    rt = summary.get("round_trip") or {}
    if rt.get("mismatches"):
        return "round trip: %d of %d dimensions differ from the STEP" % (rt["mismatches"], rt.get("n", 0))
    missing = summary.get("completeness_missing") or []
    if missing:
        shown = ", ".join("%s %s" % (m[0], m[1]) for m in missing[:4])
        return "completeness: %d features without a dimension (%s%s)" % (len(missing), shown, ", …" if len(missing) > 4 else "")
    dup = summary.get("duplicate_callouts") or {}
    if dup:
        return "holes with other than one callout: %s" % ", ".join(sorted(dup))
    for f in summary.get("fusion") or []:
        if not f.get("ok", True):
            return "Fusion cross-check (%s): %d differences" % (f.get("part"), len(f.get("differences") or []))
    if summary.get("regression") != "OK":
        return "regression: the same STEP rendered twice gave different dimension lists"
    return "verification failed"


def _verify_reason(stdout: str) -> str:
    """The line to show for a FAIL: the first failing check line, else the summary."""
    lines = stdout.splitlines()
    fails = [l.strip() for l in lines if "FAIL" in l]
    for l in fails:
        if not l.startswith("==="):
            return l
    for l in lines:
        m = re.search(r"(\d+) mismatches|(\d+) features without a dimension|(\d+) differences", l)
        if m and int(next(g for g in m.groups() if g)) > 0:
            return l.strip()
    return fails[0] if fails else "verification failed"


# ----------------------------------------------------------------- one job

def run_job(job: dict, portal: Portal, cfg: dict) -> dict:
    """Execute one claimed job and close it with finishDrawingRender. Never
    raises except KeyboardInterrupt (after finishing the job with an error)."""
    job_id = str(job.get("id") or "")
    tb = job.get("title_block") or {}
    number = str(tb.get("drawing_number") or "").strip()
    issue = str(tb.get("issue") or job.get("issue") or "").strip()
    short = job_id[:8]
    tmp = tempfile.mkdtemp(prefix="drawing-worker-")
    st: dict = {}
    log.info("job %s: claimed · %s Issue %s · %s · spec %s · from CAD Rev %s",
             short, number or "?", issue or "?", tb.get("part_number") or "?", job.get("spec"), tb.get("cad_revision") or "?")

    def report(key: str, status: str, detail=None, data=None) -> None:
        kwargs = {"job_id": job_id, "key": key, "status": status}
        if detail is not None:
            kwargs["detail"] = str(detail)[:DETAIL_MAX]
        if data is not None:
            kwargs["data"] = data
        last = None
        for attempt in range(3):
            try:
                portal.call("reportDrawingRenderStep", **kwargs)
                return
            except PortalError as exc:
                if exc.status == 409 or any(m in str(exc).lower() for m in _CLOSED):
                    raise JobClosed(str(exc))
                last = exc
                log.warning("job %s: report %s/%s failed (%d): %s", short, key, status, attempt + 1, exc)
                time.sleep(2)
            except (TimeoutError, OSError) as exc:
                # A slow or dropped connection (urlopen raises TimeoutError, not
                # URLError, on a read timeout) is retried like any other failure.
                last = exc
                log.warning("job %s: report %s/%s timed out (%d): %s", short, key, status, attempt + 1, exc)
                time.sleep(2)
        raise RuntimeError("report %s lost: %s" % (key, last))

    # ---- step bodies -------------------------------------------------------
    def step_download():
        url = str(job.get("step_url") or "")
        name = os.path.basename(str(job.get("step_file_name") or "")) or "part.step"
        want = str(job.get("cad_sha256") or "").lower()
        st["want_sha"] = want
        if not url:
            raise StepFailed("job carries no step_url")
        # A STEP registered before the portal recorded shas has none: the
        # download's sha becomes the fact, and finishDrawingRender backfills it.
        path = os.path.join(tmp, name)
        h = hashlib.sha256()
        n = 0
        try:
            with urllib.request.urlopen(urllib.request.Request(url), timeout=DOWNLOAD_TIMEOUT_S) as resp, open(path, "wb") as f:
                for chunk in iter(lambda: resp.read(1024 * 1024), b""):
                    f.write(chunk)
                    h.update(chunk)
                    n += len(chunk)
        except urllib.error.HTTPError as exc:
            raise StepFailed("STEP download failed: HTTP %d" % exc.code)
        except urllib.error.URLError as exc:
            raise StepFailed("STEP download failed: %s" % exc.reason)
        got = h.hexdigest()
        if want and got != want:
            raise StepFailed("STEP sha differs from the registry")
        st["step_path"], st["step_sha256"], st["want_sha"] = path, got, got
        note = "" if want else " · registry had no sha, recorded"
        return "%s · %d bytes · %s%s" % (name, n, got[:8], note), {"file_name": name, "bytes": n, "sha256": got}

    def step_render():
        spec_name = str(job.get("spec") or "").strip()
        if not spec_name or spec_name != os.path.basename(spec_name) or spec_name.startswith("."):
            raise StepFailed("job carries no valid spec name")
        spec_path = os.path.join(specs_dir(cfg), spec_name + ".yaml")
        if not os.path.exists(spec_path):
            raise StepFailed("spec %s.yaml not found in %s" % (spec_name, specs_dir(cfg)))
        spec = load_yaml(spec_path, cfg)
        st["spec_sha256"] = sha256_of(spec_path)
        today = datetime.date.today().isoformat()
        temp = build_temp_spec(spec, st["step_path"], tb, st["step_sha256"], today)
        temp_path = os.path.join(tmp, spec_name + ".yaml")
        with open(temp_path, "w", encoding="utf-8") as f:
            f.write(dump_yaml(temp, cfg))
        out_dir = os.path.join(tmp, "out")
        os.makedirs(out_dir, exist_ok=True)
        cmd = [cfg["python"], "drawset.py", temp_path, "--out", out_dir]
        log.info("job %s: %s (cwd %s)", short, " ".join(cmd), cfg["drawset_dir"])
        t0 = time.time()
        try:
            proc = subprocess.run(cmd, cwd=cfg["drawset_dir"], capture_output=True, text=True, timeout=DRAWSET_TIMEOUT_S,
                                  start_new_session=True)
        except subprocess.TimeoutExpired:
            raise StepFailed("drawset did not finish within %d s" % DRAWSET_TIMEOUT_S)
        elapsed = time.time() - t0
        st["stdout"], st["stderr"] = proc.stdout or "", proc.stderr or ""
        with open(os.path.join(tmp, "drawset.stdout.txt"), "w", encoding="utf-8") as f:
            f.write(st["stdout"])
        with open(os.path.join(tmp, "drawset.stderr.txt"), "w", encoding="utf-8") as f:
            f.write(st["stderr"])
        log.debug("job %s: drawset stdout\n%s", short, st["stdout"])
        if st["stderr"].strip():
            log.debug("job %s: drawset stderr\n%s", short, st["stderr"])
        st["returncode"] = proc.returncode
        # exit 3 = rendered but the verification failed: the PDF exists, the verify step says why
        if proc.returncode not in (0, 3):
            raise StepFailed("drawset exit %d: %s" % (proc.returncode, _tail(st["stderr"] or st["stdout"])))
        pdf = None
        for line in st["stdout"].splitlines():
            if line.startswith("PDF:"):
                pdf = line[4:].strip()
                break
        if not pdf:
            pdf = os.path.join(out_dir, "VALCYRA_Rev%s_%s.pdf" % (temp["issue"], temp["set_name"]))
        if not os.path.exists(pdf):
            raise StepFailed("drawset produced no PDF: %s" % _tail(st["stdout"]))
        pages = count_pdf_pages(pdf) or len(spec.get("sheets") or [])
        st["pdf_path"], st["pages"], st["temp_spec"] = pdf, pages, temp
        return ("%s · %d pages · %.0f s" % (os.path.basename(pdf), pages, elapsed),
                {"pdf": os.path.basename(pdf), "pages": pages, "seconds": round(elapsed, 1), "set_name": temp["set_name"]})

    def step_verify():
        out = st["stdout"]
        summary = _parse_summary(out)
        st["summary"] = summary
        if summary is not None:
            if st.get("returncode") == 3 or not summary.get("pass"):
                raise StepFailed(_summary_reason(summary))
            if summary.get("regression") != "OK":
                raise StepFailed("no regression verdict in the summary")
        else:
            # a drawset that predates DRAWSET_SUMMARY: read the prose
            if "=== VERIFICATION ===" not in out:
                raise StepFailed("drawset printed no verification block: %s" % _tail(out))
            if any("FAIL" in l for l in out.splitlines()):
                raise StepFailed(_verify_reason(out))
            regression = next((l.strip() for l in out.splitlines() if l.startswith("5 regression")), "")
            if not regression.endswith("OK"):
                raise StepFailed("no regression verdict: %s" % (regression or _tail(out)))
            if "=== PASS ===" not in out:
                raise StepFailed("verification did not pass: %s" % _tail(out))
        sidecar = st["pdf_path"] + ".sources.json"
        if not os.path.exists(sidecar):
            raise StepFailed("no sources sidecar: %s" % os.path.basename(sidecar))
        with open(sidecar, encoding="utf-8") as f:
            src = json.load(f)
        dl = str(src.get("dimension_list_sha256") or "")
        if not dl:
            raise StepFailed("sidecar has no dimension_list_sha256")
        steps = src.get("steps") or []
        shas = [str(s.get("sha256") or "").lower() for s in steps]
        if len(steps) != 1 or shas[0] != st["step_sha256"]:
            raise StepFailed("sidecar STEP sha differs from the registry")
        st["dimension_list_sha256"] = dl
        st["geometry_sha256"] = str(src.get("geometry_sha256") or "")
        st["product_id"] = steps[0].get("product_id")
        data = {"dimension_list_sha256": dl, "step_sha256": shas[0], "product_id": st["product_id"]}
        if st["geometry_sha256"]:
            data["geometry_sha256"] = st["geometry_sha256"]
        if summary is not None:
            data["verify"] = {"round_trip": summary.get("round_trip"), "completeness_missing": summary.get("completeness_missing"),
                              "wall_flags": summary.get("wall_flags"), "regression": summary.get("regression")}
        return ("PASS · dimension list %s · geometry %s · STEP %s" % (dl[:8], (st["geometry_sha256"] or "—")[:8], shas[0][:8]), data)

    def step_upload():
        if not number or not issue:
            raise StepFailed("title_block lacks drawing_number or issue")
        file_name = "%s Issue %s.pdf" % (number, issue)
        r = portal.call("docUploadUrl", fileName=file_name)
        if not r.get("signedUrl") or not r.get("path"):
            raise StepFailed("docUploadUrl answered without signedUrl/path")
        put_file(r["signedUrl"], st["pdf_path"], "application/pdf")
        st["storage_path"], st["file_name"] = r["path"], file_name
        st["pdf_sha256"] = sha256_of(st["pdf_path"])
        size = os.path.getsize(st["pdf_path"])
        return ("%s · %d bytes · %s" % (file_name, size, st["pdf_sha256"][:8]),
                {"storage_path": r["path"], "file_name": file_name, "bytes": size, "sha256": st["pdf_sha256"]})

    bodies = {"download": step_download, "render": step_render, "verify": step_verify, "upload": step_upload}

    def finish_error(error: str) -> None:
        try:
            portal.call("finishDrawingRender", job_id=job_id, error=error[:2000])
        except Exception as exc:
            log.error("job %s: finishDrawingRender(error) failed: %s", short, exc)

    # ---- drive -------------------------------------------------------------
    try:
        for key in STEPS:
            report(key, "running")
            t0 = time.time()
            try:
                out = bodies[key]()
            except (StepFailed, JobClosed, KeyboardInterrupt):
                raise
            except Exception:
                tb_text = traceback.format_exc()
                log.error("job %s: %s raised\n%s", short, key, tb_text)
                raise StepFailed(tb_text.strip().splitlines()[-1][:300])
            detail, data = out if isinstance(out, tuple) else (out, None)
            report(key, "passed", detail, data)
            log.info("job %s: %s passed in %.1f s — %s", short, key, time.time() - t0, detail)
        result = {
            "pages": st["pages"],
            "dimension_list_sha256": st["dimension_list_sha256"],
            "spec_sha256": st["spec_sha256"],
            "drawset_version": drawset_version(cfg),
            "verify_ok": True,
        }
        if st.get("geometry_sha256"):
            result["geometry_sha256"] = st["geometry_sha256"]
        if st.get("summary") is not None:
            sm = st["summary"]
            result["verify"] = {"round_trip": sm.get("round_trip"), "completeness_missing": sm.get("completeness_missing"),
                                "wall_flags": sm.get("wall_flags"), "regression": sm.get("regression")}
            result["unmatched_overrides"] = sm.get("unmatched_overrides") or []
        fin = portal.call("finishDrawingRender", job_id=job_id, storage_path=st["storage_path"],
                          file_name=st["file_name"], sha256=st["pdf_sha256"], result=result,
                          source_sha256=st.get("want_sha"))
        j = fin.get("job") if isinstance(fin, dict) else None
        if j and j.get("status") != "done":
            # The portal refused the issue (a letter added meanwhile, a vanished
            # drawing): the PDF was not registered. Keep the folder for a look.
            log.error("job %s: the portal did not register the issue — %s; files kept in %s",
                      short, j.get("error") or j.get("status"), tmp)
            return fin
        log.info("job %s: done — %s Issue %s registered", short, number, issue)
        shutil.rmtree(tmp, ignore_errors=True)
        return fin
    except JobClosed as exc:
        log.warning("job %s: the portal closed the job (%s); stopped, nothing finished", short, exc)
        shutil.rmtree(tmp, ignore_errors=True)
        return {"error": str(exc), "closed": True}
    except KeyboardInterrupt:
        log.warning("job %s: stopped by hand", short)
        finish_error("worker stopped by hand")
        raise
    except StepFailed as exc:
        log.error("job %s: failed — %s (files kept in %s)", short, exc, tmp)
        finish_error(str(exc))
        return {"error": str(exc)}
    except Exception as exc:
        log.error("job %s: failed — %s (files kept in %s)\n%s", short, exc, tmp, traceback.format_exc())
        finish_error(str(exc)[:600])
        return {"error": str(exc)}


# ----------------------------------------------------------------- the loop

def setup_logging(console: bool = True) -> None:
    log.setLevel(logging.DEBUG)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)
    log.addHandler(fh)
    if console:
        sh = logging.StreamHandler(sys.stdout)
        sh.setLevel(logging.INFO)
        sh.setFormatter(fmt)
        log.addHandler(sh)


def check_start(cfg: dict) -> list[str]:
    problems = []
    token, _ = read_token(cfg)
    if not token:
        problems.append("no portal token: Connect to Portal in Fusion (writes %s) or set PORTAL_TOKEN" % cfg["token_file"])
    if not os.path.exists(os.path.join(cfg["drawset_dir"], "drawset.py")):
        problems.append("drawset.py not found in drawset_dir %s" % cfg["drawset_dir"])
    if not os.path.exists(cfg["python"]):
        problems.append("python not found: %s" % cfg["python"])
    return problems


def main_loop(cfg: dict) -> int:
    problems = check_start(cfg)
    if problems:
        for p in problems:
            log.error(p)
        return 2
    portal = Portal(cfg)
    agent = agent_name(cfg)
    stop = threading.Event()
    interrupts = [0]

    def on_signal(signum, frame):
        interrupts[0] += 1
        if interrupts[0] == 1:
            stop.set()
            log.info("stopping: the current job finishes first (Ctrl-C again aborts it)")
        else:
            raise KeyboardInterrupt

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    log.info("drawing worker · %s · %s · every %d s · specs %s · config %s",
             agent, portal.url, cfg["poll_seconds"], specs_dir(cfg), cfg["_config_file"] or "defaults")
    next_register = 0.0
    last_poll_error = None
    try:
        while not stop.is_set():
            now = time.time()
            if now >= next_register:
                try:
                    register_specs(portal, cfg, agent)
                    next_register = now + REGISTER_EVERY_S
                except Exception as exc:
                    log.warning("registerDrawingSpecs failed: %s", exc)
                    next_register = now + REGISTER_RETRY_S
            job = None
            try:
                r = portal.call("pollDrawingRenderJob", agent=agent)
                job = r.get("job") if isinstance(r, dict) else None
                last_poll_error = None
            except Exception as exc:
                msg = str(exc)
                if msg != last_poll_error:
                    log.warning("poll failed: %s", msg)
                    last_poll_error = msg
            if job:
                run_job(job, portal, cfg)
                continue        # look for the next job at once
            stop.wait(cfg["poll_seconds"])
    except KeyboardInterrupt:
        pass
    log.info("stopped")
    return 0


# ----------------------------------------------------------------- dry runs

def dry_spec(cfg: dict, name: str, step: str | None) -> str:
    """The temp spec `name` would render with, for a sample title block. No network."""
    spec_path = os.path.join(specs_dir(cfg), name + ".yaml")
    spec = load_yaml(spec_path, cfg)
    parts = spec.get("parts") or []
    if not step:
        step = os.path.join(cfg["drawset_dir"], str(parts[0].get("step", ""))) if parts else "part.step"
    today = datetime.date.today().isoformat()
    sample_tb = {"drawing_number": "DRW-0000", "issue": "A", "title": spec.get("title"),
                 "part_number": ", ".join(PART_NUMBER.findall(os.path.basename(step))) or None,
                 "cad_revision": "B", "cad_sha8": "0123abcd", "date": today}
    temp = build_temp_spec(spec, step, sample_tb, "0123abcd" + "0" * 56, today)
    return dump_yaml(temp, cfg)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Rushroom drawing worker (docs/DRAWING_RENDER.md §5)")
    ap.add_argument("--config", default=CONFIG_FILE, help="config file (default: config.json beside worker.py)")
    ap.add_argument("--catalogue", action="store_true", help="print the spec catalogue as JSON and exit (no network)")
    ap.add_argument("--dry-spec", metavar="NAME", help="print the temp spec NAME would render with and exit (no network)")
    ap.add_argument("--step", metavar="PATH", help="with --dry-spec: the STEP path to put in the temp spec")
    a = ap.parse_args(argv)
    cfg = load_config(a.config)
    if a.catalogue:
        logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
        print(json.dumps(spec_catalogue(cfg), indent=1, ensure_ascii=False))
        return 0
    if a.dry_spec:
        logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
        try:
            sys.stdout.write(dry_spec(cfg, a.dry_spec, a.step))
        except StepFailed as exc:
            print("would fail at render: %s" % exc)
            return 1
        return 0
    setup_logging()
    return main_loop(cfg)


if __name__ == "__main__":
    sys.exit(main())
