-- 0046_bom_cost_simulation.sql — PROP-072: BOM cost simulation
-- ============================================================================
-- Planning costs for the BOM: unit cost and transport in their own currency
-- (SEK / EUR / USD / PLN), customs as a % of the unit cost, converted to SEK ex
-- VAT at dated exchange rates, rolled up through any assembly. Isolated from
-- bookkeeping on purpose — these are planning numbers, never accounting entries.
--
-- This deliberately reverses PROP-019 (migration 0012), which removed a much
-- larger cost layer because "financial analysis belongs in ERP". There will be
-- no ERP: Rushroom builds the stack in-house. What does NOT come back: cost
-- scenarios as tables, cost maturity, ERP references. What-if lives in the
-- browser; only baselines are stored. (docs/IDEAS.md, 2026-10-09)
--
-- RLS on with no policies — deny-all for every role but the service role,
-- the same pattern as 0034/0035. All three tables are in TENANT_TABLES.

-- One current cost per component. Not on component_metadata, which is
-- snapshotted on every version bump: cost changes far more often than the part.
CREATE TABLE IF NOT EXISTS component_costs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  component_id       UUID NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  unit_cost          NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
  unit_currency      CHAR(3) NOT NULL DEFAULT 'SEK' CHECK (unit_currency IN ('SEK','EUR','USD','PLN')),
  transport_cost     NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (transport_cost >= 0),
  transport_currency CHAR(3) NOT NULL DEFAULT 'SEK' CHECK (transport_currency IN ('SEK','EUR','USD','PLN')),
  customs_pct        NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (customs_pct >= 0 AND customs_pct <= 100),
  quoted_on          DATE,
  source_note        TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (organization_id, component_id)
);
ALTER TABLE component_costs ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE component_costs IS
  'PROP-072: planning cost per component, ex VAT. Landed SEK = unit×rate + transport×rate + (unit×rate)×customs_pct/100.';

-- Dated rates to SEK. SEK itself is always 1 and never stored.
CREATE TABLE IF NOT EXISTS currency_rates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  currency        CHAR(3) NOT NULL CHECK (currency IN ('EUR','USD','PLN')),
  valid_on        DATE NOT NULL,
  rate_to_sek     NUMERIC(14,6) NOT NULL CHECK (rate_to_sek > 0),
  source_note     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (organization_id, currency, valid_on)
);
ALTER TABLE currency_rates ENABLE ROW LEVEL SECURITY;
-- "The latest rate on or before a date", per currency.
CREATE INDEX IF NOT EXISTS currency_rates_lookup
  ON currency_rates (organization_id, currency, valid_on DESC);

-- A saved roll-up, with the rates it used, to compare against later.
CREATE TABLE IF NOT EXISTS cost_baselines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  root_component_id UUID NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  name              TEXT NOT NULL CHECK (length(trim(name)) > 0),
  rate_date         DATE NOT NULL,
  rates             JSONB NOT NULL,
  total_sek         NUMERIC(16,4) NOT NULL,
  incomplete        BOOLEAN NOT NULL DEFAULT false,
  lines             JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL
);
ALTER TABLE cost_baselines ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS cost_baselines_by_root
  ON cost_baselines (organization_id, root_component_id, created_at DESC);
