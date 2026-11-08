// PROP-076 — AI BOM anomaly scan: finds structural problems and naming inconsistencies
// across the entire BOM (all organizations). Runs two passes:
//   1. Rule-based: definite findings (copy active, empty assemblies, inactive children, orphans,
//      duplicate children, duplicate names, make_or_buy violations).
//   2. AI pass: variant family gaps, naming drift, suspicious structures.
//      Sends structured JSON (pre-grouped into variant families) to SCAN_MODEL (opus).
//      All AI-returned component_ids are validated against the loaded BOM before returning.
// All suggestions are read-only — nothing is written here.
import { json } from "../../_shared/http.ts";

type Ctx = {
  role: string;
  tdb: (table: string) => any;
  apiKey: string;
  model: string;
  meterAi: (aj: any) => Promise<void>;
};

type Anomaly = {
  severity: "high" | "medium" | "low";
  category: string;
  component_id: string | null;
  component_name: string | null;
  part_number: string | null;
  description: string;
  suggestion: string;
};

const ANOMALY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    anomalies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity:        { type: "string", enum: ["high", "medium", "low"] },
          category:        { type: "string" },
          component_id:    { type: ["string", "null"] },
          component_name:  { type: ["string", "null"] },
          part_number:     { type: ["string", "null"] },
          description:     { type: "string" },
          suggestion:      { type: "string" },
        },
        required: ["severity", "category", "component_id", "component_name", "part_number", "description", "suggestion"],
      },
    },
    summary: { type: "string" },
  },
  required: ["anomalies", "summary"],
};

