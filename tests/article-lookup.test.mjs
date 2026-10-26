// Contract guard and fixture tests for the Operations → PIM article lookup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { exactIlikePattern, matchArticle, normaliseArticleNumber } from "../supabase/functions/_shared/article-lookup-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const components = [
  { id: "c1", part_number: "RR-LED-30W", name: "LED strip 30 W", type: "part", unit_of_measure: "pcs" },
  { id: "c2", part_number: "RR-HINGE", name: "", type: "part", unit_of_measure: null },
  { id: "c3", part_number: "FAM-WARDROBE", name: "Wardrobe family", type: "product_family", unit_of_measure: "ea" },
  { id: "c4", part_number: "PH-1", name: "Phantom", type: "phantom_assembly", unit_of_measure: "ea" },
  { id: "c5", part_number: "DUP-1", name: "Upper", type: "part", unit_of_measure: "ea" },
  { id: "c6", part_number: "dup-1", name: "Lower", type: "part", unit_of_measure: "ea" },
];

test("lookup uses service auth, a strict request and the seed org, ahead of session auth", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const at = api.indexOf('action === "lookupArticle"');
  assert.ok(at > 0, "lookupArticle action missing");
  assert.ok(at < api.indexOf("// --- everything else requires a valid token"), "lookup must sit before session auth");
  const block = api.slice(at, api.indexOf("// --- everything else requires a valid token"));
  for (const fragment of ["OPERATIONS_PIM_RESOLVER_KEY", "constantTimeSecretEqual", "allowedKeys", "contract_version !== 1", "makeTdb(RUSHROOM_ORG_ID)", "exactIlikePattern", "matchArticle"]) {
    assert.ok(block.includes(fragment), `lookupArticle lacks ${fragment}`);
  }
  const docs = read("docs/PLANNER_MAPPINGS.md");
  assert.ok(docs.includes('"action": "lookupArticle"'), "lookup contract is undocumented");
});

test("finds an article by exact number, ignoring case and spaces", () => {
  assert.deepEqual(matchArticle(components, "  rr-led-30w "), {
    status: "found",
    article: { pim_component_id: "c1", article_number: "RR-LED-30W", name: "LED strip 30 W", unit: "pcs" },
  });
});

test("falls back to the number for a missing name and to ea for a missing unit", () => {
  assert.deepEqual(matchArticle(components, "RR-HINGE").article, {
    pim_component_id: "c2", article_number: "RR-HINGE", name: "RR-HINGE", unit: "ea",
  });
});

test("never returns product families or phantom assemblies", () => {
  assert.deepEqual(matchArticle(components, "FAM-WARDROBE"), { status: "not_found" });
  assert.deepEqual(matchArticle(components, "PH-1"), { status: "not_found" });
});

test("reports an unknown, empty or partial number as not found", () => {
  assert.deepEqual(matchArticle(components, "RR-LED"), { status: "not_found" });
  assert.deepEqual(matchArticle(components, "   "), { status: "not_found" });
  assert.deepEqual(matchArticle(components, undefined), { status: "not_found" });
});

test("refuses to guess between numbers that differ only in case", () => {
  assert.deepEqual(matchArticle(components, "DUP-1"), { status: "ambiguous" });
});

test("escapes ilike wildcards so the query is an exact match", () => {
  assert.equal(exactIlikePattern(" A_B%C\\D "), "A\\_B\\%C\\\\D");
  assert.equal(normaliseArticleNumber(42), "");
});
