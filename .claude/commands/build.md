# /build — Generate a full implementation spec and build a feature

The feature to spec out: $ARGUMENTS

## Step 0 — Branch first, always
Before writing a single line of code, create a feature branch:

```
git checkout main
git pull origin main
git checkout -b feat/<prop-slug>
```

The branch name comes from the `Branch name` field in the IDEAS.md entry, or derive one
from the PROP number: `feat/prop-0XX-short-name`. Never commit feature work directly to main.
Confirm the branch is active (`git branch`) before touching any file.

## Step 1 — Find the idea
Read docs/IDEAS.md and find the entry matching the feature name above.
If nothing matches, treat $ARGUMENTS as the idea description directly.

## Step 2 — Read system context
Read docs/SYSTEM_OVERVIEW.html:
- Section 2: current table inventory
- Section 9: existing API actions
- Section 14: current proposals (find the PROP number if it exists)

## Step 3 — Generate the spec
Output a complete implementation plan with these sections:

### Feature: [name]
**PROP number:** PROP-0XX (next available number)
**Branch:** `feat/prop-0XX-short-name`
**Effort estimate:** X hours
**Risk:** Low / Medium / High

### What to build
[Clear description of what changes and what stays the same]

### New DB migration
File: supabase/migrations/00XX_[feature_name].sql
[Show the complete SQL — CREATE TABLE with organization_id NOT NULL, RLS policies,
and indexes for every column that will be filtered or sorted in queries]

### New API actions
[For each action: name, which function owns it (portal-api / portal-ai / portal-cellar),
input params, output, what it does in plain English]

### File structure
Break the implementation into focused files — no single file should exceed ~300 lines.
For edge functions, split handlers out of index.ts:
- `portal-api/handlers/<action-name>.ts` — one file per action group
- `portal-api/index.ts` — router only (imports + dispatch switch)

For Next.js routes, co-locate by feature:
- `app/(scope)/[feature]/page.tsx` — server component, data fetching only
- `app/(scope)/[feature]/actions.ts` — server actions ("use server")
- `app/(scope)/[feature]/<feature>-section.tsx` — client component ("use client")
- `server/<domain>/<module>.ts` — reusable server-side data functions
- `features/<domain>/schema.ts` — Zod schemas and shared types

Do not create barrel index files that re-export everything. Import directly.

### Performance and search requirements
For every query this feature introduces, specify:
- Which DB indexes are needed (add them in the migration)
- Which columns to select (never `select *` — fetch only what the UI uses)
- Whether results need pagination (add `limit`/`offset` or cursor if row count > 100)
- Whether a full-text search index (`tsvector`) is needed

For the frontend:
- Server components fetch data; client components own interaction only
- Lazy-load heavy sections (modals, large lists) rather than mounting everything upfront
- Avoid prop-drilling across more than two levels — pass data at the closest server boundary

### Architecture checklist
- [ ] Feature branch created (`feat/...`) before any code was written?
- [ ] Every new table has organization_id UUID NOT NULL?
- [ ] RLS deny-all policy on every new table?
- [ ] New action dispatched via body.action in the correct function?
- [ ] Using haiku (not opus) for cheap AI calls?
- [ ] No file exceeds ~300 lines?
- [ ] Every query column filtered/sorted has a DB index?
- [ ] No `select *` anywhere?

### How to test
[Step-by-step: what to click, what to expect, what proves it works]

### SYSTEM_OVERVIEW sections to update
[Which sections change — /ship will handle the actual update]

## Step 4 — Ask for confirmation
After showing the spec, ask: "Does this look right? Say 'go ahead' to start building,
or tell me what to change."

Before asking, state in ONE line each:
- **Blocked on:** any decision you need from me, or "nothing".
- **Prerequisites:** anything that must be built or fixed first (name it, do not bury it).

## Step 5 — While building, capture what you find
Building always turns up things the spec did not predict. Do not silently absorb them
and do not let them derail the feature.

- **A defect in the code you are touching** → fix it if it blocks the feature, and say so
  plainly in the commit. If it does not block, add it to **Discovered While Building** in
  docs/ROADMAP.md and keep going.
- **A better idea for something adjacent** → one line in **Discovered While Building**.
  Do not expand scope mid-build.
- **A fact that contradicts the spec** (the guard already exists, the column is not what
  the spec assumed, the API already does this) → say it immediately and correct the spec
  before continuing. A spec that has been invalidated must not be followed to the letter.
- **A file growing past ~300 lines** → stop and split it before continuing. Name the split
  clearly by what it owns, not by what it is (`location-actions.ts` beats `utils.ts`).

The point is that ideas which surface during a build are usually the good ones, but they
belong in the roadmap, not in the current diff.

## Step 6 — End with the Next Steps block
Same mandatory format as /ship Step 7: numbered commands in dependency order, then what
to verify specifically. If the feature is built but untested, say so in those words —
never describe unexercised code as working.
