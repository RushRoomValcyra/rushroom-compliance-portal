-- 0071_template_sandboxes_and_catch.sql — Drawing Templates phase 2
-- ============================================================================
-- docs/DRAWING_TEMPLATES.md §3, §4.4, §5.2, §10.1, §12 row 2 ("Rules he can see").
-- drawing_template_changes: the sandbox of a part type's rules (rev is its 409 guard).
-- drawing_template_marks:   a hole clicked on a part, where a rule came from.
-- cad_feature_cache:        a STEP's raw features (before edges and classify),
--                           so a catch needs no STEP download and no render.
-- drawing_template_items gains the sandbox it belongs to and its request.
-- The render job gains modes 'features' (one CAD file, no render) and 'catch'
-- (no single part: the job's part and CAD columns may be empty for it only).
--
-- Every new table carries organization_id NOT NULL, sits in TENANT_TABLES and
-- is RLS deny-all. Re-runnable: IF NOT EXISTS everywhere, and every added
-- constraint is dropped first.

-- 1. drawing_template_changes (the sandbox) -------------------------------------
CREATE TABLE IF NOT EXISTS drawing_template_changes (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID NOT NULL REFERENCES organizations(id),
  part_type_id             UUID NOT NULL REFERENCES part_types(id) ON DELETE CASCADE,
  name                     VARCHAR(80) NOT NULL CHECK (length(btrim(name)) > 0),
  -- The type version it started from; no type version exists in phase 2.
  started_from_version_id  UUID REFERENCES drawing_spec_versions(id),
  -- The rule body it started from ({ rules, edges }); body = start + operations.
  start_body               JSONB NOT NULL,
  operations               JSONB NOT NULL DEFAULT '[]'::jsonb,
  body                     JSONB NOT NULL,
  body_sha256              VARCHAR(64),
  request                  TEXT,
  origin                   TEXT NOT NULL DEFAULT 'page' CHECK (origin IN ('page', 'drawing', 'restore')),
  from_drawing_id          UUID REFERENCES drawings(id) ON DELETE SET NULL,
  state                    TEXT NOT NULL DEFAULT 'sandbox'
                           CHECK (state IN ('sandbox', 'put_forward', 'saved', 'discarded')),
  rev                      INTEGER NOT NULL DEFAULT 1,
  try_component_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by               UUID REFERENCES users(id),
  created_by_label         TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_drawing_template_changes_type
  ON drawing_template_changes (organization_id, part_type_id, state, created_at DESC);
-- One put forward per rule set (§10.1).
CREATE UNIQUE INDEX IF NOT EXISTS idx_drawing_template_changes_one_put_forward
  ON drawing_template_changes (organization_id, part_type_id) WHERE state = 'put_forward';
ALTER TABLE drawing_template_changes ENABLE ROW LEVEL SECURITY;

-- 2. drawing_template_marks -----------------------------------------------------
CREATE TABLE IF NOT EXISTS drawing_template_marks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  change_id        UUID NOT NULL REFERENCES drawing_template_changes(id) ON DELETE CASCADE,
  -- The rule the mark became, when it became one.
  rule_id          TEXT,
  component_id     UUID NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  -- The STEP bytes the hole id belongs to: a hole id means nothing on other bytes.
  cad_sha256       VARCHAR(64) NOT NULL,
  hole_id          TEXT NOT NULL,
  -- By place, never by coordinates (describeHole).
  description      TEXT,
  -- { sheet, x_mm, y_mm } where it was clicked, when on paper.
  paper            JSONB,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_drawing_template_marks_change
  ON drawing_template_marks (change_id, created_at);
ALTER TABLE drawing_template_marks ENABLE ROW LEVEL SECURITY;

-- 3. cad_feature_cache ----------------------------------------------------------
-- The raw features of one STEP's bytes, read by fusion_scripts/catch.py; valid
-- for every type's edges. features_format is catch.py's FEATURES_FORMAT (and
-- render-job-core's): a new format is a new row, never an overwrite.
CREATE TABLE IF NOT EXISTS cad_feature_cache (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  cad_file_id      UUID NOT NULL REFERENCES cad_model_files(id) ON DELETE CASCADE,
  sha256           VARCHAR(64) NOT NULL,
  features_format  INTEGER NOT NULL,
  features         JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cad_file_id, sha256, features_format)
);
ALTER TABLE cad_feature_cache ENABLE ROW LEVEL SECURITY;

-- 4. drawing_template_items: the sandbox and the request ------------------------
ALTER TABLE drawing_template_items
  ADD COLUMN IF NOT EXISTS change_id UUID REFERENCES drawing_template_changes(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS request   JSONB;
CREATE INDEX IF NOT EXISTS idx_drawing_template_items_change
  ON drawing_template_items (change_id, created_at DESC) WHERE change_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drawing_template_items_file
  ON drawing_template_items (cad_file_id, purpose, status) WHERE cad_file_id IS NOT NULL;
-- A features item reads one CAD file and writes no drawing.
ALTER TABLE drawing_template_items DROP CONSTRAINT IF EXISTS drawing_template_items_features_shape;
ALTER TABLE drawing_template_items ADD CONSTRAINT drawing_template_items_features_shape CHECK (
  purpose <> 'features' OR (
    component_id IS NOT NULL AND cad_model_revision_id IS NOT NULL
    AND cad_file_id IS NOT NULL AND cad_sha256 IS NOT NULL
    AND drawing_id IS NULL AND drawing_revision_id IS NULL
    AND spec_patch_id IS NULL AND patch_sha256 IS NULL
  )
);
-- A catch item belongs to a sandbox and carries its part list, no single part.
ALTER TABLE drawing_template_items DROP CONSTRAINT IF EXISTS drawing_template_items_catch_shape;
ALTER TABLE drawing_template_items ADD CONSTRAINT drawing_template_items_catch_shape CHECK (
  purpose <> 'catch' OR (
    change_id IS NOT NULL AND parts IS NOT NULL
    AND component_id IS NULL AND cad_model_revision_id IS NULL
    AND cad_file_id IS NULL AND cad_sha256 IS NULL
    AND drawing_id IS NULL AND drawing_revision_id IS NULL
    AND spec_patch_id IS NULL AND patch_sha256 IS NULL
  )
);

-- 5. The render job: modes 'features' and 'catch' and their shapes -------------
-- The part and CAD columns become nullable for 'catch' only; every other mode
-- keeps them required through the shape CHECK.
ALTER TABLE drawing_render_jobs ALTER COLUMN component_id          DROP NOT NULL;
ALTER TABLE drawing_render_jobs ALTER COLUMN cad_model_revision_id DROP NOT NULL;
ALTER TABLE drawing_render_jobs ALTER COLUMN cad_file_id           DROP NOT NULL;
ALTER TABLE drawing_render_jobs DROP CONSTRAINT IF EXISTS drawing_render_jobs_mode_check;
ALTER TABLE drawing_render_jobs ADD CONSTRAINT drawing_render_jobs_mode_check
  CHECK (mode IN ('issue', 'iterate', 'sandbox', 'features', 'catch'));
ALTER TABLE drawing_render_jobs DROP CONSTRAINT IF EXISTS drawing_render_jobs_mode_shape;
ALTER TABLE drawing_render_jobs ADD CONSTRAINT drawing_render_jobs_mode_shape CHECK (
  (mode IN ('issue','iterate') AND issue IS NOT NULL AND spec IS NOT NULL AND template_item_id IS NULL
     AND component_id IS NOT NULL AND cad_model_revision_id IS NOT NULL AND cad_file_id IS NOT NULL)
  OR
  (mode = 'sandbox' AND template_item_id IS NOT NULL AND drawing_id IS NULL
     AND created_drawing = FALSE AND issue IS NULL AND spec_patch_id IS NULL
     AND replaces_revision_id IS NULL AND spec_version_id IS NOT NULL
     AND component_id IS NOT NULL AND cad_model_revision_id IS NOT NULL AND cad_file_id IS NOT NULL)
  OR
  (mode = 'features' AND template_item_id IS NOT NULL AND drawing_id IS NULL
     AND created_drawing = FALSE AND issue IS NULL AND spec IS NULL AND spec_patch_id IS NULL
     AND replaces_revision_id IS NULL
     AND component_id IS NOT NULL AND cad_model_revision_id IS NOT NULL AND cad_file_id IS NOT NULL)
  OR
  (mode = 'catch' AND template_item_id IS NOT NULL AND drawing_id IS NULL
     AND created_drawing = FALSE AND issue IS NULL AND spec IS NULL AND spec_patch_id IS NULL
     AND replaces_revision_id IS NULL)
);
