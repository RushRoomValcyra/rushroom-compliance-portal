-- 0032_drawings_domain.sql — PROP-045: drawings as a first-class domain
-- ============================================================================
-- A drawing is not a file about a part. It has its own identity (drawing
-- number), its own controlled revision sequence (letters, not v1/v2), an
-- approval state, and relationships to other drawings and to the assemblies it
-- depicts. None of that fits component_documents, and no amount of AI layered
-- on a file-link table produces it — a tolerance stack-up is an ordered path
-- across dimensions on several drawings for several parts, which that table
-- cannot express at all.
--
-- Timing is the argument for doing this now: component_documents holds ZERO
-- rows in production. There is nothing to migrate today. The same carve-out
-- after a year of drawings is a re-linking project with a retraining problem.

-- PostgreSQL has no CREATE TYPE IF NOT EXISTS; the guarded block matches the
-- pattern established in 0004 so a re-run of this migration is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'drawing_status') THEN
    CREATE TYPE drawing_status AS ENUM
      ('draft', 'checked', 'approved', 'released', 'superseded');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS drawings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  drawing_number      VARCHAR(80)  NOT NULL,
  title               VARCHAR(200) NOT NULL,
  -- Denormalised pointer to the newest revision. Derivable by query, but it is
  -- read on every register row and written by exactly one action.
  current_revision_id UUID,
  status              drawing_status NOT NULL DEFAULT 'draft',
  projection_angle    VARCHAR(10),   -- 'first' | 'third'
  sheet_size          VARCHAR(10),   -- A0..A4
  scale               VARCHAR(20),
  -- Manufacturing partners need drawings, so this defaults to TRUE. It is a
  -- per-drawing switch rather than a global one so a confidential drawing can
  -- be withheld without a deploy. Per-supplier selectivity is the expected
  -- next step; see the choke point in portal-api (supplierDrawingScope).
  is_supplier_visible BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES users(id),
  UNIQUE (organization_id, drawing_number)
);
ALTER TABLE drawings ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_drawings_org_number ON drawings (organization_id, drawing_number);
CREATE INDEX IF NOT EXISTS idx_drawings_supplier   ON drawings (organization_id, is_supplier_visible);

CREATE TABLE IF NOT EXISTS drawing_revisions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  drawing_id       UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
  revision         VARCHAR(10) NOT NULL,   -- 'A', 'B', … 'AA' — letters, not v1
  -- The file sits in the same storage bucket as documents and is uploaded
  -- through the same signed-URL action, but it deliberately gets NO
  -- document_versions row: that table drives the Documents Library, and a
  -- drawing appearing in the library is exactly what this proposal removes.
  -- One revision chain, not two over the same file.
  storage_path     TEXT NOT NULL,
  file_name        TEXT NOT NULL,
  notes            TEXT,
  status           drawing_status NOT NULL DEFAULT 'draft',
  released_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID REFERENCES users(id),
  UNIQUE (organization_id, drawing_id, revision)
);
ALTER TABLE drawing_revisions ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_drawing_revisions_drawing
  ON drawing_revisions (organization_id, drawing_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drawings_current_revision_fk') THEN
    ALTER TABLE drawings
      ADD CONSTRAINT drawings_current_revision_fk
      FOREIGN KEY (current_revision_id) REFERENCES drawing_revisions(id);
  END IF;
END$$;

-- Many-to-many on purpose: a detail drawing shows one part, an assembly
-- drawing shows a whole sub-assembly, and one part may carry detail,
-- installation and wiring drawings at once.
CREATE TABLE IF NOT EXISTS drawing_components (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  drawing_id       UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
  component_id     UUID NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  role             VARCHAR(20) NOT NULL DEFAULT 'depicts',  -- depicts|installation|wiring
  linked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_by        UUID REFERENCES users(id),
  UNIQUE (organization_id, drawing_id, component_id, role)
);
ALTER TABLE drawing_components ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_drawing_components_component
  ON drawing_components (organization_id, component_id);
CREATE INDEX IF NOT EXISTS idx_drawing_components_drawing
  ON drawing_components (organization_id, drawing_id);

-- Populated by the AI extraction that follows shortly. It ships now so that
-- work adds behaviour rather than schema, and so tolerance chains have a row
-- type to reference: a stack-up is an ordered path over these rows.
CREATE TABLE IF NOT EXISTS drawing_dimensions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id),
  drawing_revision_id   UUID NOT NULL REFERENCES drawing_revisions(id) ON DELETE CASCADE,
  feature_label         VARCHAR(80),
  nominal               NUMERIC(12,4),
  upper_tolerance       NUMERIC(12,4),
  lower_tolerance       NUMERIC(12,4),
  unit                  VARCHAR(10) NOT NULL DEFAULT 'mm',
  datum                 VARCHAR(20),
  is_general_tolerance  BOOLEAN NOT NULL DEFAULT FALSE,
  -- NULL = entered by hand. high|medium|low = extracted, and the UI must say so:
  -- an engineer is right to distrust an AI-read tolerance on a safety part.
  extraction_confidence VARCHAR(10),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE drawing_dimensions ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_drawing_dimensions_revision
  ON drawing_dimensions (organization_id, drawing_revision_id);

-- Drawing events join the BOM node trail PROP-043 built. As there, the history
-- insert is non-fatal by design, so this CHECK must be widened BEFORE the
-- function deploy or the rows fail silently.
ALTER TABLE bom_component_history DROP CONSTRAINT IF EXISTS bom_component_history_change_type_check;
ALTER TABLE bom_component_history ADD CONSTRAINT bom_component_history_change_type_check
  CHECK (change_type IN (
    'created','updated','version_bumped','document_linked','document_revised',
    'drawing_linked','drawing_revised','drawing_released'
  ));
