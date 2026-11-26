// Pure core of the Operations → PIM supplier article list (contract v1, see
// docs/PLANNER_MAPPINGS.md): every article the BOM says is bought from a
// supplier, with the supplier's own article number and the price on file.
// Order Operations' purchase order form offers the chosen supplier's articles
// from it. No HTTP, secrets, database or tenant access.

import { ARTICLE_LOOKUP_EXCLUDED_TYPES } from "./article-lookup-core.mjs";
import { supplierForTypedName } from "./supplier-register-core.mjs";

// The price a purchase order should start from: what was really paid first,
// then the estimate. One row per kind exists (component_costs_one_per_kind).
const PRICE_ORDER = ["actual", "estimated"];

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Builds the list from bom_components, component_metadata (the preferred
 * supplier and its article number), component_costs (who each price came
 * from) and the supplier register (0066). A supplier is one entry per article
 * however it is registered: by its register id when the part or price points
 * at one (or its typed name matches a register name or alias), otherwise by
 * its typed name ignoring case, with supplier_id null. Articles without any
 * supplier are left out.
 */
export function supplierArticles({ components = [], metadata = [], costs = [], suppliers = [] }) {
  const registerById = new Map(suppliers.map((s) => [s.id, s]));
  const resolve = (id, typed) => {
    const linked = (id && registerById.get(id)) || supplierForTypedName(typed, suppliers);
    return linked ? { key: `id:${linked.id}`, id: linked.id, name: linked.name } : { key: `name:${typed.toLowerCase()}`, id: null, name: typed };
  };
  const metaOf = new Map(metadata.map((row) => [row.component_id, row]));
  const costsOf = new Map();
  for (const row of costs) {
    const list = costsOf.get(row.component_id) || [];
    list.push(row);
    costsOf.set(row.component_id, list);
  }

  const articles = [];
  for (const row of components) {
    const number = text(row.part_number);
    if (!number || ARTICLE_LOOKUP_EXCLUDED_TYPES.includes(row.type)) continue;

    const bySupplier = new Map();
    const supplierFor = (id, typed) => {
      const who = resolve(id, typed);
      if (!bySupplier.has(who.key)) bySupplier.set(who.key, { supplier_id: who.id, name: who.name, preferred: false, supplier_article_number: null, price: null });
      return bySupplier.get(who.key);
    };

    const meta = metaOf.get(row.id);
    const preferred = text(meta?.preferred_supplier_name);
    if (preferred || meta?.preferred_supplier_id) {
      const entry = supplierFor(meta.preferred_supplier_id, preferred);
      entry.preferred = true;
      entry.supplier_article_number = text(meta.supplier_part_number) || null;
    }

    const priced = [...(costsOf.get(row.id) || [])]
      .filter((cost) => (text(cost.supplier_name) || cost.supplier_id) && Number.isFinite(Number(cost.unit_cost)) && text(cost.unit_currency))
      .sort((a, b) => rank(a.kind) - rank(b.kind));
    for (const cost of priced) {
      const entry = supplierFor(cost.supplier_id, text(cost.supplier_name));
      if (entry.price) continue;
      entry.price = { amount: Number(cost.unit_cost), currency: text(cost.unit_currency).toUpperCase(), kind: PRICE_ORDER.includes(cost.kind) ? cost.kind : "estimated" };
    }

    if (!bySupplier.size) continue;
    articles.push({
      pim_component_id: row.id,
      article_number: number,
      name: text(row.name) || number,
      unit: text(row.unit_of_measure) || "ea",
      suppliers: [...bySupplier.values()].sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.name.localeCompare(b.name)),
    });
  }
  return articles.sort((a, b) => a.article_number.localeCompare(b.article_number));
}

function rank(kind) {
  const at = PRICE_ORDER.indexOf(kind);
  return at === -1 ? PRICE_ORDER.length : at;
}
