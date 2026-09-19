-- REFERENCE ONLY. Apply via supabase/migrations/ not this file.
-- ============================================================================
-- Rushroom Engineering & Compliance Platform — Supabase schema
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.
-- Safe to re-run: it uses "if not exists" / "on conflict do nothing".
--
-- Security model: the browser NEVER touches these tables directly. Row-Level
-- Security is enabled with no public policies, so anon/authenticated clients are
-- denied. All reads/writes go through the `portal-api` Edge Function, which uses
-- the service-role key and enforces the role rules (Rushroom vs supplier).
-- ============================================================================

-- ---- Tables ----------------------------------------------------------------
create table if not exists public.steps (
  step        integer primary key,
  phase       text not null default 'Unphased',
  action      text not null default '',
  owner       text default '',
  where_how   text default '',
  evidence    text default '',
  folder      text default '',
  priority    text default '',
  status      text default 'Open',
  audience    text[] not null default array['internal']::text[],
  updated_at  timestamptz not null default now(),
  updated_by  text default ''
);

create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  category      text not null default '',
  name          text not null default '',
  url           text default '',          -- external link (e.g. legacy Google Drive)
  storage_path  text default '',          -- path in the 'documents' bucket when the file is hosted here
  kind          text not null default 'template', -- 'template' (Templates & Requirements) | 'operational' (Company as Operates)
  audience      text[] not null default array['internal']::text[],
  sort          integer default 0
);
-- For projects created before these columns existed:
alter table public.documents add column if not exists storage_path text default '';
alter table public.documents add column if not exists kind text not null default 'template';

-- Version history for operational ("Company as Operates") documents. These are
-- never deleted — a new version is uploaded and the previous ones stay accessible.
create table if not exists public.document_versions (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.documents(id) on delete cascade,
  version      text default '',
  file_name    text not null,
  storage_path text not null,
  notes        text default '',
  uploaded_by  text default '',
  created_at   timestamptz not null default now()
);
create index if not exists document_versions_doc_idx on public.document_versions (document_id);

alter table if exists public.document_versions add column if not exists source_document_version_id uuid references public.document_versions(id) on delete set null;
alter table if exists public.document_versions add column if not exists source_standard_version_ids jsonb not null default '[]'::jsonb;

create table if not exists public.uploads (
  id             uuid primary key default gen_random_uuid(),
  step           integer references public.steps(step) on delete set null,
  uploaded_role  text not null,           -- 'rushroom' | 'supplier'
  supplier_label text default '',          -- free-text "who" (suppliers share one login)
  file_path      text not null,            -- path within the storage bucket
  file_name      text not null,
  note           text default '',
  created_at     timestamptz not null default now()
);

create index if not exists uploads_step_idx on public.uploads (step);

-- Standards & Regulations register, with per-standard version history.
create table if not exists public.standards (
  id           uuid primary key default gen_random_uuid(),
  code         text not null default '',   -- e.g. "EN 60598-1"
  title        text not null default '',
  category     text default '',            -- DOMAIN tag: "LVD", "EMC", "Materials"
  reg_type     text default '',            -- TYPE/level: EU Directive | EU Regulation | Harmonised Standard (EN) | National Standard | International (IEC/ISO) | Other
  jurisdiction text default '',            -- EU | International | a member-state country (e.g. Germany)
  audience     text[] not null default array['internal']::text[],
  created_at   timestamptz not null default now()
);
-- For projects created before the type/jurisdiction columns existed:
alter table public.standards add column if not exists reg_type text default '';
alter table public.standards add column if not exists jurisdiction text default '';
create table if not exists public.standard_versions (
  id             uuid primary key default gen_random_uuid(),
  standard_id    uuid not null references public.standards(id) on delete cascade,
  version        text not null default '',   -- e.g. "2015+A1:2022"
  effective_date text default '',
  notes          text default '',            -- what changed
  storage_path   text not null,              -- file in the 'standards' bucket
  file_name      text not null,
  uploaded_by    text default '',
  created_at     timestamptz not null default now()
);
create index if not exists standard_versions_standard_idx on public.standard_versions (standard_id);

-- AI deviation-monitoring scans: each scan compares the document library against
-- the standards register (via the Claude API) and stores findings by severity.
create table if not exists public.deviation_scans (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  model             text default '',
  status            text not null default 'ok',
  summary           text default '',
  counts            jsonb default '{}'::jsonb,
  docs_scanned      integer default 0,
  standards_scanned integer default 0,
  error             text default ''
);
create table if not exists public.deviation_findings (
  id             uuid primary key default gen_random_uuid(),
  scan_id        uuid not null references public.deviation_scans(id) on delete cascade,
  severity       text not null default 'Info',   -- Critical | High | Medium | Low | Info
  title          text not null default '',
  description    text default '',
  document       text default '',
  standard       text default '',
  recommendation text default '',
  source         text default 'ai_inference',    -- 'structured' (from as_operates_interpretations) | 'ai_inference'
  created_at     timestamptz not null default now()
);
create index if not exists deviation_findings_scan_idx on public.deviation_findings (scan_id);
-- Optional: persist AI token usage per scan so the cost shows in scan history.
-- (The edge function self-heals if this column is missing.)
alter table public.deviation_scans add column if not exists usage jsonb default '{}'::jsonb;

