-- 0048_transport_percent.sql — transport as a % of the unit cost
-- ============================================================================
-- Decided 2026-10-10: transport is entered like customs — a percentage of the
-- unit cost — not as an amount with its own currency. Freight is known as a
-- share of the goods value far more often than per unit, and a % works the
-- same for a 0.012 USD pin and a 300 EUR panel.
--
--   landed SEK = unit × rate × (1 + transport % / 100 + customs % / 100)
--
-- The amount columns (transport_cost / transport_currency, PROP-072) are
-- dropped rather than left unused: production held one cost row, with
-- transport 0, on 2026-10-10. The guard below refuses to drop a real amount
-- that has appeared since — convert it by hand first.
-- Old baselines keep their stored transport amounts in JSON; the arithmetic
-- still reads those, so comparisons against them stay correct.

ALTER TABLE component_costs ADD COLUMN IF NOT EXISTS transport_pct NUMERIC(7,3) NOT NULL DEFAULT 0
  CHECK (transport_pct >= 0 AND transport_pct <= 1000);
COMMENT ON COLUMN component_costs.transport_pct IS
  'Transport as % of the unit cost (may exceed 100 for very cheap parts). Landed = unit × rate × (1 + transport% + customs%).';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'component_costs' AND column_name = 'transport_cost')
     AND EXISTS (SELECT 1 FROM component_costs WHERE transport_cost <> 0) THEN
    RAISE EXCEPTION '0048: component_costs holds transport amounts — convert them to transport_pct before dropping the column';
  END IF;
END $$;

ALTER TABLE component_costs DROP COLUMN IF EXISTS transport_cost;
ALTER TABLE component_costs DROP COLUMN IF EXISTS transport_currency;
