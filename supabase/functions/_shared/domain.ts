// Domain helpers needed by BOTH the lightweight portal-api and the heavy
// functions. Each takes `tdb` as a parameter, so they carry no client state and
// stay tenant-scoped by whatever the caller passes in.

/** Billing/usage period key, 'YYYY-MM'. */
export const usagePeriod = () => new Date().toISOString().slice(0, 7);

export async function buildComplianceGraph(tdb: any, scope: string, passportId: string | null): Promise<{ nodes: any[]; edges: any[]; gaps: any[] }> {
  let directives: any[] = [];
  const applicabilityByDir = new Map<string, string>();
  if (scope === "product" && passportId) {
    const { data: appl } = await tdb("product_directive_applicability").select("*").eq("passport_id", passportId);
    for (const a of appl || []) applicabilityByDir.set(a.directive_id, a.applicability_status);
    const dirIds = (appl || []).filter((a: any) => a.applicability_status !== "not_applicable").map((a: any) => a.directive_id);
    if (dirIds.length) { const { data } = await db.from("eu_directives").select("*").in("id", dirIds); directives = data || []; }
  } else if (scope === "company") {
    const { data } = await db.from("eu_directives").select("*").eq("applies_to_company", true);
    directives = data || [];
  } else {
    // "all" — every directive already in the platform's registry, pre-loaded.
    const { data } = await db.from("eu_directives").select("*");
    directives = data || [];
  }
  const { data: allDirs } = await db.from("eu_directives").select("id, celex_number, short_name, applies_to_company, status, directive_type, official_title");
  const regById = new Map<string, any>(); const regByCelex = new Map<string, any>();
  for (const d of allDirs || []) { regById.set(d.id, d); regByCelex.set(String(d.celex_number).toUpperCase(), d); }
  const nodeIds = new Set(directives.map((d) => d.id));

  const nodes: any[] = [];
  for (const d of directives) {
    const cov = await coverageForDirective(tdb, d);
    nodes.push({
      id: d.id, celex: d.celex_number, shortName: d.short_name, title: d.official_title || "",
      status: d.status || "active", directiveType: d.directive_type || "", appliesToCompany: !!d.applies_to_company,
      applicabilityStatus: applicabilityByDir.get(d.id) || null, complianceCoverage: cov.coverage_pct, coverage: cov,
    });
  }

  let rels: any[] = [];
  if (nodeIds.size) { const { data } = await db.from("directive_relations").select("*").in("source_directive_id", [...nodeIds]); rels = data || []; }
  const edges: any[] = []; const gapMap = new Map<string, any>();
  for (const r of rels) {
    const targetInScope = r.target_directive_id && nodeIds.has(r.target_directive_id);
    if (targetInScope) {
      edges.push({
        id: r.id, source: r.source_directive_id, target: r.target_directive_id, relationType: r.relation_type,
        clauses: { source: r.source_clause_ref || "", target: r.target_clause_ref || "" },
        description: r.relation_description || "", confidence: r.confidence, sourceKind: r.source, verified: !!r.verified,
      });
    } else {
      const tCelex = String(r.target_celex || "").toUpperCase();
      if (!tCelex) continue;
      const known = regByCelex.get(tCelex);
      const reason = known
        ? (scope === "product" ? "Referenced by an applicable directive but not assessed for this product" : "Referenced but not marked as applying to the company")
        : "Referenced by an applicable directive but not yet in the portal";
      if (!gapMap.has(tCelex)) gapMap.set(tCelex, { celex: tCelex, reason, inRegistry: !!known, shortName: known?.short_name || null, viaShortName: regById.get(r.source_directive_id)?.short_name || null, relationType: r.relation_type });
    }
  }
  return { nodes, edges, gaps: [...gapMap.values()] };
}

export async function loadClassificationItems(tdb: any): Promise<any[]> {
  const { data: steps } = await tdb("steps").select("step, action, phase, status, lifecycle_phase, scope, classification_ai_generated").order("step");
  const { data: docs } = await tdb("documents").select("id, name, category, kind, lifecycle_phase, scope, classification_ai_generated");
  const { data: interps } = await tdb("as_operates_interpretations").select("id, compliance_status, clause_id, document_version_id, lifecycle_phase, scope, classification_ai_generated");
  const docClass = new Map<string, { phase: string | null; scope: string | null }>();
  const docName = new Map<string, string>();
  for (const d of docs || []) { docClass.set(d.id, { phase: d.lifecycle_phase, scope: d.scope }); docName.set(d.id, d.name || ""); }
  const dvIds = [...new Set((interps || []).map((i: any) => i.document_version_id).filter(Boolean))];
  const dvToDoc = new Map<string, string>();
  if (dvIds.length) { const { data: dvs } = await tdb("document_versions").select("id, document_id").in("id", dvIds); for (const v of dvs || []) dvToDoc.set(v.id, v.document_id); }
  const clauseIds = [...new Set((interps || []).map((i: any) => i.clause_id).filter(Boolean))];
  const clauseMap = new Map<string, any>();
  if (clauseIds.length) { const { data: cs } = await tdb("standard_clauses").select("id, clause_ref, clause_title").in("id", clauseIds); for (const c of cs || []) clauseMap.set(c.id, c); }
  const items: any[] = [];
  // Steps: their action-plan status maps to a compliance bucket so the matrix % reflects progress.
  const stepStatus = (st: string) => /done|complete|closed/i.test(st || "") ? "compliant" : /n\/?a|not applicable/i.test(st || "") ? "not_applicable" : "pending";
  for (const s of steps || []) items.push({
    entityType: "step", id: String(s.step), label: s.action || `Step ${s.step}`, sublabel: s.phase || "",
    lifecycle_phase: s.lifecycle_phase || null, scope: s.scope || null, effective_phase: s.lifecycle_phase || null, effective_scope: s.scope || null,
    inherited: false, ai: !!s.classification_ai_generated, compliance_status: stepStatus(s.status), step: s.step, status: s.status || "",
  });
  for (const d of docs || []) items.push({
    entityType: "document", id: d.id, label: d.name || "(untitled)", sublabel: [d.category, d.kind].filter(Boolean).join(" · "),
    lifecycle_phase: d.lifecycle_phase || null, scope: d.scope || null, effective_phase: d.lifecycle_phase || null, effective_scope: d.scope || null,
    inherited: false, ai: !!d.classification_ai_generated, compliance_status: null,
  });
  for (const it of interps || []) {
    const parentDocId = dvToDoc.get(it.document_version_id);
    const parent = parentDocId ? docClass.get(parentDocId) : null;
    const eff_phase = it.lifecycle_phase || (parent ? parent.phase : null) || null;
    const eff_scope = it.scope || (parent ? parent.scope : null) || null;
    const inherited = (!it.lifecycle_phase && !!eff_phase) || (!it.scope && !!eff_scope);
    const cl = clauseMap.get(it.clause_id);
    items.push({
      entityType: "interpretation", id: it.id,
      label: cl ? `${cl.clause_ref}${cl.clause_title ? " — " + cl.clause_title : ""}` : "Interpretation",
      sublabel: parentDocId ? (docName.get(parentDocId) || "") : "",
      lifecycle_phase: it.lifecycle_phase || null, scope: it.scope || null, effective_phase: eff_phase, effective_scope: eff_scope,
      inherited, ai: !!it.classification_ai_generated, compliance_status: it.compliance_status || null,
    });
  }
  return items;
}