-- ---- Row-Level Security: lock everything; only the service role (Edge
--      Function) may read/write. No policies = no access for anon/authenticated.
alter table public.steps             enable row level security;
alter table public.documents          enable row level security;
alter table public.document_versions  enable row level security;
alter table public.uploads            enable row level security;
alter table public.standards          enable row level security;
alter table public.standard_versions  enable row level security;
alter table public.deviation_scans    enable row level security;
alter table public.deviation_findings enable row level security;

-- ---- Private storage buckets ----------------------------------------------
--   supplier-uploads : files suppliers submit
--   documents        : the compliance document library files (Google-free mode)
insert into storage.buckets (id, name, public)
values ('supplier-uploads', 'supplier-uploads', false),
       ('documents', 'documents', false),
       ('standards', 'standards', false)
on conflict (id) do nothing;

-- Storage objects are likewise reached only via the Edge Function (signed URLs),
-- so no public storage policies are created here.

-- ============================================================================
-- SEED DATA (generated from assets/config.js)
-- ============================================================================
-- Seed data — generated from assets/config.js (do not edit by hand).
insert into public.steps (step, phase, action, owner, where_how, evidence, folder, priority, status, audience) values
  (1, '1. Classify & decide', 'Confirm economic-operator role: Rushroom = MANUFACTURER of finished product + IMPORTER of the China LED strip (carries full CE responsibility on the assembled product)', 'Rushroom', 'Internal note', 'Documented role statement', '00 / README', 'Foundation', 'Done (documented)', ARRAY['internal']::text[]),
  (2, '1. Classify & decide', 'Confirm whether the controller is WIRELESS (BT/Zigbee/RF). If yes, Radio Equipment Directive 2014/53/EU replaces the LVD+EMC route', 'Rushroom + SE controller partner', 'Ask partner', 'Written confirmation', '01b', 'Foundation', 'Open', ARRAY['internal']::text[]),
  (3, '1. Classify & decide', 'Confirm whether the LED strip is PERMANENTLY FIXED (glued/potted). If yes, the whole fixture is assessed for ecodesign', 'Rushroom', 'Design review', 'Decision recorded', '2', 'Foundation', 'Open', ARRAY['internal']::text[]),
  (4, '1. Classify & decide', 'Confirm whether any BATTERY ships (controller/remote). If yes, adds battery producer responsibility', 'Rushroom', 'Design review', 'Decision recorded', '4', 'Foundation', 'Open', ARRAY['internal']::text[]),
  (5, '1. Classify & decide', 'Confirm WEEE EEE category (likely Large or Small equipment) and B2C vs B2B sales channel', 'Rushroom + El-Kretsen', 'Call El-Kretsen / Naturvardsverket', 'Category + channel decided', '4', 'Foundation', 'Open', ARRAY['internal']::text[]),
  (6, '1. Classify & decide', 'Confirm whether the LED-to-controller cabling counts as permanently incorporated in the building (CPR / EN 50575 applicability)', 'Rushroom', 'Assess install method', 'Decision recorded', '01e', 'Foundation', 'Open', ARRAY['internal']::text[]),
  (7, '2. Suppliers', 'SEND each supplier the package: Supplier Compliance Spec (standards + harmonised standards list), Declaration of Compliance form, and PCN Commitment', 'Rushroom → suppliers (LED strip CN, controller SE, PSU, cable, connectors)', 'Email', 'Sent, with acknowledgement', '01e', 'High', 'Open', ARRAY['internal','supplier']::text[]),
  (8, '2. Suppliers', 'COLLECT back: signed supplier declarations, test reports, datasheets, RoHS + REACH/SVHC declarations, and the PSU''s own CE DoC', 'Suppliers → Rushroom', 'Email / portal', 'Completed forms + attachments filed', '01e', 'High', 'Open', ARRAY['internal','supplier','reviewer']::text[]),
  (9, '2. Suppliers', 'VERIFY supplier evidence against the spec; chase any gaps before designing the finished product', 'Rushroom', 'Review vs spec sheet', 'Gap log cleared', '01e', 'High', 'Open', ARRAY['internal','supplier']::text[]),
  (10, '3. Testing & evidence', 'ARRANGE LVD safety testing of the ASSEMBLED product at an accredited lab (EN 60598, EN 61347, EN 62471)', 'Rushroom → accredited lab', 'Book test', 'Safety test report', '01d', 'High', 'Open', ARRAY['internal']::text[]),
  (11, '3. Testing & evidence', 'ARRANGE EMC testing of the assembled product (EN 55015, EN 61547, EN 61000-3-2). If RED applies, use EN 300 328 / EN 301 489 instead', 'Rushroom → accredited lab', 'Book test', 'EMC test report(s)', '01d', 'High', 'Open', ARRAY['internal']::text[]),
  (12, '3. Testing & evidence', 'COMPILE RoHS technical documentation (EN IEC 63000) from supplier data', 'Rushroom', 'Assemble file', 'RoHS documentation', '3', 'High', 'Open', ARRAY['internal','supplier']::text[]),
  (13, '3. Testing & evidence', 'CONDUCT risk assessment of the finished product (electrical safety + fire/thermal of 24V high-current wiring)', 'Rushroom', 'Use risk method', 'Risk assessment record', '01f', 'High', 'Open', ARRAY['internal']::text[]),
  (14, '3. Testing & evidence', 'COMPILE the Technical File using the template index (pulls in all of the above)', 'Rushroom', 'Fill template', 'Complete technical file', '01b', 'High — gate', 'Open', ARRAY['internal','reviewer']::text[]),
  (15, '4. Energy / EPREL', 'OBTAIN/verify ecodesign data: efficacy, flicker (PstLM<=1, SVM<=0.4), lumen maintenance, power factor', 'Rushroom (+ lab/supplier)', 'Test/collect data', 'Ecodesign data set', '2', 'High', 'Open', ARRAY['internal']::text[]),
  (16, '4. Energy / EPREL', 'REGISTER the light source in the EPREL database and produce the energy label — BEFORE first sale', 'Rushroom', 'eprel.ec.europa.eu', 'EPREL registration + label', '2', 'BLOCKER', 'Open', ARRAY['internal']::text[]),
  (17, '5. Registrations', 'WEEE: JOIN a PRO (e.g. El-Kretsen) AND register in the EE-registret with Naturvardsverket; set up annual report (by 31 Mar)', 'Rushroom', 'El-Kretsen + eeb.naturvardsverket.se', 'PRO agreement + registration confirmation', '4', 'BLOCKER', 'Open', ARRAY['internal']::text[]),
  (18, '5. Registrations', 'PACKAGING: document the reuse system + NOTIFY Naturvardsverket; register as packaging producer + annual report', 'Rushroom', 'Naturvardsverket', 'Reuse-system notification + registration', '4', 'High — by 2026-08-12', 'Open', ARRAY['internal']::text[]),
  (19, '5. Registrations', 'BATTERY register — only if step 4 = yes', 'Rushroom', 'Naturvardsverket', 'Battery registration', '4', 'Conditional', 'Open', ARRAY['internal']::text[]),
  (20, '6. Chemicals', 'COLLECT REACH/SVHC declarations; if any article > 0.1% w/w SVHC, submit a SCIP notification to ECHA', 'Rushroom', 'ECHA SCIP', 'SVHC declarations (+ SCIP ref if needed)', '3', 'Medium', 'Open', ARRAY['internal','supplier']::text[]),
  (21, '7. Self-declaration', 'DRAW UP and SIGN the EU Declaration of Conformity for the finished product, listing all applicable directives + standards (Rushroom does this itself)', 'Rushroom', 'Fill DoC template', 'Signed EU DoC', '01a', 'BLOCKER', 'Open', ARRAY['internal','reviewer']::text[]),
  (22, '7. Self-declaration', 'AFFIX the CE marking to the product per the marking spec (Rushroom does this itself, after steps 14 + 21)', 'Rushroom', 'Per CE spec', 'CE mark on product', '01c', 'BLOCKER', 'Open', ARRAY['internal','reviewer']::text[]),
  (23, '7. Self-declaration', 'DESIGN the product label combining: CE mark, manufacturer ID + address, type/batch no., ratings, WEEE crossed-out-bin (EN 50419), energy/EPREL', 'Rushroom', 'Artwork', 'Approved label artwork', '01c', 'High', 'Open', ARRAY['internal','reviewer']::text[]),
  (24, '8. Product info & install', 'FINALISE the Swedish user & safety instructions and ship them with every product', 'Rushroom', 'Finalise template', 'Final SV manual', '6', 'High', 'Open', ARRAY['internal','installer']::text[]),
  (25, '8. Product info & install', 'FINALISE the installer SOP and TRAIN installers; lock the plug-connection-only rule (no fixed 230V work)', 'Rushroom', 'Finalise + train', 'Final SOP + training record', '6', 'High', 'Open', ARRAY['internal','installer']::text[]),
  (26, '9. Liability & records', 'OBTAIN product liability insurance before first sale', 'Rushroom → insurer', 'Arrange policy', 'Insurance policy', '7', 'High', 'Open', ARRAY['internal']::text[]),
  (27, '9. Liability & records', 'POPULATE the Records Retention Log; keep DoC + technical file 10 years', 'Rushroom', 'Update log', 'Maintained log', '8', 'Ongoing', 'Open', ARRAY['internal','reviewer']::text[]),
  (28, '10. Ongoing', 'MONITOR standards/regulations monthly (automated watch agent already running)', 'Rushroom / agent', '09 folder', 'Monthly watch reports', '9', 'Ongoing', 'Active', ARRAY['internal']::text[]),
  (29, '10. Ongoing', 'RE-ISSUE the DoC / update the technical file whenever a supplier sends a Product Change Notification or a standard changes', 'Rushroom', 'On change', 'Updated DoC/file', '1', 'Ongoing', 'Open', ARRAY['internal','supplier','reviewer']::text[]),
  (30, '10. Ongoing', 'SUBMIT annual WEEE + packaging reports to Naturvardsverket by 31 March each year', 'Rushroom', 'Naturvardsverket', 'Filed reports', '4', 'Annual', 'Open', ARRAY['internal']::text[])
