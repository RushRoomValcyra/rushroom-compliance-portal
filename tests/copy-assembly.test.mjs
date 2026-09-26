// Copy an assembly with its structure (PROP-059) — static, no credentials.
//
// The old ⧉ copied the node and nothing else, so copying an assembly handed you
// an empty shell. Building one by hand is the slow part of this system.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const app = read("assets/app.js");
const api = read("supabase/functions/portal-api/index.ts");

/** The plan is written annotation-free so it can be run, not just read. */
const planAssemblyCopy = (() => {
  const m = api.match(/function planAssemblyCopy\(rootId, childrenOf, visited\) \{[\s\S]*?\n\}/);
  assert.ok(m, "planAssemblyCopy not found in portal-api");
  return eval(`(${m[0]})`);
})();

const plan = (rootId, kids) => {
  const visited = new Set([rootId]);
  const walk = (id) => (kids[id] || []).forEach((e) => { if (!visited.has(e.child_id)) { visited.add(e.child_id); walk(e.child_id); } });
  walk(rootId);
  const r = planAssemblyCopy(rootId, kids, visited);
  return { clones: [...r.clones].sort(), shared: [...r.shared].sort(), edges: r.edgeCount };
};

test("a node holding structure is cloned; a leaf is reused", () => {
  // Shelf → (LED shelf → inserts, profile), screw
  const r = plan("shelf", {
    shelf: [{ child_id: "led" }, { child_id: "screw" }],
    led: [{ child_id: "inserts" }, { child_id: "profile" }],
  });
  assert.deepEqual(r.clones, ["led", "shelf"], "the inner assembly was not cloned");
  assert.deepEqual(r.shared, ["inserts", "profile", "screw"], "a leaf was cloned, duplicating the registry");
  assert.equal(r.edges, 4, "every link under a cloned node must be recreated");
});

test("an assembly with only leaves clones exactly one component", () => {
  const r = plan("asm", { asm: [{ child_id: "a" }, { child_id: "b" }, { child_id: "c" }] });
  assert.deepEqual(r.clones, ["asm"]);
  assert.deepEqual(r.shared, ["a", "b", "c"]);
  assert.equal(r.edges, 3);
});

test("a leaf root still produces a usable copy", () => {
  // Copying a plain part from the list must not need a special case.
  const r = plan("screw", {});
  assert.deepEqual(r.clones, ["screw"]);
  assert.deepEqual(r.shared, []);
  assert.equal(r.edges, 0);
});

test("structure decides, not type — a `part` with children is cloned", () => {
  // "S Plinth - White" is typed part and holds two children. Deciding on type
  // would have shared it, and editing the copy would change the original.
  const r = plan("asm", { asm: [{ child_id: "plinth" }], plinth: [{ child_id: "switch" }, { child_id: "pin" }] });
  assert.ok(r.clones.includes("plinth"), "a part holding structure was shared, so editing the copy hits the original");
  assert.deepEqual(r.shared, ["pin", "switch"]);
});

test("a component used twice is cloned once and linked twice", () => {
  // asm → subA, subB; both → the same screw.
  const r = plan("asm", {
    asm: [{ child_id: "subA" }, { child_id: "subB" }],
    subA: [{ child_id: "screw" }],
    subB: [{ child_id: "screw" }],
  });
  assert.deepEqual(r.clones, ["asm", "subA", "subB"]);
  assert.deepEqual(r.shared, ["screw"], "the shared screw was duplicated");
  assert.equal(r.edges, 4, "both links to the shared part must be recreated");
});

test("edges under a reused node are not recreated", () => {
  // Only edges whose PARENT is cloned. Recreating one under a reused node
  // would duplicate the ORIGINAL's structure, not the copy's.
  const kids = { asm: [{ child_id: "leaf" }] };
  const r = planAssemblyCopy("asm", kids, new Set(["asm", "leaf", "stranger"]));
  assert.equal(r.edgeCount, 1);
  assert.ok(!r.clones.has("stranger"), "an unrelated node was pulled into the clone set");
});

