-- 0026_bom_edge_active_unique.sql — fix: cannot re-add a child removed the same day
-- ============================================================================
-- bom_edges_unconditional_unique (migration 0022) indexes
--   (parent_id, child_id, effective_from) WHERE variant_condition IS NULL
-- across ALL rows — closed ones included. Removing a child soft-closes its edge
-- (effective_to = today) but leaves the row in place with its original
-- effective_from, so re-adding the same child to the same parent on the same day
-- collides with the edge that was just removed:
--   duplicate key value violates unique constraint "bom_edges_unconditional_unique"
--
-- The invariant that is actually wanted is "at most one ACTIVE unconditional edge
-- per parent→child pair". Closed edges are history and must be free to accumulate,
-- which is also what makes effective_from unnecessary in the key.
--
-- This path was mostly unreachable before v202, because removing a direct child
-- used to hard-delete the component (taking its edges with it). Fixing that bug
-- correctly — so removal now only closes the edge — exposed this one.

DROP INDEX IF EXISTS bom_edges_unconditional_unique;

-- The old index permitted two ACTIVE unconditional edges between the same pair so
-- long as their effective_from differed (add today, add again tomorrow). Close any
-- such duplicates before the stricter index goes on, keeping the most recent.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
           PARTITION BY parent_id, child_id
           ORDER BY effective_from DESC, id DESC
         ) AS rn
  FROM bom_edges
  WHERE effective_to IS NULL AND variant_condition IS NULL
)
UPDATE bom_edges e SET effective_to = CURRENT_DATE
FROM ranked r WHERE e.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX bom_edges_unconditional_unique
  ON bom_edges (parent_id, child_id)
  WHERE variant_condition IS NULL AND effective_to IS NULL;
