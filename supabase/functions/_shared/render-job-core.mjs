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
 *  is unusable. part_numbers keeps strings only; parts a non-negative integer. */
export function normaliseSpec(spec) {
  const name = normaliseSpecName(spec && spec.name);
  if (!name) return null;
  const partsN = Number(spec.parts);
  const part_numbers = Array.isArray(spec.part_numbers)
    ? [...new Set(spec.part_numbers.map((p) => String(p ?? "").trim().toUpperCase()).filter(Boolean))].slice(0, 200)
    : [];
  return {
    name,
    title: spec.title != null ? String(spec.title).slice(0, 200) : null,
    parts: Number.isInteger(partsN) && partsN >= 0 ? partsN : null,
    part_numbers,
  };
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
