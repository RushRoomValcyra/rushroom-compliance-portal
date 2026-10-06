// Prepared wrappers (migration 0038) — static, no credentials.
//
// A purchased part never holds children: the work done to it lives in its
// "Prepared …" sub-assembly. 0038 moves the 42 child links that production
// had under 24 parts. It is a data migration against a live BOM, so what is
// asserted here is its safety shape, not its data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase/migrations/0038_prepared_wrappers.sql", import.meta.url), "utf8");
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

test("0038 is one atomic block, so a failed guard changes nothing", () => {
  const statements = code.split(/\$mig\$/);
  assert.equal(statements.length, 3, "expected exactly one DO $mig$ … $mig$ block");
  assert.ok(/^\s*DO\s*$/.test(statements[0].trim().split("\n").pop()), "the block is not a DO statement");
  assert.equal(statements[2].trim(), ";", "statements outside the DO block would commit on their own");
});

test("0038 is a no-op on a database without the production rows", () => {
  assert.ok(/IF NOT EXISTS \(SELECT 1 FROM bom_components WHERE part_number = 'RR-202609-G26N4P8A'\)[\s\S]*?RETURN;/.test(code),
    "a fresh `supabase db reset` would raise instead of skipping");
});

test("0038 never deletes and never edits a link in place", () => {
  assert.ok(!/\bDELETE\b/i.test(code), "retire-not-delete: nothing may be deleted");
  assert.ok(!/UPDATE bom_edges SET (?!effective_to = current_date)/.test(code),
    "a link may only be closed; changing parent_id/quantity in place would erase its history");
});

test("every moved link keeps quantity, designator, condition and fitting stage", () => {
  const inserts = [...code.matchAll(/INSERT INTO bom_edges \(([^)]*)\)\s*VALUES \(([^;]*?)\);/g)];
  const copies = inserts.filter((m) => /e\.quantity/.test(m[2]));
  assert.equal(copies.length, 2, "expected two copying inserts: re-point the parent, and move a child");
  for (const [, cols, vals] of copies) {
    for (const f of ["quantity", "reference_designator", "variant_condition", "fitting_stage"]) {
      assert.ok(cols.includes(f) && vals.includes(`e.${f}`), `a moved link drops ${f}`);
    }
  }
});

test("the block aborts if any part still holds children", () => {
  assert.ok(/par\.type = 'part'[\s\S]*?RAISE EXCEPTION '0038 aborted: parts still holding children/.test(code));
});

test("the block aborts if Order Operations would lose or change a quantity", () => {
  assert.ok(/_leaf_before[\s\S]*_leaf_after/.test(code), "no before/after snapshot of planner leaves");
  assert.ok(/RAISE EXCEPTION '0038 aborted: planner quantities would change/.test(code));
  assert.ok(/RAISE EXCEPTION '0038 aborted: unexpected new planner lines/.test(code),
    "only the wrapped parts may appear as new planner lines");
});

test("retiring marks 'replaced' with a note and refuses anything still in use", () => {
  assert.ok(/lifecycle_status = 'replaced'/.test(code));
  assert.ok(/replacement_note = step\.arg/.test(code));
  assert.ok(/still used by a live assembly — not retiring it/.test(code));
});

test("new wrappers are Assembled sub-assemblies with revision A, like addComponent", () => {
  assert.ok(/'sub_assembly', 'assembled', 'inactive'/.test(code));
  assert.ok(/INSERT INTO bom_component_versions[\s\S]*?'A', 'Initial revision', true/.test(code));
  assert.ok(/'version_bumped'/.test(code));
});
