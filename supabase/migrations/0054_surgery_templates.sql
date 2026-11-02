-- 0054_surgery_templates.sql — PROP-0059: surgery template register
-- ============================================================================
-- The E&C Gateway owns every physical drilling template used in Order Surgery.
-- Each template has its own QR code per face, so scanning always names the face
-- being drilled. Order Operations reads the register and never edits it.
--
-- A face row names the Order Surgery rule it serves (e.g.
-- 'surgery:interior-7.left-of-carcass.hub.1'); Order Operations looks up the
-- template for a step by the step's rule id. One active face per rule is
-- enforced by a partial unique index.
--
-- Codes are immutable: a trigger blocks any UPDATE on both code columns, so
-- existing QR labels on the shop floor remain valid forever. Templates are
-- retired, never deleted.

CREATE TABLE IF NOT EXISTS surgery_templates (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id),
  code            VARCHAR(40) NOT NULL,          -- printed on the QR / label, never changes
  name            VARCHAR(200) NOT NULL,         -- "Dubbelhäng 50/50 mall"
  drawing_id      UUID        REFERENCES drawings(id),
  status          VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES users(id),
  UNIQUE (organization_id, code)
);
ALTER TABLE surgery_templates ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_surgery_templates_org  ON surgery_templates (organization_id);
CREATE INDEX IF NOT EXISTS idx_surgery_templates_code ON surgery_templates (organization_id, code);

-- Each face a template serves.  A template used for both left and right gets
-- two rows.  The QR on the label carries face_code, not template code, so
-- scanning always identifies the face being drilled.
CREATE TABLE IF NOT EXISTS surgery_template_faces (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id),
  template_id     UUID        NOT NULL REFERENCES surgery_templates(id) ON DELETE CASCADE,
  face_code       VARCHAR(40) NOT NULL,          -- the QR payload, never changes
  label           VARCHAR(200) NOT NULL,         -- "Dubbelhäng 50/50 mall, left face"
  rule_id         VARCHAR(200) NOT NULL,         -- Order Surgery rule id, e.g. 'surgery:interior-7.…'
  status          VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, face_code)
);
ALTER TABLE surgery_template_faces ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_surgery_template_faces_org      ON surgery_template_faces (organization_id);
CREATE INDEX IF NOT EXISTS idx_surgery_template_faces_template ON surgery_template_faces (template_id);
CREATE INDEX IF NOT EXISTS idx_surgery_template_faces_rule     ON surgery_template_faces (organization_id, rule_id);

-- One active face per rule per org.
CREATE UNIQUE INDEX IF NOT EXISTS idx_surgery_template_faces_unique_active_rule
  ON surgery_template_faces (organization_id, rule_id)
  WHERE status = 'active';

-- Immutability trigger: codes and a face's rule_id cannot change once set.
CREATE OR REPLACE FUNCTION trg_surgery_codes_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'surgery_templates' AND NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'surgery_templates.code is immutable';
  END IF;
  IF TG_TABLE_NAME = 'surgery_template_faces' THEN
    IF NEW.face_code <> OLD.face_code THEN
      RAISE EXCEPTION 'surgery_template_faces.face_code is immutable';
    END IF;
    IF NEW.rule_id <> OLD.rule_id THEN
      RAISE EXCEPTION 'surgery_template_faces.rule_id is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_surgery_templates_immutable
  BEFORE UPDATE ON surgery_templates
  FOR EACH ROW EXECUTE FUNCTION trg_surgery_codes_immutable();

CREATE TRIGGER trg_surgery_template_faces_immutable
  BEFORE UPDATE ON surgery_template_faces
  FOR EACH ROW EXECUTE FUNCTION trg_surgery_codes_immutable();
