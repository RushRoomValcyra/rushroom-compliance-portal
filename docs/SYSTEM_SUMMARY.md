# Rushroom Engineering & Compliance Platform — System Summary

**Last updated:** 2026-07-07
**Status:** Live in production
**Scope:** LED system-furniture (the "LED wardrobe system") compliance for Rushroom AB

> This is a concise, current summary of the actual portal. For the full technical
> reference (data model, ERDs, every API action, workflows) see
> [`SYSTEM_OVERVIEW.html`](SYSTEM_OVERVIEW.html). The older proposal-tracking
> workflow lives in [`PROPOSALS.json`](PROPOSALS.json),
> [`IMPLEMENTATION_LOG.md`](IMPLEMENTATION_LOG.md) and
> [`DRAFTING_SYSTEM_GUIDE.md`](DRAFTING_SYSTEM_GUIDE.md).

---

## What it is

A web-based compliance-documentation system that manages the full lifecycle of the
compliance evidence for Rushroom's LED system-furniture product: the CE/compliance
**action plan**, the **document library** (templates and "as operated" documents with
immutable version history), the **standards & regulations** register, structured
**clause-level interpretations** and **Digital Product Passport (DPP)** preparation for
ESPR, an **AI deviation scan**, and an **EU-directive relationship analyser**.

The whole thing is intentionally lightweight: a no-framework static frontend on GitHub
Pages talking to a single Supabase Edge Function, which is the only thing that touches
the database and file storage.

---

## Architecture at a glance

Three tiers:

1. **Frontend** — static HTML/CSS/vanilla JS, no build step. Hosted on **GitHub Pages**
   (repo `ziirvass/rushroom-compliance-portal`). Assets are cache-busted with a shared
   `?v=N` query string bumped on every release (currently `?v=91`).
   - `index.html` (portal shell + tabs), plus `supplier.html`, `verify.html`,
     `reset.html`.
   - `assets/app.js` (UI), `api.js` (edge-function client), `config.js` (function URL +
     public Google OAuth client id), `gdocs.js` (client-side Google Docs/Sheets),
     `viewer.js` (in-browser PDF/DOCX/XLSX/CSV/MD viewer), `styles.css`.

2. **Backend** — one **Supabase Edge Function** (`supabase/functions/portal-api`, Deno),
   deployed `--no-verify-jwt` because it does its own token auth. The browser never
   touches Postgres or Storage directly — every request is a `POST` with an `action`
   field. Project ref `iwoqujpwhsoywudjtsnj`.

3. **Data** — Supabase **PostgreSQL** (RLS enabled with no policies, so all access is via
   the function's service role) + three private **Storage** buckets: `documents`,
   `standards`, `supplier-uploads`.

External services: **Anthropic Claude** for all AI (model `claude-opus-4-8`), **Resend**
for transactional email (optional), the **EU Publications Office CELLAR** SPARQL/REST
service for directive metadata and relations, and **client-side Google Identity Services
OAuth** for the optional "edit in Google Docs" round-trip (the user's own Google account —
no server-side service account).

---

## What a user sees — the six tabs

The portal shows up to six top-level tabs, gated by role:

| Tab | Who | What it does |
|-----|-----|--------------|
| **Compliance Status** | All roles | The live action plan: summary tiles (overall %, pre-sale blockers, blocked actions), progress-by-phase, blockers panel, and collapsible phase sections with inline status editing. For Rushroom it carries two sub-tabs: **Status** and **Compliance Map** (a 2×2 Lifecycle × Scope board). |
| **Standards & Regulations** | All roles | Versioned register of standards/regulations (type + jurisdiction). Rushroom gets an **Add standard** sub-tab with AI metadata autofill. |
| **As Operated** | All roles | The document library — a two-pane browser of "Templates & Requirements" and "Company as Operated" docs, with version history, in-app viewer, version-to-version diff, AI drafting, and (Rushroom) supplier-upload review + a "Labels and Instructions" placeholder. |
| **Deviation Monitoring** | Rushroom only | Sub-tabs: **Monitoring** (the AI deviation scan) and **Directive Graph** (a D3 force graph of EU-directive relationships). |
| **Clauses & DPP** | Rushroom only | Level-2 structured compliance: **Clauses**, **Interpretations**, **Matrix**, **Passports** (DPP export). |
| **Accounts** | Admins only | User administration: approve/assign roles, generate verify/reset links, email-delivery status + test send. |

**Roles → access tier.** `admin`/`internal`/`reviewer` map to the full **"rushroom"**
tier; `supplier`/`installer` map to a limited **"supplier"** tier. `admin` accounts also
carry a super-user flag that unlocks the Accounts tab and permanent document deletion. A
shared-password login is retained as a bootstrap admin fallback.

---

## Key capabilities

- **Immutable versioning + provenance.** Documents and standards are never edited in
  place; every change is a new version row. Each document version records which prior
  version and which standard versions it was derived from. (Exception: an admin can
  permanently delete a whole document, cascading to versions, interpretations, passport
  links and the stored files.)

- **AI-assisted document drafting.** Claude reads the current document file + selected
  standard versions + the user's change notes and returns a structured draft (summary,
  proposed changes, markdown draft, version/filename hints) for human review before
  publishing.

