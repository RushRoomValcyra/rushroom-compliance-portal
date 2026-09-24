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
