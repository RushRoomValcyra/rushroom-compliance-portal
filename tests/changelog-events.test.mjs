// Change Log event drift — no network, no credentials, always runs.
//
// bom_component_history accepts a fixed set of change_type values, enforced by a
// CHECK constraint in the migrations. getComponentChangelog reads only a subset.
// A value that is written but not read is invisible: the event happens, the row
// is stored, and the trail shows nothing — which in an audit trail is worse than
// an error, because it is indistinguishable from "nothing happened".
//
// That is exactly what happened to the drawing events and to document_revised,
// twice, so the agreement between the two lists is asserted mechanically here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

/**
 * Events reconstructed from a canonical table instead of from history. Reading
 * these here as well would double every revision and every document.
 */
const DELIBERATELY_EXCLUDED = new Map([
  ["version_bumped", "bom_component_versions is the canonical source for revisions"],
  ["document_linked", "component_documents is the canonical source for linked documents"],
]);

/** The newest CHECK constraint on bom_component_history.change_type. */
function allowedChangeTypes() {
  const dir = join(root, "supabase/migrations");
  let latest = null;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, f), "utf8");
    const m = [...sql.matchAll(/bom_component_history_change_type_check[\s\S]*?CHECK\s*\(\s*change_type\s+IN\s*\(([\s\S]*?)\)\s*\)/gi)].pop();
    if (m) latest = m[1];
  }
  assert.ok(latest, "no change_type CHECK constraint found in the migrations");
  return new Set([...latest.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
}

/** Events getComponentChangelog actually reads out of history. */
function readEvents() {
  const src = read("supabase/functions/portal-api/index.ts");
  const m = src.match(/const HISTORY_EVENTS = \[([\s\S]*?)\];/);
  assert.ok(m, "HISTORY_EVENTS not found in getComponentChangelog");
  return new Set([...m[1].replace(/\/\/.*$/gm, "").matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
}

test("every change_type the database accepts is either displayed or excluded on purpose", () => {
  const allowed = allowedChangeTypes();
  const shown = readEvents();
  const invisible = [...allowed].filter((t) => !shown.has(t) && !DELIBERATELY_EXCLUDED.has(t));
  assert.deepEqual(invisible, [],
    `these change_types can be written but are never read back into the Change Log, so the event would be stored and invisible:\n  ${invisible.join("\n  ")}`);
});

test("the changelog does not read events that a canonical source already supplies", () => {
  const shown = readEvents();
  const doubled = [...DELIBERATELY_EXCLUDED.keys()].filter((t) => shown.has(t));
  assert.deepEqual(doubled, [],
    `these would appear twice — once from history and once from their canonical table: ${doubled.join(", ")}`);
});

test("the frontend can label every event the changelog returns", () => {
  const app = read("assets/app.js");
  const labels = app.match(/const badgeLabel = \{([\s\S]*?)\}\[entry\.change_type\]/);
  assert.ok(labels, "the Change Log badge label map was not found");
  const missing = [...readEvents()].filter((t) => !new RegExp(`\\b${t}\\s*:`).test(labels[1]));
  // An unlabelled type still renders (it falls back to the raw value), so this
  // is about legibility rather than correctness — "drawing_revised" in a table
  // a compliance auditor reads is not the same as "drawing rev".
  assert.deepEqual(missing, [],
    `these events reach the Change Log with no human label: ${missing.join(", ")}`);
});
