-- PROP-035: Component Variant Groups — link color/finish/size siblings under one concept.
-- A panel comes in 5 colours; each colour is its own SKU (bom_component) but they
-- are related. A variant group names the relationship and the attribute that varies.

CREATE TABLE component_variant_groups (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT        NOT NULL,
  variant_attribute TEXT        NOT NULL DEFAULT 'Color',
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        UUID        REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (organization_id, name)
);
ALTER TABLE component_variant_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY deny_all ON component_variant_groups FOR ALL USING (false);

CREATE TABLE component_variant_members (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  group_id          UUID        NOT NULL REFERENCES component_variant_groups(id) ON DELETE CASCADE,
  component_id      UUID        NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  variant_value     TEXT        NOT NULL,
  sort_order        INT         NOT NULL DEFAULT 0,
  UNIQUE (group_id, component_id),
  UNIQUE (group_id, variant_value)
);
ALTER TABLE component_variant_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY deny_all ON component_variant_members FOR ALL USING (false);
