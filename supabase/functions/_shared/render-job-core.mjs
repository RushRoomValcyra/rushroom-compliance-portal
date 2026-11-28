/* Rushroom AB — Engineering & Compliance Platform: the drawing render job's
 * pure rules (docs/DRAWING_RENDER.md).
 *
 * Pure functions, no DOM, no network, no Deno/Node APIs. ONE file for two
 * users, so the step list the portal writes and the one the tests expect
 * cannot drift apart (the test-agent-core.mjs pattern):
 *   - portal-api (requestDrawingRender … finishDrawingRender)
 *   - the tests (tests/drawing-render.test.mjs)
 *
 * The helpers have the same shapes as test-agent-core's (newSteps, setStep,
 * skipRemaining, normaliseSteps, timeoutPatch) but are keyed to the six render
 * steps. They are a separate module rather than a parameterised test-agent
 * core: each core stays one page that can be read whole, and the two step
 * lists have different owners (the add-in, the drawing worker).
 */

// ---------------------------------------------------------------------------
// Steps — fixed order, fixed keys (DRAWING_RENDER.md §2)
// ---------------------------------------------------------------------------
export const STEPS = [
  { key: "claim",    label: "Claim" },
  { key: "download", label: "Download STEP" },
  { key: "render",   label: "Render" },
  { key: "verify",   label: "Verify" },
  { key: "upload",   label: "Upload PDF" },
  { key: "register", label: "Register issue" },
];
export const STEP_KEYS = STEPS.map((s) => s.key);
/** Reported by the worker with reportDrawingRenderStep (steps 2–5). */
export const WORKER_STEP_KEYS = ["download", "render", "verify", "upload"];
/** Set by the portal: `claim` by the poll, `register` by finishDrawingRender. */
export const PORTAL_STEP_KEYS = ["claim", "register"];
export const STEP_STATUSES = ["pending", "running", "passed", "failed", "skipped"];

/** Job statuses (drawing_render_jobs.status CHECK). */
export const JOB_STATUSES = ["requested", "running", "done", "failed", "timed_out", "cancelled"];
export const OPEN_STATUSES = ["requested", "running"];

/** A job not claimed within this many ms of requested_at → timed_out. */
export const CLAIM_TIMEOUT_MS = 120_000;
/** A job running for longer than this since claimed_at → failed. */
export const RUN_TIMEOUT_MS = 900_000;
export const CLAIM_TIMEOUT_ERROR = "no drawing worker picked the job up";
export const RUN_TIMEOUT_ERROR = "worker stopped reporting";

/** All six steps, pending, in contract order. */
export function newSteps() {
  return STEPS.map((s) => ({ key: s.key, label: s.label, status: "pending", detail: null, at: null, data: null }));
}

/** A step list that may be missing or partial brought to the full six, in
 *  order, keeping what was recorded. */
export function normaliseSteps(steps) {
  const byKey = new Map();
  for (const s of Array.isArray(steps) ? steps : []) if (s && s.key) byKey.set(s.key, s);
  return STEPS.map((s) => {
    const have = byKey.get(s.key);
    return {
      key: s.key, label: s.label,
      status: have && STEP_STATUSES.includes(have.status) ? have.status : "pending",
      detail: have && have.detail != null ? String(have.detail) : null,
      at: have && have.at ? have.at : null,
      // Structured facts the worker attached (the verify step's sha256s, the
      // render step's drawset version).
      data: have && have.data && typeof have.data === "object" ? have.data : null,
    };
  });
}

/** New list with one step changed. `at` is an ISO string the caller supplies
 *  (the function keeps no clock of its own). Unknown key → list unchanged. */
export function setStep(steps, key, status, detail, at, data) {
  return normaliseSteps(steps).map((s) => s.key === key
    ? { ...s, status, detail: detail == null ? s.detail : String(detail).slice(0, 2000), at: at ?? s.at,
        data: data && typeof data === "object" && !Array.isArray(data) ? { ...(s.data || {}), ...data } : s.data }
    : s);
}

/** Every step still pending or running among `keys` (default: all) → skipped. */
export function skipRemaining(steps, keys = STEP_KEYS, at) {
  return normaliseSteps(steps).map((s) =>
    keys.includes(s.key) && (s.status === "pending" || s.status === "running")
      ? { ...s, status: "skipped", at: at ?? s.at }
      : s);
}

