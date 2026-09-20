-- 0034_planner_mappings.sql — PIM-owned Website Planner mapping registry
-- The Website owns its cart vocabulary; PIM maps stable source keys to BOM IDs.
-- A future Operations resolver consumes this data but is intentionally not here.

CREATE TABLE planner_mappings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type         TEXT NOT NULL CHECK (source_type IN (
    'module', 'interior', 'side_panel', 'feet', 'door', 'cover', 'back_cover'
  )),
  source_key          TEXT NOT NULL,
  target_component_id UUID NOT NULL REFERENCES bom_components(id) ON DELETE RESTRICT,
  quantity_rule       TEXT NOT NULL CHECK (quantity_rule IN ('fixed', 'cart_quantity')),
  fixed_quantity      NUMERIC(12,3),
  is_active           BOOLEAN NOT NULL DEFAULT true,
  mapping_revision    INTEGER NOT NULL DEFAULT 1 CHECK (mapping_revision > 0),
  release_label       TEXT,
  supersedes_id       UUID REFERENCES planner_mappings(id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  superseded_at       TIMESTAMPTZ,
  deactivated_at      TIMESTAMPTZ,
  deactivated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT planner_mappings_source_key_not_blank CHECK (length(trim(source_key)) > 0),
  CONSTRAINT planner_mappings_fixed_quantity_rule CHECK (
    (quantity_rule = 'fixed' AND fixed_quantity IS NOT NULL AND fixed_quantity > 0)
    OR (quantity_rule = 'cart_quantity' AND fixed_quantity IS NULL)
  ),
  CONSTRAINT planner_mappings_revision_unique UNIQUE (organization_id, source_type, source_key, mapping_revision)
);

ALTER TABLE planner_mappings ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX planner_mappings_one_active_source
  ON planner_mappings (organization_id, source_type, source_key)
  WHERE is_active;
CREATE INDEX planner_mappings_latest_lookup
  ON planner_mappings (organization_id, source_type, source_key, mapping_revision DESC);
CREATE INDEX planner_mappings_target_lookup
  ON planner_mappings (organization_id, target_component_id);
