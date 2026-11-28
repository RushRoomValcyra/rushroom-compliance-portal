// Drawing Templates phase 1 — the pure helpers (docs/DRAWING_TEMPLATES.md
// §4.5, §5.2, §6). The pump order and its age tie-break, the sandbox title
// block, today's flat_panel v3 in words (the exact lines the Base page shows)
// and the compare lines between v1, v2 and v3.
import { test } from "node:test";
import assert from "node:assert/strict";

const R = await import(new URL("../supabase/functions/_shared/render-job-core.mjs", import.meta.url));
const S = await import(new URL("../supabase/functions/_shared/drawing-spec-core.mjs", import.meta.url));

// flat_panel v3 as the portal holds it (fusion_scripts/specs/flat_panel.yaml).
const V3 = {
  ctq: [], date: null, plan: { face_order: "bottom_up" }, group: "Auto", issue: "A", owner: "VALCYRA AB",
  pairs: [], parts: [], title: null, change: [],
  datums: { x: "min", y: "min", inside_face: "max", y_from_top_within: 0 },
  features: [], set_name: "template", template: "flat_panel",
  tolerances: {
    general: "ISO 2768-m", outline: "+0 -0.5", hole_depth: "+0.3 -0", groove_depth: "+0.3 -0",
    groove_width: "+0.2 -0", pocket_depth: "+0.3 -0", hole_position: "±0.2", edge_bore_depth: "+1 -0",
    counterbore_depth: "+0.3 -0",
  },
  designed_by: "VALCYRA",
};
const { plan: _plan, ...V1 } = V3;                       // v1 = v3 without plan
const V2 = { ...V3, plan: { face_order: "top_down" } };   // v2 = v3 with top_down

test("pickNextItem: purpose order first, then the oldest, then the id; queued only", () => {
  assert.deepEqual(R.ITEM_PUMP_ORDER, ["features", "catch", "preview", "rebase", "reference", "try"]);
  const items = [
    { id: "a", purpose: "reference", status: "queued", created_at: "2026-11-28T10:00:00Z" },
    { id: "b", purpose: "try", status: "queued", created_at: "2026-11-28T09:00:00Z" },
    { id: "c", purpose: "preview", status: "queued", created_at: "2026-11-28T11:00:00Z" },
    { id: "d", purpose: "features", status: "running", created_at: "2026-11-28T08:00:00Z" },
  ];
  assert.equal(R.pickNextItem(items).id, "c", "a preview goes before a reference and a try");
  assert.equal(R.pickNextItem(items.filter((i) => i.id !== "c")).id, "a", "a reference goes before a try, however old the try");
  const same = [
    { id: "y", purpose: "reference", status: "queued", created_at: "2026-11-28T10:00:00Z" },
    { id: "x", purpose: "reference", status: "queued", created_at: "2026-11-28T10:00:00Z" },
    { id: "w", purpose: "reference", status: "queued", created_at: "2026-11-28T10:00:01Z" },
  ];
  assert.equal(R.pickNextItem(same).id, "x", "same age: the lower id");
  assert.equal(R.pickNextItem([{ id: "z", purpose: "reference", status: "cancelled", created_at: "2026-11-28T10:00:00Z" }]), null);
  assert.equal(R.pickNextItem([]), null);
  assert.equal(R.pickNextItem(null), null);
});

test("sandboxTitleBlock: SANDBOX / S and the part's name", () => {
  assert.deepEqual(R.sandboxTitleBlock("Side Panel Left"), { drawing_number: "SANDBOX", issue: "S", title: "Side Panel Left" });
  assert.deepEqual(R.sandboxTitleBlock(null), { drawing_number: "SANDBOX", issue: "S", title: "Reference" });
  assert.deepEqual(R.sandboxTitleBlock("Side Panel Left", "B"), { drawing_number: "SANDBOX", issue: "S", title: "Side Panel Left", cad_revision: "B" });
});

test("describeTemplateBody(v3): the five lines of the Base page, exactly", () => {
  assert.deepEqual(S.describeTemplateBody(V3), {
    title_block: "Owner VALCYRA AB · Designed by VALCYRA · General tolerance ISO 2768-m",
    tolerances: "Outline +0 / −0.5 · Hole positions ±0.2 · Depth of holes in the face +0.3 / −0 · Depth of holes in an edge +1 / −0 · Pocket depth +0.3 / −0 · Groove width +0.2 / −0 · Groove depth +0.3 / −0 · Counterbore depth +0.3 / −0",
    sheets: "Face sheets bottom band first · Views and scales per part",
    edges: "Front edge as modelled · Inside face most blind holes",
    rules: [],
  });
  // No key name, no YAML word reaches a line.
  const text = Object.values(S.describeTemplateBody(V3)).flat().join(" ");
  for (const k of ["flat_panel", "face_order", "bottom_up", "hole_position", "designed_by"]) assert.ok(!text.includes(k), `${k} is shown`);
});

test("describeTemplateBody: a missing plan drops the face-sheet phrase; a missing kind is left out", () => {
  assert.equal(S.describeTemplateBody(V1).sheets, "Views and scales per part");
  const { outline: _o, ...tol } = V3.tolerances;
  assert.ok(!S.describeTemplateBody({ ...V3, tolerances: tol }).tolerances.includes("Outline"));
  assert.equal(S.describeTemplateBody({ ...V3, owner: null }).title_block, "Designed by VALCYRA · General tolerance ISO 2768-m");
});

