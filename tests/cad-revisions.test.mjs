// CAD revisions — status lives on the revision (docs/STATUS_MODEL.md).
//
// Unauthenticated and tenancy assertions always run; the credentialed ones skip
// without TEST_RUSHROOM_PASSWORD, matching the harness convention. The pure
// rules (transition table, statusSummary) are covered by status-model.test.mjs;
// this file is about the portal-api surface around them.
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

const WRITES = ["linkCadDocument", "cadUploadUrl", "registerCadRevision",
                "releaseCadRevision", "setCadRevisionStatus"];
const READS = ["getComponentCad", "listCadModels"];

for (const action of [...WRITES, ...READS]) {
  test(`${action} rejects an unauthenticated call`, async () => {
    const r = await call(action);
    assert.notEqual(r.status, 200, `${action} answered 200 without a session`);
  });
}

test("a forged organization_id cannot reach another tenant's CAD models", async () => {
  const r = await call("listCadModels", { organization_id: "11111111-1111-1111-1111-111111111111" });
  assert.notEqual(r.status, 200);
});

test("a supplier can neither read nor write the CAD registry", async (t) => {
  if (!CREDS.supplierPassword) return t.skip("TEST_SUPPLIER_PASSWORD not set");
  const token = await loginShared("supplier", CREDS.supplierPassword);
  for (const action of [...WRITES, ...READS]) {
    const r = await call(action, {
      token, cad_model_id: "x", cad_model_revision_id: "x", component_id: "x",
      format: "step", storage_path: "p", file_name: "f.step", status: "checked",
    });
    if (notDeployed(r)) return t.skip("CAD revisions not deployed yet");
    assert.equal(r.status, 403, `${action} let a supplier through with ${r.status}`);
  }
});

test("listCadModels reports the derived facts per model", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const r = await call("listCadModels", { token });
  if (notDeployed(r)) return t.skip("CAD registry not deployed yet");
  assert.equal(r.status, 200, `error: ${r.json?.error}`);
  const models = r.json?.cad_models;
  assert.ok(Array.isArray(models), "cad_models must be an array");
  for (const m of models) {
    for (const key of ["current_revision", "status", "released_revision", "formats", "preview_file", "revision_count"]) {
      assert.ok(key in m, `model ${m.id} lacks ${key}`);
    }
    // Three lifecycle states; 0064 makes the enum exactly these.
    assert.ok(["draft", "released", "superseded"].includes(m.status), `model ${m.id} carries a retired status ${m.status}`);
    // The object only reports: no revisions means draft and no letters.
    if (m.revision_count === 0) {
      assert.equal(m.current_revision, null);
      assert.equal(m.released_revision, null);
      assert.equal(m.status, "draft");
    }
    // A released letter never sorts above the current one.
    if (m.released_revision && m.current_revision) {
      const [a, b] = [m.released_revision, m.current_revision];
      assert.ok(a.length < b.length || (a.length === b.length && a.localeCompare(b) <= 0),
        `model ${m.id}: released ${a} sorts after current ${b}`);
    }
  }
});

test("getComponentCad answers a part without CAD with a summary, not an error", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const r = await call("getComponentCad", { token, component_id: "00000000-0000-0000-0000-000000000000" });
  if (notDeployed(r)) return t.skip("CAD registry not deployed yet");
  assert.equal(r.status, 200, `error: ${r.json?.error}`);
  assert.equal(r.json?.cad_model, null);
  assert.deepEqual(r.json?.revisions, []);
  assert.deepEqual(r.json?.files, []);
  assert.ok(r.json?.summary && Array.isArray(r.json.summary.warnings), "summary.warnings missing");
  assert.ok(Array.isArray(r.json.summary.drawings), "summary.drawings missing");
});

test("releaseCadRevision and setCadRevisionStatus refuse an unknown revision", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const missing = await call("releaseCadRevision", { token, cad_model_revision_id: "00000000-0000-0000-0000-000000000000" });
  if (notDeployed(missing)) return t.skip("CAD revisions not deployed yet");
  assert.equal(missing.status, 404);
  const noId = await call("releaseCadRevision", { token });
  assert.equal(noId.status, 400);
  const noStatus = await call("setCadRevisionStatus", { token, cad_model_revision_id: "00000000-0000-0000-0000-000000000000" });
  assert.equal(noStatus.status, 400);
});

