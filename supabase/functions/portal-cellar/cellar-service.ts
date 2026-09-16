// ============================================================================
// CELLAR integration service — EU Publications Office (publications.europa.eu)
//
// Reads EU legislation metadata + inter-directive relations from the public
// CELLAR SPARQL endpoint and REST content API (no auth), plus optional on-demand
// AI inference of implicit relations via Claude. Every network result is cached
// in the `cellar_cache` table for 7 days. All CELLAR access is rate-limited
// (max 5 concurrent), retried with exponential backoff on 429/503, and bounded
// by a 60s timeout — a failure degrades gracefully to null/[] so the portal
// keeps working even when CELLAR is unreachable.
//
// Usage (from index.ts):
//   import { createCellarService } from "./cellar-service.ts";
//   const cellar = createCellarService(db, ANTHROPIC_API_KEY);
//   await cellar.fetchDirectiveMetadata("32014L0035");
// ============================================================================

const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
const REST_BASE = "https://publications.europa.eu/resource/celex";
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT = 5;
const CLAUDE_MODEL = "claude-opus-4-8";

export type RelationType =
  | "requires" | "supplements" | "implements" | "amends"
  | "supersedes" | "references" | "conflicts_with" | "defines_terms_for";

export interface DirectiveMetadata {
  celexNumber: string;
  officialTitle: string;
  inForceDate: string | null;   // ISO date or null
  status: string;               // 'active' | 'repealed' | 'amended'
  eliUri: string | null;
  directiveType: string;        // 'directive' | 'regulation' | 'decision'
}
export interface CellarRelation {
  targetCelex: string;
  relationType: RelationType;
  confidence: number;
  source: "cellar_sparql";
}
export interface AknReference {
  sourceClauses: string;        // parent eId / article reference
  targetCelex: string;
  targetClauseRef: string;
  rawText: string;
}
export interface ImplicitRelation {
  sourceClauseRef: string;
  targetCelex: string;
  targetClauseRef: string;
  relationType: RelationType;
  relationDescription: string;
  confidence: number;
}

const CELEX_RE = /^[0-9][0-9A-Z]{2,}$/; // loose CELEX shape, e.g. 32014L0035
const isCelex = (s: string) => typeof s === "string" && CELEX_RE.test(s.trim().toUpperCase());
const cleanCelex = (s: string) => String(s || "").trim().toUpperCase();

// CELEX 5th char encodes the sector document type: L=directive, R=regulation, D=decision.
function directiveTypeFromCelex(celex: string): string {
  const t = celex.charAt(4);
  if (t === "L") return "directive";
  if (t === "R") return "regulation";
  if (t === "D") return "decision";
  return "other";
}

// ---- tiny concurrency limiter (max 5 in-flight CELLAR requests) ------------
function makeLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => { active--; const fn = queue.shift(); if (fn) fn(); };
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try { return await task(); }
    finally { next(); }
  };
}

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// Fetch with a hard timeout + exponential backoff on 429/503.
async function fetchWithRetry(url: string, init: RequestInit, retries = 4): Promise<Response> {
  let attempt = 0;
  // deno-lint-ignore no-explicit-any
  let lastErr: any = null;
  while (attempt <= retries) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 429 || res.status === 503) {
        if (attempt === retries) return res;
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        await sleep(Math.max(retryAfter * 1000, 500 * Math.pow(2, attempt)));
        attempt++; continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt === retries) throw e;
      await sleep(500 * Math.pow(2, attempt));
      attempt++;
    }
  }
  throw lastErr ?? new Error("CELLAR request failed");
}

