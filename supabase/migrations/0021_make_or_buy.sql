-- PROP-032: make_or_buy column on bom_components.
-- Indicates whether a component is sourced externally or produced/assembled
-- in-house. Drives manufacturing routing scope and incoming inspection logic.

ALTER TABLE bom_components
  ADD COLUMN make_or_buy TEXT NOT NULL DEFAULT 'purchased'
    CHECK (make_or_buy IN ('purchased','manufactured','assembled','subcontracted'));
