// Contract guard and fixture tests for the Operations → PIM supplier article list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { supplierArticles } from "../supabase/functions/_shared/supplier-articles-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const components = [
  { id: "c1", part_number: "RR-LEG", name: "Adjustable leg", type: "part", unit_of_measure: "pcs" },
  { id: "c2", part_number: "RR-HINGE", name: "Hinge", type: "part", unit_of_measure: null },
  { id: "c3", part_number: "RR-NOSUP", name: "No supplier", type: "part", unit_of_measure: "pcs" },
  { id: "c4", part_number: "FAM-1", name: "Family", type: "product_family", unit_of_measure: "ea" },
  { id: "c5", part_number: "  ", name: "No number", type: "part", unit_of_measure: "ea" },
];

test("the action uses service auth, a strict request and the seed org, ahead of session auth", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const at = api.indexOf('action === "listSupplierArticles"');
  const end = api.indexOf("// --- everything else requires a valid token");
  assert.ok(at > 0 && at < end, "listSupplierArticles must exist and sit before session auth");
  const block = api.slice(at, api.indexOf("// --- Operations → PIM pre-assemblies", at));
  for (const fragment of ["operationsServiceRefusal(req, ", "allowedKeys", "contract_version !== 1", "makeTdb(RUSHROOM_ORG_ID)", "supplierArticles("]) {
    assert.ok(block.includes(fragment), `listSupplierArticles lacks ${fragment}`);
  }
  assert.ok(read("docs/PLANNER_MAPPINGS.md").includes('"action": "listSupplierArticles"'), "the contract is undocumented");
});

test("a price's supplier and the preferred supplier both count, merged by name ignoring case", () => {
  const [hinge, leg] = supplierArticles({
    components,
    metadata: [
      { component_id: "c1", preferred_supplier_name: "Italiana Ferramenta", supplier_part_number: " IF-77 " },
      { component_id: "c2", preferred_supplier_name: "HETTICH", supplier_part_number: null },
    ],
    costs: [
      { component_id: "c1", supplier_name: "ITALIANA FERRAMENTA", unit_cost: 0.76, unit_currency: "eur", kind: "actual" },
      { component_id: "c2", supplier_name: "Häfele", unit_cost: "12.5", unit_currency: "SEK", kind: "estimated" },
    ],
  });
  assert.deepEqual(leg, {
    pim_component_id: "c1", article_number: "RR-LEG", name: "Adjustable leg", unit: "pcs",
    suppliers: [{ supplier_id: null, name: "Italiana Ferramenta", preferred: true, supplier_article_number: "IF-77", price: { amount: 0.76, currency: "EUR", kind: "actual" } }],
  });
  assert.equal(hinge.unit, "ea");
  assert.deepEqual(hinge.suppliers.map((s) => [s.name, s.preferred, s.price?.amount ?? null]), [["HETTICH", true, null], ["Häfele", false, 12.5]]);
});

test("the price really paid wins over the estimate", () => {
  const [leg] = supplierArticles({
    components,
    costs: [
      { component_id: "c1", supplier_name: "GQK", unit_cost: 9, unit_currency: "USD", kind: "estimated" },
      { component_id: "c1", supplier_name: "gqk", unit_cost: 7, unit_currency: "USD", kind: "actual" },
    ],
  });
  assert.deepEqual(leg.suppliers, [{ supplier_id: null, name: "gqk", preferred: false, supplier_article_number: null, price: { amount: 7, currency: "USD", kind: "actual" } }]);
});

test("leaves out articles without a supplier, families and components without a number", () => {
  const list = supplierArticles({
    components,
    metadata: [{ component_id: "c4", preferred_supplier_name: "X" }, { component_id: "c5", preferred_supplier_name: "X" }],
    costs: [{ component_id: "c3", supplier_name: "  ", unit_cost: 1, unit_currency: "SEK", kind: "actual" }],
  });
  assert.deepEqual(list, []);
});

test("a part or price linked to the register is listed under the register's id and name", () => {
  const suppliers = [{ id: "s-if", name: "Italiana Ferramenta s.r.l.", aliases: [] }, { id: "s-gqk", name: "Xiamen GQK Technology", aliases: ["GQK"] }];
  const [hinge, leg] = supplierArticles({
    components,
    suppliers,
    metadata: [
      { component_id: "c1", preferred_supplier_id: "s-if", preferred_supplier_name: "Italiana Ferramenta s.r.l.", supplier_part_number: "IF-77" },
      { component_id: "c2", preferred_supplier_name: "GQK" },
    ],
    costs: [
      { component_id: "c1", supplier_id: "s-if", supplier_name: "ITALIANA FERRAMENTA s.r.l.", unit_cost: 0.76, unit_currency: "EUR", kind: "actual" },
      { component_id: "c2", supplier_name: "XIAMEN GQK Technology", unit_cost: 3, unit_currency: "USD", kind: "actual" },
    ],
  });
  assert.deepEqual(leg.suppliers, [{ supplier_id: "s-if", name: "Italiana Ferramenta s.r.l.", preferred: true, supplier_article_number: "IF-77", price: { amount: 0.76, currency: "EUR", kind: "actual" } }]);
  assert.deepEqual(hinge.suppliers.map((s) => [s.supplier_id, s.name, s.preferred, s.price?.amount ?? null]), [["s-gqk", "Xiamen GQK Technology", true, 3]]);
});