// ---- factory ---------------------------------------------------------------
// deno-lint-ignore no-explicit-any
export function createCellarService(db: any, anthropicKey: string) {
  const limit = makeLimiter(MAX_CONCURRENT);

  // ---- 7-day cache in the cellar_cache table -------------------------------
  async function getCache(celex: string, queryType: string): Promise<unknown | null> {
    try {
      const { data } = await db.from("cellar_cache")
        .select("result_jsonb, fetched_at").eq("celex_number", celex).eq("query_type", queryType).maybeSingle();
      if (!data) return null;
      const age = Date.now() - new Date(data.fetched_at).getTime();
      if (age > CACHE_TTL_MS) return null;
      return data.result_jsonb ?? null;
    } catch { return null; }
  }
  async function putCache(celex: string, queryType: string, result: unknown): Promise<void> {
    try {
      await db.from("cellar_cache").upsert(
        { celex_number: celex, query_type: queryType, result_jsonb: result, fetched_at: new Date().toISOString() },
        { onConflict: "celex_number,query_type" },
      );
    } catch { /* cache is best-effort */ }
  }

  // ---- SPARQL SELECT → bindings array --------------------------------------
  // deno-lint-ignore no-explicit-any
  async function sparqlSelect(query: string): Promise<any[]> {
    const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=application%2Fsparql-results%2Bjson`;
    const res = await limit(() => fetchWithRetry(url, {
      headers: { "Accept": "application/sparql-results+json", "User-Agent": "RushroomCompliancePortal/1.0" },
    }));
    if (!res.ok) throw new Error(`SPARQL ${res.status}`);
    const j = await res.json();
    return j?.results?.bindings ?? [];
  }

  // ==========================================================================
  // fetchDirectiveMetadata — title, in-force date, status, ELI, doc type
  // ==========================================================================
  async function fetchDirectiveMetadata(celexNumber: string): Promise<DirectiveMetadata | null> {
    const celex = cleanCelex(celexNumber);
    if (!isCelex(celex)) return null;
    const cached = await getCache(celex, "metadata");
    if (cached) return cached as DirectiveMetadata;

    const query = `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX dc: <http://purl.org/dc/elements/1.1/>
SELECT ?title ?date ?eli ?inforce WHERE {
  ?work cdm:resource_legal_id_celex ?celex .
  FILTER(str(?celex) = "${celex}")
  OPTIONAL { ?exp cdm:expression_belongs_to_work ?work ;
                  cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> ;
                  cdm:expression_title ?title . }
  OPTIONAL { ?work cdm:work_date_document ?date . }
  OPTIONAL { ?work cdm:resource_legal_eli ?eli . }
  OPTIONAL { ?work cdm:resource_legal_in-force ?inforce . }
} LIMIT 1`;
    try {
      const rows = await sparqlSelect(query);
      const r = rows[0];
      const meta: DirectiveMetadata = {
        celexNumber: celex,
        officialTitle: r?.title?.value || "",
        inForceDate: r?.date?.value ? String(r.date.value).slice(0, 10) : null,
        status: (r?.inforce && /false/i.test(String(r.inforce.value))) ? "repealed" : "active",
        eliUri: r?.eli?.value || null,
        directiveType: directiveTypeFromCelex(celex),
      };
      await putCache(celex, "metadata", meta);
      return meta;
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // fetchDirectiveRelations — legal-basis / implements / cites triples
  // ==========================================================================
  const PREDICATE_RELATION: Record<string, RelationType> = {
    "resource_legal_based_on": "requires",
    "resource_legal_implements": "implements",
    "resource_legal_amends": "amends",
    "resource_legal_repeals": "supersedes",
    "work_cites_work": "references",
  };
  async function fetchDirectiveRelations(celexNumber: string): Promise<CellarRelation[]> {
    const celex = cleanCelex(celexNumber);
    if (!isCelex(celex)) return [];
    const cached = await getCache(celex, "relations");
    if (cached) return cached as CellarRelation[];

    const query = `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT DISTINCT ?pred ?targetCelex WHERE {
  ?work cdm:resource_legal_id_celex ?c . FILTER(str(?c) = "${celex}")
  VALUES ?pred {
    cdm:resource_legal_based_on
    cdm:resource_legal_implements
    cdm:resource_legal_amends
    cdm:resource_legal_repeals
    cdm:work_cites_work
  }
  ?work ?pred ?target .
  ?target cdm:resource_legal_id_celex ?targetCelex .
} LIMIT 500`;
    try {
      const rows = await sparqlSelect(query);
      const seen = new Set<string>();
      const rels: CellarRelation[] = [];
      for (const row of rows) {
        const predUri = String(row?.pred?.value || "");
        const predKey = predUri.split("#").pop() || predUri.split("/").pop() || "";
        const targetCelex = cleanCelex(row?.targetCelex?.value || "");
        const relationType = PREDICATE_RELATION[predKey] || "references";
        if (!isCelex(targetCelex) || targetCelex === celex) continue;
        const k = `${relationType}|${targetCelex}`;
        if (seen.has(k)) continue;
        seen.add(k);
        rels.push({ targetCelex, relationType, confidence: 1.0, source: "cellar_sparql" });
      }
      await putCache(celex, "relations", rels);
      return rels;
    } catch {
      return [];
    }
  }

  // ==========================================================================
  // fetchDirectiveFullText — parse Akoma Ntoso / XHTML <ref> cross-references
  // ==========================================================================
  async function fetchDirectiveFullText(celexNumber: string): Promise<AknReference[]> {
    const celex = cleanCelex(celexNumber);
    if (!isCelex(celex)) return [];
    const cached = await getCache(celex, "fulltext");
    if (cached) return cached as AknReference[];

    let xml = "";
    try {
      const res = await limit(() => fetchWithRetry(`${REST_BASE}/${celex}`, {
        headers: { "Accept": "application/xhtml+xml, text/html;q=0.9, application/xml;q=0.8", "User-Agent": "RushroomCompliancePortal/1.0" },
      }));
      if (!res.ok) { await putCache(celex, "fulltext", []); return []; }
      xml = await res.text();
    } catch {
      return [];
    }

    const refs = parseAknRefs(xml, celex);
    await putCache(celex, "fulltext", refs);
    return refs;
  }

  // ==========================================================================
  // extractImplicitRelations — on-demand Claude inference (never automatic)
  // ==========================================================================
  const INFER_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
      relations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            sourceClauseRef: { type: "string" },
            targetCelex: { type: "string" },
            targetClauseRef: { type: "string" },
            relationType: {
              type: "string",
              enum: ["requires", "supplements", "implements", "amends", "supersedes", "references", "conflicts_with", "defines_terms_for"],
            },
            relationDescription: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["sourceClauseRef", "targetCelex", "targetClauseRef", "relationType", "relationDescription", "confidence"],
        },
      },
    },
    required: ["relations"],
  };
  async function extractImplicitRelations(celexNumber: string, articleText: string): Promise<ImplicitRelation[]> {
    const celex = cleanCelex(celexNumber);
    if (!anthropicKey || !articleText || articleText.trim().length < 40) return [];
    const system = `You analyse EU legislation to surface IMPLICIT relationships between directives/regulations that are not captured by explicit cross-reference tags. Given the text of an article from CELEX ${celex}, identify only genuine relationships to OTHER EU legal acts (by CELEX number, e.g. 32014L0030), such as:
- requires: compliance with this act requires compliance with another
- supplements / implements / amends / supersedes
- references: mentions another act
- conflicts_with: an apparent tension
- defines_terms_for: provides definitions relied on by another act
For each, give the source article reference, the best-known target CELEX (only if you are confident of the exact number — otherwise omit the relation), the target clause if stated, a one-line description, and a confidence 0.0–1.0 reflecting your certainty. Do NOT invent CELEX numbers. Return an empty array if there are no confident implicit relations.`;
    try {
      const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 2000,
          thinking: { type: "adaptive" },
          output_config: { effort: "low", format: { type: "json_schema", schema: INFER_SCHEMA } },
          system,
          messages: [{ role: "user", content: [{ type: "text", text: `Source CELEX: ${celex}\n\nArticle text:\n${articleText.slice(0, 12000)}` }] }],
        }),
      }, 2);
      const j = await res.json();
      if (!res.ok || j.stop_reason === "refusal") return [];
      const textBlock = (j.content || []).find((b: { type: string }) => b.type === "text");
      const parsed = JSON.parse(textBlock?.text || "{}");
      const out: ImplicitRelation[] = [];
      for (const rel of (parsed.relations || [])) {
        const targetCelex = cleanCelex(rel.targetCelex || "");
        if (!isCelex(targetCelex) || targetCelex === celex) continue;
        out.push({
          sourceClauseRef: String(rel.sourceClauseRef || "").slice(0, 120),
          targetCelex,
          targetClauseRef: String(rel.targetClauseRef || "").slice(0, 120),
          relationType: rel.relationType,
          relationDescription: String(rel.relationDescription || "").slice(0, 500),
          confidence: Math.max(0, Math.min(1, Number(rel.confidence) || 0.5)),
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  return {
    fetchDirectiveMetadata,
    fetchDirectiveRelations,
    fetchDirectiveFullText,
    extractImplicitRelations,
    // helpers exposed for the endpoints
    isCelex,
    cleanCelex,
    directiveTypeFromCelex,
  };
}

// ---- Akoma Ntoso / XHTML <ref> parsing (regex-based; no DOM in Deno) --------
// EUR-Lex renderings express cross-references as either Akoma Ntoso <ref
// href="..."> elements or plain anchors whose href carries a CELEX/ELI. We pull
// the target CELEX out of the href and attribute it to the nearest preceding
// article/eId heading so a relation can be tied to a specific clause.
export function parseAknRefs(xml: string, sourceCelex: string): AknReference[] {
  const out: AknReference[] = [];
  const seen = new Set<string>();
  if (!xml) return out;

  // Index the character offsets of article / eId anchors so we can find the
  // nearest heading that precedes each reference.
  const headings: Array<{ pos: number; label: string }> = [];
  const headingRe = /(?:eId|id)="([^"]*(?:art|article|point|para)[^"]*)"|>\s*(Article\s+\d+[a-z]?)\b/gi;
  let hm: RegExpExecArray | null;
  while ((hm = headingRe.exec(xml)) !== null) {
    const label = (hm[2] || hm[1] || "").replace(/_/g, " ").trim();
    if (label) headings.push({ pos: hm.index, label: /^article/i.test(label) ? label : `Article ${label.replace(/^.*?(\d+[a-z]?).*$/i, "$1")}` });
  }
  const headingBefore = (pos: number): string => {
    let best = "";
    for (const h of headings) { if (h.pos <= pos) best = h.label; else break; }
    return best;
  };

  // Match <ref href="..."> … </ref> and <a href="..."> … </a>.
  const refRe = /<(?:ref|a)\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/(?:ref|a)>/gi;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(xml)) !== null) {
    const href = m[1];
    const rawText = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    const targetCelex = celexFromHref(href);
    if (!targetCelex || targetCelex.toUpperCase() === sourceCelex.toUpperCase()) continue;
    const sourceClauses = headingBefore(m.index);
    // Try to read a target article out of the visible link text ("Article 5 of …").
    const tArt = /article\s+(\d+[a-z]?)/i.exec(rawText);
    const targetClauseRef = tArt ? `Article ${tArt[1]}` : "";
    const key = `${sourceClauses}|${targetCelex}|${targetClauseRef}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sourceClauses, targetCelex, targetClauseRef, rawText });
    if (out.length >= 400) break;
  }
  return out;
}

// Extract a CELEX number from a CELLAR/EUR-Lex href in any of its common shapes.
function celexFromHref(href: string): string | null {
  if (!href) return null;
  const h = decodeURIComponent(href);
  // .../celex/32014L0030 | CELEX:32014L0030 | uri=CELEX:32014L0030
  let m = /celex[:/]\s*([0-9][0-9A-Za-z]{6,})/i.exec(h);
  if (m) return m[1].toUpperCase();
  // ELI form: /eli/dir/2014/30/oj → build a directive CELEX (best-effort)
  m = /\/eli\/(dir|reg|dec)\/(\d{4})\/(\d+)\b/i.exec(h);
  if (m) {
    const kind = m[1].toLowerCase() === "reg" ? "R" : m[1].toLowerCase() === "dec" ? "D" : "L";
    return `3${m[2]}${kind}${String(m[3]).padStart(4, "0")}`.toUpperCase();
  }
  return null;
}
