// PROP-073 — Read supplier costs from a quote, price list or invoice.
// ============================================================================
// One document → many parts. The parts the AI may match are the bought items
// of the structure the user is standing in (or the one part whose panel is
// open); it returns, per document line, the matched part (or none), the price
// as printed, the quantity basis, currency, transport and customs when the
// document states them (transport as a % of the unit price), the quote date, a verbatim evidence quote and
// a confidence. Nothing is written here — the user reviews every line and
// saves what is right (portal-api setComponentCosts).
//
// The same rule as AI fill: extract what the document states, never infer.
// Cleaning (decimal commas, "per 10 pcs", currency symbols) is done by the
// shared cost-math.mjs, so what the user approves is exactly what is saved.
import { json } from "../../_shared/http.ts";
import { normaliseExtractedLines } from "../../_shared/cost-math.mjs";

type Ctx = {
  role: string;
  tdb: (table: string) => any;
  db: any;
  apiKey: string;
  model: string;
  docBucket: string;
  fileBlock: (bucket: string, path: string, fileName: string) => Promise<any>;
  meterAi: (apiJson: any) => Promise<void>;
};

const MAX_CANDIDATES = 300;

// The bought items under a structure: leaves of its real links (In the box is
// inside its parent's price, so it is not a candidate of its own).
async function candidatesUnder(tdb: Ctx["tdb"], scopeId: string): Promise<string[]> {
  const leaves = new Set<string>();
  let frontier = [scopeId];
  const seen = new Set<string>();
  for (let depth = 0; frontier.length && depth <= 10; depth++) {
    const ids = frontier.filter((id) => !seen.has(id));
    ids.forEach((id) => seen.add(id));
    if (!ids.length) break;
    const { data: kids } = await tdb("bom_edges").select("parent_id, child_id")
      .in("parent_id", ids).is("effective_to", null).eq("is_reference", false);
    const hasKids = new Set((kids || []).map((e: any) => e.parent_id));
    ids.forEach((id) => { if (!hasKids.has(id)) leaves.add(id); });
    frontier = (kids || []).map((e: any) => e.child_id);
  }
  return [...leaves].slice(0, MAX_CANDIDATES);
}

