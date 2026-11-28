// Drawing Templates phase 2, the frontend (docs/DRAWING_TEMPLATES.md §3.9,
// §4.3, §4.4): the [Sandbox ▾] list, the sandbox page, the hand row, the
// catch with rings and counts, Try on, the paper mapping. Static guards plus
// the pure paper ↔ model functions run in node: no credentials, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as RulesCore from "../supabase/functions/_shared/template-rules-core.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const app = read("assets/app.js");
const viewer = read("assets/viewer.js");
const css = read("assets/styles.css");
const html = read("index.html");
const body = (name) => {
  const i = app.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} missing`);
  return app.slice(i, app.indexOf("\n    }\n", i));
};
const block = (() => {
  const i = app.indexOf("// ---- Drawing Templates (docs/DRAWING_TEMPLATES.md, phase 1)");
  assert.ok(i > 0, "the Drawing Templates block is missing");
  return app.slice(i, app.indexOf("// Land on the first register", i));
})();

test("index.html exposes the rules core beside SpecCore", () => {
  assert.match(html, /import \* as RulesCore from "\.\/supabase\/functions\/_shared\/template-rules-core\.mjs\?v=\d+";\s*window\.PortalRulesCore = RulesCore;/);
  const spec = html.indexOf("window.PortalSpecCore = SpecCore;");
  const rules = html.indexOf("window.PortalRulesCore = RulesCore;");
  assert.ok(spec > 0 && rules > spec && rules - spec < 200, "in the same module script, after SpecCore");
  assert.doesNotMatch(read("supplier.html"), /template-rules-core|PortalRulesCore/);
});

test("every RulesCore name the page uses is exported by the core", () => {
  const used = new Set([...block.matchAll(/\bRC\.([A-Za-z_]+)/g)].map((m) => m[1]));
  assert.ok(used.size > 10, "the page reads the core");
  for (const n of used) assert.ok(n in RulesCore, `RulesCore.${n} is not exported`);
});

test("the phase 2 functions exist", () => {
  for (const f of ["dtplSandboxMenu", "dtplSandboxNameModal", "dtplSavedRules", "dtplEdgesRows", "dtplRuleRow",
    "dtplOpenSandbox", "dtplSbPaint", "dtplSbRulesPane", "dtplSbRings", "dtplSbClick", "dtplSbRequestCatch",
    "dtplSbWatchCatch", "dtplSbCaught", "dtplSbApply", "dtplSbRemoveOp", "dtplHandRow", "dtplTermBox",
    "dtplSbEdgesForm", "dtplSbTryPane", "dtplSbPickPart", "dtplSbDiscard", "dtplFaceViews", "dtplRingsFor", "dtplHoleAt"]) {
    assert.match(app, new RegExp(`function ${f}\\(`), `${f} missing`);
  }
});

test("the actions of the contract are called with its fields", () => {
  const calls = {
    createDrawingTemplateSandbox: /\{ part_type_id: t\.id, name \}/,
    getDrawingTemplateSandbox: /\{ id \}/,
    applyDrawingTemplateOps: /\{ id: S\.id, rev: S\.sb\.rev, ops, \.\.\.\(o\.marks && o\.marks\.length \? \{ marks: o\.marks \} : \{\}\) \}/,
    removeDrawingTemplateOp: /\{ id: S\.id, rev: S\.sb\.rev, index \}/,
    renameDrawingTemplateSandbox: /\{ id: sb\.id, rev: sb\.rev, name \}/,
    setDrawingTemplateTryParts: /\{ id: S\.id, rev: S\.sb\.rev, component_ids: ids \}/,
    discardDrawingTemplateChange: /\{ id: sb\.id \|\| S\.id, rev: sb\.rev \}/,
    requestDrawingTemplateCatch: /mark \? \{ id: S\.id, mark \} : \{ id: S\.id \}/,
    getDrawingTemplateCatch: /\{ item_id: itemId \}/,
  };
  for (const [action, args] of Object.entries(calls)) {
    const i = app.indexOf(`API.post(token, "${action}", `);
    assert.ok(i > 0, `${action} is never called`);
    assert.match(app.slice(i, i + 200), args, `${action} fields`);
  }
  assert.match(body("dtplOpenType"), /page\.sandboxes/);
  assert.match(body("dtplSandboxMenu"), /`Sandbox ▾ \$\{list\.length\}`/);
});

test("a bar on every background action", () => {
  for (const action of ["createDrawingTemplateSandbox", "renameDrawingTemplateSandbox", "applyDrawingTemplateOps",
    "removeDrawingTemplateOp", "setDrawingTemplateTryParts", "discardDrawingTemplateChange", "setComponentPartType"]) {
    const from = app.indexOf("// ---- Phase 2: sandboxes, rules and the catch");
    const hits = [...app.matchAll(new RegExp(`API\\.post\\(token, "${action}"`, "g"))].filter((h) => h.index > from);
    assert.ok(hits.length, `${action} is never called by phase 2`);
    for (const h of hits) {
      const before = app.slice(Math.max(0, h.index - 600), h.index);
      assert.match(before, /drBusy\(/, `${action} at ${h.index} is not under drBusy`);
    }
  }
  // The catch: its bar stands from the click through the queue to done.
  const req = body("dtplSbRequestCatch");
  assert.ok(req.indexOf("drProgress(") < req.indexOf("requestDrawingTemplateCatch"), "the bar before the request");
  const w = body("dtplSbWatchCatch");
  assert.match(w, /setTimeout\(tick, 1500\)/, "polls every 1.5 s");
  assert.match(w, /drShowJobStage\(p, job, false\)/);
  assert.match(w, /p\.done\(/); assert.match(w, /p\.fail\(/);
  assert.match(w, /dtplState\.view !== "sandbox"/, "the poll stops once the page is left");
  // Loading pages and pickers show drLoading.
  assert.match(body("dtplOpenSandbox"), /drLoading\("Loading sandbox…"\)/);
  assert.match(body("dtplSbPickPart"), /drLoading\(/);
  // dtplStop clears the catch poll.
  assert.match(body("dtplStop"), /_dtplCatchTimer/);
});

test("after every successful op a catch is asked for", () => {
  for (const f of ["dtplSbApply", "dtplSbRemoveOp"]) {
    const b = body(f);
    assert.ok(b.indexOf("dtplSbTake(S, res.sandbox, res.marks") < b.indexOf("dtplSbRequestCatch(S, null)"), f);
  }
  assert.match(body("dtplSbApply"), /ex\.status === 409/, "a stale rev reloads");
});

test("no confirm(): Discard is a facts modal with the number of changes", () => {
  assert.doesNotMatch(block, /\bconfirm\(/);
  const d = body("dtplSbDiscard");
  assert.match(d, /openModal\(`Discard "/);
  assert.match(d, /n === 1 \? "change" : "changes"/);
  assert.match(d, /el\("dt", \{\}, "Changes"\)/);
});

test("the hand row: one row, labels above the boxes, in the order of §4.4", () => {
  const b = body("dtplHandRow");
  const row = b.slice(b.indexOf('el("div", { class: "dr-row dtpl-hand"'));
  const order = ['"Name"', '"Takes"', '"Across from"', '"Up from"', '"c/c"', '"c/c dir"', '"c/c is"', "plusExtra", '"Specifics"', "apply, cancel"];
  let at = 0;
  for (const o of order) { const i = row.indexOf(o, at); assert.ok(i >= at, `${o} out of order`); at = i; }
  assert.match(app, /const dtplField = \(text, input, cls\) => el\("label", \{ class: `form-row\$\{cls \? ` \$\{cls\}` : ""\}` \}, \[el\("span", \{ class: "form-label" \}, text\), input\]\)/,
    "a label above its box (the .form-row of the drawing surface)");
  assert.match(b, /\["", "—"\], \["can", "can be"\], \["shall", "shall be"\]/);
  for (const x of ["Position ±", "c/c ±", "Ø tolerance", "Depth tolerance", "Thickness from", "Callout name", "At least", "Mates with"]) {
    assert.ok(app.includes(`label: "${x}"`), x);
  }
  assert.ok(b.indexOf("RC.checkRule(next") < b.indexOf("dtplSbApply(S"), "checkRule before Apply");
  assert.match(b, /op: exists \? "set_rule" : "add_rule"/);
  assert.match(b, /setTerms\(list\[list\.length - 1\]\.select\)/, "the narrowest candidate fills Takes");
  assert.match(b, /class: "dtpl-cand"/);
  assert.match(css, /\.dr-row \{ display: flex; align-items: flex-end; gap: 0\.5rem; flex-wrap: wrap; \}/, "the row wraps, label with box");
});

test("rule ids look like the core's RULE_ID", () => {
  const m = app.match(/const dtplRuleId = \(\) => (.+);/);
  assert.ok(m, "dtplRuleId missing");
  const make = new Function("crypto", `return ${m[1]};`);
  for (let i = 0; i < 20; i++) assert.match(make(globalThis.crypto), RulesCore.RULE_ID);
});

test("term boxes produce terms the core accepts", () => {
  const b = body("dtplTermBox");
  for (const k of RulesCore.TERM_KINDS) assert.ok(b.includes(`k === "${k}"`) || b.includes(`"${k}"`), k);
  // The shapes read() builds, checked against checkTerm.
  const samples = [
    { t: "dia", D: 5 }, { t: "drilled", v: "inside" }, { t: "drilled", v: "edge", edge: "bottom" }, { t: "through", v: "blind" },
    { t: "place", edge: "front", op: "at", v: 37 }, { t: "place", edge: "bottom", op: "between", v: 10, v2: 100 },
    { t: "column", edge: "front", rank: 1 }, { t: "row", edge: "top", rank: 2 }, { t: "spacing", pitch: 32, dir: "up" }, { t: "near", D: 8, within: 40 },
  ];
  for (const s of samples) assert.deepEqual(RulesCore.checkTerm(s), [], JSON.stringify(s));
});

test("rules list: n · name · takes · measured · count, ✎ ×, drag → reorder_rules, Base default, findings", () => {
  const b = body("dtplSbRulesPane");
  assert.match(b, /RC\.describeRule\(r\)/);
  assert.match(b, /RC\.catchCounts\(refOut\)/);
  assert.match(b, /RC\.overlapLines\(refOut, rules\)/);
  assert.match(b, /op: "remove_rule", id: r\.id/);
  assert.match(b, /op: "reorder_rules", ids/);
  assert.match(b, /"dragstart"/); assert.match(b, /"drop"/);
  assert.match(b, /"\+ Rule"/);
  assert.match(b, /name: "Base default"/);
  assert.match(b, /refOut\.findings/);
  assert.match(b, /dtplSbEdgesForm\(S, edgeSlot\)/, "EDGES carry a pencil in the sandbox");
  const e = body("dtplSbEdgesForm");
  assert.match(e, /op: "set_edges", edges/);
  assert.match(e, /RC\.EDGE_TEST_NEEDS_D/);
});

test("the saved type page stays read-only", () => {
  const b = body("dtplSavedRules");
  assert.match(b, /dtplEdgesRows\(lines, null, null\)/, "no pencil");
  assert.doesNotMatch(b, /API\.post|✎|×/);
  assert.match(b, /`Rules \(\$\{rules\.length\}\)`/);
  assert.match(b, /"Base default"/);
  assert.match(body("dtplOpenType"), /\{ id: "rules", label: "Rules", build: \(p\) => dtplSavedRules\(p, page\) \}/);
});

test("the sandbox page: amber head with Rename and Discard, Rules and Try on, the rail", () => {
  const b = body("dtplSbPaint");
  assert.match(b, /class: "drawing-head dtpl-sb-head"/);
  assert.match(b, /`\$\{t\.name \|\| "Part type"\} · Sandbox "\$\{sb\.name \|\| ""\}"`/);
  assert.match(b, /"Rename"/); assert.match(b, /"Discard"/);
  assert.match(b, /id: "rules"/); assert.match(b, /id: "try"/);
  assert.match(b, /`Change \(\$\{changes\.length\}\)`/);
  assert.match(b, /`Marks \(/);
  assert.match(b, /"Catch"/);
  assert.match(b, /dtplSbRemoveOp\(S, index, x\)/);
  assert.match(css, /\.dtpl-sb-head \{ background: var\(--amber-bg\)/);
  assert.match(body("dtplOpenSandbox"), /dtplState\.view = "sandbox"/);
});

test("a click marks a hole, worded by describeHole, and asks for its candidates", () => {
  const b = body("dtplSbClick");
  assert.match(b, /dtplHoleAt\(S\.ents, refOut\.holes, at\.sheet, at\.x_mm, at\.y_mm\)/);
  assert.match(b, /RC\.describeHole\(h\)/);
  assert.match(b, /dtplSbRequestCatch\(S, \{ component_id: refOut\.key, hole_id: h\.id \}\)/);
  const marks = body("dtplHandRow");
  assert.match(marks, /rule_id: next\.id, component_id: mk\.component_id, cad_sha256: mk\.cad_sha256, hole_id: mk\.hole_id, description: mk\.description, paper: mk\.paper/);
});

test("Try on: + Part over the candidates, a count per rule, Assign, amber states", () => {
  const b = body("dtplSbTryPane");
  assert.match(b, /"\+ Part"/);
  assert.match(b, /`Assign \$\{t\.name \|\| "part type"\}`/);
  assert.match(b, /setComponentPartType", \{ component_ids: \[c\.component_id\], part_type_id: t\.id \}/);
  assert.match(b, /"no features yet"/);
  assert.match(b, /`failed: \$\{out\.error \|\| "—"\}`/);
  assert.match(b, /"Base default"/);
  assert.doesNotMatch(b, /"Render/, "Render per row is phase 5");
  assert.match(body("dtplSbPickPart"), /listPartTypeReferenceCandidates/);
});

test("viewer: setRings draws circles in the overlay, onPaperClick reports paper mm", () => {
  const i = viewer.indexOf("function renderSheets(");
  const rs = viewer.slice(i, viewer.indexOf("\n  window.PortalViewer", i));
  assert.match(rs, /setRings\(list\)/);
  assert.match(rs, /createElementNS\(SVG_NS, "circle"\)/);
  assert.match(rs, /c\.setAttribute\("cy", ringH - r\.y_mm\)/, "paper mm origin bottom-left, as the rects");
  assert.match(rs, /opts\.onPaperClick\(\{ sheet: currentSheet, x_mm: d\.p\[0\], y_mm: d\.p\[1\] \}\)/);
  assert.match(css, /\.sheet-ring \{[^}]*pointer-events: none/);
  assert.match(body("dtplShowReference"), /onPaperClick: view && view\.onPaperClick/);
});

test("paper mapping: a ring sits where drawset draws the hole, and a click on it finds the hole", () => {
  const src = ["dtplFaceViews", "dtplRingsFor", "dtplHoleAt"].map((n) => body(n) + "\n    }").join("\n");
  const fns = new Function(`${src}; return { dtplFaceViews, dtplRingsFor, dtplHoleAt };`)();
  // A face view: ox 40, oy 30, s 0.1, mirrored (sx −1, p0 −580), showing y 0..1000.
  const ents = { sheets: [{ sheet: 2, views: [{ id: "face", kind: "face", ox: 40, oy: 30, s: 0.1, sx: -1, p0: -580, ya: 0, yb: 1000 }, { kind: "edge", s: 1 }] }] };
  const holes = [
    { id: "H1", D: 5, pos: [105, 59] },
    { id: "H2", D: 8, pos: [569, 400] },
    { id: "H3", D: 5, pos: [105, 1500] },   // above yb: not on this view
  ];
  const rings = fns.dtplRingsFor(ents, holes, "is-rule");
  assert.equal(rings.length, 2);
  const r1 = rings[0];
  assert.equal(r1.sheet, 2);
  assert.ok(Math.abs(r1.x_mm - (40 + (-105 + 580) * 0.1)) < 1e-9);
  assert.ok(Math.abs(r1.y_mm - (30 + 59 * 0.1)) < 1e-9);
  assert.equal(r1.r_mm, 1.6, "small holes keep a 1.6 mm ring");
  const hit = fns.dtplHoleAt(ents, holes, 2, rings[1].x_mm + 0.3, rings[1].y_mm - 0.2);
  assert.equal(hit && hit.hole.id, "H2");
  assert.equal(fns.dtplHoleAt(ents, holes, 2, 400, 280), null, "far from every hole");
  assert.equal(fns.dtplHoleAt(ents, holes, 1, r1.x_mm, r1.y_mm), null, "another sheet");
});

test("no new names start with template or tpl; Swedish decimals are read", () => {
  const bad = [...block.matchAll(/(?:function|const|let)\s+((?:template|tpl)[A-Za-z0-9_]*)/gi)].map((m) => m[1])
    .filter((n) => !["tplRuleLabel", "tplRulesWithoutActiveFace", "tplOpenPrintLabels"].includes(n));
  assert.deepEqual(bad, []);
  assert.match(app, /const t = String\(v \?\? ""\)\.trim\(\)\.replace\(",", "\."\);/);
});

// ---- Review fixes ------------------------------------------------------------
test("the catch poll ends on skipped, on a bar that left the page, and when no worker takes it", () => {
  const b = body("dtplSbWatchCatch");
  assert.match(b, /it\.status === "skipped"/);
  assert.match(b, /asked !== S\.sb\.body_sha256/, "asked on another body: asked again");
  assert.match(b, /p\.fail\(it\.error \|\| "Skipped"\)/);
  assert.match(b, /const gone = \(\) => [^;]*!p\.el\.isConnected;/);
  assert.match(b, /\+\+idle > 40\) \{ p\.fail\("No worker"\)/);
  assert.match(b, /setTimeout\(tick, job \? 1500 : idle > 20 \? 15000 : idle > 8 \? 5000 : 1500\)/);
  assert.ok(b.indexOf('it.status === "skipped"') < b.indexOf('"Waiting for the worker"'), "skipped is read before the wait");
});

test("opening a sandbox asks for a catch unless the newest is live, failed or done on this body", () => {
  const b = body("dtplOpenSandbox");
  assert.match(b, /else dtplSbRequestCatch\(S, null\);/);
  assert.match(b, /c\.status === "done" && !otherBody/);
  assert.doesNotMatch(b, /\(!c \|\|/);
});

test("the stored marks follow Apply and Remove: the answer's marks, else the page is read again", () => {
  const b = body("dtplSbTake");
  assert.match(b, /if \(Array\.isArray\(marks\)\) S\.marks = marks;/);
  assert.match(b, /if \(whole && \(Array\.isArray\(marks\) \|\| !marksMoved\)\) \{ S\.repaint\(\); return; \}\s*await dtplOpenSandbox\(S\.id, \{ keep: true \}\);/);
  assert.match(body("dtplSbRemoveOp"), /dtplSbTake\(S, res\.sandbox, res\.marks, /);
});

test("hand row: a typed c/c pitch reaches checkRule, which names the missing choice", () => {
  assert.match(body("dtplHandRow"), /if \(ccMust\.value \|\| ccPitch\.value\.trim\(\)\) \{/);
  const rule = { id: "r_x", name: "Shelf pins", select: [{ t: "dia", D: 5 }], at_least: 0, measure: { cc: { dir: "up", must: "", pitch: 32 } } };
  assert.ok(RulesCore.checkRule(rule, undefined).includes("c/c is: can be or shall be"));
});

test("hand row: the [+] menu hangs on a positioned wrap", () => {
  assert.match(body("dtplHandRow"), /extraEls, el\("span", \{ class: "dtpl-menu-wrap" \}, plusExtra\),/);
  assert.match(css, /\.dtpl-menu-wrap \{ position: relative;/);
  assert.match(css, /\.dtpl-hand \.dtpl-menu \{ right: auto; left: 0; \}/);
});

test("a repaint keeps the shell: the reference sheets are placed once, the hand row keeps focus", () => {
  const b = body("dtplSbPaint");
  assert.equal(b.split("S.refSlot").length - 1, 1, "S.refSlot is placed in one spot, the first paint");
  assert.equal(b.split("host.replaceChildren(").length - 1, 1);
  assert.ok(b.indexOf("if (fresh) {") < b.indexOf("host.replaceChildren("));
  assert.match(b, /sh\.rail\.replaceChildren\(/);
  assert.match(b, /S\.handSlot\.contains\(focused\)/);
  assert.match(b, /focused\.focus\(\);/);
});

test("every term box has its label above; Near reads Ø then Within", () => {
  const b = body("dtplTermBox");
  for (const line of b.split("\n").filter((l) => /\bboxes = \[[^\]]/.test(l))) {
    const list = line.slice(line.indexOf("boxes = [") + 9, line.indexOf("];"));
    for (const item of list.split(/,\s*(?![^()]*\))/)) assert.match(item.trim(), /^(dtplField\(|edgeF$|v2F$)/, line.trim());
  }
  assert.match(b, /boxes = \[dtplField\("Ø", D\), dtplField\("Within", within\)\];/);
  assert.match(b, /edgeF\.style\.display/);
  assert.match(b, /v2F\.style\.display/);
  assert.match(css, /\.dtpl-term \{ display: inline-flex; align-items: flex-end;/);
});

test("one row reads as selected: the rule rows and BASE DEFAULT share the highlight", () => {
  const b = body("dtplSbRulesPane");
  assert.match(b, /const syncSel = \(\) => \{ for \(const n of p\.querySelectorAll\("\.dtpl-rule"\)\)/);
  assert.equal(b.split("syncSel();").length - 1, 2);
  assert.doesNotMatch(b, /baseRow\.classList\.toggle/);
});

test("a features job that failed reads failed: <reason>, not no features yet", () => {
  assert.match(body("dtplSbTryPane"), /c\.features_error && \(!out \|\| out\.status === "no_features"\)\) cells = \[el\("td", \{ colspan: rules\.length \+ 1, class: "is-warn" \}, `failed: \$\{c\.features_error\}`\)\]/);
  assert.match(body("dtplSbRulesPane"), /refPart\.features_error \? `Failed: \$\{refPart\.features_error\}` : "No features yet"/);
});
