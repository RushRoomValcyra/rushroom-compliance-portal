// The drawing spec patch's pure rules (docs/DYNAMIC_DRAWINGS.md §3.3, §4.4) — no
// credentials, no network. One module for portal-api, portal-ai, the browser
// and these tests, so the vocabulary and the validator cannot drift apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import * as M from "../supabase/functions/_shared/drawing-spec-core.mjs";

const plain = (v) => JSON.parse(JSON.stringify(v));
const r = "";                                                     // an empty reason is admitted
const HOLE = { type: "hole", axis: "Z", D: 5, pos: [37, 58.5] };
const GROOVE = { type: "groove", axis: "X", offset: 12 };
const POCKET = { type: "pocket", at: [100, 40] };

// ----------------------------------------------------------------- parseTolerance
test("parseTolerance: the house forms, canonical spelling", () => {
  assert.deepEqual(M.parseTolerance("±0.2"), { ok: true, form: "sym", text: "±0.2" });
  assert.deepEqual(M.parseTolerance("+/- 0.20"), { ok: true, form: "sym", text: "±0.2" });
  assert.deepEqual(M.parseTolerance("+0.3 -0"), { ok: true, form: "asym", text: "+0.3 -0" });
  assert.deepEqual(M.parseTolerance("+0.1 -0.1"), { ok: true, form: "asym", text: "+0.1 -0.1" });
  assert.deepEqual(M.parseTolerance("+0 -0.5"), { ok: true, form: "asym", text: "+0 -0.5" });
  assert.deepEqual(M.parseTolerance("0 -0.5"), { ok: true, form: "asym", text: "+0 -0.5" });
  assert.deepEqual(M.parseTolerance("+1 −0"), { ok: true, form: "asym", text: "+1 -0" }, "a typographic minus is read as minus");
});

test("parseTolerance: ISO 2768 only for the general tolerance", () => {
  assert.deepEqual(M.parseTolerance("ISO 2768-m", { general: true }), { ok: true, form: "iso", text: "ISO 2768-m" });
  assert.deepEqual(M.parseTolerance("iso 2768-F", { general: true }), { ok: true, form: "iso", text: "ISO 2768-f" });
  const no = M.parseTolerance("ISO 2768-m");
  assert.equal(no.ok, false);
  assert.match(no.reason, /general/);
  assert.equal(M.parseTolerance("ISO 2768-x", { general: true }).ok, false);
});

test("parseTolerance: a bare number is a value and is refused as such", () => {
  for (const bad of ["0.2", " 12 ", "-0.5", "0.2 mm", 0.2, 12]) {
    const p = M.parseTolerance(bad, { general: true });
    assert.equal(p.ok, false, `${JSON.stringify(bad)} accepted`);
    assert.match(p.reason, /bare number/);
  }
  assert.equal(M.parseTolerance("").ok, false);
  assert.equal(M.parseTolerance(null).ok, false);
  assert.equal(M.parseTolerance("+0.3").ok, false, "one-sided without the minus part");
  assert.equal(M.parseTolerance("+0.3 +0.1").ok, false);
});

// ----------------------------------------------------------------- validateOps
test("validateOps: unknown op, unknown key, portal facts, missing reason", () => {
  const v = M.validateOps([
    { op: "set_title", title: "X", reason: r },
    { op: "set_tolerance", kind: "hole_depth", tol: "+0.3 -0", colour: "red", reason: r },
    { op: "set_tolerance", kind: "hole_depth", tol: "+0.3 -0", issue: "C", reason: r },
    { op: "set_tolerance", kind: "hole_depth", tol: "+0.3 -0" },
    { op: "set_tolerance", kind: "hole_depth", tol: "+0.3 -0", reason: "x".repeat(161) },
    "not an op",
  ]);
  assert.equal(v.ok.length, 0);
  assert.equal(v.rejected.length, 6);
  assert.match(v.rejected[0].reason, /unknown op "set_title"/);
  assert.match(v.rejected[1].reason, /unknown key colour/);
  assert.match(v.rejected[2].reason, /issue is a portal fact/);
  assert.match(v.rejected[3].reason, /reason/);
  assert.match(v.rejected[4].reason, /160/);
  assert.match(v.rejected[5].reason, /object/);
});

