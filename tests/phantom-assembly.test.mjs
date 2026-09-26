// Phantom assemblies (PROP-058) — static, no credentials.
//
// A phantom assembly is a grouping node: it carries structure and gives the
// storefront something stable to point at, but is never built, stocked or
// picked. Added as a TYPE, because every screen already branches on `type`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const app = read("assets/app.js");
const api = read("supabase/functions/portal-api/index.ts");

test("the database accepts the new type", () => {
  const files = readdirSync(join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  const owning = files.filter((f) => /phantom_assembly/.test(read(`supabase/migrations/${f}`)));
  assert.deepEqual(owning, ["0037_phantom_assembly_type.sql"], `expected one migration, got ${owning}`);
  const mig = read("supabase/migrations/0037_phantom_assembly_type.sql");
  const check = mig.match(/CHECK \(type IN \(([\s\S]*?)\)\)/);
  assert.ok(check, "no type CHECK in the migration");
  const values = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  // Everything that was valid before must still be valid — this rewrites the
  // constraint, so a dropped value would fail every existing row.
  assert.deepEqual(values,
    ["finished_good", "part", "phantom_assembly", "product_family", "raw_material", "spare_part", "sub_assembly"],
    "the rewritten CHECK does not preserve every existing type");
});

test("the function and the database agree on the type list", () => {
  const m = api.match(/const COMPONENT_TYPES = \[([^\]]*)\]/);
  assert.ok(m, "COMPONENT_TYPES not found in portal-api");
  const types = m[1].replace(/"/g, "").split(",").map((x) => x.trim()).filter(Boolean).sort();
  assert.deepEqual(types,
    ["finished_good", "part", "phantom_assembly", "product_family", "raw_material", "spare_part", "sub_assembly"]);
  // Declared once. Two literals drifted apart is how a type becomes creatable
  // but not editable.
  assert.equal([...api.matchAll(/const validTypes = /g)].length, 2, "unexpected number of validTypes sites");
  assert.equal([...api.matchAll(/const validTypes = COMPONENT_TYPES;/g)].length, 2,
    "a validTypes site still carries its own array literal");
});

test("a phantom needs no part category — it has no physical identity", () => {
  assert.ok(/const CATEGORYLESS_TYPES = \[[^\]]*"phantom_assembly"[^\]]*\]/.test(api),
    "the server would demand a category for a phantom");
  assert.ok(/const needsCategory = !CATEGORYLESS_TYPES\.includes\(type\)/.test(api),
    "needsCategory no longer uses the shared list");
  assert.ok(/const categoryRequiredFor = \(type\) => !ASSEMBLY_TYPES\.includes\(type\)/.test(app),
    "the UI would still demand a category for a phantom");
});

test("phantoms group with the assemblies, in every screen that groups", () => {
  assert.ok(/const ASSEMBLY_TYPES = \["sub_assembly", "phantom_assembly"\]/.test(app), "ASSEMBLY_TYPES not found");
  assert.ok(/ASSEMBLY_TYPES\.includes\(c\.type\) \? "assemblies"/.test(app), "bomTabOf does not place phantoms");
  // The Status Overview picker used to bucket "anything not sub_assembly or
  // product_family" as a Part — a new type would have fallen in there silently.
  assert.ok(/const group = all\.filter\(\(c\) => bomTabOf\(c\) === want\)/.test(app),
    "the Status Overview picker still buckets by exclusion");
  // Creating one must land you on the tab it actually went to.
  assert.ok(/activeTab = bomTabOf\(\{ type \}\)/.test(app), "after creating a phantom the list jumps to the wrong tab");
});

test("a phantom is offered when creating and editing, everywhere", () => {
  // Non-greedy to the statement's own semicolon — [^\]]* would stop at the
  // first inner array and pass while telling you nothing.
  const pickers = [...app.matchAll(/const TYPE_OPTS = \[[\s\S]*?\];/g)].map((m) => m[0]);
  assert.equal(pickers.length, 3, `expected three type pickers, found ${pickers.length}`);
  for (const p of pickers) {
    assert.ok(/\["phantom_assembly", "Phantom Assembly \(structural only\)"\]/.test(p),
      `a type picker does not offer phantom_assembly:\n${p.slice(0, 120)}`);
  }
});

test("a phantom is visibly different inside a tree", () => {
  // In a tree it otherwise looks exactly like a sub-assembly, and the
  // difference matters most precisely there.
  assert.ok(app.includes('}, "PHANTOM")'), "no PHANTOM badge on tree rows");
  assert.ok(/familyBadge, phantomBadge, condTag/.test(app), "the badge is built but never mounted");
  assert.ok(/never built or stocked/.test(app), "the badge does not explain what a phantom is");
  assert.ok(/phantom_assembly: "#0d9488"/.test(app), "the root-row type badge has no colour for phantoms");
});

test("listAssemblies keeps its old contract unless phantoms are asked for", () => {
  const fn = api.match(/if \(action === "listAssemblies"\)[\s\S]*?\n  \}/);
  assert.ok(fn, "listAssemblies not found");
  // An integration asking for "the assemblies" and acting on the answer must
  // not be handed a node that is never built.
  assert.ok(/body\.include_phantom === true/.test(fn[0]), "there is no opt-in for phantoms");
  assert.ok(/: q\.eq\("type", "sub_assembly"\)/.test(fn[0]), "the default no longer excludes phantoms");
  // Byte-identical response shape for every caller that predates PROP-058.
  assert.ok(/\{ id: a\.id, name: a\.name \}/.test(fn[0]), "the narrow id+name shape is gone");
});

test("nothing claims phantoms are flattened on explosion", () => {
  // In every other PLM a phantom is blow-through: exploding skips its level.
  // This build does NOT do that, and the gap is recorded rather than implied.
  assert.ok(!/blowThrough|blow_through|flattenPhantom/.test(app),
    "half-implemented blow-through logic is present");
  assert.ok(/blow-through/.test(read("supabase/migrations/0037_phantom_assembly_type.sql")),
    "the migration does not warn the next reader that explosion is not implemented");
  assert.ok(/blow-through/i.test(read("docs/ROADMAP.md")), "the gap is not on the roadmap");
});
