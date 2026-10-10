// BOM cost arithmetic (PROP-072) — pure, no credentials.
// assets/cost-math.js is what the cost view runs and what a baseline stores,
// so its numbers are checked here by hand-worked examples.
import { test } from "node:test";
import assert from "node:assert/strict";

// The same module the browser, portal-api and portal-ai import.
const M = await import(new URL("../supabase/functions/_shared/cost-math.mjs", import.meta.url));
// Values made inside the sandbox have the sandbox's Array prototype; strict
// deepEqual would reject them even when the contents match.
const plain = (v) => JSON.parse(JSON.stringify(v));
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`);

const RATES = { SEK: { rate: 1 }, EUR: { rate: 11.2, valid_on: "2026-10-01" }, PLN: { rate: 2.65, valid_on: "2026-10-01" }, USD: null };

test("landed cost: unit and transport in their own currencies, customs on the unit only", () => {
  const l = M.landed({ unit_cost: 24, unit_currency: "EUR", transport_cost: 3, transport_currency: "PLN", customs_pct: 4 }, RATES);
  close(l.unitSEK, 268.8, "unit");            // 24 × 11.20
  close(l.transportSEK, 7.95, "transport");    // 3 × 2.65
  close(l.customsSEK, 10.752, "customs");      // 268.80 × 4 % — not on transport
  close(l.landedSEK, 287.502, "landed");
  assert.equal(l.missing, null);
});

test("a missing cost or a missing rate is reported, never converted at 0 quietly", () => {
  assert.equal(M.landed(null, RATES).missing, "cost");
  assert.equal(M.landed({ unit_cost: 5, unit_currency: "USD", transport_cost: 0, customs_pct: 0 }, RATES).missing, "rate");
});

// L COMPLETE Drawer Set, shaped like production:
//   root ─ Prepared Drawer Set ×1 ─ Drawer Set ex Front ×2 (EUR) ─ [slides In the box]
//        │                       └ Drawer Bottom ×1 (SEK)
//        ├ Handle ×1 (no cost)
//        └ Front ×1 (PLN)
const VIEW = {
  root_id: "root", rates: RATES,
  nodes: [
    { id: "root", name: "L COMPLETE Drawer Set" }, { id: "prep", name: "Prepared Drawer Set", type: "sub_assembly" },
    { id: "set", name: "Drawer Set ex Front" }, { id: "slides", name: "Slides" }, { id: "bottom", name: "Drawer Bottom" },
    { id: "handle", name: "Handle" }, { id: "front", name: "Front" },
  ],
  edges: [
    { parent_id: "root", child_id: "prep", quantity: 1 },
    { parent_id: "prep", child_id: "set", quantity: 2 },
    { parent_id: "set", child_id: "slides", quantity: 2, is_reference: true },
    { parent_id: "prep", child_id: "bottom", quantity: 1 },
    { parent_id: "root", child_id: "handle", quantity: 1 },
    { parent_id: "root", child_id: "front", quantity: 1 },
  ],
  costs: [
    { component_id: "set", unit_cost: 24, unit_currency: "EUR", transport_cost: 3, transport_currency: "PLN", customs_pct: 4 },
    { component_id: "slides", unit_cost: 999, unit_currency: "SEK", transport_cost: 0, customs_pct: 0 },   // must be ignored
    { component_id: "bottom", unit_cost: 40, unit_currency: "SEK", transport_cost: 0, customs_pct: 0 },
    { component_id: "prep", unit_cost: 500, unit_currency: "SEK", transport_cost: 0, customs_pct: 0 },    // has real children — ignored
    { component_id: "front", unit_cost: 50, unit_currency: "PLN", transport_cost: 0, customs_pct: 0 },
  ],
};

test("roll-up: In the box is inside its parent's price, assemblies are the sum of their children", () => {
  const r = M.rollup(VIEW);
  assert.deepEqual(plain(r.lines.map((l) => l.name).sort()), ["Drawer Bottom", "Drawer Set ex Front", "Front", "Handle"]);
  close(r.lines.find((l) => l.name === "Drawer Set ex Front").lineSEK, 2 * 287.502, "drawer set ×2");
  close(r.total, 2 * 287.502 + 40 + 132.5, "total (slides and the Prepared assembly's own cost excluded)");
  const prep = r.groups.find((g) => g.component_id === "prep");
  close(prep.subtotalSEK, 2 * 287.502 + 40, "Prepared subtotal");
  assert.equal(r.incomplete, true, "the handle has no cost, so the total must say incomplete");
  assert.deepEqual(plain(r.missing.map((l) => l.name)), ["Handle"]);
});

test("what-if overrides and swaps change the result without touching the view", () => {
  const base = M.rollup(VIEW).total;
  const r = M.rollup(VIEW, {
    overrides: { handle: { unit_cost: 30, unit_currency: "SEK" } },
    swaps: { front: { node: { id: "front2", name: "Front, other supplier" }, cost: { unit_cost: 45, unit_currency: "PLN", transport_cost: 0, customs_pct: 0 } } },
  });
  close(r.total - base, 30 + (45 - 50) * 2.65, "delta");
  assert.equal(r.incomplete, false);
  assert.equal(r.lines.find((l) => l.component_id === "front2").swapped_from, "front");
  assert.equal(VIEW.costs.find((c) => c.component_id === "front").unit_cost, 50, "the view itself must not change");
});

test("comparison splits each change into quantity, price and exchange rate, and they add up", () => {
  const before = M.rollup(VIEW);
  const baseline = { rates: RATES, total_sek: before.total, lines: M.baselineLines(before) };
  const later = { ...RATES, EUR: { rate: 11.55, valid_on: "2026-10-09" } };
  const view2 = { ...VIEW, costs: VIEW.costs.map((c) => (c.component_id === "bottom" ? { ...c, unit_cost: 44 } : c)) };
  const now = M.rollup(view2, { rates: later });
  const cmp = M.compare(now, later, baseline);
  close(cmp.qty + cmp.price + cmp.rate, cmp.delta, "the three effects add up to the total change");
  close(cmp.price, 4, "bottom +4 SEK is price");
  close(cmp.rate, 2 * 24 * (11.55 - 11.2) * 1.04, "EUR move on 2 × 24 EUR incl. customs is rate");
  assert.equal(cmp.rows.find((r) => r.line.name === "Drawer Bottom").status, "changed");
});

test("one part replaced by another under the same parent reads as a swap", () => {
  const before = M.rollup(VIEW);
  const baseline = { rates: RATES, total_sek: before.total, lines: M.baselineLines(before) };
  const view2 = {
    ...VIEW,
    nodes: [...VIEW.nodes, { id: "front2", name: "Front B" }],
    edges: VIEW.edges.map((e) => (e.child_id === "front" ? { ...e, child_id: "front2" } : e)),
    costs: [...VIEW.costs, { component_id: "front2", unit_cost: 45, unit_currency: "PLN", transport_cost: 0, customs_pct: 0 }],
  };
  const cmp = M.compare(M.rollup(view2), RATES, baseline);
  const swap = cmp.rows.find((r) => r.status === "swapped");
  assert.ok(swap, "no swap detected");
  close(swap.delta, (45 - 50) * 2.65, "swap delta");
  assert.ok(!cmp.rows.some((r) => r.status === "removed" || r.status === "added"));
});

test("opportunities: the lines making 80 %, heavy transport/customs, currency exposure", () => {
  const view2 = { ...VIEW, costs: [...VIEW.costs, { component_id: "handle", unit_cost: 10, unit_currency: "SEK", transport_cost: 5, transport_currency: "SEK", customs_pct: 0 }] };
  const o = M.opportunities(M.rollup(view2));
  assert.equal(o.pareto[0].name, "Drawer Set ex Front");
  assert.ok(o.paretoShare >= M.PARETO_SHARE);
  assert.deepEqual(plain(o.overhead.map((l) => l.name)), ["Handle"], "5 SEK transport on 10 SEK is 50 %");
  close(Object.values(o.exposure).reduce((a, b) => a + b, 0), 1, "exposure shares sum to 1");
  assert.ok(o.exposure.EUR > 0.5);
});

// ---- PROP-073 -----------------------------------------------------------------

test("estimated and actual roll up separately; what-if touches only the actual", () => {
  const view = { ...VIEW, costs: [
    ...VIEW.costs,
    { component_id: "set", kind: "estimated", unit_cost: 250, unit_currency: "SEK", transport_cost: 0, customs_pct: 0 },
    { component_id: "handle", kind: "estimated", unit_cost: 20, unit_currency: "SEK", transport_cost: 0, customs_pct: 0 },
  ] };
  const ea = M.estimateVsActual(view, { overrides: { handle: { unit_cost: 30, unit_currency: "SEK" } } });
  close(ea.estimated.total, 2 * 250 + 20, "estimated total (only estimated rows count)");
  assert.equal(ea.estimated.incomplete, true, "bottom and front have no estimate");
  close(ea.actual.total, 2 * 287.502 + 40 + 132.5 + 30, "actual total with the what-if handle");
  close(ea.estimatedByPath["/prep/set"].landedSEK, 250, "estimate looked up by path");
  const o = M.opportunities(ea.actual, ea.estimatedByPath);
  assert.ok(o.overEstimate.some((l) => l.name === "Drawer Set ex Front"), "287.50 against an estimate of 250 is more than 10 % over");
  assert.ok(o.overEstimate.some((l) => l.name === "Handle"), "30 against 20");
});

test("the full review costs each product and keeps its lines with the estimate", () => {
  const graph = {
    nodes: [...VIEW.nodes, { id: "kit", name: "Kit", type: "phantom_assembly" }],
    edges: [...VIEW.edges, { parent_id: "kit", child_id: "bottom", quantity: 4 }],
    costs: [...VIEW.costs, { component_id: "bottom", kind: "estimated", unit_cost: 35, unit_currency: "SEK", transport_cost: 0, customs_pct: 0 }],
  };
  const r = M.reviewProducts(graph, ["root", "kit"], RATES);
  const one = M.rollup({ ...graph, root_id: "root", rates: RATES });
  close(r[0].actual, one.total, "a review total equals the product's own roll-up");
  close(r[1].actual, 4 * 40, "kit: 4 bottoms");
  close(r[1].estimated, 4 * 35, "kit estimate");
  assert.equal(r[1].baseline_lines[0].estimatedSEK, 35, "baseline lines carry the estimate");
  assert.equal(r[0].missing_actual, 1, "the handle has no cost");
});

test("numbers as printed on European, Swedish and US documents", () => {
  for (const [input, want] of [["1 234,50", 1234.5], ["1.234,50", 1234.5], ["1,234.50", 1234.5], ["12,5", 12.5], ["€ 24", 24], ["24.00 EUR", 24], ["1,234", 1234], ["", null], ["n/a", null]]) {
    assert.equal(M.parseAmount(input), want, input);
  }
  assert.equal(M.normaliseCurrency("€"), "EUR");
  assert.equal(M.normaliseCurrency("zł"), "PLN");
  assert.equal(M.normaliseCurrency("kr"), "SEK");
  assert.equal(M.normaliseCurrency("GBP"), null);
});

test("AI lines: price per N becomes per unit; unknown parts are unmatched, unusable ones rejected", () => {
  const out = M.normaliseExtractedLines([
    { component_id: "set", unit_price: "120,00", per_quantity: "10", currency: "€", confidence: "high", evidence: "Drawer set 120,00 EUR/10 st", quote_date: "2026-10-01" },
    { component_id: "not-in-scope", unit_price: "5", per_quantity: "", currency: "SEK", confidence: "medium" },
    { component_id: "", unit_price: "9,90", per_quantity: "1", currency: "SEK", confidence: "low" },
    { component_id: "front", unit_price: "", per_quantity: "1", currency: "PLN" },
    { component_id: "handle", unit_price: "3", per_quantity: "1", currency: "GBP" },
  ], ["set", "front", "handle"]);
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].unit_cost, 12);
  assert.equal(out.lines[0].unit_currency, "EUR");
  assert.equal(out.lines[0].quote_date, "2026-10-01");
  assert.equal(out.unmatched.length, 2, "an id outside the structure is never trusted");
  assert.deepEqual(plain(out.rejected.map((r) => r.reason)), ["no readable price", "currency not SEK/EUR/USD/PLN"]);
});

test("AI fill price: $0.012 per piece and $1.20 per 100 both give 0.012 USD per unit", () => {
  // The snapshot of 2026-10-10: "price 1 $0.012", "price 2 $1.20", MOQ 100.
  const a = M.normaliseExtractedLines([{ component_id: "pin", unit_price: "$0.012", per_quantity: "1", currency: "$", confidence: "medium" }], ["pin"]);
  const b = M.normaliseExtractedLines([{ component_id: "pin", unit_price: "1.20", per_quantity: "100", currency: "USD", confidence: "medium" }], ["pin"]);
  assert.equal(a.lines[0].unit_cost, 0.012);
  assert.equal(b.lines[0].unit_cost, 0.012);
  assert.equal(a.lines[0].unit_currency, "USD");
});
