// PROP-076 — AI BOM anomaly scan: finds structural problems and naming inconsistencies
// across the entire BOM (all organizations). Runs two passes:
//   1. Rule-based: definite findings (- copy active, empty assemblies, inactive children, orphans).
//   2. AI pass: variant inconsistency, naming drift, suspicious structures.
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

  // R4: Orphaned components (never a child, not a root type) — all lifecycle statuses.
  const topLevelTypes = new Set(["product_family", "finished_good"]);
  for (const c of components) {
    if (topLevelTypes.has(c.type)) continue;
    if (!(parentsOf[c.id] || []).length) {
      const isActive = c.lifecycle_status === "active";
      findings.push({
        severity: isActive ? "low" : "low",
        category: "orphan",
        component_id: c.id,
        component_name: c.name,
        part_number: c.part_number || null,
        description: `Component "${c.name}" (${c.type}, ${c.lifecycle_status}) is not used as a child anywhere in the BOM.`,
        suggestion: isActive
          ? "Link it into the appropriate assembly, mark it Inactive, or delete it if it was created by mistake."
          : "Safe to delete if it has no linked documents or cost data.",
      });
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

  // --- AI pass: variant consistency, naming drift, suspicious structures ---
  // Build a compact text representation of ALL components (all lifecycle states) and their children.
  const activeComps = components.filter(c => c.lifecycle_status === "active");

  const lines: string[] = [];
  for (const c of components) {
    const statusTag = c.lifecycle_status !== "active" ? `, ${c.lifecycle_status}` : "";
    const kids = (childrenOf[c.id] || [])
      .map(id => byId[id])
      .filter(Boolean)
      .map(k => {
        const ks = k.lifecycle_status !== "active" ? `, ${k.lifecycle_status}` : "";
        return `    - ${k.name} [${k.type}${ks}]`;
      })
      .join("\n");
    lines.push(`${c.name} [${c.type}${statusTag}] (PN: ${c.part_number || "—"}, make_or_buy: ${c.make_or_buy || "—"})` +
      (kids ? `\n${kids}` : ""));
  }
  const bomText = lines.join("\n\n");

  // Skip AI if BOM is completely empty.
  let aiAnomalies: Anomaly[] = [];
  let summary = `Rule-based scan found ${findings.length} issue(s).`;
  let aiUsage = { input_tokens: 0, output_tokens: 0 };

  if (components.length > 0) {
    const system = `You are a BOM quality analyst for a Swedish LED furniture manufacturer (Rushroom AB / VALCYRA).
You will receive the full BOM including both active and inactive components (lifecycle status is shown in brackets).
Your job: identify structural anomalies, naming inconsistencies, and missing patterns that suggest errors.

WHAT TO LOOK FOR:
1. Variant families (e.g. "Drawer Set - White" vs "Drawer Set - Grey") where one variant is missing a child the others have.
2. Sub-assemblies with suspiciously few children (e.g. only 1 child, which looks like a mistake).
3. Naming inconsistencies: a component that follows a different naming pattern from its siblings/cousins.
4. make_or_buy mismatch: sub_assembly not set to "assembled", purchased parts set to "manufactured", etc.
5. Active assemblies that share children with inactive assemblies — may indicate a copy was made active while the original was left inactive.
6. Any other pattern that suggests a configuration error.

Do NOT flag:
- Orphans, copy-components, inactive children, or empty assemblies (already checked by rule-based scan).
- Things that are obviously intentional (e.g. a product_family with no children is a container).

For each finding: use component_id and part_number from the data provided. If a finding applies to a family (not one component), set component_id and part_number to null and name the family in description.
Return at most 15 AI findings. Be specific and actionable.`;

    const userMsg = `BOM (${components.length} components, ${activeComps.length} active):\n\n${bomText}`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
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
        aiAnomalies = (parsed.anomalies || []).slice(0, 15).map((a: any) => ({
          severity: ["high", "medium", "low"].includes(a.severity) ? a.severity : "low",
          category: String(a.category || "ai_finding"),
          component_id: a.component_id || null,
          component_name: a.component_name || null,
          part_number: a.part_number || null,
          description: String(a.description || "").slice(0, 600),
          suggestion: String(a.suggestion || "").slice(0, 300),
        }));
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
