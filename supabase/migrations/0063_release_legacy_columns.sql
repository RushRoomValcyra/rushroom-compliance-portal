-- 0063_release_legacy_columns.sql — release the legacy status columns
-- ============================================================================
-- docs/STATUS_MODEL.md §9 "0063 + 0064 — the clean-up, in two steps", step 1.
--
-- Since 0060 the revision is the controlled object and portal-api derives every
-- status it shows from drawing_revisions / cad_model_revisions. The old
-- object-level columns (drawings.status, cad_models.status / current_revision,
-- cad_model_files.revision / released_at) have only been DUAL-WRITTEN since,
-- so a rolled-back function kept working. Now they go — but the drop is the
-- reverse of 0060: there the migration ran first and the old function kept
-- working because its columns were still there; here the function must stop
-- writing BEFORE a column goes, and it cannot stop writing
-- cad_model_files.revision while that column is NOT NULL.
--
-- So this migration drops NOTHING. It only releases the constraints that force
-- the legacy columns to be written, and tightens the one the new API always
-- fills. It is safe with the dual-writing function still running (it keeps
-- writing the now-nullable columns), and it is what makes the next portal-api
-- deployable — one that neither reads nor writes any of them. 0064 drops.
--
-- Steps:
--   1. cad_model_files.revision DROP NOT NULL — so a file can be registered
--      without the letter; the letter lives on cad_model_revisions.
--   2. The legacy unique constraint (organization_id, cad_model_id, revision,
--      format) and its index idx_cad_model_files_model go: the revision-keyed
--      unique index idx_cad_model_files_revision_format from 0060 holds the
--      rule "one file per format per revision".
--   3. cad_models.status and drawings.status DROP NOT NULL, DROP DEFAULT — an
--      insert that names neither leaves NULL, which nothing reads.
--   4. cad_model_files.cad_model_revision_id SET NOT NULL — every row has been
--      linked since 0060 (51/51 on production, 2026-11-25) and the API fills
--      it on every insert. Guarded: an unlinked row RAISEs, it is never
--      silently given a revision here.
--
-- Inventory on production before writing this (2026-11-25): 51/51 files
-- linked, no revision row at checked or approved, no trigger or view on the
-- five tables, the enum drawing_status used only by drawings.status,
-- drawing_revisions.status and cad_model_revisions.status.
--
-- Re-runnable: every ALTER here is idempotent (DROP NOT NULL / DROP DEFAULT on
-- a column that already has neither is a no-op; IF EXISTS on the constraint and
-- the index; SET NOT NULL on a NOT NULL column is a no-op).
--
-- Rollback between 0063 and 0064: redeploy the previous portal-api, which still
-- writes the (now nullable) columns. Nothing here needs undoing.

-- ---------------------------------------------------------------------------
-- 4 (guard first). Every file must already hang off a revision.
-- ---------------------------------------------------------------------------
DO $mig$
DECLARE
  n_unlinked INTEGER := 0;
BEGIN
  SELECT count(*) INTO n_unlinked FROM cad_model_files WHERE cad_model_revision_id IS NULL;
  IF n_unlinked > 0 THEN
    RAISE EXCEPTION '0063: % cad_model_files row(s) have no cad_model_revision_id; run the 0060 backfill (or link them by hand) before releasing the legacy columns', n_unlinked;
  END IF;
END
$mig$;

-- ---------------------------------------------------------------------------
-- 1. The letter on the file is no longer required
-- ---------------------------------------------------------------------------
ALTER TABLE cad_model_files
  ALTER COLUMN revision DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. The legacy (model, letter, format) uniqueness and its index
--    (0059). idx_cad_model_files_revision_format (0060) keeps the rule.
-- ---------------------------------------------------------------------------
ALTER TABLE cad_model_files
  DROP CONSTRAINT IF EXISTS cad_model_files_organization_id_cad_model_id_revision_forma_key;
DROP INDEX IF EXISTS idx_cad_model_files_model;

-- ---------------------------------------------------------------------------
-- 3. Object-level status columns: optional, no default
-- ---------------------------------------------------------------------------
ALTER TABLE cad_models
  ALTER COLUMN status DROP NOT NULL,
  ALTER COLUMN status DROP DEFAULT;

ALTER TABLE drawings
  ALTER COLUMN status DROP NOT NULL,
  ALTER COLUMN status DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- 4. The pointer the new API always fills becomes required
-- ---------------------------------------------------------------------------
ALTER TABLE cad_model_files
  ALTER COLUMN cad_model_revision_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------
DO $mig$
DECLARE
  n_files            INTEGER := 0;
  n_files_no_letter  INTEGER := 0;
  n_models_no_status INTEGER := 0;
  n_draw_no_status   INTEGER := 0;
  n_retired          INTEGER := 0;
  has_old_constraint BOOLEAN := FALSE;
  has_old_index      BOOLEAN := FALSE;
BEGIN
  SELECT count(*) INTO n_files FROM cad_model_files;
  SELECT count(*) INTO n_files_no_letter FROM cad_model_files WHERE revision IS NULL;
  SELECT count(*) INTO n_models_no_status FROM cad_models WHERE status IS NULL;
  SELECT count(*) INTO n_draw_no_status FROM drawings WHERE status IS NULL;
  -- Reported only: 0064 refuses to run while any revision row carries a retired word.
  SELECT count(*) INTO n_retired FROM (
    SELECT 1 FROM drawing_revisions   WHERE status::text IN ('checked', 'approved')
    UNION ALL
    SELECT 1 FROM cad_model_revisions WHERE status::text IN ('checked', 'approved')
  ) x;
  SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cad_model_files_organization_id_cad_model_id_revision_forma_key') INTO has_old_constraint;
  SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_cad_model_files_model') INTO has_old_index;

  RAISE NOTICE E'0063 done:\n  cad_model_files rows (all linked to a revision, now NOT NULL): %\n  cad_model_files without a letter (expected 0 until the new API is deployed): %\n  cad_models without a status (expected 0 until the new API is deployed): %\n  drawings without a status (expected 0 until the new API is deployed): %\n  revision rows at checked/approved (must be 0 before 0064): %\n  legacy unique constraint still present (expected false): %\n  legacy index idx_cad_model_files_model still present (expected false): %',
    n_files, n_files_no_letter, n_models_no_status, n_draw_no_status, n_retired, has_old_constraint, has_old_index;
END
$mig$;
