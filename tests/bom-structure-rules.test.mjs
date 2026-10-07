// BOM structure rules (PROP-067) — static, no credentials.
//
// Which parent may hold which child lives in the database (migration 0040),
// with two mirrors: the API (so the move picker only offers what the database
// accepts) and the browser (so +child routes bought items through the
// "what is this child?" dialog). Three copies of one rule drift unless
// something checks them — this file does, over every type × sourcing × link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const sql = read("supabase/migrations/0040_bom_structure_rules.sql");
// PROP-068 rewords the matrix and lifts the Hub/Site ban on In-the-box links.
const sql41 = read("supabase/migrations/0041_in_the_box.sql");
const handler = read("supabase/functions/portal-api/handlers/bom-structure.ts");
const api = read("supabase/functions/portal-api/index.ts");
const app = read("assets/app.js");
const rulesJs = read("assets/bom-structure.js");

const TYPES = ["part", "raw_material", "spare_part", "sub_assembly", "phantom_assembly", "finished_good", "product_family"];
const SOURCING = ["purchased", "manufactured", "assembled", "subcontracted"];

// The decisions, restated independently (docs/BOM_LOGIC_REVIEW.html §2, §5b).
function decided(type, mob, ref) {
  if (type === "finished_good") return false;                       // Q7
  if (ref) return mob === "purchased" && !["phantom_assembly", "product_family"].includes(type); // Q4
  if (mob === "purchased" && ["part", "raw_material", "spare_part", "sub_assembly"].includes(type)) return false; // rule 2
  if (mob === "assembled" && ["part", "raw_material", "spare_part"].includes(type)) return false; // part we put together = sub-assembly
  return true;   // incl. Manufactured / Subcontracted parts — deferred, left open
}

function browserRule() {
  const sandbox = { window: {}, document: {} };
  vm.runInNewContext(rulesJs, sandbox);
  return sandbox.window.PortalBomRules.childRule;
}

async function serverRule() {
  // The handler imports Deno-only modules; lift out the pure function alone.
  const fn = handler.match(/export function bomChildRule[\s\S]*?\n}\n/);
  assert.ok(fn, "bomChildRule not found in handlers/bom-structure.ts");
  // CI runs Node 20, which cannot load .ts. The types are only on the
  // signature line, so strip them there and load plain JavaScript.
  const [sig, ...body] = fn[0].split("\n");
  const m = sig.match(/^export function bomChildRule\(([^)]*)\)[^{]*\{$/);
  assert.ok(m, `unexpected signature: ${sig}`);
  const params = m[1].split(",").map((p) => p.split(":")[0].trim()).join(", ");
  const js = [`export function bomChildRule(${params}) {`, ...body].join("\n");
  assert.ok(!/:\s*(string|boolean|number)\b/.test(body.join("\n")), "types in the body — this stripper only handles the signature");
  const dir = mkdtempSync(join(tmpdir(), "bomrule-"));
  const file = join(dir, "rule.mjs");
  writeFileSync(file, js);
  return (await import(file)).bomChildRule;
}

test("browser and API apply the decided matrix to every combination", async () => {
  const js = browserRule();
  const ts = await serverRule();
  for (const t of TYPES) for (const m of SOURCING) for (const r of [false, true]) {
    const want = decided(t, m, r);
    assert.equal(js(t, m, r) === null, want, `browser: ${t} / ${m} / ${r ? "reference" : "fitted"}`);
    assert.equal(ts(t, m, r) === null, want, `API: ${t} / ${m} / ${r ? "reference" : "fitted"}`);
    assert.equal(js(t, m, r), ts(t, m, r), `browser and API word ${t} / ${m} differently`);
  }
});

test("the database refuses with the same four sentences", () => {
  // The latest definition of bom_child_rule is the one in force.
  const sqlMsgs = [...sql41.matchAll(/THEN '([^']+)'/g)].map((m) => m[1].replace(/''/g, "'")).sort();
  const jsMsgs = [...rulesJs.matchAll(/return "([^"]+)";/g)].map((m) => m[1]).sort();
  assert.equal(sqlMsgs.length, 4, "bom_child_rule should have four refusals");
  assert.deepEqual(sqlMsgs, jsMsgs, "SQL and browser messages differ");
  assert.ok(/WHEN p_type = 'finished_good'/.test(sql));
  assert.ok(/p_type IN \('part', 'raw_material', 'spare_part', 'sub_assembly'\)/.test(sql));
});

test("0040 adds the reference flag, both CHECKs and both triggers", () => {
  assert.ok(/ADD COLUMN IF NOT EXISTS is_reference BOOLEAN NOT NULL DEFAULT false/.test(sql));
  assert.ok(/CHECK \(NOT is_reference OR fitting_stage IS NULL\)/.test(sql), "a reference child must not carry Hub/Site");
  assert.ok(/CHECK \(type <> 'finished_good' OR make_or_buy = 'purchased'\)/.test(sql));
  assert.ok(/BEFORE INSERT OR UPDATE OF parent_id, is_reference, effective_to ON bom_edges/.test(sql),
    "the link trigger must cover insert, re-parent, re-flag and re-open");
  assert.ok(/BEFORE UPDATE OF type, make_or_buy ON bom_components/.test(sql));
  assert.ok(/IF NEW\.effective_to IS NOT NULL THEN RETURN NEW;/.test(sql), "closing a link must always be allowed");
});

