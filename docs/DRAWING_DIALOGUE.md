# The drawing dialogue — a prompt that changes a callout, a drawing, or the template

Design, 2026-11-27. Refines `docs/DYNAMIC_DRAWINGS.md` §4.2 / §7 Phase 5.
**Built the same day** (v470, migration 0069, portal-ai `handlers/drawing-spec.ts`,
portal-api `promoteDrawingSpecOps` · `discardDrawingSpecTurn` ·
`getDrawingSpecVersion`, the worker `Mirror`, drawset `plan` / `from` /
`pos_x_far`; UI contract in DRAWINGS_TAB_UX §13.9); §9 decided as recommended.
Deployed 2026-11-27; all §8 proofs held live the same morning — 1–4, 7, 8 and 10 on Side Panel Left, 6, 9 and 11 on Side Panel Right, the first drawing on `flat_panel` (ROADMAP has the record; flat_panel is at v3, promoted, `face_order: bottom_up`).

## 1 What was asked

> An integrated chat (prompt) so that you can change and update the drawing
> templates on the fly. For example: now the part is divided into 4 parts
> where 1 sheet holds every section. I would like to start from the bottom and
> not from the top. Such things must be possible to directly change in the
> drawings engine by an integrated prompt. Or, change where a specific
> measurement shall start from. In general or by marking a callout.
> — ziirvass, 2026-11-27

Three things are asked, and only one of them is a chat:

| ask | what it is underneath |
|---|---|
| change the **template** on the fly | a change whose home is the house template, not one drawing's patch |
| start the face sheets from the **bottom** | a knob on how `derive_template` splits a tall part into sheets |
| change where a measurement **starts from**, in general or per callout | a datum: per drawing (exists in the vocabulary) and per dimension (does not) |

The prompt is the way in. What it can reach is decided by the vocabulary and
by where a change is allowed to live. This document settles both.

## 2 What Phase 5 already designs, and where the two examples fall through