test("validateOps: no printed value in a tolerance or a name", () => {
  const v = M.validateOps([
    { op: "set_tolerance", kind: "hole_depth", tol: 0.3, reason: r },
    { op: "set_tolerance", kind: "hole_depth", tol: "0.3", reason: r },
    { op: "set_tolerance", kind: "hole_depth", tol: "ISO 2768-m", reason: r },
    { op: "override_dimension", at: HOLE, kind: "dia", name: "35", reason: r },
    { op: "override_dimension", at: HOLE, kind: "dia", name: 35, reason: r },
    { op: "name_edge", edge: "y_max", name: "600", reason: r },
    { op: "set_hole_rule", D: 8, axis: "Z", depth_tol: "13", reason: r },
  ]);
  assert.equal(v.ok.length, 0);
  for (const x of v.rejected) assert.match(x.reason, /bare number|general/, x.reason);
});

test("validateOps: scales, override kinds, name only with dia, required args", () => {
  const v = M.validateOps([
    { op: "set_view", id: "A", scale: 3, reason: r },
    { op: "set_sheet", sheet: 2, scale: 2.5, reason: r },
    { op: "override_dimension", at: HOLE, kind: "pos_x", tol: "±0.1", reason: r },
    { op: "override_dimension", at: HOLE, kind: "depth", name: "hinge cup", tol: "+0.5 -0", reason: r },
    { op: "override_dimension", at: HOLE, kind: "depth", reason: r },
    { op: "override_dimension", at: HOLE, kind: "groove_width", tol: "±0.1", reason: r },
    { op: "override_dimension", at: { type: "hole", axis: "Z", D: 5 }, kind: "dia", name: "x", reason: r },
    { op: "override_dimension", at: { type: "hole", axis: "Z", D: 5, pos: [1, 2], id: "H12" }, kind: "dia", name: "x", reason: r },
    { op: "add_view", kind: "section", through: { D: 8, axis: "Y" }, normal: "y", reason: r },
    { op: "add_view", kind: "edge", reason: r },
    { op: "set_tolerance", kind: "hole_depth", reason: r },
    { op: "add_ctq", a: { D: 8, column: "rearmost" }, b: { D: 5, column: "middle" }, within: 60, label: "CTQ", reason: r },
  ]);
  assert.equal(v.ok.length, 0, JSON.stringify(v.ok));
  const reasons = v.rejected.map((x) => x.reason);
  assert.match(reasons[0], /scale must be one of 1, 2, 5, 10, 20/);
  assert.match(reasons[1], /scale/);
  // A per-hole position TOLERANCE stays code (§9 decision 3); pos_x is a datum kind now and takes `from` only.
  assert.match(reasons[2], /kind pos_x takes from/);
  assert.match(reasons[3], /name only with kind dia/);
  assert.match(reasons[4], /give tol or name/);
  assert.match(reasons[5], /groove address/);
  assert.match(reasons[6], /at\.pos/);
  assert.match(reasons[7], /unknown key at\.id/);
  assert.match(reasons[8], /normal must be one of x/);
  assert.match(reasons[9], /edge view needs edge/);
  assert.match(reasons[10], /tol is required/);
  assert.match(reasons[11], /column/);
});

test("validateOps: admitted ops come back normalised (canonical tol, upper-case hole axis)", () => {
  const v = M.validateOps([
    { op: "override_dimension", at: { type: "hole", axis: "z", D: 5, pos: [37, 58.5] }, kind: "depth", tol: "+0.50 -0", reason: "hinge cup seats on the floor" },
    { op: "set_tolerance", kind: "general", tol: "iso 2768-f", reason: r },
    { op: "set_hole_rule", D: 8, axis: "z", name: "dowel", only_at: [[37, 58.5]], reason: r },
    { op: "set_view", id: "A", scale: 5, reason: r },
    { op: "add_sheet", kind: "face", y_range: [0, 600], scale: 2, orient: "landscape", reason: r },
    { op: "set_edge_band", edge: "y_max", text: null, reason: r },
  ]);
  assert.equal(v.rejected.length, 0, JSON.stringify(v.rejected));
  assert.equal(v.ok[0].tol, "+0.5 -0");
  assert.equal(v.ok[0].at.axis, "Z");
  assert.equal(v.ok[1].tol, "ISO 2768-f");
  assert.equal(v.ok[2].axis, "Z");
  assert.equal(v.ok[5].text, null);
});

