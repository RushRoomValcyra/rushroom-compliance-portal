-- 0065_suppliers.sql — supplier accounts, per-part access, a file audit
-- ============================================================================
-- docs/SUPPLIER_PORTAL.md. Until now a supplier was a shared password and a
-- per-drawing yes/no (drawings.is_supplier_visible): nothing tied a supplier
-- company to the parts it makes, nothing recorded what it fetched, and the
-- admin's preview ran on the admin's own session. After this a supplier is a
-- company with its own user accounts, access is granted part by part (drawings
-- and, separately, the released CAD STEP), and every signed URL handed to a
-- supplier session leaves one audit row.
--
-- Three tables, all org-scoped (organization_id NOT NULL, TENANT_TABLES, RLS
-- deny-all), plus one column on the global users table: users.supplier_id.
-- A users row has no organization_id (accounts are global, memberships carry
-- the org), so the rule "a user's supplier belongs to the same organization"
-- is enforced where the link is written (addSupplierUser scopes the supplier
-- lookup through makeTdb), not by the schema.
--
-- The shared supplier password is retired by the function (login answers 403
-- for role supplier); SUPPLIER_PW_HASH may stay set, nothing reads it.
--
-- Re-runnable: IF NOT EXISTS everywhere.

-- The company. One row per supplier per organization; inactive keeps its
-- history and its assignments but its users cannot sign in.
CREATE TABLE IF NOT EXISTS suppliers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            TEXT NOT NULL,
  contact_name    TEXT,
  contact_email   TEXT,
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL
);
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
-- The name is the identity the admin types; saveSupplier answers 409 on this.
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_org_name
  ON suppliers (organization_id, lower(name));

-- Access, per part. drawings: the released issues of supplier-visible
-- engineering drawings linked to the part (owner or drawing_components);
-- cad: the released CAD revision's STEP file. Both gates hold together with
-- drawings.is_supplier_visible; a surgery-template drawing is never shown.
-- A deleted part or supplier takes its assignments with it.
CREATE TABLE IF NOT EXISTS supplier_components (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  supplier_id     UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  component_id    UUID NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  drawings        BOOLEAN NOT NULL DEFAULT TRUE,
  cad             BOOLEAN NOT NULL DEFAULT FALSE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (organization_id, supplier_id, component_id)
);
ALTER TABLE supplier_components ENABLE ROW LEVEL SECURITY;
-- "Which suppliers make this part" — the Parts modal and the history line.
CREATE INDEX IF NOT EXISTS idx_supplier_components_component
  ON supplier_components (organization_id, component_id);

-- The audit: one row every time a signed URL is issued to a supplier session.
-- user_id is the signed-in supplier user, or the admin when the session is an
-- impersonation (adminViewAsSupplier). The file ids are SET NULL so the fact
-- that a file was fetched survives the file; file_name keeps the name.
CREATE TABLE IF NOT EXISTS supplier_file_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  supplier_id         UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('drawing', 'cad')),
  drawing_revision_id UUID REFERENCES drawing_revisions(id) ON DELETE SET NULL,
  cad_file_id         UUID REFERENCES cad_model_files(id) ON DELETE SET NULL,
  file_name           TEXT,
  at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE supplier_file_events ENABLE ROW LEVEL SECURITY;
-- The admin's view: the last 100 events of one supplier, newest first.
CREATE INDEX IF NOT EXISTS idx_supplier_file_events_supplier
  ON supplier_file_events (organization_id, supplier_id, at DESC);

-- The link from an account to its company. A supplier user without one is
-- refused at login ("Your account is not linked to a supplier yet."). Deleting
-- the supplier unlinks the account rather than deleting it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_supplier ON users (supplier_id);
