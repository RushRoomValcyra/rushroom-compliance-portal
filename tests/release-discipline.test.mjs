// Release discipline — docs/DRAWINGS_TAB_UX.md §11, step D.
//
// The rule is releaseCheck in _shared/status-core.mjs (tested by hand-worked
// cases in status-model.test.mjs). Here: the static guarantees over
// portal-api/index.ts that the one release path and the preview share that
// rule, that previewRelease is Rushroom-only and loads the way getComponentCad
// does, and that an unauthenticated call is refused. The deployed copy may
// predate the action; "unknown action" is tolerated as in cad-test-agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { call } from "./config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const src = read("supabase/functions/portal-api/index.ts");

const M = await import(new URL("../supabase/functions/_shared/status-core.mjs", import.meta.url));
const { releaseCheck, releasedView, hasReleaseFile } = M;

/** The body of one `if (action === "name")` block: from its head to the next
 *  action head at the same indentation (the cad-drawings-tab pattern). */
function actionBlock(name) {
  // The head may dispatch several names: `if (action === "a" || action === "b")`.
  const head = `  if (action === "${name}"`;
  const start = src.indexOf(head);
  assert.notEqual(start, -1, `portal-api does not dispatch ${name}`);
  const rest = src.slice(start + head.length);
  const next = rest.search(/\n  if \(action === "/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The body of a top-level `async function name(` up to the next top-level function. */
function functionBody(name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `portal-api has no ${name}`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n(?:async )?function |\n\/\*\*|\nDeno\.serve/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

// ---------------------------------------------------------------------------
// The pure rule, as the contract words it (the full matrix is in status-model.test.mjs)
// ---------------------------------------------------------------------------
const rev = (revision, status, extra = {}) => ({ id: `rev-${revision}`, revision, status, ...extra });
const withFile = (r) => ({ ...r, files: [{ id: `f-${r.revision}`, format: "step", sha256: `sha-${r.revision}` }] });

test("releaseCheck: the four answers the contract names (three states since §12: a drawing draft releases like a CAD draft)", () => {
  const b = withFile(rev("B", "draft")), c = withFile(rev("C", "draft"));
  assert.deepEqual(releaseCheck("cad", [b, c], b), { error: "Rev B is not the current revision; C is" });
  assert.deepEqual(releaseCheck("drawing", [b, c], b), { error: "Issue B is not the current revision; C is" });
  // The transition refusal is now reserved for an old row carrying a retired word.
  const d = rev("D", "checked", { storage_path: "p/d.pdf" });
  assert.deepEqual(releaseCheck("drawing", [d], d), { error: "Cannot go from checked to released" });
  const e = rev("E", "draft", { files: [] });
  assert.deepEqual(releaseCheck("cad", [e], e), { error: "Rev E has no file" });
  const f = rev("F", "draft", { storage_path: "" });
  assert.deepEqual(releaseCheck("drawing", [f], f), { error: "Issue F has no file" });
  assert.deepEqual(releaseCheck("cad", [b, c], c), { ok: true });
  const g = rev("G", "draft", { storage_path: "p/g.pdf" });
  assert.deepEqual(releaseCheck("drawing", [g], g), { ok: true }, "a drawing draft with a file releases directly");
});

test("releaseCheck never writes: the revisions passed in are the same afterwards", () => {
  const a = withFile(rev("A", "released")), b = withFile(rev("B", "draft"));
  const before = JSON.stringify([a, b]);
  releaseCheck("cad", [a, b], b);
  releaseCheck("cad", [a, b], a);
  assert.equal(JSON.stringify([a, b]), before);
});

test("releasedView: the previous release is superseded and the input stays as it was", () => {
  const a = withFile(rev("A", "released")), b = withFile(rev("B", "draft"));
  const after = releasedView([a, b], "rev-B");
  assert.deepEqual(after.map((r) => r.status), ["superseded", "released"]);
  assert.deepEqual([a.status, b.status], ["released", "draft"]);
  assert.equal(hasReleaseFile("cad", after[1]), true, "the files travel with the copy");
});

// ---------------------------------------------------------------------------
// Static guarantees over portal-api
// ---------------------------------------------------------------------------
test("the retired transitions are gone from portal-api: nothing stamps checked or approved", () => {
  const start = src.indexOf("function transitionStamp(");
  assert.notEqual(start, -1, "transitionStamp is the one stamping helper");
  const body = src.slice(start, src.indexOf("\n}", start));
  assert.ok(!/checked_at|approved_at/.test(body), "transitionStamp still stamps a retired state");
  assert.ok(/released_at/.test(body) && /released_by/.test(body), "the release stamp stays");
  // No write anywhere sets checked_at / approved_at.
  assert.deepEqual(src.match(/(?:checked|approved)_(?:at|by): (?!r\.)[^,}]*/g) || [], [],
    "a write still stamps checked_* / approved_* (reads of r.checked_at for old rows are fine)");
  // Both status actions refuse through canTransition — the same table as the release.
  for (const [name, kind] of [["setDrawingRevisionStatus", "drawing"], ["releaseCadRevision", "cad"]]) {
    const block = actionBlock(name);
    assert.ok(block.includes(`canTransition("${kind}", rev.status, status)`), `${name} does not consult the table`);
    assert.ok(block.includes("`Cannot go from ${rev.status} to ${status}`"), `${name} does not answer with the table's text`);
  }
});

test("createDrawingWithRevision and createDrawing no longer read projection_angle, sheet_size or scale", () => {
  for (const name of ["createDrawingWithRevision", "createDrawing"]) {
    const block = actionBlock(name);
    assert.ok(!/body\.(?:projection_angle|sheet_size|scale)\b/.test(block), `${name} still reads a retired field from the body`);
  }
});

test("releaseRevisionRow applies releaseCheck before any write", () => {
  const body = functionBody("releaseRevisionRow");
  const check = body.indexOf("releaseCheck(kind, revisions, rev)");
  assert.notEqual(check, -1, "releaseRevisionRow does not call releaseCheck");
  const firstWrite = body.search(/await tdb\(/);
  assert.notEqual(firstWrite, -1);
  assert.ok(check < firstWrite, "the check must come before the first write");
  // The rule is not restated locally: no second copy of the texts.
  assert.ok(!/is not the current revision/.test(body), "the 'not current' text is restated in releaseRevisionRow");
  assert.ok(!/Cannot go from/.test(body), "the transition text is restated in releaseRevisionRow");
  assert.ok(/if \("error" in check\) return \{ error: check\.error, status: 400 \};/.test(body), "a refusal answers 400 with the exact text");
});

test("every release path goes through releaseRevisionRow (so all get the zero-file refusal)", () => {
  for (const name of ["setDrawingRevisionStatus", "registerCadRevision", "releaseCadRevision"]) {
    assert.ok(actionBlock(name).includes("await releaseRevisionRow("), `${name} does not release through releaseRevisionRow`);
  }
  // The old object-level aliases are gone (0063/0064 clean-up): the revision is the only thing released.
  assert.ok(src.includes('if (action === "setDrawingRevisionStatus")'));
  assert.ok(src.includes('if (action === "releaseCadRevision" || action === "setCadRevisionStatus")'));
  assert.ok(!src.includes('action === "setDrawingStatus"'), "the alias setDrawingStatus is still dispatched");
  assert.ok(!src.includes('action === "releaseCadModel"'), "the alias releaseCadModel is still dispatched");
  // No other caller writes status: "released" on a revision table by hand.
  const hand = src.match(/tdb\("(?:drawing_revisions|cad_model_revisions)"\)\.update\(\{[^}]*status: "released"/g) || [];
  assert.deepEqual(hand, [], "a hand-written release outside releaseRevisionRow");
});

test("the drawing revision rows carry storage_path, and getDrawing strips it again", () => {
  const fields = src.match(/const DRAWING_REV_FIELDS =\s*"([^"]*)"\s*\+\s*"([^"]*)"/);
  assert.ok(fields, "DRAWING_REV_FIELDS not found");
  assert.ok((fields[1] + fields[2]).split(/,\s*/).includes("storage_path"), "DRAWING_REV_FIELDS lacks storage_path");
  assert.ok(actionBlock("getDrawing").includes("({ storage_path: _path, ...r }: any) => r"), "getDrawing must not hand the storage path to a client");
});

test("previewRelease exists, is Rushroom-only, takes kind + revision_id and uses releaseCheck", () => {
  const block = actionBlock("previewRelease");
  assert.ok(/^\)\s*\{\s*\n\s*if \(role !== "rushroom"\) return json\(\{ error: "Rushroom only" \}, 403\);/.test(block), "the first line must refuse non-Rushroom callers");
  assert.ok(/body\.kind === "cad" \|\| body\.kind === "drawing"/.test(block), "kind is cad | drawing");
  assert.ok(block.includes('String(body.revision_id ?? "")'), "revision_id is the parameter");
  assert.ok(block.includes("releaseCheck(kind, revisions, rev)"), "the refusal must come from releaseCheck");
  assert.ok(!/is not the current revision/.test(block) && !/Cannot go from/.test(block) && !/has no file/.test(block),
    "the refusal texts must not be restated in previewRelease");
  assert.ok(/refusal: check\.error/.test(block), "refusal carries releaseCheck's text verbatim");
});

test("previewRelease writes nothing", () => {
  const block = actionBlock("previewRelease");
  assert.ok(!/\.(update|insert|upsert|delete)\(/.test(block), "a write inside previewRelease");
  assert.ok(!/(?:releaseRevisionRow|syncCadModel|syncDrawingStatus|writeBomHistory|recordDrawingEvent)\(/.test(block), "a release side effect inside previewRelease");
});

test("previewRelease computes 'after' with releasedView and the same two pure views as the test agent", () => {
  const block = actionBlock("previewRelease");
  assert.ok(block.includes("releasedView(revisions, rev.id)"), "after = releasedView of the loaded revisions");
  assert.equal((block.match(/statusSummary\(/g) || []).length >= 3, true, "warnings now and after come from statusSummary");
  assert.equal((block.match(/snapshotSupplierView\(/g) || []).length, 4, "supplier_now / supplier_after for both kinds");
  for (const key of ["warnings_now:", "warnings_after:", "supplier_now:", "supplier_after:", "supersedes:", "can_release", "refusal", "made_from:", "this_issue_made_from:"]) {
    assert.ok(block.includes(key), `previewRelease lacks ${key}`);
  }
  assert.ok(/import \{[^}]*\bsnapshotSupplierView\b[^}]*\} from "\.\.\/_shared\/test-agent-core\.mjs"/.test(src), "snapshotSupplierView must be imported from test-agent-core");
  assert.ok(/import \{[^}]*\breleaseCheck\b[^}]*\breleasedView\b[^}]*\} from "\.\.\/_shared\/status-core\.mjs"/.test(src), "releaseCheck and releasedView must be imported from status-core");
});

test("previewRelease loads the part's drawings and CAD the way getComponentCad does", () => {
  const block = actionBlock("previewRelease");
  assert.ok(/tdb\("drawing_components"\)\.select\("drawing_id, role"\)\.eq\("component_id", componentId\)/.test(block));
  assert.ok(/tdb\("drawings"\)\.select\("[^"]*is_supplier_visible[^"]*"\)\.in\("id", drawingIds\)/.test(block), "drawings with is_supplier_visible for the supplier view");
  assert.ok(block.includes("loadDrawingRevisions(tdb, drawingIds)"));
  assert.ok(block.includes("loadCadRevisions(tdb, cad_model_id)") && block.includes("loadCadRevisions(tdb, model.id)"));
  assert.ok(/l\.role === "depicts"/.test(block), "a drawing linked in several roles counts as depicting");
  assert.ok(block.includes('select("id, part_number, name")'), "the part comes from bom_components");
  assert.ok(/owner_component_id/.test(block), "a drawing's part is its owner");
  assert.ok(/\.slice\(0, 8\)/.test(block), "sha8 is the first eight hex characters");
});

// ---------------------------------------------------------------------------
// portal-api surface — no credentials
// ---------------------------------------------------------------------------
const notDeployed = (r) => /unknown action/i.test(r.json?.error ?? "");

test("previewRelease rejects an unauthenticated call", async () => {
  const r = await call("previewRelease", { kind: "cad", revision_id: "x" });
  if (notDeployed(r)) return;   // the deployed copy predates step D
  assert.equal(r.status, 401, `previewRelease answered ${r.status} without a session`);
});
