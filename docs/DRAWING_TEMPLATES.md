# Drawing templates — a shared base, a rule set per part type, and a sandbox where rules are tried before they become a version

**DESIGN — model changed and decided 2026-11-28. Phase 1 (types, the page, the reference render)
is built and live (0070, v476). Phase 2 (rules he can see: sandboxes, rules by hand and by mark,
the catch as rings and counts) is built 2026-11-28 (0071, v477); phases 3-9 are not built.** It
replaces the design of 2026-11-27 (one template, `flat_panel`, with one datum per panel). What
survives from that design is carried over; what the new model ends is deleted and named in §14
and §15. The owner answered the eight questions on 2026-11-28, all as recommended (§14). What was
checked in the code, and where, is in the appendix. Every hole count below is read from the Rev B
STEP (Postęp's geometry, what all CAD models in production are on), not from Rev F.

**As built in phase 2, where it differs from the text below.** The vocabulary is
`_shared/template-rules-core.mjs`; the one evaluator is `fusion_scripts/catch.py`. (1) "Drilled
in" has one more value, **"in a face"** (any hole in a face, whichever way it opens): without it
§3.7 rule 5 also took the two Ø2 in the rear edge; with it the seed rules give exactly the table's
counts on Left Rev B (8, 9, 9, 4, 3, 1, 2, base default 19), pinned in `proofs/run_catch.py`.
(2) The feature cache is keyed by a features format number, not the engine version, so an engine
commit does not empty it. (3) Only holes are selected; grooves, pockets and the CTQ relation
(rules 8 and 9) wait. (4) An edge hole is ringed and marked at its mouth on the face view, not on
its callout or edge view. (5) A type has no saved version until phase 6, so the saved view shows
no rules and the Takes column has no `old → new`. (6) Compare, Render, Decide, Bring up and Ask
are phases 5-7.

Short names used below: DD = DYNAMIC_DRAWINGS.md, DLG = DRAWING_DIALOGUE.md, UX =
DRAWINGS_TAB_UX.md. "The engine" is drawset.py with the worker on the Mac.

## 1 What was asked

On 2026-11-27 the owner approved a page of its own for the drawing template: rules in plain
words, a change previewed across real drawings before it is saved, history, who is on what. On
2026-11-28 he changed what a template is. His words:

> "datums can be different on the same panel, for example, some holes must be measured from the
> bottom edge. but som can be c/c or shall be c/c."

> "I think that it has to be like this; per type (shelf/side panel/door/plint/back panel/bottom/
> top/etc) the user can add/edit/delete measuring rules (datum/tolerances etc). mark call outs on
> a drawings dummy that represents that type and describe specifics. it is not one for all, and
> rules for parts are different due to tolerance chain effects. it has to be dynamic."

Four questions were put to him, and he answered:

| # | question | answer |
|---|---|---|
| 1 | A shared base under the types, or each type fully separate? | "Shared base for sure." |
| 2 | What is the dummy? | "The user can pick from all the parts CAD which shall represent that specific dummy." |
| 3 | Variants within a type (door S/M/L, left and right side panel) are one type with one rule set, the rules described relative to edges so they hold across sizes and mirror images? | "Yes." |
| 4 | (his addition) | "I still want the sandbox where you can test and play around and finally decide on a template per part." |

**The reading of answer 4, stated as an assumption.** The sandbox is a free workspace for one
part type's rule set: rules are tried on the reference CAD and on other parts, nothing real is
touched, and when he is satisfied he decides, and the sandbox becomes the type's next template
version. "Per part" is read as **per part type**; what is special to one part stays an override
on that part's drawing. The words also fit a second reading (in the sandbox one part is tried
against rule sets and he decides which type that part gets, or a single part carries a rule set
of its own). The design supports the first half of that reading anyway (§4.4, "Try on"); the
second half is Open decision 1.

**The reading of answer 2, stated as an assumption.** "From all the parts CAD" is built as: any
part with a released CAD revision that has no type or is of this type; picking an untyped part
gives it the type. Two narrowings he did not state: a draft revision cannot be the reference
(its STEP is replaced in place when Fusion sends it again), and a part of another type is refused
(§4.7). Either can be lifted if he says so.

**The principle from 2026-11-27 stands:** a template version does not exist until its effect has
been rendered on what it governs. So do the standing rules: versions are immutable and never
deleted, a new version never moves a drawing, a released issue is frozen, release shows facts and
never blocks, the level of a change is never inferred by the model.

## 2 The model

### 2.1 Why per type, in tolerance-chain terms

A hole's datum is right when it is the surface the mating part really locates on. Each part type
has different fitting interfaces, so the same hole class needs different rules on different
types, and different groups on one panel need different datums. The side panel's own geometry
shows it (Side Panel Left Rev B, 580 × 2310 × 18, read from the STEP by the engine's own
classify, 2026-11-28). A datum is named per direction, because that is his point:

| group on the side panel | mates with | across from | up from | centre to centre |
|---|---|---|---|---|
| Ø5 pairs 37 from the front edge, 32 apart (8 holes) | a fitting with two pins | front edge | bottom edge, the lower hole | the fitting fixes 32 |
| Ø5 single holes 41 from the front edge (9) and 91 from the rear edge (9) | shelf supports | front edge; the rear column from the **rear edge** (proposed; today from the front) | bottom edge, each hole from the datum, so no error adds up | none |
| holes within 60 of the top edge (2 of the shelf-support holes, 1 buried Ø2) | top panel | as their column | **top edge** (decided 2026-11-25, `y_from_top_within`) | none |
| Ø8 column 11 from the rear edge, 96 apart (4) | back panel | **rear edge** (proposed; today 569 from the front, which puts the outline tolerance +0 / −0.5 into the chain) | bottom edge | the back panel fixes 96 |

On a door the same logic by hole class is wrong: the cups locate from the hinge edge, and the
Ø10 screw holes sit ±26 about each cup, from no edge at all. One rule set for all flat panels,
with one datum per panel, cannot say either. That is why decision 10 of 2026-11-27 is gone.

### 2.2 The objects

| object | what it is | rule |
|---|---|---|
| **Base** | the shared rule set: title block, general tolerance, kind tolerances, sheet plan, standard hole names and tolerances, house rules | today's `flat_panel`, kept under that key with its versions (v3 stays v3); shown as "Base" |
| **Part type** | shelf, side panel, door, plinth, back panel, bottom, top … | a managed list in the register; a part has at most one; a drawing follows its part's type |
| **Rule** | one measuring rule = **which features** (a selector) + **how they are measured** (datum per direction, c/c, tolerances, name) | never uses a model coordinate, a hole id or a paper side; has a stable id, a name and free text for the specifics |
| **Edges** | how the type's edge words (front, rear, hinge edge, inside face) are found on a part | owned by the type; found per part; not found = a failed row, never a guess |
| **Reference** | the part whose CAD represents the type on the page | picked from any part with a released CAD revision; pinned to the revision and the STEP bytes; not part of a version |
| **Sandbox** | a working copy of one rule set (Base or one type), with its rules, marks, renders and tried parts | several per rule set, each named; touches no drawing; ends in Decide or Discard |
| **Version** | a saved, proved rule set. A type version = **the Base version it was proved on + the type's own body** | immutable; one row, so every existing pin still holds one id |
| **Drawing override** | what one drawing sets for itself (the patch, as today) | stays on the drawing; tied to one CAD revision |
| **Item** | one row of a preview or a bulk rebase: the stored effect, and the queue | as designed 2026-11-27 |

A drawing is still `f(CAD revision, immutable template version, per-drawing patch)`. What changed
is what "template version" means.

**Precedence.** Drawing override > type rule > Base rule. A type rule with the same id as a Base
rule replaces it; a type may switch a Base rule off. Between two rules of one level that take the
same hole and set the same property, see §3.6 and Open decision 7.

**Tolerance lines.** A type may override each of the Base's tolerance lines (outline, hole
position, the depths, groove width and depth); the type page shows every line as `from Base` or
`overridden`, like rules. Why from the first build: shelf length, door size and a back panel's
size in its groove are the chain items that differ per type, and composing them is one merge.

**Why a type version pins its Base version** and does not float on "the current Base": a released
issue must be reproducible from its pin; every pin column (issue, job, patch) holds one version
id today, and a float would need a second column everywhere; and "who is on what" stays one line
per drawing. The type's body is stored as its own rules, not flattened: the engine composes Base
+ type + patch, because DD §3.3 forbids an "effective spec" built in the portal.

**Why the sandbox is the change object of 2026-11-27 before it is put forward**, and not a second
object: it already needs everything the change had (the version it started from, the operations,
the content built by the server, who). Two objects would need a copy step, and what is saved must
be what was tried. Its states: Sandbox → Put forward → Saved | Discarded. Several sandboxes may
exist on one rule set, because playing means comparing alternatives ("all from the bottom"
against "pins as a c/c chain"); **one** is put forward at a time, so Save never needs a merge.

**Why the server builds the content and never accepts it from the browser** (unchanged): what is
approved must be what was analysed. The saved version is rebuilt by the server from the
operations that were previewed and compared by fingerprint.