on conflict (step) do nothing;

insert into public.documents (category, name, url, audience) values
  ('Declarations & CE', 'EU Declaration of Conformity (template)', 'https://docs.google.com/document/d/1x5Llp1rEulCz_-7LtMBHT8wb6uVGpGhFeB03Q-63CnU/edit', ARRAY['internal','reviewer']::text[]),
  ('Declarations & CE', 'CE marking specification', 'https://docs.google.com/document/d/1ywY9J9Fgfl4_ExBdFA9gQwt3AkqABw8xz48KVbYaH0Y/edit', ARRAY['internal','supplier','reviewer']::text[]),
  ('Declarations & CE', 'PPWR Declaration of Conformity (reusable packaging)', 'https://docs.google.com/document/d/1Px8WdhGTlwEWB0mkYJc_0bTBbZp-PRTniUdXiTBAnzE/edit', ARRAY['internal']::text[]),
  ('Technical file', 'Technical File index (template)', 'https://docs.google.com/document/d/14vnhdLBOU_3gZToVHy_soRX1HqZvmgvmXAadoSGO6TM/edit', ARRAY['internal','reviewer']::text[]),
  ('Technical file', 'Compliance Audit File — README / map', 'https://docs.google.com/document/d/1e_Hvhyp50ST9l4NOG0A07Qy6b6xlDKJ2nLfV4GAzunc/edit', ARRAY['internal']::text[]),
  ('Technical file', 'Compliance Documentation Register', 'https://docs.google.com/spreadsheets/d/1W2BLk_gWH0QVZaN-zNdXnJ31ODC3trK0myIQNdJQAzk/edit', ARRAY['internal','reviewer']::text[]),
  ('Test reports', 'LVD / safety test report (IOS-PRF0032, AA-86878-25)', 'https://drive.google.com/file/d/1pXOt6Ol4MwmjvblUSY03vSpv9naXZ3GW/view', ARRAY['internal','reviewer']::text[]),
  ('Suppliers', 'Supplier Declaration of Compliance (form)', 'https://docs.google.com/document/d/1MNxJ_uByom-XcrnvrzbjyKhYbwEeD7gHmB0Kne9es4U/edit', ARRAY['internal','supplier']::text[]),
  ('Suppliers', 'Supplier Compliance Spec — LED strip & cabling/connectors', 'https://docs.google.com/spreadsheets/d/1Xz67mHsJ31HWQFXYLrn_xqkhhtxXZETun9f6jTk59JA/edit', ARRAY['internal','supplier']::text[]),
  ('Suppliers', 'Product Change Notification commitment (annex)', 'https://docs.google.com/document/d/1eqPeMt8QpsYHEpW9bclvyHA6veaHqKmi0PwGcHetHpU/edit', ARRAY['internal','supplier']::text[]),
  ('Materials & packaging', 'Packaging compliance checklist (reusable transport packaging)', 'https://docs.google.com/spreadsheets/d/1rrWd76T6SvcHF985jWgDrT8tzPa2pZ54uXFoI9fLVP4/edit', ARRAY['internal']::text[]),
  ('Records & monitoring', 'Records Retention Log', 'https://docs.google.com/spreadsheets/d/1mKgXaBHHghEF3l-qR7tdDC5PnS5wpUEAkAWFqJb9kcM/edit', ARRAY['internal']::text[]),
  ('Records & monitoring', 'Regulatory Watch — 2026-06', 'https://docs.google.com/document/d/1MO246WfK9Fnc7Es7-WZwAWwVvJrWkECXpEIJmVnIuS8/edit', ARRAY['internal','reviewer']::text[])
