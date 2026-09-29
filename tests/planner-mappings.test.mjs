// Planner mappings (PROP-053) — static, no credentials.
//
// The saved-keys list and the mappings table are two sections of one screen,
// loaded by two independent requests. When they did not share state, a key that
// was already mapped rendered exactly like one that was not, and the only way to
// find out was to scroll past the whole key list to the table underneath — which
// is how "Module S is mapped and you cannot see it" happened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(root, "assets/app.js"), "utf8");
const css = readFileSync(join(root, "assets/styles.css"), "utf8");

/** The body of plannerMappingsView, so nothing matches another screen. */
function view() {
  const m = app.match(/async function plannerMappingsView\(token\)[\s\S]*?\n  \}\n/);
  assert.ok(m, "plannerMappingsView not found in assets/app.js");
  return m[0];
}

test("every saved key says whether it is mapped", () => {
  const v = view();
  assert.ok(/badge-status \$\{m \? "s-done" : "s-todo"\}/.test(v), "the key rows carry no mapped/unmapped badge");
  assert.ok(/"Mapped" : "Not mapped"/.test(v), "the badge does not state the two states");
  // Both badge classes must actually exist, or the state renders unstyled.
  for (const cls of [".badge-status", ".s-done", ".s-todo"]) {
    assert.ok(css.includes(cls), `${cls} is not defined in styles.css`);
  }
});

test("a mapped key names its target, not just its state", () => {
  // "Mapped" without saying to what still sends you to the table below.
  const v = view();
  assert.ok(/→ \$\{targetName\} · r\$\{m\.mapping_revision\}/.test(v),
    "a mapped row does not show the PIM target it resolves to");
  assert.ok(/"Target no longer exists"/.test(v),
    "a mapping whose target was deleted would render as an empty arrow");
});

