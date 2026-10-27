-- 0051_target_days_to_operations.sql — how much to hold moves to Order Operations
-- ============================================================================
-- This portal defines the product, including which assemblies may be built
-- ahead of orders (is_stocked). How many days of stock to hold is a stock
-- policy, owned by Order Operations with the stock itself (its decision 0012),
-- where it is now set on the Pre-assemblies page. Production held no values on
-- 2026-10-27; the guard keeps any value from being dropped unnoticed.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM bom_components WHERE target_stock_days IS NOT NULL) THEN
    RAISE EXCEPTION 'target_stock_days still holds values; copy them to Order Operations (pre_assembly_targets) first';
  END IF;
END $$;

ALTER TABLE bom_components DROP COLUMN IF EXISTS target_stock_days;

COMMENT ON COLUMN bom_components.is_stocked IS
  'True when this assembly may be built ahead of orders (pre-assembly eligibility). Stock and targets live in Order Operations.';
