"""
Project import: send every part document of the active Fusion project to the
portal in one pass — the 51-file workflow after the documents were renamed to
"<part number> <name>".

For each document whose name starts with a part number:
  1. open it (or use it if already open; skipped when it has unsaved changes)
  2. find the portal component by part number (exact), stamp the root
     component with pim_component_id / pim_part_number if not stamped yet,
     and link the document (linkCadDocument); a new stamp is saved as a version
  3. export the requested formats, upload each, registerCadRevision — all on
     one letter (the portal picks it: next letter, or the current draft)
  4. optionally releaseCadRevision when every format registered
  5. close it again (only if this pass opened it)

Progress is written to a JSON file after every document so a long pass can be
followed from outside Fusion (the MCP request times out long before 51 files
are done, but the script keeps running).

Nothing here guesses: a document whose part number is not in the portal is
reported, not matched by name; a part whose current revision is released is
skipped unless `resend_released` is set, so a re-run does not pile up draft
letters.
"""
from __future__ import annotations
import json
import os
import re
import time
import traceback

import adsk.core
import adsk.fusion

from .exports import (
    cleanup_tmpdir, export_formats, get_fusion_version, get_stamp,
    parse_revision_label, set_stamp,
)
from .portal import call, sha256_of, upload_file

PART_NUMBER = re.compile(r"^(RR-\d{6}-[A-Z0-9]{8})\b")
DEFAULT_FOLDERS = ("01 Panels", "02 Doors/Plain RevF", "03 Drawers", "04 Beauty Box and Trim")
DEFAULT_FORMATS = ("step", "glb", "f3z")


def list_part_files(folders=DEFAULT_FOLDERS) -> list:
    """[(dataFile, part_number)] for every document in the given project folders
    (paths relative to the project root, '/'-separated) whose name starts with
    a part number. Subfolders are not descended: supplier models live there."""
    app = adsk.core.Application.get()
    root = app.data.activeProject.rootFolder
    out = []
    for path in folders:
        folder = root
        for part in path.split("/"):
            nxt = None
            for j in range(folder.dataFolders.count):
                f = folder.dataFolders.item(j)
                if f.name == part:
                    nxt = f
                    break
            if nxt is None:
                folder = None
                break
            folder = nxt
        if folder is None:
            continue
        for i in range(folder.dataFiles.count):
            df = folder.dataFiles.item(i)
            m = PART_NUMBER.match(df.name or "")
            if m:
                out.append((df, m.group(1)))
    return out


def lookup_component(part_number: str):
    """The active portal component with exactly this part number, or None."""
    r = call("listComponents", search=part_number)
    for c in r.get("components") or []:
        if c.get("part_number") == part_number and c.get("lifecycle_status") not in ("replaced", "inactive"):
            return c
    return None


def _find_open(app, df):
    for i in range(app.documents.count):
        d = app.documents.item(i)
        if d.dataFile and d.dataFile.id == df.id:
            return d
    return None


def _wait_version(doc, v0: int, seconds: int = 60) -> int:
    t0 = time.time()
    while time.time() - t0 < seconds:
        adsk.doEvents()
        time.sleep(1)
        if doc.dataFile.versionNumber > v0:
            break
    return doc.dataFile.versionNumber


