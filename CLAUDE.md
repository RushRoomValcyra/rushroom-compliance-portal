# Rushroom Engineering & Compliance Platform — Claude Code Context

## What this is
Compliance portal for Rushroom AB's LED furniture product.
- Frontend: GitHub Pages (static, cache-busted via ?v=N on the asset tags in index.html)
- Backend: Three Supabase Edge Functions (Deno, --no-verify-jwt), sharing `supabase/functions/_shared/`:
  - `portal-api`    — auth, CRUD, tenants, accounts, BOM (the hot path; no heavy deps)
  - `portal-ai`     — every Anthropic action + document parsing (jszip, pdf-lib)
  - `portal-cellar` — EU CELLAR SPARQL + relation inference
- DB: Supabase Postgres (29 tables). Schema in supabase/migrations/*.sql
- AI: ALL calls use `claude-opus-4-8` via api.anthropic.com/v1/messages

## Commands I use to deploy
Deploy edge functions: supabase functions deploy portal-ai --no-verify-jwt
                       supabase functions deploy portal-cellar --no-verify-jwt
                       supabase functions deploy portal-api --no-verify-jwt
                       (heavy functions FIRST — the frontend routes to them once pushed;
                        a _shared/ change requires redeploying all three)
Apply DB migration:    supabase db push
Deploy frontend:       git push origin main (GitHub Actions → Pages)
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

## Database — 29 tables across 7 domains
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
Custom fields (PROP-040): custom_spec_fields
Manufacturing (PROP-030): family_routing_steps, work_orders,
        work_order_steps, work_order_components

## Current state
Frontend cache version: ?v=264
Last SYSTEM_OVERVIEW audit: 2026-09-24
PROP-012 (multi-tenant SaaS): IN PROGRESS — do not break organization_id logic