// Drawing Templates phase 2 — the rule vocabulary (docs/DRAWING_TEMPLATES.md §3, §4.4).
// Shapes, words and operations; the selector itself is evaluated by the engine.
import { test } from "node:test";
import assert from "node:assert/strict";

const C = await import(new URL("../supabase/functions/_shared/template-rules-core.mjs", import.meta.url));

const PIN = {
  id: "r_pinpair", name: "Pin pairs, front", at_least: 2,
  select: [{ t: "dia", D: 5 }, { t: "place", edge: "front", op: "at", v: 37 }],
  measure: { across: "front", up: "bottom", cc: { pitch: 32, dir: "up", must: "can" } },
};
const TOP = { id: "r_topfix", name: "Top fixing", select: [{ t: "place", edge: "top", op: "within", v: 60 }], measure: { up: "top" } };

test("checkRule: the seed rules of §3.7 hold; bad shapes are named", () => {
  assert.deepEqual(C.checkRule(PIN, C.DEFAULT_EDGES), []);
  assert.deepEqual(C.checkRule(TOP), []);
  assert.ok(C.checkRule({ ...PIN, id: "x" }).some((e) => /id/.test(e)));
  assert.ok(C.checkRule({ ...PIN, name: " " }).some((e) => /name/.test(e)));
  assert.ok(C.checkRule({ ...PIN, select: [{ t: "dia", D: 0 }] }).some((e) => /diameter/.test(e)));
  assert.ok(C.checkRule({ ...PIN, select: [{ t: "dia", D: 5 }, { t: "dia", D: 8 }] }).some((e) => /one dia/.test(e)));
  assert.ok(C.checkRule({ ...PIN, select: [{ t: "place", edge: "x_min", op: "at", v: 3 }] }).some((e) => /edge/.test(e)));
  assert.ok(C.checkRule({ ...PIN, select: [{ t: "place", edge: "top", op: "between", v: 400, v2: 100 }] }).some((e) => /v2/.test(e)));
  assert.ok(C.checkRule({ ...PIN, select: [{ t: "drilled", v: "edge" }] }).some((e) => /names the edge/.test(e)));
  assert.ok(C.checkRule({ ...PIN, select: [{ t: "column", edge: "bottom", rank: 1 }] }).some((e) => /column/.test(e)));
  assert.ok(C.checkRule({ ...PIN, measure: { across: "top" } }).some((e) => /across/.test(e)));
  assert.ok(C.checkRule({ ...PIN, measure: { cc: { dir: "across", must: "can" } } }).some((e) => /Open decision 3/.test(e)));
  assert.ok(C.checkRule({ ...PIN, measure: { up: "bottom", cc: { dir: "up", must: "shall", pitch: 32 } } }).some((e) => /one or the other/.test(e)));
  assert.ok(C.checkRule({ ...PIN, measure: { tol: { pos: "0.1" } } }).some((e) => /bare number/.test(e)));
  assert.ok(C.checkRule({ ...PIN, measure: { only_at: [[1, 2]] } }).some((e) => /unknown keys/.test(e)));
  assert.ok(C.checkRule(PIN, { inside: { test: "opens_class" } }).some((e) => /diameter of the class/.test(e)));
});

test("describeRule: the words of §3.7", () => {
  const d = C.describeRule(PIN);
  assert.equal(d.takes, "Ø5, 37 from the front edge · at least 2");
  assert.equal(d.measured, "across from the front edge · up from the bottom edge · c/c 32 up, pairs, can be");
  assert.equal(C.describeRule(TOP).takes, "within 60 of the top edge");
  assert.equal(C.describeRule({ id: "r_aaaaaa", name: "x", select: [] }).measured, "from the Base default");
  assert.equal(C.describeRule({ id: "r_aaaaaa", name: "x", select: [], measure: { cc: { dir: "up", must: "shall", pitch: null } } }).measured,
    "c/c as modelled up, pairs, shall be");
  assert.equal(C.describeTerm({ t: "near", D: 35, within: 30 }), "within 30 of a Ø35");
  assert.equal(C.describeTerm({ t: "column", edge: "rear", rank: 1 }), "in the column nearest the rear edge");
  assert.equal(C.describeTerm({ t: "row", edge: "bottom", rank: 2 }), "in the 2nd row from the bottom edge");
  assert.equal(C.describeTerm({ t: "drilled", v: "edge", edge: "bottom" }), "into the bottom edge");
  assert.equal(C.describeTerm({ t: "drilled", v: "neither" }), "opening on neither face");
  assert.equal(C.describeSelect([{ t: "drilled", v: "face" }, { t: "place", edge: "top", op: "within", v: 60 }]), "in a face, within 60 of the top edge");
  assert.equal(C.describeTerm({ t: "place", edge: "bottom", op: "between", v: 100, v2: 400 }), "between 100 and 400 from the bottom edge");
});

