-- 0035_planner_catalog_entries.sql — PIM-owned saved planner source catalog
-- Website/Operations remain outside this schema. This table stores only source
-- identities and human-readable labels imported from a locally pasted cart.

CREATE TABLE planner_catalog_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type     TEXT NOT NULL CHECK (source_type IN (
    'module', 'interior', 'side_panel', 'feet', 'door', 'cover', 'back_cover'
  )),
  source_key      TEXT NOT NULL,
  label           TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT planner_catalog_entries_key_not_blank CHECK (length(trim(source_key)) > 0),
  CONSTRAINT planner_catalog_entries_label_not_blank CHECK (length(trim(label)) > 0),
  CONSTRAINT planner_catalog_entries_identity_unique UNIQUE (organization_id, source_type, source_key)
);

ALTER TABLE planner_catalog_entries ENABLE ROW LEVEL SECURITY;

CREATE INDEX planner_catalog_entries_lookup
  ON planner_catalog_entries (organization_id, source_type, source_key);
