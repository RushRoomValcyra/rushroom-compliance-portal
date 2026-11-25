-- 0060_revision_status.sql — one status model for drawings and CAD models
-- ============================================================================
-- docs/STATUS_MODEL.md, §9 "0060 — add and backfill". The revision is the
-- controlled object; drawings and CAD models only report. Today the portal
-- keeps a status on the drawing AND on each drawing revision, a status on the
-- CAD model AND a release stamp on each CAD file. Nothing keeps them aligned,
-- so a released drawing with a new issue in work still reads "released", and
-- releasing a CAD model stamps every unreleased file of every letter.
--
-- This migration ADDS and BACKFILLS only. It drops nothing and is safe with
-- the old portal-api still running: the old API keeps reading drawings.status,
-- cad_models.status / current_revision and cad_model_files.revision /
-- released_at, all of which stay in place until 0061. The new API dual-writes
-- them so a rollback of the function keeps working.
--
-- Steps (design §9):
--   1. cad_model_revisions — mirrors drawing_revisions; one row per letter.
--   2. One row per distinct (cad_model_id, revision) in cad_model_files:
--      released when any file of that letter has released_at (earliest kept),
--      else draft. A model with several released letters keeps the highest
--      released and the others become superseded.
--   3. cad_model_files.cad_model_revision_id filled. It stays NULLABLE until
--      0061: between `db push` and the function deploy the old
--      registerCadRevision still inserts files without it, and a NOT NULL
--      would make every Fusion send fail after the upload (orphaned storage
--      objects). cad_models.current_revision_id = the row with the highest letter.
--   4. drawing_revisions gains checked/approved/released who+when and the
--      source STEP; drawings.status checked/approved copied onto a draft
--      current revision (that is what the user set, see §1).
--   5. Nothing dropped. RAISE NOTICE with the counts.
--
-- Re-runnable: IF NOT EXISTS everywhere, inserts ON CONFLICT DO NOTHING,
-- backfills touch only rows still NULL.

-- ---------------------------------------------------------------------------
-- 1. cad_model_revisions
-- ---------------------------------------------------------------------------
-- The drawing_status enum (0032) already has the right five values:
-- draft → checked → approved → released → superseded. It is reused, not
-- duplicated, so both lifecycles share one set of words.
CREATE TABLE IF NOT EXISTS cad_model_revisions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id),
  cad_model_id          UUID NOT NULL REFERENCES cad_models(id) ON DELETE CASCADE,
  revision              VARCHAR(10) NOT NULL,   -- 'A', 'B', … 'AA' — same alphabet as drawing issues
  status                drawing_status NOT NULL DEFAULT 'draft',
  -- "RevF" as found in the Fusion document name at registration. It is where
  -- the default letter comes from; kept so a mismatch can be shown later.
  fusion_revision_label VARCHAR(20),
  -- Fusion's own save counter when this letter was first registered. Metadata
  -- only ("Fusion v12"), never a revision.
  fusion_version        INTEGER,
  -- A state without who and when is half a state.
  checked_at            TIMESTAMPTZ,
  checked_by            UUID REFERENCES users(id),
  approved_at           TIMESTAMPTZ,
  approved_by           UUID REFERENCES users(id),
  released_at           TIMESTAMPTZ,
  released_by           UUID REFERENCES users(id),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by            UUID REFERENCES users(id),
  UNIQUE (organization_id, cad_model_id, revision)
);
ALTER TABLE cad_model_revisions ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_cad_model_revisions_model
  ON cad_model_revisions (organization_id, cad_model_id);

