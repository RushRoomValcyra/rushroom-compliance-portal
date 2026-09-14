-- 0025_bom_edge_ordering.sql — PROP-036: stable sibling order on BOM edges
-- ============================================================================
-- Until now bom_edges had no position column and getBom fetched child edges
-- with no ORDER BY, so the "Pos. 1, 2, 3" column in the BOM tree was just the
-- array index of an unordered Postgres result — sibling order was arbitrary
-- and could reshuffle between loads.
--
-- No new table: bom_edges already carries organization_id NOT NULL (PROP-012)
-- and has RLS enabled from migration 0007, so the new column inherits both.

ALTER TABLE bom_edges ADD COLUMN IF NOT EXISTS sort_order INT;

-- Backfill: freeze the current (arbitrary) order exactly once, per parent, so
-- nothing visibly jumps on deploy. Gaps of 10 let a single insert land between
-- two neighbours without renumbering the whole sibling set.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (
           PARTITION BY parent_id
           ORDER BY effective_from, id
         ) * 10 AS pos
  FROM bom_edges
  WHERE effective_to IS NULL
)
UPDATE bom_edges e SET sort_order = o.pos
FROM ordered o WHERE e.id = o.id AND e.sort_order IS NULL;

-- Closed (historical) edges never render, but leave no NULLs behind.
UPDATE bom_edges SET sort_order = 0 WHERE sort_order IS NULL;

ALTER TABLE bom_edges ALTER COLUMN sort_order SET DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_bom_edges_parent_sorted
  ON bom_edges (parent_id, sort_order) WHERE effective_to IS NULL;
