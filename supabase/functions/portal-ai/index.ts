// ============================================================================
// portal-ai — Anthropic-backed actions and the document parsing they need.
//
// Split out of portal-api (2026-09-16) so the hot path — login, CRUD, tenant
// and account operations — no longer imports jszip or pdf-lib, and no longer
// pays for parsing machinery it never uses.
//
// Contract is unchanged: same action names, same request/response shapes, same
// status codes, same session token, same tenant isolation. Only the URL differs,
// and the browser routes on action name (see assets/api.js).
//
// Deploy with JWT verification OFF (auth is ours):
//   supabase functions deploy portal-ai --no-verify-jwt
// ============================================================================
import * as JSZipNS from "https://esm.sh/jszip@3.10.1";
const JSZip: any = (JSZipNS as any).default ?? JSZipNS;
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

import { serve, json, type Ctx } from "../_shared/handler.ts";
import { db, enc, ANTHROPIC_API_KEY, SCAN_MODEL, BUCKET, DOC_BUCKET, STD_BUCKET } from "../_shared/env.ts";
import { eq } from "../_shared/auth.ts";
import { usagePeriod, buildComplianceGraph, loadClassificationItems } from "../_shared/domain.ts";

const TEXT_CAP = 40000; // per-file char cap fed to the model

// ---- token accounting (identical to portal-api) ----------------------------
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

// ---- document parsing (jszip / pdf-lib live here, not in portal-api) -------
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
    const IMG_TYPES: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    };
    if (IMG_TYPES[ext]) {
      return { type: "image", source: { type: "base64", media_type: IMG_TYPES[ext], data: toBase64(bytes) } };
    }
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

