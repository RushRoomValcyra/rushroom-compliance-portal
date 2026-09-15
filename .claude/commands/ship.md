# /ship — Update all documentation after a feature is complete

Run this after a feature is built and tested. Never before.

## Step 1 — See what changed
Run: git diff --name-only HEAD
Read each changed file to understand what was added or modified.

## Step 2 — Update SYSTEM_OVERVIEW.html
Open docs/SYSTEM_OVERVIEW.html and make exactly these updates:

Section 0 (As-Built Status):
- Change the audit date to today
- Update ?v=N to the current value in index.html
- Update the paragraph to describe the new capability

Section 2 (Table Inventory):
- Add any new tables (domain, purpose, key fields)
- Wrap new content in: <span class="doc-changed">...</span>

Section 9 (API Endpoints):
- Add any new actions to the right table (Action | Input | Output | Role)

Section 14 (Proposals):
- Find the matching PROP card
- Change its status badge from IN PROGRESS → IMPLEMENTED
- Add today's date

IMPORTANT: Only change the sections affected by this feature.
Do not reformat or rewrite sections that weren't touched.
Preserve all existing HTML, CSS classes, and structure exactly.

## Step 3 — Update ROADMAP.md
The lifecycle is: Backlog → Next → Now → **Built (awaiting deploy)** → Shipped.

- Move the feature to **Built — Awaiting Deploy or Verification**, NOT to Shipped, unless
  it has been deployed AND exercised against production. On each Built line, state exactly
  what is still required (which migration, which deploy, what to verify).
- Move to **Shipped** only when confirmed working. The date is the verification date.
- If anything was found mid-build that is real but off-scope, add it to
  **Discovered While Building** rather than losing it in a commit message.
- Update "Next" if priorities changed.

## Step 4 — Append to DECISIONS.md
Add this block at the bottom of docs/DECISIONS.md:

---
**Date:** [today]
**Feature:** [feature name]
**Decision:** [the key architectural choice made]
**Why:** [why this approach over alternatives]
**Files changed:** [list the files]

## Step 5 — Bump cache version
In index.html, increment N by 1 in every ?v=N asset reference (styles.css, config.js, api.js, gdocs.js, viewer.js, app.js). Do the same in supplier.html if it carries versioned assets.
Also update the ?v=N line in CLAUDE.md to match.

## Step 6 — Stage everything
Run: git add -A
Show me a summary of every file that changed — as a table, one line per file.
Then ask: "Ready to commit? Give me a commit message or I'll write one."

## Step 7 — ALWAYS end with the Next Steps block
This is mandatory and comes last, after any explanation. Never bury ordering in prose.
Keep the whole block under ~12 lines. Commands only — no rationale inside it.

Use exactly this shape, omitting any section that does not apply:

```
**Next steps**

1. <command>          # only if this change needs it
2. <command>
3. <command>

**Then verify:** <the one or two checks that would actually catch a defect>
**Blocked:** <anything that cannot proceed, and on what>
```

Rules for the commands:
- **Dependency order, always:** `supabase db push` → `supabase functions deploy portal-api
  --no-verify-jwt` → `git push origin main`. The frontend is last because it is the thing
  that breaks loudly if the schema or function is behind it.
- **Only list steps this change actually needs.** A frontend-only change is one command;
  do not print the full three every time. Say which files changed to justify each step.
- **Verification must be specific.** "Test it" is useless. Name the click and the expected
  result, and prefer the check that would catch the riskiest path in the change.
- If nothing is left to do, say exactly that in one line instead of inventing steps.
- If a previous feature is still sitting in **Built — Awaiting Deploy**, list it too.
  The user cannot be expected to remember what is still undeployed.
