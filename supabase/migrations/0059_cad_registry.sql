-- 0059_cad_registry.sql — Phase 1.2: CAD file registry
-- ============================================================================
-- A drawing is 2D instructions. A CAD model is 3D geometry. They answer
-- different questions and must not share a table. The connection is indirect:
-- a component has one CAD model and many drawings; the drawings are found
-- through drawing_components, not through cad_models.
--
-- component_id is NULLABLE so surgery-template jigs and other fixtures can be
-- registered here later without a migration. The uniqueness constraint is a
-- partial index on non-null values, so each component maps to at most one CAD
-- model while NULL rows (future fixtures) are unconstrained.
--
-- Multiple formats per revision (f3z / step / glb / dxf) are stored as
-- separate rows in cad_model_files, keyed by (cad_model_id, revision, format).
-- current_revision is the letter ('A', 'B', …) of the newest revision; reading
-- the current files is a query on that letter, not a FK chase.

CREATE TABLE IF NOT EXISTS cad_models (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      UUID NOT NULL REFERENCES organizations(id),
  -- Nullable: BOM components today; fixtures/jigs in a future step.
  component_id         UUID REFERENCES bom_components(id) ON DELETE SET NULL,
  fusion_project_id    VARCHAR(200),
  -- The Autodesk stable lineage URN — survives version bumps, copies, and
  -- project moves. The human-readable name is recorded separately because it
  -- can change; the URN is what identifies the document in the Fusion API.
  fusion_document_id   VARCHAR(400),
  fusion_document_name VARCHAR(400),
  current_revision     VARCHAR(10),    -- letter of the newest registered revision
  status               VARCHAR(20) NOT NULL DEFAULT 'draft',
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by           UUID REFERENCES users(id)
);
ALTER TABLE cad_models ENABLE ROW LEVEL SECURITY;
-- One CAD model per component per org. NULL component_id rows are excluded so
-- future fixture rows don't collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cad_models_component
  ON cad_models (organization_id, component_id) WHERE component_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cad_models_org
  ON cad_models (organization_id);

CREATE TABLE IF NOT EXISTS cad_model_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  cad_model_id    UUID NOT NULL REFERENCES cad_models(id) ON DELETE CASCADE,
  revision        VARCHAR(10) NOT NULL,   -- 'A', 'B', … same alphabet as drawings
  -- Fusion's own integer version counter at the moment of export. Stored for
  -- traceability — "which save did this glb come from" — not for logic.
  fusion_version  INTEGER,
  format          VARCHAR(10) NOT NULL,   -- f3z | step | glb | dxf
  storage_path    TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  sha256          VARCHAR(64),
  released_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES users(id),
  UNIQUE (organization_id, cad_model_id, revision, format)
);
ALTER TABLE cad_model_files ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_cad_model_files_model
  ON cad_model_files (organization_id, cad_model_id, revision);
