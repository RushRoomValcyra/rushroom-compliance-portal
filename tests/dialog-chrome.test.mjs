// Dialog chrome consistency — static, no credentials.
//
// Dialogs were built two ways: openModal, and thirteen hand-rolled overlays with
// inline styles. Between them the scrim came in six darknesses, so the page
// dimmed by a visibly different amount depending on which dialog you opened, and
// a view rendered inside openModal could end up with two Close buttons and two
// title rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(root, "assets/app.js"), "utf8");
const viewer = readFileSync(join(root, "assets/viewer.js"), "utf8");
const css = readFileSync(join(root, "assets/styles.css"), "utf8");

test("no dialog paints its own scrim inline", () => {
  const inline = [...app.matchAll(/"data-modal-overlay": "", style: "position:fixed[^"]*"/g)].map((m) => m[0].slice(0, 70));
  assert.deepEqual(inline, [], `these still style their own overlay:\n  ${inline.join("\n  ")}`);
  assert.ok(/\.modal-scrim \{/.test(css), ".modal-scrim is not defined");
});

test("there is one scrim colour, plus a deliberate dark variant", () => {
  // The lightbox wants the page gone rather than dimmed; everything else shares
  // the viewer's scrim so dialogs feel like one system.
  const scrim = css.slice(css.indexOf(".modal-scrim {"), css.indexOf("}", css.indexOf(".modal-scrim {")));
  assert.ok(/rgba\(0, 0, 0, 0\.6\)/.test(scrim), ".modal-scrim does not match the viewer overlay's scrim");
  const viewerOverlay = css.slice(css.indexOf(".viewer-overlay {"), css.indexOf("}", css.indexOf(".viewer-overlay {")));
  assert.ok(/rgba\(0,0,0,0\.6\)|rgba\(0, 0, 0, 0\.6\)/.test(viewerOverlay),
    "the two dialog systems no longer share a scrim");
});

test("close buttons are labelled the same everywhere", () => {
  const labels = new Set([
    ...[...app.matchAll(/\}, "([^"]*[Cc]lose[^"]*)"\)/g)].map((m) => m[1]),
    ...[...viewer.matchAll(/\}, "([^"]*[Cc]lose[^"]*)"\)/g)].map((m) => m[1].replace(/\\u2715/g, "✕")),
  ]);
  assert.deepEqual([...labels], ["✕ Close"], `mixed close labels: ${[...labels].join(" | ")}`);
});

test("the drawing surface renders exactly one Close, in the right mode", () => {
  const i = app.indexOf("async function openDrawingSurface(");
  const block = app.slice(i, app.indexOf("\n  // --- Main renderProduct", i) + 1 || undefined);
  const closes = [...block.matchAll(/"✕ Close"/g)].length;
  assert.equal(closes, 1, `the surface renders ${closes} Close buttons`);
  // Mounted in the detail panel it has replaced that panel's header, so it owns
  // the only way out. In its own modal, openModal already provides one.
  assert.ok(/mount\s*\n?\s*\? el\("button"/.test(block) || /mount$/m.test(block),
    "the Close is not conditional on being mounted");
  assert.ok(/mount\.__hide/.test(block), "the mounted Close does not dismiss the detail overlay");
});

test("the drawing title appears once, not above itself", () => {
  const i = app.indexOf("async function openDrawingSurface(");
  const block = app.slice(i, app.indexOf("\n  // --- Main renderProduct", i) + 1 || undefined);
  // In modal mode the dialog's own header is the title bar, so the surface
  // renames it rather than printing a second title row beneath it.
  assert.ok(/querySelector\("\.viewer-title"\)/.test(block),
    "the surface does not name its own dialog");
  assert.ok(/mount\s*\n?\s*\? el\("div", \{ class: "drawing-title" \}/.test(block),
    "the in-surface title is not limited to mounted mode");
});
