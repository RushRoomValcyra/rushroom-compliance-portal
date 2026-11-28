// Drawing Templates phase 2 — the rule vocabulary of a part type
// (docs/DRAWING_TEMPLATES.md §3, §4.4, §10.2). One file for portal-api, the
// tests and the browser (index.html imports it as window.PortalRulesCore).
//
// A rule = a selector (terms that must all hold, no "or") + a measure + "at
// least". The engine (fusion_scripts/catch.py) evaluates selectors; this file
// only checks shapes, words and operations. Edge words are the part's own
// ("front", "rear", "bottom", "top", "inside", "outside"): the type's edge
// tests find them per part, so mirror parts read the same.
//
// Nothing here knows coordinates, STEP axes or hole ids: they are not legal
// in a type's rules (§3.2, "left out on purpose").

import { parseTolerance } from "./drawing-spec-core.mjs";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------
export const EDGE_WORDS = Object.freeze(["front", "rear", "bottom", "top"]);
export const FACE_WORDS = Object.freeze(["inside", "outside"]);
export const ACROSS_EDGES = Object.freeze(["front", "rear"]);
export const UP_EDGES = Object.freeze(["bottom", "top"]);
/** How each edge word is found on a part (§3.1). The opposite word follows. */
export const EDGE_TESTS = Object.freeze({
  front: Object.freeze(["as_modelled", "nearest_class", "away_from_groove"]),
  bottom: Object.freeze(["as_modelled"]),
  inside: Object.freeze(["most_blind", "as_modelled", "opens_class"]),
});
export const EDGE_TEST_NEEDS_D = Object.freeze(["nearest_class", "opens_class"]);
export const DEFAULT_EDGES = Object.freeze({
  front: Object.freeze({ test: "as_modelled" }),
  bottom: Object.freeze({ test: "as_modelled" }),
  inside: Object.freeze({ test: "most_blind" }),
});
/** "Drilled in" (§3.2): from the opening after two-sided holes are merged, never the engine's face field. */
/** "face" = any hole in a face, whichever way it opens (Top fixing, §3.7 rule 5: the buried Ø2 opens on neither). */
export const DRILLED = Object.freeze(["face", "inside", "outside", "both", "through", "neither", "edge"]);
export const TERM_KINDS = Object.freeze(["dia", "drilled", "through", "place", "column", "row", "spacing", "near"]);
export const PLACE_OPS = Object.freeze(["at", "within", "between"]);
/** A place "at" a distance matches within this (mm): a system line, not a range. */
export const PLACE_AT_TOL = 0.05;
export const CC_DIRS = Object.freeze(["up", "along", "thickness"]);
export const CC_MUST = Object.freeze(["can", "shall"]);
export const SPACING_DIRS = Object.freeze(["up", "across"]);
export const TOL_KEYS = Object.freeze(["pos", "cc", "dia", "depth"]);
export const RULE_OPS = Object.freeze(["add_rule", "set_rule", "remove_rule", "reorder_rules", "set_edges"]);
export const RULE_ID = /^r_[a-z0-9]{6,24}$/;
export const NAME_MAX = 60;
export const TEXT_MAX = 400;
export const MAX_RULES = 60;
export const MAX_TERMS = 8;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPos = (v) => isNum(v) && v > 0;
const isNonNeg = (v) => isNum(v) && v >= 0;
const isInt = (v) => Number.isInteger(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const str = (v) => (typeof v === "string" ? v.trim() : "");

/** 37 → "37", 12.5 → "12.5", 0.333 → "0.33". */
export function mm(v) {
  if (!isNum(v)) return "?";
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}
const ordinal = (n) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  return `${n}${s}`;
};

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------
/** The edges of a body with every missing key at its default. */
export function normaliseEdges(edges) {
  const e = isObj(edges) ? edges : {};
  const out = {};
  for (const key of Object.keys(EDGE_TESTS)) {
    const v = isObj(e[key]) ? e[key] : DEFAULT_EDGES[key];
    const t = { test: v.test };
    if (EDGE_TEST_NEEDS_D.includes(v.test) && v.D !== undefined) t.D = v.D;
    out[key] = t;
  }
  return out;
}

