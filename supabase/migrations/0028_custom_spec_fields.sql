-- 0028_custom_spec_fields.sql — PROP-040: promote a recurring custom spec to a standard field
-- ============================================================================
-- PROP-039 captures values a datasheet states that no column can hold, in
-- component_metadata.custom_specs. Some of those are not oddities but real
-- dimensions of the data — "Diameter" turns up on every round part — and they
-- should become proper labelled fields on the Specifications tab.
--
-- This is a MANAGED CATALOGUE, not a column per field. A real column would be
-- correct in the abstract, but every promotion would then be a migration plus an
-- edge-function deploy, which cannot happen in the moment while data is being
-- entered. The catalogue makes promotion a data operation; values continue to
-- live in the existing custom_specs JSONB, so nothing has to be migrated when a
-- field is promoted, renamed, or demoted again.

CREATE TABLE custom_spec_fields (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  field_key        VARCHAR(80)  NOT NULL,   -- the key inside custom_specs
  label            VARCHAR(120) NOT NULL,   -- what the tab shows
  unit             VARCHAR(30),             -- rendered after the value, e.g. "mm"
  data_type        TEXT NOT NULL DEFAULT 'text'
                     CHECK (data_type IN ('text', 'number', 'boolean')),
  section          TEXT NOT NULL DEFAULT 'physical'
                     CHECK (section IN ('physical', 'material', 'procurement', 'quality', 'regulatory')),
  sort_order       INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID REFERENCES users(id),
  UNIQUE (organization_id, field_key)
);

ALTER TABLE custom_spec_fields ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_custom_spec_fields_org ON custom_spec_fields (organization_id, section, sort_order);
