// The drawings engine's progress contract (docs/DRAWINGS_TAB_UX.md §13.11):
// every click that starts background work shows the upload zone's bar — a
// render job driven by its real stages from the queue on, a short action
// trickling toward 90 and landing on 100 / red. And the pair rules drawset
// reports as unmatched (unmatched_rules or kind "pair") drop with remove_pair.
// Static guards only: no credentials, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const app = read("assets/app.js");
const css = read("assets/styles.css");
const body = (name) => {
  const i = app.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} missing`);
  return app.slice(i, app.indexOf("\n  }\n", i));
};

test("one bar component, the upload zone's look, accessible, cleaned up", () => {
  const p = body("drProgress");
  assert.match(p, /class: "up-progress-bar"/);
  assert.match(p, /class: "up-progress-pct"/);
  assert.match(p, /`up-progress-row dr-progress/, "the upload zone's row, not a new look");
  assert.match(p, /role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0"/);
  assert.match(p, /track\.setAttribute\("aria-valuenow"/, "aria-valuenow follows the bar");
  assert.match(p, /"aria-busy": "true"/);
  assert.match(p, /1 - 0\.8 \* Math\.exp\(-t \/ tau\) - 0\.2 \* Math\.exp\(-t \/ \(12 \* tau\)\)/, "a stage creeps toward its cap with a slow tail");
  assert.match(css, /\.dr-progress\[aria-busy="true"\] \.up-progress-bar::after \{[^}]*animation: dr-progress-sheen/, "a running bar visibly lives even near its band's cap");
  assert.match(p, /if \(root\.isConnected\) seen = true;\n\s*else if \(seen \|\| Date\.now\(\) - born > 15000\)/, "the loop ends once the bar left the document");
  assert.match(p, /fail: \(w\) => \{ phase = "fail"; halt\(\);/, "a failure stops the loop: never spinning after an error");
  assert.match(css, /\.dr-progress\.is-error \.up-progress-bar \{ background: var\(--red\); \}/);
  assert.match(css, /\.dr-progress\.is-inline \{/);
});

test("drBusy: disabled at once, one run at a time, 100 on success, red on false or a throw", () => {
  const b = body("drBusy");
  assert.match(b, /if \(btn && btn\.__drBusy\) return false;/);
  assert.match(b, /btn\.__drBusy = true; btn\.__drBar = p; btn\.disabled = true;/);
  assert.match(b, /p\.run\(opts\.ms\)/);
  assert.match(b, /catch \(ex\) \{ p\.fail\(\); p\.remove\(1800\); throw ex; \}/);
  assert.match(b, /if \(out === false\) \{ p\.fail\(\); p\.remove\(1800\); \}\n\s*else \{ p\.done\(\); p\.remove\(900\); \}/);
});

test("render jobs: the bar follows the stages from the queue on, mirrored under the Patch head", () => {
  const s = body("drJobStage");
  assert.match(s, /word: "Queued"/, "a job no worker has claimed still shows a moving bar");
  assert.match(s, /if \(j\.status === "done"\) return \{ phase: "done", at: 100 \}/);
  assert.match(s, /phase: "fail"/);
  for (const k of ["claim", "download", "render", "verify", "upload", "register"]) assert.match(app, new RegExp(`DR_STAGE_WEIGHT = \\{[^}]*${k}:`), k);
  const panel = body("drawingRenderJobPanel");
  assert.match(panel, /\[bar\.el, stepsEl, resultEl, errEl\]/, "the bar sits above the checklist");
  assert.match(panel, /for \(const b of bars\) drShowJobStage\(b, j, fresh\)/);
  assert.match(panel, /if \(\[401, 403, 404\]\.includes\(ex\.status\)\) \{ for \(const b of bars\) b\.fail\(\); return; \}/, "a poll that gives up turns the bar red");
  assert.match(panel, /await new Promise\(\(r\) => setTimeout\(r, 700\)\);/, "the bar lands before the repaint");
  assert.match(app, /if \(layer && drLive\(job\) && job\.mode === "iterate"\) layer\.showJobBar\(panel\.addBar\(\)\)/);
  assert.match(app, /patchJobSlot,\n\s*lines\.length/);
  // The click itself: New issue (the modal's Render) and Re-render / Render.
  assert.match(app, /await drBusy\(renderBtn, async \(\) => \{\n\s*const body = \{ component_id: preset\.component_id/);
  assert.match(app, /const job = await drBusy\(btn, async \(\) => \{\n\s*const j = drUnwrapJob\(await API\.post\(token, "requestDrawingRender"/);
  assert.match(app, /loadBar\.done\(\); loadBar\.remove\(600\);/, "the spec catalogue load shows a bar where Render waits");
});

test("short actions: every one carries the bar at its control", () => {
  // Every postOps call from a control goes through drBusy.
  const calls = app.split("\n").filter((l) => l.includes("postOps(") && !l.includes("async function postOps"));
  assert.ok(calls.length >= 6, `expected the six postOps callers (two forms, the card, Drop, ×, Revert), got ${calls.length}`);
  for (const l of calls) assert.match(l, /drBusy\([a-zA-Z]+, \(\) => postOps\(/, l.trim());
  // Send: the AI call (10–40 s) — a full-width bar under Ask, Enter cannot send twice.
  assert.match(app, /if \(!prompt \|\| sendBtn\.__drBusy\) return;/);
  assert.match(app, /\{ slot: sendBar, ms: 12000, label: "Asking" \}/);
  assert.match(app, /sendBtn,\n\s*\]\),\n\s*sendBar,/);
  // Promote, Discard (the turn), Rebase, Keep / Discard (the candidate), Release, Delete.
  assert.match(app, /await drBusy\(apply, async \(\) => \{\n\s*try \{\n\s*const r = await API\.post\(token, "promoteDrawingSpecOps"/);
  assert.match(app, /await drBusy\(discard, async \(\) => \{\n\s*try \{ if \(res\.turn_id\) await API\.post\(token, "discardDrawingSpecTurn"/);
  assert.match(app, /await drBusy\(b, async \(\) => \{\n\s*try \{\n\s*await API\.post\(token, "rebaseDrawingSpec"/);
  assert.match(app, /await drBusy\(btn, async \(\) => \{\n\s*try \{\n\s*await API\.post\(token, action, \{ job_id: job\.id \}\);/);
  assert.match(app, /onclick: \(e\) => finish\("acceptDrawingIteration", buttons, e\.currentTarget\)/);
  assert.match(app, /onclick: \(e\) => finish\("discardDrawingIteration", buttons, e\.currentTarget\)/);
  assert.match(app, /await drBusy\(releaseBtn, async \(\) => \{/);
  assert.match(app, /await drBusy\(deleteBtn, async \(\) => \{/);
  // Loading panes: the surface and the candidate.
  assert.match(app, /setChildren\(host, drLoading\("Loading drawing…"\)\)/);
  // The file pane (an issue in the history, Plain PDF / Sheets), the release
  // and delete previews, Adopt's part list: a bar, never bare "Loading…" text.
  assert.match(app, /setChildren\(fileTarget, drLoading\(`Loading Issue \$\{rev\.revision\}…`\)\)/);
  assert.match(app, /current \? drLoading\("Loading the drawing…"\)/);
  assert.equal((app.match(/const body = el\("div", \{ style: "min-width:min\(640px,88vw\)" \}, drLoading\("Loading…"\)\)/g) || []).length, 2, "release + delete previews");
  assert.match(app, /const box = el\("div", \{\}, drLoading\("Loading parts…"\)\)/);
  assert.doesNotMatch(app, /class: "loading" \}, `Loading Issue/);
  // New drawing Save and Adopt.
  assert.match(app, /await drBusy\(btn, async \(\) => \{ try \{\n\s*const res = await API\.post\(token, "createDrawingWithRevision"/);
  assert.match(app, /const ok = await drBusy\(btn, async \(\) => \{\n\s*try \{ res = await API\.post\(token, "adoptDrawing"/);
  assert.match(app, /drLoading\("Loading the candidate…"\)/);
  // + New issue (upload) moved onto the shared bar.
  assert.match(app, /prog = drProgress\(\{ label: "Upload revision" \}\)/);
});

test("unmatched pair rules: both report shapes read, Drop posts remove_pair, shown in rail, strip and release modal", () => {
  const u = body("drUnmatched");
  assert.match(u, /u\.rule === "pair" \|\| u\.kind === "pair"/, "folded into unmatched_overrides with kind pair");
  assert.match(u, /r\.unmatched_rules/, "or reported apart as unmatched_rules");
  assert.match(app, /\{ op: "remove_pair", D: Number\(u\.D\), cc: Number\(u\.cc\), reason: "" \}/);
  assert.match(app, /editable && drUnmatchedDropOp\(u\) && \(!u\.pair \|\| drPatchHasPair\(state\.latest\?\.patch, u\)\)/, "no Drop on a template pair the core would refuse");
  assert.match(app, /const list = drUnmatched\(spec\?\.issue_job\?\.result\);/, "the rail: the issue's job");
  assert.match(app, /const unmatched = drUnmatched\(result\);/, "the strip: the candidate's job");
  assert.match(app, /unmatched\.map\(\(u\) => unmatchedLine\(u, stripErr\)\)/, "the strip's lines carry Drop");
  assert.match(app, /drUnmatched\(\{ unmatched_overrides: p\.unmatched_overrides, unmatched_rules: p\.unmatched_rules \}\)/, "the release modal");
  const api = read("supabase/functions/portal-api/index.ts");
  assert.match(api, /if \(Array\.isArray\(unmatchedRules\)\) specFacts\.unmatched_rules = unmatchedRules;/);
});

test("the dialogue prompt: add_pair covers a face column and an edge; 'make this a c/c' maps to add_pair", () => {
  const src = read("supabase/functions/portal-ai/handlers/drawing-spec.ts");
  assert.match(src, /holes of class D in one column on a face, AND holes of class D along one edge/);
  assert.match(src, /"make this a c\/c"\. → add_pair \{D: 12, cc: 448\}/);
});

test("cache v476 on both shells and in CLAUDE.md", () => {
  for (const f of ["index.html", "supplier.html"]) {
    const html = read(f);
    for (const a of ["app.js", "styles.css", "viewer.js"]) assert.equal((html.match(new RegExp(`assets/${a}\\?v=(\\d+)`)) || [])[1], "476", `${f}: ${a}`);
  }
  assert.match(read("index.html"), /drawing-spec-core\.mjs\?v=476/);
  assert.match(read("CLAUDE.md"), /Frontend cache version: \?v=476/);
});
