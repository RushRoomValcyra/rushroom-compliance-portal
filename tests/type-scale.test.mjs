// Type and control scale — static, no credentials.
//
// Before this there were ~40 distinct font sizes across styles.css and the
// inline styles in app.js: 0.8 / 0.82 / 0.83 / 0.84 / 0.85 and so on. Nobody
// chose those differences and nobody can see them individually, but together
// they make an interface read as unsettled. The scale only stays a scale if
// drift is caught, so it is asserted rather than remembered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "assets/styles.css"), "utf8");
const app = readFileSync(join(root, "assets/app.js"), "utf8");

/** The six body/control steps, plus the eyebrow step. */
const ALLOWED_INLINE = new Set([
  "0.625rem", "0.6875rem", "0.75rem", "0.8125rem", "0.875rem", "1rem", "1.125rem",
  "1.25rem", "1.5rem", "1.75rem", "2rem",   // display steps
]);

test("every font size in the stylesheet comes from a token", () => {
  const raw = [...css.matchAll(/font-size:\s*([0-9.]+rem)/g)].map((m) => m[1]);
  assert.deepEqual(raw, [],
    `these stylesheet sizes bypass the scale: ${[...new Set(raw)].join(", ")}`);
});

test("every scale token is defined in :root and actually used", () => {
  const used = new Set([...css.matchAll(/var\((--fs-[a-z0-9]+)\)/g)].map((m) => m[1]));
  const defined = new Set([...css.matchAll(/(--fs-[a-z0-9]+):/g)].map((m) => m[1]));
  const undef = [...used].filter((t) => !defined.has(t));
  assert.deepEqual(undef, [], `undefined tokens: ${undef.join(", ")}`);
  const rootBlock = css.slice(css.indexOf(":root"), css.indexOf("}", css.indexOf(":root")));
  const outside = [...defined].filter((t) => !rootBlock.includes(`${t}:`));
  assert.deepEqual(outside, [], `tokens defined outside :root will not resolve: ${outside.join(", ")}`);
});

test("inline font sizes in app.js sit on the scale", () => {
  // Glyphs inside fixed-size circular buttons are sizing an icon, not setting
  // type, and are exempt by design.
  const offenders = [];
  for (const m of app.matchAll(/"[^"\n]*"|`[^`\n]*`/g)) {
    const str = m[0];
    if (!str.includes("font-size:")) continue;
    if (str.includes("border-radius:50%")) continue;
    for (const f of str.matchAll(/font-size:([0-9.]+rem)/g)) {
      if (!ALLOWED_INLINE.has(f[1])) offenders.push(f[1]);
    }
  }
  assert.deepEqual([...new Set(offenders)], [],
    `off-scale inline sizes: ${[...new Set(offenders)].join(", ")}`);
});

test("row-action buttons use .btn-xs rather than hand-set padding", () => {
  // Twelve different inline paddings each fought .btn's 44px min-height and
  // produced a tall box around a tiny label.
  const bad = [...app.matchAll(/class: "btn[^"]*"[^\n]{0,160}?padding:\d+px \d+px/g)].map((m) => m[0].slice(0, 60));
  assert.deepEqual(bad, [], `buttons still carrying inline padding:\n  ${bad.join("\n  ")}`);
  assert.ok(/\.btn-xs\s*\{/.test(css), ".btn-xs is not defined");
});

test(".btn-xs is declared after .btn so its height applies", () => {
  // Equal specificity: source order decides. Declared first, its 32px would
  // silently lose to .btn's 44px and every row action would stay oversized.
  assert.ok(css.indexOf(".btn-xs {") > css.indexOf(".btn {"),
    ".btn-xs is declared before .btn, so its min-height never takes effect");
});

test("interactive controls stay within reach of the WCAG target size", () => {
  const xs = css.slice(css.indexOf(".btn-xs {"), css.indexOf("}", css.indexOf(".btn-xs {")));
  const h = Number((xs.match(/min-height:\s*(\d+)px/) || [])[1]);
  // 2.5.8 (AA) requires 24px; the full-size .btn keeps 44px for 2.5.5 (AAA).
  // A row action below 24px would fail outright.
  assert.ok(h >= 24, `.btn-xs min-height is ${h}px, below the 24px AA target size`);
});
