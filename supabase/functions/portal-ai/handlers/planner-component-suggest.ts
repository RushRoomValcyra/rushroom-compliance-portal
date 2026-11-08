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
  db: any;
  organizationId: string;
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
  const { role, tdb, apiKey, model, meterAi, db, organizationId } = ctx;

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

  const suggestedName = String(parsed.name || "").slice(0, 200);

  // 7. Find the closest existing assembly with children to use as a structure template.
  //    Only makes sense for assembly types. Failure here is non-fatal.
  const ASSEMBLY_TYPES = new Set(["sub_assembly", "phantom_assembly", "finished_good"]);
  let template: any = null;
  if (ASSEMBLY_TYPES.has(validType)) {
    try {
      // Fetch all active assemblies that have at least one child edge.
      const { data: candidates } = await tdb("bom_components")
        .select("id, name, part_number, type")
        .in("type", [...ASSEMBLY_TYPES])
        .eq("lifecycle_status", "active");

      if (candidates && candidates.length) {
        // Score each candidate by word-overlap with the suggested name.
        const words = (s: string) => new Set(
          s.toLowerCase().split(/[\s\-\/\(\)]+/).filter((w: string) => w.length > 2)
        );
        const sugWords = words(suggestedName);
        let best: any = null, bestScore = 0;
        for (const c of candidates) {
          if (c.id === undefined) continue;
          const cWords = words(c.name);
          let overlap = 0;
          for (const w of sugWords) if (cWords.has(w)) overlap++;
          const score = overlap / Math.max(sugWords.size, cWords.size, 1);
          if (score > bestScore) { bestScore = score; best = c; }
        }

        // Only use as template if there's a meaningful overlap (>40%) and it has children.
        if (best && bestScore > 0.4) {
          const { data: edges } = await tdb("bom_edges")
            .select("child_id, quantity, sort_order, fitting_stage")
            .eq("parent_id", best.id)
            .is("effective_to", null)
            .eq("is_reference", false)
            .order("sort_order");

          if (edges && edges.length) {
            const childIds = edges.map((e: any) => e.child_id);
            const { data: childComps } = await tdb("bom_components")
              .select("id, name, part_number, type, lifecycle_status")
              .in("id", childIds);
            const byId: Record<string, any> = {};
            for (const c of (childComps || [])) byId[c.id] = c;

            template = {
              id: best.id,
              name: best.name,
              part_number: best.part_number || null,
              similarity: Math.round(bestScore * 100),
              children: edges.map((e: any) => {
                const child = byId[e.child_id] || {};
                return {
                  id: e.child_id,
                  name: child.name || "Unknown",
                  part_number: child.part_number || null,
                  type: child.type || "part",
                  lifecycle_status: child.lifecycle_status || "active",
                  quantity: e.quantity,
                  sort_order: e.sort_order,
                  fitting_stage: e.fitting_stage || null,
                };
              }),
            };
          }
        }
      }
    } catch {
      // Template lookup failure is non-fatal — the user can proceed without it.
    }
  }

  // Deterministic name-similarity check: find existing BOM components that
  // closely match the AI-suggested name so the user is never shown "create new"
  // when a near-identical component already exists.
  let nameMatches: any[] = [];
  if (suggestedName && db && organizationId) {
    try {
      const { data: sim } = await db.rpc("find_similar_bom_components", {
        p_org_id: organizationId,
        p_name: suggestedName,
        p_threshold: 0.4,
        p_max_results: 6,
      });
      nameMatches = (sim || []).map((r: any) => ({
        id:               r.id,
        name:             r.name,
        part_number:      r.part_number,
        type:             r.type,
        lifecycle_status: r.lifecycle_status,
        score:            Math.round(r.score * 100) / 100,
      }));
    } catch { /* non-fatal — user still gets the AI suggestion */ }
  }

  return json({
    name:        suggestedName,
    type:        validType,
    make_or_buy: makeOrBuy,
    description: String(parsed.description || "").slice(0, 500),
    reasoning:   String(parsed.reasoning   || "").slice(0, 300),
    template,
    name_matches: nameMatches,
    usage: { input_tokens: apiJson?.usage?.input_tokens ?? 0, output_tokens: apiJson?.usage?.output_tokens ?? 0 },
  });
}
