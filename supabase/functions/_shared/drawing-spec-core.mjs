/* Rushroom AB — Engineering & Compliance Platform: the drawing spec patch's
 * pure rules (docs/DYNAMIC_DRAWINGS.md §3.3, §4.4, §5).
 *
 * Pure functions, no DOM, no network, no Deno/Node-only APIs (sha256 goes
 * through globalThis.crypto.subtle, which Deno, Node ≥ 18 and the browser all
 * have). ONE file for four users, so the vocabulary cannot drift apart:
 *   - portal-api  (applyDrawingSpecOps: validateOps → applySpecOps, canonicalSha
 *                  for patch_sha256 / spec_body_sha256, touchedEntities)
 *   - portal-ai   (proposeDrawingSpecOps: the op enum of its JSON schema is
 *                  Object.keys(SPEC_VOCAB); the proposal is re-validated here)
 *   - the browser (diffDimensionLists for the compare strip)
 *   - the tests   (tests/drawing-spec-core.test.mjs)
 *
 * The one rule everything here enforces: NO FIELD CAN HOLD A PRINTED VALUE.
 * drawset prints what it measures in the STEP; a patch carries tolerances,
 * names, datum rules and selectors only. A bare number in a tolerance or name
 * field is refused; the only numbers admitted are the selectors and
 * thresholds drawset already owns (D, pos, only_at, cc, within, offset,
 * y_from_top_within, scale, y_range, *_shown, box, index, part).
 *
 * Ops in, snapshot out. An op carries intent and a reason (what the dialogue,
 * the audit and the diff speak); the snapshot is what the worker hands drawset
 * under `patch:` and what an issue cites by sha. The portal never merges the
 * patch into the template — drawset does (apply_patch), so there is one copy
 * of the derivation.
 *
 * Axes: drawset's hole axes are upper case (AX = 'XYZ'; feature_rule compares
 * them exactly), so hole/at/through axes are normalised to upper case here.
 * Datum axes (set_datum) are the lower-case keys datums.x / datums.y.
 */

// ---------------------------------------------------------------------------
// Closed sets
// ---------------------------------------------------------------------------
export const TOLERANCE_KINDS = [
  "general", "outline", "hole_position", "hole_depth", "edge_bore_depth",
  "pocket_depth", "groove_width", "groove_depth", "counterbore_depth",
];
/** Per-dimension override kinds. No pos_* in v1 (§4.3: ptol is per face sheet). */
export const OVERRIDE_KINDS = ["dia", "depth", "groove_width", "groove_depth", "pocket_depth"];
export const VIEW_KINDS = ["edge", "section", "groove_section", "detail", "cup_section"];
export const SHEET_KINDS = ["overview", "face", "door_overview", "hinge_sheet", "part_sheet"];
/** House scales. 2:1 and 5:1 are the integers 2 and 5 (drawset prints n:1 when S ≥ 1 on a detail). */
export const SCALES = [1, 2, 5, 10, 20];
export const EDGES = ["x_min", "x_max", "y_min", "y_max", "z_min", "z_max"];
export const SIDES = ["min", "max"];
export const HOLE_AXES = ["X", "Y", "Z"];
export const DATUM_AXES = ["x", "y"];
export const ORIENTS = ["portrait", "landscape"];
export const FACES = ["inside", "outside"];
export const CTQ_COLUMNS = ["rearmost", "frontmost"];
/** Portal facts build_temp_spec writes; never a patch's business (§3.3). */
export const PORTAL_FACT_KEYS = ["title", "drawing_number", "issue", "date", "set_name"];
export const REASON_MAX = 160;
export const PATCH_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Argument types used by SPEC_VOCAB. An arg's type is either one of these
// strings or an array (an enum of admitted values).
//   tol        tolerance string in the house grammar (ISO 2768-x only for general)
//   text       free text, never a bare number (names, captions, labels)
//   text_null  text or null (clears an edge band)
//   number     finite number ≥ 0 (a selector or threshold drawset owns)
//   integer    finite integer ≥ 1 (a sheet number, a part index)
//   index      finite integer ≥ 0 (a view's groove / hole index)
//   scale      one of SCALES
//   at         a geometric address (§3.5)
//   only_at    [[x, y], …]
//   range      [a, b] numbers, a ≤ b
//   id         a view id (A, B-B, cup) — text, never a bare number
//   id_list    [id, …]
//   labels     { z_min?: text, z_max?: text }
//   through    { D, axis?, open_at?, index? } — the hole class a section cuts
//   around     { D, index? } — the hole a detail is drawn around
//   box        { x_from_datum, y_half } — a detail's window (selectors, not printed)
//   ctq_end    { D, column }
//   about      { D } — the hole class a pair sits symmetrically about
// ---------------------------------------------------------------------------
export const SPEC_VOCAB = Object.freeze({
  set_tolerance:     { args: { kind: TOLERANCE_KINDS, tol: "tol" }, required: ["kind", "tol"] },
  set_inside_face:   { args: { side: SIDES }, required: ["side"] },
  set_datum:         { args: { axis: DATUM_AXES, side: SIDES }, required: ["axis", "side"] },
  set_from_top_rule: { args: { within: "number" }, required: ["within"] },
  name_edge:         { args: { edge: EDGES, name: "text" }, required: ["edge", "name"] },
  set_edge_band:     { args: { edge: EDGES, text: "text_null" }, required: ["edge", "text"] },
  set_hole_rule:     { args: { D: "number", axis: HOLE_AXES, name: "text", dia_tol: "tol", depth_tol: "tol", only_at: "only_at" }, required: ["D", "axis"] },
  remove_hole_rule:  { args: { D: "number", axis: HOLE_AXES, only_at: "only_at" }, required: ["D", "axis"] },
  override_dimension:{ args: { at: "at", kind: OVERRIDE_KINDS, tol: "tol", name: "text" }, required: ["at", "kind"] },
  remove_override:   { args: { at: "at", kind: OVERRIDE_KINDS }, required: ["at", "kind"] },
  add_pair:          { args: { D: "number", cc: "number", about: "about" }, required: ["D", "cc"] },
  remove_pair:       { args: { D: "number", cc: "number" }, required: ["D", "cc"] },
  add_ctq:           { args: { a: "ctq_end", b: "ctq_end", within: "number", label: "text" }, required: ["a", "b", "within", "label"] },
  remove_ctq:        { args: { label: "text" }, required: ["label"] },
  set_view:          { args: { id: "id", scale: "scale", caption: "text", y_max_shown: "number", y_min_shown: "number", x_shown: "number", labels: "labels" }, required: ["id"] },
  add_view:          { args: { kind: VIEW_KINDS, edge: EDGES, through: "through", normal: ["x"], groove: "index", around: "around", box: "box", scale: "scale", caption: "text", y_max_shown: "number", y_min_shown: "number", x_shown: "number", labels: "labels" }, required: ["kind"] },
  remove_view:       { args: { id: "id" }, required: ["id"] },
  set_sheet:         { args: { sheet: "integer", scale: "scale", orient: ORIENTS, y_range: "range", views: "id_list" }, required: ["sheet"] },
  add_sheet:         { args: { kind: SHEET_KINDS, orient: ORIENTS, scale: "scale", y_range: "range", views: "id_list", face: FACES, part: "index" }, required: ["kind"] },
  remove_sheet:      { args: { sheet: "integer" }, required: ["sheet"] },
});
export const OPS = Object.freeze(Object.keys(SPEC_VOCAB));

