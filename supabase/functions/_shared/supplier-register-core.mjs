// Pure core of the supplier register (0066): checking a supplier's fields,
// linking a typed name to the register, and the list of typed names an admin
// still has to link. No HTTP, secrets, database or tenant access.

export const ORDERING_METHODS = ["email", "web_shop", "other"];

const text = (value) => (typeof value === "string" ? value.trim() : "");

// Company forms dropped from the end of a name when comparing, as words after
// punctuation is gone. Same list as Order Operations' supplier-articles.ts.
const COMPANY_FORMS = [
  "s r l", "srl", "s p a", "spa", "sp z o o", "gmbh", "co kg", "kg", "ag", "ab", "aps", "as", "oy", "bv", "nv",
  "ltd", "limited", "llc", "inc", "co", "co ltd", "corp", "sa", "sl", "sas", "sarl", "oü",
];

/** A supplier name reduced for comparing: "ITALIANA FERRAMENTA s.r.l." → "italiana ferramenta". */
export function supplierNameKey(name) {
  let key = text(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const form of COMPANY_FORMS) {
      if (key.endsWith(` ${form}`)) {
        key = key.slice(0, -form.length - 1).trim();
        changed = true;
      }
    }
  }
  return key;
}

/**
 * The register entry a typed name belongs to: its name or one of its aliases
 * reduces to the same key. Only an exact key match links on its own; "GQK" and
 * "Xiamen GQK Technology" are linked by a person. Null when nothing or more
 * than one supplier matches.
 */
export function supplierForTypedName(name, suppliers = []) {
  const key = supplierNameKey(name);
  if (!key) return null;
  const hits = suppliers.filter((s) => [s.name, ...(s.aliases || [])].some((n) => supplierNameKey(n) === key));
  return hits.length === 1 ? hits[0] : null;
}