on conflict do nothing;
-- ---------------------------------------------------------------------------
-- User accounts: self-registration + email verification + admin management.
-- Access is via the portal-api Edge Function (service role); RLS denies direct.
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  email          text not null unique,
  phone          text,
  whatsapp       text,
  requested_role text not null default 'supplier',
  role           text,                                   -- assigned by an admin: admin|internal|reviewer|supplier|installer
  status         text not null default 'pending',        -- pending|verified|approved|rejected|disabled
  email_verified boolean not null default false,
  password       text,                                   -- PBKDF2 hash (pbkdf2$iter$salt$hash); never plaintext
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.users enable row level security;      -- deny-all; edge function uses service role
create index if not exists users_status_idx on public.users (status);
-- If the table already exists from an earlier version, add the password column:
alter table public.users add column if not exists password text;

-- ============================================================================
-- LEVEL 2 DATA ARCHITECTURE: Structured Clause-Level Interpretations
-- ============================================================================
-- Decomposed clauses from a specific version of a standard.
-- Populated either manually or via AI extraction from the standard PDF.
create table if not exists public.standard_clauses (
  id                   uuid primary key default gen_random_uuid(),
  standard_version_id  uuid not null references public.standard_versions(id) on delete cascade,
  clause_ref           text not null,        -- e.g. "4.11", "Annex B.2"
  clause_title         text,                 -- e.g. "Short-circuit protection"
  clause_text          text,                 -- verbatim or summarized requirement
  requirement_type     text default 'mandatory', -- 'mandatory' | 'conditional' | 'informative'
  parent_clause_id     uuid references public.standard_clauses(id) on delete set null,  -- for hierarchy
  sort_order           integer default 0,
  ai_generated         boolean default false,
  created_at           timestamptz not null default now(),
  unique(standard_version_id, clause_ref)
);
create index if not exists standard_clauses_std_version_idx on public.standard_clauses (standard_version_id);
create index if not exists standard_clauses_parent_idx on public.standard_clauses (parent_clause_id);

-- Our interpretation of each clause — this IS the As Operates at atomic level.
-- Stores compliance interpretation per clause, linked to a specific As Operates document version.
create table if not exists public.as_operates_interpretations (
  id                        uuid primary key default gen_random_uuid(),
  clause_id                 uuid not null references public.standard_clauses(id) on delete cascade,
  document_version_id       uuid not null references public.document_versions(id) on delete cascade,
  interpretation_text       text,        -- how we have implemented this requirement
  compliance_status         text default 'pending', -- 'compliant' | 'deviation' | 'not_applicable' | 'pending'
  rationale                 text,        -- why we interpret it this way
  evidence_refs             jsonb default '[]'::jsonb, -- [{type, label, storage_path, url}]
  deviation_description     text,        -- if deviation: what and why
  deviation_accepted_by     text,        -- who approved the deviation
  deviation_accepted_at     timestamptz,
  reviewed_by               text,        -- human reviewer (audit trail)
  reviewed_at               timestamptz,
  ai_generated              boolean default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique(clause_id, document_version_id)
);
-- Optional: keep the prior interpretation text so the UI can show a version diff.
alter table public.as_operates_interpretations add column if not exists previous_interpretation_text text;
create index if not exists as_op_interp_clause_idx on public.as_operates_interpretations (clause_id);
create index if not exists as_op_interp_doc_version_idx on public.as_operates_interpretations (document_version_id);
create index if not exists as_op_interp_status_idx on public.as_operates_interpretations (compliance_status);