/** What each view kind must carry besides `kind` (drawset reads these without a default). */
export const VIEW_KIND_REQUIRED = Object.freeze({
  edge: ["edge"],
  section: ["through"],
  groove_section: ["groove"],
  detail: ["around", "box"],
  cup_section: ["through"],
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const BARE_NUMBER = /^\s*[-+−]?\d+(?:[.,]\d+)?\s*(?:mm)?\s*$/i;
/** "12", " 0.5 ", "-3", "12 mm" — a value, not a tolerance or a name. */
export const isBareNumber = (v) => isNum(v) || (typeof v === "string" && BARE_NUMBER.test(v));
const near = (a, b, eps = 0.01) => isNum(a) && isNum(b) && Math.abs(a - b) < eps;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------------------
// Tolerance grammar — ±n | +n -n | +n -0 | 0 -n | ISO 2768-[fmcv]
// ---------------------------------------------------------------------------
const NUM = "\\d+(?:\\.\\d+)?";
const RE_SYM = new RegExp(`^(?:\\u00b1|\\+/-|\\+-)\\s*(${NUM})$`);
const RE_ASYM = new RegExp(`^(\\+?${NUM})\\s+[-\\u2212](${NUM})$`);
const RE_ISO = /^ISO\s*2768\s*-\s*([fmcv])$/i;

const stripNum = (s) => {
  // "0.50" → "0.5", "0.0" → "0", "1.0" → "1"; leaves "0.3" alone.
  if (!s.includes(".")) return s;
  const t = s.replace(/0+$/, "").replace(/\.$/, "");
  return t === "" ? "0" : t;
};

/**
 * parseTolerance("+0.3 -0") → { ok: true, form: "asym", text: "+0.3 -0" }
 * parseTolerance("±0.2")    → { ok: true, form: "sym",  text: "±0.2" }
 * parseTolerance("ISO 2768-m", { general: true }) → { ok: true, form: "iso", text: "ISO 2768-m" }
 * Anything else → { ok: false, reason }. A bare number is a value and is named as such.
 * `text` is the canonical spelling drawset prints (ASCII minus, no stray spaces).
 */
export function parseTolerance(str, opts = {}) {
  const general = !!(opts && opts.general);
  if (typeof str !== "string") {
    if (isNum(str)) return { ok: false, reason: `bare number ${str} is a value, not a tolerance; write ±n, +n -n, +n -0 or 0 -n` };
    return { ok: false, reason: "tolerance must be a string in the house grammar (±n, +n -n, +n -0, 0 -n)" };
  }
  const s = str.trim().replace(/−/g, "-");
  if (s === "") return { ok: false, reason: "tolerance is empty" };
  if (isBareNumber(s)) return { ok: false, reason: `bare number "${str.trim()}" is a value, not a tolerance; write ±n, +n -n, +n -0 or 0 -n` };
  let m = s.match(RE_SYM);
  if (m) return { ok: true, form: "sym", text: `±${stripNum(m[1])}` };
  m = s.match(RE_ASYM);
  if (m) {
    const plus = m[1].replace(/^\+/, "");
    const text = `${plus === "0" || stripNum(plus) === "0" ? "+0" : "+" + stripNum(plus)} -${stripNum(m[2])}`;
    return { ok: true, form: "asym", text };
  }
  m = s.match(RE_ISO);
  if (m) {
    if (!general) return { ok: false, reason: "ISO 2768 is the general tolerance only; a kind or a dimension takes ±n, +n -n, +n -0 or 0 -n" };
    return { ok: true, form: "iso", text: `ISO 2768-${m[1].toLowerCase()}` };
  }
  return { ok: false, reason: `"${str.trim()}" is not a tolerance; write ±n, +n -n, +n -0 or 0 -n${general ? " or ISO 2768-[fmcv]" : ""}` };
}

// ---------------------------------------------------------------------------
// Addresses (§3.5) — hole { type, axis, D, pos }, groove { type, axis, offset, edge? },
// pocket { type, at: [x, y] }. Matched ±0.01 mm like drawset's at_match.
// ---------------------------------------------------------------------------
export const AT_TYPES = ["hole", "groove", "pocket"];

function checkAt(at) {
  if (!isObj(at)) return "at must be an object { type, … }";
  if (!AT_TYPES.includes(at.type)) return `at.type must be one of ${AT_TYPES.join(", ")}`;
  const allowed = at.type === "hole" ? ["type", "axis", "D", "pos"]
    : at.type === "groove" ? ["type", "axis", "offset", "edge"]
    : ["type", "at"];
  for (const k of Object.keys(at)) if (!allowed.includes(k)) return `unknown key at.${k}`;
  if (at.type === "hole") {
    if (!isAxis(at.axis)) return "at.axis must be X, Y or Z";
    if (!isNum(at.D) || at.D <= 0) return "at.D must be a positive number";
    if (!Array.isArray(at.pos) || at.pos.length !== 2 || !at.pos.every(isNum)) return "at.pos must be [p0, p1]";
  } else if (at.type === "groove") {
    if (!isAxis(at.axis)) return "at.axis must be X, Y or Z";
    if (!isNum(at.offset)) return "at.offset must be a number";
    if (at.edge !== undefined && !SIDES.includes(at.edge)) return "at.edge must be min or max";
  } else if (!Array.isArray(at.at) || at.at.length !== 2 || !at.at.every(isNum)) {
    return "at.at must be [x, y] (the pocket's floor centre)";
  }
  return null;
}
const isAxis = (a) => typeof a === "string" && HOLE_AXES.includes(a.toUpperCase());
const normAt = (at) => {
  const o = clone(at);
  if (o.axis) o.axis = String(o.axis).toUpperCase();
  return o;
};

/** Two addresses point at the same feature (positions within 0.01 mm). */
export function atEquals(a, b) {
  if (!isObj(a) || !isObj(b) || a.type !== b.type) return false;
  const ax = (o) => String(o.axis || "").toUpperCase();
  if (a.type === "hole") {
    return ax(a) === ax(b) && near(a.D, b.D)
      && Array.isArray(a.pos) && Array.isArray(b.pos) && a.pos.length === 2 && b.pos.length === 2
      && near(a.pos[0], b.pos[0]) && near(a.pos[1], b.pos[1]);
  }
  if (a.type === "groove") {
    return ax(a) === ax(b) && near(a.offset, b.offset) && (a.edge == null || b.edge == null || a.edge === b.edge);
  }
  if (a.type === "pocket") {
    return Array.isArray(a.at) && Array.isArray(b.at) && a.at.length === 2 && b.at.length === 2
      && near(a.at[0], b.at[0]) && near(a.at[1], b.at[1]);
  }
  return false;
}

const onlyAtEquals = (a, b) => {
  if (a == null && b == null) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((p, i) => near(p[0], b[i][0]) && near(p[1], b[i][1]));
};

// ---------------------------------------------------------------------------
// Validation (§3.3 rules) — one op in, { ok: op } or { reason } out
// ---------------------------------------------------------------------------
function checkArg(name, type, v, ctx) {
  // ctx = { op } so "tol" can know whether ISO is admitted.
  if (Array.isArray(type)) {
    if (type === HOLE_AXES) return isAxis(v) ? null : `${name} must be X, Y or Z`;
    return type.includes(v) ? null : `${name} must be one of ${type.join(", ")}`;
  }
  switch (type) {
    case "tol": {
      const general = ctx.op === "set_tolerance" && ctx.kind === "general";
      const p = parseTolerance(v, { general });
      return p.ok ? null : `${name}: ${p.reason}`;
    }
    case "text":
      if (typeof v !== "string") return isNum(v) ? `${name}: bare number ${v} is a value, not a name` : `${name} must be text`;
      if (isBareNumber(v)) return `${name}: bare number "${v.trim()}" is a value, not a name`;
      return null;
    case "text_null":
      if (v === null) return null;
      return checkArg(name, "text", v, ctx);
    case "id":
      if (typeof v !== "string" || v.trim() === "") return `${name} must be a view id`;
      if (isBareNumber(v)) return `${name}: "${v}" is not a view id`;
      return null;
    case "id_list":
      if (!Array.isArray(v)) return `${name} must be a list of view ids`;
      for (const x of v) { const r = checkArg(name + "[]", "id", x, ctx); if (r) return r; }
      return null;
    case "number":
      return isNum(v) && v >= 0 ? null : `${name} must be a number ≥ 0`;
    case "integer":
      return Number.isInteger(v) && v >= 1 ? null : `${name} must be an integer ≥ 1`;
    case "index":
      return Number.isInteger(v) && v >= 0 ? null : `${name} must be an integer ≥ 0`;
    case "scale":
      return SCALES.includes(v) ? null : `${name} must be one of ${SCALES.join(", ")} (2:1 and 5:1 are 2 and 5)`;
    case "at":
      return checkAt(v);
    case "only_at":
      if (!Array.isArray(v) || v.length === 0) return `${name} must be [[x, y], …]`;
      if (!v.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum))) return `${name} must be [[x, y], …]`;
      return null;
    case "range":
      if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum) || v[0] > v[1]) return `${name} must be [a, b] with a ≤ b`;
      return null;
    case "labels": {
      if (!isObj(v)) return `${name} must be { z_min?, z_max? }`;
      for (const k of Object.keys(v)) {
        if (!["z_min", "z_max"].includes(k)) return `unknown key ${name}.${k}`;
        const r = checkArg(`${name}.${k}`, "text", v[k], ctx); if (r) return r;
      }
      return null;
    }
    case "through": {
      if (!isObj(v)) return `${name} must be { D, axis?, open_at?, index? }`;
      for (const k of Object.keys(v)) if (!["D", "axis", "open_at", "index"].includes(k)) return `unknown key ${name}.${k}`;
      if (!isNum(v.D) || v.D <= 0) return `${name}.D must be a positive number`;
      if (v.axis !== undefined && !isAxis(v.axis)) return `${name}.axis must be X, Y or Z`;
      if (v.open_at !== undefined && !SIDES.includes(v.open_at)) return `${name}.open_at must be min or max`;
      if (v.index !== undefined && !(Number.isInteger(v.index) && v.index >= 0)) return `${name}.index must be an integer ≥ 0`;
      return null;
    }
    case "around": {
      if (!isObj(v)) return `${name} must be { D, index? }`;
      for (const k of Object.keys(v)) if (!["D", "index"].includes(k)) return `unknown key ${name}.${k}`;
      if (!isNum(v.D) || v.D <= 0) return `${name}.D must be a positive number`;
      if (v.index !== undefined && !(Number.isInteger(v.index) && v.index >= 0)) return `${name}.index must be an integer ≥ 0`;
      return null;
    }
    case "box": {
      if (!isObj(v)) return `${name} must be { x_from_datum, y_half }`;
      for (const k of Object.keys(v)) if (!["x_from_datum", "y_half"].includes(k)) return `unknown key ${name}.${k}`;
      if (!isNum(v.x_from_datum) || !isNum(v.y_half)) return `${name} must be { x_from_datum, y_half } (numbers)`;
      return null;
    }
    case "ctq_end": {
      if (!isObj(v)) return `${name} must be { D, column }`;
      for (const k of Object.keys(v)) if (!["D", "column"].includes(k)) return `unknown key ${name}.${k}`;
      if (!isNum(v.D) || v.D <= 0) return `${name}.D must be a positive number`;
      if (!CTQ_COLUMNS.includes(v.column)) return `${name}.column must be ${CTQ_COLUMNS.join(" or ")}`;
      return null;
    }
    case "about": {
      if (!isObj(v)) return `${name} must be { D }`;
      for (const k of Object.keys(v)) if (k !== "D") return `unknown key ${name}.${k}`;
      if (!isNum(v.D) || v.D <= 0) return `${name}.D must be a positive number`;
      return null;
    }
    default:
      return `internal: unknown arg type ${type}`;
  }
}

