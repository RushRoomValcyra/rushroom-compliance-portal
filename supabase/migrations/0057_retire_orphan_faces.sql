-- Fix: active faces that belong to retired templates were left active because
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
