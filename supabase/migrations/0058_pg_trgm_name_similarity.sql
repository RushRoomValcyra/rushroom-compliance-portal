-- PROP-078: trigram similarity for BOM component name matching.
-- Used by suggestPlannerComponent and addComponent to surface near-duplicate
-- names before a new component is created.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION find_similar_bom_components(
  p_org_id      UUID,
  p_name        TEXT,
  p_threshold   FLOAT DEFAULT 0.4,
  p_max_results INT   DEFAULT 6
)
RETURNS TABLE(
  id               UUID,
  name             TEXT,
  part_number      TEXT,
  type             TEXT,
  lifecycle_status TEXT,
  score            FLOAT
)
LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  SELECT
    bc.id,
    bc.name,
    bc.part_number,
    bc.type,
    bc.lifecycle_status,
    similarity(lower(bc.name), lower(p_name))::FLOAT AS score
  FROM bom_components bc
  WHERE bc.organization_id = p_org_id
    AND similarity(lower(bc.name), lower(p_name)) >= p_threshold
  ORDER BY score DESC
  LIMIT p_max_results;
$$;
