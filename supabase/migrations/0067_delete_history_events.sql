-- 0067: deleting a drawing or a CAD revision joins the BOM node's trail
-- (docs/STATUS_MODEL.md §5.5). As with 0031-0033, the history insert in the
-- function is non-fatal, so this CHECK must be widened BEFORE the function
-- deploy or the rows fail silently.
ALTER TABLE bom_component_history DROP CONSTRAINT IF EXISTS bom_component_history_change_type_check;
ALTER TABLE bom_component_history ADD CONSTRAINT bom_component_history_change_type_check
  CHECK (change_type IN (
    'created','updated','version_bumped','document_linked','document_revised',
    'drawing_linked','drawing_revised','drawing_released','drawing_adopted',
    'drawing_deleted','cad_deleted'
  ));
