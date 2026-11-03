-- 0055_surgery_template_drawing_type.sql — PROP-074
-- ============================================================================
-- A surgery template IS a controlled drawing. This migration adds drawing_type
-- to drawings, backfills existing templates' drawings to 'surgery_template',
-- seeds placeholder drawings for any templates that have no drawing_id, and
-- makes surgery_templates.drawing_id NOT NULL.
--
-- drawing_type values: 'engineering' (default) | 'surgery_template'
-- Plain VARCHAR — new types can be added later without a migration.

ALTER TABLE drawings
  ADD COLUMN IF NOT EXISTS drawing_type VARCHAR(40) NOT NULL DEFAULT 'engineering';

CREATE INDEX IF NOT EXISTS idx_drawings_type
  ON drawings (organization_id, drawing_type);

-- Backfill: drawings already linked from surgery_templates → mark as surgery_template.
UPDATE drawings d
  SET drawing_type = 'surgery_template'
  FROM surgery_templates st
  WHERE st.drawing_id = d.id;

-- Safety net: for any surgery_template with no drawing, create a minimal placeholder
-- drawing so the NOT NULL constraint below can be enforced cleanly.
-- This block should never fire in production — drawing_id has always been settable —
-- but protects against any local dev rows that skipped the link step.
DO $$
DECLARE
  rec RECORD;
  placeholder_id UUID;
BEGIN
  FOR rec IN
    SELECT st.id, st.name, st.organization_id
    FROM surgery_templates st
    WHERE st.drawing_id IS NULL
  LOOP
    INSERT INTO drawings (organization_id, drawing_number, title, drawing_type, is_supplier_visible)
      VALUES (
        rec.organization_id,
        'PLACEHOLDER-' || substring(rec.id::text, 1, 8),
        rec.name || ' (placeholder — link a real drawing)',
        'surgery_template',
        false
      )
      RETURNING id INTO placeholder_id;

    UPDATE surgery_templates SET drawing_id = placeholder_id WHERE id = rec.id;
  END LOOP;
END$$;

ALTER TABLE surgery_templates
  ALTER COLUMN drawing_id SET NOT NULL;
