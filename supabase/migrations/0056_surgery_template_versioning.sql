-- 0056_surgery_template_versioning.sql — PROP-075
-- ============================================================================
-- Adds an append-only event ledger for face-rule assignments and a supersedes
-- chain between template generations.
--
-- surgery_template_face_events: every face status change (created / retired /
--   reactivated) writes one row here. Never updated or deleted.
-- surgery_templates.supersedes_id: nullable FK to the template this one
--   replaces — records the lineage chain between jig generations.

-- Supersedes chain.
ALTER TABLE surgery_templates
  ADD COLUMN IF NOT EXISTS supersedes_id UUID
    REFERENCES surgery_templates(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_surgery_templates_supersedes
  ON surgery_templates (supersedes_id)
  WHERE supersedes_id IS NOT NULL;

-- Append-only face event ledger.
CREATE TABLE IF NOT EXISTS surgery_template_face_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id),
  face_id         UUID        NOT NULL REFERENCES surgery_template_faces(id) ON DELETE RESTRICT,
  event_type      VARCHAR(20) NOT NULL CHECK (event_type IN ('created', 'retired', 'reactivated')),
  actor_id        UUID        REFERENCES users(id),   -- NULL = system / cascade / backfill
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE surgery_template_face_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_stfe_org   ON surgery_template_face_events (organization_id);
CREATE INDEX IF NOT EXISTS idx_stfe_face  ON surgery_template_face_events (face_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stfe_actor ON surgery_template_face_events (actor_id)
  WHERE actor_id IS NOT NULL;

-- Backfill: seed one 'created' event per existing face (actor_id NULL = pre-history).
-- The UI shows "History available from [date]" for rows created before this migration.
INSERT INTO surgery_template_face_events
  (organization_id, face_id, event_type, actor_id, reason, created_at)
SELECT
  f.organization_id, f.id, 'created', NULL,
  'Backfilled on PROP-075 migration — original creation date unknown',
  f.created_at
FROM surgery_template_faces f;

-- For already-retired faces, also backfill a 'retired' event.
INSERT INTO surgery_template_face_events
  (organization_id, face_id, event_type, actor_id, reason, created_at)
SELECT
  f.organization_id, f.id, 'retired', NULL,
  'Backfilled on PROP-075 migration — exact retirement date unknown',
  NOW()
FROM surgery_template_faces f
WHERE f.status = 'retired';
