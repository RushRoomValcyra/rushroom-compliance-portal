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
const css = read("assets/styles.css");
const api = read("supabase/functions/portal-api/index.ts");

/** The plan is written annotation-free so it can be run, not just read. */
const planAssemblyCopy = (() => {
  const m = api.match(/function planAssemblyCopy\(rootId, childrenOf, visited, subs\) \{[\s\S]*?\n\}/);
  assert.ok(m, "planAssemblyCopy not found in portal-api");
  return eval(`(${m[0]})`);
})();

const plan = (rootId, kids, subs = {}) => {
  // Mirrors the walk in copyAssembly: a replaced child is recorded but never
  // expanded, because whatever sits under it is not coming with the copy.
  const visited = new Set([rootId]);
  const walk = (id) => (kids[id] || []).forEach((e) => {
    if (visited.has(e.child_id)) return;
    visited.add(e.child_id);
    if (!subs[e.child_id]) walk(e.child_id);
  });
  walk(rootId);
  const r = planAssemblyCopy(rootId, kids, visited, subs);
  return { clones: [...r.clones].sort(), shared: [...r.shared].sort(), replaced: [...r.replaced].sort(), edges: r.edgeCount };
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
  const r = planAssemblyCopy("asm", kids, new Set(["asm", "leaf", "stranger"]), {});
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
  // The dry run now carries the substitutions too — the preview and the result
  // must come from the same code path, or they disagree while writing real rows.
  assert.ok(/"copyAssembly", \{\s*\n\s*component_id: comp\.id, dry_run: true,/.test(modal[0]),
    "the dialog builds its own preview, which can disagree with what the server does");
  assert.ok(/Documents, drawings and images do not/.test(modal[0]),
    "the dialog does not say what is NOT copied");
});


// ---- Substitution at copy time (PROP-060) ----------------------------------
// The S/M/L job is "copy S, but use the M panel and the M plinth". Doing the
// swap after copying would leave the S clones behind as registry litter.

test("a replaced branch is never cloned", () => {
  // asm → plinth(→ switch, pin), screw.  Replace the plinth.
  const kids = { asm: [{ child_id: "plinth" }, { child_id: "screw" }], plinth: [{ child_id: "switch" }, { child_id: "pin" }] };
  const before = plan("asm", kids);
  assert.deepEqual(before.clones, ["asm", "plinth"]);
  const after = plan("asm", kids, { plinth: "mPlinth" });
  assert.deepEqual(after.clones, ["asm"], "the replaced plinth was still cloned");
  assert.deepEqual(after.replaced, ["plinth"]);
  // And nothing under it comes along: switch and pin are not in the copy at all.
  assert.deepEqual(after.shared, ["screw"], "the replaced branch's children followed it into the copy");
  assert.equal(after.edges, 2, "asm should link to the substitute and the screw");
});

test("replacing a leaf swaps it without cloning anything extra", () => {
  const kids = { asm: [{ child_id: "sPanel" }, { child_id: "screw" }] };
  const r = plan("asm", kids, { sPanel: "mPanel" });
  assert.deepEqual(r.clones, ["asm"]);
  assert.deepEqual(r.shared, ["screw"], "the replaced panel is still being reused");
  assert.deepEqual(r.replaced, ["sPanel"]);
  assert.equal(r.edges, 2);
});

test("a part used twice is replaced in both places", () => {
  // Substitution is by component, so one choice fixes every occurrence.
  const kids = { asm: [{ child_id: "a" }, { child_id: "b" }], a: [{ child_id: "screw" }], b: [{ child_id: "screw" }] };
  const r = plan("asm", kids, { screw: "bolt" });
  assert.deepEqual(r.replaced, ["screw"]);
  assert.deepEqual(r.shared, [], "the replaced screw is still listed as reused");
  assert.equal(r.edges, 4, "both links must still be written, pointing at the substitute");
});

test("the root cannot be replaced", () => {
  // Replacing the thing you are copying is not a copy. Caught server-side
  // before anything is walked.
  const fn = api.match(/if \(action === "copyAssembly"\)[\s\S]*?\n  \}\n/)[0];
  assert.ok(/from === component_id/.test(fn), "the root can be substituted, which makes no sense");
  assert.ok(/cannot be replaced by another one/.test(fn), "no message for replacing the root");
  // And a substitute that has since been deleted must not be written.
  assert.ok(/A replacement component no longer exists/.test(fn), "replacements are not checked for existence");
  // Scoped by tdb, so an id from another tenant simply is not found.
  assert.ok(/await tdb\("bom_components"\)\.select\("id"\)\.in\("id", wanted\)/.test(fn),
    "the replacement check is not tenant-scoped");
});

