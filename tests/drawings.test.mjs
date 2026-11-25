// PROP-045 drawings domain.
//
// Unauthenticated and tenancy assertions always run; the credentialed ones skip
// without TEST_RUSHROOM_PASSWORD, matching the harness convention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CREDS, call, loginShared } from "./config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

/** The deployed copy may predate these actions; skip rather than fail. */
const notDeployed = (r) => /unknown action/i.test(r.json?.error ?? "");

const WRITES = ["createDrawing", "addDrawingRevision", "linkDrawingToComponent",
                "unlinkDrawingFromComponent", "setDrawingRevisionStatus",
                "setDrawingSupplierVisibility"];
const READS = ["listDrawings", "getDrawing", "drawingFileUrl"];

for (const action of [...WRITES, ...READS]) {
  test(`${action} rejects an unauthenticated call`, async () => {
    const r = await call(action);
    assert.notEqual(r.status, 200, `${action} answered 200 without a session`);
  });
}

test("a forged organization_id cannot reach another tenant's drawings", async () => {
  const r = await call("listDrawings", { organization_id: "11111111-1111-1111-1111-111111111111" });
  assert.notEqual(r.status, 200);
});

test("listDrawings returns {drawings, count} sorted by drawing number", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const r = await call("listDrawings", { token });
  if (notDeployed(r)) return t.skip("drawings not deployed yet");
  assert.equal(r.status, 200, `error: ${r.json?.error}`);
  const { drawings, count } = r.json ?? {};
  assert.ok(Array.isArray(drawings), "drawings must be an array");
  assert.equal(count, drawings.length, "count must match the array length");
  const numbers = drawings.map((d) => d.drawing_number);
  const sorted = [...numbers].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  assert.deepEqual(numbers, sorted, "drawings are not number-sorted");
});

test("createDrawing rejects a blank number and a blank title", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const noNum = await call("createDrawing", { token, title: "x" });
  if (notDeployed(noNum)) return t.skip("drawings not deployed yet");
  assert.equal(noNum.status, 400);
  const noTitle = await call("createDrawing", { token, drawing_number: "RR-TEST-0001" });
  assert.equal(noTitle.status, 400);
});

// Status lives on the revision (docs/STATUS_MODEL.md). A drawing's `status` is
// its current issue's; `released_revision` is the issue a supplier may build
// from. The two are different facts and the API reports both.
test("setDrawingRevisionStatus refuses an illegal transition on the current issue", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const list = await call("listDrawings", { token });
  if (notDeployed(list)) return t.skip("drawings not deployed yet");
  const draft = (list.json?.drawings ?? []).find((d) => d.status === "draft" && d.revision);
  if (!draft) return t.skip("no draft drawing to exercise transitions against");
  // Three states (STATUS_MODEL §5.1, 2026-11-25): a draft issue goes to released
  // and nowhere else; the retired words are refused with the table's answer.
  // The probe below is read-only: on a deployed copy that still has the old
  // table, "checked" would be ACCEPTED and stamp a production row, so the
  // test must know which table it is talking to before it sends anything.
  const detail = await call("getDrawing", { token, drawing_id: draft.id });
  const current = (detail.json?.revisions ?? []).find((x) => x.revision === draft.revision);
  if (!current) return t.skip("current revision not found in getDrawing");
  const probe = await call("previewRelease", { token, kind: "drawing", revision_id: current.id });
  if (notDeployed(probe)) return t.skip("previewRelease not deployed yet");
  if (/cannot go from draft to released/i.test(probe.json?.refusal ?? "")) return t.skip("the deployed copy predates three states");
  const r = await call("setDrawingRevisionStatus", { token, drawing_revision_id: current.id, status: "checked" });
  if (notDeployed(r)) return t.skip("setDrawingRevisionStatus not deployed yet");
  assert.equal(r.status, 400, "draft → checked should be rejected");
  assert.match(r.json?.error ?? "", /cannot go from draft to checked/i);
  const r2 = await call("setDrawingRevisionStatus", { token, drawing_revision_id: current.id, status: "approved" });
  assert.equal(r2.status, 400, "draft → approved should be rejected too");
  assert.match(r2.json?.error ?? "", /cannot go from draft to approved/i);
});