test("one clone path, so a deep copy makes the same rows as the single ⧉", () => {
  // Two implementations would drift, and the one that drifted would be the
  // rarely-used one.
  assert.ok(/async function cloneComponentRow\(tdb: any, session: any, srcId: string, nameOverride\?: string\)/.test(api),
    "cloneComponentRow was not extracted");
  const dup = api.match(/if \(action === "duplicateComponent"\)[\s\S]*?\n  \}/);
  assert.ok(dup, "duplicateComponent not found");
  assert.ok(/cloneComponentRow\(tdb, session, component_id/.test(dup[0]),
    "duplicateComponent still has its own inline clone");
  assert.ok(!/part_number = `RR-/.test(dup[0]), "duplicateComponent still mints its own part number");
});

test("the copy takes only ACTIVE structure", () => {
  const fn = api.match(/if \(action === "copyAssembly"\)[\s\S]*?\n  \}\n/);
  assert.ok(fn, "copyAssembly not found");
  // A closed edge is history. Copying it would resurrect a part someone removed.
  assert.ok(/is\("effective_to", null\)/.test(fn[0]), "closed edges are copied, resurrecting removed parts");
  assert.ok(/role !== "rushroom"/.test(fn[0]), "a supplier can copy assemblies");
  // Everything that makes the link what it is has to survive the copy.
  for (const col of ["quantity", "reference_designator", "sort_order", "fitting_stage", "variant_condition"]) {
    assert.ok(new RegExp(`${col}:`).test(fn[0]), `the copied edges drop ${col}`);
  }
});

test("a runaway tree is refused rather than half-copied", () => {
  const fn = api.match(/if \(action === "copyAssembly"\)[\s\S]*?\n  \}\n/)[0];
  assert.ok(/MAX_NODES/.test(fn) && /MAX_DEPTH/.test(fn), "no bound on the walk");
  assert.ok(/more than \$\{MAX_NODES\} nodes/.test(fn), "the cap has no message a user can act on");
  // Components are written before edges; if the edges fail, say what exists.
  assert.ok(/Copied \$\{created\.length\} components, but the structure failed/.test(fn),
    "a failure after the components are written would read as if nothing happened");
});

test("a tree deeper than the limit is refused, not silently truncated", () => {
  // A node found at the depth limit has no children fetched, so it would look
  // like a leaf and be REUSED despite holding structure.
  const fn = api.match(/if \(action === "copyAssembly"\)[\s\S]*?\n  \}\n/)[0];
  assert.ok(/if \(queue\.length\) \{/.test(fn), "the walk can end with nodes unexplored and say nothing");
  assert.ok(/deeper than \$\{MAX_DEPTH\} levels/.test(fn), "the depth refusal has no message a user can act on");
  const refusal = fn.indexOf("deeper than ${MAX_DEPTH}");
  const firstWrite = fn.indexOf("cloneComponentRow");
  assert.ok(refusal < firstWrite, "the depth check runs after components have been written");
});

test("nothing is written until the user has seen what it will do", () => {
  const fn = api.match(/if \(action === "copyAssembly"\)[\s\S]*?\n  \}\n/)[0];
  const dryEnd = fn.indexOf("if (dry_run)");
  const firstWrite = fn.indexOf("cloneComponentRow");
  assert.ok(dryEnd > 0 && firstWrite > dryEnd, "the dry run happens after components are created");
  assert.ok(/dry_run: true/.test(fn), "the dry run does not identify itself in the response");
  // And the UI must use it rather than computing its own preview.
  const modal = app.match(/function copyAssemblyModal\([\s\S]*?\n  \}\n/);
  assert.ok(modal, "copyAssemblyModal not found");
  assert.ok(/"copyAssembly", \{ component_id: comp\.id, dry_run: true \}/.test(modal[0]),
    "the dialog builds its own preview, which can disagree with what the server does");
  assert.ok(/Documents, drawings and images do not/.test(modal[0]),
    "the dialog does not say what is NOT copied");
});
