// PROP-073 — Full BOM cost review: every product, now, at the current rates.
// ============================================================================
// One button costs every top-level product — each assembly we build or Kit
// that sits inside nothing else — at this moment with the rates in force, and
// stores it as one dated review: a summary row per product (actual, estimated,
// what is missing) plus each product's lines as a cost_baselines row pointing
// at the review, so the cost view can compare against any past review.
//
// The arithmetic is the same file the browser uses (_shared/cost-math.mjs), so
// a review and the cost view on screen cannot disagree. The organisation's BOM
// is read in a handful of bulk queries, not one tree walk per product.
import { json } from "../../_shared/http.ts";
import { reviewProducts } from "../../_shared/cost-math.mjs";

export const COST_REVIEW_ACTIONS = new Set(["runCostReview", "listCostReviews", "getCostReview"]);

const RATE_CURRENCIES = ["EUR", "USD", "PLN"];
const PAGE = 1000;   // PostgREST returns at most 1000 rows per request

type Ctx = { role: string; tdb: (table: string) => any; uid: string | null };

// Every row of a query, a page at a time — a BOM past 1000 links must not
// be silently cut short.
async function all(build: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

export async function handleCostReviewAction(action: string, body: any, ctx: Ctx): Promise<Response> {
  if (ctx.role !== "rushroom") return json({ error: "Not authorised" }, 403);
  const { tdb } = ctx;

  if (action === "runCostReview") {
    const reviewedAt = new Date();
    const rateDate = reviewedAt.toISOString().slice(0, 10);
    let nodes, edges, costs;
    try {
      [nodes, edges, costs] = await Promise.all([
        all(() => tdb("bom_components").select("id, part_number, name, type, make_or_buy, lifecycle_status").order("id")),
        all(() => tdb("bom_edges").select("id, parent_id, child_id, quantity, sort_order, is_reference").is("effective_to", null).order("id")),
        all(() => tdb("component_costs").select("component_id, kind, unit_cost, unit_currency, transport_cost, transport_currency, customs_pct").order("id")),
      ]);
    } catch (e: any) { return json({ error: e?.message || "Could not read the BOM" }, 400); }

    const rates: Record<string, { rate: number; valid_on: string } | null> = { SEK: { rate: 1, valid_on: rateDate } };
    for (const cur of RATE_CURRENCIES) {
      const { data: r } = await tdb("currency_rates")
        .select("valid_on, rate_to_sek").eq("currency", cur).lte("valid_on", rateDate)
        .order("valid_on", { ascending: false }).limit(1).maybeSingle();
      rates[cur] = r ? { rate: Number(r.rate_to_sek), valid_on: r.valid_on } : null;
    }

    // A product: an assembly we build, or a Kit, that is inside nothing else.
    const isChild = new Set(edges.map((e: any) => e.child_id));
    const roots = nodes.filter((n: any) => !isChild.has(n.id) && n.lifecycle_status !== "replaced" && (
      n.type === "phantom_assembly" || (n.type === "sub_assembly" && n.make_or_buy !== "purchased"))).map((n: any) => n.id);
    if (!roots.length) return json({ error: "No top-level assemblies to review." }, 400);

    const products = reviewProducts({ nodes, edges, costs }, roots, rates);
    const summary = products.map(({ baseline_lines, ...p }: any) => p).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));

    const { data: review, error: re } = await tdb("cost_reviews").insert({
      reviewed_at: reviewedAt.toISOString(), rate_date: rateDate, rates, summary, created_by: ctx.uid,
    }).select("id").maybeSingle();
    if (re || !review) return json({ error: re?.message || "Could not save the review" }, 400);

    const stamp = reviewedAt.toISOString().slice(0, 16).replace("T", " ");
    const { error: be } = await tdb("cost_baselines").insert(products.map((p: any) => ({
      root_component_id: p.root_id, name: `Review ${stamp}`, rate_date: rateDate, rates,
      total_sek: p.actual, incomplete: p.incomplete, lines: p.baseline_lines, review_id: review.id, created_by: ctx.uid,
    })));
    if (be) return json({ error: `The review was saved, but its product lines were not: ${be.message}`, review_id: review.id }, 400);

    return json({ review_id: review.id, reviewed_at: reviewedAt.toISOString(), rate_date: rateDate, rates, summary });
  }

  if (action === "listCostReviews") {
    const { data, error } = await tdb("cost_reviews")
      .select("id, reviewed_at, rate_date, summary").order("reviewed_at", { ascending: false }).limit(50);
    if (error) return json({ error: error.message }, 400);
    // Totals only — the per-product detail is in getCostReview.
    return json({ reviews: (data || []).map((r: any) => ({
      id: r.id, reviewed_at: r.reviewed_at, rate_date: r.rate_date, products: (r.summary || []).length,
      actual: (r.summary || []).reduce((a: number, p: any) => a + Number(p.actual || 0), 0),
      estimated: (r.summary || []).reduce((a: number, p: any) => a + Number(p.estimated || 0), 0),
    })) });
  }

  if (action === "getCostReview") {
    if (!body.id) return json({ error: "id required" }, 400);
    const { data: review, error } = await tdb("cost_reviews")
      .select("id, reviewed_at, rate_date, rates, summary").eq("id", body.id).maybeSingle();
    if (error) return json({ error: error.message }, 400);
    if (!review) return json({ error: "Review not found" }, 404);
    // The review before it, for "since the last review" per product.
    const { data: prev } = await tdb("cost_reviews")
      .select("id, reviewed_at, summary").lt("reviewed_at", review.reviewed_at)
      .order("reviewed_at", { ascending: false }).limit(1).maybeSingle();
    return json({ review, previous: prev || null });
  }

  return json({ error: `Unknown cost review action ${action}` }, 400);
}