-- DPP-ready product passport record (Level 3 preparation, ESPR furniture compliance 2027).
create table if not exists public.product_passports (
  id                                uuid primary key default gen_random_uuid(),
  product_name                      text not null,
  product_model                     text,
  manufacturer                      text default 'Rushroom AB',
  gtin                              text,  -- GS1 identifier when assigned
  declaration_of_conformity_ref     text,  -- link to DoC version
  applicable_standards              jsonb default '[]'::jsonb,  -- [{standard_id, version_id, clause_scope}]
  sustainability_data               jsonb default '{}'::jsonb,  -- {co2, materials, recyclability, etc.}
  passport_status                   text default 'draft',  -- 'draft' | 'active' | 'superseded'
  valid_from                        date,
  valid_to                          date,
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now()
);
create index if not exists product_passports_status_idx on public.product_passports (passport_status);

-- Link between a passport and specific interpretation records (many-to-many).
create table if not exists public.passport_interpretation_links (
  id                 uuid primary key default gen_random_uuid(),
  passport_id        uuid not null references public.product_passports(id) on delete cascade,
  interpretation_id  uuid not null references public.as_operates_interpretations(id) on delete cascade,
  relevance_note     text,
  created_at         timestamptz not null default now(),
  unique(passport_id, interpretation_id)
);
create index if not exists passport_interp_links_passport_idx on public.passport_interpretation_links (passport_id);

-- ---- RLS for new tables (deny-all; only edge function with service role can access) ----
alter table public.standard_clauses enable row level security;
alter table public.as_operates_interpretations enable row level security;
alter table public.product_passports enable row level security;
alter table public.passport_interpretation_links enable row level security;

-- ============================================================================
-- EU DIRECTIVE RELATIONSHIP ANALYSER (CELLAR / EUR-Lex integration)
-- ============================================================================
-- Maps how EU directives/regulations relate to each other — both at company
-- level (which apply to Rushroom AB as a business) and at product level (which
-- apply to a specific product passport). Data is drawn from the EU Publications
-- Office CELLAR SPARQL endpoint (public, no auth) and, on demand, AI inference.
-- All access is via the portal-api Edge Function (service role); RLS denies direct.

-- Registry of EU directives and regulations tracked by the company.
create table if not exists public.eu_directives (
  id                 uuid primary key default gen_random_uuid(),
  celex_number       text unique not null,             -- e.g. '32014L0035' (LVD)
  short_name         text not null,                    -- e.g. 'LVD', 'EMC', 'ESPR', 'RoHS'
  official_title     text,
  directive_type     text,                             -- 'directive' | 'regulation' | 'decision'
  status             text default 'active',            -- 'active' | 'repealed' | 'amended'
  in_force_date      date,
  scope_description  text,                             -- human-readable scope summary
  eur_lex_url        text,
  applies_to_company boolean default false,
  created_at         timestamptz not null default now()
);
create index if not exists eu_directives_company_idx on public.eu_directives (applies_to_company);

-- Links between directives — explicit (CELLAR / Akoma Ntoso <ref>) and AI-inferred.
create table if not exists public.directive_relations (
  id                  uuid primary key default gen_random_uuid(),
  source_directive_id uuid not null references public.eu_directives(id) on delete cascade,
  target_directive_id uuid references public.eu_directives(id) on delete cascade,
  target_celex        text,                            -- keep the CELEX even when the target isn't in the registry yet (gap)
  source_clause_ref   text default '',                 -- e.g. 'Article 3'
  target_clause_ref   text default '',                 -- e.g. 'Article 5'
  relation_type       text not null,
  -- 'requires' | 'supplements' | 'implements' | 'amends' |
  -- 'supersedes' | 'references' | 'conflicts_with' | 'defines_terms_for'
  relation_description text,
  source              text,                            -- 'cellar_sparql' | 'akn_ref_element' | 'ai_inferred'
  confidence          double precision default 1.0,    -- 1.0 for CELLAR data, 0.0-1.0 for AI
  verified            boolean default false,
  created_at          timestamptz not null default now(),
  unique(source_directive_id, target_celex, relation_type, source_clause_ref)
);
create index if not exists directive_relations_source_idx on public.directive_relations (source_directive_id);
create index if not exists directive_relations_target_idx on public.directive_relations (target_directive_id);

-- Directive applicability per product/component/service (linked to a passport).
create table if not exists public.product_directive_applicability (
  id                  uuid primary key default gen_random_uuid(),
  passport_id         uuid not null references public.product_passports(id) on delete cascade,
  directive_id        uuid not null references public.eu_directives(id) on delete cascade,
  applicability_status text default 'applicable',      -- 'applicable' | 'not_applicable' | 'partial' | 'under_review'
  rationale           text,
  assessed_by         text,
  assessed_at         timestamptz,
  created_at          timestamptz not null default now(),
  unique(passport_id, directive_id)
);
create index if not exists prod_dir_applic_passport_idx on public.product_directive_applicability (passport_id);

