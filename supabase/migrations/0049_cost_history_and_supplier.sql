-- 0049_cost_history_and_supplier.sql — every cost save kept; supplier per cost
-- ============================================================================
-- Decided 2026-10-10: a save must not overwrite what was there. component_costs
-- stays the CURRENT cost per (component, kind); every insert, change and clear
-- of it is copied into component_cost_history by a trigger — so no save path
-- (Cost tab, quote reader, AI fill, a future one) can skip the record, and a
-- failed history write fails the save with it.
--
-- History is append-only: a row cannot be changed or deleted on its own. It
-- goes only with its component or organisation (FK cascades).
--
-- supplier_name: who quoted this cost, on the cost itself — a part's preferred
-- supplier (component_metadata) is not necessarily who this price came from.

ALTER TABLE component_costs ADD COLUMN IF NOT EXISTS supplier_name TEXT
  CHECK (supplier_name IS NULL OR length(supplier_name) <= 200);
COMMENT ON COLUMN component_costs.supplier_name IS
  'Who this cost came from (quote / price list / invoice supplier). Free text.';

CREATE TABLE IF NOT EXISTS component_cost_history (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  component_id               UUID NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  kind                       TEXT NOT NULL CHECK (kind IN ('actual', 'estimated')),
  event                      TEXT NOT NULL CHECK (event IN ('set', 'cleared')),
  unit_cost                  NUMERIC(14,4),
  unit_currency              CHAR(3),
  transport_pct              NUMERIC(7,3),
  customs_pct                NUMERIC(6,3),
  supplier_name              TEXT,
  quoted_on                  DATE,
  source_note                TEXT,
  source_document_version_id UUID REFERENCES document_versions(id) ON DELETE SET NULL,
  evidence                   JSONB,
  saved_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  saved_by                   UUID REFERENCES users(id) ON DELETE SET NULL
);
ALTER TABLE component_cost_history ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS component_cost_history_by_component
  ON component_cost_history (organization_id, component_id, saved_at DESC);
COMMENT ON TABLE component_cost_history IS
  'Every save and clear of component_costs, written by trigger. Append-only.';

-- Copy each change of the current cost into the history.
CREATE OR REPLACE FUNCTION component_costs_keep_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The component itself is being deleted (cascade): its history goes too,
    -- so there is nothing to record.
    IF NOT EXISTS (SELECT 1 FROM bom_components WHERE id = OLD.component_id) THEN RETURN OLD; END IF;
    INSERT INTO component_cost_history (organization_id, component_id, kind, event, saved_by)
    VALUES (OLD.organization_id, OLD.component_id, OLD.kind, 'cleared', OLD.updated_by);   -- the handler stamps updated_by just before clearing
    RETURN OLD;
  END IF;
  -- An UPDATE that changes nothing a person entered is not a save worth keeping.
  IF TG_OP = 'UPDATE' AND (NEW.unit_cost, NEW.unit_currency, NEW.transport_pct, NEW.customs_pct,
      NEW.supplier_name, NEW.quoted_on, NEW.source_note, NEW.source_document_version_id, NEW.evidence)
    IS NOT DISTINCT FROM (OLD.unit_cost, OLD.unit_currency, OLD.transport_pct, OLD.customs_pct,
      OLD.supplier_name, OLD.quoted_on, OLD.source_note, OLD.source_document_version_id, OLD.evidence) THEN
    RETURN NEW;
  END IF;
  INSERT INTO component_cost_history (organization_id, component_id, kind, event, unit_cost, unit_currency,
    transport_pct, customs_pct, supplier_name, quoted_on, source_note, source_document_version_id, evidence,
    saved_at, saved_by)
  VALUES (NEW.organization_id, NEW.component_id, NEW.kind, 'set', NEW.unit_cost, NEW.unit_currency,
    NEW.transport_pct, NEW.customs_pct, NEW.supplier_name, NEW.quoted_on, NEW.source_note,
    NEW.source_document_version_id, NEW.evidence, now(), NEW.updated_by);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS component_costs_history ON component_costs;
CREATE TRIGGER component_costs_history AFTER INSERT OR UPDATE OR DELETE ON component_costs
  FOR EACH ROW EXECUTE FUNCTION component_costs_keep_history();

-- Append-only. A cascade from the component / organisation still removes rows
-- (it runs inside the parent's delete, so pg_trigger_depth() > 1).
CREATE OR REPLACE FUNCTION component_cost_history_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'component_cost_history is append-only — a saved cost is never changed or removed';
END $$;

DROP TRIGGER IF EXISTS component_cost_history_append_only ON component_cost_history;
CREATE TRIGGER component_cost_history_append_only BEFORE UPDATE OR DELETE ON component_cost_history
  FOR EACH ROW EXECUTE FUNCTION component_cost_history_append_only();

-- What is there today is the first entry of each history.
INSERT INTO component_cost_history (organization_id, component_id, kind, event, unit_cost, unit_currency,
  transport_pct, customs_pct, supplier_name, quoted_on, source_note, source_document_version_id, evidence,
  saved_at, saved_by)
SELECT c.organization_id, c.component_id, c.kind, 'set', c.unit_cost, c.unit_currency, c.transport_pct,
  c.customs_pct, c.supplier_name, c.quoted_on, c.source_note, c.source_document_version_id, c.evidence,
  c.updated_at, c.updated_by
FROM component_costs c
WHERE NOT EXISTS (SELECT 1 FROM component_cost_history h
                  WHERE h.component_id = c.component_id AND h.kind = c.kind);
