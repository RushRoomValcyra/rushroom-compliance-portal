// BOM export (PROP-048) — the CSV writer and tree flattener are exercised for
// real here, not just pattern-matched, because a corrupted export is the kind of
// defect that surfaces weeks later in someone else's spreadsheet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "assets/app.js"), "utf8");

/** Lift a function out of the app IIFE so it can be run directly. */
function lift(signature) {
  const m = src.match(new RegExp(`function ${signature} \\{[\\s\\S]*?\\n  \\}`));
  assert.ok(m, `${signature} not found in assets/app.js`);
  return eval(`(${m[0]})`);
}

const toCSV = lift("toCSV\\(rows, columns\\)");
const flatten = lift("flattenBomForExport\\(rootId, nodes, edges\\)");

const cols = [{ label: "ID", get: (r) => r.id }, { label: "Name", get: (r) => r.name }];

test("CSV starts with a UTF-8 BOM so Excel reads å ä ö correctly", () => {
  const out = toCSV([{ id: "1", name: "Fäste" }], cols);
  assert.equal(out.charCodeAt(0), 0xfeff, "no BOM — Swedish part names will open mangled on Windows Excel");
});

test("CSV quotes and escapes commas, quotes and newlines", () => {
  const out = toCSV([{ id: "1", name: 'Panel, 600mm "wide"' }, { id: "2", name: "two\nlines" }], cols);
  assert.ok(out.includes('"Panel, 600mm ""wide"""'), "quotes are not doubled inside a quoted field");
  assert.ok(/"two\nlines"/.test(out), "a field containing a newline is not quoted");
});

test("CSV neutralises spreadsheet formula injection", () => {
  // A part name is untrusted text as far as Excel is concerned: =, +, - and @
  // all start a formula, and one of them opening a shell is a real attack.
  for (const bad of ["=cmd|calc", "+1+1", "-1+1", "@SUM(A1)"]) {
    const out = toCSV([{ id: "1", name: bad }], cols);
    assert.ok(out.includes(`'${bad}`), `${bad} is not neutralised`);
  }
});

test("CSV uses CRLF and renders null as empty", () => {
  const out = toCSV([{ id: "1", name: null }], cols);
  assert.ok(out.includes("\r\n"), "not CRLF — Excel expects it");
  assert.ok(/1,\r\n/.test(out), "null did not become an empty field");
});

const NODES = [
  { id: "P", name: "Wardrobe", part_number: "RR-P", type: "sub_assembly" },
  { id: "A", name: "Panel", part_number: "RR-A", type: "part" },
  { id: "B", name: "Shelf", part_number: "RR-B", type: "sub_assembly" },
  { id: "S", name: "Screw", part_number: "RR-S", type: "part" },
];
const EDGES = [
  { parent_id: "P", child_id: "A", quantity: 2, sort_order: 1 },
  { parent_id: "P", child_id: "B", quantity: 3, sort_order: 2 },
  { parent_id: "B", child_id: "S", quantity: 4, sort_order: 1 },
  { parent_id: "P", child_id: "S", quantity: 8, sort_order: 3 },
];

test("the tree exports one row per occurrence, not per component", () => {
  const rows = flatten("P", NODES, EDGES);
  const screws = rows.filter((r) => r.id === "S");
  // A screw used in four places is four lines in a bill of materials.
  // Collapsing them would understate what has to be bought.
  assert.equal(screws.length, 2, "repeated components were collapsed");
  assert.deepEqual(screws.map((r) => r.quantity).sort(), [4, 8]);
});

test("positions and levels describe the hierarchy", () => {
  const rows = flatten("P", NODES, EDGES);
  assert.equal(rows[0].level, 0, "the root is not level 0");
  assert.equal(rows[0].quantity, "", "the root should carry no quantity — nothing consumes it");
  assert.deepEqual(rows.map((r) => r.position), ["", "1", "2", "2.1", "3"]);
  assert.equal(rows.find((r) => r.position === "2.1").parent_name, "Shelf");
});

test("a malformed edge set terminates instead of hanging the browser", () => {
  // The database forbids cycles, but the export must not depend on that.
  const cyc = [{ parent_id: "P", child_id: "A", quantity: 1, sort_order: 1 },
               { parent_id: "A", child_id: "P", quantity: 1, sort_order: 1 }];
  const started = Date.now();
  const rows = flatten("P", NODES, cyc);
  assert.ok(Date.now() - started < 2000, "cycle walk did not terminate quickly");
  assert.ok(rows.length < 50, `cycle produced ${rows.length} rows`);
});

test("export writes the whole filtered set, not the paginated page", () => {
  // The list renders PAGE_SIZE rows at a time. Exporting the rendered slice
  // would silently truncate, and a short export looks exactly like a short BOM.
  assert.ok(/exportSet = items;/.test(src), "exportSet is not captured from the sorted set");
  const i = src.indexOf("exportSet = items;");
  const slice = src.indexOf("items.slice(0, shown)");
  assert.ok(i > 0 && slice > i, "exportSet is assigned from the paginated slice rather than the full set");
});

test("both formats share one column definition", () => {
  // Two definitions would eventually disagree about what an export contains.
  assert.equal((src.match(/const BOM_EXPORT_COLUMNS =/g) || []).length, 1);
  assert.ok(/exportRows\(rows, columns, basename, format\)/.test(src),
    "CSV and XLSX do not go through one function");
});

test("Excel reuses the viewer's SheetJS rather than adding a dependency", () => {
  assert.ok(/await loadScript\(XLSX_CDN\)/.test(src), "XLSX is not lazy-loaded from the existing CDN constant");
});