/** Validate one op → { ok: normalisedOp } | { reason }. */
export function validateOp(raw) {
  if (!isObj(raw)) return { reason: "op must be an object" };
  const name = raw.op;
  if (typeof name !== "string" || !OPS.includes(name)) {
    return { reason: `unknown op ${JSON.stringify(name === undefined ? null : name)}; the vocabulary is ${OPS.join(", ")}` };
  }
  const def = SPEC_VOCAB[name];
  // Portal facts first, so the refusal says why rather than "unknown key".
  for (const k of Object.keys(raw)) {
    if (PORTAL_FACT_KEYS.includes(k)) return { reason: `${k} is a portal fact written at render time, not a patch field` };
  }
  for (const k of Object.keys(raw)) {
    if (k === "op" || k === "reason") continue;
    if (!(k in def.args)) return { reason: `unknown key ${k} for ${name}` };
  }
  if (!("reason" in raw) || typeof raw.reason !== "string") return { reason: `${name}: reason must be a string (may be empty)` };
  if (raw.reason.length > REASON_MAX) return { reason: `${name}: reason longer than ${REASON_MAX} characters` };
  for (const k of def.required) {
    if (raw[k] === undefined) return { reason: `${name}: ${k} is required` };
  }
  const out = { op: name, reason: raw.reason };
  const ctx = { op: name, kind: raw.kind };
  for (const [k, type] of Object.entries(def.args)) {
    if (raw[k] === undefined) continue;
    const r = checkArg(k, type, raw[k], ctx);
    if (r) return { reason: `${name}: ${r}` };
    let v = clone(raw[k]);
    if (type === "tol") v = parseTolerance(raw[k], { general: ctx.op === "set_tolerance" && ctx.kind === "general" }).text;
    else if (type === HOLE_AXES) v = String(v).toUpperCase();
    else if (type === "at") v = normAt(v);
    else if (type === "through" && v.axis) v.axis = String(v.axis).toUpperCase();
    out[k] = v;
  }
  // Cross-field rules
  switch (name) {
    case "override_dimension":
      if (out.tol === undefined && out.name === undefined) return { reason: "override_dimension: give tol or name (or both)" };
      if (out.name !== undefined && out.kind !== "dia") return { reason: "override_dimension: name only with kind dia (the callout names the hole, not its depth)" };
      if ((out.kind === "groove_width" || out.kind === "groove_depth") && out.at.type !== "groove") return { reason: `override_dimension: kind ${out.kind} needs a groove address` };
      if (out.kind === "pocket_depth" && out.at.type !== "pocket") return { reason: "override_dimension: kind pocket_depth needs a pocket address" };
      if ((out.kind === "dia" || out.kind === "depth") && out.at.type !== "hole") return { reason: `override_dimension: kind ${out.kind} needs a hole address` };
      break;
    case "set_hole_rule":
      if (out.name === undefined && out.dia_tol === undefined && out.depth_tol === undefined) return { reason: "set_hole_rule: give name, dia_tol or depth_tol" };
      break;
    case "add_view": {
      const need = VIEW_KIND_REQUIRED[out.kind] || [];
      for (const k of need) if (out[k] === undefined) return { reason: `add_view: a ${out.kind} view needs ${need.join(" and ")}` };
      const allowed = ["kind", "scale", "caption", "labels", ...need,
        ...(out.kind === "section" ? ["normal", "y_max_shown", "y_min_shown"] : []),
        ...(out.kind === "groove_section" || out.kind === "cup_section" ? ["x_shown"] : [])];
      for (const k of Object.keys(out)) {
        if (k === "op" || k === "reason") continue;
        if (!allowed.includes(k)) return { reason: `add_view: ${k} does not apply to a ${out.kind} view` };
      }
      break;
    }
    case "add_sheet":
      if (out.kind === "face" && out.y_range === undefined) return { reason: "add_sheet: a face sheet needs y_range" };
      if (out.kind === "part_sheet" && out.part === undefined) return { reason: "add_sheet: a part_sheet needs part" };
      break;
    default:
      break;
  }
  return { ok: out };
}

