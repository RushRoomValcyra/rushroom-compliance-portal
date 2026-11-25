// Supplier portal — docs/SUPPLIER_PORTAL.md, the backend half.
//
// Static tests over the migration, _shared/tenant.ts and portal-api/index.ts:
// the three tables are tenant-scoped (§6.7); every new action exists behind
// its role gate (§3); the one file gate answers 404 on every failed check and
// writes supplier_file_events (§6.1, §6.5); loginUser refuses a supplier user
// without a company and login refuses the shared supplier password (§2, §6.4);
// the impersonation token is role supplier, imp: true, 30 minutes (§6.6); the
// supplier tier is deny-by-default in portal-api and portal-ai (§6), the
// assignment is re-checked for liveness on every request, a Download is signed
// as an attachment and the viewer's Open inline (§6.1, §6.5). The
// network tests call the deployed function without a session and expect 401;
// the deployed copy may predate the actions, so "unknown action" is tolerated
// (the cad-test-agent convention). No credentials, no writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { call } from "./config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const src = read("supabase/functions/portal-api/index.ts");
const sql = read("supabase/migrations/0065_suppliers.sql");
const tenant = read("supabase/functions/_shared/tenant.ts");

const TABLES = ["suppliers", "supplier_components", "supplier_file_events"];
const SUPPLIER_ACTIONS = ["supplierHome", "supplierFileUrl"];
const ADMIN_ACTIONS = ["listSuppliers", "saveSupplier", "setSupplierParts", "getSupplier", "addSupplierUser", "removeSupplierUser", "adminViewAsSupplier"];
// Existing supplier-reachable actions the contract scopes to the assignment.
const SCOPED_ACTIONS = ["listDrawings", "getDrawing", "drawingFileUrl", "listSupplierComponents", "getBom", "getSupplierBomRoots", "getComponentDocuments"];

/** The body of one `if (action === "name")` block: from its head to the next
 *  action head at the same indentation (the cad-drawings-tab pattern). */