test("the dialog re-plans on every swap instead of guessing", () => {
  const modal = app.match(/function copyAssemblyModal\([\s\S]*?\n  \}\n/)[0];
  assert.ok(/async function replan\(\)/.test(modal), "the preview is built once and never updated");
  assert.ok(/substitutions: Object\.fromEntries/.test(modal), "substitutions are not sent with the dry run");
  // Two sends: the preview and the real copy, both from the same map.
  assert.equal([...modal.matchAll(/substitutions: Object\.fromEntries/g)].length, 2,
    "the real copy and the preview do not both send the substitutions");
  assert.ok(/delete subs\[r\.id\]; replan\(\)/.test(modal), "a replacement cannot be undone");
  // A name the user typed must survive a re-plan.
  assert.ok(/if \(!userNamed\) \{[\s\S]*?nameInput\.value = /.test(modal), "re-planning overwrites a name the user typed");
});

test("the picker never offers the thing being replaced", () => {
  const modal = app.match(/function copyAssemblyModal\([\s\S]*?\n  \}\n/)[0];
  assert.ok(/excludeIds: \[r\.id, comp\.id\]/.test(modal),
    "the picker offers the component being replaced, or the assembly being copied");
  const picker = app.match(/function pickComponentModal\(token, opts = \{\}\)[\s\S]*?\n  \}\n/);
  assert.ok(picker, "pickComponentModal not found");
  assert.ok(/const exclude = new Set\(excludeIds\)/.test(picker[0]), "excludeIds is accepted but ignored");
  assert.ok(/filter\(\(c\) => !exclude\.has\(c\.id\)\)/.test(picker[0]), "exclusions are not applied to the list");
  // Same tabs, chips and ordering as everywhere else (PROP-052).
  for (const shared of ["BOM_TAB_DEFS", "BOM_SORT_COLS", "bomGroupByType", "bomSortComparator", "bomChip"]) {
    assert.ok(picker[0].includes(shared), `the picker does not reuse ${shared}`);
  }
});

// ---- Copying a plain part (PROP-061) ---------------------------------------
// The dialog was built for assemblies and said so over a part with nothing
// under it, listing the part itself as "copied", an empty "reused", "0 links"
// and a Replace button pointing at the thing being copied.

test("the dialog is named for what is actually being copied", () => {
  const modal = app.match(/function copyAssemblyModal\([\s\S]*?\n  \}\n/)[0];
  assert.ok(/const isAssemblyLike = !!comp\.has_children \|\| ASSEMBLY_TYPES\.includes\(comp\.type\)/.test(modal),
    "the title does not consider what the node is");
  assert.ok(/openModal\(isAssemblyLike \? "Copy assembly" : "Copy part", box\)/.test(modal),
    "the dialog still calls everything an assembly");
  // Structure OR type: a `part` holding children really is copied as an
  // assembly, and an empty sub-assembly is still one.
  assert.ok(/has_children/.test(modal) && /ASSEMBLY_TYPES/.test(modal), "only one of structure or type is considered");
});

test("a part with nothing under it gets no assembly preview", () => {
  const modal = app.match(/function copyAssemblyModal\([\s\S]*?\n  \}\n/)[0];
  assert.ok(/if \(!swap\.length && clone\.length === 1 && !share\.length && !plan\.edge_count\)/.test(modal),
    "there is no short path for a leaf");
  assert.ok(/Nothing is linked under this part/.test(modal), "the leaf case has no explanation of its own");
  // And it must stop there rather than fall through into the lists.
  const shortIdx = modal.indexOf("Nothing is linked under this part");
  const listsIdx = modal.indexOf('}, "New in the copy")');   // the heading, not a comment
  assert.ok(shortIdx < listsIdx, "the leaf message renders after the assembly lists");
  assert.ok(/return;\n      \}/.test(modal.slice(shortIdx, listsIdx)), "the leaf path does not return early");
});

test("the root is never offered a Replace button", () => {
  // Replacing the thing you are copying is not a copy; the server refuses it,
  // so the button was a dead end.
  const modal = app.match(/function copyAssemblyModal\([\s\S]*?\n  \}\n/)[0];
  assert.ok(/withReplace && r\.id !== comp\.id/.test(modal), "the root row still offers Replace");
  assert.ok(/isRoot \? null : replaceBtn\(r\)/.test(modal), "the root row in 'New in the copy' offers Replace");
});

test("an empty status panel does not render as a blank box", () => {
  // .empty/.loading/.error carry 1.25rem of padding and a dashed border.
  assert.ok(/\.empty:empty, \.loading:empty, \.error:empty \{ display: none; \}/.test(css),
    "an empty .error still draws a large dashed box");
  const modal = app.match(/function copyAssemblyModal\([\s\S]*?\n  \}\n/)[0];
  assert.ok(!/const err = el\("div", \{ class: "error"/.test(modal),
    "the dialog's inline error slot is still a full .error panel");
});

test("the copy dialog describes the result, named as it will be (2026-10-07)", () => {
  // "Copied as new components" listed the ORIGINAL's name and part number, so
  // after a Replace it was unclear what the copy would hold.
  const modal = app.match(/function copyAssemblyModal\([\s\S]*?\n  \}\n/)[0];
  assert.ok(/"Creates ", copyName\(\), " with a new part number\. "/.test(modal), "no one-line statement of what is created");
  assert.ok(/The original “\$\{comp\.name\}” is not changed\./.test(modal));
  assert.ok(/isRoot \? copyName\(\) : `\$\{r\.name\} \(copy\)`/.test(modal), "new rows show the original's name, not the copy's");
  assert.ok(/"Swapped in the copy"/.test(modal) && /"Same part in the copy"/.test(modal));
  // Swapping M for L in "Prepared M Middle Door …" suggests "Prepared L Middle Door …".
  assert.ok(/suggested\.replace\(r\.name, r\.with\.name\)/.test(modal));
});
