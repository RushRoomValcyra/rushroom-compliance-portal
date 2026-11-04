// PROP-075 — AI-suggested BOM component metadata for a planner key that has no mapping.
// ============================================================================
// Called when the user clicks "Create component" on a no_mapping gap in the
// BOM gap check modal. Fetches existing components already mapped for the same
// source_type to infer naming conventions, then asks Claude to suggest a name,
// type, make_or_buy, and description for the new component.
// Nothing is written here — the user reviews and edits in the modal first.
import { json } from "../../_shared/http.ts";

type Ctx = {
  role: string;
  tdb: (table: string) => any;
  apiKey: string;
  model: string;
  meterAi: (aj: any) => Promise<void>;
};

const COMPONENT_TYPES = ["part", "raw_material", "sub_assembly", "phantom_assembly", "finished_good", "spare_part", "product_family"];
const CATEGORYLESS_TYPES = ["sub_assembly", "phantom_assembly", "product_family"];

const SUGGESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name:        { type: "string" },
    type:        { type: "string", enum: COMPONENT_TYPES },
    make_or_buy: { type: "string", enum: ["purchased", "manufactured", "assembled", "subcontracted", ""] },
    description: { type: "string" },
    reasoning:   { type: "string" },
  },
  required: ["name", "type", "make_or_buy", "description", "reasoning"],
};

export async function suggestPlannerComponent(body: any, ctx: Ctx): Promise<Response> {
  const { role, tdb, apiKey, model, meterAi } = ctx;

  if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
  if (!apiKey) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY in the function secrets." }, 400);

  const sourceType = String(body.source_type ?? "").trim();
  const sourceKey  = String(body.source_key  ?? "").trim();
  if (!sourceType || !sourceKey) return json({ error: "source_type and source_key are required" }, 400);

  // 1. Fetch active mappings for this source_type as naming-convention reference.
  const { data: mappingRows, error: mappingErr } = await tdb("planner_mappings")
    .select("source_key, target_component_id")
    .eq("source_type", sourceType)
    .eq("is_active", true)
    .limit(60);
  if (mappingErr) return json({ error: mappingErr.message }, 400);

  // 2. Fetch the components those mappings point to.
  const targetIds = [...new Set((mappingRows || []).map((m: any) => m.target_component_id).filter(Boolean))];
  const refComponents: any[] = [];
  if (targetIds.length) {
    const { data: comps } = await tdb("bom_components")
      .select("id, name, part_number, type, make_or_buy, description")
      .in("id", targetIds);
    if (comps) refComponents.push(...comps);
  }
  const compById: Record<string, any> = {};
  for (const c of refComponents) compById[c.id] = c;

  // 3. Build reference lines (key → component).
  const refLines = (mappingRows || [])
    .filter((m: any) => compById[m.target_component_id])
    .map((m: any) => {
      const c = compById[m.target_component_id];
      return `"${m.source_key}" → "${c.name}" (PN: ${c.part_number || "—"}, type: ${c.type}, make_or_buy: ${c.make_or_buy || "—"})`;
    })
    .join("\n");

  // 4. Build the prompt.
  const system = `You are a PIM component creation assistant for a Swedish LED furniture manufacturer (Rushroom AB / VALCYRA).

You will receive:
1. REFERENCE MAPPINGS — existing planner keys for the same source_type, already mapped to known BOM components. Use these to understand naming conventions and attribute patterns.
2. A NEW KEY that has no BOM component yet. Your job is to suggest what the new component should look like.

RULES:
- Derive the component's attributes directly from the key. Every attribute encoded in the key (colour, size, handle type, material, etc.) must be reflected in the name and description.
- Choose the most specific type. For LED furniture modules or door inserts → "sub_assembly". For bare parts (screws, brackets, strips) → "part". For the final product SKU → "finished_good". For raw sheet or profile material → "raw_material".
- make_or_buy: for sub_assemblies → "assembled"; for purchased parts → "purchased"; for manufactured sheet/profiles → "manufactured". Leave blank ("") only for finished_good and product_family.
- name: short, consistent with naming conventions from the references. 3–8 words.
- description: one sentence explaining what this component is and how it differs from related components (e.g. colour, size).
- reasoning: one concise sentence explaining how you derived the suggestion from the key.`;

  const userMessage = `REFERENCE MAPPINGS (source_type="${sourceType}"):\n${refLines || "(none yet — this may be the first component of this type)"}\n\nNEW KEY TO SUGGEST A COMPONENT FOR:\n${sourceType}:${sourceKey}`;

  // 5. Call the AI.
  let apiJson: any;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 800,
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

  // 6. Parse.
  let parsed: any;
  try {
    const txt = (apiJson.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    parsed = JSON.parse(txt);
  } catch {
    return json({ error: "The AI reply could not be parsed. Try again or fill the fields manually." }, 502);
  }

  const validType = COMPONENT_TYPES.includes(parsed.type) ? parsed.type : "sub_assembly";
  const needsMakeOrBuy = !CATEGORYLESS_TYPES.includes(validType) && validType !== "finished_good";
  const makOrBuyOptions = ["purchased", "manufactured", "assembled", "subcontracted"];
  const makeOrBuy = makOrBuyOptions.includes(parsed.make_or_buy) ? parsed.make_or_buy : (needsMakeOrBuy ? "assembled" : "");

  return json({
    name:        String(parsed.name        || "").slice(0, 200),
    type:        validType,
    make_or_buy: makeOrBuy,
    description: String(parsed.description || "").slice(0, 500),
    reasoning:   String(parsed.reasoning   || "").slice(0, 300),
    usage: { input_tokens: apiJson?.usage?.input_tokens ?? 0, output_tokens: apiJson?.usage?.output_tokens ?? 0 },
  });
}
