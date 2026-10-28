-- 0052_operations_on_components.sql — what we do to a component, and where
-- ============================================================================
-- Decided 2026-10-27 with Order Operations (its item 0039, decisions 0011 and
-- 0012): this portal defines which operations a component takes (drill a
-- customer's holes, route a cut-out), and Order Operations runs them for each
-- customer order, with the positions the wardrobe planner sends.
--
-- Operations were scoped to a product family (0019), a named set unrelated to
-- the planner and the dynamic BOM, so an order could never reach them.
-- They now belong to the component itself: family_id becomes optional and is
-- kept only for the old Manufacturing BOM screen until it is retired.
--
-- stage says where the operation is done, with the same answers as Fitted on a
-- BOM link (0036, 0045): 'hub', 'site', or empty when nobody has said yet.
-- Order Operations runs the Hub operations; Site operations are instructions
-- for the installer.
--
-- When it applies (decided 2026-10-28): most holes come predrilled from the
-- supplier; the hub adds the rest, and which ones depends on the module next
-- to each face of a side panel. variant_condition (already on the table) holds
-- that condition, e.g. {"face": "left", "size": "L", "interior": 1}: face as
-- seen from the front, the module's size, and the planner's interior code.
-- Empty means always. Order Operations matches it against each side panel's
-- neighbours in the customer's configuration. The hole pattern itself is a
-- drawing of the part in the Drawings section (drawing_id).
--
-- Production held 0 routing steps on 2026-10-27, so nothing is converted.

ALTER TABLE component_routing_steps ALTER COLUMN family_id DROP NOT NULL;

ALTER TABLE component_routing_steps
  ADD COLUMN IF NOT EXISTS stage TEXT CHECK (stage IS NULL OR stage IN ('hub', 'site'));

ALTER TABLE component_routing_steps
  ADD COLUMN IF NOT EXISTS drawing_id UUID REFERENCES drawings(id) ON DELETE SET NULL;

ALTER TABLE component_routing_steps
  ADD CONSTRAINT component_routing_steps_condition_is_object
  CHECK (variant_condition IS NULL OR jsonb_typeof(variant_condition) = 'object');

-- The table's UNIQUE (component_id, family_id, step_number) treats every
-- empty family as different, so operations on the component need their own.
CREATE UNIQUE INDEX IF NOT EXISTS component_routing_steps_component_step_key
  ON component_routing_steps (component_id, step_number)
  WHERE family_id IS NULL;

COMMENT ON TABLE component_routing_steps IS
  'Operations: what we do to a component (drill, route, insert…). Owned by the component; family_id only for the legacy product-family screen. Order Operations runs the Hub operations per customer order.';
COMMENT ON COLUMN component_routing_steps.stage IS
  'Where the operation is done: hub, site, or NULL when not decided yet.';
COMMENT ON COLUMN component_routing_steps.variant_condition IS
  'When the operation applies: {"face": "left"|"right", "size": "S"|"M"|"L", "interior": <planner interior code>}; each key optional, NULL means always.';
COMMENT ON COLUMN component_routing_steps.drawing_id IS
  'The drawing that shows the hole or milling pattern (Drawings section).';
