# Deploy Runbook — Database Migrations

How to apply the `supabase/migrations/` files to a database. Two flows: a **fresh**
database (new environment, local dev, CI, a new tenant's prod) and an **existing**
database that already has the schema but no migration history (today's production).

- **Schema** lives in `supabase/migrations/` — 6 numbered, idempotent files
  (`0001_baseline` … `0006_multi_tenant`). `supabase/schema.sql` is **REFERENCE ONLY**,
  do not apply it.
- **Seed + backfill data** lives in `supabase/seed.sql` (storage buckets, the seed
  org "Rushroom AB", steps, documents, EU directives, users→memberships). Migrations
  never insert data.
- Project ref: **`iwoqujpwhsoywudjtsnj`** ("Compliance Dashboard", eu-central-1).

---

## Prerequisites

- Supabase CLI installed (`supabase --version`) and logged in (`supabase login`;
  verify with `supabase projects list`).
- The **production database password** — needed for every *remote* DB command
  (`link`, `migration list`, `migration repair`, `db push`). Keep it out of the repo;
  the CLI prompts for it, or set `SUPABASE_DB_PASSWORD` in your shell.
- For local flows: Docker running (`supabase start`).

> These remote steps can't be run from the Claude Code environment — the DB password
> is not available there. Run them from a trusted local shell, same as `git push`.

---

## Flow A — Fresh database (local dev, CI, a new tenant's prod)

The database is empty. Migrations create everything from scratch, then seeds load data.

### Local

```bash
supabase start                 # boots local Docker Postgres
supabase db reset              # applies all migrations IN ORDER, then runs seed.sql
supabase db diff --local       # expect: "No schema changes found"
```

`db reset` runs `seed.sql` automatically. Verified 2026-07-10: all 6 migrations apply
cleanly to a fresh local DB, `db diff` is clean, 25 tables present.

### Remote (a brand-new project)

```bash
supabase link --project-ref <NEW_PROJECT_REF>
supabase db push               # applies all migrations in order
# seed.sql is NOT run by db push — apply it once, manually:
#   psql "<connection string>" -f supabase/seed.sql
#   (or paste supabase/seed.sql into the SQL Editor)
```

---

## Flow B — Existing prod that already has the schema (RECONCILE FIRST)

**This is today's production.** The schema was applied historically by pasting SQL into
the Supabase SQL Editor (Stages 0–5a), so the tables exist but the
`supabase_migrations.schema_migrations` history has **no record of 0001–0006**. A naive
`db push` would try to run all six files against the live DB. They are idempotent
(`IF NOT EXISTS` / guarded `DO` blocks), so it *should* be a no-op — but do not rely on
that. Instead, tell the migration system these versions are already applied, then push.

```bash
# 1) Link this checkout to prod (creates supabase/config.toml; may prompt for DB password)
supabase link --project-ref iwoqujpwhsoywudjtsnj

# 2) Inspect remote history — expect 0001–0006 shown as applied Locally but NOT Remote
supabase migration list --linked

# 3) Reconcile: mark them applied WITHOUT re-running DDL
supabase migration repair --status applied 0001 0002 0003 0004 0005 0006

# 4) Confirm the push is now a clean no-op
supabase db push               # expect: "Remote database is up to date"
```

**If step 4 instead wants to apply 0001–0006 — STOP, do not confirm.** That means the
repair didn't register; re-running DDL on the live DB unattended is not worth the risk.
Recheck `migration list --linked` and the version names before proceeding.

Do **not** run `seed.sql` against existing prod — the data is already there. (It is
`on conflict do nothing` throughout, so it would be a safe no-op, but there's no reason to.)

---

## Verification (any flow)

```bash
supabase migration list --linked   # local and remote columns should match
supabase db diff --linked          # expect: "No schema changes found"
```

---

## Gotchas

- **`supabase link` creates `supabase/config.toml`** as a new file. Commit it so the
  linked-project config is captured for the team.
- **Migration versions are the numeric prefixes** `0001`…`0006` (Supabase usually uses
  14-digit timestamps). Local `db push` accepts these; if a remote command ever rejects
  them, rename the files with timestamp prefixes and update this runbook.
- **Idempotency is the safety net, not the plan.** Every migration uses
  `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, and guarded `DO` blocks for
  enums/constraints, so re-application is safe — but on prod, reconcile (Flow B) rather
  than lean on that.
- **Order matters.** Files must apply `0001 → 0006` (FKs + the `organization_id`
  NOT-NULL/trigger in 0006 depend on earlier tables). The numeric prefixes enforce it.
- **The `forbid_org_change` trigger (0006)** blocks any UPDATE that changes
  `organization_id`. That's why seed data carries `organization_id` at INSERT time
  (via a temporary column default in `seed.sql`) instead of being back-filled by UPDATE.
- **Full deploy also needs** the edge function and frontend, which are independent of DB
  migrations:
  - `supabase functions deploy portal-api --no-verify-jwt`
  - frontend: bump `?v=N` on the changed asset tags, then merge the pull request into `main` (Netlify publishes it).
