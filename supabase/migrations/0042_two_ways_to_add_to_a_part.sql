-- 0042_two_ways_to_add_to_a_part.sql — PROP-069
-- ============================================================================
-- Decided 2026-10-07 after the first real use (docs/BOM_LOGIC_REVIEW.html §0b).
-- Adding the L LED Profile's clips took up to three dialogs of text, and a
-- Part with Sourcing "Assembled" blocked the obvious action, because a part's
-- children depended on its Sourcing. They no longer do:
--
--   A part never holds real children, whatever its Sourcing. There are two
--   ways to add to it: In the box (visual — comes with its order line, no
--   stock of its own, may carry Hub/Site) or a Prepared assembly (real
--   structure, under Assemblies; the part unchanged).
--
-- Sub-assemblies keep the Sourcing test: bought complete → In the box only;
-- built by us → real children only. Finished goods and Kits are unchanged.
--
-- Hub/Site stays on In-the-box links (2026-10-07): some contents are fitted at
-- the hub, some on site, and where something is installed or modified must
-- always be sayable.
--
-- No data changes: production held 0 In-the-box links and 0 real children
-- under parts on 2026-10-07. The check below proves it at apply time.

CREATE OR REPLACE FUNCTION bom_child_rule(p_type text, p_mob text, p_ref boolean)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_type = 'finished_good'
      THEN 'A finished good is bought and passed on untouched — it never holds children.'
    WHEN p_type IN ('part', 'raw_material', 'spare_part') AND NOT p_ref
      THEN 'A part never holds real children. Put it In the box, or make a Prepared assembly.'
    WHEN p_type = 'sub_assembly' AND p_mob = 'purchased' AND NOT p_ref
      THEN 'This assembly is bought complete — what is inside it goes In the box.'
    WHEN p_ref AND p_type IN ('sub_assembly', 'phantom_assembly', 'product_family') AND NOT (p_type = 'sub_assembly' AND p_mob = 'purchased')
      THEN 'Only a part, or an assembly we buy complete, has an In the box.'
  END
$$;

REVOKE ALL ON FUNCTION bom_child_rule(text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bom_child_rule(text, text, boolean) TO service_role;

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT p.name || ' (' || p.part_number || ')', ', ') INTO bad
    FROM bom_edges e JOIN bom_components p ON p.id = e.parent_id
   WHERE e.effective_to IS NULL
     AND bom_child_rule(p.type, p.make_or_buy, e.is_reference) IS NOT NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0042: existing links break the simplified rule: %', bad;
  END IF;
END $$;

-- A Prepared assembly can be made from any part now, whatever its Sourcing
-- (the L LED Profile says Assembled), and from an assembly bought complete.
CREATE OR REPLACE FUNCTION bom_wrap_in_prepared(
  p_org uuid, p_part uuid, p_parent uuid, p_all boolean, p_name text, p_user uuid)
RETURNS TABLE (wrapper_id uuid, wrapper_part_number text, wrapper_name text, relinked int)
LANGUAGE plpgsql AS $$
DECLARE
  part   record;
  e      record;
  w_id   uuid;
  w_pn   text;
  w_name text;
  n      int := 0;
BEGIN
  SELECT * INTO part FROM bom_components WHERE id = p_part AND organization_id = p_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOM_RULE: component not found';
  END IF;
  IF NOT (part.type IN ('part', 'raw_material', 'spare_part')
          OR (part.type = 'sub_assembly' AND part.make_or_buy = 'purchased')) THEN
    RAISE EXCEPTION 'BOM_RULE: %: only a part, or an assembly we buy complete, gets a Prepared assembly', part.name;
  END IF;
  w_name := coalesce(nullif(trim(p_name), ''), 'Prepared ' || part.name);

  LOOP  -- same format as addComponent: RR-YYYYMM-XXXXXXXX
    w_pn := 'RR-' || to_char(now(), 'YYYYMM') || '-' ||
            (SELECT string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
               FROM generate_series(1, 8));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM bom_components WHERE part_number = w_pn);
  END LOOP;

  INSERT INTO bom_components (organization_id, part_number, name, type, make_or_buy, created_by)
  VALUES (p_org, w_pn, w_name, 'sub_assembly', 'assembled', p_user)
  RETURNING id INTO w_id;
  INSERT INTO bom_component_versions (organization_id, component_id, revision, spec_summary, is_current, created_by)
  VALUES (p_org, w_id, 'A', 'Initial revision', true, p_user);
  INSERT INTO bom_component_history (organization_id, component_id, changed_by, change_type, part_number, name, type, notes)
  VALUES (p_org, w_id, p_user, 'version_bumped', w_pn, w_name, 'sub_assembly', 'Revision A: Initial revision');

  FOR e IN
    SELECT * FROM bom_edges
     WHERE child_id = p_part AND organization_id = p_org
       AND effective_to IS NULL AND NOT is_reference
       AND (p_all OR parent_id = p_parent)
  LOOP
    UPDATE bom_edges SET effective_to = current_date WHERE id = e.id;
    INSERT INTO bom_edges (organization_id, parent_id, child_id, quantity, reference_designator,
                           variant_condition, sort_order, fitting_stage, effective_from)
    VALUES (p_org, e.parent_id, w_id, e.quantity, e.reference_designator,
            e.variant_condition, e.sort_order, e.fitting_stage, current_date);
    n := n + 1;
  END LOOP;

  INSERT INTO bom_edges (organization_id, parent_id, child_id, quantity, sort_order, effective_from)
  VALUES (p_org, w_id, p_part, 1, 10, current_date);

  INSERT INTO bom_component_history (organization_id, component_id, changed_by, change_type, part_number,
                                     oem_number, name, description, type, lifecycle_status, notes)
  VALUES (p_org, p_part, p_user, 'updated', part.part_number, part.oem_number, part.name, part.description,
          part.type, part.lifecycle_status, format('Wrapped in "%s" (%s)', w_name, w_pn));

  RETURN QUERY SELECT w_id, w_pn, w_name, n;
END $$;

REVOKE ALL ON FUNCTION bom_wrap_in_prepared(uuid, uuid, uuid, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bom_wrap_in_prepared(uuid, uuid, uuid, boolean, text, uuid) TO service_role;
