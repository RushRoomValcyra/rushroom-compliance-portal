-- Fix trigger: compound AND evaluates NEW.code even on surgery_template_faces rows (no code col).
-- Use nested IFs so each table's fields are only accessed after TG_TABLE_NAME is confirmed.
CREATE OR REPLACE FUNCTION trg_surgery_codes_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'surgery_templates' THEN
    IF NEW.code <> OLD.code THEN
      RAISE EXCEPTION 'surgery_templates.code is immutable';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'surgery_template_faces' THEN
    IF NEW.face_code <> OLD.face_code THEN
      RAISE EXCEPTION 'surgery_template_faces.face_code is immutable';
    END IF;
    IF NEW.rule_id <> OLD.rule_id THEN
      RAISE EXCEPTION 'surgery_template_faces.rule_id is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Backfill: active faces belonging to retired templates were left active because
-- the cascade-retire logic in portal-api was added after those templates were retired.
-- This one-time backfill retires them and writes an audit event for each.

UPDATE surgery_template_faces stf
SET status = 'retired'
FROM surgery_templates st
WHERE stf.template_id = st.id
  AND st.status = 'retired'
  AND stf.status = 'active';

INSERT INTO surgery_template_face_events
  (organization_id, face_id, event_type, actor_id, reason, created_at)
SELECT stf.organization_id,
       stf.id,
       'retired',
       NULL,
       'Template retired (backfill)',
       NOW()
FROM surgery_template_faces stf
JOIN surgery_templates st ON stf.template_id = st.id
WHERE st.status = 'retired'
  AND stf.status = 'retired'
  AND NOT EXISTS (
    SELECT 1
    FROM surgery_template_face_events e
    WHERE e.face_id = stf.id
      AND e.event_type = 'retired'
  );
