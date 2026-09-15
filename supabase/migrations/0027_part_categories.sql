-- 0027_part_categories.sql — PROP-038: clickable part categories
-- ============================================================================
-- The Parts tab is a single flat list. At a few dozen parts that is merely
-- untidy; at the thousands this range is heading for it is unusable, and the
-- only way through it is the search box — which forces a hand off the mouse
-- for what should be a click.
--
-- Categories are a MANAGED LIST rather than a CHECK constraint: a growing
-- furniture range will want Packaging, Textiles, Lighting and so on, and each
-- of those would otherwise be a migration plus an edge-function deploy.

CREATE TABLE part_categories (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  name             VARCHAR(80) NOT NULL,
  sort_order       INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID REFERENCES users(id),
  UNIQUE (organization_id, name)
);

ALTER TABLE part_categories ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_part_categories_org ON part_categories (organization_id, sort_order);

-- Nullable on purpose. Existing rows have no category and must not be given a
-- fabricated one; the UI requires a category on CREATE and surfaces the
-- untagged backlog in its own tab until it is worked through.
ALTER TABLE bom_components
  ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES part_categories(id);

CREATE INDEX IF NOT EXISTS idx_bom_components_category
  ON bom_components (organization_id, category_id);

-- Seed the four starting categories for every existing organization.
INSERT INTO part_categories (organization_id, name, sort_order)
SELECT o.id, c.name, c.sort_order
FROM organizations o
CROSS JOIN (VALUES
  ('Furniture panels',      10),
  ('Mechanicals',           20),
  ('Fittings & Fasteners',  30),
  ('Electronics',           40)
) AS c(name, sort_order)
ON CONFLICT (organization_id, name) DO NOTHING;