test("registerCadRevision validates its body before touching storage", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const noModel = await call("registerCadRevision", { token, format: "step", storage_path: "p", file_name: "f.step" });
  if (notDeployed(noModel)) return t.skip("CAD registry not deployed yet");
  assert.equal(noModel.status, 400, "cad_model_id is required");
  const badFormat = await call("registerCadRevision", {
    token, cad_model_id: "00000000-0000-0000-0000-000000000000", format: "obj", storage_path: "p", file_name: "f.obj",
  });
  assert.equal(badFormat.status, 400, "an unknown format must be refused");
  const unknown = await call("registerCadRevision", {
    token, cad_model_id: "00000000-0000-0000-0000-000000000000", format: "step", storage_path: "p", file_name: "f.step",
  });
  assert.equal(unknown.status, 404, "an unknown model must be refused");
});

test("the status of a CAD model is derived, never set by hand", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const list = await call("listCadModels", { token });
  if (notDeployed(list)) return t.skip("CAD registry not deployed yet");
  const withRevs = (list.json?.cad_models ?? []).find((m) => m.revision_count > 0 && m.component_id);
  if (!withRevs) return t.skip("no CAD model with revisions to check against");
  const r = await call("getComponentCad", { token, component_id: withRevs.component_id });
  assert.equal(r.status, 200, `error: ${r.json?.error}`);
  const { cad_model, revisions } = r.json;
  assert.equal(cad_model.current_revision, revisions[revisions.length - 1].revision, "current is the highest letter");
  assert.equal(cad_model.status, revisions[revisions.length - 1].status, "status is the current revision's");
  const released = revisions.filter((x) => x.status === "released");
  assert.ok(released.length <= 1, "at most one revision is released; the rest are superseded");
  assert.equal(cad_model.released_revision, released[0]?.revision ?? null);
  // Every file hangs off exactly one revision and knows its letter.
  for (const rev of revisions) for (const f of rev.files) assert.ok(f.id && f.format && "download_url" in f);
});

// --- static guarantees, no network -----------------------------------------

test("a CAD draft releases directly and the retired words are refused — the same table as drawings", async () => {
  const { canTransition, TRANSITIONS } = await import(new URL("../supabase/functions/_shared/status-core.mjs", import.meta.url));
  assert.equal(canTransition("cad", "draft", "released"), true);
  assert.equal(canTransition("cad", "draft", "checked"), false);
  assert.equal(canTransition("cad", "draft", "approved"), false);
  assert.deepEqual(TRANSITIONS.cad, TRANSITIONS.drawing);
  // setCadRevisionStatus refuses through the table with the table's text.
  const src = read("supabase/functions/portal-api/index.ts");
  const start = src.indexOf('action === "releaseCadRevision" || action === "setCadRevisionStatus"');
  const block = src.slice(start, src.indexOf('action === "listCadModels"', start));
  assert.ok(block.includes('canTransition("cad", rev.status, status)'), "setCadRevisionStatus does not consult the table");
  assert.ok(block.includes("`Cannot go from ${rev.status} to ${status}`"), "setCadRevisionStatus does not answer with the table's text");
  assert.ok(!/checked_at|approved_at/.test(block), "setCadRevisionStatus still stamps a retired state");
});