**Vocabulary.** A template has **versions** (v1, v2 …), the stated exception to STATUS_MODEL §3.
On screen: Base, Part type, Rule, Takes (the holes a rule catches), Reference, Sandbox, Version.
"Part type" is not Category (a list filter, required for every part including screws) and not
Component type (the node's role in the BOM).

## 3 Rules

### 3.1 Edges: what "rear" means on a part

Today the engine calls the model's zero edge "front" and nothing checks it; it sets x and y to
the zero edges and the inside face to the side most blind holes open on, for every part
(drawset.py:1024-1034). A rule that says "rear edge" is only as good as that guess. So each type
says how its edge words are found, from a closed set of tests:

| test | reads as | use |
|---|---|---|
| as modelled | "front edge · as modelled" | the CAD convention is asserted; today's behaviour and the Base default |
| nearest a hole class | "hinge edge · nearest the Ø35 holes" | doors, both hands |
| has the groove | "rear edge · the edge with the groove" | panels with a back-panel groove |
| the face a class opens on | "inside face · where the Ø35 holes open" | doors; panels drilled from both faces |
| most blind holes | "inside face · most blind holes" | today's derivation, the default; fails unless one face has at least twice the other's count |

**The tests run on the STEP's raw features** (each hole with the face it opens on), before the
engine classifies anything and before any face is assumed. Why: today's count is taken after
classify has assumed a face and folded the second hole of every two-sided pair away. Measured on
Side Panel Shared: the count reads 36 / 0, while the STEP has 40 holes opening on one face and 38
on the other. Today that part gets "max" with no warning; under this design it FAILS with "cannot
tell the inside face: 40 / 38", and a panel drilled from both faces needs a type whose inside
face is found by another test (§3.7).

The result per part is exactly what the engine already works with (a datum side per axis, an
inside face, edge names), so everything downstream is unchanged. This is what makes Side Panel
Left and Right one type: they are mirror images through the thickness with the inside face on
opposite sides, and the face is found per part, not fixed. A tie or a failed test is a FAIL row
in words ("cannot tell the rear edge: no groove"). Why never a default: measured 2026-11-27, a
panel drawn from the wrong face keeps its row and sheet counts and reads PASS; only the wall
flags rise (6 → 41). A silent guess would release that drawing.

Edge band and edge names are keyed by edge word ("front edge · EB 1.2 R1"), so they survive
mirroring too. Not covered: a part modelled turned 90° in plane; the type states which way is up
and the render fails if the CAD breaks it.

### 3.2 Which features: the selector

A selector is a list of terms, all of which must hold. There is no "or": a rule that needs it is
two rules. Each term is something true of the same hole on every part of the type.

| term | reads as | engine source |
|---|---|---|
| diameter | "Ø8" | hole diameter |
| drilled in | "in the inside face" / "in the outside face" / "from both faces" / "through" / "opening on neither face" (a cross-bore) / "into the bottom edge" | the face the hole opens on, through, and counterbores, read after two-sided holes are merged, through the edges of §3.1. **Not the engine's `face` field**: it labels every hole that opens on neither face, and every through hole with a counterbore on each face, "outside" (measured: the buried Ø2 on Left Rev B; the four Ø8 back-panel holes on Shared) |
| through or blind | "through" / "blind" | as classified |
| place from an edge | "37 from the front edge" (a system line) / "within 60 of the top edge" / "between 100 and 400 from the bottom edge" | distance to the named edge |
| column or row | "in the column nearest the rear edge" / "2nd row from the bottom edge" | holes grouped by equal distance, ranked from the named edge among the holes the earlier terms kept |
| spacing | "spaced 32 apart, up" | a neighbour of the same selection at that distance |
| near a class | "within 30 of a Ø35" | centre-to-centre distance in the plane |

"Within 30 of a Ø35" is a distance in the plane. The CTQ's "within 60" is something else, a
difference along one direction, and has its own words (§3.3). Grooves and pockets are selected
by kind and the edge they are in ("the groove in the rear edge") in the first build.

Why "37 from the front edge" and not "the first column": "first column" breaks the day a part
gains a column. **But an exact distance is a system line, and a CAD revision can move it.** It
already happened: between Rev F and Rev B the shelf-support holes moved from 37 to 41 from the
front and from 95 to 91 from the rear. A rule written for the old line then takes nothing, and 18
holes slide to the Base default without a word. So a rule for a system line carries **at least**
(§3.3): the moved line fails by name ("Shelf supports, front: found 0, at least 2") on the first
catch of the new revision.

Why spacing and place together: the old class rule "Ø5 c/c 32" also takes the two-pin fittings
at 59 / 91 up (105 and 457 from the front), which are not the pin pairs of the 37 column. A
column term separates them here. It is not always enough: on Rev F one such fitting sat in the
same column as the rear shelf supports, and only a range up ("more than 100 from the bottom
edge") told them apart.

Left out on purpose: model coordinates (`only_at`), STEP axis letters, hole ids (they follow the
STEP's face order and change between revisions), paper left and right (they flip with the hand).
They stay legal only in a drawing's own overrides. "By function" is not a term: the function is
the rule's name, and the selector must find it by geometry.

### 3.3 How they are measured: the measure

| part | forms | words |
|---|---|---|
| across, up | from a named edge, **or** c/c to a partner: one or the other per direction, never both (§3.6) | "across from the rear edge · up from the bottom edge" |
| through the thickness | from the inside or the outside face | "from the inside face" |
| c/c | **direction** (up; along an edge; through the thickness; across on a face is Open decision 3); pitch, or empty = as modelled; pairs (today), a chain (each hole to the previous: error adds up), or all from the first hole (no adding up); **can be** or **shall be**; about another class | "c/c 32 up, pairs, can be" · "c/c 52 about the cup, shall be" |
| grooves, pockets | offset through the thickness from the inside or the outside face; width ±, depth ±, offset ± | "from the inside face · width +0.2 / −0 · depth +0.3 / −0" |
| tolerances | position ±, c/c ±, diameter, depth | "±0.1" |
| name | the callout's word | "foot bore" |
| at least | how many holes the rule must take on every part of the type; 0 = where present | "at least 2" |
| specifics, mates with | free text | the owner's "describe specifics"; what the group mates with ("Back panel") |

A property a rule does not state is inherited from a rule that also takes the hole, then from the
Base default (across from the front edge, up from the bottom edge, thickness from the inside
face, the Base's kind tolerance).

**Up from the top edge on a long panel.** A panel too long for one sheet is drawn in bands. A
dimension from the bottom edge on an upper band is already drawn to a short stub of the bottom
edge with break lines; nothing like it exists for the top edge, because today only holes within
60 of the top are measured from it. A rule may now say "up from the top edge" for any group, so
the engine gains the same stub for the top edge (§10.3). Until it is built, such a row on a lower
band fails by name; it is never drawn off the sheet.

Two things this fixes that are wrong today. **Thickness positions** are always measured from the
model's zero face, so on the left panel an edge hole is measured from the outer face and on the
right from the inner: the mirror parts disagree. And **c/c rows print no tolerance** on face
sheets. Both change printed numbers or text on existing drawings, correctly and visibly in the
preview.

A relation between two groups (today's CTQ: "the rear Ø8 column to the nearest Ø5, within 60 in
height") is a rule with two selectors, a label and a **named direction**: "within 60 in height"
is the difference up, not a distance in the plane. Why the words differ from the selector's
"within 30 of": on Rev B the CTQ holes are 34 apart in height and 87 apart in the plane; read as
a distance, "within 60" would find no CTQ and both rows would vanish. A datum that is another
feature is available only as "c/c about"; a general "from the cup centre" needs a new kind of
dimension row and is out of the first build (§3.8 says what that costs a door).

### 3.4 "Can be" c/c and "shall be" c/c

**The reading, stated as an assumption.** His words are about how holes are **measured**: some
may be dimensioned c/c, some must be. So the two words say that, and the pitch is a second,
optional thing:

| the rule says | meaning |
|---|---|
| c/c, **can be** | today's behaviour: where two taken holes are the pitch apart they are dimensioned c/c; where not, from the datum; a rule that pairs nothing is listed and nothing fails |
| c/c, **shall be** | every hole the rule takes must be dimensioned c/c to a partner the rule also takes; a hole left without a partner is a finding |
| a pitch value (optional) | in addition, the spacing must equal it. Empty = "as modelled": the drawing prints what the CAD has, which suits a pitch that differs by size or a fitting whose pitch he does not want typed into a rule |

**Shall be** adds these checks to verification:

1. every hole the rule takes has a partner **in the resolved plan** (not "on the sheet": see
   below); a position from the datum no longer satisfies completeness for these holes;
2. with a pitch: taken holes whose spacing is not the pitch are named by place, "c/c 96 not met
   at 811 up from the bottom edge". This is a finding about the CAD, and the row says so;
3. each c/c number equals the distance to its recorded partner;
4. the count rule of §3.5.

**A sheet break must not look like a CAD fault.** Today a pair on a face is dimensioned c/c only
when both holes fall on the same band; when the band boundary (derived from the part's length,
so different on every size) falls between them, the upper hole quietly gets a position from the
datum. Under check 1 that would fail a drawing whose CAD is right. So pairs are decided before
bands, and a band boundary is moved off any pair or chain of a c/c rule (§10.3).

Whether finding 2 fails the drawing or flags it is Open decision 2.

### 3.5 When a rule takes nothing on a part

| case | shown |
|---|---|
| "at least 0" and nothing taken on a part (a plain shelf under an LED-shelf rule) | muted `0`; no finding |
| "at least n" not met | a finding that names the rule: "Back panel fixing: found 0, at least 2"; the row fails |
| a rule that takes nothing on **any** part of the type | flagged on the sandbox; Save then needs the name typed (decision 7a reused) |
| **holes no type rule takes** | they fall to the Base default and are counted per part: `base default 4`, amber; no failure |

Why the last row matters most: it is how a new hole in a new CAD revision becomes visible instead
of quietly getting bottom-edge dimensions. Why amber and not a failure: facts, not gates; a type
must not block a drawing on the day it is created with one rule.

### 3.6 Two rules take the same hole

Each property is resolved on its own: how the hole is located across, how it is located up, each
tolerance, the name. **"How it is located" is one property per direction: from an edge, or c/c
to a partner, never both.** A hole dimensioned c/c and from an edge in the same direction is
double-dimensioned, the chain error the model exists to avoid.

The real case on the side panel: the upper hole of a pair that lies within 60 of the top edge.
"Top fixing" (later in the list) wins the up direction: that hole is measured from the top edge
and leaves its pair; its former partner goes back to the datum. Both rule lines say so ("loses 1
c/c partner to Top fixing"), and the proposal card says it before the rule is added, as for
every overlap: a rule line always says how many holes it loses to which rule. If the
losing rule is "shall be", the lost hole is a finding on the card, before Add, not a surprise at
verification.

Which rule wins when two of one level set the same property is Open decision 7. The design
proposes **the order of the list, the later rule wins**, and not "the more specific selector
wins", because the real seed case defeats specificity: "any hole within 60 of the top edge" is
the least specific rule on a side panel and must still beat "Ø5, 37 from the front edge" for the
hole 13.5 from the top.

### 3.7 Example: Side panel

Seeded from `side_panel_left.yaml` and `side_panel_left.patch.json`, which is in effect the first
side-panel rule set already, stored per drawing. Counts are for Side Panel Left **Rev B** (53
holes), from the engine's classify of the STEP, 2026-11-28. Side Panel Right's Rev B STEP is not
on the Mac yet; its counts are expected equal and the first catch confirms it.

Edges: front edge as modelled · rear edge the opposite · bottom, top as modelled · inside face
most blind holes (Left Rev B: 48 / 0).

| # | rule | takes (Left Rev B) | measured | from today's |
|---|---|---|---|---|
| 1 | Pin pairs, front | Ø5, 37 from the front edge (8) · at least 2 | across from the front edge · up from the bottom edge · c/c 32 up, pairs, can be | `pairs {D:5, cc:32}`, narrowed by place |
| 2 | Shelf supports, front | Ø5, 41 from the front edge (9) · at least 2 | across from the front edge · up from the bottom edge | — (Base default today) |
| 3 | Shelf supports, rear | Ø5, 91 from the rear edge (9) · at least 2 | across from the **rear edge** · up from the bottom edge | — |
| 4 | Back panel fixing | Ø8, 11 from the rear edge (4) · at least 2 | across from the **rear edge** · up from the bottom edge · c/c 96 up, pairs, can be | `pairs {D:8, cc:96}`, narrowed by place |
| 5 | Top fixing | any hole in a face within 60 of the top edge (3: two Ø5 at 12, the buried Ø2 at 1) | up from the top edge | `y_from_top_within: 60` |
| 6 | Adjustment hole | Ø8 within 15 of the front edge and within 20 of the bottom edge (1, at 12 / 15) | diameter +0.05 / −0 | `only_at [[11,16]]`, which matches nothing on Rev B |
| 7 | Foot bore | Ø12 into the bottom edge (2) | name "foot bore" · depth +1 / −0 | `features {D:12, axis:Y}` |
| 8 | CTQ | the Ø8 of rule 4 to the nearest Ø5 of rule 3, within 60 in height (2) | relation, label CTQ | `ctq` |
| 9 | Back panel groove | the groove in the rear edge (1) | from the inside face · width +0.2 / −0 · depth +0.3 / −0 | the groove section and the two groove tolerances |

Base default on Left Rev B: 19 holes. Edge band: front edge EB 1.2 R1; rear, bottom and top EB
0.8 R0.5. Rule 5 names no face on purpose: the buried Ø2 opens on neither face, and "in the
inside face" would drop it from the top edge it is measured from today.

What the seed leaves for the owner to settle in the sandbox, not in code:

- **Across from the rear edge** in rules 3 and 4 is a proposal; today everything is across from
  the front, so the back-panel holes are dimensioned 569 across a 580 panel. It is exactly the
  choice his sentence (a) is about, and each shows as its own Effect segment in the preview.
- "Can be" in rules 1 and 4 copies today. Whether the 32 pairs and the 96 pairs **shall be** is
  recorded nowhere.
- The 19 holes on the Base default are not named by any rule: the two-pin fittings at 59 / 91 up
  (105 and 457 from the front; today c/c 32 by the class-wide rule, see M6 in §9); four Ø5 at 45
  and 429 from the front; four Ø5 278 from the front, 20 apart; two Ø8 at 52 up; Ø15, Ø15 and
  Ø45 near the top; two Ø2 in the rear edge. They stay amber until he says what they are.
- The shared side panel is drilled from both faces and carries classes the others lack (Ø14,
  Ø20, through holes with a counterbore on each face). It **cannot use this type's "most blind
  holes" test** (§3.1: 40 / 38), so it is a type of its own or this type gets another inside-face
  test; which, is found by trying it in the sandbox.

### 3.8 Example: Door

Seeded from `doors_m.yaml`. Edges: hinge edge nearest the Ø35 holes · inside face where the Ø35
holes open. That makes "Left-Right" and "Middle", and S, M and L, one type.

| # | rule | takes | measured |
|---|---|---|---|
| 1 | Cup | Ø35 in the inside face (4 on Door M) | across from the hinge edge · up from the bottom edge · name "cup" · depth +0.2 / −0 · at least 2 |
| 2 | Cup screw holes | Ø10 within 30 of a Ø35 (8) | c/c 52 about the cup, shall be · across from the hinge edge |

Edge band EB 1.2 R1 on all four edges. "Within 30 of a Ø35" mends a weakness of today's rule,
which takes every Ø10 on the part.

**Rule 2's "across from the hinge edge" copies today and is a compromise.** On a cup hinge the
screw holes are fixed by the hinge relative to the cup centre in both directions: 52 across the
cup, and a small offset from the cup centre. Dimensioning them from the hinge edge puts the
cup's own edge-distance tolerance into a chain the fitting does not have. The first build cannot
say "offset from the cup centre" (§3.3, Out of scope); it belongs with the door sheets.

**Honest limit.** A door's sheets (overview, hinge detail, cup section, variant table) are door
sheet kinds in code; the flat-panel derivation cannot produce them. Door rules can be written and
their catch shown, and door parts can be given the type, from the first phases; a door **drawing**
from a type needs the type to carry its sheet kinds, which is engine work outside the first build
(§12). Until then doors stay on `doors_m`.

### 3.9 From a mark on the reference to a rule

1. **Mark.** A click on a callout or a hole on the reference sheet resolves, through the sheet's
   stored entity list and view frames (`entities.json`, which already carries both), to one hole
   on the reference's STEP. The mark shows as a numbered chip worded by place, never by
   coordinates: "① Ø5 · 105 from the front edge · 59 up". Several marks are examples of one
   group. Holes in an edge are marked on their callout or edge view.
2. **Describe.** The engineer types the specifics in the Ask row and sends. No scope control: on
   this page the scope is the rule set that is open.
3. **Candidates, without AI.** The server describes the marked hole in selector terms and builds
   up to about six selectors from broad to narrow, each with its count on the reference and on
   every part of the type. **This works before any AI exists** (phase 2): a click on a hole
   fills the Takes boxes of the hand row (§4.4) with the narrowest candidate, and the others are
   offered as chips. Only step 4 waits for the Ask phase.
4. **Proposal.** The model (portal-ai, structured output) gets the hole's description, the
   candidates with their counts, the type's current rules, a census over the type's parts and
   the engineer's sentence, and returns one rule. **Guard:** every millimetre figure in the
   proposed selector must equal a value of the marked hole or stand in the engineer's own text;
   anything else is refused by the validator. The model chooses and words; it does not invent
   geometry.
5. **The catch is shown before anything is added.** The card reads the rule in words, "Takes 4 ·
   4 from Base default", and the counts on the other parts ("4 / 4 / 0"); the sheet rings the
   holes it takes. Each selector term on the card is a chip with ×: removing one widens the
   catch and the count and rings follow. **Add** puts the rule in the sandbox.

The same rule can be made by hand in one row (§4.4). AI is never load-bearing: a click and the
prompt produce the same operation through the same validator.

**How the catch is computed.** "Which holes does this rule take on this part" needs the STEP's
features, no views and no drawing. What is cached per STEP (by its bytes and the engine version)
is the **raw** feature list, before edges and classify. Why not the classified holes: classify
takes the inside face and the datum sides as input, so its answer belongs to one type's edges; a
cache of it would hand one type's classification to another's rules, or go stale when a sandbox
changes an edge test. Edges, classify and selectors are then run per evaluation, which is
milliseconds once the features are loaded. Measured on Side Panel Left Rev B: reading the STEP
and its features takes 0.1 s, plus about 1 s to start the engine; downloading the file from the
portal is not measured. The cache is filled when a CAD file is uploaded, so the first page open
does not wait for 51 files.

A catch is one small job on the worker with no render: the rule set, the edges and the cached
features of every part of the type in one call (§5.2, §10.1). **One evaluator, in the engine.** A
second one in the browser would answer faster and would drift from the one that draws; the rule
is the engine's until measurement says the wait hurts (the round trip is not measured yet). The
render reports the catch again per rule; if it ever differs from the catch job's answer the row
reads `catch differs` in amber and Save needs the name typed.

## 4 The page

One rule for every reason on these pages: it lives in `title`, never on screen. Labels sit
outside boxes, forms are single rows, styles are copied from the drawing surface, and every
background action shows a bar (§4.8).

### 4.1 Name and place

Sub-tab **Drawing Templates**, in the order CAD Models · Drawings · Drawing Templates · Surgery
Templates (decision 6). In code nothing new is called `template…` or `tpl…` (the surgery register
owns those names): sub-tab id `drawing_templates`, frontend prefix `dtpl`, actions say
`DrawingTemplate`, tables `drawing_template_*`.

### 4.2 The register

Copied from the Drawings register: count, Refresh, search, sortable heads.

```
[Search            ]  [All 7] [Sandbox 2] [Behind 1] [Per-part specs 4]              [+ Part type]

 Name          Reference              Parts  Drawings  Version         Saved        Behind  Sandbox
 Base          —                      9      2         v3              27/11 · MQ   —       —
 Side panel    Side Panel Left · B    2      2         v1 · Base v3    28/11 · MQ   —       2 · MQ
 Shelf         M Shelf · B            7      0         —               —            —       1 · MQ
 Back panel    Choose                 0      0         —               —            —       —
 No part type                         42     0
```

(Counts are illustrative.) "Version" on a type row names the Base version it was proved on.
"Behind" is by effect (§7). "Choose" opens the reference picker. "No part type" is not a type; it
links to the Parts list filtered to untyped parts with CAD. "Per-part specs" lists
`side_panel_left`, `side_panel_right`, `side_panel_shared` and `doors_m` read-only: the migration
backlog toward the types. `[+ Part type]` opens one row: `Name [      ]  [Create]`. A stale
worker shows the existing amber "No drawing worker". A row opens in place with Back.

### 4.3 The type page

The `.drawing-surface` grid: the reference drawing in the main pane as in the drawing modal, the
rules under it, a 300 px rail.

```
[← Drawing Templates]  Side panel                                              [Sandbox ▾ 2]
┌───────────────────────────────────────────────────────────────┬──────────────────────────┐
│ [Rules] [Parts 2] [Drawings 2] [History 1]                    │ VERSION                  │
│ ┌─ Side Panel Left · Rev B ─────────── sheet 2/3 ◂ ▸ ──────┐  │  Version  v1             │
│ │   (the reference drawing; rings on the holes of the      │  │  Base     v3             │
│ │    selected rule)                                        │  │  Saved    28/11 · MQ     │
│ └──────────────────────────────────────────────────────────┘  │  Proof    2 of 2         │
│ EDGES                                                         │ REFERENCE                │
│  Front edge     as modelled                                   │  Part     Side Panel Left│
│  Inside face    most blind holes                              │  CAD      Rev B          │
│ RULES (9)                                              Takes  │  Rendered 28/11 10:02    │
│  1 Pin pairs,      Ø5, 37 from front edge · at least 2        │ PARTS                    │
│    front           across from front · up from bottom         │  Side Panel Left    B    │
│                    c/c 32 up, pairs, can be               8   │  Side Panel Right   B    │
│  4 Back panel      Ø8, 11 from rear edge · at least 2         │ HISTORY                  │
│    fixing          across from rear · up from bottom          │  v1 · 28/11 · MQ         │
│                    c/c 96 up, pairs, can be               4   │                          │
│  …                                                            │                          │
│ BASE DEFAULT                                             19   │                          │
│ TOLERANCES     Outline +0 / −0.5  from Base  …                │                          │
│ FROM BASE (9)  ▸                                              │                          │
└───────────────────────────────────────────────────────────────┴──────────────────────────┘
```

- A rule is its name, what it takes, how it is measured: words generated by one function in the
  shared core, the same one History and Compare use, so a rule reads the same everywhere.
- Clicking a rule rings its holes on the sheet; clicking a hole lists the rules that take it.
- **Base default** is the count of holes no rule takes (§3.5); clicking it rings them.
- **From Base** is collapsed; open, it lists the Base rules that apply, muted, each marked
  `overridden` or `off` where the type replaces or switches it off, and links to the Base page.
- The saved view is read-only. Rules are edited only in a sandbox.

### 4.4 The sandbox

`[Sandbox ▾]` lists the type's sandboxes with name, who and age, and **New**. Opening one puts
the same page into edit state: an amber header with the sandbox's name, the rules as the working
copy, and Ask and Change on the rail.

```
[← Side panel]  Side panel · Sandbox "pins as pairs"         [Render] [Decide…] [Discard]
┌───────────────────────────────────────────────────────────────┬──────────────────────────┐
│ [Rules] [Try on 2] [Compare]                                  │ Ask                      │
│ ┌─ Side Panel Left · Rev B ──── sheet 3/3 ── not rendered ─┐  │ ① Ø5 · 105 from front ·  │
│ │            ◎ ◎      rings: 4 holes                       │  │   59 up              ×   │
│ │            ①        the mark                             │  │ [these are measured c/c  │
│ └──────────────────────────────────────────────────────────┘  │  not from the bottom   ] │
│ RULES (9)                                              Takes  │                   [Send] │
│  1 Pin pairs, front      …                         8      ✎ × │ ┌ Lower pair ──────────┐ │
│  2 Shelf supports, front …                         9      ✎ × │ │ Ø5 inside face,      │ │
│  …                                                            │ │ within 100 of bottom │ │
│ [+ Rule]                                                      │ │ c/c 32 up, shall be  │ │
│ BASE DEFAULT                                  19 → 15         │ │ Takes 4 · 4 from     │ │
│                                                               │ │ Base default · 4/4   │ │
│                                                               │ │ [Ø5 ×] [inside ×]    │ │
│                                                               │ │ [within 100 bottom ×]│ │
│                                                               │ │ [Add] [Discard]      │ │
│                                                               │ └──────────────────────┘ │
│                                                               │ CHANGE (3)               │
│                                                               │  + Lower pair          × │
│                                                               │  Back panel ±0.2→±0.1  × │
│                                                               │  Top fixing 60 → 40    × │
└───────────────────────────────────────────────────────────────┴──────────────────────────┘
```

**By hand.** ✎ on a rule, or `[+ Rule]`, opens one row under the list, labels above the boxes:

```
 Name          Takes                                  Across from  Up from     c/c           c/c is               Specifics
 [Lower pair ] [Ø5 ▾][within ▾][100][bottom ▾][+]     [front ▾]    [bottom ▾]  [32  ][up ▾]  [shall be ▾]  [+]    [two-pin fitting, the pins fix 32     ]  [Apply] [Cancel]
```

- The leading boxes are fixed. The second `[+]` adds one labelled box at a time from what is
  left of the measure, exactly as the Takes `[+]` adds terms: Position ±, c/c ±, Ø tolerance,
  Depth tolerance, Thickness from, Callout name, At least, Mates with. A rule shows only the
  boxes it uses, so the row stays short for the common case.
- **A click on a hole fills Takes** from the server's candidates (§3.9 step 3); no AI is needed.
- The c/c box may stay empty: "as modelled" (§3.4). "c/c is" offers `—`, `can be`, `shall be`:
  the owner's two words.
- **Specifics** is the last and widest box of the same row: it is his "describe specifics", and
  the sentence the Ask box captures.
- On a narrow pane the row wraps, each label travelling with its box, as the drawing surface's
  form rows do.

Apply adds one operation to Change; it does not save. Rules are dragged to reorder (§3.6). The
EDGES rows and the TOLERANCES lines have the same pencil and a one-row form each; in a type
sandbox a tolerance line's pencil writes the type's override of the Base line (§2.2).

**Tabs.**

- **Rules**: above. The Takes column shows `old → new` in amber where the working copy changes a
  count.
- **Try on**: any parts with CAD, of this type or not. One row per part with the catch per rule
  from the feature cache, and Render per row or for all. A rendered row opens its sheets in the
  pane. This is the play surface across sizes and hands, and where an untyped part is judged
  against a type: its row carries `[Assign Side panel]`.

```
 [+ Part]  [Render all]
 Part               CAD   1   2   3   4   5   6   7   9   Base default   Render
 Side Panel Left    B     8   9   9   4   3   1   2   1   19             PASS · 28/11 10:14
 Side Panel Right   B     8   9   9   4   3   1   2   1   19             —
```

(Left as measured; Right as expected.)

- **Compare**: the existing compare strip, the saved version beside the sandbox on the
  reference, with the differing rows in words under it ("14 positions now from the top edge").

**Buttons.** Render draws the reference with the working copy, with no drawing written (about 12
s: one build). It arrives in phase 5; in phase 2 the catch shows as rings and counts on the
reference as drawn by today's Base. Discard goes through the facts modal ("3 changes · 2
renders"); no `confirm()`.
Decide opens §5.

**What a sandbox render is.** A job with the part, its CAD revision and file, and **no drawing
and no issue**. Why this needs saying: an ordinary render request creates a real, numbered,
supplier-visible drawing when none exists. A sandbox render reaches neither the Drawings
register, a supplier, nor "who is on what". It is an item taken by the pump (§5.2), which ships
with the first reference render in phase 1: the worker takes real renders first, then catches,
previews, and sandbox renders last.

**Life of a sandbox.** It lives until Saved or Discarded; there is no expiry, because expiry
would delete thought. Every Rushroom user sees it, with the starter's name. When its rule set, or
the Base under it, gets a new version, it reads "Behind v2" and offers **Bring up**: its
operations are replayed on the new version. Operations name rules by id, so replay is mechanical;
one whose rule is gone is listed with Drop.

**Is a test part still needed (decision 5 of 2026-11-27)? No.** That sandbox existed to prove the
software on production without touching real drawings, so it needed a part and drawings of its
own. This sandbox exists to work out rules; it needs geometry, not a drawing, and drawing-less
renders on the real CAD give it. What goes with the test part: a TEST part, CAD model and three
drawings visible in three registers, eight guards in existing actions, a delete across twelve
tables, and the one exception to "versions are never deleted". What it costs: one live proof
waits for a real release (§13).

### 4.5 The Base page

The same page without a reference of its own; in a Base sandbox the sheet header has `Shown on
[Side Panel Left ▾]`, listing the types' references.

```
[← Drawing Templates]  Base                                                     [Sandbox ▾]
 [Rules] [Types 3] [Drawings 2] [History 3]
 TITLE BLOCK   Owner VALCYRA AB · Designed by VALCYRA · General tolerance ISO 2768-m
 TOLERANCES    Outline +0 / −0.5 · Hole positions ±0.2 · Depth of holes in the face +0.3 / −0 · …
 SHEETS        Face sheets bottom band first · Views and scales per part
 EDGES         Front edge as modelled · Inside face most blind holes
 RULES (0)     No rules.                                                       Used by
```

The lines are `flat_panel` v3 as stored. The DATUMS group of the earlier design is gone; "from
the top edge within" is now an ordinary rule of a type. Owner and Designed by are shown because
they print on every sheet and are read-only because no operation sets them. Views and scales are
derived per part and only a drawing's patch changes them; two words stop the engineer looking
for them here.

### 4.6 Part type on parts

- **Properties panel**: a row `Part type [Side panel ▾]` under Category, copied from
  `categorySelect`; empty is allowed (fasteners and electronics have no drawing type).
- **Parts list**: a Part type column and chips beside the category chips; bulk through the
  existing selection bar: `3 selected  Part type [Shelf ▾] [Apply]`.
- **Type page, Parts tab**: the members, `[+ Parts]` and × per row.
- **Suggest** on the "No part type" filter proposes a type per part from its name and its
  classified features, unticked until accepted. Why only a proposal: names are unreliable
  (RR-202609-3T39YDLW is "Top Panel M" in one document and wraps "M Shelf" in migration 0038).
- **Every change of type writes a part-history row.** The category action writes none today;
  that gap is not copied, because the type decides what a supplier's drawing says. The history
  table accepts only a closed list of change types and the writer swallows a refused row, so the
  migration adds `part_type_changed` to that list and the action checks that the row was written
  (§10.1).
- **Changing the type of a part with a draft drawing** marks the draft "Type changed" in the
  Template column, with Rebase and Keep. A released issue stays as released; the next issue takes
  the new type's current version. Overrides that name a rule of the old type appear under
  Unmatched with Drop.
- **A part with no type, or a type with no version yet**, is drawn on the Base alone, which is
  exactly today's `flat_panel` drawing. The list and the release modal read "No part type" in
  amber: a fact, not a gate, as every release fact.
- A type is renamed freely (a label; no version, no drawing moves). It is retired, never deleted,
  and only when no part has it: versions are never deleted and released issues cite them. Two
  types are merged by moving the parts; one is split by **Copy as new type**, whose first sandbox
  holds the source's rules.

Why a managed list of its own and not a level under Category, or a fixed list in code: a category
is required for every part and drives chips in three places; a drawing type applies only to drawn
parts. And migration 0027 already gave the reason for a managed list: a new grouping must be a
data operation, not a deploy.

### 4.7 The reference

```
 Reference for Side panel
 [Search part or number     ]  [This type 2] [All with CAD 51]
  Part                 Number        CAD     Size              Part type
  Side Panel Left      RR-2026…      Rev B   580 × 2310 × 18   Side panel
                                                                    [Use] [Cancel]
```

- Any part with a **released** CAD revision. Why released only: a draft revision's STEP is
  replaced in place when Fusion sends it again, so a reference on a draft would change under the
  type without anyone acting. All 51 CAD models are Rev B released, so this costs nothing today.
- Pinned to the revision and to the STEP's fingerprint. Why not "the model's current revision":
  current is the highest letter, drafts included.
- Picking an untyped part gives it the type (a fact line in the modal). A part of another type
  is refused: rules proved on a part they do not apply to prove nothing. Both, and "released
  only", narrow his answer 2 and are stated as an assumption in §1.
- **The reference is the authoring surface, not the master.** The rule is the master. Changing
  the reference writes no version and moves no drawing; it is a line in the type's history.
- **A newer released revision exists:** the rail reads `CAD Rev B · Rev C` with Rev C an amber
  link; Move shows the catch per rule before and after ("Shelf supports, front 9 → 0") and is then
  confirmed. A mark whose hole is gone reads "mark lost"; its rule is unaffected.
- **Deleting the reference's CAD, revision or part is blocked** with the reason "Reference of
  part type Side panel", through the delete dialog's existing blocker. Changing the reference
  part's type is refused until another reference is chosen.
- One reference per type. The need behind a second ("does it hold on Door L?") is answered by
  Try on and by the counts on every card, without a second pin to keep.

### 4.8 Progress

Every background action shows a bar; none is exempt.

| action | bar |
|---|---|
| register load and Refresh; opening a page, a History row, a Proof | `drBusy` on the control, else the pane's `drProgress` |
| Use (reference), Move reference, Render, Render all (Try on) | `drProgress` under the sheet header; aggregate "Rendering 2 of 5" |
| the catch across parts; reading features of a CAD file not yet cached (normally done at upload) | `drProgress` on the Takes column, "Reading 3 of 51" when files are read |
| Ask → Send; Suggest part types | `drBusy` |
| Add, Apply, ×, reorder, New sandbox, Bring up, Discard, Cancel preview | `drBusy` on the button |
| Decide (the preview); Preview the rest | one aggregate `drProgress`, "Rendering 2 of 3" |
| Save, Restore | `drBusy`; the modal stays open until the answer |
| Part type Apply (single and bulk) | `drBusy` |
| Rebase (row); Rebase drafts | `drBusy`, then the render bar; aggregate "Rebasing 2 of 5" |

## 5 Decide: the preview, then Save

### 5.1 What the engineer sees

**Decide…** on a sandbox puts it forward (refused, with the reason in `title`, while it is
Behind or while another sandbox of the same rule set, or of the Base, is put forward). A table
takes the top of the main pane; the rules stay below it.

```
 Side panel · "pins as pairs" → v2 · Base v3           3 of 3 · 3 PASS    [Save v2…] [Back to sandbox]
 ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
 + Lower pair · Back panel fixing ±0.2 → ±0.1 · Top fixing 60 → 40
 [All 3] [Changed 2] [Fail 0] [No drawing 1]
   Part               CAD  Drawing     Issue    On   Dimensions  Effect                                       Verify
 ▶ Side Panel Right   B    …X4VLYLQY   A Draft  v1   233 → 233   Lower pair: 4 now c/c · 4 tolerances          PASS
 ▶ Side Panel Left    B    …9EBYDVSL   A Draft  v1   233 → 233   Lower pair: 4 now c/c · kept by this drawing 1 PASS
 ▶ Side Panel Shared  F    —           —        —    — → 354     base default 22                              PASS
```

(Illustrative rows.)

- **Rows are the type's drawings, and its parts that have no drawing yet.** A drawing is rendered
  twice from the same STEP bytes and its own patch (the version it is on, then the candidate):
  the row is the whole difference. A part without a drawing is rendered once on the candidate:
  it proves the rules draw and verify on that part. Why parts too: at the start most types have
  no drawing, and a preview over drawings alone would prove nothing for a type of seven shelves.
- **Effect is per rule**, in the compare strip's words: "Lower pair: 4 now c/c", "Top fixing: 2
  now up from the top edge", `12 tolerances changed`, `4 moved`, `3 → 4 sheets`, `1 unmatched`.
  New segments: `base default 22`, `takes 0` under an unmet "at least", `c/c 96 not met at 811
  up`, `rear edge not found`, `catch differs`, and **`+35 wall flags`** in amber when the count
  rises. The wall flags stay because they are the only signal that a face or an edge was taken
  from the wrong side: measured, such a drawing keeps its counts and reads PASS.
- **Never "geometry differs".** Both sides come from the same bytes; when the fingerprint moves,
  numbers are measured differently and the row says from where.
- **Kept by this drawing.** Where the drawing's own override sets the same property of the same
  hole, the rule has no effect there, and the row says so with the value. Without it "0 changed"
  reads as a fault.
- The change is listed in words above the table: edge band and names never reach a dimension row.
- A failed render is a row, not an error; the run continues. A drawing that cannot be previewed
  is Skipped with the reason ("CAD file changed since Issue B").
- Above 12 rows the button names the time ("Preview on 51 · 19 min") and checkboxes narrow it to
  a sample. All by default: a row left out reads "not previewed" afterwards (§7).
- Expanding a row shows the current sheets beside the candidate's, the verify lines and the
  changed rows.
- Editing after a preview mutes the rows and disables Save: a preview of other content proves
  nothing. **Back to sandbox** returns to play and keeps the record.

### 5.2 The queue: the poll is the pump

Unchanged from 2026-11-27. A preview inserts one **item** per row, not one job. When the worker's
poll finds no requested job it takes the oldest queued item, claims it with a guarded update,
inserts a job row already claimed, and hands it out. Real renders therefore always go first, no
item times out waiting, and the run continues with the tab closed.

| point | rule | why |
|---|---|---|
| a preview, reference or sandbox job row | carries the item, the part, the CAD revision and file; `drawing_id`, the patch and the replaced issue are always empty; `issue` is empty for a row without a drawing |
| a `features` job row | one CAD file: the worker downloads the STEP, reads its raw features and returns them for the cache | it fits the job table as it is, apart from `issue` |
| a `catch` job row | no single part: the item carries the part list, and the poll answer carries the rule set, the edges and the cached features. The job's part and CAD columns are empty, which the migration allows for this mode only | one call for a whole type; no STEP is downloaded |
| the pump's order | real renders (never items) · `features` and `catch` · `preview` and `rebase` · `reference`, `try` and sandbox renders | a catch is what the engineer is waiting on at the keyboard and takes well under a second; a preview is a batch he left running | three existing paths set a job's patch to failed when the job fails; with the patch on the job a failed preview would fail the real drawing's patch |
| readers that list jobs | the last-10 panel, the New issue modal and the CAD delete count return only jobs without an item | fifty preview jobs would fill the lists and inflate what a delete says it removes |
| readers that take an empty `drawing_id` to mean "the drawing was deleted" | branch on the mode first | a preview job is not an orphan |
| **the STEP is identified by its bytes** | the pump compares the file's fingerprint with the one the issue recorded; different or none → Skipped | a CAD file row can change content in place |

A **rebase** item is different: the pump writes the drawing's `carry` patch and an ordinary
`iterate` job. It is a real render of that drawing and belongs in its history.

### 5.3 The worker contract

Job modes added: `sandbox` (one run, no regression pass; the reference render of phase 1 is this
mode), `features` and `catch` (no render), and `preview` (two runs, or one for a part without a
drawing). The poll answer carries the **Base body, the type body and the patch** separately with
their fingerprints; the engine composes them. For a preview it also carries the bodies the
drawing is on now. **A type body reaches the worker only this way.** The worker's mirror writes a
file on the Mac for every template the portal lists, and its next registration would read that
file back as a Mac spec; so the list the mirror reads returns the Base alone, and the worker
never writes a type body to `specs/`.

`run_preview_job` is a second job shape beside today's four fixed steps, because three things
differ: two engine runs in two folders (the first with a new `--no-regression` flag); **a failed
verify is a result**, so the candidate's files are uploaded whatever the verdict; and finish
echoes the fingerprints of what was rendered. Why the base is rendered again instead of read from
the stored list: the stored one may come from another engine version, and a preview that once
blames the template for an engine change will not be believed again. Cost about 22 s a drawing,
12 s a part without one, serial.

**`sheets_identical`.** The job compares the two runs' sheet images with the title block
rectangle masked and stores the answer per row. "No difference" in M3 and M4, and "nothing to
do" in §7, rest on it together with the dimension list: the list cannot see a dimension line
that moved.

The stored summary per item: `sheets_identical`; the row counts of today's diff plus `moved`;
sheets and row counts
before → after; `geometry_same`; new unmatched rules and overrides; misprints and unlinked rows;
wall flags before → after with the new lines; `shadowed[]` (what the drawing keeps); the verdict;
and new, **per rule**: id, level (base | type | drawing), the holes taken as edge-relative
places, the datum each was measured from, c/c met or broken, and the count of holes on the Base
default. The earlier `datums` and `datum_moved` keys are not built.

### 5.4 Save

Save opens a facts modal in the `releaseModal` pattern. No `confirm()`.

```
┌ Save Side panel v2 ──────────────────────────────────────── [Close] ┐
│ Part type   Side panel v1 → v2 · Base v3                            │
│ Changes     + Lower pair · Back panel fixing ±0.2 → ±0.1            │
│ Previewed   3 of 3 · 2 drawings · 1 part without a drawing          │
│ Verify      3 PASS                                                  │
│ Drafts      2 · v2 available                                        │
│ Released    0                                                       │
│ Request     [pairs near the bottom are c/c, back panel ±0.1     ]   │
│                                                  [Save v2] [Cancel] │
└─────────────────────────────────────────────────────────────────────┘
```

| step | what happens | why |
|---|---|---|
| 1 | the server rebuilds the content from the starting version and the operations; it must equal the previewed fingerprint | what is saved is what was rendered |
| 2 | the rule set's pointer must still be the version the sandbox stands on, and for a type the Base pointer must be the Base it was proved on; else 409 and Preview again | the check today's Promote lacks. It can only be met if nothing else moves the Base: see §5.5, "One way in" |
| 3 | at least one finished row of this content, unless the type has no part with CAD | impact is measured, not reasoned |
| 4 | inserts version max+1 (who, the sandbox, the request, the Base version); moves the pointer; marks the sandbox Saved; records coverage on the version; audit row | history reads from the row |
| 5 | when the sandbox came from a drawing (§8): writes that drawing's `carry`, if it is still a draft with no open iteration | the drawing that asked moves first, with a Render and a Keep |

A Confirm row (type the type's name) appears only when a row fails, when not every row was
previewed, when a rule takes nothing anywhere, or on `catch differs` (decisions 7a and 7b).
Otherwise Save is one click. **After Save no drawing has moved.** Other sandboxes of the rule set
read Behind. Discard removes the sandbox's renders; no version number is consumed; the row stays
as the record that it was tried.

### 5.5 A change to the Base

A Base change is the largest change order in the system: it reaches every drawing. Proposed (Open
decision 6): **one preview across every type, one Save.**

- The preview's rows are grouped by type with a line each ("Side panel · 3 rows · no
  difference"), plus a group **No part type**: every drawing of an untyped part (they are drawn
  on the Base alone, so a Base change hits them most directly; today that is Side Panel Right),
  and the untyped parts with CAD. A sample is **stratified**: at least one row per type, the
  reference first; in No part type every drawing, and a sample of the parts. Save's coverage
  line names the group.
- A type that overrides or switches off a Base rule the change removes is listed before Save
  ("Side panel: 1 override of a removed rule") with Drop.
- Save writes Base vN+1 and, in the same act, the next version of every type with its body
  unchanged, marked "Base v3 → v4" in the type's history.
- A Base sandbox and a type sandbox may not both be put forward: they overlap on every drawing
  of that type, and each preview would be untrue once the other saved.

**One way in.** A type version pins a Base version, and this fan-out is the only way a type
reaches a new Base. Two paths write a Base version today with no preview and no fan-out: a hand
edit of `specs/flat_panel.yaml` on the Mac (the worker registers it as the next version and moves
the pointer) and Promote at Template scope from a drawing. After either, every type would stand
on the old Base and Save step 2 would answer 409 for every type sandbox with no way out. So both
close **in the phase where the first type version can exist** (phase 6): the Mac's `flat_panel`
file becomes read-only for the portal (decision 8, pulled forward for the Base), and Promote at
Template scope answers "change the Base on Drawing Templates" until To sandbox replaces it
(phase 8). The per-part specs stay Mac-owned until they are retired.

Why one act: every pin holds one version id, and a type version names its Base, so nothing
floats; and the Base is the house standard. Its cost is waiting time on a serial worker (51
drawings is about 19 minutes), which is what the sample and decision 7b are for.

## 6 History, compare, Restore

Per rule set, copying `openHistory()`: Version · Base · Origin · By · Saved · Request · Proof ·
Restore, with two radio columns to compare any two.

```
  ○ ● v3 · Base v3 · 30/11 · MQ · 3 of 3 · + Lower pair
  ● ○ v2 · Base v3 · 29/11 · MQ · Base v2 → v3
  ○ ○ v1 · Base v2 · 28/11 · MQ · from side_panel_left                    [Restore v1…]

  Compare v2 → v3
   + Lower pair          Ø5 inside face, within 100 of the bottom edge · c/c 32, shall be
   Back panel fixing     ±0.2 → ±0.1
```

- **Proof** is the saved coverage; a click reopens that preview's rows read-only.
- **Compare** is in words per rule (added, removed, changed, reordered) over every key of the
  body, and never refuses. It is for reading; it is not a list of operations.
- **Restore vN** opens a sandbox holding vN's content **copied as stored**, goes through Decide,
  and saves as the next number, "restored from vN". A restored type version lands on the current
  Base and the modal says so. Undo is Restore of the previous version.

Why a copy and not "the operations back to vN": the operations cannot say everything two versions
differ by (`flat_panel` v1 has no sheet plan, v3 has one, and nothing removes it). Why through the
preview: going back is a mass change like any other. Why a new version: a revert is a new entry,
never a delete. What must change for it (as designed before): the rule "one row per distinct
content" is dropped so two versions may hold the same content; "current = the highest version
number" becomes the stated rule; a Save whose content equals its starting version answers "no
change".

## 7 Who is on what, and bulk rebase

The Drawings tab of a type (and of the Base, across types): chips All · Drafts behind · Released
behind · Not previewed; columns Drawing · Part · Issue · Status · On · Own settings.

**Two questions that today's code answers with one row, and gets both wrong** (fixed in phase
5, before any of this is shown; §12):

| question | answer |
|---|---|
| **On**: which version is this drawing's file made with? | the version pinned on its current issue; for a draft, the base of its accepted patch |
| **Live head**: what does the next change build on? | the newest patch row that is not discarded or failed |

Why split: a `carry` row is only a proposal; counting by the newest row would report a drawing
"On v2" while its PDF is still the v1 render. A draft with a carry not yet kept reads `v1 · v2
pending`.

| current issue | shown | action |
|---|---|---|
| Draft on current | `Side panel v2` | — |
| Draft behind | `v1` · `v2 available` | Rebase (row) · Rebase drafts (toolbar) |
| Draft behind, carry rendered or waiting | `v1` · `v2 pending` | Keep / Discard |
| Draft on the Base alone, its type now has a first version (Side Panel Right after M3) | `Base v3` · `Side panel v1 available` | Rebase |
| Draft whose part changed type | `Type changed` amber | Rebase / Keep |
| Released behind, stored preview says no difference | `v1` muted | nothing to do |
| Released behind, stored preview says it changes | `v1` amber | New issue |
| Behind and not previewed | `v1 · not previewed` muted | Preview the rest |
| no type, on the current Base | `No part type` amber, or the legacy spec's name muted | — |
| no type, Base behind | `Base v3` · `v4 available` | Rebase, as today |

**What Rebase aims at.** Today it looks for the current version of the rule set the drawing is
already on, by name, and answers "nothing to rebase onto" otherwise. M4, M5 and Type changed all
cross from one name to another. The rule becomes: the target is the current version of the
part's type; with no type, or a type with no version, the current Base (§10.2).

**"Behind" is judged by effect, not by number** (decision 2). Re-issuing 51 drawings to suppliers
for a rule that touches 3 is the classic PLM overreaction, and a flag on every drawing after
every Save teaches people to ignore it. The stored row of the latest saved version decides,
provided it was measured from the issue, the patch and the bytes the drawing still has; with no
such row the drawing is **not previewed**, muted, not amber. **Preview the rest** measures those
without a new version. **Rebase drafts (n)** (decision 1) queues one candidate per draft through
the pump, with the strip words and Keep / Discard per row; released issues are never in the list.

## 8 On the drawing surface

| element | after |
|---|---|
| Rail, Spec group | `Part type Side panel →` (a link to the page) · `Version v1 · v2 available  Rebase` · `Base v3` · `Own settings 2` |
| Scope control | `This callout · This drawing · Type Side panel`. No Base scope from a drawing: a Base rule reaches every type, and one drawing is not the place to argue it |
| Card button at Type scope | **To sandbox**. The server turns the callout's hole into a description by place, the model proposes the selector (§3.9), and the rule lands in a sandbox of the type named after this drawing, with the catch on this drawing on the card. Nothing is saved from the drawing |
| meanwhile, and after Save | the drawing's own override stays in force until the type is saved; Save then writes this drawing's carry with the promoted keys stripped, and Render · Keep as today |
| per dimension, the From form | reads which edge a row is measured from and which rule decided it ("Up from bottom · Pin pairs, front · type") **from the render summary**. It can no longer be read from the body: the answer is per hole |
| an unmatched type rule | a link to the rule on the type page |
| Render modal | the Spec select becomes a `Part type` line from the part; an untyped part shows the select and choosing one assigns it; legacy per-part specs stay selectable while they exist |
| Release modal, fact on the template | by the stored effect of §7: amber only when this drawing would change; plus "No part type" and "Type changed" as facts. Never a gate |
| Drawings register | a sortable **Template** column: "Side panel v1", with the states of §7 |

**Hole classes and every other rule: the drawing's own wins** (decision 9, now three levels).
Today the engine appends the drawing's rows after the template's and takes the first match, and
tries rows with a position before general rows whatever their source, so the template beats the
drawing. The order becomes source first (drawing, type, Base), then the rule order of §3.6.
Checked 2026-11-27: none of the 16 patch rows in production carries a hole class, so no drawing
changes when this ships.

**The title block names the versions** (decision 11): "From CAD Rev B · b5dcc866 · Side panel v2
· Base v3"; for an untyped part "· Base v3". Both are printed because a new issue letter may come
from a Base move with no type change, and that line is then the supplier's only explanation.

Suppliers: all page code is gated on the Rushroom shell; a supplier sees only a released PDF, and
a Save alone never changes anything a supplier holds.

## 9 Migration

**What "identical" can mean.** The PDF differs on every run (a timestamp and paths inside it), so
byte-identical PDFs are not a test the engine can pass even against itself. Two things are
compared instead. (1) The fingerprint of the dimension list (`dl`: sheet, feature, kind, value,
text, tolerance, view), which the 32 pinned proof cases use. (2) **The sheet images**, because
`dl` cannot see a dimension line that moved: `proofs/run.py` stores a fingerprint of every
sheet's PNG per case, and a preview compares the two runs' PNGs with the title block rectangle
masked (§5.3). A critic's two runs of `left_revB` gave byte-identical PNGs; confirming that on
all 32 cases is the first act of M0. **Acceptance for every step below: the same `dl`, the same
row count, the same verify result, and the same sheet images outside the title block line**
(which changes by decision 11).

| step | act | acceptance |
|---|---|---|
| M0 engine | the engine composes Base + type + patch through one resolution pass; today's rule forms (hole classes, pairs, CTQ, the top band) are read into the same pass. The `datums` keys every stored `flat_panel` version carries (`x`, `y`, `inside_face: max`, `y_from_top_within: 0`) stay inert, as today | all 32 pins unmoved with an empty type body, no pin rewritten; **every sheet PNG of all 32 cases byte-identical before and after** |
| M1 Base | `flat_panel` **is** the Base: same row, same key, v3 stays v3, shown as "Base" | no write to any version; Side Panel Right's pin untouched; the Mac's copy and the proof specs keep working |
| M2 type | create Side panel; reference Side Panel Left Rev B; assign Left and Right | two part-history rows, nothing else |
| M3 first version | a sandbox on Side panel seeded from Side Panel Right's own patch by `legacyToRules`, **one to one and class-wide**: "Ø5 · c/c 32 up, pairs, can be", "Ø8 · c/c 96 up, pairs, can be", "any hole in a face within 60 of the top edge" (no face term), the CTQ, the foot bore; edge names and band. A legacy row that matches nothing on the part (the `only_at` adjustment hole, if the patch has it) is dropped and listed. The inside face leaves the patch (found per part) | Decide shows Side Panel Right **no difference**: `dl` equal, `sheets_identical`. The migration's acceptance and a live proof at once |
| M4 Right | Rebase Side Panel Right (Issue A, Draft) from `flat_panel` v3 onto Side panel v1, a rebase across names (§7); its patch is stripped of what the type now says | `dl` equal and sheets identical before and after; the letter stays (an iterated draft keeps its letter, STATUS_MODEL §5.2) |
| M5 Left | Side Panel Left leaves `side_panel_left.yaml` for Side panel v1 | **cannot be identical**, see below; Open decision 8 |
| M6 the rules | the nine rules of §3.7 replace the class-wide rules of M3 in a second sandbox. **This cannot be "no difference"**: today's pair rule is class-wide and the new rules are bound to a place | every change is deliberate, shows as its own Effect segment, and is one of the list below; nothing else moves |
| M7 Shared, Doors | the shared side panel waits for its trial in the sandbox; `doors_m` is a two-part set with door sheets and stays on its spec | — |

**Side Panel Left cannot be identical, and the pins already show it.** `left_revB` (the per-part
spec): 233 rows, **4 sheets**. `template_left_revB` (`flat_panel` + the left patch): 233 rows, **3
sheets**, a different `dl`, the same geometry fingerprint. The per-part spec fixes its sheet
bands by hand; the Base derives them. Sheet is inside the fingerprint. Acceptance for M5 is
therefore a new comparison: the two lists equal as sets over feature, kind, value, text and
tolerance, ignoring sheet and view. **Not run yet**; if it does not hold, the difference table is
what the owner reviews.

**What M6 changes on Side Panel Left Rev B, row by row** (the list the preview must show and no
more):

| holes | today | after M6 | unless |
|---|---|---|---|
| the upper holes of the two-pin fittings, 105 and 457 from the front, 91 up | c/c 32 | from the bottom edge (Base default) | he adds a "Lower pair" rule, which is live proof 5 |
| the adjustment hole at 12 / 15 | no diameter tolerance (the legacy row misses it) | +0.05 / −0 | — |
| the rear shelf supports and the back-panel holes | across from the front edge | across from the rear edge | he keeps "front" in rules 3 and 4 |
| edge holes; c/c rows | thickness from the model's zero face; no c/c tolerance | from the inside face; a tolerance (decision Q4 a) | — |

`registerDrawingSpecs` deletes every catalogue row the worker did not list. Rows born in the
portal are exempt from M2 on, or a type loses its pointer within minutes. The Base itself stops
taking versions from the Mac when the first type version can exist (§5.5, "One way in").

## 10 Data model, API, engine

### 10.1 Migrations (0070 onward)

Every new table carries `organization_id NOT NULL`, goes into `TENANT_TABLES`
(`tests/tenant-tables.test.mjs` guards it) and is RLS deny-all.

| table | change | why |
|---|---|---|
| **`part_types`** (new) | id, organization_id, key (immutable, the catalogue name), name, sheet_family (`flat_panel` now; `door` later), reference_component_id, reference_cad_model_revision_id, reference_sha256, retired_at, created_by | the managed list; the reference pin |
| `bom_components` | + `part_type_id`, nullable; delete of a type refused while in use | one type per part |
| `drawing_render_specs` | + `level` (base \| type \| legacy), `part_type_id`, `portal_owned`. Named `level`, not `kind`: the catalogue reader already overwrites `kind` with the version's. The existing `template` flag is kept and derived (true for base and type) | the rule sets; the exemption from the worker's delete |
| `drawing_spec_versions` | + `base_version_id` (a type version's Base), `change_id`, `saved_by_label`, `coverage`, `restored_from_version_id`. Reused as they are: `author_user_id` (who saved), `parent_version_id` (the version it started from), `note` (the request). A type version is `kind` 'template', so the kind CHECK is untouched. The one-row-per-content key becomes a plain index | one pin says type and Base; History's By and Proof; Restore |
| version body | + `rules[]` (id, name, specifics, mates_with, select, measure, at_least; list order counts), `edges{}`, `off[]` (Base rule ids switched off), and in a type `tolerances{}` (its overrides of Base lines); edge band and names keyed by edge word | rules need a stable id for override, "kept by this drawing", History words and per-rule segments |
| **`drawing_template_changes`** (new) | the sandbox: organization_id, rule set, name, started_from_version_id, operations, body, body_sha256, request, origin (page \| drawing \| restore), from_drawing_id, state (sandbox \| put_forward \| saved \| discarded), rev, who; partial unique: one put forward per rule set | `rev` is its 409 guard |
| **`drawing_template_items`** (new, phase 1) | organization_id, purpose (reference \| features \| catch \| try \| preview \| rebase), change or target version, component, CAD revision, file and its sha (all empty for a catch, which carries its part list), drawing and issue (empty for a part without a drawing), patch and its sha, status, job, summary | the queue and the stored effect; issue, patch sha and CAD sha are what "still valid" is judged on |
| **`drawing_template_marks`** (new) | organization_id, change, rule id, STEP sha, hole address, description by place, paper point | where a rule came from |
| **`cad_feature_cache`** (new) | organization_id, CAD file, sha256, engine version, the **raw** features (before edges and classify) | the catch without a render; valid for every type's edges |
| `drawing_render_jobs` | modes + `sandbox`, `features`, `catch`, `preview`; + `template_item_id`; `issue` and `spec` required only for `issue` and `iterate`; component, CAD revision and CAD file may be empty for `catch` only (a CHECK per mode) | drawing-less and part-less jobs |
| `drawing_spec_turns` | + rule set, version, change; the scope CHECK gains `type` and `base` (`template` stays legal for stored turns and reads as Base) | an Ask turn on a page has no drawing |
| `bom_component_history` | the change-type CHECK gains `part_type_changed` | without it the row is refused and nobody sees it |

Not built from the earlier design: `sandbox_of`, `sandbox_component_id`, the sandbox delete
function, `datums.fixed`, `remove_datum`.

### 10.2 Actions

portal-api unless marked; every one begins with the Rushroom tier check and none enters
`SUPPLIER_ACTIONS` (a static test asserts both).

- **Part types:** `listPartTypes`, `createPartType`, `renamePartType`, `retirePartType`,
  `copyPartType`, `setComponentPartType` (one id or a list; writes history),
  `setPartTypeReference`, `previewPartTypeReferenceMove`.
- **Read:** `listDrawingTemplates`, `getDrawingTemplate` (Base and type bodies, the rules in
  words with inherited / overridden / off, the catch on the reference, parts, drawings, versions).
- **Sandbox:** `createDrawingTemplateSandbox`, `renameDrawingTemplateSandbox`,
  `applyDrawingTemplateOps`, `removeDrawingTemplateOp`, `reorderDrawingTemplateRules`,
  `setDrawingTemplateTryParts`, `requestDrawingTemplateSandboxRender`,
  `requestDrawingTemplateCatch` / `getDrawingTemplateCatch`, `bringUpDrawingTemplateSandbox`,
  `discardDrawingTemplateChange`.
- **Decide and after:** `decideDrawingTemplateSandbox`, `returnDrawingTemplateSandbox`,
  `requestDrawingTemplatePreview`, `getDrawingTemplatePreview`, `cancelDrawingTemplatePreview`,
  `saveDrawingTemplateChange` (a type; and the Base with its fan-out),
  `restoreDrawingTemplateVersion`, `rebaseDrawingTemplateDrafts`.
- **portal-ai** (added to `HEAVY_ROUTES`; JSON-schema structured output): `proposeDrawingRule`
  (marks as descriptions, candidates with counts, the type's rules, the census capped at 40
  lines and never sampled, the engineer's words → one rule; `claude-opus-4-8`, the same
  reasoning task as today's proposal); `suggestPartTypes` (classification, so haiku).

Changed actions: `rebaseDrawingSpec` aims at the current version of the part's type, else of the
Base (today: the same catalogue name only), and `patch.base.name` and the drawing's
`render_spec` change with it; `templateList` (what the worker mirrors to the Mac) returns the
Base alone; `requestDrawingRender` takes the template from the part's type;
`promoteDrawingSpecOps` writes no version and routes Type-scope operations to a sandbox;
Apply, Promote, Rebase, `getDrawingSpec` and the AI handler read the **live head** through one
shared helper; `resolveDrawingSpecVersion` and `drawingsPerVersion` answer **On**;
`registerDrawingSpecs` skips portal-owned rows, takes the newest row for a known content and,
from phase 6, makes no `flat_panel` version from the Mac's file;
`pollDrawingRenderJob` is the pump; the expiry, empty-drawing and job-context helpers branch on
the mode; `listDrawingRenderJobs` and the CAD delete count exclude item jobs; the upload and
finish actions accept the new modes, and finish stores the per-rule summary and the feature
cache; `describeDeletion` and `deleteComponent` block a reference; `listDrawings` returns type,
versions and state for the Rushroom tier; `previewRelease` carries the stored effect.

Shared core (`drawing-spec-core.mjs`): the selector terms and `checkRule` (closed sets, bounds,
edge words must exist in the type's edges); `describeRule`; `mergeRuleSets` (replace by id,
`off`); `legacyToRules` (to show and migrate today's forms); operations `add_rule`, `set_rule`,
`remove_rule`, `switch_off_rule`, `reorder_rules`, `set_edges`; `diffTemplateBodies`,
`shadowedBy`, `moved`, `liveHead` as designed before.

**The level `template` goes.** `LEVELS` becomes callout · drawing · type · base. The ten
operations that sit at `template` today stay legal on a drawing (a patch may still carry them);
what changes is where they go when the engineer chooses a wider scope:

| today's operation | on a type | on the Base |
|---|---|---|
| `set_datum`, `set_from_top_rule` | a rule's measure (`add_rule`, `set_rule`) | — |
| `set_inside_face`, `name_edge`, `set_edge_band` | `set_edges` | `set_edges` (the default tests) |
| `set_hole_rule`, `add_pair`, `add_ctq` and their removals | a rule | a rule (the standard hole names) |
| `set_tolerance` | the type's override of a Base line | the line |
| `set_sheet_plan` | — | the plan |

`TEMPLATE_KEYS` loses `datums`. A patch keeps its edge names and band keyed by model side
(`x_min` …), which is safe there because a patch is tied to one CAD revision; the engine finds
the part's edges first and the patch's key then overrides the word on that side.

### 10.3 Engine and worker

1. **One resolution pass** before any sheet is drawn: Base + type + patch → a plan per hole
   (how it is located per direction, c/c partner, tolerances, name, rule id, level). Every place
   that reads the datum reads the plan instead: about 70 lines across the face sheet, the
   side-edge and pocket callouts, the edge view, the section and the groove section. Today's
   rule forms are read into the same plan by an adapter. **This step ships alone and must move
   none of the 32 pins and no sheet image.**
2. **Edges before classify.** The edge tests run on the raw features; the part is then built
   once with the found edges. Named failures. Proof: Shared under "most blind holes" fails with
   "40 / 38".
3. **The selector evaluator**, a features-only run and `--catch`. "Drilled in" is computed from
   the opening, through and counterbore after the merge of two-sided holes, never from `face`.
   Proofs: the buried Ø2 on Left Rev B reads "opening on neither face"; the four back-panel
   holes on Shared read "through".
4. **Image comparison**: a PNG fingerprint per sheet in the proof cases; the masked comparison
   in a preview. It turns layout from "looked at" into a regression.
5. **Per-group edge datum** wherever dimensions are laid out. Rows are merged today per distinct
   distance; the merge keys gain datum and tolerance, or two holes at the same distance under
   different rules would print one tolerance.
6. **The top-edge stub**: on a band that does not contain the top edge, a from-top row is drawn
   to a stub of the top edge with break lines, mirroring the bottom stub (placement, the clipped
   outline, room in the sheet's height). Proof: a from-top hole on a lower band.
7. **Thickness datum** by face name.
8. **c/c**: the direction and the partner carried on each row; pairs decided before bands, and a
   band boundary moved off any pair or chain of a c/c rule; "shall be" verified against the
   plan's partner (§3.4). Proof: a constructed 96 pair that straddles the derived boundary.
9. **Tolerance per rule**, a tolerance on c/c rows, and a new verification: each row's tolerance
   equals what the rules resolve for that hole, computed apart from the layout code. Today a
   printed tolerance is checked against nothing.
10. **Verification mirrors.** Verify recomputes every printed number per kind, independently of
    the layout. Each new row form (from the rear edge, from the top on a lower band, thickness
    from the inside face) needs its own expected value and its own completeness branch.
11. **Relations** read from rules (today's CTQ), with their direction.
12. **Layout guard.** More datums mean more dimension columns and rows than any case today; c/c
    and from-top dimensions share a column, the stack width ignores them, and nothing checks the
    top of the sheet. An overflow check is added, and datum marks (decision Q5 a).
13. **Worker:** the `sandbox`, `features` and `catch` jobs and `--no-regression` (phases 1-2);
    `run_preview_job`, the forwarded counts, the title block line; `proofs/run.py` with Base and
    type bodies supplied. The worker never writes a type body to `specs/`.

**Not in the first build: a c/c across on a face** (two holes side by side at the same height).
The face sheet's rows above the view are all from an edge; a horizontal c/c needs a new row type
there, with its own expected value and completeness (about 1.5 days). Until then `checkRule`
refuses "c/c … across" on face holes with that reason. It is part of Open decision 3.

New per-row fields (rule id, partner, level) stay outside the hashed fields, or every pin moves.
The engine refuses countersunk holes today (cones); a type that has them needs engine work first.

## 11 Permissions

**Any Rushroom user, as today** (decision 4). Every new action begins with the check every
drawing action has now and nothing looks past it. No button on these pages is disabled because
of who is signed in. With the test part gone, the earlier admin-only exception is gone too;
deleting a CAD model or a part stays admin-only where it is today.

| session | inside the tier | what a version it saves records |
|---|---|---|
| a personal account (admin, internal or reviewer) | yes | the user; History shows the name |
| the shared Rushroom password | yes | no person: History shows **shared login** |
| a support session inside a tenant | yes | `support · <the operator's email>` |
| supplier, installer | no | — |

**Suppliers get nothing, enforced in three places:** the server's allow-list (no action of this
design is added), each action's own tier line, and the page code loading only in the Rushroom
shell. A sandbox render makes no drawing, so there is nothing a supplier's lists could reach.
Accepted with decision 4: a version saved through the shared password has no named author, and
two people on it are one "shared login" to the page; the `rev` guard still stops one overwriting
the other.

## 12 Phases

| phase | content | days | he can author rules | what it proves, and what he can use |
|---|---|---|---|---|
| 1 Types and the page | `part_types`, the Part type row, column, chips and bulk with history; the sub-tab and register; the Base page in words; History and compare; the Template column (plain); the reference picker, its pin and its delete block. **For the reference render:** `drawing_template_items`, the pump, the job-shape migration, the mode branches in poll, expiry, upload and finish, the worker's `sandbox` mode; portal-born rows exempt from the worker's delete | 9.5 | no | he assigns types, picks a reference per type, sees each drawn on today's Base, reads the Base's lines and history. Proves a render that touches no register and waits behind real work |
| 2 Rules he can see | engine: edges before classify, "drilled in", the selector evaluator, `--catch`, the raw feature cache filled at upload, the image comparison. Portal: sandboxes, operations and the core (`checkRule`, `describeRule`); the rule row by hand; **marks, place-worded chips and the server's candidates (no AI)**; rings, counts, overlap lines, reorder; Try on as counts; Discard | 14 | **by hand and by mark**; the catch shows as rings and counts on the reference and on every part. The sheet is not yet dimensioned by his rules | his loop on real holes: mark, see what a rule takes on Left and Right, widen, narrow. The selector language is judged weeks before the engine draws from it |
| 3 Engine I | the resolution pass with the adapter; composition and the three-level order | 6 | as phase 2 (no screen) | no pin and no sheet image moves; Left and Right under one type body give the same list apart from face names |
| 4 Engine II | per-group datum; the top-edge stub; thickness datum; c/c direction, pairs before bands, "shall be"; tolerance per rule and its check; the verification mirrors; relations; the layout guard; new proof cases | 14.5 | as phase 2 (no screen) | each new behaviour pinned; a constructed STEP with one hole at 31.5 fails "shall be c/c 32"; two datums on one panel as a sheet |
| 5 The sandbox draws | the two fixes of §7 (On and live head) and the drawing surface's builders extracted; Render with the working copy; Try on renders; Compare; Bring up | 3 | by hand and by mark, **drawn** | **he can play**: the reference and other parts drawn by his rules, nothing real touched |
| 6 Decide and Save | `run_preview_job`; the preview table with the No part type group; the Save modal and its checks; who saved; Restore; the title block line; the Base change across types; **one way in** for the Base (the Mac's `flat_panel` read-only, Promote at Template scope closed; decision 8) | 9 | … and **decided as a version** | a version exists only after its effect was rendered; M1-M4 run here; a hand edit on the Mac makes no Base version |
| 7 Ask | `proposeDrawingRule`, the census, the guard; `suggestPartTypes` | 2 | **by mark and words** | a mark and a sentence become a rule that holds on the other parts |
| 8 On the drawing, effectivity | rail lines, scope Type, To sandbox, the rule behind each row; Rebase across names; behind by effect, not previewed, Preview the rest, Type changed, the release fact, Rebase drafts | 5.5 | … and from a drawing | who is on what, by effect |
| 9 First types | Side panel's rules (M6), Side Panel Left (M5); Shelf, Back panel, Plinth and Top worked out in the sandbox with the owner; the three side-panel specs retired | 3 | | the model on real parts |
| | | **66.5** | | |

The design of 2026-11-27 was 26.5 days. Taken out: decision 10's machinery (3) and the test-part
sandbox (3). Added: about 46, of which the engine is 26.5 (6 of phase 2, then 6 and 14.5). The
earlier figure of 21 engine days left out what the code shows is needed: the top-edge stub
(1.5), pairs before bands (1), edges before classify (1), the verification mirrors (1) and the
image comparison (1). **If the total must hold, these are what can be cut, and what he then
cannot say:** without the top-edge stub (−1.5), "up from the top edge" is refused for holes
below the top band; without pairs before bands (−1), a "shall be" pair that a sheet break splits
is reported as "split by the sheet break" and the rule must be "can be" on long panels.

**Not in the total:** chain and all-from-the-first c/c with a compact "n × 32" text (+3) and c/c
across on a face (+1.5), both Open decision 3; door sheets carried by a type (+4 to 5, rough).
These are estimates from reading the code, not from a trial; the layout items are the least
certain. Phases 3 and 4 have no screen of their own and can run beside phase 2's portal work.

**Why this order** (changed from the first cut, where the first rule could be written on day 38
and a mark did nothing until day 48): what he asked for is the loop "mark a callout on the dummy,
describe, see what it takes". Phase 2 gives exactly that loop, by day 24, on the engine's own
evaluator, before the engine can draw from the rules. What he cannot do until phase 5 is see the
sheet dimensioned by his rules, and until phase 6 make them a version.

Deploy order for each phase: `supabase db push --remote` → `portal-ai` → `portal-cellar` →
`portal-api` (a `_shared/` change redeploys all three) → restart the worker (phases 1-6) →
merge to main with the `?v=` bump.

**Proving on production without a test part: three layers.** (1) The engine, off production:
`proofs/run.py` with Base and type bodies supplied, the 32 pins, the new cases, and a case for
Side Panel Right Rev B (its STEP is not in `step/` yet). (2) Sandbox and preview renders on real
CAD, which write to no drawing. (3) Acts that write (Save, carry, Rebase) first on Side Panel
Right, a draft (Issue A), where M3 and M4 expect "no difference". Whether Side Panel Left's
current issue is a draft was not read; if it is released, proof 13 needs a second draft (the
first drawing of a Shelf, made with supplier visibility off).

## 13 Live proofs

Each counts as verified only when run on production and read on screen; in every proof that
presses a button, its bar (§4.8) must be seen.

1. Drawing Templates lists Base v3 and no types; the Base's lines are `flat_panel` v3 in words;
   no YAML or key name anywhere. History: v1 mac, v2 mac, v3 portal; compare v1 with v3 shows the
   sheet plan as added.
2. Create Side panel; assign Left and Right in bulk: two part-history rows of type "part type
   changed", read in the part's history; a supplier session sees no change and every new action
   answers 403.
3. Choose Side Panel Left as reference: the sheets render; no row appears in Drawings, in the
   last-10 render panel, in any supplier list or in "who is on what". Request a real render
   while it runs: the real one is taken first. As admin, deleting its CAD revision is blocked
   with the type named.
4. (phase 2) In a sandbox on Side panel, enter the rules of §3.7 by hand: Takes reads 8 · 9 · 9
   · 4 · 3 · 1 · 2 and Base default 19 on Left Rev B; a click on a rule rings its holes; Try on
   Side Panel Right gives the same counts. Change rule 2 to "37 from the front edge": it reads
   "found 0, at least 2". Nothing is on the saved type page: no type has a version before M3.
5. (phase 2) Click the hole 105 from the front, 59 up: the chip reads so and the Takes boxes
   fill without AI. A rule "Ø5 within 100 of the bottom edge": the rings sit on the four holes at
   59 / 91 up; removing the place chip widens the catch and the count follows. (Phase 5) Render:
   the sheet shows them c/c. Discard: the version and both drawings untouched, no file left.
6. "Shall be c/c 96" on the rear Ø8 column passes; set to 95 it reads "not met" and names the
   holes by place.
7. Two sandboxes on one type; put one forward; Decide on the second is refused with its reason.
8. **Real work goes first:** start a preview and, while its first row runs, Render a real
   drawing: the render is taken before the second row.
9. **M3:** Decide shows Side Panel Right "no difference" (list and sheet images); Save Side
   panel v1; By reads the name or "shared login"; after the worker's next two registrations
   there is no `side_panel.yaml` in `specs/` and no new catalogue row; no drawing has moved.
10. **M4:** the Template column reads `Base v3 · Side panel v1 available`. Rebase Side Panel
    Right; before Keep it reads `Base v3 · Side panel v1 pending`; Keep; the list is unchanged,
    Issue A keeps its letter, and the title block reads "Side panel v1 · Base v3".
11. The second sandbox reads Behind; Bring up; one operation listed with Drop.
12. Mark a hole, send a sentence: a card with one rule, its counts on both parts, an
    `ai_usage_events` row. Add; Render.
13. Decide and Save v2 with a real change: the type's drafts read `v2 available` in amber;
    Rebase drafts (2): Keep one, Discard the other; the discarded one's next Apply builds on its kept
    patch.
14. Restore v1 → preview → Save: v3 carries v1's content, "restored from v1"; compare v1 with v3
    reads "No differences."
15. Two sessions on one sandbox: B adds an operation; A's Save answers 409, A's rows mute, and
    Preview again works.
16. A Base tolerance in a Base sandbox, put forward: rows grouped by type; **Back to sandbox and
    Discard**. `specs/flat_panel.yaml` on the Mac is not rewritten; History still ends at v3.
17. From a real drawing, scope Type, To sandbox: the rule is in a sandbox named after the
    drawing; the drawing has no new patch row.
18. Change a draft's part to another type: "Type changed"; Rebase and Keep both tried.
19. A sampled Save: the name is asked; Proof reads "2 of 3"; the third row reads `not previewed`
    muted; Preview the rest clears it.
20. (phase 6) hand-edit `specs/flat_panel.yaml`, restart the worker: no new version, and a type
    sandbox still saves. Promote at Template scope from a drawing answers with the page's name.
21. (phase 2) On the shared side panel, Try on under Side panel: the row fails with "cannot tell
    the inside face: 40 / 38".

**Waiting proofs**, recorded and not claimed; until run, what each covers is "built, not
verified":

| # | waits for | proves |
|---|---|---|
| W1 | the first real Base Save | the Mac's copy rewritten once; every type's next version; a real title block |
| W2 | a Mac registration landing under a sandbox that is put forward | Save's pointer check live (a server test covers it meanwhile) |
| W3 | the first real Restore of the Base | the Mac copy converging; two versions with one content |
| W4 | the first preview with a FAIL row | Save with a failure: the name typed, the failure on the version |
| W5 | **the first real release of a typed drawing** | a released issue left behind on an old version: muted when nothing changes, amber and New issue when it does. The test part bought this proof early; without it, it waits |
| W6 | more than 12 rows in one preview | the time on the button; a 19-minute run left unattended |
| W7 | Open decision 8 and M5 | Side Panel Left on the type |

## 14 Decisions

### Decided

| # | decision | when | status |
|---|---|---|---|
| A | A shared Base under every part type | 2026-11-28 | **in force** |
| B | The reference ("dummy") is any part's CAD, picked by the user | 2026-11-28 | **in force**, built as: any part with a released CAD revision that is untyped or of this type; picking assigns the type (the narrowings are an assumption, §1) |
| C | Size variants and mirror images are one type with one rule set; rules are relative to edges | 2026-11-28 | **in force** |
| D | A sandbox to test and play in, ending in a decision | 2026-11-28 | **in force**; per part type (decision Q1, 2026-11-28) |
| E | Measuring rules per group of features: datum, c/c "can be" or "shall be", tolerances | 2026-11-28 | **in force** |
| 1 | Bulk rebase is "Rebase drafts", Keep per row | 2026-11-27 | stands |
| 2 | A Template column in the Drawings list; amber by effect; "not previewed" muted | 2026-11-27 | stands; shows type and version; new value "Type changed" |
| 3 | Restore vN as a new version, through the preview | 2026-11-27 | stands, per rule set |
| 4 | Any Rushroom user may edit; suppliers nothing | 2026-11-27 | stands; the admin-only sandbox delete is moot |
| 5 | A sandbox with its own test drawings on a test part | 2026-11-27 | **replaced** by D: a working copy on real CAD, no drawing, no test part |
| 6 | The sub-tab is "Drawing Templates" | 2026-11-27 | stands |
| 7a, 7b | Save with the name typed when a row fails, or when not all were previewed; recorded | 2026-11-27 | stand; also used when a rule takes nothing anywhere and on `catch differs` |
| 8 | Once the portal owns a template the portal is the only place to change it; built last | 2026-11-27 | stands, **but no longer last**: types are born in the portal (exempt from the worker's delete in phase 1), and the Base closes to the Mac in phase 6, because one hand edit there would strand every type (§5.5) |
| 9 | The drawing's own hole-class rule beats the template's | 2026-11-27 | stands, as three levels: drawing > type > Base |
| 10 | A template fixes one datum side and one inside face per panel | 2026-11-27 | **superseded** by E and C: datums per rule; the inside face found per part |
| 11 | The title block names the template version | 2026-11-27 | stands: type version and Base version |

Settled by the design under the standing rule "facts, not gates", not put as questions: a part
without a type is drawn on the Base alone and says so in amber; holes no rule takes are counted
and shown, never a failure.

### Decided 2026-11-28, second round — all eight as recommended

Answered one by one on 2026-11-28. Each question is kept with its options; the chosen option is
the one marked *Recommended — decided*. Elsewhere in this document "Open decision N" refers to
these.

**1. "Decide on a template per part": per part type, or per part?**
The design reads your sentence as per part type. A single part's specifics stay overrides on its
drawing; a part whose tolerance chain truly differs (the shared side panel may be one) becomes a
type of its own through Copy as new type.
- (a) Per type. *Recommended — decided 2026-11-28.*
- (b) A part may carry a rule set of its own inside a type.
Why (a): you answered yes to "variants are one type with one rule set", and a rule set per part
is what the per-part specs are today, the thing being retired. (b) adds a fourth level to every
"why is this measured from here". The sandbox's Try on already lets you test any part against a
type and assign it from there.

**2. A "shall be" c/c that the CAD breaks.**
A rule says the rear Ø8 holes shall be c/c 96 and the CAD has 95.
- (a) The drawing fails verification and no issue is made, until the CAD or the rule is put
  right. There is no per-drawing waiver in the first build. *Recommended — decided 2026-11-28.*
- (b) The drawing is made with an amber flag.
Why (a): a "shall" that only flags is a "can". The finding is about the CAD and names the holes.
The same answer applies to a "shall be" hole left without a partner. A rule with no pitch typed
("as modelled") can never fail on the spacing, only on a missing partner (§3.4).

**3. Which c/c forms are needed from the start?**
Pairs (today: two holes, the lower from the datum); a chain (each hole to the previous: errors
add up); all from the first hole (no adding up). And the direction: up on a face, along an edge
and through the thickness exist; **across on a face** (two holes side by side) does not.
- (a) Pairs, not across, now; chain and all-from-first (+3 days) and across (+1.5 days) as the
  next slice. *Recommended — decided 2026-11-28.*
- (b) Everything from the start (+4.5 days).
Why (a): every c/c on the two seed types is a vertical pair. This is a tolerance-chain call only
you can make: if shelf-pin rows must be chains, or a fitting with two pins side by side must be
c/c, on day one, choose (b). Until built, such a rule is refused with the reason.

**4. Position tolerance per rule, and a tolerance on c/c.**
On 2026-11 it was decided that position tolerance is one value per kind for the whole drawing.
Your words "tolerances etc" and "tolerance chain effects" imply a tolerance per rule, and face
c/c dimensions print no tolerance at all today.
- (a) Yes: position ± per rule, c/c with its own ±; the Base's value is the default.
  *Recommended — decided 2026-11-28.*
- (b) Keep one position tolerance per drawing; rules set datum and c/c only.
Why (a): a c/c fixed by a fitting and a hole located from an edge 2 m away are not the same
tolerance. It reopens your earlier decision, so it is asked and not assumed.

**5. Two datums on one panel: how the sheet shows it.**
With some holes from the bottom edge and some from the top, dimension lines start at both edges
with nothing marking either.
- (a) A datum triangle with a letter on each edge used, named in the caption. *Recommended — decided 2026-11-28.*
- (b) Wording only, as today.
Why (a): the operator must see which edge a dimension starts from without reading the caption.
You know what Postęp's people expect better than the design does.

**6. When the Base changes, do all types follow at once?**
- (a) One preview across every type, one Save: the Base's next version and every type's next
  version together. *Recommended — decided 2026-11-28.*
- (b) The Base is saved alone; each type shows "Base v4 available" and is moved through its own
  preview.
Why (a): the Base is the house standard; under (b) two types can print different general
tolerances for months and there are seven places to remember. No drawing moves at Save either
way. (a) costs waiting time; a sample is recorded as one.

**7. Two rules of one type take the same hole and set the same thing.**
- (a) The rule list has an order you see and can change; the later rule wins; every overlap is
  shown as a count. *Recommended — decided 2026-11-28.*
- (b) The engine decides by which rule is more specific; an exact tie blocks Save.
Why (a): "any hole within 60 of the top edge" is the least specific rule on a side panel and must
still win for the top fixing holes. An order on screen can be predicted; a computed one cannot.
The brief for this design assumed (b); the side panel's own top-fixing rule is the case against.

**8. Side Panel Left's move to the Side panel type changes its sheets (4 become 3).**
Its per-part spec sets the sheet bands by hand; the Base derives them. The dimensions are
expected to be the same (233 rows both ways); that is to be proved, not yet run.
- (a) Accept once the dimension lists are proved equal ignoring sheet numbers; if its current
  issue is released, it gets a new letter. *Recommended — decided 2026-11-28.*
- (b) Leave Side Panel Left on its own spec.
Why (a): left and right are mirror hands of one design; keeping one outside the type means every
rule is kept twice, which is what types exist to end.

## 15 Risks, amendments, out of scope

| risk | held by |
|---|---|
| a rule proved on the reference takes the wrong holes on a sibling nobody looked at | preview rows are parts as well as drawings; the count per rule in every row and on every card; "at least"; `base default` |
| edge words wrong on one part (modelled the other way round) | edges found per part by the type's test; not found = FAIL; the wall-flag segment for a wrong find that still passes |
| more datums put more columns and rows on a sheet than any case today | the overflow check; sheet images pinned per proof case; the first types' sheets looked at with the owner (phase 9) |
| the cached catch and the render disagree | one evaluator; the cache holds raw features, so it is valid under any edges; `catch differs` on screen; the render wins |
| a CAD revision moves a system line and a rule's holes slide to the Base default | "at least" on every column rule: the rule fails by name on the first catch |
| a "shall be" fails for a layout reason and reads as a CAD fault | pairs before bands; verified against the plan, not the sheet |
| a hand edit of the Base on the Mac strands every type | the Base closes to the Mac in phase 6 (§5.5) |
| the model proposes a selector that fits the reference only | candidates with counts on every part before the model answers; the millimetre guard; counts on the card before Add |
| a Base Save reaches every drawing; preview time grows with the register | stratified sample, Preview the rest, decision 7b recorded |
| one failing type blocks a Base Save | decision 7a: the name typed, recorded |
| a part gets the wrong type | history on every change; "Type changed" on drafts; released issues never move |
| the worker's registration deletes a portal-born rule set's row, or its mirror writes a type to the Mac | exemption ships in phase 1; the mirror's list returns the Base alone |
| sandbox renders delay real work | fixed order: real renders, previews, sandbox |
| many stale sandboxes | the list shows who, age and Behind; Discard is one click |
| a preview delays a real render, marks a real patch failed, or crowds the job lists | items in their own table; item jobs carry no patch and are excluded from the readers (§5.2); one test each |
| the base run uses other STEP bytes than the issue | the fingerprint comparison; Skipped with the reason |
| a stored effect goes out of date | each item records the issue, patch and CAD it was measured on; a mismatch reads "not previewed" |
| the thickness datum and c/c tolerances change print on existing drawings | deliberate; each shows as its own Effect segment (M6); nothing changes until a drawing is rebased |
| doors look like a type but cannot be drawn from rules yet | said on the Door page; doors stay on `doors_m` |
| a hole class named by STEP axis means face on one part and edge on another | gone with selectors: "drilled in" is resolved per part through the edges |
| holes that are neither in a face nor in an edge are not required by verification | unchanged; recorded for the engine backlog |
| a version saved by nobody in particular | accepted with decision 4: By reads "shared login" |
| the Mac's mirror moves proof pins and stamps `-dirty` on a Base Save | unchanged; commit the mirrored file after a Save |

**Amendments to earlier documents.**

| earlier | becomes |
|---|---|
| DD §3.2, DLG §3: one template level, `flat_panel` | Base and part types; the level `template` is replaced by `type` and `base` (the table in §10.2); the drawing's scope control offers Type |
| DD §5.4: one datum per axis per part, the template's value overwritten | a datum per measuring rule; edges and inside face found per part by the type |
| DD §4.3 and §9 decision 3: position tolerance at kind level | per rule, decision Q4 (a) |
| DD §9 decision 5: per-part specs migrate into `flat_panel` + patch | into part types (§9) |
| DD §3.3, the engine's merge: the template's hole class first | drawing, then type, then Base (decision 9) |
| DD §3.2, DLG §7: one row per distinct content | the same content may be two versions (Restore) |
| DLG §5, §6, UX §13.9: Promote saves at once from the drawing | To sandbox; a version exists only at Save after the preview |
| DLG §9.1: a Mac hand edit becomes current | not for the Base from phase 6, nor for any type (decision 8) |
| DLG §9.2: no batch rebase | Rebase drafts (decision 1) |
| UX §2: three sub-tabs | four (decision 6) |
| UX §13.10: `template_drift` amber by number; "on" = the newest patch row | by stored effect; On is the pinned version |
| UX §13.11: an unmatched template pair points to Ask | a link to the rule |
| DD §10, UX §13.5: the rail shows the template body | the rail links to the page |
| STATUS_MODEL §3: "version" reserved for Fusion | exception for template versions |
| this document, 2026-11-27: a census, not a reference-drawing picker | the reference is the subject of the marks; the census stays as what lets the model generalise |
| this document, 2026-11-27, decisions 5 and 10 | replaced and superseded (§14) |
| DD §9.6 (versions have no lifecycle; never deleted), DLG §9.7 (any Rushroom user) | **stand**, now without exception |

**Out of scope:** URL deep links; parallel worker renders; a type hierarchy (the Base is the only
parent; Copy as new type instead); a rule set per part (Open 1); a datum that is another feature
beyond "c/c about", so a door's cup screw holes stay dimensioned from the hinge edge and not
from the cup centre (§3.8); chain, all-from-first and across-on-a-face c/c (Open 3); a
per-drawing waiver of a "shall be" (Open 2); choosing the wall or edge a groove's offset is
measured to (grooves are measured as today, with tolerances per type); door sheets from a type, and
multi-part sets such as Doors M as one drawing; countersunk holes; a part turned 90° in plane;
"upper half" and other places relative to the part's size; a list of rules that share a "mates
with" word across types (the word is stored from the start; the list is about a day, later);
changing Owner and Designed by from the page; a lifecycle on versions; permission levels inside
the Rushroom tier; a second evaluator in the browser.

## Appendix — verified against the code

Checked 2026-11-27 and 2026-11-28; everything else rests on the read-only maps of the same days.
portal-api `index.ts` unless named.

| what | where |
|---|---|
| x and y set to the zero edges and the inside face to the blind-hole majority on every template render, then the patch's datums | drawset.py 1024-1034 |
| the patch's hole classes, pairs and CTQ are appended after the template's; first match wins; rows with a position are tried first | drawset.py 746-806 |
| pairs are disjoint and vertical on face holes; CTQ's "rearmost" is counted from the x datum; the top band is the one group datum today | drawset.py 876-894, 978-1001, 1170-1195 |
| thickness positions are measured from the model's zero face | drawset.py 1485, 1545 |
| face c/c rows register no tolerance; a printed tolerance is not verified | drawset.py 1392-1393, 2592-2599 |
| every sheet's view frames and entity boxes are written to `entities.json` | drawset.py 44-53, 122-127 |
| the hashed fields of a dimension row | drawset.py 655 |
| the left and right side panels differ only in the inside face | `specs/side_panel_left.yaml`, `side_panel_right.yaml` |
| `left_revB` 233 rows, 4 sheets; `template_left_revB` 233 rows, 3 sheets, another `dl`, the same geometry fingerprint; 32 cases | `proofs/cases.json` |
| PDFs differ on every run; the suite proves the dimension list, not the layout | `proofs/README.md` |
| an inside face forced against the part's own: PASS, 189 → 189 rows, 3 → 3 sheets, wall flags 6 → 41 | five renders, 2026-11-27 |
| part categories: a managed list, four seeded; the category action writes no history | 0027; 4863-4877 |
| one CAD model per part; "current" is the highest letter, drafts included; a draft's file is replaced in place | 0059:38; 893-898; 6990-7000 |
| a render request with no drawing creates a supplier-visible one | 8028-8045 |
| job columns: part, CAD revision, file and `issue` required; `drawing_id` may be empty; modes `issue`, `iterate`; one open job per drawing | 0062:35-54, 85-86; 0068:157 |
| the delete dialog's `blocked` mechanism | 7175-7177 |
| `registerDrawingSpecs` deletes rows the worker did not list; the pointer rule | 8526-8546 |
| the newest patch row decides "on" and what the next change builds on | 1510-1579; 8653, 8740, 8809; portal-ai `handlers/drawing-spec.ts` 266-285 |
| `LEVELS`, `OP_LEVEL`, `TEMPLATE_KEYS`; `promoteTemplate` never removes a key | drawing-spec-core 48, 121-131, 597-616 |
| the tier check, the shared-password session, `SUPPLIER_ACTIONS` | 188, 1844-1856, 2283-2297 |
| the claim and run timeouts; the worker's four steps; verify raising; the `-dirty` stamp | render-job-core 40-42; worker.py 85, 713-717, 429-448 |
| `categorySelect`, `drProgress`, `drBusy`, `openHistory`, `releaseModal` | app.js 5743, 14387, 14461, 15738, 15905 |
| Side Panel Left Rev B: 53 holes; Ø5 at 37 from the front 8, at 41 from the front 9, at 91 from the rear 9; Ø8 at 11 from the rear 4; within 60 of the top 3; adjustment hole at 12 / 15; the buried Ø2 opens on neither face and is labelled "outside" | classify run on `step/VALCYRA_RevB_Side_Panel_Left…`, 2026-11-28 |
| Side Panel Shared: 40 holes open on one face and 38 on the other; after classify 36 / 0; the four Ø8 back-panel holes are through with counterbores and labelled "outside" | the same run on the Rev F STEP |
| reading a STEP and its features: 0.1 s, about 1 s to start the engine | timed on Left Rev B, 2026-11-28 |
| a pair is dimensioned c/c on a face only when both holes are on one band; a stub exists for the bottom edge only; rows above the view are from an edge only | drawset.py 1188, 1217-1244, 1201-1214 |
| CTQ's "within" is the height difference | drawset.py 988-1001 |
| Rebase looks up the target by the pinned name | 8804-8807 |
| the Mac's hand edit becomes version max + 1 and current; the mirror writes every listed template | 8504-8533; 1547-1551; worker.py 344-354 |
| the catalogue reader overwrites `kind`; version kind CHECK; `author_user_id`, `parent_version_id`, `note`; turn scope CHECK | 1543-1544; 0068:45; 0069:23-33 |
| the part-history change-type CHECK; the writer swallows a refused row | 0067:6-11; 943-963 |
| a job with no drawing is closed as orphan; upload refuses it; the worker knows two modes | 8196-8203; 8294; worker.py 781 |
| production 2026-11-27: `flat_panel` at v3; Side Panel Right (RR-DWG-202611-X4VLYLQY, Issue A, Draft) on it; Side Panel Left (RR-DWG-202611-9EBYDVSL) on its per-part spec; 16 patch rows, none with a hole class | one read |

Latest migration: `0069_drawing_dialogue.sql`. Not verified: the time of a catch round trip and
of a STEP download; that sheet PNGs are byte-identical between runs on all 32 cases; Side Panel
Right's Rev B counts; whether all 51 released CAD revisions are still released today; the
equality of Side Panel Left's two dimension lists ignoring sheets; whether colour variants of a
part share one CAD model.

## Appendix — alternatives considered and rejected

Three proposals were written for this rewrite (the rule language, the PLM objects, the screen).
Where they disagreed, or where an earlier choice was reversed:

| question | chosen | rejected, and why |
|---|---|---|
| where a part type lives | its own managed list and a column on the part | *a level under Category*: mixes a filter every part needs with a type only drawn parts have, and turns three chip rows into trees. *A fixed list in code*: a new type would need a deploy. *On the drawing*: the type must exist before the first drawing |
| does a type version pin its Base | yes, one row naming both | *floating on the current Base*: a released issue would render differently next month, and every pin would need a second column |
| where Base and type are combined | in the engine | *an effective body built in the portal*: DD §3.3 forbids it, and two composers drift |
| the sandbox and the change | one object, with a state before "put forward" | *two objects*: a copy step between what was tried and what is saved |
| how many sandboxes | several named per rule set, one put forward | *one shared working copy*: two alternatives cannot be compared, and two engineers write into one list |
| a test part (decision 5) | none | *kept for the write proofs*: a TEST part visible in three registers, eight guards and a twelve-table delete, to buy one proof early |
| who wins between two rules of a type | list order (Open 7) | *most specific wins*: the top-fixing rule is the least specific and must win. *A tie blocks Save* remains under option (b) |
| the catch | one evaluator in the engine, over cached raw features | *a second evaluator in the browser*: instant, but it can disagree with the drawing; reconsidered only if the wait is measured as a problem |
| preview population | drawings, and parts without one | *drawings only*: nothing to preview for most types at the start |
| an untyped part | drawn on the Base, shown in amber | *cannot be released*: breaks "release shows facts and never blocks". *Cannot be drawn*: stops work on 49 parts on day one |
| the reference | one per type, a member of the type, released revisions only | *several references*: double the bookkeeping; Try on answers the need. *A part of another type*: rules proved where they do not apply |
| naming a column | by its distance from an edge | *by rank alone* ("first column"): breaks when a part gains a column; rank stays available as a term |
| build order | types and the page, then his loop (mark, rule, catch) on the evaluator alone, then the engine that draws from rules | *the whole skeleton on today's rule forms first, selectors later*: delivers a sandbox that cannot yet say what the owner asked for. *Engine first*: three weeks with nothing to use. *Sandbox after both engine phases*: his first rule on day 38, his first mark on day 48 |
| context for Ask (reversed) | the reference and its marks, with the census as second input | *a census and no reference* (2026-11-27): overruled by the owner's "mark call outs on a drawings dummy" |
| datum and inside face (reversed) | per rule; found per part | *one value per template* (decision 10): wrong for one hand of every mirrored pair, and contradicted by his sentence (a) |
| where the candidate lives; how previews are queued; "behind"; Restore's pointer rule | as chosen 2026-11-27: a server row from the first operation; items pumped by the poll; by effect; current = highest | *client state*, *N job rows*, *by number*, *a moved pointer*: unchanged reasons |
