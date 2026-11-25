// One status model for drawings and CAD models (docs/STATUS_MODEL.md) — pure,
// no network, no credentials, always runs.
//
// _shared/status-core.mjs is the single copy of the rules that portal-api, the
// browser and the Fusion dialog all depend on: which hand transitions exist,
// how letters order, what an object reports about itself, and when a part's
// drawing and CAD disagree. Each rule is checked here by hand-worked cases.
import { test } from "node:test";
import assert from "node:assert/strict";

const M = await import(new URL("../supabase/functions/_shared/status-core.mjs", import.meta.url));
const { STATUSES, TRANSITIONS, canTransition, compareRevision, nextRevisionLetter,
        deriveObject, parseRevisionLabel, statusSummary } = M;

// ---------------------------------------------------------------------------
// Transition table — every from/to pair, both kinds
// ---------------------------------------------------------------------------
// STATUSES keeps the five enum words so an old row still renders; the lifecycle
// (the transition table) has three states since 2026-11-25 (STATUS_MODEL §5.1,
// DRAWINGS_TAB_UX §12).
const LIFECYCLE = ["draft", "released", "superseded"];

test("STATUSES are the five enum values; the transition table has the three lifecycle states, both kinds", () => {
  assert.deepEqual(STATUSES, ["draft", "checked", "approved", "released", "superseded"]);
  for (const kind of ["drawing", "cad"]) {
    assert.deepEqual(Object.keys(TRANSITIONS[kind]).sort(), [...LIFECYCLE].sort(), `${kind} table is the three states`);
    assert.ok(!("checked" in TRANSITIONS[kind]) && !("approved" in TRANSITIONS[kind]), `${kind} table still names a retired state`);
  }
  assert.deepEqual(TRANSITIONS.drawing, TRANSITIONS.cad, "one table for both kinds");
});

// The full matrix as §5.1 writes it, over every enum word. Anything not listed is
// refused — the retired words have no entry and no exit.
const ALLOWED = {
  drawing: { draft: ["released"], checked: [], approved: [], released: [], superseded: [] },
  cad:     { draft: ["released"], checked: [], approved: [], released: [], superseded: [] },
};

for (const kind of ["drawing", "cad"]) {
  test(`${kind}: every from → to pair matches the design table`, () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const expected = ALLOWED[kind][from].includes(to);
        assert.equal(canTransition(kind, from, to), expected, `${kind} ${from} → ${to} should be ${expected ? "allowed" : "refused"}`);
      }
    }
  });
}

test("released → superseded is never a hand transition on either side", () => {
  assert.equal(canTransition("drawing", "released", "superseded"), false);
  assert.equal(canTransition("cad", "released", "superseded"), false);
});

test("draft → released is the one hand move, on both sides; the retired words are refused", () => {
  assert.equal(canTransition("drawing", "draft", "released"), true);
  assert.equal(canTransition("cad", "draft", "released"), true);
  for (const kind of ["drawing", "cad"]) {
    assert.equal(canTransition(kind, "draft", "checked"), false, `${kind}: draft → checked is refused`);
    assert.equal(canTransition(kind, "draft", "approved"), false, `${kind}: draft → approved is refused`);
    // An old row carrying a retired word cannot move: no exit, not even back to draft.
    assert.equal(canTransition(kind, "checked", "released"), false);
    assert.equal(canTransition(kind, "checked", "draft"), false);
    assert.equal(canTransition(kind, "approved", "released"), false);
    assert.equal(canTransition(kind, "approved", "draft"), false);
    assert.equal(canTransition(kind, "released", "draft"), false, `${kind}: a release is not undone by hand`);
  }
});

test("superseded is terminal; nothing moves to superseded or out of it by hand", () => {
  for (const kind of ["drawing", "cad"]) {
    for (const s of STATUSES) {
      assert.equal(canTransition(kind, "superseded", s), false);
      assert.equal(canTransition(kind, s, "superseded"), false);
    }
  }
});

