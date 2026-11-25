// The 0063 + 0064 clean-up (docs/STATUS_MODEL.md §9): the legacy object-level
// status columns go, in two steps, and no edge function may name them any more.
//
// Pure, static, always runs: it reads the two migration files and every source
// under supabase/functions. The order the contract fixes — 0063 releases the
// constraints, the function stops writing, 0064 drops — is what makes each
// check here matter: a function that still wrote cad_model_files.revision
// would fail after 0064, and a 0064 that cast checked/approved would rewrite a
// row a human must decide about.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*--.*$/gm, "");

const m63 = read("supabase/migrations/0063_release_legacy_columns.sql");
const m64 = read("supabase/migrations/0064_drop_legacy_columns.sql");
const sql63 = stripComments(m63);
const sql64 = stripComments(m64);

/** Every .ts / .mjs / .js under supabase/functions, as { path, src } with comments stripped. */
function functionSources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|mjs|js)$/.test(name)) out.push({ path: p.slice(root.length + 1), src: stripComments(readFileSync(p, "utf8")) });
    }
  };
  walk(join(root, "supabase/functions"));
  return out;
}

// ---------------------------------------------------------------------------
// 0063 — release the legacy columns, drop nothing
// ---------------------------------------------------------------------------
test("0063 drops NOT NULL on cad_model_files.revision", () => {
  assert.match(sql63, /ALTER TABLE cad_model_files\s+ALTER COLUMN revision DROP NOT NULL/);
});

test("0063 drops the legacy unique constraint and the index on (organization_id, cad_model_id, revision)", () => {
  assert.match(sql63, /ALTER TABLE cad_model_files\s+DROP CONSTRAINT IF EXISTS cad_model_files_organization_id_cad_model_id_revision_forma_key/);
  assert.match(sql63, /DROP INDEX IF EXISTS idx_cad_model_files_model\b/);
});

test("0063 makes cad_models.status and drawings.status optional with no default", () => {
  for (const table of ["cad_models", "drawings"]) {
    const re = new RegExp(`ALTER TABLE ${table}\\s+ALTER COLUMN status DROP NOT NULL,\\s+ALTER COLUMN status DROP DEFAULT`);
    assert.match(sql63, re, `${table}.status is not released`);
  }
});

test("0063 sets cad_model_files.cad_model_revision_id NOT NULL, guarded by a RAISE on an unlinked row", () => {
  assert.match(sql63, /ALTER TABLE cad_model_files\s+ALTER COLUMN cad_model_revision_id SET NOT NULL/);
  const guard = sql63.indexOf("RAISE EXCEPTION");
  assert.notEqual(guard, -1, "0063 has no guard");
  assert.ok(guard < sql63.indexOf("SET NOT NULL"), "the guard must run before SET NOT NULL");
  assert.match(sql63.slice(0, guard), /cad_model_revision_id IS NULL/, "the guard does not count unlinked files");
});

test("0063 drops nothing and reports counts", () => {
  assert.ok(!/DROP COLUMN/.test(sql63), "0063 drops a column; that is 0064's job");
  assert.ok(!/DROP TYPE/.test(sql63), "0063 touches the enum; that is 0064's job");
  assert.match(sql63, /RAISE NOTICE/);
});

// ---------------------------------------------------------------------------
// 0064 — drop
// ---------------------------------------------------------------------------
const DROPPED = {
  drawings:            ["status", "projection_angle", "sheet_size", "scale"],
  cad_models:          ["status", "current_revision"],
  cad_model_files:     ["revision", "released_at"],
  drawing_revisions:   ["checked_at", "checked_by", "approved_at", "approved_by"],
  cad_model_revisions: ["checked_at", "checked_by", "approved_at", "approved_by"],
};

test("0064 drops every listed column, IF EXISTS", () => {
  for (const [table, cols] of Object.entries(DROPPED)) {
    const start = sql64.indexOf(`ALTER TABLE ${table}\n`);
    assert.notEqual(start, -1, `0064 has no ALTER TABLE ${table}`);
    const stmt = sql64.slice(start, sql64.indexOf(";", start));
    for (const c of cols) {
      assert.match(stmt, new RegExp(`DROP COLUMN IF EXISTS ${c}\\b`), `0064 does not drop ${table}.${c}`);
    }
  }
});

test("0064 refuses to run while a revision row carries checked or approved — RAISE, not a cast", () => {
  const guard = sql64.indexOf("RAISE EXCEPTION");
  assert.notEqual(guard, -1, "0064 has no RAISE EXCEPTION guard");
  const before = sql64.slice(0, guard);
  assert.match(before, /FROM drawing_revisions\s+WHERE status::text IN \('checked', 'approved'\)/, "the guard does not count drawing revisions");
  assert.match(before, /FROM cad_model_revisions\s+WHERE status::text IN \('checked', 'approved'\)/, "the guard does not count CAD revisions");
  // The guard comes before the first DDL, so nothing is dropped when it fires.
  assert.ok(guard < sql64.indexOf("DROP COLUMN"), "the guard must run before the first drop");
  assert.ok(guard < sql64.indexOf("CREATE TYPE"), "the guard must run before the enum swap");
  // Nothing maps the retired words onto a surviving one.
  assert.ok(!/CASE\s+WHEN\s+status/i.test(sql64), "0064 casts a retired status instead of refusing");
});

