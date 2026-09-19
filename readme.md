# Rushroom AB — Engineering & Compliance Platform

A small, accessible static website that gives all parties — the internal team, component
suppliers, installers and reviewers — one place to see **live compliance readiness** and
reach the **compliance document library** for Rushroom's LED system-furniture product.

Built as plain HTML/CSS/JavaScript (no build step, no framework), so it deploys free on
**GitHub Pages** and can be extended in any editor.

---

## Features

- **Access gate** — a single shared password (light gate; see Security).
- **Readiness view** — reads the 30-step action-plan Google Sheet live and shows overall
  progress, a **progress-by-phase** overview, the **pre-sale blockers** (priority =
  `BLOCKER`/gate), and every step grouped by phase with owner, evidence and priority.
- **Print / Save as PDF** — one click produces a clean, light-themed readiness report.
- **Document library** — tidy links to the real source files in Google Drive.
- **Clauses & DPP (Level 2, Rushroom-only)** — with the Supabase backend: AI-extract standard
  clauses, capture clause-level compliance interpretations, view a documents × clauses
  **compliance matrix**, and export an EU **Digital Product Passport** as JSON-LD (schema.org +
  ESPR, 2027-ready). See [docs/SYSTEM_OVERVIEW.html](docs/SYSTEM_OVERVIEW.html).
- **Supplier view** (`supplier.html`) — a slimmed page for suppliers: only their documents,
  the status of the supplier steps, and an optional **upload declaration** panel; nothing
  internal.
- **Accessible** — built to WCAG 2.1 AA (semantic landmarks, keyboard-operable tabs, skip
  link, visible focus, AA contrast, 44px targets, reduced-motion, responsive). See the
  Accessibility Audit in Drive.

---

## Project structure

```
.
├── index.html            # full portal: readiness dashboard + document library
├── supplier.html         # supplier-only view
├── assets/
│   ├── styles.css        # styling (WCAG 2.1 AA)
│   ├── app.js            # full-portal logic + API (editing) mode
│   ├── supplier.js       # supplier-view logic
│   ├── api.js            # Supabase Edge Function client (login/edit/upload)
│   └── config.js         # ← edit: password, sheet URL, document links, api.functionUrl
├── supabase/
│   ├── migrations/       # numbered migration files, apply with supabase db push
│   └── functions/portal-api/index.ts   # auth + edit/upload API gateway
├── google-apps-script/
│   └── setup-action-plan.gs   # one-time: adds Status/Priority dropdowns + colours to the Sheet
├── docs/                 # SUPABASE_SETUP.md, SYSTEM_OVERVIEW.html, ROADMAP.md, and more
├── .gitignore
├── CNAME.example         # rename to CNAME for a custom domain
├── .nojekyll             # serve files as-is on GitHub Pages
└── README.md
```

### Two modes
- **Read-only (default).** No backend. Shared-password gate + live status read
  from the published Google Sheet. Zero setup beyond the steps below.
- **Live editing (optional).** Set `api.functionUrl` in `config.js` to a deployed
  Supabase `portal-api` function and the portal gains **two-role login**, **in-portal
  status editing**, **supplier uploads**, and **document management** — Rushroom edits
  every step and uploads/deletes library files (stored in Supabase, no Google Drive
  needed); suppliers edit only their steps and submit files. This can fully replace
  Google. See **[docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md)**.

Everything you normally change lives in **`assets/config.js`**.

---

## Setup & deploy (≈10 minutes)

### 1. Set the password
The default password is `Rushroom-Compliance-2026`. Change it: compute the SHA-256 hash of
your new password and paste it into `assets/config.js` → `passwordHash`.

```bash
printf '%s' 'YOUR-NEW-PASSWORD' | shasum -a 256   # macOS
printf '%s' 'YOUR-NEW-PASSWORD' | sha256sum        # Linux
```

(Or, on the live page, open the browser console and run `portalHash('YOUR-NEW-PASSWORD')`.)

### 2. Share the status sheet
The dashboard reads the action-plan sheet live, so set that sheet to
**Anyone with the link → Viewer** in Google Drive. It contains only step statuses (low
sensitivity), not the documents themselves.

### 3. Publish to GitHub Pages
1. Push this folder to a repository (its contents at the repo root, so `index.html` is at
   the top level).
2. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   select `main` / `/ (root)`, and save.
3. The site goes live at `https://<your-username>.github.io/<repo-name>/` within a minute.

### 4. (Optional) Custom domain
Rename `CNAME.example` to `CNAME`, put your domain inside (e.g. `compliance.rushroom.se`),
add the same domain under Settings → Pages, and create a CNAME DNS record at your provider.

---

## Updating

- **Status** — edit the action-plan Google Sheet; the dashboard reads it live (press
  *Reload status*). No redeploy needed. To make the Sheet easy and consistent to edit,
  run [`google-apps-script/setup-action-plan.gs`](google-apps-script/setup-action-plan.gs)
  once (Extensions → Apps Script) — it adds Status/Priority **dropdowns** and colour-codes
  the cells to match the portal.
- **Documents / password** — edit `assets/config.js` and commit the change.

---

## Security

This is a **static** site, so the shared password lives in the browser — it keeps casual
visitors out but is **not** strong security. Real protection of each document comes from
**Google Drive sharing**: a person can only open a linked file if Drive permits it.

- Keep sensitive files (test reports, signed Declaration of Conformity, supplier
  declarations) shared only with the right people in Drive.
- A **public** GitHub repo exposes `config.js` (the password hash and document links).
  The links stay protected by Drive permissions; if you need the code private too, that
  requires a paid GitHub plan.

---

## Accessibility

Conforms to **WCAG 2.1 AA** at the code level: semantic `header`/`main`/`footer`
landmarks, a skip link, keyboard-operable tabs (arrow-key navigation), a labelled password
field with live error messaging, visible focus outlines, AA colour contrast (lowest pair
4.56:1), responsive layout, and reduced-motion support. A screen-reader pass and a
Lighthouse/axe run on the deployed URL are recommended before go-live.

---

## Tech

Vanilla HTML, CSS and JavaScript. No dependencies, no build tooling. Data is read from a
published Google Sheet (CSV) at runtime; documents are hosted in Google Drive.

## Roadmap (optional, for later)

- **Per-role login + editing + uploads** — available now via the optional Supabase
  backend (`docs/SUPABASE_SETUP.md`): Rushroom and supplier passwords, server-side rules,
  in-portal status editing, and native file uploads. Currently shared-password-per-role;
  a future step is per-supplier accounts with a full `who-changed-what` audit trail
  (the data model already records `updated_by`).
- Search/filtering across documents and steps.

---

_Internal compliance tool for Rushroom AB. Not legal advice._