// ----------------------------------------------------------------- applySpecOps
test("applySpecOps: never mutates its input; v:1 and base kept", () => {
  const base = { name: "flat_panel", version: 2 };
  const input = M.emptyPatch(base);
  input.tolerances.hole_depth = "+0.3 -0";
  const frozen = plain(input);
  const { patch, rejected } = M.applySpecOps(input, [
    { op: "set_tolerance", kind: "hole_depth", tol: "+0.5 -0", reason: r },
    { op: "override_dimension", at: HOLE, kind: "dia", name: "hinge cup", reason: r },
  ]);
  assert.deepEqual(plain(input), frozen, "input changed");
  assert.equal(rejected.length, 0);
  assert.equal(patch.v, 1);
  assert.deepEqual(patch.base, base);
  assert.notEqual(patch, input);
  assert.equal(patch.tolerances.hole_depth, "+0.5 -0");
  assert.equal(patch.overrides.length, 1);
});

test("applySpecOps: from null/undefined starts an empty schema-1 snapshot", () => {
  const { patch } = M.applySpecOps(null, []);
  assert.deepEqual(plain(patch), plain(M.emptyPatch(null)));
  assert.deepEqual(Object.keys(patch).sort(), ["base", "ctq", "datums", "edge_band", "edge_names", "features", "overrides", "pairs", "plan", "sheets", "tolerances", "v", "views"]);
});

test("applySpecOps: override_dimension upserts by (at, kind); remove_override removes it", () => {
  let p = M.applySpecOps(null, [
    { op: "override_dimension", at: HOLE, kind: "depth", tol: "+0.5 -0", reason: r },
    { op: "override_dimension", at: { ...HOLE, axis: "z", pos: [37.004, 58.5] }, kind: "depth", tol: "+0.8 -0", reason: "same hole within 0.01" },
    { op: "override_dimension", at: HOLE, kind: "dia", name: "hinge cup", reason: r },
    { op: "override_dimension", at: { ...HOLE, pos: [37, 90] }, kind: "depth", tol: "+0.5 -0", reason: "another hole" },
    { op: "override_dimension", at: GROOVE, kind: "groove_width", tol: "±0.1", reason: r },
    { op: "override_dimension", at: POCKET, kind: "pocket_depth", tol: "+0.2 -0", reason: r },
  ]).patch;
  assert.equal(p.overrides.length, 5);
  assert.deepEqual(p.overrides[0], { at: HOLE, kind: "depth", tol: "+0.8 -0" });
  assert.deepEqual(p.overrides[1], { at: HOLE, kind: "dia", name: "hinge cup" });
  const rm = M.applySpecOps(p, [
    { op: "remove_override", at: HOLE, kind: "depth", reason: r },
    { op: "remove_override", at: { ...HOLE, pos: [1, 1] }, kind: "depth", reason: r },
  ]);
  assert.equal(rm.patch.overrides.length, 4);
  assert.equal(rm.patch.overrides.some((o) => o.kind === "depth" && M.atEquals(o.at, HOLE)), false);
  assert.equal(rm.rejected.length, 1);
  assert.match(rm.rejected[0].reason, /no depth override/);
  assert.equal(p.overrides.length, 5, "the previous snapshot is untouched");
});

