-- 0040_bom_structure_rules.sql — PROP-067: which parent may hold which child
-- ============================================================================
-- Decided 2026-10-06 on docs/BOM_LOGIC_REVIEW.html (rules §6b, questions 4,
-- 7, 8, 10, flow §5b):
--
--   * Buy unit = pick line. What is inside a bought item as delivered may be
--     recorded as REFERENCE children: greyed, never picked, never staged.
--   * A bought part never holds children we fit; that work lives in its
--     Prepared wrapper, which the portal builds (bom_wrap_in_prepared).
--   * A finished good is always bought and never holds children.
--
-- Until now the only guard was an app-level type check in addBomEdge, which
-- move, copy and materialise bypassed, and which was too strict (it refused
-- Dynamic BOMs). The rule now lives here, once, so every path obeys it.
--
-- Manufactured and Subcontracted parts are deliberately left open: there is no
-- real case in production yet (questions 2, 3, 5 — "until we hit the wall").

-- 1. Reference children ------------------------------------------------------
ALTER TABLE bom_edges ADD COLUMN IF NOT EXISTS is_reference BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN bom_edges.is_reference IS
  'true = the child is inside the parent as delivered (contents of a bought item). Recorded for compliance; never picked, never staged. The planner resolver skips these links.';

-- A reference child arrives fitted, so "where is it fitted" has no answer.
ALTER TABLE bom_edges DROP CONSTRAINT IF EXISTS bom_edges_reference_unstaged;
ALTER TABLE bom_edges ADD CONSTRAINT bom_edges_reference_unstaged
  CHECK (NOT is_reference OR fitting_stage IS NULL);

-- 2. A finished good is always bought (question 7) -------------------------
ALTER TABLE bom_components DROP CONSTRAINT IF EXISTS bom_components_finished_good_purchased;
ALTER TABLE bom_components ADD CONSTRAINT bom_components_finished_good_purchased
  CHECK (type <> 'finished_good' OR make_or_buy = 'purchased');

-- 3. The rule matrix, once. NULL = allowed; otherwise the reason it is not.
--    assets/bom-structure.js mirrors this table so the UI only offers moves
--    the database will accept; tests/bom-structure-rules.test.mjs keeps the
--    two in step.
CREATE OR REPLACE FUNCTION bom_child_rule(p_type text, p_mob text, p_ref boolean)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_type = 'finished_good'
      THEN 'A finished good is bought and passed on untouched — it never holds children.'
    WHEN p_ref AND (p_mob <> 'purchased' OR p_type IN ('phantom_assembly', 'product_family'))
      THEN 'A reference child records what is inside something we buy; this parent is not bought complete.'
    WHEN NOT p_ref AND p_mob = 'purchased' AND p_type IN ('part', 'raw_material', 'spare_part', 'sub_assembly')
      THEN 'This is bought complete. Something we fit goes into its Prepared wrapper; something inside it as delivered is a reference child.'
    WHEN NOT p_ref AND p_mob = 'assembled' AND p_type IN ('part', 'raw_material', 'spare_part')
      THEN 'A part we put together is a sub-assembly. Change its Type first.'
  END
$$;

-- 4. Refuse to switch on over data that already breaks it. Migrations 0038
--    and 0039 cleaned production; this proves it at apply time.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT p.name || ' (' || p.part_number || ')', ', ') INTO bad
    FROM bom_edges e JOIN bom_components p ON p.id = e.parent_id
   WHERE e.effective_to IS NULL
     AND bom_child_rule(p.type, p.make_or_buy, e.is_reference) IS NOT NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0040: existing links break the BOM structure rules: %', bad;
  END IF;
END $$;

-- 5. Every path that opens a link: add, move, copy, materialise, re-open. ----
CREATE OR REPLACE FUNCTION trg_bom_edge_structure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p   record;
  msg text;
