// Pure core of the Operations → PIM single-article lookup (contract v1, see
// docs/PLANNER_MAPPINGS.md): no HTTP, secrets, database or tenant access, so
// the contract is executable with fixture tests like the planner resolver.

export const ARTICLE_LOOKUP_MAX_LENGTH = 200;

// Product families are dynamic BOMs and phantom assemblies are structure only:
// neither is a physical article that can be received or stocked.
export const ARTICLE_LOOKUP_EXCLUDED_TYPES = ["product_family", "phantom_assembly"];

/** The article number as asked for, trimmed; "" when it is missing or not text. */
export function normaliseArticleNumber(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Finds one article by exact article number, ignoring case and surrounding
 * spaces. Returns { status: "found", article }, { status: "not_found" }, or
 * { status: "ambiguous" } when two components share the number in any case.
 */
export function matchArticle(components, articleNumber) {
  const wanted = normaliseArticleNumber(articleNumber).toUpperCase();
  const matches = components.filter((row) =>
    !ARTICLE_LOOKUP_EXCLUDED_TYPES.includes(row.type)
    && String(row.part_number ?? "").trim().toUpperCase() === wanted);

  if (!wanted || matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) return { status: "ambiguous" };

  const row = matches[0];
  const number = String(row.part_number).trim();
  return {
    status: "found",
    article: {
      pim_component_id: row.id,
      article_number: number,
      name: String(row.name ?? "").trim() || number,
      unit: String(row.unit_of_measure ?? "").trim() || "ea",
    },
  };
}

/** Escapes % _ and \ so an article number can be matched with ilike as an exact pattern. */
export function exactIlikePattern(articleNumber) {
  return normaliseArticleNumber(articleNumber).replace(/[\\%_]/g, (character) => `\\${character}`);
}
