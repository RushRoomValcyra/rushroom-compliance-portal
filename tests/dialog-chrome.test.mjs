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
  assert.ok(/levelNote, pickTabBar, pickCatBar, pickSortBar, searchInput, listEl, trayEl/.test(fn),
    "the note is not mounted above the picker, or the filter bars are missing from it");
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

// ---- Shared list shaping (PROP-052) ----------------------------------------
// The BOM list and the add-child picker show the same rows. The tabs, category
// chips and sort order are defined once so the two cannot disagree.

/**
 * Lift module-scope helpers out of the app IIFE and run them for real, rather
 * than pattern-matching their source. They reference each other, so they are
 * evaluated together with the one module value they read.
 */
function liftApp(name) {
  const grab = (re, what) => {
    const m = app.match(re);
    assert.ok(m, `${what} not found in assets/app.js`);
    return m[0];
  };
  const src = [
    "let partCategories = [];",
    grab(/const categoryNameOf = \(id\) => [^\n]+/, "categoryNameOf"),
    grab(/const bomTabOf = \(c\) => [\s\S]*?;\n/, "bomTabOf"),
    grab(/function bomGroupByType\(list\) \{[\s\S]*?\n  \}/, "bomGroupByType"),
    grab(/const bomSortValue = \(c, key\) =>[\s\S]*?;\n/, "bomSortValue"),
    grab(/function bomSortComparator\(sortKey, sortDir\) \{[\s\S]*?\n  \}/, "bomSortComparator"),
  ].join("\n");
  return eval(`(function () { ${src}; return ${name}; })()`);
}

test("grouping and sorting are defined once, not per screen", () => {
  for (const name of ["BOM_TAB_DEFS", "BOM_SORT_COLS"]) {
    const defs = [...app.matchAll(new RegExp(`const ${name} = \\[`, "g"))];
    assert.equal(defs.length, 1, `${name} is defined ${defs.length} times`);
  }
  // bomTreeView must consume them rather than keep its own copy.
  assert.ok(/const TAB_DEFS = BOM_TAB_DEFS;/.test(app), "the BOM list still declares its own tab defs");
  assert.ok(/const SORT_COLS = BOM_SORT_COLS;/.test(app), "the BOM list still declares its own sort columns");
  assert.ok(/sort\(bomSortComparator\(sortKey, sortDir\)\)/.test(app), "the BOM list does not use the shared comparator");
  assert.ok(/return bomGroupByType\(filtered\);/.test(app), "the BOM list still groups by type inline");
});

test("the picker offers the same tabs, categories and sort as the list", () => {
  const fn = addChildModal();
  assert.ok(/BOM_TAB_DEFS\.map/.test(fn), "the picker has no type tabs");
  assert.ok(/partCategories\.forEach/.test(fn), "the picker has no category chips");
  assert.ok(/BOM_SORT_COLS\.filter/.test(fn), "the picker has no sort controls");
  assert.ok(/bomSortComparator\(pickState\.sortKey, pickState\.sortDir\)/.test(fn),
    "the picker sorts differently from the list");
  // Categories belong to Parts in both places.
  assert.ok(/c\.key !== "category" \|\| pickState\.tab === "components"/.test(fn),
    "the picker offers a Category sort on tabs that have no categories");
  // Managing categories from inside this dialog would stack a second modal.
  assert.ok(!/openCategoryManager/.test(fn), "the picker opens the category manager over itself");
});

test("the shared comparator orders rows the way the list promises", () => {
  const cmp = liftApp("bomSortComparator");
  const rows = [
    { name: "S Shelf 10", part_number: "B" },
    { name: "S Shelf 2",  part_number: "A" },
    { name: "",           part_number: "C" },
  ];
  const asc = rows.slice().sort(cmp("name", "asc")).map((r) => r.name);
  assert.deepEqual(asc, ["S Shelf 2", "S Shelf 10", ""], "numeric ordering or empty-last is broken");
  const desc = rows.slice().sort(cmp("name", "desc")).map((r) => r.name);
  assert.equal(desc[desc.length - 1], "", "an empty value is paraded to the top when the direction flips");
  // Equal values must not shuffle between renders.
  const ties = [{ name: "X", part_number: "B" }, { name: "X", part_number: "A" }];
  assert.deepEqual(ties.slice().sort(cmp("name", "asc")).map((r) => r.part_number), ["A", "B"],
    "equal values have no stable tiebreak");
});

test("bomGroupByType puts every row in exactly one tab", () => {
  const group = liftApp("bomGroupByType");
  const out = group([
    { id: 1, type: "part" }, { id: 2, type: "sub_assembly" },
    { id: 3, type: "product_family" }, { id: 4, type: "finished_good" }, { id: 5 },
  ]);
  assert.deepEqual(out.assemblies.map((c) => c.id), [2]);
  assert.deepEqual(out.dynamic.map((c) => c.id), [3]);
  // Anything else lands in Parts — including a row with no type at all, which
  // must not vanish from every tab.
  assert.deepEqual(out.components.map((c) => c.id), [1, 4, 5]);
  assert.equal(group([]).components.length, 0, "an empty list should not throw");
});

test("an empty picker says where the matches actually are", () => {
  // Now that the picker has tabs, "no match" while rows sit one tab away is
  // the dead end this project keeps producing.
  const fn = addChildModal();
  assert.ok(/in \$\{x\.tab\.label\}/.test(fn), "the empty state does not point at the other tabs");
  assert.ok(/in all categories/.test(fn), "a category chip can hide everything with no way back offered");
});

test("the move-child picker keeps its own search wiring", () => {
  // Both modals have a function called buildList with different signatures:
  // the move picker takes a filter string, the add picker reads shared state.
  // A blind rename across the file silently disables search in one of them.
  const move = app.match(/function openMoveComponentModal[\s\S]*?\n  \}\n/)
    || app.match(/listMoveTargets[\s\S]{0,6000}/);
  assert.ok(move, "the move-child modal was not found");
  assert.ok(/searchInput\.oninput = \(\) => buildList\(searchInput\.value\);/.test(app),
    "the move picker's search no longer passes its query — typing filters nothing");
  assert.ok(/function buildList\(filter\) \{/.test(app), "the move picker's filtered buildList is gone");
});
