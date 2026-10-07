-- 0043_prepared_part.sql — PROP-071: which child a Prepared assembly prepares
-- ============================================================================
-- Decided 2026-10-07. A Prepared assembly holds a bought part plus what we fit
-- to it at the hub or on site (rule 2). On screen those were plain siblings,
-- so "the door and its hardware" read as five unrelated rows — and Move made
-- it look as if hardware had to leave the door's structure.
--
-- The link from a Prepared assembly to the part it prepares is now marked, so
-- the tree can show that part first and the rest as fitted to it. Marked on
-- the LINK, like quantity and Hub/Site: the same part may sit plainly in a Kit
-- elsewhere, and unlinking it removes the mark with it.
--
-- One per assembly. Never on an In-the-box link (that is contents, not the
-- thing being prepared).

ALTER TABLE bom_edges ADD COLUMN IF NOT EXISTS is_prepared_part BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN bom_edges.is_prepared_part IS
  'true = the child is the bought part this Prepared assembly prepares; its siblings are what we fit to it. At most one active per parent.';

ALTER TABLE bom_edges DROP CONSTRAINT IF EXISTS bom_edges_prepared_not_in_box;
ALTER TABLE bom_edges ADD CONSTRAINT bom_edges_prepared_not_in_box
  CHECK (NOT (is_prepared_part AND is_reference));

CREATE UNIQUE INDEX IF NOT EXISTS bom_edges_one_prepared_part
  ON bom_edges (parent_id)
  WHERE is_prepared_part AND effective_to IS NULL;

-- Existing Prepared assemblies, by part number — reviewed one by one on
-- 2026-10-07 against production: in each, the bought part is the first child.
-- Prepared Mid Panel - White (RR-202609-7C4GCN8M) is deliberately absent: it
-- holds no panel at all, only hardware, so there is nothing to mark.
-- A no-op on a database without these rows.
UPDATE bom_edges e
   SET is_prepared_part = true
  FROM bom_components w
 WHERE e.parent_id = w.id
   AND e.effective_to IS NULL
   AND NOT e.is_reference
   AND w.part_number IN (
     'RR-202609-AA8MEN62', 'RR-202610-AB529UAL', 'RR-202609-4457HA2M', 'RR-202610-GDNNHNLL',
     'RR-202609-NUVAFFRR', 'RR-202609-VH6TG56K', 'RR-202610-VQFKYK33', 'RR-202609-KYELQLWH',
     'RR-202610-XEYYF2G6', 'RR-202609-PGNBPUK6', 'RR-202609-DEFPG54X', 'RR-202609-U8QTFCGM',
     'RR-202609-WWQTVTEA', 'RR-202610-EUDWSHL4', 'RR-202610-R75DNXFD', 'RR-202609-H7EEGK5Z',
     'RR-202610-QHEKMU6M', 'RR-202610-VPD4JKD5', 'RR-202609-UJ884EKT', 'RR-202610-QQ8C7FEW',
     'RR-202609-JYH8L6TW')
   AND e.id = (
     SELECT e2.id FROM bom_edges e2
       JOIN bom_components c ON c.id = e2.child_id
      WHERE e2.parent_id = w.id AND e2.effective_to IS NULL AND NOT e2.is_reference
        AND c.type IN ('part', 'raw_material', 'spare_part')
      ORDER BY e2.sort_order NULLS LAST, e2.id
      LIMIT 1);

-- New Prepared assemblies mark the link themselves. Same function as 0042,
-- one change: the wrapper → part link is inserted with is_prepared_part.
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

  INSERT INTO bom_edges (organization_id, parent_id, child_id, quantity, sort_order, effective_from, is_prepared_part)
  VALUES (p_org, w_id, p_part, 1, 10, current_date, true);

  INSERT INTO bom_component_history (organization_id, component_id, changed_by, change_type, part_number,
                                     oem_number, name, description, type, lifecycle_status, notes)
  VALUES (p_org, p_part, p_user, 'updated', part.part_number, part.oem_number, part.name, part.description,
          part.type, part.lifecycle_status, format('Wrapped in "%s" (%s)', w_name, w_pn));

  RETURN QUERY SELECT w_id, w_pn, w_name, n;
END $$;

REVOKE ALL ON FUNCTION bom_wrap_in_prepared(uuid, uuid, uuid, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bom_wrap_in_prepared(uuid, uuid, uuid, boolean, text, uuid) TO service_role;
