// PROP-075 — AI-suggested planner key → BOM component mappings.
// ============================================================================
// Reads all unmapped catalog entries, all active mappings (as reference
// patterns) and all BOM components, then asks Claude (haiku) to suggest a
// target for each unmapped key. Returns suggestions with confidence and
// reasoning; nothing is written here — the user reviews and approves in the
// VALCYRA Studio BOM Link tab before anything is saved.
import { json } from "../../_shared/http.ts";

type Ctx = {
  role: string;
  tdb: (table: string) => any;
  apiKey: string;
  model: string;
  meterAi: (aj: any) => Promise<void>;
  organizationId: string;
};

const SUGGESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          source_type:         { type: "string" },
          source_key:          { type: "string" },
          target_component_id: { type: "string" },
          confidence:          { type: "string", enum: ["high", "medium", "low"] },
          reasoning:           { type: "string" },
        },
        required: ["source_type", "source_key", "target_component_id", "confidence", "reasoning"],
      },
    },
  },
  required: ["suggestions"],
};

const MAX_COMPONENTS = 500;

export async function suggestPlannerMappings(body: any, ctx: Ctx): Promise<Response> {
  const { role, tdb, apiKey, model, meterAi } = ctx;

  if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
  if (!apiKey) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY in the function secrets." }, 400);

  // 1. Fetch catalog and active mappings in parallel.
  const [{ data: catalogRows, error: catalogErr }, { data: activeMappings, error: mappingErr }] = await Promise.all([
    tdb("planner_catalog_entries").select("source_type, source_key, label").order("source_type").order("source_key"),
    tdb("planner_mappings").select("source_type, source_key, target_component_id").eq("is_active", true),
  ]);
  if (catalogErr) return json({ error: catalogErr.message }, 400);
  if (mappingErr) return json({ error: mappingErr.message }, 400);

  const catalog: any[] = catalogRows || [];
  const active: any[] = activeMappings || [];

  // 2. Find unmapped keys.
  const mappedSet = new Set<string>(active.map((m: any) => `${m.source_type}:${m.source_key}`));
  const unmapped = catalog.filter((c: any) => !mappedSet.has(`${c.source_type}:${c.source_key}`));
  if (!unmapped.length) return json({ suggestions: [], message: "All catalog keys are already mapped." });

  // 3. Fetch the BOM components already mapped to, so we can show their names.
  const mappedTargetIds = [...new Set(active.map((m: any) => m.target_component_id).filter(Boolean))];
  const mappedTargetMap: Record<string, any> = {};
  if (mappedTargetIds.length) {
    const { data: mappedComps } = await tdb("bom_components")
      .select("id, name, part_number, type, make_or_buy").in("id", mappedTargetIds);
    for (const c of mappedComps || []) mappedTargetMap[c.id] = c;
  }

  // 4. Fetch all non-obsolete BOM components for the catalog.
  const { data: allComps, error: compsErr } = await tdb("bom_components")
    .select("id, name, part_number, type, make_or_buy, lifecycle_status")
    .not("lifecycle_status", "in", '("obsolete","withdrawn")')
    .order("name")
    .limit(MAX_COMPONENTS);
  if (compsErr) return json({ error: compsErr.message }, 400);
  const components: any[] = allComps || [];
  const compById: Record<string, any> = {};
  for (const c of components) compById[c.id] = c;
  const validIds = new Set<string>(components.map((c: any) => c.id));

  // 5. Build prompt context strings.
  const existingLines = active.length
    ? active.map((m: any) => {
        const t = mappedTargetMap[m.target_component_id];
        const name = t ? t.name : "(unknown)";
        const pn = t?.part_number || "—";
        const type = t?.type || "—";
        return `"${m.source_type}:${m.source_key}" → "${name}" (PN: ${pn}, type: ${type})`;
      }).join("\n")
    : "(none yet)";

  const catalogLines = components.map((c: any) =>
    `${c.id} | ${c.name} | PN: ${c.part_number || "—"} | ${c.type} | ${c.make_or_buy || "—"}`
  ).join("\n");

  const unmappedLines = unmapped.map((u: any) => {
    const label = u.label && u.label !== u.source_key ? ` (${u.label})` : "";
    return `${u.source_type}:${u.source_key}${label}`;
  }).join("\n");

  const system = `You are a PIM mapping assistant for a Swedish LED furniture manufacturer (Rushroom AB / VALCYRA).

You will receive:
1. EXISTING MAPPINGS — planner source keys already mapped to BOM components, as reference patterns
2. BOM COMPONENT CATALOG — all available components with their IDs, names, part numbers and types
3. UNMAPPED KEYS — planner source keys that need a BOM component target suggested

Your task: for each unmapped key, suggest the most appropriate BOM component from the catalog.

══════════════════════════════════════════════
RUSHROOM SIZE LOOKUP TABLE (confirmed from live mappings — treat as ground truth)
══════════════════════════════════════════════

DOOR dimensions → size label:
  Left/Right doors (388 / 397 / 588 mm):  388 mm = S  |  397 mm = L  |  588 mm = M
  Middle doors     (380 / 389 / 580 mm):  380 mm = S  |  389 mm = L  |  580 mm = M
  NOTE: 580 mm and 588 mm both map to M size (one for Middle, one for Left/Right).

Handle/cutout colour translation:
  handle_cutout_color_silver  →  "Grey Cut out Handle"  (grey/silver cutout, not a standard handle)
  handle_cutout_color_white   →  "White Cut out Handle"
  handle_bar_color_black      →  "Black Bar Handle"
  handle_bar_color_gold       →  "Gold Bar Handle"
  handle_knob_color_black     →  "Black Knob Handle"
  handle_knob_color_gold      →  "Gold Knob Handle"

Component type name translation (dimension ALWAYS determines door type — not handle type):
  door_left_<mm>  or  door_right_<mm>  where mm is 388 / 397 / 588  →  "Prepared <S/M/L> Left/Right Door"
  door_left_<mm>  or  door_right_<mm>  where mm is 380 / 389 / 580  →  "Prepared <S/M/L> Middle Door"

══════════════════════════════════════════════
MATCHING RULES
══════════════════════════════════════════════

HARD attributes — MUST match exactly. If any hard attribute differs, omit the key (never substitute):
- Main component colour (color_white → white body; color_black → black body)
- Handle/cutout colour (use the translation table above)
- Handle type (handle_cutout vs handle_bar vs handle_knob)

SOFT attributes — may be resolved using the size lookup table above:
- Numeric dimension (mm) vs size label (S/M/L) — use the table to translate directly. If a key's mm value appears in the table, the size label is KNOWN, so confidence should be "high" when everything else also matches.

GENERAL:
- Use the exact component id from the catalog (the first column, a UUID).
- Confidence "high": all attributes including size confirmed from the lookup table and naming convention; "medium": one attribute inferred rather than explicit; "low": genuine uncertainty remains after applying all rules.
- reasoning: one concise sentence explaining the match.`;

  const userMessage = `EXISTING MAPPINGS:\n${existingLines}\n\nBOM COMPONENT CATALOG:\n${catalogLines}\n\nUNMAPPED KEYS TO SUGGEST FOR:\n${unmappedLines}`;

  // 6. Call the AI.
  let apiJson: any;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        output_config: { format: { type: "json_schema", schema: SUGGESTION_SCHEMA } },
        system,
        messages: [{ role: "user", content: [{ type: "text", text: userMessage }] }],
      }),
    });
    apiJson = await res.json();
    if (!res.ok) {
      return json({ error: `Claude API error (${res.status}): ${apiJson?.error?.message || "unknown"}` }, 502);
    }
  } catch (e) {
    return json({ error: `AI request failed: ${(e as Error).message}` }, 502);
  }

  await meterAi(apiJson);

  // 7. Parse and validate suggestions.
  let parsed: any;
  try {
    const txt = (apiJson.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    parsed = JSON.parse(txt);
  } catch {
    return json({ error: "The AI reply could not be parsed. Try again or map keys manually." }, 502);
  }

  const unmappedKeySet = new Set<string>(unmapped.map((u: any) => `${u.source_type}:${u.source_key}`));
  const enriched = (parsed.suggestions || [])
    .filter((s: any) =>
      validIds.has(String(s.target_component_id)) &&
      unmappedKeySet.has(`${s.source_type}:${s.source_key}`)
    )
    .map((s: any) => {
      const comp = compById[s.target_component_id];
      return {
        source_type: String(s.source_type),
        source_key: String(s.source_key),
        target_component_id: String(s.target_component_id),
        confidence: ["high", "medium", "low"].includes(s.confidence) ? s.confidence : "low",
        reasoning: String(s.reasoning || "").slice(0, 400),
        target: comp ? { id: comp.id, name: comp.name, part_number: comp.part_number, type: comp.type } : null,
      };
    });

  const usage = { input_tokens: apiJson?.usage?.input_tokens ?? 0, output_tokens: apiJson?.usage?.output_tokens ?? 0 };
  return json({ suggestions: enriched, usage });
}
