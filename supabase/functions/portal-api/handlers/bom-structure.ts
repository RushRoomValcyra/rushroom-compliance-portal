// PROP-067 — BOM structure rules: which parent may hold which child.
// ============================================================================
// The rule itself lives in the database (migration 0040: bom_child_rule and
// the two triggers), so every path — add, move, copy, materialise, a change
// of Type or Sourcing — obeys it whether or not this file is consulted.
//
// This file holds three things the API needs around that rule:
//   * bomChildRule  — the same matrix, so listMoveTargets only offers
//                     destinations the database will accept;
//   * bomRuleError  — the database's refusals turned into sentences;
//   * wrapInPrepared — the "we fit it" path of the +child dialog (§5b).
//
// Three copies of the matrix exist (SQL, this file, assets/bom-structure.js).
// tests/bom-structure-rules.test.mjs fails if they disagree.
import { json } from "../../_shared/http.ts";
import { db } from "../../_shared/env.ts";

// NULL-equivalent: returns null when allowed, otherwise the reason it is not.
// Keep in step with bom_child_rule() in supabase/migrations/0040.
export function bomChildRule(type: string, makeOrBuy: string, isReference: boolean): string | null {
  if (type === "finished_good") {
    return "A finished good is bought and passed on untouched — it never holds children.";
  }
  if (isReference && (makeOrBuy !== "purchased" || type === "phantom_assembly" || type === "product_family")) {
    return "A reference child records what is inside something we buy; this parent is not bought complete.";
  }
  if (!isReference && makeOrBuy === "purchased" && ["part", "raw_material", "spare_part", "sub_assembly"].includes(type)) {
    return "This is bought complete. Something we fit goes into its Prepared wrapper; something inside it as delivered is a reference child.";
  }
  if (!isReference && makeOrBuy === "assembled" && ["part", "raw_material", "spare_part"].includes(type)) {
    return "A part we put together is a sub-assembly. Change its Type first.";
  }
  return null;
}

// The triggers raise "BOM_RULE: <name>: <reason>"; the two CHECKs raise their
// constraint names. Anything else is not ours to reword.
export function bomRuleError(raw: string): string | null {
  const m = raw.match(/BOM_RULE:\s*([\s\S]*)$/);
  if (m) return m[1].trim();
  if (raw.includes("bom_edges_reference_unstaged")) {
    return "A reference child arrives fitted inside its parent, so it has no Hub or Site.";
  }
  if (raw.includes("bom_components_finished_good_purchased")) {
    return "A finished good is always bought: its Sourcing must be Purchased.";
  }
  return null;
}

// "We fit it to this part": build a Prepared sub-assembly around a bought part.
// One database function, so it is a single transaction — the wrapper, its
// revision A, the re-pointed parent links and the part ×1 inside either all
// exist or none do. Scope is the assembly the user stands in (parent_id),
// or every assembly that uses the part (replace_everywhere), or none at all
// (no parent_id: wrapping from the part's own panel).
export async function wrapInPrepared(
  body: Record<string, unknown>,
  ctx: { organizationId: string; uid: string | null },
): Promise<Response> {
  const { part_id, parent_id, replace_everywhere, name } = body ?? {};
  if (!part_id) return json({ error: "part_id required" }, 400);
  const { data, error } = await db.rpc("bom_wrap_in_prepared", {
    p_org: ctx.organizationId,
    p_part: String(part_id),
    p_parent: parent_id ? String(parent_id) : null,
    p_all: replace_everywhere === true,
    p_name: name ? String(name).trim().slice(0, 200) : null,
    p_user: ctx.uid,
  });
  if (error) return json({ error: bomRuleError(error.message) ?? error.message }, 400);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return json({ error: "Wrapping returned no result" }, 500);
  return json({
    wrapper_id: row.wrapper_id,
    part_number: row.wrapper_part_number,
    name: row.wrapper_name,
    relinked: row.relinked,
  });
}
