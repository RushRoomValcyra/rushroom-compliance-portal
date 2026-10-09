// PROP-072 — BOM cost simulation: planning costs, dated rates, baselines.
// ============================================================================
// The server gathers and stores; it does no cost arithmetic. Roll-up, what-if,
// baseline comparison and opportunities live in assets/cost-math.js, so the
// numbers a user sees and the numbers a baseline stores come from one place.
//
// Rushroom role only — every action checks it. supplier.html loads the same
// app.js, and costs must never reach a supplier (or Order Operations).
import { json } from "../../_shared/http.ts";

export const COST_ACTIONS = new Set([
  "getCostView", "getComponentCost", "setComponentCost",
  "listCurrencyRates", "setCurrencyRate", "deleteCurrencyRate",
  "saveCostBaseline", "listCostBaselines", "getCostBaseline",
]);

const CURRENCIES = ["SEK", "EUR", "USD", "PLN"];
const RATE_CURRENCIES = ["EUR", "USD", "PLN"];   // SEK is always 1
const MAX_DEPTH = 10;
const MAX_BASELINE_LINES = 2000;

type Ctx = {
  role: string;
  tdb: (table: string) => any;
  uid: string | null;
};

const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const num = (v: unknown) => (v === "" || v === null || v === undefined ? NaN : Number(v));
const today = () => new Date().toISOString().slice(0, 10);