function actionBlock(name) {
  const head = `  if (action === "${name}")`;
  const start = src.indexOf(head);
  assert.notEqual(start, -1, `portal-api does not dispatch ${name}`);
  const rest = src.slice(start + head.length);
  const next = rest.search(/\n  if \(action === "/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The body of a top-level `async function name(` up to the next top-level function. */
function functionBody(name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `portal-api has no ${name}`);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n(?:async )?function |\n\/\*\*|\nDeno\.serve|\n\/\/ ---/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

// ---------------------------------------------------------------------------
// §6.7 tenant: the three tables, scoped and RLS deny-all
// ---------------------------------------------------------------------------
test("the three supplier tables are in TENANT_TABLES", () => {
  const block = tenant.match(/export const TENANT_TABLES = new Set\(\[([\s\S]*?)\]\);/)[1].replace(/\/\/.*$/gm, "");
  for (const t of TABLES) assert.ok(new RegExp(`"${t}"`).test(block), `${t} missing from TENANT_TABLES`);
});

test("migration 0065 creates the three tables with organization_id, RLS and the contract's columns", () => {
  for (const t of TABLES) {
    const m = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(([\\s\\S]*?)\\n\\);`));
    assert.ok(m, `0065 does not create ${t}`);
    assert.match(m[1], /organization_id\s+UUID NOT NULL REFERENCES organizations\(id\)/, `${t} lacks organization_id`);
    assert.match(sql, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`), `${t} is not RLS-enabled`);
  }
  const sc = sql.match(/CREATE TABLE IF NOT EXISTS supplier_components \(([\s\S]*?)\n\);/)[1];
  assert.match(sc, /drawings\s+BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(sc, /cad\s+BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(sc, /UNIQUE \(organization_id, supplier_id, component_id\)/);
  const ev = sql.match(/CREATE TABLE IF NOT EXISTS supplier_file_events \(([\s\S]*?)\n\);/)[1];
  for (const col of ["supplier_id", "user_id", "kind", "drawing_revision_id", "cad_file_id", "file_name", "at"]) {
    assert.match(ev, new RegExp(`\\b${col}\\b`), `supplier_file_events lacks ${col}`);
  }
  assert.match(sql, /ON supplier_file_events \(organization_id, supplier_id, at DESC\)/);
  // users.supplier_id, SET NULL, indexed.
  assert.match(sql, /ALTER TABLE users ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers\(id\) ON DELETE SET NULL/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_users_supplier ON users \(supplier_id\)/);
  // Re-runnable: nothing without IF NOT EXISTS.
  assert.equal((sql.match(/CREATE TABLE(?! IF NOT EXISTS)/g) || []).length, 0);
  assert.equal((sql.match(/CREATE (?:UNIQUE )?INDEX(?! IF NOT EXISTS)/g) || []).length, 0);
});

// ---------------------------------------------------------------------------
// §3 every action exists behind its role gate
// ---------------------------------------------------------------------------
for (const action of SUPPLIER_ACTIONS) {
  test(`${action} is supplier-only and refuses a session without sid`, () => {
    const block = actionBlock(action);
    assert.match(block, /if \(role !== "supplier"\) return json\(\{ error: "Supplier only" \}, 403\)/);
    assert.ok(block.includes("await supplierScope(tdb, session)"), `${action} does not resolve the assignment`);
    assert.ok(block.includes("if (!scope) return supplierNotLinked()"), `${action} does not 403 without sid`);
  });
}

for (const action of ADMIN_ACTIONS) {
  test(`${action} is gated on isAdmin (platform owner or org admin)`, () => {
    const block = actionBlock(action);
    assert.match(block, /^\s*\{\s*\n\s*if \(!isAdmin\) return json\(\{ error: "Admin only" \}, 403\);/, `${action} must gate first`);
  });
}

test("the admin supplier actions sit after adminUserResetLink, the supplier ones after listSupplierComponents", () => {
  assert.ok(src.indexOf('action === "adminUserResetLink"') < src.indexOf('action === "listSuppliers"'));
  assert.ok(src.indexOf('action === "listSupplierComponents"') < src.indexOf('action === "supplierHome"'));
  assert.ok(src.indexOf('action === "supplierHome"') < src.indexOf('action === "supplierFileUrl"'));
});

test("every admin supplier action reads the supplier through the tenant-scoped client", () => {
  for (const action of ["saveSupplier", "setSupplierParts", "getSupplier", "addSupplierUser", "removeSupplierUser", "adminViewAsSupplier"]) {
    assert.ok(/supplierInOrg\(/.test(actionBlock(action)), `${action} does not resolve the supplier in the caller's org`);
  }
  assert.match(src, /const supplierInOrg = async[\s\S]*?tdb\("suppliers"\)/);
  assert.match(actionBlock("listSuppliers"), /tdb\("suppliers"\)/);
});

// ---------------------------------------------------------------------------
// §6.2 the existing supplier-reachable actions are scoped to the assignment
// ---------------------------------------------------------------------------
for (const action of SCOPED_ACTIONS) {
  test(`${action} resolves the supplier assignment and refuses a supplier session without sid`, () => {
    const block = actionBlock(action);
    assert.ok(block.includes("supplierScope(tdb, session)"), `${action} does not resolve the assignment`);
    assert.ok(block.includes("supplierNotLinked()"), `${action} does not 403 a supplier without sid`);
  });
}

test("supplierDrawingScope takes the assignment's drawing ids and keeps the per-drawing rule", () => {
  const fn = src.slice(src.indexOf("function supplierDrawingScope("), src.indexOf("const supplierMaySeeDrawing"));
  assert.match(fn, /drawingIds\?: string\[\]/);
  assert.match(fn, /\.eq\("is_supplier_visible", true\)\.neq\("drawing_type", "surgery_template"\)/);
  // An empty assignment matches nothing, never everything.
  assert.match(fn, /drawingIds\.length \? q\.in\("id", drawingIds\) : q\.eq\("id", NIL_UUID\)/);
  for (const action of ["listDrawings", "getDrawing"]) {
    assert.ok(actionBlock(action).includes("supplierDrawingScope(q, role, scope?.drawingIds)"), `${action} does not pass the assignment to the choke point`);
  }
});

test("supplierScope builds the drawing set from the assignment, the drawings flag, visibility and type", () => {
  const fn = functionBody("supplierScope");
  assert.match(fn, /tdb\("supplier_components"\)\.select\("component_id, drawings, cad"\)\.eq\("supplier_id", sid\)/);
  assert.match(fn, /partIds\.filter\(\(id\) => parts\.get\(id\)!\.drawings\)/, "the drawings flag must gate the drawing set");
  assert.match(fn, /tdb\("drawing_components"\)[\s\S]*?\.in\("component_id", drawingPartIds\)/);
  assert.match(fn, /tdb\("drawings"\)[\s\S]*?\.in\("owner_component_id", drawingPartIds\)/);
  assert.ok(fn.includes("filter(supplierMaySeeDrawing)"), "is_supplier_visible and surgery_template must be applied");
  assert.match(src, /const supplierMaySeeDrawing = \(d: any\) =>\s*d\.is_supplier_visible !== false && \(d\.drawing_type \|\| "engineering"\) !== "surgery_template"/);
});

test("getBom for a supplier: the root must be assigned and nodes/edges outside the assignment are dropped", () => {
  const block = actionBlock("getBom");
  assert.ok(block.includes('if (scope && !scope.parts.has(String(root_component_id))) return json({ error: "Component not found" }, 404)'));
  assert.ok(block.includes("if (scope && !scope.parts.has(e.child_id)) return;"));
  assert.ok(block.includes("filter((n: any) => !scope || scope.parts.has(n.id))"));
});

test("listSupplierComponents narrows parts and drawings to the assignment for a supplier", () => {
  const block = actionBlock("listSupplierComponents");
  assert.ok(block.includes('compQ.in("id", scope.partIds)'));
  assert.ok(block.includes('drawQ.in("id", scope.drawingIds)'));
  assert.ok(block.includes('compQ.eq("id", NIL_UUID)'), "an empty assignment must list no parts");
});

// ---------------------------------------------------------------------------
// §6.1 / §6.5 the one file gate: 404 on every failed check, one audit row
// ---------------------------------------------------------------------------
test("issueSupplierFile answers 404 on every failed check and never 403", () => {
  const fn = functionBody("issueSupplierFile");
  assert.match(fn, /const notFound = \{ error: "File not found", status: 404 \}/);
  assert.ok(!/403/.test(fn), "the file gate must never answer 403 (no enumeration)");
  const returns = (fn.match(/return notFound;/g) || []).length;
  // id missing · drawing: revision missing, not released, outside the assignment
  // · cad: file missing, not STEP, revision not released, model without part,
  // cad flag off · unknown kind · no storage path · signing failed.
  assert.ok(returns >= 12, `expected the checks to each return notFound, found ${returns}`);
  assert.ok(fn.includes('if (rev.status !== "released") return notFound;'));
  assert.ok(fn.includes("if (!scope.drawingParts.has(rev.drawing_id)) return notFound;"));
  assert.ok(fn.includes('if (String(f.format || "").toLowerCase() !== "step") return notFound;'));
  assert.ok(fn.includes('if ((revs || [])[0]?.status !== "released") return notFound;'));
  assert.ok(fn.includes("if (!scope.parts.get(model.component_id)?.cad) return notFound;"));
});

test("issueSupplierFile writes supplier_file_events before the URL is issued, for 600 seconds", () => {
  const fn = functionBody("issueSupplierFile");
  const audit = fn.indexOf('tdb("supplier_file_events").insert(event)');
  const sign = fn.indexOf("createSignedUrl(storagePath, 600, opts.inline ? undefined : { download: fileName })");
  assert.notEqual(audit, -1, "no supplier_file_events row");
  assert.notEqual(sign, -1, "no 600-second signed URL");
  assert.ok(audit < sign, "the audit row must be written before the URL is issued");
  assert.match(fn, /if \(auditErr\) return \{ error: [^}]*, status: 500 \}/, "a failed audit write must refuse the URL");
  assert.match(fn, /supplier_id: scope\.sid, user_id: session\.uid \?\? null, kind/);
  assert.ok(fn.includes("event.drawing_revision_id = rev.id") && fn.includes("event.cad_file_id = f.id"));
  assert.match(fn, /return \{ url: signed\.signedUrl, file_name: fileName, expires_in: 600 \}/);
});

test("supplierFileUrl and a supplier's drawingFileUrl both go through issueSupplierFile", () => {
  assert.ok(actionBlock("supplierFileUrl").includes("await issueSupplierFile(tdb, session, scope, kind, id, { inline })"));
  const dfu = actionBlock("drawingFileUrl");
  assert.ok(dfu.includes('await issueSupplierFile(tdb, session, scope, "drawing", revision_id, { inline: true })'));
  // The supplier branch returns before the Rushroom path signs anything.
  assert.ok(dfu.indexOf("issueSupplierFile") < dfu.indexOf("createSignedUrl(rev.storage_path"));
});

// ---------------------------------------------------------------------------
// §2 / §6.4 sign-in
// ---------------------------------------------------------------------------
test("loginUser refuses a supplier user without a company and carries sid otherwise", () => {
  const block = actionBlock("loginUser");
  assert.ok(block.includes('if (assigned === "supplier")'));
  assert.ok(block.includes("if (!sid) return supplierNotLinked();"));
  assert.match(src, /const supplierNotLinked = \(\) =>\s*json\(\{ error: "Your account is not linked to a supplier yet\. Contact Rushroom\." \}, 403\)/);
  assert.ok(block.includes("if (!s) return supplierNotLinked();"), "a dangling supplier_id must refuse too");
  assert.ok(block.includes("payload.sid = supplier.id"));
  assert.ok(block.includes("orgId = s.organization_id"), "the supplier's organization decides the tenant");
  assert.match(block, /return json\(\{ token, [^}]*supplier \}\)/, "the answer must carry supplier");
});

test("login answers 403 for role supplier: the shared password no longer issues a session", () => {
  const block = actionBlock("login");
  const refuse = block.indexOf('if (role === "supplier") return json({ error: "Supplier access is by personal account." }, 403);');
  assert.notEqual(refuse, -1);
  assert.ok(refuse < block.indexOf("issueSession("), "the refusal must come before any session is issued");
  // Rushroom's bootstrap login stays.
  assert.ok(block.includes('body.role === "rushroom"'));
});

test("orgContext names the supplier for a supplier session", () => {
  const block = actionBlock("orgContext");
  assert.match(block, /tdb\("suppliers"\)\.select\("id, name"\)\.eq\("id", session\.sid\)/);
  assert.ok(block.includes("supplier,"));
});

// ---------------------------------------------------------------------------
// §6.6 the impersonation token
// ---------------------------------------------------------------------------
test("adminViewAsSupplier issues a 30-minute supplier token with imp, sid, actor and the admin's uid", () => {
  const block = actionBlock("adminViewAsSupplier");
  assert.ok(block.includes("const IMP_TTL = 30 * 60;"));
  assert.match(block, /issueSession\(\{\s*role: "supplier", admin: false, org: organizationId, sid: supplier\.id, imp: true,\s*actor: session\.email \?\? session\.uid \?\? "admin", uid: session\.uid \?\? null/);
  assert.match(block, /\}, IMP_TTL\)/);
  assert.match(block, /return json\(\{ token, supplier: \{ id: supplier\.id, name: supplier\.name \}/);
});

// ---------------------------------------------------------------------------
// §3 shapes the page relies on
// ---------------------------------------------------------------------------
test("supplierHome answers with the contract's shape", () => {
  const block = actionBlock("supplierHome");
  for (const key of ["supplier: { id: supplier.id, name: supplier.name, contact_name: supplier.contact_name, contact_email: supplier.contact_email }",
                     "user: { name:", "parts, documents_count:", "updated_at: newest"]) {
    assert.ok(block.includes(key), `supplierHome lacks ${key}`);
  }
  assert.match(block, /drawings = flags\.drawings \? \(files\.drawingsByPart\.get\(c\.id\) \|\| \[\]\) : \[\]/, "the drawings flag must be honoured");
  assert.match(block, /cad = flags\.cad \? \(files\.cadByPart\.get\(c\.id\) \?\? null\) : null/, "the cad flag must be honoured");
  const files = functionBody("supplierPartFiles");
  for (const key of ["drawing_id: d.id, drawing_number: d.drawing_number, title: d.title", "issue: released.revision", "drawing_revision_id: released.id",
                     "supplier_drawing_number", "cad_model_revision_id: released.id, revision: released.revision", "fusion_version", "sha8", "cad_file_id: step.id"]) {
    assert.ok(files.includes(key), `supplierPartFiles lacks ${key}`);
  }
  assert.ok(files.includes("if (!supplierMaySeeDrawing(d)) continue;"));
  assert.ok(files.includes(".eq(\"format\", \"step\")"), "only the STEP file is offered");
});

test("setSupplierParts replaces the set and writes the part history", () => {
  const block = actionBlock("setSupplierParts");
  assert.ok(block.includes('tdb("supplier_components").insert(toInsert)'));
  assert.ok(block.includes('tdb("supplier_components").delete().in("id", toDelete.map((r) => r.id))'));
  assert.match(block, /writeBomHistory\(tdb, session, r\.component_id, "updated", `Supplier \$\{supplier\.name\} given access \(\$\{flagsText\(r\)\}\)`\)/);
  assert.match(block, /writeBomHistory\(tdb, session, r\.component_id, "updated", `Supplier \$\{supplier\.name\} access removed`\)/);
  assert.ok(block.includes("return json({ ok: true, count: wanted.size"));
});

test("addSupplierUser creates or links a supplier account, refuses other roles with 409, and returns the set-password link", () => {
  const block = actionBlock("addSupplierUser");
  assert.ok(block.includes('if (assigned !== "supplier") return json({ error: "That email belongs to an account with another role." }, 409);'));
  assert.match(block, /requested_role: "supplier", role: "supplier", status: "approved",\s*email_verified: true, supplier_id: supplier\.id/);
  // The set-password link lands a supplier on supplier.html (&to=supplier).
  assert.ok(block.includes('const set_password_url = await resetLinkFor(user.id, "supplier");'));
  assert.ok(block.includes("await sendPasswordEmail(user.email, user.name, set_password_url)"));
  assert.ok(block.includes("return json({ user: stripUser(user), emailed, set_password_url })"));
});

test("removeSupplierUser unlinks and disables, only inside the caller's organization", () => {
  const block = actionBlock("removeSupplierUser");
  assert.ok(block.includes("!(await supplierInOrg(u.supplier_id))"));
  assert.match(block, /update\(\{ supplier_id: null, status: "disabled"/);
});

// ---------------------------------------------------------------------------
// §6 deny by default: the supplier tier reaches an allowlist, nothing else
// ---------------------------------------------------------------------------
const ai = read("supabase/functions/portal-ai/index.ts");
// Every action the supplier page and its Documents/Standards tabs call.
const SUPPLIER_READS = ["orgContext", "supplierHome", "supplierFileUrl", "listDrawings", "getDrawing", "drawingFileUrl",
  "listSupplierComponents", "getSupplierBomRoots", "getBom", "getComponentDocuments",
  "data", "standards", "uploads", "listRequirementLinksForDocumentVersions"];
const SUPPLIER_WRITES = ["setStatus", "uploadUrl", "recordUpload", "docUploadUrl", "addDocument",
  "mfaStatus", "mfaEnrollStart", "mfaEnrollVerify", "mfaDisable"];
// Reads with no role gate of their own: the allowlist is what keeps them from suppliers.
const UNGATED_READS = ["listComponentThumbnails", "listComponentImages", "getComponentMetadata", "listParentCounts",
  "listProductFamilies", "listFamilyMembers", "listComponentFamilies"];
const namesIn = (setSrc) => [...setSrc.replace(/\/\/.*$/gm, "").matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);

test("portal-api: SUPPLIER_ACTIONS is exactly the supplier page's allowlist", () => {
  const m = src.match(/const SUPPLIER_ACTIONS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, "portal-api has no SUPPLIER_ACTIONS set");
  const names = namesIn(m[1]);
  assert.deepEqual([...names].sort(), [...SUPPLIER_READS, ...SUPPLIER_WRITES].sort());
  assert.equal(new Set(names).size, names.length, "no duplicates");
  for (const a of [...UNGATED_READS, ...ADMIN_ACTIONS]) assert.ok(!names.includes(a), `${a} must not be reachable by a supplier`);
});

test("portal-api: the gate sits after the session is verified and before the first session action", () => {
  const sessionAt = src.indexOf("const session = await verifySession(");
  const setAt = src.indexOf("const SUPPLIER_ACTIONS = new Set([");
  const gateAt = src.indexOf('if (role === "supplier" && (!SUPPLIER_ACTIONS.has(action) || (session.imp === true && SUPPLIER_WRITES.has(action)))) {');
  const firstAction = src.indexOf('\n  if (action === "', sessionAt);
  assert.ok(sessionAt > 0 && setAt > sessionAt && gateAt > setAt, "the set and the gate must follow the session check");
  assert.ok(gateAt < firstAction, "the gate must come before the first action of the session section");
  assert.ok(src.slice(gateAt, firstAction).includes('return json({ error: "Not available to supplier accounts" }, 403);'));
  // The public actions run before the session check and are untouched.
  for (const a of ["login", "loginUser", "requestPasswordReset", "registerUser", "verifyUser", "setPassword", "listSurgeryTemplates", "resolvePlannerBom"]) {
    const at = src.indexOf(`  if (action === "${a}")`);
    assert.ok(at !== -1 && at < sessionAt, `${a} must stay public`);
  }
});

test("portal-api: the impersonation token gets the reads only", () => {
  const m = src.match(/const SUPPLIER_WRITES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, "portal-api has no SUPPLIER_WRITES set");
  assert.deepEqual(namesIn(m[1]).sort(), [...SUPPLIER_WRITES].sort());
});

test("portal-ai: no AI action serves a supplier session, nor the impersonation token", () => {
  // suggestFileMetadata reads any storage path it is handed; until it scopes
  // the path to the caller's own uploads no AI action is open to a supplier.
  const m = ai.match(/const SUPPLIER_ACTIONS = new Set<string>\(\[([\s\S]*?)\]\);/);
  assert.ok(m, "portal-ai has no SUPPLIER_ACTIONS set");
  assert.deepEqual(namesIn(m[1]), []);
  const ctxAt = ai.indexOf("} = ctx;");
  const gateAt = ai.indexOf('if (role === "supplier" && (session?.imp === true || !SUPPLIER_ACTIONS.has(action)))');
  const firstAction = ai.indexOf('if (action === "', ctxAt);
  assert.ok(ctxAt > 0 && gateAt > ctxAt && gateAt < firstAction, "the gate must follow the context and precede the first action");
  assert.ok(ai.slice(gateAt, firstAction).includes('return json({ error: "Not available to supplier accounts" }, 403);'));
});

// ---------------------------------------------------------------------------
// §6.2 no part outside the assignment — on the drawing and in the list
// ---------------------------------------------------------------------------
test("getDrawing lists only assigned parts to a supplier; listDrawings blanks an unassigned owner", () => {
  const gd = actionBlock("getDrawing");
  assert.ok(gd.includes("const links = scope ? (linkRows || []).filter((l: any) => scope.parts.has(l.component_id)) : (linkRows || []);"));
  const ld = actionBlock("listDrawings");
  assert.ok(ld.includes("const ownerShown = !!d.owner_component_id && (!scope || scope.parts.has(d.owner_component_id));"));
  assert.ok(ld.includes("owner_component_id: ownerShown ? d.owner_component_id : null,"));
  assert.ok(ld.includes('owner_name: ownerShown ? (ownerMap[d.owner_component_id]?.name || "") : "",'));
  assert.ok(ld.includes('owner_part_number: ownerShown ? (ownerMap[d.owner_component_id]?.part_number || "") : "",'));
});

// ---------------------------------------------------------------------------
// §6 liveness: the account and the company are re-checked on every request
// ---------------------------------------------------------------------------
test("supplierScope re-reads the user and the supplier per request and refuses a stale session", () => {
  const fn = functionBody("supplierScope");
  assert.ok(fn.includes("if (!imp && !uid) return null;"), "a person's session without uid is refused");
  assert.ok(fn.includes('tdb("suppliers").select("id, status").eq("id", sid).maybeSingle()'));
  assert.ok(fn.includes('db.from("users").select("id, status, supplier_id").eq("id", uid).maybeSingle()'));
  assert.ok(fn.includes('if (!supplierRow || supplierRow.status !== "active") return null;'));
  assert.ok(fn.includes('if (!imp && (!userRow || userRow.status !== "approved" || userRow.supplier_id !== sid)) return null;'));
  // The check precedes the assignment read; every supplier-scoped action, the
  // two file gates included, inherits it through supplierScope → 403.
  assert.ok(fn.indexOf('supplierRow.status !== "active"') < fn.indexOf('tdb("supplier_components")'));
  for (const action of ["supplierHome", "supplierFileUrl", ...SCOPED_ACTIONS]) {
    assert.ok(actionBlock(action).includes("supplierScope(tdb, session)"), `${action} bypasses supplierScope`);
    assert.ok(actionBlock(action).includes("supplierNotLinked()"), `${action} does not 403 a stale session`);
  }
});

// ---------------------------------------------------------------------------
// the admin side: seats, the schema, the audit's Part column
// ---------------------------------------------------------------------------
test("removeSupplierUser suspends the membership the way orgUpdateMember does", () => {
  assert.match(actionBlock("removeSupplierUser"),
    /db\.from\("memberships"\)\.update\(\{ status: "suspended", updated_at: new Date\(\)\.toISOString\(\) \}\)\s*\.eq\("user_id", user_id\)\.eq\("organization_id", organizationId\)/);
  assert.match(actionBlock("orgUpdateMember"), /\["active", "suspended", "invited"\]/, "the value orgUpdateMember accepts");
});

test("0065: created_by on suppliers and supplier_components is SET NULL when the user goes", () => {
  for (const t of ["suppliers", "supplier_components"]) {
    const m = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(([\\s\\S]*?)\\n\\);`))[1];
    assert.match(m, /created_by\s+UUID REFERENCES users\(id\) ON DELETE SET NULL/, `${t}.created_by`);
  }
});

test("getSupplier names the part of an ownerless drawing through drawing_components", () => {
  const block = actionBlock("getSupplier");
  assert.ok(block.includes('tdb("drawing_components").select("drawing_id, component_id, linked_at").in("drawing_id", drawingIds).order("linked_at", { ascending: true })'));
  assert.ok(block.includes("if (compById.has(l.component_id) && !linkedPart.has(l.drawing_id)) linkedPart.set(l.drawing_id, l.component_id);"));
  assert.ok(block.includes('part = d ? (partLabel(d.owner_component_id ?? null) || partLabel(linkedPart.get(d.id) ?? null)) : "";'));
});

// ---------------------------------------------------------------------------
// §6.1 / §6.5 Download as attachment, Open inline — both through the gate
// ---------------------------------------------------------------------------
test("a Download is signed as an attachment, the viewer's Open inline, both audited", () => {
  const fn = functionBody("issueSupplierFile");
  assert.ok(fn.includes("opts: { inline?: boolean } = {}"));
  assert.ok(fn.includes(".createSignedUrl(storagePath, 600, opts.inline ? undefined : { download: fileName })"));
  assert.ok(fn.indexOf('tdb("supplier_file_events").insert(event)') < fn.indexOf(".createSignedUrl("), "the audit row precedes either URL");
  const sfu = actionBlock("supplierFileUrl");
  assert.ok(sfu.includes("const inline = body.inline === true;"));
  assert.ok(sfu.includes("await issueSupplierFile(tdb, session, scope, kind, id, { inline })"));
  assert.ok(actionBlock("drawingFileUrl").includes('await issueSupplierFile(tdb, session, scope, "drawing", revision_id, { inline: true })'));
});

// ---------------------------------------------------------------------------
// portal-api surface — no credentials
// ---------------------------------------------------------------------------
const notDeployed = (r) => /unknown action/i.test(r.json?.error ?? "");

for (const action of [...SUPPLIER_ACTIONS, ...ADMIN_ACTIONS]) {
  test(`${action} rejects an unauthenticated call`, async () => {
    const r = await call(action, { supplier_id: "x", user_id: "x", kind: "drawing", id: "x", name: "x", email: "x@example.com", parts: [] });
    if (notDeployed(r)) return;   // the deployed copy predates the supplier portal
    assert.equal(r.status, 401, `${action} answered ${r.status} without a session`);
  });
}

test("login with role supplier is refused by the deployed function (once deployed)", async () => {
  const r = await call("login", { role: "supplier", password: "" });
  // Before the deploy the old code answers 401 "Incorrect password"; after it, 403.
  if (r.status === 401) return;
  assert.equal(r.status, 403, `login(role supplier) answered ${r.status}`);
  assert.equal(r.json?.error, "Supplier access is by personal account.");
});

test("portal-api: every supplier request re-checks the account and the company in the gate", () => {
  const gateAt = src.indexOf('if (role === "supplier" && action !== "orgContext")');
  const firstAction = src.indexOf('if (action === "orgContext")');
  assert.ok(gateAt > 0 && gateAt < firstAction, "the liveness check sits in the gate, before the first action");
  const block = src.slice(gateAt, firstAction);
  assert.ok(block.includes('tdb("suppliers").select("id, status")'), "the supplier's status is read");
  assert.ok(block.includes('db.from("users").select("id, status, supplier_id")'), "the user's status and supplier are read");
  assert.ok(/u\.status !== "approved" \|\| u\.supplier_id !== sid/.test(block), "a disabled or re-linked user is refused");
});

test("getDrawing hands a supplier the drawing's identity only", () => {
  const n = src.indexOf('if (action === "getDrawing")');
  const block = src.slice(n, n + 9000);
  assert.ok(block.includes('const drawingOut = role === "supplier"'), "no supplier-shaped drawing object");
  assert.ok(!/drawingOut[\s\S]{0,600}created_by/.test(block.slice(block.indexOf("const drawingOut"), block.indexOf("const drawingOut") + 700)), "created_by must not reach a supplier");
  assert.ok(block.includes("const payload: any = { drawing: drawingOut, revisions: shownRevisions, components };"));
});