test("a drawing reports its current issue's status and its released issue separately", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const list = await call("listDrawings", { token });
  if (notDeployed(list)) return t.skip("drawings not deployed yet");
  const drawings = list.json?.drawings ?? [];
  if (!drawings.length || !("released_revision" in drawings[0])) return t.skip("revision status model not deployed yet");
  for (const d of drawings) {
    assert.ok("released_revision" in d, `${d.drawing_number} lacks released_revision`);
    // status = released means the current issue IS the released one.
    if (d.status === "released") assert.equal(d.released_revision, d.revision, `${d.drawing_number}: released but the released issue differs`);
    // A released drawing with a new issue in work says draft, and still names
    // the released issue — the §1 fault this model fixes.
    if (d.released_revision && d.released_revision !== d.revision) {
      assert.notEqual(d.status, "released", `${d.drawing_number}: issue ${d.revision} is in work but the drawing says released`);
    }
  }
  // getDrawing agrees with the list, revision by revision.
  const sample = drawings.find((d) => d.released_revision) ?? drawings[0];
  const r = await call("getDrawing", { token, drawing_id: sample.id });
  assert.equal(r.status, 200, `error: ${r.json?.error}`);
  const { drawing, revisions } = r.json;
  assert.equal(drawing.status, sample.status);
  assert.equal(drawing.released_revision, sample.released_revision);
  const released = revisions.filter((x) => x.status === "released");
  assert.ok(released.length <= 1, "at most one issue is released at a time");
  assert.equal(released[0]?.revision ?? null, drawing.released_revision);
  // The status filter reads the derived status.
  const filtered = await call("listDrawings", { token, status: sample.status });
  assert.ok((filtered.json?.drawings ?? []).some((d) => d.id === sample.id), "the status filter does not apply to the derived status");
  assert.ok((filtered.json?.drawings ?? []).every((d) => d.status === sample.status), "the status filter let another status through");
});