test("applySpecOps: set_tolerance, datums and edge ops land on their keys", () => {
  const { patch, rejected } = M.applySpecOps(null, [
    { op: "set_tolerance", kind: "hole_depth", tol: "+0.3 -0", reason: r },
    { op: "set_tolerance", kind: "general", tol: "ISO 2768-f", reason: r },
    { op: "set_inside_face", side: "min", reason: r },
    { op: "set_datum", axis: "y", side: "max", reason: r },
    { op: "set_from_top_rule", within: 60, reason: r },
    { op: "name_edge", edge: "y_max", name: "Top", reason: r },
    { op: "set_edge_band", edge: "y_max", text: "2 mm ABS", reason: r },
    { op: "set_edge_band", edge: "x_min", text: null, reason: r },
  ]);
  assert.equal(rejected.length, 0, JSON.stringify(rejected));
  assert.deepEqual(patch.tolerances, { hole_depth: "+0.3 -0", general: "ISO 2768-f" });
  assert.deepEqual(patch.datums, { inside_face: "min", y: "max", y_from_top_within: 60 });
  assert.deepEqual(patch.edge_names, { y_max: "Top" });
  assert.deepEqual(patch.edge_band, { y_max: "2 mm ABS", x_min: null });
});

test("applySpecOps: set_hole_rule upserts by (D, axis, only_at); remove_hole_rule removes that row only", () => {
  const { patch, rejected } = M.applySpecOps(null, [
    { op: "set_hole_rule", D: 8, axis: "Z", name: "dowel", reason: r },
    { op: "set_hole_rule", D: 8, axis: "Z", depth_tol: "+0.5 -0", reason: "merges into the class row" },
    { op: "set_hole_rule", D: 8, axis: "Z", only_at: [[11, 16]], dia_tol: "+0.05 -0", reason: "a different row: position-specific" },
    { op: "set_hole_rule", D: 8, axis: "Y", name: "edge bore", reason: "a different row: other axis" },
  ]);
  assert.equal(rejected.length, 0, JSON.stringify(rejected));
  assert.equal(patch.features.length, 3);
  assert.deepEqual(patch.features[0], { D: 8, axis: "Z", name: "dowel", depth_tol: "+0.5 -0" });
  assert.deepEqual(patch.features[1], { D: 8, axis: "Z", only_at: [[11, 16]], dia_tol: "+0.05 -0" });
  const rm = M.applySpecOps(patch, [
    { op: "remove_hole_rule", D: 8, axis: "Z", reason: r },
    { op: "remove_hole_rule", D: 12, axis: "Z", reason: r },
  ]);
  assert.equal(rm.patch.features.length, 2);
  assert.equal(rm.patch.features.some((f) => f.name === "dowel"), false);
  assert.ok(rm.patch.features.some((f) => f.only_at), "the only_at row survives");
  assert.equal(rm.rejected.length, 1);
});

test("applySpecOps: pairs and ctq add/remove", () => {
  const { patch, rejected } = M.applySpecOps(null, [
    { op: "add_pair", D: 5, cc: 32, reason: r },
    { op: "add_pair", D: 5, cc: 32, reason: "twice is once" },
    { op: "add_pair", D: 10, cc: 52, about: { D: 35 }, reason: r },
    { op: "add_ctq", a: { D: 8, column: "rearmost" }, b: { D: 5, column: "rearmost" }, within: 60, label: "CTQ", reason: r },
    { op: "add_ctq", a: { D: 5, column: "rearmost" }, b: { D: 5, column: "frontmost" }, within: 0.3, label: "hinge line", reason: r },
  ]);
  assert.equal(rejected.length, 0, JSON.stringify(rejected));
  assert.deepEqual(patch.pairs, [{ D: 5, cc: 32 }, { D: 10, cc: 52, about: { D: 35 } }]);
  assert.equal(patch.ctq.length, 2);
  const rm = M.applySpecOps(patch, [
    { op: "remove_pair", D: 5, cc: 32, reason: r },
    { op: "remove_ctq", label: "CTQ", reason: r },
    { op: "remove_ctq", label: "nope", reason: r },
  ]);
  assert.deepEqual(rm.patch.pairs, [{ D: 10, cc: 52, about: { D: 35 } }]);
  assert.deepEqual(rm.patch.ctq.map((c) => c.label), ["hinge line"]);
  assert.equal(rm.rejected.length, 1);
});