test("describeHole: by place, never by coordinates", () => {
  assert.equal(C.describeHole({ D: 5, drilled: "inside", from: { front: 105, rear: 475, bottom: 59, top: 1941 }, pos: [105, 59] }),
    "Ø5 · 105 from the front edge · 59 up");
  assert.equal(C.describeHole({ D: 5, drilled: "inside", from: { front: 41, rear: 539, bottom: 1950, top: 12 } }),
    "Ø5 · 41 from the front edge · 12 from the top edge");
  assert.equal(C.describeHole({ D: 12, drilled: "edge", edge: "bottom", from: { front: 41, rear: 489, bottom: 0, top: 2000 } }),
    "Ø12 · into the bottom edge · 41 from the front edge");
  assert.equal(C.describeHole({ D: 2, drilled: "neither", from: { front: 20, rear: 560, bottom: 1999, top: 1 } }),
    "Ø2 · 20 from the front edge · 1 from the top edge · opening on neither face");
});

test("edges: defaults, checks and words", () => {
  assert.deepEqual(C.normaliseEdges(null), { front: { test: "as_modelled" }, bottom: { test: "as_modelled" }, inside: { test: "most_blind" } });
  assert.deepEqual(C.checkEdges({ inside: { test: "opens_class", D: 35 }, front: { test: "nearest_class", D: 35 } }), []);
  assert.ok(C.checkEdges({ rear: { test: "as_modelled" } }).some((e) => /unknown edge/.test(e)));
  assert.ok(C.checkEdges({ bottom: { test: "most_blind" } }).length);
  const words = C.describeEdges({ front: { test: "nearest_class", D: 35 }, inside: { test: "opens_class", D: 35 } }).map((r) => `${r.label} · ${r.words}`);
  assert.deepEqual(words, ["Front edge · nearest the Ø35 holes", "Bottom edge · as modelled", "Inside face · where the Ø35 holes open"]);
});

test("applyRuleOps: add, set, reorder, remove, edges; all or nothing", () => {
  let r = C.applyRuleOps(C.emptyRuleBody(), [{ op: "add_rule", rule: PIN }, { op: "add_rule", rule: TOP }]);
  assert.ok(r.ok);
  assert.deepEqual(r.body.rules.map((x) => x.id), ["r_pinpair", "r_topfix"]);
  assert.equal(r.body.rules[1].at_least, 0);
  const two = r.body;
  r = C.applyRuleOps(two, [{ op: "reorder_rules", ids: ["r_topfix", "r_pinpair"] }]);
  assert.deepEqual(r.body.rules.map((x) => x.id), ["r_topfix", "r_pinpair"]);
  assert.equal(C.applyRuleOps(two, [{ op: "reorder_rules", ids: ["r_topfix"] }]).ok, false);
  r = C.applyRuleOps(two, [{ op: "set_rule", rule: { ...TOP, measure: { up: "top", tol: { pos: "+-0.1" } } } }]);
  assert.equal(r.body.rules[1].measure.tol.pos, "±0.1");
  // A bad second op leaves the body untouched and names its index.
  r = C.applyRuleOps(two, [{ op: "remove_rule", id: "r_topfix" }, { op: "add_rule", rule: PIN }]);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].index, 1);
  assert.equal(two.rules.length, 2);
  r = C.applyRuleOps(two, [{ op: "set_edges", edges: { inside: { test: "opens_class", D: 35 } } }]);
  assert.deepEqual(r.body.edges.inside, { test: "opens_class", D: 35 });
  assert.deepEqual(r.body.edges.front, { test: "as_modelled" });
  assert.equal(C.applyRuleOps(two, [{ op: "set_datum" }]).ok, false);
});

test("describeRuleOps: the CHANGE list", () => {
  const ops = [
    { op: "add_rule", rule: PIN }, { op: "add_rule", rule: TOP },
    { op: "set_rule", rule: { ...TOP, name: "Top fixing" } }, { op: "reorder_rules", ids: ["r_topfix", "r_pinpair"] },
    { op: "set_edges", edges: { inside: { test: "most_blind" } } }, { op: "remove_rule", id: "r_pinpair" },
  ];
  assert.deepEqual(C.describeRuleOps(C.emptyRuleBody(), ops), [
    "+ Pin pairs, front", "+ Top fixing", "Top fixing changed", "Rules reordered", "Inside face · most blind holes", "− Pin pairs, front",
  ]);
});

test("catchCounts and overlapLines: the later rule wins", () => {
  const part = {
    status: "ok", rules: [{ id: "r_pinpair", taken: ["H1", "H2", "H3"] }, { id: "r_topfix", taken: ["H3"] }],
    base_default: ["H9"], overlaps: [{ hole: "H3", rules: ["r_topfix", "r_pinpair"] }],
  };
  assert.deepEqual(C.catchCounts(part), { base_default: 1, r_pinpair: 3, r_topfix: 1 });
  assert.equal(C.catchCounts({ status: "failed" }), null);
  assert.deepEqual(C.overlapLines(part, [PIN, TOP]), { r_pinpair: ["loses 1 hole to Top fixing"] });
});

test("ruleIdFrom and mm", () => {
  assert.equal(C.ruleIdFrom("A1B2-C3D4-E5"), "r_a1b2c3d4e5");
  assert.equal(C.ruleIdFrom("ab"), null);
  assert.equal(C.mm(12.5), "12.5"); assert.equal(C.mm(0.333), "0.33"); assert.equal(C.mm(37), "37");
});