-- ---------------------------------------------------------------------------
-- 3a. New columns (DDL first; the backfill below fills them)
-- ---------------------------------------------------------------------------
ALTER TABLE cad_model_files
  ADD COLUMN IF NOT EXISTS cad_model_revision_id UUID
    REFERENCES cad_model_revisions(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_cad_model_files_revision
  ON cad_model_files (organization_id, cad_model_revision_id);
-- One file per format per revision. The old (cad_model_id, revision, format)
-- constraint stays until 0061; the two agree as long as the letter is
-- dual-written.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cad_model_files_revision_format
  ON cad_model_files (organization_id, cad_model_revision_id, format)
  WHERE cad_model_revision_id IS NOT NULL;

ALTER TABLE cad_models
  ADD COLUMN IF NOT EXISTS current_revision_id UUID;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cad_models_current_revision_fk') THEN
    ALTER TABLE cad_models
      ADD CONSTRAINT cad_models_current_revision_fk
      FOREIGN KEY (current_revision_id) REFERENCES cad_model_revisions(id) ON DELETE SET NULL;
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 4a. drawing_revisions — who and when, and the STEP a drawing was made from
-- ---------------------------------------------------------------------------
ALTER TABLE drawing_revisions
  ADD COLUMN IF NOT EXISTS checked_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS checked_by         UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by        UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS released_by        UUID REFERENCES users(id),
  -- The STEP file the drawing was made from. drawset.py writes the STEP's
  -- sha256 into its .sources.json; with it here the portal can say "this
  -- drawing is not from the released CAD" exactly, not by date.
  ADD COLUMN IF NOT EXISTS source_cad_file_id UUID REFERENCES cad_model_files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_sha256      VARCHAR(64);

-- ---------------------------------------------------------------------------
-- 2, 3b, 4b. Backfill
-- ---------------------------------------------------------------------------
DO $mig$
DECLARE
  n_revisions_created   INTEGER := 0;
  n_models_multi_rel    INTEGER := 0;
  n_superseded          INTEGER := 0;
  n_files_linked        INTEGER := 0;
  n_files_unlinked      INTEGER := 0;
  n_models_current      INTEGER := 0;
  n_draw_copied         INTEGER := 0;
  n_draw_superseded     INTEGER := 0;
  n_draw_no_current     INTEGER := 0;
  n_draw_rel_no_rev     INTEGER := 0;
BEGIN
  -- 2. One revision row per distinct letter of each model.
  --    status: released when ANY file of that letter carries released_at —
  --    the old releaseCadModel stamped only files that were still NULL, so a
  --    letter whose files were registered across a release has some stamped
  --    and some not; the letter was released all the same. released_at is the
  --    earliest stamp. fusion_version / created_by come from the first file
  --    registered for the letter (that is when the letter was registered).
  WITH ins AS (
    INSERT INTO cad_model_revisions
      (organization_id, cad_model_id, revision, status, fusion_version, released_at, created_at, created_by)
    SELECT f.organization_id,
           f.cad_model_id,
           f.revision,
           CASE WHEN bool_or(f.released_at IS NOT NULL)
                THEN 'released'::drawing_status ELSE 'draft'::drawing_status END,
           (array_agg(f.fusion_version ORDER BY f.created_at) FILTER (WHERE f.fusion_version IS NOT NULL))[1],
           min(f.released_at),
           min(f.created_at),
           (array_agg(f.created_by ORDER BY f.created_at) FILTER (WHERE f.created_by IS NOT NULL))[1]
      FROM cad_model_files f
     GROUP BY f.organization_id, f.cad_model_id, f.revision
    ON CONFLICT (organization_id, cad_model_id, revision) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO n_revisions_created FROM ins;

  -- A model may end up with more than one released letter (the old release
  -- stamped every unreleased file of every letter). Only one revision may be
  -- released at a time: the highest letter stays, the rest are superseded.
  -- Letter order is shorter-first then alphabetical, so "AA" is above "Z".
  SELECT count(*) INTO n_models_multi_rel
    FROM (SELECT cad_model_id FROM cad_model_revisions
           WHERE status = 'released'
           GROUP BY cad_model_id HAVING count(*) > 1) m;

  WITH ranked AS (
    SELECT id,
           row_number() OVER (PARTITION BY cad_model_id
                              ORDER BY length(revision) DESC, revision DESC) AS rn
      FROM cad_model_revisions
     WHERE status = 'released'
  ),
  upd AS (
    UPDATE cad_model_revisions r
       SET status = 'superseded'
      FROM ranked
     WHERE r.id = ranked.id AND ranked.rn > 1
    RETURNING 1
  )
  SELECT count(*) INTO n_superseded FROM upd;

  -- 3. Point every file at its revision row …
  WITH upd AS (
    UPDATE cad_model_files f
       SET cad_model_revision_id = r.id
      FROM cad_model_revisions r
     WHERE f.cad_model_revision_id IS NULL
       AND r.organization_id = f.organization_id
       AND r.cad_model_id    = f.cad_model_id
       AND r.revision        = f.revision
    RETURNING 1
  )
  SELECT count(*) INTO n_files_linked FROM upd;

  -- … and count any file left behind (should be 0: every (model, letter) got
  -- a row above). The column stays nullable until 0061 (design §9 step 3), so
  -- the old API can still insert files during the deploy window; the new API
  -- always fills it.
  SELECT count(*) INTO n_files_unlinked FROM cad_model_files WHERE cad_model_revision_id IS NULL;

  -- cad_models.current_revision_id = the highest letter. Only rows still NULL
  -- are touched, so a re-run never undoes what the API has set since.
  WITH top AS (
    SELECT DISTINCT ON (cad_model_id) id, cad_model_id
      FROM cad_model_revisions
     ORDER BY cad_model_id, length(revision) DESC, revision DESC
  ),
  upd AS (
    UPDATE cad_models m
       SET current_revision_id = top.id
      FROM top
     WHERE top.cad_model_id = m.id
       AND m.current_revision_id IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO n_models_current FROM upd;

  -- 4. The §1 fault on drawings: setDrawingStatus moved drawings.status to
  --    checked / approved but never wrote the revision. Where the current
  --    revision is still draft, copy what the user set onto it. Released needs
  --    nothing — setDrawingStatus always wrote the released revision.
  WITH upd AS (
    UPDATE drawing_revisions r
       SET status = d.status
      FROM drawings d
     WHERE d.current_revision_id = r.id
       AND r.status = 'draft'
       AND d.status IN ('checked', 'approved')
    RETURNING 1
  )
  SELECT count(*) INTO n_draw_copied FROM upd;

  --    And the other direction of the same fault: drawings.status set to
  --    superseded by hand while the current revision still says released.
  --    Copy superseded to it (that is what the user set).
  WITH upd AS (
    UPDATE drawing_revisions r
       SET status = 'superseded'
      FROM drawings d
     WHERE d.current_revision_id = r.id
       AND r.status = 'released'
       AND d.status = 'superseded'
    RETURNING 1
  )
  SELECT count(*) INTO n_draw_superseded FROM upd;

  -- Reported, not fixed: a drawing without a current revision has nothing to
  -- carry its status (the derived status will read draft), and a drawing
  -- marked released before it had a revision has no released revision to show.
  SELECT count(*) INTO n_draw_no_current FROM drawings WHERE current_revision_id IS NULL;
  SELECT count(*) INTO n_draw_rel_no_rev
    FROM drawings d
   WHERE d.status = 'released'
     AND NOT EXISTS (SELECT 1 FROM drawing_revisions r
                      WHERE r.drawing_id = d.id AND r.status = 'released');

  -- 5. Nothing dropped (0061).
  RAISE NOTICE E'0060 done:\n  cad_model_revisions created: %\n  models with >1 released letter (fixed): %\n  CAD revisions superseded: %\n  cad_model_files linked to a revision: %\n  cad_model_files still without a revision (expected 0): %\n  cad_models.current_revision_id set: %\n  drawing revisions given checked/approved: %\n  drawing revisions given superseded: %\n  drawings with no current revision (reported only): %\n  drawings released with no released revision (reported only): %',
    n_revisions_created, n_models_multi_rel, n_superseded, n_files_linked, n_files_unlinked,
    n_models_current, n_draw_copied, n_draw_superseded, n_draw_no_current, n_draw_rel_no_rev;
END
$mig$;
