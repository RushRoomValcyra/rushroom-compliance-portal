-- PROP-034: Separate manufacturer from supplier on component_metadata.
-- A component may be manufactured by one company and purchased through a
-- different distributor or trader. Both identities need to be recorded.

ALTER TABLE component_metadata
  ADD COLUMN manufacturer_name        TEXT,
  ADD COLUMN manufacturer_part_number TEXT;
