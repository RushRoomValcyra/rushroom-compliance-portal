// Expand all / Collapse all on the BOM list (PROP-062) — static, no credentials.
//
// The per-assembly Expand all already existed one level down; opening fifteen
// assemblies one arrow at a time was the same work, undone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(root, "assets/app.js"), "utf8");

test("the buttons act on what is on screen, not on everything behind a Load more", () => {
  assert.ok(/let expandableShown = \[\];/.test(app), "the shown set is not tracked");
  assert.ok(/expandableShown = shownItems\.filter\(\(c\) => c\.has_children\)/.test(app),
    "the buttons are not scoped to the rendered page");
  assert.ok(/async function expandAllShown\(\)/.test(app) && /function collapseAllShown\(\)/.test(app),
    "the handlers are missing");
});

test("expanding many rows is one wait, not fifteen", () => {
  const fn = app.match(/async function expandAllShown\(\)[\s\S]*?\n    \}/);
  assert.ok(fn, "expandAllShown not found");
  assert.ok(/await Promise\.all\(targets\.map/.test(fn[0]),
    "the trees are fetched one after another — fifteen round trips of waiting");
  // Already-open rows must not be refetched.
  assert.ok(/filter\(\(c\) => !expandedTrees\[c\.id\]\)/.test(fn[0]), "open rows are fetched again");
  // Something has to show while they load.
  assert.ok(/= "loading"/.test(fn[0]) && /renderAll\(\)/.test(fn[0]), "nothing indicates the rows are loading");
  // A failure on one row must not throw away the others.
  assert.ok(/catch \{ expandedTrees\[c\.id\] = "error"; \}/.test(fn[0]), "one failed tree rejects the whole batch");
});

test("the control is hidden when nothing on screen can expand", () => {
  // A button that does nothing is the failure this project keeps producing.
  assert.ok(/expandGroup\.style\.display = expandableShown\.length \? "flex" : "none"/.test(app),
    "the group is shown even when no row has children");
  // "flex", not "" — the group is a flex row and would stack as a block.
  assert.ok(!/expandGroup\.style\.display = expandableShown\.length \? "" :/.test(app),
    "clearing display would drop the group back to block");
  assert.ok(/expandableShown = \[\];/.test(app.split("expandGroup.style.display = \"none\";")[1] || ""),
    "the shown set is not cleared when the list renders empty");
});

test("each button says when it would do nothing", () => {
  assert.ok(/expandAllBtn\.disabled = openCount === expandableShown\.length/.test(app),
    "Expand all stays enabled when everything is already open");
  assert.ok(/collapseAllBtn\.disabled = openCount === 0/.test(app),
    "Collapse all stays enabled when nothing is open");
});

test("a part that holds children can be opened where it lives", () => {
  // The Parts tab was flat from a time when a part could not hold structure.
  // One now can, and keeping it flat left that structure with no door.
  assert.ok(/renderRootRow\(comp, true, allowAddChild\)/.test(app), "the Parts tab is still flat");
  assert.ok(/const expandBtn = allowExpand && comp\.has_children/.test(app),
    "expansion is no longer gated on the row actually having children");
});

test("expanding and adding a child are separate permissions", () => {
  // They were one flag. Reusing it would have put +child on all 86 catalogue
  // rows as a side effect of making them expandable.
  assert.ok(/function renderRootRow\(comp, allowExpand = false, allowAddChild = false\)/.test(app),
    "renderRootRow still takes a single flag");
  assert.ok(/role === "rushroom" && allowAddChild \?/.test(app), "+child is still gated on expandability");
  assert.ok(/const allowAddChild = activeTab !== "components"/.test(app),
    "the Parts tab gained a structure-editing button it did not have before");
});
