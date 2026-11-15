# CAD file repository — native Fusion files keyed by PIM IDs

Status: **draft** · 2026-11-15 · companion to `PLANNER-KEY-FLOW.md` (D5: CAD is out of the order path; this is the engineering path).

## The question

Where do the actual Fusion files live, and how are they tied to a BOM node in the PIM so that a part number means one geometry?

## What is already true

- **Fusion is cloud-native.** A design's working copy and its version history live in Autodesk Fusion Team (the hub). `.f3d` / `.f3z` are exports, not the master. Working "from a folder" means Fusion's offline/local mode, which gives up Fusion Team's versions, references between documents and sharing.
- The hub today has three projects: **Assets**, **Serie D**, **VALCYRA Electronics** (created 2026-11-12/13).
- The PIM already has a file pattern that works: a revision table whose rows point at a file in the `documents` bucket, uploaded through a signed URL, linked many-to-many to `bom_components` (`drawings` / `drawing_revisions` / `drawing_components`, migration 0032). Revisions are letters, immutable once released.
- Blender (and so Studio) derives its objects from Fusion geometry.

## Options for the repository of actual files

| | Master copy of the native file | Verdict |
|---|---|---|
| A | **Fusion Team** (as today); the PIM is the registry and the archive of released exports | **Recommended** — see below |
| B | PIM storage (Supabase bucket) holds the `.f3d`; Fusion opens local copies | Fights the tool: no Fusion versions, no external references, every save is a manual export; two people cannot work on one assembly |
| C | Git (LFS) | Binary CAD in git: no viewer, no Fusion integration, repository bloat; solves nothing B does not |
| D | Google Drive / SharePoint folder tree named by part number | A second copy with no link to revisions or the resolver; drifts on the first rename |

Fusion Team must stay the master because Fusion will not let it be anything else without losing what makes Fusion useful. Everything else is about **how the PIM points at it and what the PIM keeps**.

## Architecture (option A)

```
Fusion Team (hub)                        PIM (E&C Gateway)                      Consumers
──────────────────                       ─────────────────                      ─────────
project  ↔ product family / shared       bom_components.id  ─┐                  Blender / Studio
  folder ↔ assembly                                          │ 1:1 registry     suppliers (STEP, drawings)
    design document ↔ BOM node  ◄────────── cad_models ───────┘                  DPP (what geometry shipped)
      Part Number property = PIM part_number                                     compliance (what was built)
      version N  ──release export──►  cad_model_files (rev, format, storage_path)
                                          in bucket "documents", prefix cad/<component_id>/<rev>/
```

### 1. One Fusion design document per BOM node

- A **part** is one Fusion design. An **assembly** is one Fusion design whose components are *external references* to the part documents (Fusion "distributed design"). That mirrors the BOM exactly: `bom_edges` parent→child is the reference graph, and a part used in five assemblies is one document, as it is one `bom_components` row.
- The Fusion document name is the PIM part number, then the name: `RR-202609-3FZE3P4Z · Drawer front L white`. The component's **Part Number** property (Fusion's own field, exported in its BOM) is set to the PIM part number; **Description** to the PIM name. That is the Fusion → PIM link and it survives copies, exports and STEP.
- Fusion projects follow the PIM's top level: `Serie D` = the product family, `Assets` = shared and purchased parts (fittings, handles, Hettich hardware — supplier STEP files imported once, under the PIM part number), `VALCYRA Electronics` = the LED and electronics parts. Folders inside a project follow assemblies.

### 2. The PIM is the registry

New tables, same shape as drawings (both `organization_id NOT NULL`, both in `TENANT_TABLES`):

- `cad_models` — one row per BOM node that has geometry: `component_id` (unique), `fusion_project_id`, `fusion_document_id` (the lineage URN, stable across versions), `fusion_document_name`, `current_revision_id`, `status` (`draft | released | superseded`).
- `cad_model_files` — one row per released revision and format: `cad_model_id`, `revision` (letter, same rule as drawings), `fusion_version` (the integer Fusion shows), `format` (`f3d | step | glb | dxf`), `storage_path`, `file_name`, `sha256`, `released_at`, `created_by`.

PIM → Fusion is the `fusion_document_id`; Fusion → PIM is the Part Number property. Both directions, no name matching.

### 3. The PIM is the archive of released exports

