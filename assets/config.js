/*
 * Rushroom AB — Engineering & Compliance Platform configuration
 * ============================================================================
 * This is the only file you normally edit. See README.md for full instructions.
 *
 * SAFE TO COMMIT, but remember: a public repo exposes everything below.
 * Real protection of each document comes from Google Drive sharing, not this file.
 */
window.PORTAL_CONFIG = {
  org: "Rushroom AB",
  product: "LED system-furniture",

  /* ---- Access gate -------------------------------------------------------
   * SHA-256 hex hash of the shared password (NOT the password itself).
   * Default below corresponds to:  Rushroom-Compliance-2026
   * To change: run  printf '%s' 'NEW-PASSWORD' | shasum -a 256
   * or in the browser console on the live site:  portalHash('NEW-PASSWORD')
   */
  passwordHash: "b0eb72b1c6231cbc7bc759a84148de428650f650878f2fdd7c6ecbacdaf1dd4f",

  /* ---- Live editing backend (Supabase) ----------------------------------
   * Set api.functionUrl to your deployed `portal-api` Edge Function URL to turn
   * on in-portal LOGIN + EDITING + UPLOADS. See docs/SUPABASE_SETUP.md.
   *   • When set: Rushroom logs in (full edit) and suppliers log in (edit the
   *     status of their steps + upload files). Role passwords live as Supabase
   *     secrets, NOT in this file.
   *   • When empty (""): the portal runs in read-only mode — the shared-password
   *     gate above + live Google-Sheet status below. Nothing breaks.
   */
  api: {
    functionUrl: "https://iwoqujpwhsoywudjtsnj.supabase.co/functions/v1/portal-api",
  },

  /* ---- Google Docs editing (in-browser OAuth) ---------------------------
   * Lets Rushroom edit an AI draft in Google Docs before publishing. Because
   * personal Google accounts can't use a service account for this, the user
   * signs in with their own Google account and the Doc is created in their
   * Drive. Create an OAuth 2.0 Client ID (type: Web application) in Google
   * Cloud, add this site's origin as an authorised JavaScript origin, and
   * paste the Client ID below. Leave "" to hide the Google Docs buttons.
   */
  google: {
    oauthClientId: "362898915614-hee1mbekq75m27jvhen0jofsht7prufk.apps.googleusercontent.com",
  },

  /* ---- Live status source ------------------------------------------------
   * Published CSV URL of the action-plan Google Sheet
   * ("00_ACTION_PLAN_Rushroom_Compliance_Step_by_Step").
   * In the Sheet:  File → Share → Publish to web → (whole sheet) → CSV → Publish,
   * then paste the generated link here. Leave "" to use the bundled snapshot below.
   *
   * The parser reads the action-plan's own columns (case-insensitive, any order):
   *   Step | Phase | ACTION — what Rushroom must do | Who does it |
   *   Where / how | Output / evidence | Folder | Priority | Status
   * It also accepts the simpler aliases: action, owner, evidence, priority, status.
   *   - Status:   anything containing "done" → complete; "active"/"in progress" →
   *               in progress; "blocked" → blocked; otherwise "open".
   *   - Priority: a "BLOCKER" or "gate" priority marks a pre-sale blocker.
   *   - Audience (optional column): comma-separated, e.g. "internal, supplier".
   *               If absent, supplier relevance is inferred from the step text.
   *
   * The URL below is the action-plan sheet's CSV endpoint. It activates as soon
   * as the Sheet is shared "Anyone with the link → Viewer" (Share button, top
   * right of the Sheet). Until then the portal shows the bundled snapshot and
   * explains how to enable live status — nothing breaks.
   * Most reliable alternative if the gviz endpoint is ever blocked:
   *   File → Share → Publish to web → (whole sheet) → CSV → Publish,
   * then paste that ".../pub?output=csv" link here instead.
   */
  statusSheetCsvUrl: "https://docs.google.com/spreadsheets/d/1xR6h5x-fV0R91cFiNB9UqHhGtVvg2VnW28brz8zrF4A/gviz/tq?tqx=out:csv",

  /* Direct link to the action-plan sheet (shown as "open the plan" in the UI). */
  statusSheetViewUrl: "https://docs.google.com/spreadsheets/d/1xR6h5x-fV0R91cFiNB9UqHhGtVvg2VnW28brz8zrF4A/edit",

  /* ---- Supplier declaration upload --------------------------------------
   * GitHub Pages can't receive uploads itself, so point this at a form/endpoint
   * that can: a Google Form, a Formspree form (https://formspree.io), Typeform,
   * a Drive upload-request link, etc. Suppliers see an "Upload declaration"
   * panel that links here. Leave "" to hide the panel.
   */
  supplierUploadUrl: "",

  /* ---- Document library --------------------------------------------------
   * Links to the source files in Google Drive. `audience` controls who sees a
   * document: include "supplier" to surface it on supplier.html. Access to each
   * file is still governed by Google Drive sharing.
   */
  documents: [
    { category: "Declarations & CE", name: "EU Declaration of Conformity (template)", url: "https://docs.google.com/document/d/1x5Llp1rEulCz_-7LtMBHT8wb6uVGpGhFeB03Q-63CnU/edit", audience: ["internal", "reviewer"] },
    { category: "Declarations & CE", name: "CE marking specification", url: "https://docs.google.com/document/d/1ywY9J9Fgfl4_ExBdFA9gQwt3AkqABw8xz48KVbYaH0Y/edit", audience: ["internal", "supplier", "reviewer"] },
    { category: "Declarations & CE", name: "PPWR Declaration of Conformity (reusable packaging)", url: "https://docs.google.com/document/d/1Px8WdhGTlwEWB0mkYJc_0bTBbZp-PRTniUdXiTBAnzE/edit", audience: ["internal"] },

    { category: "Technical file", name: "Technical File index (template)", url: "https://docs.google.com/document/d/14vnhdLBOU_3gZToVHy_soRX1HqZvmgvmXAadoSGO6TM/edit", audience: ["internal", "reviewer"] },
    { category: "Technical file", name: "Compliance Audit File — README / map", url: "https://docs.google.com/document/d/1e_Hvhyp50ST9l4NOG0A07Qy6b6xlDKJ2nLfV4GAzunc/edit", audience: ["internal"] },
    { category: "Technical file", name: "Compliance Documentation Register", url: "https://docs.google.com/spreadsheets/d/1W2BLk_gWH0QVZaN-zNdXnJ31ODC3trK0myIQNdJQAzk/edit", audience: ["internal", "reviewer"] },

    { category: "Test reports", name: "LVD / safety test report (IOS-PRF0032, AA-86878-25)", url: "https://drive.google.com/file/d/1pXOt6Ol4MwmjvblUSY03vSpv9naXZ3GW/view", audience: ["internal", "reviewer"] },

    { category: "Suppliers", name: "Supplier Declaration of Compliance (form)", url: "https://docs.google.com/document/d/1MNxJ_uByom-XcrnvrzbjyKhYbwEeD7gHmB0Kne9es4U/edit", audience: ["internal", "supplier"] },
    { category: "Suppliers", name: "Supplier Compliance Spec — LED strip & cabling/connectors", url: "https://docs.google.com/spreadsheets/d/1Xz67mHsJ31HWQFXYLrn_xqkhhtxXZETun9f6jTk59JA/edit", audience: ["internal", "supplier"] },
    { category: "Suppliers", name: "Product Change Notification commitment (annex)", url: "https://docs.google.com/document/d/1eqPeMt8QpsYHEpW9bclvyHA6veaHqKmi0PwGcHetHpU/edit", audience: ["internal", "supplier"] },

    { category: "Materials & packaging", name: "Packaging compliance checklist (reusable transport packaging)", url: "https://docs.google.com/spreadsheets/d/1rrWd76T6SvcHF985jWgDrT8tzPa2pZ54uXFoI9fLVP4/edit", audience: ["internal"] },

    { category: "Records & monitoring", name: "Records Retention Log", url: "https://docs.google.com/spreadsheets/d/1mKgXaBHHghEF3l-qR7tdDC5PnS5wpUEAkAWFqJb9kcM/edit", audience: ["internal"] },
    { category: "Records & monitoring", name: "Regulatory Watch — 2026-06", url: "https://docs.google.com/document/d/1MO246WfK9Fnc7Es7-WZwAWwVvJrWkECXpEIJmVnIuS8/edit", audience: ["internal", "reviewer"] },
  ],

  /* ---- Bundled status snapshot ------------------------------------------
   * Used only when statusSheetCsvUrl is empty, so the dashboard is never blank.
   * This is a snapshot of the action-plan sheet and mirrors its columns exactly.
   * Connect the live Sheet (above) to keep it current without redeploying.
   */
  sampleSteps: [
    { step: 1, phase: "1. Classify & decide", action: "Confirm economic-operator role: Rushroom = MANUFACTURER of finished product + IMPORTER of the China LED strip (carries full CE responsibility on the assembled product)", owner: "Rushroom", where: "Internal note", evidence: "Documented role statement", folder: "00 / README", priority: "Foundation", status: "Done (documented)" },
    { step: 2, phase: "1. Classify & decide", action: "Confirm whether the controller is WIRELESS (BT/Zigbee/RF). If yes, Radio Equipment Directive 2014/53/EU replaces the LVD+EMC route", owner: "Rushroom + SE controller partner", where: "Ask partner", evidence: "Written confirmation", folder: "01b", priority: "Foundation", status: "Open" },
    { step: 3, phase: "1. Classify & decide", action: "Confirm whether the LED strip is PERMANENTLY FIXED (glued/potted). If yes, the whole fixture is assessed for ecodesign", owner: "Rushroom", where: "Design review", evidence: "Decision recorded", folder: "2", priority: "Foundation", status: "Open" },
    { step: 4, phase: "1. Classify & decide", action: "Confirm whether any BATTERY ships (controller/remote). If yes, adds battery producer responsibility", owner: "Rushroom", where: "Design review", evidence: "Decision recorded", folder: "4", priority: "Foundation", status: "Open" },
    { step: 5, phase: "1. Classify & decide", action: "Confirm WEEE EEE category (likely Large or Small equipment) and B2C vs B2B sales channel", owner: "Rushroom + El-Kretsen", where: "Call El-Kretsen / Naturvardsverket", evidence: "Category + channel decided", folder: "4", priority: "Foundation", status: "Open" },
    { step: 6, phase: "1. Classify & decide", action: "Confirm whether the LED-to-controller cabling counts as permanently incorporated in the building (CPR / EN 50575 applicability)", owner: "Rushroom", where: "Assess install method", evidence: "Decision recorded", folder: "01e", priority: "Foundation", status: "Open" },
    { step: 7, phase: "2. Suppliers", action: "SEND each supplier the package: Supplier Compliance Spec (standards + harmonised standards list), Declaration of Compliance form, and PCN Commitment", owner: "Rushroom → suppliers (LED strip CN, controller SE, PSU, cable, connectors)", where: "Email", evidence: "Sent, with acknowledgement", folder: "01e", priority: "High", status: "Open" },
    { step: 8, phase: "2. Suppliers", action: "COLLECT back: signed supplier declarations, test reports, datasheets, RoHS + REACH/SVHC declarations, and the PSU's own CE DoC", owner: "Suppliers → Rushroom", where: "Email / portal", evidence: "Completed forms + attachments filed", folder: "01e", priority: "High", status: "Open" },
    { step: 9, phase: "2. Suppliers", action: "VERIFY supplier evidence against the spec; chase any gaps before designing the finished product", owner: "Rushroom", where: "Review vs spec sheet", evidence: "Gap log cleared", folder: "01e", priority: "High", status: "Open" },
    { step: 10, phase: "3. Testing & evidence", action: "ARRANGE LVD safety testing of the ASSEMBLED product at an accredited lab (EN 60598, EN 61347, EN 62471)", owner: "Rushroom → accredited lab", where: "Book test", evidence: "Safety test report", folder: "01d", priority: "High", status: "Open" },
    { step: 11, phase: "3. Testing & evidence", action: "ARRANGE EMC testing of the assembled product (EN 55015, EN 61547, EN 61000-3-2). If RED applies, use EN 300 328 / EN 301 489 instead", owner: "Rushroom → accredited lab", where: "Book test", evidence: "EMC test report(s)", folder: "01d", priority: "High", status: "Open" },
    { step: 12, phase: "3. Testing & evidence", action: "COMPILE RoHS technical documentation (EN IEC 63000) from supplier data", owner: "Rushroom", where: "Assemble file", evidence: "RoHS documentation", folder: "3", priority: "High", status: "Open" },
    { step: 13, phase: "3. Testing & evidence", action: "CONDUCT risk assessment of the finished product (electrical safety + fire/thermal of 24V high-current wiring)", owner: "Rushroom", where: "Use risk method", evidence: "Risk assessment record", folder: "01f", priority: "High", status: "Open" },
    { step: 14, phase: "3. Testing & evidence", action: "COMPILE the Technical File using the template index (pulls in all of the above)", owner: "Rushroom", where: "Fill template", evidence: "Complete technical file", folder: "01b", priority: "High — gate", status: "Open" },
    { step: 15, phase: "4. Energy / EPREL", action: "OBTAIN/verify ecodesign data: efficacy, flicker (PstLM<=1, SVM<=0.4), lumen maintenance, power factor", owner: "Rushroom (+ lab/supplier)", where: "Test/collect data", evidence: "Ecodesign data set", folder: "2", priority: "High", status: "Open" },
    { step: 16, phase: "4. Energy / EPREL", action: "REGISTER the light source in the EPREL database and produce the energy label — BEFORE first sale", owner: "Rushroom", where: "eprel.ec.europa.eu", evidence: "EPREL registration + label", folder: "2", priority: "BLOCKER", status: "Open" },
    { step: 17, phase: "5. Registrations", action: "WEEE: JOIN a PRO (e.g. El-Kretsen) AND register in the EE-registret with Naturvardsverket; set up annual report (by 31 Mar)", owner: "Rushroom", where: "El-Kretsen + eeb.naturvardsverket.se", evidence: "PRO agreement + registration confirmation", folder: "4", priority: "BLOCKER", status: "Open" },
    { step: 18, phase: "5. Registrations", action: "PACKAGING: document the reuse system + NOTIFY Naturvardsverket; register as packaging producer + annual report", owner: "Rushroom", where: "Naturvardsverket", evidence: "Reuse-system notification + registration", folder: "4", priority: "High — by 2026-08-12", status: "Open" },
    { step: 19, phase: "5. Registrations", action: "BATTERY register — only if step 4 = yes", owner: "Rushroom", where: "Naturvardsverket", evidence: "Battery registration", folder: "4", priority: "Conditional", status: "Open" },
    { step: 20, phase: "6. Chemicals", action: "COLLECT REACH/SVHC declarations; if any article > 0.1% w/w SVHC, submit a SCIP notification to ECHA", owner: "Rushroom", where: "ECHA SCIP", evidence: "SVHC declarations (+ SCIP ref if needed)", folder: "3", priority: "Medium", status: "Open" },
    { step: 21, phase: "7. Self-declaration", action: "DRAW UP and SIGN the EU Declaration of Conformity for the finished product, listing all applicable directives + standards (Rushroom does this itself)", owner: "Rushroom", where: "Fill DoC template", evidence: "Signed EU DoC", folder: "01a", priority: "BLOCKER", status: "Open" },
    { step: 22, phase: "7. Self-declaration", action: "AFFIX the CE marking to the product per the marking spec (Rushroom does this itself, after steps 14 + 21)", owner: "Rushroom", where: "Per CE spec", evidence: "CE mark on product", folder: "01c", priority: "BLOCKER", status: "Open" },
    { step: 23, phase: "7. Self-declaration", action: "DESIGN the product label combining: CE mark, manufacturer ID + address, type/batch no., ratings, WEEE crossed-out-bin (EN 50419), energy/EPREL", owner: "Rushroom", where: "Artwork", evidence: "Approved label artwork", folder: "01c", priority: "High", status: "Open" },
    { step: 24, phase: "8. Product info & install", action: "FINALISE the Swedish user & safety instructions and ship them with every product", owner: "Rushroom", where: "Finalise template", evidence: "Final SV manual", folder: "6", priority: "High", status: "Open" },
    { step: 25, phase: "8. Product info & install", action: "FINALISE the installer SOP and TRAIN installers; lock the plug-connection-only rule (no fixed 230V work)", owner: "Rushroom", where: "Finalise + train", evidence: "Final SOP + training record", folder: "6", priority: "High", status: "Open" },
    { step: 26, phase: "9. Liability & records", action: "OBTAIN product liability insurance before first sale", owner: "Rushroom → insurer", where: "Arrange policy", evidence: "Insurance policy", folder: "7", priority: "High", status: "Open" },
    { step: 27, phase: "9. Liability & records", action: "POPULATE the Records Retention Log; keep DoC + technical file 10 years", owner: "Rushroom", where: "Update log", evidence: "Maintained log", folder: "8", priority: "Ongoing", status: "Open" },
    { step: 28, phase: "10. Ongoing", action: "MONITOR standards/regulations monthly (automated watch agent already running)", owner: "Rushroom / agent", where: "09 folder", evidence: "Monthly watch reports", folder: "9", priority: "Ongoing", status: "Active" },
    { step: 29, phase: "10. Ongoing", action: "RE-ISSUE the DoC / update the technical file whenever a supplier sends a Product Change Notification or a standard changes", owner: "Rushroom", where: "On change", evidence: "Updated DoC/file", folder: "1", priority: "Ongoing", status: "Open" },
    { step: 30, phase: "10. Ongoing", action: "SUBMIT annual WEEE + packaging reports to Naturvardsverket by 31 March each year", owner: "Rushroom", where: "Naturvardsverket", evidence: "Filed reports", folder: "4", priority: "Annual", status: "Open" },
  ],
};