def import_file(df, part_number: str, formats=DEFAULT_FORMATS, release: bool = False,
                resend_released: bool = False, dry_run: bool = False) -> dict:
    """Stamp, export and send one document. Returns a result dict; never raises."""
    app = adsk.core.Application.get()
    res = {"file": df.name, "part_number": part_number, "status": "", "formats": [], "revision": None}
    tmpdir = None
    doc = None
    opened_here = False
    try:
        comp = lookup_component(part_number)
        if not comp:
            res["status"] = "no portal component with this part number"
            return res
        res["component"] = comp.get("name")
        if dry_run:
            res["status"] = "would send"
            return res

        doc = _find_open(app, df)
        if doc is None:
            doc = app.documents.open(df, True)
            opened_here = True
        if doc.isModified:
            res["status"] = "skipped: unsaved changes"
            return res
        design = adsk.fusion.Design.cast(doc.products.itemByProductType("DesignProductType"))
        root = design.rootComponent

        # 2. stamp + link
        stamp = get_stamp(root)
        if stamp.get("pim_component_id") != comp["id"]:
            set_stamp(root, comp["id"], part_number)
            v0 = df.versionNumber
            doc.save("Stamped with portal identity %s" % part_number)
            _wait_version(doc, v0)
            res["stamped"] = True
        try:
            project_id = df.parentProject.id
        except Exception:
            project_id = None
        link = call("linkCadDocument", component_id=comp["id"], fusion_document_id=df.id,
                    fusion_document_name=df.name, fusion_project_id=project_id)
        cad_model_id = link.get("id")
        if not cad_model_id:
            cad = call("getComponentCad", component_id=comp["id"])
            cad_model_id = (cad.get("cad_model") or {}).get("id")
        if not cad_model_id:
            res["status"] = "no cad_model record"
            return res

        cad = call("getComponentCad", component_id=comp["id"])
        model = cad.get("cad_model") or {}
        if model.get("released_revision") and model.get("status") == "released" and not resend_released:
            res["status"] = "skipped: Rev %s already released" % model.get("released_revision")
            return res

        # 3. export + send, one letter for every format
        # Files are named from the hub document name (part number + name), not the
        # root component's embedded name, which Fusion does not always refresh on rename.
        exported, tmpdir = export_formats(root, list(formats), file_stem=df.name)
        # The Fusion archive (.f3z) export returns before the file exists — it is
        # written asynchronously. Wait for every exported file to land; a format
        # that never appears is dropped and reported, not uploaded half-written.
        t0 = time.time()
        while time.time() - t0 < 90 and any(not (os.path.exists(p) and os.path.getsize(p) > 0) for p in exported.values()):
            adsk.doEvents()
            time.sleep(1)
        for fmt in [f for f, p in exported.items() if not (os.path.exists(p) and os.path.getsize(p) > 0)]:
            res.setdefault("not_written", []).append(fmt)
            del exported[fmt]
        # Geometry first: STEP and GLB are what the portal shows; the archive last.
        exported = {f: exported[f] for f in formats if f in exported}
        if not exported:
            res["status"] = "nothing exported"
            return res
        parsed = parse_revision_label(df.name)
        label = parsed[0] if parsed else None
        fusion_version = df.versionNumber
        letter = None
        revision_id = None
        for fmt, path in exported.items():
            file_name = os.path.basename(path)
            url_r = call("cadUploadUrl", fileName=file_name)
            upload_file(url_r["signedUrl"], path)
            reg = call("registerCadRevision", cad_model_id=cad_model_id, format=fmt,
                       storage_path=url_r["path"], file_name=file_name, revision=letter,
                       fusion_revision_label=label, fusion_version=fusion_version, sha256=sha256_of(path))
            letter = reg.get("revision", letter)
            revision_id = reg.get("revision_id", revision_id)
            res["formats"].append(fmt)
        res["revision"] = letter
        missing = [f for f in formats if f not in exported]
        if missing:
            res["missing"] = missing
            # Fusion's API only grew glTF export in some builds; this one has none.
            if "glb" in missing and not hasattr(design.exportManager, "createGLTFExportOptions"):
                res["glb"] = "no glTF export in this Fusion build"

        # 4. release
        if release:
            if missing:
                res["status"] = "sent Rev %s as draft — not released: %s failed to export" % (letter, ", ".join(missing))
            elif revision_id:
                rel = call("releaseCadRevision", cad_model_revision_id=revision_id)
                res["released"] = True
                res["superseded"] = rel.get("superseded_revision")
                res["status"] = "sent Rev %s, released" % letter
            else:
                res["status"] = "sent Rev %s as draft — no revision id returned" % letter
        else:
            res["status"] = "sent Rev %s as draft" % letter
        return res
    except Exception:
        res["status"] = "FAILED"
        res["error"] = traceback.format_exc()[-500:]
        return res
    finally:
        if tmpdir:
            cleanup_tmpdir(tmpdir)
        if doc is not None and opened_here:
            try:
                if not doc.isModified:
                    doc.close(False)
            except Exception:
                pass


def run_import(folders=DEFAULT_FOLDERS, formats=DEFAULT_FORMATS, release=False,
               resend_released=False, dry_run=False, progress_path=None, only=None) -> dict:
    """Import every part document of the given folders; `only` limits the pass to
    the listed part numbers. Progress JSON is rewritten after each document."""
    files = list_part_files(folders)
    if only:
        wanted = set(only)
        files = [(df, pn) for df, pn in files if pn in wanted]
    state = {"total": len(files), "results": [], "finished": False,
             "started": time.strftime("%H:%M:%S"), "release": release, "formats": list(formats), "dry_run": dry_run}

    def write():
        if progress_path:
            with open(progress_path, "w", encoding="utf-8") as fh:
                json.dump(state, fh, indent=1)
    write()
    for df, pn in files:
        state["results"].append(import_file(df, pn, formats, release, resend_released, dry_run))
        write()
        adsk.doEvents()
    state["finished"] = True
    state["ended"] = time.strftime("%H:%M:%S")
    write()
    return state
