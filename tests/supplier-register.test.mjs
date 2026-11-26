// The one supplier register (0066): checks, linking typed names, the list an
// admin links, and the contract Order Operations reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  orderingAddressMissing, supplierForOperations, supplierForTypedName, supplierNameKey, supplierPatch, tidySupplierName, typedSupplierNames,
} from "../supabase/functions/_shared/supplier-register-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("names compare without case, accents, punctuation or company forms", () => {
  assert.equal(supplierNameKey("ITALIANA FERRAMENTA s.r.l."), "italiana ferramenta");
  assert.equal(supplierNameKey("SHENZHEN KEDIYA TECHNOLOGY CO., LTD"), "shenzhen kediya technology");
  assert.equal(supplierNameKey("HÄFELE"), "hafele");
  assert.equal(supplierNameKey("Postęp sp. z o.o."), "postep");
});

test("a typed name links itself only to exactly one supplier, by name or alias", () => {
  const register = [
    { id: "a", name: "Italiana Ferramenta s.r.l.", aliases: [] },
    { id: "b", name: "Xiamen GQK Technology", aliases: ["GQK"] },
    { id: "c", name: "Hettich", aliases: [] },
  ];
  assert.equal(supplierForTypedName("ITALIANA FERRAMENTA", register)?.id, "a");
  assert.equal(supplierForTypedName("gqk", register)?.id, "b");
  assert.equal(supplierForTypedName("HETTICH", register)?.id, "c");
  assert.equal(supplierForTypedName("Hettich Sverige", register), null, "a longer name is linked by a person");
  assert.equal(supplierForTypedName("", register), null);
  assert.equal(supplierForTypedName("Same", [{ id: "x", name: "Same AB" }, { id: "y", name: "SAME" }]), null, "two matches link nothing");
});

test("all-caps names are tidied for a new supplier; mixed case is kept", () => {
  assert.equal(tidySupplierName("SHENZHEN KEDIYA TECHNOLOGY CO., LTD"), "Shenzhen Kediya Technology Co., Ltd");
  assert.equal(tidySupplierName("HÄFELE"), "Häfele");
  assert.equal(tidySupplierName("ITALIANA FERRAMENTA s.r.l."), "ITALIANA FERRAMENTA s.r.l.");
  assert.equal(tidySupplierName("Xiamen GQK Technology"), "Xiamen GQK Technology");
});

test("a save is checked field by field, and only the fields sent change", () => {
  assert.deepEqual(supplierPatch({ name: "  Häfele  ", currency: "sek", country: "se" }).patch, { name: "Häfele", currency: "SEK", country: "SE" });
  assert.deepEqual(supplierPatch({ id: "x", lead_time_days: "14" }).patch, { lead_time_days: 14 });
  assert.match(supplierPatch({}).error, /Name/);
  assert.match(supplierPatch({ name: "X", currency: "kronor" }).error, /three-letter/);
  assert.match(supplierPatch({ name: "X", web_shop_url: "http://shop" }).error, /https/);
  assert.match(supplierPatch({ name: "X", order_email: "nope" }).error, /order email/);
  assert.match(supplierPatch({ name: "X", lead_time_days: 400 }).error, /Lead time/);
  assert.match(supplierPatch({ name: "X", ordering_method: "fax" }).error, /ordering method/);
  assert.equal(orderingAddressMissing({ ordering_method: "email" }), "Ordering by email needs an order email.");
  assert.equal(orderingAddressMissing({ ordering_method: "web_shop", web_shop_url: "https://a.b" }), null);
  assert.equal(orderingAddressMissing({ ordering_method: null }), null);
});

