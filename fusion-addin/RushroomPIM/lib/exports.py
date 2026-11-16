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
"""
import os
import tempfile
from typing import Optional

import adsk.core
import adsk.fusion

ATTR_GROUP = "RushroomPIM"
ATTR_COMPONENT_ID = "pim_component_id"
ATTR_PART_NUMBER = "pim_part_number"


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


def set_stamp(component: adsk.fusion.Component, pim_component_id: str, pim_part_number: str) -> None:
    """Write PIM identity attributes on the component."""
    attrs = component.attributes
    attrs.add(ATTR_GROUP, ATTR_COMPONENT_ID, pim_component_id)
    attrs.add(ATTR_GROUP, ATTR_PART_NUMBER, pim_part_number)


def export_formats(component: adsk.fusion.Component, formats: list[str]) -> tuple[dict, str]:
    """
    Export the component in the requested formats to a temp directory.
    formats: subset of ["f3z", "step", "glb"]
    Returns ({ format: filepath }, tmpdir).  The caller must clean up tmpdir.

    f3z  — full Fusion archive of the DOCUMENT (component selection is ignored;
            the whole doc is archived because .f3z is a document-level format)
    step — STEP AP214 of the component (or the root if component is root)
    glb  — binary glTF 2.0 of the component (requires Fusion 360 ≥ 2.0.17000)
    """
    design = get_design()
    em = design.exportManager
    # Sanitise the component name for use as a filename.
    safe_name = "".join(c if c.isalnum() or c in "-_. " else "_" for c in component.name)[:50].strip()
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
