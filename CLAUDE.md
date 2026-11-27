# Rushroom Engineering & Compliance Platform — Claude Code Context

## What this is
Compliance portal for Rushroom AB's LED furniture product.
- Frontend: Netlify, https://engineeringcompliance.netlify.app (static, no build step, `netlify.toml`; cache-busted via ?v=N on the asset tags in index.html). Every pull request gets a deploy preview; `main` is production. The old github.io address forwards there.
- Backend: Three Supabase Edge Functions (Deno, --no-verify-jwt), sharing `supabase/functions/_shared/`:
  - `portal-api`    — auth, CRUD, tenants, accounts, BOM (the hot path; no heavy deps)
  - `portal-ai`     — every Anthropic action + document parsing (jszip, pdf-lib)
  - `portal-cellar` — EU CELLAR SPARQL + relation inference
- DB: Supabase Postgres (32 tables). Schema in supabase/migrations/*.sql
- AI: ALL calls use `claude-opus-4-8` via api.anthropic.com/v1/messages

## Commands I use to deploy
Deploy edge functions: supabase functions deploy portal-ai --no-verify-jwt --use-api
                       supabase functions deploy portal-cellar --no-verify-jwt --use-api
                       supabase functions deploy portal-api --no-verify-jwt --use-api
                       (heavy functions FIRST — the frontend routes to them once pushed;
                        a _shared/ change requires redeploying all three;
                        --use-api bundles server-side: without it the CLI waits on Docker,
                        which is usually not running here; from an agent add --yes)
Apply DB migration:    supabase db push --remote   (the bare command targets the local stack; from an agent add --yes)
Deploy frontend:       merge to main (Netlify publishes it; pull requests get a deploy preview)
Bump cache:            increment ?v=N on every asset tag in index.html (and supplier.html if present)

## Architecture rules — always follow these
- ALL business logic goes through an edge function. Browser never touches DB directly.
- Heavy work (AI, document parsing, CELLAR) belongs in portal-ai / portal-cellar, never portal-api.
  portal-api must not import jszip, pdf-lib or cellar-service — that is enforced by tests/routing-static.test.mjs.
- RLS is deny-all on every table. Service-role key only in edge function.
- Every new table MUST have: organization_id UUID NOT NULL FK → organizations,
  AND be added to TENANT_TABLES in _shared/tenant.ts — a table missing from that set
  passes through makeTdb unscoped, so every tenant reads every row and nothing errors.
  tests/tenant-tables.test.mjs guards this.
- Every new API action dispatches on body.action in the function that owns it.
  If it is AI or document work, add it to portal-ai and to HEAVY_ROUTES in assets/api.js.
- Schema changes = new migration file in supabase/migrations/ (never paste into SQL editor)
- AI responses MUST use JSON schema structured output (no free-form text parsing)
- Never use claude-opus-4-8 for cheap tasks (classification, metadata) — use haiku instead

## How to end a reply — always
Every reply that changes code or docs ends with a **Next steps** block: numbered commands
in dependency order, then one specific thing to verify. Never bury ordering in prose.

Deploy order is always: `supabase db push` → `supabase functions deploy portal-api
--no-verify-jwt` → `git push origin main`. Only list the steps the change actually needs.

Committed / pushed / deployed / verified are four different states. Do not conflate them,
and never describe unexercised code as working. Run `/status` to see where everything sits.

## Key files
- portal-api/index.ts       — hot-path actions (auth, CRUD, tenants, BOM)
- portal-ai/index.ts        — AI + document parsing actions
- portal-cellar/index.ts    — CELLAR actions
- _shared/                  — auth, tenancy, CORS/JSON, env+client, timing, request envelope
- portal-api/cellar-service.ts — EU CELLAR SPARQL integration
- assets/app.js             — all frontend logic (no framework, vanilla JS)
- assets/config.js          — API URL + Google OAuth client ID (no ?v= here)
- index.html                — page shell + the ?v=N cache-bust on all asset tags
- docs/SYSTEM_OVERVIEW.html — living system documentation (always update with /ship)
- docs/IDEAS.md             — raw feature ideas (Claude reads this before /build)
- docs/ROADMAP.md           — lifecycle state: Backlog → Next → Now → Built (awaiting deploy) → Shipped
                              plus "Discovered While Building" for ideas found mid-build
- docs/DECISIONS.md         — architectural decisions log (Claude appends after /ship)

## Database — 32 tables across 7 domains
Action plan: steps
Documents: documents, document_versions, uploads
Standards: standards, standard_versions
Deviation: deviation_scans, deviation_findings
Users: users
Level 2: standard_clauses, as_operates_interpretations,
         product_passports, passport_interpretation_links
CELLAR: eu_directives, directive_relations,
        product_directive_applicability, cellar_cache
Classification: classification_log
SaaS (PROP-012 IN PROGRESS): organizations, memberships,
        invitations, platform_audit, ai_usage_events
Links (PROP-011): requirement_links, document_statements
Categories (PROP-038): part_categories
Drawings (PROP-045): drawings, drawing_revisions,
        drawing_components, drawing_dimensions
Spec governance (dynamic drawings, 0068): drawing_spec_versions,
        drawing_spec_patches, drawing_spec_turns
        (docs/DYNAMIC_DRAWINGS.md; template + patch pinned on every issue;
         an iterated draft keeps its letter, STATUS_MODEL §5.2)
Custom fields (PROP-040): custom_spec_fields
Manufacturing (PROP-030): family_routing_steps, work_orders,
        work_order_steps, work_order_components

Fitting stage (PROP-056): bom_edges.fitting_stage (hub / site / NULL)
Revision states (2026-11-25): a drawing issue and a CAD revision are Draft → Released →
        Superseded only (docs/STATUS_MODEL.md §5.1). Since 0064 the revision row is the ONLY
        place a status or letter lives: drawings and cad_models carry current_revision_id, nothing else
Component types (PROP-058): part | raw_material | sub_assembly |
        phantom_assembly (structural only) | finished_good | spare_part | product_family

## Current state
Frontend cache version: ?v=473 (app.js, viewer.js, styles.css, drawing-spec-core.mjs)
Last SYSTEM_OVERVIEW audit: 2026-09-24
PROP-012 (multi-tenant SaaS): IN PROGRESS — do not break organization_id logic