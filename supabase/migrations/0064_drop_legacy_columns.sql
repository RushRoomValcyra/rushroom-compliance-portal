-- 0064_drop_legacy_columns.sql — drop the legacy status columns, three-word enum
-- ============================================================================
-- docs/STATUS_MODEL.md §9 "0063 + 0064 — the clean-up, in two steps", step 3.
--
-- Push this ONLY after the portal-api from step 2 is deployed — the one that
-- neither reads nor writes any column below (tests/legacy-cleanup.test.mjs
-- guards the sources). `supabase db push` applies every pending file, so this
-- file is written and pushed after that deploy, never alongside 0063.
-- Rollback of the function after this migration is not possible: the columns
-- are gone. Rollback between 0063 and here: redeploy the previous function.
--
-- What goes, and why each is safe to drop now:
--   drawings.status, cad_models.status, cad_models.current_revision,
--   cad_model_files.revision, cad_model_files.released_at
--       — the object-level copies the API dual-wrote since 0060; every status
--         and letter the API shows is derived from the revision rows.
--   drawings.projection_angle, drawings.sheet_size, drawings.scale
--       — never read by the page, no longer taken from the body since
--         2026-11-25 (DRAWINGS_TAB_UX.md §12, step E); extractDrawingMeta no
--         longer asks for them.
--   drawing_revisions.checked_at/by, approved_at/by,
--   cad_model_revisions.checked_at/by, approved_at/by
--       — retired 2026-11-25 with the two review states; no transition stamps
--         them and no row carries a value anyone reads.
--   The enum drawing_status loses checked and approved. Postgres cannot drop
--   an enum value, so the type is recreated: new type with the three words,
--   the two status columns' defaults dropped, the columns altered with
--   USING status::text::drawing_status_new, defaults restored, the old type
--   dropped, the new one renamed. Guarded: a revision row still carrying
--   checked or approved makes this RAISE, never cast — such a row has no
--   exit in the transition table and must be dealt with by hand (release the
--   next issue), not rewritten by a migration.
--
-- Re-runnable: DROP COLUMN IF EXISTS everywhere; the enum swap runs only while
-- the type still has a retired label; the guard compares status::text so it
-- parses on a second run, when 'checked' is no longer a value of the type.

-- ---------------------------------------------------------------------------
-- 0. Guard — no revision row may carry a retired word
-- ---------------------------------------------------------------------------
DO $mig$
DECLARE
  n_draw INTEGER := 0;
  n_cad  INTEGER := 0;
BEGIN
  SELECT count(*) INTO n_draw FROM drawing_revisions   WHERE status::text IN ('checked', 'approved');
  SELECT count(*) INTO n_cad  FROM cad_model_revisions WHERE status::text IN ('checked', 'approved');
  IF n_draw + n_cad > 0 THEN
    RAISE EXCEPTION '0064: % drawing revision(s) and % CAD revision(s) still carry checked or approved; release the next issue of each by hand (a retired word has no exit) before dropping the enum values',
      n_draw, n_cad;
  END IF;
END
$mig$;

-- ---------------------------------------------------------------------------
-- 1. The object-level copies and the retired fields
-- ---------------------------------------------------------------------------
-- drawings.status first: it is a drawing_status column and would otherwise
-- have to be carried through the enum swap below.
ALTER TABLE drawings
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS projection_angle,
  DROP COLUMN IF EXISTS sheet_size,
  DROP COLUMN IF EXISTS scale;

ALTER TABLE cad_models
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS current_revision;

ALTER TABLE cad_model_files
  DROP COLUMN IF EXISTS revision,
  DROP COLUMN IF EXISTS released_at;

ALTER TABLE drawing_revisions
  DROP COLUMN IF EXISTS checked_at,
  DROP COLUMN IF EXISTS checked_by,
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS approved_by;

ALTER TABLE cad_model_revisions
  DROP COLUMN IF EXISTS checked_at,
  DROP COLUMN IF EXISTS checked_by,
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS approved_by;

-- ---------------------------------------------------------------------------
-- 2. drawing_status: draft · released · superseded
-- ---------------------------------------------------------------------------
DO $mig$
BEGIN
  -- Only while the type still carries a retired label (a re-run skips this).
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'drawing_status' AND e.enumlabel IN ('checked', 'approved')
  ) THEN
    DROP TYPE IF EXISTS drawing_status_new;
    CREATE TYPE drawing_status_new AS ENUM ('draft', 'released', 'superseded');

    -- The defaults are bound to the old type; drop them before the cast,
    -- restore them after.
    ALTER TABLE drawing_revisions   ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE cad_model_revisions ALTER COLUMN status DROP DEFAULT;

    ALTER TABLE drawing_revisions
      ALTER COLUMN status TYPE drawing_status_new USING status::text::drawing_status_new;
    ALTER TABLE cad_model_revisions
      ALTER COLUMN status TYPE drawing_status_new USING status::text::drawing_status_new;

    ALTER TABLE drawing_revisions   ALTER COLUMN status SET DEFAULT 'draft';
    ALTER TABLE cad_model_revisions ALTER COLUMN status SET DEFAULT 'draft';

    DROP TYPE drawing_status;
    ALTER TYPE drawing_status_new RENAME TO drawing_status;
  END IF;
END
$mig$;

-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------
DO $mig$
DECLARE
  n_cols_left  INTEGER := 0;
  enum_labels  TEXT    := '';
  n_draw_draft INTEGER := 0;
  n_draw_rel   INTEGER := 0;
  n_draw_sup   INTEGER := 0;
  n_cad_draft  INTEGER := 0;
  n_cad_rel    INTEGER := 0;
  n_cad_sup    INTEGER := 0;
BEGIN
  -- Any of the dropped columns still present (expected 0).
  SELECT count(*) INTO n_cols_left
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND (   (table_name = 'drawings'            AND column_name IN ('status', 'projection_angle', 'sheet_size', 'scale'))
          OR (table_name = 'cad_models'          AND column_name IN ('status', 'current_revision'))
          OR (table_name = 'cad_model_files'     AND column_name IN ('revision', 'released_at'))
          OR (table_name = 'drawing_revisions'   AND column_name IN ('checked_at', 'checked_by', 'approved_at', 'approved_by'))
          OR (table_name = 'cad_model_revisions' AND column_name IN ('checked_at', 'checked_by', 'approved_at', 'approved_by')));
  SELECT string_agg(e.enumlabel, ' · ' ORDER BY e.enumsortorder) INTO enum_labels
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = 'drawing_status';
  SELECT count(*) FILTER (WHERE status = 'draft'),
         count(*) FILTER (WHERE status = 'released'),
         count(*) FILTER (WHERE status = 'superseded')
    INTO n_draw_draft, n_draw_rel, n_draw_sup FROM drawing_revisions;
  SELECT count(*) FILTER (WHERE status = 'draft'),
         count(*) FILTER (WHERE status = 'released'),
         count(*) FILTER (WHERE status = 'superseded')
    INTO n_cad_draft, n_cad_rel, n_cad_sup FROM cad_model_revisions;

  RAISE NOTICE E'0064 done:\n  legacy columns still present (expected 0): %\n  drawing_status labels: %\n  drawing_revisions draft / released / superseded: % / % / %\n  cad_model_revisions draft / released / superseded: % / % / %',
    n_cols_left, enum_labels, n_draw_draft, n_draw_rel, n_draw_sup, n_cad_draft, n_cad_rel, n_cad_sup;
END
$mig$;