BEGIN
  IF NEW.effective_to IS NOT NULL THEN RETURN NEW; END IF;   -- closing a link is always allowed
  SELECT type, make_or_buy, name INTO p FROM bom_components WHERE id = NEW.parent_id;
  msg := bom_child_rule(p.type, p.make_or_buy, NEW.is_reference);
  IF msg IS NOT NULL THEN
    RAISE EXCEPTION 'BOM_RULE: %: %', p.name, msg USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bom_edge_structure ON bom_edges;
CREATE TRIGGER trg_bom_edge_structure
  BEFORE INSERT OR UPDATE OF parent_id, is_reference, effective_to ON bom_edges
  FOR EACH ROW EXECUTE FUNCTION trg_bom_edge_structure();

-- 6. Changing Type or Sourcing must not strand children that then break it.
CREATE OR REPLACE FUNCTION trg_bom_component_structure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE msg text;
BEGIN
  SELECT bom_child_rule(NEW.type, NEW.make_or_buy, e.is_reference) INTO msg
    FROM bom_edges e
   WHERE e.parent_id = NEW.id AND e.effective_to IS NULL
     AND bom_child_rule(NEW.type, NEW.make_or_buy, e.is_reference) IS NOT NULL
   LIMIT 1;
  IF msg IS NOT NULL THEN
    RAISE EXCEPTION 'BOM_RULE: %: not with the children it holds now — %', NEW.name, msg
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bom_component_structure ON bom_components;
CREATE TRIGGER trg_bom_component_structure
  BEFORE UPDATE OF type, make_or_buy ON bom_components
  FOR EACH ROW EXECUTE FUNCTION trg_bom_component_structure();

-- 7. Wrap a bought part in a Prepared sub-assembly (§5b, path "we fit it").
--    A database function so the whole thing is one transaction: the REST
--    client cannot do multi-statement work, which is why copyAssembly can
--    leave orphans behind. Called only by portal-api with the session's org.
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
  IF part.make_or_buy <> 'purchased' OR part.type NOT IN ('part', 'raw_material', 'spare_part', 'sub_assembly') THEN
    RAISE EXCEPTION 'BOM_RULE: %: only something we buy complete gets a Prepared wrapper', part.name;
  END IF;
  w_name := coalesce(nullif(trim(p_name), ''), 'Prepared ' || part.name);

  LOOP  -- same format as addComponent: RR-YYYYMM-XXXXXXXX
    w_pn := 'RR-' || to_char(now(), 'YYYYMM') || '-' ||
            (SELECT string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
               FROM generate_series(1, 8));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM bom_components WHERE part_number = w_pn);
  END LOOP;

  -- The INSERT trigger writes the 'created' history row.
  INSERT INTO bom_components (organization_id, part_number, name, type, make_or_buy, created_by)
  VALUES (p_org, w_pn, w_name, 'sub_assembly', 'assembled', p_user)
  RETURNING id INTO w_id;
  INSERT INTO bom_component_versions (organization_id, component_id, revision, spec_summary, is_current, created_by)
  VALUES (p_org, w_id, 'A', 'Initial revision', true, p_user);
  INSERT INTO bom_component_history (organization_id, component_id, changed_by, change_type, part_number, name, type, notes)
  VALUES (p_org, w_id, p_user, 'version_bumped', w_pn, w_name, 'sub_assembly', 'Revision A: Initial revision');

  -- The wrapper takes the part's place — same position, quantity and stage.
  -- Close first: the cycle trigger is BEFORE INSERT and must see the new
  -- ancestry. Reference links are not re-pointed: wrapping is about fitting.
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

-- PostgREST exposes functions in `public` to anon/authenticated by default.
-- RLS is deny-all on every table; these must be just as closed.
REVOKE ALL ON FUNCTION bom_wrap_in_prepared(uuid, uuid, uuid, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bom_wrap_in_prepared(uuid, uuid, uuid, boolean, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION bom_child_rule(text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION bom_child_rule(text, text, boolean) TO service_role;
