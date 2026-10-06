-- 0038_prepared_wrappers.sql — a purchased part never holds children
-- ============================================================================
-- Decided 2026-10-06 (docs/BOM_LOGIC_REVIEW.html, section 5b and the cleanup
-- table): a part we buy complete has no structure of its own. The work we do
-- to it — legs, holders, pins, dowels fitted at the hub or on site — lives in
-- its "Prepared …" sub-assembly, which is Assembled. The part stays exactly
-- what we buy, so its supplier documents and drawings stay true.
--
-- Production had 24 parts holding 42 child links, built up through +child
-- before 2026-10-05 and spread by the copy dialog. This migration moves every
-- one of them:
--
--   INTO   the part already sits in its Prepared wrapper: move its children
--          up into the wrapper.
--   NEW    no usable wrapper: create one (sub_assembly, assembled), put it
--          where the part was, put the part ×1 inside it, then move the
--          children in.
--   RETIRE unused copies, and the three Prepared Fixed Back Panels that held
--          the panel ×2 and were wired in nowhere: close their child links,
--          mark them 'replaced', suffix the name with "(retired)". Nothing is
--          deleted.
--
-- Every moved link keeps quantity, reference designator, variant condition
-- and fitting stage. Links are closed (effective_to) and reopened, never
-- updated in place, so the history of the old structure stays readable.
--
-- Data, not schema: keyed by part number, so on any database that does not
-- hold these rows (a fresh local reset) the whole block is a no-op.
--
-- Two guards make the block abort — and therefore change nothing — rather
-- than leave a half-moved BOM:
--   1. No active link may have a `part` as its parent afterwards.
--   2. What the planner resolver sends Order Operations must not lose or
--      change any quantity. The resolver emits leaves only, so a part holding
--      children was itself missing from every resolved BOM. The ONLY change
--      allowed is that the wrapped parts now appear, as the leaves they are.