test("portal-api derives status from the shared status core", () => {
  const src = read("supabase/functions/portal-api/index.ts");
  assert.match(src, /from "\.\.\/_shared\/status-core\.mjs"/, "portal-api does not import status-core");
  for (const fn of ["canTransition", "compareRevision", "deriveObject", "statusSummary"]) {
    assert.ok(new RegExp(`\\b${fn}\\(`).test(src), `portal-api never calls ${fn}`);
  }
  // The portal assigns the letter (next letter per send); the RevX label in a
  // Fusion document name is metadata and must never decide a letter.
  assert.ok(!/\bparseRevisionLabel\(/.test(src), "portal-api derives a letter from the document label");
  // Every status / transition action is implemented on the revision …
  for (const a of ["registerCadRevision", "releaseCadRevision", "setCadRevisionStatus",
                   "getComponentCad", "listCadModels", "setDrawingRevisionStatus"]) {
    assert.ok(src.includes(`action === "${a}"`), `portal-api does not implement ${a}`);
  }
  // … and the object-level aliases are gone (0063/0064 clean-up): an unknown
  // action answers "unknown action", so nothing else is needed for them.
  for (const a of ["releaseCadModel", "setDrawingStatus"]) {
    assert.ok(!src.includes(`action === "${a}"`), `portal-api still dispatches the alias ${a}`);
  }
});

test("the API no longer reads the object-level status columns", () => {
  const src = read("supabase/functions/portal-api/index.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // The named column lists that replaced select("*") (0063/0064 clean-up).
  const constOf = (name) => {
    const m = src.match(new RegExp(`const ${name} =\\s*((?:"[^"]*"\\s*\\+?\\s*)+);`));
    assert.ok(m, `${name} is not defined`);
    return m[1].replace(/"\s*\+\s*"/g, "").replace(/"/g, "").split(",").map((c) => c.trim());
  };
  const cadModelCols = constOf("CAD_MODEL_FIELDS");
  assert.ok(!cadModelCols.includes("status") && !cadModelCols.includes("current_revision"),
    "CAD_MODEL_FIELDS still names the dropped status/current_revision");
  assert.ok(["id", "component_id", "fusion_document_id", "fusion_document_name", "current_revision_id"].every((c) => cadModelCols.includes(c)),
    "CAD_MODEL_FIELDS lacks a column the code reads");
  const drawingCols = constOf("DRAWING_FIELDS");
  for (const c of ["status", "projection_angle", "sheet_size", "scale"]) {
    assert.ok(!drawingCols.includes(c), `DRAWING_FIELDS still names the dropped ${c}`);
  }
  // No read of either table asks for everything any more: "*" would carry a
  // dropped column until 0064 and hide what an action answers with.
  assert.ok(!/tdb\("cad_models"\)\s*\.select\("\*"\)/.test(src), "a cad_models read still selects *");
  assert.ok(!/tdb\("drawings"\)\s*\.select\("\*"\)/.test(src), "a drawings read still selects *");
  // Reads of cad_models must not ask for the columns 0064 drops …
  for (const m of src.matchAll(/tdb\("cad_models"\)\s*\.select\("([^"]*)"\)/g)) {
    const cols = m[1].split(",").map((c) => c.trim());
    assert.ok(!cols.includes("status") && !cols.includes("current_revision"),
      `a cad_models read still selects the dropped status/current_revision: "${m[1]}"`);
  }
  // … nor must drawings reads ask for status or the three retired drawing
  // fields (the derived status replaces the column; the fields are gone).
  for (const m of src.matchAll(/tdb\("drawings"\)\s*\.select\(\s*"([^"]*)"(?:\s*\+\s*"([^"]*)")?/g)) {
    const cols = ((m[1] || "") + (m[2] || "")).split(",").map((c) => c.trim());
    for (const c of ["status", "projection_angle", "sheet_size", "scale"]) {
      assert.ok(!cols.includes(c), `a drawings read still selects ${c}: "${m[1]}"`);
    }
  }
  // … and no write to drawings or cad_models names the dropped columns.
  for (const m of src.matchAll(/tdb\("(?:drawings|cad_models)"\)\s*\.(?:update|insert)\(\{([^}]*)\}/g)) {
    assert.ok(!/(?:^|[\s,{])status\s*:/.test(m[1]), `a drawings/cad_models write still sets status: {${m[1].trim()}}`);
    assert.ok(!/(?:^|[\s,{])current_revision\s*:/.test(m[1]), `a cad_models write still sets current_revision: {${m[1].trim()}}`);
  }
  // … nor cad_model_files its letter or release stamp.
  for (const m of src.matchAll(/tdb\("cad_model_files"\)\s*\.select\("([^"]*)"\)/g)) {
    const cols = m[1].split(",").map((c) => c.trim());
    assert.ok(!cols.includes("revision") && !cols.includes("released_at"),
      `a cad_model_files read still selects revision/released_at: "${m[1]}"`);
  }
});

test("release is one rule on both sides and only the current revision qualifies", () => {
  const src = read("supabase/functions/portal-api/index.ts");
  assert.ok(src.includes("async function releaseRevisionRow("), "the shared release helper is missing");
  // The rule itself is pure and lives in the status core (releaseCheck), where
  // previewRelease reads it too; the helper must consult it before writing.
  const core = read("supabase/functions/_shared/status-core.mjs");
  assert.match(core, /is not the current revision; \$\{derived\.current\.revision\} is/,
    "releasing a non-current revision is not refused with the agreed message");
  assert.ok(src.includes("releaseCheck(kind, revisions, rev)"), "releaseRevisionRow does not consult releaseCheck");
  // Both tables go through the one helper — a second release path is where the
  // "released but not really" fault of §1 comes back.
  assert.ok(/releaseRevisionRow\(tdb, session, "drawing_revisions", "drawing"/.test(src), "drawings bypass the release helper");
  assert.ok(/releaseRevisionRow\(tdb, session, "cad_model_revisions", "cad"/.test(src), "CAD bypasses the release helper");
});

test("nothing writes or reads the legacy columns (0063/0064 clean-up)", () => {
  const src = read("supabase/functions/portal-api/index.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // syncCadModel keeps only the pointer.
  const sync = src.slice(src.indexOf("async function syncCadModel("), src.indexOf("function transitionStamp("));
  assert.ok(/tdb\("cad_models"\)\.update\(\{ current_revision_id: derived\.current\?\.id \?\? null \}\)/.test(sync),
    "syncCadModel does not write current_revision_id alone");
  assert.ok(!/status:/.test(sync) && !/current_revision:/.test(sync), "syncCadModel still mirrors cad_models.status / current_revision");
  // syncDrawingStatus keeps only the pointer.
  const dsync = src.slice(src.indexOf("async function syncDrawingStatus("), src.indexOf("async function loadCadRevisions("));
  assert.ok(/tdb\("drawings"\)\.update\(\{ current_revision_id: derived\.current\.id \}\)/.test(dsync),
    "syncDrawingStatus does not write current_revision_id alone");
  assert.ok(!/status:/.test(dsync), "syncDrawingStatus still mirrors drawings.status");
  // A CAD release stamps the revision only: no released_at write on the files.
  const rel = src.slice(src.indexOf("async function releaseRevisionRow("), src.indexOf("async function writeBomHistory("));
  assert.ok(!/tdb\("cad_model_files"\)/.test(rel), "releaseRevisionRow still touches cad_model_files");
  assert.ok(!/tdb\("cad_model_files"\)[^;]*released_at/.test(src), "a cad_model_files write or filter still names released_at");
  // registerCadRevision inserts the file without the letter or a release stamp.
  const reg = src.slice(src.indexOf('action === "registerCadRevision"'), src.indexOf('action === "getComponentCad"'));
  const ins = reg.slice(reg.indexOf('tdb("cad_model_files").insert({'), reg.indexOf("}).select", reg.indexOf('tdb("cad_model_files").insert({')));
  assert.ok(ins.length > 0, "registerCadRevision has no cad_model_files insert");
  assert.ok(!/(?:^|[\s,{])revision\s*[,:]/.test(ins), "registerCadRevision still writes cad_model_files.revision");
  assert.ok(!/released_at/.test(ins), "registerCadRevision still writes cad_model_files.released_at");
  // The object-level aliases do not exist.
  assert.ok(!src.includes('action === "releaseCadModel"'), "releaseCadModel is still dispatched");
  assert.ok(!src.includes('action === "setDrawingStatus"'), "setDrawingStatus is still dispatched");
});
