-- 0039_drawer_hardware_set.sql — the drawer hardware set is one bought line
-- ============================================================================
-- Decided 2026-10-06 (docs/BOM_LOGIC_REVIEW.html, case G and question 12):
--
--   A drawer is a hardware set bought from one supplier, plus a bottom and a
--   back panel from our panel supplier, pre-assembled at the hub. On a
--   customer order the front and handle are fitted, also at the hub.
--   Drawers come in pairs — the cabinets are designed for two.
--
-- The hardware set ("L/M Drawer Set ex Front") arrives with its slides and
-- EURO screws in the box. By rule 1 (buy unit = BOM line) it is ONE line with
-- no children: modelled with children, the planner resolver would send Order
-- Operations slides and screws to pick instead of the set.
--
-- That makes migration 0038's Prepared Drawer Slides LEFT/RIGHT wrong: they
-- wrapped contents of the box, not work we do. This migration
--
--   1. closes the hardware sets' child links and retires the two Prepared
--      Drawer Slides wrappers (marked 'replaced', nothing deleted);
--   2. makes each hardware set a `part` — a purchased buy unit;
--   3. marks the L/M Prepared Drawer Sets and the Prepared Wide/Narrow Doors
--      as Assembled: they are our hub work, not something we buy.
--
-- Deliberately NOT done here, waiting on facts that do not exist yet:
--   - drawer bottom and back panel: the parts are not in the catalogue;
--   - handles on the Prepared doors: which colours are stocked.
--
-- Drawer Slides LEFT/RIGHT and EURO Screw 13mm stay in the catalogue, linked
-- to nothing, in case they are ever bought as spares.
--
-- Same shape as 0038: one block, all-or-nothing, re-runnable, a no-op on a
-- database without these rows, and it aborts if any part would hold children
-- or any planner quantity would change.

