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

test("both Excel writers are lazy-loaded, so neither costs a page load", () => {
  // The flat writer reuses the viewer's SheetJS. The picture writer (PROP-049)
  // adds ExcelJS — deliberately, because SheetJS cannot embed images — and the
  // 948 KB only downloads when someone presses the button.
  assert.ok(/await loadScript\(XLSX_CDN\)/.test(src), "XLSX is not lazy-loaded from the existing CDN constant");
  assert.ok(/await loadScript\(EXCELJS_CDN\)/.test(src), "ExcelJS is not lazy-loaded");
  for (const cdn of ["XLSX_CDN", "EXCELJS_CDN"]) {
    assert.ok(!new RegExp(`<script[^>]*${cdn}`).test(src), `${cdn} is being loaded eagerly`);
  }
});

// ---- Picture workbook (PROP-049) -------------------------------------------
// The per-part sheets are only as good as the sheet names: Excel rejects the
// whole file for one bad name, and a 64-part export gives 64 chances to produce
// one. These run the real function rather than reading it.

const uniqueSheetName = lift("uniqueSheetName\\(base, used\\)");
const fitBox = lift("fitBox\\(w, h, boxW, boxH\\)");

const SHEET_ILLEGAL = /[\\/?*[\]:]/;

test("sheet names are always legal, however the part is named", () => {
  const used = new Set();
  const inputs = ["Summary", "A/B:C*D?E[F]G\\H", "", null, undefined, "'quoted'",
                  "x".repeat(60), "RR-202609-3FZE3P4Z", 12345];
  for (const raw of inputs) {
    const name = uniqueSheetName(raw, used);
    assert.ok(name, `${JSON.stringify(raw)} produced an empty sheet name`);
    assert.ok(name.length <= 31, `"${name}" is ${name.length} chars — Excel's limit is 31`);
    assert.ok(!SHEET_ILLEGAL.test(name), `"${name}" contains a character Excel forbids`);
  }
});

test("duplicate part numbers get distinct sheet names, still within 31 chars", () => {
  const used = new Set();
  const names = [];
  // The same long name ten times: the suffix must eat into the name, not the limit.
  for (let i = 0; i < 10; i++) names.push(uniqueSheetName("y".repeat(31), used));
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length,
    "two sheets share a name — Excel will refuse the workbook");
  for (const n of names) assert.ok(n.length <= 31, `"${n}" exceeds 31 chars`);
});

test('"History" is never used as a sheet name', () => {
  // Excel reserves it; a part called History would otherwise break the file.
  assert.notEqual(uniqueSheetName("History", new Set()).toLowerCase(), "history");
  assert.notEqual(uniqueSheetName("history", new Set()).toLowerCase(), "history");
});

test("images are scaled to fit, never stretched, never enlarged", () => {
  const tall = fitBox(100, 400, 260, 260);
  assert.ok(tall.width <= 260 && tall.height <= 260, "image escapes its box");
  assert.ok(Math.abs(tall.width / tall.height - 100 / 400) < 0.02, "aspect ratio is distorted");
  const small = fitBox(20, 20, 260, 260);
  assert.deepEqual(small, { width: 20, height: 20 }, "a small image is being upscaled into a blur");
  const unknown = fitBox(0, 0, 44, 44);
  assert.ok(unknown.width > 0 && unknown.height > 0, "unknown dimensions must still produce a box");
});

test("each picture is embedded once and referenced twice", () => {
  // ExcelJS appends a new media entry on every addImage(), so registering per
  // sheet would put identical bytes in the file twice.
  const m = src.match(/const imageIds = images\.map[\s\S]{0,200}/);
  assert.ok(m, "imageIds is not built up front — images will be embedded per sheet");
  const perSheet = src.match(/(summary|ws)\.addImage\(wb\.addImage\(/g);
  assert.equal(perSheet, null, "a sheet still calls wb.addImage() inline, duplicating the bytes");
});

test("the Excel writer with pictures is ExcelJS, not SheetJS", () => {
  // SheetJS cannot write images at any version of the community build. If this
  // ever flips back, the pictures silently vanish from the export.
  assert.ok(/EXCELJS_CDN\s*=\s*"https:\/\/cdn\.jsdelivr\.net\/npm\/exceljs@/.test(src),
    "ExcelJS is not pinned to an exact version on the CDN");
  const fn = src.match(/async function exportComponentWorkbook[\s\S]*?\n  \}/);
  assert.ok(fn, "exportComponentWorkbook not found");
  assert.ok(fn[0].includes("loadScript(EXCELJS_CDN)"), "the workbook writer does not load ExcelJS");
  assert.ok(!fn[0].includes("window.XLSX"), "the picture workbook is using SheetJS, which cannot embed images");
});

test("only formats Excel understands reach addImage", () => {
  const fn = src.match(/async function imageForExcel[\s\S]*?\n  \}/);
  assert.ok(fn, "imageForExcel not found");
  for (const sig of ["0x89", "0xff", "0x47"]) {
    assert.ok(fn[0].includes(sig), `missing magic-byte sniff ${sig} — format is being trusted from the URL`);
  }
  assert.ok(/toBlob\(r, "image\/png"\)/.test(fn[0]),
    "no canvas fallback — a webp upload would produce an empty frame in the sheet with no error");
});

test("CSV is untouched by the picture workbook", () => {
  // Pictures cannot live in a CSV, and a column of expiring signed URLs would
  // be worse than nothing.
  assert.ok(!/toCSV\([\s\S]{0,400}base64/.test(src), "image data is leaking into the CSV writer");
  const out = toCSV([{ id: "1", name: "Fäste" }], cols);
  assert.ok(!out.includes("base64") && !out.includes("http"), "CSV output now carries image data");
});