/** Errors in an edges object, [] when it holds. */
export function checkEdges(edges) {
  const errors = [];
  if (!isObj(edges)) return ["edges must be an object"];
  for (const k of Object.keys(edges)) {
    if (!EDGE_TESTS[k]) { errors.push(`unknown edge "${k}": front, bottom or inside`); continue; }
    const v = edges[k];
    if (!isObj(v) || !EDGE_TESTS[k].includes(v.test)) { errors.push(`${k}: test must be one of ${EDGE_TESTS[k].join(", ")}`); continue; }
    if (EDGE_TEST_NEEDS_D.includes(v.test) && !isPos(v.D)) errors.push(`${k}: ${v.test} needs the diameter of the class`);
    const extra = Object.keys(v).filter((x) => x !== "test" && !(x === "D" && EDGE_TEST_NEEDS_D.includes(v.test)));
    if (extra.length) errors.push(`${k}: unknown keys ${extra.join(", ")}`);
  }
  return errors;
}

const EDGE_TEST_WORDS = {
  as_modelled: () => "as modelled",
  nearest_class: (v) => `nearest the Ø${mm(v.D)} holes`,
  away_from_groove: () => "opposite the groove",
  most_blind: () => "most blind holes",
  opens_class: (v) => `where the Ø${mm(v.D)} holes open`,
};
const EDGE_LABEL = { front: "Front edge", bottom: "Bottom edge", inside: "Inside face" };