/** validateOps(ops) → { ok: [normalised ops], rejected: [{ op, reason }] }. Never throws on bad input. */
export function validateOps(ops) {
  const ok = [], rejected = [];
  if (!Array.isArray(ops)) return { ok, rejected: [{ op: ops, reason: "ops must be an array" }] };
  for (const raw of ops) {
    const r = validateOp(raw);
    if (r.ok) ok.push(r.ok); else rejected.push({ op: raw, reason: r.reason });
  }
  return { ok, rejected };
}

// ---------------------------------------------------------------------------
// The snapshot (§3.3 schema 1)
// ---------------------------------------------------------------------------
export function emptyPatch(base) {
  return {
    v: PATCH_SCHEMA_VERSION,
    base: base === undefined ? null : clone(base),
    tolerances: {}, datums: {}, edge_names: {}, edge_band: {},
    features: [], pairs: [], ctq: [], overrides: [],
    views: { set: {}, add: [], remove: [] },
    sheets: { set: {}, add: [], remove: [] },
  };
}

/** A full copy of `patch` with every schema-1 key present (so handlers never test for undefined). */
function normalisePatch(patch) {
  const p = emptyPatch(patch && patch.base !== undefined ? patch.base : null);
  if (!isObj(patch)) return p;
  for (const k of ["tolerances", "datums", "edge_names", "edge_band"]) if (isObj(patch[k])) p[k] = clone(patch[k]);
  for (const k of ["features", "pairs", "ctq", "overrides"]) if (Array.isArray(patch[k])) p[k] = clone(patch[k]);
  for (const k of ["views", "sheets"]) {
    if (!isObj(patch[k])) continue;
    if (isObj(patch[k].set)) p[k].set = clone(patch[k].set);
    if (Array.isArray(patch[k].add)) p[k].add = clone(patch[k].add);
    if (Array.isArray(patch[k].remove)) p[k].remove = clone(patch[k].remove);
  }
  // Keys schema 1 does not know (a hand-written _note, say) travel along untouched.
  for (const k of Object.keys(patch)) if (!(k in p)) p[k] = clone(patch[k]);
  return p;
}

