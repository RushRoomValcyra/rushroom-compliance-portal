"""
Fusion 360 export and attribute helpers.

API notes (Fusion 360 2.0 / August 2024+):
  exportManager.createFusionArchiveExportOptions(filename)
      → FusionArchiveExportOptions (whole document)
  exportManager.createSTEPExportOptions(filename, occurrence_or_component?)
      → STEPExportOptions
  exportManager.createGLTFExportOptions(filename, occurrence_or_component?)
      → GLTFExportOptions  (.isTextFormat = False → binary .glb)
  exportManager.execute(options) → bool

  component.attributes.add(group, name, value)
  component.attributes.itemByName(group, name) → Attribute | None

  dataFile.versionNumber → int (Fusion's own save counter; not necessarily
                                monotonic — it reflects the version the
                                document was at when last saved to the cloud)

Physical properties (units: Fusion uses centimetres internally):
  volume → cm³   area → cm²   mass → g (not kg despite Fusion docs sometimes
  saying kg; verify with a known mass before relying on the unit)

The "correct" unit for mass in Fusion's Python API depends on the document's
unit system. For safety we return the raw value and label it as "Fusion units".
Phase 3.4 will reconcile units when storing these in the portal.

Revision label (STATUS_MODEL.md §3 / §5.3):
  By convention the design revision is written into the Fusion document name
  ("VALCYRA RevF Door M").  parse_revision_label() lifts it out so the portal
  letter defaults to the engineer's own letter instead of an export counter.
  The regex mirrors parseRevisionLabel in _shared/status-core.mjs exactly.
"""
from __future__ import annotations
import os
import re
import tempfile
from typing import Optional

import adsk.core
import adsk.fusion

ATTR_GROUP = "RushroomPIM"
ATTR_COMPONENT_ID = "pim_component_id"
ATTR_PART_NUMBER = "pim_part_number"

# Same pattern as parseRevisionLabel() in _shared/status-core.mjs.
_REV_LABEL_RE = re.compile(r"\bRev\s*([A-Z]{1,2})\b", re.IGNORECASE)


def parse_revision_label(doc_name: Optional[str]) -> Optional[tuple]:
    """
    Find the design revision label in a Fusion document name.

    "VALCYRA RevF Door M"  → ("RevF", "F")
    "Panel rev ab v3"      → ("rev ab", "AB")
    "Door M"               → None

    Returns (label, letter) where label is the text exactly as written in the
    name and letter is the upper-cased one- or two-letter revision, or None
    when the name carries no label.
    """
    if not doc_name:
        return None
    m = _REV_LABEL_RE.search(doc_name)
    if not m:
        return None
    return (m.group(0), m.group(1).upper())


def get_doc_name() -> str:
    """Return the active document's name (dataFile name when saved, else doc name)."""
    try:
        doc = get_app().activeDocument
        df = doc.dataFile
        if df:
            return df.name or doc.name or ""
        return doc.name or ""
    except Exception:
        return ""


def get_app() -> adsk.core.Application:
    return adsk.core.Application.get()


def get_design() -> adsk.fusion.Design:
    return adsk.fusion.Design.cast(get_app().activeProduct)


def get_active_component() -> adsk.fusion.Component:
    """Return the component currently open for editing (may be a sub-component)."""
    return get_design().activeComponent


def get_doc_info() -> dict:
    """
    Return Fusion document identity fields for linkCadDocument.
    fusion_document_id is the stable lineage URN — it survives version bumps,
    copies, and project moves. Returns None values when the doc is unsaved.
    """
    app = get_app()
    doc = app.activeDocument
    df = doc.dataFile
    if df:
        try:
            project = df.parentProject
            project_id = project.id if project else None
        except Exception:
            project_id = None
        return {
            "fusion_document_id": df.id,
            "fusion_document_name": df.name,
            "fusion_project_id": project_id,
        }
    return {
        "fusion_document_id": None,
        "fusion_document_name": doc.name,
        "fusion_project_id": None,
    }


def next_revision_letter(current: Optional[str]) -> str:
    """The letter after `current` in the portal's alphabet: A … Z, AA, AB …
    Mirrors nextRevisionLetter in _shared/status-core.mjs so the dialog can say
    which letter the portal will assign before anything is sent."""
    if not current:
        return "A"
    chars = list(current.strip().upper())
    i = len(chars) - 1
    while i >= 0:
        if chars[i] != "Z":
            chars[i] = chr(ord(chars[i]) + 1)
            return "".join(chars)
        chars[i] = "A"
        i -= 1
    return "A" + "".join(chars)


def get_fusion_version() -> Optional[int]:
    """Return the Fusion version number of the current document, or None."""
    app = get_app()
    doc = app.activeDocument
    df = doc.dataFile
    if df:
        try:
            return int(df.versionNumber)
        except Exception:
            pass
    return None


def get_physical_props(component: adsk.fusion.Component) -> dict:
    """
    Read volume, area and mass from Fusion's physical properties.
    Returns raw Fusion-unit values (cm³, cm², Fusion-mass-unit).
    Returns an empty dict if the calculation fails.
    """
    try:
        props = component.getPhysicalProperties(
            adsk.fusion.CalculationAccuracy.LowCalculationAccuracy
        )
        return {
            "volume_cm3": props.volume,
            "area_cm2": props.area,
            "mass_fusion_units": props.mass,
        }
    except Exception:
        return {}


