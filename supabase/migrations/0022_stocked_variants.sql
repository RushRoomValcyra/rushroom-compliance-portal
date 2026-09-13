-- PROP-033: Stocked Assembly Variants — back-references from materialised SKUs
-- to the Dynamic BOM family and saved configuration they were derived from.

ALTER TABLE bom_components
  ADD COLUMN source_family_id UUID REFERENCES bom_components(id) ON DELETE SET NULL,
  ADD COLUMN source_config_id UUID REFERENCES saved_configurations(id) ON DELETE SET NULL;

-- Allow multiple variant-conditional edges between the same parent→child pair.
-- The old unique constraint (parent_id, child_id, effective_from) blocked same-day
-- duplicate edges even when variant_condition differs. Replace with a partial constraint
-- that only prevents duplicate unconditional edges; conditional edges may coexist.
ALTER TABLE bom_edges
  DROP CONSTRAINT IF EXISTS bom_edges_parent_id_child_id_effective_from_key;

CREATE UNIQUE INDEX bom_edges_unconditional_unique
  ON bom_edges (parent_id, child_id, effective_from)
  WHERE variant_condition IS NULL;
