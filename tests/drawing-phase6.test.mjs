// Dynamic drawings, Phase 6 (docs/DYNAMIC_DRAWINGS.md §7 Phase 6; DRAWINGS_TAB_UX
// §13.10): Rebase, Drop on unmatched overrides, the spec facts in the release
// modal, the released-issue guard. Static guards over the files that must agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("portal-api: rebaseDrawingSpec makes a carry row on the current version and refuses when nothing drifted", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  assert.match(api, /action === "rebaseDrawingSpec"/);
  assert.match(api, /if \(target\.id === pinned\.id\) return json\(\{ error: `\$\{pinned\.name\} v\$\{pinned\.version\} is the current version; nothing to rebase onto` \}, 409\)/);
  assert.match(api, /patch, patch_sha256, operations: \[\], origin: "carry",\n\s*prompt: `rebase \$\{pinned\.name\} v\$\{pinned\.version\} → v\$\{target\.version\}`/);
  assert.match(api, /New issue from CAD renders the next letter on the current template/, "a released current issue is refused");
});

test("portal-api: an edit on a released current issue is refused on apply, promote and rebase", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const applyBlock = api.slice(api.indexOf('action === "applyDrawingSpecOps"'), api.indexOf('action === "promoteDrawingSpecOps"'));
  assert.match(applyBlock, /render the next letter from CAD and edit that/);
  const promoteBlock = api.slice(api.indexOf('action === "promoteDrawingSpecOps"'), api.indexOf('action === "rebaseDrawingSpec"'));
  assert.match(promoteBlock, /render the next letter before changing the template from it/);
});

test("portal-api: previewRelease carries template_drift beside iteration_open and spec_not_recorded", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const block = api.slice(api.indexOf("const specFacts"), api.indexOf("the spec facts never block a release"));
  for (const w of ["spec_not_recorded", "iteration_open", "template_drift"]) assert.match(block, new RegExp(`specWarnings\\.push\\("${w}"\\)`), w);
  assert.match(block, /sp\.current_version = curV\?\.version \?\? null/);
});

test("the rail: Rebase beside the drift text on a draft, Unmatched overrides with Drop, the three spec rows in the release modal", () => {
  const app = read("assets/app.js");
  assert.match(app, /"rebaseDrawingSpec", \{ drawing_id: drawing\.id, parent_seq: parentSeq\(\) \}/);
  assert.match(app, /t\.drift && t\.current_version != null && editable/, "Rebase only on a draft with drift");
  assert.match(app, /`Unmatched overrides \(\$\{list\.length\}\)`/);
  assert.match(app, /op: "remove_override", at: u\.at, kind: u\.kind, reason: ""/, "Drop is an ordinary remove_override");
  assert.match(app, /nodes: \[\.\.\.dimsNodes, unmatchedSlot, patchSlot, specSlot\]/, "unmatched overrides list first, above Patch");
  for (const w of ["template changed since", "iteration open", "not recorded", "geometry same", "geometry differs", "Unmatched overrides"]) assert.ok(app.includes(w), w);
  assert.match(app, /if \(kind === "drawing" && "spec" in p\)/, "the rows appear for a drawing issue only");
  assert.ok(!/can_release[^\n]*template_drift/.test(app), "a drift fact never blocks the release");
});

test("docs and shells: SYSTEM_OVERVIEW lists the dynamic-drawings actions and the three tables; CLAUDE.md counts 32; v472 on both shells", () => {
  const so = read("docs/SYSTEM_OVERVIEW.html");
  for (const a of ["getDrawingSpec", "applyDrawingSpecOps", "proposeDrawingSpecOps", "promoteDrawingSpecOps", "rebaseDrawingSpec", "drawing_spec_versions", "drawing_spec_patches", "drawing_spec_turns"]) assert.ok(so.includes(a), `${a} missing from SYSTEM_OVERVIEW`);
  const claude = read("CLAUDE.md");
  assert.match(claude, /Supabase Postgres \(35 tables\)/);
  assert.match(claude, /Frontend cache version: \?v=47[3-9]/);
  for (const f of ["index.html", "supplier.html"]) {
    const html = read(f);
    for (const a of ["app.js", "styles.css", "viewer.js"]) assert.ok(Number((html.match(new RegExp(`assets/${a}\\?v=(\\d+)`)) || [])[1]) >= 472, `${f}: ${a}`);
  }
  const ux = read("docs/DRAWINGS_TAB_UX.md");
  assert.match(ux, /### 13\.10 Carry-forward, Rebase, the release facts/);
});
