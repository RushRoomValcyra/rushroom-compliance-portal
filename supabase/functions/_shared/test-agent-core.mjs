/* Rushroom AB — Engineering & Compliance Platform: the CAD change-order test
 * agent's pure rules (docs/TEST_AGENT.md).
 *
 * Pure functions, no DOM, no network, no Deno/Node APIs. ONE file for two
 * users, so the verdict the portal writes and the verdict the tests expect
 * cannot drift apart (the status-core.mjs pattern):
 *   - portal-api (requestCadTestRun predicts, finishCadTestRun verifies)
 *   - the tests (tests/cad-test-agent.test.mjs)
 *
 * The run proves ONE seam: a Fusion save + STEP send on a part lands on the
 * right letter, with the right name and version, and changes nothing a
 * supplier can reach. The letter policy itself lives in status-core.mjs and is
 * imported, never restated, so the prediction uses the same rule the send does.
 */
import { compareRevision, deriveObject, nextRevisionLetter } from "./status-core.mjs";

// ---------------------------------------------------------------------------
// Steps — fixed order, fixed keys (TEST_AGENT.md "Steps")
// ---------------------------------------------------------------------------
export const STEPS = [
  { key: "claim",      label: "Claim" },
  { key: "open",       label: "Open document" },
  { key: "change",     label: "Change" },
  { key: "save",       label: "Save" },
  { key: "stamp",      label: "Stamp" },
  { key: "export",     label: "Export STEP" },
  { key: "send",       label: "Send to portal" },
  { key: "naming",     label: "Naming" },
  { key: "versioning", label: "Versioning" },
  { key: "status",     label: "Status" },
  { key: "supplier",   label: "Supplier view" },
  { key: "changelog",  label: "Changelog" },
];
export const STEP_KEYS = STEPS.map((s) => s.key);
/** Reported by the add-in with reportCadTestStep. */
export const FUSION_STEP_KEYS = ["claim", "open", "change", "save", "stamp", "export", "send"];
/** Computed by finishCadTestRun through verifyRun. */
export const PORTAL_STEP_KEYS = ["naming", "versioning", "status", "supplier", "changelog"];
export const STEP_STATUSES = ["pending", "running", "passed", "failed", "skipped"];

/** A run not claimed within this many ms of requested_at → timed_out. */
export const CLAIM_TIMEOUT_MS = 120_000;
/** A run running for longer than this since claimed_at → failed. */
export const RUN_TIMEOUT_MS = 600_000;
export const CLAIM_TIMEOUT_ERROR = "Fusion add-in did not pick the run up";
export const RUN_TIMEOUT_ERROR = "add-in stopped reporting";

/** What bom_component_history must have gained for the changelog step. */
export const CHANGELOG_NOTE = /CAD revision \w+ (re-)?registered \(step\)/;

/** All twelve steps, pending, in contract order. */
export function newSteps() {
  return STEPS.map((s) => ({ key: s.key, label: s.label, status: "pending", detail: null, at: null, data: null }));
}

/** A step list that may be missing or partial (an old row) brought to the
 *  full twelve, in order, keeping what was recorded. */
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
      // Structured facts the add-in attached (the save step's version numbers).
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

/** The lazy timeouts (TEST_AGENT.md "Steps", last paragraph). Pure: the
 *  caller passes the clock. Returns the patch to write, or null when the run
 *  is fine as it stands. */
