-- 0030_category_scoped_fields.sql — PROP-041: category-specific spec fields
-- ============================================================================
-- A screw needs Head diameter, Thread diameter, Head slot type and Head type.
-- A furniture panel does not, and showing all of them on every part would make
-- the Specifications tab a field of dashes — the same dilution the category
-- chips (PROP-038) exist to prevent in the list.
--
-- Rather than a new mechanism, this extends the PROP-040 catalogue with two
-- things it was missing:
--   category_id — the field only renders for parts in that category
--                 (NULL = every category, which is the existing behaviour)
--   options     — a fixed choice list, so Head slot type is a picker rather
--                 than free text where PZ2 / Pz2 / "pozi 2" all coexist

ALTER TABLE custom_spec_fields
  ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES part_categories(id);

ALTER TABLE custom_spec_fields
  ADD COLUMN IF NOT EXISTS options JSONB;

-- 'choice' joins text / number / boolean.
ALTER TABLE custom_spec_fields
  DROP CONSTRAINT IF EXISTS custom_spec_fields_data_type_check;
ALTER TABLE custom_spec_fields
  ADD CONSTRAINT custom_spec_fields_data_type_check
  CHECK (data_type IN ('text', 'number', 'boolean', 'choice'));

CREATE INDEX IF NOT EXISTS idx_custom_spec_fields_category
  ON custom_spec_fields (organization_id, category_id);

-- Seed the fastener fields for every organization that has the category.
INSERT INTO custom_spec_fields
  (organization_id, category_id, field_key, label, unit, data_type, section, sort_order, options)
SELECT pc.organization_id, pc.id, f.field_key, f.label, f.unit, f.data_type, f.section, f.sort_order, f.options
FROM part_categories pc
CROSS JOIN (VALUES
  ('head_diameter_mm',   'Head diameter',          'mm', 'number', 'physical', 100, NULL::jsonb),
  ('thread_diameter_mm', 'Thread / tube diameter', 'mm', 'number', 'physical', 110, NULL::jsonb),
  ('head_slot_type',     'Head slot type',          NULL, 'choice', 'physical', 120,
     '["PH1","PH2","PH3","PZ1","PZ2","PZ3","TX10","TX15","TX20","TX25","TX30","Slotted","Hex","Square","None"]'::jsonb),
  ('head_type',          'Head type',               NULL, 'choice', 'physical', 130,
     '["Countersunk","Flat","Pan","Bullet","Button","Cheese","Hex","Round","Truss","Wafer"]'::jsonb)
) AS f(field_key, label, unit, data_type, section, sort_order, options)
WHERE pc.name = 'Fittings & Fasteners'
ON CONFLICT (organization_id, field_key) DO NOTHING;
