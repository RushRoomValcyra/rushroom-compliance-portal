// Dynamic drawings, Phase 5 — the dialogue (docs/DRAWING_DIALOGUE.md). Pure
// rules through the shared core, and static guards over the files that must
// agree: the portal-ai handler's op enum IS the vocabulary, the scope is a
// ceiling the core knows per op, a promotion touches only the template body's
// own keys, and the worker mirrors the template file. No credentials, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as M from "../supabase/functions/_shared/drawing-spec-core.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const r = "";
const HOLE = { type: "hole", axis: "Z", D: 5, pos: [41, 1319] };

// ----------------------------------------------------------------- the two new words
test("override_dimension { from }: a per-dimension datum on pos_x / pos_y, nothing else (§4.2)", () => {
  const ok = M.validateOps([
    { op: "override_dimension", at: HOLE, kind: "pos_y", from: "max", reason: r },
    { op: "override_dimension", at: HOLE, kind: "pos_x", from: "min", reason: r },
  ]);
  assert.equal(ok.ok.length, 2);
  assert.equal(ok.ok[0].from, "max");
  const bad = M.validateOps([
    { op: "override_dimension", at: HOLE, kind: "pos_y", reason: r },                    // from is required
    { op: "override_dimension", at: HOLE, kind: "pos_y", from: "max", tol: "±0.1", reason: r }, // no per-hole position tolerance (decision 3)
    { op: "override_dimension", at: HOLE, kind: "depth", from: "max", reason: r },         // from only on pos kinds
    { op: "override_dimension", at: { type: "groove", axis: "X", offset: 12 }, kind: "pos_y", from: "max", reason: r },
    { op: "override_dimension", at: HOLE, kind: "pos_y", from: "top", reason: r },
  ]);
  assert.equal(bad.ok.length, 0);
  assert.match(bad.rejected[0].reason, /takes from/);
  assert.match(bad.rejected[1].reason, /takes from only/);
  assert.match(bad.rejected[2].reason, /from applies to pos_x and pos_y/);
  assert.match(bad.rejected[3].reason, /hole address/);
  assert.match(bad.rejected[4].reason, /from must be one of min, max/);
});

test("remove_tolerance: the patch stops speaking about a kind; the template value applies again", () => {
  const a = M.applySpecOps(null, [{ op: "set_tolerance", kind: "general", tol: "ISO 2768-f", reason: r }, { op: "set_tolerance", kind: "outline", tol: "+0 -0.5", reason: r }]).patch;
  const b = M.applySpecOps(a, [{ op: "remove_tolerance", kind: "general", reason: r }]);
  assert.equal(b.rejected.length, 0);
  assert.deepEqual(b.patch.tolerances, { outline: "+0 -0.5" });
  const c = M.applySpecOps(b.patch, [{ op: "remove_tolerance", kind: "general", reason: r }]);
  assert.equal(c.rejected.length, 1, "removing what is not there is reported");
  assert.equal(M.levelOf("remove_tolerance"), "drawing", "never a template-level op: a template keeps its house values");
  assert.equal(M.touchedEntities([{ op: "remove_tolerance", kind: "general", reason: r }], []).length, 0);
  const app = read("assets/app.js");
  assert.match(app, /\{ op: "remove_tolerance", kind \}/, "× on a set_tolerance line without an accepted value posts remove_tolerance");
  assert.match(app, /op\(\{ op: "remove_tolerance", kind: k \}\)/, "Revert can take a tolerance away");
});

test("set_sheet_plan lands on patch.plan; the empty snapshot carries plan (§4.1)", () => {
  const { patch, rejected } = M.applySpecOps(null, [{ op: "set_sheet_plan", face_order: "bottom_up", reason: r }]);
  assert.equal(rejected.length, 0);
  assert.deepEqual(patch.plan, { face_order: "bottom_up" });
  assert.deepEqual(M.emptyPatch(null).plan, {});
  assert.equal(M.validateOps([{ op: "set_sheet_plan", face_order: "sideways", reason: r }]).ok.length, 0);
});

test("a from override upserts by (at, kind) and × removes it like any override", () => {
  const a = M.applySpecOps(null, [{ op: "override_dimension", at: HOLE, kind: "pos_y", from: "max", reason: r }]).patch;
  assert.deepEqual(a.overrides, [{ at: HOLE, kind: "pos_y", from: "max" }]);
  const b = M.applySpecOps(a, [{ op: "override_dimension", at: HOLE, kind: "pos_y", from: "min", reason: r }]).patch;
  assert.deepEqual(b.overrides, [{ at: HOLE, kind: "pos_y", from: "min" }]);
  const c = M.applySpecOps(b, [{ op: "remove_override", at: HOLE, kind: "pos_y", reason: r }]).patch;
  assert.deepEqual(c.overrides, []);
});

