-- 0068_drawing_spec_governance.sql — the drawing spec becomes a governed document
-- ============================================================================
-- docs/DYNAMIC_DRAWINGS.md §3, §5.5 (the design numbers this 0067; 0067 was
-- taken by delete_history_events, so it is 0068 here). Until now a drawing's
-- spec lived only as a YAML file on the Mac that runs drawset: the portal knew
-- its name (drawing_render_specs.name, drawings.render_spec) and the job kept
-- a spec_sha256 in its result, but nothing could say WHICH body produced an
-- issue, and nothing could change one dimension's tolerance without editing
-- the YAML by hand and rendering again. After this a drawing is a function of
-- three inputs — the CAD revision, a template version, a per-drawing patch —
-- and each issue pins all three.
--
--   drawing_spec_versions  the template bodies, immutable, one row per distinct
--                          body per name (the worker registers parsed YAML; the
--                          same body registers once).
--   drawing_spec_patches   the per-drawing patch, append-only and linear
--                          (seq 1, 2, … per drawing, parent_id the previous
--                          seq). A row is the whole snapshot after its ops,
--                          plus the ops and their provenance.
--   drawing_spec_turns     every dialogue turn, including the ones that produced
--                          nothing — refusal_categories feeds the backlog query
--                          "what does the vocabulary not cover".
--
-- All three org-scoped (organization_id NOT NULL, TENANT_TABLES, RLS deny-all).
-- The columns added to drawing_render_specs, drawing_render_jobs,
-- drawing_revisions and drawings are the pins and the job mode (§3.4, §5.3).
-- drawing_dimensions is NOT written in v1 (§9); the dimension list is a sidecar
-- under the job's render artefacts and a sha on the revision.
--
-- Re-runnable: IF NOT EXISTS everywhere.

-- ----------------------------------------------------------------------------
-- Template bodies. Immutable: there is no UPDATE path in code.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drawing_spec_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  -- The YAML file stem (side_panel_left, flat_panel).
  name            TEXT NOT NULL,
  -- 1, 2, … per name. Assigned by registerDrawingSpecs when a body it has not
  -- seen arrives.
  version         INTEGER NOT NULL,
  -- A template is reused across drawings through a patch; a part_spec is the
  -- old one-YAML-per-part form.
  kind            TEXT NOT NULL CHECK (kind IN ('template', 'part_spec')),
  -- The parsed YAML, stored canonical (keys sorted, no whitespace in the
  -- hashed form). body_sha256 is sha256 of canonicalJson(body) — the identity
  -- the worker echoes back on every job.
  body            JSONB NOT NULL,
  body_sha256     CHAR(64) NOT NULL,
  -- The worker agent that registered it ("drawing-worker · MacBook").
  registered_by   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The same body under the same name is one version, not two.
  UNIQUE (organization_id, name, body_sha256),
  UNIQUE (organization_id, name, version)
);
ALTER TABLE drawing_spec_versions ENABLE ROW LEVEL SECURITY;
-- "The versions of this template, newest first" — the explicit index the
-- design asks for; the UNIQUE above also covers the lookup.
CREATE INDEX IF NOT EXISTS idx_drawing_spec_versions_name
  ON drawing_spec_versions (organization_id, name, version);