On release of a revision, Fusion exports and the PIM stores, per revision: `.f3z` (the native archive with references, so the geometry can be reopened without the hub), `.step` (suppliers, long-term neutral), `.glb` (Blender / Studio). Draft versions are not archived — Fusion Team keeps those. A released revision is immutable, like a drawing revision; a change is the next letter.

This archive is the single feed for every derivative: Blender imports `cad/<component_id>/<rev>/*.glb`, suppliers get `.step` through the supplier portal (same `is_supplier_visible` switch as drawings), the DPP records which revision shipped.

### 4. How files move

- **Phase 1 — Fusion script, same signed-URL path as drawings.** A small Fusion add-in (Python, Fusion API) run on a released document: reads the Part Number property, exports the three formats, calls portal-api `cadUploadUrl` (sibling of `docUploadUrl`) and `registerCadRevision`. One click per release. The script can also stamp the Part Number / Description from the PIM (`getComponent`) so the stamping is never typed by hand.
- **Phase 2 — server-side pull through Autodesk Platform Services** (Data Management API, OAuth on the team hub): the PIM lists a document's versions and fetches exports without anyone in Fusion. Heavier (APS app, hub admin consent); worth it once releases are frequent.

### 5. Rules

1. A BOM node is created in the PIM first (same principle as `PLANNER-KEY-FLOW.md` D2); the Fusion document is created for it and stamped with its part number. A Fusion document with no PIM part number is a sketch, not a part.
2. One document per node, one node per document. A variant that is a different part number is a different document (copy, re-stamp).
3. Released geometry is immutable in the PIM. Fusion may keep editing; nothing the PIM, Blender or a supplier holds changes until the next letter is released.
4. The PIM never stores a draft. Fusion Team is the only place in-progress geometry lives.

## Open questions

1. **Hub type.** Is the current hub a personal hub or a team hub? APS (phase 2) and fine-grained sharing need a team hub; check before more documents are created.
2. **Purchased parts.** A Hettich STEP in `Assets` under the PIM part number, or kept only as a supplier document in the PIM and referenced from assemblies? Suggest: imported into Fusion once (assemblies need the geometry), registered in `cad_models` like anything else, with `status` noting it is supplier-owned.
3. **Revision letter vs Fusion version.** Fusion versions bump on every save; PIM letters bump on release. The registry stores both; the rule above makes letters the ones that mean anything outside Fusion. Agree?
4. **Blender's unit.** Does Blender import per part and assemble in Blender, or import the assembly `.glb`? Decides whether assembly exports are needed at all for Studio.
5. **Existing files.** What is in `Serie D` today and under which names — the migration is renaming and stamping, no re-modelling.

## Carry forward (2026-11-15 discussion — supersedes the structure parts above; rewrite pending)

- **Identity, not structure.** One identifier per part across Fusion, Blender and the portal: the UUID for machines, the part number for people and for files. The part number must become immutable. Fusion assemblies are free and need not match the PIM BOM.
- **The engineering BOM lives only in Fusion.** The PIM BOM is shaped by operations and installation (hub, site, kits) — rare, and worth protecting. No structure sync, no reconciliation at release.
- **Blender has two layers.** *Geometry layer*: 1:1 with Fusion, pulled automatically by identifier (GLB hierarchy; mesh swapped in place; appearance stays Blender's). *Option layer*: the planner's swappable units — module, interior, door, side panel, cover — as collections referencing geometry nodes.
- **The cut line is the sellable-option boundary.** Draw Fusion sub-assemblies at that level and the Fusion sub-assembly, the Blender swappable unit and the PIM assembly behind a planner key coincide. Above the line the planner's needs; below it engineering and the hub stay free. Shared parts across options are the case to design for.
- **Changes flow one way:** Fusion release → portal archive → Blender pulls → Studio via a core release. A release lists its dependents (drawings, operations, mappings, used-in).
- **AI proposes gaps, people accept.** Possible only because the identifier is hard.

## Not in this design

- Fusion drawings as drawings: the existing `drawings` domain stays; a Fusion-generated 2D drawing is uploaded there like any other.
- CAM, simulation, electronics schematics (Fusion Electronics in `VALCYRA Electronics`) — same registry pattern later if needed.
- Any change to the order path (`PLANNER-KEY-FLOW.md`).