test("unknown kind or status is refused, not thrown", () => {
  assert.equal(canTransition("document", "draft", "checked"), false);
  assert.equal(canTransition("cad", "bogus", "checked"), false);
  assert.equal(canTransition("cad", "draft", "bogus"), false);
  assert.equal(canTransition(undefined, undefined, undefined), false);
});

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------
test("compareRevision: shorter first, then alphabetical — Z < AA", () => {
  assert.ok(compareRevision("A", "B") < 0);
  assert.ok(compareRevision("B", "A") > 0);
  assert.equal(compareRevision("F", "F"), 0);
  assert.ok(compareRevision("Z", "AA") < 0, "Z sorts before AA");
  assert.ok(compareRevision("AA", "Z") > 0);
  assert.ok(compareRevision("AA", "AB") < 0);
  assert.ok(compareRevision("AZ", "BA") < 0);
  assert.equal(compareRevision(" f ", "F"), 0, "case and whitespace do not matter");
  const sorted = ["AB", "C", "AA", "Z", "A"].sort(compareRevision);
  assert.deepEqual(sorted, ["A", "C", "Z", "AA", "AB"]);
});

test("nextRevisionLetter: [] → A, [A,B] → C, [Z] → AA, [AZ] → BA, [ZZ] → AAA", () => {
  assert.equal(nextRevisionLetter([]), "A");
  assert.equal(nextRevisionLetter(["A", "B"]), "C");
  assert.equal(nextRevisionLetter(["B", "A"]), "C", "order of input does not matter");
  assert.equal(nextRevisionLetter(["Z"]), "AA");
  assert.equal(nextRevisionLetter(["Z", "AA"]), "AB", "AA is above Z, so the next is AB");
  assert.equal(nextRevisionLetter(["AZ"]), "BA");
  assert.equal(nextRevisionLetter(["ZZ"]), "AAA");
  assert.equal(nextRevisionLetter(["a", " b "]), "C", "lower case and whitespace are normalised");
  assert.equal(nextRevisionLetter(["1", "v2", null, undefined, ""]), "A", "non-letters are ignored");
  assert.equal(nextRevisionLetter(["A", "v2"]), "B");
  assert.equal(nextRevisionLetter(undefined), "A");
});

// ---------------------------------------------------------------------------
// deriveObject — what a drawing or CAD model reports about itself
// ---------------------------------------------------------------------------
const rev = (revision, status, extra = {}) => ({ id: `rev-${revision}`, revision, status, ...extra });

test("deriveObject: no revisions → draft, nothing current, nothing released", () => {
  assert.deepEqual(deriveObject([]), { current: null, released: null, status: "draft" });
  assert.deepEqual(deriveObject(undefined), { current: null, released: null, status: "draft" });
});

test("deriveObject: one draft revision", () => {
  const a = rev("A", "draft");
  const d = deriveObject([a]);
  assert.equal(d.current, a);
  assert.equal(d.released, null);
  assert.equal(d.status, "draft");
});

test("deriveObject: one released revision", () => {
  const a = rev("A", "released");
  const d = deriveObject([a]);
  assert.equal(d.current, a);
  assert.equal(d.released, a);
  assert.equal(d.status, "released");
});

test("deriveObject: released F with a new draft G reports 'F released · G draft' — the §1 fix", () => {
  const e = rev("E", "superseded"), f = rev("F", "released"), g = rev("G", "draft");
  const d = deriveObject([g, e, f]);   // unsorted on purpose
  assert.equal(d.current, g, "current is the highest letter");
  assert.equal(d.released, f);
  assert.equal(d.status, "draft", "the object's status is the current revision's, not 'released'");
});

test("deriveObject: current is by letter order, not array order or status — AA above Z", () => {
  // AA carries a retired word (an old row): deriveObject reports it as it is.
  const z = rev("Z", "released"), aa = rev("AA", "checked");
  const d = deriveObject([aa, z]);
  assert.equal(d.current, aa);
  assert.equal(d.released, z);
  assert.equal(d.status, "checked");
});