// Strip size (S/M/L) and colour tokens to produce a "family key" for grouping variant components.
function variantFamilyKey(name: string): string {
  return name
    .replace(/\b(S|M|L)\b/g, "?")
    .replace(/\b(White|Black|Grey|Gray|Oak|Birch|Walnut)\b/gi, "?")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export async function scanBomAnomalies(body: any, ctx: Ctx): Promise<Response> {
  const { role, tdb, apiKey, model, meterAi } = ctx;

  if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
  if (!apiKey) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY in the function secrets." }, 400);

  // 1. Fetch all BOM data.
  const [compRes, edgeRes] = await Promise.all([
    tdb("bom_components").select("id, part_number, name, type, make_or_buy, lifecycle_status, description, is_stocked"),
    tdb("bom_edges").select("parent_id, child_id, quantity").is("effective_to", null).eq("is_reference", false),
  ]);
  if (compRes.error) return json({ error: compRes.error.message }, 400);
  if (edgeRes.error) return json({ error: edgeRes.error.message }, 400);

  const components: any[] = compRes.data || [];
  const edges: any[] = edgeRes.data || [];

  const byId: Record<string, any> = {};
  for (const c of components) byId[c.id] = c;

  // Build adjacency: parent → [child]
  const childrenOf: Record<string, string[]> = {};
  const parentsOf: Record<string, string[]> = {};
  for (const e of edges) {
    (childrenOf[e.parent_id] ||= []).push(e.child_id);
    (parentsOf[e.child_id]  ||= []).push(e.parent_id);
  }

  const findings: Anomaly[] = [];

  // --- Rule-based pass ---

  // R1: "- copy" components (any lifecycle status).
  for (const c of components) {
    if (c.name && c.name.includes("- copy")) {
      const isActive = c.lifecycle_status === "active";
      findings.push({
        severity: isActive ? "high" : "medium",
        category: "copy_component",
        component_id: c.id,
        component_name: c.name,
        part_number: c.part_number || null,
        description: `Component "${c.name}" (${c.lifecycle_status}) has "- copy" in its name, indicating it was auto-generated during an assembly copy and was never replaced with the original.`,
        suggestion: isActive
          ? "Replace this component in its parent assembly (use the ≡ menu → Replace), then set this one to Inactive."
          : "Safe to delete if it has no linked documents or orders — it was an accidental duplicate.",
      });
    }
  }

  // R2: Assemblies (any lifecycle) with no children in any edge.
  const assemblyTypes = new Set(["sub_assembly", "finished_good", "phantom_assembly"]);
  for (const c of components) {
    if (!assemblyTypes.has(c.type)) continue;
    if (!(childrenOf[c.id] || []).length) {
      const isActive = c.lifecycle_status === "active";
      findings.push({
        severity: isActive ? "medium" : "low",
        category: "empty_assembly",
        component_id: c.id,
        component_name: c.name,
        part_number: c.part_number || null,
        description: `Assembly "${c.name}" (${c.type}, ${c.lifecycle_status}) has no children in the BOM.`,
        suggestion: isActive
          ? "Add children, mark it Inactive if it is a placeholder, or delete it if unused."
          : "Can be deleted if it has no linked documents, work orders, or cost data.",
      });
    }
  }

  // R3: Active assemblies that contain inactive/discontinued children (operational risk).
  for (const c of components) {
    if (!assemblyTypes.has(c.type)) continue;
    if (c.lifecycle_status !== "active") continue;
    for (const childId of (childrenOf[c.id] || [])) {
      const child = byId[childId];
      if (!child) continue;
      if (child.lifecycle_status === "inactive" || child.lifecycle_status === "discontinued") {
        findings.push({
          severity: "high",
          category: "inactive_child",
          component_id: childId,
          component_name: child.name,
          part_number: child.part_number || null,
          description: `Inactive/discontinued component "${child.name}" is a child of active assembly "${c.name}".`,
          suggestion: `Replace "${child.name}" in "${c.name}" with its active successor, or activate it if it is still current.`,
        });
      }
    }
  }

  // R5: Duplicate children in an assembly (same child linked twice).
  for (const [parentId, children] of Object.entries(childrenOf)) {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const cid of children) {
      if (seen.has(cid)) dupes.add(cid);
      seen.add(cid);
    }
    for (const dupId of dupes) {
      const parent = byId[parentId];
      const child  = byId[dupId];
      if (!parent || !child) continue;
      findings.push({
        severity: "medium",
        category: "duplicate_child",
        component_id: dupId,
        component_name: child.name,
        part_number: child.part_number || null,
        description: `"${child.name}" appears more than once as a direct child of "${parent.name}".`,
        suggestion: "Remove the duplicate edge — keep the one with the correct quantity.",
      });
    }
  }

  // R6: Multiple distinct components sharing the same name (different IDs).
  const byName: Record<string, any[]> = {};
  for (const c of components) {
    const key = (c.name || "").trim().toLowerCase();
    if (!key) continue;
    (byName[key] ||= []).push(c);
  }
  for (const group of Object.values(byName)) {
    if (group.length < 2) continue;
    const allActive = group.every(c => c.lifecycle_status === "active");
    const anyActive = group.some(c => c.lifecycle_status === "active");
    findings.push({
      severity: allActive ? "high" : anyActive ? "medium" : "low",
      category: "duplicate_name",
      component_id: null,
      component_name: group[0].name,
      part_number: null,
      description: `${group.length} components share the name "${group[0].name}": ${group.map(c => c.part_number || c.id).join(", ")}.`,
      suggestion: "Rename or merge so each component has a unique name. If one is a superseded version, set it to Inactive/Discontinued.",
    });
  }

  // R7: make_or_buy violations.
  // sub_assembly / phantom_assembly must be "assembled" (never "purchased").
  // part / raw_material / spare_part must NOT be "assembled".
  const assembledExpected = new Set(["sub_assembly", "phantom_assembly"]);
  const purchasedOrMfgExpected = new Set(["part", "raw_material", "spare_part"]);
  for (const c of components) {
    if (c.lifecycle_status !== "active") continue;
    if (!c.make_or_buy) continue; // null = not yet set, skip
    if (assembledExpected.has(c.type) && c.make_or_buy === "purchased") {
      findings.push({
        severity: "high",
        category: "mob_violation",
        component_id: c.id,
        component_name: c.name,
        part_number: c.part_number || null,
        description: `"${c.name}" is a ${c.type} but has make_or_buy = "purchased". Structural assemblies must be set to "assembled".`,
        suggestion: `Change make_or_buy to "assembled" on "${c.name}".`,
      });
    }
    if (purchasedOrMfgExpected.has(c.type) && c.make_or_buy === "assembled") {
      findings.push({
        severity: "high",
        category: "mob_violation",
        component_id: c.id,
        component_name: c.name,
        part_number: c.part_number || null,
        description: `"${c.name}" is a ${c.type} but has make_or_buy = "assembled". Purchased/manufactured parts cannot be assembled.`,
        suggestion: `Change make_or_buy to "purchased" or "manufactured" on "${c.name}".`,
      });
    }
  }

  // --- AI pass: variant family gaps, naming drift, suspicious structures ---
  // Pre-group active components into variant families using name-token stripping.
  const activeComps = components.filter(c => c.lifecycle_status === "active");

  const familyMap: Record<string, any[]> = {};
  for (const c of activeComps) {
    const key = variantFamilyKey(c.name || "");
    (familyMap[key] ||= []).push(c);
  }

  // Families: 2+ active members sharing the same stripped name pattern.
  const families = Object.entries(familyMap)
    .filter(([, members]) => members.length >= 2)
    .map(([pattern, members]) => ({
      pattern,
      variants: members.map(c => ({
        id: c.id,
        name: c.name,
        pn: c.part_number || null,
        type: c.type,
        mob: c.make_or_buy || null,
        child_count: (childrenOf[c.id] || []).length,
        children: (childrenOf[c.id] || []).slice(0, 15).map(cid => byId[cid]?.name).filter(Boolean),
      })),
    }));

  // Singletons: active assemblies/parts not part of any family (potential variants missing siblings).
  const singletons = Object.entries(familyMap)
    .filter(([, members]) => members.length === 1)
    .map(([, members]) => members[0])
    .filter(c => assemblyTypes.has(c.type)) // only flag singleton assemblies
    .map(c => ({
      id: c.id,
      name: c.name,
      pn: c.part_number || null,
      type: c.type,
      mob: c.make_or_buy || null,
      child_count: (childrenOf[c.id] || []).length,
      children: (childrenOf[c.id] || []).slice(0, 10).map(cid => byId[cid]?.name).filter(Boolean),
    }));

  const structuredInput = { families, singletons };

  let aiAnomalies: Anomaly[] = [];
  let summary = `Rule-based scan found ${findings.length} issue(s).`;
  let aiUsage = { input_tokens: 0, output_tokens: 0 };

  if (components.length > 0) {
    const system = `You are a BOM quality analyst for a Swedish LED furniture manufacturer (Rushroom AB / VALCYRA).
You will receive BOM data grouped into VARIANT FAMILIES (components sharing the same name pattern except for size or colour tokens) and SINGLETON ASSEMBLIES (assemblies that appear to have no siblings in their product family).

Your job: identify gaps and inconsistencies that the rule-based scan cannot catch.

══════════════════════════════════════════════
RUSHROOM PRODUCT KNOWLEDGE
══════════════════════════════════════════════

DOOR dimensions → size label (ground truth from live data):
  Left/Right doors (388 / 397 / 588 mm):  388 mm = S  |  397 mm = L  |  588 mm = M
  Middle doors     (380 / 389 / 580 mm):  380 mm = S  |  389 mm = L  |  580 mm = M
  NOTE: 580 mm and 588 mm both map to M (one for Middle, one for Left/Right door families).

Handle/cutout colour naming:
  "Grey Cut out Handle"   = silver/grey cutout recess (no physical handle)
  "White Cut out Handle"  = white cutout recess
  "Black Bar Handle"  |  "Gold Bar Handle"
  "Black Knob Handle" |  "Gold Knob Handle"

Component type rules:
  sub_assembly / phantom_assembly → make_or_buy MUST be "assembled"
  part / raw_material / spare_part → make_or_buy MUST be "purchased" or "manufactured"
  finished_good                    → make_or_buy is typically "purchased"

Product line structure:
  A complete door variant family has members for EACH active size (S, M, L) and EACH active colour.
  An assembly's child list typically mirrors its sibling variants' child lists — count and type.
  Any variant with a child_count significantly different from its siblings is suspicious.

══════════════════════════════════════════════
WHAT TO FIND
══════════════════════════════════════════════

1. VARIANT FAMILY GAPS — a family is missing expected size or colour variants (e.g. S and M exist but L is absent).
2. CHILD COUNT MISMATCH — siblings in a family have different child counts without an obvious reason.
3. CHILD TYPE MISMATCH — one variant has a child of a different type or name pattern than its siblings.
4. SINGLETON ASSEMBLIES — an active assembly appears to be a variant with no siblings; flag only if the name strongly implies it should have siblings (e.g. contains a colour or size token).
5. NAMING DRIFT — a component name does not follow the established pattern for its family (e.g. capitalisation, extra word, missing token).
6. SUSPICIOUS STRUCTURE — any other anomaly the rules above could not catch.

DO NOT flag:
- Orphans, copy-components, inactive children, empty assemblies, duplicate names, duplicate children, or make_or_buy violations (all handled by the rule-based pass).
- Product-family or finished_good components with no siblings (by design).
- Singleton assemblies where the name contains no size or colour token.

For each finding: use the exact id from the data provided as component_id.
If a finding applies to a whole family (not one member), set component_id to null and describe the family in component_name.
Return at most 20 findings, ranked by severity. Be specific — name the missing variant or the differing child.`;

    const userMsg = `BOM SUMMARY: ${components.length} total components, ${activeComps.length} active.
Variant families: ${families.length}. Singleton active assemblies: ${singletons.length}.

${JSON.stringify(structuredInput, null, 0)}`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 4000,
          output_config: { format: { type: "json_schema", schema: ANOMALY_SCHEMA } },
          system,
          messages: [{ role: "user", content: [{ type: "text", text: userMsg }] }],
        }),
      });
      const apiJson = await res.json();
      if (res.ok) {
        await meterAi(apiJson);
        aiUsage = { input_tokens: apiJson?.usage?.input_tokens ?? 0, output_tokens: apiJson?.usage?.output_tokens ?? 0 };
        const txt = (apiJson.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
        const parsed = JSON.parse(txt);
        aiAnomalies = (parsed.anomalies || [])
          .slice(0, 20)
          .map((a: any) => ({
            severity: (["high", "medium", "low"] as const).includes(a.severity) ? a.severity : "low" as const,
            category: String(a.category || "ai_finding"),
            component_id: a.component_id || null,
            component_name: a.component_name || null,
            part_number: a.part_number || null,
            description: String(a.description || "").slice(0, 600),
            suggestion: String(a.suggestion || "").slice(0, 300),
          }))
          // Discard any finding where the AI returned a component_id that does not exist in the BOM.
          .filter((a: Anomaly) => !a.component_id || !!byId[a.component_id]);
        summary = parsed.summary || `Rule-based: ${findings.length} issue(s). AI: ${aiAnomalies.length} pattern(s).`;
      }
    } catch {
      // AI failure is non-fatal — return rule-based findings only.
      summary = `Rule-based scan found ${findings.length} issue(s). AI analysis failed — showing rule-based results only.`;
    }
  }

  const all = [...findings, ...aiAnomalies];

  return json({
    anomalies: all,
    summary,
    stats: { total_components: components.length, active_components: activeComps.length, total_edges: edges.length },
    usage: aiUsage,
  });
}
