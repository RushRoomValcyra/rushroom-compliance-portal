-- 0036_edge_fitting_stage.sql — PROP-056: where a part is actually fitted
-- ============================================================================
-- Some parts inside an assembly are joined at the logistics hub before
-- delivery; others are inserted during physical installation on site. The BOM
-- could not express the difference, so a delivery could not be split into what
-- the hub builds and what ships loose to the installation crew.
--
-- The column goes on the EDGE, not the component. The same screw can be
-- hub-fitted under one panel and site-fitted under another — that is a fact
-- about the occurrence, which is exactly where quantity, reference designator
-- and sort order already live. A column on bom_components could not express it
-- at all.
--
-- NULL means "not decided yet", deliberately distinct from either stage: every
-- edge that exists today is unset, and a screen that cannot tell "nobody has
-- said" from "decided: hub" would report false confidence about a delivery.

ALTER TABLE bom_edges ADD COLUMN IF NOT EXISTS fitting_stage TEXT;

-- A CHECK rather than an enum type: widening this list is one statement, and
-- this schema has already widened bom_component_history's change_type twice.
-- 'factory' (already joined on arrival) and 'either' (installer's choice) are
-- the two most likely additions.
ALTER TABLE bom_edges DROP CONSTRAINT IF EXISTS bom_edges_fitting_stage_check;
ALTER TABLE bom_edges ADD CONSTRAINT bom_edges_fitting_stage_check
  CHECK (fitting_stage IS NULL OR fitting_stage IN ('hub', 'site'));

COMMENT ON COLUMN bom_edges.fitting_stage IS
  'Where this occurrence is assembled: hub = logistics hub before delivery, site = during physical installation. NULL = not yet decided.';

-- The counts strip asks "how many of this parent's children are at each stage"
-- on every tree render.
CREATE INDEX IF NOT EXISTS idx_bom_edges_parent_stage
  ON bom_edges (parent_id, fitting_stage)
  WHERE effective_to IS NULL;