-- ----------------------------------------------------------------------------
-- Dialogue turns. Created before the patches so the patch FK can point here.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drawing_spec_turns (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  -- A deleted drawing takes its dialogue with it; a deleted issue leaves the
  -- turn, which still says what was asked.
  drawing_id          UUID REFERENCES drawings(id) ON DELETE CASCADE,
  drawing_revision_id UUID REFERENCES drawing_revisions(id) ON DELETE SET NULL,
  -- What the engineer wrote, what they had marked on the sheet, and what the
  -- model proposed (the ops before the validator admitted or refused them).
  prompt              TEXT,
  selection           JSONB,
  proposal            JSONB,
  -- The refusal categories the proposal fell under (outside the vocabulary,
  -- bare number, title-block field, …) — for the backlog query.
  refusal_categories  TEXT[],
  model               TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  -- NULL undecided, true the ops were applied, false discarded.
  accepted            BOOLEAN,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE drawing_spec_turns ENABLE ROW LEVEL SECURITY;
-- A drawing's dialogue, newest first.
CREATE INDEX IF NOT EXISTS idx_drawing_spec_turns_drawing
  ON drawing_spec_turns (organization_id, drawing_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- The per-drawing patch. Append-only, linear per drawing.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drawing_spec_patches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  drawing_id      UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
  -- 1, 2, … per drawing. applyDrawingSpecOps answers 409 when the caller's
  -- parent seq is no longer the head.
  seq             INTEGER NOT NULL,
  -- The previous seq of the same drawing (NULL for seq 1).
  parent_id       UUID REFERENCES drawing_spec_patches(id),
  -- The template version this patch applies to — the base.
  spec_version_id UUID NOT NULL REFERENCES drawing_spec_versions(id),
  -- The whole snapshot after this seq's ops (§3.3: v:1, base, tolerances,
  -- datums, edge_names, edge_band, features, pairs, ctq, overrides, views,
  -- sheets). patch_sha256 is sha256 of canonicalJson(patch).
  patch           JSONB NOT NULL,
  patch_sha256    CHAR(64) NOT NULL,
  -- The ops that made this seq from its parent.
  operations      JSONB NOT NULL,
  -- click: layer 1 form · dialogue: layer 2 · carry: carried forward from a
  -- previous issue at rebase · hand: applyDrawingSpecOps called directly.
  origin          TEXT NOT NULL CHECK (origin IN ('click', 'dialogue', 'carry', 'hand')),
  -- Provenance when origin = dialogue.
  prompt          TEXT,
  selection       JSONB,
  proposal        JSONB,
  turn_id         UUID REFERENCES drawing_spec_turns(id) ON DELETE SET NULL,
  -- proposed: written, not yet rendered · candidate: rendered and verified ·
  -- accepted: the draft's file and pins moved to it · discarded · failed:
  -- the render or its verification failed, the draft untouched. "rendering"
  -- is derivable from job_id's status.
  status          TEXT NOT NULL DEFAULT 'proposed'
                  CHECK (status IN ('proposed', 'candidate', 'accepted', 'discarded', 'failed')),
  -- The iterate job that rendered this patch; the fact survives the job.
  job_id          UUID REFERENCES drawing_render_jobs(id) ON DELETE SET NULL,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, drawing_id, seq)
);
ALTER TABLE drawing_spec_patches ENABLE ROW LEVEL SECURITY;
-- The head of a drawing's patch chain and its history — the explicit index the
-- design asks for; the UNIQUE above also covers the lookup.
CREATE INDEX IF NOT EXISTS idx_drawing_spec_patches_drawing_seq
  ON drawing_spec_patches (organization_id, drawing_id, seq);

-- ----------------------------------------------------------------------------
-- Columns added: the pins and the job mode.
-- ----------------------------------------------------------------------------

-- The catalogue row points at the version the worker registered last; template
-- marks a spec that is reused through a patch (versus a one-part spec).
ALTER TABLE drawing_render_specs
  ADD COLUMN IF NOT EXISTS current_version_id UUID REFERENCES drawing_spec_versions(id),
  ADD COLUMN IF NOT EXISTS template           BOOLEAN NOT NULL DEFAULT FALSE;

-- issue: the job registers a new issue (the flow 0062 built).
-- iterate: the job renders a patch as a candidate; no revision is written, the
-- patch row moves to candidate or failed. replaces_revision_id is the draft an
-- accepted candidate will replace the file of.
ALTER TABLE drawing_render_jobs
  ADD COLUMN IF NOT EXISTS mode                 TEXT NOT NULL DEFAULT 'issue'
                                                CHECK (mode IN ('issue', 'iterate')),
  ADD COLUMN IF NOT EXISTS spec_version_id      UUID REFERENCES drawing_spec_versions(id),
  ADD COLUMN IF NOT EXISTS spec_patch_id        UUID REFERENCES drawing_spec_patches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS replaces_revision_id UUID REFERENCES drawing_revisions(id) ON DELETE SET NULL;

-- The issue pins its three inputs (the CAD side already sits in
-- source_cad_file_id / source_sha256) and its two fingerprints (§3.6): the
-- dimension list, which says whether the numbers changed, and the geometry,
-- which says whether the shape did.
ALTER TABLE drawing_revisions
  ADD COLUMN IF NOT EXISTS spec_version_id       UUID REFERENCES drawing_spec_versions(id),
  ADD COLUMN IF NOT EXISTS spec_patch_id         UUID REFERENCES drawing_spec_patches(id),
  ADD COLUMN IF NOT EXISTS render_job_id         UUID REFERENCES drawing_render_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dimension_list_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS geometry_sha256       CHAR(64);

-- The drawing's current patch — the head that the next render and the next
-- applyDrawingSpecOps start from.
ALTER TABLE drawings
  ADD COLUMN IF NOT EXISTS spec_patch_id UUID REFERENCES drawing_spec_patches(id) ON DELETE SET NULL;