DYNAMIC_DRAWINGS §4.2 designs the dialogue: prose plus the marked entities (and
the marquee's model rectangle) go to portal-ai `proposeDrawingSpecOps`; the
answer is operations over the closed `SPEC_VOCAB`, refusals naming the code, and
questions; nothing is applied until the engineer accepts; accepted ops go
through `applyDrawingSpecOps` like a form edit. That stands. Tested against
the two examples it has three gaps:

1. **Sheet order is not a word.** `derive_template` (drawset.py ~970) splits a
   tall part into `n` bands of equal height and numbers them **top first**:
   sheet 2 is the top band, the last face sheet is the bottom. The only way to
   express "from the bottom" today is three `set_sheet { y_range }` ops typed
   by hand — numbers the patch may carry, but a layout dictated by the
   engineer, which breaks the moment the next CAD revision is 20 mm longer.
   The ask is a rule, so it needs a rule knob.
2. **A per-dimension datum is excluded.** `override_dimension` admits
   `dia, depth, groove_width, groove_depth, pocket_depth` only; `pos_*` kinds
   were named as code (§4.3, review challenge 3) because a per-hole
   **position tolerance** would change the x-row / y-stack grouping. "Measure
   this one from the top" is not that: `face_sheet` already keeps a from-top
   stack (`top`, kind `pos_y_top`) and decides per hole whether it belongs
   there (`y_from_top_within`). A per-hole datum is a lookup into an existing
   mechanism, not a layout change. The exclusion was right for tolerance and
   is wrong for datum.
3. **There is no template scope.** §10 placed "editing the house template from
   the portal" out of scope: a file on the Mac. The user now asks for exactly
   that. Since Phase 2 the portal already holds every template body as an
   immutable version and hands the body, not the name, to the worker — so the
   portal can author a version. What is missing is the act, its rules, and
   what happens to the file on the Mac and to the other fifty drawings.

Everything else in the ask (datum in general, tolerance on a kind, a view, a
sheet scale) the vocabulary already speaks.

## 3 Scope — the one new control

A change lives at one of three levels. The level is **chosen by the engineer**
on the prompt row, never inferred by the model: whether fifty drawings change
is not an inference.

| level | holds | written to | example |
|---|---|---|---|
| **This callout** | one dimension's override | this drawing's patch (`overrides[]`) | "this hole from the top", "depth +0.3 −0 here" |
| **This drawing** | rules for this part | this drawing's patch (`tolerances`, `datums`, `plan`, `views`, `sheets`, …) | "sheets from the bottom", "all Ø8 depths +0.5 −0" |
| **Template `flat_panel`** | house rules for every part on it | a **new immutable template version** (§5), then this drawing rebased onto it | "we always start sheets from the bottom" |

Rules:

- The control shows the three levels as a segmented row: **This callout ·
  This drawing · Template flat_panel vN**. *This callout* is enabled only
  while the selection chips hold at least one entity; the default is *This
  callout* when something is marked, *This drawing* otherwise.
- Every op in `SPEC_VOCAB` gets a fixed **level ceiling** (`OP_LEVEL` in
  `drawing-spec-core.mjs`, one constant, tested): `override_dimension` /
  `remove_override` are callout-level; `set_view`, `set_sheet`, `add_*`,
  `remove_*` on views and sheets are drawing-level (their ids are derived per
  part); `set_tolerance`, `set_datum`, `set_inside_face`, `set_from_top_rule`,
  `set_sheet_plan`, `name_edge`, `set_edge_band`, `set_hole_rule`, `add_pair`,
  `add_ctq` may be template-level.
- The chosen scope is a **ceiling, not a coercion**. Under *Template*, an op
  whose ceiling is lower stays in this drawing's patch and the card says so on
  its line ("stays on this drawing: a callout is one part's business"). Under
  *This drawing*, nothing is promoted. Under *This callout*, an op with no
  `at` is offered **unticked** (`above_scope: true`) with its level badge;
  ticking it is the widening, and it applies at its own level. It was a
  refusal (`category: scope`) until 2026-11-27 (v474): a marked box plus a
  general ask then produced a card with nothing to apply.
- Template scope is offered only when the drawing is on a template version
  (`kind = template`). A legacy `part_spec` drawing (side_panel_left) shows the
  control disabled with "migrate to flat_panel first" (DECISIONS 2026-11-26,
  §9 decision 5).

Why a control and not a question from the model: the model's job is to turn
intent into named operations over a closed grammar. "Did you mean every
drawing?" is a question it would have to ask on every turn, and a wrong guess
in either direction is costly — fifty silent changes, or a house rule that
never leaves one drawing. One tap settles it before the model is called, and
the turn row records it (`drawing_spec_turns.scope`).

## 4 The two asks as vocabulary

### 4.1 `set_sheet_plan` — how a part is split into sheets

A new patch key `plan` and one op:

| op | args | effect | applied |
|---|---|---|---|
| `set_sheet_plan` | `face_order ∈ {top_down, bottom_up}`; later `face_scale`, `overview_orient` | `plan.face_order` | **inside `derive_template`**, like datums: the bands are numbered from the chosen end before views and sheets are written |

drawset: `derive_template(spec, part, patch_datums, patch_plan)`; the band
list is reversed when `face_order = bottom_up`; the template YAML gains
`plan: { face_order: top_down }` as the house default so the key is visible in
the body and promotable. `derived.face_ranges` already reports the bands; the
rail and the model read the order off it.

Why a knob on the derivation and not three `set_sheet` ops: the bands are a
function of the part's length. A rule survives the next CAD revision; a list
of hand ranges does not, and would be the one place in the patch where the
engineer dictates layout numbers drawset should own.

### 4.2 `override_dimension { from }` — where one dimension starts

`override_dimension` admits two more kinds with one more argument:

| kind | arg | effect in drawset | dimension-list row |
|---|---|---|---|
| `pos_y` | `from ∈ {min, max}` | `ydims` consults `override_for(spec, at(h), 'pos_y')` **before** the `y_from_top_within` test; `from: max` routes the hole into the existing from-top group, `from: min` keeps it in the bottom group even inside the from-top band | kind becomes `pos_y_top` (exists) with the from-top value |
| `pos_x` | `from ∈ {min, max}` | the x-row loop measures that column from `X(ext_x)` instead of `X(0)` (or the reverse) — one extra end in `dimh`, same row pitch | kind becomes `pos_x_far` (new; the x counterpart of `pos_y_top`) |

Rules kept from 2026-11-26: `tol` and `name` are **refused** on `pos_*` kinds
(per-hole position tolerance stays code, §9 decision 3); `from` is refused on
every other kind. A pair member (c/c) or a CTQ end carries a relation, not a
datum: an override aimed at one is reported with the unmatched ones ("c/c is
a relation between two holes; it has no datum"), the same path a depth
override takes on a `through` row. drawset's verifier already recomputes
from-top values (`pos_y_top` passes round-trip today); `pos_x_far` is verified
the same way.

Why the kind changes rather than the value under the same kind: a dimension
measured from the other edge **is a different dimension**. `diffDimensionLists`
keys on `(at, kind)`, so the compare strip shows one row gone and one row new
at the same address, and `geometry_sha256` moves — truthfully, because the
geometry record changed. A silent value change under `pos_y` would read as a
CAD move.

"In general" is already spoken: `set_datum { axis: y, side: max }` moves the
whole drawing's y datum to the top edge; `set_from_top_rule { within }` moves
the band in which holes are measured from the top. Both exist, both apply
inside `derive_template`, both are drawing- or template-level under §3.

### 4.3 Three turns, end to end

| selection · scope | prompt | proposal | after Apply |
|---|---|---|---|
| none · This drawing | "Start the face sheets from the bottom, not the top" | `set_sheet_plan { face_order: bottom_up }` · reason "face sheets 2–4 run 0–280, 280–1300, 1300–2310" | Patch (1); Render; compare shows sheet 2 as the bottom band; strip "233 → 233 · 0 tolerances · 0 values · geometry same" (the bands move, the dimensions do not) |
| none · Template flat_panel v1 | same words | same op, line marked "→ flat_panel v2" | Promote (§5): v2 written, this drawing carried onto v2, Render, Keep; every other flat_panel drawing shows "v2 available · Rebase" |
| one `1319 ±0.2` callout · This callout | "measure this one from the top edge" | `override_dimension { at, kind: pos_y, from: max }` | Patch (1); the box amber; after Render the row reads `pos_y_top 991` and the strip says "1 removed · 1 added · geometry changed (datum)" |
| marquee over the right y-stack (15 rows) · This callout | "these from the top" | eight `override_dimension … pos_y, from: max` (one per hole), **Stays as is**: "c/c 96 and CTQ carry a relation, no datum", **Question**: none | eight amber boxes; Render; eight rows move to `pos_y_top` |

## 5 Promote — a template change is a new version, proved on one drawing first

Under *Template* scope, Apply calls a new portal-api action instead of
`applyDrawingSpecOps`:

```
promoteDrawingSpecOps { drawing_id, turn_id?, ops, parent_seq, note }
```

| step | what happens | why |
|---|---|---|
| 1 | the ops are validated (`validateOps`) and split by `OP_LEVEL`: template-level ops → the body; the rest → this drawing's patch as usual | one validator, one grammar |
| 2 | `promoteTemplate(body, ops)` (pure, in `drawing-spec-core.mjs`) applies the template-level ops to the **template body's own keys** — `tolerances`, `datums`, `plan`, `edge_names`, `edge_band`, `features`, `pairs`, `ctq` — by the same key-level merge `apply_patch` does for them in drawset; never `overrides`, never `views`/`sheets` (those are derived per part) | this is not "materialising an effective spec" (DYNAMIC_DRAWINGS §3.3): the result is a template body, itself an input, and drawset still derives everything from it. The merge is a dict update, not `feature_rule` |
| 3 | a new row in `drawing_spec_versions`: same name, `version = max + 1`, `origin = portal`, `author_user_id`, `parent_version_id`, `promoted_from_drawing_id`, `note`; `drawing_render_specs.current_version_id` → the new row | immutable history; the catalogue points at what is current |
| 4 | a `carry` patch row for **this drawing** on the new base: the accepted patch minus the keys the promotion now carries in the body (so nothing is said twice), plus the non-template ops of this turn | the change is proved where it was asked for, with a Render and a Keep, before any other drawing sees it |
| 5 | audit `drawing_template_promoted { name, from_version, to_version, ops }`; the turn row gets `accepted = true, scope = template` | |

Returns `{ version, seq }`; the rail then reads "Template flat_panel v2 (was v1,
promoted from this drawing) · Patch #7 (carry)" and Render is enabled as after
any proposed step. Nothing on `drawing_revisions` changes until Keep, as
always (§3.7 of the main design).

**The other drawings.** A new version never moves a drawing by itself
(DYNAMIC_DRAWINGS §3.2). Each flat_panel drawing shows "v2 available · Rebase"
(Phase 6) and rebases one at a time, each rebase a candidate with a diff and a
Keep. Why not a batch: every rebase is a verified, release-facing change to a
document a supplier may already hold; fifty Keeps in one click is fifty
unread diffs. The rail's Drawings register gains a count ("flat_panel: 3 on
v2, 48 on v1") so the backlog is visible; a batch action is §9 decision 2,
recommended **later**, and only ever over drafts.

**The file on the Mac.** `specs/flat_panel.yaml` stops being the source and
becomes a **mirror**. The poll answer carries `templates: [{ name, version,
body_sha256 }]`; when the worker sees a current version whose sha is not the
file's canonical sha it writes the body to the file (`dump_yaml`, the
previous file kept as `.bak`) and logs "flat_panel.yaml ← v2 (portal)". A
hand edit on the Mac still registers at worker start as a new version
(`origin = mac`) and becomes current, so both editors write into one linear
history and neither overwrites the other silently: the rail's drift flag and
the version list show who did what. Why a mirror and not two sources: a
template body must have one current value; the portal already has history,
tenancy and audit for it, the file does not (DECISIONS 2026-11-26, "Spec truth
lives in the portal").

What Promote refuses: a legacy `part_spec` (migrate first); an op whose
ceiling is below template (stays on the drawing, said on the line); a body
that would make `validateOps` reject the drawing's remaining patch (409 with
the reason); a drawing whose current issue is not a draft (render the next
letter first, as for any edit).

