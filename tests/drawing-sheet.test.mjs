// Dynamic drawings, Phase 4 (docs/DYNAMIC_DRAWINGS.md §6 "The sheet", §7 Phase 4)
// — static, no credentials. The render's sheet PNGs with the entities sidecar
// drawn over them in paper mm; a box is the second way to the same one-row
// form; a marquee selects every box it touches and keeps its model rectangle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const app = read("assets/app.js");
const viewer = read("assets/viewer.js");
const css = read("assets/styles.css");
const index = read("index.html");
const supplier = read("supplier.html");

const sheets = viewer.slice(viewer.indexOf("function renderSheets(target, opts)"), viewer.indexOf("window.PortalViewer = {"));
const layer = app.slice(app.indexOf("function drawingSpecLayer(ctx)"), app.indexOf("function releaseModal("));

test("the sheet viewer draws the sidecar in paper millimetres over the PNG, with no PDF library", () => {
  assert.ok(sheets.length > 0, "renderSheets is missing");
  assert.ok(/viewBox", `0 0 \$\{W\} \$\{H\}`/.test(sheets), "the overlay's viewBox is not the sheet size in mm");
  assert.ok(/H - box\[3\]/.test(sheets), "paper y (origin bottom-left) is not flipped into SVG y");
  assert.ok(/preserveAspectRatio", "none"/.test(sheets), "the overlay must stretch exactly over the image");
  assert.ok(/non-scaling-stroke/.test(sheets), "strokes scale with zoom");
  assert.ok(!/pdf\.js|pdfjs|cdn\.jsdelivr/.test(sheets), "the sheet path pulls a library");
  // The frame drawset draws at (20, 10) is the calibration box on every sheet.
  assert.ok(/\[20, 10, W - 10, H - 10\]/.test(sheets), "no frame rectangle for calibration");
});

test("click, shift-click and marquee report entity ids; the marquee maps to the face view", () => {
  assert.ok(/ids: \[id\], add: d\.shift/.test(sheets), "a click does not report the box with shift as add");
  assert.ok(/b\[0\] <= box\[2\] && b\[2\] >= box\[0\] && b\[1\] <= box\[3\] && b\[3\] >= box\[1\]/.test(sheets), "the marquee does not select every box it touches");
  // drawset: paper x = ox + (sx·x − p0)·s, paper y = oy + (y − ya)·s (REC.view)
  assert.ok(/\(\(px - v\.ox\) \/ v\.s \+ \(v\.p0 \|\| 0\)\) \/ sx/.test(sheets), "paper → model x is not drawset's inverse");
  assert.ok(/\(py - v\.oy\) \/ v\.s \+ \(v\.ya \|\| 0\)/.test(sheets), "paper → model y is not drawset's inverse");
});

test("a box reaches the same one-row form as its row; the selection narrows the table", () => {
  assert.ok(/const drEntId = \(r\) => \(r && r\.entity != null/.test(app), "rows are not keyed to entities by the sidecar's entity index");
  assert.ok(/openOne: ids\.length === 1 && !add && !region/.test(layer), "a single click does not open the form");
  assert.ok(/if \(tr\) openForm\(tr, tr\.__row\);/.test(layer), "the sheet opens something other than openForm");
  assert.ok(/\(!state\.sel\.size \|\| state\.sel\.has\(key\)\)/.test(layer), "the selection does not filter the table");
  assert.ok(/`\$\{rows\.length\} selected`/.test(layer), "no selection chips");
  assert.ok(/drRegionWords\(state\.region\)/.test(layer), "the marquee's model rectangle is not shown");
});

test("the sheets replace the iframe only for the current issue made by a render job; Plain PDF switches back", () => {
  assert.ok(/const sheetsAvailable = fromJob && pngs\.length > 0 && !!ents;/.test(layer), "sheets are offered without a render job, PNGs and a sidecar");
  assert.ok(/rev\.id === current\.id && viewingCurrent/.test(layer), "an older issue would show the current issue's sheets");
  assert.ok(/if \(!sheetsOk\) return renderPdf\(target\);/.test(layer), "the iframe path is not kept for files without a sidecar");
  assert.ok(/"Plain PDF"/.test(layer) && /"Sheets"/.test(layer), "no toggle between the sheets and the PDF");
});

test("the compare pane shows the candidate's sheets with the same overlay, touched boxes amber", () => {
  assert.ok(/state\.cand = window\.PortalViewer\.renderSheets\(candTarget/.test(layer), "the candidate is not drawn as sheets");
  assert.ok(/state\.cand\.setTouched\(touchedIds\(candDims\)\)/.test(layer), "touched rows are not amber on the candidate");
  assert.ok(/\.sheet-ent\.is-touched \{ stroke: var\(--amber\)/.test(css), "a touched box is not amber");
  assert.ok(/\.sheet-ent\.is-selected \{ stroke: var\(--accent\)/.test(css), "a selected box is not in the accent");
});

test("the changed assets are cache-busted together on both shells", () => {
  const v = (html, a) => (html.match(new RegExp(`assets/${a}\\?v=(\\d+)`)) || [])[1];
  for (const html of [index, supplier]) {
    assert.equal(v(html, "viewer.js"), v(html, "app.js"), "viewer.js and app.js are bumped apart");
    assert.equal(v(html, "styles.css"), v(html, "app.js"), "styles.css and app.js are bumped apart");
  }
  assert.ok(Number(v(index, "app.js")) >= 469, "app.js was not bumped past v468");
});
