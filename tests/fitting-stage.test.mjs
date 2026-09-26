// Where a part is fitted (PROP-056) — static, no credentials.
//
// Some parts inside an assembly are joined at the logistics hub before
// delivery; others are inserted during physical installation. The distinction
// lives on the EDGE, because the same screw can be hub-fitted under one panel
// and site-fitted under another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const app = read("assets/app.js");
const api = read("supabase/functions/portal-api/index.ts");
const mig = read("supabase/migrations/0036_edge_fitting_stage.sql");

test("the stage is a column on bom_edges, not on bom_components", () => {
  assert.ok(/ALTER TABLE bom_edges ADD COLUMN IF NOT EXISTS fitting_stage TEXT/.test(mig),
    "fitting_stage is not added to bom_edges");
  assert.ok(!/ALTER TABLE bom_components[\s\S]*fitting_stage/.test(mig),
    "the stage is on the component, which cannot express the same part fitted differently in two places");
});

test("only hub, site and not-set are accepted, in the database and the function", () => {
  const check = mig.match(/CHECK \(fitting_stage IS NULL OR fitting_stage IN \(([^)]*)\)\)/);
  assert.ok(check, "no CHECK constraint on fitting_stage");
  assert.deepEqual(check[1].replace(/'/g, "").split(",").map((x) => x.trim()).sort(), ["hub", "site"]);
  // The function's list must match the constraint, or a value it accepts comes
  // back as a raw Postgres error instead of a usable message.
  const consts = api.match(/const FITTING_STAGES = \[([^\]]*)\]/);
  assert.ok(consts, "FITTING_STAGES not found in portal-api");
  assert.deepEqual(consts[1].replace(/"/g, "").split(",").map((x) => x.trim()).filter(Boolean).sort(), ["hub", "site"]);
});

test("NULL stays a distinct state, not a default", () => {
  // Every edge that exists today is unset; defaulting them to a stage would
  // invent a decision nobody made.
  assert.ok(!/fitting_stage TEXT[^;]*DEFAULT/.test(mig), "the column has a default, so existing edges gain a stage nobody chose");
  assert.ok(!/fitting_stage[^;]*NOT NULL/.test(mig), "the column is NOT NULL, which forces a decision on 100+ existing edges");
});

test("getBom returns the stage, or the tree cannot render it", () => {
  // The recurring defect in this codebase is data written and then filtered out
  // of the query that displays it.
  const sel = api.match(/from\("bom_edges"\)\.select\("id, parent_id, child_id, quantity, reference_designator, variant_condition, sort_order[^"]*"\)/);
  assert.ok(sel, "the getBom edge select was not found");
  assert.ok(sel[0].includes("fitting_stage"), "getBom does not return fitting_stage");
});

test("changing the stage is audited where the Change Log will show it", () => {
  const fn = api.match(/if \(action === "setEdgeFittingStage"\)[\s\S]*?\n  \}/);
  assert.ok(fn, "setEdgeFittingStage not found");
  assert.ok(/bom_component_history/.test(fn[0]), "the change is not audited");
  // "updated" is in getComponentChangelog's HISTORY_EVENTS; a new change_type
  // would need the CHECK widened AND that list extended, or the row is written
  // and never displayed — which has happened twice in this repo.
  assert.ok(/change_type: "updated"/.test(fn[0]), "the audit row uses a change_type the Change Log may filter out");
  assert.ok(/HISTORY_EVENTS/.test(api) && /"updated"/.test(api.match(/const HISTORY_EVENTS = \[[^\]]*\]/)[0]),
    "HISTORY_EVENTS no longer includes 'updated'");
  assert.ok(/role !== "rushroom"/.test(fn[0]), "a supplier session can change where parts are fitted");
  assert.ok(/is\("effective_to", null\)/.test(fn[0]), "a closed edge can be restaged");
});

test("the tree header and its rows declare the same columns", () => {
  // A grid whose header has one fewer column than its rows misaligns silently.
  const grids = [...app.matchAll(/grid-template-columns:(6rem 1fr [^;"`]*)/g)].map((m) => m[1].trim());
  assert.ok(grids.length >= 2, `expected the header and the row grid, found ${grids.length}`);
  assert.equal(new Set(grids).size, 1, `header and row grids differ:\n  ${grids.join("\n  ")}`);
  const cols = grids[0].split(/\s+/).length;
  const header = app.match(/\}, \["Pos\.", isDynamicBom \? "Configuration" : "Part",([^\]]*)\]/);
  assert.ok(header, "the header label list was not found");
  const labels = 2 + header[1].split(",").filter((x) => x.trim()).length;
  assert.equal(labels, cols, `${cols} grid columns but ${labels} header labels`);
  assert.ok(/"Fitted"/.test(header[0]), "the Fitted column has no header");
});

test("the counts describe the delivery, not the screen", () => {
  const strip = app.match(/const stageTally = \(\(\) => \{[\s\S]*?\}\)\(\);/);
  assert.ok(strip, "stageTally not found");
  // buildRows() stops at collapsed nodes; counting those rows would make the
  // totals change when someone collapses a sub-assembly that still ships.
  assert.ok(/\(edges \|\| \[\]\)\.forEach/.test(strip[0]), "the tally counts rendered rows rather than edges");
  assert.ok(!/buildRows\(\)/.test(strip[0]), "the tally is derived from the collapsed view");
  assert.ok(/unset/.test(strip[0]), "unset edges are not counted, so an unanswered question looks answered");
  assert.ok(/not set/.test(app), "the strip never shows the unset count");
});

test("the stage control does not open the detail panel", () => {
  // PROP-055: a row opens the panel on double-click, and this cell is a button
  // plus a select.
  const cell = app.match(/const stageCell = \(\) => \{[\s\S]*?\n        \};/);
  assert.ok(cell, "stageCell not found");
  assert.ok(/"data-row-control": ""/.test(cell[0]), "the stage cell is not marked as a row control");
  assert.ok(/ev\.stopPropagation\(\)/.test(cell[0]), "the stage control does not stop click propagation");
});

test("the front end and the function agree on the vocabulary", () => {
  const ui = app.match(/const FITTING_STAGES = \[([\s\S]*?)\];/);
  assert.ok(ui, "FITTING_STAGES not found in app.js");
  const ids = [...ui[1].matchAll(/id: "([a-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(ids, ["hub", "site"], "the UI offers stages the database will reject");
});

test("the migration is the newest one, so db push applies it before the deploy", () => {
  const files = readdirSync(join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  assert.equal(files[files.length - 1], "0036_edge_fitting_stage.sql",
    "a later migration exists — check the ordering of this deploy");
});
