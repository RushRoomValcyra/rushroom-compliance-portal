-- 0044_drop_prepared_part.sql — remove PROP-071's "part being prepared" mark
-- ============================================================================
-- Decided 2026-10-07: the ◆ BEING PREPARED label added nothing. Where value is
-- added is already said by the Fitted column on every link — nothing (picked
-- as is), Hub (prepared / pre-assembled at the hub) or Site (fitted at the
-- customer). A second way of saying it is noise.
--
-- Removed completely rather than hidden: a value stored and shown nowhere is
-- the "accepted and displayed nowhere" pattern (docs/ROADMAP.md). The column,
-- its index and CHECK go, and bom_wrap_in_prepared returns to its 0042 form.
-- Nothing else read the column.

DROP INDEX IF EXISTS bom_edges_one_prepared_part;
ALTER TABLE bom_edges DROP CONSTRAINT IF EXISTS bom_edges_prepared_not_in_box;

-- The function first: its 0043 body inserts into the column being dropped.
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

ALTER TABLE bom_edges DROP COLUMN IF EXISTS is_prepared_part;
