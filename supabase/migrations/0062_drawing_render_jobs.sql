-- 0062_drawing_render_jobs.sql — drawings rendered from CAD by a worker
-- ============================================================================
-- docs/DRAWING_RENDER.md. A drawing is a derived document: every number on it
-- comes from the STEP file of a named CAD revision. The portal already records
-- the fact on the issue (drawing_revisions.source_cad_file_id / source_sha256,
-- STATUS_MODEL §5.4) and the generator already exists (drawset.py + a YAML spec
-- per part family), but the two were joined by hand: run drawset, find the
-- PDF, upload it through the New drawing modal, and the "made from" fact was
-- never written. After this the engineer presses "Drawing from Rev B" on the
-- CAD register and the issue that appears is provably derived from Rev B.
--
-- The geometry kernel (OCP) cannot run in an edge function, so the render runs
-- on the Mac that has it, as a worker polling the portal — the pattern the CAD
-- test agent proved (0061, cad_test_runs). One row per requested render; the
-- worker claims it, reports its steps, uploads the PDF and finishes it; the
-- portal then registers the issue through the same code addDrawingRevision
-- uses, so there is one rule for "a new issue on a drawing".
--
-- Statuses:   requested → running → done | failed
--             requested → cancelled        (by hand, before a worker claims it)
--             requested → timed_out        (no worker claimed it within 120 s)
--             running   → failed           (no report for 15 min: "worker stopped reporting")
--
-- Two tables: the job log, and the worker's spec catalogue (so the modal can
-- offer specs without asking the worker). Both org-scoped (organization_id NOT
-- NULL, TENANT_TABLES, RLS deny-all). The STATUS_MODEL drop migration, which
-- had reserved this number, moves to 0063.
--
-- Re-runnable: IF NOT EXISTS everywhere.

CREATE TABLE IF NOT EXISTS drawing_render_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id),
  -- The part drawn. A deleted part takes its render log with it.
  component_id          UUID NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  -- The CAD revision drawn from and its STEP file. A job without its source
  -- means nothing, so both cascade.
  cad_model_revision_id UUID NOT NULL REFERENCES cad_model_revisions(id) ON DELETE CASCADE,
  cad_file_id           UUID NOT NULL REFERENCES cad_model_files(id) ON DELETE CASCADE,
  -- The target drawing: existing, or created by this job (created_drawing).
  -- Nullable with SET NULL rather than NOT NULL + CASCADE: a job that created
  -- its drawing and then failed before an issue existed deletes that drawing
  -- again (no half-made drawing is left), and the failed job must survive the
  -- deletion so the panel polling it can show WHY it failed. While a job is
  -- requested or running the column is always set (the partial unique index
  -- below depends on it).
  drawing_id            UUID REFERENCES drawings(id) ON DELETE SET NULL,
  created_drawing       BOOLEAN NOT NULL DEFAULT FALSE,
  -- drawset spec name: the YAML file stem (side_panel_left).
  spec                  TEXT NOT NULL,
  -- The letter reserved at request: nextRevisionLetter of the drawing's
  -- issues (A for a new drawing). finishDrawingRender refuses to register if
  -- an issue was added meanwhile — the job fails with that reason.
  issue                 VARCHAR(10) NOT NULL,
  status                TEXT NOT NULL DEFAULT 'requested'
                        CHECK (status IN ('requested', 'running', 'done', 'failed', 'timed_out', 'cancelled')),
  requested_by          UUID REFERENCES users(id),
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at            TIMESTAMPTZ,
  -- "drawing-worker · MacBook" — whatever the worker says about itself.
  claimed_by            TEXT,
  finished_at           TIMESTAMPTZ,
  -- [{ key, label, status, detail, at, data }] in the contract's fixed order:
  -- claim · download · render · verify · upload · register.
  steps                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- { drawing_revision_id, file_name, sha256, pages, dimension_list_sha256,
  --   spec_sha256, drawset_version, verify_ok } once done.
  result                JSONB,
  -- The one-line reason when status is failed / timed_out.
  error                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE drawing_render_jobs ENABLE ROW LEVEL SECURITY;

-- The poll: "oldest requested job in this org" — and the lazy timeouts.
CREATE INDEX IF NOT EXISTS idx_drawing_render_jobs_poll
  ON drawing_render_jobs (organization_id, status, requested_at);
-- A drawing's own render history and a part's.
CREATE INDEX IF NOT EXISTS idx_drawing_render_jobs_drawing
  ON drawing_render_jobs (organization_id, drawing_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_drawing_render_jobs_component
  ON drawing_render_jobs (organization_id, component_id, requested_at DESC);
-- One render per drawing at a time, held by the database and not only by the
-- read-then-insert in requestDrawingRender. Two parts may render at once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_drawing_render_jobs_one_open
  ON drawing_render_jobs (organization_id, drawing_id) WHERE status IN ('requested', 'running');

-- The worker's spec catalogue: registered on start and every 10 min, so the
-- modal offers the specs that exist without a round trip to the worker.
-- Specs no longer in the worker's list are deleted for the org on register.
CREATE TABLE IF NOT EXISTS drawing_render_specs (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  -- The YAML file stem.
  name            TEXT NOT NULL,
  title           TEXT,
  -- How many `parts:` the spec has. A render job draws one part; the modal
  -- can hide or mark multi-part specs.
  parts           INTEGER,
  -- The RR numbers found in the spec's parts[].step file names — how the
  -- modal preselects a spec by part number.
  part_numbers    JSONB,
  -- Who registered it.
  agent           TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, name)
);
ALTER TABLE drawing_render_specs ENABLE ROW LEVEL SECURITY;

-- The spec last used for this drawing; preselected next time.
ALTER TABLE drawings ADD COLUMN IF NOT EXISTS render_spec TEXT;
