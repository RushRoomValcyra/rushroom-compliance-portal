-- 0066_supplier_register.sql — one supplier register for parts, prices and purchasing
-- ============================================================================
-- Decided by Matte 2026-11-26 (Valcyra Operations, "Create one supplier
-- register"). Until now a supplier lived in three places: typed on a part
-- (component_metadata.preferred_supplier_name), typed on a price
-- (component_costs.supplier_name), and in two registers — this one (0065,
-- portal logins) and Order Operations' (its item 0067, purchasing terms).
-- After this the Gateway's suppliers table is THE register: a supplier is
-- created once, parts and prices point at it, and Order Operations reads it
-- (service action listSupplierRegister, docs/PLANNER_MAPPINGS.md).
--
-- The typed name columns stay. On a part it follows the register's name when
-- the supplier is picked; on a price it keeps what was typed when the price
-- was saved (it is part of the cost history, which is append-only). The id is
-- the link; a name with no id is "typed, not linked yet", and the Suppliers tab
-- lists those for an admin to link once.
--
-- aliases: names typed before the register ("ITALIANA FERRAMENTA s.r.l."). A
-- save that still sends a typed name (AI fill, quote reader, cost import)
-- links itself when the name matches the supplier's name or an alias.
--
-- Re-runnable: IF NOT EXISTS everywhere.

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS org_number         TEXT
  CHECK (org_number IS NULL OR length(btrim(org_number)) BETWEEN 4 AND 40);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS country            TEXT
  CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS currency           TEXT
  CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS ordering_method    TEXT
  CHECK (ordering_method IS NULL OR ordering_method IN ('email', 'web_shop', 'other'));
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS order_email        TEXT
  CHECK (order_email IS NULL OR length(order_email) BETWEEN 3 AND 254);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS web_shop_url       TEXT
  CHECK (web_shop_url IS NULL OR web_shop_url ~ '^https://');
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS phone              TEXT
  CHECK (phone IS NULL OR phone ~ '^\+?[0-9 ()-]{6,24}$');
-- As agreed with the supplier. Order Operations measures the real one.
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS lead_time_days     INTEGER
  CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 365);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER
  CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 180);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS aliases            TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- The part's supplier, and who a price came from. Deleting a supplier is not
-- offered (it is made inactive), but if a row goes the parts keep their typed name.
ALTER TABLE component_metadata ADD COLUMN IF NOT EXISTS preferred_supplier_id UUID
  REFERENCES suppliers(id) ON DELETE SET NULL;
ALTER TABLE component_costs ADD COLUMN IF NOT EXISTS supplier_id UUID
  REFERENCES suppliers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_component_metadata_supplier
  ON component_metadata (organization_id, preferred_supplier_id) WHERE preferred_supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_component_costs_supplier
  ON component_costs (organization_id, supplier_id) WHERE supplier_id IS NOT NULL;

COMMENT ON COLUMN component_metadata.preferred_supplier_id IS
  'The part''s supplier in the register (0066). preferred_supplier_name follows its name.';
COMMENT ON COLUMN component_costs.supplier_id IS
  'Who this price came from, in the register (0066). supplier_name keeps what was typed when it was saved.';