/** The step the worker is on: the running one, else the first pending one. */
export function activeStep(steps) {
  const list = normaliseSteps(steps);
  return list.find((s) => s.status === "running") || list.find((s) => s.status === "pending") || null;
}

/** Close a job as failed: the active step fails with the reason, the rest are
 *  skipped. Returns the patch to write (status, error, finished_at, steps). */
export function failPatch(steps, error, at) {
  const reason = String(error ?? "render failed").slice(0, 2000);
  let list = normaliseSteps(steps);
  const active = activeStep(list);
  if (active) list = setStep(list, active.key, "failed", reason, at);
  return { status: "failed", error: reason, finished_at: at, steps: skipRemaining(list, STEP_KEYS, at) };
}

/** The lazy timeouts (DRAWING_RENDER.md §3, last paragraph). Pure: the caller
 *  passes the clock. Returns the patch to write, or null when the job is fine
 *  as it stands. */
export function timeoutPatch(job, nowMs) {
  if (!job) return null;
  const now = typeof nowMs === "number" ? nowMs : Date.parse(String(nowMs));
  const at = new Date(now).toISOString();
  if (job.status === "requested") {
    const requested = Date.parse(job.requested_at);
    if (Number.isFinite(requested) && now - requested > CLAIM_TIMEOUT_MS) {
      return { status: "timed_out", error: CLAIM_TIMEOUT_ERROR, finished_at: at, steps: skipRemaining(job.steps, STEP_KEYS, at) };
    }
    return null;
  }
  if (job.status === "running") {
    const claimed = Date.parse(job.claimed_at || job.requested_at);
    if (Number.isFinite(claimed) && now - claimed > RUN_TIMEOUT_MS) {
      return failPatch(job.steps, RUN_TIMEOUT_ERROR, at);
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Title block — what the worker writes on the sheet (DRAWING_RENDER.md §4, poll)
// ---------------------------------------------------------------------------
/** First eight characters of a sha256, lower case, or null. */
export const sha8 = (sha) => sha ? String(sha).trim().toLowerCase().slice(0, 8) : null;

/** { drawing_number, issue, title, part_number, part_name, cad_revision,
 *    cad_sha8, date } — date is YYYY-MM-DD of `at` (ISO string or ms). */
export function titleBlock({ drawing, job, component, revision, file, at } = {}) {
  const when = typeof at === "number" ? new Date(at) : new Date(at ?? Date.now());
  return {
    drawing_number: drawing ? drawing.drawing_number ?? null : null,
    issue: job ? String(job.issue ?? "").toUpperCase() || null : null,
    title: drawing ? drawing.title ?? null : null,
    part_number: component ? component.part_number ?? null : null,
    part_name: component ? component.name ?? null : null,
    cad_revision: revision ? String(revision.revision ?? "").toUpperCase() || null : null,
    cad_sha8: sha8(file ? file.sha256 : null),
    date: Number.isFinite(when.getTime()) ? when.toISOString().slice(0, 10) : null,
  };
}

/** A spec name as the worker registers it: the YAML file stem — letters,
 *  digits, "-_." only, at most 120 characters. Returns null when unusable. */
export function normaliseSpecName(name) {
  const s = String(name ?? "").trim();
  return s && s.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s) ? s : null;
}

/** One registered spec row from what the worker sent, or null when the name
 *  is unusable. part_numbers keeps strings only; parts a non-negative integer.
 *  Since DYNAMIC_DRAWINGS §3.2 the worker also sends `template` (the YAML is
 *  a template, not a per-part spec) and `body` (the parsed YAML). `template`
 *  is kept as a boolean; `body` is kept only when it is a plain object — it is
 *  NOT a column of drawing_render_specs (registerDrawingSpecs lifts it into
 *  drawing_spec_versions and drops it before the upsert). */
export function normaliseSpec(spec) {
  const name = normaliseSpecName(spec && spec.name);
  if (!name) return null;
  const partsN = Number(spec.parts);
  const part_numbers = Array.isArray(spec.part_numbers)
    ? [...new Set(spec.part_numbers.map((p) => String(p ?? "").trim().toUpperCase()).filter(Boolean))].slice(0, 200)
    : [];
  const out = {
    name,
    title: spec.title != null ? String(spec.title).slice(0, 200) : null,
    parts: Number.isInteger(partsN) && partsN >= 0 ? partsN : null,
    part_numbers,
  };
  // Only when the worker sent them: a worker from before §3.2 registers the
  // same row it always did.
  if (spec.template !== undefined) out.template = spec.template === true;
  if (spec.body !== undefined) {
    out.body = spec.body && typeof spec.body === "object" && !Array.isArray(spec.body) ? spec.body : null;
  }
  return out;
}

/** The newest updated_at among spec rows, or null. */
export function lastSeen(specs) {
  let best = null;
  for (const s of specs || []) {
    const t = s && s.updated_at ? Date.parse(s.updated_at) : NaN;
    if (Number.isFinite(t) && (best == null || t > best)) best = t;
  }
  return best == null ? null : new Date(best).toISOString();
}

// ---------------------------------------------------------------------------
// Template items — the queue of portal-born renders that write no drawing
// (docs/DRAWING_TEMPLATES.md §5.2). The poll is the pump: it takes an item only
// when no real job is requested, so real renders always go first.
// ---------------------------------------------------------------------------
/** The pump's order across purposes: lower index first. */
export const ITEM_PUMP_ORDER = ["features", "catch", "preview", "rebase", "reference", "try"];

/** The next queued item to hand out, or null. Within a purpose the oldest
 *  created_at goes first, then the lower id (a stable tie-break). Items in any
 *  other status, or with a purpose outside the order, are never picked. */
export function pickNextItem(items) {
  const rank = (p) => ITEM_PUMP_ORDER.indexOf(p);
  const queued = (Array.isArray(items) ? items : []).filter((it) => it && it.status === "queued" && rank(it.purpose) >= 0);
  if (!queued.length) return null;
  const time = (it) => { const t = Date.parse(it.created_at); return Number.isFinite(t) ? t : Infinity; };
  queued.sort((a, b) =>
    rank(a.purpose) - rank(b.purpose)
    || time(a) - time(b)
    || String(a.id ?? "").localeCompare(String(b.id ?? "")));
  return queued[0];
}

/** The title block of a sandbox render: build_temp_spec requires a drawing
 *  number and an issue, and a fixed value makes a stray sheet recognisable. */
export function sandboxTitleBlock(partName, cadRevision) {
  const tb = { drawing_number: "SANDBOX", issue: "S", title: partName || "Reference" };
  // The sheet's change line reads "From CAD Rev <letter>" (worker build_temp_spec).
  if (cadRevision) tb.cad_revision = String(cadRevision);
  return tb;
}

/** An item claimed by the pump that still has no job after this long was
 *  orphaned (the function died between claim and insert): the pump fails it. */
export const ITEM_CLAIM_STALE_MS = 120_000;

/** setComponentPartType's rule for one part (DRAWING_TEMPLATES §4.6):
 *  `comp` the part row or null, `targetId` the type asked for (null = clear),
 *  `refType` the part type whose reference this part is, or null.
 *  → { kind: "refused", reason } | { kind: "unchanged" } | { kind: "change", from }. */
export function partTypeChange(comp, targetId, refType) {
  if (!comp) return { kind: "refused", reason: "Part not found" };
  const from = comp.part_type_id ?? null;
  const to = targetId ?? null;
  if (from === to) return { kind: "unchanged" };
  if (refType && refType.id !== to) return { kind: "refused", reason: `Reference of part type ${refType.name}` };
  return { kind: "change", from };
}

/** The checks a finished sandbox job must pass before its item is done:
 *  the STEP it drew is the item's, the template body is the pinned version's,
 *  and a PDF plus at least one sheet were uploaded. A failed verify is a
 *  result, not a failure (verify_ok false).
 *  → { error } | { source, verify_ok, verify }. */
export function sandboxFinishCheck({ result, bodySourceSha, itemCadSha, versionSha, sheets }) {
  const res = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const hex = (v) => /^[0-9a-f]{64}$/i.test(String(v ?? "")) ? String(v).toLowerCase() : null;
  const source = hex(res.source_sha256) ?? hex(bodySourceSha);
  if (!source || source !== String(itemCadSha ?? "").toLowerCase()) return { error: "STEP changed while drawing" };
  const specSha = hex(res.spec_sha256) ?? hex(res.spec_body_sha256);
  if (!versionSha || !specSha || specSha !== String(versionSha).toLowerCase()) return { error: "Template changed while drawing" };
  if (!sheets || !sheets.pdf || !Array.isArray(sheets.pngs) || !sheets.pngs.length) return { error: "No sheets uploaded" };
  const verify = res.verify && typeof res.verify === "object" && !Array.isArray(res.verify) ? res.verify : null;
  const verify_ok = res.verify_ok !== false && !(verify && String(verify.regression ?? "OK").toUpperCase() === "FAIL");
  return { source, verify_ok, verify };
}

// ---------------------------------------------------------------------------
// Drawing Templates phase 2 — the feature cache and the catch (§3, §5.2, §5.3)
// ---------------------------------------------------------------------------
/** The raw-features format the portal caches under. MUST equal
 *  fusion_scripts/catch.py's FEATURES_FORMAT: a cache row of another format is
 *  never handed to the engine. */
export const FEATURES_FORMAT = 1;

const hex64 = (v) => /^[0-9a-f]{64}$/i.test(String(v ?? "")) ? String(v).toLowerCase() : null;
const plainObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The checks a finished `features` job must pass before its cache row is
 *  written: the STEP it read is the item's, the format is the portal's, and
 *  features is an object. → { error } | { features_format, features, cad_sha256, drawset_version }. */
export function featuresFinishCheck({ result, itemCadSha }) {
  const res = plainObj(result) ? result : {};
  const sha = hex64(res.cad_sha256);
  if (!sha || sha !== String(itemCadSha ?? "").toLowerCase()) return { error: "STEP changed while reading its features" };
  const format = Number(res.features_format);
  if (format !== FEATURES_FORMAT) {
    return { error: `features format ${Number.isFinite(format) ? format : "missing"}; the portal reads format ${FEATURES_FORMAT}` };
  }
  if (!plainObj(res.features)) return { error: "No features returned" };
  return {
    features_format: FEATURES_FORMAT, features: res.features, cad_sha256: sha,
    drawset_version: res.drawset_version != null ? String(res.drawset_version).slice(0, 80) : null,
  };
}

/** A features read that failed is not asked again at once: a STEP that cannot
 *  be read would otherwise be downloaded and failed ahead of every catch.
 *  One (file, sha) waits FEATURES_RETRY_COOLDOWN_MS after a failure, and after
 *  FEATURES_MAX_FAILS failures inside FEATURES_FAIL_WINDOW_MS it waits until
 *  the oldest of them leaves the window. A cache row or new bytes (another
 *  sha) are not held back by any of this. */
export const FEATURES_RETRY_COOLDOWN_MS = 10 * 60_000;
export const FEATURES_MAX_FAILS = 3;
export const FEATURES_FAIL_WINDOW_MS = 24 * 3_600_000;

/** The key a STEP's features are cached and queued under. */
export const featureKey = (cadFileId, sha) => `${cadFileId}:${String(sha ?? "").toLowerCase()}`;

const itemTime = (it) => {
  const t = Date.parse(it && (it.finished_at || it.created_at));
  return Number.isFinite(t) ? t : NaN;
};

/** The (file, sha) keys whose features must not be queued again now.
 *  `items` features items [{ cad_file_id, cad_sha256, status, finished_at, created_at }]
 *  (other statuses are ignored), `nowMs` the clock. → Set of featureKey. */
export function featureRetryBlocked(items, nowMs) {
  const fails = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || it.status !== "failed" || !it.cad_file_id || !it.cad_sha256) continue;
    const t = itemTime(it);
    if (!Number.isFinite(t) || nowMs - t > FEATURES_FAIL_WINDOW_MS) continue;
    const k = featureKey(it.cad_file_id, it.cad_sha256);
    const f = fails.get(k) || { count: 0, newest: -Infinity };
    f.count++;
    if (t > f.newest) f.newest = t;
    fails.set(k, f);
  }
  const blocked = new Set();
  for (const [k, f] of fails) {
    if (f.count >= FEATURES_MAX_FAILS || nowMs - f.newest < FEATURES_RETRY_COOLDOWN_MS) blocked.add(k);
  }
  return blocked;
}