export function timeoutPatch(run, nowMs) {
  if (!run) return null;
  const now = typeof nowMs === "number" ? nowMs : Date.parse(String(nowMs));
  const at = new Date(now).toISOString();
  if (run.status === "requested") {
    const requested = Date.parse(run.requested_at);
    if (Number.isFinite(requested) && now - requested > CLAIM_TIMEOUT_MS) {
      return { status: "timed_out", error: CLAIM_TIMEOUT_ERROR, finished_at: at, steps: skipRemaining(run.steps, STEP_KEYS, at) };
    }
    return null;
  }
  if (run.status === "running") {
    const claimed = Date.parse(run.claimed_at || run.requested_at);
    if (Number.isFinite(claimed) && now - claimed > RUN_TIMEOUT_MS) {
      // The step the add-in was on fails with the reason; the rest are skipped.
      let steps = normaliseSteps(run.steps);
      const active = steps.find((s) => s.status === "running")
        || steps.find((s) => s.status === "pending");
      if (active) steps = setStep(steps, active.key, "failed", RUN_TIMEOUT_ERROR, at);
      return { status: "failed", error: RUN_TIMEOUT_ERROR, finished_at: at, steps: skipRemaining(steps, STEP_KEYS, at) };
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Snapshot shape (TEST_AGENT.md "Snapshot shape")
// ---------------------------------------------------------------------------
const norm = (r) => String(r ?? "").trim().toUpperCase();

/** Mirror of lib/exports.py safe_file_stem: letters and digits (any script),
 *  "-_. " kept, everything else "_", cut at `limit`, trimmed. The add-in names
 *  every export this way, so the naming step expects exactly this. */
export function safeFileStem(name, limit = 120) {
  const chars = Array.from(String(name ?? "")).map((c) => (/[\p{L}\p{N}]/u.test(c) || "-_. ".includes(c)) ? c : "_");
  // Code points, as Python slices, never UTF-16 units.
  const stem = Array.from(chars.join("").trim()).slice(0, limit).join("").trim();
  return stem || "export";
}
/** The STEP file name the add-in produces for a document name. */
export const expectedStepName = (docName) => `${safeFileStem(docName)}.step`;

/** The STEP file of a revision, or null. */
export function stepFileOf(revision) {
  if (!revision || !Array.isArray(revision.files)) return null;
  return revision.files.find((f) => f && String(f.format).toLowerCase() === "step") || null;
}

/** The revision of a snapshot carrying a given letter, or null. */
export function revisionOf(snapshot, letter) {
  const want = norm(letter);
  return ((snapshot && snapshot.revisions) || []).find((r) => norm(r.revision) === want) || null;
}

/** What a supplier can reach for this part — the same rule the supplier
 *  actions use: released only, and only drawings flagged supplier-visible.
 *  cadRevisions: [{ revision, status }]
 *  drawings:     [{ drawing_number, is_supplier_visible, revisions: [{ revision, status }] }]
 *  → { cad_released_revision, drawings: [{ drawing_number, released_revision }] } (drawings sorted) */
export function snapshotSupplierView({ cadRevisions, drawings } = {}) {
  const cad = deriveObject(cadRevisions || []);
  const out = [];
  for (const d of drawings || []) {
    if (!d || d.is_supplier_visible === false) continue;
    const { released } = deriveObject(d.revisions || []);
    if (!released) continue;                                   // no released issue → invisible
    out.push({ drawing_number: String(d.drawing_number ?? ""), released_revision: norm(released.revision) });
  }
  out.sort((a, b) => a.drawing_number.localeCompare(b.drawing_number, undefined, { numeric: true, sensitivity: "base" }));
  return { cad_released_revision: cad.released ? norm(cad.released.revision) : null, drawings: out };
}

const revisionOut = (r) => ({
  id: r.id, revision: norm(r.revision), status: r.status,
  fusion_version: r.fusion_version ?? null,
  files: (r.files || []).map((f) => ({
    id: f.id, format: f.format, file_name: f.file_name ?? null,
    fusion_version: f.fusion_version ?? null, sha256: f.sha256 ?? null,
  })),
});

/** Build a before/after snapshot from loaded rows. Pure: the caller loads.
 *  component:   { part_number, name }
 *  model:       { fusion_document_id, fusion_document_name, status } | null
 *  revisions:   loadCadRevisions() output (letter-sorted, each with files[])
 *  drawings:    [{ id, drawing_number, role, is_supplier_visible, revisions }]
 *  historyCount: bom_component_history rows for the part
 *  warnings:    statusSummary(...).warnings, already computed by the caller */
export function buildSnapshot({ at, component, model, revisions, drawings, historyCount, warnings } = {}) {
  const revs = [...(revisions || [])].sort((a, b) => compareRevision(a.revision, b.revision));
  const derived = deriveObject(revs);
  const brief = (r) => r ? {
    id: r.id, revision: norm(r.revision), status: r.status,
    fusion_version: (stepFileOf(r) || {}).fusion_version ?? r.fusion_version ?? null,
  } : null;
  return {
    at: at ?? null,
    part_number: component ? component.part_number ?? null : null,
    component_name: component ? component.name ?? null : null,
    fusion_document_id: model ? model.fusion_document_id ?? null : null,
    fusion_document_name: model ? model.fusion_document_name ?? null : null,
    current: brief(derived.current),
    released: brief(derived.released),
    revisions: revs.map(revisionOut),
    // cad_models.status as dual-written by the API; compared with current.status
    // in the status step. null when the model has no status column any more.
    model_status: model && model.status != null ? model.status : null,
    history_count: Number.isFinite(Number(historyCount)) ? Number(historyCount) : 0,
    supplier_view: snapshotSupplierView({ cadRevisions: revs, drawings }),
    warnings: Array.isArray(warnings) ? warnings : [],
  };
}

// ---------------------------------------------------------------------------
// Prediction — what the send must do, decided BEFORE the run (STATUS_MODEL §5.2/5.3)
// ---------------------------------------------------------------------------
/** { mode: "replace" | "new_letter", letter, fusion_version }
 *  replace:    the current revision is still in work (not released/superseded),
 *              so the send lands on that letter and replaces its STEP file.
 *  new_letter: no revision yet, or the current one is released/superseded, so
 *              the send mints the next letter as a draft.
 *  fusion_version: the LEAST Fusion version the sent file may carry — the
 *              before STEP file's version + 1 — or null when there is no file
 *              to count from. The exact number is what the add-in reports on
 *              the save step (the document may be ahead of the last send:
 *              v12 and v13 never left the engineer's machine, §5.3). */
export function expectedOutcome(before) {
  const current = before && before.current ? before.current : null;
  const letters = ((before && before.revisions) || []).map((r) => r.revision);
  const currentRev = current ? revisionOf(before, current.revision) : null;
  const file = stepFileOf(currentRev);
  const fv = file && Number.isInteger(Number(file.fusion_version)) ? Number(file.fusion_version) : null;
  const inWork = current && current.status !== "released" && current.status !== "superseded";
  return {
    mode: inWork ? "replace" : "new_letter",
    letter: inWork ? norm(current.revision) : nextRevisionLetter(letters),
    fusion_version: fv == null ? null : fv + 1,
  };
}

// ---------------------------------------------------------------------------
// Verdict — the five portal-side steps (TEST_AGENT.md steps 8–12)
// ---------------------------------------------------------------------------
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v === undefined ? null : v;
};
/** Structural equality with key order ignored; undefined reads as null. */
export function deepEqual(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

const result = (key, failures, okDetail) => ({
  key, label: STEPS.find((s) => s.key === key).label,
  status: failures.length ? "failed" : "passed",
  detail: failures.length ? failures.join("; ") : okDetail,
});

/** Evaluate steps 8–12 from what the run recorded.
 *  before/after: snapshots (buildSnapshot shape); expected: expectedOutcome();
 *  send: what the add-in stored from registerCadRevision (+ its own file_name,
 *        sha256, fusion_version); steps: the run's reported steps (the save
 *        step's data carries version_before / version_after);
 *  historyRows: [{ changed_at, notes }];
 *  requestedAt: ISO string — rows at or before it do not count.
 *  → { steps: [five results], passed }. Never throws on a missing field: a
 *  missing fact is a failed step with the fact named. */
export function verifyRun({ before, after, expected, send, steps: reported, historyRows, requestedAt, at } = {}) {
  before = before || {}; after = after || {}; expected = expected || {}; send = send || {};
  // The add-in's own account of the save: { version_before, version_after }
  // on the reported save step.
  const saveStep = (Array.isArray(reported) ? reported : []).find((s) => s && s.key === "save");
  const saved = saveStep && saveStep.data && typeof saveStep.data === "object" ? saveStep.data : null;
  const savedBefore = saved && Number.isInteger(Number(saved.version_before)) ? Number(saved.version_before) : null;
  const savedAfter = saved && Number.isInteger(Number(saved.version_after)) ? Number(saved.version_after) : null;
  const stamp = at ?? null;
  const steps = [];

  const docName = before.fusion_document_name ?? null;
  const sentLetter = send.revision != null ? norm(send.revision) : null;
  const afterRev = sentLetter ? revisionOf(after, sentLetter) : null;
  const afterFile = stepFileOf(afterRev);
  const beforeCurrentRev = before.current ? revisionOf(before, before.current.revision) : null;
  const beforeFile = stepFileOf(beforeCurrentRev);
  const sentFileId = send.file_id ?? send.id ?? null;

  // 8. naming
  {
    const f = [];
    const wantName = docName ? expectedStepName(docName) : null;
    if (!docName) f.push("the CAD model has no fusion_document_name");
    if (!sentLetter) f.push("send recorded no revision");
    else if (!afterRev) f.push(`Rev ${sentLetter} is not in the after snapshot`);
    else if (!afterFile) f.push(`Rev ${sentLetter} has no STEP file after the run`);
    if (wantName && afterFile && afterFile.file_name !== wantName) {
      f.push(`registered file is "${afterFile.file_name}", expected "${wantName}"`);
    }
    if (wantName && send.file_name != null && send.file_name !== wantName) {
      f.push(`add-in sent "${send.file_name}", expected "${wantName}"`);
    }
    if (docName && before.part_number && !String(docName).startsWith(String(before.part_number))) {
      f.push(`document name "${docName}" does not start with the part number ${before.part_number}`);
    }
    if (after.fusion_document_name !== docName) {
      f.push(`cad_models.fusion_document_name changed from "${docName}" to "${after.fusion_document_name}"`);
    }
    steps.push(result("naming", f, wantName ? `"${wantName}"` : null));
  }

  // 9. versioning
  {
    const f = [];
    const fv = afterFile ? afterFile.fusion_version : null;
    if (!afterFile) f.push("no STEP file registered on the sent revision");
    else if (!Number.isInteger(fv) || fv < 1) f.push(`file carries no Fusion version (${fv})`);
    else {
      // One save, one version: the add-in reports v_before → v_after on the
      // save step, and the registered file must carry v_after.
      if (savedBefore != null && savedAfter != null) {
        if (savedAfter !== savedBefore + 1) f.push(`the save moved Fusion v${savedBefore} → v${savedAfter}, expected exactly one version`);
        if (fv !== savedAfter) f.push(`file is Fusion v${fv}, the save produced v${savedAfter}`);
      } else if (savedAfter != null) {
        if (fv !== savedAfter) f.push(`file is Fusion v${fv}, the save produced v${savedAfter}`);
      } else {
        f.push("the save step recorded no Fusion version numbers");
      }
      // Never behind the last send: the document is at least one version on.
      const bfv = beforeFile && Number.isInteger(Number(beforeFile.fusion_version)) ? Number(beforeFile.fusion_version) : null;
      if (bfv != null && fv <= bfv) f.push(`file is Fusion v${fv}, the registered file was already v${bfv}`);
    }
    if (afterFile && send.fusion_version != null && Number(send.fusion_version) !== fv) {
      f.push(`add-in sent Fusion v${send.fusion_version}, the portal registered v${fv}`);
    }
    if (afterFile) {
      if (!afterFile.sha256) f.push("file has no sha256");
      else if (beforeFile && beforeFile.sha256 && afterFile.sha256 === beforeFile.sha256) f.push("sha256 unchanged: the save did not change the STEP");
      if (send.sha256 && afterFile.sha256 && String(send.sha256).toLowerCase() !== String(afterFile.sha256).toLowerCase()) {
        f.push("add-in sha256 differs from the registered sha256");
      }
    }
    if (expected.mode === "replace") {
      const want = before.current ? norm(before.current.revision) : null;
      if (sentLetter !== want) f.push(`landed on Rev ${sentLetter ?? "?"}, expected the current Rev ${want}`);
      if (send.created === true) f.push("send.created is true: the current letter was minted again");
      if (beforeFile) {
        // The letter already had a STEP: the send must have replaced that row.
        if (send.replaced !== true) f.push("send.replaced is not true: a draft letter must replace its file");
        if (sentFileId && sentFileId !== beforeFile.id) f.push("the file row was not the one replaced: a new file id was minted");
        if (!sentFileId) f.push("send recorded no file id");
      } else if (send.replaced === true) {
        // No STEP on the letter before: the first STEP is inserted, not replaced.
        f.push("send.replaced is true although the letter had no STEP file before");
      }
    } else if (expected.mode === "new_letter") {
      const want = expected.letter ?? nextRevisionLetter((before.revisions || []).map((r) => r.revision));
      if (sentLetter !== norm(want)) f.push(`landed on Rev ${sentLetter ?? "?"}, expected the next letter ${want}`);
      if (send.created !== true) f.push("send.created is not true: a new letter must be minted");
    } else {
      f.push(`unknown expected mode "${expected.mode}"`);
    }
    steps.push(result("versioning", f, afterFile ? `Rev ${sentLetter} · Fusion v${fv} · ${expected.mode}` : null));
  }

  // 10. status
  {
    const f = [];
    // A replaced file leaves the letter's status alone (registerCadRevision
    // never touches it); a minted letter is a draft.
    const wantStatus = expected.mode === "replace" && before.current ? before.current.status : "draft";
    if (!after.current) f.push("no current revision after the run");
    else if (after.current.status !== wantStatus) f.push(`current Rev ${after.current.revision} is ${after.current.status}, expected ${wantStatus}`);
    if (after.current && ["released", "superseded"].includes(after.current.status)) {
      f.push(`current Rev ${after.current.revision} is ${after.current.status}: the send landed on a closed letter`);
    }
    const bRel = before.released ? before.released.id : null;
    const aRel = after.released ? after.released.id : null;
    if (bRel !== aRel) f.push(`released revision changed: ${before.released ? "Rev " + before.released.revision : "none"} → ${after.released ? "Rev " + after.released.revision : "none"}`);
    const releasedCount = (after.revisions || []).filter((r) => r.status === "released").length;
    if (releasedCount > 1) f.push(`${releasedCount} revisions are released at once`);
    if (after.model_status != null && after.current && after.model_status !== after.current.status) {
      f.push(`cad_models.status "${after.model_status}" disagrees with the current revision "${after.current.status}"`);
    }
    steps.push(result("status", f, after.current ? `Rev ${after.current.revision} ${after.current.status}` + (after.released ? ` · Rev ${after.released.revision} released` : "") : null));
  }

  // 11. supplier
  {
    const f = [];
    if (!before.supplier_view || !after.supplier_view) f.push("a snapshot has no supplier_view");
    else if (!deepEqual(before.supplier_view, after.supplier_view)) {
      f.push(`supplier view changed: ${JSON.stringify(canon(before.supplier_view))} → ${JSON.stringify(canon(after.supplier_view))}`);
    }
    const sv = after.supplier_view || {};
    const brief = sv.cad_released_revision ? `CAD Rev ${sv.cad_released_revision}` : "no released CAD";
    const dr = (sv.drawings || []).length;
    steps.push(result("supplier", f, `${brief} · ${dr} released drawing${dr === 1 ? "" : "s"} · unchanged`));
  }

  // 12. changelog
  {
    const f = [];
    const since = requestedAt ? Date.parse(requestedAt) : NaN;
    const rows = (historyRows || []).filter((r) => {
      if (!r) return false;
      if (!Number.isFinite(since)) return true;
      const t = Date.parse(r.changed_at);
      return Number.isFinite(t) && t > since;
    });
    const hit = rows.find((r) => CHANGELOG_NOTE.test(String(r.notes ?? "")));
    if (!hit) f.push(rows.length ? `${rows.length} history row(s) since the request, none says a CAD revision was registered` : "no bom_component_history row since the request");
    if (before.history_count != null && after.history_count != null && after.history_count <= before.history_count) {
      f.push(`history_count did not grow (${before.history_count} → ${after.history_count})`);
    }
    steps.push(result("changelog", f, hit ? String(hit.notes) : null));
  }

  const out = steps.map((s) => ({ ...s, at: stamp }));
  return { steps: out, passed: out.every((s) => s.status === "passed") };
}

/** Merge verifyRun results into a run's step list. */
export function applyResults(steps, results) {
  let out = normaliseSteps(steps);
  for (const r of results || []) out = setStep(out, r.key, r.status, r.detail, r.at);
  return out;
}