test("applySpecOps: views set/add/remove", () => {
  const { patch, rejected } = M.applySpecOps(null, [
    { op: "set_view", id: "A", scale: 5, reason: r },
    { op: "set_view", id: "A", caption: "VIEW A 1:5", reason: "merges" },
    { op: "add_view", kind: "section", through: { D: 8, axis: "y", open_at: "min" }, normal: "x", scale: 2, reason: r },
    { op: "add_view", kind: "groove_section", groove: 0, scale: 2, x_shown: 30, reason: r },
    { op: "add_view", kind: "detail", around: { D: 35, index: 0 }, box: { x_from_datum: 52, y_half: 34 }, scale: 1, reason: r },
    { op: "set_view", id: "B-B", scale: 1, reason: r },
    { op: "remove_view", id: "B-B", reason: "removing also drops its set entry" },
    { op: "remove_view", id: "B-B", reason: "twice is once" },
  ]);
  assert.equal(rejected.length, 0, JSON.stringify(rejected));
  assert.deepEqual(patch.views.set, { A: { scale: 5, caption: "VIEW A 1:5" } });
  assert.equal(patch.views.add.length, 3);
  assert.deepEqual(patch.views.add[0], { kind: "section", through: { D: 8, axis: "Y", open_at: "min" }, normal: "x", scale: 2 });
  assert.deepEqual(patch.views.remove, ["B-B"]);
  const back = M.applySpecOps(patch, [{ op: "set_view", id: "B-B", scale: 2, reason: "setting it again un-removes it" }]).patch;
  assert.deepEqual(back.views.remove, []);
  assert.deepEqual(back.views.set["B-B"], { scale: 2 });
});

test("applySpecOps: sheets set/add/remove", () => {
  const { patch, rejected } = M.applySpecOps(null, [
    { op: "set_sheet", sheet: 2, scale: 2, y_range: [0, 600], reason: r },
    { op: "set_sheet", sheet: 2, orient: "landscape", reason: "merges" },
    { op: "add_sheet", kind: "face", y_range: [600, 1200], scale: 5, reason: r },
    { op: "add_sheet", kind: "part_sheet", part: 1, reason: r },
    { op: "set_sheet", sheet: 3, scale: 10, reason: r },
    { op: "remove_sheet", sheet: 3, reason: r },
    { op: "remove_sheet", sheet: 3, reason: r },
    { op: "add_sheet", kind: "face", reason: "no y_range" },
    { op: "add_sheet", kind: "part_sheet", reason: "no part" },
  ]);
  assert.equal(rejected.length, 2);
  assert.deepEqual(patch.sheets.set, { "2": { scale: 2, y_range: [0, 600], orient: "landscape" } });
  assert.deepEqual(patch.sheets.add, [{ kind: "face", y_range: [600, 1200], scale: 5 }, { kind: "part_sheet", part: 1 }]);
  assert.deepEqual(patch.sheets.remove, [3]);
});

test("applySpecOps: a rejected op is reported and the admitted ones still apply", () => {
  const { patch, rejected } = M.applySpecOps(null, [
    { op: "set_tolerance", kind: "hole_depth", tol: "0.3", reason: r },
    { op: "set_tolerance", kind: "groove_width", tol: "±0.1", reason: r },
  ]);
  assert.equal(rejected.length, 1);
  assert.deepEqual(patch.tolerances, { groove_width: "±0.1" });
});

// ----------------------------------------------------------------- canonical JSON + sha
test("canonicalJson: keys sorted recursively, arrays in order, stable", () => {
  const a = { b: 1, a: { z: [3, { y: 1, x: 2 }], c: "s" }, n: null, u: undefined };
  const b = { n: null, a: { c: "s", z: [3, { x: 2, y: 1 }] }, b: 1 };
  assert.equal(M.canonicalJson(a), '{"a":{"c":"s","z":[3,{"x":2,"y":1}]},"b":1,"n":null}');
  assert.equal(M.canonicalJson(a), M.canonicalJson(b));
  assert.equal(M.canonicalJson([1, undefined, "x"]), '[1,null,"x"]', "JSON.stringify semantics in arrays");
  assert.equal(M.canonicalJson("s"), '"s"');
  assert.equal(M.canonicalJson(1.5), "1.5");
  assert.equal(JSON.stringify(JSON.parse(M.canonicalJson(a))), M.canonicalJson(a), "round-trips through JSON.parse");
});