test("In the box may carry Hub/Site (PROP-068)", () => {
  assert.ok(/DROP CONSTRAINT IF EXISTS bom_edges_reference_unstaged;/.test(sql41));
  assert.ok(!/ADD CONSTRAINT bom_edges_reference_unstaged/.test(sql41), "0041 must not put the ban back");
  const stage = api.match(/if \(action === "setEdgeFittingStage"\) \{[\s\S]*?\n  \}\n/)[0];
  assert.ok(!/is_reference/.test(stage), "the stage setter still refuses In-the-box links");
  assert.ok(sql41.includes("REVOKE ALL ON FUNCTION bom_child_rule(text, text, boolean) FROM PUBLIC, anon, authenticated;"));
});

test("0040 refuses to switch on over data that breaks the rule", () => {
  assert.ok(/RAISE EXCEPTION '0040: existing links break the BOM structure rules/.test(sql));
});

test("the new functions are as closed as the tables (RLS is deny-all)", () => {
  for (const fn of ["bom_wrap_in_prepared(uuid, uuid, uuid, boolean, text, uuid)", "bom_child_rule(text, text, boolean)"]) {
    assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, anon, authenticated;`), `${fn} is callable by anon`);
    assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION ${fn} TO service_role;`));
  }
  assert.ok(/WHERE id = p_part AND organization_id = p_org/.test(sql), "the wrap must be scoped to the caller's org");
});

test("addBomEdge no longer carries its own type guard", () => {
  const block = api.match(/if \(action === "addBomEdge"\) \{[\s\S]*?\n  \}\n/);
  assert.ok(block);
  assert.ok(!/Only assemblies can have children/.test(block[0]));
  assert.ok(!/ASSEMBLY_TYPES/.test(block[0]));
  assert.ok(/is_reference: is_reference === true/.test(block[0]));
});

test("is_reference survives every path that copies a link", () => {
  const move = api.match(/if \(action === "moveComponentToParent"\) \{[\s\S]*?\n  \}\n/)[0];
  assert.ok(/fitting_stage: edge\.fitting_stage \?\? null, is_reference: edge\.is_reference === true/.test(move),
    "a move must keep Hub/Site and the reference flag");
  const copy = api.match(/if \(action === "copyAssembly"\) \{[\s\S]*?\n  \}\n/)[0];
  assert.ok(/is_reference: e\.is_reference === true/.test(copy));
  const mat = api.match(/if \(action === "materialiseConfiguration"\) \{[\s\S]*?\n  \}\n/)[0];
  assert.equal((mat.match(/is_reference: e\.is_reference === true/g) || []).length, 2);
});

test("Order Operations never receives a reference child as a pick line", () => {
  assert.ok(/resolverTdb\("bom_edges"\)\.select\("parent_id, child_id, quantity"\)\.is\("effective_to", null\)\.eq\("is_reference", false\)/.test(api));
});

test("the tree reads the flag, and Sourcing is never assumed", () => {
  assert.ok(/"id, parent_id, child_id, quantity, reference_designator, variant_condition, sort_order, fitting_stage, is_reference"/.test(api));
  assert.ok(/"id, part_number, name, type, make_or_buy, category_id, unit_of_measure/.test(api), "getBom nodes need Sourcing and Category for the edit form");
  assert.ok(!/nodeData\?\.make_or_buy \|\| "purchased"/.test(app), "the edit form defaults Sourcing to Purchased again");
  assert.ok(/Choose its Sourcing: purchased, manufactured, assembled or subcontracted\./.test(api), "addComponent accepts a missing Sourcing");
});

test("the pages load the rules before app.js", () => {
  for (const page of ["index.html", "supplier.html"]) {
    const html = read(page);
    const rules = html.indexOf("assets/bom-structure.js");
    const appAt = html.indexOf("assets/app.js");
    assert.ok(rules > 0 && rules < appAt, `${page}: bom-structure.js must load before app.js`);
  }
});

// ---- Create-child safety (fix 2026-10-07) ------------------------------------
// "Create new" under L LED Profile (Part + Assembled) created the part, had the
// link refused, and a second press collided on the same part number — leaving
// an orphan and hiding the real reason behind a duplicate-key error.

test("the add-child dialog asks the rule before it writes anything", () => {
  const submit = app.slice(app.indexOf("function openAddChildModal"), app.indexOf("PROP-036 option 3"));
  const check = submit.indexOf("R.childRule(parentNode.type, parentNode.make_or_buy, isReference)");
  const create = submit.indexOf('API.post(token, "addComponent"');
  assert.ok(check > 0 && create > 0 && check < create, "the rule must be checked before the part is created");
});

test("a part created on a failed press is reused, never created twice", () => {
  assert.ok(/if \(mode === "new" && createdNew\) \{[\s\S]*?batch\[0\]\.childId = createdNew\.id;/.test(app));
  assert.ok(/createdNew = \{ id: r\.id, part_number: r\.part_number/.test(app));
  assert.ok(/part_number_key/.test(app), "a duplicate part number must read as a sentence, not a Postgres error");
});

test("a Part that says Assembled explains itself instead of opening the picker", () => {
  const sandbox = { window: {}, document: {} };
  vm.runInNewContext(rulesJs, sandbox);
  const R = sandbox.window.PortalBomRules;
  assert.equal(R.needsTypeOrSourcing({ type: "part", make_or_buy: "assembled" }), true);
  assert.equal(R.needsTypeOrSourcing({ type: "part", make_or_buy: "purchased" }), false, "a bought part has In the box");
  assert.equal(R.needsTypeOrSourcing({ type: "sub_assembly", make_or_buy: "assembled" }), false);
  assert.equal(R.needsTypeOrSourcing({ type: "finished_good", make_or_buy: "purchased" }), false, "a finished good shows no +child at all");
  assert.ok(/R\.needsTypeOrSourcing\(comp\)[\s\S]*?R\.openCannotHold\(/.test(app), "root-row +child does not route Part + Assembled to the explanation");
});