-- Raw CELLAR query cache — re-fetch only if older than 7 days (see cellar-service.ts).
create table if not exists public.cellar_cache (
  id            uuid primary key default gen_random_uuid(),
  celex_number  text not null,
  query_type    text not null,                          -- 'metadata' | 'relations' | 'fulltext'
  result_jsonb  jsonb not null default '{}'::jsonb,
  fetched_at    timestamptz not null default now(),
  unique(celex_number, query_type)
);
create index if not exists cellar_cache_lookup_idx on public.cellar_cache (celex_number, query_type);

alter table public.eu_directives                    enable row level security;
alter table public.directive_relations              enable row level security;
alter table public.product_directive_applicability  enable row level security;
alter table public.cellar_cache                     enable row level security;

-- Seed the directives relevant to VALCYRA's LED wardrobe system (idempotent).
insert into public.eu_directives (celex_number, short_name, official_title, directive_type, in_force_date, scope_description, eur_lex_url, applies_to_company) values
  ('32014L0035', 'LVD', 'Directive 2014/35/EU on the harmonisation of the laws of the Member States relating to the making available on the market of electrical equipment designed for use within certain voltage limits', 'directive', '2016-04-20', 'Electrical safety of equipment rated 50–1000 V AC / 75–1500 V DC.', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32014L0035', true),
  ('32014L0030', 'EMC', 'Directive 2014/30/EU on the harmonisation of the laws of the Member States relating to electromagnetic compatibility', 'directive', '2016-04-20', 'Electromagnetic compatibility — emissions and immunity of electrical/electronic equipment.', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32014L0030', true),
  ('32011L0065', 'RoHS', 'Directive 2011/65/EU on the restriction of the use of certain hazardous substances in electrical and electronic equipment', 'directive', '2011-07-21', 'Restriction of hazardous substances (Pb, Hg, Cd, Cr6+, PBB, PBDE, phthalates) in EEE.', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32011L0065', true),
  ('32012L0019', 'WEEE', 'Directive 2012/19/EU on waste electrical and electronic equipment', 'directive', '2012-08-13', 'Producer responsibility for collection, treatment and recycling of EEE waste.', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32012L0019', true),
  ('32006L0042', 'Machinery', 'Directive 2006/42/EC on machinery', 'directive', '2009-12-29', 'Health & safety requirements for machinery (applicability assessed for the finished product).', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32006L0042', false),
  ('32023R1542', 'Batteries', 'Regulation (EU) 2023/1542 concerning batteries and waste batteries', 'regulation', '2023-08-17', 'Sustainability, safety, labelling and end-of-life for batteries (applies if a battery ships).', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R1542', false),
  ('32024R1781', 'ESPR', 'Regulation (EU) 2024/1781 establishing a framework for the setting of ecodesign requirements for sustainable products', 'regulation', '2024-07-18', 'Ecodesign framework + Digital Product Passport; furniture/EEE delegated acts to follow.', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1781', true)
on conflict (celex_number) do nothing;

-- ============================================================================
-- COMPLIANCE STATUS DIMENSION: Lifecycle phase × Scope classification
-- ============================================================================
-- Positions every compliance item (documents + clause interpretations) in a 2×2
-- matrix: lifecycle phase (pre_launch | monitoring) × scope (company |
-- product_services). All columns are NULLABLE — NULL = unclassified, so an
-- existing Level 1/Level 2 database keeps working unchanged (progressive
-- enrichment). Additive migration only; no existing columns are altered.

-- Enums (guarded so the script stays safe to re-run).
do $$ begin
  create type public.lifecycle_phase as enum ('pre_launch', 'monitoring');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.compliance_scope as enum ('company', 'product_services');
exception when duplicate_object then null; end $$;

-- Classification + monitoring-recurrence columns on documents and interpretations.
-- Monitoring fields are SCHEMA ONLY in this phase (no due-date/notification logic);
-- they are only meaningful when lifecycle_phase = 'monitoring'.
alter table public.documents add column if not exists lifecycle_phase public.lifecycle_phase;
alter table public.documents add column if not exists scope public.compliance_scope;
alter table public.documents add column if not exists classification_ai_generated boolean not null default false;
alter table public.documents add column if not exists classified_by uuid;
alter table public.documents add column if not exists classified_at timestamptz;
alter table public.documents add column if not exists monitoring_frequency interval;
alter table public.documents add column if not exists next_due_at timestamptz;
alter table public.documents add column if not exists last_verified_at timestamptz;

alter table public.as_operates_interpretations add column if not exists lifecycle_phase public.lifecycle_phase;
alter table public.as_operates_interpretations add column if not exists scope public.compliance_scope;
alter table public.as_operates_interpretations add column if not exists classification_ai_generated boolean not null default false;
alter table public.as_operates_interpretations add column if not exists classified_by uuid;
alter table public.as_operates_interpretations add column if not exists classified_at timestamptz;
alter table public.as_operates_interpretations add column if not exists monitoring_frequency interval;
alter table public.as_operates_interpretations add column if not exists next_due_at timestamptz;
alter table public.as_operates_interpretations add column if not exists last_verified_at timestamptz;

-- Monitoring fields must be NULL for pre_launch items (only meaningful for monitoring).
do $$ begin
  alter table public.documents add constraint documents_monitoring_null_chk
    check (lifecycle_phase is distinct from 'pre_launch'
      or (monitoring_frequency is null and next_due_at is null and last_verified_at is null));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.as_operates_interpretations add constraint interp_monitoring_null_chk
    check (lifecycle_phase is distinct from 'pre_launch'
      or (monitoring_frequency is null and next_due_at is null and last_verified_at is null));
exception when duplicate_object then null; end $$;

-- Append-only audit trail of every classification change (no updates/deletes).
create table if not exists public.classification_log (
  id                  uuid primary key default gen_random_uuid(),
  entity_type         text not null,                    -- 'document' | 'interpretation'
  entity_id           uuid not null,
  old_lifecycle_phase public.lifecycle_phase,
  new_lifecycle_phase public.lifecycle_phase,
  old_scope           public.compliance_scope,
  new_scope           public.compliance_scope,
  changed_by          uuid,
  changed_at          timestamptz not null default now(),
  ai_generated        boolean not null default false
);
create index if not exists classification_log_entity_idx on public.classification_log (entity_type, entity_id);

alter table public.classification_log enable row level security;

-- ---- Classification on STEPS (same lifecycle_phase × scope 2×2 as documents) ----
-- Lets action-plan steps be designed/edited per quadrant. Enums are reused from
-- the classification section above. classification_log gains an integer entity_step
-- (steps have an integer PK) and entity_id becomes nullable for step entries.
alter table public.steps add column if not exists lifecycle_phase public.lifecycle_phase;
alter table public.steps add column if not exists scope public.compliance_scope;
alter table public.steps add column if not exists classification_ai_generated boolean not null default false;
alter table public.classification_log alter column entity_id drop not null;
alter table public.classification_log add column if not exists entity_step integer;

-- ============================================================================
-- REQUIREMENT LINKS: cross-document clause & text linking ("Requirement Threads")
-- ============================================================================
-- A typed, evidenced, reviewable edge between two addressable text units — today
-- a standard clause (standard_clauses) or a document version (document_versions);
-- an As-Operated "statement" endpoint can be added later without changing shape.
-- Generalises the directive_relations pattern (type / confidence / source /
-- status). Manual links are created 'accepted'; AI/imported links start 'proposed'.
-- Endpoints are stored as (type, id) rather than FKs so both kinds share one row;
-- referential cleanup is handled in the Edge Function. RLS denies direct access.
create table if not exists public.requirement_links (
  id             uuid primary key default gen_random_uuid(),
  from_type      text not null,                    -- 'clause' | 'document_version'
  from_id        uuid not null,
  to_type        text not null,                    -- 'clause' | 'document_version'
  to_id          uuid not null,
  link_type      text not null default 'same_clause',
  -- 'same_clause' | 'citation' | 'implements' | 'similar_intent' |
  -- 'defines_terms_for' | 'supersedes' | 'conflicts_with'
  confidence     double precision default 1.0,     -- 1.0 manual/exact, 0.0-1.0 for AI
  source         text default 'manual',            -- 'manual' | 'cited' | 'imported' | 'ai_assisted' | 'derived'
  status         text default 'accepted',          -- 'proposed' | 'accepted' | 'rejected' | 'flagged' | 'archived'
  rationale      text,
  evidence_from  text,                             -- matched snippet on the from side
  evidence_to    text,                             -- matched snippet on the to side
  created_by     text,
  reviewed_by    text,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique(from_type, from_id, to_type, to_id, link_type)
);
create index if not exists requirement_links_from_idx on public.requirement_links (from_type, from_id);
create index if not exists requirement_links_to_idx   on public.requirement_links (to_type, to_id);

alter table public.requirement_links enable row level security;

-- As-Operated "statements": a document version broken into addressable paragraphs,
-- so a requirement_link can point at a specific paragraph (endpoint type
-- 'statement') rather than the whole document. Segmented client-side from the
-- stored file text; re-segmenting replaces the set for that version.
create table if not exists public.document_statements (
  id                  uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references public.document_versions(id) on delete cascade,
  seq                 integer not null default 0,        -- 0-based paragraph order
  text                text not null default '',
  anchor              text,                              -- optional heading/label
  created_at          timestamptz not null default now(),
  unique(document_version_id, seq)
);
create index if not exists document_statements_docver_idx on public.document_statements (document_version_id);

alter table public.document_statements enable row level security;

-- ============================================================================
-- MULTI-TENANT SaaS — Stage 1: Organizations, Memberships, Invitations
-- ============================================================================
-- Introduces the tenant model additively. Every existing row is backfilled to a
-- single seed organization ("Rushroom AB"), so nothing changes behaviourally
-- until Stage 2 enforces scoping. All access still flows through portal-api
-- (RLS deny-all). Safe to re-run (idempotent). See PROP-012 in SYSTEM_OVERVIEW.

-- The seed organization id. MUST match RUSHROOM_ORG_ID in portal-api/index.ts.
-- (Used below via the literal; kept here as documentation.)

-- Tenants.
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text unique,                                  -- url-safe handle
  status      text not null default 'active',               -- 'trial'|'active'|'past_due'|'suspended'|'cancelled'
  plan        text not null default 'internal',             -- entitlement tier (Stage 4); 'internal' for the seed org
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- A user's role + status within one organization (the unit seats are counted from).
create table if not exists public.memberships (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  role            text not null default 'collaborator',     -- 'org_admin'|'manager'|'reviewer'|'collaborator'
  status          text not null default 'active',           -- 'active'|'invited'|'suspended'
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique(organization_id, user_id)
);
create index if not exists memberships_user_idx on public.memberships (user_id);
create index if not exists memberships_org_idx  on public.memberships (organization_id);

-- Pending email invitations to join an organization at a role.
create table if not exists public.invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email           text not null,
  role            text not null default 'collaborator',
  status          text not null default 'pending',          -- 'pending'|'accepted'|'revoked'|'expired'
  invited_by      uuid,                                     -- users.id of the inviter
  created_at      timestamptz not null default now(),
  expires_at      timestamptz,
  unique(organization_id, email)
);
create index if not exists invitations_email_idx on public.invitations (email);

alter table public.organizations enable row level security;
alter table public.memberships   enable row level security;
alter table public.invitations   enable row level security;

-- Seed the first tenant (idempotent by slug).
insert into public.organizations (id, name, slug, status, plan)
values ('11111111-1111-4111-8111-111111111111', 'Rushroom AB', 'rushroom', 'active', 'internal')
on conflict (slug) do nothing;

-- Migrate existing users into memberships of the seed org (role-mapped).
insert into public.memberships (organization_id, user_id, role, status)
select '11111111-1111-4111-8111-111111111111', u.id,
  case
    when u.role = 'admin'    then 'org_admin'
    when u.role = 'internal' then 'manager'
    when u.role = 'reviewer' then 'reviewer'
    else 'collaborator'
  end,
  case
    when u.status = 'approved'              then 'active'
    when u.status in ('disabled','rejected') then 'suspended'
    else 'invited'
  end
from public.users u
on conflict (organization_id, user_id) do nothing;

-- Add a nullable organization_id to every tenant-scoped table (additive).
-- NOTE: kept NULLABLE in Stage 1; Stage 2 ensures all writes set it and a later
-- hardening stage may add NOT NULL. Global tables (users, eu_directives,
-- directive_relations, cellar_cache) are intentionally NOT given an org column.
do $$
declare t text;
begin
  foreach t in array array[
    'steps','documents','document_versions','uploads','standards','standard_versions',
    'deviation_scans','deviation_findings','standard_clauses','as_operates_interpretations',
    'product_passports','passport_interpretation_links','product_directive_applicability',
    'classification_log','requirement_links','document_statements'
  ] loop
    execute format('alter table public.%I add column if not exists organization_id uuid references public.organizations(id) on delete cascade', t);
    execute format('update public.%I set organization_id = %L where organization_id is null', t, '11111111-1111-4111-8111-111111111111');
    execute format('create index if not exists %I on public.%I (organization_id)', t || '_org_idx', t);
  end loop;
end $$;

-- ============================================================================
-- MULTI-TENANT SaaS — Stage 3: platform audit (operator actions)
-- ============================================================================
-- Append-only trail of internal/operator actions — impersonation and tenant
-- status changes especially. Distinct from the per-tenant classification_log.
create table if not exists public.platform_audit (
  id                     uuid primary key default gen_random_uuid(),
  actor_user_id          uuid,
  actor_email            text,
  action                 text not null,               -- 'impersonate_start' | 'tenant_status_change' | …
  target_organization_id uuid references public.organizations(id) on delete set null,
  detail                 jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now()
);
create index if not exists platform_audit_created_idx on public.platform_audit (created_at desc);
alter table public.platform_audit enable row level security;

-- ============================================================================
-- MULTI-TENANT SaaS — Stage 4: usage metering (append-only AI token ledger)
-- ============================================================================
-- One row per AI call. Monthly usage = sum(input+output) for (org, period).
-- Append-only avoids read-modify-write races on a counter. Plan/entitlements
-- live in code (portal-api); the plan itself is organizations.plan.
create table if not exists public.ai_usage_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  period          text not null,                    -- 'YYYY-MM'
  action          text,
  input_tokens    integer not null default 0,
  output_tokens   integer not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists ai_usage_events_org_period_idx on public.ai_usage_events (organization_id, period);
alter table public.ai_usage_events enable row level security;

-- ============================================================================
-- MULTI-TENANT SaaS — Stage 5: DB hardening + MFA
-- ============================================================================
-- (1) organization_id becomes NOT NULL on every tenant table (safe now that
--     Stage 2 stamps every write), and (2) an immutability trigger blocks a bug
--     from ever moving a row between tenants. The trigger fires even for the
--     service role (unlike RLS, which the service role bypasses). Idempotent.

-- Block changing organization_id on update (tenant-move protection).
create or replace function public.forbid_org_change() returns trigger
language plpgsql as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'organization_id is immutable (tenant boundary)';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'steps','documents','document_versions','uploads','standards','standard_versions',
    'deviation_scans','deviation_findings','standard_clauses','as_operates_interpretations',
    'product_passports','passport_interpretation_links','product_directive_applicability',
    'classification_log','requirement_links','document_statements'
  ] loop
    -- backfill any stragglers, then enforce NOT NULL
    execute format('update public.%I set organization_id = %L where organization_id is null', t, '11111111-1111-4111-8111-111111111111');
    execute format('alter table public.%I alter column organization_id set not null', t);
    -- tenant-move protection
    execute format('drop trigger if exists trg_forbid_org_change on public.%I', t);
    execute format('create trigger trg_forbid_org_change before update on public.%I for each row execute function public.forbid_org_change()', t);
  end loop;
end $$;

-- Multi-factor auth (TOTP) — opt-in per user; mfa_enabled defaults false so
-- existing accounts are unaffected until they enrol.
alter table public.users add column if not exists mfa_enabled boolean not null default false;
alter table public.users add column if not exists mfa_secret text;
alter table public.users add column if not exists mfa_pending_secret text;