/** Why a STEP has no features: per (file, sha), the error of its newest
 *  features item when that item failed. A newer queued, running or done item
 *  means the read is under way or made, so that key has no entry.
 *  `items` [{ cad_file_id, cad_sha256, status, error, created_at }]. → Map featureKey → error. */
export function featureErrors(items) {
  const newest = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !it.cad_file_id || !it.cad_sha256) continue;
    const t = Date.parse(it.created_at);
    const at = Number.isFinite(t) ? t : -Infinity;
    const k = featureKey(it.cad_file_id, it.cad_sha256);
    const cur = newest.get(k);
    if (!cur || at > cur.at) newest.set(k, { at, it });
  }
  const out = new Map();
  for (const [k, { it }] of newest) if (it.status === "failed") out.set(k, String(it.error || "Failed"));
  return out;
}

/** The checks a finished `catch` job must pass: an output with a parts list,
 *  one row per part the item asked for. → { error } | { catch, drawset_version }. */
export function catchFinishCheck({ result, itemParts }) {
  const res = plainObj(result) ? result : {};
  const out = res.catch;
  if (!plainObj(out) || !Array.isArray(out.parts)) return { error: "No catch returned" };
  const asked = new Set((Array.isArray(itemParts) ? itemParts : []).map((p) => p && p.component_id).filter(Boolean));
  const got = new Set(out.parts.map((p) => p && p.key).filter(Boolean));
  const missing = [...asked].filter((k) => !got.has(k));
  if (missing.length) return { error: `The catch has no answer for ${missing.length} of ${asked.size} parts` };
  return { catch: out, drawset_version: res.drawset_version != null ? String(res.drawset_version).slice(0, 80) : null };
}

