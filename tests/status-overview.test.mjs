// Status Overview + BOM Tree lifecycle strip — static, no credentials.
//
// The feature computed correctly and was unusable: it asked for a raw component
// UUID, and nothing in the portal displays one. A working feature behind an
// unreachable door is indistinguishable from a broken one, which is how several
// things in this codebase ended up with zero rows in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(root, "assets/app.js"), "utf8");

function block(startNeedle, endNeedle) {
  const i = app.indexOf(startNeedle);
  assert.ok(i > 0, `${startNeedle} not found`);
  const j = app.indexOf(endNeedle, i);
  return app.slice(i, j > 0 ? j : undefined);
}

test("Status Overview never asks for a raw component id", () => {
  const b = block("async function statusOverviewView(", "\n  // --- Main renderProduct");
  assert.ok(!/Root component ID/.test(b), "the raw UUID input is still there");
  assert.ok(/listComponents/.test(b), "it does not load a list to choose from");
  assert.ok(/optgroup/.test(b), "the picker does not group by type, so a long list is unreadable");
});

test("Status Overview names what needs attention, not only how much", () => {
  const b = block("async function statusOverviewView(", "\n  // --- Main renderProduct");
  // Counting alone leaves the user to hunt for the flagged parts by hand.
  assert.ok(/flagged/.test(b) && /replaced/.test(b), "it does not surface flagged or replaced components");
  assert.ok(/Needs attention/.test(b), "there is no list of the components that need attention");
});

test("the BOM Tree carries the same summary with no root to choose", () => {
  const b = block("async function bomTreeView(", "function groupFiltered()");
  assert.ok(/const summaryEl = el\(/.test(b), "the tree has no summary strip");
  assert.ok(/summaryEl,\n      catBarEl/.test(app), "the strip is not mounted in the tree layout");
  const paint = block("function paintSummary(", "function groupFiltered()");
  assert.ok(/expandedTrees/.test(paint), "the strip ignores expanded sub-assemblies, so it under-reports what is on screen");
});

test("both surfaces share one summary implementation", () => {
  // Two copies would disagree eventually, and a status figure that differs
  // between two screens is worse than one that is absent from both.
  const uses = (app.match(/lifecycleSummary\(/g) || []).length;
  assert.ok(uses >= 3, `expected one definition and at least two call sites, found ${uses} occurrences`);
  assert.equal((app.match(/function lifecycleSummary\(/g) || []).length, 1,
    "lifecycleSummary is defined more than once");
});

test("the summary counts each component once", () => {
  const b = block("function lifecycleSummary(", "\n  const MATURITY_COLORS");
  // A component can sit under several assemblies; counting per appearance
  // would overstate the BOM.
  assert.ok(/new Map\(\)/.test(b) || /seen/.test(b), "the summary does not dedupe by id");
});

test("summaryEl is declared before the layout that mounts it", () => {
  // const is not hoisted: a declaration below its first use throws at runtime,
  // which has already happened twice in this file.
  const decl = app.indexOf("const summaryEl = el(");
  const use = app.indexOf("      summaryEl,\n      catBarEl");
  assert.ok(decl > 0 && use > 0, "summaryEl declaration or use not found");
  assert.ok(decl < use, "summaryEl is used before it is declared — temporal dead zone");
});