test("addDrawingRevision is the only way a drawing goes back to draft", () => {
  const src = read("supabase/functions/portal-api/index.ts");
  const start = src.indexOf('action === "addDrawingRevision"');
  const block = src.slice(start, src.indexOf('action === "linkDrawingToComponent"', start));
  // The new issue is draft and current, and the drawing's derived status follows.
  assert.ok(/syncDrawingStatus\(tdb, drawing_id\)/.test(block), "addDrawingRevision does not re-derive the drawing's status");
  assert.ok(/source_cad_file_id/.test(block) && /source_sha256/.test(block), "the STEP a drawing was made from is not recorded");
  // Out-of-order letters are refused, not reshuffled.
  assert.ok(/is below the current/.test(block), "an out-of-order issue letter is not refused");
  // Nothing writes drawings.status by hand (the column is gone, 0064); the
  // revision is the only thing a status is set on, and the drawing-level alias
  // setDrawingStatus no longer exists.
  const st = src.slice(src.indexOf('if (action === "setDrawingRevisionStatus")'),
                       src.indexOf('action === "setDrawingSupplierVisibility"'));
  assert.ok(st.length > 0, "setDrawingRevisionStatus is not dispatched on its own");
  assert.ok(!src.includes('action === "setDrawingStatus"'), "the alias setDrawingStatus is still dispatched");
  assert.ok(!/tdb\("drawings"\)\.update\(\{ status/.test(st), "setDrawingRevisionStatus still writes drawings.status directly");
  assert.ok(/canTransition\("drawing"/.test(st), "drawing transitions do not use the shared table");
  // Three states: the block no longer stamps a checker or an approver.
  assert.ok(!/checked_at|approved_at/.test(st), "setDrawingRevisionStatus still stamps a retired state");
});

test("a drawing draft releases directly — the shared table has no checked or approved step for drawings", async () => {
  const { canTransition, TRANSITIONS } = await import(new URL("../supabase/functions/_shared/status-core.mjs", import.meta.url));
  assert.equal(canTransition("drawing", "draft", "released"), true);
  assert.equal(canTransition("drawing", "draft", "checked"), false);
  assert.equal(canTransition("drawing", "draft", "approved"), false);
  assert.deepEqual(Object.keys(TRANSITIONS.drawing).sort(), ["draft", "released", "superseded"]);
});

test("createDrawingWithRevision takes no projection angle, sheet size or scale", () => {
  const src = read("supabase/functions/portal-api/index.ts");
  const start = src.indexOf('action === "createDrawingWithRevision"');
  const block = src.slice(start, src.indexOf('\n  if (action === "', start + 10));
  assert.ok(block.length > 0);
  assert.ok(!/body\.(?:projection_angle|sheet_size|scale)\b/.test(block), "a retired field is still read from the body");
  // The columns are dropped by 0064; listDrawings and getDrawing no longer name them (tests/legacy-cleanup).
});

test("a supplier cannot write to the drawings domain", async (t) => {
  if (!CREDS.supplierPassword) return t.skip("TEST_SUPPLIER_PASSWORD not set");
  const token = await loginShared("supplier", CREDS.supplierPassword);
  for (const action of WRITES) {
    const r = await call(action, { token, drawing_id: "x", component_id: "x", drawing_number: "x", title: "x", status: "checked" });
    if (notDeployed(r)) return t.skip("drawings not deployed yet");
    assert.equal(r.status, 403, `${action} let a supplier through with ${r.status}`);
  }
});

test("a supplier sees only drawings marked visible to them", async (t) => {
  if (!CREDS.supplierPassword || !CREDS.rushroomPassword) return t.skip("both passwords required");
  const sup = await loginShared("supplier", CREDS.supplierPassword);
  const rr = await loginShared("rushroom", CREDS.rushroomPassword);
  const supList = await call("listDrawings", { token: sup });
  if (notDeployed(supList)) return t.skip("drawings not deployed yet");
  assert.equal(supList.status, 200, "suppliers are meant to read drawings");
  const rrList = await call("listDrawings", { token: rr });
  const hidden = (rrList.json?.drawings ?? []).filter((d) => d.is_supplier_visible === false).map((d) => d.id);
  const seen = new Set((supList.json?.drawings ?? []).map((d) => d.id));
  for (const id of hidden) assert.ok(!seen.has(id), `supplier can see withheld drawing ${id}`);
});

// --- static guarantees, no network -----------------------------------------

test("supplier visibility is enforced at exactly one choke point", () => {
  const src = read("supabase/functions/portal-api/index.ts");
  assert.ok(src.includes("function supplierDrawingScope"), "the choke point is missing");
  // Every drawing read must route through it, so making visibility selective
  // per supplier later is one edit rather than an audit of every query.
  const uses = (src.match(/supplierDrawingScope\(/g) || []).length;
  // 1 definition + 1 call per drawing read (listDrawings, getDrawing, and
  // drawingFileUrl, which must check the parent drawing or it leaks the bytes
  // of a drawing the supplier cannot even see listed).
  assert.ok(uses >= 4, `expected every drawing read to use the choke point, found ${uses - 1} call sites`);
  // Inside the drawings action block the filter must never appear by hand — a
  // second copy is how the rule drifts once visibility becomes selective. (The
  // documents domain has its own, older, unrelated supplier filter; scoping the
  // assertion to the drawings block keeps this test about drawings.)
  const start = src.indexOf("PROP-045: Drawings");
  assert.ok(start > 0, "drawings action block not found");
  const end = src.indexOf("PROP-019: COGS", start);
  const block = src.slice(start, end > 0 ? end : undefined);
  assert.ok(!/\.eq\("is_supplier_visible"/.test(block),
    "a drawings query filters is_supplier_visible by hand instead of via supplierDrawingScope");
});

test("drawings are no longer offered as a component-document category", () => {
  const app = read("assets/app.js");
  const cats = app.match(/const CATS = \[([^\]]*)\]/);
  assert.ok(cats, "component document category list not found");
  assert.ok(!/"drawing"/.test(cats[1]),
    'the old "drawing" document category is still selectable — the weaker record can still be created by accident');
});

test("the drawings tab exists on both the portal and the supplier page", () => {
  for (const page of ["index.html"]) {
    const src = read(page);
    assert.ok(src.includes('id="tab-drawings"'), `${page} has no Drawings tab`);
    assert.ok(src.includes('id="drawings-panel"'), `${page} has no Drawings panel`);
  }
  // The supplier page has its own Parts panel (docs/SUPPLIER_PORTAL.md) and no Drawings tab.
  const supplier = read("supplier.html");
  assert.ok(supplier.includes('id="parts-panel"'), "supplier.html has no Parts panel");
  assert.ok(!supplier.includes('id="tab-drawings"'), "supplier.html must not carry the Drawings tab");
});

// --- PROP-046: node-first creation, system-owned identity -------------------

test("createDrawingWithRevision and adoptDrawing reject unauthenticated calls", async () => {
  for (const action of ["createDrawingWithRevision", "adoptDrawing"]) {
    const r = await call(action);
    assert.notEqual(r.status, 200, `${action} answered 200 without a session`);
  }
});

test("createDrawingWithRevision requires a file and a title, but not an owner", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const noFile = await call("createDrawingWithRevision", { token, title: "x" });
  if (notDeployed(noFile)) return t.skip("PROP-046 not deployed yet");
  assert.equal(noFile.status, 400, "a drawing without a file must be refused");
  const noTitle = await call("createDrawingWithRevision", { token, storage_path: "p", file_name: "f.pdf" });
  assert.equal(noTitle.status, 400, "a drawing without a title must be refused");
});

test("the caller cannot choose the drawing number or the revision", () => {
  const src = read("supabase/functions/portal-api/index.ts");
  const start = src.indexOf('action === "createDrawingWithRevision"');
  assert.ok(start > 0, "createDrawingWithRevision not found");
  const block = src.slice(start, src.indexOf('action === "adoptDrawing"'));
  // An identity the caller can supply is one that collides and drifts. The
  // number comes from the generator and the first revision is always "A".
  assert.ok(!/body\.drawing_number/.test(block), "drawing_number is read from the request body");
  assert.ok(!/body\.revision/.test(block), "revision is read from the request body");
  assert.ok(/generateDrawingNumber\(/.test(block), "the number is not generated server-side");
  assert.ok(/revision: "A"/.test(block), 'the first revision is not pinned to "A"');
});

test("the AI extractor never returns our identity fields", () => {
  const src = read("supabase/functions/portal-ai/index.ts");
  const start = src.indexOf('action === "extractDrawingMeta"');
  assert.ok(start > 0, "extractDrawingMeta not found");
  const block = src.slice(start, start + 6000);
  const keys = block.match(/const KEYS = \[([\s\S]*?)\];/);
  assert.ok(keys, "the extractor's key list was not found");
  // It may read the SUPPLIER's number and revision; it must never produce ours.
  assert.ok(!/"drawing_number"/.test(keys[1]), "the extractor can return drawing_number — identity must be system-assigned");
  assert.ok(!/"revision"(?!_)/.test(keys[1].replace(/"supplier_revision"/g, "")), "the extractor can return revision");
  assert.ok(/"supplier_drawing_number"/.test(keys[1]) && /"supplier_revision"/.test(keys[1]),
    "the extractor should capture the supplier's identifiers");
});

test("drawing metadata extraction runs on haiku, not opus", () => {
  const env = read("supabase/functions/_shared/env.ts");
  assert.ok(/META_MODEL = "claude-haiku/.test(env), "META_MODEL is not a haiku model");
  const src = read("supabase/functions/portal-ai/index.ts");
  const start = src.indexOf('action === "extractDrawingMeta"');
  const block = src.slice(start, start + 6000);
  assert.ok(/model: META_MODEL/.test(block), "extractDrawingMeta does not use META_MODEL");
  assert.ok(!/model: SCAN_MODEL/.test(block), "extractDrawingMeta still uses the opus scan model");
});

test("adoption refuses a drawing that already belongs to a part", () => {
  const src = read("supabase/functions/portal-api/index.ts");
  const start = src.indexOf('action === "adoptDrawing"');
  const block = src.slice(start, start + 4000);
  // Re-homing rewrites what a released revision was built against; it must not
  // hide inside adoption.
  assert.ok(/if \(drawing\.owner_component_id\)/.test(block), "adoptDrawing does not check for an existing owner");
  assert.ok(/already belongs to a part/i.test(block), "adoptDrawing does not refuse an owned drawing");
});

test("the creation modal asks for the part before the file, and never for a number", () => {
  const app = read("assets/app.js");
  const start = app.indexOf("function newDrawingModal(");
  assert.ok(start > 0, "newDrawingModal not found");
  const block = app.slice(start, app.indexOf("async function openDrawingDetail("));
  assert.ok(/renderStep1/.test(block) && /renderStep2/.test(block) && /renderStep3/.test(block),
    "the three-step flow is missing");
  assert.ok(/free/i.test(block), "there is no free-drawing option");
  // The old modal's number field must be gone, or two numbering schemes coexist.
  assert.ok(!/Drawing number/.test(block), "the modal still asks for a drawing number");
  assert.ok(!/RR-DWG-0001/.test(block), "the old drawing-number placeholder is still present");
});

test("the drawing file step supports drag & drop, and reuses the shared upload zone", () => {
  const app = read("assets/app.js");
  const start = app.indexOf("function newDrawingModal(");
  const block = app.slice(start, app.indexOf("function adoptDrawingModal("));
  // uploadZone carries drag & drop, the animated bar and the upload → AI-read
  // phasing. Hand-rolling a second file input here would mean the drawing
  // upload behaved differently from every other upload in the portal.
  assert.ok(/uploadZone\(role, "documents"/.test(block), "step 2 does not use the shared uploadZone");
  assert.ok(/finishProcessing\(/.test(block), "the AI-read phase never lands the progress bar");
  assert.ok(/addEventListener\("paste"/.test(block), "pasting a drawing is not supported");
  assert.ok(/removeEventListener\("paste"/.test(block), "the paste listener is never removed");
});

test("openModal dialogs suppress the component panel's image paste", () => {
  const app = read("assets/app.js");
  const i = app.indexOf('class: "viewer-overlay"');
  assert.ok(i > 0, "openModal overlay not found");
  const line = app.slice(app.lastIndexOf("\n", i), app.indexOf("\n", i));
  // Without this marker, pasting a screenshot while any openModal dialog is open
  // uploads it to the component's Images tab instead of the dialog in front of
  // the user — a silent wrong destination.
  assert.ok(/data-modal-overlay/.test(line),
    "openModal's overlay lacks data-modal-overlay, so a paste leaks to the detail panel behind it");
});

test("no replaceChildren call passes a bare null child", () => {
  // Node.replaceChildren() stringifies non-Nodes, so a conditional child that
  // evaluates to null renders the literal word "null" on the page. el() forgives
  // this in its children array; the raw DOM method does not, and the difference
  // is invisible until a user reads "null" in a form.
  const src = read("assets/app.js");
  const offenders = [];
  const re = /(\w+)\.replaceChildren\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1, j = re.lastIndex;
    while (j < src.length && depth > 0) {
      const ch = src[j];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      j++;
    }
    // Keep only depth-0 text, so nested el(... : null) calls are not counted.
    let d = 0, top = "";
    for (const ch of src.slice(re.lastIndex, j - 1)) {
      if (ch === "(" || ch === "[") d++;
      else if (ch === ")" || ch === "]") d--;
      if (d === 0) top += ch;
    }
    if (/:\s*null\s*(,|$)/m.test(top)) {
      offenders.push(`line ${src.slice(0, m.index).split("\n").length}: ${m[1]}.replaceChildren(...)`);
    }
  }
  assert.deepEqual(offenders, [],
    `these pass a conditional null straight to the DOM and will render "null":\n  ${offenders.join("\n  ")}`);
});

test("the Documents tab does not describe drawings as belonging to it", () => {
  const app = read("assets/app.js");
  const start = app.indexOf("const docsSection = el(");
  assert.ok(start > 0, "docsSection not found");
  const block = app.slice(start, app.indexOf("// Materials section", start));
  // The category was removed in PROP-045, so telling a user to pick it is
  // instructing them to do something the UI no longer allows.
  assert.ok(!/category to drawing/i.test(block),
    "the Documents empty state still tells the user to set the category to drawing");
  assert.ok(/Drawings tab/.test(block),
    "the Documents tab should point at the Drawings tab rather than leaving the user to find it");
});

test("documents have versions and drawings have revisions, consistently", () => {
  const app = read("assets/app.js");
  // openNewVersionModal is the DOCUMENT flow. Borrowing the drawing word here
  // makes two genuinely different things read as one.
  const docStart = app.indexOf("function openNewVersionModal(");
  assert.ok(docStart > 0, "openNewVersionModal not found");
  const docBlock = app.slice(docStart, app.indexOf("const docRows = ", docStart));
  for (const wrong of ['"New revision"', '"Revision label"', '"Upload revision"']) {
    assert.ok(!docBlock.includes(wrong), `the document version flow still says ${wrong}`);
  }
  // …and the drawing flow must keep saying revision.
  const drawStart = app.indexOf("function addDrawingRevisionModal(");
  const drawBlock = app.slice(drawStart, app.indexOf("function adoptDrawingModal(", drawStart));
  assert.ok(/Revision letter/.test(drawBlock), "the drawing flow no longer asks for a revision letter");
});

test("the Change Log does not claim the database captures everything", () => {
  const app = read("assets/app.js");
  // Four sources feed this trail and only one of them is a database trigger.
  // Overclaiming completeness is precisely the failure this trail has had twice.
  assert.ok(!/every field change captured automatically by the database/.test(app),
    "the Change Log still describes itself as capturing everything automatically");
});
