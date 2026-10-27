-- 0050_pre_assemblies.sql — stocked pre-assembly marker
-- ============================================================================
-- A pre-assembly is an assembly that is built ahead of customer orders and
-- held as a shelf unit (e.g. a prepared door with handle fitted, a drawer pair).
-- The planner resolver will stop at these instead of exploding them to loose
-- parts — that resolver change comes in a separate commit once the marking UI
-- is in use and the list of stocked assemblies is stable.
--
-- is_stocked:        true  = build ahead and hold on the shelf.
-- target_stock_days: how many days of sales cover to target (optional guide
--                    for hub build scheduling; not enforced by the system).

ALTER TABLE bom_components
  ADD COLUMN IF NOT EXISTS is_stocked         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS target_stock_days  INTEGER
    CHECK (target_stock_days IS NULL OR (target_stock_days > 0 AND target_stock_days <= 365));

COMMENT ON COLUMN bom_components.is_stocked IS
  'True when this assembly is built ahead of orders and held as a shelf unit.';
COMMENT ON COLUMN bom_components.target_stock_days IS
  'Target days of sales cover to hold in stock (guide only, not enforced).';

CREATE INDEX IF NOT EXISTS bom_components_stocked
  ON bom_components (organization_id, is_stocked)
  WHERE is_stocked = true;
