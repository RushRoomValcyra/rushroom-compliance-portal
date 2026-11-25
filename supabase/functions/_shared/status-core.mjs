/* Rushroom AB — Engineering & Compliance Platform: one status model for
 * drawings and CAD models (docs/STATUS_MODEL.md).
 *
 * Pure functions, no DOM, no network, no imports. ONE file for three users, so
 * the rules cannot drift apart (the cost-math.mjs pattern):
 *   - portal-api (transitions, letter policy, derived object status)
 *   - the browser (status line on the part card, CAD Models tab)
 *   - and the tests (tests/status-model.test.mjs).
 *
 * Principle: the REVISION is the controlled object. A drawing or a CAD model
 * has no status of its own; it reports the current revision (highest letter)
 * and the released revision (the one a supplier may build from), if any.
 *
 * Vocabulary: "Rev F" for a CAD letter, "Issue F" for a drawing letter,
 * "Fusion v12" for Fusion's own save counter (never a revision).
 */

export const STATUSES = ["draft", "checked", "approved", "released", "superseded"];

// Hand transitions only. released → superseded is automatic — it happens when
// a later revision is released — and is never offered or accepted by hand.
// A CAD revision may go draft → released directly: the Fusion flow has no
// checker. A drawing must pass checked and approved, as today.
export const TRANSITIONS = {
  drawing: { draft: ["checked"], checked: ["approved", "draft"], approved: ["released", "draft"], released: [], superseded: [] },
  cad:     { draft: ["checked", "released"], checked: ["approved", "draft"], approved: ["released", "draft"], released: [], superseded: [] },
};

/** kind 'drawing' | 'cad'. Unknown kind or status → false, never a throw. */
export function canTransition(kind, from, to) {
  const table = TRANSITIONS[kind];
  if (!table) return false;
  const allowed = table[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

const norm = (r) => String(r ?? "").trim().toUpperCase();

/** Letter ordering: shorter first, then alphabetical — "Z" < "AA" < "AB". */
export function compareRevision(a, b) {
  const x = norm(a), y = norm(b);
  if (x.length !== y.length) return x.length - y.length;
  return x.localeCompare(y);
}

/** ['A','B'] → 'C'; [] → 'A'; ['Z'] → 'AA'. Same behaviour as portal-api had. */
export function nextRevisionLetter(existing) {
  const letters = (existing || []).map(norm).filter((r) => /^[A-Z]+$/.test(r));
  if (!letters.length) return "A";
  const highest = letters.sort(compareRevision).pop();
  const chars = highest.split("");
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] !== "Z") { chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1); return chars.join(""); }
    chars[i] = "A"; i--;
  }
  return "A" + chars.join("");
}

/** What an object (drawing or CAD model) reports about itself.
 *  revisions: [{ id, revision, status, ... }]
 *  → { current, released, status }
 *    current  = the revision with the highest letter (null when none)
 *    released = the revision with status 'released' (highest if several), else null
 *    status   = current ? current.status : 'draft'
 *  The revision objects are returned as given, not copied. */
export function deriveObject(revisions) {
  const sorted = [...(revisions || [])].sort((a, b) => compareRevision(a.revision, b.revision));
  const current = sorted.length ? sorted[sorted.length - 1] : null;
  const releasedAll = sorted.filter((r) => r.status === "released");
  const released = releasedAll.length ? releasedAll[releasedAll.length - 1] : null;
  return { current, released, status: current ? current.status : "draft" };
}

/** "VALCYRA RevF Door M" → { label: "RevF", letter: "F" }; null when no label.
 *  The label is kept as written (it is stored as fusion_revision_label); the
 *  letter is upper-cased. "Revision", "Review", "RevABC" do not match. */
export function parseRevisionLabel(name) {
  const m = /\bRev\s*([A-Z]{1,2})\b/i.exec(String(name ?? ""));
  if (!m) return null;
  return { label: m[0], letter: m[1].toUpperCase() };
}

const letterOf = (rev) => (rev ? norm(rev.revision) : null);

/** Coherence between a part's drawings and its CAD model (design §5.4).
 *  drawings: [{ id, drawing_number, role, revisions: [{ id, revision, status, source_cad_file_id, source_sha256 }] }]
 *            role = drawing_components.role; 'depicts' for the ones that depict the part
 *  cad:      null | { revisions: [{ id, revision, status, files: [{ format, sha256 }] }] }
 *  → { cad: null | { current, released }, drawings: [{ id, drawing_number, role, current, released }], warnings: [{ code, text, drawing_id? }] }
 *  Warnings are information, never blocks: a supplier package is a human decision. */
export function statusSummary({ drawings, cad } = {}) {
  const cadDerived = cad ? deriveObject(cad.revisions) : null;
  const cadOut = cadDerived ? { current: cadDerived.current, released: cadDerived.released } : null;
  const cadReleasedLetter = letterOf(cadDerived && cadDerived.released);
  const cadReleasedShas = new Set(
    ((cadDerived && cadDerived.released && cadDerived.released.files) || [])
      .map((f) => f && f.sha256).filter(Boolean),
  );
  // Which CAD revision each file belongs to, so a drawing that records the file
  // it was made from can be placed on a revision without comparing letters.
  const revisionOfFile = new Map();
  for (const r of (cad && cad.revisions) || []) {
    for (const f of r.files || []) if (f && f.id) revisionOfFile.set(f.id, norm(r.revision));
  }

  const drawingsOut = (drawings || []).map((d) => {
    const { current, released } = deriveObject(d.revisions);
    return { id: d.id, drawing_number: d.drawing_number, role: d.role, current, released };
  });

  const warnings = [];
  const releasedDrawings = drawingsOut.filter((d) => d.released);

  // cad_missing: the part has released drawings and no CAD model.
  if (!cad && releasedDrawings.length) {
    const names = releasedDrawings.map((d) => `${d.drawing_number} issue ${letterOf(d.released)}`).join(", ");
    warnings.push({ code: "cad_missing", text: `${names} ${releasedDrawings.length === 1 ? "is" : "are"} released but the part has no CAD model` });
  }

  for (const d of releasedDrawings) {
    const issue = letterOf(d.released);
    const name = `Drawing ${d.drawing_number} issue ${issue}`;

    // cad_draft_drawing_released: a depicting drawing has a released issue and
    // the CAD model has no released revision.
    if (cad && !cadReleasedLetter && d.role === "depicts") {
      warnings.push({ code: "cad_draft_drawing_released", drawing_id: d.id,
        text: `${name} is released but the CAD model has no released revision` });
    }

    if (cadReleasedLetter) {
      // drawing_from_other_cad: the released issue records the CAD file it was
      // made from (by id, or by the STEP's sha256), and that file does not belong
      // to the released CAD revision. Issue letters and CAD letters are separate
      // sequences, so they are never compared with each other.
      const srcRev = d.released.source_cad_file_id ? revisionOfFile.get(d.released.source_cad_file_id) : null;
      const sha = d.released.source_sha256;
      if (srcRev && srcRev !== cadReleasedLetter) {
        warnings.push({ code: "drawing_from_other_cad", drawing_id: d.id,
          text: `${name} was made from CAD Rev ${srcRev}; the released CAD is Rev ${cadReleasedLetter}` });
      } else if (!srcRev && sha && !cadReleasedShas.has(sha)) {
        warnings.push({ code: "drawing_from_other_cad", drawing_id: d.id,
          text: `${name} was not made from the released CAD Rev ${cadReleasedLetter}` });
      }
    }
  }

  return { cad: cadOut, drawings: drawingsOut, warnings };
}
