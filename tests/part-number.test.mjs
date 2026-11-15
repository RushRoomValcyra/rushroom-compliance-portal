// The part number is the identifier stamped into CAD, Blender, supplier files
// and order snapshots (docs/BUILD-ROADMAP-IDENTITY.md, gaps G-1..G-3). These
// read the source so a second generator or a writable part number fails the
// build instead of surfacing as two parts with one number a year later.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const api = read("supabase/functions/portal-api/index.ts");
const app = read("assets/app.js");

test("part numbers are generated in exactly one place, on the server", () => {
  assert.equal((api.match(/`RR-\$\{/g) || []).length, 1, "portal-api builds RR- numbers in more than one place");
  assert.equal((app.match(/`RR-\$\{/g) || []).length, 0, "the browser must not invent part numbers");
  assert.equal((app.match(/function genPN/g) || []).length, 0, "a client-side generator came back");
});

test("every path that writes a part number validates its format", () => {
  const writes = (api.match(/\.insert\(\{\s*\n?\s*part_number/g) || []).length;
  const checks = (api.match(/PART_NUMBER_RE\.test\(/g) || []).length;
  assert.ok(writes >= 1, "no insert of part_number found — test needs updating");
  assert.ok(checks >= 2, `expected the format check on create and variant paths, found ${checks}`);
});

test("updateComponent never writes part_number", () => {
  const start = api.indexOf('action === "updateComponent"');
  const end = api.indexOf('action === "setComponentStatus"', start);
  assert.ok(start > 0 && end > start, "updateComponent block not found");
  const block = api.slice(start, end);
  assert.ok(!/patch\.part_number\s*=/.test(block), "updateComponent assigns patch.part_number");
  assert.ok(/cannot be changed/.test(block), "updateComponent no longer refuses a changed part number");
});

test("the component panel does not send part_number on save", () => {
  const start = app.indexOf('API.post(token, "updateComponent"');
  const block = app.slice(start, start + 600);
  assert.ok(start > 0, "panel save not found");
  assert.ok(!/part_number:\s*pnInp/.test(block), "the panel still sends the part number on save");
});