test("deriveObject: two released letters (pre-0060 data) → the highest is the released one", () => {
  const b = rev("B", "released"), c = rev("C", "released"), d0 = rev("D", "draft");
  const d = deriveObject([b, c, d0]);
  assert.equal(d.released, c, "highest released letter wins");
  assert.equal(d.current, d0);
  assert.equal(d.status, "draft");
});

test("deriveObject does not mutate its input", () => {
  const input = [rev("B", "draft"), rev("A", "released")];
  const copy = [...input];
  deriveObject(input);
  assert.deepEqual(input, copy);
});

// ---------------------------------------------------------------------------
// parseRevisionLabel — the RevX label in a Fusion document name
// ---------------------------------------------------------------------------
test("parseRevisionLabel: positives", () => {
  assert.deepEqual(parseRevisionLabel("VALCYRA RevF Door M"), { label: "RevF", letter: "F" });
  assert.deepEqual(parseRevisionLabel("VALCYRA RevAA Door M"), { label: "RevAA", letter: "AA" });
  assert.deepEqual(parseRevisionLabel("Door M Rev B"), { label: "Rev B", letter: "B" }, "a space between Rev and the letter is allowed");
  assert.deepEqual(parseRevisionLabel("door m revc"), { label: "revc", letter: "C" }, "case-insensitive; the letter is upper-cased");
  assert.deepEqual(parseRevisionLabel("RevG"), { label: "RevG", letter: "G" });
  assert.deepEqual(parseRevisionLabel("Side panel (RevD)"), { label: "RevD", letter: "D" }, "punctuation is a word boundary");
  assert.deepEqual(parseRevisionLabel("RevD v12"), { label: "RevD", letter: "D" }, "the Fusion version counter is not the label");
});

test("parseRevisionLabel: negatives → null", () => {
  assert.equal(parseRevisionLabel("VALCYRA Door M"), null, "no label");
  assert.equal(parseRevisionLabel("Revision 4 Door"), null, "'Revision' is a word, not a label");
  assert.equal(parseRevisionLabel("Review Door"), null);
  assert.equal(parseRevisionLabel("Reverse bracket"), null);
  assert.equal(parseRevisionLabel("Door RevABC"), null, "three letters is not a revision");
  assert.equal(parseRevisionLabel("Door Rev 12"), null, "digits are not a revision");
  assert.equal(parseRevisionLabel("Door PrevA"), null, "'Rev' must start a word");
  assert.equal(parseRevisionLabel(""), null);
  assert.equal(parseRevisionLabel(null), null);
  assert.equal(parseRevisionLabel(undefined), null);
});

// ---------------------------------------------------------------------------
// statusSummary — coherence between a part's drawings and its CAD (§5.4)
// ---------------------------------------------------------------------------
const drawing = (number, role, revisions, id = `dr-${number}`) => ({ id, drawing_number: number, role, revisions });
const cadModel = (revisions) => ({ revisions });
const cadRev = (revision, status, shas = []) => ({
  id: `cad-${revision}`, revision, status, files: shas.map((sha256, i) => ({ format: i ? "glb" : "step", sha256 })),
});
const codes = (s) => s.warnings.map((w) => w.code).sort();

test("statusSummary: clean case — same letter released on both sides, drawing made from the released STEP", () => {
  const s = statusSummary({
    drawings: [drawing("RR-100", "depicts", [rev("E", "superseded"), rev("F", "released", { source_sha256: "sha-F" })])],
    cad: cadModel([cadRev("E", "superseded", ["sha-E"]), cadRev("F", "released", ["sha-F", "sha-F-glb"])]),
  });
  assert.deepEqual(s.warnings, []);
  assert.equal(s.cad.current.revision, "F");
  assert.equal(s.cad.released.revision, "F");
  assert.equal(s.drawings.length, 1);
  assert.equal(s.drawings[0].drawing_number, "RR-100");
  assert.equal(s.drawings[0].role, "depicts");
  assert.equal(s.drawings[0].current.revision, "F");
  assert.equal(s.drawings[0].released.revision, "F");
});

