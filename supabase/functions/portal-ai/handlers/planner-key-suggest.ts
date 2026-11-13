// AI-suggested planner key for an existing BOM component (the reverse of
// planner-component-suggest.ts). Keys usually name a whole assembly, so the
// component's direct children are sent along: the attributes a planner key
// encodes (handle colour, insert type, size) often live on a child, not on
// the assembly's own name. Nothing is written here — the user edits and assigns.
import { json } from "../../_shared/http.ts";

type Ctx = {
  role: string;
  tdb: (table: string) => any;
  apiKey: string;
  model: string;
  meterAi: (aj: any) => Promise<void>;
};

const SOURCE_TYPES = ["module", "interior", "side_panel", "feet", "door", "cover", "back_cover"];
const ASSEMBLY_TYPES = new Set(["sub_assembly", "phantom_assembly", "finished_good"]);
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:*\/-]{0,159}$/;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    key:          { type: "string" },
    alternatives: { type: "array", items: { type: "string" } },
    reasoning:    { type: "string" },
  },
  required: ["key", "alternatives", "reasoning"],
};

export async function suggestPlannerKey(body: any, ctx: Ctx): Promise<Response> {
  const { role, tdb, apiKey, model, meterAi } = ctx;

  if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
  if (!apiKey) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY in the function secrets." }, 400);

  const componentId = String(body.component_id ?? "").trim();
  const sourceType  = String(body.source_type  ?? "").trim();
  if (!componentId) return json({ error: "component_id required" }, 400);
  if (!SOURCE_TYPES.includes(sourceType)) return json({ error: "Invalid source_type" }, 400);

  const { data: comp, error: compErr } = await tdb("bom_components")
    .select("id, name, part_number, type, description, make_or_buy")
    .eq("id", componentId).maybeSingle();
  if (compErr) return json({ error: compErr.message }, 400);
  if (!comp || comp.type === "product_family") return json({ error: "Choose an existing PIM component or sub-assembly" }, 400);

  const compNames = async (ids: string[]) => {
    if (!ids.length) return {} as Record<string, any>;
    const { data } = await tdb("bom_components").select("id, name, type").in("id", ids);
    const byId: Record<string, any> = {};
    for (const c of data || []) byId[c.id] = c;
    return byId;
  };

  // Direct children: where an assembly's distinguishing attributes live.
  let childLines = "";
  if (ASSEMBLY_TYPES.has(comp.type)) {
    const { data: edges } = await tdb("bom_edges")
      .select("child_id, quantity")
      .eq("parent_id", comp.id).is("effective_to", null).eq("is_reference", false)
      .order("sort_order").limit(40);
    const byId = await compNames((edges || []).map((e: any) => e.child_id));
    childLines = (edges || [])
      .filter((e: any) => byId[e.child_id])
      .map((e: any) => `  - ${e.quantity ?? 1} × "${byId[e.child_id].name}" (${byId[e.child_id].type})`)
      .join("\n");
  }

  // Parents: which module/door this component belongs to.
  const { data: parentEdges } = await tdb("bom_edges")
    .select("parent_id")
    .eq("child_id", comp.id).is("effective_to", null).eq("is_reference", false)
    .limit(10);
  const parentsById = await compNames([...new Set((parentEdges || []).map((e: any) => e.parent_id))]);
  const parentLines = Object.values(parentsById).map((p: any) => `  - "${p.name}" (${p.type})`).join("\n");

  // Naming-convention references: mapped keys (with their component) plus
  // catalog keys that are not mapped yet, for this source_type.
  const { data: mappingRows } = await tdb("planner_mappings")
    .select("source_key, target_component_id")
    .eq("source_type", sourceType).eq("is_active", true).limit(60);
  const targetsById = await compNames([...new Set((mappingRows || []).map((m: any) => m.target_component_id))]);
  const mappedKeys = new Set((mappingRows || []).map((m: any) => m.source_key));
  const refLines = (mappingRows || [])
    .map((m: any) => {
      const t = targetsById[m.target_component_id];
      return t ? `"${m.source_key}" → "${t.name}" (${t.type})` : `"${m.source_key}"`;
    });
  const { data: catalogRows } = await tdb("planner_catalog_entries")
    .select("source_key").eq("source_type", sourceType).limit(60);
  for (const c of catalogRows || []) if (!mappedKeys.has(c.source_key)) refLines.push(`"${c.source_key}" (not mapped yet)`);

  const { data: ownRows } = await tdb("planner_mappings")
    .select("source_type, source_key")
    .eq("target_component_id", comp.id).eq("is_active", true);
  const ownKeys = new Set((ownRows || []).map((r: any) => r.source_key));
  const ownLines = (ownRows || []).map((r: any) => `  - ${r.source_type}:${r.source_key}`).join("\n");

  const system = `You name planner keys for a Swedish LED furniture manufacturer (Rushroom AB / VALCYRA). A planner key is the stable identifier the web planner sends for one option; a BOM mapping resolves it to one BOM component.

You will receive REFERENCE KEYS already in use for the same source_type, and one TARGET COMPONENT that needs a new key.

RULES:
- Follow the grammar of the reference keys exactly: same token order, same vocabulary, same size and colour tokens. Reuse an existing token for an attribute whenever one exists; invent a token only for an attribute no reference encodes.
- Lowercase; tokens joined by "_"; only a-z, 0-9 and "_".
- The key identifies the whole target component. When the target is an assembly, encode the attributes its children contribute (handle colour, insert type, size) — the planner picks the assembly by those attributes, never a single part.
- Encode every attribute that separates this component from similarly named ones. Omit what the source_type already implies.
- Never return a key that is already in the references or already assigned to the target.
- alternatives: up to 2 other plausible keys (different token order or level of detail); may be empty.
- reasoning: one sentence on which references and which attributes the key follows.`;

  const user = [
    `REFERENCE KEYS (source_type="${sourceType}"):`,
    refLines.length ? refLines.join("\n") : "(none yet — this may be the first key of this type)",
    "",
    `TARGET COMPONENT (needs a "${sourceType}" key):`,
    `name: ${comp.name}`,
    `part_number: ${comp.part_number || "—"}`,
    `type: ${comp.type}${ASSEMBLY_TYPES.has(comp.type) ? " (assembly — the key names the whole assembly)" : ""}`,
    `make_or_buy: ${comp.make_or_buy || "—"}`,
    `description: ${comp.description || "—"}`,
    childLines ? `direct children:\n${childLines}` : (ASSEMBLY_TYPES.has(comp.type) ? "direct children: (none recorded)" : ""),
    parentLines ? `used in:\n${parentLines}` : "",
    ownLines ? `keys already assigned to this component:\n${ownLines}` : "",
  ].filter((l) => l !== "").join("\n");

  let apiJson: any;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
        system,
        messages: [{ role: "user", content: [{ type: "text", text: user }] }],
      }),
    });
    apiJson = await res.json();
    if (!res.ok) return json({ error: `Claude API error (${res.status}): ${apiJson?.error?.message || "unknown"}` }, 502);
  } catch (e) {
    return json({ error: `AI request failed: ${(e as Error).message}` }, 502);
  }

  await meterAi(apiJson);

  let parsed: any;
  try {
    const txt = (apiJson.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    parsed = JSON.parse(txt);
  } catch {
    return json({ error: "The AI reply could not be parsed. Try again or type the key manually." }, 502);
  }

  const clean = (k: unknown) => String(k ?? "").trim().toLowerCase();
  const candidates = [...new Set([clean(parsed.key), ...(Array.isArray(parsed.alternatives) ? parsed.alternatives.map(clean) : [])])]
    .filter((k) => k && KEY_RE.test(k) && !ownKeys.has(k))
    .slice(0, 3);
  if (!candidates.length) return json({ error: "The AI did not produce a valid key. Type one manually." }, 502);

  // Prefer the first candidate not already held by another component; if every
  // one is taken, return the primary and say who holds it.
  let key = candidates[0];
  let existing: { component_id: string; name: string } | null = null;
  for (const k of candidates) {
    const { data: held } = await tdb("planner_mappings")
      .select("target_component_id")
      .eq("source_type", sourceType).eq("source_key", k).eq("is_active", true).maybeSingle();
    if (!held) { key = k; existing = null; break; }
    if (k === candidates[0]) {
      const holder = (await compNames([held.target_component_id]))[held.target_component_id];
      existing = { component_id: held.target_component_id, name: holder?.name || "another component" };
    }
  }

  return json({
    key,
    alternatives: candidates.filter((k) => k !== key),
    reasoning: String(parsed.reasoning || "").slice(0, 300),
    existing,
    usage: { input_tokens: apiJson?.usage?.input_tokens ?? 0, output_tokens: apiJson?.usage?.output_tokens ?? 0 },
  });
}
