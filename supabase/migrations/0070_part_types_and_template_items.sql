-- 0070_part_types_and_template_items.sql — Drawing Templates phase 1
-- ============================================================================
-- docs/DRAWING_TEMPLATES.md §10.1, §12 row 1.
-- part_types: what kind of panel a part is; a type later owns a template level.
-- drawing_template_items: the queue for portal-born renders that write no drawing
-- (phase 1 uses purpose 'reference' only). The render job gains mode 'sandbox'.
-- The history CHECK is widened FIRST: the history insert for a type change is
-- checked by the function, but older inserts are non-fatal (see 0067's note).
--
-- Both new tables carry organization_id NOT NULL, sit in TENANT_TABLES and are
-- RLS deny-all. The CAD file table is cad_model_files (0059); there is no
-- cad_files table. Re-runnable: IF NOT EXISTS everywhere, and every added
-- constraint is dropped first.

-- 1. History event ------------------------------------------------------------
ALTER TABLE bom_component_history DROP CONSTRAINT IF EXISTS bom_component_history_change_type_check;
ALTER TABLE bom_component_history ADD CONSTRAINT bom_component_history_change_type_check
  CHECK (change_type IN (
    'created','updated','version_bumped','document_linked','document_revised',
    'drawing_linked','drawing_revised','drawing_released','drawing_adopted',
    'drawing_deleted','cad_deleted','part_type_changed'
  ));

-- 2. part_types ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS part_types (
  id                               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id                  UUID NOT NULL REFERENCES organizations(id),
  -- Immutable: the catalogue name a type's template level will carry.
  key                              TEXT NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,59}$'),
  name                             VARCHAR(80) NOT NULL CHECK (length(btrim(name)) > 0),
  sheet_family                     TEXT NOT NULL DEFAULT 'flat_panel'
                                   CHECK (sheet_family IN ('flat_panel', 'door')),
  sort_order                       INTEGER NOT NULL DEFAULT 100,
  -- The reference: one part, one released CAD revision, its STEP and its bytes.
  -- All four or none.
  reference_component_id           UUID REFERENCES bom_components(id),
  reference_cad_model_revision_id  UUID REFERENCES cad_model_revisions(id),
  reference_cad_file_id            UUID REFERENCES cad_model_files(id),
  reference_sha256                 VARCHAR(64),
  reference_set_at                 TIMESTAMPTZ,
  reference_set_by                 UUID REFERENCES users(id),
  retired_at                       TIMESTAMPTZ,
  retired_by                       UUID REFERENCES users(id),
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                       UUID REFERENCES users(id),
  CONSTRAINT part_types_reference_whole CHECK (
    (reference_component_id IS NULL AND reference_cad_model_revision_id IS NULL
       AND reference_cad_file_id IS NULL AND reference_sha256 IS NULL)
    OR
    (reference_component_id IS NOT NULL AND reference_cad_model_revision_id IS NOT NULL
       AND reference_cad_file_id IS NOT NULL AND reference_sha256 IS NOT NULL)
  ),
  UNIQUE (organization_id, key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_part_types_org_name ON part_types (organization_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_part_types_reference ON part_types (reference_component_id)
  WHERE reference_component_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_part_types_reference_rev ON part_types (reference_cad_model_revision_id)
  WHERE reference_cad_model_revision_id IS NOT NULL;
ALTER TABLE part_types ENABLE ROW LEVEL SECURITY;

-- Seed the owner's seven types for every existing organisation (0027 precedent).
INSERT INTO part_types (organization_id, key, name, sheet_family, sort_order)
SELECT o.id, v.key, v.name, v.sheet_family, v.sort_order
FROM organizations o
CROSS JOIN (VALUES
  ('side_panel', 'Side panel', 'flat_panel', 10),
  ('shelf',      'Shelf',      'flat_panel', 20),
  ('door',       'Door',       'door',       30),
  ('plinth',     'Plinth',     'flat_panel', 40),
  ('back_panel', 'Back panel', 'flat_panel', 50),
  ('bottom',     'Bottom',     'flat_panel', 60),
  ('top',        'Top',        'flat_panel', 70)
) AS v(key, name, sheet_family, sort_order)
ON CONFLICT (organization_id, key) DO NOTHING;

-- 3. Part type on a part ------------------------------------------------------
ALTER TABLE bom_components
  ADD COLUMN IF NOT EXISTS part_type_id UUID REFERENCES part_types(id);
CREATE INDEX IF NOT EXISTS idx_bom_components_part_type ON bom_components (part_type_id)
  WHERE part_type_id IS NOT NULL;

-- 4. Template level on the catalogue ------------------------------------------
-- Named `level`, not `kind`: the catalogue reader already overwrites `kind`
-- with the version's. portal_owned rows are never touched by the worker's
-- registration (none exist in phase 1).
ALTER TABLE drawing_render_specs
  ADD COLUMN IF NOT EXISTS level        TEXT NOT NULL DEFAULT 'legacy'
                                        CHECK (level IN ('base', 'type', 'legacy')),
  ADD COLUMN IF NOT EXISTS part_type_id UUID REFERENCES part_types(id),
  ADD COLUMN IF NOT EXISTS portal_owned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE drawing_render_specs DROP CONSTRAINT IF EXISTS drawing_render_specs_level_shape;
ALTER TABLE drawing_render_specs ADD CONSTRAINT drawing_render_specs_level_shape CHECK (
  (level = 'type' AND part_type_id IS NOT NULL) OR (level <> 'type' AND part_type_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_drawing_render_specs_one_per_type
  ON drawing_render_specs (organization_id, part_type_id) WHERE part_type_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_drawing_render_specs_one_base
  ON drawing_render_specs (organization_id) WHERE level = 'base';
UPDATE drawing_render_specs SET level = 'base' WHERE name = 'flat_panel';

-- 5. drawing_template_items ---------------------------------------------------
CREATE TABLE IF NOT EXISTS drawing_template_items (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID NOT NULL REFERENCES organizations(id),
  purpose                TEXT NOT NULL
                         CHECK (purpose IN ('reference','features','catch','try','preview','rebase')),
  part_type_id           UUID REFERENCES part_types(id) ON DELETE CASCADE,
  -- The template version rendered on; pinned so a later Base change does not
  -- silently alter what a done item showed.
  spec_version_id        UUID REFERENCES drawing_spec_versions(id),
  component_id           UUID REFERENCES bom_components(id) ON DELETE CASCADE,
  cad_model_revision_id  UUID REFERENCES cad_model_revisions(id) ON DELETE CASCADE,
  cad_file_id            UUID REFERENCES cad_model_files(id) ON DELETE CASCADE,
  cad_sha256             VARCHAR(64),
  drawing_id             UUID REFERENCES drawings(id) ON DELETE SET NULL,
  drawing_revision_id    UUID REFERENCES drawing_revisions(id) ON DELETE SET NULL,
  spec_patch_id          UUID REFERENCES drawing_spec_patches(id),
  patch_sha256           VARCHAR(64),
  parts                  JSONB,
  status                 TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','running','done','failed','skipped','cancelled')),
  job_id                 UUID REFERENCES drawing_render_jobs(id) ON DELETE SET NULL,
  summary                JSONB,
  error                  TEXT,
  requested_by           UUID REFERENCES users(id),
  requested_by_label     TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  taken_at               TIMESTAMPTZ,
  finished_at            TIMESTAMPTZ,
  CONSTRAINT drawing_template_items_reference_shape CHECK (
    purpose <> 'reference' OR (
      part_type_id IS NOT NULL AND spec_version_id IS NOT NULL
      AND component_id IS NOT NULL AND cad_model_revision_id IS NOT NULL
      AND cad_file_id IS NOT NULL AND cad_sha256 IS NOT NULL
      AND drawing_id IS NULL AND drawing_revision_id IS NULL
      AND spec_patch_id IS NULL AND patch_sha256 IS NULL
    )
  ),
  CONSTRAINT drawing_template_items_part_shape CHECK (
    purpose = 'catch' OR (component_id IS NOT NULL AND cad_model_revision_id IS NOT NULL
                          AND cad_file_id IS NOT NULL AND cad_sha256 IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_drawing_template_items_queue
  ON drawing_template_items (organization_id, status, created_at) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS idx_drawing_template_items_type
  ON drawing_template_items (part_type_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_drawing_template_items_component
  ON drawing_template_items (component_id);
ALTER TABLE drawing_template_items ENABLE ROW LEVEL SECURITY;

-- 6. The render job: mode 'sandbox' and its shape -------------------------------
-- A sandbox job carries its item, the part, the CAD revision and file, and the
-- template version; it has no drawing, no letter, no patch, no replaced issue.
ALTER TABLE drawing_render_jobs ALTER COLUMN issue DROP NOT NULL;
ALTER TABLE drawing_render_jobs ALTER COLUMN spec  DROP NOT NULL;
ALTER TABLE drawing_render_jobs
  ADD COLUMN IF NOT EXISTS template_item_id UUID REFERENCES drawing_template_items(id) ON DELETE CASCADE;
ALTER TABLE drawing_render_jobs DROP CONSTRAINT IF EXISTS drawing_render_jobs_mode_check;
ALTER TABLE drawing_render_jobs ADD CONSTRAINT drawing_render_jobs_mode_check
  CHECK (mode IN ('issue', 'iterate', 'sandbox'));
ALTER TABLE drawing_render_jobs DROP CONSTRAINT IF EXISTS drawing_render_jobs_mode_shape;
ALTER TABLE drawing_render_jobs ADD CONSTRAINT drawing_render_jobs_mode_shape CHECK (
  (mode IN ('issue','iterate') AND issue IS NOT NULL AND spec IS NOT NULL AND template_item_id IS NULL)
  OR
  (mode = 'sandbox' AND template_item_id IS NOT NULL AND drawing_id IS NULL
     AND created_drawing = FALSE AND issue IS NULL AND spec_patch_id IS NULL
     AND replaces_revision_id IS NULL AND spec_version_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_drawing_render_jobs_one_open_item
  ON drawing_render_jobs (template_item_id)
  WHERE template_item_id IS NOT NULL AND status IN ('requested','running');
