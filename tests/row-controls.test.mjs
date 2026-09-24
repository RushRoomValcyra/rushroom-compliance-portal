// BOM row controls (PROP-055) — static, no credentials.
//
// A BOM row opens the component detail panel on double-click. Every control in
// the row stops `click` — but `dblclick` is a separate event, and clicking a
// number input's spinner twice to change a quantity IS a double-click. It
// bubbled to the row and opened the detail panel over what the user was doing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(root, "assets/app.js"), "utf8");

test("every double-click-to-open row checks it was not a control", () => {
  const handlers = [...app.matchAll(/ondblclick: \(ev\) => \{[\s\S]*?\n(?:\s*)\},/g)].map((m) => m[0]);
  assert.ok(handlers.length >= 2, `expected the tree row and the list row, found ${handlers.length}`);
  for (const h of handlers) {
    assert.ok(/hitRowControl\(ev\)/.test(h),
      `a double-click handler opens without checking the target:\n${h.slice(0, 160)}`);
    // The guard has to come first, or the panel opens anyway.
    assert.ok(h.indexOf("hitRowControl") < h.indexOf("openComponentDetail"),
      "the guard runs after the panel is opened");
  }
});

test("the guard covers form controls and the marked non-form ones", () => {
  const m = app.match(/const ROW_CONTROLS = "([^"]+)";/);
  assert.ok(m, "ROW_CONTROLS not found");
  const sel = m[1].split(",").map((s) => s.trim());
  for (const want of ["input", "button", "select", "textarea", "a", "[data-row-control]"]) {
    assert.ok(sel.includes(want), `ROW_CONTROLS does not cover ${want}`);
  }
});

test("the interactive bits that are not form elements are marked", () => {
  // The quantity cell is built from spans, the action cluster holds the
  // reorder/link/delete buttons, and the list thumbnail opens a lightbox.
  const qty = app.match(/const qtyCell = \(\) => \{[\s\S]*?\n        \};/);
  assert.ok(qty, "qtyCell not found");
  assert.ok(/"data-row-control": ""/.test(qty[0]), "the quantity cell is not marked as a control");

  const marks = [...app.matchAll(/"data-row-control": ""/g)].length;
  assert.ok(marks >= 3, `expected the quantity cell, the action cluster and the thumbnail, found ${marks}`);
  assert.ok(/loading: "lazy", decoding: "async", "data-row-control": ""/.test(app),
    "the list thumbnail, which opens a lightbox, is not marked");
});

test("the guard tolerates a target with no closest()", () => {
  const consts = app.match(/const ROW_CONTROLS = "[^"]+";\n  const hitRowControl = [^\n]+/);
  assert.ok(consts, "ROW_CONTROLS / hitRowControl not found together");
  const hitRowControl = eval(`(function () { ${consts[0]}; return hitRowControl; })()`);
  assert.equal(hitRowControl({ target: null }), false, "a null target throws instead of falling through");
  assert.equal(hitRowControl({ target: {} }), false, "a target without closest() throws");
  assert.equal(hitRowControl({ target: { closest: () => null } }), false, "no match should mean no control");
  assert.equal(hitRowControl({ target: { closest: () => ({}) } }), true, "a match should mean a control");
});

test("the quantity editor still stops the events it always stopped", () => {
  // Removing these would put the single-click paths back on the row.
  const qty = app.match(/const qtyCell = \(\) => \{[\s\S]*?\n        \};/)[0];
  assert.ok(/input\.onclick = \(ev\) => ev\.stopPropagation\(\)/.test(qty), "the input no longer stops click");
  assert.ok(/input\.onkeydown = \(ev\) => \{\n              ev\.stopPropagation\(\);/.test(qty),
    "the input no longer stops keydown — arrow keys would reach the row");
});
