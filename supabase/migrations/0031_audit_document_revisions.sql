-- 0031_audit_document_revisions.sql — PROP-043: document revisions as BOM node events
-- ============================================================================
-- No new table. This widens an existing CHECK so a new revision of a document
-- can be recorded against every component that links it.
--
-- Applying this BEFORE the function deploy is not optional. The constraint
-- rejects unlisted values, and the history insert sits inside a try/catch that
-- treats failures as non-fatal — so without the migration the new rows would
-- fail SILENTLY, which is precisely the class of bug this proposal removes.

ALTER TABLE bom_component_history
  DROP CONSTRAINT IF EXISTS bom_component_history_change_type_check;

ALTER TABLE bom_component_history
  ADD CONSTRAINT bom_component_history_change_type_check
  CHECK (change_type IN (
    'created',
    'updated',
    'version_bumped',
    'document_linked',
    'document_revised'   -- new: a linked document gained a version
  ));

-- getComponentChangelog joins component_documents by component_id on every
-- panel open, and the fan-out in addDocumentVersion looks up every component
-- linking a given document.
CREATE INDEX IF NOT EXISTS idx_component_documents_component
  ON component_documents (component_id);

CREATE INDEX IF NOT EXISTS idx_component_documents_docversion
  ON component_documents (document_version_id);