// ---- actions ---------------------------------------------------------------
serve({
  fn: "portal-ai",
  handle: async (ctx: Ctx): Promise<Response | null> => {
    const { body, action, session, role, organizationId, tdb, timer } = ctx;

    // Per-request AI usage ledger, mirroring portal-api's meterAi.
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

  if (action === "extractComponentSpecs") {
    if (role !== "rushroom") return json({ error: "Not authorised" }, 403);
    if (!ANTHROPIC_API_KEY) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY in the function secrets." }, 400);
    const { component_id, image_id, storage_path, file_name, ephemeral } = body;
    if (!component_id) return json({ error: "component_id required" }, 400);

    const { data: comp } = await tdb("bom_components")
      .select("id, name, part_number, oem_number").eq("id", component_id).maybeSingle();
    if (!comp) return json({ error: "Component not found" }, 404);

    // Resolve the source, org-scoped in every case.
    let path = "", fname = "";
    if (image_id) {
      const { data: img } = await tdb("component_images")
        .select("storage_path, file_name").eq("id", image_id).maybeSingle();
      if (!img) return json({ error: "Image not found" }, 404);
      path = img.storage_path; fname = img.file_name || "image.png";
    } else if (storage_path) {
      path = String(storage_path); fname = String(file_name || "document");
    } else {
      return json({ error: "image_id or storage_path required" }, 400);
    }

    // Numeric and boolean targets are coerced server-side; everything else is text.
    const NUM = new Set(["weight_g","length_mm","width_mm","height_mm","lead_time_days","moq",
      "inspection_sample_size","recycled_content_pct","carbon_footprint_kgco2e"]);
    const BOOL = new Set(["has_cpk_requirement","battery_regulation_applicable",
      "conflict_minerals_free","repair_spare_part_available"]);
    const TEXT = new Set(["manufacturer_name","manufacturer_part_number","base_material","surface_treatment",
      "color_specification","flame_retardant_class","preferred_supplier_name","supplier_part_number",
      "country_of_origin","hs_code","incoming_inspection_method","critical_to_quality",
      "weee_category","carbon_footprint_source","end_of_life_instruction"]);
    const FIELD_KEYS = [...NUM, ...BOOL, ...TEXT];

    const system = `You are reading a component datasheet, technical drawing, catalogue page or screenshot and extracting values for a product data record.

The component on file is: "${comp.name}" (part number ${comp.part_number}${comp.oem_number ? ", OEM " + comp.oem_number : ""}).

Rules that matter more than coverage:
- Extract ONLY what the document actually states. Never infer, never complete from general knowledge of similar parts. An omitted field is correct; a guessed one is a defect.
- Give every value exactly as printed in \`as_printed\`, including its unit ("50 mm", "1.2 kg", "±0.2"), and the converted value in \`value\`.
- UNITS ARE CRITICAL. weight_g is GRAMS: a sheet quoting 1.2 kg must yield value "1200". Lengths are MILLIMETRES. If a unit is ambiguous or missing, use confidence "low".
- \`evidence\` must be a short verbatim quote from the document showing where the value came from.
- confidence: "high" only when the document states the value unambiguously for THIS component; "medium" when it is stated but the wording is loose; "low" when a unit is missing, the layout is ambiguous, or the value might belong to a different variant.
- If the document covers several parts (a catalogue page, a family table), set confident_part_match=false and matched_part to what you believe it describes. Do not guess a row.
- incoming_inspection_method must be exactly one of: none, visual, dimensional, functional, chemical, destructive, certificate_only.
- country_of_origin is an ISO 3166-1 alpha-2 code.
- Anything the document states that does not fit one of the field keys goes in \`unmapped\` with a suggested snake_case key. This is how missing schema fields get discovered, so do not discard it.

Valid field keys: ${FIELD_KEYS.join(", ")}`;

    const EXTRACT_SCHEMA = {
      type: "object",
      properties: {
        matched_part: { type: "string" },
        confident_part_match: { type: "boolean" },
        summary: { type: "string" },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string", enum: FIELD_KEYS },
              value: { type: "string" },
              as_printed: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              evidence: { type: "string" },
            },
            required: ["key", "value", "as_printed", "confidence", "evidence"],
            additionalProperties: false,
          },
        },
        unmapped: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "string" },
              suggested_key: { type: "string" },
            },
            required: ["label", "value", "suggested_key"],
            additionalProperties: false,
          },
        },
      },
      required: ["matched_part", "confident_part_match", "summary", "fields", "unmapped"],
      additionalProperties: false,
    };

    // Read it into memory first, then delete an ephemeral source immediately —
    // the bytes are already in the request payload, so nothing is lost and the
    // file never reaches the component's image gallery or version history.
    const sourceBlock = await fileBlock(DOC_BUCKET, path, fname);
    if (ephemeral) {
      try { await db.storage.from(DOC_BUCKET).remove([path]); } catch { /* best effort */ }
    }

    let apiJson: any;
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: SCAN_MODEL,
          max_tokens: 4000,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium", format: { type: "json_schema", schema: EXTRACT_SCHEMA } },
          system,
          messages: [{ role: "user", content: [
            { type: "text", text: "Extract the product data fields stated in this document." },
            sourceBlock,
          ] }],
        }),
      });
      apiJson = await res.json();
      if (!res.ok) return json({ error: apiJson?.error?.message || "AI request failed" }, 400);
    } catch (e: any) {
      return json({ error: `AI request failed: ${e?.message || e}` }, 400);
    }
    await meterAi(apiJson);

    let parsed: any;
    try {
      const txt = (apiJson.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      parsed = JSON.parse(txt);
    } catch {
      return json({ error: "AI returned an unreadable response." }, 400);
    }

    // Coerce to column types here rather than in the browser, so what the user
    // approves is exactly what will be written.
    const fields = (parsed.fields || []).flatMap((f: any) => {
      const key = String(f.key || "");
      if (!NUM.has(key) && !BOOL.has(key) && !TEXT.has(key)) return [];
      let value: any = String(f.value ?? "").trim();
      if (!value) return [];
      if (NUM.has(key)) {
        const n = Number(value.replace(",", "."));
        if (!Number.isFinite(n)) return [];
        value = n;
      } else if (BOOL.has(key)) {
        value = /^(true|yes|y|1)$/i.test(value);
      }
      return [{ key, value, as_printed: String(f.as_printed ?? ""), confidence: String(f.confidence ?? "low"), evidence: String(f.evidence ?? "") }];
    });

    return json({
      fields,
      unmapped: parsed.unmapped || [],
      matched_part: parsed.matched_part || "",
      confident_part_match: !!parsed.confident_part_match,
      summary: parsed.summary || "",
    });
  }

    return null; // unknown action -> 400 from the shared handler
  },
});