test("the two sections share state instead of loading independently", () => {
  const v = view();
  assert.ok(/allMappings = r\.mappings \|\| \[\];/.test(v), "the mappings are not kept for the key list to read");
  assert.ok(/renderCatalog\(\);\n        const mappings = allMappings/.test(v),
    "saving or deactivating a mapping does not repaint the key list");
  // "Mapped" must mean an ACTIVE mapping, regardless of the Show inactive toggle.
  assert.ok(/if \(m\.is_active\) idx\.set\(/.test(v),
    "an inactive mapping would still mark its key as mapped");
});

test("an already-mapped key edits its mapping rather than opening a blank form", () => {
  // planner_mappings_one_active_source rejects a second active mapping, so the
  // old path filled in a whole form and then failed with a 409.
  const v = view();
  assert.ok(/m \? actionBtn\("Edit mapping", "edit", \{ onClick: \(\) => editModal\(m\) \}\)/.test(v),
    "a mapped key still offers Map this item, which the unique index will reject");
  assert.ok(/actionBtn\("Map this item", "link", \{ onClick: \(\) => editModal\(null, item\) \}\)/.test(v),
    "an unmapped key no longer offers Map this item");
});

test("the count is visible without scrolling, and can be filtered", () => {
  const v = view();
  assert.ok(/of \$\{catalog\.length\} key/.test(v), "there is no headline mapped count");
  assert.ok(/\$\{mappedInType\}\/\$\{inType\.length\} mapped/.test(v), "the section headings carry no count");
  assert.ok(/catalogFilter = id; renderCatalog\(\)/.test(v), "the mapped/unmapped filter does nothing");
  // Counts must come from the whole catalog, not the filtered view, or the
  // chips would report on themselves.
  assert.ok(/const mappedCount = catalog\.filter/.test(v), "the count is taken from the filtered rows");
});

test('"no keys imported yet" is never shown while the keys are still loading', () => {
  // reload() and loadCatalog() race; the mappings can land first.
  const v = view();
  assert.ok(/if \(!catalogLoaded\) return;/.test(v),
    "the empty state can paint before the catalogue request has returned");
  assert.ok(/catalogLoaded = true;/.test(v), "catalogLoaded is never set");
  assert.ok(/catalogLoaded = false;/.test(v), "a failed reload leaves the flag set, showing a stale empty state");
});

test("the tab sits second and is named for the Studio, not the planner", () => {
  const fn = app.match(/async function renderProduct\(role, mount\)[\s\S]*?\n  \}/);
  assert.ok(fn, "renderProduct not found");
  assert.ok(/tabs\.splice\(1, 0, \{ id: "planner-mappings", label: "VALCYRA Studio BOM Link"/.test(fn[0]),
    "the tab is not inserted second, or carries the old label");
  assert.ok(!/tabs\.push\(\{ id: "planner-mappings"/.test(fn[0]), "the tab is still appended last");
  // The id is the persisted sub-tab key; renaming it drops every user back to
  // BOM Tree the next time they open the screen.
  assert.ok(/paneSubTab/.test(app), "sub-tab state is no longer persisted — check this assumption");
});

test("the key rows are banded, so the label and its button read as one row", () => {
  // The label sits far left and its button far right; on a list of sixty the
  // eye loses the row between them.
  assert.ok(/\.key-row:nth-child\(even\) \{ background: var\(--panel-2\); \}/.test(css),
    "the rows are not striped");
  assert.ok(/\.key-row:hover \{[^}]*inset 3px 0 0 var\(--accent\)/.test(css),
    "no hover cue on the row you are about to click");
  // Striping needs contiguous rows: the old layout used a vertical margin, so
  // bands would have been separated by gaps of page background.
  assert.ok(!/class: "row-tools", style: "margin:0\.35rem 0;justify-content:space-between/.test(app),
    "the rows still carry the margin that breaks the banding");
  assert.ok(/el\("div", \{ class: "key-rows" \}, rows\.map/.test(app),
    "the rows are not wrapped, so :nth-child would count the section heading");
  assert.ok(/el\("div", \{ class: "key-row" \}/.test(app), "the rows do not use the banded class");
});

test("the PIM target is picked from a filterable list, not an 86-option select", () => {
  const fn = app.match(/function editModal\(mapping, detectedSource = null\)[\s\S]*?\n    \}\n/);
  assert.ok(fn, "editModal not found");
  assert.ok(/pickComponentModal\(token, \{/.test(fn[0]), "the target is still chosen from a plain select");
  assert.ok(!/target\.value/.test(fn[0]), "the save path still reads a select value");
  assert.ok(/target_component_id: targetId/.test(fn[0]), "the chosen id is not what gets saved");
  // A Dynamic BOM is a configuration, not something a key resolves to. The old
  // select excluded them; losing that in the swap would be a silent widening.
  assert.ok(/filter: \(c\) => c\.type !== "product_family"/.test(fn[0]),
    "Dynamic BOMs are now offered as mapping targets");
  // Editing an existing mapping must show what it currently points at.
  assert.ok(/let chosen = mapping\?\.target \|\| null/.test(fn[0]),
    "editing a mapping shows no current target until you pick a new one");
  // And the function that draws it must exist — an earlier pass called it
  // without defining it, which node --check cannot catch.
  assert.ok(/const paintTarget = \(\) =>/.test(fn[0]), "paintTarget is called but never defined");
});

test("the picker can be narrowed by its caller", () => {
  const picker = app.match(/function pickComponentModal\(token, opts = \{\}\)[\s\S]*?\n  \}\n/);
  assert.ok(picker, "pickComponentModal not found");
  assert.ok(/filter = null/.test(picker[0]), "the picker accepts no caller filter");
  assert.ok(/\.filter\(\(c\) => !filter \|\| filter\(c\)\)/.test(picker[0]), "the filter is accepted but never applied");
});

test("nothing still loads a target list that no longer exists", () => {
  // loadTargets() existed only to fill the removed select.
  assert.ok(!/loadTargets/.test(app), "loadTargets survives with no caller");
});