## 6 The prompt row — contract

Under the selection chips in the Dimensions section (DRAWINGS_TAB_UX §13.8),
Rushroom only, draft issues only. DRAWINGS_TAB_UX rules hold: labels outside
boxes, one row, no explanatory sentences, amber for warnings only.

| element | contract |
|---|---|
| **Scope** | segmented: This callout · This drawing · Template flat_panel v1 (§3). Disabled states carry the reason as a title, never a sentence on the page |
| **Prompt** | one input, placeholder **Ask…**, ≤ 2000 chars, Enter or **Send** |
| Send | posts `proposeDrawingSpecOps { drawing_id, prompt, scope, selection: { sheet?, entities[], region_model? }, parent_seq }`; the row disables while the call runs; the job panel is not involved (no render yet) |
| **The card** | three lists, as designed: **Operations** (one line each in the Patch (n) wording, reason in grey, a checkbox per line, the level badge *callout / drawing / template* on the right), **Stays code** (amber; file and function), **Questions**. Under Template scope a line below its ceiling reads "stays on this drawing" in grey |
| **Apply** | checked ops → `applyDrawingSpecOps` (callout / drawing scope) or `promoteDrawingSpecOps` (template scope) with `turn_id`; touched rows and boxes turn amber; Patch (n) gains the lines; Render as today |
| **Discard** | `discardDrawingSpecTurn { turn_id }`; the card closes; the turn stays in history as declined |
| **History** | the Spec section's history list already shows patch steps by origin; turns show as "#8 · prompt · 2 ops · template" with the prompt text on hover |
| Memory | none beyond what is on screen; the patch rows and turns are the memory (unchanged) |

