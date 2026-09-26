-- 0037_phantom_assembly_type.sql — PROP-058: phantom assemblies
-- ============================================================================
-- A phantom assembly is a grouping node that exists to carry structure and to
-- give the storefront something stable to point at. It is never built, never
-- stocked and never picked: only its children are real.
--
-- Added as a TYPE rather than a boolean, because every screen already branches
-- on `type` and a parallel flag would have to be remembered at each of them.
--
-- Note for whoever adds explosion logic later: in every other PLM a phantom is
-- "blow-through" — exploding a BOM skips the phantom level and attaches its
-- children to the phantom's parent. This migration does NOT implement that, and
-- nothing in the portal flattens phantoms today. See docs/ROADMAP.md.

ALTER TABLE bom_components DROP CONSTRAINT IF EXISTS bom_components_type_check;

ALTER TABLE bom_components ADD CONSTRAINT bom_components_type_check
  CHECK (type IN (
    'part',
    'raw_material',
    'sub_assembly',
    'phantom_assembly',   -- new: structural only, never built or stocked
    'finished_good',
    'spare_part',
    'product_family'
  ));

COMMENT ON COLUMN bom_components.type IS
  'What the node IS. phantom_assembly is structural only — it groups children for storefront/BOM logic and is never built, stocked or picked.';
