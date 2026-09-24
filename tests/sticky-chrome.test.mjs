// Sticky chrome (PROP-054) — static, no credentials.
//
// The header, the tab bar and the sub-tab rows each pin below the one above.
// The offsets are measured, not assumed, because every one of those rows wraps
// to a second line on a narrow window — a hard-coded offset overlaps or leaves
// a gap exactly when the screen is smallest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const app = read("assets/app.js");
const css = read("assets/styles.css");

function rule(selector) {
  const m = css.match(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `${selector} not found in styles.css`);
  return m[2];
}

test("the sub-tab row pins below the tab bar, which pins below the header", () => {
  const bar = rule(".subtab-bar");
  assert.ok(/position:\s*sticky/.test(bar), ".subtab-bar is not sticky");
  assert.ok(/--header-h/.test(bar) && /--tabs-h/.test(bar),
    ".subtab-bar's offset does not stack on the header and tab bar heights");
  assert.ok(/background:\s*var\(--bg\)/.test(bar),
    "a pinned bar with no background lets the content scroll through it");
  // Both rows above it must actually be sticky, or the stack is imaginary.
  assert.ok(/position:\s*sticky/.test(rule(".site-header")), ".site-header is not sticky");
  assert.ok(/position:\s*sticky/.test(rule(".tabs")), ".tabs is not sticky");
});

test("a second-level sub-tab row clears the first", () => {
  const nested = rule(".subtab-body .subtab-bar");
  assert.ok(/--subtabs-h/.test(nested), "the nested row does not clear the row above it");
  // Product BOM is exactly this case: its own tabs sit inside the As Operated
  // sub-tab body.
  assert.ok(/subTabs\("product", tabs\)/.test(app), "the two-level case no longer exists");
});

test("pinned rows are layered under the bar they pin beneath", () => {
  const z = (s) => {
    const m = rule(s).match(/z-index:\s*([^;]+);/);
    assert.ok(m, `${s} has no z-index`);
    return m[1].trim();
  };
  assert.equal(z(".tabs"), "var(--z-sticky)");
  assert.equal(z(".subtab-bar"), "calc(var(--z-sticky) - 1)");
  assert.equal(z(".subtab-body .subtab-bar"), "calc(var(--z-sticky) - 2)");
});

test("a short window does not end up all chrome", () => {
  assert.ok(/@media \(max-height: 780px\)[\s\S]{0,320}\.subtab-body \.subtab-bar \{ position: static; \}/.test(css),
    "on a short viewport three pinned rows plus a header leave too little content");
});

test("the sticky element is a wrapper, not the pill group", () => {
  // .subtabs is inline-flex; sticking it would let content scroll past either
  // side of the pills.
  assert.ok(/el\("div", \{ class: "subtab-bar" \}, bar\)/.test(app),
    "subTabs no longer wraps its bar in a full-width sticky element");
  assert.ok(/\.subtabs \{[^}]*inline-flex/.test(css), ".subtabs is expected to stay an inline pill group");
  assert.ok(!/\.subtabs \{[^}]*position:\s*sticky/.test(css), "the pill group itself is sticky");
});

test("the chrome is measured, and hidden panels are skipped", () => {
  const fn = app.match(/function measureChrome\(\)[\s\S]*?\n  \}/);
  assert.ok(fn, "measureChrome not found");
  for (const v of ["--header-h", "--tabs-h", "--subtabs-h"]) {
    assert.ok(fn[0].includes(v), `measureChrome does not set ${v}`);
  }
  // Six panels each hold a sub-tab bar; five of them are display:none.
  assert.ok(/offsetParent !== null/.test(fn[0]),
    "a hidden panel's sub-tab bar would be measured as the visible one");
  assert.ok(/\[role="tabpanel"\]:not\(\[hidden\]\)/.test(fn[0]), "the query does not exclude hidden panels");
});

test("measuring does not force a reflow on every DOM change", () => {
  // offsetHeight forces layout, and this app replaces hundreds of rows at a
  // time. A DOM-wide MutationObserver would pay for that once a frame.
  assert.ok(!/new MutationObserver\(scheduleChromeMeasure\)/.test(app),
    "the chrome measurer is back on a DOM-wide observer");
  assert.ok(/requestAnimationFrame\(\(\) => \{ chromeFrame = 0; measureChrome\(\); \}\)/.test(app),
    "measurement is not gated to one call per frame");
  // The four moments that actually change the pinned chrome.
  const calls = [...app.matchAll(/scheduleChromeMeasure\(\)/g)].length;
  assert.ok(calls >= 5, `expected the measure to be triggered at each change point, found ${calls} call sites`);
  for (const ctx of ["appEl.hidden = false;\n      scheduleChromeMeasure();", "panel.hidden = !sel;"]) {
    assert.ok(app.includes(ctx), `missing re-measure at: ${ctx.split("\\n")[0]}`);
  }
});

test("the header height is measured in one place, not once per page", () => {
  // index.html and supplier.html each carried their own copy, which measured
  // only the header and would now be a half-correct duplicate.
  for (const page of ["index.html", "supplier.html"]) {
    assert.ok(!/setHeaderH/.test(read(page)), `${page} still has its own inline header measurer`);
  }
  assert.ok(/root\.style\.setProperty\("--header-h"/.test(app), "app.js does not set --header-h");
});
