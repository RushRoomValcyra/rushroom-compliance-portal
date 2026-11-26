-- 0066: an upload and a step change carry who sent them (docs/SUPPLIER_PORTAL.md).
-- Before this, a supplier's upload stored only uploaded_role and the free-text
-- "Your company" label, although the signed session carried the supplier and the
-- account. Both columns are optional: Rushroom's own uploads have no supplier,
-- legacy rows have neither.
ALTER TABLE public.uploads
  ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS user_id     UUID REFERENCES public.users(id)     ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS uploads_supplier_idx ON public.uploads (supplier_id) WHERE supplier_id IS NOT NULL;
