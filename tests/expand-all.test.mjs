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
  // (A row that FAILED is fetched again — that is a retry, not a refetch.)
  assert.ok(/filter\(\(c\) => !expandedTrees\[c\.id\] \|\| expandedTrees\[c\.id\] === "error"\)/.test(fn[0]), "open rows are fetched again");
  // Something has to show while they load.
  assert.ok(/= "loading"/.test(fn[0]) && /renderAll\(\)/.test(fn[0]), "nothing indicates the rows are loading");
  // A failure on one row must not throw away the others.
  assert.ok(/catch \(ex\) \{ expandedTrees\[c\.id\] = "error";/.test(fn[0]), "one failed tree rejects the whole batch");
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
  // They were one flag; they stay two. PROP-068 (2026-10-07) then decided that
  // every part row gets +child — a bought part's children now mean something
  // (In the box, or a Prepared wrapper) — except a finished good, which never
  // holds children. That is a decision, not a side effect of expandability.
  assert.ok(/function renderRootRow\(comp, allowExpand = false, allowAddChild = false\)/.test(app),
    "renderRootRow still takes a single flag");
  assert.ok(/role === "rushroom" && allowAddChild && comp\.type !== "finished_good" \?/.test(app),
    "+child must be hidden on a finished good, and still gated on its own flag");
  assert.ok(/const allowAddChild = true;/.test(app), "the Parts tab lost its +child (PROP-068)");
});

// ---- Categories on Assemblies (PROP-065) -----------------------------------
// The chips and the Category sort were gated to the Parts tab because an
// assembly is not *required* to have a category. Three already carried one,
// inherited through a copy, with no way to see or filter by it.

test("categories are gated by one predicate, not three copies", () => {
  assert.ok(/const bomTabHasCategories = \(tab\) => tab !== "dynamic";/.test(app),
    "the predicate is missing");
  // The main list, the add-child picker and pickComponentModal all ask this.
  assert.ok([...app.matchAll(/bomTabHasCategories\(/g)].length >= 10,
    "not every category gate routes through the predicate");
  assert.equal([...app.matchAll(/tab !== "components"\s*\)\s*\{\s*\n\s*\w*[Cc]at/g)].length, 0,
    "a chip bar is still hidden by a hard-coded Parts check");
});

test("the chip counts describe the tab you are on", () => {
  // grouped.components on the Assemblies tab would have counted parts.
  assert.equal([...app.matchAll(/const parts = grouped\.components \|\| \[\];/g)].length, 0,
    "a chip bar still counts the Parts group regardless of tab");
  assert.ok([...app.matchAll(/const parts = grouped\[(activeTab|state\.tab|pickState\.tab)\] \|\| \[\];/g)].length === 3,
    "the three chip bars do not all count the active tab's group");
});

test("a category chosen on one tab does not follow you to another", () => {
  // With chips on both tabs, a shared selection lands you on an empty list for
  // a reason that happened on a different screen.
  assert.ok(/const categoryByTab = \{ components: "all", assemblies: "all", dynamic: "all" \}/.test(app),
    "the category selection is still shared across tabs");
  assert.ok(/const curCategory = \(\) => categoryByTab\[activeTab\] \|\| "all"/.test(app),
    "there is no per-tab accessor");
  assert.ok(!/\bactiveCategory\b/.test(app), "the old shared variable is still referenced");
  // Paging resets for the tab being filtered, not always for Parts.
  assert.ok(/categoryByTab\[activeTab\] = id; tabPageShown\[activeTab\] = PAGE_SIZE/.test(app),
    "choosing a category on Assemblies resets the Parts page counter");
});

test("a tree that failed to load is tried again, and says why it failed", () => {
  // 2026-10-07: one getBom failed in transit and the tree stayed "Failed to
  // load" until a full page reload — re-expanding never asked again — and the
  // reason was thrown away.
  assert.ok(/!expandedTrees\[comp\.id\] \|\| expandedTrees\[comp\.id\] === "error"/.test(app), "re-expanding does not retry");
  assert.ok(/!expandedTrees\[c\.id\] \|\| expandedTrees\[c\.id\] === "error"/.test(app), "Expand all skips failed trees");
  assert.ok(!/catch \{ expandedTrees\[[^\]]+\] = "error"; \}/.test(app), "a failure still discards its reason");
  assert.ok(/`Failed to load tree: \$\{reason\}`/.test(app));
  assert.ok(/\}, "Retry"\)/.test(app), "no Retry on a failed tree");
});
