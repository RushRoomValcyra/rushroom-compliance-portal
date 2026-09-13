// ============================================================================
// Rushroom Compliance Portal — API gateway (Supabase Edge Function)
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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as JSZipNS from "https://esm.sh/jszip@3.10.1";
// jszip ships an export-assignment type (no default export); unwrap for Deno.
const JSZip: any = (JSZipNS as any).default ?? JSZipNS;
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";
import { createCellarService } from "./cellar-service.ts";

const BUCKET = "supplier-uploads";
const DOC_BUCKET = "documents";
const STD_BUCKET = "standards";
const TOKEN_TTL_SECONDS = 60 * 60 * 8; // 8 hours

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN_SECRET = Deno.env.get("TOKEN_SECRET") ?? "";
const PW_HASH: Record<string, string | undefined> = {
  rushroom: Deno.env.get("RUSHROOM_PW_HASH")?.toLowerCase(),
  supplier: Deno.env.get("SUPPLIER_PW_HASH")?.toLowerCase(),
};

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const enc = new TextEncoder();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ---- crypto helpers --------------------------------------------------------
// Copy any view into a standalone ArrayBuffer so Web Crypto's BufferSource
// param types are satisfied (avoids the SharedArrayBuffer/ArrayBufferLike clash).
function ab(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}
function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", ab(enc.encode(text))));
}
async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", ab(enc.encode(TOKEN_SECRET)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
// Constant-time-ish compare
function eq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A session token carries the access tier (role) + admin flag + user identity.
async function issueSession(payload: Record<string, unknown>, ttlSeconds = TOKEN_TTL_SECONDS): Promise<string> {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const p = b64url(enc.encode(JSON.stringify(body)));
  const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), ab(enc.encode(p)))));
  return `${p}.${sig}`;
}
async function verifySession(token: string | undefined): Promise<any | null> {
  if (!token || !token.includes(".")) return null;
  const [p, sig] = token.split(".");
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(), ab(b64urlDecode(sig)), ab(enc.encode(p)));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    if (typeof data.exp !== "number" || data.exp < Math.floor(Date.now() / 1000)) return null;
    if (data.role !== "rushroom" && data.role !== "supplier") return null;
    return data;
  } catch { return null; }
}

// ---- password hashing (PBKDF2-SHA256) --------------------------------------
async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", ab(enc.encode(pw)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: ab(salt), iterations: 120000, hash: "SHA-256" }, key, 256);
  return `pbkdf2$120000$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}
async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, iterStr, saltB64, hashB64] = stored.split("$");
  if (algo !== "pbkdf2" || !saltB64 || !hashB64) return false;
  const salt = b64urlDecode(saltB64);
  const key = await crypto.subtle.importKey("raw", ab(enc.encode(pw)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: ab(salt), iterations: Number(iterStr) || 120000, hash: "SHA-256" }, key, 256);
  return eq(b64url(new Uint8Array(bits)), hashB64);
}

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
const USER_ROLES = ["supplier", "reviewer", "installer", "internal"]; // roles a user may REQUEST at registration
const ASSIGNABLE_ROLES = ["admin", "internal", "reviewer", "supplier", "installer"]; // roles an admin may ASSIGN
const USER_STATUSES = ["pending", "verified", "approved", "rejected", "disabled"];
const emailOk = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
// Map an assigned user role to an access tier the portal enforces.
// Full-access roles see everything; supplier/installer get the limited view.
const roleTier = (r: string): "rushroom" | "supplier" =>
  ["admin", "internal", "reviewer"].includes(r) ? "rushroom" : "supplier";

// --- Multi-tenant Stage 1: the seed organization all existing data belongs to.
// This literal MUST match the organizations seed row in supabase/schema.sql.
// The tenant is always taken from the session (never a request body); this is
// only the fallback for sessions/rows created before the org model existed.
const RUSHROOM_ORG_ID = "11111111-1111-4111-8111-111111111111";
// A user's assigned role → their per-organization membership role.
const MEMBERSHIP_ROLE: Record<string, string> = {
  admin: "org_admin", internal: "manager", reviewer: "reviewer", supplier: "collaborator", installer: "collaborator",
};
const membershipRoleFor = (assigned: string) => MEMBERSHIP_ROLE[assigned] || "collaborator";

// --- Stage 2: central tenant scoping (module-level factory) ----------------
// Tenant tables carry organization_id; reads are filtered and writes are stamped
// with the caller's org. Global/account tables (users, eu_directives,
// directive_relations, cellar_cache, organizations, memberships) pass straight
// through. Build a per-request instance with makeTdb(orgId) — never a shared
// mutable global — so scoping can't race across concurrent requests. Use
// tdb(table) exactly like db.from(table) for tenant data.
const TENANT_TABLES = new Set([
  "steps", "documents", "document_versions", "uploads", "standards", "standard_versions",
  "deviation_scans", "deviation_findings", "standard_clauses", "as_operates_interpretations",
  "product_passports", "passport_interpretation_links", "product_directive_applicability",
  "classification_log", "requirement_links", "document_statements",
  // PROP-013: Product Information System
  "bom_components", "bom_component_versions", "bom_edges", "bom_component_history",
  "component_materials", "component_documents",
  // PROP-015: Configure-to-Order Variant BOM
  "family_attributes", "family_attribute_values", "saved_configurations",
  // PROP-026: Component image gallery
  "component_images",
  // PROP-030: Manufacturing BOM + product families (migration 0019)
  "product_families", "product_family_members",
  "component_routing_steps", "work_orders", "work_order_steps", "work_order_components",
  // PROP-031: Component metadata (migration 0020)
  "component_metadata",
]);
function makeTdb(orgId: string) {
  const stamp = (rows: any) => Array.isArray(rows)
    ? rows.map((r) => ({ ...r, organization_id: orgId }))
    : { ...rows, organization_id: orgId };
  return function tdb(table: string): any {
    const b = db.from(table);
    if (!TENANT_TABLES.has(table)) return b;
    return {
      select: (...args: any[]) => (b.select as any)(...args).eq("organization_id", orgId),
      insert: (rows: any) => b.insert(stamp(rows)),
      upsert: (rows: any, opts?: any) => b.upsert(stamp(rows), opts),
      update: (patch: any) => b.update(patch).eq("organization_id", orgId),
      delete: () => b.delete().eq("organization_id", orgId),
    };
  };
}

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
  sendEmail(to, "Verify your Rushroom Compliance Portal registration",
    `<p>Hi ${name || "there"},</p><p>Thanks for registering for the Rushroom AB Compliance Portal. Please confirm your email address:</p><p><a href="${url}">Verify my email</a></p><p>This link expires in 7 days. If you didn't request this, you can ignore it.</p>`);
const sendPasswordEmail = (to: string, name: string, url: string) =>
  sendEmail(to, "Set your Rushroom Compliance Portal password",
    `<p>Hi ${name || "there"},</p><p>Use the link below to set a new password for the Rushroom AB Compliance Portal:</p><p><a href="${url}">Set my password</a></p><p>This link expires in 1 hour. If you didn't request this, you can ignore it.</p>`);

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
  let res = await tdb("document_versions").insert(row);
  if (res.error && /source_(document|standard)_version_ids?/.test(res.error.message || "")) {
    const clean = { ...row };
    delete clean.source_document_version_id;
    delete clean.source_standard_version_ids;
    res = await tdb("document_versions").insert(clean);
  }
  return res;
}

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SCAN_MODEL = "claude-opus-4-8";
// EU Publications Office (CELLAR) integration — directive metadata + relations.
const cellar = createCellarService(db, ANTHROPIC_API_KEY);
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
const usagePeriod = () => new Date().toISOString().slice(0, 7); // 'YYYY-MM'

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

function xmlDecode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");
}
async function extractDocx(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const withBreaks = xml.replace(/<w:p[ >/]/g, "\n<w:p ").replace(/<[^>]+>/g, " ");
  return xmlDecode(withBreaks).replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}
async function extractXlsx(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const shared = (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "";
  const cells = [...shared.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlDecode(m[1]).trim()).filter(Boolean);
  return cells.join(" · ");
}
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}
// Claude accepts at most 600 PDF pages per request; large regulations (e.g. the
// REACH full text) exceed that. The metadata / key requirements we need live on
// the first pages, so cap oversized PDFs to their first PDF_PAGE_CAP pages.
const PDF_PAGE_CAP = 40;
async function capPdfPages(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const total = src.getPageCount();
    if (total <= PDF_PAGE_CAP) return bytes;
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, Array.from({ length: PDF_PAGE_CAP }, (_, i) => i));
    for (const pg of pages) out.addPage(pg);
    return await out.save();
  } catch (_) {
    return bytes; // best effort — if it still exceeds the limit the caller surfaces a graceful message
  }
}

