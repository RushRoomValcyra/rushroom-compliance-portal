-- 0069_drawing_dialogue.sql — the dialogue's scope and a promoted template version
-- ============================================================================
-- docs/DRAWING_DIALOGUE.md §5, §7 (Phase 5 of docs/DYNAMIC_DRAWINGS.md). Until
-- now every row of drawing_spec_versions came from the worker registering a
-- YAML body it found on the Mac. A template-scope turn in the dialogue now
-- PROMOTES a new version from the portal: same name, version = max + 1,
-- origin = portal, the author, the version it was derived from and the drawing
-- the turn was made on. Versions stay immutable; the Mac file becomes a
-- mirror the worker writes from the current version (§5 "The file on the Mac").
--
-- drawing_spec_turns gains the scope the engineer chose on the prompt row
-- (callout · drawing · template): a ceiling the validator applies per op, never
-- an inference the model makes (§3).
--
-- Both tables already carry organization_id and sit in TENANT_TABLES.
-- Re-runnable: IF NOT EXISTS everywhere.

ALTER TABLE drawing_spec_versions
  -- mac: registered by the worker from specs/<name>.yaml · portal: promoted
  -- from a dialogue turn (promoteDrawingSpecOps).
  ADD COLUMN IF NOT EXISTS origin                   TEXT NOT NULL DEFAULT 'mac'
                                                    CHECK (origin IN ('mac', 'portal')),
  ADD COLUMN IF NOT EXISTS author_user_id           UUID,
  -- The version the promotion started from (NULL for a registered body).
  ADD COLUMN IF NOT EXISTS parent_version_id        UUID REFERENCES drawing_spec_versions(id),
  -- The drawing whose turn promoted it; the drawing may be deleted later, the
  -- version stays (other drawings are pinned to it).
  ADD COLUMN IF NOT EXISTS promoted_from_drawing_id UUID REFERENCES drawings(id) ON DELETE SET NULL,
  -- The engineer's note or the turn's prompt, for the version list.
  ADD COLUMN IF NOT EXISTS note                     TEXT;

ALTER TABLE drawing_spec_turns
  ADD COLUMN IF NOT EXISTS scope TEXT CHECK (scope IN ('callout', 'drawing', 'template'));