test("statusSummary: clean case — released F with draft G on both sides is still clean", () => {
  const s = statusSummary({
    drawings: [drawing("RR-100", "depicts", [rev("F", "released", { source_sha256: "sha-F" }), rev("G", "draft")])],
    cad: cadModel([cadRev("F", "released", ["sha-F"]), cadRev("G", "draft", ["sha-G"])]),
  });
  assert.deepEqual(s.warnings, []);
  assert.equal(s.cad.current.revision, "G");
  assert.equal(s.cad.released.revision, "F");
  assert.equal(s.drawings[0].current.revision, "G");
  assert.equal(s.drawings[0].released.revision, "F");
});

test("statusSummary: nothing released anywhere and no CAD → no warnings", () => {
  const s = statusSummary({ drawings: [drawing("RR-100", "depicts", [rev("A", "draft")])], cad: null });
  assert.deepEqual(s.warnings, []);
  assert.equal(s.cad, null);
});

test("statusSummary: empty input is fine", () => {
  assert.deepEqual(statusSummary({ drawings: [], cad: null }), { cad: null, drawings: [], warnings: [] });
  assert.deepEqual(statusSummary({}), { cad: null, drawings: [], warnings: [] });
});

test("cad_draft_drawing_released: a depicting drawing is released but no CAD revision is", () => {
  const s = statusSummary({
    drawings: [drawing("RR-100", "depicts", [rev("F", "released")])],
    cad: cadModel([cadRev("F", "draft", ["sha-F"])]),
  });
  assert.deepEqual(codes(s), ["cad_draft_drawing_released"]);
  const w = s.warnings[0];
  assert.equal(w.drawing_id, "dr-RR-100");
  assert.match(w.text, /RR-100/);
  assert.match(w.text, /issue F/);
  assert.match(w.text, /no released revision/);
  assert.equal(s.cad.released, null);
  assert.equal(s.cad.current.revision, "F");
});

test("cad_draft_drawing_released fires only for role 'depicts'", () => {
  const s = statusSummary({
    drawings: [drawing("RR-900", "installation", [rev("A", "released")])],
    cad: cadModel([cadRev("A", "draft")]),
  });
  assert.deepEqual(codes(s), []);
});

test("cad_draft_drawing_released: the CAD model exists but has no revisions at all", () => {
  const s = statusSummary({
    drawings: [drawing("RR-100", "depicts", [rev("A", "released")])],
    cad: cadModel([]),
  });
  assert.deepEqual(codes(s), ["cad_draft_drawing_released"]);
  assert.deepEqual(s.cad, { current: null, released: null });
});

test("issue letters and CAD letters are separate sequences: issue A on CAD Rev C is not a warning by itself", () => {
  const s = statusSummary({
    drawings: [drawing("RR-100", "depicts", [rev("A", "released")])],
    cad: cadModel([cadRev("B", "superseded", ["sha-B"]), cadRev("C", "released", ["sha-C"])]),
  });
  assert.deepEqual(codes(s), [], "no source recorded, so the portal says nothing");
});

test("drawing_from_other_cad by file id: the released issue was made from a file of a superseded CAD revision", () => {
  const cad = { revisions: [
    { id: "cB", revision: "B", status: "superseded", files: [{ id: "file-B", format: "step", sha256: "sha-B" }] },
    { id: "cC", revision: "C", status: "released",   files: [{ id: "file-C", format: "step", sha256: "sha-C" }] },
  ] };
  const s = statusSummary({
    drawings: [{ id: "d1", drawing_number: "RR-100", role: "depicts",
      revisions: [{ id: "r1", revision: "A", status: "released", source_cad_file_id: "file-B", source_sha256: "sha-B" }] }],
    cad,
  });
  assert.deepEqual(codes(s), ["drawing_from_other_cad"]);
  assert.match(s.warnings[0].text, /made from CAD Rev B/);
  assert.match(s.warnings[0].text, /released CAD is Rev C/);
});

