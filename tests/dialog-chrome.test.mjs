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

// ---- Resizable add-child picker (PROP-050) ---------------------------------

/** The body of openAddChildModal, so assertions cannot match some other dialog. */
function addChildModal() {
  const m = app.match(/function openAddChildModal\([\s\S]*?\n  \}\n/);
  assert.ok(m, "openAddChildModal not found in assets/app.js");
  return m[0];
}

test("the add-child dialog can be resized, and the picker takes the extra height", () => {
  const fn = addChildModal();
  assert.ok(/resize:both/.test(fn), "the dialog is not resizable");
  assert.ok(/overflow:hidden/.test(fn), "resize does nothing on an element with overflow:visible");
  assert.ok(/min-width:340px/.test(fn) && /min-height:320px/.test(fn),
    "no minimum size — the dialog can be dragged down to an unusable sliver");
  assert.ok(/max-width:96vw/.test(fn) && /max-height:94vh/.test(fn),
    "no maximum — a saved size from a larger screen would open off-screen");
  // The point of resizing is a longer list. A fixed max-height would mean the
  // extra height becomes whitespace instead.
  assert.ok(!/max-height:200px;overflow-y:auto;border/.test(fn), "the picker still has its fixed 200px height");
  assert.ok(/flex:1;min-height:140px;overflow-y:auto/.test(fn), "the picker does not grow with the dialog");
});

test("switching back from Create new restores the picker's flex layout", () => {
  // `style.display = ""` clears the property and the section falls back to
  // block, which silently breaks the stretch-to-fit list.
  const fn = addChildModal();
  assert.ok(/existingSection\.style\.display = isExisting \? "flex" : "none"/.test(fn),
    'existingSection is toggled with "" instead of "flex"');
});

test("the picker shows a picture for every row, including parts without one", () => {
  assert.ok(/thumbMap\[c\.id\]/.test(addChildModal()), "the picker does not read thumbMap");
  const box = app.match(/function thumbBox\(url\)[\s\S]*?\n  \}/);
  assert.ok(box, "thumbBox not found");
  assert.ok(/loading: "lazy"/.test(box[0]), "64 full-size images would be fetched before the first row is visible");
  assert.ok(/No image/.test(box[0]), "a part without a picture gets nothing, so the text columns misalign");
  // Signed thumbnail URLs expire after an hour; a page left open overnight
  // would otherwise show a column of broken-image glyphs.
  assert.ok(/onerror:/.test(box[0]), "an expired image URL is left to render as a broken glyph");
});

test("thumbMap is module-scoped, or the picker reads an empty object", () => {
  // openAddChildModal is a sibling of bomTreeView, not nested in it — the same
  // reason parentCountMap and partCategories are module-scoped.
  const decls = [...app.matchAll(/^\s*let thumbMap = \{\};/gm)];
  assert.equal(decls.length, 1, `thumbMap is declared ${decls.length} times — a nested one shadows the shared map`);
  assert.ok(/^  let thumbMap = \{\};/m.test(app), "thumbMap is not declared at module scope");
});

test("dialog size persistence never lets storage break the dialog", () => {
  // localStorage throws outright in a private window or with site data blocked;
  // an unguarded read here would stop the modal from opening at all.
  for (const name of ["loadDialogSize", "rememberDialogSize"]) {
    const m = app.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n  \\}`));
    assert.ok(m, `${name} not found`);
    assert.ok(/try \{/.test(m[0]) && /\} catch/.test(m[0]), `${name} accesses localStorage unguarded`);
  }
  const rem = app.match(/function rememberDialogSize\([\s\S]*?\n  \}/)[0];
  assert.ok(/ro\.disconnect\(\)/.test(rem),
    "the ResizeObserver is never disconnected — it outlives every modal opened");
});

// ---- Multi-select add-child (PROP-051) -------------------------------------

test("the picker selects many parts, and clicking a row again removes it", () => {
  const fn = addChildModal();
  assert.ok(/const picked = new Map\(\)/.test(fn), "selection is still a single id, not a set");
  assert.ok(/if \(picked\.has\(c\.id\)\) picked\.delete\(c\.id\);/.test(fn),
    "a row does not toggle — a mis-click cannot be undone the way it was made");
  assert.ok(!/\bselectedId\b/.test(fn), "the old single-selection variable is still referenced");
  // Insertion order is the add order; a plain object would not guarantee it.
  assert.ok(/\[\.\.\.picked\.values\(\)\]/.test(fn), "the tray does not iterate the map in order");
});

test("quantity is per selected part, not one box for all of them", () => {
  // Two legs and eight screws is the normal case. A single shared quantity
  // would make multi-select actively wrong rather than merely limited.
  const fn = addChildModal();
  assert.ok(/entry\.qty = qty\.value/.test(fn), "the tray rows have no own quantity");
  assert.ok(/entry\.ref = ref\.value/.test(fn), "the tray rows have no own reference designator");
  assert.ok(/qtyRefRow\.style\.display = isExisting \? "none" : "flex"/.test(fn),
    "the shared quantity row is still shown alongside the per-part ones");
});

test("the dialog says the children land on the same level", () => {
  const fn = addChildModal();
  assert.ok(/function paintLevelNote/.test(fn), "there is no same-level explanation");
  assert.ok(/siblings on the same level/.test(fn), "the note does not say they are siblings");
  assert.ok(/levelNote, searchInput, listEl, trayEl/.test(fn), "the note is not mounted above the picker");
});

test("nothing is written until every row validates", () => {
  // A batch that creates three edges and then rejects the fourth for a typo
  // leaves the tree half-changed with the dialog still open over it.
  const fn = addChildModal();
  const firstWrite = fn.indexOf('"addBomEdge"');
  const validation = fn.indexOf("must be greater than 0.`");
  assert.ok(firstWrite > 0 && validation > 0, "validation or write not found");
  assert.ok(validation < firstWrite, "per-row quantity is validated after the first edge is written");
});

test("a partial failure says how far it got", () => {
  const fn = addChildModal();
  assert.ok(/Added \$\{added\.length\} of \$\{batch\.length\}/.test(fn),
    "a failure mid-batch reports only the error, so a retry duplicates the edges already written");
  assert.ok(/added\.push\(item\)/.test(fn), "successful writes are not tracked");
  assert.ok(/picked\.delete\(item\.childId\)/.test(fn),
    "parts already added stay selected, so retrying adds them twice");
});

test("edges are written in the order they were picked", () => {
  // The edges carry a sort_order; Promise.all would land them in whatever
  // order the requests happen to resolve.
  const fn = addChildModal();
  assert.ok(/for \(const item of batch\)/.test(fn), "the batch is not written sequentially");
  assert.ok(!/Promise\.all\([^)]*batch/.test(fn), "the batch is written in parallel, losing the picked order");
});

test("submitBtn is declared before paintTray, which sets its label", () => {
  // const is not hoisted: a declaration below its first use throws at runtime,
  // which has already happened three times in this file.
  const fn = addChildModal();
  const decl = fn.indexOf('const submitBtn = el(');
  const use = fn.indexOf("paintTray();   // after submitBtn exists");
  assert.ok(decl > 0 && use > 0, "submitBtn declaration or the setup call was not found");
  assert.ok(decl < use, "submitBtn is used before it is declared — temporal dead zone");
  const picked = fn.indexOf("const picked = new Map()");
  assert.ok(picked < use, "picked is read by submitLabel before it is declared");
});
