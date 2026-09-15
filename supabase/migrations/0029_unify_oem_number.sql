-- 0029_unify_oem_number.sql — one OEM number, not two
-- ============================================================================
-- Two columns were both surfaced as "OEM number" in the UI:
--   bom_components.oem_number                  → Overview tab, "OEM NO."
--   component_metadata.manufacturer_part_number → Specifications, "OEM number"
-- They are the same concept, so a value entered in one screen was invisible in
-- the other. PROP-039's AI fill wrote the metadata one, which is how the
-- divergence became obvious.
--
-- component_metadata.manufacturer_part_number wins. It preserves PROP-034's
-- symmetry — Manufacturer + their part number, Supplier + their part number —
-- which is the model that reflects how procurement actually works.
-- bom_components.oem_number is retired from the UI but KEPT as a column: it is
-- historical data, and dropping it would destroy the record of what was entered
-- before the two were reconciled.

-- Components that already have a metadata row: fill the gap.
UPDATE component_metadata m
SET manufacturer_part_number = c.oem_number
FROM bom_components c
WHERE m.component_id = c.id
  AND m.organization_id = c.organization_id
  AND c.oem_number IS NOT NULL
  AND c.oem_number <> ''
  AND (m.manufacturer_part_number IS NULL OR m.manufacturer_part_number = '');

-- Components with an OEM number but no metadata row yet: create one.
INSERT INTO component_metadata (organization_id, component_id, manufacturer_part_number)
SELECT c.organization_id, c.id, c.oem_number
FROM bom_components c
LEFT JOIN component_metadata m ON m.component_id = c.id
WHERE m.component_id IS NULL
  AND c.oem_number IS NOT NULL
  AND c.oem_number <> ''
ON CONFLICT (component_id) DO NOTHING;