test("drawing_from_other_cad by file id does not fire when the source file belongs to the released revision", () => {
  const cad = { revisions: [
    { id: "cC", revision: "C", status: "released", files: [{ id: "file-C", format: "step", sha256: "sha-C" }] },
  ] };
  const s = statusSummary({
    drawings: [{ id: "d1", drawing_number: "RR-100", role: "depicts",
      revisions: [{ id: "r1", revision: "A", status: "released", source_cad_file_id: "file-C", source_sha256: "other" }] }],
    cad,
  });
  assert.deepEqual(codes(s), [], "the file id decides; the sha is only the fallback");
});

test("drawing_from_other_cad: the released issue's source sha matches no file of the released CAD revision", () => {
  const s = statusSummary({
    drawings: [drawing("RR-100", "depicts", [rev("F", "released", { source_sha256: "sha-F-old" })])],
    cad: cadModel([cadRev("F", "released", ["sha-F-new", "sha-F-glb"])]),
  });
  assert.deepEqual(codes(s), ["drawing_from_other_cad"]);
  assert.match(s.warnings[0].text, /RR-100/);
  assert.match(s.warnings[0].text, /Rev F/);
});

test("drawing_from_other_cad: the sha may match any format of the released revision", () => {
  const s = statusSummary({
    drawings: [drawing("RR-100", "depicts", [rev("F", "released", { source_sha256: "sha-F-glb" })])],
    cad: cadModel([cadRev("F", "released", ["sha-F-step", "sha-F-glb"])]),
  });
  assert.deepEqual(codes(s), []);
});

test("drawing_from_other_cad does not fire without a source sha, and compares against the RELEASED revision only", () => {
  const noSha = statusSummary({
    drawings: [drawing("RR-100", "depicts", [rev("F", "released")])],
    cad: cadModel([cadRev("F", "released", ["sha-F"])]),
  });
  assert.deepEqual(codes(noSha), [], "no source recorded → nothing to compare");

  // The sha is on the draft G files, not on released F: that is "other CAD".
  const draftOnly = statusSummary({
    drawings: [drawing("RR-100", "depicts", [rev("F", "released", { source_sha256: "sha-G" })])],
    cad: cadModel([cadRev("F", "released", ["sha-F"]), cadRev("G", "draft", ["sha-G"])]),
  });
  assert.deepEqual(codes(draftOnly), ["drawing_from_other_cad"]);
});

test("drawing_from_other_cad looks at the released issue's sha, not the current draft's", () => {
  const s = statusSummary({
    drawings: [drawing("RR-100", "depicts", [
      rev("F", "released", { source_sha256: "sha-F" }),
      rev("G", "draft", { source_sha256: "sha-something-else" }),
    ])],
    cad: cadModel([cadRev("F", "released", ["sha-F"])]),
  });
  assert.deepEqual(codes(s), []);
});

test("cad_missing: the part has released drawings and no CAD model", () => {
  const s = statusSummary({
    drawings: [drawing("RR-100", "depicts", [rev("F", "released")]), drawing("RR-200", "wiring", [rev("A", "draft")])],
    cad: null,
  });
  assert.deepEqual(codes(s), ["cad_missing"]);
  assert.match(s.warnings[0].text, /RR-100 issue F/);
  assert.doesNotMatch(s.warnings[0].text, /RR-200/, "the unreleased drawing is not named");
  assert.match(s.warnings[0].text, /no CAD model/);
  assert.equal(s.cad, null);
});

test("cad_missing does not fire when no drawing is released", () => {
  const s = statusSummary({ drawings: [drawing("RR-100", "depicts", [rev("F", "draft")])], cad: null });
  assert.deepEqual(codes(s), []);
});

test("cad_missing and cad_draft_drawing_released are exclusive: no model vs. model without release", () => {
  const drawings = [drawing("RR-100", "depicts", [rev("F", "released")])];
  assert.deepEqual(codes(statusSummary({ drawings, cad: null })), ["cad_missing"]);
  assert.deepEqual(codes(statusSummary({ drawings, cad: cadModel([cadRev("A", "draft")]) })), ["cad_draft_drawing_released"]);
});

