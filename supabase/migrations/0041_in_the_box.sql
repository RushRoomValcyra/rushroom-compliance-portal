-- 0041_in_the_box.sql — PROP-068: "In the box" replaces "reference child"
-- ============================================================================
-- Decided 2026-10-07 (docs/BOM_LOGIC_REVIEW.html). PROP-067 called the
-- contents of a bought item "reference children" and assumed they arrive
-- already fitted, so they could not carry Hub/Site. Real cases say otherwise:
--
--   L LED Profile — one order line, delivered loose: we fit the cover at the
--                   hub and the two clips on site.
--   Drawer hardware set — one order line, slides and screws in the box, fitted
--                   by us at the hub.
--
-- So contents are things we may work with. What stays true is rule 1: they
-- come with the parent's order line and are never their own order or pick line
-- (the planner resolver keeps skipping them). The dividing line is one
-- question — is it its own order line? Yes → it goes in a Prepared wrapper.
-- No → it is In the box.
--
-- The column keeps its name, is_reference: renaming it would touch every path
-- that copies a link for no change in meaning. Only the wording and the
-- Hub/Site restriction change.
--
-- No data to convert: production held 0 reference links on 2026-10-07.

-- 1. Hub/Site is allowed on contents. Set = where we fit it; empty = it
--    arrives fitted (or nobody has said yet).
ALTER TABLE bom_edges DROP CONSTRAINT IF EXISTS bom_edges_reference_unstaged;

COMMENT ON COLUMN bom_edges.is_reference IS
  'In the box: the child comes with the parent''s order line (loose or already fitted). Never its own order or pick line — the planner resolver skips these links. fitting_stage says where we fit it; NULL = arrives fitted / not decided.';

-- 2. Same matrix as 0040, new wording. Kept in step with
--    portal-api/handlers/bom-structure.ts and assets/bom-structure.js.
CREATE OR REPLACE FUNCTION bom_child_rule(p_type text, p_mob text, p_ref boolean)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_type = 'finished_good'
      THEN 'A finished good is bought and passed on untouched — it never holds children.'
    WHEN p_ref AND (p_mob <> 'purchased' OR p_type IN ('phantom_assembly', 'product_family'))
      THEN 'Only something we buy complete has an In the box: what comes with its order line.'
    WHEN NOT p_ref AND p_mob = 'purchased' AND p_type IN ('part', 'raw_material', 'spare_part', 'sub_assembly')
      THEN 'This is bought complete. Something ordered separately and fitted to it goes into its Prepared wrapper; something that comes with its order is In the box.'
    WHEN NOT p_ref AND p_mob = 'assembled' AND p_type IN ('part', 'raw_material', 'spare_part')
      THEN 'A part we put together is a sub-assembly. Change its Type first.'
  END
$$;

-- CREATE OR REPLACE keeps the grants from 0040; restated so this file stands alone.
REVOKE ALL ON FUNCTION bom_child_rule(text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bom_child_rule(text, text, boolean) TO service_role;