def get_stamp(component: adsk.fusion.Component) -> dict:
    """Return { pim_component_id, pim_part_number } from attributes, or empty strings."""
    def _val(name: str) -> str:
        attr = component.attributes.itemByName(ATTR_GROUP, name)
        return attr.value if attr else ""

    return {
        "pim_component_id": _val(ATTR_COMPONENT_ID),
        "pim_part_number": _val(ATTR_PART_NUMBER),
    }


def set_stamp(component: adsk.fusion.Component, pim_component_id: str, pim_part_number: str,
              pim_name: str | None = None) -> list[str]:
    """Write the PIM identity on the component (docs/CAD-FILE-REPOSITORY.md):
    the RushroomPIM attributes, Fusion's own Part Number property = the PIM part
    number, and Description = the PIM name when one is given. Returns the list
    of fields that actually changed, so a caller knows whether to save.

    Note: Fusion does not flag a document as modified when only Description or
    an attribute changes, so doc.save() after such a change is a no-op (it
    returns True and creates no version). Callers that must persist use
    ensure_modified() before saving."""
    changed = []
    attrs = component.attributes
    cur = get_stamp(component)
    if cur["pim_component_id"] != pim_component_id:
        attrs.add(ATTR_GROUP, ATTR_COMPONENT_ID, pim_component_id); changed.append("pim_component_id")
    if cur["pim_part_number"] != pim_part_number:
        attrs.add(ATTR_GROUP, ATTR_PART_NUMBER, pim_part_number); changed.append("pim_part_number")
    if pim_part_number and component.partNumber != pim_part_number:
        component.partNumber = pim_part_number; changed.append("partNumber")
    if pim_name:
        want = " ".join(pim_name.split())
        if component.description != want:
            component.description = want; changed.append("description")
    return changed


def name_single_body(component: adsk.fusion.Component, name: str) -> list[str]:
    """A part document holds one body; name it like the document
    ("<part number> <name>") so the body reads right in STEP viewers and in
    the Fusion browser. Assemblies and multi-body parts are left alone."""
    if not name or component.bRepBodies.count != 1 or component.occurrences.count:
        return []
    body = component.bRepBodies.item(0)
    if body.name == name:
        return []
    body.name = name
    return ["body"]


def ensure_modified(doc: adsk.core.Document, component: adsk.fusion.Component) -> bool:
    """Make sure doc.save() will create a version. Description and attribute
    writes do not set doc.isModified; renaming the part number to itself with a
    trailing space and back does, and leaves the model as it was."""
    if doc.isModified:
        return True
    pn = component.partNumber
    component.partNumber = pn + " "
    component.partNumber = pn
    return doc.isModified


def safe_file_stem(name: str, limit: int = 120) -> str:
    """A file-system safe stem: letters, digits, "-_. " kept, the rest "_"; a
    long name is cut at `limit` characters, never inside the part number."""
    stem = "".join(c if c.isalnum() or c in "-_. " else "_" for c in (name or "")).strip()
    return stem[:limit].strip() or "export"


def export_formats(component: adsk.fusion.Component, formats: list[str],
                   file_stem: str | None = None) -> tuple[dict, str]:
    """
    Export the component in the requested formats to a temp directory.
    formats: subset of ["f3z", "step", "glb"]
    Returns ({ format: filepath }, tmpdir).  The caller must clean up tmpdir.

    f3z  — full Fusion archive of the DOCUMENT (component selection is ignored;
            the whole doc is archived because .f3z is a document-level format)
    step — STEP AP214 of the component (or the root if component is root)
    glb  — binary glTF 2.0 of the component (requires Fusion 360 ≥ 2.0.17000)

    file_stem names the files. Callers pass the hub document name ("<part number>
    <name>"): the root component's embedded name can lag behind a rename of the
    document, so it is only the fallback for an unsaved document.
    """
    design = get_design()
    em = design.exportManager
    safe_name = safe_file_stem(file_stem or component.name)
    tmpdir = tempfile.mkdtemp(prefix="rushroom_pim_")
    result: dict[str, str] = {}

    if "f3z" in formats:
        path = os.path.join(tmpdir, f"{safe_name}.f3z")
        try:
            opts = em.createFusionArchiveExportOptions(path)
            if em.execute(opts):
                result["f3z"] = path
        except Exception:
            pass

    if "step" in formats:
        path = os.path.join(tmpdir, f"{safe_name}.step")
        try:
            opts = em.createSTEPExportOptions(path, component)
            if em.execute(opts):
                result["step"] = path
        except Exception:
            # Some Fusion versions don't accept a component argument; fall back.
            try:
                opts = em.createSTEPExportOptions(path)
                if em.execute(opts):
                    result["step"] = path
            except Exception:
                pass

    if "glb" in formats:
        path = os.path.join(tmpdir, f"{safe_name}.glb")
        try:
            opts = em.createGLTFExportOptions(path, component)
            opts.isTextFormat = False  # binary .glb, not .gltf
            if em.execute(opts):
                result["glb"] = path
        except Exception:
            try:
                opts = em.createGLTFExportOptions(path)
                opts.isTextFormat = False
                if em.execute(opts):
                    result["glb"] = path
            except Exception:
                pass

    return result, tmpdir


def cleanup_tmpdir(tmpdir: str) -> None:
    """Remove the temp directory and its contents."""
    import shutil
    try:
        shutil.rmtree(tmpdir, ignore_errors=True)
    except Exception:
        pass