export async function handleCostAction(action: string, body: any, ctx: Ctx): Promise<Response> {
  if (ctx.role !== "rushroom") return json({ error: "Not authorised" }, 403);
  const { tdb } = ctx;

  // --- the tree, its costs and the rates — no arithmetic --------------------
  if (action === "getCostView") {
    const rootId = body.root_component_id;
    if (!rootId) return json({ error: "root_component_id required" }, 400);
    const rateDate = isDate(body.rate_date) ? body.rate_date : today();

    const nodeMap: Record<string, any> = {};
    const edges: any[] = [];
    const visited = new Set<string>();
    let frontier = [rootId];
    for (let depth = 0; frontier.length && depth <= MAX_DEPTH; depth++) {
      const ids = frontier.filter((id) => !visited.has(id));
      ids.forEach((id) => visited.add(id));
      if (!ids.length) break;
      const { data: comps, error: ce } = await tdb("bom_components")
        .select("id, part_number, name, type, make_or_buy").in("id", ids);
      if (ce) return json({ error: ce.message }, 400);
      (comps || []).forEach((c: any) => { nodeMap[c.id] = c; });
      if (depth === MAX_DEPTH) break;
      const { data: kids, error: ee } = await tdb("bom_edges")
        .select("id, parent_id, child_id, quantity, sort_order, is_reference")
        .in("parent_id", ids).is("effective_to", null)
        .order("sort_order", { ascending: true }).order("id", { ascending: true });
      if (ee) return json({ error: ee.message }, 400);
      (kids || []).forEach((e: any) => edges.push(e));
      frontier = (kids || []).map((e: any) => e.child_id);
    }
    if (!nodeMap[rootId]) return json({ error: "Component not found" }, 404);

    const ids = Object.keys(nodeMap);
    const { data: costs, error: ke } = await tdb("component_costs")
      .select("component_id, unit_cost, unit_currency, transport_cost, transport_currency, customs_pct, quoted_on, source_note, updated_at")
      .in("component_id", ids);
    if (ke) return json({ error: ke.message }, 400);

    const rates: Record<string, { rate: number; valid_on: string } | null> = { SEK: { rate: 1, valid_on: rateDate } };
    for (const cur of RATE_CURRENCIES) {
      const { data: r } = await tdb("currency_rates")
        .select("valid_on, rate_to_sek").eq("currency", cur).lte("valid_on", rateDate)
        .order("valid_on", { ascending: false }).limit(1).maybeSingle();
      rates[cur] = r ? { rate: Number(r.rate_to_sek), valid_on: r.valid_on } : null;
    }
    const { data: last } = await tdb("currency_rates")
      .select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle();

    return json({
      root_id: rootId, rate_date: rateDate,
      nodes: Object.values(nodeMap), edges, costs: costs || [], rates,
      rates_updated_on: last ? String(last.created_at).slice(0, 10) : null,
    });
  }

  // --- one component's cost, for the panel form -----------------------------
  if (action === "getComponentCost") {
    const id = body.component_id;
    if (!id) return json({ error: "component_id required" }, 400);
    const [{ data: cost, error }, { data: kids }] = await Promise.all([
      tdb("component_costs")
        .select("unit_cost, unit_currency, transport_cost, transport_currency, customs_pct, quoted_on, source_note, updated_at")
        .eq("component_id", id).maybeSingle(),
      tdb("bom_edges").select("id").eq("parent_id", id).is("effective_to", null).eq("is_reference", false).limit(1),
    ]);
    if (error) return json({ error: error.message }, 400);
    return json({ cost: cost || null, has_real_children: (kids || []).length > 0 });
  }

  if (action === "setComponentCost") {
    const id = body.component_id;
    if (!id) return json({ error: "component_id required" }, 400);
    const { data: comp } = await tdb("bom_components")
      .select("id, part_number, oem_number, name, description, type, lifecycle_status").eq("id", id).maybeSingle();
    if (!comp) return json({ error: "Component not found" }, 404);

    let note: string;
    if (body.clear === true) {
      const { error } = await tdb("component_costs").delete().eq("component_id", id);
      if (error) return json({ error: error.message }, 400);
      note = "Cost cleared";
    } else {
      const unit = num(body.unit_cost), transport = body.transport_cost === undefined ? 0 : num(body.transport_cost);
      const customs = body.customs_pct === undefined ? 0 : num(body.customs_pct);
      const uc = String(body.unit_currency || "SEK").toUpperCase(), tc = String(body.transport_currency || uc).toUpperCase();
      if (!(unit >= 0)) return json({ error: "Unit cost must be a number, 0 or more." }, 400);
      if (!(transport >= 0)) return json({ error: "Transport must be a number, 0 or more." }, 400);
      if (!(customs >= 0 && customs <= 100)) return json({ error: "Customs must be a percentage between 0 and 100." }, 400);
      if (!CURRENCIES.includes(uc) || !CURRENCIES.includes(tc)) return json({ error: `Currency must be one of ${CURRENCIES.join(", ")}.` }, 400);
      if (body.quoted_on && !isDate(body.quoted_on)) return json({ error: "Quote date must be YYYY-MM-DD." }, 400);
      const row = {
        component_id: id, unit_cost: unit, unit_currency: uc, transport_cost: transport, transport_currency: tc,
        customs_pct: customs, quoted_on: body.quoted_on || null,
        source_note: body.source_note ? String(body.source_note).slice(0, 500) : null,
        updated_at: new Date().toISOString(), updated_by: ctx.uid,
      };
      const { error } = await tdb("component_costs").upsert(row, { onConflict: "organization_id,component_id" });
      if (error) return json({ error: error.message }, 400);
      note = `Cost set to ${unit} ${uc}` + (transport ? ` + ${transport} ${tc} transport` : "") + (customs ? `, ${customs} % customs` : "");
    }
    try {
      await tdb("bom_component_history").insert({
        component_id: id, changed_at: new Date().toISOString(), changed_by: ctx.uid, change_type: "updated",
        part_number: comp.part_number, oem_number: comp.oem_number, name: comp.name,
        description: comp.description, type: comp.type, lifecycle_status: comp.lifecycle_status, notes: note,
      });
    } catch { /* non-fatal — the cost is already saved */ }
    return json({ ok: true });
  }

  // --- dated currency rates --------------------------------------------------
  if (action === "listCurrencyRates") {
    const { data, error } = await tdb("currency_rates")
      .select("id, currency, valid_on, rate_to_sek, source_note, created_at")
      .order("currency", { ascending: true }).order("valid_on", { ascending: false });
    if (error) return json({ error: error.message }, 400);
    return json({ rates: data || [] });
  }

  if (action === "setCurrencyRate") {
    const cur = String(body.currency || "").toUpperCase();
    const rate = num(body.rate_to_sek);
    if (!RATE_CURRENCIES.includes(cur)) return json({ error: `Currency must be one of ${RATE_CURRENCIES.join(", ")} (SEK is always 1).` }, 400);
    if (!isDate(body.valid_on)) return json({ error: "Date must be YYYY-MM-DD." }, 400);
    if (!(rate > 0)) return json({ error: "The rate must be a number above 0." }, 400);
    const { error } = await tdb("currency_rates").upsert({
      currency: cur, valid_on: body.valid_on, rate_to_sek: rate,
      source_note: body.source_note ? String(body.source_note).slice(0, 200) : null, created_by: ctx.uid,
    }, { onConflict: "organization_id,currency,valid_on" });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (action === "deleteCurrencyRate") {
    if (!body.id) return json({ error: "id required" }, 400);
    const { error } = await tdb("currency_rates").delete().eq("id", body.id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // --- baselines -------------------------------------------------------------
  if (action === "saveCostBaseline") {
    const { root_component_id, name, rate_date, rates, total_sek, incomplete, lines } = body;
    if (!root_component_id) return json({ error: "root_component_id required" }, 400);
    if (!name || !String(name).trim()) return json({ error: "Give the baseline a name." }, 400);
    if (!isDate(rate_date)) return json({ error: "rate_date must be YYYY-MM-DD." }, 400);
    if (!Array.isArray(lines) || lines.length > MAX_BASELINE_LINES) return json({ error: `lines must be a list of at most ${MAX_BASELINE_LINES}.` }, 400);
    if (!lines.every((l: any) => l && typeof l.path === "string" && typeof l.component_id === "string")) {
      return json({ error: "Every line needs a path and a component_id." }, 400);
    }
    if (!(Number(total_sek) >= 0)) return json({ error: "total_sek must be a number." }, 400);
    const { data, error } = await tdb("cost_baselines").insert({
      root_component_id, name: String(name).trim().slice(0, 120), rate_date,
      rates: rates || {}, total_sek: Number(total_sek), incomplete: incomplete === true, lines, created_by: ctx.uid,
    }).select("id").maybeSingle();
    if (error) return json({ error: error.message }, 400);
    return json({ id: data.id });
  }

  if (action === "listCostBaselines") {
    if (!body.root_component_id) return json({ error: "root_component_id required" }, 400);
    const { data, error } = await tdb("cost_baselines")
      .select("id, name, rate_date, total_sek, incomplete, created_at")
      .eq("root_component_id", body.root_component_id).order("created_at", { ascending: false });
    if (error) return json({ error: error.message }, 400);
    return json({ baselines: data || [] });
  }

  if (action === "getCostBaseline") {
    if (!body.id) return json({ error: "id required" }, 400);
    const { data, error } = await tdb("cost_baselines")
      .select("id, root_component_id, name, rate_date, rates, total_sek, incomplete, lines, created_at")
      .eq("id", body.id).maybeSingle();
    if (error) return json({ error: error.message }, 400);
    if (!data) return json({ error: "Baseline not found" }, 404);
    return json({ baseline: data });
  }

  return json({ error: `Unknown cost action ${action}` }, 400);
}
