-- PROP-031: Structured component metadata for PLM & DPP.
-- One row per component (UNIQUE on component_id).
-- All spec columns are nullable — partial data is normal and expected.
-- Version-controlled by inclusion in bumpComponentVersion's version_snapshot JSONB.

CREATE TABLE component_metadata (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  component_id     UUID        NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,

  -- Physical
  weight_g         NUMERIC,
  length_mm        NUMERIC,
  width_mm         NUMERIC,
  height_mm        NUMERIC,

  -- Material & finish
  base_material         TEXT,
  surface_treatment     TEXT,
  color_specification   TEXT,
  flame_retardant_class TEXT,

  -- Procurement & logistics
  preferred_supplier_name TEXT,
  supplier_part_number    TEXT,
  lead_time_days          INTEGER,
  moq                     INTEGER,
  country_of_origin       TEXT,   -- ISO 3166-1 alpha-2 e.g. "SE", "DE"
  hs_code                 TEXT,   -- harmonised system commodity code (6–10 digits)

  -- Quality & incoming inspection
  incoming_inspection_method TEXT CHECK (
    incoming_inspection_method IS NULL OR incoming_inspection_method IN (
      'none','visual','dimensional','functional',
      'chemical','destructive','certificate_only'
    )
  ),
  inspection_sample_size  TEXT,
  critical_to_quality     TEXT,
  has_cpk_requirement     BOOLEAN NOT NULL DEFAULT false,

  -- Regulatory & DPP (ESPR Article 7)
  weee_category                 TEXT,
  battery_regulation_applicable BOOLEAN NOT NULL DEFAULT false,
  conflict_minerals_free        BOOLEAN,
  recycled_content_pct          NUMERIC,
  carbon_footprint_kgco2e       NUMERIC,
  carbon_footprint_source       TEXT,
  end_of_life_instruction       TEXT,
  repair_spare_part_available   BOOLEAN NOT NULL DEFAULT true,

  -- Overflow for anything not anticipated above
  custom_specs JSONB,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (component_id)
);

ALTER TABLE component_metadata ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON component_metadata AS RESTRICTIVE FOR ALL TO PUBLIC USING (false);