test("diffTemplateBodies: v1→v3, v2→v3, v3→v3", () => {
  assert.deepEqual(S.diffTemplateBodies(V1, V3), ["+ Face sheets bottom band first"]);
  assert.deepEqual(S.diffTemplateBodies(V2, V3), ["Face sheets top band first → bottom band first"]);
  assert.deepEqual(S.diffTemplateBodies(V3, V3), ["No differences."]);
  assert.deepEqual(S.diffTemplateBodies(V3, V1), ["− Face sheets bottom band first"]);
});

test("diffTemplateBodies: a changed value by subject; keys outside the words are counted", () => {
  const wider = { ...V3, tolerances: { ...V3.tolerances, outline: "+0 -1" } };
  assert.deepEqual(S.diffTemplateBodies(V3, wider), ["Outline +0 / −0.5 → +0 / −1"]);
  assert.deepEqual(S.diffTemplateBodies(V3, { ...V3, unknown_key: 1 }), ["1 other settings changed"]);
  assert.deepEqual(S.diffTemplateBodies(V3, { ...V3, datums: { ...V3.datums, x: "max" } }), ["1 other settings changed"], "datums count as other settings");
  assert.deepEqual(S.diffTemplateBodies(V3, { ...V3, date: "2026-11-28", issue: "B" }), ["No differences."], "per-render facts are not settings");
});

test("diffTemplateBodies: a tolerance kind outside the described list counts as another setting", () => {
  const more = { ...V3, tolerances: { ...V3.tolerances, chamfer: "+0.2 -0" } };
  assert.deepEqual(S.diffTemplateBodies(V3, more), ["1 other settings changed"]);
  assert.deepEqual(S.diffTemplateBodies(more, more), ["No differences."]);
});

test("partTypeChange: not found, unchanged, reference refused, change", () => {
  const side = { id: "t-side", name: "Side panel" };
  assert.deepEqual(R.partTypeChange(null, "t-side", null), { kind: "refused", reason: "Part not found" });
  assert.deepEqual(R.partTypeChange({ part_type_id: "t-side" }, "t-side", side), { kind: "unchanged" });
  assert.deepEqual(R.partTypeChange({ part_type_id: null }, null, null), { kind: "unchanged" });
  assert.deepEqual(R.partTypeChange({}, null, null), { kind: "unchanged" }, "a missing column reads as none");
  assert.deepEqual(R.partTypeChange({ part_type_id: "t-side" }, "t-shelf", side), { kind: "refused", reason: "Reference of part type Side panel" });
  assert.deepEqual(R.partTypeChange({ part_type_id: "t-side" }, null, side), { kind: "refused", reason: "Reference of part type Side panel" }, "a reference cannot be cleared");
  assert.deepEqual(R.partTypeChange({ part_type_id: null }, "t-side", side), { kind: "change", from: null }, "a reference may take its own type");
  assert.deepEqual(R.partTypeChange({ part_type_id: "t-shelf" }, null, null), { kind: "change", from: "t-shelf" });
});

test("sandboxFinishCheck: STEP, template, sheets; a failed verify is a result", () => {
  const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
  const sheets = { pdf: "x/sandbox.pdf", pngs: ["x/1.png"] };
  const base = { result: { source_sha256: A, spec_sha256: B }, bodySourceSha: null, itemCadSha: A, versionSha: B, sheets };
  assert.deepEqual(R.sandboxFinishCheck(base), { source: A, verify_ok: true, verify: null });
  assert.deepEqual(R.sandboxFinishCheck({ ...base, itemCadSha: C }), { error: "STEP changed while drawing" });
  assert.deepEqual(R.sandboxFinishCheck({ ...base, result: { spec_sha256: B } }), { error: "STEP changed while drawing" }, "no source sha at all");
  assert.equal(R.sandboxFinishCheck({ ...base, result: { spec_sha256: B }, bodySourceSha: A.toUpperCase() }).source, A, "the body's source sha is the fallback");
  assert.deepEqual(R.sandboxFinishCheck({ ...base, versionSha: C }), { error: "Template changed while drawing" });
  assert.deepEqual(R.sandboxFinishCheck({ ...base, versionSha: null }), { error: "Template changed while drawing" }, "the version is gone");
  assert.equal(R.sandboxFinishCheck({ ...base, result: { source_sha256: A, spec_body_sha256: B } }).verify_ok, true, "spec_body_sha256 is accepted");
  assert.deepEqual(R.sandboxFinishCheck({ ...base, sheets: { pdf: "x.pdf", pngs: [] } }), { error: "No sheets uploaded" });
  assert.deepEqual(R.sandboxFinishCheck({ ...base, sheets: { pdf: null, pngs: ["1.png"] } }), { error: "No sheets uploaded" });
  assert.equal(R.sandboxFinishCheck({ ...base, result: { ...base.result, verify_ok: false } }).verify_ok, false);
  const reg = R.sandboxFinishCheck({ ...base, result: { ...base.result, verify: { regression: "fail" } } });
  assert.equal(reg.verify_ok, false);
  assert.deepEqual(reg.verify, { regression: "fail" });
});
