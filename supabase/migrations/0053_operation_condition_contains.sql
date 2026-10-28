-- An operation's condition can say what the neighbouring module holds
-- (Order Operations item 0039, slice 5). Drawer runner holes are needed next
-- to every module with drawers, whatever its interior preset, so the rule is
-- {"contains": "drawer_set"} rather than one per preset. The kinds are the
-- planner's item keys without size and colour (valcyra-site partKeys.js);
-- portal-api checks them. Documentation only: the column already takes any
-- object.
COMMENT ON COLUMN component_routing_steps.variant_condition IS
  'When the operation applies: {"face": "left"|"right", "size": "S"|"M"|"L", "interior": <planner interior code>, "contains": "drawer_set"|"shelf"|"hanger"|"led_ramp"|"beautybox"|"removable_panel_back_full"}; each key optional, NULL means always.';