test("canonicalSha: a string is hashed as given; an object via canonicalJson (node:crypto as oracle)", async () => {
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  const text = '{"b":1,"a":2}';
  assert.equal(await M.canonicalSha(text), sha(text), "the string is NOT canonicalised");
  assert.equal(await M.canonicalSha({ b: 1, a: 2 }), sha('{"a":2,"b":1}'));
  assert.equal(await M.canonicalSha({ b: 1, a: 2 }), await M.canonicalSha({ a: 2, b: 1 }));
  assert.equal(await M.canonicalSha(""), sha(""));
  assert.match(await M.canonicalSha("x"), /^[0-9a-f]{64}$/);
});

// ----------------------------------------------------------------- diffDimensionLists
const ROWS_A = [
  { sheet: 2, feature: "H12", kind: "depth", value: 13, text: "13", tol: "+0.3 -0", view: "", at: HOLE },
  { sheet: 2, feature: "H12", kind: "dia", value: 5, text: "Ø5", tol: "", view: "", at: HOLE },
  { sheet: 2, feature: "H13", kind: "depth", value: 13, text: "13", tol: "+0.3 -0", view: "", at: { ...HOLE, pos: [37, 90] } },
  { sheet: 1, feature: "outline", kind: "width", value: 600, text: "600", tol: "+0 -0.5", view: "" },
  { sheet: 3, feature: "G0", kind: "groove_width", value: 4, text: "4", tol: "+0.2 -0", view: "", at: GROOVE },
];
test("diffDimensionLists: keyed by (at | feature) + kind; added/removed/value/tol/text", () => {
  const b = [
    // H12 renumbered to H40 after a CAD change — same at, so the same key; tol changed
    { sheet: 2, feature: "H40", kind: "depth", value: 13, text: "13", tol: "+0.5 -0", view: "", at: HOLE },
    { sheet: 2, feature: "H40", kind: "dia", value: 5, text: "Ø5 hinge cup", tol: "", view: "", at: HOLE },
    // H13 moved — a different key: one removed, one added
    { sheet: 2, feature: "H41", kind: "depth", value: 13, text: "13", tol: "+0.3 -0", view: "", at: { ...HOLE, pos: [37, 120] } },
    // outline has no at → keyed by feature; value changed
    { sheet: 1, feature: "outline", kind: "width", value: 598, text: "598", tol: "+0 -0.5", view: "" },
    { sheet: 3, feature: "G0", kind: "groove_width", value: 4, text: "4", tol: "+0.2 -0", view: "", at: GROOVE },
  ];
  const d = M.diffDimensionLists(ROWS_A, b);
  assert.deepEqual(d.counts, { a: 5, b: 5, added: 1, removed: 1, value_changed: 1, tol_changed: 1, text_changed: 1, same: 1, datum_swaps: 0 });
  assert.equal(d.added[0].row.feature, "H41");
  assert.equal(d.removed[0].row.feature, "H13");
  assert.equal(d.tol_changed[0].key, M.canonicalJson(HOLE) + "|depth");
  assert.deepEqual([d.tol_changed[0].before.tol, d.tol_changed[0].after.tol], ["+0.3 -0", "+0.5 -0"]);
  assert.equal(d.text_changed[0].kind, "dia");
  assert.equal(d.value_changed[0].key, "outline|width");
  assert.equal(d.same[0].feature, "G0");
});

test("diffDimensionLists: identical lists are all same; the same (at, kind) on two sheets is paired by sheet", () => {
  const twice = [
    { sheet: 1, feature: "H1", kind: "depth", value: 13, text: "13", tol: "", view: "", at: HOLE },
    { sheet: 2, feature: "H1", kind: "depth", value: 13, text: "13", tol: "", view: "", at: HOLE },
  ];
  const d = M.diffDimensionLists(twice, twice);
  assert.equal(d.counts.same, 2);
  assert.equal(d.counts.a, 2);
  assert.equal(M.diffDimensionLists([], []).counts.same, 0);
});

