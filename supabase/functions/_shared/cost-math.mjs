/* Rushroom AB — Engineering & Compliance Platform: BOM cost arithmetic (PROP-072, PROP-073)
 *
 * Pure functions, no DOM, no network. ONE file for three users, so the numbers
 * cannot drift apart:
 *   - the browser (index.html imports it and sets window.PortalCostMath;
 *     GitHub Pages serves this folder — .nojekyll is in the repo root)
 *   - portal-api's full cost review (handlers/cost-review.ts)
 *   - portal-ai's cleaning of what the AI read from a quote
 *   - and the tests (tests/cost-math.test.mjs).
 *
 *   Landed unit cost in SEK, ex VAT =
 *       unit × rate(unit currency)
 *     + transport × rate(transport currency)
 *     + unit × rate(unit currency) × customs % / 100        (customs on the unit only)
 *
 * Roll-up follows the BOM logic already decided (docs/BOM_LOGIC_REVIEW.html):
 * only real links are followed — In-the-box children are inside their parent's
 * price — and anything with real children is the sum of them (a cost entered
 * on it is ignored; hub work is not costed yet).
 */

export const OVERHEAD_SHARE = 0.25;   // transport + customs above this share of the unit price is flagged
export const PARETO_SHARE = 0.8;
export const OVER_ESTIMATE = 0.10;   // actual above estimate by more than this is flagged

export const toSEK = (amount, cur, rates) => {
  if (cur === "SEK" || !cur) return Number(amount) || 0;
  const r = rates && rates[cur];
  return r && r.rate > 0 ? Number(amount) * r.rate : null;
};

// { unitSEK, transportSEK, customsSEK, landedSEK, missing: null | "cost" | "rate" }
export function landed(cost, rates) {
  if (!cost) return { unitSEK: 0, transportSEK: 0, customsSEK: 0, landedSEK: 0, missing: "cost" };
  const unitSEK = toSEK(cost.unit_cost, cost.unit_currency, rates);
  const transportSEK = Number(cost.transport_cost) ? toSEK(cost.transport_cost, cost.transport_currency, rates) : 0;
  if (unitSEK === null || transportSEK === null) {
    return { unitSEK: unitSEK || 0, transportSEK: transportSEK || 0, customsSEK: 0, landedSEK: 0, missing: "rate" };
  }
  const customsSEK = unitSEK * (Number(cost.customs_pct) || 0) / 100;
  return { unitSEK, transportSEK, customsSEK, landedSEK: unitSEK + transportSEK + customsSEK, missing: null };
}