// ----------------------------------------------------------------- scope and levels
test("every op has a level ceiling; overrides are callout, views and sheets drawing, rules template (§3)", () => {
  for (const op of M.OPS) assert.ok(M.LEVELS.includes(M.OP_LEVEL[op]), `${op} has no level`);
  assert.deepEqual(Object.keys(M.OP_LEVEL).sort(), [...M.OPS].sort());
  assert.equal(M.levelOf("override_dimension"), "callout");
  assert.equal(M.levelOf({ op: "remove_override" }), "callout");
  for (const op of ["set_view", "add_view", "remove_view", "set_sheet", "add_sheet", "remove_sheet"]) assert.equal(M.levelOf(op), "drawing", op);
  for (const op of ["set_tolerance", "set_datum", "set_from_top_rule", "set_sheet_plan", "name_edge", "set_hole_rule", "add_pair", "add_ctq"]) assert.equal(M.levelOf(op), "template", op);
  assert.equal(M.levelOf("not_an_op"), null);
});

// ----------------------------------------------------------------- promote
const BODY = {
  template: "flat_panel", title: null, parts: [],
  datums: { x: "min", y: "min", inside_face: "max", y_from_top_within: 0 },
  plan: { face_order: "top_down" },
  tolerances: { general: "ISO 2768-m", hole_depth: "+0.3 -0" },
  features: [], pairs: [], ctq: [],
};

test("promoteTemplate: template-level ops write the body's own keys; lower ones are kept for the drawing; the input is untouched (§5)", () => {
  const frozen = JSON.stringify(BODY);
  const out = M.promoteTemplate(BODY, [
    { op: "set_sheet_plan", face_order: "bottom_up", reason: r },
    { op: "set_tolerance", kind: "hole_depth", tol: "+0.5 -0", reason: r },
    { op: "set_datum", axis: "y", side: "max", reason: r },
    { op: "set_hole_rule", D: 8, axis: "Z", name: "dowel", reason: r },
    { op: "override_dimension", at: HOLE, kind: "pos_y", from: "max", reason: r },   // callout: kept
    { op: "set_sheet", sheet: 2, scale: 2, reason: r },                            // drawing: kept
    { op: "set_tolerance", kind: "hole_depth", tol: "0.5", reason: r },             // a value: rejected
  ]);
  assert.equal(JSON.stringify(BODY), frozen, "input mutated");
  assert.equal(out.promoted.length, 4);
  assert.equal(out.kept.length, 2);
  assert.equal(out.rejected.length, 1);
  assert.deepEqual(out.body.plan, { face_order: "bottom_up" });
  assert.equal(out.body.tolerances.hole_depth, "+0.5 -0");
  assert.equal(out.body.tolerances.general, "ISO 2768-m", "untouched keys stay");
  assert.deepEqual(out.body.datums, { x: "min", y: "max", inside_face: "max", y_from_top_within: 0 });
  assert.deepEqual(out.body.features, [{ D: 8, axis: "Z", name: "dowel" }]);
  assert.equal(out.body.template, "flat_panel");
  assert.equal(out.body.overrides, undefined, "a promotion never writes overrides, views or sheets");
  assert.equal(out.body.views, undefined);
  assert.equal(out.body.sheets, undefined);
  for (const k of Object.keys(out.body)) if (!M.TEMPLATE_KEYS.includes(k)) assert.deepEqual(out.body[k], BODY[k], `${k} changed`);
});

test("stripPromoted: the carried patch loses only what the body now says", () => {
  const patch = M.applySpecOps(null, [
    { op: "set_sheet_plan", face_order: "bottom_up", reason: r },
    { op: "set_tolerance", kind: "hole_depth", tol: "+0.5 -0", reason: r },
    { op: "set_tolerance", kind: "outline", tol: "+0 -0.5", reason: r },
    { op: "override_dimension", at: HOLE, kind: "depth", tol: "+0.4 -0", reason: r },
    { op: "set_hole_rule", D: 8, axis: "Z", name: "dowel", reason: r },
  ]).patch;
  const out = M.stripPromoted(patch, [
    { op: "set_sheet_plan", face_order: "bottom_up", reason: r },
    { op: "set_tolerance", kind: "hole_depth", tol: "+0.5 -0", reason: r },
    { op: "set_hole_rule", D: 8, axis: "Z", name: "dowel", reason: r },
  ]);
  assert.deepEqual(out.plan, {});
  assert.deepEqual(out.tolerances, { outline: "+0 -0.5" });
  assert.deepEqual(out.features, []);
  assert.equal(out.overrides.length, 1, "overrides are never promoted, so never stripped");
  assert.deepEqual(patch.tolerances, { hole_depth: "+0.5 -0", outline: "+0 -0.5" }, "input untouched");
});

