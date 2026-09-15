# /ideate — Capture and structure a new feature idea

The idea to explore is: $ARGUMENTS

## Step 1 — Read what already exists
Read docs/IDEAS.md to see existing ideas.
Read docs/SYSTEM_OVERVIEW.html sections 2 (tables) and 14 (proposals).
Check: does a PROP already cover this idea?

## Step 2 — Think it through
Answer these questions before writing anything:
- What real problem does this solve?
- What already exists that could be extended?
- Which tables and API actions would this touch?
- What is the smallest version that proves the value?
- What could go wrong?
- How does this interact with PROP-012 multi-tenancy?

## Step 3 — Write to IDEAS.md
Append this block to docs/IDEAS.md:

---
### [idea title] — [today's date]
**One sentence:** [what it does]
**Problem it solves:** [the pain]
**MVP scope:** [smallest thing worth building]
**Tables involved:** [list]
**Effort estimate:** [X hours]
**Risks:** [what could go wrong]
**Related PROPs:** [any overlap with existing proposals]
**Status:** Raw idea

## Step 4 — Confirm
Tell me: "Written to IDEAS.md. Run /build '[idea title]' to generate the implementation spec."

Then, in at most three lines:
- **Already exists:** anything in the codebase that already does part of this. Say what it
  covers and what it does not. Check before claiming the idea is new — several ideas in this
  repo turned out to be 80% built already.
- **Blocked on:** any prerequisite defect or decision.
- **Overlaps:** any existing PROP or IDEAS entry covering the same ground, and which should
  be built first. Two proposals for one problem is worse than none.

## Quick capture — ideas that arrive mid-build
When an idea surfaces while building something else, do NOT run the full flow and do not
expand the current work. Add one line to **Discovered While Building** in docs/ROADMAP.md
and carry on. Promote it to a full IDEAS.md entry later if it keeps mattering.
