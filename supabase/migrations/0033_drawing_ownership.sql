-- 0033_drawing_ownership.sql — PROP-046: node-first drawings, system-owned identity
-- ============================================================================
-- 0032 shipped a drawing whose identity was whatever the supplier called it and
-- whose link to a part was an afterthought: the modal asked the user to type a
-- drawing number before it would accept a file. That makes our record key off a
-- supplier's vocabulary, so changing supplier means either carrying a dead
-- supplier's numbering forever or renumbering and breaking the trail.
--
-- This anchors identity to us and to the BOM node, and records the supplier's
-- vocabulary alongside rather than instead — the same split bom_components has
-- used since the beginning: part_number is ours, oem_number is theirs.

-- NULL = a free drawing: development work, deliberately unattached. It has to be
-- a choice in the modal, never something that happens by forgetting.
ALTER TABLE drawings
  ADD COLUMN IF NOT EXISTS owner_component_id UUID REFERENCES bom_components(id) ON DELETE SET NULL;

-- "Drawing 2 of this part" — a human handle that does not require memorising a
-- random suffix. Computed per owner, per tenant.
ALTER TABLE drawings
  ADD COLUMN IF NOT EXISTS node_sequence INT;

-- Theirs. Captured so an engineer holding the PDF recognises it and a purchase
-- order can quote it. Nothing keys off it, which is the entire point: changing
-- supplier changes this column and nothing else.
ALTER TABLE drawings
  ADD COLUMN IF NOT EXISTS supplier_drawing_number VARCHAR(120);

ALTER TABLE drawing_revisions
  ADD COLUMN IF NOT EXISTS supplier_revision VARCHAR(40);
ALTER TABLE drawing_revisions
  ADD COLUMN IF NOT EXISTS supplier_file_name TEXT;

CREATE INDEX IF NOT EXISTS idx_drawings_owner
  ON drawings (organization_id, owner_component_id);

-- One drawing exists, created while testing 0032 with a hand-typed number. Its
-- number is preserved as the supplier's, and it becomes a free drawing. Deleting
-- a user's row to tidy a migration is not a trade this system should make.
UPDATE drawings
   SET supplier_drawing_number = drawing_number
 WHERE supplier_drawing_number IS NULL
   AND drawing_number NOT LIKE 'RR-DWG-%';

-- Adoption — a free drawing becoming a controlled one — is an event in its own
-- right. As with 0031 and 0032, the history insert is non-fatal, so this CHECK
-- must be widened BEFORE the function deploy or the rows fail silently.
ALTER TABLE bom_component_history DROP CONSTRAINT IF EXISTS bom_component_history_change_type_check;
ALTER TABLE bom_component_history ADD CONSTRAINT bom_component_history_change_type_check
  CHECK (change_type IN (
    'created','updated','version_bumped','document_linked','document_revised',
    'drawing_linked','drawing_revised','drawing_released','drawing_adopted'
  ));