// view: getCostView response. opts.overrides: { componentId: partial cost },
// opts.swaps: { componentId: { node, cost } }, opts.rates: replaces view.rates.
export function rollup(view, opts = {}) {
  const rates = opts.rates || view.rates || {};
  const overrides = opts.overrides || {}, swaps = opts.swaps || {};
  const nodes = Object.fromEntries((view.nodes || []).map((n) => [n.id, n]));
  // PROP-073: two costs per part — estimated (planning) and actual (from documents).
  const kind = opts.kind || "actual";
  const costs = Object.fromEntries((view.costs || []).filter((c) => (c.kind || "actual") === kind).map((c) => [c.component_id, c]));
  const kids = {};
  (view.edges || []).filter((e) => !e.is_reference).forEach((e) => { (kids[e.parent_id] ||= []).push(e); });

  const lines = [], groups = [];
  let seq = 0;   // tree order across groups and lines, for display
  const walk = (parentId, parentPath, parentQty, depth, onPath) => {
    for (const e of kids[parentId] || []) {
      if (onPath.has(e.child_id) || depth > 10) continue;          // the database forbids cycles; never hang
      const path = `${parentPath}/${e.child_id}`;
      const qty = parentQty * Number(e.quantity || 0);
      const swap = swaps[e.child_id];
      const node = swap ? swap.node : nodes[e.child_id];
      if (!node) continue;
      if (!swap && (kids[e.child_id] || []).length) {
        const g = { seq: seq++, path, parent_path: parentPath, component_id: node.id, part_number: node.part_number, name: node.name, type: node.type, depth, qty, edge_qty: Number(e.quantity), subtotalSEK: 0, incomplete: false };
        groups.push(g);
        walk(e.child_id, path, qty, depth + 1, new Set([...onPath, e.child_id]));
        continue;
      }
      const base = swap ? swap.cost : costs[node.id];
      const cost = overrides[node.id] ? { ...(base || { unit_cost: 0, unit_currency: "SEK", transport_cost: 0, transport_currency: "SEK", customs_pct: 0 }), ...overrides[node.id] } : base || null;
      const l = landed(cost, rates);
      lines.push({
        seq: seq++, path, parent_path: parentPath, component_id: node.id, part_number: node.part_number, name: node.name,
        depth, qty, edge_qty: Number(e.quantity), swapped_from: swap ? e.child_id : null, overridden: !!overrides[node.id],
        unit_cost: cost ? Number(cost.unit_cost) : null, unit_currency: cost ? cost.unit_currency : null,
        transport_cost: cost ? Number(cost.transport_cost) : null, transport_currency: cost ? cost.transport_currency : null,
        customs_pct: cost ? Number(cost.customs_pct) : null,
        ...l, lineSEK: l.landedSEK * qty,
      });
    }
  };
  walk(view.root_id, "", 1, 0, new Set([view.root_id]));

  // Subtotals: every line counts towards each group on its path.
  for (const g of groups) {
    const inside = lines.filter((l) => l.path.startsWith(g.path + "/"));
    g.subtotalSEK = inside.reduce((a, l) => a + l.lineSEK, 0);
    g.incomplete = inside.some((l) => l.missing);
  }
  const sum = (k) => lines.reduce((a, l) => a + l[k] * l.qty, 0);
  const total = lines.reduce((a, l) => a + l.lineSEK, 0);
  return {
    lines, groups, total,
    parts: { price: sum("unitSEK"), transport: sum("transportSEK"), customs: sum("customsSEK") },
    incomplete: lines.some((l) => l.missing),
    missing: lines.filter((l) => l.missing),
  };
}

// What a baseline line costs per unit at a given set of rates.
const landedOf = (line, rates) => landed(line.unit_cost === null || line.unit_cost === undefined ? null : line, rates).landedSEK;

// Compare the current roll-up with a stored baseline. A line's change splits
// into quantity, price and exchange rate:
//   qty   = (q1 − q0) × L(c0, r0)
//   price = q1 × (L(c1, r0) − L(c0, r0))
//   rate  = q1 × (L(c1, r1) − L(c1, r0))
// which add up to q1·L(c1,r1) − q0·L(c0,r0) exactly.
export function compare(current, currentRates, baseline) {
  const r0 = baseline.rates || {}, r1 = currentRates || {};
  const before = Object.fromEntries((baseline.lines || []).map((l) => [l.path, l]));
  const now = Object.fromEntries(current.lines.map((l) => [l.path, l]));
  const rows = [];
  for (const [path, l1] of Object.entries(now)) {
    const l0 = before[path];
    if (!l0) { rows.push({ path, status: "added", line: l1, delta: l1.lineSEK, qty: 0, price: l1.lineSEK, rate: 0 }); continue; }
    const L00 = landedOf(l0, r0), L10 = landedOf(l1, r0), L11 = landedOf(l1, r1);
    const qty = (l1.qty - l0.qty) * L00, price = l1.qty * (L10 - L00), rate = l1.qty * (L11 - L10);
    const delta = l1.lineSEK - l0.qty * L00;
    rows.push({ path, status: Math.abs(delta) < 0.005 ? "same" : "changed", line: l1, before: l0, delta, qty, price, rate });
  }
  for (const [path, l0] of Object.entries(before)) {
    if (!now[path]) { const d = -l0.qty * landedOf(l0, r0); rows.push({ path, status: "removed", line: l0, before: l0, delta: d, qty: 0, price: d, rate: 0 }); }
  }
  // One removed and one added under the same parent is a swap, not two events.
  const byParent = (status) => rows.filter((r) => r.status === status).reduce((m, r) => { (m[r.line.parent_path] ||= []).push(r); return m; }, {});
  const removed = byParent("removed"), added = byParent("added");
  for (const [parent, out] of Object.entries(removed)) {
    const ins = added[parent];
    if (out.length === 1 && ins && ins.length === 1) { ins[0].status = "swapped"; ins[0].before = out[0].before; ins[0].delta += out[0].delta; ins[0].price += out[0].price; out[0].status = "merged"; }
  }
  const shown = rows.filter((r) => r.status !== "merged");
  const sumOf = (k) => shown.reduce((a, r) => a + r[k], 0);
  return {
    rows: shown, delta: current.total - Number(baseline.total_sek || 0),
    qty: sumOf("qty"), price: sumOf("price"), rate: sumOf("rate"),
  };
}

