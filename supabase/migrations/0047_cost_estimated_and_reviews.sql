-- 0047_cost_estimated_and_reviews.sql — PROP-073: Estimated vs Actual, AI sources, reviews
-- ============================================================================
-- Two costs per component (decided 2026-10-09):
--   estimated  our planning cost — what we expected
--   actual     what a supplier document says (quote, price list, invoice)
-- The cost view and the full review show both and the deviation.
--
-- Existing rows (PROP-072) become 'actual' — they were entered as real prices.
-- A cost read from a document by AI keeps a link to the document version it
-- came from and the verbatim quotes it was read from, so every number can be
-- traced to its source.
--
-- cost_reviews: one "full BOM cost review" — every top-level product costed at
-- one moment with the rates then in force. Each product's lines are stored as
-- a cost_baselines row pointing at the review, so the existing comparison
-- (quantity / price / exchange rate) works between reviews too.

ALTER TABLE component_costs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'actual'
  CHECK (kind IN ('actual', 'estimated'));
ALTER TABLE component_costs DROP CONSTRAINT IF EXISTS component_costs_organization_id_component_id_key;
ALTER TABLE component_costs DROP CONSTRAINT IF EXISTS component_costs_one_per_kind;
ALTER TABLE component_costs ADD CONSTRAINT component_costs_one_per_kind
  UNIQUE (organization_id, component_id, kind);
ALTER TABLE component_costs ADD COLUMN IF NOT EXISTS source_document_version_id UUID
  REFERENCES document_versions(id) ON DELETE SET NULL;
ALTER TABLE component_costs ADD COLUMN IF NOT EXISTS evidence JSONB;
COMMENT ON COLUMN component_costs.kind IS
  'PROP-073: estimated = our planning cost; actual = what a supplier document says. One row of each per component at most.';

CREATE TABLE IF NOT EXISTS cost_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  rate_date       DATE NOT NULL,
  rates           JSONB NOT NULL,
  summary         JSONB NOT NULL,      -- [{root_id, name, part_number, actual, estimated, missing_actual, missing_estimated, lines}]
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL
);
ALTER TABLE cost_reviews ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS cost_reviews_recent ON cost_reviews (organization_id, reviewed_at DESC);

ALTER TABLE cost_baselines ADD COLUMN IF NOT EXISTS review_id UUID REFERENCES cost_reviews(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS cost_baselines_by_review ON cost_baselines (review_id) WHERE review_id IS NOT NULL;