// ----------------------------------------------------------------- touchedEntities
test("touchedEntities: an override touches its (at, kind) row; a kind tolerance touches every row of the kind", () => {
  const t1 = M.touchedEntities([{ op: "override_dimension", at: { ...HOLE, axis: "z" }, kind: "depth", tol: "+0.5 -0", reason: r }], ROWS_A);
  assert.deepEqual(plain(t1), [{ feature: "H12", kind: "depth", at: HOLE, sheet: 2 }]);
  const t2 = M.touchedEntities([{ op: "set_tolerance", kind: "hole_depth", tol: "+0.5 -0", reason: r }], ROWS_A);
  assert.deepEqual(t2.map((x) => x.feature), ["H12", "H13"]);
  const t3 = M.touchedEntities([{ op: "set_tolerance", kind: "groove_width", tol: "±0.1", reason: r }], ROWS_A);
  assert.deepEqual(t3.map((x) => x.feature), ["G0"]);
  const t4 = M.touchedEntities([{ op: "set_tolerance", kind: "outline", tol: "+0 -0.3", reason: r }], ROWS_A);
  assert.deepEqual(plain(t4), [{ feature: "outline", kind: "width", at: null, sheet: 1 }]);
  assert.deepEqual(M.touchedEntities([{ op: "set_tolerance", kind: "general", tol: "ISO 2768-f", reason: r }], ROWS_A), []);
  assert.deepEqual(M.touchedEntities([{ op: "bogus", reason: r }], ROWS_A), [], "a rejected op touches nothing");
  const t5 = M.touchedEntities([{ op: "set_hole_rule", D: 5, axis: "Z", name: "hinge", reason: r }], ROWS_A);
  assert.deepEqual(t5.map((x) => `${x.feature}/${x.kind}`), ["H12/dia"]);
});

// ----------------------------------------------------------------- static: vocabulary ↔ handlers
test("static: every op in SPEC_VOCAB has a handler in applySpecOps and vice versa", () => {
  const vocab = Object.keys(M.SPEC_VOCAB).sort();
  const handlers = Object.keys(M.OP_HANDLERS).sort();
  assert.deepEqual(handlers, vocab);
  assert.deepEqual([...M.OPS].sort(), vocab);
  // §4.4 names every one of these
  for (const op of ["set_tolerance", "set_inside_face", "set_datum", "set_from_top_rule", "name_edge", "set_edge_band",
    "set_hole_rule", "remove_hole_rule", "override_dimension", "remove_override", "add_pair", "remove_pair",
    "add_ctq", "remove_ctq", "set_view", "add_view", "remove_view", "set_sheet", "add_sheet", "remove_sheet"]) {
    assert.ok(vocab.includes(op), `${op} missing from SPEC_VOCAB`);
  }
  assert.ok(vocab.includes("set_sheet_plan"), "set_sheet_plan missing (DRAWING_DIALOGUE §4.1)");
  assert.ok(vocab.includes("remove_tolerance"), "remove_tolerance missing (a kind tolerance set in error must be unsettable)");
  assert.equal(vocab.length, 22);
  for (const [op, def] of Object.entries(M.SPEC_VOCAB)) {
    assert.ok(Array.isArray(def.required), `${op}.required`);
    for (const k of def.required) assert.ok(k in def.args, `${op}: required ${k} not in args`);
  }
  assert.deepEqual(M.OVERRIDE_KINDS, ["dia", "depth", "groove_width", "groove_depth", "pocket_depth"]);
  assert.deepEqual(M.SCALES, [1, 2, 5, 10, 20]);
  assert.deepEqual(M.VIEW_KINDS, ["edge", "section", "groove_section", "detail", "cup_section"]);
  assert.equal(M.SHEET_KINDS.length, 5);
});