export async function extractCostsFromDocument(body: any, ctx: Ctx): Promise<Response> {
  if (ctx.role !== "rushroom") return json({ error: "Not authorised" }, 403);
  if (!ctx.apiKey) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY in the function secrets." }, 400);
  const { scope_component_id, storage_path, file_name } = body;
  if (!scope_component_id || !storage_path || !file_name) return json({ error: "scope_component_id, storage_path and file_name required" }, 400);

  const ids = await candidatesUnder(ctx.tdb, scope_component_id);
  if (!ids.length) return json({ error: "Nothing to price under this component." }, 400);
  const [{ data: comps }, { data: metas }] = await Promise.all([
    ctx.tdb("bom_components").select("id, part_number, oem_number, name").in("id", ids),
    ctx.tdb("component_metadata").select("component_id, supplier_part_number, manufacturer_part_number, preferred_supplier_name").in("component_id", ids),
  ]);
  const meta = Object.fromEntries((metas || []).map((m: any) => [m.component_id, m]));
  const candidates = (comps || []).map((c: any) => ({
    id: c.id, part_number: c.part_number, name: c.name, oem_number: c.oem_number || "",
    supplier_part_number: meta[c.id]?.supplier_part_number || "", manufacturer_part_number: meta[c.id]?.manufacturer_part_number || "",
    supplier: meta[c.id]?.preferred_supplier_name || "",
  }));

  const source = await ctx.fileBlock(ctx.docBucket, String(storage_path), String(file_name));
  if (source.type === "text" && /^\(could not/.test(source.text)) return json({ error: "The file could not be read." }, 400);

  const system = `You are reading a supplier document — a quote, price list, order confirmation or invoice — and extracting purchase prices for parts we buy.

Our parts that may appear in it (match document lines to these; use the id exactly):
${candidates.map((c) => `- id ${c.id} · our part no ${c.part_number} · "${c.name}"${c.oem_number ? ` · OEM ${c.oem_number}` : ""}${c.supplier_part_number ? ` · supplier part no ${c.supplier_part_number}` : ""}${c.manufacturer_part_number ? ` · manufacturer part no ${c.manufacturer_part_number}` : ""}${c.supplier ? ` · usual supplier ${c.supplier}` : ""}`).join("\n")}

Rules that matter more than coverage:
- Extract ONLY what the document states. Never infer a price, a currency, a discount, freight or customs from general knowledge. An omitted value is correct; a guessed one is a defect.
- One output line per priced line in the document. Match it to one of our parts only when the document clearly identifies it (part number, supplier part number, OEM number, or an unambiguous name). Otherwise component_id is "" and matched_by is "none" — the user will match it.
- unit_price is the net price as printed for the quantity basis in per_quantity ("120,00" for "120,00 EUR / 10 pcs" with per_quantity "10"). Use the net price after line discounts when the document shows both, and say so in as_printed.
- Prices are ex VAT. If only a VAT-inclusive price is shown, give it and set confidence "low".
- currency: SEK, EUR, USD or PLN as printed (symbols are fine). Use the document's currency when a line has none.
- Transport: transport_pct when the document states freight as a percentage; transport_per_unit (+ transport_currency) only when it states freight PER UNIT for that line — we convert it to a % of the unit price. Otherwise both are "". Freight per shipment or order goes in freight_note AND also fill freight_amount (the total freight as a number string), freight_currency, and total_order_value (total goods value before freight, as a number string in the same currency). We compute freight_pct = freight_amount / total_order_value and apply it to all lines. customs_pct only when stated.
- quote_date as YYYY-MM-DD: the document's quote/offer/invoice date, unless a line states its own.
- evidence: a short verbatim quote of the line. confidence: "high" only when part and price are unambiguous; "medium" when the wording is loose; "low" when the unit, basis or match is uncertain.`;

  const SCHEMA = {
    type: "object",
    properties: {
      supplier: { type: "string" },
      document_type: { type: "string", enum: ["quote", "price_list", "order_confirmation", "invoice", "other"] },
      document_date: { type: "string" },
      currency: { type: "string" },
      freight_note: { type: "string" },
      freight_amount: { type: "string" },
      freight_currency: { type: "string" },
      total_order_value: { type: "string" },
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            component_id: { type: "string", enum: ["", ...candidates.map((c) => c.id)] },
            matched_by: { type: "string", enum: ["part_number", "supplier_part_number", "oem_number", "manufacturer_part_number", "name", "none"] },
            description: { type: "string" },
            as_printed: { type: "string" },
            unit_price: { type: "string" },
            per_quantity: { type: "string" },
            currency: { type: "string" },
            transport_pct: { type: "string" },
            transport_per_unit: { type: "string" },
            transport_currency: { type: "string" },
            customs_pct: { type: "string" },
            quote_date: { type: "string" },
            evidence: { type: "string" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["component_id", "matched_by", "description", "as_printed", "unit_price", "per_quantity", "currency",
            "transport_pct", "transport_per_unit", "transport_currency", "customs_pct", "quote_date", "evidence", "confidence"],
          additionalProperties: false,
        },
      },
      notes: { type: "string" },
    },
    required: ["supplier", "document_type", "document_date", "currency", "freight_note", "freight_amount", "freight_currency", "total_order_value", "lines", "notes"],
    additionalProperties: false,
  };

  let apiJson: any;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ctx.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: ctx.model,
        max_tokens: 16000,   // ~100 lines of JSON plus thinking, under the non-streaming timeout
        thinking: { type: "adaptive" },
        output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
        system,
        messages: [{ role: "user", content: [source, { type: "text", text: "Extract every priced line in this document." }] }],
      }),
    });
    apiJson = await res.json();
    if (!res.ok) return json({ error: apiJson?.error?.message || "AI request failed" }, 400);
  } catch (e: any) {
    return json({ error: `AI request failed: ${e?.message || e}` }, 400);
  }
  await ctx.meterAi(apiJson);
  if (apiJson.stop_reason === "refusal") return json({ error: "The AI declined to read this document." }, 400);
  if (apiJson.stop_reason === "max_tokens") return json({ error: "The document has more lines than one read can return — split it (e.g. by page) and read each part." }, 400);

  let parsed: any;
  try {
    const txt = (apiJson.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    parsed = JSON.parse(txt);
  } catch {
    return json({ error: "AI returned an unreadable response." }, 400);
  }

  // Lines without their own date take the document's.
  const docDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed.document_date || "") ? parsed.document_date : null;
  const raw = (parsed.lines || []).map((l: any) => ({ ...l, quote_date: l.quote_date || docDate, currency: l.currency || parsed.currency }));
  let { lines, unmatched, rejected } = normaliseExtractedLines(raw, candidates.map((c) => c.id));

  // When freight is per-shipment, compute freight % and pre-fill lines without one.
  const fa = Number(parsed.freight_amount || "");
  const rawLinesTotal = (parsed.lines || []).reduce((sum: number, l: any) => {
    const p = Number(String(l.unit_price || "").replace(",", "."));
    const qty = Math.max(1, Number(String(l.per_quantity || "1").replace(",", ".")) || 1);
    return sum + (isNaN(p) ? 0 : p * qty);
  }, 0);
  const tov = Number(parsed.total_order_value || "") || rawLinesTotal;
  const fc = (parsed.freight_currency || parsed.currency || "").toUpperCase();
  const dc = (parsed.currency || "").toUpperCase();
  const freightPctComputed = (fa > 0 && tov > 0 && (fc === dc || !parsed.freight_currency))
    ? Math.round((fa / tov) * 10000) / 100
    : null;
  if (freightPctComputed !== null) {
    lines = lines.map((l: any) => (!l.transport_pct ? { ...l, transport_pct: freightPctComputed } : l));
    unmatched = (unmatched as any[]).map((l: any) => (!l.transport_pct ? { ...l, transport_pct: freightPctComputed } : l));
  }

  const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));
  return json({
    supplier: parsed.supplier || "", document_type: parsed.document_type || "other", document_date: docDate,
    freight_note: parsed.freight_note || "", freight_pct_computed: freightPctComputed, notes: parsed.notes || "",
    lines: lines.map((l: any) => ({ ...l, part_number: byId[l.component_id]?.part_number, name: byId[l.component_id]?.name })),
    unmatched, rejected,
    candidates: candidates.map((c) => ({ id: c.id, part_number: c.part_number, name: c.name })),
  });
}
