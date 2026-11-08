// PROP-076 — AI BOM anomaly scan: finds structural problems and naming inconsistencies
// across the entire BOM (all organizations). Runs two passes:
//   1. Rule-based deterministic findings:
//      R1  copy_component   — name contains "- copy"
//      R2  empty_assembly   — assembly/finished_good with no children
//      R3  inactive_child   — active assembly referencing inactive/discontinued child
//      R5  duplicate_child  — same child linked twice under one parent
//      R6  duplicate_name   — distinct components sharing the same name
//      R7  mob_violation    — make_or_buy contradicts component type
//      R8  duplicate_pn     — distinct active components sharing the same part number
//      R9  circular_ref     — cycle in the parent→child graph (Kahn's algorithm)
//      R10 missing_pn       — active assembly/finished_good with no part number
//      R11 variant_gap      — size-variant family (S/M/L) missing one or more sizes
//   2. AI pass (SCAN_MODEL/opus): colour-gap detection, child-count mismatches,
//      naming drift, and other structural patterns not caught above.
//      Input: structured JSON of pre-grouped variant families.
//      All AI-returned component_ids validated against loaded BOM before returning.
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

  // Pre-group active components into variant families (used by R11 and the AI pass).
  const activeComps = components.filter(c => c.lifecycle_status === "active");
  const familyMap: Record<string, any[]> = {};
  for (const c of activeComps) {
    const key = variantFamilyKey(c.name || "");
    (familyMap[key] ||= []).push(c);
  }

  const findings: Anomaly[] = [];
  const assemblyTypes = new Set(["sub_assembly", "finished_good", "phantom_assembly"]);

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
    if (!c.make_or_buy) continue;
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

  // R8: Distinct active components sharing the same part number.
  const byPN: Record<string, any[]> = {};
  for (const c of components) {
    if (!c.part_number || !c.part_number.trim()) continue;
    const key = c.part_number.trim().toLowerCase();
    (byPN[key] ||= []).push(c);
  }
  for (const group of Object.values(byPN)) {
    if (group.length < 2) continue;
    const anyActive = group.some(c => c.lifecycle_status === "active");
    if (!anyActive) continue;
    findings.push({
      severity: "high",
      category: "duplicate_pn",
      component_id: null,
      component_name: null,
      part_number: group[0].part_number,
      description: `${group.length} components share part number "${group[0].part_number}": ${group.map(c => `"${c.name}" (${c.lifecycle_status})`).join(", ")}.`,
      suggestion: "Part numbers must be unique. Assign a distinct PN to each component or merge duplicate entries.",
    });
  }

  // R9: Circular BOM references — Kahn's topological sort; unvisited nodes are in a cycle.
  const inDeg: Record<string, number> = {};
  for (const c of components) inDeg[c.id] = 0;
  for (const e of edges) {
    if (byId[e.parent_id] && byId[e.child_id]) {
      inDeg[e.child_id] = (inDeg[e.child_id] || 0) + 1;
    }
  }
  const topoQueue: string[] = Object.entries(inDeg).filter(([, d]) => d === 0).map(([id]) => id);
  const topoVisited = new Set<string>(topoQueue);
  while (topoQueue.length) {
    const id = topoQueue.shift()!;
    for (const childId of (childrenOf[id] || [])) {
      if (!byId[childId]) continue;
      inDeg[childId]--;
      if (inDeg[childId] === 0 && !topoVisited.has(childId)) {
        topoVisited.add(childId);
        topoQueue.push(childId);
      }
    }
  }
  for (const c of components) {
    if (!topoVisited.has(c.id)) {
      findings.push({
        severity: "high",
        category: "circular_ref",
        component_id: c.id,
        component_name: c.name,
        part_number: c.part_number || null,
        description: `"${c.name}" is part of a circular BOM reference — the component graph contains a cycle.`,
        suggestion: "Remove the edge that closes the cycle. A component cannot be a direct or indirect ancestor of itself.",
      });
    }
  }

  // R10: Active assembly or finished_good with no part number.
  const pnRequiredTypes = new Set(["sub_assembly", "phantom_assembly", "finished_good"]);
  for (const c of components) {
    if (!pnRequiredTypes.has(c.type)) continue;
    if (c.lifecycle_status !== "active") continue;
    if (!c.part_number || !c.part_number.trim()) {
      findings.push({
        severity: "medium",
        category: "missing_pn",
        component_id: c.id,
        component_name: c.name,
        part_number: null,
        description: `Active ${c.type} "${c.name}" has no part number.`,
        suggestion: "Assign a part number so this assembly can be referenced in procurement, work orders, and cost rollups.",
      });
    }
  }

  // R11: Variant family size gaps — if a family has 2 of {S, M, L}, the third is expected.
  const ALL_SIZES = ["S", "M", "L"];
  for (const [, members] of Object.entries(familyMap)) {
    if (members.length < 2) continue;
    const memberSizes = members.map((c: any) => {
      const m = (c.name || "").match(/\b(S|M|L)\b/);
      return { c, size: m ? m[1] : null };
    });
    const presentSizes = new Set(memberSizes.filter((x: any) => x.size).map((x: any) => x.size as string));
    if (presentSizes.size < 2) continue; // need at least 2 to infer the full family
    for (const size of ALL_SIZES) {
      if (!presentSizes.has(size)) {
        const example = members[0];
        const exampleName = (example.name || "").replace(/\b(S|M|L)\b/, size);
        findings.push({
          severity: "medium",
          category: "variant_gap",
          component_id: null,
          component_name: null,
          part_number: null,
          description: `Variant family "${variantFamilyKey(example.name || "")}" has sizes ${[...presentSizes].sort().join(", ")} but is missing size ${size}. Expected member: "${exampleName}".`,
          suggestion: `Create the missing size-${size} variant to complete the family, or confirm this product intentionally has no ${size} option.`,
        });
      }
    }
  }

  // --- AI pass: colour gaps, child-count mismatches, naming drift, suspicious structures ---
  // Families and singletons are pre-computed above.
  const families = Object.entries(familyMap)
    .filter(([, members]) => members.length >= 2)
    .map(([pattern, members]) => ({
      pattern,
      variants: members.map((c: any) => ({
        id: c.id,
        name: c.name,
        pn: c.part_number || null,
        type: c.type,
        mob: c.make_or_buy || null,
        child_count: (childrenOf[c.id] || []).length,
        children: (childrenOf[c.id] || []).slice(0, 15).map((cid: string) => byId[cid]?.name).filter(Boolean),
      })),
    }));

  const singletons = Object.entries(familyMap)
    .filter(([, members]) => members.length === 1)
    .map(([, members]) => members[0])
    .filter((c: any) => assemblyTypes.has(c.type))
    .map((c: any) => ({
      id: c.id,
      name: c.name,
      pn: c.part_number || null,
      type: c.type,
      mob: c.make_or_buy || null,
      child_count: (childrenOf[c.id] || []).length,
      children: (childrenOf[c.id] || []).slice(0, 10).map((cid: string) => byId[cid]?.name).filter(Boolean),
    }));

  const structuredInput = { families, singletons };

  let aiAnomalies: Anomaly[] = [];
  let summary = `Rule-based scan found ${findings.length} issue(s).`;
  let aiUsage = { input_tokens: 0, output_tokens: 0 };

  if (components.length > 0) {
    const system = `You are a BOM quality analyst for a Swedish LED furniture manufacturer (Rushroom AB / VALCYRA).
You will receive BOM data grouped into VARIANT FAMILIES (components sharing the same name pattern except for size or colour tokens) and SINGLETON ASSEMBLIES.

Your job: identify gaps and inconsistencies NOT already caught by the rule-based scan.

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

1. COLOUR GAPS — a family has White and Black but is missing Grey (or vice versa). Do NOT flag S/M/L size gaps — those are handled by the rule-based scan.
2. CHILD COUNT MISMATCH — siblings in a family have different child counts without an obvious reason.
3. CHILD TYPE MISMATCH — one variant has a child of a different type or name pattern than its siblings.
4. SINGLETON ASSEMBLIES — an active assembly appears to be a variant with no siblings; flag only if the name contains a colour token (not a size token — size gaps are covered above).
5. NAMING DRIFT — a component name does not follow the established pattern for its family (capitalisation, extra word, missing token).
6. SUSPICIOUS STRUCTURE — any other anomaly the rules above could not catch.

DO NOT flag:
- Size gaps (S/M/L) — handled by rule R11.
- Orphans, copy-components, inactive children, empty assemblies, duplicate names, duplicate children,
  make_or_buy violations, duplicate part numbers, circular refs, or missing part numbers — all in the rule-based pass.
- product_family or finished_good components with no siblings (by design).

For each finding: use the exact id from the data provided as component_id.
If a finding applies to a whole family, set component_id to null and describe the family in component_name.
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