const stripOp = (op, ...drop) => {
  const o = {};
  for (const [k, v] of Object.entries(op)) if (k !== "op" && k !== "reason" && !drop.includes(k)) o[k] = v;
  return o;
};
const featureKey = (row, op) => near(row.D, op.D) && String(row.axis || "").toUpperCase() === String(op.axis || "").toUpperCase()
  && onlyAtEquals(row.only_at, op.only_at);
const pairKey = (row, op) => near(row.D, op.D) && near(row.cc, op.cc);

/** One handler per op. Each returns null (applied) or a reason string (rejected, patch unchanged). */
export const OP_HANDLERS = Object.freeze({
  set_tolerance(p, op) { p.tolerances[op.kind] = op.tol; return null; },
  set_inside_face(p, op) { p.datums.inside_face = op.side; return null; },
  set_datum(p, op) { p.datums[op.axis] = op.side; return null; },
  set_from_top_rule(p, op) { p.datums.y_from_top_within = op.within; return null; },
  name_edge(p, op) { p.edge_names[op.edge] = op.name; return null; },
  set_edge_band(p, op) { p.edge_band[op.edge] = op.text; return null; },
  set_hole_rule(p, op) {
    const row = stripOp(op);
    const i = p.features.findIndex((r) => featureKey(r, op));
    const prev = p.features[i];
    if (i < 0) p.features.push(row);
    else p.features[i] = { ...prev, ...row, D: prev.D, axis: prev.axis, ...(prev.only_at ? { only_at: prev.only_at } : {}) };
    return null;
  },
  remove_hole_rule(p, op) {
    const n = p.features.length;
    p.features = p.features.filter((r) => !featureKey(r, op));
    return p.features.length === n ? `no hole rule for Ø${op.D} ${op.axis}${op.only_at ? " at " + JSON.stringify(op.only_at) : ""} in this patch` : null;
  },
  override_dimension(p, op) {
    const row = stripOp(op);
    const i = p.overrides.findIndex((r) => r.kind === op.kind && atEquals(r.at, op.at));
    // The address that first registered the override stays the key; tol/name merge.
    if (i < 0) p.overrides.push(row); else p.overrides[i] = { ...p.overrides[i], ...row, at: p.overrides[i].at };
    return null;
  },
  remove_override(p, op) {
    const n = p.overrides.length;
    p.overrides = p.overrides.filter((r) => !(r.kind === op.kind && atEquals(r.at, op.at)));
    return p.overrides.length === n ? `no ${op.kind} override at ${canonicalJson(op.at)} in this patch` : null;
  },
  add_pair(p, op) {
    const row = stripOp(op);
    const i = p.pairs.findIndex((r) => pairKey(r, op));
    if (i < 0) p.pairs.push(row); else p.pairs[i] = { ...p.pairs[i], ...row };
    return null;
  },
  remove_pair(p, op) {
    const n = p.pairs.length;
    p.pairs = p.pairs.filter((r) => !pairKey(r, op));
    return p.pairs.length === n ? `no pair Ø${op.D} c/c ${op.cc} in this patch` : null;
  },
  add_ctq(p, op) {
    const row = stripOp(op);
    const i = p.ctq.findIndex((r) => r.label === op.label);
    if (i < 0) p.ctq.push(row); else p.ctq[i] = row;
    return null;
  },
  remove_ctq(p, op) {
    const n = p.ctq.length;
    p.ctq = p.ctq.filter((r) => r.label !== op.label);
    return p.ctq.length === n ? `no CTQ labelled "${op.label}" in this patch` : null;
  },
  set_view(p, op) {
    const knobs = stripOp(op, "id");
    if (Object.keys(knobs).length === 0) return "set_view: nothing to set";
    p.views.remove = p.views.remove.filter((id) => id !== op.id);
    p.views.set[op.id] = { ...(p.views.set[op.id] || {}), ...knobs };
    return null;
  },
  add_view(p, op) { p.views.add.push(stripOp(op)); return null; },
  remove_view(p, op) {
    delete p.views.set[op.id];
    if (!p.views.remove.includes(op.id)) p.views.remove.push(op.id);
    return null;
  },
  set_sheet(p, op) {
    const knobs = stripOp(op, "sheet");
    if (Object.keys(knobs).length === 0) return "set_sheet: nothing to set";
    const key = String(op.sheet);
    p.sheets.remove = p.sheets.remove.filter((n) => Number(n) !== op.sheet);
    p.sheets.set[key] = { ...(p.sheets.set[key] || {}), ...knobs };
    return null;
  },
  add_sheet(p, op) { p.sheets.add.push(stripOp(op)); return null; },
  remove_sheet(p, op) {
    delete p.sheets.set[String(op.sheet)];
    if (!p.sheets.remove.some((n) => Number(n) === op.sheet)) p.sheets.remove.push(op.sheet);
    return null;
  },
});

