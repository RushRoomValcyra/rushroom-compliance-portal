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
In docs/ROADMAP.md:
- Move the feature from "In Progress" to "Shipped" (with today's date)
- Update "Next" section if priorities changed

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
Show me a summary of every file that changed.
Then ask: "Ready to commit? Give me a commit message or I'll write one."