test("several warnings at once, one per drawing, and warnings always carry code and text", () => {
  const s = statusSummary({
    drawings: [
      drawing("RR-100", "depicts", [rev("E", "released", { source_sha256: "sha-E" })]),   // made from the superseded CAD
      drawing("RR-101", "depicts", [rev("G", "released", { source_sha256: "sha-G" })]),   // clean
      drawing("RR-102", "depicts", [rev("A", "draft")]),                                   // nothing released
    ],
    cad: cadModel([cadRev("E", "superseded", ["sha-E"]), cadRev("G", "released", ["sha-G"])]),
  });
  assert.deepEqual(codes(s), ["drawing_from_other_cad"]);
  for (const w of s.warnings) {
    assert.equal(w.drawing_id, "dr-RR-100");
    assert.equal(typeof w.code, "string");
    assert.ok(w.text.length > 0);
  }
  assert.equal(s.drawings.length, 3);
  assert.equal(s.drawings[2].released, null);
  assert.equal(s.drawings[2].current.revision, "A");
});

test("statusSummary: two released letters on the CAD (pre-0060 data) → the highest counts as released", () => {
  const s = statusSummary({
    drawings: [drawing("RR-100", "depicts", [rev("F", "released")])],
    cad: cadModel([cadRev("F", "released"), cadRev("G", "released")]),
  });
  assert.equal(s.cad.released.revision, "G");
  assert.deepEqual(codes(s), [], "issue F on CAD Rev G is not a warning: the letters are separate sequences");
});

// ---------------------------------------------------------------------------
// Release discipline (docs/DRAWINGS_TAB_UX.md §11) — releaseCheck, hasReleaseFile, releasedView
// ---------------------------------------------------------------------------
const { releaseCheck, hasReleaseFile, releasedView } = M;
const cadFile = (id, sha256 = `sha-${id}`) => ({ id, format: "step", sha256 });

test("hasReleaseFile: cad counts file rows, drawing counts storage_path", () => {
  assert.equal(hasReleaseFile("cad", { files: [cadFile("f1")] }), true);
  assert.equal(hasReleaseFile("cad", { files: [] }), false);
  assert.equal(hasReleaseFile("cad", {}), false, "no files array at all");
  assert.equal(hasReleaseFile("drawing", { storage_path: "org/drawings/x.pdf" }), true);
  assert.equal(hasReleaseFile("drawing", { storage_path: "" }), false);
  assert.equal(hasReleaseFile("drawing", { files: [cadFile("f1")] }), false, "a drawing's file is its storage_path, not file rows");
  assert.equal(hasReleaseFile("cad", null), false);
});

test("releaseCheck: the current CAD draft with a file may be released", () => {
  const a = rev("A", "released", { files: [cadFile("fa")] }), b = rev("B", "draft", { files: [cadFile("fb")] });
  assert.deepEqual(releaseCheck("cad", [a, b], b), { ok: true });
});

test("releaseCheck: not the current revision — exact text, Rev for CAD, Issue for drawings", () => {
  const e = rev("E", "draft", { files: [cadFile("fe")] }), g = rev("G", "draft", { files: [cadFile("fg")] });
  assert.deepEqual(releaseCheck("cad", [e, g], e), { error: "Rev E is not the current revision; G is" });
  const b = rev("B", "draft", { storage_path: "p/b.pdf" }), c = rev("C", "draft", { storage_path: "p/c.pdf" });
  assert.deepEqual(releaseCheck("drawing", [b, c], b), { error: "Issue B is not the current revision; C is" });
});

test("releaseCheck: the current drawing draft with a file may be released — same rule as CAD since 2026-11-25", () => {
  const a = rev("A", "released", { storage_path: "p/a.pdf" }), b = rev("B", "draft", { storage_path: "p/b.pdf" });
  assert.deepEqual(releaseCheck("drawing", [a, b], b), { ok: true });
  assert.deepEqual(releaseCheck("drawing", [b], b), { ok: true }, "a first issue needs no predecessor");
});