// ----------------------------------------------------------------- the diff reads a datum move
test("diffDimensionLists counts a datum move as a swap: pos_y gone, pos_y_top new at the same address", () => {
  const before = [{ sheet: 2, feature: "H15", kind: "pos_y", value: 2118, text: "2118 ±0.2", tol: "±0.2", view: "face 2", at: HOLE }];
  const after = [{ sheet: 2, feature: "H15", kind: "pos_y_top", value: 192, text: "192 ±0.2", tol: "±0.2", view: "face 2", at: HOLE }];
  const d = M.diffDimensionLists(before, after);
  assert.equal(d.counts.added, 1); assert.equal(d.counts.removed, 1); assert.equal(d.counts.datum_swaps, 1);
  assert.equal(M.diffDimensionLists(before, before).counts.datum_swaps, 0);
  // touchedEntities: a from op touches the row whichever of the two kinds it prints as
  const t = M.touchedEntities([{ op: "override_dimension", at: HOLE, kind: "pos_y", from: "max", reason: r }], after);
  assert.equal(t.length, 1); assert.equal(t[0].kind, "pos_y_top");
  assert.deepEqual(M.touchedEntities([{ op: "set_sheet_plan", face_order: "bottom_up", reason: r }], after), [], "a sheet-order change prints no new number");
});

// ----------------------------------------------------------------- static guards
test("portal-ai: the proposal schema's op enum is OPS, the scope is read from the body, the turn row carries it", () => {
  const src = read("supabase/functions/portal-ai/handlers/drawing-spec.ts");
  assert.match(src, /op:\s*\{\s*type:\s*"string",\s*enum:\s*\[\.\.\.OPS\]/, "the op enum must be generated from OPS");
  assert.match(src, /LEVELS\.includes\(body\.scope\)/, "scope comes from the body, defaulting to drawing");
  assert.match(src, /levelOf\(op\)/, "the level is the core's constant, never a model field");
  assert.ok(!/level:\s*\{\s*type:\s*"string"/.test(src), "the schema must not let the model propose a level");
  assert.match(src, /category:\s*"scope"/, "a callout-scope op without an address is a scope refusal");
  assert.match(src, /drawing_spec_turns"\)\.insert\(\{[\s\S]*scope,/, "the turn row records the scope");
  assert.match(src, /cache_control:\s*\{\s*type:\s*"ephemeral"\s*\}/, "the system block is cached");
  assert.match(src, /thinking:\s*\{\s*type:\s*"adaptive"\s*\}/);
  const ai = read("supabase/functions/portal-ai/index.ts");
  assert.match(ai, /action === "proposeDrawingSpecOps"/);
  assert.match(ai, /model: SCAN_MODEL, docBucket: DOC_BUCKET, meterAi, session,\n\s*\}\);/, "SCAN_MODEL, as the design requires");
});

test("portal-api: promote, discard and the version fetch exist; register never moves the pointer back; the poll carries templates", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  for (const a of ["promoteDrawingSpecOps", "discardDrawingSpecTurn", "getDrawingSpecVersion"]) assert.match(api, new RegExp(`action === "${a}"`), a);
  assert.match(api, /moved_to: "portal-ai"[\s\S]{0,40}/, "");
  assert.match(api, /'proposeDrawingSpecOps' is served by portal-ai/, "the stale-client guard");
  assert.match(api, /promoteTemplate\(version\.body, ops\)/);
  assert.match(api, /stripPromoted\(basePatch, pro\.promoted\)/);
  assert.match(api, /origin: "portal", author_user_id: session\.uid/);
  assert.match(api, /origin: "carry", turn_id,/, "the carried seq is a carry row on the new base");
  assert.match(api, /version\.kind !== "template"\) return json\(\{ error: `\$\{version\.name\} is a per-part spec/, "decision 6: migrate first");
  assert.match(api, /Number\(top\.version\) > Number\(have\.version\) \? top\.id : have\.id/, "a known older body never moves current back");
  assert.match(api, /return json\(\{ job: null, templates: await templateList\(tdb\) \}\)/, "the idle poll carries the templates");
  assert.match(api, /accepted: true \}\)\.eq\("id", turn_id\)/, "an applied turn is accepted");
  assert.match(api, /"drawing_template_promoted"/);
});

test("worker: the Mac file mirrors the current template version and a hand edit still registers", () => {
  const w = read("tools/drawing-worker/worker.py");
  assert.match(w, /class Mirror:/);
  assert.match(w, /getDrawingSpecVersion/);
  assert.match(w, /shutil\.copyfile\(path, path \+ "\.bak"\)/, "the previous file is kept");
  assert.match(w, /mirror\.after_register\(portal, cfg, register_specs\(portal, cfg, agent\)\)/);
  assert.match(w, /r\.get\("templates"\)/, "the poll answer's list is read");
  assert.match(w, /def spec_catalogue/, "registration from the files is unchanged");
});

test("migration 0069: origin, author, parent, promoted_from, note on versions; scope on turns", () => {
  const sql = read("supabase/migrations/0069_drawing_dialogue.sql");
  for (const col of ["origin", "author_user_id", "parent_version_id", "promoted_from_drawing_id", "note"]) assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${col}`), col);
  assert.match(sql, /CHECK \(origin IN \('mac', 'portal'\)\)/);
  assert.match(sql, /drawing_spec_turns\s+ADD COLUMN IF NOT EXISTS scope TEXT CHECK \(scope IN \('callout', 'drawing', 'template'\)\)/);
});