- **AI deviation scan (two-phase).** Phase A turns existing clause interpretations into
  findings with no LLM call; Phase B sends only the documents that lack interpretations to
  Claude. Findings are graded Critical→Info, tagged `structured` vs `ai_inference`, and
  flagged when new since the previous scan. Token usage + cost is shown.

- **Level 2 — structured clause interpretations & DPP.** Standards are AI-decomposed into
  atomic clauses; each clause × document version gets an interpretation with a compliance
  status (`compliant` / `deviation` / `not_applicable` / `pending`) and an audit trail.
  These feed a compliance matrix and a Digital Product Passport export in **JSON-LD**
  (schema.org/Product + ESPR extensions) for the 2027 ESPR furniture deadline.

- **EU Directive Relationship Analyser (CELLAR).** Pulls directive metadata and
  relationships from the EU CELLAR service (7-day cached), optionally augmented by
  on-demand AI inference, and visualises them as an interactive D3 graph coloured by
  compliance coverage — at company level or per product passport, with a gaps list and an
  AI-written compliance narrative (EN/SV).

- **Compliance Status dimension (Lifecycle × Scope 2×2).** Every compliance item
  (documents, action-plan items, clause interpretations) can be classified by lifecycle
  phase (`pre_launch` / `monitoring`) × scope (`company` / `product_services`).
  Classification is captured at creation time in the new-action and new-document forms
  (all columns nullable → progressive enrichment); the **Compliance Map** sub-tab renders
  the resulting 2×2 board with per-quadrant counts, % complete and drill-down. An AI
  classification-suggestion endpoint and an editable classification workbench exist in the
  codebase but are not wired into the live UI in this revision.

- **Editing niceties.** In-browser document viewer, client-side version diffing (inline &
  side-by-side, yellow highlights), file-type badges, optional Google Docs/Sheets editing
  round-trip, light/dark theme, accessible keyboard tab navigation, Print/Save-PDF.

---

## Data model (tables)

Grouped by domain (see `supabase/schema.sql` for exact columns):

- **Action plan & documents:** `steps`, `documents`, `document_versions`, `uploads`
- **Standards:** `standards`, `standard_versions`
- **Deviation scan:** `deviation_scans`, `deviation_findings`
- **Accounts:** `users`
- **Level 2 / DPP:** `standard_clauses`, `as_operates_interpretations`,
  `product_passports`, `passport_interpretation_links`
- **CELLAR / directives:** `eu_directives`, `directive_relations`,
  `product_directive_applicability`, `cellar_cache`
- **Classification:** enums `lifecycle_phase` & `compliance_scope`; classification columns
  added additively to `documents`, `as_operates_interpretations` and `steps`; plus an
  append-only `classification_log`.

> Terminology note: the action-plan table is `steps` and the API verbs are still
> `addStep`/`updateStep`/`deleteStep` (the text field is sent as `actionText`). The
> **"Action"** wording is a UI rename only — the schema and API remain `step`.

---

## Deployment

- **Frontend:** commit & push to `main` → GitHub Pages redeploys. Bump the `?v=N`
  cache-bust on the asset tags in `index.html` (and `supplier.html`) so browsers refetch.
- **Edge function:** `supabase functions deploy portal-api --no-verify-jwt` (project is
  linked, so no `--project-ref` needed).
- **Schema:** paste `supabase/schema.sql` into the Supabase **SQL Editor** and run. It is
  idempotent (`if not exists` / `on conflict do nothing` / guarded `alter … add column`).
  There is **no** `migrations/` dir, so `supabase db push` does not apply the schema.

**Required Supabase secrets:** `TOKEN_SECRET`, `RUSHROOM_PW_HASH`, `SUPPLIER_PW_HASH`,
`ANTHROPIC_API_KEY`. **Optional:** `RESEND_API_KEY` + `MAIL_FROM` (email delivery;
falls back to copyable links), `APP_BASE_URL` (overrides the GitHub Pages base used in
email links). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.