/** [{ key, label, test, words }] — the EDGES rows of the type page. */
export function describeEdges(edges) {
  const e = normaliseEdges(edges);
  return Object.keys(EDGE_TESTS).map((key) => ({
    key, label: EDGE_LABEL[key], test: e[key].test, words: (EDGE_TEST_WORDS[e[key].test] || (() => e[key].test))(e[key]),
  }));
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------
const edgeName = (w) => (FACE_WORDS.includes(w) ? `${w} face` : `${w} edge`);

/** Errors in one selector term. */
export function checkTerm(t) {
  if (!isObj(t) || !TERM_KINDS.includes(t.t)) return [`term must be one of ${TERM_KINDS.join(", ")}`];
  const e = [];
  const only = (keys) => {
    const extra = Object.keys(t).filter((k) => k !== "t" && !keys.includes(k));
    if (extra.length) e.push(`${t.t}: unknown keys ${extra.join(", ")}`);
  };
  switch (t.t) {
    case "dia":
      if (!isPos(t.D)) e.push("dia: D must be a diameter above 0");
      only(["D"]); break;
    case "drilled":
      if (!DRILLED.includes(t.v)) e.push(`drilled: v must be one of ${DRILLED.join(", ")}`);
      if (t.v === "edge" && !EDGE_WORDS.includes(t.edge)) e.push(`drilled into an edge names the edge: ${EDGE_WORDS.join(", ")}`);
      if (t.v !== "edge" && t.edge !== undefined) e.push("drilled: edge only with v edge");
      only(["v", "edge"]); break;
    case "through":
      if (!["through", "blind"].includes(t.v)) e.push("through: v must be through or blind");
      only(["v"]); break;
    case "place":
      if (!EDGE_WORDS.includes(t.edge)) e.push(`place: edge must be one of ${EDGE_WORDS.join(", ")}`);
      if (!PLACE_OPS.includes(t.op)) e.push(`place: op must be one of ${PLACE_OPS.join(", ")}`);
      if (!isNonNeg(t.v)) e.push("place: v must be a distance of 0 or more");
      if (t.op === "between") {
        if (!isNonNeg(t.v2) || !(t.v2 > t.v)) e.push("place: between needs v2 above v");
      } else if (t.v2 !== undefined) e.push("place: v2 only with between");
      if (t.op === "within" && !(t.v > 0)) e.push("place: within needs a distance above 0");
      only(["edge", "op", "v", "v2"]); break;
    case "column":
      if (!ACROSS_EDGES.includes(t.edge)) e.push("column: ranked from the front or the rear edge");
      if (!isInt(t.rank) || t.rank < 1 || t.rank > 20) e.push("column: rank 1 to 20");
      only(["edge", "rank"]); break;
    case "row":
      if (!UP_EDGES.includes(t.edge)) e.push("row: ranked from the bottom or the top edge");
      if (!isInt(t.rank) || t.rank < 1 || t.rank > 50) e.push("row: rank 1 to 50");
      only(["edge", "rank"]); break;
    case "spacing":
      if (!isPos(t.pitch)) e.push("spacing: pitch above 0");
      if (!SPACING_DIRS.includes(t.dir)) e.push("spacing: dir up or across");
      only(["pitch", "dir"]); break;
    case "near":
      if (!isPos(t.D)) e.push("near: D must be a diameter above 0");
      if (!isPos(t.within)) e.push("near: within must be a distance above 0");
      only(["D", "within"]); break;
  }
  return e;
}

/** One term in words: "Ø5", "37 from the front edge", "in the inside face" … */
export function describeTerm(t) {
  if (!isObj(t)) return "?";
  switch (t.t) {
    case "dia": return `Ø${mm(t.D)}`;
    case "drilled":
      return ({
        face: "in a face", inside: "in the inside face", outside: "in the outside face", both: "from both faces",
        through: "through", neither: "opening on neither face",
        edge: `into the ${t.edge} edge`,
      })[t.v] || "?";
    case "through": return t.v === "blind" ? "blind" : "through";
    case "place":
      if (t.op === "at") return `${mm(t.v)} from the ${edgeName(t.edge)}`;
      if (t.op === "within") return `within ${mm(t.v)} of the ${edgeName(t.edge)}`;
      return `between ${mm(t.v)} and ${mm(t.v2)} from the ${edgeName(t.edge)}`;
    case "column": return t.rank === 1 ? `in the column nearest the ${t.edge} edge` : `in the ${ordinal(t.rank)} column from the ${t.edge} edge`;
    case "row": return t.rank === 1 ? `in the row nearest the ${t.edge} edge` : `in the ${ordinal(t.rank)} row from the ${t.edge} edge`;
    case "spacing": return `spaced ${mm(t.pitch)} apart, ${t.dir}`;
    case "near": return `within ${mm(t.within)} of a Ø${mm(t.D)}`;
    default: return "?";
  }
}

/** A selector in words: "Ø5, 37 from the front edge". "any hole" when empty. */
export function describeSelect(select) {
  const terms = Array.isArray(select) ? select : [];
  return terms.length ? terms.map(describeTerm).join(", ") : "any hole";
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
/** Errors in one rule ([] when it holds). The edges are the type's. */
export function checkRule(rule, edges) {
  const e = [];
  if (!isObj(rule)) return ["rule must be an object"];
  if (!RULE_ID.test(String(rule.id || ""))) e.push("rule id must look like r_xxxxxx");
  const name = str(rule.name);
  if (!name) e.push("a rule needs a name");
  else if (name.length > NAME_MAX) e.push(`name at most ${NAME_MAX} characters`);
  for (const k of ["specifics", "mates_with"]) {
    if (rule[k] !== undefined && (typeof rule[k] !== "string" || rule[k].length > TEXT_MAX)) e.push(`${k}: text of at most ${TEXT_MAX} characters`);
  }
  if (!Array.isArray(rule.select)) e.push("select must be a list of terms");
  else {
    if (rule.select.length > MAX_TERMS) e.push(`at most ${MAX_TERMS} terms`);
    rule.select.forEach((t, i) => { for (const x of checkTerm(t)) e.push(`term ${i + 1}: ${x}`); });
    const kinds = rule.select.map((t) => t && t.t);
    for (const k of ["dia", "drilled", "through"]) if (kinds.filter((x) => x === k).length > 1) e.push(`one ${k} term at most`);
  }
  if (rule.at_least !== undefined && (!isInt(rule.at_least) || rule.at_least < 0 || rule.at_least > 999)) e.push("at least: a whole number 0 to 999");
  const m = rule.measure;
  if (m !== undefined && !isObj(m)) e.push("measure must be an object");
  if (isObj(m)) {
    const extra = Object.keys(m).filter((k) => !["across", "up", "thickness", "cc", "tol", "callout"].includes(k));
    if (extra.length) e.push(`measure: unknown keys ${extra.join(", ")}`);
    if (m.across !== undefined && !ACROSS_EDGES.includes(m.across)) e.push("across from the front or the rear edge");
    if (m.up !== undefined && !UP_EDGES.includes(m.up)) e.push("up from the bottom or the top edge");
    if (m.thickness !== undefined && !FACE_WORDS.includes(m.thickness)) e.push("thickness from the inside or the outside face");
    if (m.callout !== undefined && (typeof m.callout !== "string" || !m.callout.trim() || m.callout.length > NAME_MAX)) e.push(`callout name: 1 to ${NAME_MAX} characters`);
    if (m.cc !== undefined) {
      const c = m.cc;
      if (!isObj(c)) e.push("c/c must be an object");
      else {
        if (c.dir === "across") e.push("c/c across on a face is not built yet (Open decision 3)");
        else if (!CC_DIRS.includes(c.dir)) e.push(`c/c direction: ${CC_DIRS.join(", ")}`);
        if (!CC_MUST.includes(c.must)) e.push("c/c is: can be or shall be");
        if (c.pitch !== undefined && c.pitch !== null && !isPos(c.pitch)) e.push("c/c pitch above 0, or empty for as modelled");
        // One way per direction (§3.6): "shall be" c/c up leaves no hole to the up datum.
        if (c.must === "shall" && c.dir === "up" && m.up !== undefined) e.push("c/c up shall be and up from an edge: one or the other");
        const extra2 = Object.keys(c).filter((k) => !["dir", "must", "pitch"].includes(k));
        if (extra2.length) e.push(`c/c: unknown keys ${extra2.join(", ")}`);
      }
    }
    if (m.tol !== undefined) {
      if (!isObj(m.tol)) e.push("tolerances must be an object");
      else for (const [k, v] of Object.entries(m.tol)) {
        if (!TOL_KEYS.includes(k)) { e.push(`tolerance "${k}": ${TOL_KEYS.join(", ")}`); continue; }
        const p = parseTolerance(v);
        if (!p.ok) e.push(`${k} tolerance: ${p.reason}`);
      }
    }
  }
  // Edge words exist by construction (the type's tests always yield all six);
  // the edges themselves must hold.
  if (edges !== undefined) for (const x of checkEdges(edges)) e.push(`edges: ${x}`);
  return e;
}

/** A rule with its fields in canonical form (trimmed, tolerances spelt as drawset prints). */
export function normaliseRule(rule) {
  const r = clone(rule);
  r.name = str(r.name);
  for (const k of ["specifics", "mates_with"]) { if (r[k] !== undefined) { r[k] = str(r[k]); if (!r[k]) delete r[k]; } }
  r.select = Array.isArray(r.select) ? r.select : [];
  r.at_least = isInt(r.at_least) ? r.at_least : 0;
  r.measure = isObj(r.measure) ? r.measure : {};
  if (isObj(r.measure.tol)) {
    for (const [k, v] of Object.entries(r.measure.tol)) { const p = parseTolerance(v); if (p.ok) r.measure.tol[k] = p.text; }
    if (!Object.keys(r.measure.tol).length) delete r.measure.tol;
  }
  if (isObj(r.measure.cc) && (r.measure.cc.pitch === undefined || r.measure.cc.pitch === "")) r.measure.cc.pitch = null;
  if (typeof r.measure.callout === "string") r.measure.callout = r.measure.callout.trim();
  return r;
}

const TOL_WORDS = { pos: "position", cc: "c/c", dia: "diameter", depth: "depth" };

/** { name, takes, measured, specifics } — a rule in words, the same on every page (§4.3). */
export function describeRule(rule) {
  const r = isObj(rule) ? rule : {};
  const takes = describeSelect(r.select) + (isInt(r.at_least) && r.at_least > 0 ? ` · at least ${r.at_least}` : "");
  const m = isObj(r.measure) ? r.measure : {};
  const parts = [];
  if (m.across) parts.push(`across from the ${m.across} edge`);
  if (m.up) parts.push(`up from the ${m.up} edge`);
  if (m.thickness) parts.push(`from the ${m.thickness} face`);
  if (isObj(m.cc)) {
    const pitch = isNum(m.cc.pitch) ? ` ${mm(m.cc.pitch)}` : " as modelled";
    parts.push(`c/c${pitch} ${m.cc.dir}, pairs, ${m.cc.must === "shall" ? "shall be" : "can be"}`);
  }
  if (isObj(m.tol)) for (const k of TOL_KEYS) if (m.tol[k]) parts.push(`${TOL_WORDS[k]} ${m.tol[k]}`);
  if (m.callout) parts.push(`name "${m.callout}"`);
  if (r.mates_with) parts.push(`mates with ${r.mates_with}`);
  return { name: str(r.name) || "Rule", takes, measured: parts.length ? parts.join(" · ") : "from the Base default", specifics: r.specifics || "" };
}

/** A hole from the engine's catch output in words, by place, never by coordinates:
 *  "Ø5 · 105 from the front edge · 59 up". Edge holes name their edge. */
export function describeHole(hole) {
  if (!isObj(hole)) return "?";
  const f = isObj(hole.from) ? hole.from : {};
  const pick = (a, b) => (isNum(f[a]) && isNum(f[b]) ? (f[a] <= f[b] ? a : b) : (isNum(f[a]) ? a : (isNum(f[b]) ? b : null)));
  const out = [`Ø${mm(hole.D)}`];
  if (hole.drilled === "edge" && hole.edge) {
    out.push(`into the ${hole.edge} edge`);
    const along = UP_EDGES.includes(hole.edge) ? pick("front", "rear") : pick("bottom", "top");
    if (along) out.push(`${mm(f[along])} from the ${along} edge`);
    return out.join(" · ");
  }
  const a = pick("front", "rear");
  if (a) out.push(`${mm(f[a])} from the ${a} edge`);
  const u = pick("bottom", "top");
  if (u) out.push(u === "bottom" ? `${mm(f[u])} up` : `${mm(f[u])} from the top edge`);
  if (hole.drilled === "neither") out.push("opening on neither face");
  return out.join(" · ");
}

// ---------------------------------------------------------------------------
// Bodies and operations
// ---------------------------------------------------------------------------
/** { rules: [], edges } — the part of a type body phase 2 edits. */
export function emptyRuleBody() {
  return { rules: [], edges: normaliseEdges(null) };
}

export function normaliseRuleBody(body) {
  const b = isObj(body) ? body : {};
  return { rules: Array.isArray(b.rules) ? clone(b.rules) : [], edges: normaliseEdges(b.edges) };
}

/** Errors in one operation, [] when its shape holds (not yet against a body). */
export function checkRuleOp(op) {
  if (!isObj(op) || !RULE_OPS.includes(op.op)) return [`op must be one of ${RULE_OPS.join(", ")}`];
  const extra = (keys) => Object.keys(op).filter((k) => k !== "op" && k !== "marks" && !keys.includes(k));
  const e = [];
  switch (op.op) {
    case "add_rule": case "set_rule":
      e.push(...checkRule(op.rule));
      if (extra(["rule"]).length) e.push(`${op.op}: unknown keys ${extra(["rule"]).join(", ")}`);
      break;
    case "remove_rule":
      if (!RULE_ID.test(String(op.id || ""))) e.push("remove_rule: id");
      if (extra(["id"]).length) e.push(`remove_rule: unknown keys ${extra(["id"]).join(", ")}`);
      break;
    case "reorder_rules":
      if (!Array.isArray(op.ids) || op.ids.some((x) => !RULE_ID.test(String(x)))) e.push("reorder_rules: ids");
      if (extra(["ids"]).length) e.push(`reorder_rules: unknown keys ${extra(["ids"]).join(", ")}`);
      break;
    case "set_edges":
      e.push(...checkEdges(op.edges));
      if (extra(["edges"]).length) e.push(`set_edges: unknown keys ${extra(["edges"]).join(", ")}`);
      break;
  }
  if (op.marks !== undefined && !Array.isArray(op.marks)) e.push("marks must be a list");
  return e;
}

/**
 * applyRuleOps(body, ops) → { ok: true, body } | { ok: false, errors: [{ index, error }] }.
 * All or nothing: one bad operation leaves the body as it was. Operations
 * name rules by id, so a sandbox replays mechanically on a new version (§4.4).
 */
export function applyRuleOps(body, ops) {
  let b = normaliseRuleBody(body);
  const errors = [];
  (Array.isArray(ops) ? ops : []).forEach((op, index) => {
    const shape = checkRuleOp(op);
    if (shape.length) { for (const error of shape) errors.push({ index, error }); return; }
    const has = (id) => b.rules.some((r) => r.id === id);
    switch (op.op) {
      case "add_rule":
        if (has(op.rule.id)) { errors.push({ index, error: `rule ${op.rule.id} exists` }); return; }
        if (b.rules.length >= MAX_RULES) { errors.push({ index, error: `at most ${MAX_RULES} rules` }); return; }
        b.rules.push(normaliseRule(op.rule)); break;
      case "set_rule":
        if (!has(op.rule.id)) { errors.push({ index, error: `no rule ${op.rule.id}` }); return; }
        b.rules = b.rules.map((r) => (r.id === op.rule.id ? normaliseRule(op.rule) : r)); break;
      case "remove_rule":
        if (!has(op.id)) { errors.push({ index, error: `no rule ${op.id}` }); return; }
        b.rules = b.rules.filter((r) => r.id !== op.id); break;
      case "reorder_rules": {
        const ids = b.rules.map((r) => r.id);
        const same = op.ids.length === ids.length && new Set(op.ids).size === ids.length && op.ids.every((x) => ids.includes(x));
        if (!same) { errors.push({ index, error: "reorder_rules must list every rule once" }); return; }
        const by = new Map(b.rules.map((r) => [r.id, r]));
        b.rules = op.ids.map((x) => by.get(x)); break;
      }
      case "set_edges":
        b.edges = normaliseEdges({ ...b.edges, ...op.edges }); break;
    }
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, body: b };
}

/** One CHANGE line per operation (§4.4): "+ Lower pair", "− Top fixing",
 *  "Pin pairs, front changed", "Rules reordered", "Inside face · most blind holes". */
export function describeRuleOp(op, before) {
  const rules = normaliseRuleBody(before).rules;
  const nameOf = (id) => (rules.find((r) => r.id === id) || {}).name || "a rule";
  if (!isObj(op)) return "?";
  switch (op.op) {
    case "add_rule": return `+ ${str(op.rule && op.rule.name) || "Rule"}`;
    case "set_rule": return `${str(op.rule && op.rule.name) || nameOf(op.rule && op.rule.id)} changed`;
    case "remove_rule": return `− ${nameOf(op.id)}`;
    case "reorder_rules": return "Rules reordered";
    case "set_edges": return describeEdges({ ...normaliseRuleBody(before).edges, ...(op.edges || {}) })
      .filter((row) => isObj(op.edges) && op.edges[row.key]).map((row) => `${row.label} · ${row.words}`).join(" · ") || "Edges";
    default: return "?";
  }
}

/** The CHANGE list: each op described against the body it was applied to. */
export function describeRuleOps(startBody, ops) {
  let b = normaliseRuleBody(startBody);
  const lines = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    lines.push(describeRuleOp(op, b));
    const r = applyRuleOps(b, [op]);
    if (r.ok) b = r.body;
  }
  return lines;
}

/** A fresh rule id from 6+ random characters (the caller supplies the randomness). */
export function ruleIdFrom(seed) {
  const s = String(seed || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  return s.length >= 6 ? `r_${s}` : null;
}

// ---------------------------------------------------------------------------
// The catch (what the engine answers) — small readers the page and API share
// ---------------------------------------------------------------------------
/** Counts per rule id on one part of a catch output, plus "base_default". */
export function catchCounts(part) {
  const out = { base_default: 0 };
  if (!isObj(part) || part.status !== "ok") return null;
  for (const r of Array.isArray(part.rules) ? part.rules : []) out[r.id] = Array.isArray(r.taken) ? r.taken.length : 0;
  out.base_default = Array.isArray(part.base_default) ? part.base_default.length : 0;
  return out;
}

/** Overlap lines on one part (§3.6): "loses 1 hole to Top fixing", keyed by the losing rule.
 *  The later rule in the list wins (Open decision 7, proposed). */
export function overlapLines(part, rules) {
  const out = {};
  if (!isObj(part) || !Array.isArray(part.overlaps)) return out;
  const order = (Array.isArray(rules) ? rules : []).map((r) => r.id);
  const nameOf = (id) => ((Array.isArray(rules) ? rules : []).find((r) => r.id === id) || {}).name || id;
  const tally = {};
  for (const o of part.overlaps) {
    const ids = (o.rules || []).slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const winner = ids[ids.length - 1];
    for (const loser of ids.slice(0, -1)) {
      tally[loser] = tally[loser] || {};
      tally[loser][winner] = (tally[loser][winner] || 0) + 1;
    }
  }
  for (const [loser, by] of Object.entries(tally)) {
    out[loser] = Object.entries(by).map(([w, n]) => `loses ${n} ${n === 1 ? "hole" : "holes"} to ${nameOf(w)}`);
  }
  return out;
}
