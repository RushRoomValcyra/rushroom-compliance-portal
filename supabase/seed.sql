-- ============================================================================
-- seed.sql — Rushroom Engineering & Compliance Platform seed & backfill data
-- Run AFTER every migration in supabase/migrations/ has been applied.
-- Contains all data that used to live in the schema: storage buckets, the seed
-- tenant, action-plan steps, the document library, the EU directive registry,
-- and the users→memberships backfill. Idempotent (on conflict do nothing).
--
-- organization_id is NOT NULL on tenant tables (migration 0006). For the two
-- seeded tenant tables (steps, documents) we set a temporary column default to
-- the seed org so the VALUES lists stay unchanged; INSERT does not fire the
-- forbid_org_change trigger, so no tenant-boundary conflict arises.
-- ============================================================================

-- ---- Private storage buckets ----------------------------------------------
--   supplier-uploads : files suppliers submit
--   documents        : the compliance document library files (Google-free mode)
--   standards        : the standards register files
-- Storage objects are reached only via the Edge Function (signed URLs), so no
-- public storage policies are created.
insert into storage.buckets (id, name, public)
values ('supplier-uploads', 'supplier-uploads', false),
       ('documents', 'documents', false),
       ('standards', 'standards', false)
on conflict (id) do nothing;

-- ---- Seed the first tenant (must exist before any org-scoped rows) ---------
-- The seed organization id MUST match RUSHROOM_ORG_ID in portal-api/index.ts.
insert into public.organizations (id, name, slug, status, plan)
values ('11111111-1111-4111-8111-111111111111', 'Rushroom AB', 'rushroom', 'active', 'internal')
on conflict (slug) do nothing;

-- ---- Action-plan steps + document library (generated from assets/config.js)
-- Default the NOT NULL organization_id to the seed org for these inserts.
alter table public.steps     alter column organization_id set default '11111111-1111-4111-8111-111111111111';
alter table public.documents alter column organization_id set default '11111111-1111-4111-8111-111111111111';

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

alter table public.steps     alter column organization_id drop default;
alter table public.documents alter column organization_id drop default;

-- ---- EU directive registry (global table; no organization_id) --------------
-- Directives relevant to VALCYRA's LED wardrobe system (idempotent).
insert into public.eu_directives (celex_number, short_name, official_title, directive_type, in_force_date, scope_description, eur_lex_url, applies_to_company) values
  ('32014L0035', 'LVD', 'Directive 2014/35/EU on the harmonisation of the laws of the Member States relating to the making available on the market of electrical equipment designed for use within certain voltage limits', 'directive', '2016-04-20', 'Electrical safety of equipment rated 50–1000 V AC / 75–1500 V DC.', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32014L0035', true),
  ('32014L0030', 'EMC', 'Directive 2014/30/EU on the harmonisation of the laws of the Member States relating to electromagnetic compatibility', 'directive', '2016-04-20', 'Electromagnetic compatibility — emissions and immunity of electrical/electronic equipment.', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32014L0030', true),
  ('32011L0065', 'RoHS', 'Directive 2011/65/EU on the restriction of the use of certain hazardous substances in electrical and electronic equipment', 'directive', '2011-07-21', 'Restriction of hazardous substances (Pb, Hg, Cd, Cr6+, PBB, PBDE, phthalates) in EEE.', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32011L0065', true),
  ('32012L0019', 'WEEE', 'Directive 2012/19/EU on waste electrical and electronic equipment', 'directive', '2012-08-13', 'Producer responsibility for collection, treatment and recycling of EEE waste.', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32012L0019', true),
  ('32006L0042', 'Machinery', 'Directive 2006/42/EC on machinery', 'directive', '2009-12-29', 'Health & safety requirements for machinery (applicability assessed for the finished product).', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32006L0042', false),
  ('32023R1542', 'Batteries', 'Regulation (EU) 2023/1542 concerning batteries and waste batteries', 'regulation', '2023-08-17', 'Sustainability, safety, labelling and end-of-life for batteries (applies if a battery ships).', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R1542', false),
  ('32024R1781', 'ESPR', 'Regulation (EU) 2024/1781 establishing a framework for the setting of ecodesign requirements for sustainable products', 'regulation', '2024-07-18', 'Ecodesign framework + Digital Product Passport; furniture/EEE delegated acts to follow.', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1781', true)
on conflict (celex_number) do nothing;

-- ---- Backfill: existing users → memberships of the seed org (role-mapped) ---
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
