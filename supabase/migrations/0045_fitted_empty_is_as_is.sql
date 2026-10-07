-- 0045_fitted_empty_is_as_is.sql — what an empty Fitted means
-- ============================================================================
-- Decided 2026-10-07 (docs/BOM_LOGIC_REVIEW.html question 14): Fitted has
-- three answers — nothing (picked as is for the order), Hub (prepared or
-- pre-assembled at the hub) and Site (fitted at the customer). The first is
-- the empty value, shown as "—". It is a decision, not a gap.
--
-- Migration 0036 described NULL as "not decided yet, deliberately distinct
-- from either stage". That reading is withdrawn; this restates the column so
-- the schema says what the screen says. No data or constraint changes.

COMMENT ON COLUMN bom_edges.fitting_stage IS
  'Where value is added to this occurrence: hub = prepared / pre-assembled at the logistics hub, site = fitted during installation at the customer. NULL ("—") = nothing is done to it; it is picked as is for the order.';
