// ============================================================================
// Rushroom Engineering & Compliance Platform — API gateway (Supabase Edge Function)
//
// The browser talks ONLY to this function; it never touches the database or
// storage directly. This function authenticates the role password server-side,
// issues a short-lived signed token, and enforces what each role may do:
//   • rushroom — read everything, edit any step, upload, list uploads
//   • supplier — read only supplier-tagged steps/docs, edit status of those
//                steps, upload files
//
// Required Edge Function secrets (Project → Edge Functions → Manage secrets):
//   RUSHROOM_PW_HASH  SHA-256 hex of the Rushroom password
//   SUPPLIER_PW_HASH  SHA-256 hex of the supplier password
//   TOKEN_SECRET      any long random string (signs session tokens)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//
// Deploy with JWT verification OFF (we do our own auth):
//   supabase functions deploy portal-api --no-verify-jwt
// ============================================================================
import { CORS, json } from "../_shared/http.ts";
import {
  BUCKET, DOC_BUCKET, STD_BUCKET, TOKEN_TTL_SECONDS,
  SUPABASE_URL, SERVICE_KEY, TOKEN_SECRET, PW_HASH,
  ANTHROPIC_API_KEY, SCAN_MODEL, db, enc,
} from "../_shared/env.ts";
import {
  ab, toHex, b64url, b64urlDecode, sha256Hex, hmacKey, eq,
  issueSession, verifySession, hashPassword, verifyPassword,
} from "../_shared/auth.ts";
import { RUSHROOM_ORG_ID, TENANT_TABLES, makeTdb } from "../_shared/tenant.ts";
import { usagePeriod, buildComplianceGraph, loadClassificationItems } from "../_shared/domain.ts";
import { startTimer } from "../_shared/timing.ts";




// ---- Stage 5: TOTP multi-factor auth (RFC 6238, base32 secret) -----------
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(s: string): Uint8Array {
  const clean = String(s || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) { value = (value << 5) | B32_ALPHABET.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; } }
  return new Uint8Array(out);
}
function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function newTotpSecret(): string { const b = new Uint8Array(20); crypto.getRandomValues(b); return base32Encode(b); }
async function totpAt(secretB32: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", ab(base32Decode(secretB32)), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8); let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, ab(msg)));
  const off = sig[sig.length - 1] & 0x0f;
  const bin = ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}
async function totpVerify(secretB32: string, code: string): Promise<boolean> {
  const c = String(code || "").trim();
  if (!secretB32 || !/^\d{6}$/.test(c)) return false;
  const t = Math.floor(Date.now() / 30000);
  for (const w of [-1, 0, 1]) { if ((await totpAt(secretB32, t + w)) === c) return true; } // ±30s clock skew
  return false;
}

const isSupplierStep = (audience: string[] | null) => Array.isArray(audience) && audience.includes("supplier");
const safeName = (n: string) => (n || "file").replace(/[^\w.\-]+/g, "_").slice(-120);

// ---- user accounts: registration, verification, admin --------------------
const APP_BASE = (Deno.env.get("APP_BASE_URL") ?? "https://ziirvass.github.io/rushroom-compliance-portal").replace(/\/+$/, "");
// PROP-056: where an occurrence is fitted. Kept in step with the CHECK in
// migration 0036 — a value accepted here that the constraint rejects would
// surface as a raw Postgres error rather than a usable message.
// PROP-058: phantom_assembly is structural only — never built, stocked or
// picked. Declared once; the two call sites used to carry their own copies.
// Kept in step with the CHECK in migration 0037.
const COMPONENT_TYPES = ["part", "raw_material", "sub_assembly", "phantom_assembly", "finished_good", "spare_part", "product_family"];
// Types with no physical identity of their own, so no part category applies.
const CATEGORYLESS_TYPES = ["sub_assembly", "phantom_assembly", "product_family"];
const FITTING_STAGES = ["hub", "site"];
const FITTING_STAGE_LABEL: Record<string, string> = {
  hub: "at the logistics hub", site: "on site during installation",
};
const USER_ROLES = ["supplier", "reviewer", "installer", "internal"]; // roles a user may REQUEST at registration
const ASSIGNABLE_ROLES = ["admin", "internal", "reviewer", "supplier", "installer"]; // roles an admin may ASSIGN
const USER_STATUSES = ["pending", "verified", "approved", "rejected", "disabled"];
const emailOk = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
// Map an assigned user role to an access tier the portal enforces.
// Full-access roles see everything; supplier/installer get the limited view.
const roleTier = (r: string): "rushroom" | "supplier" =>
  ["admin", "internal", "reviewer"].includes(r) ? "rushroom" : "supplier";


// HMAC-sign an arbitrary payload (used for email-verification links).
async function signData(obj: unknown): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(obj)));
  const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), ab(enc.encode(payload)))));
  return `${payload}.${sig}`;
}
async function readSigned(token: string): Promise<any | null> {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(), ab(b64urlDecode(sig)), ab(enc.encode(payload)));
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch { return null; }
}
const verifyLinkFor = async (uid: string) =>
  `${APP_BASE}/verify.html?token=${encodeURIComponent(await signData({ uid, purpose: "verify", exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 }))}`;
const resetLinkFor = async (uid: string) =>
  `${APP_BASE}/reset.html?token=${encodeURIComponent(await signData({ uid, purpose: "setpw", exp: Math.floor(Date.now() / 1000) + 3600 }))}`;

// Best-effort transactional email via Resend (optional — set RESEND_API_KEY).
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return false;
  const from = Deno.env.get("MAIL_FROM") || "Rushroom Compliance <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
    });
    return res.ok;
  } catch { return false; }
}
const sendVerificationEmail = (to: string, name: string, url: string) =>
  sendEmail(to, "Verify your Rushroom Engineering & Compliance Platform registration",
    `<p>Hi ${name || "there"},</p><p>Thanks for registering for the Rushroom AB Engineering & Compliance Platform. Please confirm your email address:</p><p><a href="${url}">Verify my email</a></p><p>This link expires in 7 days. If you didn't request this, you can ignore it.</p>`);
const sendPasswordEmail = (to: string, name: string, url: string) =>
  sendEmail(to, "Set your Rushroom Engineering & Compliance Platform password",
    `<p>Hi ${name || "there"},</p><p>Use the link below to set a new password for the Rushroom AB Engineering & Compliance Platform:</p><p><a href="${url}">Set my password</a></p><p>This link expires in 1 hour. If you didn't request this, you can ignore it.</p>`);

// ---- AI deviation monitoring (Claude) ----
// Insert a document_versions row, tolerating the optional provenance columns
// (source_document_version_id / source_standard_version_ids) not existing yet —
// if the DB doesn't have them, retry without them so publishing still works.
async function insertDocumentVersion(tdb: any, row: Record<string, unknown>) {
  // Auto-number the version (v1, v2, v3 …) when no label was supplied.
  if (!String(row.version ?? "").trim() && row.document_id) {
    const { count } = await tdb("document_versions").select("id", { count: "exact", head: true }).eq("document_id", row.document_id as string);
    row.version = `v${(count ?? 0) + 1}`;
  }
  // The resolved label and the new row's id are returned, not just the error.
  // Callers that audit the revision need to name it, and the auto-numbered case
  // is the common one — reading body.version there yields an empty string.
  let res = await tdb("document_versions").insert(row).select("id").maybeSingle();
  if (res.error && /source_(document|standard)_version_ids?/.test(res.error.message || "")) {
    const clean = { ...row };
    delete clean.source_document_version_id;
    delete clean.source_standard_version_ids;
    res = await tdb("document_versions").insert(clean).select("id").maybeSingle();
  }
  return { ...res, version: String(row.version ?? ""), versionId: res.data?.id ?? null };
}

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SCAN_MODEL = "claude-opus-4-8";
// Token usage from a Claude response — surfaced in the UI so the team can see
// how much AI each operation costs (front-end turns tokens into an estimate).
const usageOf = (j: any) => ({
  model: j?.model || SCAN_MODEL,
  input_tokens: j?.usage?.input_tokens ?? 0,
  output_tokens: j?.usage?.output_tokens ?? 0,
  cache_read_input_tokens: j?.usage?.cache_read_input_tokens ?? 0,
});
const addUsage = (a: any, b: any) => ({
  model: a.model || b?.model || SCAN_MODEL,
  input_tokens: (a.input_tokens || 0) + (b?.input_tokens ?? 0),
  output_tokens: (a.output_tokens || 0) + (b?.output_tokens ?? 0),
  cache_read_input_tokens: (a.cache_read_input_tokens || 0) + (b?.cache_read_input_tokens ?? 0),
});

// --- Stage 4: plan entitlements, feature gating & AI metering --------------
// Plans are code-defined (operator config). A tenant's plan is organizations.plan.
// The seed/operator org uses 'internal' = every feature, no AI cap.
const PLANS: Record<string, { label: string; features: string[]; aiTokensPerMonth: number | null; maxSeats: number | null }> = {
  trial:        { label: "Trial",        features: ["core"], aiTokensPerMonth: 100_000, maxSeats: 3 },
  starter:      { label: "Starter",      features: ["core", "deviation"], aiTokensPerMonth: 1_000_000, maxSeats: 10 },
  professional: { label: "Professional", features: ["core", "deviation", "level2", "links", "classification"], aiTokensPerMonth: 5_000_000, maxSeats: 30 },
  enterprise:   { label: "Enterprise",   features: ["core", "deviation", "level2", "links", "classification", "cellar"], aiTokensPerMonth: null, maxSeats: null },
  internal:     { label: "Operator",     features: ["core", "deviation", "level2", "links", "classification", "cellar"], aiTokensPerMonth: null, maxSeats: null },
};
const PLAN_IDS = Object.keys(PLANS);
const planOf = (p: string) => PLANS[p] || PLANS.trial;

// Which paywalled feature (if any) an action requires. Unlisted actions = core.
const FEATURE_FOR_ACTION: Record<string, string> = {
  runDeviationScan: "deviation", deviations: "deviation",
  extractStandardClauses: "level2", getClausesForStandard: "level2", generateInterpretations: "level2",
  saveInterpretation: "level2", getInterpretations: "level2", complianceMatrix: "level2",
  listProductPassports: "level2", getProductPassport: "level2", createProductPassport: "level2",
  updateProductPassport: "level2", deleteProductPassport: "level2", linkPassportInterpretation: "level2",
  unlinkPassportInterpretation: "level2", exportProductPassport: "level2",
  listRequirementLinks: "links", listRequirementLinksForClauses: "links", listRequirementLinksForDocumentVersions: "links",
  listRequirementLinksForStatements: "links", createRequirementLink: "links", setRequirementLinkStatus: "links",
  deleteRequirementLink: "links", listRequirementLinksQueue: "links", suggestRequirementLinks: "links",
  detectClauseCitations: "links", listDocumentStatements: "links", saveDocumentStatements: "links",
  listDirectives: "cellar", addDirective: "cellar", syncDirectiveRelations: "cellar",
  inferDirectiveRelations: "cellar", analyseComplianceGraph: "cellar", setDirectiveApplicability: "cellar",
  getComplianceCoverage: "cellar", generateComplianceNarrative: "cellar",
};
// Actions that spend Anthropic tokens (metered + capped).
const AI_ACTIONS = new Set([
  "suggestDocumentVersion", "suggestStandardMetadata", "suggestFileMetadata", "suggestComponentMetadata", "runDeviationScan",
  "extractStandardClauses", "generateInterpretations", "suggestRequirementLinks",
  "inferDirectiveRelations", "generateComplianceNarrative", "suggestClassifications",
]);
// Monthly AI token usage for an org (sum of the append-only ledger; best-effort).
async function aiTokensUsed(orgId: string, period: string): Promise<number> {
  try {
    const { data } = await db.from("ai_usage_events").select("input_tokens, output_tokens").eq("organization_id", orgId).eq("period", period);
    return (data ?? []).reduce((n: number, r: any) => n + (r.input_tokens || 0) + (r.output_tokens || 0), 0);
  } catch { return 0; }
}

const SEVERITIES = ["Critical", "High", "Medium", "Low", "Info"];
const TEXT_CAP = 40000; // per-file char cap fed to the model
const DOCUMENT_DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    proposed_changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["title", "description", "rationale"],
      },
    },
    draft_text: { type: "string" },
    version_hint: { type: "string" },
    file_name_hint: { type: "string" },
  },
  required: ["summary", "proposed_changes", "draft_text", "version_hint", "file_name_hint"],
};
const STANDARD_META_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    code: { type: "string" },
    title: { type: "string" },
    category: { type: "string" },
    reg_type: { type: "string" },
    jurisdiction: { type: "string" },
    version: { type: "string" },
    effective_date: { type: "string" },
    summary: { type: "string" },
  },
  required: ["code", "title", "category", "reg_type", "jurisdiction", "version", "effective_date", "summary"],
};
const FILE_META_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    category: { type: "string" },
    version: { type: "string" },
    effective_date: { type: "string" },
    kind: { type: "string" },
    summary: { type: "string" },
  },
  required: ["name", "category", "version", "effective_date", "kind", "summary"],
};
const COMPONENT_META_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    part_number: { type: "string" },
    oem_number:  { type: "string" },
    name:        { type: "string" },
    type:        { type: "string" },
    description: { type: "string" },
    summary:     { type: "string" },
  },
  required: ["part_number", "oem_number", "name", "type", "description", "summary"],
};
const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: SEVERITIES },
          title: { type: "string" },
          description: { type: "string" },
          document: { type: "string" },
          standard: { type: "string" },
          recommendation: { type: "string" },
        },
        required: ["severity", "title", "description", "document", "standard", "recommendation"],
      },
    },
  },
  required: ["summary", "findings"],
};

// NOTE: document parsing (jszip/pdf-lib) and the AI file helpers that used it
// moved to supabase/functions/portal-ai/ on 2026-09-16. portal-api no longer
// parses documents, so it no longer carries those dependencies.

// ---- EU directive graph helpers -------------------------------------------
const DIRECTIVE_RELATION_TYPES = ["requires", "supplements", "implements", "amends", "supersedes", "references", "conflicts_with", "defines_terms_for"];
const APPLICABILITY_STATUSES = ["applicable", "not_applicable", "partial", "under_review"];

// Compliance coverage for a directive: we tie a directive to the standards in the
// register whose DOMAIN (category) or code matches the directive's short name, then
// count clause-level interpretations by status. No matching standards → not assessed
// (coverage_pct = null → grey node).
async function coverageForDirective(tdb: any, dir: any): Promise<{ total_clauses: number; covered_clauses: number; coverage_pct: number | null; pending_count: number; deviation_count: number; standard_ids: string[] }> {
  const zero = { total_clauses: 0, covered_clauses: 0, coverage_pct: null as number | null, pending_count: 0, deviation_count: 0, standard_ids: [] as string[] };
  try {
    const shortU = String(dir.short_name || "").toUpperCase();
    if (!shortU) return zero;
    const { data: stds } = await tdb("standards").select("id, code, category, reg_type, title");
    const related = (stds || []).filter((s: any) => {
      const hay = `${s.category || ""} ${s.code || ""} ${s.title || ""}`.toUpperCase();
      return hay.includes(shortU);
    });
    const relIds = related.map((s: any) => s.id);
    if (!relIds.length) return zero;
    const { data: vers } = await tdb("standard_versions").select("id, standard_id, created_at").in("standard_id", relIds).order("created_at", { ascending: false });
    const latestByStd = new Map<string, string>();
    for (const v of vers || []) if (!latestByStd.has(v.standard_id)) latestByStd.set(v.standard_id, v.id);
    const versionIds = [...latestByStd.values()];
    if (!versionIds.length) return { ...zero, standard_ids: relIds };
    const { data: clauses } = await tdb("standard_clauses").select("id").in("standard_version_id", versionIds);
    const clauseIds = (clauses || []).map((c: any) => c.id);
    const total = clauseIds.length;
    if (!total) return { ...zero, standard_ids: relIds };
    const { data: interps } = await tdb("as_operates_interpretations").select("compliance_status, clause_id").in("clause_id", clauseIds);
    const statusByClause = new Map<string, string>();
    for (const it of interps || []) statusByClause.set(it.clause_id, it.compliance_status);
    let covered = 0, deviation = 0;
    for (const st of statusByClause.values()) { if (st === "compliant") covered++; else if (st === "deviation") deviation++; }
    const pending = total - covered - deviation;
    return { total_clauses: total, covered_clauses: covered, coverage_pct: Math.round((covered / total) * 100), pending_count: pending, deviation_count: deviation, standard_ids: relIds };
  } catch { return zero; }
}

// Derive a CELEX number from a standards-register code, e.g. "2014/35/EU" →
// 32014L0035, "(EU) 2023/1542" → 32023R1542, "(EC) No 765/2008" → 32008R0765.
// Returns null when the code can't be parsed confidently.
function celexFromCode(code: string, regType: string): string | null {
  const c = String(code || "").toUpperCase().replace(/\s+/g, "");
  // Directive: YYYY/NN/EU|EC|EEC
  let m = /(\d{4})\/(\d{1,4})\/(EU|EC|EEC)/.exec(c);
  if (m) return `3${m[1]}L${m[2].padStart(4, "0")}`;
  // Regulation post-2015: (EU)YYYY/NNNN
  m = /\((?:EU|EC)\)(?:NO)?(\d{4})\/(\d{1,4})/.exec(c);
  if (m) return `3${m[1]}R${m[2].padStart(4, "0")}`;
  // Regulation pre-2015: (EU|EC)No NNN/YYYY
  m = /\((?:EU|EC|EEC)\)NO(\d{1,4})\/(\d{4})/.exec(c);
  if (m) return `3${m[2]}R${m[1].padStart(4, "0")}`;
  // Only treat as a regulation if the register says so (avoid matching EN standard codes).
  if (/EU Regulation/i.test(regType || "")) {
    m = /(\d{4})\/(\d{1,4})/.exec(c);
    if (m) return `3${m[1]}R${m[2].padStart(4, "0")}`;
  }
  return null;
}

// Pre-load the directive registry from the Standards & Regulations register: any
// standard classed as an EU Directive/Regulation whose code yields a CELEX and that
// isn't already tracked gets added to eu_directives. Idempotent; best-effort.
async function importDirectivesFromStandards(tdb: any): Promise<number> {
  try {
    const { data: stds } = await tdb("standards").select("code, title, reg_type, category");
    if (!stds || !stds.length) return 0;
    const { data: existing } = await db.from("eu_directives").select("celex_number");
    const have = new Set((existing || []).map((d: any) => String(d.celex_number).toUpperCase()));
    const rows: Record<string, unknown>[] = [];
    for (const s of stds) {
      if (!/EU Directive|EU Regulation/i.test(s.reg_type || "")) continue;
      const celex = celexFromCode(s.code || "", s.reg_type || "");
      if (!celex || have.has(celex)) continue;
      have.add(celex);
      rows.push({
        celex_number: celex,
        short_name: String(s.category || s.code || celex).slice(0, 40),
        official_title: s.title || null,
        directive_type: celex.charAt(4) === "R" ? "regulation" : "directive",
        eur_lex_url: `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${celex}`,
        applies_to_company: true,
      });
    }
    if (rows.length) await db.from("eu_directives").upsert(rows, { onConflict: "celex_number", ignoreDuplicates: true });
    return rows.length;
  } catch { return 0; }
}

// Build the directive relationship graph for a scope: nodes (directives + coverage),
// edges (relations between in-scope directives) and gaps (referenced directives not
// in scope / not in the portal). scope: "all" (whole registry) | "company" | "product".

// ---- Compliance Status classification (lifecycle phase × scope) ------------
const LIFECYCLE_PHASES = ["pre_launch", "monitoring"];
const COMPLIANCE_SCOPES = ["company", "product_services"];
const CLASS_STATUSES = ["compliant", "deviation", "not_applicable", "pending"];

// Apply one classification change and append to the audit log. phase/scope may be
// null (unclassify). When set to pre_launch, monitoring fields are nulled to keep
// the CHECK constraint satisfied.
async function applyClassification(tdb: any, entityType: string, id: string, phase: string | null, scope: string | null, aiGenerated: boolean, changedBy: string | null): Promise<{ ok: boolean; error?: string }> {
  if (entityType === "step") {
    // Steps have an integer PK and no classified_at/by columns; log via entity_step.
    const stepNo = Number(id);
    if (!stepNo) return { ok: false, error: "invalid step" };
    const { data: cur } = await tdb("steps").select("lifecycle_phase, scope").eq("step", stepNo).maybeSingle();
    if (!cur) return { ok: false, error: "not found" };
    const { error } = await tdb("steps").update({ lifecycle_phase: phase, scope, classification_ai_generated: !!aiGenerated, updated_at: new Date().toISOString(), updated_by: "classification" }).eq("step", stepNo);
    if (error) return { ok: false, error: error.message };
    await tdb("classification_log").insert({ entity_type: "step", entity_step: stepNo, entity_id: null, old_lifecycle_phase: cur.lifecycle_phase ?? null, new_lifecycle_phase: phase ?? null, old_scope: cur.scope ?? null, new_scope: scope ?? null, changed_by: changedBy || null, ai_generated: !!aiGenerated });
    return { ok: true };
  }
  const table = entityType === "interpretation" ? "as_operates_interpretations" : "documents";
  const { data: cur } = await db.from(table).select("lifecycle_phase, scope").eq("id", id).maybeSingle();
  if (!cur) return { ok: false, error: "not found" };
  const patch: Record<string, unknown> = { lifecycle_phase: phase, scope, classification_ai_generated: !!aiGenerated, classified_at: new Date().toISOString(), classified_by: changedBy || null };
  if (phase === "pre_launch") { patch.monitoring_frequency = null; patch.next_due_at = null; patch.last_verified_at = null; }
  const { error } = await db.from(table).update(patch).eq("id", id);
  if (error) return { ok: false, error: error.message };
  await tdb("classification_log").insert({
    entity_type: entityType, entity_id: id,
    old_lifecycle_phase: cur.lifecycle_phase ?? null, new_lifecycle_phase: phase ?? null,
    old_scope: cur.scope ?? null, new_scope: scope ?? null,
    changed_by: changedBy || null, ai_generated: !!aiGenerated,
  });
  return { ok: true };
}

// Load every classifiable item (documents + interpretations) with its own and
// EFFECTIVE classification (interpretations inherit their parent document's
// classification when their own is unset — overridable per row).

// ---- component revision bump (PROP-043) ------------------------------------
// Extracted from the bumpComponentVersion action so a document revision can
// raise a component revision without duplicating the numbering, the retire-old
// step, or the snapshot. One implementation means the two paths cannot drift.
async function bumpComponentRevision(
  tdb: any, session: any, component_id: string, spec_summary: string | null,
): Promise<{ version_id: string; revision: string }> {
    // Auto-compute next revision from existing versions (server is authoritative)
    function revRank(r: string): number {
      let n = 0;
      for (const ch of r.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
      return n;
    }
    function nextRev(revisions: string[]): string {
      const max = revisions.length ? revisions.reduce((m, r) => revRank(r) > revRank(m) ? r : m) : "";
      let num = 0;
      for (const ch of max.toUpperCase()) num = num * 26 + (ch.charCodeAt(0) - 64);
      num++;
      let result = "";
      while (num > 0) { num--; result = String.fromCharCode(65 + num % 26) + result; num = Math.floor(num / 26); }
      return result;
    }
    const { data: existing } = await tdb("bom_component_versions")
      .select("id, revision").eq("component_id", component_id);
    const revision = nextRev((existing || []).map((r: any) => r.revision));

    // Explicitly retire old versions before inserting the new one.
    // The trigger fn_set_current_version does the same but may not fire
    // reliably in all Supabase RLS configurations, so we do it here too.
    if ((existing || []).length > 0) {
      await tdb("bom_component_versions")
        .update({ is_current: false }).eq("component_id", component_id);
    }

    // Fetch component fields for snapshot + audit trail
    const { data: comp } = await tdb("bom_components")
      .select("organization_id, part_number, oem_number, name, description, notes, type, make_or_buy, lifecycle_status, replacement_note, flag_reason")
      .eq("id", component_id).maybeSingle();

    // Build version snapshot: capture documents + materials as they exist right now
    const { data: snapDocs } = await tdb("component_documents")
      .select("id, category, label, document_version_id").eq("component_id", component_id);
    let snapDocNames: Record<string, string> = {};
    if ((snapDocs || []).length) {
      const dvIds = (snapDocs || []).map((d: any) => d.document_version_id);
      const { data: dvs } = await tdb("document_versions").select("id, document_id").in("id", dvIds);
      const docIds = (dvs || []).map((v: any) => v.document_id);
      if (docIds.length) {
        const { data: docRows } = await tdb("documents").select("id, name").in("id", docIds);
        const nameMap: Record<string, string> = {};
        (docRows || []).forEach((d: any) => { nameMap[d.id] = d.name; });
        (dvs || []).forEach((v: any) => { snapDocNames[v.id] = nameMap[v.document_id] || ""; });
      }
    }
    const { data: snapMats } = await tdb("component_materials")
      .select("substance_name, cas_number, percentage_w_w, reach_svhc, rohs_restricted")
      .eq("component_id", component_id);
    const { data: snapMeta } = await tdb("component_metadata")
      .select("weight_g,length_mm,width_mm,height_mm,base_material,surface_treatment,color_specification,incoming_inspection_method,country_of_origin,hs_code,recycled_content_pct,carbon_footprint_kgco2e,carbon_footprint_source,weee_category,conflict_minerals_free,recycled_content_pct")
      .eq("component_id", component_id).maybeSingle();
    const version_snapshot = comp ? {
      description:      comp.description      || null,
      notes:            comp.notes            || null,
      lifecycle_status: comp.lifecycle_status,
      make_or_buy:      comp.make_or_buy      || "purchased",
      replacement_note: comp.replacement_note || null,
      flag_reason:      comp.flag_reason      || null,
      documents: (snapDocs || []).map((d: any) => ({
        doc_name: snapDocNames[d.document_version_id] || "",
        category: d.category,
        label:    d.label || null,
      })),
      materials: (snapMats || []).map((m: any) => ({
        substance_name:  m.substance_name,
        cas_number:      m.cas_number      || null,
        percentage_w_w:  m.percentage_w_w  ?? null,
        reach_svhc:      m.reach_svhc,
        rohs_restricted: m.rohs_restricted,
      })),
      metadata: snapMeta || null,
    } : null;

    const { data: ver, error } = await tdb("bom_component_versions").insert({
      component_id, revision, spec_summary: spec_summary || null,
      is_current: true, created_by: session.uid || null,
      version_snapshot,
    }).select("id").maybeSingle();
    if (error) throw new Error(error.message);

    // Write audit trail — trigger doesn't fire because bom_components isn't touched
    if (comp) {
      await tdb("bom_component_history").insert({
        organization_id: comp.organization_id,
        component_id,
        changed_at: new Date().toISOString(),
        changed_by: session.uid || null,
        change_type: "version_bumped",
        part_number: comp.part_number,
        oem_number: comp.oem_number,
        name: comp.name,
        description: comp.description,
        type: comp.type,
        lifecycle_status: comp.lifecycle_status,
        notes: `Revision ${revision}${spec_summary ? ": " + spec_summary : ""}`,
      });
    }
    return { version_id: ver.id, revision };
}

// ---- document revision -> BOM node events (PROP-043) -----------------------
// A new version of a document is a change to every component that links it.
// Drawings additionally raise the component revision: a dimension change is a
// change to the part. A supplier reissuing a datasheet is not, so other
// categories record history without bumping.
async function recordDocumentRevision(
  tdb: any, session: any, documentId: string, newVersion: string, newVersionId?: string | null,
): Promise<{ audited: number; bumped: string[] }> {
  const bumped: string[] = [];
  let audited = 0;
  try {
    // Which components link ANY version of this document, and under what category.
    // Ordered: the "previous revision" in the audit note is positional, so an
    // unordered read would name an arbitrary row as the one being superseded.
    const { data: versions } = await tdb("document_versions")
      .select("id, version, created_at").eq("document_id", documentId)
      .order("created_at", { ascending: true });
    const versionIds = (versions || []).map((v: any) => v.id);
    if (!versionIds.length) return { audited, bumped };

    const { data: links } = await tdb("component_documents")
      .select("component_id, category, label, document_version_id")
      .in("document_version_id", versionIds);
    if (!links?.length) return { audited, bumped };

    const { data: doc } = await tdb("documents").select("name").eq("id", documentId).maybeSingle();
    const docName = doc?.name || "document";

    // The revision this document carried before the one just added. Identify
    // the new row by id where we have it: two revisions may share a label
    // (nothing forbids uploading "Rev B" twice), so matching on the string
    // would drop the real predecessor along with the new row.
    const ordered = versions || [];
    const newIdx = newVersionId
      ? ordered.findIndex((v: any) => v.id === newVersionId)
      : ordered.map((v: any) => v.version).lastIndexOf(newVersion);
    const priorRow = newIdx > 0 ? ordered[newIdx - 1]
      : (newIdx === -1 && ordered.length ? ordered[ordered.length - 1] : null);
    const from = priorRow?.version || "—";

    // One component may link the document more than once; audit each node once.
    const seen = new Set<string>();
    for (const link of links) {
      if (seen.has(link.component_id)) continue;
      seen.add(link.component_id);

      const { data: comp } = await tdb("bom_components")
        .select("organization_id, part_number, oem_number, name, description, type, lifecycle_status")
        .eq("id", link.component_id).maybeSingle();
      if (!comp) continue;   // tdb() scopes by org, so a foreign component simply is not found

      try {
        await tdb("bom_component_history").insert({
          organization_id: comp.organization_id,
          component_id: link.component_id,
          changed_at: new Date().toISOString(),
          changed_by: session?.uid || null,
          change_type: "document_revised",
          part_number: comp.part_number, oem_number: comp.oem_number,
          name: comp.name, description: comp.description,
          type: comp.type, lifecycle_status: comp.lifecycle_status,
          notes: `${link.category === "drawing" ? "Drawing" : "Document"} revised: ${docName}${link.label ? ` (${link.label})` : ""} ${from} → ${newVersion || "new revision"}`,
        });
        audited++;
      } catch { /* non-fatal: the document version itself is already saved */ }

      if (link.category === "drawing") {
        try {
          const r = await bumpComponentRevision(
            tdb, session, link.component_id,
            `Drawing revised: ${docName} ${from} → ${newVersion || "new revision"}`,
          );
          bumped.push(`${comp.name} ${r.revision}`);
        } catch { /* a failed bump must not lose the uploaded revision */ }
      }
    }
  } catch { /* auditing must never break the upload it describes */ }
  return { audited, bumped };
}

/**
 * PROP-046: the system's own drawing number, never the supplier's.
 * Same alphabet as part_number — no I, O, 0 or 1 — because these get read off a
 * printed sheet and typed back in. Retries on the (vanishingly unlikely) clash
 * rather than trusting 32^8 blindly; the unique index is per organization.
 */
async function generateDrawingNumber(tdb: any): Promise<string> {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const d = new Date();
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const rand = new Uint8Array(8);
    crypto.getRandomValues(rand);
    const candidate = `RR-DWG-${ym}-${Array.from(rand).map((b) => chars[b % chars.length]).join("")}`;
    const { data } = await tdb("drawings").select("id").eq("drawing_number", candidate);
    if (!(data || []).length) return candidate;
  }
  return `RR-DWG-${ym}-${Date.now().toString(36).toUpperCase()}`;
}

// ---- PROP-045: drawings helpers -------------------------------------------

/**
 * THE supplier visibility choke point.
 *
 * Manufacturing partners need drawings, so the default is that they see them.
 * Every drawing read passes through here, which is the point: making visibility
 * selective per supplier — the expected next step — means changing this one
 * function instead of auditing every query for a forgotten filter. Turning
 * supplier access off entirely is the constant below; withholding a single
 * drawing is its is_supplier_visible column, which needs no deploy.
 */
const SUPPLIER_DRAWINGS_ENABLED = true;
function supplierDrawingScope(q: any, role: string) {
  if (role !== "supplier") return q;
  if (!SUPPLIER_DRAWINGS_ENABLED) return q.eq("id", "00000000-0000-0000-0000-000000000000");
  return q.eq("is_supplier_visible", true);
}

/**
 * A → B → … → Z → AA → AB. Drawing revisions are letters, not v1/v2, which is
 * one reason they do not share document_versions' auto-numbering.
 * Hand-entered labels are respected; this only fills the blank.
 */
