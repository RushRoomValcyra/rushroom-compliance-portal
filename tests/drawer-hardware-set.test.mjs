// Drawer hardware set (migration 0039) — static, no credentials.
//
// The bought drawer hardware set is one BOM line (rule 1: buy unit = BOM
// line); its slides and screws come in the box. Like 0038, this is a data
// migration against a live BOM, so its safety shape is what is asserted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../supabase/migrations/0039_drawer_hardware_set.sql", import.meta.url), "utf8");
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

test("0039 is one atomic block and a no-op without the production rows", () => {
  const parts = code.split(/\$mig\$/);
  assert.equal(parts.length, 3, "expected exactly one DO $mig$ … $mig$ block");
  assert.equal(parts[2].trim(), ";", "statements outside the DO block would commit on their own");
  assert.ok(/IF NOT EXISTS \(SELECT 1 FROM bom_components WHERE part_number = 'RR-202609-ALVZKBQR'\)[\s\S]*?RETURN;/.test(code));
});

test("0039 never deletes and only closes links", () => {
  assert.ok(!/\bDELETE\b/i.test(code));
  assert.ok(!/UPDATE bom_edges SET (?!effective_to = current_date)/.test(code));
});

test("the hardware set becomes a purchased part with no children", () => {
  assert.ok(/SET type = 'part', make_or_buy = 'purchased'/.test(code));
  assert.ok(/WHERE parent_id = hw\.id AND effective_to IS NULL/.test(code), "the set's child links are not closed");
});

test("0039 is re-runnable", () => {
  assert.ok((code.match(/skipped/g) || []).length >= 3, "each step must skip when already done");
});

test("0039 aborts on a part-parent or any change to planner output", () => {
  assert.ok(/RAISE EXCEPTION '0039 aborted: parts holding children/.test(code));
  assert.ok(/RAISE EXCEPTION '0039 aborted: planner output would change/.test(code));
  // Symmetric difference, parenthesised: A EXCEPT B UNION ALL C EXCEPT D would
  // parse left to right and silently compare the wrong sets.
  assert.ok(/\(\(SELECT root, leaf, qty FROM _leaf_before\s+EXCEPT/.test(code));
});
