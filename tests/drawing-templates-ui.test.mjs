// Drawing Templates phase 1, the frontend (docs/DRAWING_TEMPLATES.md §4,
// DRAWINGS_TAB_UX.md §14): the sub-tab, the register, the Base and type pages,
// History with compare, the part type on parts, the Template column, a bar on
// every write, nothing for a supplier. Static guards only: no credentials, no
// network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const app = read("assets/app.js");
const css = read("assets/styles.css");
const body = (name) => {
  const i = app.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} missing`);
  return app.slice(i, app.indexOf("\n    }\n", i));
};

test("SUB_TABS: CAD Models · Drawings · Drawing Templates · Surgery Templates", () => {
  const i = app.indexOf("const SUB_TABS = role === \"rushroom\"");
  assert.ok(i > 0, "SUB_TABS missing");
  const block = app.slice(i, app.indexOf("\n      : [", i));
  const ids = [...block.matchAll(/id: "([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["cad_models", "drawings", "drawing_templates", "surgery_templates"]);
  assert.match(block, /label: "Drawing Templates"/);
  assert.match(block, /dtplRender\(drawingTemplatesContentEl\)/);
  // The supplier branch is the Drawings register alone.
  const sup = app.slice(app.indexOf(": [{ id: \"drawings\"", i), app.indexOf("];", app.indexOf(": [{ id: \"drawings\"", i)));
  assert.doesNotMatch(sup, /dtpl|drawing_templates/);
});

test("the dtpl functions exist, and nothing new is named template* or tpl*", () => {
  for (const f of ["dtplRender", "dtplRegister", "dtplOpenBase", "dtplOpenType", "dtplUntypedList",
    "dtplPickReference", "dtplHistory", "dtplCompare", "dtplWatchItem", "dtplShowReference", "partTypeSelect"]) {
    assert.match(app, new RegExp(`function ${f}\\(`), `${f} missing`);
  }
  // The names the Surgery Templates register owned before this phase.
  const owned = new Set(["tplRuleLabel", "tplRulesWithoutActiveFace", "tplOpenPrintLabels"]);
  const i = app.indexOf("// ---- Drawing Templates (docs/DRAWING_TEMPLATES.md, phase 1)");
  assert.ok(i > 0, "the Drawing Templates block is missing");
  const block = app.slice(i, app.indexOf("// Land on the first register", i));
  const bad = [...block.matchAll(/(?:function|const|let)\s+((?:template|tpl)[A-Za-z0-9_]*)/gi)]
    .map((m) => m[1]).filter((n) => !owned.has(n));
  assert.deepEqual(bad, [], `new names starting template / tpl: ${bad.join(", ")}`);
});

test("register: Name · Reference · Parts · Drawings · Version, Base first, No part type last", () => {
  const b = body("dtplRegister");
  for (const h of ["Name", "Reference", "Parts", "Drawings", "Version"]) assert.match(b, new RegExp(`head\\("${h}", "`), h);
  assert.match(b, /el\("strong", \{\}, "Base"\)/);
  assert.match(b, /onclick: \(\) => dtplOpenBase\(\)/);
  assert.match(b, /onclick: \(\) => dtplOpenType\(t\.id\)/);
  assert.match(b, /"No part type"/);
  assert.match(b, /onclick: \(\) => dtplUntypedList\(\)/);
  assert.match(b, /untyped_count/);
  assert.match(b, /`Per-part specs \(/);
  assert.match(b, /retired\.length \? chip\("retired"/);
  assert.match(b, /"\+ Part type"/);
  assert.match(b, /bomChip\(/, "the chips copy the category chips");
  assert.match(css, /\.dtpl-chips/);
});

test("Base page: the five lines with sentence-case labels, no key names", () => {
  const b = body("dtplOpenBase");
  for (const l of ["Title block", "Tolerances", "Sheets", "Edges"]) assert.match(b, new RegExp(`el\\("dt", \\{\\}, "${l}"\\)`), l);
  assert.match(b, /`Rules \(\$\{rules\.length\}\)`/);
  assert.match(b, /"No rules\."/);
  assert.match(b, /getDrawingTemplate", \{ base: true \}/);
  for (const k of ["flat_panel", "face_order", "bottom_up", "yaml"]) assert.doesNotMatch(b, new RegExp(k, "i"), k);
  for (const r of ["\"Version\"", "\"Saved\"", "\"By\"", "\"Drawings\""]) assert.ok(b.includes(r), r);
});

test("History: From · To · Version · Base · Origin · By · Saved · Request · Proof · Restore, compare in words", () => {
  const b = body("dtplHistory");
  assert.match(b, /\["From", "To", "Version", "Base", "Origin", "By", "Saved", "Request", "Proof", "Restore"\]/);
  assert.match(b, /type: "radio"/);
  assert.match(b, /rows\[1\] \|\| rows\[0\]/, "default selection previous → newest");
  const c = body("dtplCompare");
  assert.match(c, /compareDrawingTemplateVersions", \{ from_version_id: fromId, to_version_id: toId \}/);
  assert.match(c, /class: "dtpl-diff"/);
});

test("type page: drawing surface, Parts · Drawings · History, the rail, the reference", () => {
  const b = body("dtplOpenType");
  assert.match(b, /class: "drawing-surface"/);
  assert.match(b, /class: "drawing-rail"/);
  assert.match(b, /`Parts \(/); assert.match(b, /`Drawings \(/); assert.match(b, /`History \(/);
  assert.match(b, /`On Base v\$\{base\.version\}`/);
  assert.match(b, /ref \? "Change" : "Choose"/);
  assert.match(b, /"No versions"/);
  assert.match(b, /retirePartType/);
  assert.match(app, /\["Number", "Title", "Issue", "Status", "Template"\]/);
  const r = body("dtplShowReference");
  assert.match(r, /getDrawingRenderArtifacts", \{ job_id: item\.job_id \}/);
  assert.match(r, /PortalViewer\.renderSheets/);
  assert.match(r, /"Verification failed"/);
  const w = body("dtplWatchItem");
  assert.match(w, /getDrawingTemplateItem/);
  assert.match(w, /setTimeout\(tick, 3000\)/);
  assert.match(w, /"Waiting for the worker"/);
  assert.match(w, /drShowJobStage\(p, job, false\)/);
  assert.match(w, /isConnected/, "the poll stops once the page is left");
  const pick = body("dtplPickReference");
  assert.match(pick, /\["Part number", "Name", "Revision", "Released"\]/);
  assert.match(pick, /listPartTypeReferenceCandidates/);
});

test("drJobStage: a sandbox job's register step reads Finishing", () => {
  const i = app.indexOf("function drJobStage(");
  const b = app.slice(i, app.indexOf("\n  }\n", i));
  assert.match(b, /k === "register" && j\.mode === "sandbox" \? "Finishing"/);
});

test("every new write runs under drBusy", () => {
  for (const action of ["createPartType", "renamePartType", "retirePartType", "setComponentPartType", "setPartTypeReference"]) {
    const hits = [...app.matchAll(new RegExp(`API\\.post\\(token, "${action}"`, "g"))];
    assert.ok(hits.length, `${action} is never called`);
    for (const h of hits) {
      // The properties panel's Save wraps its five calls in one drBusy.
      const before = app.slice(Math.max(0, h.index - 2000), h.index);
      assert.match(before, /drBusy\(/, `${action} at ${h.index} is not under drBusy`);
    }
  }
});

test("part type on parts: picker, properties row, list badge, chips, bulk bar, Change Log", () => {
  const sel = app.slice(app.indexOf("function partTypeSelect("), app.indexOf("const categoryRequiredFor"));
  assert.match(sel, /el\("option", \{ value: "" \}, "—"\)/);
  assert.match(sel, /!t\.retired_at/);
  assert.match(app, /let partTypes = \[\];/);
  assert.match(app, /role === "rushroom"\s*\? API\.post\(token, "listPartTypes", \{\}\)\.catch\(\(\) => \(\{ part_types: \[\] \}\)\)/);
  assert.match(app, /lbl\("Part type"\), ptSel/);
  assert.match(app, /ptChanged\s*\? API\.post\(token, "setComponentPartType"/);
  assert.match(app, /class: "dtpl-badge"/);
  assert.match(app, /class: "dtpl-type-chips"/);
  assert.match(app, /chip\("none", "No part type"\)/);
  assert.match(app, /class: "dtpl-pick"/);
  assert.match(app, /`\$\{dtplPicked\.size\} selected`/);
  const labels = app.match(/const badgeLabel = \{([\s\S]*?)\}\[entry\.change_type\]/)[1];
  assert.match(labels, /part_type_changed: "part type changed"/);
  assert.match(app, /part_type_changed: \["#4a9eed20", "#4a9eed"\]/, "coloured as updated");
});

test("Drawings register: a Template column after Issue, Rushroom only", () => {
  assert.match(app, /head\("Issue", "revision"\),[\s\S]{0,140}isRushroom \? head\("Template", "template_label"\) : null,/);
  assert.match(app, /isRushroom \? el\("td", \{\}, d\.template_label \|\| "—"\) : null/);
});

test("suppliers get nothing: supplier.html and supplier.js carry no dtpl, the new actions only behind rushroom", () => {
  assert.doesNotMatch(read("supplier.html"), /dtpl|DrawingTemplate|PartType/);
  assert.doesNotMatch(read("assets/supplier.js"), /dtpl|DrawingTemplate|PartType/);
  // listPartTypes in shared paths is called only when role is rushroom.
  for (const h of app.matchAll(/API\.post\(token, "listPartTypes"/g)) {
    const before = app.slice(Math.max(0, h.index - 200), h.index);
    const inBlock = h.index > app.indexOf("// ---- Drawing Templates (docs/DRAWING_TEMPLATES.md, phase 1)");
    assert.ok(inBlock || /role === "rushroom"/.test(before), `listPartTypes at ${h.index} is not gated`);
  }
});

test("the part type select never drops a value it was given, and Save sends it only when touched", () => {
  const sel = app.slice(app.indexOf("function partTypeSelect("), app.indexOf("const categoryRequiredFor"));
  assert.match(sel, /const missing = value && !types\.some\(\(t\) => t\.id === value\)/);
  assert.match(sel, /missing \? el\("option", \{ value \}/);
  const save = app.slice(app.indexOf("const ptSel = partTypeSelect(ptInitial);"), app.indexOf("if (ptChanged && nodeData)"));
  assert.match(save, /ptSel\.addEventListener\("change", \(\) => \{ ptTouched = true; \}\)/);
  assert.match(save, /const ptChanged = ptTouched && ptSel\.value !== ptInitial;/);
  assert.match(save, /r\.refused\.length \? false : saved/, "a refused part type leaves the bar green");
});

test("the bulk bar keeps its chosen type across repaints and never assigns an untouched —", () => {
  const b = body("dtplPaintBulk");
  assert.match(b, /partTypeSelect\(dtplBulkType \|\| ""\)/);
  assert.match(b, /assign\.disabled = dtplBulkType === null;/);
  assert.match(b, /if \(dtplBulkType === null\) \{ sel\.focus\(\); return; \}/);
});

test("the reference poll backs off on a blip, idles behind another sub-tab; compare keeps the last pair", () => {
  const w = body("dtplWatchItem");
  assert.match(w, /if \(_subTab !== "drawing_templates"\)/);
  assert.match(w, /_dtplTimer = setTimeout\(tick, 6000\)/);
  const c = app.slice(app.indexOf("async function dtplCompare("), app.indexOf("async function dtplCompare(") + 1200);
  assert.match(c, /target\.__seq !== seq/);
  const stage = app.slice(app.indexOf("function drJobStage("), app.indexOf("function drShowJobStage("));
  assert.match(stage, /bands\.slice\(\)\.reverse\(\)\.find\(\(b\) => st\(b\) === "failed"\)/);
});