export function opportunities(result, estimatedByPath = null) {
  const total = result.total || 0;
  const ranked = [...result.lines].filter((l) => !l.missing).sort((a, b) => b.lineSEK - a.lineSEK);
  const pareto = [];
  let acc = 0;
  for (const l of ranked) { if (total && acc >= PARETO_SHARE * total) break; pareto.push(l); acc += l.lineSEK; }
  const overhead = ranked.filter((l) => l.unitSEK > 0 && (l.transportSEK + l.customsSEK) / l.unitSEK > OVERHEAD_SHARE);
  const exposure = {};
  for (const l of ranked) {
    exposure[l.unit_currency || "SEK"] = (exposure[l.unit_currency || "SEK"] || 0) + (l.unitSEK + l.customsSEK) * l.qty;
    if (l.transportSEK) exposure[l.transport_currency || "SEK"] = (exposure[l.transport_currency || "SEK"] || 0) + l.transportSEK * l.qty;
  }
  const share = Object.fromEntries(Object.entries(exposure).map(([c, v]) => [c, total ? v / total : 0]));
  // PROP-073: where the actual landed cost runs above our estimate.
  const overEstimate = estimatedByPath ? ranked.filter((l) => {
    const e = estimatedByPath[l.path];
    return e && !e.missing && e.landedSEK > 0 && l.landedSEK > e.landedSEK * (1 + OVER_ESTIMATE);
  }) : [];
  return { pareto, paretoShare: total ? acc / total : 0, overhead, exposure: share, missing: result.missing, overEstimate };
}

// What a baseline stores: the lines as computed, with their costs and rates.
export const baselineLines = (result, estimatedByPath = null) => result.lines.map((l) => ({
  path: l.path, parent_path: l.parent_path, component_id: l.component_id, part_number: l.part_number, name: l.name,
  qty: l.qty, unit_cost: l.unit_cost, unit_currency: l.unit_currency, transport_cost: l.transport_cost,
  transport_currency: l.transport_currency, customs_pct: l.customs_pct, landedSEK: l.landedSEK, missing: l.missing,
  estimatedSEK: estimatedByPath && estimatedByPath[l.path] && !estimatedByPath[l.path].missing ? estimatedByPath[l.path].landedSEK : null,
}));

export const sek = (v) => (v === null || v === undefined || Number.isNaN(v) ? "—"
  : `${Number(v).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`);

// ---- PROP-073: Estimated vs Actual -------------------------------------------

// Both roll-ups of one view. What-if (overrides, swaps) applies to the actual
// only — the estimate is the plan being compared against.
export function estimateVsActual(view, opts = {}) {
  const actual = rollup(view, { ...opts, kind: "actual" });
  const estimated = rollup(view, { rates: opts.rates, kind: "estimated" });
  return {
    actual, estimated,
    estimatedByPath: Object.fromEntries(estimated.lines.map((l) => [l.path, l])),
    estimatedGroupByPath: Object.fromEntries(estimated.groups.map((g) => [g.path, g])),
    delta: actual.total - estimated.total,
  };
}

