/* Rushroom AB — Engineering & Compliance Platform API client
 * Thin wrapper around the Supabase `portal-api` Edge Function. The function does
 * all auth and authorization; this just sends JSON and stores the session token.
 * Exposes window.PortalAPI. Loaded before app.js.
 */
(() => {
  "use strict";
  const CFG = (window.PORTAL_CONFIG && window.PORTAL_CONFIG.api) || {};
  const URL_ = (CFG.functionUrl || "").replace(/\/+$/, "");

  // A single active session: { token, role, admin, name, urole }. Stored under
  // one key so an individual email/password login and the shared-role login
  // share the same plumbing (role is decided by the server, not the page).
  const SESSION_KEY = "rushroom_portal_session";
  const IMP_BACKUP_KEY = "rushroom_portal_session_backup"; // operator session, parked during impersonation
  const LEGACY_KEYS = ["rushroom_portal_token_rushroom", "rushroom_portal_token_supplier"];
  function saveSession(s) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* ignore */ } }
  function getSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) return JSON.parse(raw);
      // Migrate a legacy per-role token if one is still around.
      for (const k of LEGACY_KEYS) {
        const t = sessionStorage.getItem(k);
        if (t) { const role = k.endsWith("supplier") ? "supplier" : "rushroom"; return { token: t, role, admin: role === "rushroom" }; }
      }
    } catch { /* ignore */ }
    return null;
  }

  // --- action routing (2026-09-16) -----------------------------------------
  // portal-api was split so the hot path stops carrying jszip/pdf-lib and the
  // CELLAR client. The contract is unchanged — same action names, same bodies,
  // same token; only the URL differs, chosen here by action name.
  //
  // Sibling URLs are derived from the configured portal-api URL, so there is
  // still exactly one thing to configure in assets/config.js.
  const HEAVY_ROUTES = {
    "portal-ai": new Set([
      "suggestStandardMetadata", "suggestComponentMetadata", "suggestFileMetadata",
      "suggestDocumentVersion", "runDeviationScan", "extractStandardClauses",
      "generateInterpretations", "suggestRequirementLinks", "generateComplianceNarrative",
      "suggestClassifications", "extractComponentSpecs", "extractDrawingMeta",
    ]),
    "portal-cellar": new Set([
      "addDirective", "syncDirectiveRelations", "inferDirectiveRelations",
    ]),
  };

  function urlFor(action) {
    for (const [fn, actions] of Object.entries(HEAVY_ROUTES)) {
      if (actions.has(action)) return URL_.replace(/\/[^/]+$/, "/" + fn);
    }
    return URL_;
  }

  async function call(payload) {
    const res = await fetch(urlFor(payload && payload.action), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) { const e = new Error(data.error || `Request failed (HTTP ${res.status})`); e.code = data.code; e.status = res.status; throw e; }
    return data;
  }

  const API = {
    configured: () => !!URL_,

    // The role argument is ignored (kept for call-site compatibility) — the
    // active session's token is returned regardless.
    getToken: () => { const s = getSession(); return s ? s.token : ""; },
    clearToken: () => { try { sessionStorage.removeItem(SESSION_KEY); LEGACY_KEYS.forEach((k) => sessionStorage.removeItem(k)); } catch { /* ignore */ } },
    session: () => getSession(),
    isAdmin: () => { const s = getSession(); return !!(s && s.admin); },

    // Shared-role login (bootstrap admin + legacy supplier password).
    async login(role, password) {
      const r = await call({ action: "login", role, password });
      saveSession({ token: r.token, role: r.role, admin: r.role === "rushroom", name: role });
      return r.token;
    },
    // Individual email + password login. Returns the full session. When the
    // account has MFA, the first call throws with code "mfa_required"; pass
    // mfaCode on a second call. The raw error carries .code for the UI.
    async loginUser(email, password, mfaCode) {
      let r;
      try { r = await call({ action: "loginUser", email, password, mfaCode }); }
      catch (e) { throw e; }
      saveSession({ token: r.token, role: r.role, admin: !!r.admin, name: r.name, urole: r.urole, email });
      return r;
    },

    data: (token) => call({ action: "data", token }),

    // --- user accounts (public register/verify/reset + admin management) ---
    registerUser: (fields) => call({ action: "registerUser", ...fields }),
    verifyUser: (verifyToken) => call({ action: "verifyUser", token: verifyToken }),
    requestPasswordReset: (email) => call({ action: "requestPasswordReset", email }),
    setPassword: (resetToken, password) => call({ action: "setPassword", token: resetToken, password }),
    adminListUsers: (token) => call({ action: "adminListUsers", token }),
    adminUpdateUser: (token, id, fields) => call({ action: "adminUpdateUser", token, id, ...fields }),
    adminDeleteUser: (token, id) => call({ action: "adminDeleteUser", token, id }),
    adminUserVerifyLink: (token, id) => call({ action: "adminUserVerifyLink", token, id }),
    adminUserResetLink: (token, id) => call({ action: "adminUserResetLink", token, id }),
    adminSendTestEmail: (token, to) => call({ action: "adminSendTestEmail", token, to }),

    // --- Stage 3: organization management, admin console, impersonation ---
    orgContext: (token) => call({ action: "orgContext", token }),
    orgMembers: (token) => call({ action: "orgMembers", token }),
    orgInviteMember: (token, email, role) => call({ action: "orgInviteMember", token, email, role }),
    orgUpdateMember: (token, membershipId, fields) => call({ action: "orgUpdateMember", token, membershipId, ...fields }),
    orgSettings: (token) => call({ action: "orgSettings", token }),
    orgUpdateSettings: (token, fields) => call({ action: "orgUpdateSettings", token, ...fields }),
    platformTenants: (token) => call({ action: "platformTenants", token }),
    platformSetTenantStatus: (token, organizationId, status) => call({ action: "platformSetTenantStatus", token, organizationId, status }),
    platformImpersonate: (token, organizationId, reason) => call({ action: "platformImpersonate", token, organizationId, reason }),
    platformAudit: (token, limit) => call({ action: "platformAudit", token, limit }),
    // Stage 5: MFA (TOTP) self-service
    mfaStatus: (token) => call({ action: "mfaStatus", token }),
    mfaEnrollStart: (token) => call({ action: "mfaEnrollStart", token }),
    mfaEnrollVerify: (token, code) => call({ action: "mfaEnrollVerify", token, code }),
    mfaDisable: (token, code) => call({ action: "mfaDisable", token, code }),
    orgBilling: (token) => call({ action: "orgBilling", token }),
    platformSetTenantPlan: (token, organizationId, plan) => call({ action: "platformSetTenantPlan", token, organizationId, plan }),
    // Swap the active session for an impersonation token, parking the operator's
    // own session so it can be restored on exit.
    startImpersonation(r, orgName) {
      try { const cur = sessionStorage.getItem(SESSION_KEY); if (cur) sessionStorage.setItem(IMP_BACKUP_KEY, cur); } catch { /* ignore */ }
      saveSession({ token: r.token, role: "rushroom", admin: false, name: "support", imp: true, impOrg: orgName || "", expiresAt: r.expires_at || "" });
    },
    endImpersonation() {
      try { const raw = sessionStorage.getItem(IMP_BACKUP_KEY); if (raw) { sessionStorage.setItem(SESSION_KEY, raw); sessionStorage.removeItem(IMP_BACKUP_KEY); } } catch { /* ignore */ }
    },
    impersonation() { const s = getSession(); return (s && s.imp) ? s : null; },

    setStatus: (token, step, status, supplierLabel) =>
      call({ action: "setStatus", token, step, status, supplierLabel }),

    // Rushroom-only action-plan management. `fields` carries the step's action
    // text as `actionText` (not `action`, which is the request router field).
    addStep: (token, fields) => call({ action: "addStep", token, ...fields }),
    updateStep: (token, step, fields) => call({ action: "updateStep", token, step, ...fields }),
    deleteStep: (token, step) => call({ action: "deleteStep", token, step }),

    listUploads: (token) => call({ action: "uploads", token }),
    deleteUpload: (token, id) => call({ action: "deleteUpload", token, id }),

    /* Upload a File: ask the function for a signed URL, PUT the bytes straight
     * to storage, then record the metadata. Returns the stored path. */
    async uploadFile(token, file, { step, note, supplierLabel } = {}) {
      const { signedUrl, path } = await call({ action: "uploadUrl", token, fileName: file.name });
      const put = await fetch(signedUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await call({ action: "recordUpload", token, step, note, supplierLabel, path, fileName: file.name });
      return path;
    },

    deleteDocument: (token, id) => call({ action: "deleteDocument", token, id }),
    updateDocument: (token, id, fields) => call({ action: "updateDocument", token, id, ...fields }),

    // Standards & Regulations register (with version history)
    standards: (token) => call({ action: "standards", token }),
    addStandard: (token, fields) => call({ action: "addStandard", token, ...fields }),
    updateStandard: (token, id, fields) => call({ action: "updateStandard", token, id, ...fields }),
    deleteStandard: (token, id) => call({ action: "deleteStandard", token, id }),
    deleteStandardVersion: (token, id) => call({ action: "deleteStandardVersion", token, id }),
    // AI deviation monitoring (Rushroom only). The scan can take a while — the
    // browser fetch has no timeout, so it waits for Claude to finish.
    deviations: (token) => call({ action: "deviations", token }),
    runDeviationScan: (token) => call({ action: "runDeviationScan", token }),

    async uploadStandardVersion(token, file, { standardId, version, effectiveDate, notes } = {}) {
      const { signedUrl, path } = await call({ action: "stdUploadUrl", token, fileName: file.name });
      const put = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await call({ action: "addStandardVersion", token, standardId, version, effectiveDate, notes, path, fileName: file.name });
      return path;
    },

    // Upload the standard file WITHOUT registering it yet (for AI auto-fill + human approval).
    async uploadStandardFile(token, file) {
      const { signedUrl, path } = await call({ action: "stdUploadUrl", token, fileName: file.name });
      const put = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      return { path, fileName: file.name };
    },
    // AI reads an already-uploaded standard file and proposes its catalogue fields.
    suggestStandardMetadata: (token, { path, fileName }) => call({ action: "suggestStandardMetadata", token, path, fileName }),
    // Record a version row for an already-uploaded file (used after AI auto-fill approval).
    addStandardVersionRecord: (token, { standardId, version, effectiveDate, notes, path, fileName }) =>
      call({ action: "addStandardVersion", token, standardId, version, effectiveDate, notes, path, fileName }),

    /* ---- Generic upload + AI auto-fill (used by every file-upload flow) ----
     * uploadAnyFile sends the bytes to the right bucket WITHOUT registering the
     * file; suggestFileMetadata then has the AI read it and propose fields; a
     * flow-specific record* call registers it after the human approves. */
    // Ask for a signed upload URL for the right bucket (the PUT is done by the
    // caller, e.g. via XHR so upload progress can be shown).
    signedUploadUrl: (token, fileName, bucket = "documents") =>
      call({ action: bucket === "standards" ? "stdUploadUrl" : bucket === "uploads" ? "uploadUrl" : "docUploadUrl", token, fileName }),
    async uploadAnyFile(token, file, bucket = "documents") {
      const uploadAction = bucket === "standards" ? "stdUploadUrl" : bucket === "uploads" ? "uploadUrl" : "docUploadUrl";
      const { signedUrl, path } = await call({ action: uploadAction, token, fileName: file.name });
      const put = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      return { path, fileName: file.name };
    },
    suggestFileMetadata: (token, { path, fileName, bucket = "documents" }) =>
      call({ action: "suggestFileMetadata", token, path, fileName, bucket }),
    // Register an already-uploaded library document (after AI auto-fill approval).
    addDocumentRecord: (token, { category, name, audience, kind, path, fileName, version, lifecyclePhase, scope }) =>
      call({ action: "addDocument", token, category, name, audience, kind, storagePath: path, fileName, version, lifecyclePhase, scope }),
    // Add a version row to an existing document for an already-uploaded file.
    addDocumentVersionRecord: (token, { documentId, version, notes, path, fileName, sourceStandardVersionIds }) =>
      call({ action: "addDocumentVersion", token, documentId, version, notes, path, fileName, sourceStandardVersionIds }),
    // Add a NEW version from a binary blob (e.g. a Google Doc exported as .docx).
    async addDocumentVersionFile(token, blob, { documentId, version, notes, fileName, sourceStandardVersionIds } = {}) {
      const { signedUrl, path } = await call({ action: "docUploadUrl", token, fileName: fileName || "version.docx" });
      const put = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await call({ action: "addDocumentVersion", token, documentId, version, notes, sourceStandardVersionIds, path, fileName });
      return path;
    },
    // Register an already-uploaded supplier/technical-file upload.
    recordUploadRecord: (token, { step, note, supplierLabel, path, fileName }) =>
      call({ action: "recordUpload", token, step, note, supplierLabel, path, fileName }),

    /* Add a library document: upload the file to the documents bucket, then
     * register it in the documents table. Rushroom only (enforced server-side). */
    async uploadDocument(token, file, { category, name, audience, kind } = {}) {
      const { signedUrl, path } = await call({ action: "docUploadUrl", token, fileName: file.name });
      const put = await fetch(signedUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await call({ action: "addDocument", token, category, name: name || file.name, audience, kind, storagePath: path, fileName: file.name });
      return path;
    },

    // Upload a new version of an existing document (previous versions kept).
    async uploadDocumentVersion(token, file, { documentId, version, notes } = {}) {
      const { signedUrl, path } = await call({ action: "docUploadUrl", token, fileName: file.name });
      const put = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await call({ action: "addDocumentVersion", token, documentId, version, notes, path, fileName: file.name });
      return path;
    },

    createOperationalDocumentFromTemplate(token, { templateDocumentId, name, version, notes } = {}) {
      return call({ action: "createOperationalDocumentFromTemplate", token, templateDocumentId, name, version, notes });
    },

    suggestDocumentVersion(token, { documentId, templateDocumentId, notes, preferredVersion, sourceStandardIds = [] } = {}) {
      return call({ action: "suggestDocumentVersion", token, documentId, templateDocumentId, notes, preferredVersion, sourceStandardIds });
    },

    async publishDocumentDraft(token, { documentId, newDocumentName, templateDocumentId, category, audience, version, notes, draftText, fileName, approvedChanges, sourceStandardVersionIds } = {}) {
      const { signedUrl, path } = await call({ action: "docUploadUrl", token, fileName: fileName || "draft.md" });
      const body = new Blob([draftText || ""], { type: "text/markdown;charset=utf-8" });
      const put = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": "text/markdown;charset=utf-8" }, body });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await call({ action: "publishDocumentDraft", token, documentId, newDocumentName, templateDocumentId, category, audience, version, notes, draftText, fileName, approvedChanges, sourceStandardVersionIds, path });
      return path;
    },

    // Publish a binary file (e.g. a Google Doc exported as .docx/.pdf) as the
    // document version, preserving its formatting.
    async publishDocumentFile(token, blob, { documentId, newDocumentName, templateDocumentId, category, audience, version, notes, fileName, approvedChanges, sourceStandardVersionIds } = {}) {
      const { signedUrl, path } = await call({ action: "docUploadUrl", token, fileName: fileName || "document.docx" });
      const put = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      await call({ action: "publishDocumentDraft", token, documentId, newDocumentName, templateDocumentId, category, audience, version, notes, draftText: "(published from Google Docs)", fileName, approvedChanges, sourceStandardVersionIds, path });
      return path;
    },

    // ---- LEVEL 2: Structured Clause-Level Interpretations (DPP & ESPR) ----
    extractStandardClauses: (token, { standardVersionId, maxClauses }) =>
      call({ action: "extractStandardClauses", token, standardVersionId, maxClauses }),
    generateInterpretations: (token, { documentVersionId, clauseIds }) =>
      call({ action: "generateInterpretations", token, documentVersionId, clauseIds }),
    saveInterpretation: (token, id, fields) =>
      call({ action: "saveInterpretation", token, id, ...fields }),
    getInterpretations: (token, documentVersionId) =>
      call({ action: "getInterpretations", token, documentVersionId }),
    getClausesForStandard: (token, standardVersionId) =>
      call({ action: "getClausesForStandard", token, standardVersionId }),
    complianceMatrix: (token, { documentVersionIds, standardVersionIds }) =>
      call({ action: "complianceMatrix", token, documentVersionIds, standardVersionIds }),
    exportProductPassport: (token, { passportId, format }) =>
      call({ action: "exportProductPassport", token, passportId, format }),
    // ---- Requirement links: cross-document clause & text linking ----
    listRequirementLinks: (token, { entityType, entityId }) =>
      call({ action: "listRequirementLinks", token, entityType, entityId }),
    listRequirementLinksForClauses: (token, clauseIds) =>
      call({ action: "listRequirementLinksForClauses", token, clauseIds }),
    listRequirementLinksForDocumentVersions: (token, documentVersionIds) =>
      call({ action: "listRequirementLinksForDocumentVersions", token, documentVersionIds }),
    suggestRequirementLinks: (token, clauseId) =>
      call({ action: "suggestRequirementLinks", token, clauseId }),
    listRequirementLinksQueue: (token, statuses) =>
      call({ action: "listRequirementLinksQueue", token, statuses }),
    detectClauseCitations: (token, standardVersionId) =>
      call({ action: "detectClauseCitations", token, standardVersionId }),
    listDocumentStatements: (token, documentVersionId) =>
      call({ action: "listDocumentStatements", token, documentVersionId }),
    saveDocumentStatements: (token, documentVersionId, statements) =>
      call({ action: "saveDocumentStatements", token, documentVersionId, statements }),
    listRequirementLinksForStatements: (token, statementIds) =>
      call({ action: "listRequirementLinksForStatements", token, statementIds }),
    createRequirementLink: (token, fields) =>
      call({ action: "createRequirementLink", token, ...fields }),
    setRequirementLinkStatus: (token, id, status, reviewedBy) =>
      call({ action: "setRequirementLinkStatus", token, id, status, reviewedBy }),
    deleteRequirementLink: (token, id) =>
      call({ action: "deleteRequirementLink", token, id }),
    // Product passport management
    listProductPassports: (token) => call({ action: "listProductPassports", token }),
    getProductPassport: (token, id) => call({ action: "getProductPassport", token, id }),
    createProductPassport: (token, fields) => call({ action: "createProductPassport", token, ...fields }),
    updateProductPassport: (token, id, fields) => call({ action: "updateProductPassport", token, id, ...fields }),
    deleteProductPassport: (token, id) => call({ action: "deleteProductPassport", token, id }),
    linkPassportInterpretation: (token, { passportId, interpretationId, relevanceNote }) =>
      call({ action: "linkPassportInterpretation", token, passportId, interpretationId, relevanceNote }),
    unlinkPassportInterpretation: (token, { passportId, interpretationId }) =>
      call({ action: "unlinkPassportInterpretation", token, passportId, interpretationId }),

    // ---- EU Directive relationship analyser (CELLAR) ----
    listDirectives: (token, passportId) => call({ action: "listDirectives", token, passportId }),
    addDirective: (token, { celexNumber, shortName, appliesToCompany }) =>
      call({ action: "addDirective", token, celexNumber, shortName, appliesToCompany }),
    syncDirectiveRelations: (token, directiveId) => call({ action: "syncDirectiveRelations", token, directiveId }),
    inferDirectiveRelations: (token, directiveId) => call({ action: "inferDirectiveRelations", token, directiveId }),
    analyseComplianceGraph: (token, { scope, passportId } = {}) => call({ action: "analyseComplianceGraph", token, scope, passportId }),
    setDirectiveApplicability: (token, { passportId, directiveId, status, rationale }) =>
      call({ action: "setDirectiveApplicability", token, passportId, directiveId, status, rationale }),
    getComplianceCoverage: (token, directiveId) => call({ action: "getComplianceCoverage", token, directiveId }),
    generateComplianceNarrative: (token, { scope, passportId, language } = {}) =>
      call({ action: "generateComplianceNarrative", token, scope, passportId, language }),

    // ---- Compliance Status classification (lifecycle phase × scope) ----
    getComplianceMatrix: (token) => call({ action: "getComplianceMatrix", token }),
    listClassificationItems: (token, { lifecyclePhase, scope, unclassified, entityType } = {}) =>
      call({ action: "listClassificationItems", token, lifecyclePhase, scope, unclassified, entityType }),
    setClassification: (token, { entityType, ids, id, lifecyclePhase, scope, aiGenerated } = {}) =>
      call({ action: "setClassification", token, entityType, ids, id, lifecyclePhase, scope, aiGenerated }),
    suggestClassifications: (token, ids) => call({ action: "suggestClassifications", token, ids }),

    // Assemblies (sub_assembly) as { id, name }, sorted by name. Includes
    // inactive ones, matching what the Assemblies tab shows; pass
    // { include_inactive: false } to narrow it.
    listAssemblies: (token, opts = {}) => call({ action: "listAssemblies", token, ...opts }),
    listPlannerMappings: (token, opts = {}) => call({ action: "listPlannerMappings", token, ...opts }),
    savePlannerMapping: (token, fields) => call({ action: "savePlannerMapping", token, ...fields }),
    deactivatePlannerMapping: (token, mappingId) => call({ action: "deactivatePlannerMapping", token, mapping_id: mappingId }),

    // Generic escape hatch for actions not yet named on this object.
    post: (token, action, body = {}) => call({ action, token, ...body }),
  };

  window.PortalAPI = API;
})();