/** The engine's catch input (fusion_scripts/catch.py, contract §1) from what the
 *  portal holds: the Base's datums, the sandbox's rules and edges, the item's
 *  parts and the cached features (null when missing: the engine answers
 *  "no_features" for that part), and the mark.
 *  `cache` maps `${cad_file_id}:${sha256}` → features; `labels` component id → name. */
export function buildCatchInput({ datums, rules, edges, parts, cache, labels, mark }) {
  const d = plainObj(datums) ? datums : {};
  const base = { datums: {} };
  for (const k of ["x", "y", "inside_face"]) if (d[k] !== undefined) base.datums[k] = d[k];
  const c = cache instanceof Map ? cache : new Map(Object.entries(cache || {}));
  const l = labels instanceof Map ? labels : new Map(Object.entries(labels || {}));
  return {
    base,
    edges: plainObj(edges) ? edges : {},
    rules: Array.isArray(rules) ? rules : [],
    parts: (Array.isArray(parts) ? parts : []).map((p) => ({
      key: p.component_id,
      label: l.get(p.component_id) ?? null,
      cad_sha256: p.cad_sha256 ?? null,
      features: c.get(`${p.cad_file_id}:${String(p.cad_sha256 ?? "").toLowerCase()}`) ?? null,
    })),
    mark: plainObj(mark) && mark.component_id && mark.hole_id
      ? { key: String(mark.component_id), hole_id: String(mark.hole_id) }
      : null,
  };
}

/** A part's STEP for the sandbox (DRAWING_TEMPLATES §4.4, Try on): of the
 *  released revisions that have a STEP with a sha, the highest letter.
 *  `revs` [{ id, revision }], `stepOf` revision id → { id, sha256 }, `compare`
 *  the revision comparator. → { cad_model_revision_id, revision, cad_file_id, cad_sha256 } | null. */
export function newestReleasedStep(revs, stepOf, compare) {
  const withStep = (Array.isArray(revs) ? revs : []).filter((r) => r && stepOf.get(r.id) && stepOf.get(r.id).sha256);
  if (!withStep.length) return null;
  withStep.sort((a, b) => compare(b.revision, a.revision));
  const r = withStep[0];
  const f = stepOf.get(r.id);
  return { cad_model_revision_id: r.id, revision: r.revision, cad_file_id: f.id, cad_sha256: String(f.sha256).toLowerCase() };
}