test("the rail: scope row, Ask, the card, Promote wording, the From form, the swap line; nothing in the supplier shell", () => {
  const app = read("assets/app.js");
  assert.match(app, /scopeBtn\("callout", "This callout"\), scopeBtn\("drawing", "This drawing"\), tBtn/);
  assert.match(app, /placeholder: "Ask…"/);
  assert.match(app, /"proposeDrawingSpecOps", \{ drawing_id: drawing\.id, prompt, scope: state\.scope, selection, parent_seq: parentSeq\(\) \}/);
  assert.match(app, /`Promote to \$\{tmpl\.name\} v\$\{Number\(tmpl\.current_version \|\| tmpl\.version\) \+ 1\}`/);
  assert.match(app, /"promoteDrawingSpecOps"/);
  assert.match(app, /"discardDrawingSpecTurn"/);
  assert.match(app, /origin: "dialogue", turn_id: res\.turn_id/);
  assert.match(app, /"stays on this drawing"/);
  assert.match(app, /const POS_FORM = \{ pos_x: "pos_x", pos_x_far: "pos_x", pos_y: "pos_y", pos_y_top: "pos_y" \}/);
  assert.match(app, /field\("From", from\)/);
  assert.match(app, /measured from the other edge/);
  assert.match(app, /case "set_sheet_plan": return `sheets from the/);
  // The scope is a ceiling the engineer sets: the callout button is disabled with nothing marked.
  assert.match(app, /if \(k === "callout"\) b\.disabled = !hasSel;/);
  // A datum move prints under the other kind: the touched set keys by the swap pair, and is rebuilt
  // from the pending Patch lines after a reload (proved live 2026-11-27: 10 amber on both panes).
  assert.match(app, /const drTouchKey = \(r\) => `\$\{r\.sheet\}\|\$\{r\.feature\}\|\$\{String\(r\.kind\)\.replace\(\/\^pos_y_top\$\/, "pos_y"\)\.replace\(\/\^pos_x_far\$\/, "pos_x"\)\}`/);
  assert.match(app, /state\.touched\.add\(drTouchKey\(t\)\)/);
  assert.match(app, /core\.touchedEntities\(pend, dims\)/, "the touched set is rebuilt from the pending lines");
  // A drawing with no accepted patch compares its views/sheets against the empty schema structure, not {}
  // (found live on the first flat_panel drawing: Patch read (0) after a set_sheet_plan).
  assert.match(app, /const EMPTY = core\.emptyPatch\(null\);\n\s*if \(!same\(a\.views \|\| EMPTY\.views, b\.views \|\| EMPTY\.views\)\)/);
  assert.ok(!/state\.touched\.add\(drDimKey/.test(app), "no touched key bypasses the swap pair");
  const sup = read("supplier.html");
  assert.ok(!sup.includes("drawing-spec-core"), "the supplier shell does not load the vocabulary");
  const html = read("index.html");
  assert.match(html, /drawing-spec-core\.mjs\?v=470/);
  for (const a of ["app.js", "styles.css"]) {
    const v = (html.match(new RegExp(`assets/${a}\\?v=(\\d+)`)) || [])[1];
    assert.ok(Number(v) >= 470, `${a} not bumped to 470`);
  }
});