test("0064 recreates drawing_status with exactly three labels through the new-type / USING / drop / rename pattern", () => {
  assert.match(sql64, /CREATE TYPE drawing_status_new AS ENUM \('draft', 'released', 'superseded'\)/);
  const labels = sql64.match(/CREATE TYPE drawing_status_new AS ENUM \(([^)]*)\)/)[1].split(",").map((s) => s.trim().replace(/'/g, ""));
  assert.deepEqual(labels, ["draft", "released", "superseded"]);
  for (const table of ["drawing_revisions", "cad_model_revisions"]) {
    assert.match(sql64, new RegExp(`ALTER TABLE ${table}\\s+ALTER COLUMN status DROP DEFAULT`), `${table}: default not dropped before the cast`);
    assert.match(sql64, new RegExp(`ALTER TABLE ${table}\\s+ALTER COLUMN status TYPE drawing_status_new USING status::text::drawing_status_new`), `${table}: column not altered with the USING cast`);
    assert.match(sql64, new RegExp(`ALTER TABLE ${table}\\s+ALTER COLUMN status SET DEFAULT 'draft'`), `${table}: default not restored`);
  }
  assert.match(sql64, /DROP TYPE drawing_status;/);
  assert.match(sql64, /ALTER TYPE drawing_status_new RENAME TO drawing_status;/);
  // Order inside the swap: defaults off → cast → defaults on → drop old → rename.
  const i = (s) => sql64.indexOf(s);
  assert.ok(i("DROP DEFAULT") < i("USING status::text::drawing_status_new"));
  assert.ok(i("USING status::text::drawing_status_new") < i("SET DEFAULT 'draft'"));
  assert.ok(i("SET DEFAULT 'draft'") < i("DROP TYPE drawing_status;"));
  assert.ok(i("DROP TYPE drawing_status;") < i("RENAME TO drawing_status;"));
  // drawings.status (a drawing_status column) is dropped before the swap, so it needs no cast.
  assert.ok(i("ALTER TABLE drawings\n") < i("CREATE TYPE drawing_status_new"), "drawings.status must be dropped before the enum swap");
  // Re-runnable: the swap only runs while the type still has a retired label.
  assert.match(sql64, /e\.enumlabel IN \('checked', 'approved'\)/);
});

// ---------------------------------------------------------------------------
// The functions — nothing selects or writes a dropped column
// ---------------------------------------------------------------------------
/** Every statement that starts at a tdb("<table>") / .from("<table>") call,
 *  up to its terminating semicolon. */
function tableChains(src, table) {
  const out = [];
  const re = new RegExp(`(?:tdb|from)\\("${table}"\\)`, "g");
  for (const m of src.matchAll(re)) {
    const end = src.indexOf(";", m.index);
    out.push(src.slice(m.index, end === -1 ? undefined : end));
  }
  return out;
}

test("no function source selects, filters on or writes a dropped column of its table", () => {
  const sources = functionSources();
  assert.ok(sources.some((f) => f.path.endsWith("portal-api/index.ts")), "portal-api not found");
  for (const { path, src } of sources) {
    for (const [table, cols] of Object.entries(DROPPED)) {
      for (const chain of tableChains(src, table)) {
        for (const c of cols) {
          // As a select-list entry, a filter column, an order column, or an object key.
          const asColumn = new RegExp(`(?:["',\\s{(]|^)${c}(?=\\s*[,"':)}]|\\s*$)`);
          assert.ok(!asColumn.test(chain), `${path}: a ${table} statement still names ${c}:\n${chain.trim().slice(0, 300)}`);
        }
      }
    }
  }
});

test("the named column lists that replaced select(\"*\") name no dropped column", () => {
  const src = stripComments(read("supabase/functions/portal-api/index.ts"));
  for (const [name, table] of [["DRAWING_FIELDS", "drawings"], ["CAD_MODEL_FIELDS", "cad_models"], ["DRAWING_REV_FIELDS", "drawing_revisions"]]) {
    const m = src.match(new RegExp(`const ${name} =\\s*((?:"[^"]*"\\s*\\+?\\s*)+);`));
    assert.ok(m, `${name} is not defined`);
    const cols = m[1].replace(/"\s*\+\s*"/g, "").replace(/"/g, "").split(",").map((c) => c.trim());
    for (const c of DROPPED[table]) assert.ok(!cols.includes(c), `${name} still names ${table}.${c}`);
  }
  assert.ok(!/tdb\("(?:drawings|cad_models)"\)\s*\.select\("\*"\)/.test(src), "a drawings / cad_models read still selects *");
});

test("the retired stamp and drawing-field names appear in no function source outside comments", () => {
  // Unambiguous names: a hit anywhere is a leftover. (checked_by is not in
  // this list: portal-ai's extractDrawingMeta reads a title block's "Checked
  // by" line into a key of that name, which is not the column.)
  const names = ["checked_at", "approved_at", "approved_by", "projection_angle", "sheet_size", "model_status"];
  for (const { path, src } of functionSources()) {
    for (const n of names) {
      assert.ok(!new RegExp(`\\b${n}\\b`).test(src), `${path} still names ${n}`);
    }
  }
});

test("the test agent's snapshot has no model_status and verifyRun does not compare one", () => {
  const core = stripComments(read("supabase/functions/_shared/test-agent-core.mjs"));
  assert.ok(!/model_status/.test(core), "test-agent-core still carries model_status");
  assert.ok(!/model\.status/.test(core), "test-agent-core still reads cad_models.status");
});

test("STATUSES in status-core are the three words the enum has after 0064", async () => {
  const { STATUSES } = await import(new URL("../supabase/functions/_shared/status-core.mjs", import.meta.url));
  assert.deepEqual(STATUSES, ["draft", "released", "superseded"]);
});
