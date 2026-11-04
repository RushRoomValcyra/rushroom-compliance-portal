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

STRICT MATCHING RULES — read carefully:
- Every explicit attribute encoded in the source key MUST match the component exactly. This includes: door/module colour, handle colour, handle type (cutout vs standard), size (S/M/L/XL, mm), and any other variant. If even one attribute differs, do NOT suggest that component.
- Example: a key containing "handle_color_silver" must map to a component that explicitly has a silver handle. Mapping it to a white-handle component is WRONG. If no silver-handle component exists in the catalog, omit the key entirely — do not fall back to a similar component.
- Example: a key containing "color_black" must map to a black component. Never suggest a white variant as a substitute.
- When no component in the catalog matches ALL attributes in the key, omit that key from the suggestions array. The user will create the missing component in the BOM. A missing suggestion is far better than a wrong one — a wrong mapping ships the wrong product to the customer.
- Use naming patterns from existing mappings only as a structural guide (e.g. key format → component name format). Never copy the target of an existing mapping to a key with different attributes.
- Confidence "high": every attribute matches clearly; "medium": structural match is clear but one attribute is implicit rather than explicit in the component name; "low": significant uncertainty — only use for keys where the key has very few attributes and the match is otherwise strong.
- Use the exact component id from the catalog (the first column, a UUID).
- reasoning: one concise sentence explaining why ALL attributes in the key match this component, or what makes you uncertain.`;

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
