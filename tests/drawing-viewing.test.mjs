// PROP-047 drawing surface — static, no credentials.
//
// The complaint was stacked overlays: a part panel, a drawing dialog over it,
// and the file in a browser tab outside the portal entirely. The fix is that the
// drawing REPLACES what you were looking at, and the file renders in place.
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

const surface = app.slice(app.indexOf("async function openDrawingSurface("), app.indexOf("\n  // Main renderProduct") + 1 || undefined);

test("the viewer can render into any element, not only its own modal", () => {
  assert.ok(/async function render\(target, doc\)/.test(viewer), "render(target, doc) was not extracted");
  assert.ok(/window\.PortalViewer = \{ open, render \}/.test(viewer), "render is not exported");
  // open() must go through the same path, or the two renderers drift.
  assert.ok(/cleanup = await render\(body, doc\)/.test(viewer), "open() no longer delegates to render()");
});

test("render returns its own disposer instead of claiming the module slot", () => {
  const r = viewer.slice(viewer.indexOf("async function render(target, doc)"), viewer.indexOf("async function open(doc)"));
  assert.ok(/return dispose;/.test(r), "render does not return a disposer");
  // Writing to the module-level `cleanup` would mean closing the modal revokes
  // the embedded blob URL and the drawing silently goes blank.
  assert.ok(!/\bcleanup\s*=/.test(r), "render writes to the shared cleanup slot");
});

test("scanned drawings render — images are not a fallthrough", () => {
  assert.ok(/IMAGE_EXT/.test(viewer), "no image extension set");
  for (const ext of ["png", "jpg", "tiff"]) {
    assert.ok(new RegExp(`"${ext}"`).test(viewer), `${ext} is not recognised as an image`);
  }
});

test("opened from a part, the drawing replaces the panel instead of stacking", () => {
  assert.ok(/mount: panel/.test(app), "the part panel does not mount the surface in place");
  assert.ok(/onBack: \{/.test(app), "there is no breadcrumb back to the part");
  // Two controls called "Open" meaning different things was half the confusion.
  assert.ok(!/\}\) \}, "Open"\)/.test(app), 'the row action still says "Open"');
});

test("switching revisions disposes the previous file", () => {
  assert.ok(/disposeCurrent\(\)/.test(surface), "no disposal on revision switch");
  assert.ok(/disposeFile = await window\.PortalViewer\.render\(/.test(surface),
    "the surface does not keep the disposer returned by render()");
});

test("the file column grows and the rail stays fixed, stacking when narrow", () => {
  const block = css.slice(css.indexOf(".drawing-surface {"), css.indexOf("}", css.indexOf(".drawing-surface {")));
  assert.ok(/minmax\(0, 1fr\)/.test(block), "the file column cannot shrink below its content without minmax(0,…)");
  assert.ok(/@media \(max-width: 900px\)[\s\S]*?\.drawing-surface \{ grid-template-columns: minmax\(0, 1fr\)/.test(css),
    "the surface never collapses to one column, so neither pane is usable on a laptop half-screen");
});

test("supplier visibility is unchanged by this feature", () => {
  // The surface reads files through drawingFileUrl, which re-checks the parent
  // drawing. Bypassing it would serve withheld drawings.
  assert.ok(/drawingFileUrl/.test(surface), "the surface does not fetch through drawingFileUrl");
  assert.ok(!/storage_path: rev\.storage_path/.test(surface),
    "the surface reads a storage path directly, bypassing the visibility check");
});