function nextRevisionLetter(existing: string[]): string {
  const letters = existing
    .map((r) => String(r || "").trim().toUpperCase())
    .filter((r) => /^[A-Z]+$/.test(r));
  if (!letters.length) return "A";
  // Longest-then-lexical: "AA" follows "Z", not the other way round.
  const highest = letters.sort((a, b) => a.length - b.length || a.localeCompare(b)).pop()!;
  const chars = highest.split("");
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] !== "Z") { chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1); return chars.join(""); }
    chars[i] = "A"; i--;
  }
  return "A" + chars.join("");
}

/** One audit row on one component. Non-fatal by design: an audit write must
 *  never block the change it records. Migration 0032 widens the CHECK that
 *  would otherwise reject the new change_types — silently, inside this catch. */
async function writeBomHistory(
  tdb: any, session: any, componentId: string, changeType: string, notes: string,
): Promise<boolean> {
  try {
    const { data: comp } = await tdb("bom_components")
      .select("organization_id, part_number, oem_number, name, description, type, lifecycle_status")
      .eq("id", componentId).maybeSingle();
    if (!comp) return false;
    await tdb("bom_component_history").insert({
      organization_id: comp.organization_id,
      component_id: componentId,
      changed_at: new Date().toISOString(),
      changed_by: session?.uid || null,
      change_type: changeType,
      part_number: comp.part_number, oem_number: comp.oem_number,
      name: comp.name, description: comp.description,
      type: comp.type, lifecycle_status: comp.lifecycle_status,
      notes,
    });
    return true;
  } catch { return false; }
}

/**
 * Fan a drawing event out to every BOM node the drawing depicts, optionally
 * raising each node's revision. Mirrors recordDocumentRevision: a drawing
 * change IS a change to the parts built from it, and the trail must say so.
 */
async function recordDrawingEvent(
  tdb: any, session: any, drawingId: string, changeType: string, notes: string,
  opts: { bump: boolean; bumpSummary?: string },
): Promise<{ audited: number; bumped: string[] }> {
  const bumped: string[] = [];
  let audited = 0;
  try {
    const { data: links } = await tdb("drawing_components")
      .select("component_id").eq("drawing_id", drawingId);
    const seen = new Set<string>();
    for (const link of links || []) {
      if (seen.has(link.component_id)) continue;
      seen.add(link.component_id);
      if (await writeBomHistory(tdb, session, link.component_id, changeType, notes)) audited++;
      if (opts.bump) {
        try {
          const { data: comp } = await tdb("bom_components").select("name").eq("id", link.component_id).maybeSingle();
          const r = await bumpComponentRevision(tdb, session, link.component_id, opts.bumpSummary || notes);
          bumped.push(`${comp?.name || "part"} ${r.revision}`);
        } catch { /* a failed bump must not lose the revision just uploaded */ }
      }
    }
  } catch { /* auditing must never break the change it describes */ }
  return { audited, bumped };
}

/**
 * Decide what a deep assembly copy clones and what it reuses (PROP-059).
 *
 * Cloned: the root, and every descendant that HAS CHILDREN.
 * Reused:  the leaves.
 *
 * Structural rather than type-based on purpose. A node typed `part` that holds
 * children is still structure someone will want to edit in the copy, and
 * cloning leaves would put a second Confirmat Screw in a registry people scan
 * by part number. Sharing a node that HAS children would be worse than either:
 * editing inside it changes the original too.
 *
 * Deliberately annotation-free plain JavaScript so tests/copy-assembly.test.mjs
 * can lift and run it against real tree shapes rather than pattern-match it.
 */
function planAssemblyCopy(rootId, childrenOf, visited) {
  const clones = new Set([rootId]);
  for (const id of visited) {
    if ((childrenOf[id] || []).length) clones.add(id);
  }
  const shared = [];
  for (const id of visited) if (!clones.has(id)) shared.push(id);
  // Only edges whose PARENT is cloned are recreated. An edge under a reused
  // node already exists there; recreating it would duplicate the original's
  // own structure.
  let edgeCount = 0;
  for (const id of clones) edgeCount += (childrenOf[id] || []).length;
  return { clones, shared, edgeCount };
}

/**
 * Clone one bom_components row: new part number, "- copy" name unless one is
 * given, spec record carried across, fresh revision A, audited.
 *
 * Extracted for PROP-059 so a deep assembly copy produces components
 * indistinguishable from ones made by the single-node ⧉ — two clone paths
 * would drift, and the one that drifted would be the rarely-used one.
 */
async function cloneComponentRow(tdb: any, session: any, srcId: string, nameOverride?: string) {
  const { data: src } = await tdb("bom_components")
    .select("part_number, oem_number, name, description, type, unit_of_measure, notes, make_or_buy, category_id")
    .eq("id", srcId).maybeSingle();
  if (!src) return { error: "Component not found" };

  // Always a fresh number: part_number is unique per org and is the thing
  // people scan for, so a copy must never be mistakable for the original.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rand = new Uint8Array(8);
  crypto.getRandomValues(rand);
  const d = new Date();
  const part_number = `RR-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}-${Array.from(rand).map((b) => chars[b % chars.length]).join("")}`;
  const name = String(nameOverride && nameOverride.trim() ? nameOverride.trim() : `${src.name} - copy`).slice(0, 255);

  const { data: comp, error: ce } = await tdb("bom_components").insert({
    part_number, name, type: src.type,
    oem_number: src.oem_number, description: src.description,
    unit_of_measure: src.unit_of_measure, notes: src.notes,
    make_or_buy: src.make_or_buy, category_id: src.category_id,
    // A copy has not been reviewed or sourced, whatever the original's state.
    lifecycle_status: "inactive",
    created_by: session?.uid || null,
  }).select("id").maybeSingle();
  if (ce || !comp) return { error: ce?.message ?? "Copy failed" };

  const { data: ver, error: ve } = await tdb("bom_component_versions").insert({
    component_id: comp.id, revision: "A",
    spec_summary: `Initial revision — copied from ${src.part_number}`,
    is_current: true, created_by: session?.uid || null,
  }).select("id").maybeSingle();
  if (ve || !ver) return { error: ve?.message ?? "Version insert returned no data" };

  // The whole point of the feature: carry the spec record across.
  const { data: meta } = await tdb("component_metadata").select("*").eq("component_id", srcId).maybeSingle();
  if (meta) {
    const copy: Record<string, unknown> = { ...meta };
    delete copy.id; delete copy.component_id; delete copy.organization_id;
    delete copy.created_at; delete copy.updated_at;
    try { await tdb("component_metadata").insert({ ...copy, component_id: comp.id }); }
    catch { /* non-fatal: the component exists, specs can be re-entered */ }
  }

  try {
    await tdb("bom_component_history").insert({
      component_id: comp.id, changed_at: new Date().toISOString(),
      changed_by: session?.uid || null, change_type: "created",
      part_number, oem_number: src.oem_number, name,
      description: src.description, type: src.type, lifecycle_status: "inactive",
      notes: `Copied from ${src.name} (${src.part_number})`,
    });
  } catch { /* non-fatal */ }

  return { id: comp.id as string, part_number, name, type: src.type as string };
}