DO $mig$
DECLARE
  hw        record;
  w         record;
  n_closed  int;
  report    text := '';
  bad       text;
  hw_sets   constant text[] := ARRAY['RR-202609-ALVZKBQR', 'RR-202609-S6SGGE5W'];  -- L / M Drawer Set ex Front
  slide_wrappers constant text[] := ARRAY['RR-202610-Q7LCHNSZ', 'RR-202610-AKQFGS7X'];  -- Prepared Drawer Slides LEFT / RIGHT (0038)
  our_work  constant text[] := ARRAY['RR-202609-AA8MEN62', 'RR-202609-VH6TG56K',     -- L / M Prepared Drawer Set Excluding Front
                                     'RR-202609-H7EEGK5Z', 'RR-202609-U8QTFCGM'];    -- Prepared Wide / Narrow Left/Right Door
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bom_components WHERE part_number = 'RR-202609-ALVZKBQR') THEN
    RAISE NOTICE '0039: production BOM rows not present — nothing to do';
    RETURN;
  END IF;

  CREATE TEMP TABLE _leaf_before ON COMMIT DROP AS
  WITH RECURSIVE t(root, node, qty, depth) AS (
    SELECT m.target_component_id, m.target_component_id, 1::numeric, 0
      FROM (SELECT DISTINCT target_component_id FROM planner_mappings WHERE is_active) m
    UNION ALL
    SELECT t.root, ed.child_id, t.qty * ed.quantity, t.depth + 1
      FROM t JOIN bom_edges ed ON ed.parent_id = t.node AND ed.effective_to IS NULL
     WHERE t.depth < 25
  )
  SELECT root, node AS leaf, sum(qty) AS qty FROM t
   WHERE NOT EXISTS (SELECT 1 FROM bom_edges x WHERE x.parent_id = t.node AND x.effective_to IS NULL)
   GROUP BY 1, 2;

  -- 1 + 2. Each hardware set: close its child links, become a part.
  FOR hw IN SELECT * FROM bom_components WHERE part_number = ANY (hw_sets) ORDER BY part_number LOOP
    UPDATE bom_edges SET effective_to = current_date
     WHERE parent_id = hw.id AND effective_to IS NULL;
    GET DIAGNOSTICS n_closed = ROW_COUNT;
    IF hw.type <> 'part' THEN
      -- The UPDATE trigger records the type change in the Change Log.
      UPDATE bom_components
         SET type = 'part', make_or_buy = 'purchased', updated_at = now()
       WHERE id = hw.id;
    END IF;
    IF n_closed > 0 OR hw.type <> 'part' THEN
      INSERT INTO bom_component_history (organization_id, component_id, change_type, part_number, oem_number,
                                         name, description, type, lifecycle_status, notes)
      VALUES (hw.organization_id, hw.id, 'updated', hw.part_number, hw.oem_number, hw.name, hw.description,
              'part', hw.lifecycle_status,
              format('Bought as one hardware set — slides and screws come in the box, so %s child links closed (migration 0039)', n_closed));
      report := report || format(E'set      %s  %s  → part, %s child links closed\n', hw.part_number, hw.name, n_closed);
    ELSE
      report := report || format(E'skipped  %s  %s  (already done)\n', hw.part_number, hw.name);
    END IF;
  END LOOP;

  -- 1. Retire the Prepared Drawer Slides wrappers 0038 created.
  FOR w IN SELECT * FROM bom_components WHERE part_number = ANY (slide_wrappers) ORDER BY part_number LOOP
    IF w.lifecycle_status = 'replaced' THEN
      report := report || format(E'skipped  %s  %s  (already retired)\n', w.part_number, w.name);
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM bom_edges ed JOIN bom_components par ON par.id = ed.parent_id
       WHERE ed.child_id = w.id AND ed.effective_to IS NULL AND par.lifecycle_status <> 'replaced'
    ) THEN
      RAISE EXCEPTION '0039: % (%) is still used by a live assembly — not retiring it', w.name, w.part_number;
    END IF;
    UPDATE bom_edges SET effective_to = current_date WHERE parent_id = w.id AND effective_to IS NULL;
    GET DIAGNOSTICS n_closed = ROW_COUNT;
    UPDATE bom_components
       SET lifecycle_status = 'replaced',
           replacement_note = 'Created by migration 0038 around contents of the bought drawer hardware set. The set is one line (rule 1: buy unit = BOM line). Retired 2026-10-06 (migration 0039).',
           name = CASE WHEN name LIKE '%(retired)' THEN name ELSE name || ' (retired)' END,
           updated_at = now()
     WHERE id = w.id;
    report := report || format(E'retired  %s  %s  (closed %s child links)\n', w.part_number, w.name, n_closed);
  END LOOP;

  -- 3. Our hub work is Assembled.
  FOR w IN SELECT * FROM bom_components WHERE part_number = ANY (our_work) ORDER BY part_number LOOP
    IF w.make_or_buy <> 'assembled' THEN
      UPDATE bom_components SET make_or_buy = 'assembled', updated_at = now() WHERE id = w.id;
      INSERT INTO bom_component_history (organization_id, component_id, change_type, part_number, oem_number,
                                         name, description, type, lifecycle_status, notes)
      VALUES (w.organization_id, w.id, 'updated', w.part_number, w.oem_number, w.name, w.description,
              w.type, w.lifecycle_status, 'Sourcing: Purchased → Assembled — pre-assembled at the hub (migration 0039)');
      report := report || format(E'sourcing %s  %s  → Assembled\n', w.part_number, w.name);
    ELSE
      report := report || format(E'skipped  %s  %s  (already Assembled)\n', w.part_number, w.name);
    END IF;
  END LOOP;

  -- Guard 1: no part is a parent.
  SELECT string_agg(DISTINCT par.name || ' (' || par.part_number || ')', ', ') INTO bad
    FROM bom_edges ed JOIN bom_components par ON par.id = ed.parent_id
   WHERE ed.effective_to IS NULL AND par.type = 'part';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0039 aborted: parts holding children: %', bad;
  END IF;

  -- Guard 2: no drawer structure is reachable from a planner mapping, so
  -- nothing Order Operations receives may change at all.
  CREATE TEMP TABLE _leaf_after ON COMMIT DROP AS
  WITH RECURSIVE t(root, node, qty, depth) AS (
    SELECT m.target_component_id, m.target_component_id, 1::numeric, 0
      FROM (SELECT DISTINCT target_component_id FROM planner_mappings WHERE is_active) m
    UNION ALL
    SELECT t.root, ed.child_id, t.qty * ed.quantity, t.depth + 1
      FROM t JOIN bom_edges ed ON ed.parent_id = t.node AND ed.effective_to IS NULL
     WHERE t.depth < 25
  )
  SELECT root, node AS leaf, sum(qty) AS qty FROM t
   WHERE NOT EXISTS (SELECT 1 FROM bom_edges x WHERE x.parent_id = t.node AND x.effective_to IS NULL)
   GROUP BY 1, 2;

  SELECT string_agg(format('%s / %s', r.name, c.name), '; ') INTO bad
    FROM ((SELECT root, leaf, qty FROM _leaf_before
           EXCEPT SELECT root, leaf, qty FROM _leaf_after)
          UNION ALL
          (SELECT root, leaf, qty FROM _leaf_after
           EXCEPT SELECT root, leaf, qty FROM _leaf_before)) d
    JOIN bom_components r ON r.id = d.root
    JOIN bom_components c ON c.id = d.leaf;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0039 aborted: planner output would change: %', bad;
  END IF;

  RAISE NOTICE E'0039 done:\n%', report;
END
$mig$;