/**
 * applySpecOps(patch, ops) → { patch, rejected }. A new snapshot object (v: 1,
 * base kept); the input is never mutated. Ops are validated first; a rejected
 * op is reported with its reason and the rest are applied in order.
 */
export function applySpecOps(patch, ops) {
  const out = normalisePatch(patch);
  const { ok, rejected } = validateOps(ops);
  for (const op of ok) {
    const r = OP_HANDLERS[op.op](out, op);
    if (r) rejected.push({ op, reason: r });
  }
  return { patch: out, rejected };
}

// ---------------------------------------------------------------------------
// Canonical JSON and sha256
// ---------------------------------------------------------------------------
/** Keys sorted recursively, no whitespace, JSON.stringify semantics for values. Stable across runtimes. */
export function canonicalJson(v) {
  if (v === undefined) return undefined;
  return canon(v);
}
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map((x) => { const s = canon(x); return s === undefined ? "null" : s; }).join(",") + "]";
  if (v !== null && typeof v === "object") {
    if (typeof v.toJSON === "function") return canon(v.toJSON());
    const parts = [];
    for (const k of Object.keys(v).sort()) {
      const s = canon(v[k]);
      if (s !== undefined) parts.push(JSON.stringify(k) + ":" + s);
    }
    return "{" + parts.join(",") + "}";
  }
  return JSON.stringify(v); // string, number (NaN/Infinity → null), boolean, null; undefined/function → undefined
}