Vocabulary added (DRAWINGS_TAB_UX §13.7): **Scope**, **This callout**, **This
drawing**, **Template**, **Promote** (the Apply under Template scope reads
**Promote to flat_panel v2**), **stays on this drawing**, **from the top
edge / from the bottom edge** (the Patch line wording for `from`: "pos_y from
top edge on Ø5 at (41, 1319)"), **sheets from the bottom / from the top**.

## 7 Contract changes by component

| component | change |
|---|---|
| drawset.py | `plan` key; `derive_template(spec, part, patch_datums, patch_plan)` honours `face_order`; `override_for` consulted for `pos_x` / `pos_y` with `from` in `ydims` and the x-row loop; new kind `pos_x_far`; a `from` override on a pair member or CTQ end reported via `override_inapplicable`; `--patch` tests for both; the Issue B oracle a38c2186 unchanged (no `from`, no `plan` → identical rows) |
| flat_panel.yaml | `plan: { face_order: top_down }` |
| `_shared/drawing-spec-core.mjs` | `set_sheet_plan`; `remove_tolerance` (level drawing; the × on a kind-tolerance line with no accepted value, and Revert, need it — found in the live proof); `override_dimension` kinds `pos_x`, `pos_y` with required `from` and refused `tol`/`name`; `OP_LEVEL`; `TEMPLATE_KEYS`; `promoteTemplate(body, ops)`; `levelOf(op)`; static tests: every op has a level, `promoteTemplate` touches only `TEMPLATE_KEYS`, the AI enum still equals `OPS` |
| migration 0069 | `drawing_spec_versions`: `origin text not null default 'mac'`, `author_user_id uuid`, `parent_version_id uuid`, `promoted_from_drawing_id uuid`, `note text`; `drawing_spec_turns.scope text`; both tables already carry `organization_id` and sit in `TENANT_TABLES` |
| portal-api | `promoteDrawingSpecOps`; `registerDrawingSpecs` keeps "known body → no new row, unknown body → new version `origin = mac`, current"; `pollDrawingRenderJob` answer gains `templates[]`; `getDrawingSpec` returns `template.origin/author/parent`, `plan`, and per-name counts for the rail; `applyDrawingSpecOps` validates `from` ops like any other |
| portal-ai `proposeDrawingSpecOps` | body gains `scope`; the system prompt gains the scope rule ("propose ops; the engineer chose the level; never propose a level"), the two new ops with their worked examples (sheet order; this one from the top; the c/c relation refusal), and the loader adds `plan` and `derived.face_ranges` so the model can state the current order in its reason; refusal category `relation` added for datum asks on c/c / CTQ rows, `scope` for an op that needs a selection |
| worker | reads `templates[]` from the poll, mirrors the current body into `specs/<name>.yaml` when the sha differs (`.bak` kept), logs the write; still interprets nothing in the patch |
| app.js | the prompt row, the scope control, the card, Promote wording, history lines, Patch lines for `from` and `plan`; nothing in the supplier shell |
| docs | DYNAMIC_DRAWINGS §4.2 / §4.4 / §7 Phase 5 / §10 point here; DRAWINGS_TAB_UX §13.9 holds the UI contract; DECISIONS gets "The engineer chooses the scope; a template change is a promoted version proved on one drawing first; the Mac file is a mirror" |

Deploy order for the phase: `supabase db push` → `supabase functions deploy
portal-ai --no-verify-jwt` → `supabase functions deploy portal-api
--no-verify-jwt` → `git push origin main` → restart the worker (it must learn
`templates[]`) → commit drawset in fusion_scripts.

## 8 Proofs for Phase 5 (replacing the five in DYNAMIC_DRAWINGS §7)

On Side Panel Left migrated to `flat_panel` + patch (decision 5 says at its
next issue; the proof case is that issue):

1. two Ø8 depth entities marked, *This callout*, "tighten depth on these to
   +0.3/−0" → two `override_dimension`, Apply, Render, strip "2 tolerances
   changed".
2. nothing marked, *This drawing*, "general tolerance ISO 2768-f" →
   `set_tolerance general`.
3. "move the c/c text clear of the CTQ" → refusal `needs_code`, drawset.py
   `face_sheet`.
4. "change the 37 to 38" → refusal `not_in_step`.
5. marquee over two Ø5 classes, "tighten these" → a question, no ops.
6. nothing marked, *This drawing*, "start the face sheets from the bottom" →
   `set_sheet_plan bottom_up`; Render; sheet 2 is the 0–280 band; geometry
   same; Keep.
7. the `1319 ±0.2` callout, *This callout*, "measure this from the top" →
   `override_dimension pos_y from max`; Render; the row is `pos_y_top 991`;
   strip "1 removed · 1 added · geometry changed"; the PDF shows the dimension
   from the top edge; Keep.
8. the right y-stack marquee, "these from the top" → eight ops and one
   `relation` refusal naming c/c 96 and CTQ.
9. nothing marked, *Template flat_panel v1*, "we always start sheets from the
   bottom" → Promote: `drawing_spec_versions` has v2 `origin = portal`,
   `current_version_id` = v2, this drawing on a `carry` row, Render, Keep;
   Right Side Panel's rail reads "v2 available · Rebase"; the worker log reads
   "flat_panel.yaml ← v2 (portal)" and the file on the Mac carries
   `plan.face_order: bottom_up`.
10. the same under *This callout* with nothing marked → refusal `scope`.
11. a hand edit to flat_panel.yaml on the Mac, worker restart → v3 `origin =
    mac`, current; the drawing kept on v2 shows drift; Rebase is offered.

Each AI turn has an `ai_usage_events` row; no cost figure is claimed.

## 9 Decisions for the user — all seven decided as recommended, 2026-11-27 (DECISIONS.md)

1. **The Mac file as a mirror** (the worker overwrites `specs/<name>.yaml`
   from the portal's current version) or the Mac stays authoritative and
   Promote only proposes a version the Mac must register? *Recommendation:*
   mirror — one current value, history in the portal, `.bak` on disk, hand
   edits still register (§5).
2. **Batch rebase after a promotion** (all drafts on the old version → one
   queued candidate each) or one at a time as Phase 6 designs? *Recommendation:*
   one at a time with the count visible; batch over drafts only, later, if the
   count hurts.
3. **`from` on `pos_x` in v1** or `pos_y` only (the ask names the top edge)?
   *Recommendation:* both; the x-row change is one extra end in `dimh`, and
   "from the rear edge" is the same ask turned ninety degrees.
4. **Default scope with a selection** — *This callout* (recommended; the
   selection is the subject) or *This drawing*?
5. **Where the row sits** — under the selection chips in the Dimensions
   section (recommended; the chips are its subject and the card's amber
   lands on the table and the sheet beside it) or its own section above
   Patch (n)?
6. **Template scope from a legacy `part_spec` drawing** — disabled with
   "migrate first" (recommended; decision 5 already says migrate at the next
   issue, and a promotion from a legacy spec has no template to land in) or
   allowed by promoting into the legacy spec's own version line?
7. **Who may promote** — any Rushroom user, as Keep and Release today
   (recommended until roles exist, decision 10), or the designer only?

## 10 Risks

| risk | held by |
|---|---|
| A promotion lands a house rule nobody wanted on fifty drawings | it lands on none: each drawing rebases by hand with a diff; the promoting drawing proves it first with Render and Keep |
| The Mac file and the portal disagree | the file is a mirror written on every poll where the sha differs; a hand edit registers as a new version; the version list names the origin of each |
| `from` on a hole that a pair or CTQ already relates | reported with the unmatched overrides, never applied; the card says so before Apply |
| `pos_x_far` / `pos_y_top` make the compare strip say "geometry changed" for a datum move | true and stated: the strip's amber line reads "datum moved" when every changed row is a `pos_*` kind swap at the same address (a `diffDimensionLists` classification, no new data) |
| The model proposes a level | it cannot: the schema has no level field; `OP_LEVEL` and the chosen scope decide |
| Scope creep: `plan` grows into a layout language | `plan` admits only derivation rules drawset already has a branch for (`face_order` now; `face_scale`, `overview_orient` are the two candidates); a new rule is a drawset change plus a `SPEC_VOCAB` change plus the static test, as for every op |