// The full review: every product root costed at one set of rates.
// graph = { nodes, edges, costs } for the whole organisation.
export function reviewProducts(graph, rootIds, rates) {
  const byId = Object.fromEntries((graph.nodes || []).map((n) => [n.id, n]));
  return rootIds.map((id) => {
    const { actual, estimated, estimatedByPath } = estimateVsActual({ ...graph, root_id: id, rates });
    const n = byId[id] || {};
    return {
      root_id: id, name: n.name, part_number: n.part_number,
      actual: actual.total, estimated: estimated.total,
      missing_actual: actual.missing.length, missing_estimated: estimated.missing.length,
      lines: actual.lines.length, incomplete: actual.incomplete,
      baseline_lines: baselineLines(actual, estimatedByPath),
    };
  });
}

// ---- PROP-073: cleaning what the AI read from a supplier document -------------

const CURRENCY_ALIASES = { "€": "EUR", EURO: "EUR", EUROS: "EUR", "$": "USD", US$: "USD", USD: "USD", ZL: "PLN", "ZŁ": "PLN", PLN: "PLN", KR: "SEK", SEK: "SEK", EUR: "EUR" };
export function normaliseCurrency(v) {
  const k = String(v || "").trim().toUpperCase().replace(/\.$/, "");
  return CURRENCY_ALIASES[k] || (["SEK", "EUR", "USD", "PLN"].includes(k) ? k : null);
}

// "1 234,50" · "1.234,50" · "1,234.50" · "12,5" · "€ 24" → a number. null if none.
export function parseAmount(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[^0-9.,-]/g, "");
  if (!s || !/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // whichever comes last is the decimal separator
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma > -1) {
    // a lone comma with 1–2 digits after it is decimal (Swedish/European); 3 digits is thousands
    const after = s.length - lastComma - 1;
    s = after > 0 && after <= 2 && s.indexOf(",") === lastComma ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// raw: the model's lines. candidateIds: the components it was allowed to match.
// A price per N units becomes a price per unit; anything unusable is reported,
// never silently dropped or guessed.
export function normaliseExtractedLines(raw, candidateIds) {
  const allowed = new Set(candidateIds || []);
  const lines = [], unmatched = [], rejected = [];
  for (const r of raw || []) {
    const price = parseAmount(r.unit_price);
    const per = parseAmount(r.per_quantity) || 1;
    const cur = normaliseCurrency(r.currency);
    const transport = parseAmount(r.transport_per_unit);
    const tcur = normaliseCurrency(r.transport_currency) || cur;
    const customs = parseAmount(r.customs_pct);
    const base = {
      description: String(r.description || ""), as_printed: String(r.as_printed || ""),
      evidence: String(r.evidence || ""), confidence: ["high", "medium", "low"].includes(r.confidence) ? r.confidence : "low",
      matched_by: String(r.matched_by || ""), quote_date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.quote_date || "")) ? r.quote_date : null,
    };
    if (price === null || price < 0 || !cur || per <= 0) { rejected.push({ ...base, reason: price === null ? "no readable price" : !cur ? "currency not SEK/EUR/USD/PLN" : "bad quantity basis" }); continue; }
    const line = {
      ...base,
      unit_cost: Math.round((price / per) * 10000) / 10000, unit_currency: cur, per_quantity: per,
      transport_cost: transport && transport > 0 ? transport : 0, transport_currency: tcur || cur,
      customs_pct: customs !== null && customs >= 0 && customs <= 100 ? customs : 0,
    };
    if (r.component_id && allowed.has(r.component_id)) lines.push({ ...line, component_id: r.component_id });
    else unmatched.push(line);
  }
  return { lines, unmatched, rejected };
}