/** sha256 hex. A string is hashed as given; anything else goes through canonicalJson first. */
export async function canonicalSha(v) {
  const text = typeof v === "string" ? v : canonicalJson(v);
  const bytes = new TextEncoder().encode(text === undefined ? "" : text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Dimension lists — rows { sheet, feature, kind, value, text, tol, view, at }
// ---------------------------------------------------------------------------
/** The compare key: the geometric address when the row has one, else the feature id; plus the kind. */
export function dimKey(row) {
  const head = row && row.at != null ? canonicalJson(row.at) : String(row && row.feature);
  return head + "|" + (row && row.kind);
}

/** Rows by key. The same (at, kind) printed on two sheets gets #2, #3 … in (sheet, view) order. */
function indexDims(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const k = dimKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const m = new Map();
  for (const [k, list] of groups) {
    list.sort((a, b) => (Number(a.sheet) - Number(b.sheet)) || String(a.view || "").localeCompare(String(b.view || "")));
    list.forEach((r, i) => m.set(i === 0 ? k : `${k}#${i + 1}`, r));
  }
  return m;
}
const valueEq = (a, b) => near(Number(a), Number(b), 1e-6);

/**
 * diffDimensionLists(a, b) → { added, removed, value_changed, tol_changed, text_changed, same, counts }.
 * Precedence per row: value > tol > text. Each entry carries the key and the
 * row(s): added/removed { key, row }, changes { key, feature, kind, at, sheet, before, after }.
 */
export function diffDimensionLists(a, b) {
  const A = indexDims(a), B = indexDims(b);
  const out = { added: [], removed: [], value_changed: [], tol_changed: [], text_changed: [], same: [] };
  for (const [k, rb] of B) if (!A.has(k)) out.added.push({ key: k, row: rb });
  for (const [k, ra] of A) {
    const rb = B.get(k);
    if (!rb) { out.removed.push({ key: k, row: ra }); continue; }
    const e = { key: k, feature: rb.feature, kind: rb.kind, at: rb.at === undefined ? null : rb.at, sheet: rb.sheet, before: ra, after: rb };
    if (!valueEq(ra.value, rb.value)) out.value_changed.push(e);
    else if ((ra.tol || "") !== (rb.tol || "")) out.tol_changed.push(e);
    else if ((ra.text || "") !== (rb.text || "")) out.text_changed.push(e);
    else out.same.push(e);
  }
  out.counts = {
    a: A.size, b: B.size,
    added: out.added.length, removed: out.removed.length,
    value_changed: out.value_changed.length, tol_changed: out.tol_changed.length,
    text_changed: out.text_changed.length, same: out.same.length,
  };
  return out;
}

// ---------------------------------------------------------------------------
// touchedEntities — which dimension rows an op would change (the blast radius
// shown before the render job runs)
// ---------------------------------------------------------------------------
const THICKNESS_AXIS = "Z";
const isHoleRow = (r) => isObj(r.at) && r.at.type === "hole";
const holeAxis = (r) => String(r.at.axis || "").toUpperCase();
const POS_KINDS = ["pos", "pos_x", "pos_y", "pos_y_top", "cc", "twin", "ends_in", "from", "to"];

/** Rows a kind-level tolerance governs. `general` governs the title block, not a row. */
function rowsForToleranceKind(kind, dims) {
  switch (kind) {
    case "general": return [];
    case "outline": return dims.filter((r) => r.feature === "outline" || (isObj(r.at) && r.at.type === "outline"));
    case "hole_position": return dims.filter((r) => isHoleRow(r) && POS_KINDS.includes(r.kind));
    case "hole_depth": return dims.filter((r) => isHoleRow(r) && r.kind === "depth" && holeAxis(r) === THICKNESS_AXIS);
    case "edge_bore_depth": return dims.filter((r) => isHoleRow(r) && r.kind === "depth" && holeAxis(r) !== THICKNESS_AXIS);
    case "counterbore_depth": return dims.filter((r) => isHoleRow(r) && /cbore|counterbore/.test(String(r.kind)));
    case "pocket_depth": case "groove_width": case "groove_depth":
      return dims.filter((r) => r.kind === kind);
    default: return [];
  }
}

function rowsForOp(op, dims) {
  switch (op.op) {
    case "override_dimension": case "remove_override":
      return dims.filter((r) => r.kind === op.kind && atEquals(r.at, op.at));
    case "set_tolerance":
      return rowsForToleranceKind(op.kind, dims);
    case "set_hole_rule": case "remove_hole_rule": {
      const kinds = op.op === "remove_hole_rule" ? ["dia", "depth"]
        : [...(op.name !== undefined || op.dia_tol !== undefined ? ["dia"] : []), ...(op.depth_tol !== undefined ? ["depth"] : [])];
      return dims.filter((r) => isHoleRow(r) && kinds.includes(r.kind) && near(r.at.D, op.D) && holeAxis(r) === String(op.axis).toUpperCase()
        && (!op.only_at || op.only_at.some((p) => near(p[0], r.at.pos[0]) && near(p[1], r.at.pos[1]))));
    }
    case "set_datum":
      return dims.filter((r) => isHoleRow(r) && (op.axis === "x" ? ["pos_x", "pos"] : ["pos_y", "pos_y_top", "pos"]).includes(r.kind));
    case "set_inside_face":
      return dims.filter((r) => isHoleRow(r) && r.kind === "depth");
    case "set_from_top_rule":
      return dims.filter((r) => isHoleRow(r) && ["pos_y", "pos_y_top"].includes(r.kind));
    case "set_view": case "remove_view":
      return dims.filter((r) => r.view === op.id || String(r.view || "").endsWith(" " + op.id));
    case "set_sheet": case "remove_sheet":
      return dims.filter((r) => Number(r.sheet) === op.sheet);
    default:
      return []; // name_edge, set_edge_band, pairs, ctq, add_view, add_sheet print nothing that exists yet
  }
}

/** touchedEntities(ops, dims) → [{ feature, kind, at, sheet }], deduped, in dimension-list order. */
export function touchedEntities(ops, dims) {
  const rows = Array.isArray(dims) ? dims : [];
  const { ok } = validateOps(Array.isArray(ops) ? ops : []);
  const seen = new Set(), out = [];
  for (const op of ok) {
    for (const r of rowsForOp(op, rows)) {
      const k = `${r.sheet}|${r.feature}|${r.kind}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ feature: r.feature, kind: r.kind, at: r.at === undefined ? null : r.at, sheet: r.sheet });
    }
  }
  return out;
}