DO $mig$
DECLARE
  step      record;
  p         record;   -- the part being handled
  w         record;   -- its wrapper
  e         record;
  w_id      uuid;
  w_pn      text;
  next_sort int;
  n_moved   int;
  report    text := '';
  bad       text;
  chars     constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bom_components WHERE part_number = 'RR-202609-G26N4P8A') THEN
    RAISE NOTICE '0038: production BOM rows not present — nothing to do';
    RETURN;
  END IF;

  -- Planner leaf totals BEFORE, computed the way planner-resolver-core.mjs
  -- walks: every active edge, quantities multiplied down, leaves summed.
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

  CREATE TEMP TABLE _wrapped (part_id uuid PRIMARY KEY) ON COMMIT DROP;

  FOR step IN
    SELECT * FROM (VALUES
      -- RETIRE: copies made by the copy dialog, used nowhere (or only inside
      -- another unused copy).
      ( 1, 'retire', 'RR-202609-JUNQL3H3', 'Unused copy of S Plinth - White. Retired 2026-10-06 (migration 0038).'),
      ( 2, 'retire', 'RR-202609-X56RQ6C4', 'Unused copy of Seat to Door Switch - White. Retired 2026-10-06 (migration 0038).'),
      ( 3, 'retire', 'RR-202609-UMLW47EN', 'Unused copy of Seat to Door Switch - White. Retired 2026-10-06 (migration 0038).'),
      ( 4, 'retire', 'RR-202609-S45KFX3W', 'Unused copy of S Bottom - White. Retired 2026-10-06 (migration 0038).'),
      ( 5, 'retire', 'RR-202609-NZK5KJMA', 'Unused copy of S LED Shelf - White. Retired 2026-10-06 (migration 0038).'),
      -- RETIRE: Prepared Fixed Back Panels holding the panel ×2, used nowhere.
      -- Replaced by new wrappers holding ×1 (steps 30–32), like every other
      -- Prepared wrapper.
      ( 6, 'retire', 'RR-202609-V8QXNQ7Y', 'Held the panel ×2 and was used nowhere. Replaced 2026-10-06 by a new L Prepared Fixed Back Panel holding ×1 (migration 0038).'),
      ( 7, 'retire', 'RR-202609-8BNLEEUQ', 'Held the panel ×2 and was used nowhere. Replaced 2026-10-06 by a new M Prepared Fixed Back Panel holding ×1 (migration 0038).'),
      ( 8, 'retire', 'RR-202609-CU984PSY', 'Held the panel ×2 and was used nowhere. Replaced 2026-10-06 by a new S Prepared Fixed Back Panel holding ×1 (migration 0038).'),

      -- NEW: small bought parts with something fitted to them. The door
      -- switch arrives unmounted; the screws fix the slides.
      (10, 'new', 'RR-202609-UCGKWTMZ', 'Prepared Seat to Door Switch - White'),
      (11, 'new', 'RR-202609-SHGMU7CC', 'Prepared Drawer Slides LEFT'),
      (12, 'new', 'RR-202609-FVNCJE7D', 'Prepared Drawer Slides RIGHT'),

      -- INTO: the Prepared wrapper already exists and holds the part.
      (20, 'into', 'RR-202609-G26N4P8A', 'RR-202609-DEFPG54X'),  -- Left Side Panel
      (21, 'into', 'RR-202609-BC3QZGRD', 'RR-202609-WWQTVTEA'),  -- Right Side Panel
      (22, 'into', 'RR-202609-7WSSCV56', 'RR-202609-NUVAFFRR'),  -- L Shelf
      (23, 'into', 'RR-202609-3T39YDLW', 'RR-202609-PGNBPUK6'),  -- M Shelf
      (24, 'into', 'RR-202609-ZVNBVUMX', 'RR-202609-JYH8L6TW'),  -- S Shelf
      (25, 'into', 'RR-202609-5TFEW7WH', 'RR-202609-4457HA2M'),  -- L LED Shelf
      (26, 'into', 'RR-202609-LBG8Z7DY', 'RR-202609-KYELQLWH'),  -- M LED Shelf
      (27, 'into', 'RR-202609-NR298GGY', 'RR-202609-UJ884EKT'),  -- S LED Shelf
      (28, 'into', 'RR-202609-4Y6HG8PL', 'RR-202610-EUDWSHL4'),  -- S Middle Door

      -- NEW: panels that sit directly in a Module Common Parts kit.
      (30, 'new', 'RR-202609-2XJV8PJK', 'L Prepared Fixed Back Panel - White'),
      (31, 'new', 'RR-202609-L325ZQQF', 'M Prepared Fixed Back Panel - White'),
      (32, 'new', 'RR-202609-7UCQ55KY', 'S Prepared Fixed Back Panel - White'),
      (33, 'new', 'RR-202609-AJPDGV6Q', 'L Prepared Plinth - White'),
      (34, 'new', 'RR-202609-QVFJ5PSJ', 'M Prepared Plinth - White'),
      (35, 'new', 'RR-202609-8VDLC4KG', 'S Prepared Plinth - White'),
      (36, 'new', 'RR-202609-W5TK6ZGW', 'S Prepared Bottom - White')
    ) AS v(seq, op, pn, arg)
    ORDER BY seq
  LOOP
    SELECT * INTO p FROM bom_components WHERE part_number = step.pn;
    IF NOT FOUND THEN
      RAISE EXCEPTION '0038 step %: component % not found', step.seq, step.pn;
    END IF;

    -- Re-runnable: a step whose work is already done is skipped, so running
    -- the block twice (e.g. pasted after `db push`) cannot wrap a wrapper.
    IF (step.op = 'retire' AND p.lifecycle_status = 'replaced')
       OR (step.op <> 'retire' AND NOT EXISTS (
             SELECT 1 FROM bom_edges WHERE parent_id = p.id AND effective_to IS NULL)) THEN
      report := report || format(E'skipped  %s  %s  (already done)\n', p.part_number, p.name);
      CONTINUE;
    END IF;

    -- ---------------------------------------------------------------- RETIRE
    IF step.op = 'retire' THEN
      IF EXISTS (
        SELECT 1 FROM bom_edges ed
          JOIN bom_components par ON par.id = ed.parent_id
         WHERE ed.child_id = p.id AND ed.effective_to IS NULL
           AND par.lifecycle_status <> 'replaced'
      ) THEN
        RAISE EXCEPTION '0038 step %: % (%) is still used by a live assembly — not retiring it', step.seq, p.name, p.part_number;
      END IF;
      UPDATE bom_edges SET effective_to = current_date
       WHERE parent_id = p.id AND effective_to IS NULL;
      GET DIAGNOSTICS n_moved = ROW_COUNT;
      UPDATE bom_components
         SET lifecycle_status = 'replaced',
             replacement_note = step.arg,
             name = CASE WHEN name LIKE '%(retired)' THEN name ELSE name || ' (retired)' END,
             updated_at = now()
       WHERE id = p.id;
      report := report || format(E'retired  %s  %s  (closed %s child links)\n', p.part_number, p.name, n_moved);
      CONTINUE;
    END IF;

    -- ------------------------------------------------------- find / make wrapper
    IF step.op = 'into' THEN
      SELECT * INTO w FROM bom_components WHERE part_number = step.arg;
      IF NOT FOUND THEN
        RAISE EXCEPTION '0038 step %: wrapper % not found', step.seq, step.arg;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM bom_edges WHERE parent_id = w.id AND child_id = p.id AND effective_to IS NULL) THEN
        RAISE EXCEPTION '0038 step %: % does not hold % — refusing to guess', step.seq, w.name, p.name;
      END IF;
      w_id := w.id;
      UPDATE bom_components SET make_or_buy = 'assembled', updated_at = now()
       WHERE id = w_id AND make_or_buy <> 'assembled';

    ELSE -- 'new'
      LOOP
        w_pn := 'RR-' || to_char(now(), 'YYYYMM') || '-' ||
                (SELECT string_agg(substr(chars, 1 + floor(random() * 32)::int, 1), '')
                   FROM generate_series(1, 8));
        EXIT WHEN NOT EXISTS (SELECT 1 FROM bom_components WHERE part_number = w_pn);
      END LOOP;

      -- The INSERT trigger writes the 'created' history row.
      INSERT INTO bom_components (organization_id, part_number, name, type, make_or_buy, lifecycle_status, notes)
      VALUES (p.organization_id, w_pn, step.arg, 'sub_assembly', 'assembled', 'inactive',
              format('Prepared wrapper for %s (%s). Created by migration 0038.', p.name, p.part_number))
      RETURNING id INTO w_id;
      SELECT * INTO w FROM bom_components WHERE id = w_id;

      -- Same as addComponent: revision A, and a version_bumped row so it shows
      -- in the Change Log timeline.
      INSERT INTO bom_component_versions (organization_id, component_id, revision, spec_summary, is_current)
      VALUES (p.organization_id, w_id, 'A', 'Initial revision', true);
      INSERT INTO bom_component_history (organization_id, component_id, change_type, part_number, name, type, notes)
      VALUES (p.organization_id, w_id, 'version_bumped', w_pn, step.arg, 'sub_assembly', 'Revision A: Initial revision');

      -- Put the wrapper wherever the part was, in the same position, with the
      -- same quantity and stage. Close first: the cycle trigger is BEFORE
      -- INSERT and must see the post-move ancestry.
      FOR e IN
        SELECT ed.* FROM bom_edges ed
          JOIN bom_components par ON par.id = ed.parent_id
         WHERE ed.child_id = p.id AND ed.effective_to IS NULL
           AND par.lifecycle_status <> 'replaced'
      LOOP
        UPDATE bom_edges SET effective_to = current_date WHERE id = e.id;
        INSERT INTO bom_edges (organization_id, parent_id, child_id, quantity, reference_designator,
                               variant_condition, sort_order, fitting_stage, effective_from)
        VALUES (e.organization_id, e.parent_id, w_id, e.quantity, e.reference_designator,
                e.variant_condition, e.sort_order, e.fitting_stage, current_date);
      END LOOP;

      INSERT INTO bom_edges (organization_id, parent_id, child_id, quantity, sort_order, effective_from)
      VALUES (p.organization_id, w_id, p.id, 1, 10, current_date);
    END IF;

    -- ------------------------------------------------- move children up
    SELECT coalesce(max(sort_order), 0) INTO next_sort
      FROM bom_edges WHERE parent_id = w_id AND effective_to IS NULL;
    n_moved := 0;
    FOR e IN
      SELECT * FROM bom_edges WHERE parent_id = p.id AND effective_to IS NULL
       ORDER BY sort_order NULLS LAST, id
    LOOP
      next_sort := next_sort + 10;
      UPDATE bom_edges SET effective_to = current_date WHERE id = e.id;
      INSERT INTO bom_edges (organization_id, parent_id, child_id, quantity, reference_designator,
                             variant_condition, sort_order, fitting_stage, effective_from)
      VALUES (e.organization_id, w_id, e.child_id, e.quantity, e.reference_designator,
              e.variant_condition, next_sort, e.fitting_stage, current_date);
      -- Same audit as moveComponentToParent.
      INSERT INTO bom_component_history (organization_id, component_id, change_type, part_number, oem_number,
                                         name, description, type, lifecycle_status, notes)
      SELECT c.organization_id, c.id, 'updated', c.part_number, c.oem_number, c.name, c.description,
             c.type, c.lifecycle_status, format('Moved to assembly "%s" (migration 0038)', w.name)
        FROM bom_components c WHERE c.id = e.child_id;
      n_moved := n_moved + 1;
    END LOOP;

    INSERT INTO bom_component_history (organization_id, component_id, change_type, part_number, oem_number,
                                       name, description, type, lifecycle_status, notes)
    VALUES (p.organization_id, p.id, 'updated', p.part_number, p.oem_number, p.name, p.description,
            p.type, p.lifecycle_status,
            format('Its %s fitted parts moved to "%s" — a purchased part holds no children (migration 0038)', n_moved, w.name));

    INSERT INTO _wrapped VALUES (p.id) ON CONFLICT DO NOTHING;
    report := report || format(E'%-6s  %s  %s  →  %s %s  (%s children moved)\n',
                               step.op, p.part_number, p.name, w.part_number, w.name, n_moved);
  END LOOP;

  -- Guard 1: no part is a parent any more.
  SELECT string_agg(DISTINCT par.name || ' (' || par.part_number || ')', ', ') INTO bad
    FROM bom_edges ed JOIN bom_components par ON par.id = ed.parent_id
   WHERE ed.effective_to IS NULL AND par.type = 'part';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0038 aborted: parts still holding children: %', bad;
  END IF;

  -- Guard 2: planner output loses nothing; only the wrapped parts appear.
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

  SELECT string_agg(format('%s / %s: %s → %s', r.name, c.name, b.qty, coalesce(a.qty::text, 'gone')), '; ') INTO bad
    FROM _leaf_before b
    LEFT JOIN _leaf_after a ON a.root = b.root AND a.leaf = b.leaf
    JOIN bom_components r ON r.id = b.root
    JOIN bom_components c ON c.id = b.leaf
   WHERE a.qty IS DISTINCT FROM b.qty;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0038 aborted: planner quantities would change: %', bad;
  END IF;

  SELECT string_agg(format('%s / %s', r.name, c.name), '; ') INTO bad
    FROM _leaf_after a
    JOIN bom_components r ON r.id = a.root
    JOIN bom_components c ON c.id = a.leaf
   WHERE NOT EXISTS (SELECT 1 FROM _leaf_before b WHERE b.root = a.root AND b.leaf = a.leaf)
     AND a.leaf NOT IN (SELECT part_id FROM _wrapped);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0038 aborted: unexpected new planner lines: %', bad;
  END IF;

  SELECT report || E'\nNow reaching Order Operations (were missing):\n' ||
         coalesce(string_agg(format('  %s  ←  %s ×%s', c.name, r.name, a.qty), E'\n' ORDER BY r.name, c.name), '  none')
    INTO report
    FROM _leaf_after a
    JOIN bom_components r ON r.id = a.root
    JOIN bom_components c ON c.id = a.leaf
   WHERE NOT EXISTS (SELECT 1 FROM _leaf_before b WHERE b.root = a.root AND b.leaf = a.leaf);

  RAISE NOTICE E'0038 done:\n%', report;
  -- @dryrun
END
$mig$;
