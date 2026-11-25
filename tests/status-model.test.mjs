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
test("STATUSES are the five enum values in lifecycle order", () => {
  assert.deepEqual(STATUSES, ["draft", "checked", "approved", "released", "superseded"]);
  for (const kind of ["drawing", "cad"]) {
    assert.deepEqual(Object.keys(TRANSITIONS[kind]).sort(), [...STATUSES].sort(), `${kind} table covers every status`);
  }
});

// The full matrix as the design §5.1 writes it. Anything not listed is refused.
const ALLOWED = {
  drawing: {
    draft: ["checked"],
    checked: ["approved", "draft"],
    approved: ["released", "draft"],
    released: [],
    superseded: [],
  },
  cad: {
    draft: ["checked", "released"],          // the Fusion flow has no checker
    checked: ["approved", "draft"],
    approved: ["released", "draft"],
    released: [],
    superseded: [],
  },
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

test("a drawing may not skip checked and approved; a CAD revision may", () => {
  assert.equal(canTransition("drawing", "draft", "released"), false);
  assert.equal(canTransition("cad", "draft", "released"), true);
  assert.equal(canTransition("cad", "draft", "approved"), false, "CAD still cannot jump to approved");
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

test("drawing_behind_cad: CAD released G, drawing released F", () => {
  const s = statusSummary({
    drawings: [drawing("RR-100", "depicts", [rev("F", "released")])],
    cad: cadModel([cadRev("F", "superseded", ["sha-F"]), cadRev("G", "released", ["sha-G"])]),
  });
  assert.deepEqual(codes(s), ["drawing_behind_cad"]);
  assert.match(s.warnings[0].text, /issue F/);
  assert.match(s.warnings[0].text, /Rev G/);
});

test("drawing_behind_cad: letter order is shorter-first — CAD AA is after drawing Z", () => {
  const s = statusSummary({
    drawings: [drawing("RR-100", "depicts", [rev("Z", "released")])],
    cad: cadModel([cadRev("AA", "released")]),
  });
  assert.deepEqual(codes(s), ["drawing_behind_cad"]);
});

test("drawing_behind_cad does not fire when the drawing is AHEAD of the CAD (issue G, Rev F)", () => {
  const s = statusSummary({
    drawings: [drawing("RR-100", "depicts", [rev("G", "released")])],
    cad: cadModel([cadRev("F", "released")]),
  });
  assert.deepEqual(codes(s), [], "a drawing ahead of the CAD is a warning the design does not define");
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
  const s = statusSummary({ drawings: [drawing("RR-100", "depicts", [rev("F", "approved")])], cad: null });
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
      drawing("RR-100", "depicts", [rev("E", "released", { source_sha256: "sha-E" })]),   // behind G, and from other CAD
      drawing("RR-101", "depicts", [rev("G", "released", { source_sha256: "sha-G" })]),   // clean
      drawing("RR-102", "depicts", [rev("A", "draft")]),                                   // nothing released
    ],
    cad: cadModel([cadRev("E", "superseded", ["sha-E"]), cadRev("G", "released", ["sha-G"])]),
  });
  assert.deepEqual(codes(s), ["drawing_behind_cad", "drawing_from_other_cad"]);
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
  assert.deepEqual(codes(s), ["drawing_behind_cad"]);
});