// Returns a Claude content block for a stored file.
async function fileBlock(bucket: string, path: string, fileName: string) {
  const { data, error } = await db.storage.from(bucket).download(path);
  if (error || !data) return { type: "text", text: "(could not read file)" };
  const bytes = new Uint8Array(await data.arrayBuffer());
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  try {
    if (ext === "pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(await capPdfPages(bytes)) } };
    if (ext === "docx") return { type: "text", text: (await extractDocx(bytes)).slice(0, TEXT_CAP) || "(empty)" };
    if (ext === "xlsx" || ext === "xls") return { type: "text", text: (await extractXlsx(bytes)).slice(0, TEXT_CAP) || "(empty)" };
    return { type: "text", text: new TextDecoder().decode(bytes).slice(0, TEXT_CAP) || "(empty)" };
  } catch (e) {
    return { type: "text", text: `(could not extract text: ${(e as Error).message})` };
  }
}

async function summarizeRequirementSource(bucket: string, path: string, fileName: string, label: string) {
  const block = await fileBlock(bucket, path, fileName);
  const text = typeof block === "object" && "text" in block ? String(block.text || "") : "";
  if (!text || text.includes("could not read") || text.includes("(empty)")) return `- ${label}: no readable text available`;
  const prompt = `Extract the most important compliance requirements and obligations from the following document text. Return a concise bullet list with no more than 8 bullets. Focus on requirements relevant to an operational compliance document.\n\nDocument: ${label}\n\n${text.slice(0, 18000)}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: SCAN_MODEL,
        max_tokens: 4000,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      }),
    });
    const json = await res.json();
    if (!res.ok) return `- ${label}: could not summarize automatically`; 
    const textBlock = (json.content || []).find((b: any) => b.type === "text");
    return `- ${label}:\n${String(textBlock?.text || "").trim()}`;
  } catch {
    return `- ${label}: could not summarize automatically`;
  }
}

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
async function buildComplianceGraph(tdb: any, scope: string, passportId: string | null): Promise<{ nodes: any[]; edges: any[]; gaps: any[] }> {
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
async function loadClassificationItems(tdb: any): Promise<any[]> {
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

// ---- request handler -------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!TOKEN_SECRET) return json({ error: "Server not configured (TOKEN_SECRET missing)" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = String(body.action || "");
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
  const session = await verifySession(body.token);
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
    const emailed = await sendEmail(to, "Rushroom Compliance Portal — test email",
      `<p>This is a test email from the Rushroom AB Compliance Portal.</p><p>If you can read this, email delivery is working — verification and password links will now reach users automatically.</p>`);
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
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const document_id = String(body.documentId ?? "").trim();
    const templateDocumentId = String(body.templateDocumentId ?? "").trim();
    const context = String(body.notes ?? "").trim();
    const preferredVersion = String(body.preferredVersion ?? "").trim();
    const sourceStandardIds = Array.isArray(body.sourceStandardIds) ? body.sourceStandardIds.filter((v: unknown) => String(v ?? "").trim()) : [];
    const sourceStandardVersionIds = Array.isArray(body.sourceStandardVersionIds) ? body.sourceStandardVersionIds.filter((v: unknown) => String(v ?? "").trim()) : [];

    let doc: any = null;
    let storagePath = "";
    let fileName = "document";
    if (document_id) {
      const { data: foundDoc, error: docErr } = await tdb("documents").select("id,name,kind,storage_path").eq("id", document_id).maybeSingle();
      if (docErr || !foundDoc) return json({ error: "Document not found" }, 404);
      doc = foundDoc;
      const { data: latest } = await tdb("document_versions").select("*").eq("document_id", document_id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      // Fall back to the document's own file when no version row exists yet.
      storagePath = latest?.storage_path || foundDoc.storage_path || "";
      fileName = latest?.file_name || doc.name || "document";
    } else if (templateDocumentId) {
      const { data: foundDoc } = await tdb("documents").select("id,name,kind,storage_path").eq("id", templateDocumentId).maybeSingle();
      if (foundDoc) {
        doc = foundDoc;
        const { data: latest } = await tdb("document_versions").select("*").eq("document_id", templateDocumentId).order("created_at", { ascending: false }).limit(1).maybeSingle();
        storagePath = latest?.storage_path || foundDoc.storage_path || "";
        fileName = latest?.file_name || doc.name || "document";
      }
    }

    const content: any[] = [{ type: "text", text: "You are helping Rushroom create or update a compliance-operational document. Draft the next version using the supplied source material and the user's change request. Return strict JSON matching the requested schema." }];
    if (context) content.push({ type: "text", text: `\nChange request / context:\n${context}` });
    if (preferredVersion) content.push({ type: "text", text: `\nPreferred version label:\n${preferredVersion}` });
    if ((document_id || templateDocumentId) && storagePath) {
      content.push({ type: "text", text: "\n=== CURRENT DOCUMENT ===" });
      content.push(await fileBlock(DOC_BUCKET, storagePath, fileName));
    }
    const standardVersionIds = sourceStandardVersionIds.length ? sourceStandardVersionIds : [];
    if (sourceStandardIds.length && !standardVersionIds.length) {
      // backward compatibility: use the latest uploaded version for each standard ID.
      for (const standardId of sourceStandardIds) {
        const { data: latestVersion } = await tdb("standard_versions").select("id").eq("standard_id", standardId).order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (latestVersion?.id) standardVersionIds.push(latestVersion.id);
      }
    }
    if (standardVersionIds.length) {
      content.push({ type: "text", text: "\n=== REFERENCE STANDARDS & REGULATIONS ===" });
      const summaries: string[] = [];
      for (const standardVersionId of standardVersionIds) {
        const { data: version } = await tdb("standard_versions").select("*, standard:standard_id(code,title,category)").eq("id", standardVersionId).maybeSingle();
        if (!version) continue;
        const label = `${version.standard?.code || version.standard?.title || "standard"}${version.version ? ` ${version.version}` : ""}`;
        if (version.storage_path) {
          const summary = await summarizeRequirementSource(STD_BUCKET, version.storage_path, version.file_name || label, `${label}`);
          summaries.push(summary);
        } else {
          summaries.push(`- ${label}: no uploaded file yet`);
        }
      }
      content.push({ type: "text", text: summaries.join("\n") });
    }
    if (!document_id && !templateDocumentId && !standardVersionIds.length) return json({ error: "Provide either a current document, a template, or at least one source standard/regulation." }, 400);

    const system = `You are an expert compliance-document editor for Rushroom AB. Review the supplied source material and produce a practical next version draft. Keep it concise, professional, and suitable for compliance use. If the document contains outdated wording, add clear improvement suggestions. When reference standards/regulations are supplied, reflect their relevant requirements and terminology. Return a JSON object with:
- summary: a short explanation of the proposed update
- proposed_changes: an array of objects with title, description, rationale
- draft_text: a full draft of the updated document in plain markdown
- version_hint: a suggested version label such as Rev C or 2026-08
- file_name_hint: a file name suggestion such as as-operated-v3.md`;

    let apiJson: any;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: SCAN_MODEL,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium", format: { type: "json_schema", schema: DOCUMENT_DRAFT_SCHEMA } },
          system,
          messages: [{ role: "user", content }],
        }),
      });
      apiJson = await res.json();
      await meterAi(apiJson);
      if (!res.ok) return json({ error: `Claude API error (${res.status}): ${apiJson?.error?.message || "unknown"}` }, 502);
    } catch (e) {
      return json({ error: `Claude API request failed: ${(e as Error).message}` }, 502);
    }
    if (apiJson.stop_reason === "refusal") return json({ error: "The AI declined to draft the document update." }, 502);
    const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
    let parsed: any;
    try { parsed = JSON.parse(textBlock?.text || "{}"); }
    catch { return json({ error: "The AI response could not be parsed. Try again." }, 502); }

    const proposedChanges = Array.isArray(parsed.proposed_changes) ? parsed.proposed_changes : [];
    return json({
      ok: true,
      summary: String(parsed.summary || "Draft prepared."),
      proposedChanges,
      draftText: String(parsed.draft_text || ""),
      versionHint: String(parsed.version_hint || "AI draft"),
      fileNameHint: String(parsed.file_name_hint || "draft.md"),
      usage: usageOf(apiJson),
    });
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
    const { error } = await insertDocumentVersion(tdb, {
      document_id, version: String(body.version ?? "").slice(0, 80),
      file_name: fileName.slice(0, 200), storage_path: path,
      notes: String(body.notes ?? "").slice(0, 1000), uploaded_by: "rushroom",
      source_document_version_id: sourceDocumentVersionId,
      source_standard_version_ids: sourceStandardVersionIds.length ? sourceStandardVersionIds : [],
    });
    if (error) return json({ error: error.message }, 500);
    await tdb("documents").update({ storage_path: path }).eq("id", document_id); // keep current pointer in sync
    return json({ ok: true });
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
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    if (!ANTHROPIC_API_KEY) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY in the function secrets." }, 400);
    const path = String(body.path ?? "").trim();
    const fileName = String(body.fileName ?? "file").trim();
    if (!path) return json({ error: "path required" }, 400);

    const system = `You are a compliance librarian reading a single standard or regulation document. Extract its catalogue metadata precisely from the document itself — do not invent values. Return a JSON object:
- code: the official designation exactly as published (e.g. "EN 60598-1", "2014/35/EU", "(EU) 2019/2020", "EN IEC 63000"). If none is visible, "".
- title: the official document title.
- category: a short classifying DOMAIN tag for a compliance register — one of LVD, EMC, RoHS, REACH, Ecodesign, Energy labelling, Packaging/PPWR, WEEE, Batteries, Radio/RED, CPR, Machinery, or another concise domain tag if none fit.
- reg_type: the regulatory TYPE/level — exactly one of "EU Directive", "EU Regulation", "Harmonised Standard (EN)", "National Standard", "International (IEC/ISO)", or "Other". Infer from the designation: "2014/35/EU" → EU Directive; "(EU) 2019/2020" → EU Regulation; a code starting "EN " → Harmonised Standard (EN); "IEC …"/"ISO …" → International (IEC/ISO); a national code (e.g. "DIN …", "BS …", "NF …", "SS …", "UNE …") → National Standard. If unclear, "".
- jurisdiction: where it applies — "EU" for EU directives/regulations and harmonised EN standards; "International" for IEC/ISO; or the specific country for a national standard (e.g. "Germany", "France", "Sweden"). If unclear, "".
- version: the edition / amendment / year that identifies this revision (e.g. "2015+A1:2022", "Rev 3", "2014"). If none is visible, "".
- effective_date: the date the document applies from if explicitly stated (ISO or as printed), else "".
- summary: one sentence on what the document covers.`;

    const content: any[] = [
      { type: "text", text: "Extract the metadata for this standard/regulation document." },
      await fileBlock(STD_BUCKET, path, fileName),
    ];

    let apiJson: any;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: SCAN_MODEL,
          max_tokens: 2000,
          thinking: { type: "adaptive" },
          output_config: { effort: "low", format: { type: "json_schema", schema: STANDARD_META_SCHEMA } },
          system,
          messages: [{ role: "user", content }],
        }),
      });
      apiJson = await res.json();
      await meterAi(apiJson);
      if (!res.ok) return json({ error: `Claude API error (${res.status}): ${apiJson?.error?.message || "unknown"}` }, 502);
    } catch (e) {
      return json({ error: `Claude API request failed: ${(e as Error).message}` }, 502);
    }
    if (apiJson.stop_reason === "refusal") return json({ error: "The AI declined to read this document." }, 502);
    const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
    let parsed: any;
    try { parsed = JSON.parse(textBlock?.text || "{}"); }
    catch { return json({ error: "The AI response could not be parsed. Try again or fill the fields manually." }, 502); }
    return json({
      ok: true,
      code: String(parsed.code || ""),
      title: String(parsed.title || ""),
      category: String(parsed.category || ""),
      regType: String(parsed.reg_type || ""),
      jurisdiction: String(parsed.jurisdiction || ""),
      version: String(parsed.version || ""),
      effectiveDate: String(parsed.effective_date || ""),
      summary: String(parsed.summary || ""),
      usage: usageOf(apiJson),
    });
  }

  if (action === "suggestComponentMetadata") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    if (!ANTHROPIC_API_KEY) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY in the function secrets." }, 400);
    const path = String(body.path ?? "").trim();
    const fileName = String(body.fileName ?? "file").trim();
    if (!path) return json({ error: "path required" }, 400);

    const system = `You are reading a product datasheet, technical drawing, or component specification. Extract the component's catalogue metadata precisely from the document. Return a JSON object:
- part_number: the manufacturer's own part number or SKU exactly as printed (e.g. "LED-STRIP-2835-24V-12W", "WAGO-221-412"). If none is visible, "".
- oem_number: the OEM or distributor reference number if printed separately from the main part number (e.g. a Farnell order code, RS part number, or second manufacturer reference). If not present, "".
- name: the component's concise descriptive name (e.g. "LED Strip 24V 12W/m", "PSU 24V 60W", "Wago 221 Lever Connector 2-pin").
- type: exactly one of "part", "raw_material", "sub_assembly", "finished_good", "spare_part". A single purchased or manufactured item → "part"; a bulk raw/process material → "raw_material"; an intermediate built group of other parts → "sub_assembly"; the final saleable product → "finished_good"; a service or replacement part → "spare_part".
- description: one sentence describing what this component is and what purpose it serves.
- summary: one sentence on the document itself (for the upload status bar).`;

    const content: any[] = [
      { type: "text", text: "Extract the component metadata from this document." },
      await fileBlock(DOC_BUCKET, path, fileName),
    ];

    let apiJson: any;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: SCAN_MODEL,
          max_tokens: 1500,
          thinking: { type: "adaptive" },
          output_config: { effort: "low", format: { type: "json_schema", schema: COMPONENT_META_SCHEMA } },
          system,
          messages: [{ role: "user", content }],
        }),
      });
      apiJson = await res.json();
      await meterAi(apiJson);
      if (!res.ok) return json({ error: `Claude API error (${res.status}): ${apiJson?.error?.message || "unknown"}` }, 502);
    } catch (e) {
      return json({ error: `Claude API request failed: ${(e as Error).message}` }, 502);
    }
    if (apiJson.stop_reason === "refusal") return json({ error: "The AI declined to read this document." }, 502);
    const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
    let parsed: any;
    try { parsed = JSON.parse(textBlock?.text || "{}"); }
    catch { return json({ error: "The AI response could not be parsed. Try again or fill the fields manually." }, 502); }
    const VALID_TYPES = ["part", "raw_material", "sub_assembly", "finished_good", "spare_part"];
    return json({
      ok: true,
      part_number: String(parsed.part_number || ""),
      oem_number:  String(parsed.oem_number  || ""),
      name:        String(parsed.name        || ""),
      type:        VALID_TYPES.includes(parsed.type) ? parsed.type : "part",
      description: String(parsed.description || ""),
      summary:     String(parsed.summary     || ""),
      usage: usageOf(apiJson),
    });
  }

  if (action === "suggestFileMetadata") {
    if (!ANTHROPIC_API_KEY) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY in the function secrets." }, 400);
    const bucketKey = String(body.bucket ?? "documents");
    const bucket = bucketKey === "standards" ? STD_BUCKET : bucketKey === "uploads" ? BUCKET : DOC_BUCKET;
    // The document library and standards register are Rushroom-managed; supplier
    // uploads may be auto-described by whoever uploaded them.
    if ((bucketKey === "documents" || bucketKey === "standards") && role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    const path = String(body.path ?? "").trim();
    const fileName = String(body.fileName ?? "file").trim();
    if (!path) return json({ error: "path required" }, 400);

    const system = `You are a compliance librarian cataloguing an uploaded file. Read the document and extract its metadata precisely — do not invent values. Return a JSON object:
- name: a clear, concise title for the document (e.g. "EU Declaration of Conformity", "LVD Safety Test Report — Model X", "Supplier Declaration of Compliance"). If the file has an obvious title, use it.
- category: a short classifying tag for a compliance file library — e.g. Declarations & CE, Technical file, Test reports, Suppliers, Materials & packaging, Records & monitoring, or another concise domain tag if none fit.
- version: an edition / revision / date-based version label if the document states one (e.g. "Rev B", "2026-06", "2015+A1:2022"), else "".
- effective_date: a date the document is dated or effective from if stated, else "".
- kind: "template" if this is a blank or fillable template, form, or reference-requirement document; "operational" if it is completed operational evidence or a filled-in record; else "".
- summary: one sentence describing what the document is.`;

    const content: any[] = [
      { type: "text", text: "Extract catalogue metadata for this uploaded compliance file." },
      await fileBlock(bucket, path, fileName),
    ];

    let apiJson: any;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: SCAN_MODEL,
          max_tokens: 2000,
          thinking: { type: "adaptive" },
          output_config: { effort: "low", format: { type: "json_schema", schema: FILE_META_SCHEMA } },
          system,
          messages: [{ role: "user", content }],
        }),
      });
      apiJson = await res.json();
      await meterAi(apiJson);
      if (!res.ok) return json({ error: `Claude API error (${res.status}): ${apiJson?.error?.message || "unknown"}` }, 502);
    } catch (e) {
      return json({ error: `Claude API request failed: ${(e as Error).message}` }, 502);
    }
    if (apiJson.stop_reason === "refusal") return json({ error: "The AI declined to read this document." }, 502);
    const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
    let parsed: any;
    try { parsed = JSON.parse(textBlock?.text || "{}"); }
    catch { return json({ error: "The AI response could not be parsed. Try again or fill the fields manually." }, 502); }
    return json({
      ok: true,
      name: String(parsed.name || ""),
      category: String(parsed.category || ""),
      version: String(parsed.version || ""),
      effectiveDate: String(parsed.effective_date || ""),
      kind: String(parsed.kind || ""),
      summary: String(parsed.summary || ""),
      usage: usageOf(apiJson),
    });
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
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);

    // Operational ("Company as Operated") documents are the evidence being audited.
    const { data: docs } = await tdb("documents").select("id,name,storage_path").eq("kind", "operational").neq("storage_path", "");
    const storedDocs = (docs ?? []).filter((d) => d.storage_path);

    // ---- Phase A: structured findings from clause-level interpretations ----
    // Instant, no LLM. A document with any interpretations is "covered" and is
    // NOT sent to the AI — its deviations/pending items come from here instead.
    const { data: interps } = await tdb("as_operates_interpretations").select(
      "compliance_status, interpretation_text, rationale, deviation_description, deviation_accepted_by, document_version_id, clause:clause_id(clause_ref, clause_title, standard:standard_version_id(standard:standard_id(code,title)))",
    );
    const interpList = interps ?? [];
    const docNameByVersion: Record<string, string> = {};
    const coveredDocIds = new Set<string>();
    const interpVersionIds = [...new Set(interpList.map((i) => i.document_version_id))];
    if (interpVersionIds.length) {
      const { data: vers } = await tdb("document_versions").select("id, file_name, document_id, document:document_id(name, kind)").in("id", interpVersionIds);
      for (const v of vers ?? []) {
        docNameByVersion[v.id] = (v as any).document?.name || v.file_name || "document";
        if (((v as any).document?.kind || "template") === "operational") coveredDocIds.add(v.document_id);
      }
    }
    const sevForInterp = (i: any): string | null => {
      if (i.compliance_status === "deviation") return i.deviation_accepted_by ? "Info" : "High";
      if (i.compliance_status === "pending") return "Medium";
      return null; // compliant / not_applicable → no finding
    };
    const structuredFindings = interpList.map((i: any) => {
      const sev = sevForInterp(i);
      if (!sev) return null;
      const c = i.clause || {};
      const stdCode = c.standard?.standard?.code || "";
      const isDev = i.compliance_status === "deviation";
      return {
        severity: sev,
        title: (isDev ? `Deviation on clause ${c.clause_ref || "?"}${i.deviation_accepted_by ? " (accepted)" : ""}` : `Interpretation pending review — clause ${c.clause_ref || "?"}`).slice(0, 300),
        description: String(i.deviation_description || i.interpretation_text || i.rationale || "").slice(0, 4000),
        document: String(docNameByVersion[i.document_version_id] || "document").slice(0, 300),
        standard: `${stdCode}${c.clause_ref ? " " + c.clause_ref : ""}`.trim().slice(0, 300),
        recommendation: (isDev ? (i.deviation_accepted_by ? `Accepted by ${i.deviation_accepted_by} — keep documented.` : "Close this deviation, or document an accepted-deviation rationale and approver.") : "Review this clause and set a compliance status.").slice(0, 2000),
        source: "structured",
      };
    }).filter(Boolean) as any[];

    // ---- Phase B: AI fallback for operational docs WITHOUT interpretations ----
    const uncoveredDocs = storedDocs.filter((d) => !coveredDocIds.has(d.id));
    // Latest uploaded version of each standard (needed for the AI comparison).
    const { data: stds } = await tdb("standards").select("id,code,title,category").order("code");
    const standards: any[] = [];
    for (const s of stds ?? []) {
      const { data: v } = await tdb("standard_versions").select("*").eq("standard_id", s.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (v?.storage_path) standards.push({ ...s, version: v.version, storage_path: v.storage_path, file_name: v.file_name });
    }
    const willRunAI = uncoveredDocs.length > 0 && standards.length > 0;

    // Guardrails: only bail when there is genuinely nothing to do.
    if (!storedDocs.length && !interpList.length) return json({ error: "No operational documents to check — mark documents as “Company as Operated” in the Document library first." }, 400);
    if (!structuredFindings.length && coveredDocIds.size === 0 && !willRunAI) {
      if (!standards.length) return json({ error: "No standards with an uploaded version yet — add standards and upload files first." }, 400);
      return json({ error: "Nothing to scan — add clause interpretations or operational documents first." }, 400);
    }
    if (willRunAI && !ANTHROPIC_API_KEY) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY in the function secrets (or add interpretations so the scan can run structured-only)." }, 400);

    let aiFindings: any[] = [];
    let aiModel = ""; let aiSummary = ""; let aiNote = "";
    let aiUsage: any = { model: "", input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    if (willRunAI) {
      const content: any[] = [{ type: "text", text: "=== STANDARDS & REGULATIONS (the requirements) ===" }];
      for (const s of standards) {
        content.push({ type: "text", text: `\n--- STANDARD: ${s.code}${s.title ? ` — ${s.title}` : ""}${s.category ? ` [${s.category}]` : ""} (version ${s.version || "?"}) ---` });
        content.push(await fileBlock(STD_BUCKET, s.storage_path, s.file_name));
      }
      content.push({ type: "text", text: "\n\n=== COMPLIANCE DOCUMENTS (what Rushroom has produced) ===" });
      for (const d of uncoveredDocs) {
        content.push({ type: "text", text: `\n--- DOCUMENT: ${d.name} ---` });
        content.push(await fileBlock(DOC_BUCKET, d.storage_path, d.storage_path));
      }
      content.push({ type: "text", text: "\nAnalyse the compliance DOCUMENTS against the STANDARDS & REGULATIONS above. Report deviations, gaps, missing evidence, outdated references, and unmet requirements. Only report genuine issues grounded in the supplied material; do not invent requirements that were not provided." });

      const system = `You are a meticulous EU product-compliance auditor for Rushroom AB (LED system-furniture). Compare the company's compliance DOCUMENTS against the provided STANDARDS & REGULATIONS and surface where the documents deviate from, or fall short of, the standards.

Assign each finding a severity:
- Critical: a legal blocker to selling or CE-marking (missing Declaration of Conformity, an unmet mandatory requirement, a safety/EMC/energy non-conformity).
- High: a significant gap that must be closed before launch.
- Medium: an incomplete or outdated item that needs attention.
- Low: a minor inconsistency or improvement.
- Info: an observation, not a deviation.

Be specific: name the exact document and the exact standard (and clause where possible) each finding relates to, and give a concrete recommendation. If everything aligns, return an empty findings array and say so in the summary.`;

      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model: SCAN_MODEL, max_tokens: 16000, thinking: { type: "adaptive" },
            output_config: { effort: "medium", format: { type: "json_schema", schema: FINDINGS_SCHEMA } },
            system, messages: [{ role: "user", content }],
          }),
        });
        const apiJson = await res.json();
        await meterAi(apiJson);
        if (!res.ok) throw new Error(`Claude API error (${res.status}): ${apiJson?.error?.message || "unknown"}`);
        if (apiJson.stop_reason === "refusal") throw new Error("the AI declined to complete the analysis (refusal)");
        const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
        const parsed = JSON.parse(textBlock?.text || "{}");
        aiFindings = (Array.isArray(parsed.findings) ? parsed.findings : []).map((f: any) => ({
          severity: SEVERITIES.includes(f.severity) ? f.severity : "Info",
          title: String(f.title || "").slice(0, 300),
          description: String(f.description || "").slice(0, 4000),
          document: String(f.document || "").slice(0, 300),
          standard: String(f.standard || "").slice(0, 300),
          recommendation: String(f.recommendation || "").slice(0, 2000),
          source: "ai_inference",
        }));
        aiModel = apiJson.model || SCAN_MODEL;
        aiSummary = String(parsed.summary || "");
        aiUsage = usageOf(apiJson);
      } catch (e) {
        // AI failure is non-fatal when we still have structured findings.
        if (!structuredFindings.length && !coveredDocIds.size) return json({ error: `Claude API request failed: ${(e as Error).message}` }, 502);
        aiNote = ` (AI analysis of ${uncoveredDocs.length} uncovered document(s) failed: ${(e as Error).message})`;
      }
    }

    // ---- Combine, count, persist ----
    const allFindings = [...structuredFindings, ...aiFindings];
    const counts: Record<string, number> = {};
    for (const f of allFindings) counts[f.severity] = (counts[f.severity] || 0) + 1;

    const summaryParts: string[] = [];
    if (coveredDocIds.size) summaryParts.push(`${coveredDocIds.size} document(s) checked via structured interpretations — ${structuredFindings.length} finding(s), no AI needed.`);
    if (willRunAI && !aiNote) summaryParts.push(aiSummary || `${uncoveredDocs.length} document(s) analysed with AI.`);
    if (aiNote) summaryParts.push(aiNote.trim());
    if (!summaryParts.length) summaryParts.push(allFindings.length ? `${allFindings.length} finding(s).` : "No issues found.");

    const scanRow: Record<string, unknown> = {
      model: aiModel || "structured", status: "ok", summary: summaryParts.join(" ").slice(0, 4000),
      counts, docs_scanned: coveredDocIds.size + (willRunAI && !aiNote ? uncoveredDocs.length : 0), standards_scanned: standards.length,
      usage: aiUsage,
    };
    let scanResp = await tdb("deviation_scans").insert(scanRow).select("*").maybeSingle();
    // Self-heal if the optional `usage` column hasn't been added yet.
    if (scanResp.error && /usage/.test(scanResp.error.message || "")) {
      const { usage: _u, ...noUsage } = scanRow;
      scanResp = await tdb("deviation_scans").insert(noUsage).select("*").maybeSingle();
    }
    const scan = scanResp.data;
    if (scanResp.error || !scan) return json({ error: `Could not save scan: ${scanResp.error?.message}` }, 500);

    if (allFindings.length) {
      const rows = allFindings.slice(0, 300).map((f: any) => ({ scan_id: scan.id, ...f }));
      const { error: fErr } = await tdb("deviation_findings").insert(rows);
      if (fErr) return json({ error: `Could not save findings: ${fErr.message}` }, 500);
    }
    return json({ ok: true, scan: { ...scan, usage: scan.usage ?? aiUsage }, findings: allFindings, structuredCount: structuredFindings.length, aiCount: aiFindings.length, usage: aiUsage });
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
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    if (!ANTHROPIC_API_KEY) return json({ error: "AI is not configured" }, 400);
    const standardVersionId = String(body.standardVersionId ?? "").trim();
    if (!standardVersionId) return json({ error: "standardVersionId required" }, 400);
    const maxClauses = Number(body.maxClauses ?? 200) || 200;

    const { data: version } = await tdb("standard_versions")
      .select("*, standard:standard_id(code,title)").eq("id", standardVersionId).maybeSingle();
    if (!version) return json({ error: "Standard version not found" }, 404);
    if (!version.storage_path) return json({ error: "Standard version has no uploaded file" }, 400);

    const fileBlock_ = await fileBlock(STD_BUCKET, version.storage_path, version.file_name || "standard");
    const content = [{
      type: "text",
      text: `Extract all compliance clauses from this standard document. Return a JSON array of clause objects with this structure:\n[\n  { "clause_ref": "4.1", "clause_title": "Title", "clause_text": "requirement text", "requirement_type": "mandatory|conditional|informative", "parent_clause_ref": "4" or null },\n  ...\n]\n\nFocus on requirements, not explanatory text. Return up to ${maxClauses} clauses.`,
    }, fileBlock_];

    let apiJson: any;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: SCAN_MODEL, max_tokens: 12000,
          system: "You are an expert regulatory compliance document analyst. Extract all clauses from the provided standard. Be precise and concise.",
          messages: [{ role: "user", content }],
        }),
      });
      apiJson = await res.json();
      await meterAi(apiJson);
      if (!res.ok) return json({ error: `Claude API error: ${apiJson?.error?.message || "unknown"}` }, 502);
    } catch (e) {
      return json({ error: `Claude API request failed: ${(e as Error).message}` }, 502);
    }

    const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
    let parsed: any[] = [];
    try {
      const jsonStr = (textBlock?.text || "").match(/\[[\s\S]*\]/)?.[0] || "[]";
      parsed = JSON.parse(jsonStr);
    } catch { return json({ error: "Could not parse AI clause response" }, 502); }

    if (!Array.isArray(parsed) || !parsed.length) return json({ error: "No clauses extracted" }, 400);

    // Build a parent-ref → id map for linking
    const clausesByRef: Record<string, any> = {};
    const toInsert: any[] = [];
    let insertedCount = 0;

    for (const clause of parsed.slice(0, maxClauses)) {
      const ref = String(clause.clause_ref ?? "").trim().slice(0, 120);
      if (!ref) continue;
      const key = `${standardVersionId}:${ref}`;
      if (clausesByRef[key]) continue; // skip if already queued
      clausesByRef[key] = clause;
      toInsert.push({
        standard_version_id: standardVersionId,
        clause_ref: ref,
        clause_title: String(clause.clause_title ?? "").slice(0, 300),
        clause_text: String(clause.clause_text ?? "").slice(0, 4000),
        requirement_type: ["mandatory", "conditional", "informative"].includes(String(clause.requirement_type))
          ? clause.requirement_type : "mandatory",
        ai_generated: true,
      });
    }

    if (!toInsert.length) return json({ error: "No valid clauses to insert" }, 400);

    const { data: inserted, error: insertErr } = await tdb("standard_clauses").insert(toInsert).select("id,clause_ref");
    if (insertErr) {
      if (insertErr.code === "23505") {
        // Duplicate key: clauses already exist for this standard version
        return json({ error: "Clauses already exist for this standard version. Clear them first if you want to re-extract." });
      }
      return json({ error: `Insert error: ${insertErr.message}` }, 500);
    }

    insertedCount = (inserted ?? []).length;

    // Now link parents: for each clause, find its parent_ref and update parent_clause_id
    for (const clause of (inserted ?? [])) {
      const orig = toInsert.find((t) => t.clause_ref === clause.clause_ref);
      if (!orig) continue;
      const parentRef = String(orig.clause_ref).replace(/\.[^.]+$/, "");
      if (parentRef === orig.clause_ref) continue; // no parent
      const parent = (inserted ?? []).find((p) => p.clause_ref === parentRef);
      if (parent?.id) {
        await tdb("standard_clauses").update({ parent_clause_id: parent.id }).eq("id", clause.id);
      }
    }

    return json({ ok: true, inserted: insertedCount, standard: version.standard?.code, version: version.version, usage: usageOf(apiJson) });
  }

  if (action === "generateInterpretations") {
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    if (!ANTHROPIC_API_KEY) return json({ error: "AI is not configured" }, 400);
    const documentVersionId = String(body.documentVersionId ?? "").trim();
    const clauseIds = (Array.isArray(body.clauseIds) ? body.clauseIds.filter((v: unknown) => String(v ?? "").trim()) : []).slice(0, 60);
    if (!documentVersionId || !clauseIds.length) return json({ error: "documentVersionId and clauseIds required" }, 400);

    // Fetch the document version
    const { data: docVer } = await tdb("document_versions").select("*, document:document_id(name)").eq("id", documentVersionId).maybeSingle();
    if (!docVer) return json({ error: "Document version not found" }, 404);
    if (!docVer.storage_path) return json({ error: "Document version has no uploaded file" }, 400);

    // Fetch all clauses
    const { data: clauses } = await tdb("standard_clauses").select("*").in("id", clauseIds);
    if (!clauses || !clauses.length) return json({ error: "No clauses found" }, 404);

    // Send the actual document FILE to Claude (so PDFs work — not just text),
    // and interpret clauses in BATCHES (one call per ~10 clauses, not per clause).
    const docBlock = await fileBlock(DOC_BUCKET, docVer.storage_path, docVer.file_name || docVer.document?.name || "document");
    const INTERP_SCHEMA = {
      type: "object", additionalProperties: false,
      required: ["interpretations"],
      properties: {
        interpretations: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            required: ["index", "interpretation_text", "compliance_status", "rationale"],
            properties: {
              index: { type: "integer" },
              interpretation_text: { type: "string" },
              compliance_status: { type: "string", enum: ["compliant", "deviation", "not_applicable", "pending"] },
              rationale: { type: "string" },
            },
          },
        },
      },
    };
    const interpSystem = "You are a meticulous EU product-compliance auditor. For each requirement clause, read the attached company operational document and state how the document implements that clause. Base every interpretation strictly on the document — never invent implementation details. If the document does not address a clause, mark it 'pending' (unclear) or 'not_applicable', and say so in the rationale. Echo each clause's [index] exactly.";

    const results: any[] = [];
    let usageTotal: any = { model: SCAN_MODEL, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    const batchSize = 10;
    for (let i = 0; i < clauses.length; i += batchSize) {
      const batch = clauses.slice(i, i + batchSize);
      const list = batch.map((c, j) => `[${j + 1}] Clause ${c.clause_ref}${c.clause_title ? ` — ${c.clause_title}` : ""}\nRequirement: ${String(c.clause_text || "").slice(0, 1500)}`).join("\n\n");
      const content: any[] = [
        { type: "text", text: `Interpret how the ATTACHED company operational document implements each of the following ${batch.length} requirement clause(s). Return exactly one interpretation per clause, echoing its [index].\n\n${list}` },
        docBlock,
      ];
      const markPending = () => batch.forEach((c) => results.push({ clause_id: c.id, interpretation_text: "", compliance_status: "pending", rationale: "", ai_generated: false }));
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model: SCAN_MODEL, max_tokens: 12000,
            thinking: { type: "adaptive" },
            output_config: { effort: "low", format: { type: "json_schema", schema: INTERP_SCHEMA } },
            system: interpSystem,
            messages: [{ role: "user", content }],
          }),
        });
        const apiJson = await res.json();
        await meterAi(apiJson);
        usageTotal = addUsage(usageTotal, usageOf(apiJson));
        if (!res.ok || apiJson.stop_reason === "refusal") { markPending(); continue; }
        const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
        const parsed = JSON.parse(textBlock?.text || "{}");
        const arr: any[] = Array.isArray(parsed.interpretations) ? parsed.interpretations : [];
        const byIdx = new Map(arr.map((o) => [Number(o.index), o]));
        batch.forEach((c, j) => {
          const o = byIdx.get(j + 1) || {};
          const text = String(o.interpretation_text ?? "").slice(0, 4000);
          results.push({
            clause_id: c.id,
            interpretation_text: text,
            compliance_status: ["compliant", "deviation", "not_applicable", "pending"].includes(String(o.compliance_status)) ? o.compliance_status : "pending",
            rationale: String(o.rationale ?? "").slice(0, 2000),
            ai_generated: !!text,
          });
        });
      } catch { markPending(); }
    }

    // Insert interpretations (skip duplicates)
    const toInsert = results.map((r) => ({
      clause_id: r.clause_id,
      document_version_id: documentVersionId,
      interpretation_text: r.interpretation_text,
      compliance_status: r.compliance_status,
      rationale: r.rationale,
      ai_generated: r.ai_generated,
    }));

    // Insert new interpretations, ignoring any that already exist for the same
    // (clause, document version) pair — the table has a unique constraint on it.
    const { data: inserted, error: insertErr } = await tdb("as_operates_interpretations")
      .upsert(toInsert, { onConflict: "clause_id,document_version_id", ignoreDuplicates: true }).select("id");
    if (insertErr && insertErr.code !== "23505") {
      return json({ error: `Insert error: ${insertErr.message}` }, 500);
    }

    return json({ ok: true, generated: (inserted ?? []).length, total: clauseIds.length, usage: usageTotal });
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
      if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
      if (!ANTHROPIC_API_KEY) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY." }, 400);
      const clauseId = String(body.clauseId ?? "").trim();
      if (!isUuid(clauseId)) return json({ error: "Valid clauseId required" }, 400);

      const clauseSelect = "id,standard_version_id,clause_ref,clause_title,clause_text,standard_version:standard_version_id(standard:standard_id(code,title))";
      const { data: src } = await tdb("standard_clauses").select(clauseSelect).eq("id", clauseId).maybeSingle();
      if (!src) return json({ error: "Clause not found" }, 404);
      const stdOf = (c: any) => c?.standard_version?.standard?.code || c?.standard_version?.standard?.title || "Standard";

      // Candidate clauses from OTHER standard versions (cross-standard matching).
      const { data: cands } = await tdb("standard_clauses").select(clauseSelect)
        .neq("standard_version_id", (src as any).standard_version_id).limit(150);
      let candidates = cands ?? [];
      // Drop candidates already linked to this clause (either direction).
      const [la, lb] = await Promise.all([
        tdb("requirement_links").select("to_type,to_id").eq("from_type", "clause").eq("from_id", clauseId),
        tdb("requirement_links").select("from_type,from_id").eq("to_type", "clause").eq("to_id", clauseId),
      ]);
      const linked = new Set<string>();
      for (const r of la.data ?? []) if (r.to_type === "clause") linked.add(r.to_id);
      for (const r of lb.data ?? []) if (r.from_type === "clause") linked.add(r.from_id);
      candidates = candidates.filter((c) => !linked.has(c.id));
      if (!candidates.length) return json({ ok: true, created: 0, candidates: 0 });

      const SUG_SCHEMA = {
        type: "object", additionalProperties: false,
        properties: { matches: { type: "array", items: {
          type: "object", additionalProperties: false,
          properties: {
            id: { type: "string" },
            linkType: { type: "string", enum: ["same_clause", "similar_intent", "implements", "defines_terms_for"] },
            confidence: { type: "number" }, rationale: { type: "string" },
          },
          required: ["id", "linkType", "confidence", "rationale"],
        } } },
        required: ["matches"],
      };
      const trunc = (t: unknown, n: number) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, n);
      const system = `You find cross-reference relationships between EU product-compliance clauses for Rushroom AB (LED system-furniture).
Given a SOURCE clause and CANDIDATE clauses from other standards, return only candidates that express the SAME or a CLOSELY RELATED requirement.
linkType: same_clause = identical normative requirement; similar_intent = same obligation worded differently; implements = candidate is a means of satisfying the source; defines_terms_for = candidate defines terms the source relies on.
Be conservative — prefer precision over recall; only match when a compliance reviewer would agree. Give confidence 0.0–1.0 and a one-line rationale. Echo the candidate id exactly; never invent ids.`;
      const candText = candidates.map((c) => `- id=${c.id} [${stdOf(c)} ${c.clause_ref}] ${trunc(c.clause_title, 80)} :: ${trunc(c.clause_text, 240)}`).join("\n");
      const user = `SOURCE clause [${stdOf(src)} ${(src as any).clause_ref}] ${trunc((src as any).clause_title, 120)}:\n${trunc((src as any).clause_text, 800)}\n\nCANDIDATES (${candidates.length}):\n${candText}`;

      let apiJson: any;
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: SCAN_MODEL, max_tokens: 4000, thinking: { type: "adaptive" }, output_config: { effort: "medium", format: { type: "json_schema", schema: SUG_SCHEMA } }, system, messages: [{ role: "user", content: [{ type: "text", text: user }] }] }),
        });
        apiJson = await res.json();
        await meterAi(apiJson);
        if (!res.ok) return json({ error: `Claude API error (${res.status}): ${apiJson?.error?.message || "unknown"}` }, 502);
      } catch (e) { return json({ error: `Claude API request failed: ${(e as Error).message}` }, 502); }
      if (apiJson.stop_reason === "refusal") return json({ error: "The AI declined to suggest links." }, 502);
      const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
      let parsed: any; try { parsed = JSON.parse(textBlock?.text || "{}"); } catch { return json({ error: "The AI response could not be parsed." }, 502); }

      const validIds = new Set(candidates.map((c) => c.id));
      const allowed = ["same_clause", "similar_intent", "implements", "defines_terms_for"];
      const now = new Date().toISOString();
      const rows = (parsed.matches || [])
        .filter((m: any) => validIds.has(String(m.id)) && allowed.includes(m.linkType) && Number(m.confidence) >= 0.5)
        .slice(0, 25)
        .map((m: any) => ({
          from_type: "clause", from_id: clauseId, to_type: "clause", to_id: String(m.id),
          link_type: m.linkType, source: "ai_assisted", status: "proposed",
          confidence: Math.max(0, Math.min(1, Number(m.confidence) || 0.5)),
          rationale: String(m.rationale || "").slice(0, 500), created_by: "AI", created_at: now, updated_at: now,
        }));
      let created = 0;
      if (rows.length) {
        const { data: ins, error } = await tdb("requirement_links")
          .upsert(rows, { onConflict: "from_type,from_id,to_type,to_id,link_type", ignoreDuplicates: true }).select("id");
        if (error) return json({ error: error.message }, 500);
        created = (ins ?? []).length;
      }
      return json({ ok: true, created, candidates: candidates.length, usage: usageOf(apiJson) });
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

  // On-demand AI inference of implicit relations (never runs automatically — cost control).
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
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    if (!ANTHROPIC_API_KEY) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY." }, 400);
    const scope = body.scope === "product" ? "product" : body.scope === "company" ? "company" : "all";
    const passportId = String(body.passportId ?? "").trim() || null;
    const language = body.language === "sv" ? "sv" : "en";
    if (scope === "product" && !passportId) return json({ error: "passportId required for product scope" }, 400);
    const graph = await buildComplianceGraph(tdb, scope, passportId);
    let subject = "Rushroom AB";
    if (scope === "product" && passportId) { const { data: pp } = await tdb("product_passports").select("product_name").eq("id", passportId).maybeSingle(); subject = pp?.product_name || "the product"; }
    // Compact the graph for the model.
    const byId = new Map(graph.nodes.map((n: any) => [n.id, n]));
    const nodeLines = graph.nodes.map((n: any) => `- ${n.shortName} (${n.celex}): ${n.title || ""} — coverage ${n.complianceCoverage == null ? "not assessed" : n.complianceCoverage + "%"}${n.applicabilityStatus ? `, ${n.applicabilityStatus}` : ""}`).join("\n");
    const edgeLines = graph.edges.map((e: any) => `- ${byId.get(e.source)?.shortName || "?"} ${e.relationType} ${byId.get(e.target)?.shortName || "?"}${e.clauses?.source ? ` (${e.clauses.source})` : ""}${e.sourceKind === "ai_inferred" ? ` [AI, conf ${e.confidence}]` : ""}`).join("\n");
    const gapLines = graph.gaps.map((g: any) => `- ${g.celex}${g.shortName ? ` (${g.shortName})` : ""}: ${g.reason}`).join("\n");
    const system = `You are a compliance writer for Rushroom AB. Write a clear, factual compliance narrative in ${language === "sv" ? "Swedish" : "English"} describing how the EU directives below relate to each other and to ${subject}. Reference directives by short name and the parenthetical legal number (e.g. LVD (2014/35/EU)). Explain the primary applicable directive(s), how they require or supplement one another, coverage status, and note any gaps. Keep it 2–4 short paragraphs, suitable for inclusion in a Declaration of Conformity or product passport. Do not invent relationships beyond those listed; treat AI-inferred edges as tentative.`;
    const user = `Scope: ${scope}\nSubject: ${subject}\n\nDIRECTIVES:\n${nodeLines || "(none)"}\n\nRELATIONSHIPS:\n${edgeLines || "(none captured)"}\n\nGAPS:\n${gapLines || "(none)"}`;
    let apiJson: any;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: SCAN_MODEL, max_tokens: 2000, thinking: { type: "adaptive" }, output_config: { effort: "medium" }, system, messages: [{ role: "user", content: [{ type: "text", text: user }] }] }),
      });
      apiJson = await res.json();
      await meterAi(apiJson);
      if (!res.ok) return json({ error: `Claude API error (${res.status}): ${apiJson?.error?.message || "unknown"}` }, 502);
    } catch (e) { return json({ error: `Claude API request failed: ${(e as Error).message}` }, 502); }
    if (apiJson.stop_reason === "refusal") return json({ error: "The AI declined to generate the narrative." }, 502);
    const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
    const narrative = String(textBlock?.text || "").trim();
    const assessed = graph.nodes.filter((n: any) => n.complianceCoverage != null);
    const avg = assessed.length ? Math.round(assessed.reduce((s: number, n: any) => s + n.complianceCoverage, 0) / assessed.length) : null;
    return json({
      ok: true, narrative, generatedAt: new Date().toISOString(),
      coverageSummary: { directiveCount: graph.nodes.length, relationCount: graph.edges.length, gapCount: graph.gaps.length, assessedCount: assessed.length, averageCoverage: avg },
      usage: usageOf(apiJson),
    });
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
    if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
    if (!ANTHROPIC_API_KEY) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY." }, 400);
    let items: any[];
    try { items = await loadClassificationItems(tdb); }
    catch (e) { if (/does not exist|schema cache|Could not find|column/i.test((e as Error).message)) return json({ error: "The classification columns aren't set up yet — run the classification SQL first." }, 500); return json({ error: (e as Error).message }, 500); }
    const wanted = Array.isArray(body.ids) && body.ids.length ? new Set(body.ids.map((x: unknown) => String(x))) : null;
    const unclassified = items.filter((it) => (!it.lifecycle_phase || !it.scope) && (!wanted || wanted.has(it.id))).slice(0, 40);
    if (!unclassified.length) return json({ ok: true, proposals: [] });
    const SUGGEST_SCHEMA = {
      type: "object", additionalProperties: false,
      properties: {
        proposals: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              id: { type: "string" }, entityType: { type: "string", enum: ["document", "interpretation"] },
              lifecyclePhase: { type: "string", enum: LIFECYCLE_PHASES }, scope: { type: "string", enum: COMPLIANCE_SCOPES },
              confidence: { type: "number" }, rationale: { type: "string" },
            },
            required: ["id", "entityType", "lifecyclePhase", "scope", "confidence", "rationale"],
          },
        },
      },
      required: ["proposals"],
    };
    const system = `You classify EU compliance items for Rushroom AB into a 2×2 matrix.
LIFECYCLE PHASE:
- pre_launch: one-time requirements that must be cleared BEFORE market launch (testing, technical file, EPREL registration, DoC, CE marking, initial risk assessment).
- monitoring: ongoing obligations AFTER launch (market surveillance, recurring/annual reporting, re-verification, standard-change re-assessment).
SCOPE:
- company: organisation-level obligations (producer registrations, WEEE/packaging producer responsibility, insurance, management-system, records retention).
- product_services: per-product/service obligations (CE conformity, Declaration of Conformity, product standards compliance, Digital Product Passport, labelling, installation/service requirements).
For each item, choose exactly one lifecyclePhase and one scope, with a confidence 0.0–1.0 and a one-line rationale. Base it on the title, category and any clause text. Echo back the item id and entityType exactly.`;
    const list = unclassified.map((it) => `- id=${it.id} type=${it.entityType} | ${it.label}${it.sublabel ? ` (${it.sublabel})` : ""}`).join("\n");
    let apiJson: any;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: SCAN_MODEL, max_tokens: 4000, thinking: { type: "adaptive" }, output_config: { effort: "low", format: { type: "json_schema", schema: SUGGEST_SCHEMA } }, system, messages: [{ role: "user", content: [{ type: "text", text: `Classify these ${unclassified.length} unclassified items:\n${list}` }] }] }),
      });
      apiJson = await res.json();
      await meterAi(apiJson);
      if (!res.ok) return json({ error: `Claude API error (${res.status}): ${apiJson?.error?.message || "unknown"}` }, 502);
    } catch (e) { return json({ error: `Claude API request failed: ${(e as Error).message}` }, 502); }
    if (apiJson.stop_reason === "refusal") return json({ error: "The AI declined to classify these items." }, 502);
    const textBlock = (apiJson.content || []).find((b: any) => b.type === "text");
    let parsed: any; try { parsed = JSON.parse(textBlock?.text || "{}"); } catch { return json({ error: "The AI response could not be parsed." }, 502); }
    const validIds = new Map(unclassified.map((it) => [it.id, it]));
    const proposals = (parsed.proposals || []).filter((p: any) => validIds.has(String(p.id)) && LIFECYCLE_PHASES.includes(p.lifecyclePhase) && COMPLIANCE_SCOPES.includes(p.scope)).map((p: any) => {
      const it = validIds.get(String(p.id));
      return { id: String(p.id), entityType: it.entityType, label: it.label, sublabel: it.sublabel, lifecyclePhase: p.lifecyclePhase, scope: p.scope, confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0.5)), rationale: String(p.rationale || "").slice(0, 300) };
    });
    return json({ ok: true, proposals, usage: usageOf(apiJson) });
  }

  // ==========================================================================
  // PROP-013 · Product Information System — Vertical Integration Engine
  // ==========================================================================

  // --- BOM: list all components + identify roots (no active parent edge) -----
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
      .select("id, part_number, oem_number, name, type, lifecycle_status, replacement_note, flag_reason")
      .order("name");
    if (search) q = (q as any).or(`name.ilike.*${search}*,part_number.ilike.*${search}*`);
    const { data: comps, error: ce } = await q;
    if (ce) return json({ error: ce.message }, 400);
    const components = (comps || []).map((c: any) => ({ ...c, has_children: parentIdSet.has(c.id) }));
    return json({ components, root_ids: components.map((c: any) => c.id) });
  }

  // --- BOM: add a new component (creates the node + first version "A") ------
  if (action === "addComponent") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { name, type, oem_number, description, notes } = body;
    let { part_number } = body;
    if (!name || !type) return json({ error: "name and type are required" }, 400);
    const validTypes = ["part", "raw_material", "sub_assembly", "finished_good", "spare_part", "product_family"];
    if (!validTypes.includes(type)) return json({ error: "Invalid type" }, 400);
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

  // --- BOM: update component metadata (never part_number or type) -----------
  if (action === "updateComponent") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { component_id, name, description, notes, oem_number, part_number, type: newType } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: session.uid || null };
    if (name        !== undefined) patch.name        = String(name);
    if (description !== undefined) patch.description = description;
    if (notes       !== undefined) patch.notes       = notes;
    if (oem_number  !== undefined) patch.oem_number  = oem_number ? String(oem_number).trim() : null;
    if (part_number !== undefined && String(part_number).trim()) patch.part_number = String(part_number).trim();
    if (newType     !== undefined) {
      const validTypes = ["part", "raw_material", "sub_assembly", "finished_good", "spare_part", "product_family"];
      if (!validTypes.includes(newType)) return json({ error: "Invalid type" }, 400);
      patch.type = newType;
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
      .select("organization_id, part_number, oem_number, name, description, notes, type, lifecycle_status, replacement_note, flag_reason")
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
    if (error) return json({ error: error.message }, 400);

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
    return json({ version_id: ver.id, revision });
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
    // (1) bom_component_history — field-level snapshots (created + updated only;
    //     version_bumped/document_linked rows exist but are superseded by canonical sources)
    // (2) bom_component_versions — all revisions ever, including pre-audit-trail ones
    // (3) component_documents — all linked docs ever, including pre-audit-trail ones
    const [histRes, verRes, docRes] = await Promise.all([
      tdb("bom_component_history")
        .select("id, changed_at, changed_by, change_type, part_number, oem_number, name, description, type, lifecycle_status, notes")
        .eq("component_id", component_id)
        .in("change_type", ["created", "updated"]),
      tdb("bom_component_versions")
        .select("id, revision, spec_summary, created_at, created_by")
        .eq("component_id", component_id),
      tdb("component_documents")
        .select("id, category, label, created_at, uploaded_by")
        .eq("component_id", component_id),
    ]);
    if (histRes.error) return json({ error: histRes.error.message }, 400);

    const versionEntries = (verRes.data || []).map((v: any) => ({
      id: v.id,
      changed_at: v.created_at,
      changed_by: v.created_by,
      change_type: "version_bumped",
      notes: `Revision ${v.revision}${v.spec_summary ? ": " + v.spec_summary : ""}`,
    }));

    const docEntries = (docRes.data || []).map((d: any) => ({
      id: d.id,
      changed_at: d.created_at,
      changed_by: d.uploaded_by,
      change_type: "document_linked",
      notes: `Document linked: ${d.label || d.category} (${d.category})`,
    }));

    const changelog = [...(histRes.data || []), ...versionEntries, ...docEntries]
      .sort((a: any, b: any) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime());

    return json({ changelog });
  }

  // --- BOM: get tree (BFS, max_depth levels deep) ---------------------------
  if (action === "getBom") {
    const { root_component_id, max_depth, scenario_id } = body;
    if (!root_component_id) return json({ error: "root_component_id required" }, 400);
    const depthLimit = Math.min(Number(max_depth) || 4, 10);
    // BFS: fetch children level by level
    const nodeMap: Record<string, any> = {};
    const edges: Array<{ parent_id: string; child_id: string; quantity: number; reference_designator: string | null }> = [];
    const queue: Array<{ id: string; depth: number }> = [{ id: root_component_id, depth: 0 }];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const batch = queue.splice(0, queue.length);
      const ids = batch.map((n) => n.id).filter((id) => !visited.has(id));
      if (!ids.length) break;
      ids.forEach((id) => visited.add(id));
      const { data: comps } = await tdb("bom_components").select("id, part_number, name, type, unit_of_measure, lifecycle_status, notes").in("id", ids);
      (comps || []).forEach((c: any) => { nodeMap[c.id] = c; });
      const currentDepth = batch[0].depth;
      if (currentDepth >= depthLimit) continue;
      const { data: childEdges } = await db.from("bom_edges").select("id, parent_id, child_id, quantity, reference_designator, variant_condition")
        .in("parent_id", ids).is("effective_to", null).eq("organization_id", organizationId);
      (childEdges || []).forEach((e: any) => {
        edges.push(e);
        if (!visited.has(e.child_id)) queue.push({ id: e.child_id, depth: currentDepth + 1 });
      });
    }
    return json({ nodes: Object.values(nodeMap), edges });
  }

  // --- BOM: add an edge (child under parent) --------------------------------
  if (action === "addBomEdge") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { parent_id, child_id, quantity, reference_designator, effective_from, variant_condition } = body;
    if (!parent_id || !child_id || !quantity) return json({ error: "parent_id, child_id and quantity required" }, 400);
    try {
      const { data, error } = await tdb("bom_edges").insert({
        parent_id, child_id, quantity: Number(quantity),
        reference_designator: reference_designator || null,
        effective_from: effective_from || new Date().toISOString().slice(0, 10),
        variant_condition: variant_condition ?? null,
      }).select("id").maybeSingle();
      if (error) return json({ error: error.message }, 400);
      return json({ id: data.id });
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (msg.includes("BOM cycle detected")) return json({ error: msg }, 400);
      return json({ error: msg }, 400);
    }
  }

  // --- BOM: close an edge (soft-delete, sets effective_to = today) ----------
  if (action === "removeBomEdge") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    const { parent_id, child_id } = body;
    if (!parent_id || !child_id) return json({ error: "parent_id and child_id required" }, 400);
    const { error } = await db.from("bom_edges").update({ effective_to: new Date().toISOString().slice(0, 10) })
      .eq("parent_id", parent_id).eq("child_id", child_id).is("effective_to", null)
      .eq("organization_id", organizationId);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
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
    // Attach document names via document_versions → documents
    const dvIds = (docs || []).map((d: any) => d.document_version_id);
    let nameMap: Record<string, string> = {};
    if (dvIds.length) {
      const { data: dvs } = await tdb("document_versions").select("id, document_id").in("id", dvIds);
      const docIds = (dvs || []).map((v: any) => v.document_id);
      if (docIds.length) {
        const { data: docRows } = await tdb("documents").select("id, name").in("id", docIds);
        const docNameMap: Record<string, string> = {};
        (docRows || []).forEach((d: any) => { docNameMap[d.id] = d.name; });
        (dvs || []).forEach((v: any) => { nameMap[v.id] = docNameMap[v.document_id] || ""; });
      }
    }
    const result = (docs || []).map((d: any) => ({ ...d, document_name: nameMap[d.document_version_id] || "" }));
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
    const images = await Promise.all((data ?? []).map(async (img: any) => {
      const { data: signed } = await db.storage.from(DOC_BUCKET).createSignedUrl(img.storage_path, 60 * 60);
      return { ...img, url: signed?.signedUrl ?? "" };
    }));
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
      "preferred_supplier_name","supplier_part_number","lead_time_days","moq",
      "country_of_origin","hs_code",
      "incoming_inspection_method","inspection_sample_size","critical_to_quality","has_cpk_requirement",
      "weee_category","battery_regulation_applicable","conflict_minerals_free",
      "recycled_content_pct","carbon_footprint_kgco2e","carbon_footprint_source",
      "end_of_life_instruction","repair_spare_part_available","custom_specs",
    ];
    const payload: Record<string, any> = { component_id, organization_id: orgId, updated_at: new Date().toISOString() };
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
    const thumbnails = await Promise.all(firsts.map(async (row) => {
      const { data: signed } = await db.storage.from(DOC_BUCKET).createSignedUrl(row.storage_path, 60 * 60);
      return { component_id: row.component_id, url: signed?.signedUrl ?? "" };
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

  return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err: any) {
    console.error(`[portal-api] unhandled error in action=${action}:`, err);
    return json({ error: err?.message ?? "Internal server error" }, 500);
  }
});
