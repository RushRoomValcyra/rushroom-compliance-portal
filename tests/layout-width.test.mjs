// Layout width — static, no credentials.
//
// The shell was capped at 1000px, so on a large display well over a thousand
// pixels sat empty either side while the BOM list and every table competed for
// room inside a narrow column.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "assets/styles.css"), "utf8");
const app = readFileSync(join(root, "assets/app.js"), "utf8");

const num = (re, what) => {
  const m = css.match(re);
  assert.ok(m, `${what} not found`);
  return Number(m[1]);
};

test("the shell uses a width token, not a hard-coded cap", () => {
  assert.ok(/\.wrap \{[^}]*max-width: var\(--wrap-max\)/.test(css),
    ".wrap does not use --wrap-max");
  assert.ok(num(/--wrap-max:\s*(\d+)px/, "--wrap-max") >= 1400,
    "the shell is still narrow enough to waste most of a large display");
});

test("prose and forms keep their own measure inside the wider shell", () => {
  // Widening the shell must give space to data, not stretch paragraphs to an
  // unreadable line length.
  const wrap = num(/--wrap-max:\s*(\d+)px/, "--wrap-max");
  for (const [re, what] of [
    [/\.doc-render[\s\S]{0,200}?max-width: (\d+)px/, "rendered document"],
    [/\.step-form \{[^}]*max-width: (\d+)px/, "step form"],
    [/\.gate-card \{[\s\S]{0,200}?max-width: (\d+)px/, "gate card"],
  ]) {
    const v = num(re, what);
    assert.ok(v < wrap, `${what} (${v}px) is not narrower than the shell (${wrap}px)`);
  }
});

test("the surfaces that hold a drawing are not capped at the old widths", () => {
  // The drawing surface renders inside the component detail panel, so its cap
  // decides how large a drawing can be shown.
  const panel = Number((app.match(/width:min\((\d+)px,96vw\)/) || [])[1]);
  assert.ok(panel >= 1400, `the detail panel is capped at ${panel}px, which shrinks every drawing`);
  const viewer = num(/\.viewer-dialog \{[\s\S]{0,400}?width: min\((\d+)px, 96vw\)/, "viewer dialog");
  assert.ok(viewer >= 1200, `the document viewer is capped at ${viewer}px`);
});

test("wide layouts still collapse on small screens", () => {
  // Growing the cap must not remove the narrow-screen handling; the shell is a
  // max, so it yields, but the grids that split into columns must still stack.
  assert.ok(/@media \(max-width: 900px\)[\s\S]*?\.drawing-surface \{ grid-template-columns: minmax\(0, 1fr\)/.test(css),
    "the drawing surface no longer collapses to one column");
  assert.ok(/@media \(max-width: 720px\)/.test(css), "the small-screen breakpoints are gone");
});