test("typed names not yet linked are listed once each, with a suggestion", () => {
  const names = typedSupplierNames({
    suppliers: [{ id: "h", name: "Hettich", aliases: [] }],
    metadata: [
      { component_id: "c1", preferred_supplier_name: "HETTICH" },
      { component_id: "c2", preferred_supplier_name: "HETTICH" },
      { component_id: "c3", preferred_supplier_name: "Linked", preferred_supplier_id: "z" },
    ],
    costs: [
      { component_id: "c4", supplier_name: "DONGUAN FENGZHAN ELECTRONIC", unit_currency: "SEK" },
      { component_id: "c5", supplier_name: "DONGUAN FENGZHAN ELECTRONIC", unit_currency: "usd" },
      { component_id: "c6", supplier_name: "XIAMEN GQK Technology", unit_currency: "USD" },
      { component_id: "c7", supplier_name: "Linked", supplier_id: "z", unit_currency: "USD" },
    ],
  });
  assert.deepEqual(names, [
    { name: "DONGUAN FENGZHAN ELECTRONIC", parts: 2, prices: 2, suggested_supplier_id: null, suggested_name: "Donguan Fengzhan Electronic", suggested_currency: null },
    { name: "HETTICH", parts: 2, prices: 0, suggested_supplier_id: "h", suggested_name: "Hettich", suggested_currency: null },
    { name: "XIAMEN GQK Technology", parts: 1, prices: 1, suggested_supplier_id: null, suggested_name: "XIAMEN GQK Technology", suggested_currency: "USD" },
  ]);
});

test("Order Operations gets every field it needs and nothing else", () => {
  const row = supplierForOperations({ id: "s", name: "Häfele", status: "inactive", currency: "SEK", aliases: ["HÄFELE"], created_by: "u", ordering_method: "web_shop", web_shop_url: "https://www.hafele.se" });
  assert.equal(row.active, false);
  assert.equal(row.ordering_method, "web_shop");
  assert.ok(!("aliases" in row) && !("created_by" in row) && !("status" in row));
  assert.deepEqual(Object.keys(row), ["id", "name", "active", "org_number", "country", "currency", "ordering_method", "order_email", "web_shop_url",
    "contact_name", "contact_email", "phone", "lead_time_days", "payment_terms_days", "notes"]);
});

test("listSupplierRegister uses service auth, a strict request and the seed org, ahead of session auth", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const at = api.indexOf('action === "listSupplierRegister"');
  const end = api.indexOf("// --- everything else requires a valid token");
  assert.ok(at > 0 && at < end, "listSupplierRegister must exist and sit before session auth");
  const block = api.slice(at, api.indexOf("// --- Operations → PIM pre-assemblies", at));
  for (const fragment of ["operationsServiceRefusal(req, ", "allowedKeys", "contract_version !== 1", "makeTdb(RUSHROOM_ORG_ID)", "supplierForOperations"]) {
    assert.ok(block.includes(fragment), `listSupplierRegister lacks ${fragment}`);
  }
  assert.ok(read("docs/PLANNER_MAPPINGS.md").includes('"action": "listSupplierRegister"'), "the contract is undocumented");
});

test("parts and prices pick the supplier from the register; typed saves link by name or alias", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const meta = api.slice(api.indexOf('action === "upsertComponentMetadata"'), api.indexOf('action === "listComponentThumbnails"'));
  assert.ok(meta.includes("payload.preferred_supplier_id = sup.id") && meta.includes("supplierForTypedName(typed"), "the part's supplier is not linked");
  const costs = read("supabase/functions/portal-api/handlers/costs.ts");
  assert.ok(/supplierForTypedName\(typed, register/.test(costs), "a typed price supplier is not linked");
  assert.ok(read("assets/app.js").includes("PortalSupplierPicker.create({ token, supplierId: meta.preferred_supplier_id"), "the part form still types the supplier");
  assert.ok(read("index.html").includes("assets/supplier-picker.js?v="), "the picker is not loaded");
  for (const action of ["listSupplierOptions", "addSupplier", "listTypedSupplierNames", "linkTypedSupplierName"]) {
    assert.ok(api.includes(`action === "${action}"`), `${action} is missing`);
  }
  const m = read("supabase/migrations/0066_supplier_register.sql");
  for (const col of ["preferred_supplier_id", "supplier_id", "aliases", "ordering_method", "currency", "lead_time_days", "payment_terms_days"]) {
    assert.ok(m.includes(col), `0066 lacks ${col}`);
  }
});
