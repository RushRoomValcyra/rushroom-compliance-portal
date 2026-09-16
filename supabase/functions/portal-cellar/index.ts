// ============================================================================
// portal-cellar — EU Publications Office (CELLAR) SPARQL integration.
//
// Split out of portal-api (2026-09-16). The CELLAR service was instantiated at
// MODULE SCOPE in portal-api, so every login and every CRUD call loaded it.
// These three actions are long-running by nature (external SPARQL + AI relation
// inference) and have no business sharing a bundle with the hot path.
//
// Contract unchanged: same action names, shapes, status codes, session token
// and tenant isolation.
//
//   supabase functions deploy portal-cellar --no-verify-jwt
// ============================================================================
import { serve, json, type Ctx } from "../_shared/handler.ts";
import { db, ANTHROPIC_API_KEY, SCAN_MODEL } from "../_shared/env.ts";
import { eq } from "../_shared/auth.ts";
import { usagePeriod } from "../_shared/domain.ts";
import { createCellarService } from "./cellar-service.ts";

const cellar = createCellarService(db, ANTHROPIC_API_KEY);

const usageOf = (j: any) => ({
  model: j?.model || SCAN_MODEL,
  input_tokens: j?.usage?.input_tokens ?? 0,
  output_tokens: j?.usage?.output_tokens ?? 0,
  cache_read_input_tokens: j?.usage?.cache_read_input_tokens ?? 0,
});

serve({
  fn: "portal-cellar",
  handle: async (ctx: Ctx): Promise<Response | null> => {
    const { body, action, session, role, organizationId, tdb, timer } = ctx;

    const meterAi = async (aj: any) => {
      try {
        const u = usageOf(aj);
        if (!((u.input_tokens || 0) + (u.output_tokens || 0))) return;
        await db.from("ai_usage_events").insert({
          organization_id: organizationId, period: usagePeriod(), action,
          input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
        });
      } catch { /* metering must never break an action */ }
    };

  if (action === "addDirective") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const celexNumber = cellar.cleanCelex(String(body.celexNumber ?? ""));
    const shortName = String(body.shortName ?? "").trim().slice(0, 40);
    if (!cellar.isCelex(celexNumber)) return json({ error: "Enter a valid CELEX number (e.g. 32014L0035)." }, 400);
    const meta = await cellar.fetchDirectiveMetadata(celexNumber); // may be null if CELLAR is unreachable
    const row: Record<string, unknown> = {
      celex_number: celexNumber,
      short_name: shortName || (meta?.officialTitle ? meta.officialTitle.slice(0, 24) : celexNumber),
      official_title: meta?.officialTitle || null,
      directive_type: meta?.directiveType || cellar.directiveTypeFromCelex(celexNumber),
      status: meta?.status || "active",
      in_force_date: meta?.inForceDate || null,
      eur_lex_url: `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${celexNumber}`,
      applies_to_company: body.appliesToCompany === true,
    };
    const { data, error } = await db.from("eu_directives").upsert(row, { onConflict: "celex_number" }).select("id, official_title").maybeSingle();
    if (error) return json({ error: (/does not exist|schema cache|Could not find the table/i.test(error.message)) ? "The directive tables aren't set up yet — run the directive SQL first." : error.message }, 500);
    return json({ ok: true, id: data?.id, title: data?.official_title || row.official_title || celexNumber });
  }

  if (action === "syncDirectiveRelations") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const directiveId = String(body.directiveId ?? "").trim();
    if (!directiveId) return json({ error: "directiveId required" }, 400);
    const { data: dir } = await db.from("eu_directives").select("*").eq("id", directiveId).maybeSingle();
    if (!dir) return json({ error: "Directive not found" }, 404);
    const { data: allDirs } = await db.from("eu_directives").select("id, celex_number");
    const idByCelex = new Map<string, string>();
    for (const d of allDirs || []) idByCelex.set(String(d.celex_number).toUpperCase(), d.id);

    let rels: any[] = [], refs: any[] = [];
    try { rels = await cellar.fetchDirectiveRelations(dir.celex_number); } catch { /* offline */ }
    try { refs = await cellar.fetchDirectiveFullText(dir.celex_number); } catch { /* offline */ }
    const relationsFound = rels.length + refs.length;
    let inserted = 0, skipped = 0;
    const upsertRel = async (row: Record<string, unknown>) => {
      const { error } = await db.from("directive_relations").upsert(row, { onConflict: "source_directive_id,target_celex,relation_type,source_clause_ref", ignoreDuplicates: true });
      if (error && error.code !== "23505") skipped++; else inserted++;
    };
    for (const r of rels) {
      await upsertRel({ source_directive_id: directiveId, target_directive_id: idByCelex.get(r.targetCelex) || null, target_celex: r.targetCelex, source_clause_ref: "", target_clause_ref: "", relation_type: r.relationType, relation_description: "", source: "cellar_sparql", confidence: r.confidence, verified: true });
    }
    for (const ref of refs) {
      const tc = String(ref.targetCelex).toUpperCase();
      await upsertRel({ source_directive_id: directiveId, target_directive_id: idByCelex.get(tc) || null, target_celex: tc, source_clause_ref: String(ref.sourceClauses || "").slice(0, 120), target_clause_ref: String(ref.targetClauseRef || "").slice(0, 120), relation_type: "references", relation_description: String(ref.rawText || "").slice(0, 500), source: "akn_ref_element", confidence: 1.0, verified: true });
    }
    return json({ ok: true, relationsFound, inserted, skipped, offline: relationsFound === 0 });
  }

  if (action === "inferDirectiveRelations") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    if (!ANTHROPIC_API_KEY) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY." }, 400);
    const directiveId = String(body.directiveId ?? "").trim();
    if (!directiveId) return json({ error: "directiveId required" }, 400);
    const { data: dir } = await db.from("eu_directives").select("*").eq("id", directiveId).maybeSingle();
    if (!dir) return json({ error: "Directive not found" }, 404);
    const { data: allDirs } = await db.from("eu_directives").select("id, celex_number");
    const idByCelex = new Map<string, string>();
    for (const d of allDirs || []) idByCelex.set(String(d.celex_number).toUpperCase(), d.id);
    // Fetch the directive text (best-effort) and let Claude surface implicit relations.
    let text = "";
    try {
      const res = await fetch(`https://publications.europa.eu/resource/celex/${dir.celex_number}`, { headers: { Accept: "text/html, application/xhtml+xml" } });
      if (res.ok) text = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    } catch { /* offline */ }
    if (!text) return json({ error: "Couldn't fetch the directive text from CELLAR to infer relations." }, 502);
    const inferred = await cellar.extractImplicitRelations(dir.celex_number, text.slice(0, 12000));
    let inserted = 0;
    for (const rel of inferred) {
      const { error } = await db.from("directive_relations").upsert({
        source_directive_id: directiveId, target_directive_id: idByCelex.get(rel.targetCelex) || null, target_celex: rel.targetCelex,
        source_clause_ref: rel.sourceClauseRef || "", target_clause_ref: rel.targetClauseRef || "", relation_type: rel.relationType,
        relation_description: rel.relationDescription, source: "ai_inferred", confidence: rel.confidence, verified: false,
      }, { onConflict: "source_directive_id,target_celex,relation_type,source_clause_ref", ignoreDuplicates: true });
      if (!error || error.code === "23505") inserted++;
    }
    return json({ ok: true, inferred: inferred.length, inserted });
  }

    return null;
  },
});
