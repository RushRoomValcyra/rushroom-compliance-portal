// PROP-075 — Lightweight batch AI suggestion for the BOM gap check "Proposed" column.
// One haiku call per source_type, returning name + type for every ungapped key.
// No template lookup, no description — those come from the full suggestPlannerComponent
// call when the user opens "Create component".
import { json } from "../../_shared/http.ts";

type Ctx = {
  role: string;
  tdb: (table: string) => any;
  apiKey: string;
  model: string;
  meterAi: (aj: any) => Promise<void>;
};

const COMPONENT_TYPES = ["part", "raw_material", "sub_assembly", "phantom_assembly", "finished_good", "spare_part", "product_family"];

const BATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          source_key: { type: "string" },
          name:       { type: "string" },
          type:       { type: "string", enum: COMPONENT_TYPES },
        },
        required: ["source_key", "name", "type"],
      },
    },
  },
  required: ["suggestions"],
};

export async function batchSuggestComponents(body: any, ctx: Ctx): Promise<Response> {
  const { role, tdb, apiKey, model, meterAi } = ctx;
  if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
  if (!apiKey) return json({ error: "AI not configured" }, 400);

  const sourceType = String(body.source_type ?? "").trim();
  const sourceKeys: string[] = Array.isArray(body.source_keys)
    ? body.source_keys.slice(0, 60).map((k: any) => String(k))
    : [];
  if (!sourceType || !sourceKeys.length) return json({ error: "source_type and source_keys required" }, 400);

  // Fetch existing active mappings for this source_type as naming reference.
  const { data: mappingRows } = await tdb("planner_mappings")
    .select("source_key, target_component_id")
    .eq("source_type", sourceType)
    .eq("is_active", true)
    .limit(60);

  const targetIds = [...new Set((mappingRows || []).map((m: any) => m.target_component_id).filter(Boolean))];
  const compById: Record<string, any> = {};
  if (targetIds.length) {
    const { data: comps } = await tdb("bom_components")
      .select("id, name, type").in("id", targetIds);
    for (const c of (comps || [])) compById[c.id] = c;
  }

  const refLines = (mappingRows || [])
    .filter((m: any) => compById[m.target_component_id])
    .map((m: any) => {
      const c = compById[m.target_component_id];
      return `"${m.source_key}" → "${c.name}" [${c.type}]`;
    })
    .join("\n");

  const system = `You are a PIM component naming assistant for a Swedish LED furniture manufacturer (Rushroom AB / VALCYRA).
Given existing key→component mappings as naming reference, suggest a short name and component type for each new planner key.
Return exactly one suggestion per key (in the same order as the input list).
Name: 3–8 words, consistent with the naming conventions from the reference.
Type: pick the most specific type. For LED furniture modules or door inserts → sub_assembly. For bare parts → part. For final product SKUs → finished_good.`;

  const userMsg = `REFERENCE (source_type="${sourceType}"):\n${refLines || "(none yet)"}\n\nSUGGEST FOR:\n${sourceKeys.map((k, i) => `${i + 1}. ${k}`).join("\n")}`;

  let apiJson: any;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        output_config: { format: { type: "json_schema", schema: BATCH_SCHEMA } },
        system,
        messages: [{ role: "user", content: [{ type: "text", text: userMsg }] }],
      }),
    });
    apiJson = await res.json();
    if (!res.ok) return json({ error: `AI error (${res.status}): ${apiJson?.error?.message ?? "unknown"}` }, 502);
  } catch (e) {
    return json({ error: `AI request failed: ${(e as Error).message}` }, 502);
  }

  await meterAi(apiJson);

  let parsed: any;
  try {
    const txt = (apiJson.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    parsed = JSON.parse(txt);
  } catch {
    return json({ error: "Could not parse AI response" }, 502);
  }

  const suggestions = (parsed.suggestions || []).map((s: any) => ({
    source_key: String(s.source_key || ""),
    name: String(s.name || "").slice(0, 200),
    type: COMPONENT_TYPES.includes(s.type) ? s.type : "sub_assembly",
  }));

  return json({
    suggestions,
    usage: { input_tokens: apiJson?.usage?.input_tokens ?? 0, output_tokens: apiJson?.usage?.output_tokens ?? 0 },
  });
}