/** "SHENZHEN KEDIYA TECHNOLOGY CO., LTD" → "Shenzhen Kediya Technology Co., Ltd". Mixed case is left alone. */
export function tidySupplierName(name) {
  const raw = text(name).replace(/\s+/g, " ");
  const letters = raw.replace(/[^\p{L}]/gu, "");
  if (!letters || letters !== letters.toLocaleUpperCase("sv")) return raw;
  return raw.toLocaleLowerCase("sv").replace(/(^|[\s(/-])(\p{L})/gu, (_m, pre, ch) => pre + ch.toLocaleUpperCase("sv"));
}

/**
 * Checks a save from the Suppliers tab. Only keys present in `body` are in the
 * patch, so an edit that leaves a field out keeps it. Returns { patch } or
 * { error } with a sentence for the person.
 */
export function supplierPatch(body = {}) {
  const patch = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const opt = (key, max) => {
    if (!has(key)) return;
    const value = text(body[key] ?? "").slice(0, max);
    patch[key] = value || null;
  };

  if (has("name") || !body.id) {
    const name = text(body.name).replace(/\s+/g, " ").slice(0, 160);
    if (!name) return { error: "Name required" };
    patch.name = name;
  }
  opt("contact_name", 160);
  opt("notes", 2000);
  opt("phone", 24);
  opt("org_number", 40);
  if (patch.phone && !/^\+?[0-9 ()-]{6,24}$/.test(patch.phone)) return { error: "Enter the phone number with digits only, for example +46 8 123 45 67." };
  if (patch.org_number && patch.org_number.length < 4) return { error: "The organisation number is too short." };

  for (const key of ["contact_email", "order_email"]) {
    if (!has(key)) continue;
    const value = text(body[key] ?? "").toLowerCase().slice(0, 254);
    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { error: key === "order_email" ? "Enter a valid order email." : "Enter a valid contact email." };
    patch[key] = value || null;
  }
  if (has("web_shop_url")) {
    const value = text(body.web_shop_url ?? "");
    if (value && !/^https:\/\/\S+$/.test(value)) return { error: "The web shop address must start with https://" };
    patch.web_shop_url = value || null;
  }
  if (has("country")) {
    const value = text(body.country ?? "").toUpperCase();
    if (value && !/^[A-Z]{2}$/.test(value)) return { error: "Country is a two-letter code, for example SE or IT." };
    patch.country = value || null;
  }
  if (has("currency")) {
    const value = text(body.currency ?? "").toUpperCase();
    if (value && !/^[A-Z]{3}$/.test(value)) return { error: "Currency is a three-letter code, for example SEK or EUR." };
    patch.currency = value || null;
  }
  if (has("ordering_method")) {
    const value = text(body.ordering_method ?? "");
    if (value && !ORDERING_METHODS.includes(value)) return { error: "Invalid ordering method" };
    patch.ordering_method = value || null;
  }
  for (const [key, max] of [["lead_time_days", 365], ["payment_terms_days", 180]]) {
    if (!has(key)) continue;
    const raw = body[key];
    if (raw === null || raw === undefined || text(String(raw)) === "") { patch[key] = null; continue; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > max) return { error: `${key === "lead_time_days" ? "Lead time" : "Payment terms"} must be whole days from 0 to ${max}.` };
    patch[key] = n;
  }
  if (has("status")) {
    if (!["active", "inactive"].includes(String(body.status))) return { error: "Invalid status" };
    patch.status = String(body.status);
  }
  return { patch };
}

/** The address an order needs, when the method is set: an email or a web shop. */
export function orderingAddressMissing(supplier) {
  if (supplier.ordering_method === "email" && !supplier.order_email) return "Ordering by email needs an order email.";
  if (supplier.ordering_method === "web_shop" && !supplier.web_shop_url) return "Ordering in a web shop needs its address.";
  return null;
}

/**
 * The typed names not linked to the register yet, one row per name as
 * typed, with where it is used and a suggestion: the register entry its key
 * matches, or a tidied name for a new supplier, with the currency when all its
 * prices share one.
 */
export function typedSupplierNames({ metadata = [], costs = [], suppliers = [] }) {
  const byName = new Map();
  const entry = (name) => {
    if (!byName.has(name)) byName.set(name, { name, parts: new Set(), prices: 0, currencies: new Set() });
    return byName.get(name);
  };
  for (const row of metadata) {
    const name = text(row.preferred_supplier_name);
    if (!name || row.preferred_supplier_id) continue;
    entry(name).parts.add(row.component_id);
  }
  for (const row of costs) {
    const name = text(row.supplier_name);
    if (!name || row.supplier_id) continue;
    const e = entry(name);
    e.prices += 1;
    e.parts.add(row.component_id);
    if (text(row.unit_currency)) e.currencies.add(text(row.unit_currency).toUpperCase());
  }
  return [...byName.values()]
    .map((e) => {
      const match = supplierForTypedName(e.name, suppliers);
      return {
        name: e.name,
        parts: e.parts.size,
        prices: e.prices,
        suggested_supplier_id: match?.id ?? null,
        suggested_name: match ? match.name : tidySupplierName(e.name),
        suggested_currency: e.currencies.size === 1 ? [...e.currencies][0] : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

/** One supplier as Order Operations reads it (listSupplierRegister, contract v1). */
export function supplierForOperations(s) {
  return {
    id: s.id,
    name: s.name,
    active: s.status !== "inactive",
    org_number: s.org_number ?? null,
    country: s.country ?? null,
    currency: s.currency ?? null,
    ordering_method: s.ordering_method ?? null,
    order_email: s.order_email ?? null,
    web_shop_url: s.web_shop_url ?? null,
    contact_name: s.contact_name ?? null,
    contact_email: s.contact_email ?? null,
    phone: s.phone ?? null,
    lead_time_days: s.lead_time_days ?? null,
    payment_terms_days: s.payment_terms_days ?? null,
    notes: s.notes ?? null,
  };
}