test("releaseCheck: a transition the §5.1 table refuses — an old row carrying a retired word has no way out", () => {
  const b = rev("B", "checked", { storage_path: "p/b.pdf" });
  assert.deepEqual(releaseCheck("drawing", [b], b), { error: "Cannot go from checked to released" });
  const c = rev("C", "approved", { files: [cadFile("fc")] });
  assert.deepEqual(releaseCheck("cad", [c], c), { error: "Cannot go from approved to released" });
});

test("releaseCheck: no file — refused after the transition check, before any write", () => {
  const b = rev("B", "draft", { files: [] });
  assert.deepEqual(releaseCheck("cad", [b], b), { error: "Rev B has no file" });
  const d = rev("D", "draft", { storage_path: null });
  assert.deepEqual(releaseCheck("drawing", [d], d), { error: "Issue D has no file" });
  // The transition refusal wins over the missing file: an old checked row without a file says "Cannot go".
  const old = rev("E", "checked", {});
  assert.deepEqual(releaseCheck("drawing", [old], old), { error: "Cannot go from checked to released" });
});

test("releaseCheck: an already released revision is a no-op, not a refusal; null is 'no revision'", () => {
  const a = rev("A", "released", { files: [cadFile("fa")] });
  assert.deepEqual(releaseCheck("cad", [a], a), { ok: true, already: true });
  assert.deepEqual(releaseCheck("cad", [a], null), { error: "no revision to release" });
});

test("releaseCheck: order — 'not current' is answered before the transition and the file", () => {
  // B is an old checked row with no file and not current: the first rule in the chain speaks.
  const b = rev("B", "checked", { files: [] }), c = rev("C", "draft", { files: [] });
  assert.deepEqual(releaseCheck("cad", [b, c], b), { error: "Rev B is not the current revision; C is" });
});

test("releasedView: this one released, the previously released one superseded, the rest untouched", () => {
  const e = rev("E", "superseded"), f = rev("F", "released"), g = rev("G", "draft", { files: [cadFile("fg")] });
  const after = releasedView([e, f, g], "rev-G");
  assert.deepEqual(after.map((r) => [r.revision, r.status]), [["E", "superseded"], ["F", "superseded"], ["G", "released"]]);
  assert.equal(after[2].files, g.files, "shallow copies: nested files are shared");
  // The input is not mutated.
  assert.equal(f.status, "released");
  assert.equal(g.status, "draft");
  assert.notEqual(after[2], g);
});

test("releasedView feeds statusSummary and deriveObject without a write", () => {
  const f = rev("F", "released"), g = rev("G", "draft");
  const d = deriveObject(releasedView([f, g], "rev-G"));
  assert.equal(d.released.revision, "G");
  assert.equal(d.status, "released");
  // Releasing CAD Rev G while the drawing was made from Rev F's STEP: the warning appears only "after".
  const cad = { revisions: [
    { id: "cF", revision: "F", status: "released", files: [{ id: "file-F", format: "step", sha256: "sha-F" }] },
    { id: "cG", revision: "G", status: "draft",    files: [{ id: "file-G", format: "step", sha256: "sha-G" }] },
  ] };
  const drawings = [drawing("RR-100", "depicts", [rev("A", "released", { source_cad_file_id: "file-F" })])];
  assert.deepEqual(codes(statusSummary({ drawings, cad })), []);
  assert.deepEqual(codes(statusSummary({ drawings, cad: { revisions: releasedView(cad.revisions, "cG") } })), ["drawing_from_other_cad"]);
});

test("releasedView: unknown id or empty input gives copies unchanged", () => {
  const f = rev("F", "released");
  assert.deepEqual(releasedView([f], "nope"), [f]);
  assert.notEqual(releasedView([f], "nope")[0], f);
  assert.deepEqual(releasedView([], "x"), []);
  assert.deepEqual(releasedView(undefined, "x"), []);
});
