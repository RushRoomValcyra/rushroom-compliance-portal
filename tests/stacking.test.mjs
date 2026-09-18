// Stacking order — static, no credentials.
//
// The component detail panel sits at z-index 900 and .viewer-overlay sat at 200,
// so every openModal dialog opened from inside a part — the drawing detail,
// adopt, link, new drawing, and the PDF viewer — rendered BEHIND the panel that
// launched it. Nothing errored; the dialog was simply invisible, which reads as
// "the button does nothing".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "assets/styles.css"), "utf8");
const app = readFileSync(join(root, "assets/app.js"), "utf8");

function layer(name) {
  const m = css.match(new RegExp(`--z-${name}:\\s*(\\d+)`));
  assert.ok(m, `--z-${name} is not defined`);
  return Number(m[1]);
}

test("dialogs stack above the component detail panel", () => {
  assert.ok(layer("modal") > layer("panel"),
    `--z-modal (${layer("modal")}) must exceed --z-panel (${layer("panel")}), or dialogs open behind the panel`);
});

test("the file viewer stacks above dialogs, and sticky chrome below both", () => {
  assert.ok(layer("viewer") >= layer("modal"), "the file viewer would open behind the dialog that launched it");
  assert.ok(layer("nav") < layer("panel"), "the sticky tab bar would sit over the detail panel");
  assert.ok(layer("sticky") < layer("nav"), "sticky table heads would sit over the nav");
});

test(".viewer-overlay uses the named layer, not a bare number", () => {
  const i = css.indexOf(".viewer-overlay {");
  assert.ok(i > 0, ".viewer-overlay not found");
  const b = css.slice(i, css.indexOf("}", i));
  assert.ok(/z-index:\s*var\(--z-modal\)/.test(b),
    ".viewer-overlay does not use --z-modal, so it can drift below the panel again");
});

test("no z-index declaration is malformed", () => {
  // A blunt string migration replaced the "1000" prefix inside "10000" and left
  // a stray digit: `z-index:var(--z-modal)0`. That is not a valid declaration,
  // so the element silently had no z-index at all — and the previous test,
  // which only looked for bare numbers, saw nothing wrong.
  const bad = [...app.matchAll(/z-index:\s*var\(--z-[a-z]+\)[^;"'`,\s]/g)].map((m) => m[0]);
  assert.deepEqual(bad, [], `malformed z-index declarations: ${bad.join(", ")}`);
  const tokens = [...app.matchAll(/z-index:\s*var\((--z-[a-z]+)\)/g)].map((m) => m[1]);
  const defined = new Set([...css.matchAll(/(--z-[a-z]+):/g)].map((m) => m[1]));
  const missing = tokens.filter((t) => !defined.has(t));
  assert.deepEqual([...new Set(missing)], [], `undefined layer tokens: ${missing.join(", ")}`);
});

test("no overlay in app.js carries a hand-picked z-index", () => {
  // 1 is a local stacking context inside a scroll container, not a layer.
  const raw = [...app.matchAll(/z-index:(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 1);
  assert.deepEqual(raw, [],
    `these bypass the layer scale and will eventually stack wrongly: ${[...new Set(raw)].join(", ")}`);
});
