# /status — Where are we, and what do I do next

Answer in under 40 lines total. This is a dashboard, not an essay. No preamble.

## Step 1 — Gather facts, do not guess
Run these and read the results. Never state deployment status from memory.

```
git log --oneline origin/main..main            # unpushed commits
git status --porcelain                         # uncommitted work
ls supabase/migrations/ | tail -5              # latest migration files
grep -c "?v=" index.html                       # cache version in use
```

For anything claimed to be live, verify against the database rather than trusting
the docs. Applied migrations and real rows are the source of truth:

```
mcp__claude_ai_Supabase__execute_sql  (project: Compliance Dashboard)
  → check the columns/tables the recent work added actually exist
```

Read docs/ROADMAP.md for the lifecycle state of each item.

## Step 2 — Output exactly these four blocks

### 1. Live right now
One line per recently shipped feature that is **confirmed working in production**.
Nothing that is merely committed.

### 2. Built but not live  ⚠ the one that bites
For each: what it is, and the exact ordered commands to make it live. This is the
state the user most often loses track of, so it comes before everything else they
might do. If the list is empty, say "Nothing undeployed."

### 3. What connects to what
Only the dependencies that would cause a failure or a wasted attempt if ignored.
Examples worth stating: a frontend that sends a field the deployed function does not
accept yet; an idea blocked on a prerequisite defect; two proposals covering the same
ground that should be reconciled before either is built. Skip anything obvious.

### 4. Next steps
A numbered list, most valuable first, each one line. For each say **why it is next**
in a half-sentence — blocking something, cheap, or high risk if left. Offer at most
five. Include an explicit "or tell me something else" at the end, since the roadmap
never survives contact with real work.

## Rules
- Deploy commands always in dependency order: `supabase db push` →
  `supabase functions deploy portal-api --no-verify-jwt` → `git push origin main`.
- Distinguish committed / pushed / deployed / verified. They are four different states
  and conflating them is what makes progress hard to follow.
- If the user asks "what now" in any form, this is the format to answer in.
- Never invent work to fill the list. A short list is a good answer.