// ---- request handler -------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!TOKEN_SECRET) return json({ error: "Server not configured (TOKEN_SECRET missing)" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = String(body.action || "");

  // Health: no session, no database, no work. Exists so cold-start and gateway
  // latency can be measured on their own — if this is slow, nothing downstream
  // of it is the explanation. Deliberately ahead of the auth gate.
  const timer = startTimer("portal-api", action);
  if (action === "health") {
    timer.done(200);
    return json({ ok: true, fn: "portal-api", ts: Date.now() });
  }

  // Outer safety net: catch any uncaught exception inside an action handler and
  // return it as a CORS-compliant JSON error so the browser never sees a raw 500.
  try {

  // --- login: password -> token -------------------------------------------
  if (action === "login") {
    const role = body.role === "rushroom" || body.role === "supplier" ? body.role : null;
    const expected = role ? PW_HASH[role] : undefined;
    if (!role || !expected) return json({ error: "Unknown role" }, 400);
    const got = await sha256Hex(String(body.password ?? ""));
    if (!eq(got, expected)) return json({ error: "Incorrect password" }, 401);
    // The shared Rushroom password is the bootstrap admin; supplier is limited.
    // Bootstrap logins belong to the seed organization (Stage 1).
    return json({ token: await issueSession({ role, admin: role === "rushroom", org: RUSHROOM_ORG_ID }), role, admin: role === "rushroom", organization_id: RUSHROOM_ORG_ID });
  }

  // --- login: individual email + password ---------------------------------
  if (action === "loginUser") {
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!emailOk(email) || !password) return json({ error: "Enter your email and password." }, 400);
    const { data: u } = await db.from("users").select("*").eq("email", email).maybeSingle();
    const bad = json({ error: "Incorrect email or password." }, 401); // generic — no user enumeration
    if (!u || !(await verifyPassword(password, u.password ?? null))) return bad;
    if (!u.email_verified) return json({ error: "Please verify your email first — check your inbox for the link." }, 403);
    if (u.status !== "approved") {
      const msg = (u.status === "rejected" || u.status === "disabled")
        ? "Your account isn't active. Please contact the administrator."
        : "Your account is awaiting administrator approval.";
      return json({ error: msg }, 403);
    }
    // Stage 5: second factor. Only enforced for accounts that enrolled in MFA,
    // so existing users are unaffected. A missing code signals the UI to prompt.
    if (u.mfa_enabled) {
      const code = String(body.mfaCode ?? "").trim();
      if (!code) return json({ error: "Enter your authenticator code.", code: "mfa_required" }, 401);
      if (!(await totpVerify(u.mfa_secret ?? "", code))) return json({ error: "That authenticator code isn't valid.", code: "mfa_invalid" }, 401);
    }
    const assigned = String(u.role || u.requested_role || "supplier");
    const tier = roleTier(assigned);
    const admin = assigned === "admin";
    // Stage 1: resolve the user's active organization membership so the session
    // is tenant-aware. Wrapped in try/catch so login still works before the
    // memberships table exists (falls back to the seed org — backward compatible).
    let orgId = RUSHROOM_ORG_ID, orgName = "", mRole = membershipRoleFor(assigned);
    try {
      const { data: ms } = await db.from("memberships")
        .select("organization_id, role, organizations(name)")
        .eq("user_id", u.id).eq("status", "active").order("created_at").limit(1);
      const m = ms && ms[0];
      if (m && m.organization_id) { orgId = m.organization_id; mRole = m.role || mRole; orgName = (m as any).organizations?.name || ""; }
    } catch { /* memberships not set up yet → default org */ }
    const token = await issueSession({ role: tier, admin, uid: u.id, email: u.email, urole: assigned, org: orgId, mrole: mRole });
    return json({ token, role: tier, admin, urole: assigned, name: u.name, organization_id: orgId, organization_name: orgName });
  }

  // --- public: request a password-reset / set-password link ---------------
  if (action === "requestPasswordReset") {
    const email = String(body.email ?? "").trim().toLowerCase();
    if (emailOk(email)) {
      const { data: u } = await db.from("users").select("id,name,email").eq("email", email).maybeSingle();
      if (u) { const url = await resetLinkFor(u.id); await sendPasswordEmail(u.email, u.name, url); }
    }
    // Generic — never reveal whether the email is registered.
    return json({ ok: true, message: "If that email is registered, a password-reset link has been sent." });
  }

  // --- public: set a new password from a signed link ----------------------
  if (action === "setPassword") {
    const data = await readSigned(String(body.token ?? ""));
    const now = Math.floor(Date.now() / 1000);
    if (!data || data.purpose !== "setpw" || (typeof data.exp === "number" && data.exp < now)) {
      return json({ error: "This link is invalid or has expired. Request a new one." }, 400);
    }
    const password = String(body.password ?? "");
    if (password.length < 8) return json({ error: "Choose a password of at least 8 characters." }, 400);
    const hash = await hashPassword(password);
    // Receiving the emailed link also proves the address, so confirm it.
    const { error } = await db.from("users").update({ password: hash, email_verified: true, updated_at: new Date().toISOString() }).eq("id", data.uid);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // --- public: self-registration (creates a pending user + emails a link) --
  if (action === "registerUser") {
    const name = String(body.name ?? "").trim().slice(0, 120);
    const email = String(body.email ?? "").trim().toLowerCase().slice(0, 200);
    const phone = String(body.phone ?? "").trim().slice(0, 40);
    const whatsapp = String(body.whatsapp ?? "").trim().slice(0, 40);
    const requested_role = USER_ROLES.includes(String(body.role)) ? String(body.role) : "supplier";
    const password = String(body.password ?? "");
    if (!name || !emailOk(email)) return json({ error: "Please provide your name and a valid email address." }, 400);
    const { data: existing } = await db.from("users").select("id,status").eq("email", email).maybeSingle();
    let uid = existing?.id as string | undefined;
    if (existing) {
      // Refresh contact details only. Never touch the password or status of an
      // existing account from a public request (prevents account takeover).
      await db.from("users").update({ name, phone, whatsapp, requested_role, updated_at: new Date().toISOString() }).eq("id", uid);
    } else {
      if (password.length < 8) return json({ error: "Choose a password of at least 8 characters." }, 400);
      const password_hash = await hashPassword(password);
      const { data: inserted, error } = await db.from("users")
        .insert({ name, email, phone, whatsapp, requested_role, password: password_hash }).select("id").maybeSingle();
      if (error) return json({ error: (/does not exist|schema cache|Could not find the table/i.test(error.message)) ? "The users table isn't set up yet — run the account SQL first." : error.message }, 500);
      uid = inserted?.id;
    }
    if (uid) { const url = await verifyLinkFor(uid); await sendVerificationEmail(email, name, url); }
    // Generic response — never leak whether the email already existed or the link itself.
    return json({ ok: true, message: "Thanks! If your details are valid, a verification link has been sent to your email. An administrator will review your access." });
  }

  // --- public: verify an email from the link ------------------------------
  if (action === "verifyUser") {
    const data = await readSigned(String(body.token ?? ""));
    const now = Math.floor(Date.now() / 1000);
    if (!data || data.purpose !== "verify" || (typeof data.exp === "number" && data.exp < now)) {
      return json({ error: "This verification link is invalid or has expired." }, 400);
    }
    const { data: u } = await db.from("users").select("id,email,name,status").eq("id", data.uid).maybeSingle();
    if (!u) return json({ error: "We couldn't find this registration." }, 404);
    const status = u.status === "pending" ? "verified" : u.status;
    await db.from("users").update({ email_verified: true, status, updated_at: new Date().toISOString() }).eq("id", u.id);
    return json({ ok: true, name: u.name, email: u.email });
  }

  // --- Stage 4: billing webhook (provider callback; no session) -----------
  // Provider-agnostic: a billing system posts { secret, organizationId, plan?,
  // status? } to move a tenant between plans/statuses. Guarded by a shared
  // secret; disabled entirely when BILLING_WEBHOOK_SECRET is unset.
  if (action === "billingWebhook") {
    const secret = Deno.env.get("BILLING_WEBHOOK_SECRET");
    if (!secret) return json({ error: "Billing webhook is not configured." }, 404);
    if (String(body.secret ?? "") !== secret) return json({ error: "Forbidden" }, 403);
    const orgId = String(body.organizationId ?? "");
    if (!orgId) return json({ error: "organizationId required" }, 400);
    const patch: Record<string, unknown> = {};
    if (body.plan !== undefined) { if (!PLAN_IDS.includes(String(body.plan))) return json({ error: "Unknown plan" }, 400); patch.plan = String(body.plan); }
    if (body.status !== undefined) { if (!["trial", "active", "past_due", "suspended", "cancelled"].includes(String(body.status))) return json({ error: "Invalid status" }, 400); patch.status = String(body.status); }
    if (!Object.keys(patch).length) return json({ error: "Nothing to update" }, 400);
    const { error } = await db.from("organizations").update(patch).eq("id", orgId);
    if (error) return json({ error: error.message }, 500);
    await db.from("platform_audit").insert({ actor_email: "billing_webhook", action: "billing_update", target_organization_id: orgId, detail: patch });
    return json({ ok: true });
  }

  // --- everything else requires a valid token -----------------------------
  // The browser sends the token in the body (unchanged). External callers —
  // Postman, integrations — can use `Authorization: Bearer <token>` instead,
  // which is what those tools default to. Body wins if both are present.
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const session = await verifySession(body.token || bearer || undefined);
  if (!session) return json({ error: "Not authenticated" }, 401);
  const role = session.role as string;      // access tier: "rushroom" | "supplier"
  const isAdmin = session.admin === true;    // account-management privilege
  // Stage 1: the caller's tenant, taken ONLY from the signed session (never the
  // request body). Legacy tokens without an org fall back to the seed org.
  const organizationId = (session.org as string) || RUSHROOM_ORG_ID;
  // Stage 3: a "platform owner" is an admin of the seed (operator) organization
  // — the only role allowed to see cross-tenant/global surfaces (all users, the
  // tenant list, impersonation). A tenant's own Org Admin manages only its org.
  const isPlatformOwner = isAdmin && organizationId === RUSHROOM_ORG_ID;

  // --- Stage 2: central tenant scoping (per-request instance) -------------
  const tdb = makeTdb(organizationId);
  // Org-namespaced storage prefix for newly generated upload paths.
  const orgPrefix = `${organizationId}/`;
  const mrole = (session.mrole as string) ?? "";

  // --- tenant context for the caller (Stage 1; read-only, session-derived) --
  if (action === "orgContext") {
    let organizationName = "";
    try {
      const { data: o } = await db.from("organizations").select("name").eq("id", organizationId).maybeSingle();
      organizationName = o?.name || "";
    } catch { /* organizations table not set up yet */ }
    return json({
      organization_id: organizationId, organization_name: organizationName,
      role, urole: session.urole ?? null, admin: isAdmin, membership_role: session.mrole ?? null,
      platform_owner: isPlatformOwner, impersonating: session.imp === true,
    });
  }

  // --- Stage 4: plan entitlements, feature gating & AI metering -----------
  // Plan resolved lazily and cached per request (only when a gate needs it), so
  // non-gated actions pay no extra query. The seed org is 'internal' = unlimited.
  let _plan: string | null = null;
  const getPlan = async (): Promise<string> => {
    if (_plan === null) {
      try { const { data } = await db.from("organizations").select("plan").eq("id", organizationId).maybeSingle(); _plan = (data?.plan as string) || "internal"; }
      catch { _plan = "internal"; }
    }
    return _plan;
  };
  // Feature gate: block paywalled modules the plan doesn't include.
  const requiredFeature = FEATURE_FOR_ACTION[action];
  if (requiredFeature) {
    const p = planOf(await getPlan());
    if (!p.features.includes(requiredFeature)) {
      return json({ error: "Your plan doesn't include this feature — upgrade to use it.", code: "feature_locked", feature: requiredFeature }, 402);
    }
  }
  // AI cap: refuse new AI work once the monthly token budget is spent.
  if (AI_ACTIONS.has(action)) {
    const limit = planOf(await getPlan()).aiTokensPerMonth;
    if (limit !== null) {
      const used = await aiTokensUsed(organizationId, usagePeriod());
      if (used >= limit) return json({ error: "Monthly AI limit reached for your plan — upgrade to continue.", code: "ai_limit", used, limit }, 402);
    }
  }
  // Record one AI call's token usage (append-only ledger; best-effort, non-fatal).
  const meterAi = async (aj: any) => {
    try {
      const u = usageOf(aj);
      if (!((u.input_tokens || 0) + (u.output_tokens || 0))) return;
      await db.from("ai_usage_events").insert({ organization_id: organizationId, period: usagePeriod(), action, input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 });
    } catch { /* metering must never break an action */ }
  };

  // --- Stage 5: MFA (TOTP) self-service for individual accounts -----------
  if (action === "mfaStatus") {
    if (!session.uid) return json({ enabled: false, available: false });
    const { data: u } = await db.from("users").select("mfa_enabled").eq("id", session.uid).maybeSingle();
    return json({ enabled: !!u?.mfa_enabled, available: true });
  }
  if (action === "mfaEnrollStart") {
    if (!session.uid) return json({ error: "MFA is available for individual accounts, not the shared login." }, 400);
    const secret = newTotpSecret();
    const { error } = await db.from("users").update({ mfa_pending_secret: secret }).eq("id", session.uid);
    if (error) return json({ error: error.message }, 500);
    const label = encodeURIComponent(`Rushroom Portal:${session.email || session.uid}`);
    const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=Rushroom%20Portal&period=30&digits=6`;
    return json({ ok: true, secret, otpauth });
  }
  if (action === "mfaEnrollVerify") {
    if (!session.uid) return json({ error: "Not available" }, 400);
    const { data: u } = await db.from("users").select("mfa_pending_secret").eq("id", session.uid).maybeSingle();
    if (!u?.mfa_pending_secret) return json({ error: "Start MFA setup first." }, 400);
    if (!(await totpVerify(u.mfa_pending_secret, String(body.code ?? "")))) return json({ error: "That code isn't valid — check the time on your device and try again." }, 400);
    const { error } = await db.from("users").update({ mfa_enabled: true, mfa_secret: u.mfa_pending_secret, mfa_pending_secret: null }).eq("id", session.uid);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (action === "mfaDisable") {
    if (!session.uid) return json({ error: "Not available" }, 400);
    const { data: u } = await db.from("users").select("mfa_secret, mfa_enabled").eq("id", session.uid).maybeSingle();
    if (!u?.mfa_enabled) return json({ ok: true });
    if (!(await totpVerify(u.mfa_secret ?? "", String(body.code ?? "")))) return json({ error: "Enter a valid code to turn MFA off." }, 400);
    const { error } = await db.from("users").update({ mfa_enabled: false, mfa_secret: null, mfa_pending_secret: null }).eq("id", session.uid);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // --- admin account management (requires the admin privilege) ------------
  if (action === "adminListUsers") {
    if (!isPlatformOwner) return json({ error: "Admin only" }, 403);
    const { data, error } = await db.from("users").select("*").order("created_at", { ascending: false });
    if (error) return json({ error: (/does not exist|schema cache|Could not find the table/i.test(error.message)) ? "The users table isn't set up yet — run the account SQL first." : error.message }, 500);
    // Strip the password hash before returning; surface email-delivery status.
    const users = (data ?? []).map(({ password: _pw, ...u }) => u);
    return json({ users, emailConfigured: !!Deno.env.get("RESEND_API_KEY"), mailFrom: Deno.env.get("MAIL_FROM") || "" });
  }
  if (action === "adminSendTestEmail") {
    if (!isPlatformOwner) return json({ error: "Admin only" }, 403);
    const to = String(body.to ?? session.email ?? "").trim().toLowerCase();
    if (!emailOk(to)) return json({ error: "Enter a valid recipient email address." }, 400);
    if (!Deno.env.get("RESEND_API_KEY")) return json({ error: "Email is not configured yet — set RESEND_API_KEY in the function secrets." }, 400);
    const emailed = await sendEmail(to, "Rushroom Engineering & Compliance Platform — test email",
      `<p>This is a test email from the Rushroom AB Engineering & Compliance Platform.</p><p>If you can read this, email delivery is working — verification and password links will now reach users automatically.</p>`);
    if (!emailed) return json({ error: "Resend rejected the send — check the API key and that the MAIL_FROM domain is verified." }, 502);
    return json({ ok: true, emailed: true, to });
  }
  if (action === "adminUpdateUser") {
    if (!isPlatformOwner) return json({ error: "Admin only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.role !== undefined) { if (!ASSIGNABLE_ROLES.includes(String(body.role))) return json({ error: "Invalid role" }, 400); patch.role = String(body.role); }
    if (body.status !== undefined) { if (!USER_STATUSES.includes(String(body.status))) return json({ error: "Invalid status" }, 400); patch.status = String(body.status); }
    if (body.name !== undefined) patch.name = String(body.name).slice(0, 120);
    if (body.phone !== undefined) patch.phone = String(body.phone).slice(0, 40);
    if (body.whatsapp !== undefined) patch.whatsapp = String(body.whatsapp).slice(0, 40);
    if (body.notes !== undefined) patch.notes = String(body.notes).slice(0, 1000);
    const { error } = await db.from("users").update(patch).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (action === "adminDeleteUser") {
    if (!isPlatformOwner) return json({ error: "Admin only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const { error } = await db.from("users").delete().eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (action === "adminUserVerifyLink") {
    if (!isPlatformOwner) return json({ error: "Admin only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const { data: u } = await db.from("users").select("id,email,name").eq("id", id).maybeSingle();
    if (!u) return json({ error: "User not found" }, 404);
    const url = await verifyLinkFor(u.id);
    const emailed = await sendVerificationEmail(u.email, u.name, url);
    return json({ ok: true, verifyUrl: url, emailed });
  }
  if (action === "adminUserResetLink") {
    if (!isPlatformOwner) return json({ error: "Admin only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const { data: u } = await db.from("users").select("id,email,name").eq("id", id).maybeSingle();
    if (!u) return json({ error: "User not found" }, 404);
    const url = await resetLinkFor(u.id);
    const emailed = await sendPasswordEmail(u.email, u.name, url);
    return json({ ok: true, resetUrl: url, emailed });
  }

  // ================= Stage 3: Organization management ====================
  // Org Admins manage their OWN organization's members / invitations /
  // settings; "platform owner" = an admin of the seed (operator) organization.
  const MEMBERSHIP_ROLES = ["org_admin", "manager", "reviewer", "collaborator"];

  if (action === "orgMembers") {
    if (!isAdmin) return json({ error: "Admin only" }, 403);
    const { data, error } = await db.from("memberships")
      .select("id, role, status, created_at, user:user_id(id, name, email, status)")
      .eq("organization_id", organizationId).order("created_at");
    if (error) return json({ error: (/does not exist|schema cache|Could not find/i.test(error.message)) ? "The membership tables aren't set up yet — run the Stage 1 SQL first." : error.message }, 500);
    const members = (data ?? []).map((m: any) => ({
      membership_id: m.id, role: m.role, status: m.status, created_at: m.created_at,
      user_id: m.user?.id, name: m.user?.name || "", email: m.user?.email || "", account_status: m.user?.status || "",
    }));
    return json({ members });
  }

  if (action === "orgInviteMember") {
    if (!isAdmin) return json({ error: "Admin only" }, 403);
    const email = String(body.email ?? "").trim().toLowerCase();
    const role = String(body.role ?? "collaborator");
    if (!emailOk(email)) return json({ error: "Enter a valid email address." }, 400);
    if (!MEMBERSHIP_ROLES.includes(role)) return json({ error: "Invalid role" }, 400);
    // Global user identity — reuse an existing account, or create one. The org
    // admin's invite IS the approval (status=approved); the invitee still sets a
    // password (email_verified stays false until they do).
    let { data: u } = await db.from("users").select("id,email,name,status").eq("email", email).maybeSingle();
    let created = false;
    if (!u) {
      const assignedRole = role === "org_admin" ? "admin" : role === "manager" ? "internal" : role === "reviewer" ? "reviewer" : "supplier";
      const ins = await db.from("users").insert({ name: email.split("@")[0], email, requested_role: assignedRole, role: assignedRole, status: "approved", email_verified: false }).select("id,email,name").maybeSingle();
      if (ins.error) return json({ error: ins.error.message }, 500);
      u = ins.data as any; created = true;
    }
    const up = await db.from("memberships").upsert({ organization_id: organizationId, user_id: u!.id, role, status: "active", updated_at: new Date().toISOString() }, { onConflict: "organization_id,user_id" });
    if (up.error) return json({ error: up.error.message }, 500);
    await db.from("invitations").upsert({ organization_id: organizationId, email, role, status: "pending", invited_by: session.uid ?? null }, { onConflict: "organization_id,email" });
    let emailed = false, setUrl = "";
    if (created) { setUrl = await resetLinkFor(u!.id); emailed = await sendPasswordEmail(u!.email, u!.name, setUrl); }
    return json({ ok: true, created, emailed, setUrl: emailed ? "" : setUrl, role });
  }

  if (action === "orgUpdateMember") {
    if (!isAdmin) return json({ error: "Admin only" }, 403);
    const membershipId = String(body.membershipId ?? "");
    if (!membershipId) return json({ error: "membershipId required" }, 400);
    const { data: m } = await db.from("memberships").select("id, user_id, organization_id").eq("id", membershipId).maybeSingle();
    if (!m || m.organization_id !== organizationId) return json({ error: "Member not found" }, 404); // no cross-tenant edits
    if (m.user_id && m.user_id === session.uid) return json({ error: "You can't change your own membership here." }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.role !== undefined) { if (!MEMBERSHIP_ROLES.includes(String(body.role))) return json({ error: "Invalid role" }, 400); patch.role = String(body.role); }
    if (body.status !== undefined) { if (!["active", "suspended", "invited"].includes(String(body.status))) return json({ error: "Invalid status" }, 400); patch.status = String(body.status); }
    const { error } = await db.from("memberships").update(patch).eq("id", membershipId).eq("organization_id", organizationId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "orgSettings") {
    if (!isAdmin) return json({ error: "Admin only" }, 403);
    const { data: o } = await db.from("organizations").select("id,name,slug,status,plan,created_at").eq("id", organizationId).maybeSingle();
    const { count } = await db.from("memberships").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "active");
    return json({ organization: o || null, activeMembers: count ?? 0 });
  }

  if (action === "orgUpdateSettings") {
    if (!isAdmin) return json({ error: "Admin only" }, 403);
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = String(body.name).slice(0, 160);
    if (!Object.keys(patch).length) return json({ error: "Nothing to update" }, 400);
    const { error } = await db.from("organizations").update(patch).eq("id", organizationId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ================= Stage 3: Internal Admin Console + impersonation ======
  if (action === "platformTenants") {
    if (!isPlatformOwner) return json({ error: "Platform operators only" }, 403);
    const { data: orgs, error } = await db.from("organizations").select("id,name,slug,status,plan,created_at").order("created_at");
    if (error) return json({ error: error.message }, 500);
    const { data: mem } = await db.from("memberships").select("organization_id, status");
    const counts: Record<string, number> = {};
    for (const m of mem ?? []) if (m.status === "active") counts[m.organization_id] = (counts[m.organization_id] || 0) + 1;
    const tenants = (orgs ?? []).map((o: any) => ({ ...o, active_members: counts[o.id] || 0, is_seed: o.id === RUSHROOM_ORG_ID }));
    return json({ tenants });
  }

  if (action === "platformSetTenantStatus") {
    if (!isPlatformOwner) return json({ error: "Platform operators only" }, 403);
    const orgId = String(body.organizationId ?? "");
    const status = String(body.status ?? "");
    if (!orgId || !["trial", "active", "past_due", "suspended", "cancelled"].includes(status)) return json({ error: "Valid organizationId and status required" }, 400);
    if (orgId === RUSHROOM_ORG_ID) return json({ error: "The operator organization can't be suspended." }, 400);
    const { error } = await db.from("organizations").update({ status }).eq("id", orgId);
    if (error) return json({ error: error.message }, 500);
    await db.from("platform_audit").insert({ actor_user_id: session.uid ?? null, actor_email: session.email ?? null, action: "tenant_status_change", target_organization_id: orgId, detail: { status } });
    return json({ ok: true });
  }

  if (action === "platformImpersonate") {
    if (!isPlatformOwner) return json({ error: "Platform operators only" }, 403);
    const orgId = String(body.organizationId ?? "");
    const reason = String(body.reason ?? "").slice(0, 300);
    if (!orgId) return json({ error: "organizationId required" }, 400);
    const { data: o } = await db.from("organizations").select("id,name,status").eq("id", orgId).maybeSingle();
    if (!o) return json({ error: "Organization not found" }, 404);
    const IMP_TTL = 30 * 60; // time-boxed: 30 minutes
    const expIso = new Date((Math.floor(Date.now() / 1000) + IMP_TTL) * 1000).toISOString();
    // Least privilege: act as a non-admin member of the target tenant.
    const token = await issueSession({ role: "rushroom", admin: false, org: orgId, imp: true, actor: session.email ?? session.uid ?? "operator", urole: "support" }, IMP_TTL);
    await db.from("platform_audit").insert({ actor_user_id: session.uid ?? null, actor_email: session.email ?? null, action: "impersonate_start", target_organization_id: orgId, detail: { reason, expires_at: expIso } });
    return json({ ok: true, token, organization: { id: o.id, name: o.name }, expires_at: expIso });
  }

  if (action === "platformAudit") {
    if (!isPlatformOwner) return json({ error: "Platform operators only" }, 403);
    const limit = Math.min(2000, Math.max(1, Number(body.limit) || 100)); // higher for export
    const { data, error } = await db.from("platform_audit")
      .select("id, actor_email, action, target_organization_id, detail, created_at")
      .order("created_at", { ascending: false }).limit(limit);
    if (error) return json({ error: error.message }, 500);
    return json({ entries: data ?? [] });
  }

  // --- Stage 4: plan & usage for the caller's org (Org Admin) -------------
  if (action === "orgBilling") {
    if (!isAdmin) return json({ error: "Admin only" }, 403);
    const plan = await getPlan();
    const p = planOf(plan);
    const period = usagePeriod();
    const used = await aiTokensUsed(organizationId, period);
    let seats = 0;
    try { const { count } = await db.from("memberships").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "active"); seats = count ?? 0; } catch { /* memberships absent */ }
    return json({
      plan, plan_label: p.label, features: p.features, period,
      ai: { used, limit: p.aiTokensPerMonth },
      seats: { used: seats, limit: p.maxSeats },
      plans: PLAN_IDS.map((id) => ({ id, label: PLANS[id].label, features: PLANS[id].features, aiTokensPerMonth: PLANS[id].aiTokensPerMonth, maxSeats: PLANS[id].maxSeats })),
    });
  }

  // --- Stage 4: set a tenant's plan (Platform operator) ------------------
  if (action === "platformSetTenantPlan") {
    if (!isPlatformOwner) return json({ error: "Platform operators only" }, 403);
    const orgId = String(body.organizationId ?? "");
    const plan = String(body.plan ?? "");
    if (!orgId || !PLAN_IDS.includes(plan)) return json({ error: "Valid organizationId and plan required" }, 400);
    const { error } = await db.from("organizations").update({ plan }).eq("id", orgId);
    if (error) return json({ error: error.message }, 500);
    await db.from("platform_audit").insert({ actor_user_id: session.uid ?? null, actor_email: session.email ?? null, action: "tenant_plan_change", target_organization_id: orgId, detail: { plan } });
    return json({ ok: true });
  }

  if (action === "data") {
    const [{ data: steps }, { data: documents }] = await Promise.all([
      tdb("steps").select("*").order("step"),
      tdb("documents").select("*").order("sort").order("category"),
    ]);
    const s = role === "supplier" ? (steps ?? []).filter((r) => isSupplierStep(r.audience)) : (steps ?? []);
    const d = role === "supplier" ? (documents ?? []).filter((r) => isSupplierStep(r.audience)) : (documents ?? []);
    // Attach an "open" link: a short-lived signed URL for files stored here, or
    // the external URL for legacy/Drive-linked documents.
    const docs = await Promise.all(d.map(async (doc) => {
      // Documents are version-managed: attach the version history (newest first)
      // with signed links, and use the latest as the current file.
      let versions: any[] = [];
      const { data: vs } = await tdb("document_versions").select("*").eq("document_id", doc.id).order("created_at", { ascending: false });
      versions = await Promise.all((vs ?? []).map(async (v) => {
        const { data: s } = await db.storage.from(DOC_BUCKET).createSignedUrl(v.storage_path, 60 * 60);
        return { ...v, open_url: s?.signedUrl ?? "" };
      }));
      let open_url = "";
      if (versions.length) open_url = versions[0].open_url;
      else if (doc.storage_path) { const { data: s } = await db.storage.from(DOC_BUCKET).createSignedUrl(doc.storage_path, 60 * 60); open_url = s?.signedUrl ?? ""; }
      else open_url = doc.url || "";
      return { ...doc, open_url, versions };
    }));

    const allStandardVersionIds = docs.flatMap((doc) => (doc.versions || []).flatMap((v: any) => Array.isArray(v.source_standard_version_ids) ? v.source_standard_version_ids : []));
    const allSourceDocumentVersionIds = docs.flatMap((doc) => (doc.versions || []).map((v: any) => v.source_document_version_id).filter(Boolean));
    const standardVersionMap = new Map<string, any>();
    if (allStandardVersionIds.length) {
      const uniq = [...new Set(allStandardVersionIds)];
      const { data: vs } = await tdb("standard_versions").select("*, standard:standard_id(code,title)").in("id", uniq);
      for (const v of vs ?? []) standardVersionMap.set(v.id, v);
    }
    const sourceVersionMap = new Map<string, any>();
    if (allSourceDocumentVersionIds.length) {
      const uniq = [...new Set(allSourceDocumentVersionIds)];
      const { data: sv } = await tdb("document_versions").select("id,document_id,version,file_name,created_at").in("id", uniq);
      for (const v of sv ?? []) sourceVersionMap.set(v.id, v);
    }
    const enrichedDocs = docs.map((doc) => ({
      ...doc,
      versions: (doc.versions || []).map((v: any) => ({
        ...v,
        source_standard_versions: (Array.isArray(v.source_standard_version_ids) ? v.source_standard_version_ids : []).map((id: string) => standardVersionMap.get(id)).filter(Boolean),
        source_document_version: v.source_document_version_id ? sourceVersionMap.get(v.source_document_version_id) : null,
      })),
    }));

    return json({ role, steps: s, documents: enrichedDocs });
  }

  if (action === "setStatus") {
    const step = Number(body.step);
    const status = String(body.status ?? "").trim();
    if (!step || !status) return json({ error: "step and status required" }, 400);
    const { data: row } = await tdb("steps").select("audience").eq("step", step).maybeSingle();
    if (!row) return json({ error: "Unknown step" }, 404);
    if (role === "supplier" && !isSupplierStep(row.audience)) return json({ error: "Not allowed for this step" }, 403);
    const by = role === "supplier" ? `supplier${body.supplierLabel ? ` (${String(body.supplierLabel).slice(0, 60)})` : ""}` : "rushroom";
    const { error } = await tdb("steps").update({ status, updated_at: new Date().toISOString(), updated_by: by }).eq("step", step);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, step, status });
  }

  // --- action-plan management (Rushroom only) -----------------------------
  if (action === "addStep") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    // NB: the step's action text travels as `actionText` to avoid colliding with
    // the request router field `action`.
    const action_ = String(body.actionText ?? "").trim();
    if (!action_) return json({ error: "action text required" }, 400);
    const { data: maxRow } = await tdb("steps").select("step").order("step", { ascending: false }).limit(1).maybeSingle();
    const step = (maxRow?.step ?? 0) + 1;
    const audience = Array.isArray(body.audience) && body.audience.length ? body.audience.map((a: unknown) => String(a)) : ["internal"];
    const lp = body.lifecyclePhase && LIFECYCLE_PHASES.includes(String(body.lifecyclePhase)) ? String(body.lifecyclePhase) : null;
    const sc = body.scope && COMPLIANCE_SCOPES.includes(String(body.scope)) ? String(body.scope) : null;
    const row: Record<string, unknown> = {
      step,
      phase: String(body.phase ?? "Unphased").slice(0, 120) || "Unphased",
      action: action_.slice(0, 1000),
      owner: String(body.owner ?? "").slice(0, 200),
      where_how: String(body.where ?? "").slice(0, 300),
      evidence: String(body.evidence ?? "").slice(0, 400),
      folder: String(body.folder ?? "").slice(0, 80),
      priority: String(body.priority ?? "").slice(0, 80),
      status: String(body.status ?? "Open").slice(0, 80) || "Open",
      audience,
      lifecycle_phase: lp, scope: sc,
      updated_by: "rushroom",
    };
    let res = await tdb("steps").insert(row);
    if (res.error && /lifecycle_phase|scope|classification/i.test(res.error.message || "")) {
      const clean = { ...row }; delete clean.lifecycle_phase; delete clean.scope;
      res = await tdb("steps").insert(clean);
    }
    if (res.error) return json({ error: res.error.message }, 500);
    return json({ ok: true, step });
  }

  if (action === "updateStep") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const step = Number(body.step);
    if (!step) return json({ error: "step required" }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: "rushroom" };
    const limits: Record<string, number> = { phase: 120, owner: 200, priority: 80, status: 80, evidence: 400, folder: 80 };
    for (const k of Object.keys(limits)) if (body[k] !== undefined) patch[k] = String(body[k]).slice(0, limits[k]);
    if (body.actionText !== undefined) patch.action = String(body.actionText).slice(0, 1000);
    if (body.where !== undefined) patch.where_how = String(body.where).slice(0, 300);
    if (Array.isArray(body.audience)) patch.audience = body.audience.length ? body.audience.map((a: unknown) => String(a)) : ["internal"];
    if (body.lifecyclePhase !== undefined) patch.lifecycle_phase = body.lifecyclePhase && LIFECYCLE_PHASES.includes(String(body.lifecyclePhase)) ? String(body.lifecyclePhase) : null;
    if (body.scope !== undefined) patch.scope = body.scope && COMPLIANCE_SCOPES.includes(String(body.scope)) ? String(body.scope) : null;
    let res = await tdb("steps").update(patch).eq("step", step);
    if (res.error && /lifecycle_phase|scope|classification/i.test(res.error.message || "")) {
      const clean = { ...patch }; delete clean.lifecycle_phase; delete clean.scope;
      res = await tdb("steps").update(clean).eq("step", step);
    }
    if (res.error) return json({ error: res.error.message }, 500);
    return json({ ok: true, step });
  }

  if (action === "deleteStep") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const step = Number(body.step);
    if (!step) return json({ error: "step required" }, 400);
    const { error } = await tdb("steps").delete().eq("step", step);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "uploadUrl") {
    const path = `${orgPrefix}${role}/${Date.now()}-${safeName(String(body.fileName ?? "file"))}`;
    const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) return json({ error: error.message }, 500);
    return json({ signedUrl: data.signedUrl, token: data.token, path });
  }

  if (action === "recordUpload") {
    const path = String(body.path ?? "");
    const fileName = String(body.fileName ?? "");
    if (!path || !fileName) return json({ error: "path and fileName required" }, 400);
    // Defence-in-depth: a recorded file must live under this tenant's prefix.
    if (!path.startsWith(orgPrefix)) return json({ error: "Invalid upload path for this organization" }, 400);
    const { error } = await tdb("uploads").insert({
      step: body.step ? Number(body.step) : null,
      uploaded_role: role,
      supplier_label: String(body.supplierLabel ?? "").slice(0, 120),
      file_path: path,
      file_name: fileName.slice(0, 200),
      note: String(body.note ?? "").slice(0, 500),
    });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // --- document library management (Rushroom only) ------------------------
  if (action === "docUploadUrl") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const path = `${orgPrefix}${Date.now()}-${safeName(String(body.fileName ?? "file"))}`;
    const { data, error } = await db.storage.from(DOC_BUCKET).createSignedUploadUrl(path);
    if (error) return json({ error: error.message }, 500);
    return json({ signedUrl: data.signedUrl, token: data.token, path });
  }

  if (action === "addDocument") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const name = String(body.name ?? "").trim();
    if (!name) return json({ error: "name required" }, 400);
    const audience = Array.isArray(body.audience) && body.audience.length
      ? body.audience.map((a: unknown) => String(a)) : ["internal"];
    const kind = body.kind === "operational" ? "operational" : "template";
    const storagePath = String(body.storagePath ?? "").slice(0, 400);
    const lp = body.lifecyclePhase && LIFECYCLE_PHASES.includes(String(body.lifecyclePhase)) ? String(body.lifecyclePhase) : null;
    const sc = body.scope && COMPLIANCE_SCOPES.includes(String(body.scope)) ? String(body.scope) : null;
    const docRow: Record<string, unknown> = {
      category: (String(body.category ?? "").trim() || "Uncategorised").slice(0, 80),
      name: name.slice(0, 200),
      url: String(body.url ?? "").slice(0, 1000),
      storage_path: storagePath,
      kind,
      audience,
      lifecycle_phase: lp, scope: sc,
      classification_ai_generated: false,
    };
    let ins = await tdb("documents").insert(docRow).select("id").maybeSingle();
    if (ins.error && /lifecycle_phase|scope|classification/i.test(ins.error.message || "")) {
      const clean = { ...docRow }; delete clean.lifecycle_phase; delete clean.scope; delete clean.classification_ai_generated;
      ins = await tdb("documents").insert(clean).select("id").maybeSingle();
    }
    const doc = ins.data; const error = ins.error;
    if (error) return json({ error: error.message }, 500);
    // All documents are version-managed from the first upload onward.
    if (doc?.id) {
      const versionLabel = String(body.version ?? "").slice(0, 80);
      const fileName = String(body.fileName ?? "file").slice(0, 200);
      if (storagePath || versionLabel || fileName) {
        await insertDocumentVersion(tdb, {
          document_id: doc.id, version: versionLabel,
          file_name: fileName, storage_path: storagePath,
          notes: String(body.notes ?? "").slice(0, 1000), uploaded_by: "rushroom",
        });
      }
    }
    return json({ ok: true, id: doc?.id });
  }

  if (action === "createOperationalDocumentFromTemplate") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const templateDocumentId = String(body.templateDocumentId ?? "");
    if (!templateDocumentId) return json({ error: "templateDocumentId required" }, 400);

    const { data: templateDoc, error: templateErr } = await tdb("documents").select("id,name,category,url,storage_path,audience").eq("id", templateDocumentId).maybeSingle();
    if (templateErr || !templateDoc) return json({ error: "Template not found" }, 404);

    const { data: latestTemplateVersion } = await tdb("document_versions").select("id").eq("document_id", templateDocumentId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const sourceDocumentVersionId = latestTemplateVersion?.id || null;

    const name = String(body.name ?? "").trim() || `${templateDoc.name || "Template"} — As Operated`;
    const audience = Array.isArray(templateDoc.audience) && templateDoc.audience.length ? templateDoc.audience : ["internal"];
    const { data: doc, error } = await tdb("documents").insert({
      category: String(templateDoc.category ?? "Uncategorised").slice(0, 80),
      name: name.slice(0, 200),
      url: String(templateDoc.url ?? "").slice(0, 1000),
      storage_path: String(templateDoc.storage_path ?? "").slice(0, 400),
      kind: "operational",
      audience,
    }).select("id").maybeSingle();
    if (error) return json({ error: error.message }, 500);

    const version = String(body.version ?? "v1").trim() || "v1";
    const notes = String(body.notes ?? "").slice(0, 1000);
    if (doc?.id && templateDoc.storage_path) {
      await insertDocumentVersion(tdb, {
        document_id: doc.id,
        version: version.slice(0, 80),
        file_name: String(templateDoc.name || "template").slice(0, 200),
        storage_path: templateDoc.storage_path,
        notes,
        uploaded_by: "rushroom",
        source_document_version_id: sourceDocumentVersionId,
      });
    }
    return json({ ok: true, id: doc?.id });
  }

  if (action === "suggestDocumentVersion") {
    // Moved to portal-ai (2026-09-16). A client still posting it here is stale.
    return json({ error: "Action 'suggestDocumentVersion' moved to portal-ai. Refresh the page to pick up the new client.", moved_to: "portal-ai" }, 421);
  }

  if (action === "publishDocumentDraft") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const document_id = String(body.documentId ?? "").trim();
    const path = String(body.path ?? "");
    const draftText = String(body.draftText ?? "");
    const fileName = String(body.fileName ?? "draft.md");
    if (!path || !draftText.trim()) return json({ error: "path and draftText required" }, 400);

    const approvedChanges = Array.isArray(body.approvedChanges) ? body.approvedChanges : [];
    const noteText = [String(body.notes ?? "").slice(0, 1000), approvedChanges.length ? `Approved changes: ${approvedChanges.join(", ")}` : ""].filter(Boolean).join("\n");
    const sourceStandardVersionIds = Array.isArray(body.sourceStandardVersionIds) ? body.sourceStandardVersionIds.filter((v: unknown) => String(v ?? "").trim()) : [];
    let sourceDocumentVersionId = String(body.sourceDocumentVersionId ?? "").trim() || "";

    let targetDocumentId = document_id;
    if (!targetDocumentId) {
      const name = String(body.newDocumentName ?? "").trim() || "New As Operated";
      const templateDocumentId = String(body.templateDocumentId ?? "").trim();
      const category = String(body.category ?? "").trim() || (templateDocumentId ? "Uncategorised" : "Uncategorised");
      const audience = Array.isArray(body.audience) && body.audience.length ? body.audience.map((a: unknown) => String(a)) : ["internal"];
      let templateDoc: any = null;
      if (templateDocumentId) {
        const { data: found } = await tdb("documents").select("id,category,audience,storage_path").eq("id", templateDocumentId).maybeSingle();
        templateDoc = found;
      }
      const { data: doc, error: insertErr } = await tdb("documents").insert({
        category: String(templateDoc?.category ?? category).slice(0, 80),
        name: name.slice(0, 200),
        url: "",
        storage_path: path,
        kind: "operational",
        audience: Array.isArray(templateDoc?.audience) && templateDoc.audience.length ? templateDoc.audience : audience,
      }).select("id").maybeSingle();
      if (insertErr) return json({ error: insertErr.message }, 500);
      targetDocumentId = doc?.id || "";
      if (!sourceDocumentVersionId && templateDocumentId) {
        const { data: latestTemplateVersion } = await tdb("document_versions").select("id").eq("document_id", templateDocumentId).order("created_at", { ascending: false }).limit(1).maybeSingle();
        sourceDocumentVersionId = latestTemplateVersion?.id || "";
      }
    }
    if (!targetDocumentId) return json({ error: "documentId or newDocumentName required" }, 400);
    if (!sourceDocumentVersionId && document_id) {
      const { data: latestSourceVersion } = await tdb("document_versions").select("id").eq("document_id", document_id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      sourceDocumentVersionId = latestSourceVersion?.id || "";
    }

    const { error: insertErr } = await insertDocumentVersion(tdb, {
      document_id: targetDocumentId,
      version: String(body.version ?? "AI draft").slice(0, 80),
      file_name: fileName.slice(0, 200),
      storage_path: path,
      notes: noteText.slice(0, 1000),
      uploaded_by: "rushroom",
      source_document_version_id: sourceDocumentVersionId || null,
      source_standard_version_ids: sourceStandardVersionIds.length ? sourceStandardVersionIds : [],
    });
    if (insertErr) return json({ error: insertErr.message }, 500);
    await tdb("documents").update({ storage_path: path }).eq("id", targetDocumentId);
    return json({ ok: true, id: targetDocumentId });
  }

  if (action === "addDocumentVersion") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const document_id = String(body.documentId ?? "");
    const path = String(body.path ?? "");
    const fileName = String(body.fileName ?? "");
    const sourceStandardVersionIds = Array.isArray(body.sourceStandardVersionIds) ? body.sourceStandardVersionIds.filter((v: unknown) => String(v ?? "").trim()) : [];
    const sourceDocumentVersionId = String(body.sourceDocumentVersionId ?? "").trim() || null;
    if (!document_id || !path || !fileName) return json({ error: "documentId, path, fileName required" }, 400);
    const { error, version: newVersion, versionId } = await insertDocumentVersion(tdb, {
      document_id, version: String(body.version ?? "").slice(0, 80),
      file_name: fileName.slice(0, 200), storage_path: path,
      notes: String(body.notes ?? "").slice(0, 1000), uploaded_by: "rushroom",
      source_document_version_id: sourceDocumentVersionId,
      source_standard_version_ids: sourceStandardVersionIds.length ? sourceStandardVersionIds : [],
    });
    if (error) return json({ error: error.message }, 500);
    await tdb("documents").update({ storage_path: path }).eq("id", document_id); // keep current pointer in sync

    // PROP-043: a document revision is a change to every BOM node that links
    // it. Previously this action touched document_versions and nothing else, so
    // uploading Rev C of a drawing left the component's Change Log unchanged.
    // newVersion is the RESOLVED label — body.version is blank whenever the
    // version was auto-numbered, which is the default path from the UI.
    const audit = await recordDocumentRevision(tdb, session, document_id, newVersion, versionId);

    // PROP-044: when the revision is uploaded from a part's Documents tab, that
    // part's link follows the new revision — the user's intent is "this part now
    // uses the new drawing", and leaving it pointing at the old one would show
    // the row as stale the instant they uploaded it. Only the part they are
    // standing on advances; the others keep their link and surface a "newer
    // revision available" marker, which is the signal their owner needs rather
    // than a silent substitution.
    let advanced = false;
    const advanceFor = String(body.advance_component_id ?? "").trim();
    if (advanceFor && versionId) {
      const { data: priorVers } = await tdb("document_versions").select("id").eq("document_id", document_id);
      const priorIds = (priorVers || []).map((v: any) => v.id).filter((id: string) => id !== versionId);
      if (priorIds.length) {
        const { error: advErr } = await tdb("component_documents")
          .update({ document_version_id: versionId })
          .eq("component_id", advanceFor).in("document_version_id", priorIds);
        advanced = !advErr;
      }
    }
    return json({ ok: true, version: newVersion, advanced, ...audit });
  }

  if (action === "updateDocument") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const patch: Record<string, unknown> = {};
    if (body.kind !== undefined) patch.kind = body.kind === "operational" ? "operational" : "template";
    if (body.name !== undefined) patch.name = String(body.name).slice(0, 200);
    if (body.category !== undefined) patch.category = String(body.category).slice(0, 80);
    if (Array.isArray(body.audience)) patch.audience = body.audience.length ? body.audience.map((a: unknown) => String(a)) : ["internal"];
    if (!Object.keys(patch).length) return json({ error: "nothing to update" }, 400);
    const { error } = await tdb("documents").update(patch).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    // Moving a single-file template into the versioned operational track: seed v1.
    if (patch.kind === "operational") {
      const { data: doc } = await tdb("documents").select("storage_path").eq("id", id).maybeSingle();
      const { count } = await tdb("document_versions").select("id", { count: "exact", head: true }).eq("document_id", id);
      if (doc?.storage_path && !count) {
        await tdb("document_versions").insert({
          document_id: id, version: "v1", file_name: (doc.storage_path.split("/").pop() || "file"),
          storage_path: doc.storage_path, uploaded_by: "rushroom",
        });
      }
    }
    return json({ ok: true });
  }

  // Permanently delete a document + all its versions and stored files.
  // Documents are normally immutable; deletion is a super-user (admin) power.
  // Accepts a single { id } or bulk { ids: [...] }. Removes the files from the
  // documents bucket via the Storage API, then deletes the row (which cascades
  // to document_versions → as_operates_interpretations → passport links).
  if (action === "deleteDocument") {
    if (!isAdmin) return json({ error: "Only an administrator can delete documents." }, 403);
    const ids = Array.isArray(body.ids) ? body.ids.map((x: unknown) => String(x)) : (body.id ? [String(body.id)] : []);
    if (!ids.length) return json({ error: "id or ids required" }, 400);
    let deletedDocs = 0, deletedFiles = 0;
    const errors: any[] = [];
    for (const id of ids) {
      const { data: doc } = await tdb("documents").select("id, storage_path").eq("id", id).maybeSingle();
      if (!doc) { errors.push({ id, error: "not found" }); continue; }
      const { data: vers } = await tdb("document_versions").select("storage_path").eq("document_id", id);
      const paths = [doc.storage_path, ...((vers ?? []).map((v: any) => v.storage_path))].filter((p: unknown): p is string => typeof p === "string" && p.trim() !== "");
      if (paths.length) { try { const { error: rmErr } = await db.storage.from(DOC_BUCKET).remove(paths); if (!rmErr) deletedFiles += paths.length; } catch { /* file cleanup best-effort */ } }
      const { error } = await tdb("documents").delete().eq("id", id);
      if (error) { errors.push({ id, error: error.message }); continue; }
      deletedDocs++;
    }
    return json({ ok: true, deletedDocuments: deletedDocs, deletedFiles, errors });
  }

  // --- Standards & Regulations register -----------------------------------
  if (action === "standards") {
    const { data: stds } = await tdb("standards").select("*").order("code");
    const list = role === "supplier" ? (stds ?? []).filter((s) => isSupplierStep(s.audience)) : (stds ?? []);
    const ids = list.map((s) => s.id);
    let versions: any[] = [];
    if (ids.length) {
      const { data: vs } = await tdb("standard_versions").select("*").in("standard_id", ids).order("created_at", { ascending: false });
      versions = vs ?? [];
    }
    const withUrls = await Promise.all(versions.map(async (v) => {
      const { data: signed } = await db.storage.from(STD_BUCKET).createSignedUrl(v.storage_path, 60 * 60);
      return { ...v, open_url: signed?.signedUrl ?? "" };
    }));
    const byStd: Record<string, any[]> = {};
    for (const v of withUrls) (byStd[v.standard_id] ||= []).push(v);
    const result = list.map((s) => ({ ...s, versions: byStd[s.id] ?? [] }));
    return json({ role, standards: result });
  }

  if (action === "addStandard") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const code = String(body.code ?? "").trim();
    const title = String(body.title ?? "").trim();
    if (!code && !title) return json({ error: "code or title required" }, 400);
    const audience = Array.isArray(body.audience) && body.audience.length ? body.audience.map((a: unknown) => String(a)) : ["internal"];
    const row: Record<string, unknown> = {
      code: code.slice(0, 120), title: title.slice(0, 300), category: String(body.category ?? "").slice(0, 80), audience,
      reg_type: String(body.regType ?? "").slice(0, 60),
      jurisdiction: String(body.jurisdiction ?? "").slice(0, 60),
    };
    let res = await tdb("standards").insert(row).select("id").maybeSingle();
    // Self-heal if the optional reg_type / jurisdiction columns aren't added yet.
    if (res.error && /reg_type|jurisdiction/.test(res.error.message || "")) {
      const { reg_type: _r, jurisdiction: _j, ...base } = row;
      res = await tdb("standards").insert(base).select("id").maybeSingle();
    }
    if (res.error) return json({ error: res.error.message }, 500);
    return json({ ok: true, id: res.data?.id });
  }

  if (action === "updateStandard") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const patch: Record<string, unknown> = {};
    if (body.code !== undefined) patch.code = String(body.code).slice(0, 120);
    if (body.title !== undefined) patch.title = String(body.title).slice(0, 300);
    if (body.category !== undefined) patch.category = String(body.category).slice(0, 80);
    if (body.regType !== undefined) patch.reg_type = String(body.regType).slice(0, 60);
    if (body.jurisdiction !== undefined) patch.jurisdiction = String(body.jurisdiction).slice(0, 60);
    if (Array.isArray(body.audience)) patch.audience = body.audience.length ? body.audience.map((a: unknown) => String(a)) : ["internal"];
    if (!Object.keys(patch).length) return json({ error: "nothing to update" }, 400);
    let res = await tdb("standards").update(patch).eq("id", id);
    if (res.error && /reg_type|jurisdiction/.test(res.error.message || "")) {
      const { reg_type: _r, jurisdiction: _j, ...base } = patch;
      res = await tdb("standards").update(base).eq("id", id);
    }
    if (res.error) return json({ error: res.error.message }, 500);
    return json({ ok: true });
  }

  if (action === "deleteStandard") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const { data: vs } = await tdb("standard_versions").select("storage_path").eq("standard_id", id);
    const paths = (vs ?? []).map((v) => v.storage_path).filter(Boolean);
    if (paths.length) await db.storage.from(STD_BUCKET).remove(paths);
    const { error } = await tdb("standards").delete().eq("id", id); // cascade removes version rows
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "stdUploadUrl") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const path = `${orgPrefix}${Date.now()}-${safeName(String(body.fileName ?? "file"))}`;
    const { data, error } = await db.storage.from(STD_BUCKET).createSignedUploadUrl(path);
    if (error) return json({ error: error.message }, 500);
    return json({ signedUrl: data.signedUrl, token: data.token, path });
  }

  if (action === "addStandardVersion") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const standard_id = String(body.standardId ?? "");
    const path = String(body.path ?? "");
    const fileName = String(body.fileName ?? "");
    if (!standard_id || !path || !fileName) return json({ error: "standardId, path, fileName required" }, 400);
    let versionLabel = String(body.version ?? "").slice(0, 80);
    if (!versionLabel.trim()) {
      const { count } = await tdb("standard_versions").select("id", { count: "exact", head: true }).eq("standard_id", standard_id);
      versionLabel = `v${(count ?? 0) + 1}`;
    }
    const { error } = await tdb("standard_versions").insert({
      standard_id,
      version: versionLabel,
      effective_date: String(body.effectiveDate ?? "").slice(0, 40),
      notes: String(body.notes ?? "").slice(0, 1000),
      storage_path: path, file_name: fileName.slice(0, 200), uploaded_by: "rushroom",
    });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "suggestStandardMetadata") {
    // Moved to portal-ai (2026-09-16). A client still posting it here is stale.
    return json({ error: "Action 'suggestStandardMetadata' moved to portal-ai. Refresh the page to pick up the new client.", moved_to: "portal-ai" }, 421);
  }

  if (action === "suggestComponentMetadata") {
    // Moved to portal-ai (2026-09-16). A client still posting it here is stale.
    return json({ error: "Action 'suggestComponentMetadata' moved to portal-ai. Refresh the page to pick up the new client.", moved_to: "portal-ai" }, 421);
  }

  if (action === "suggestFileMetadata") {
    // Moved to portal-ai (2026-09-16). A client still posting it here is stale.
    return json({ error: "Action 'suggestFileMetadata' moved to portal-ai. Refresh the page to pick up the new client.", moved_to: "portal-ai" }, 421);
  }

  if (action === "extractDrawingMeta") {
    // Never lived here, but answered anyway: if portal-ai is behind the frontend
    // during a deploy, "served elsewhere" is a far more useful reply than
    // "unknown action", which reads as a bug in the client.
    return json({ error: "Action 'extractDrawingMeta' is served by portal-ai. Refresh the page to pick up the new client.", moved_to: "portal-ai" }, 421);
  }

  if (action === "deleteStandardVersion") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const { data: v } = await tdb("standard_versions").select("storage_path").eq("id", id).maybeSingle();
    if (v?.storage_path) await db.storage.from(STD_BUCKET).remove([v.storage_path]);
    const { error } = await tdb("standard_versions").delete().eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // --- AI deviation monitoring (Rushroom only) ----------------------------
  if (action === "deviations") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    // Fetch the latest scan and the one before it, so we can flag findings that
    // are new since the previous scan (yellow-marked in the UI).
    const { data: scans } = await tdb("deviation_scans").select("*").order("created_at", { ascending: false }).limit(2);
    const scan = scans?.[0];
    const prevScan = scans?.[1];
    if (!scan) return json({ scan: null, findings: [] });
    const sigOf = (f: any) => `${f.severity}|${String(f.title || "").trim().toLowerCase()}|${String(f.document || "").trim().toLowerCase()}|${String(f.standard || "").trim().toLowerCase()}`;
    let prevSet: Set<string> | null = null;
    if (prevScan) {
      const { data: prevFindings } = await tdb("deviation_findings").select("severity,title,document,standard").eq("scan_id", prevScan.id);
      prevSet = new Set((prevFindings ?? []).map(sigOf));
    }
    const { data: findings } = await tdb("deviation_findings").select("*").eq("scan_id", scan.id);
    const withNew = (findings ?? []).map((f) => ({ ...f, is_new: prevSet ? !prevSet.has(sigOf(f)) : false }));
    return json({ scan, findings: withNew, hasPrevious: !!prevScan });
  }

  if (action === "runDeviationScan") {
    // Moved to portal-ai (2026-09-16). A client still posting it here is stale.
    return json({ error: "Action 'runDeviationScan' moved to portal-ai. Refresh the page to pick up the new client.", moved_to: "portal-ai" }, 421);
  }

  if (action === "deleteUpload") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "");
    if (!id) return json({ error: "id required" }, 400);
    const { data: u } = await tdb("uploads").select("file_path").eq("id", id).maybeSingle();
    if (u?.file_path) await db.storage.from(BUCKET).remove([u.file_path]);
    const { error } = await tdb("uploads").delete().eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "uploads") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const { data, error } = await tdb("uploads").select("*").order("created_at", { ascending: false }).limit(200);
    if (error) return json({ error: error.message }, 500);
    // Attach short-lived signed download links
    const withUrls = await Promise.all((data ?? []).map(async (u) => {
      const { data: signed } = await db.storage.from(BUCKET).createSignedUrl(u.file_path, 60 * 30);
      return { ...u, download_url: signed?.signedUrl ?? "" };
    }));
    return json({ uploads: withUrls });
  }

  // ---- LEVEL 2: Structured Clause-Level Interpretations ----

  if (action === "extractStandardClauses") {
    // Moved to portal-ai (2026-09-16). A client still posting it here is stale.
    return json({ error: "Action 'extractStandardClauses' moved to portal-ai. Refresh the page to pick up the new client.", moved_to: "portal-ai" }, 421);
  }

  if (action === "generateInterpretations") {
    // Moved to portal-ai (2026-09-16). A client still posting it here is stale.
    return json({ error: "Action 'generateInterpretations' moved to portal-ai. Refresh the page to pick up the new client.", moved_to: "portal-ai" }, 421);
  }

  if (action === "saveInterpretation") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "").trim();
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (body.interpretationText !== undefined) patch.interpretation_text = String(body.interpretationText).slice(0, 4000);
    if (body.complianceStatus !== undefined) {
      if (!["compliant", "deviation", "not_applicable", "pending"].includes(String(body.complianceStatus))) {
        return json({ error: "Invalid complianceStatus" }, 400);
      }
      patch.compliance_status = String(body.complianceStatus);
    }
    if (body.rationale !== undefined) patch.rationale = String(body.rationale).slice(0, 2000);
    if (body.deviationDescription !== undefined) patch.deviation_description = String(body.deviationDescription).slice(0, 2000);
    if (body.deviationAcceptedBy !== undefined && String(body.deviationAcceptedBy).trim()) {
      patch.deviation_accepted_by = String(body.deviationAcceptedBy).slice(0, 120);
      patch.deviation_accepted_at = new Date().toISOString();
    }
    if (body.reviewedBy !== undefined && String(body.reviewedBy).trim()) {
      patch.reviewed_by = String(body.reviewedBy).slice(0, 120);
      patch.reviewed_at = new Date().toISOString();
    }

    if (!id || !Object.keys(patch).length) return json({ error: "id and at least one field required" }, 400);

    // When the interpretation text changes, snapshot the prior text so the UI can
    // show a version-to-version diff. Optional column — self-heals if absent.
    if (patch.interpretation_text !== undefined) {
      const { data: cur } = await tdb("as_operates_interpretations").select("interpretation_text").eq("id", id).maybeSingle();
      const prior = cur?.interpretation_text ?? "";
      if (prior && prior !== patch.interpretation_text) patch.previous_interpretation_text = prior;
    }
    let upd = await tdb("as_operates_interpretations").update(patch).eq("id", id);
    if (upd.error && /previous_interpretation_text/.test(upd.error.message || "")) {
      const { previous_interpretation_text: _p, ...noPrev } = patch;
      upd = await tdb("as_operates_interpretations").update(noPrev).eq("id", id);
    }
    if (upd.error) return json({ error: upd.error.message }, 500);
    return json({ ok: true });
  }

  if (action === "getInterpretations") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const documentVersionId = String(body.documentVersionId ?? "").trim();
    if (!documentVersionId) return json({ error: "documentVersionId required" }, 400);

    // `*` includes the optional previous_interpretation_text column when present
    // (and simply omits it otherwise — no schema-cache error).
    const { data: interps, error } = await tdb("as_operates_interpretations")
      .select(`
        *,
        clause:clause_id(id,standard_version_id,clause_ref,clause_title,clause_text,requirement_type,
          standard:standard_version_id(standard:standard_id(code,title)))
      `).eq("document_version_id", documentVersionId).order("updated_at", { ascending: false });

    if (error) return json({ error: error.message }, 500);
    return json({ interpretations: interps ?? [] });
  }

  if (action === "getClausesForStandard") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const standardVersionId = String(body.standardVersionId ?? "").trim();
    if (!standardVersionId) return json({ error: "standardVersionId required" }, 400);

    const { data: clauses, error } = await tdb("standard_clauses")
      .select("*").eq("standard_version_id", standardVersionId).order("sort_order").order("clause_ref");

    if (error) return json({ error: error.message }, 500);
    return json({ clauses: clauses ?? [] });
  }

  if (action === "complianceMatrix") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    // Returns: [document_version rows] × [clause rows] with interpretation status cells
    const documentVersionIds = Array.isArray(body.documentVersionIds) ? body.documentVersionIds.filter((v: unknown) => String(v ?? "").trim()) : [];
    const standardVersionIds = Array.isArray(body.standardVersionIds) ? body.standardVersionIds.filter((v: unknown) => String(v ?? "").trim()) : [];

    if (!documentVersionIds.length && !standardVersionIds.length) {
      return json({ error: "Provide documentVersionIds or standardVersionIds" }, 400);
    }

    let docsQ = tdb("document_versions").select("id,version,file_name,document_id,document:document_id(name)");
    if (documentVersionIds.length) {
      docsQ = docsQ.in("id", documentVersionIds);
    } else {
      docsQ = docsQ.limit(50); // default limit
    }
    const { data: docs } = await docsQ;

    let clausesQ = tdb("standard_clauses").select("id,standard_version_id,clause_ref,clause_title");
    if (standardVersionIds.length) {
      clausesQ = clausesQ.in("standard_version_id", standardVersionIds);
    } else {
      clausesQ = clausesQ.limit(100); // default limit
    }
    const { data: clauses } = await clausesQ.order("sort_order").order("clause_ref");

    const docIds = (docs ?? []).map((d) => d.id);
    const clauseIds = (clauses ?? []).map((c) => c.id);

    let matrix: any[] = [];
    if (docIds.length && clauseIds.length) {
      const { data: interps } = await tdb("as_operates_interpretations")
        .select("clause_id,document_version_id,compliance_status,reviewed_by,ai_generated")
        .in("document_version_id", docIds)
        .in("clause_id", clauseIds);

      // Build matrix: each cell is { clause_id, doc_id, status, reviewed, ai_gen }
      matrix = clauseIds.flatMap((cid) =>
        docIds.map((did) => {
          const interp = (interps ?? []).find((i) => i.clause_id === cid && i.document_version_id === did);
          return {
            clause_id: cid,
            document_version_id: did,
            status: interp?.compliance_status ?? "pending",
            reviewed_by: interp?.reviewed_by ?? null,
            ai_generated: interp?.ai_generated ?? false,
          };
        })
      );
    }

    return json({ docs: docs ?? [], clauses: clauses ?? [], matrix });
  }

  // --- Requirement links: cross-document clause/text linking (Rushroom only) ---
  // Endpoints are (type, id) pairs: 'clause' -> standard_clauses, or
  // 'document_version' -> document_versions. Links are bidirectional in the UI.
  {
    const RL_ENDPOINT_TYPES = ["clause", "document_version", "statement"];
    const RL_LINK_TYPES = ["same_clause", "citation", "implements", "similar_intent", "defines_terms_for", "supersedes", "conflicts_with"];
    const RL_STATUSES = ["proposed", "accepted", "rejected", "flagged", "archived"];
    const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

    // Resolve a plain-language label for each (type,id) endpoint referenced by a set of links.
    const labelEndpoints = async (links: any[]) => {
      const clauseIds = new Set<string>(), docVerIds = new Set<string>(), stmtIds = new Set<string>();
      const add = (t: string, id: string) => { if (t === "clause") clauseIds.add(id); else if (t === "document_version") docVerIds.add(id); else if (t === "statement") stmtIds.add(id); };
      for (const l of links) { add(l.from_type, l.from_id); add(l.to_type, l.to_id); }
      const clauseMap = new Map<string, any>(), docMap = new Map<string, any>(), stmtMap = new Map<string, any>();
      if (clauseIds.size) {
        const { data } = await tdb("standard_clauses")
          .select("id,clause_ref,clause_title,standard_version:standard_version_id(version,standard:standard_id(code,title))")
          .in("id", [...clauseIds]);
        for (const c of data ?? []) {
          const std = (c as any).standard_version?.standard;
          const code = std?.code || std?.title || "Standard";
          clauseMap.set(c.id, { type: "clause", id: c.id, ref: c.clause_ref, label: `${code} ${c.clause_ref}`, title: c.clause_title || "" });
        }
      }
      if (docVerIds.size) {
        const { data } = await tdb("document_versions")
          .select("id,version,document:document_id(name)").in("id", [...docVerIds]);
        for (const v of data ?? []) {
          const name = (v as any).document?.name || "Document";
          docMap.set(v.id, { type: "document_version", id: v.id, ref: v.version || "", label: `${name}${v.version ? " " + v.version : ""}`, title: "" });
        }
      }
      if (stmtIds.size) {
        const { data } = await tdb("document_statements")
          .select("id,seq,text,document_version:document_version_id(version,document:document_id(name))").in("id", [...stmtIds]);
        for (const s of data ?? []) {
          const dv = (s as any).document_version;
          const name = dv?.document?.name || "Document";
          const para = `¶${(Number(s.seq) || 0) + 1}`;
          stmtMap.set(s.id, { type: "statement", id: s.id, ref: para, label: `${name}${dv?.version ? " " + dv.version : ""} ${para}`, title: String(s.text || "").slice(0, 160) });
        }
      }
      const resolve = (t: string, id: string) => (t === "clause" ? clauseMap.get(id) : t === "document_version" ? docMap.get(id) : t === "statement" ? stmtMap.get(id) : null) || { type: t, id, ref: "", label: "(removed)", title: "" };
      return links.map((l) => ({ ...l, from: resolve(l.from_type, l.from_id), to: resolve(l.to_type, l.to_id) }));
    };

    if (action === "listRequirementLinks") {
      if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
      const entityType = String(body.entityType ?? "").trim();
      const entityId = String(body.entityId ?? "").trim();
      if (!RL_ENDPOINT_TYPES.includes(entityType) || !isUuid(entityId)) return json({ error: "Valid entityType and entityId required" }, 400);
      // Links where the entity is on either side (bidirectional). Two queries, merged.
      const [a, b] = await Promise.all([
        tdb("requirement_links").select("*").eq("from_type", entityType).eq("from_id", entityId),
        tdb("requirement_links").select("*").eq("to_type", entityType).eq("to_id", entityId),
      ]);
      if (a.error) return json({ error: a.error.message }, 500);
      if (b.error) return json({ error: b.error.message }, 500);
      const seen = new Set<string>(), merged: any[] = [];
      for (const l of [...(a.data ?? []), ...(b.data ?? [])]) { if (!seen.has(l.id)) { seen.add(l.id); merged.push(l); } }
      merged.sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
      return json({ links: await labelEndpoints(merged) });
    }

    if (action === "createRequirementLink") {
      if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
      const fromType = String(body.fromType ?? "").trim(), toType = String(body.toType ?? "").trim();
      const fromId = String(body.fromId ?? "").trim(), toId = String(body.toId ?? "").trim();
      const linkType = String(body.linkType ?? "same_clause").trim();
      if (!RL_ENDPOINT_TYPES.includes(fromType) || !RL_ENDPOINT_TYPES.includes(toType)) return json({ error: "Invalid endpoint type" }, 400);
      if (!isUuid(fromId) || !isUuid(toId)) return json({ error: "Invalid endpoint id" }, 400);
      if (!RL_LINK_TYPES.includes(linkType)) return json({ error: "Invalid linkType" }, 400);
      if (fromType === toType && fromId === toId) return json({ error: "A text unit can't link to itself" }, 400);
      const row: Record<string, unknown> = {
        from_type: fromType, from_id: fromId, to_type: toType, to_id: toId, link_type: linkType,
        source: "manual", status: "accepted", confidence: 1.0,
        rationale: body.rationale !== undefined ? String(body.rationale).slice(0, 2000) : null,
        evidence_from: body.evidenceFrom !== undefined ? String(body.evidenceFrom).slice(0, 2000) : null,
        evidence_to: body.evidenceTo !== undefined ? String(body.evidenceTo).slice(0, 2000) : null,
        created_by: body.createdBy !== undefined ? String(body.createdBy).slice(0, 120) : (session.urole || "rushroom"),
        reviewed_by: body.createdBy !== undefined ? String(body.createdBy).slice(0, 120) : (session.urole || "rushroom"),
        reviewed_at: new Date().toISOString(),
      };
      const { data, error } = await tdb("requirement_links").insert(row).select("id").maybeSingle();
      if (error) {
        if (/duplicate key|unique/i.test(error.message)) return json({ error: "That exact link already exists." }, 409);
        return json({ error: error.message }, 500);
      }
      return json({ ok: true, id: data?.id });
    }

    if (action === "setRequirementLinkStatus") {
      if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
      const id = String(body.id ?? "").trim();
      const status = String(body.status ?? "").trim();
      if (!isUuid(id) || !RL_STATUSES.includes(status)) return json({ error: "Valid id and status required" }, 400);
      const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
      if (status === "accepted" || status === "rejected") {
        patch.reviewed_by = body.reviewedBy !== undefined ? String(body.reviewedBy).slice(0, 120) : (session.urole || "rushroom");
        patch.reviewed_at = new Date().toISOString();
      }
      const { error } = await tdb("requirement_links").update(patch).eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "deleteRequirementLink") {
      if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
      const id = String(body.id ?? "").trim();
      if (!isUuid(id)) return json({ error: "Valid id required" }, 400);
      const { error } = await tdb("requirement_links").delete().eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // Batch: every link touching any of the given clauses (for inline chips).
    if (action === "listRequirementLinksForClauses") {
      if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
      const clauseIds = (Array.isArray(body.clauseIds) ? body.clauseIds : []).map((v: unknown) => String(v ?? "")).filter(isUuid);
      if (!clauseIds.length) return json({ links: [] });
      const [a, b] = await Promise.all([
        tdb("requirement_links").select("*").eq("from_type", "clause").in("from_id", clauseIds),
        tdb("requirement_links").select("*").eq("to_type", "clause").in("to_id", clauseIds),
      ]);
      if (a.error) return json({ error: a.error.message }, 500);
      if (b.error) return json({ error: b.error.message }, 500);
      const seen = new Set<string>(), merged: any[] = [];
      for (const l of [...(a.data ?? []), ...(b.data ?? [])]) { if (!seen.has(l.id)) { seen.add(l.id); merged.push(l); } }
      return json({ links: await labelEndpoints(merged) });
    }

    // Batch: every link touching any of the given document versions OR any of
    // their paragraphs (statements), so the document-side view rolls both up.
    if (action === "listRequirementLinksForDocumentVersions") {
      if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
      const verIds = (Array.isArray(body.documentVersionIds) ? body.documentVersionIds : []).map((v: unknown) => String(v ?? "")).filter(isUuid);
      if (!verIds.length) return json({ links: [] });
      // Statements belonging to these versions (paragraph-level links).
      const { data: stmts } = await tdb("document_statements").select("id").in("document_version_id", verIds);
      const stmtIds = (stmts ?? []).map((s: any) => s.id);
      const queries = [
        tdb("requirement_links").select("*").eq("from_type", "document_version").in("from_id", verIds),
        tdb("requirement_links").select("*").eq("to_type", "document_version").in("to_id", verIds),
      ];
      if (stmtIds.length) {
        queries.push(tdb("requirement_links").select("*").eq("from_type", "statement").in("from_id", stmtIds));
        queries.push(tdb("requirement_links").select("*").eq("to_type", "statement").in("to_id", stmtIds));
      }
      const results = await Promise.all(queries);
      for (const r of results) if (r.error) return json({ error: r.error.message }, 500);
      const seen = new Set<string>(), merged: any[] = [];
      for (const r of results) for (const l of (r.data ?? [])) { if (!seen.has(l.id)) { seen.add(l.id); merged.push(l); } }
      return json({ links: await labelEndpoints(merged) });
    }

    // AI: propose semantic links from a clause to clauses in OTHER standards.
    // Proposals land as status='proposed' (source='ai_assisted') for human review.
  if (action === "suggestRequirementLinks") {
    // Moved to portal-ai (2026-09-16). A client still posting it here is stale.
    return json({ error: "Action 'suggestRequirementLinks' moved to portal-ai. Refresh the page to pick up the new client.", moved_to: "portal-ai" }, 421);
  }

    // Review queue: all links in the given statuses (default proposed + flagged),
    // labelled and newest-first, for one-screen triage across every clause.
    if (action === "listRequirementLinksQueue") {
      if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
      const wanted = (Array.isArray(body.statuses) ? body.statuses : []).map((s: unknown) => String(s)).filter((s: string) => RL_STATUSES.includes(s));
      const statuses = wanted.length ? wanted : ["proposed", "flagged"];
      const { data, error } = await tdb("requirement_links").select("*")
        .in("status", statuses).order("created_at", { ascending: false }).limit(200);
      if (error) return json({ error: error.message }, 500);
      return json({ links: await labelEndpoints(data ?? []) });
    }

    // Deterministic citation detection: parse a standard version's clause text for
    // explicit references ("clause 4.11.6", "EN 62471 4.3") and, where the target
    // clause exists, create exact 'citation' links (source='cited', accepted).
    if (action === "detectClauseCitations") {
      if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
      const standardVersionId = String(body.standardVersionId ?? "").trim();
      if (!isUuid(standardVersionId)) return json({ error: "Valid standardVersionId required" }, 400);

      const { data: srcClauses, error: scErr } = await tdb("standard_clauses")
        .select("id,clause_ref,clause_text").eq("standard_version_id", standardVersionId);
      if (scErr) return json({ error: scErr.message }, 500);
      if (!srcClauses || !srcClauses.length) return json({ ok: true, created: 0, scanned: 0, matched: 0 });

      const normRef = (s: unknown) => String(s ?? "").replace(/^\s*(?:clause|subclause|§|point)\s+/i, "").replace(/[^\d.]/g, "").replace(/\.+$/, "");
      const normCode = (s: unknown) => String(s ?? "").toUpperCase().replace(/\s+/g, " ").replace(/\s*:\s*\d{4}.*$/, "").trim();
      // Clause number requires at least one dot (e.g. "4.11") to keep precision high.
      const CROSS_RE = /\b((?:EN|IEC|ISO|EN\s?ISO|EN\s?IEC|CISPR)\s?\d{3,5}(?:-\d+)*)(?::\d{4}(?:\+A\d+(?::\d{4})?)?)?[,\s]+(?:clause\s+|subclause\s+|§\s*)?(\d+(?:\.\d+)+)\b/gi;
      const INTRA_RE = /\b(?:clause|subclause|§)\s+(\d+(?:\.\d+)+)\b/gi;

      const selfRef = new Map<string, string>();
      for (const c of srcClauses) selfRef.set(normRef(c.clause_ref), c.id);

      const crossRefs: { src: string; code: string; ref: string }[] = [];
      const intraRefs: { src: string; ref: string }[] = [];
      const codesNeeded = new Set<string>();
      for (const c of srcClauses) {
        const text = String(c.clause_text || "");
        for (const m of text.matchAll(CROSS_RE)) { const code = normCode(m[1]); const ref = normRef(m[2]); if (code && ref) { crossRefs.push({ src: c.id, code, ref }); codesNeeded.add(code); } }
        for (const m of text.matchAll(INTRA_RE)) { const ref = normRef(m[1]); if (ref) intraRefs.push({ src: c.id, ref }); }
      }

      // Resolve referenced standard codes → their clauses (any version).
      const crossLookup = new Map<string, string>(); // `${code}::${ref}` -> target clause id
      if (codesNeeded.size) {
        const { data: allStds } = await tdb("standards").select("id,code,standard_versions(id)");
        const versionIds: string[] = [];
        const versionToCode = new Map<string, string>();
        for (const s of allStds ?? []) {
          const code = normCode(s.code);
          if (!codesNeeded.has(code)) continue;
          for (const v of ((s as any).standard_versions ?? [])) { versionIds.push(v.id); versionToCode.set(v.id, code); }
        }
        if (versionIds.length) {
          const { data: tgt } = await tdb("standard_clauses").select("id,standard_version_id,clause_ref").in("standard_version_id", versionIds);
          for (const tc of tgt ?? []) {
            const code = versionToCode.get(tc.standard_version_id); if (!code) continue;
            const key = `${code}::${normRef(tc.clause_ref)}`;
            if (!crossLookup.has(key)) crossLookup.set(key, tc.id);
          }
        }
      }

      const seen = new Set<string>();
      const now = new Date().toISOString();
      const rows: any[] = [];
      const pushLink = (srcId: string, tgtId: string | undefined) => {
        if (!tgtId || tgtId === srcId) return;
        const k = `${srcId}->${tgtId}`; if (seen.has(k)) return; seen.add(k);
        rows.push({ from_type: "clause", from_id: srcId, to_type: "clause", to_id: tgtId, link_type: "citation", source: "cited", status: "accepted", confidence: 1.0, rationale: "Detected from a citation in the clause text.", created_by: "Citation", reviewed_by: "Citation", reviewed_at: now, created_at: now, updated_at: now });
      };
      for (const r of intraRefs) pushLink(r.src, selfRef.get(r.ref));
      for (const r of crossRefs) pushLink(r.src, crossLookup.get(`${r.code}::${r.ref}`));

      let created = 0;
      if (rows.length) {
        const { data: ins, error } = await tdb("requirement_links")
          .upsert(rows, { onConflict: "from_type,from_id,to_type,to_id,link_type", ignoreDuplicates: true }).select("id");
        if (error) return json({ error: error.message }, 500);
        created = (ins ?? []).length;
      }
      return json({ ok: true, created, scanned: srcClauses.length, matched: rows.length });
    }

    // As-Operated statements (addressable paragraphs of a document version).
    if (action === "listDocumentStatements") {
      if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
      const dv = String(body.documentVersionId ?? "").trim();
      if (!isUuid(dv)) return json({ error: "Valid documentVersionId required" }, 400);
      const { data, error } = await tdb("document_statements").select("*").eq("document_version_id", dv).order("seq");
      if (error) return json({ error: error.message }, 500);
      return json({ statements: data ?? [] });
    }

    // Replace the paragraph set for a version (segmented client-side from the file).
    if (action === "saveDocumentStatements") {
      if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
      const dv = String(body.documentVersionId ?? "").trim();
      if (!isUuid(dv)) return json({ error: "Valid documentVersionId required" }, 400);
      const input = Array.isArray(body.statements) ? body.statements : [];
      const rows = input.map((s: any, i: number) => ({
        document_version_id: dv,
        seq: Number.isInteger(s?.seq) ? s.seq : i,
        text: String(s?.text ?? "").slice(0, 8000),
        anchor: s?.anchor != null ? String(s.anchor).slice(0, 300) : null,
      })).filter((r: any) => r.text.trim());
      // Re-segmenting replaces this version's paragraphs. Delete links that point at
      // the old statements first, so no requirement_link is left dangling.
      const { data: oldStmts } = await tdb("document_statements").select("id").eq("document_version_id", dv);
      const oldIds = (oldStmts ?? []).map((r: any) => r.id);
      let removedLinks = 0;
      if (oldIds.length) {
        const [rf, rt] = await Promise.all([
          tdb("requirement_links").delete().eq("from_type", "statement").in("from_id", oldIds).select("id"),
          tdb("requirement_links").delete().eq("to_type", "statement").in("to_id", oldIds).select("id"),
        ]);
        removedLinks = (rf.data?.length ?? 0) + (rt.data?.length ?? 0);
      }
      const del = await tdb("document_statements").delete().eq("document_version_id", dv);
      if (del.error) return json({ error: del.error.message }, 500);
      if (rows.length) {
        const { error } = await tdb("document_statements").insert(rows);
        if (error) return json({ error: error.message }, 500);
      }
      return json({ ok: true, count: rows.length, removedLinks });
    }

    // Batch: every link touching any of the given statements (for the paragraph view).
    if (action === "listRequirementLinksForStatements") {
      if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
      const stmtIds = (Array.isArray(body.statementIds) ? body.statementIds : []).map((v: unknown) => String(v ?? "")).filter(isUuid);
      if (!stmtIds.length) return json({ links: [] });
      const [a, b] = await Promise.all([
        tdb("requirement_links").select("*").eq("from_type", "statement").in("from_id", stmtIds),
        tdb("requirement_links").select("*").eq("to_type", "statement").in("to_id", stmtIds),
      ]);
      if (a.error) return json({ error: a.error.message }, 500);
      if (b.error) return json({ error: b.error.message }, 500);
      const seen = new Set<string>(), merged: any[] = [];
      for (const l of [...(a.data ?? []), ...(b.data ?? [])]) { if (!seen.has(l.id)) { seen.add(l.id); merged.push(l); } }
      return json({ links: await labelEndpoints(merged) });
    }
  }

  if (action === "exportProductPassport") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const passportId = String(body.passportId ?? "").trim();
    const format = String(body.format ?? "json").toLowerCase();
    if (!passportId) return json({ error: "passportId required" }, 400);
    if (!["json", "json-ld", "pdf-data"].includes(format)) return json({ error: "format must be json|json-ld|pdf-data" }, 400);

    const { data: passport } = await tdb("product_passports").select("*").eq("id", passportId).maybeSingle();
    if (!passport) return json({ error: "Passport not found" }, 404);

    // Fetch all linked interpretations
    const { data: links } = await tdb("passport_interpretation_links")
      .select("interpretation:interpretation_id(*, clause:clause_id(*, standard:standard_version_id(*, standard:standard_id(code,title))))")
      .eq("passport_id", passportId);

    const applicableStandards = (passport.applicable_standards || []) as any[];
    const sustainabilityData = (passport.sustainability_data || {}) as Record<string, unknown>;

    if (format === "json-ld") {
      // schema.org/Product + ESPR extensions
      const jsonLd = {
        "@context": "https://schema.org",
        "@type": "Product",
        name: passport.product_name,
        model: passport.product_model || undefined,
        manufacturer: {
          "@type": "Organization",
          name: passport.manufacturer,
        },
        gtin: passport.gtin || undefined,
        description: `EU Product Passport for ${passport.product_name}`,
        conformity: {
          "@context": "https://espr.example.org",
          "declaration_of_conformity_ref": passport.declaration_of_conformity_ref || "",
          "applicable_standards": applicableStandards,
        },
        sustainability: sustainabilityData,
        compliance_interpretations: (links ?? []).map((l: any) => {
          const i = l.interpretation;
          const c = i?.clause;
          return {
            clause_ref: c?.clause_ref,
            standard: c?.standard?.code,
            status: i?.compliance_status,
            interpretation: i?.interpretation_text,
            reviewed_by: i?.reviewed_by,
          };
        }),
        dateModified: passport.updated_at,
        datePublished: passport.valid_from,
        validUntil: passport.valid_to,
      };
      return json({ format: "json-ld", data: jsonLd });
    }

    if (format === "pdf-data") {
      // Simple JSON that can be embedded in PDF metadata
      return json({
        format: "pdf-data",
        product: {
          name: passport.product_name,
          model: passport.product_model,
          manufacturer: passport.manufacturer,
          gtin: passport.gtin,
          doc_ref: passport.declaration_of_conformity_ref,
        },
        standards: applicableStandards,
        sustainability: sustainabilityData,
        valid_from: passport.valid_from,
        valid_to: passport.valid_to,
      });
    }

    // Default: json
    return json({
      format: "json",
      passport: {
        id: passport.id,
        product_name: passport.product_name,
        product_model: passport.product_model,
        manufacturer: passport.manufacturer,
        gtin: passport.gtin,
        applicable_standards: applicableStandards,
        sustainability_data: sustainabilityData,
        status: passport.passport_status,
        valid_from: passport.valid_from,
        valid_to: passport.valid_to,
      },
      compliance_data: (links ?? []).length > 0 ? (links ?? []).map((l: any) => {
        const i = l.interpretation;
        const c = i?.clause;
        return {
          clause: c?.clause_ref,
          standard: c?.standard?.code,
          status: i?.compliance_status,
          interpretation: i?.interpretation_text,
        };
      }) : "No interpretations linked",
    });
  }

  // --- Product passports: management (Rushroom only) ----------------------
  if (action === "listProductPassports") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const { data, error } = await tdb("product_passports").select("*").order("created_at", { ascending: false });
    if (error) return json({ error: (/does not exist|schema cache|Could not find the table/i.test(error.message)) ? "The Level 2 tables aren't set up yet — run the account/Level-2 SQL first." : error.message }, 500);
    // Attach a link count so the list can show how many interpretations each carries.
    const ids = (data ?? []).map((p) => p.id);
    const counts: Record<string, number> = {};
    if (ids.length) {
      const { data: links } = await tdb("passport_interpretation_links").select("passport_id").in("passport_id", ids);
      for (const l of links ?? []) counts[l.passport_id] = (counts[l.passport_id] || 0) + 1;
    }
    return json({ passports: (data ?? []).map((p) => ({ ...p, link_count: counts[p.id] || 0 })) });
  }
  if (action === "getProductPassport") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "").trim();
    if (!id) return json({ error: "id required" }, 400);
    const { data: passport } = await tdb("product_passports").select("*").eq("id", id).maybeSingle();
    if (!passport) return json({ error: "Passport not found" }, 404);
    const { data: links } = await tdb("passport_interpretation_links")
      .select("id, relevance_note, interpretation:interpretation_id(id, compliance_status, interpretation_text, document_version_id, clause:clause_id(clause_ref, clause_title, standard:standard_version_id(standard:standard_id(code,title))))")
      .eq("passport_id", id);
    return json({ passport, links: links ?? [] });
  }
  if (action === "createProductPassport") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const product_name = String(body.productName ?? "").trim();
    if (!product_name) return json({ error: "productName required" }, 400);
    const row: Record<string, unknown> = {
      product_name: product_name.slice(0, 300),
      product_model: String(body.productModel ?? "").slice(0, 200),
      manufacturer: (String(body.manufacturer ?? "").trim() || "Rushroom AB").slice(0, 200),
      gtin: String(body.gtin ?? "").slice(0, 60),
      declaration_of_conformity_ref: String(body.declarationOfConformityRef ?? "").slice(0, 300),
    };
    const { data, error } = await tdb("product_passports").insert(row).select("id").maybeSingle();
    if (error) return json({ error: (/does not exist|schema cache|Could not find the table/i.test(error.message)) ? "The Level 2 tables aren't set up yet — run the SQL first." : error.message }, 500);
    return json({ ok: true, id: data?.id });
  }
  if (action === "updateProductPassport") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "").trim();
    if (!id) return json({ error: "id required" }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.productName !== undefined) patch.product_name = String(body.productName).slice(0, 300);
    if (body.productModel !== undefined) patch.product_model = String(body.productModel).slice(0, 200);
    if (body.manufacturer !== undefined) patch.manufacturer = String(body.manufacturer).slice(0, 200);
    if (body.gtin !== undefined) patch.gtin = String(body.gtin).slice(0, 60);
    if (body.declarationOfConformityRef !== undefined) patch.declaration_of_conformity_ref = String(body.declarationOfConformityRef).slice(0, 300);
    if (body.passportStatus !== undefined) {
      if (!["draft", "active", "superseded"].includes(String(body.passportStatus))) return json({ error: "Invalid passportStatus" }, 400);
      patch.passport_status = String(body.passportStatus);
    }
    if (body.validFrom !== undefined) patch.valid_from = String(body.validFrom).slice(0, 40) || null;
    if (body.validTo !== undefined) patch.valid_to = String(body.validTo).slice(0, 40) || null;
    if (body.sustainabilityData !== undefined && typeof body.sustainabilityData === "object") patch.sustainability_data = body.sustainabilityData;
    if (body.applicableStandards !== undefined && Array.isArray(body.applicableStandards)) patch.applicable_standards = body.applicableStandards;
    const { error } = await tdb("product_passports").update(patch).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (action === "deleteProductPassport") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const id = String(body.id ?? "").trim();
    if (!id) return json({ error: "id required" }, 400);
    const { error } = await tdb("product_passports").delete().eq("id", id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (action === "linkPassportInterpretation") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const passport_id = String(body.passportId ?? "").trim();
    const interpretation_id = String(body.interpretationId ?? "").trim();
    if (!passport_id || !interpretation_id) return json({ error: "passportId and interpretationId required" }, 400);
    const { error } = await tdb("passport_interpretation_links")
      .upsert({ passport_id, interpretation_id, relevance_note: String(body.relevanceNote ?? "").slice(0, 500) }, { onConflict: "passport_id,interpretation_id", ignoreDuplicates: true });
    if (error && error.code !== "23505") return json({ error: error.message }, 500);
    return json({ ok: true });
  }
  if (action === "unlinkPassportInterpretation") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const passport_id = String(body.passportId ?? "").trim();
    const interpretation_id = String(body.interpretationId ?? "").trim();
    if (!passport_id || !interpretation_id) return json({ error: "passportId and interpretationId required" }, 400);
    const { error } = await tdb("passport_interpretation_links").delete().eq("passport_id", passport_id).eq("interpretation_id", interpretation_id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ==========================================================================
  // EU DIRECTIVE RELATIONSHIP ANALYSER (CELLAR)
  // ==========================================================================
  if (action === "listDirectives") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const { data, error } = await db.from("eu_directives").select("*").order("short_name", { ascending: true });
    if (error) return json({ error: (/does not exist|schema cache|Could not find the table/i.test(error.message)) ? "The directive tables aren't set up yet — run the directive SQL first." : error.message }, 500);
    let applicability: any[] = [];
    const passportId = String(body.passportId ?? "").trim();
    if (passportId) { const { data: appl } = await tdb("product_directive_applicability").select("*").eq("passport_id", passportId); applicability = appl || []; }
    return json({ ok: true, directives: data || [], applicability });
  }

  if (action === "addDirective") {
    // Moved to portal-cellar (2026-09-16). A client still posting it here is stale.
    return json({ error: "Action 'addDirective' moved to portal-cellar. Refresh the page to pick up the new client.", moved_to: "portal-cellar" }, 421);
  }

  if (action === "syncDirectiveRelations") {
    // Moved to portal-cellar (2026-09-16). A client still posting it here is stale.
    return json({ error: "Action 'syncDirectiveRelations' moved to portal-cellar. Refresh the page to pick up the new client.", moved_to: "portal-cellar" }, 421);
  }

  // On-demand AI inference of implicit relations (never runs automatically — cost control).
  if (action === "inferDirectiveRelations") {
    // Moved to portal-cellar (2026-09-16). A client still posting it here is stale.
    return json({ error: "Action 'inferDirectiveRelations' moved to portal-cellar. Refresh the page to pick up the new client.", moved_to: "portal-cellar" }, 421);
  }

  if (action === "analyseComplianceGraph") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const scope = body.scope === "product" ? "product" : body.scope === "company" ? "company" : "all";
    const passportId = String(body.passportId ?? "").trim() || null;
    if (scope === "product" && !passportId) return json({ error: "passportId required for product scope" }, 400);
    try {
      // Pre-load any EU directives/regulations already catalogued in the standards register.
      if (scope !== "product") await importDirectivesFromStandards(tdb);
      const graph = await buildComplianceGraph(tdb, scope, passportId);
      return json({ ok: true, scope, passportId, ...graph });
    } catch (e) {
      if (/does not exist|schema cache|Could not find the table/i.test((e as Error).message)) return json({ error: "The directive tables aren't set up yet — run the directive SQL first." }, 500);
      return json({ error: (e as Error).message }, 500);
    }
  }

  if (action === "setDirectiveApplicability") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const passport_id = String(body.passportId ?? "").trim();
    const directive_id = String(body.directiveId ?? "").trim();
    const status = String(body.status ?? "applicable");
    if (!passport_id || !directive_id) return json({ error: "passportId and directiveId required" }, 400);
    if (!APPLICABILITY_STATUSES.includes(status)) return json({ error: "Invalid status" }, 400);
    const { error } = await tdb("product_directive_applicability").upsert({
      passport_id, directive_id, applicability_status: status,
      rationale: String(body.rationale ?? "").slice(0, 2000),
      assessed_by: session.email || session.urole || "rushroom", assessed_at: new Date().toISOString(),
    }, { onConflict: "passport_id,directive_id" });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "getComplianceCoverage") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const directiveId = String(body.directiveId ?? "").trim();
    if (!directiveId) return json({ error: "directiveId required" }, 400);
    const { data: dir } = await db.from("eu_directives").select("*").eq("id", directiveId).maybeSingle();
    if (!dir) return json({ error: "Directive not found" }, 404);
    const cov = await coverageForDirective(tdb, dir);
    return json({ ok: true, ...cov });
  }

  if (action === "generateComplianceNarrative") {
    // Moved to portal-ai (2026-09-16). A client still posting it here is stale.
    return json({ error: "Action 'generateComplianceNarrative' moved to portal-ai. Refresh the page to pick up the new client.", moved_to: "portal-ai" }, 421);
  }

  // ==========================================================================
  // COMPLIANCE STATUS DIMENSION — lifecycle phase × scope classification
  // ==========================================================================
  // Set/update classification on one or many documents/interpretations (bulk).
  if (action === "setClassification") {
    if (role !== "rushroom") return json({ error: "Rushroom or Reviewer only" }, 403);
    const entityType = ["interpretation", "step"].includes(body.entityType) ? body.entityType : "document";
    const ids = Array.isArray(body.ids) ? body.ids.map((x: unknown) => String(x)) : (body.id ? [String(body.id)] : []);
    if (!ids.length) return json({ error: "ids required" }, 400);
    const rawPhase = body.lifecyclePhase;
    const rawScope = body.scope;
    const phase = rawPhase == null || rawPhase === "" ? null : String(rawPhase);
    const scope = rawScope == null || rawScope === "" ? null : String(rawScope);
    if (phase && !LIFECYCLE_PHASES.includes(phase)) return json({ error: "Invalid lifecyclePhase" }, 400);
    if (scope && !COMPLIANCE_SCOPES.includes(scope)) return json({ error: "Invalid scope" }, 400);
    const changedBy = (session.uid && /^[0-9a-f-]{36}$/i.test(String(session.uid))) ? String(session.uid) : null;
    let updated = 0; const errors: any[] = [];
    for (const id of ids) {
      const r = await applyClassification(tdb, entityType, id, phase, scope, body.aiGenerated === true, changedBy);
      if (r.ok) updated++; else errors.push({ id, error: r.error });
    }
    if (!updated && errors.length) {
      const msg = errors[0].error || "";
      if (/does not exist|schema cache|Could not find|column|type/i.test(msg)) return json({ error: "The classification columns aren't set up yet — run the classification SQL first." }, 500);
    }
    return json({ ok: true, updated, errors });
  }

  // Aggregated 2×2 matrix counts (pure aggregation, no LLM).
  if (action === "getComplianceMatrix") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    let items: any[];
    try { items = await loadClassificationItems(tdb); }
    catch (e) { if (/does not exist|schema cache|Could not find|column/i.test((e as Error).message)) return json({ error: "The classification columns aren't set up yet — run the classification SQL first." }, 500); return json({ error: (e as Error).message }, 500); }
    const typeKey = (t: string) => t === "interpretation" ? "interpretations" : t === "step" ? "steps" : "documents";
    const blank = () => ({ total: 0, steps: 0, documents: 0, interpretations: 0, statuses: { compliant: 0, deviation: 0, not_applicable: 0, pending: 0 }, statusable: 0 });
    const quadKeys = ["pre_launch|company", "pre_launch|product_services", "monitoring|company", "monitoring|product_services"];
    const quadrants: Record<string, any> = {}; for (const k of quadKeys) quadrants[k] = blank();
    const unclassified = { total: 0, steps: 0, documents: 0, interpretations: 0 };
    let classified = 0;
    for (const it of items) {
      if (!it.effective_phase || !it.effective_scope) {
        unclassified.total++; unclassified[typeKey(it.entityType)]++;
        continue;
      }
      classified++;
      const q = quadrants[`${it.effective_phase}|${it.effective_scope}`];
      if (!q) continue;
      q.total++; q[typeKey(it.entityType)]++;
      if (it.compliance_status && q.statuses[it.compliance_status] !== undefined) { q.statuses[it.compliance_status]++; q.statusable++; }
    }
    // Attach a coverage % + colour per quadrant.
    for (const k of quadKeys) {
      const q = quadrants[k];
      q.pct_compliant = q.statusable ? Math.round((q.statuses.compliant / q.statusable) * 100) : null;
      q.colour = (q.total === 0 || q.statusable === 0) ? "grey" : q.pct_compliant >= 80 ? "green" : q.pct_compliant >= 40 ? "amber" : "red";
      const [phase, scope] = k.split("|");
      q.lifecycle_phase = phase; q.scope = scope;
    }
    return json({
      ok: true, quadrants,
      unclassified,
      totals: { total: items.length, classified, unclassified: unclassified.total, steps: items.filter((i) => i.entityType === "step").length, documents: items.filter((i) => i.entityType === "document").length, interpretations: items.filter((i) => i.entityType === "interpretation").length },
    });
  }

  // List classifiable items with optional lifecycle_phase / scope / unclassified filters.
  if (action === "listClassificationItems") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    let items: any[];
    try { items = await loadClassificationItems(tdb); }
    catch (e) { if (/does not exist|schema cache|Could not find|column/i.test((e as Error).message)) return json({ error: "The classification columns aren't set up yet — run the classification SQL first." }, 500); return json({ error: (e as Error).message }, 500); }
    const fPhase = body.lifecyclePhase ? String(body.lifecyclePhase) : null;
    const fScope = body.scope ? String(body.scope) : null;
    const onlyUnclassified = body.unclassified === true;
    const entityFilter = body.entityType === "document" || body.entityType === "interpretation" ? body.entityType : null;
    const filtered = items.filter((it) => {
      if (entityFilter && it.entityType !== entityFilter) return false;
      if (onlyUnclassified) return !it.effective_phase || !it.effective_scope;
      if (fPhase && it.effective_phase !== fPhase) return false;
      if (fScope && it.effective_scope !== fScope) return false;
      return true;
    });
    return json({ ok: true, items: filtered, total: items.length });
  }

  // AI proposes classifications for unclassified items — returns proposals only,
  // never writes. Accepted proposals go through setClassification (aiGenerated=true).
  if (action === "suggestClassifications") {
    // Moved to portal-ai (2026-09-16). A client still posting it here is stale.
    return json({ error: "Action 'suggestClassifications' moved to portal-ai. Refresh the page to pick up the new client.", moved_to: "portal-ai" }, 421);
  }

  // ==========================================================================
  // PROP-013 · Product Information System — Vertical Integration Engine
  // ==========================================================================

  // --- BOM: list all components + identify roots (no active parent edge) -----
  // --- BOM: assemblies only, minimal shape ----------------------------------
  // A small, stable endpoint for external integrations (Postman, scripts). It
  // deliberately returns id + name only: a narrow contract is one that will not
  // break callers when columns are added to bom_components.
  //
  // INACTIVE ASSEMBLIES ARE INCLUDED, and that is a decision, not an oversight:
  // the Assemblies tab groups purely on `type === "sub_assembly"` with no
  // lifecycle filter (groupFiltered in assets/app.js), so every assembly in the
  // portal today shows `inactive` and is still listed. Filtering here would make
  // the endpoint disagree with the screen it mirrors. Pass
  // `include_inactive: false` to narrow it explicitly.
  //
  // PHANTOM ASSEMBLIES ARE EXCLUDED by default (PROP-058), and that is also a
  // decision. A phantom is structural only — never built, stocked or picked —
  // so an integration asking for "the assemblies" and acting on the answer
  // should not be handed one. The portal's Assemblies tab does show them, so
  // this is the one place the endpoint deliberately differs from that screen;
  // pass `include_phantom: true` to get both.
  if (action === "listAssemblies") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    // tdb() scopes to the caller's organization, which comes from the signed
    // session — a body organization_id has no effect here or anywhere else.
    let q = tdb("bom_components")
      .select("id, name, type")
      .order("name", { ascending: true });
    q = body.include_phantom === true
      ? (q as any).in("type", ["sub_assembly", "phantom_assembly"])
      : q.eq("type", "sub_assembly");
    if (body.include_inactive === false) q = q.neq("lifecycle_status", "inactive");
    const { data, error } = await q;
    if (error) return json({ error: error.message }, 400);
    // Still id + name only when phantoms are not asked for, so the existing
    // contract is byte-identical for every caller that predates PROP-058.
    const assemblies = (data ?? []).map((a: any) =>
      body.include_phantom === true ? { id: a.id, name: a.name, type: a.type } : { id: a.id, name: a.name });
    return json({ assemblies, count: assemblies.length });
  }

  // --- PIM Planner Mapping registry (migration 0034) ------------------------
  // This PIM-owned registry maps Website cart source keys to PIM BOM IDs. It
  // never reads the Website cart and does not resolve an order; Operations will
  // consume this stable contract later.
  const PLANNER_SOURCE_TYPES = ["module", "interior", "side_panel", "feet", "door", "cover", "back_cover"];
  const plannerSourceKey = (value: unknown) => String(value ?? "").trim();
  const plannerKeyValid = (key: string) => /^[A-Za-z0-9][A-Za-z0-9._:*\/-]{0,159}$/.test(key);

  async function plannerTarget(targetId: string) {
    const { data } = await tdb("bom_components")
      .select("id, name, part_number, type")
      .eq("id", targetId).maybeSingle();
    if (!data || data.type === "product_family") return null;
    return data;
  }

  // PIM owns this saved source catalog. Import receives derived source keys and
  // labels only — never raw Website cart JSON, Website credentials, or orders.
  if (action === "listPlannerCatalog") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const { data, error } = await tdb("planner_catalog_entries")
      .select("id, source_type, source_key, label, created_at, updated_at")
      .order("source_type").order("source_key");
    if (error) return json({ error: error.message }, 400);
    return json({ catalog: data || [], count: (data || []).length });
  }

  if (action === "importPlannerCatalog") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    if (!Array.isArray(body.items) || body.items.length > 2_000) return json({ error: "items must be an array of at most 2,000 derived planner source entries" }, 400);
    const seen = new Set<string>();
    const now = new Date().toISOString();
    const items: any[] = [];
    for (const item of body.items) {
      const sourceType = String(item?.source_type ?? "");
      const sourceKey = plannerSourceKey(item?.source_key);
      const label = String(item?.label ?? sourceKey).trim().slice(0, 160);
      if (!PLANNER_SOURCE_TYPES.includes(sourceType) || !plannerKeyValid(sourceKey) || !label) {
        return json({ error: "Every catalog item needs a valid source_type, source_key, and label" }, 400);
      }
      const identity = `${sourceType}:${sourceKey}`;
      if (!seen.has(identity)) {
        seen.add(identity);
        items.push({ source_type: sourceType, source_key: sourceKey, label, updated_at: now, created_by: session.uid ?? null, updated_by: session.uid ?? null });
      }
    }
    if (!items.length) return json({ ok: true, imported: 0, catalog: [] });
    const { data, error } = await tdb("planner_catalog_entries")
      .upsert(items, { onConflict: "organization_id,source_type,source_key" })
      .select("id, source_type, source_key, label, created_at, updated_at");
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, imported: items.length, catalog: data || [] });
  }

  if (action === "listPlannerMappings") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const includeHistory = body.include_history === true;
    const { data, error } = await tdb("planner_mappings")
      .select("id, source_type, source_key, target_component_id, quantity_rule, fixed_quantity, is_active, mapping_revision, release_label, supersedes_id, created_at, superseded_at, deactivated_at")
      .order("source_type").order("source_key").order("mapping_revision", { ascending: false });
    if (error) return json({ error: error.message }, 400);
    const rows = data || [];
    const targetIds = [...new Set(rows.map((r: any) => r.target_component_id))];
    const targetMap: Record<string, any> = {};
    if (targetIds.length) {
      const { data: targets } = await tdb("bom_components").select("id, name, part_number, type").in("id", targetIds);
      for (const target of targets || []) targetMap[target.id] = target;
    }
    const latest = includeHistory ? rows : rows.filter((row: any, i: number) =>
      i === rows.findIndex((other: any) => other.source_type === row.source_type && other.source_key === row.source_key));
    const mappings = latest.map((row: any) => ({ ...row, target: targetMap[row.target_component_id] ?? null }));
    return json({ mappings, count: mappings.length, include_history: includeHistory });
  }

  if (action === "savePlannerMapping") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const sourceType = String(body.source_type ?? "");
    const sourceKey = plannerSourceKey(body.source_key);
    const targetId = String(body.target_component_id ?? "");
    const quantityRule = body.quantity_rule === "cart_quantity" ? "cart_quantity" : body.quantity_rule === "fixed" ? "fixed" : "";
    const fixedQuantity = quantityRule === "fixed" ? Number(body.fixed_quantity) : null;
    const releaseLabel = body.release_label == null ? null : String(body.release_label).trim().slice(0, 160) || null;
    if (!PLANNER_SOURCE_TYPES.includes(sourceType)) return json({ error: "Invalid source_type" }, 400);
    if (!plannerKeyValid(sourceKey)) return json({ error: "source_key must be a stable key with no spaces (letters, numbers, . _ : * / - only)" }, 400);
    if (!targetId || !await plannerTarget(targetId)) return json({ error: "Choose an existing PIM component or sub-assembly" }, 400);
    if (!quantityRule || (quantityRule === "fixed" && (!Number.isFinite(fixedQuantity) || fixedQuantity! <= 0))) {
      return json({ error: "Choose a quantity rule and enter a fixed quantity greater than zero when required" }, 400);
    }

    const mappingId = String(body.mapping_id ?? "");
    let prior: any = null;
    if (mappingId) {
      const { data } = await tdb("planner_mappings").select("*").eq("id", mappingId).maybeSingle();
      if (!data) return json({ error: "Mapping not found" }, 404);
      if (!data.is_active) return json({ error: "Inactive mappings cannot be edited; create a new mapping instead" }, 400);
      prior = data;
      if (prior.source_type !== sourceType || prior.source_key !== sourceKey) {
        return json({ error: "Source type and source key are immutable; deactivate this mapping and create a new stable source key" }, 400);
      }
      const { error: closeError } = await tdb("planner_mappings")
        .update({ is_active: false, superseded_at: new Date().toISOString() }).eq("id", prior.id);
      if (closeError) return json({ error: closeError.message }, 400);
    }

    const { data: created, error } = await tdb("planner_mappings").insert({
      source_type: sourceType, source_key: sourceKey, target_component_id: targetId,
      quantity_rule: quantityRule, fixed_quantity: fixedQuantity,
      mapping_revision: prior ? Number(prior.mapping_revision) + 1 : 1,
      release_label: releaseLabel, supersedes_id: prior?.id ?? null, created_by: session.uid ?? null,
    }).select("id, mapping_revision").maybeSingle();
    if (error) {
      // An edit is append-only. If the new revision cannot be written, restore
      // the prior resolver entry so a transient DB failure never creates a gap.
      if (prior) await tdb("planner_mappings").update({ is_active: true, superseded_at: null }).eq("id", prior.id);
      if (/planner_mappings_one_active_source/i.test(error.message)) return json({ error: "An active mapping already exists for this source key. Edit or deactivate it first." }, 409);
      return json({ error: error.message }, 400);
    }
    return json({ ok: true, id: created?.id, mapping_revision: created?.mapping_revision });
  }

  if (action === "deactivatePlannerMapping") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const mappingId = String(body.mapping_id ?? "");
    if (!mappingId) return json({ error: "mapping_id required" }, 400);
    const { error } = await tdb("planner_mappings")
      .update({ is_active: false, deactivated_at: new Date().toISOString(), deactivated_by: session.uid ?? null })
      .eq("id", mappingId).eq("is_active", true);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (action === "listComponents") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    // Fetch the set of component IDs that are active BOM parents in one indexed query.
    // This lets the frontend classify tabs without N×getBom calls.
    const { data: parentRows } = await db.from("bom_edges")
      .select("parent_id")
      .eq("organization_id", organizationId)
      .is("effective_to", null);
    const parentIdSet = new Set((parentRows || []).map((r: any) => r.parent_id));
    const search = body.search ? String(body.search).trim() : null;
    let q = tdb("bom_components")
      .select("id, part_number, oem_number, name, type, make_or_buy, lifecycle_status, replacement_note, flag_reason, source_family_id, source_config_id, category_id, description")
      .order("name");
    if (search) q = (q as any).or(`name.ilike.*${search}*,part_number.ilike.*${search}*`);
    const { data: comps, error: ce } = await q;
    if (ce) return json({ error: ce.message }, 400);
    const components = (comps || []).map((c: any) => ({ ...c, has_children: parentIdSet.has(c.id) }));
    return json({ components, root_ids: components.map((c: any) => c.id) });
  }

  // --- Part categories (PROP-038) -------------------------------------------
  // A managed list, not a CHECK constraint: a growing range will want new
  // groupings and each one would otherwise be a migration plus a deploy.
  if (action === "listPartCategories") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { data, error } = await tdb("part_categories")
      .select("id, name, sort_order").order("sort_order").order("name");
    if (error) return json({ error: error.message }, 400);
    return json({ categories: data || [] });
  }

  if (action === "createPartCategory") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const name = String(body.name ?? "").trim();
    if (!name) return json({ error: "name required" }, 400);
    const { data: last } = await tdb("part_categories")
      .select("sort_order").order("sort_order", { ascending: false }).limit(1);
    const sort_order = body.sort_order != null ? Number(body.sort_order) : (((last && last[0]?.sort_order) ?? 0) + 10);
    const { data, error } = await tdb("part_categories")
      .insert({ name, sort_order, created_by: session.uid || null }).select("id").maybeSingle();
    if (error) {
      if (String(error.message).includes("part_categories_organization_id_name_key")) {
        return json({ error: `A category named "${name}" already exists.` }, 400);
      }
      return json({ error: error.message }, 400);
    }
    return json({ id: data.id, name, sort_order });
  }

  if (action === "updatePartCategory") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { category_id } = body;
    if (!category_id) return json({ error: "category_id required" }, 400);
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const nm = String(body.name).trim();
      if (!nm) return json({ error: "name cannot be empty" }, 400);
      patch.name = nm;
    }
    if (body.sort_order !== undefined) patch.sort_order = Number(body.sort_order);
    if (!Object.keys(patch).length) return json({ error: "nothing to update" }, 400);
    const { error } = await tdb("part_categories").update(patch).eq("id", category_id);
    if (error) {
      if (String(error.message).includes("part_categories_organization_id_name_key")) {
        return json({ error: `A category named "${patch.name}" already exists.` }, 400);
      }
      return json({ error: error.message }, 400);
    }
    return json({ ok: true });
  }

  // Refuses while parts still reference it. Silently orphaning them would drop
  // those parts into Uncategorised with no trace of what they used to be.
  if (action === "deletePartCategory") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { category_id } = body;
    if (!category_id) return json({ error: "category_id required" }, 400);
    const { data: inUse } = await tdb("bom_components").select("id").eq("category_id", category_id).limit(25);
    if (inUse?.length) {
      return json({ error: `${inUse.length >= 25 ? "25+" : inUse.length} part${inUse.length === 1 ? " is" : "s are"} still in this category. Move them first, then delete it.` }, 400);
    }
    const { error } = await tdb("part_categories").delete().eq("id", category_id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (action === "setComponentCategory") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id, category_id } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);
    if (category_id) {
      const { data: cat } = await tdb("part_categories").select("id").eq("id", category_id).maybeSingle();
      if (!cat) return json({ error: "Category not found" }, 404);
    }
    const { error } = await tdb("bom_components")
      .update({ category_id: category_id || null, updated_at: new Date().toISOString(), updated_by: session.uid || null })
      .eq("id", component_id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // --- BOM: add a new component (creates the node + first version "A") ------
  if (action === "addComponent") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { name, type, oem_number, description, notes, category_id } = body;
    let { part_number } = body;
    if (!name || !type) return json({ error: "name and type are required" }, 400);
    const validTypes = COMPONENT_TYPES;
    if (!validTypes.includes(type)) return json({ error: "Invalid type" }, 400);
    // PROP-038: a category is required for anything that lands in the Parts tab.
    // Assemblies and Dynamic BOMs are grouped by their own tabs and are exempt.
    const needsCategory = !CATEGORYLESS_TYPES.includes(type);
    if (needsCategory && !category_id) {
      return json({ error: "A category is required for parts. Pick one, or add a new category first." }, 400);
    }
    if (category_id) {
      const { data: cat } = await tdb("part_categories").select("id").eq("id", category_id).maybeSingle();
      if (!cat) return json({ error: "Category not found" }, 404);
    }
    // Auto-generate part number if not supplied
    if (!part_number || !String(part_number).trim()) {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const rand = new Uint8Array(8);
      crypto.getRandomValues(rand);
      const suffix = Array.from(rand).map((b) => chars[b % chars.length]).join("");
      const d = new Date();
      const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
      part_number = `RR-${ym}-${suffix}`;
    }
    const { data: comp, error: ce } = await tdb("bom_components").insert({
      part_number: String(part_number).trim(), name: String(name), type,
      oem_number: oem_number ? String(oem_number).trim() : null,
      description: description || null, notes: notes || null,
      category_id: category_id || null,
      created_by: session.uid || null,
    }).select("id").maybeSingle();
    if (ce || !comp) return json({ error: ce?.message ?? "Component insert returned no data" }, 400);
    const { data: ver, error: ve } = await tdb("bom_component_versions").insert({
      component_id: comp.id, revision: "A", spec_summary: "Initial revision",
      is_current: true, created_by: session.uid || null,
    }).select("id").maybeSingle();
    if (ve || !ver) return json({ error: ve?.message ?? "Version insert returned no data" }, 400);
    // The INSERT trigger on bom_components writes the 'created' field snapshot.
    // Also write an explicit version_bumped row so Revision A always appears in
    // the Change Log timeline alongside later bumps (B, C, …).
    try {
      await tdb("bom_component_history").insert({
        component_id: comp.id,
        changed_at: new Date().toISOString(),
        changed_by: session.uid || null,
        change_type: "version_bumped",
        part_number: String(part_number).trim(),
        oem_number: oem_number ? String(oem_number).trim() : null,
        name: String(name),
        description: description || null,
        type,
        lifecycle_status: null,
        notes: "Revision A: Initial revision",
      });
    } catch { /* non-fatal — main insert already succeeded */ }
    return json({ id: comp.id, part_number, version_id: ver.id });
  }

  // --- BOM: duplicate a component (PROP-042) ---------------------------------
  // Specs only: the new part carries every component_metadata field but none of
  // the source's children, documents or images. A test report or datasheet is
  // evidence about a specific part — copying those links would make a
  // compliance document appear on a part it was never issued for.
  if (action === "duplicateComponent") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);
    const r = await cloneComponentRow(tdb, session, component_id, body.name);
    if ((r as any).error) return json({ error: (r as any).error }, (r as any).error === "Component not found" ? 404 : 400);
    return json({ id: (r as any).id, part_number: (r as any).part_number, name: (r as any).name });
  }

  // --- BOM: copy an assembly AND its structure (PROP-059) -------------------
  // Building an assembly by hand is the slow part of this system, and the usual
  // job is "the same thing with two parts swapped".
  //
  // What gets cloned: the root, and every descendant that HAS CHILDREN. What
  // gets shared: the leaves. Structural rather than type-based on purpose — a
  // node typed `part` that holds children is still structure someone will want
  // to edit in the copy, and cloning screws would put a second Confirmat Screw
  // in a registry people scan by part number.
  //
  // Sharing a node that has children would be worse than either: editing inside
  // it changes the original too, which is the blast radius the add-child dialog
  // already warns about.
  if (action === "copyAssembly") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id, dry_run } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);

    const MAX_NODES = 300;
    const MAX_DEPTH = 12;

    // Breadth-first over ACTIVE edges only. A closed edge is history, not
    // structure, and copying it would resurrect a part someone removed.
    const nodeMap: Record<string, any> = {};
    const childrenOf: Record<string, any[]> = {};
    const visited = new Set<string>();
    let queue = [component_id as string];
    for (let depth = 0; depth < MAX_DEPTH && queue.length; depth++) {
      const ids = queue.filter((id) => !visited.has(id));
      if (!ids.length) break;
      ids.forEach((id) => visited.add(id));
      if (visited.size > MAX_NODES) {
        return json({ error: `This assembly has more than ${MAX_NODES} nodes. Copy it in parts.` }, 400);
      }
      const { data: comps } = await tdb("bom_components")
        .select("id, name, part_number, type").in("id", ids);
      (comps || []).forEach((c: any) => { nodeMap[c.id] = c; });
      const { data: edges } = await tdb("bom_edges")
        .select("id, parent_id, child_id, quantity, reference_designator, sort_order, fitting_stage, variant_condition")
        .in("parent_id", ids).is("effective_to", null)
        .order("sort_order", { ascending: true });
      const next: string[] = [];
      (edges || []).forEach((e: any) => {
        (childrenOf[e.parent_id] ||= []).push(e);
        if (!visited.has(e.child_id)) next.push(e.child_id);
      });
      queue = next;
    }
    if (!nodeMap[component_id]) return json({ error: "Component not found" }, 404);
    // A node discovered at the depth limit has no entry in childrenOf, so it
    // would be treated as a leaf and REUSED even though it holds structure —
    // a silently wrong copy. Refuse instead.
    if (queue.length) {
      return json({ error: `This assembly is deeper than ${MAX_DEPTH} levels. Copy an inner assembly first, then the outer one.` }, 400);
    }

    const { clones, shared, edgeCount } = planAssemblyCopy(component_id, childrenOf, visited);

    const describe = (id: string) => ({
      id, name: nodeMap[id]?.name ?? "", part_number: nodeMap[id]?.part_number ?? "", type: nodeMap[id]?.type ?? "",
    });
    if (dry_run) {
      return json({
        dry_run: true,
        will_clone: [...clones].map(describe),
        will_share: shared.map(describe),
        edge_count: edgeCount,
        suggested_name: `${nodeMap[component_id].name} - copy`,
      });
    }

    // Clone every structural node first, so every edge has both ends by the
    // time it is written. Root first, so its name override lands on the right one.
    const idMap: Record<string, string> = {};
    [...visited].forEach((id) => { idMap[id] = id; });   // shared nodes map to themselves
    const ordered = [component_id as string, ...[...clones].filter((id) => id !== component_id)];
    const created: any[] = [];
    for (const srcId of ordered) {
      const r: any = await cloneComponentRow(tdb, session, srcId, srcId === component_id ? body.name : undefined);
      if (r.error) return json({ error: `Copying "${nodeMap[srcId]?.name ?? srcId}" failed: ${r.error}` }, 400);
      idMap[srcId] = r.id;
      created.push(r);
    }

    // One insert rather than one per edge: a 40-row assembly is 40 round trips
    // otherwise, inside a single function invocation.
    const rows: any[] = [];
    for (const parentId of clones) {
      for (const e of (childrenOf[parentId] || [])) {
        rows.push({
          parent_id: idMap[parentId], child_id: idMap[e.child_id],
          quantity: e.quantity, reference_designator: e.reference_designator,
          sort_order: e.sort_order ?? 0, fitting_stage: e.fitting_stage ?? null,
          variant_condition: e.variant_condition ?? null,
        });
      }
    }
    if (rows.length) {
      const { error: ee } = await tdb("bom_edges").insert(rows);
      // The components are already written; say so rather than implying nothing
      // happened, or the user copies again and gets a second set of orphans.
      if (ee) return json({ error: `Copied ${created.length} components, but the structure failed: ${ee.message}` }, 400);
    }

    const rootClone = created[0];
    return json({
      id: rootClone.id, part_number: rootClone.part_number, name: rootClone.name,
      cloned: created.length, shared: shared.length, edges: rows.length,
    });
  }

  // --- BOM: update component metadata (never part_number or type) -----------
  if (action === "updateComponent") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id, name, description, notes, oem_number, part_number, type: newType, make_or_buy } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: session.uid || null };
    if (name        !== undefined) patch.name        = String(name);
    if (description !== undefined) patch.description = description;
    if (notes       !== undefined) patch.notes       = notes;
    if (oem_number  !== undefined) patch.oem_number  = oem_number ? String(oem_number).trim() : null;
    if (part_number !== undefined && String(part_number).trim()) patch.part_number = String(part_number).trim();
    if (newType     !== undefined) {
      const validTypes = COMPONENT_TYPES;
      if (!validTypes.includes(newType)) return json({ error: "Invalid type" }, 400);
      patch.type = newType;
    }
    if (make_or_buy !== undefined) {
      const validMOB = ["purchased", "manufactured", "assembled", "subcontracted"];
      if (!validMOB.includes(make_or_buy)) return json({ error: "Invalid make_or_buy" }, 400);
      patch.make_or_buy = make_or_buy;
    }
    const { error } = await tdb("bom_components").update(patch).eq("id", component_id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // --- BOM: advance lifecycle status ----------------------------------------
  if (action === "setComponentStatus") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const validStatuses = ["active", "inactive", "replaced", "flagged"];
    const { component_id, lifecycle_status, replacement_note, flag_reason } = body;
    if (!component_id || !lifecycle_status) return json({ error: "component_id and lifecycle_status required" }, 400);
    if (!validStatuses.includes(lifecycle_status)) return json({ error: "Invalid lifecycle_status" }, 400);
    const patch: any = { lifecycle_status, updated_at: new Date().toISOString(), updated_by: session.uid || null };
    if (lifecycle_status === "replaced") {
      patch.replacement_note = replacement_note ? String(replacement_note).slice(0, 1000) : null;
      patch.flag_reason = null;
    } else if (lifecycle_status === "flagged") {
      patch.flag_reason = flag_reason ? String(flag_reason).slice(0, 1000) : null;
      patch.replacement_note = null;
    } else {
      patch.replacement_note = null;
      patch.flag_reason = null;
    }
    const { error } = await tdb("bom_components").update(patch).eq("id", component_id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // --- BOM: create a new component version (revision auto-computed A→B→…→Z→AA→AB…) --
  if (action === "bumpComponentVersion") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id, spec_summary } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);
    try {
      const r = await bumpComponentRevision(tdb, session, component_id, spec_summary || null);
      return json(r);
    } catch (e: any) {
      return json({ error: e?.message ?? "Bump failed" }, 400);
    }
  }

  // --- BOM: version history for a component ---------------------------------
  if (action === "getComponentHistory") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);
    const { data, error } = await tdb("bom_component_versions").select("id, revision, spec_summary, is_current, created_at, version_snapshot")
      .eq("component_id", component_id).order("created_at", { ascending: false });
    if (error) return json({ error: error.message }, 400);
    return json({ history: data });
  }

  // --- BOM: full field-level change log (trigger-sourced, immutable) ---------
  if (action === "getComponentChangelog") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);

    // Three canonical sources merged into one unified timeline:
    // (1) bom_component_history — field snapshots AND the event rows that have no
    //     canonical source of their own
    // (2) bom_component_versions — all revisions ever, including pre-audit-trail ones
    // (3) component_documents — all linked docs ever, including pre-audit-trail ones
    //
    // Which history rows to read is the subtle part. version_bumped and
    // document_linked are deliberately excluded: sources (2) and (3) already
    // reconstruct those events from the canonical tables, so reading both would
    // double every revision and every document.
    //
    // Everything else must be read here, because nothing else reconstructs it.
    // The filter was ["created","updated"], which silently dropped every drawing
    // event and every document_revised row — they were written correctly and then
    // excluded by the query that displays them. PROP-043 fixed the document
    // SOURCE and missed this; the trail still under-reported, which for an audit
    // trail is the failure that matters most because it looks like nothing
    // happened. Any change_type added in future must be listed here or it will
    // vanish the same way.
    const HISTORY_EVENTS = [
      "created", "updated",
      "document_revised",
      "drawing_linked", "drawing_revised", "drawing_released", "drawing_adopted",
    ];
    const [histRes, verRes, docRes] = await Promise.all([
      tdb("bom_component_history")
        .select("id, changed_at, changed_by, change_type, part_number, oem_number, name, description, type, lifecycle_status, notes")
        .eq("component_id", component_id)
        .in("change_type", HISTORY_EVENTS),
      tdb("bom_component_versions")
        .select("id, revision, spec_summary, created_at, created_by")
        .eq("component_id", component_id),
      tdb("component_documents")
        // `uploaded_at`, not `created_at`. Selecting the wrong name made
        // PostgREST reject this query, and because only histRes.error was
        // checked the merge proceeded with zero document entries — the trail
        // looked complete and had never included a single document.
        .select("id, category, label, uploaded_at, uploaded_by")
        .eq("component_id", component_id),
    ]);
    // Check EVERY source. A parallel fetch whose error goes unchecked degrades
    // to an empty list, which is indistinguishable from "nothing happened" — in
    // an audit trail that is the worst possible failure mode. A source that
    // fails is reported, not hidden.
    if (histRes.error) return json({ error: histRes.error.message }, 400);
    const sourcesFailed: string[] = [];
    if (verRes.error) sourcesFailed.push("revisions");
    if (docRes.error) sourcesFailed.push("documents");

    const versionEntries = (verRes.data || []).map((v: any) => ({
      id: v.id,
      changed_at: v.created_at,
      changed_by: v.created_by,
      change_type: "version_bumped",
      notes: `Revision ${v.revision}${v.spec_summary ? ": " + v.spec_summary : ""}`,
    }));

    const docEntries = (docRes.data || []).map((d: any) => ({
      id: d.id,
      changed_at: d.uploaded_at,
      changed_by: d.uploaded_by,
      change_type: "document_linked",
      notes: `Document linked: ${d.label || d.category} (${d.category})`,
    }));

    const changelog = [...(histRes.data || []), ...versionEntries, ...docEntries]
      .sort((a: any, b: any) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime());

    // `partial` lets the panel say so out loud rather than render a short list.
    return json(sourcesFailed.length
      ? { changelog, partial: true, sources_failed: sourcesFailed }
      : { changelog });
  }

  // --- BOM: get tree (BFS, max_depth levels deep) ---------------------------
  if (action === "getBom") {
    const { root_component_id, max_depth, scenario_id } = body;
    if (!root_component_id) return json({ error: "root_component_id required" }, 400);
    const depthLimit = Math.min(Number(max_depth) || 4, 10);
    // BFS: fetch children level by level
    const nodeMap: Record<string, any> = {};
    const edges: Array<{ parent_id: string; child_id: string; quantity: number; reference_designator: string | null; sort_order?: number; fitting_stage?: string | null }> = [];
    const queue: Array<{ id: string; depth: number }> = [{ id: root_component_id, depth: 0 }];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const batch = queue.splice(0, queue.length);
      const ids = batch.map((n) => n.id).filter((id) => !visited.has(id));
      if (!ids.length) break;
      ids.forEach((id) => visited.add(id));
      const { data: comps } = await tdb("bom_components").select("id, part_number, name, type, unit_of_measure, lifecycle_status, notes, description").in("id", ids);
      (comps || []).forEach((c: any) => { nodeMap[c.id] = c; });
      const currentDepth = batch[0].depth;
      if (currentDepth >= depthLimit) continue;
      const { data: childEdges } = await db.from("bom_edges").select("id, parent_id, child_id, quantity, reference_designator, variant_condition, sort_order, fitting_stage")
        .in("parent_id", ids).is("effective_to", null).eq("organization_id", organizationId)
        .order("sort_order", { ascending: true }).order("id", { ascending: true });
      (childEdges || []).forEach((e: any) => {
        edges.push(e);
        if (!visited.has(e.child_id)) queue.push({ id: e.child_id, depth: currentDepth + 1 });
      });
    }
    return json({ nodes: Object.values(nodeMap), edges });
  }

  // --- BOM: add an edge (child under parent) --------------------------------
  // Turn Postgres constraint noise into something a user can act on.
  function bomEdgeError(raw: string): string {
    if (raw.includes("bom_edges_unconditional_unique")) {
      return "That component is already a child of this assembly. Remove the existing link first, or add it with a variant condition.";
    }
    if (raw.includes("BOM cycle detected")) {
      return "That would create a loop: the component is already an ancestor of this assembly.";
    }
    if (raw.includes("no_self_loop")) return "A component cannot be its own child.";
    return raw;
  }

  if (action === "addBomEdge") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { parent_id, child_id, quantity, reference_designator, effective_from, variant_condition } = body;
    if (!parent_id || !child_id || !quantity) return json({ error: "parent_id, child_id and quantity required" }, 400);
    try {
      // PROP-036: new children land at the end of the sibling list.
      const { data: sibs } = await tdb("bom_edges").select("sort_order")
        .eq("parent_id", parent_id).is("effective_to", null)
        .order("sort_order", { ascending: false }).limit(1);
      const nextOrder = ((sibs && sibs[0]?.sort_order) ?? 0) + 10;
      const { data, error } = await tdb("bom_edges").insert({
        parent_id, child_id, quantity: Number(quantity),
        reference_designator: reference_designator || null,
        effective_from: effective_from || new Date().toISOString().slice(0, 10),
        variant_condition: variant_condition ?? null,
        sort_order: nextOrder,
      }).select("id").maybeSingle();
      if (error) return json({ error: bomEdgeError(error.message) }, 400);
      return json({ id: data.id });
    } catch (e: any) {
      return json({ error: bomEdgeError(String(e?.message || "")) }, 400);
    }
  }

  // --- BOM: close an edge (soft-delete, sets effective_to = today) ----------
  if (action === "removeBomEdge") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { edge_id, parent_id, child_id } = body;
    const today = new Date().toISOString().slice(0, 10);
    // PROP-036: prefer edge_id. PROP-033 relaxed the unique constraint so several
    // variant-conditional edges may exist between the same (parent, child) pair —
    // a pair-keyed close would shut all of them, not the one the user clicked.
    if (edge_id) {
      const { data, error } = await db.from("bom_edges").update({ effective_to: today })
        .eq("id", edge_id).is("effective_to", null)
        .eq("organization_id", organizationId).select("id");
      if (error) return json({ error: error.message }, 400);
      if (!data?.length) return json({ error: "Edge not found or already removed" }, 404);
      return json({ ok: true, closed: data.length });
    }
    // Deprecated pair form, kept for older callers. Closes every active edge
    // between the pair — see the note above before relying on it.
    if (!parent_id || !child_id) return json({ error: "edge_id (preferred) or parent_id and child_id required" }, 400);
    const { data, error } = await db.from("bom_edges").update({ effective_to: today })
      .eq("parent_id", parent_id).eq("child_id", child_id).is("effective_to", null)
      .eq("organization_id", organizationId).select("id");
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, closed: data?.length ?? 0 });
  }

  // --- BOM: swap a child with its neighbour in the sibling order (PROP-036) --
  if (action === "reorderBomEdge") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { edge_id, direction } = body;
    if (!edge_id || (direction !== "up" && direction !== "down")) {
      return json({ error: "edge_id and direction ('up'|'down') required" }, 400);
    }
    const { data: edge } = await tdb("bom_edges")
      .select("id, parent_id, sort_order").eq("id", edge_id).is("effective_to", null).maybeSingle();
    if (!edge) return json({ error: "Edge not found" }, 404);
    // Nearest active sibling on the chosen side, ordered so the first row wins.
    const q = tdb("bom_edges").select("id, sort_order")
      .eq("parent_id", edge.parent_id).is("effective_to", null).neq("id", edge_id);
    const { data: neighbours } = direction === "up"
      ? await q.lte("sort_order", edge.sort_order ?? 0).order("sort_order", { ascending: false }).limit(1)
      : await q.gte("sort_order", edge.sort_order ?? 0).order("sort_order", { ascending: true }).limit(1);
    const neighbour = neighbours?.[0];
    if (!neighbour) return json({ ok: true, moved: false });  // already at the end
    // Straight swap. Equal values (possible after a backfill) are nudged apart
    // so the swap is still a real reorder rather than a no-op.
    let a = edge.sort_order ?? 0, b = neighbour.sort_order ?? 0;
    if (a === b) { if (direction === "up") a = b + 1; else b = a + 1; }
    await tdb("bom_edges").update({ sort_order: b }).eq("id", edge.id);
    await tdb("bom_edges").update({ sort_order: a }).eq("id", neighbour.id);
    return json({ ok: true, moved: true });
  }

  // --- BOM: legal destinations for moving a child (PROP-036) ----------------
  // Walks the moving node's descendants so a move can never create a cycle,
  // mirroring what trg_check_bom_cycle enforces at INSERT time.
  async function bomDescendantIds(rootId: string): Promise<Set<string>> {
    const seen = new Set<string>([rootId]);
    let frontier = [rootId];
    while (frontier.length) {
      const { data: rows } = await db.from("bom_edges").select("child_id")
        .in("parent_id", frontier).is("effective_to", null)
        .eq("organization_id", organizationId);
      const next = (rows || []).map((r: any) => r.child_id).filter((id: string) => !seen.has(id));
      next.forEach((id: string) => seen.add(id));
      frontier = next;
    }
    return seen;
  }

  if (action === "listMoveTargets") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { edge_id } = body;
    if (!edge_id) return json({ error: "edge_id required" }, 400);
    const { data: edge } = await tdb("bom_edges")
      .select("id, parent_id, child_id, variant_condition").eq("id", edge_id).is("effective_to", null).maybeSingle();
    if (!edge) return json({ error: "Edge not found" }, 404);

    // (1) never itself, never one of its own descendants — that is the cycle rule
    const blocked = await bomDescendantIds(edge.child_id);
    // (4) a parent that already holds this child unconditionally would be
    //     rejected by PROP-033's partial unique index, so hide it up front
    if (!edge.variant_condition) {
      const { data: existing } = await db.from("bom_edges").select("parent_id")
        .eq("child_id", edge.child_id).is("effective_to", null).is("variant_condition", null)
        .eq("organization_id", organizationId);
      (existing || []).forEach((e: any) => blocked.add(e.parent_id));
    }
    const { data: comps } = await tdb("bom_components")
      .select("id, part_number, name, type, lifecycle_status").order("name");
    const targets = (comps || []).filter((c: any) =>
      !blocked.has(c.id) &&
      c.type !== "finished_good" &&      // (2) PROP-029 leaf rule
      c.id !== edge.parent_id            // already its parent — nothing to do
    );
    return json({ targets, current_parent_id: edge.parent_id });
  }

  // --- BOM: move a child to a different parent (PROP-036) -------------------
  // Edge-scoped by design: a component used in several assemblies moves only in
  // the assembly being viewed. Every other parent link is left untouched.
  if (action === "moveComponentToParent") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { edge_id, new_parent_id } = body;
    if (!edge_id || !new_parent_id) return json({ error: "edge_id and new_parent_id required" }, 400);
    const today = new Date().toISOString().slice(0, 10);

    const { data: edge } = await tdb("bom_edges")
      .select("id, parent_id, child_id, quantity, reference_designator, variant_condition")
      .eq("id", edge_id).is("effective_to", null).maybeSingle();
    if (!edge) return json({ error: "Edge not found" }, 404);
    if (new_parent_id === edge.parent_id) return json({ ok: true, new_edge_id: edge.id, moved: false });

    // Re-validate server-side: a filtered picker is a suggestion, not a permission.
    const blocked = await bomDescendantIds(edge.child_id);
    if (blocked.has(new_parent_id)) {
      return json({ error: "That destination is the component itself or one of its own descendants — the move would create a cycle." }, 400);
    }
    const { data: target } = await tdb("bom_components")
      .select("id, type, name").eq("id", new_parent_id).maybeSingle();
    if (!target) return json({ error: "Destination not found" }, 404);
    if (target.type === "finished_good") {
      return json({ error: "A finished good is a leaf and cannot hold children." }, 400);
    }

    // Close first, insert second. trg_check_bom_cycle is BEFORE INSERT, so it
    // must see the post-move ancestor set — inserting first can reject a
    // legitimate re-parent inside the same branch.
    const { error: closeErr } = await tdb("bom_edges").update({ effective_to: today }).eq("id", edge.id);
    if (closeErr) return json({ error: closeErr.message }, 400);

    try {
      const { data: sibs } = await tdb("bom_edges").select("sort_order")
        .eq("parent_id", new_parent_id).is("effective_to", null)
        .order("sort_order", { ascending: false }).limit(1);
      const nextOrder = ((sibs && sibs[0]?.sort_order) ?? 0) + 10;
      const { data: created, error: insErr } = await tdb("bom_edges").insert({
        parent_id: new_parent_id, child_id: edge.child_id,
        quantity: edge.quantity, reference_designator: edge.reference_designator,
        variant_condition: edge.variant_condition ?? null,
        effective_from: today, sort_order: nextOrder,
      }).select("id").maybeSingle();
      if (insErr || !created) throw new Error(insErr?.message || "Edge insert returned no data");

      // Audit: snapshot the moved component so the Change Log records the move.
      const { data: comp } = await tdb("bom_components")
        .select("part_number, oem_number, name, description, type, lifecycle_status")
        .eq("id", edge.child_id).maybeSingle();
      if (comp) {
        try {
          await tdb("bom_component_history").insert({
            component_id: edge.child_id, changed_at: new Date().toISOString(),
            changed_by: session.uid || null, change_type: "updated",
            part_number: comp.part_number, oem_number: comp.oem_number,
            name: comp.name, description: comp.description,
            type: comp.type, lifecycle_status: comp.lifecycle_status,
            notes: `Moved to assembly "${target.name}"`,
          });
        } catch { /* non-fatal — the move itself already succeeded */ }
      }
      return json({ ok: true, new_edge_id: created.id, moved: true });
    } catch (e: any) {
      // Never leave the child detached: re-open the edge we just closed.
      await tdb("bom_edges").update({ effective_to: null }).eq("id", edge.id);
      const msg = String(e?.message || "");
      return json({ error: msg ? bomEdgeError(msg) : "Move failed" }, 400);
    }
  }

  // --- BOM: list all parent assemblies that include a given component --------
  if (action === "listParentsOf") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);
    const { data: edges, error: ee } = await tdb("bom_edges")
      .select("parent_id, quantity, reference_designator")
      .eq("child_id", component_id)
      .is("effective_to", null);
    if (ee) return json({ error: ee.message }, 400);
    const parentIds = (edges || []).map((e: any) => e.parent_id);
    if (!parentIds.length) return json({ parents: [] });
    const { data: parents } = await tdb("bom_components")
      .select("id, part_number, name, type, lifecycle_status")
      .in("id", parentIds);
    const result = (edges || []).map((e: any) => ({
      parent_id: e.parent_id,
      quantity: e.quantity,
      reference_designator: e.reference_designator,
      parent: (parents || []).find((p: any) => p.id === e.parent_id) || null,
    }));
    return json({ parents: result });
  }

  // --- Delete a component and all its related data --------------------------
  // Children of the deleted component become top-level roots (their edges to
  // this component are deleted; their own subtrees are untouched).
  if (action === "deleteComponent") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);
    const { data: comp } = await tdb("bom_components").select("id").eq("id", component_id).maybeSingle();
    if (!comp) return json({ error: "Component not found" }, 404);

    // Null out any product_passport root references (nullable FK)
    await tdb("product_passports").update({ root_component_id: null }).eq("root_component_id", component_id);

    // PROP-015: if this is a product_family, delete its attribute values, attributes, and saved configurations
    const { data: famAttrs } = await tdb("family_attributes").select("id").eq("family_id", component_id);
    if (famAttrs?.length) {
      const attrIds = famAttrs.map((a: any) => a.id);
      await tdb("family_attribute_values").delete().in("attribute_id", attrIds);
    }
    await tdb("family_attributes").delete().eq("family_id", component_id);
    await tdb("saved_configurations").delete().eq("family_id", component_id);

    // Delete component-level data
    await tdb("component_documents").delete().eq("component_id", component_id);
    await tdb("component_materials").delete().eq("component_id", component_id);
    await tdb("bom_component_versions").delete().eq("component_id", component_id);

    // Delete component images: remove storage objects then DB rows
    const { data: imgs } = await tdb("component_images").select("storage_path").eq("component_id", component_id);
    if (imgs?.length) {
      const paths = (imgs as Array<{ storage_path: string }>).map((i) => i.storage_path).filter(Boolean);
      if (paths.length) await db.storage.from(DOC_BUCKET).remove(paths);
      await tdb("component_images").delete().eq("component_id", component_id);
    }

    // Delete manufacturing routing: work_order_components and routing steps referencing this component
    await tdb("work_order_components").delete().eq("component_id", component_id);
    await tdb("component_routing_steps").delete().eq("component_id", component_id);
    await tdb("product_family_members").delete().eq("component_id", component_id);

    // Delete all BOM edges where this component is parent or child (both directions)
    await tdb("bom_edges").delete().eq("parent_id", component_id);
    await tdb("bom_edges").delete().eq("child_id", component_id);

    // Finally delete the component itself
    const { error: delErr } = await tdb("bom_components").delete().eq("id", component_id);
    if (delErr) return json({ error: delErr.message }, 400);
    return json({ ok: true });
  }

  // --- Materials: get for a component ---------------------------------------
  if (action === "getComponentMaterials") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);
    const { data, error } = await tdb("component_materials").select("*").eq("component_id", component_id).order("substance_name");
    if (error) return json({ error: error.message }, 400);
    return json({ materials: data });
  }

  // --- Materials: upsert one substance row ----------------------------------
  if (action === "upsertComponentMaterial") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id, substance_name, cas_number, percentage_w_w, reach_svhc, rohs_restricted, svhc_threshold_exceeded, notes } = body;
    if (!component_id || !substance_name) return json({ error: "component_id and substance_name required" }, 400);
    const row: Record<string, unknown> = {
      component_id, substance_name: String(substance_name), updated_at: new Date().toISOString(),
    };
    if (cas_number !== undefined) row.cas_number = cas_number;
    if (percentage_w_w !== undefined) row.percentage_w_w = Number(percentage_w_w);
    if (reach_svhc !== undefined) row.reach_svhc = Boolean(reach_svhc);
    if (rohs_restricted !== undefined) row.rohs_restricted = Boolean(rohs_restricted);
    if (svhc_threshold_exceeded !== undefined) row.svhc_threshold_exceeded = Boolean(svhc_threshold_exceeded);
    if (notes !== undefined) row.notes = notes;
    const { error } = await tdb("component_materials").upsert(row, { onConflict: "organization_id,component_id,substance_name" });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // --- Documents: get for a component (supplier sees is_supplier_visible=true only) --
  if (action === "getComponentDocuments") {
    const { component_id } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);
    let q = tdb("component_documents").select("id, category, label, is_supplier_visible, uploaded_at, document_version_id")
      .eq("component_id", component_id).order("uploaded_at", { ascending: false });
    if (role === "supplier") q = q.eq("is_supplier_visible", true);
    const { data: docs, error } = await q;
    if (error) return json({ error: error.message }, 400);
    // Attach document names via document_versions → documents.
    // PROP-044 also returns document_id, the linked revision label, whether a
    // newer revision exists, and how many components share the document — the
    // panel cannot offer "New version" or warn about the blast radius without
    // them, and having to open the Documents library to find out was the whole
    // reason drawings were unreachable from the part.
    const dvIds = (docs || []).map((d: any) => d.document_version_id);
    const meta: Record<string, { name: string; document_id: string; version: string }> = {};
    const latestOf: Record<string, string> = {};   // document_id → newest version label
    const sharedWith: Record<string, number> = {}; // document_id → distinct components linking it
    if (dvIds.length) {
      const { data: dvs } = await tdb("document_versions").select("id, document_id, version").in("id", dvIds);
      const docIds = [...new Set((dvs || []).map((v: any) => v.document_id))];
      if (docIds.length) {
        const { data: docRows } = await tdb("documents").select("id, name").in("id", docIds);
        const docNameMap: Record<string, string> = {};
        (docRows || []).forEach((d: any) => { docNameMap[d.id] = d.name; });
        (dvs || []).forEach((v: any) => {
          meta[v.id] = { name: docNameMap[v.document_id] || "", document_id: v.document_id, version: v.version || "" };
        });

        // Every revision of these documents, so the panel can say "Rev v2 —
        // v3 available" instead of silently showing a stale link.
        const { data: allVers } = await tdb("document_versions")
          .select("id, document_id, version, created_at").in("document_id", docIds)
          .order("created_at", { ascending: true });
        (allVers || []).forEach((v: any) => { latestOf[v.document_id] = v.version || latestOf[v.document_id] || ""; });

        const { data: allLinks } = await tdb("component_documents")
          .select("component_id, document_version_id")
          .in("document_version_id", (allVers || []).map((v: any) => v.id));
        const byDoc: Record<string, Set<string>> = {};
        const verDoc: Record<string, string> = {};
        (allVers || []).forEach((v: any) => { verDoc[v.id] = v.document_id; });
        (allLinks || []).forEach((l: any) => {
          const did = verDoc[l.document_version_id];
          if (!did) return;
          (byDoc[did] ||= new Set()).add(l.component_id);
        });
        Object.entries(byDoc).forEach(([did, set]) => { sharedWith[did] = set.size; });
      }
    }
    const result = (docs || []).map((d: any) => {
      const m = meta[d.document_version_id];
      const documentId = m?.document_id || null;
      const linkedVersion = m?.version || "";
      const latest = documentId ? (latestOf[documentId] || linkedVersion) : linkedVersion;
      return {
        ...d,
        document_name: m?.name || "",
        document_id: documentId,
        version: linkedVersion,
        latest_version: latest,
        outdated: Boolean(latest && linkedVersion && latest !== linkedVersion),
        shared_with: documentId ? (sharedWith[documentId] || 1) : 1,
      };
    });
    return json({ documents: result });
  }

  // --- Documents: attach an existing document_version to a component --------
  if (action === "addComponentDocument") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id, document_version_id, category, label, is_supplier_visible } = body;
    if (!component_id || !document_version_id || !category) return json({ error: "component_id, document_version_id and category required" }, 400);
    const validCats = ["datasheet", "drawing", "test_report", "declaration", "quality_cert", "other"];
    if (!validCats.includes(category)) return json({ error: "Invalid category" }, 400);
    const { data, error } = await tdb("component_documents").insert({
      component_id, document_version_id, category, label: label || null,
      is_supplier_visible: Boolean(is_supplier_visible),
      uploaded_by: session.uid || null,
    }).select("id").maybeSingle();
    if (error) return json({ error: error.message }, 400);
    // Write audit trail — trigger doesn't fire because bom_components isn't touched
    const { data: comp } = await tdb("bom_components")
      .select("organization_id, part_number, oem_number, name, description, type, lifecycle_status")
      .eq("id", component_id).maybeSingle();
    if (comp) {
      const displayLabel = label || category;
      await tdb("bom_component_history").insert({
        organization_id: comp.organization_id,
        component_id,
        changed_at: new Date().toISOString(),
        changed_by: session.uid || null,
        change_type: "document_linked",
        part_number: comp.part_number,
        oem_number: comp.oem_number,
        name: comp.name,
        description: comp.description,
        type: comp.type,
        lifecycle_status: comp.lifecycle_status,
        notes: `Document linked: ${displayLabel} (${category})`,
      });
    }
    return json({ id: data.id });
  }

  // PROP-021 Layer 1 — upload a new document and link it to a BOM component in one round-trip.
  if (action === "uploadAndLinkComponentDocument") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const { component_id, storage_path, file_name, doc_name, doc_category, version, notes, comp_category, label, is_supplier_visible } = body;
    if (!component_id || !storage_path || !file_name || !doc_name)
      return json({ error: "component_id, storage_path, file_name, doc_name required" }, 400);
    const VALID_COMP_CATS = ["datasheet","drawing","test_report","declaration","quality_cert","other"];
    const compCat = VALID_COMP_CATS.includes(String(comp_category ?? "")) ? String(comp_category) : "other";
    const docName = String(doc_name).trim().slice(0, 200);
    const docCategory = (String(doc_category ?? "").trim() || "Uncategorised").slice(0, 80);
    const storagePath = String(storage_path).slice(0, 400);
    const fileName = String(file_name).slice(0, 200);
    // 1. Create document row
    const { data: doc, error: docErr } = await tdb("documents").insert({
      name: docName, category: docCategory, storage_path: storagePath,
      kind: "operational", audience: ["internal"],
    }).select("id").maybeSingle();
    if (docErr || !doc) return json({ error: docErr?.message ?? "Failed to create document" }, 500);
    // 2. Auto-number version label when none supplied
    let versionLabel = String(version ?? "").trim();
    if (!versionLabel) {
      const { count } = await tdb("document_versions").select("id", { count: "exact", head: true }).eq("document_id", doc.id);
      versionLabel = `v${(count ?? 0) + 1}`;
    }
    // 3. Create document_versions row and get back its ID
    const { data: ver, error: verErr } = await tdb("document_versions").insert({
      document_id: doc.id, version: versionLabel.slice(0, 80),
      file_name: fileName, storage_path: storagePath,
      notes: String(notes ?? "").slice(0, 1000), uploaded_by: "rushroom",
    }).select("id").maybeSingle();
    if (verErr || !ver) return json({ error: verErr?.message ?? "Failed to create version" }, 500);
    // 4. Link version to component
    const { error: linkErr } = await tdb("component_documents").insert({
      component_id, document_version_id: ver.id, category: compCat,
      label: label ? String(label).slice(0, 200) : null,
      is_supplier_visible: Boolean(is_supplier_visible),
    });
    if (linkErr) return json({ error: linkErr.message }, 400);
    // 5. Audit trail
    const { data: comp } = await tdb("bom_components")
      .select("organization_id, part_number, oem_number, name, description, type, lifecycle_status")
      .eq("id", component_id).maybeSingle();
    if (comp) {
      await tdb("bom_component_history").insert({
        organization_id: comp.organization_id, component_id,
        changed_at: new Date().toISOString(), changed_by: session.uid || null,
        change_type: "document_linked",
        part_number: comp.part_number, oem_number: comp.oem_number,
        name: comp.name, description: comp.description,
        type: comp.type, lifecycle_status: comp.lifecycle_status,
        notes: `Document uploaded & linked: ${docName} (${compCat})`,
      });
    }
    return json({ ok: true });
  }


  // ==========================================================================
  // PROP-045: Drawings — a first-class domain, not a document category.
  // Writes are rushroom-only. Reads are open to manufacturing partners through
  // ONE choke point (supplierDrawingScope) so that making visibility selective
  // per supplier later changes a single function rather than every query.
  // ==========================================================================

  if (action === "listDrawings") {
    if (role !== "rushroom" && role !== "supplier") return json({ error: "Not authorised" }, 403);
    let q = tdb("drawings").select(
      "id, drawing_number, title, status, current_revision_id, projection_angle, sheet_size, scale, is_supplier_visible, created_at, "
      + "owner_component_id, node_sequence, supplier_drawing_number");
    q = supplierDrawingScope(q, role);
    if (body.status) q = q.eq("status", String(body.status));
    const { data: rows, error } = await q;
    if (error) return json({ error: error.message }, 400);

    let drawings = rows || [];

    // Scope to one part when asked — the panel's Drawings tab.
    const componentId = String(body.component_id ?? "").trim();
    const { data: allLinks } = await tdb("drawing_components").select("drawing_id, component_id, role");
    const links = allLinks || [];
    if (componentId) {
      const ids = new Set(links.filter((l: any) => l.component_id === componentId).map((l: any) => l.drawing_id));
      drawings = drawings.filter((d: any) => ids.has(d.id));
    }

    // Current revision labels in one query rather than per row.
    const revIds = drawings.map((d: any) => d.current_revision_id).filter(Boolean);
    const revMap: Record<string, string> = {};
    if (revIds.length) {
      const { data: revs } = await tdb("drawing_revisions").select("id, revision").in("id", revIds);
      (revs || []).forEach((r: any) => { revMap[r.id] = r.revision; });
    }
    const partsCount: Record<string, number> = {};
    links.forEach((l: any) => { partsCount[l.drawing_id] = (partsCount[l.drawing_id] || 0) + 1; });

    // PROP-046: free drawings must be findable, or "free" becomes where drawings
    // go to be forgotten.
    if (body.free_only === true) drawings = drawings.filter((d: any) => !d.owner_component_id);

    const ownerIds = [...new Set(drawings.map((d: any) => d.owner_component_id).filter(Boolean))];
    const ownerMap: Record<string, any> = {};
    if (ownerIds.length) {
      const { data: owners } = await tdb("bom_components").select("id, name, part_number").in("id", ownerIds);
      (owners || []).forEach((c: any) => { ownerMap[c.id] = c; });
    }

    const result = drawings.map((d: any) => ({
      id: d.id, drawing_number: d.drawing_number, title: d.title, status: d.status,
      revision: d.current_revision_id ? (revMap[d.current_revision_id] || "") : "",
      projection_angle: d.projection_angle, sheet_size: d.sheet_size, scale: d.scale,
      is_supplier_visible: d.is_supplier_visible,
      parts_count: partsCount[d.id] || 0,
      owner_component_id: d.owner_component_id || null,
      owner_name: d.owner_component_id ? (ownerMap[d.owner_component_id]?.name || "") : "",
      node_sequence: d.node_sequence || null,
      supplier_drawing_number: d.supplier_drawing_number || "",
      is_free: !d.owner_component_id,
    })).sort((a: any, b: any) => a.drawing_number.localeCompare(b.drawing_number, undefined, { numeric: true, sensitivity: "base" }));

    return json({ drawings: result, count: result.length });
  }

  if (action === "getDrawing") {
    if (role !== "rushroom" && role !== "supplier") return json({ error: "Not authorised" }, 403);
    const drawing_id = String(body.drawing_id ?? "");
    if (!drawing_id) return json({ error: "drawing_id required" }, 400);

    let q = tdb("drawings").select("*").eq("id", drawing_id);
    q = supplierDrawingScope(q, role);
    const { data: rows, error } = await q;
    if (error) return json({ error: error.message }, 400);
    const drawing = (rows || [])[0];
    // A supplier asking for a withheld drawing gets "not found", not "forbidden":
    // a 403 would confirm the drawing exists.
    if (!drawing) return json({ error: "Drawing not found" }, 404);

    const { data: revisions, error: revErr } = await tdb("drawing_revisions")
      .select("id, revision, status, file_name, notes, released_at, created_at")
      .eq("drawing_id", drawing_id).order("created_at", { ascending: false });

    const { data: links, error: linkErr } = await tdb("drawing_components")
      .select("id, component_id, role, linked_at").eq("drawing_id", drawing_id);

    // Name the parts, so the panel can say which BOM nodes a revision affects.
    let components: any[] = [];
    if ((links || []).length) {
      const { data: comps } = await tdb("bom_components")
        .select("id, name, part_number").in("id", (links || []).map((l: any) => l.component_id));
      const byId: Record<string, any> = {};
      (comps || []).forEach((c: any) => { byId[c.id] = c; });
      components = (links || []).map((l: any) => ({
        link_id: l.id, component_id: l.component_id, role: l.role,
        name: byId[l.component_id]?.name || "", part_number: byId[l.component_id]?.part_number || "",
      }));
    }

    // Same rule as PROP-043's changelog: a source that fails is reported, never
    // silently rendered as an empty list.
    const failed: string[] = [];
    if (revErr) failed.push("revisions");
    if (linkErr) failed.push("components");
    const payload: any = { drawing, revisions: revisions || [], components };
    if (failed.length) { payload.partial = true; payload.sources_failed = failed; }
    return json(payload);
  }

  if (action === "createDrawing") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const drawing_number = String(body.drawing_number ?? "").trim();
    const title = String(body.title ?? "").trim();
    if (!drawing_number) return json({ error: "drawing_number required" }, 400);
    if (!title) return json({ error: "title required" }, 400);
    const { data, error } = await tdb("drawings").insert({
      drawing_number: drawing_number.slice(0, 80), title: title.slice(0, 200),
      projection_angle: body.projection_angle ? String(body.projection_angle).slice(0, 10) : null,
      sheet_size: body.sheet_size ? String(body.sheet_size).slice(0, 10) : null,
      scale: body.scale ? String(body.scale).slice(0, 20) : null,
      is_supplier_visible: body.is_supplier_visible === false ? false : true,
      created_by: session.uid || null,
    }).select("id").maybeSingle();
    if (error) {
      // The unique index is per organization, so this is a duplicate number.
      if (/duplicate key|unique/i.test(error.message)) {
        return json({ error: `Drawing ${drawing_number} already exists` }, 400);
      }
      return json({ error: error.message }, 400);
    }
    return json({ ok: true, id: data?.id });
  }

  if (action === "addDrawingRevision") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const drawing_id = String(body.drawing_id ?? "");
    const storage_path = String(body.storage_path ?? "");
    const file_name = String(body.file_name ?? "");
    if (!drawing_id || !storage_path || !file_name) {
      return json({ error: "drawing_id, storage_path and file_name required" }, 400);
    }
    const { data: drawRows } = await tdb("drawings").select("id, drawing_number, title").eq("id", drawing_id);
    const drawing = (drawRows || [])[0];
    if (!drawing) return json({ error: "Drawing not found" }, 404);

    const { data: existing } = await tdb("drawing_revisions")
      .select("revision, created_at").eq("drawing_id", drawing_id)
      .order("created_at", { ascending: true });
    const priorLabels = (existing || []).map((r: any) => r.revision);
    const revision = String(body.revision ?? "").trim().toUpperCase().slice(0, 10)
      || nextRevisionLetter(priorLabels);
    const from = priorLabels.length ? priorLabels[priorLabels.length - 1] : "—";

    const { data: inserted, error } = await tdb("drawing_revisions").insert({
      drawing_id, revision, storage_path, file_name: file_name.slice(0, 200),
      notes: body.notes ? String(body.notes).slice(0, 1000) : null,
      created_by: session.uid || null,
    }).select("id").maybeSingle();
    if (error) {
      if (/duplicate key|unique/i.test(error.message)) {
        return json({ error: `Revision ${revision} already exists on this drawing` }, 400);
      }
      return json({ error: error.message }, 400);
    }
    await tdb("drawings").update({ current_revision_id: inserted?.id }).eq("id", drawing_id);

    // A drawing revision is a change to every BOM node that shows it — the same
    // rule PROP-043 established, now on the drawings chain.
    const audit = await recordDrawingEvent(tdb, session, drawing_id, "drawing_revised",
      `Drawing revised: ${drawing.drawing_number} ${drawing.title} ${from} → ${revision}`,
      { bump: true, bumpSummary: `Drawing revised: ${drawing.drawing_number} ${from} → ${revision}` });

    return json({ ok: true, id: inserted?.id, revision, ...audit });
  }

  if (action === "linkDrawingToComponent") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const drawing_id = String(body.drawing_id ?? "");
    const component_id = String(body.component_id ?? "");
    const linkRole = String(body.role ?? "depicts");
    if (!drawing_id || !component_id) return json({ error: "drawing_id and component_id required" }, 400);
    if (!["depicts", "installation", "wiring"].includes(linkRole)) {
      return json({ error: "role must be depicts, installation or wiring" }, 400);
    }
    const { data: drawRows } = await tdb("drawings").select("id, drawing_number, title").eq("id", drawing_id);
    const drawing = (drawRows || [])[0];
    if (!drawing) return json({ error: "Drawing not found" }, 404);

    const { error } = await tdb("drawing_components").insert({
      drawing_id, component_id, role: linkRole, linked_by: session.uid || null,
    });
    if (error) {
      if (/duplicate key|unique/i.test(error.message)) {
        return json({ error: "That drawing is already linked to this part in that role" }, 400);
      }
      return json({ error: error.message }, 400);
    }
    await writeBomHistory(tdb, session, component_id, "drawing_linked",
      `Drawing linked: ${drawing.drawing_number} ${drawing.title} (${linkRole})`);
    return json({ ok: true });
  }

  if (action === "unlinkDrawingFromComponent") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const drawing_id = String(body.drawing_id ?? "");
    const component_id = String(body.component_id ?? "");
    if (!drawing_id || !component_id) return json({ error: "drawing_id and component_id required" }, 400);
    // Removes the link only. The drawing itself is never deleted here — losing a
    // released drawing because a link was tidied up is not a recoverable mistake.
    let q = tdb("drawing_components").delete().eq("drawing_id", drawing_id).eq("component_id", component_id);
    if (body.role) q = q.eq("role", String(body.role));
    const { error } = await q;
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (action === "setDrawingStatus") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const drawing_id = String(body.drawing_id ?? "");
    const status = String(body.status ?? "");
    if (!drawing_id || !status) return json({ error: "drawing_id and status required" }, 400);
    const ALLOWED: Record<string, string[]> = {
      draft:      ["checked"],
      checked:    ["approved", "draft"],
      approved:   ["released", "draft"],
      released:   ["superseded"],
      superseded: [],
    };
    const { data: drawRows } = await tdb("drawings")
      .select("id, status, drawing_number, title, current_revision_id").eq("id", drawing_id);
    const drawing = (drawRows || [])[0];
    if (!drawing) return json({ error: "Drawing not found" }, 404);
    if (!ALLOWED[drawing.status]?.includes(status)) {
      return json({ error: `Cannot go from ${drawing.status} to ${status}` }, 400);
    }

    const patch: any = { status };
    const { error } = await tdb("drawings").update(patch).eq("id", drawing_id);
    if (error) return json({ error: error.message }, 400);

    let superseded = 0;
    if (status === "released" && drawing.current_revision_id) {
      // Releasing this revision supersedes whatever was released before it.
      const { data: prior } = await tdb("drawing_revisions")
        .select("id").eq("drawing_id", drawing_id).eq("status", "released");
      const priorIds = (prior || []).map((r: any) => r.id).filter((id: string) => id !== drawing.current_revision_id);
      if (priorIds.length) {
        await tdb("drawing_revisions").update({ status: "superseded" }).in("id", priorIds);
        superseded = priorIds.length;
      }
      await tdb("drawing_revisions")
        .update({ status: "released", released_at: new Date().toISOString() })
        .eq("id", drawing.current_revision_id);
    }

    const audit = status === "released"
      ? await recordDrawingEvent(tdb, session, drawing_id, "drawing_released",
          `Drawing released: ${drawing.drawing_number} ${drawing.title}`, { bump: false })
      : { audited: 0, bumped: [] };

    return json({ ok: true, status, superseded, ...audit });
  }

  if (action === "setDrawingSupplierVisibility") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const drawing_id = String(body.drawing_id ?? "");
    if (!drawing_id) return json({ error: "drawing_id required" }, 400);
    const visible = body.is_supplier_visible !== false;
    const { error } = await tdb("drawings").update({ is_supplier_visible: visible }).eq("id", drawing_id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, is_supplier_visible: visible });
  }

  if (action === "drawingFileUrl") {
    if (role !== "rushroom" && role !== "supplier") return json({ error: "Not authorised" }, 403);
    const revision_id = String(body.drawing_revision_id ?? "");
    if (!revision_id) return json({ error: "drawing_revision_id required" }, 400);
    const { data: revs } = await tdb("drawing_revisions")
      .select("id, drawing_id, storage_path").eq("id", revision_id);
    const rev = (revs || [])[0];
    if (!rev) return json({ error: "Revision not found" }, 404);
    // The file is reached through the drawing, so the same visibility rule that
    // hides a drawing from a supplier also withholds its file. Checking only the
    // revision row would leak the bytes of a drawing they cannot see listed.
    let dq = tdb("drawings").select("id").eq("id", rev.drawing_id);
    dq = supplierDrawingScope(dq, role);
    const { data: allowed } = await dq;
    if (!(allowed || []).length) return json({ error: "Revision not found" }, 404);
    const { data: signed, error } = await db.storage.from(DOC_BUCKET).createSignedUrl(rev.storage_path, 60 * 60);
    if (error) return json({ error: error.message }, 500);
    return json({ url: signed?.signedUrl });
  }


  // PROP-046: the whole New-drawing modal in one action.
  //
  // The node comes first and the file comes with it, so a drawing cannot exist
  // half-made. The system assigns BOTH the drawing number and the revision
  // letter — neither is accepted from the request, because an identity the
  // caller can choose is an identity that collides, drifts, and ends up being
  // the supplier's rather than ours.
  if (action === "createDrawingWithRevision") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const storage_path = String(body.storage_path ?? "");
    const file_name = String(body.file_name ?? "");
    const title = String(body.title ?? "").trim();
    if (!storage_path || !file_name) return json({ error: "storage_path and file_name required" }, 400);
    if (!title) return json({ error: "title required" }, 400);

    // Free drawing = no owner. Explicit, not a default: the modal makes the
    // user choose, so an unattached drawing is a decision, not an oversight.
    const ownerId = String(body.owner_component_id ?? "").trim() || null;
    let owner: any = null;
    if (ownerId) {
      const { data: comps } = await tdb("bom_components").select("id, name, part_number").eq("id", ownerId);
      owner = (comps || [])[0];
      if (!owner) return json({ error: "That part was not found" }, 404);
    }

    // Same alphabet as part_number: no I, O, 0 or 1, because these numbers get
    // read off a printed drawing and typed back in.
    const drawing_number = await generateDrawingNumber(tdb);

    // "Drawing 2 of this part" — a handle a human can hold. Per owner; free
    // drawings have none, since there is nothing to be the second of.
    let node_sequence: number | null = null;
    if (ownerId) {
      const { data: siblings } = await tdb("drawings").select("node_sequence").eq("owner_component_id", ownerId);
      const used = (siblings || []).map((d: any) => d.node_sequence || 0);
      node_sequence = (used.length ? Math.max(...used) : 0) + 1;
    }

    const { data: created, error } = await tdb("drawings").insert({
      drawing_number, title: title.slice(0, 200),
      owner_component_id: ownerId, node_sequence,
      supplier_drawing_number: body.supplier_drawing_number ? String(body.supplier_drawing_number).slice(0, 120) : null,
      projection_angle: body.projection_angle ? String(body.projection_angle).slice(0, 10) : null,
      sheet_size: body.sheet_size ? String(body.sheet_size).slice(0, 10) : null,
      scale: body.scale ? String(body.scale).slice(0, 20) : null,
      is_supplier_visible: body.is_supplier_visible === false ? false : true,
      created_by: session.uid || null,
    }).select("id").maybeSingle();
    if (error) return json({ error: error.message }, 400);
    const drawingId = created?.id;

    const { data: rev, error: revErr } = await tdb("drawing_revisions").insert({
      drawing_id: drawingId, revision: "A",
      storage_path, file_name: file_name.slice(0, 200),
      supplier_revision: body.supplier_revision ? String(body.supplier_revision).slice(0, 40) : null,
      supplier_file_name: file_name.slice(0, 500),
      notes: body.notes ? String(body.notes).slice(0, 1000) : null,
      created_by: session.uid || null,
    }).select("id").maybeSingle();
    if (revErr) {
      // The drawing row without its file is worse than nothing — it is a record
      // that looks complete and is not. Roll it back rather than leave a stub.
      await tdb("drawings").delete().eq("id", drawingId);
      return json({ error: revErr.message }, 400);
    }
    await tdb("drawings").update({ current_revision_id: rev?.id }).eq("id", drawingId);

    let audited = 0;
    if (ownerId) {
      // The owner is also a link, so every existing query that walks
      // drawing_components sees it without knowing about ownership.
      await tdb("drawing_components").insert({
        drawing_id: drawingId, component_id: ownerId, role: "depicts", linked_by: session.uid || null,
      });
      if (await writeBomHistory(tdb, session, ownerId, "drawing_linked",
        `Drawing created: ${drawing_number} ${title} Rev A`)) audited++;
    }

    return json({ ok: true, id: drawingId, drawing_number, revision: "A", node_sequence, audited });
  }

  // A development drawing becoming a controlled one. An event, not a quiet edit.
  if (action === "adoptDrawing") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const drawing_id = String(body.drawing_id ?? "");
    const component_id = String(body.component_id ?? "");
    if (!drawing_id || !component_id) return json({ error: "drawing_id and component_id required" }, 400);

    const { data: rows } = await tdb("drawings")
      .select("id, drawing_number, title, owner_component_id").eq("id", drawing_id);
    const drawing = (rows || [])[0];
    if (!drawing) return json({ error: "Drawing not found" }, 404);
    // Re-homing a drawing that already belongs to a part rewrites what a
    // released revision was built against. That is a different and riskier
    // operation and must not hide inside adoption.
    if (drawing.owner_component_id) {
      return json({ error: "That drawing already belongs to a part. Re-homing an owned drawing is not supported here." }, 400);
    }

    const { data: comps } = await tdb("bom_components").select("id, name").eq("id", component_id);
    if (!(comps || []).length) return json({ error: "That part was not found" }, 404);

    const { data: siblings } = await tdb("drawings").select("node_sequence").eq("owner_component_id", component_id);
    const used = (siblings || []).map((d: any) => d.node_sequence || 0);
    const node_sequence = (used.length ? Math.max(...used) : 0) + 1;

    const { error } = await tdb("drawings")
      .update({ owner_component_id: component_id, node_sequence }).eq("id", drawing_id);
    if (error) return json({ error: error.message }, 400);

    // Adopting also links, unless the link is somehow already there.
    const { data: existing } = await tdb("drawing_components")
      .select("id").eq("drawing_id", drawing_id).eq("component_id", component_id);
    if (!(existing || []).length) {
      await tdb("drawing_components").insert({
        drawing_id, component_id, role: "depicts", linked_by: session.uid || null,
      });
    }
    const audited = await writeBomHistory(tdb, session, component_id, "drawing_adopted",
      `Drawing adopted: ${drawing.drawing_number} ${drawing.title} (was a free drawing)`) ? 1 : 0;

    return json({ ok: true, node_sequence, audited });
  }

  // PROP-019: COGS/cost action blocks removed — financial analysis belongs in ERP, not compliance portal.


  
  // ==========================================================================
  // PROP-015: Configure-to-Order Variant BOM actions
  // ==========================================================================

  // --- Family: add a configuration attribute to a product_family component ---
  if (action === "addFamilyAttribute") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { family_id, name, display_name, is_required, sort_order } = body;
    if (!family_id || !name || !display_name) return json({ error: "family_id, name and display_name required" }, 400);
    const { data: fam } = await tdb("bom_components").select("type").eq("id", family_id).maybeSingle();
    if (!fam || fam.type !== "product_family") return json({ error: "Component is not a product_family" }, 400);
    const { data, error } = await tdb("family_attributes").insert({
      family_id, name: String(name).trim(), display_name: String(display_name).trim(),
      is_required: is_required !== false,
      sort_order: Number(sort_order) || 0,
    }).select("id").maybeSingle();
    if (error) return json({ error: error.message }, 400);
    return json({ id: data.id });
  }

  // --- Family: list attributes (with values nested) for a family ------------
  if (action === "listFamilyAttributes") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { family_id } = body;
    if (!family_id) return json({ error: "family_id required" }, 400);
    const { data: attrs, error: ae } = await tdb("family_attributes")
      .select("id, name, display_name, is_required, sort_order")
      .eq("family_id", family_id).order("sort_order").order("created_at");
    if (ae) return json({ error: ae.message }, 400);
    if (!attrs?.length) return json({ attributes: [] });
    const attrIds = attrs.map((a: any) => a.id);
    const { data: vals } = await tdb("family_attribute_values")
      .select("id, attribute_id, value, label, sort_order")
      .in("attribute_id", attrIds).order("sort_order").order("created_at");
    const valsByAttr: Record<string, any[]> = {};
    (vals || []).forEach((v: any) => {
      if (!valsByAttr[v.attribute_id]) valsByAttr[v.attribute_id] = [];
      valsByAttr[v.attribute_id].push(v);
    });
    const attributes = attrs.map((a: any) => ({ ...a, values: valsByAttr[a.id] || [] }));
    return json({ attributes });
  }

  // --- Family: add a value to an attribute ----------------------------------
  if (action === "addFamilyAttributeValue") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { attribute_id, value, label, sort_order } = body;
    if (!attribute_id || !value || !label) return json({ error: "attribute_id, value and label required" }, 400);
    const { data, error } = await tdb("family_attribute_values").insert({
      attribute_id, value: String(value).trim(), label: String(label).trim(),
      sort_order: Number(sort_order) || 0,
    }).select("id").maybeSingle();
    if (error) return json({ error: error.message }, 400);
    return json({ id: data.id });
  }

  // --- Family: delete an attribute value ------------------------------------
  if (action === "deleteFamilyAttributeValue") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { value_id } = body;
    if (!value_id) return json({ error: "value_id required" }, 400);
    const { error } = await tdb("family_attribute_values").delete().eq("id", value_id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // --- Family: delete an attribute (and all its values) --------------------
  if (action === "deleteFamilyAttribute") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { attribute_id } = body;
    if (!attribute_id) return json({ error: "attribute_id required" }, 400);
    await tdb("family_attribute_values").delete().eq("attribute_id", attribute_id);
    const { error } = await tdb("family_attributes").delete().eq("id", attribute_id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // --- Family: set or clear variant_condition on an existing edge -----------
  // --- BOM: change the quantity on one edge (PROP-037) ----------------------
  // Edge-scoped like every other edge operation: this changes how many of the
  // child this ONE parent uses. Other assemblies using the same component keep
  // their own quantities.
  if (action === "setEdgeQuantity") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { edge_id, quantity } = body;
    if (!edge_id) return json({ error: "edge_id required" }, 400);
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return json({ error: "Quantity must be a number greater than zero." }, 400);
    }
    const { data: edge } = await tdb("bom_edges")
      .select("id, parent_id, child_id, quantity").eq("id", edge_id).is("effective_to", null).maybeSingle();
    if (!edge) return json({ error: "Edge not found or no longer active" }, 404);
    if (Number(edge.quantity) === qty) return json({ ok: true, changed: false });

    const { error } = await tdb("bom_edges").update({ quantity: qty }).eq("id", edge_id);
    if (error) return json({ error: error.message }, 400);

    // Audit the change against the child component, matching how moves are logged.
    const { data: comp } = await tdb("bom_components")
      .select("part_number, oem_number, name, description, type, lifecycle_status")
      .eq("id", edge.child_id).maybeSingle();
    const { data: parent } = await tdb("bom_components").select("name").eq("id", edge.parent_id).maybeSingle();
    if (comp) {
      try {
        await tdb("bom_component_history").insert({
          component_id: edge.child_id, changed_at: new Date().toISOString(),
          changed_by: session.uid || null, change_type: "updated",
          part_number: comp.part_number, oem_number: comp.oem_number,
          name: comp.name, description: comp.description,
          type: comp.type, lifecycle_status: comp.lifecycle_status,
          notes: `Quantity changed from ${edge.quantity} to ${qty} in "${parent?.name ?? "assembly"}"`,
        });
      } catch { /* non-fatal — the quantity is already saved */ }
    }
    return json({ ok: true, changed: true, quantity: qty });
  }

  // PROP-056: where this occurrence is actually fitted. Edge-scoped, because
  // the same part can be hub-fitted under one parent and site-fitted under
  // another. null clears it back to "not decided".
  if (action === "setEdgeFittingStage") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { edge_id } = body;
    if (!edge_id) return json({ error: "edge_id required" }, 400);
    const raw = body.fitting_stage;
    const stage = raw === null || raw === undefined || raw === "" ? null : String(raw);
    if (stage !== null && !FITTING_STAGES.includes(stage)) {
      return json({ error: `fitting_stage must be one of ${FITTING_STAGES.join(", ")}, or null` }, 400);
    }
    const { data: edge } = await tdb("bom_edges")
      .select("id, parent_id, child_id, fitting_stage").eq("id", edge_id).is("effective_to", null).maybeSingle();
    if (!edge) return json({ error: "Edge not found or no longer active" }, 404);
    if ((edge.fitting_stage ?? null) === stage) return json({ ok: true, changed: false, fitting_stage: stage });

    const { error } = await tdb("bom_edges").update({ fitting_stage: stage }).eq("id", edge_id);
    if (error) return json({ error: error.message }, 400);

    // Audited against the child, the same way a quantity change is — moving a
    // part from hub to site changes what ships loose, which is exactly the kind
    // of decision someone will later need to trace.
    const { data: comp } = await tdb("bom_components")
      .select("part_number, oem_number, name, description, type, lifecycle_status")
      .eq("id", edge.child_id).maybeSingle();
    const { data: parent } = await tdb("bom_components").select("name").eq("id", edge.parent_id).maybeSingle();
    if (comp) {
      try {
        await tdb("bom_component_history").insert({
          component_id: edge.child_id, changed_at: new Date().toISOString(),
          changed_by: session.uid || null, change_type: "updated",
          part_number: comp.part_number, oem_number: comp.oem_number,
          name: comp.name, description: comp.description,
          type: comp.type, lifecycle_status: comp.lifecycle_status,
          notes: `Fitted ${FITTING_STAGE_LABEL[stage as string] ?? "not set"} (was ${FITTING_STAGE_LABEL[edge.fitting_stage as string] ?? "not set"}) in "${parent?.name ?? "assembly"}"`,
        });
      } catch { /* non-fatal — the stage is already saved */ }
    }
    return json({ ok: true, changed: true, fitting_stage: stage });
  }

  if (action === "setEdgeCondition") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { edge_id, variant_condition } = body;
    if (!edge_id) return json({ error: "edge_id required" }, 400);
    const { error } = await db.from("bom_edges")
      .update({ variant_condition: variant_condition ?? null })
      .eq("id", edge_id).eq("organization_id", organizationId);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // --- Family: resolve a variant — BFS filtered by variant_condition --------
  // Only edges where variant_condition IS NULL or ALL condition keys match selections
  // are traversed. Returns {nodes, edges} in the same shape as getBom.
  if (action === "resolveVariant") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { family_id, selections } = body;
    if (!family_id || !selections) return json({ error: "family_id and selections required" }, 400);
    const nodeMap: Record<string, any> = {};
    const resultEdges: any[] = [];
    const queue: Array<{ id: string; depth: number }> = [{ id: family_id, depth: 0 }];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const batch = queue.splice(0, queue.length);
      const ids = batch.map((n: any) => n.id).filter((id: string) => !visited.has(id));
      if (!ids.length) break;
      ids.forEach((id: string) => visited.add(id));
      const { data: comps } = await tdb("bom_components")
        .select("id, part_number, name, type, lifecycle_status").in("id", ids);
      (comps || []).forEach((c: any) => { nodeMap[c.id] = c; });
      const currentDepth = batch[0].depth;
      if (currentDepth >= 10) continue;
      const { data: childEdges } = await db.from("bom_edges")
        .select("id, parent_id, child_id, quantity, reference_designator, variant_condition")
        .in("parent_id", ids).is("effective_to", null).eq("organization_id", organizationId);
      (childEdges || []).forEach((e: any) => {
        const cond = e.variant_condition;
        const included = !cond || Object.entries(cond as Record<string, string>).every(([k, v]) => selections[k] === v);
        if (included) {
          resultEdges.push(e);
          if (!visited.has(e.child_id)) queue.push({ id: e.child_id, depth: currentDepth + 1 });
        }
      });
    }
    // Resolve routing steps per component for this configuration (PROP-030)
    const resolvedNodeIds = Object.keys(nodeMap).filter((id) => id !== family_id);
    let resolvedRouting: any[] = [];
    if (resolvedNodeIds.length) {
      const { data: allSteps } = await tdb("component_routing_steps")
        .select("id, component_id, step_number, operation_type, instruction_text, reference_document_id, variant_condition, notes")
        .eq("family_id", family_id).in("component_id", resolvedNodeIds).order("step_number");
      resolvedRouting = (allSteps || []).filter((s: any) => {
        const cond = s.variant_condition;
        return !cond || Object.entries(cond as Record<string, string>).every(([k, v]) => selections[k] === v);
      });
    }
    return json({ nodes: Object.values(nodeMap), edges: resultEdges, resolved_routing: resolvedRouting });
  }

  // --- Configurations: save a named configuration for a family --------------
  if (action === "saveConfiguration") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { family_id, name, selections, description, part_number } = body;
    if (!family_id || !name || !selections) return json({ error: "family_id, name and selections required" }, 400);
    // Validate required attributes are present
    const { data: requiredAttrs } = await tdb("family_attributes")
      .select("name, display_name").eq("family_id", family_id).eq("is_required", true);
    for (const attr of (requiredAttrs || [])) {
      if (!selections[attr.name]) return json({ error: `${attr.display_name} is required` }, 400);
    }
    const { data, error } = await tdb("saved_configurations").insert({
      family_id, name: String(name).trim(), selections,
      description: description || null,
      part_number: part_number ? String(part_number).trim() : null,
      created_by: session.uid || null,
    }).select("id").maybeSingle();
    if (error) return json({ error: error.message }, 400);
    return json({ id: data.id });
  }

  // --- Configurations: list saved configurations for a family ---------------
  if (action === "listConfigurations") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { family_id } = body;
    if (!family_id) return json({ error: "family_id required" }, 400);
    const { data, error } = await tdb("saved_configurations")
      .select("id, name, part_number, description, selections, created_at")
      .eq("family_id", family_id).order("created_at");
    if (error) return json({ error: error.message }, 400);
    return json({ configurations: data || [] });
  }

  // --- Configurations: delete a saved configuration -------------------------
  if (action === "deleteConfiguration") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { configuration_id } = body;
    if (!configuration_id) return json({ error: "configuration_id required" }, 400);
    const { error } = await tdb("saved_configurations").delete().eq("id", configuration_id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // --- PROP-033: Materialise a saved configuration as a stocked SKU ---------
  if (action === "materialiseConfiguration") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { saved_configuration_id, part_number: requestedPN, name: requestedName, notes } = body;
    if (!saved_configuration_id) return json({ error: "saved_configuration_id required" }, 400);

    // Fetch the saved configuration (validates org ownership via tdb)
    const { data: cfg, error: cfgErr } = await tdb("saved_configurations")
      .select("id, family_id, name, selections, part_number, description")
      .eq("id", saved_configuration_id).maybeSingle();
    if (cfgErr || !cfg) return json({ error: cfgErr?.message ?? "Configuration not found" }, 404);

    // Derive part number and name from the request or fall back to config defaults
    let part_number = requestedPN ? String(requestedPN).trim() : (cfg.part_number ? String(cfg.part_number).trim() : null);
    if (!part_number) {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const rand = new Uint8Array(8);
      crypto.getRandomValues(rand);
      const suffix = Array.from(rand).map((b: number) => chars[b % chars.length]).join("");
      const d = new Date();
      const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
      part_number = `RR-${ym}-${suffix}`;
    }
    const name = requestedName ? String(requestedName).trim() : String(cfg.name).trim();

    // Create the stocked variant as a sub_assembly bom_component
    const { data: comp, error: ce } = await tdb("bom_components").insert({
      part_number,
      name,
      type: "sub_assembly",
      make_or_buy: "assembled",
      lifecycle_status: "inactive",
      description: cfg.description || null,
      notes: notes ? String(notes).trim() : null,
      source_family_id: cfg.family_id,
      source_config_id: cfg.id,
      created_by: session.uid || null,
    }).select("id").maybeSingle();
    if (ce || !comp) return json({ error: ce?.message ?? "Component insert returned no data" }, 400);

    // Create Rev A version
    const { data: ver, error: ve } = await tdb("bom_component_versions").insert({
      component_id: comp.id, revision: "A",
      spec_summary: `Materialised from configuration "${cfg.name}"`,
      is_current: true, created_by: session.uid || null,
    }).select("id").maybeSingle();
    if (ve || !ver) return json({ error: ve?.message ?? "Version insert returned no data" }, 400);

    // Write history row
    try {
      await tdb("bom_component_history").insert({
        component_id: comp.id,
        changed_at: new Date().toISOString(),
        changed_by: session.uid || null,
        change_type: "version_bumped",
        part_number,
        name,
        type: "sub_assembly",
        lifecycle_status: "inactive",
        notes: `Revision A: Materialised from Dynamic BOM configuration "${cfg.name}"`,
      });
    } catch { /* non-fatal */ }

    // Resolve the BOM for this configuration using the same BFS logic as resolveVariant
    const selections = cfg.selections as Record<string, string>;
    const nodeMap: Record<string, any> = {};
    const resultEdges: any[] = [];
    const queue: Array<{ id: string; depth: number }> = [{ id: cfg.family_id, depth: 0 }];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const batch = queue.splice(0, queue.length);
      const ids = batch.map((n: any) => n.id).filter((id: string) => !visited.has(id));
      if (!ids.length) break;
      ids.forEach((id: string) => visited.add(id));
      const { data: comps } = await tdb("bom_components")
        .select("id, part_number, name, type, lifecycle_status").in("id", ids);
      (comps || []).forEach((c: any) => { nodeMap[c.id] = c; });
      const currentDepth = batch[0].depth;
      if (currentDepth >= 10) continue;
      const { data: childEdges } = await db.from("bom_edges")
        .select("id, parent_id, child_id, quantity, reference_designator, variant_condition")
        .in("parent_id", ids).is("effective_to", null).eq("organization_id", organizationId);
      (childEdges || []).forEach((e: any) => {
        const cond = e.variant_condition;
        const included = !cond || Object.entries(cond as Record<string, string>).every(([k, v]) => selections[k] === v);
        if (included) {
          resultEdges.push(e);
          if (!visited.has(e.child_id)) queue.push({ id: e.child_id, depth: currentDepth + 1 });
        }
      });
    }

    // Remove edges whose parent is the family root — the materialised SKU is the new root
    const directChildEdges = resultEdges.filter((e: any) => e.parent_id === cfg.family_id);
    // Remap direct children to point to the new materialised component; copy all other edges
    const today = new Date().toISOString().slice(0, 10);
    const edgesForInsert: any[] = directChildEdges.map((e: any) => ({
      parent_id: comp.id,
      child_id: e.child_id,
      quantity: e.quantity,
      reference_designator: e.reference_designator || null,
      effective_from: today,
      variant_condition: null,
    }));
    // Copy deeper edges (non-root parents) as-is, unconditional
    const deeperEdges = resultEdges.filter((e: any) => e.parent_id !== cfg.family_id);
    for (const e of deeperEdges) {
      // Only insert if we haven't already copied this edge (dedup by parent+child)
      if (!edgesForInsert.find((x: any) => x.parent_id === e.parent_id && x.child_id === e.child_id)) {
        edgesForInsert.push({
          parent_id: e.parent_id,
          child_id: e.child_id,
          quantity: e.quantity,
          reference_designator: e.reference_designator || null,
          effective_from: today,
          variant_condition: null,
        });
      }
    }
    if (edgesForInsert.length) {
      // PROP-036: give materialised edges a real position per parent, otherwise
      // they all land on the DEFAULT 0 and sibling order falls back to id.
      const nextByParent: Record<string, number> = {};
      edgesForInsert.forEach((e: any) => {
        nextByParent[e.parent_id] = (nextByParent[e.parent_id] ?? 0) + 10;
        e.sort_order = nextByParent[e.parent_id];
      });
      await tdb("bom_edges").insert(edgesForInsert);
    }

    return json({ id: comp.id, part_number, version_id: ver.id });
  }

  // --- PROP-033: List all materialised variants for a Dynamic BOM family -----
  if (action === "listVariantsByFamily") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { family_id } = body;
    if (!family_id) return json({ error: "family_id required" }, 400);
    const { data, error } = await tdb("bom_components")
      .select("id, part_number, name, type, make_or_buy, lifecycle_status, source_family_id, source_config_id, created_at")
      .eq("source_family_id", family_id)
      .order("created_at");
    if (error) return json({ error: error.message }, 400);
    // Enrich with config selections by joining saved_configurations
    const configIds = (data || []).map((c: any) => c.source_config_id).filter(Boolean);
    let configMap: Record<string, any> = {};
    if (configIds.length) {
      const { data: cfgs } = await tdb("saved_configurations")
        .select("id, name, selections").in("id", configIds);
      (cfgs || []).forEach((c: any) => { configMap[c.id] = c; });
    }
    const variants = (data || []).map((c: any) => ({
      ...c,
      config_name: configMap[c.source_config_id]?.name ?? null,
      config_selections: configMap[c.source_config_id]?.selections ?? null,
    }));
    return json({ variants });
  }

  // ==========================================================================
  // PROP-035: Component Variant Groups — colour/finish/size siblings
  // ==========================================================================

  if (action === "createVariantGroup") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { name, variant_attribute, notes } = body;
    if (!name) return json({ error: "name required" }, 400);
    const { data, error } = await tdb("component_variant_groups").insert({
      name: String(name).trim(),
      variant_attribute: variant_attribute ? String(variant_attribute).trim() : "Color",
      notes: notes ? String(notes).trim() : null,
      created_by: session.uid || null,
    }).select("id").maybeSingle();
    if (error) return json({ error: error.message }, 400);
    return json({ id: data.id });
  }

  if (action === "listVariantGroups") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { data: groups, error } = await tdb("component_variant_groups")
      .select("id, name, variant_attribute, notes, created_at").order("name");
    if (error) return json({ error: error.message }, 400);
    const groupIds = (groups || []).map((g: any) => g.id);
    let memberCounts: Record<string, number> = {};
    if (groupIds.length) {
      const { data: members } = await tdb("component_variant_members")
        .select("group_id").in("group_id", groupIds);
      (members || []).forEach((m: any) => { memberCounts[m.group_id] = (memberCounts[m.group_id] || 0) + 1; });
    }
    return json({ groups: (groups || []).map((g: any) => ({ ...g, member_count: memberCounts[g.id] || 0 })) });
  }

  if (action === "deleteVariantGroup") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { group_id } = body;
    if (!group_id) return json({ error: "group_id required" }, 400);
    const { error } = await tdb("component_variant_groups").delete().eq("id", group_id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (action === "addVariantMember") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { group_id, component_id, variant_value, sort_order } = body;
    if (!group_id || !component_id || !variant_value) return json({ error: "group_id, component_id and variant_value required" }, 400);
    // Validate group belongs to this org
    const { data: grp } = await tdb("component_variant_groups").select("id").eq("id", group_id).maybeSingle();
    if (!grp) return json({ error: "Group not found" }, 404);
    const { error } = await tdb("component_variant_members").insert({
      group_id, component_id,
      variant_value: String(variant_value).trim(),
      sort_order: sort_order != null ? Number(sort_order) : 0,
    });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (action === "removeVariantMember") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { group_id, component_id } = body;
    if (!group_id || !component_id) return json({ error: "group_id and component_id required" }, 400);
    const { error } = await tdb("component_variant_members").delete()
      .eq("group_id", group_id).eq("component_id", component_id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (action === "listComponentVariants") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);
    // Find all groups this component belongs to
    const { data: myMemberships, error: me } = await tdb("component_variant_members")
      .select("group_id, variant_value").eq("component_id", component_id);
    if (me) return json({ error: me.message }, 400);
    if (!myMemberships || myMemberships.length === 0) return json({ memberships: [] });
    const groupIds = myMemberships.map((m: any) => m.group_id);
    // Fetch group metadata
    const { data: groups } = await tdb("component_variant_groups")
      .select("id, name, variant_attribute").in("id", groupIds);
    const groupMap: Record<string, any> = {};
    (groups || []).forEach((g: any) => { groupMap[g.id] = g; });
    // Fetch all siblings for each group
    const { data: allMembers } = await tdb("component_variant_members")
      .select("group_id, component_id, variant_value, sort_order")
      .in("group_id", groupIds).order("sort_order");
    const siblingIds = [...new Set((allMembers || []).map((m: any) => m.component_id))];
    const { data: siblingComps } = await tdb("bom_components")
      .select("id, part_number, name, lifecycle_status").in("id", siblingIds);
    const compMap: Record<string, any> = {};
    (siblingComps || []).forEach((c: any) => { compMap[c.id] = c; });
    const memberships = myMemberships.map((mm: any) => ({
      group: groupMap[mm.group_id],
      my_variant_value: mm.variant_value,
      siblings: (allMembers || [])
        .filter((m: any) => m.group_id === mm.group_id)
        .map((m: any) => ({ ...compMap[m.component_id], variant_value: m.variant_value, sort_order: m.sort_order }))
        .filter((m: any) => m.id),
    }));
    return json({ memberships });
  }

  // ==========================================================================
  // PROP-026: Component image gallery — paste, drop, or pick from disk
  // ==========================================================================

  if (action === "imageUploadUrl") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id, fileName, contentType } = body;
    if (!component_id || !fileName) return json({ error: "component_id and fileName required" }, 400);
    const path = `component-images/${orgPrefix}${component_id}/${Date.now()}-${safeName(String(fileName))}`;
    const { data, error } = await db.storage.from(DOC_BUCKET).createSignedUploadUrl(path);
    if (error) return json({ error: error.message }, 500);
    return json({ signedUrl: data.signedUrl, token: data.token, path });
  }

  if (action === "addComponentImage") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id, storage_path, file_name, content_type } = body;
    if (!component_id || !storage_path || !file_name) return json({ error: "component_id, storage_path, file_name required" }, 400);
    const { data, error } = await tdb("component_images").insert({
      component_id: String(component_id),
      storage_path: String(storage_path).slice(0, 400),
      file_name: String(file_name).slice(0, 200),
      content_type: String(content_type ?? "image/png").slice(0, 100),
      uploaded_by: session.uid || null,
    }).select("id").maybeSingle();
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, id: data?.id });
  }

  if (action === "listComponentImages") {
    const { component_id } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);
    const { data, error } = await tdb("component_images")
      .select("id, storage_path, file_name, content_type, uploaded_at")
      .eq("component_id", component_id)
      .order("uploaded_at", { ascending: true });
    if (error) return json({ error: error.message }, 500);
    const rows = data ?? [];
    let imgSigned: Record<string, string> = {};
    if (rows.length) {
      const { data: signed } = await db.storage.from(DOC_BUCKET)
        .createSignedUrls(rows.map((r: any) => r.storage_path), 60 * 60);
      imgSigned = Object.fromEntries((signed ?? []).map((x: any) => [x.path, x.signedUrl]));
    }
    const images = rows.map((img: any) => ({ ...img, url: imgSigned[img.storage_path] ?? "" }));
    return json({ images });
  }

  if (action === "deleteComponentImage") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { image_id } = body;
    if (!image_id) return json({ error: "image_id required" }, 400);
    const { data: img } = await tdb("component_images")
      .select("storage_path").eq("id", image_id).maybeSingle();
    if (img?.storage_path) {
      await db.storage.from(DOC_BUCKET).remove([img.storage_path]);
    }
    const { error } = await tdb("component_images").delete().eq("id", image_id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // --- Component metadata (PROP-031) ---------------------------------------
  if (action === "getComponentMetadata") {
    const { component_id } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);
    const { data, error } = await tdb("component_metadata")
      .select("*").eq("component_id", component_id).maybeSingle();
    if (error) return json({ error: error.message }, 500);
    return json({ metadata: data || null });
  }

  // --- PROP-040: custom spec field catalogue ---------------------------------
  // Promotion is a data operation, not a migration: values stay in
  // component_metadata.custom_specs and the catalogue decides how they render.
  if (action === "listCustomSpecFields") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { data, error } = await tdb("custom_spec_fields")
      .select("id, field_key, label, unit, data_type, section, sort_order, category_id, options")
      .order("section").order("sort_order").order("label");
    if (error) return json({ error: error.message }, 400);
    // Usage counts ship with the fields: the detail panel needs both on every
    // open, and two actions meant two round trips for one screen.
    const { data: metaRows } = await tdb("component_metadata").select("custom_specs");
    const counts: Record<string, number> = {};
    (metaRows || []).forEach((r: any) => {
      if (r.custom_specs && typeof r.custom_specs === "object") {
        Object.keys(r.custom_specs).forEach((k) => { counts[k] = (counts[k] || 0) + 1; });
      }
    });
    const usage = Object.entries(counts).map(([field_key, count]) => ({ field_key, count }));
    return json({ fields: data || [], usage });
  }

  // How many components already carry each custom key. Drives both the
  // "used on N parts" counts and the promotion prompt at 3+.
  if (action === "listCustomSpecUsage") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { data, error } = await tdb("component_metadata").select("component_id, custom_specs");
    if (error) return json({ error: error.message }, 400);
    const counts: Record<string, number> = {};
    (data || []).forEach((r: any) => {
      const cs = r.custom_specs;
      if (cs && typeof cs === "object") {
        Object.keys(cs).forEach((k) => { counts[k] = (counts[k] || 0) + 1; });
      }
    });
    const usage = Object.entries(counts)
      .map(([field_key, count]) => ({ field_key, count }))
      .sort((a, b) => b.count - a.count || a.field_key.localeCompare(b.field_key));
    return json({ usage });
  }

  if (action === "createCustomSpecField") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const field_key = String(body.field_key ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    const label = String(body.label ?? "").trim();
    if (!field_key) return json({ error: "field_key required" }, 400);
    if (!label) return json({ error: "label required" }, 400);
    const data_type = ["text", "number", "boolean", "choice"].includes(body.data_type) ? body.data_type : "text";
    // A choice field without options is a text field with extra steps.
    const options = Array.isArray(body.options) && body.options.length
      ? body.options.map((o: any) => String(o).trim()).filter(Boolean) : null;
    if (data_type === "choice" && !options) return json({ error: "A choice field needs at least one option." }, 400);
    // null category_id = the field applies to every category.
    let category_id: string | null = null;
    if (body.category_id) {
      const { data: cat } = await tdb("part_categories").select("id").eq("id", body.category_id).maybeSingle();
      if (!cat) return json({ error: "Category not found" }, 404);
      category_id = body.category_id;
    }
    const section = ["physical", "material", "procurement", "quality", "regulatory"].includes(body.section) ? body.section : "physical";
    const { data: last } = await tdb("custom_spec_fields")
      .select("sort_order").eq("section", section).order("sort_order", { ascending: false }).limit(1);
    const sort_order = (((last && last[0]?.sort_order) ?? 0) + 10);
    const { data, error } = await tdb("custom_spec_fields").insert({
      field_key, label, unit: body.unit ? String(body.unit).trim() : null,
      data_type, section, sort_order, category_id, options,
      created_by: session.uid || null,
    }).select("id").maybeSingle();
    if (error) {
      if (String(error.message).includes("custom_spec_fields_organization_id_field_key_key")) {
        return json({ error: `"${field_key}" is already a standard field.` }, 400);
      }
      return json({ error: error.message }, 400);
    }
    return json({ id: data.id, field_key, label, data_type, section });
  }

  if (action === "updateCustomSpecField") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { field_id } = body;
    if (!field_id) return json({ error: "field_id required" }, 400);
    const patch: Record<string, unknown> = {};
    if (body.label !== undefined) {
      const l = String(body.label).trim();
      if (!l) return json({ error: "label cannot be empty" }, 400);
      patch.label = l;
    }
    if (body.unit !== undefined) patch.unit = body.unit ? String(body.unit).trim() : null;
    if (body.section !== undefined && ["physical","material","procurement","quality","regulatory"].includes(body.section)) patch.section = body.section;
    if (body.data_type !== undefined && ["text","number","boolean","choice"].includes(body.data_type)) patch.data_type = body.data_type;
    if (body.options !== undefined) {
      patch.options = Array.isArray(body.options) && body.options.length
        ? body.options.map((o: any) => String(o).trim()).filter(Boolean) : null;
    }
    if (body.category_id !== undefined) patch.category_id = body.category_id || null;
    if (body.sort_order !== undefined) patch.sort_order = Number(body.sort_order);
    if (!Object.keys(patch).length) return json({ error: "nothing to update" }, 400);
    const { error } = await tdb("custom_spec_fields").update(patch).eq("id", field_id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // Demoting only removes the catalogue entry. Values stay in custom_specs, so
  // nothing is lost and the key simply renders as a custom spec again.
  if (action === "deleteCustomSpecField") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { field_id } = body;
    if (!field_id) return json({ error: "field_id required" }, 400);
    const { error } = await tdb("custom_spec_fields").delete().eq("id", field_id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // --- PROP-039: read a datasheet / drawing / screenshot into the spec fields --
  // Extraction only. It never writes: the client reviews and applies, because a
  // wrong flame-retardant class or WEEE category is worse than an empty one —
  // it looks authoritative and ends up exported into a DPP.
  if (action === "extractComponentSpecs") {
    // Moved to portal-ai (2026-09-16). A client still posting it here is stale.
    return json({ error: "Action 'extractComponentSpecs' moved to portal-ai. Refresh the page to pick up the new client.", moved_to: "portal-ai" }, 421);
  }

  if (action === "upsertComponentMetadata") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id, ...fields } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);
    // Verify component belongs to this org
    const { data: comp } = await tdb("bom_components")
      .select("id").eq("id", component_id).maybeSingle();
    if (!comp) return json({ error: "Component not found" }, 404);
    const allowed = [
      "weight_g","length_mm","width_mm","height_mm",
      "base_material","surface_treatment","color_specification","flame_retardant_class",
      "manufacturer_name","manufacturer_part_number",
      "preferred_supplier_name","supplier_part_number","lead_time_days","moq",
      "country_of_origin","hs_code",
      "incoming_inspection_method","inspection_sample_size","critical_to_quality","has_cpk_requirement",
      "weee_category","battery_regulation_applicable","conflict_minerals_free",
      "recycled_content_pct","carbon_footprint_kgco2e","carbon_footprint_source",
      "end_of_life_instruction","repair_spare_part_available","custom_specs",
    ];
    const payload: Record<string, any> = { component_id, organization_id: organizationId, updated_at: new Date().toISOString() };
    for (const k of allowed) { if (k in fields) payload[k] = fields[k]; }
    const { error } = await tdb("component_metadata")
      .upsert(payload, { onConflict: "component_id" });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (action === "listComponentThumbnails") {
    // Returns the first uploaded image per component — for inline thumbnail previews on the BOM list.
    const { data, error } = await tdb("component_images")
      .select("component_id, storage_path")
      .order("uploaded_at", { ascending: true });
    if (error) return json({ error: error.message }, 500);
    const seen = new Set<string>();
    const firsts: Array<{ component_id: string; storage_path: string }> = [];
    for (const row of (data ?? [])) {
      if (!seen.has(row.component_id)) { seen.add(row.component_id); firsts.push(row); }
    }
    // One batched signing call. This previously issued one storage request per
    // component with an image, inside a single function invocation — with a
    // couple of dozen parts that is a couple of dozen sequential round trips,
    // and it is called on every list load.
    let signedByPath: Record<string, string> = {};
    if (firsts.length) {
      const { data: signed } = await db.storage.from(DOC_BUCKET)
        .createSignedUrls(firsts.map((r) => r.storage_path), 60 * 60);
      signedByPath = Object.fromEntries((signed ?? []).map((x: any) => [x.path, x.signedUrl]));
    }
    const thumbnails = firsts.map((row) => ({
      component_id: row.component_id, url: signedByPath[row.storage_path] ?? "",
    }));
    return json({ thumbnails });
  }

  if (action === "listParentCounts") {
    const { data, error } = await tdb("bom_edges")
      .select("child_id, parent_id")
      .is("effective_to", null);
    if (error) return json({ error: error.message }, 500);
    const counts: Record<string, Set<string>> = {};
    for (const row of (data ?? [])) {
      if (!counts[row.child_id]) counts[row.child_id] = new Set();
      counts[row.child_id].add(row.parent_id);
    }
    const parentCounts = Object.entries(counts)
      .filter(([, s]) => s.size > 1)
      .map(([component_id, s]) => ({ component_id, parent_count: s.size }));
    return json({ parentCounts });
  }

  // ==========================================================================
  // PROP-030: Manufacturing BOM — Routing & Work Orders
  // ==========================================================================

  // --- Product Families CRUD -----------------------------------------------
  if (action === "listProductFamilies") {
    const { data, error } = await tdb("product_families").select("id, name, description, created_at").order("name");
    if (error) return json({ error: error.message }, 500);
    const families = data || [];
    const ids = families.map((f: any) => f.id);
    const memberCounts: Record<string, number> = {};
    if (ids.length) {
      const { data: members } = await tdb("product_family_members").select("family_id").in("family_id", ids);
      (members || []).forEach((m: any) => { memberCounts[m.family_id] = (memberCounts[m.family_id] || 0) + 1; });
    }
    return json({ families: families.map((f: any) => ({ ...f, member_count: memberCounts[f.id] || 0 })) });
  }

  if (action === "createProductFamily") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { name, description } = body;
    if (!name?.trim()) return json({ error: "name required" }, 400);
    const { data, error } = await tdb("product_families")
      .insert({ name: name.trim(), description: description?.trim() || null }).select("id").maybeSingle();
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, id: data.id });
  }

  if (action === "updateProductFamily") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { id, name, description } = body;
    if (!id || !name?.trim()) return json({ error: "id and name required" }, 400);
    const { error } = await tdb("product_families")
      .update({ name: name.trim(), description: description?.trim() || null }).eq("id", id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (action === "deleteProductFamily") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { id } = body;
    if (!id) return json({ error: "id required" }, 400);
    const { error } = await tdb("product_families").delete().eq("id", id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // --- Product Family membership --------------------------------------------
  if (action === "addFamilyMember") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { family_id, component_id } = body;
    if (!family_id || !component_id) return json({ error: "family_id and component_id required" }, 400);
    const { error } = await tdb("product_family_members")
      .upsert({ family_id, component_id }, { onConflict: "family_id,component_id", ignoreDuplicates: true });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (action === "removeFamilyMember") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { family_id, component_id } = body;
    if (!family_id || !component_id) return json({ error: "family_id and component_id required" }, 400);
    const { error } = await tdb("product_family_members").delete()
      .eq("family_id", family_id).eq("component_id", component_id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (action === "listFamilyMembers") {
    const { family_id } = body;
    if (!family_id) return json({ error: "family_id required" }, 400);
    const { data, error } = await tdb("product_family_members").select("component_id").eq("family_id", family_id);
    if (error) return json({ error: error.message }, 500);
    const compIds = (data || []).map((m: any) => m.component_id);
    if (!compIds.length) return json({ components: [] });
    const { data: comps } = await tdb("bom_components")
      .select("id, name, part_number, type, lifecycle_status").in("id", compIds).order("name");
    return json({ components: comps || [] });
  }

  if (action === "listComponentFamilies") {
    const { component_id } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);
    const { data, error } = await tdb("product_family_members").select("family_id").eq("component_id", component_id);
    if (error) return json({ error: error.message }, 500);
    const famIds = (data || []).map((m: any) => m.family_id);
    if (!famIds.length) return json({ families: [] });
    const { data: fams } = await tdb("product_families").select("id, name").in("id", famIds).order("name");
    return json({ families: fams || [] });
  }

  // --- Routing: list steps for one component within a family ---------------
  if (action === "listFamilyRoutingSteps") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { family_id, component_id } = body;
    if (!family_id || !component_id) return json({ error: "family_id and component_id required" }, 400);
    const { data, error } = await tdb("component_routing_steps")
      .select("id, step_number, operation_type, instruction_text, reference_document_id, variant_condition, notes")
      .eq("family_id", family_id).eq("component_id", component_id).order("step_number");
    if (error) return json({ error: error.message }, 500);
    const steps = data || [];
    // Enrich reference doc names
    const docIds = [...new Set(steps.map((s: any) => s.reference_document_id).filter(Boolean))];
    const docMap: Record<string, string> = {};
    if (docIds.length) {
      const { data: docs } = await db.from("document_versions")
        .select("id, version_label, document_id").in("id", docIds);
      if (docs) {
        const dDocIds = docs.map((d: any) => d.document_id);
        const { data: dDocs } = await db.from("documents").select("id, name").in("id", dDocIds);
        const dDocMap: Record<string, string> = {};
        (dDocs || []).forEach((d: any) => { dDocMap[d.id] = d.name; });
        docs.forEach((d: any) => { docMap[d.id] = `${dDocMap[d.document_id] || ""} (${d.version_label})`; });
      }
    }
    return json({ steps: steps.map((s: any) => ({ ...s, reference_document_name: docMap[s.reference_document_id] || null })) });
  }

  // --- Routing: list step counts for all components in a family (overview) -
  if (action === "listFamilyRoutingOverview") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { family_id } = body;
    if (!family_id) return json({ error: "family_id required" }, 400);
    const { data, error } = await tdb("component_routing_steps")
      .select("component_id").eq("family_id", family_id);
    if (error) return json({ error: error.message }, 500);
    const counts: Record<string, number> = {};
    (data || []).forEach((r: any) => { counts[r.component_id] = (counts[r.component_id] || 0) + 1; });
    return json({ step_counts: counts });
  }

  // --- Routing: upsert a step on a component within a family ---------------
  if (action === "upsertFamilyRoutingStep") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { id: stepId, family_id, component_id, step_number, operation_type,
            instruction_text, reference_document_id, variant_condition, notes } = body;
    if (!family_id || !component_id || !step_number || !operation_type || !instruction_text)
      return json({ error: "family_id, component_id, step_number, operation_type, instruction_text required" }, 400);
    const row = {
      family_id, component_id, step_number: Number(step_number), operation_type,
      instruction_text: String(instruction_text).trim(),
      reference_document_id: reference_document_id || null,
      variant_condition: variant_condition || null,
      notes: notes || null,
    };
    if (stepId) {
      const { error } = await tdb("component_routing_steps").update(row).eq("id", stepId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, id: stepId });
    }
    const { data, error } = await tdb("component_routing_steps").insert(row).select("id").maybeSingle();
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, id: data.id });
  }

  // --- Routing: delete a step ----------------------------------------------
  if (action === "deleteFamilyRoutingStep") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { id: stepId } = body;
    if (!stepId) return json({ error: "id required" }, 400);
    const { error } = await tdb("component_routing_steps").delete().eq("id", stepId);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // --- Routing: reorder steps for a component within a family --------------
  if (action === "reorderFamilyRoutingSteps") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id, family_id, ordered_ids } = body;
    if (!component_id || !family_id || !Array.isArray(ordered_ids))
      return json({ error: "component_id, family_id and ordered_ids required" }, 400);
    const n = ordered_ids.length;
    for (let i = 0; i < n; i++) {
      await tdb("component_routing_steps").update({ step_number: 10000 + i + 1 }).eq("id", ordered_ids[i]);
    }
    for (let i = 0; i < n; i++) {
      await tdb("component_routing_steps").update({ step_number: i + 1 }).eq("id", ordered_ids[i]);
    }
    return json({ ok: true });
  }

  // --- Work Orders: create (resolve BOM + per-component routing snapshot) --
  if (action === "createWorkOrder") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { family_id, external_order_id, notes: woNotes } = body;
    if (!family_id) return json({ error: "family_id required" }, 400);

    // Pull list = all product_family_members for this family
    const { data: members, error: membErr } = await tdb("product_family_members")
      .select("component_id").eq("family_id", family_id);
    if (membErr) return json({ error: membErr.message }, 500);
    const memberIds = (members || []).map((m: any) => m.component_id);

    // Fetch routing steps for all members in this family, build global step sequence
    let allStepRows: any[] = [];
    if (memberIds.length) {
      const { data: routingSteps } = await tdb("component_routing_steps")
        .select("component_id, step_number, operation_type, instruction_text, reference_document_id, notes")
        .eq("family_id", family_id).in("component_id", memberIds).order("component_id").order("step_number");
      let globalStepNum = 0;
      for (const compId of memberIds) {
        const compSteps = (routingSteps || []).filter((s: any) => s.component_id === compId);
        for (const s of compSteps) {
          globalStepNum++;
          allStepRows.push({
            component_id: compId, step_number: globalStepNum,
            operation_type: s.operation_type, instruction_text: s.instruction_text,
            reference_document_id: s.reference_document_id || null,
            notes: s.notes || null, status: "pending",
          });
        }
      }
    }

    // Insert work order
    const { data: wo, error: woErr } = await tdb("work_orders").insert({
      family_id, external_order_id: external_order_id || null,
      notes: woNotes || null, status: "planned",
    }).select("id").maybeSingle();
    if (woErr) return json({ error: woErr.message }, 400);
    const workOrderId = wo.id;

    if (allStepRows.length) {
      const { error: stepsErr } = await tdb("work_order_steps").insert(allStepRows.map((r: any) => ({ ...r, work_order_id: workOrderId })));
      if (stepsErr) return json({ error: stepsErr.message }, 400);
    }
    if (memberIds.length) {
      const { error: compsErr } = await tdb("work_order_components").insert(
        memberIds.map((id: string) => ({ work_order_id: workOrderId, component_id: id, quantity: 1 }))
      );
      if (compsErr) return json({ error: compsErr.message }, 400);
    }

    return json({ ok: true, work_order_id: workOrderId });
  }

  // --- Work Orders: list ---------------------------------------------------
  if (action === "listWorkOrders") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { family_id } = body;
    let q = tdb("work_orders").select("id, family_id, external_order_id, status, notes, created_at, updated_at");
    if (family_id) q = (q as any).eq("family_id", family_id);
    const { data, error } = await (q as any).order("created_at", { ascending: false });
    if (error) return json({ error: error.message }, 500);
    const orders = data || [];
    // Enrich with family names from product_families
    const familyIds = [...new Set(orders.map((o: any) => o.family_id))];
    const familyMap: Record<string, string> = {};
    if (familyIds.length) {
      const { data: fams } = await tdb("product_families").select("id, name").in("id", familyIds);
      (fams || []).forEach((f: any) => { familyMap[f.id] = f.name; });
    }
    // Step counts
    const orderIds = orders.map((o: any) => o.id);
    const stepCounts: Record<string, { total: number; done: number }> = {};
    if (orderIds.length) {
      const { data: steps } = await tdb("work_order_steps")
        .select("work_order_id, status").in("work_order_id", orderIds);
      (steps || []).forEach((s: any) => {
        if (!stepCounts[s.work_order_id]) stepCounts[s.work_order_id] = { total: 0, done: 0 };
        stepCounts[s.work_order_id].total++;
        if (s.status === "done") stepCounts[s.work_order_id].done++;
      });
    }
    const enriched = orders.map((o: any) => ({
      ...o,
      family_name: familyMap[o.family_id] || o.family_id,
      step_count: stepCounts[o.id]?.total || 0,
      steps_done: stepCounts[o.id]?.done || 0,
    }));
    return json({ work_orders: enriched });
  }

  // --- Work Orders: get one (with steps + components) ----------------------
  if (action === "getWorkOrder") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { id: woId } = body;
    if (!woId) return json({ error: "id required" }, 400);
    const { data: wo, error: woErr } = await tdb("work_orders")
      .select("id, family_id, external_order_id, status, notes, created_at, updated_at")
      .eq("id", woId).maybeSingle();
    if (woErr || !wo) return json({ error: woErr?.message || "Not found" }, 404);
    const { data: fam } = await tdb("product_families").select("name").eq("id", wo.family_id).maybeSingle();
    // Steps
    const { data: steps } = await tdb("work_order_steps")
      .select("id, step_number, operation_type, instruction_text, reference_document_id, component_id, notes, status, completed_at")
      .eq("work_order_id", woId).order("step_number");
    // Components
    const { data: comps } = await tdb("work_order_components")
      .select("id, component_id, quantity").eq("work_order_id", woId);
    // Enrich component names (for pull list and step component labels)
    const allCompIds = [...new Set([
      ...(comps || []).map((c: any) => c.component_id),
      ...(steps || []).map((s: any) => s.component_id).filter(Boolean),
    ])];
    const compMap: Record<string, any> = {};
    if (allCompIds.length) {
      const { data: bc } = await tdb("bom_components").select("id, name, part_number").in("id", allCompIds);
      (bc || []).forEach((c: any) => { compMap[c.id] = c; });
    }
    // Signed URLs for reference docs on steps
    const docIds = [...new Set((steps || []).map((s: any) => s.reference_document_id).filter(Boolean))];
    const docUrlMap: Record<string, string> = {};
    if (docIds.length) {
      const { data: dvs } = await db.from("document_versions").select("id, storage_path").in("id", docIds);
      await Promise.all((dvs || []).map(async (dv: any) => {
        const { data: signed } = await db.storage.from(DOC_BUCKET).createSignedUrl(dv.storage_path, 3600);
        if (signed?.signedUrl) docUrlMap[dv.id] = signed.signedUrl;
      }));
    }
    const enrichedSteps = (steps || []).map((s: any) => ({
      ...s,
      component_name: compMap[s.component_id]?.name || null,
      reference_document_url: docUrlMap[s.reference_document_id] || null,
    }));
    const enrichedComps = (comps || []).map((c: any) => ({
      ...c,
      name: compMap[c.component_id]?.name || c.component_id,
      part_number: compMap[c.component_id]?.part_number || null,
    }));
    // Family name
    return json({ work_order: { ...wo, family_name: fam?.name || wo.family_id }, steps: enrichedSteps, components: enrichedComps });
  }

  // --- Work Orders: update a single step status ----------------------------
  if (action === "updateWorkOrderStepStatus") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { step_id, status } = body;
    if (!step_id || !status) return json({ error: "step_id and status required" }, 400);
    const patch: any = { status };
    if (status === "done") { patch.completed_at = new Date().toISOString(); patch.completed_by = session.uid || null; }
    else { patch.completed_at = null; patch.completed_by = null; }
    const { data: step, error } = await tdb("work_order_steps").update(patch).eq("id", step_id).select("work_order_id").maybeSingle();
    if (error) return json({ error: error.message }, 400);
    // Bump work order updated_at; auto-advance to in_progress on first done step
    if (step?.work_order_id) {
      const woPatch: any = { updated_at: new Date().toISOString() };
      if (status === "done") {
        const { data: wo } = await tdb("work_orders").select("status").eq("id", step.work_order_id).maybeSingle();
        if (wo?.status === "planned") woPatch.status = "in_progress";
      }
      await tdb("work_orders").update(woPatch).eq("id", step.work_order_id);
    }
    return json({ ok: true });
  }

  // --- Work Orders: update overall status ----------------------------------
  if (action === "updateWorkOrderStatus") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { id: woId, status } = body;
    if (!woId || !status) return json({ error: "id and status required" }, 400);
    const { error } = await tdb("work_orders").update({ status, updated_at: new Date().toISOString() }).eq("id", woId);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  // ==========================================================================

  timer.done(400, { unknown_action: true });
  return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err: any) {
    // Error text only — never the request body, token, or any row data.
    console.error(`[portal-api] unhandled error in action=${action}:`, err?.message ?? err);
    timer.done(500);
    return json({ error: err?.message ?? "Internal server error" }, 500);
  }
});
