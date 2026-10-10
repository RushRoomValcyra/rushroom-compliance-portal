// BOM cost simulation (PROP-072) — static safety checks, no credentials.
// Costs are planning numbers for Rushroom only: never on the supplier page,
// never in what Order Operations receives, always scoped to the tenant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const handler = read("supabase/functions/portal-api/handlers/costs.ts");
const api = read("supabase/functions/portal-api/index.ts");
const tenant = read("supabase/functions/_shared/tenant.ts");
const sql = read("supabase/migrations/0046_bom_cost_simulation.sql");

test("every cost action refuses any role but Rushroom, before anything else", () => {
  const fn = handler.slice(handler.indexOf("export async function handleCostAction"));
  const first = fn.split("\n").slice(1, 3).join("\n");
  assert.ok(/if \(ctx\.role !== "rushroom"\) return json\(\{ error: "Not authorised" \}, 403\);/.test(first), "the role check is not the first thing the handler does");
  assert.ok(/if \(COST_ACTIONS\.has\(action\)\) \{\s*return await handleCostAction\(action, body, \{ role, tdb,/.test(api), "cost actions are not dispatched through the guarded handler");
});

test("the three tables are tenant-scoped and closed", () => {
  for (const t of ["component_costs", "currency_rates", "cost_baselines"]) {
    assert.ok(tenant.includes(`"${t}"`), `${t} missing from TENANT_TABLES — every tenant would read every row`);
    assert.ok(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?organization_id\\s+UUID NOT NULL`).test(sql), `${t} lacks organization_id NOT NULL`);
    assert.ok(sql.includes(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`), `${t} has no RLS`);
  }
  assert.ok(/currency_rates_lookup\s+ON currency_rates \(organization_id, currency, valid_on DESC\)/.test(sql));
  assert.ok(/cost_baselines_by_root\s+ON cost_baselines \(organization_id, root_component_id, created_at DESC\)/.test(sql));
});

test("handlers read through tdb with named columns", () => {
  assert.ok(!/\bdb\.from\(/.test(handler), "a handler bypasses the tenant-scoped tdb");
  assert.ok(!/select\("\*"\)|select\(\)/.test(handler), "select * in the cost handler");
});

test("cost code never reaches the supplier page or Order Operations", () => {
  const supplier = read("supplier.html");
  assert.ok(!/cost-(forms|view)\.js/.test(supplier), "cost scripts are loaded on supplier.html");
  const resolver = read("supabase/functions/_shared/planner-resolver-core.mjs");
  assert.ok(!/cost/i.test(resolver), "the planner resolver mentions cost");
  const index = read("index.html");
  for (const f of ["cost-forms.js", "cost-view.js"]) {
    assert.ok(index.indexOf(f) > 0 && index.indexOf(f) < index.indexOf("assets/app.js"), `${f} must load before app.js`);
  }
  assert.ok(/import \* as CostMath from "\.\/supabase\/functions\/_shared\/cost-math\.mjs/.test(index), "the browser does not load the shared arithmetic");
  assert.ok(!/cost-math/.test(supplier), "the arithmetic is loaded on supplier.html");
});

test("the panel and toolbar only offer cost to Rushroom", () => {
  const app = read("assets/app.js");
  assert.ok(/role === "rushroom" && window\.PortalCost \? \[\{ id: "cost", label: "Cost" \}\]/.test(app));
  assert.ok(/role === "rushroom" && window\.PortalCost \? el\("button"/.test(app));
});

// ---- PROP-073 -----------------------------------------------------------------

test("Estimated and Actual are one row each per part", () => {
  const sql47 = read("supabase/migrations/0047_cost_estimated_and_reviews.sql");
  assert.ok(/CHECK \(kind IN \('actual', 'estimated'\)\)/.test(sql47));
  assert.ok(/UNIQUE \(organization_id, component_id, kind\)/.test(sql47));
  assert.ok(/onConflict: "organization_id,component_id,kind"/.test(handler), "upsert still targets the old one-cost key");
  assert.ok(tenant.includes('"cost_reviews"'), "cost_reviews missing from TENANT_TABLES");
  assert.ok(sql47.includes("ALTER TABLE cost_reviews ENABLE ROW LEVEL SECURITY;"));
});

test("the review and the AI read are Rushroom only and use the shared arithmetic", () => {
  const review = read("supabase/functions/portal-api/handlers/cost-review.ts");
  const extract = read("supabase/functions/portal-ai/handlers/cost-extract.ts");
  for (const [name, src] of [["cost-review", review], ["cost-extract", extract]]) {
    assert.ok(/if \(ctx\.role !== "rushroom"\) return json\(\{ error: "Not authorised" \}, 403\);/.test(src), `${name} has no role check`);
    assert.ok(/from "\.\.\/\.\.\/_shared\/cost-math\.mjs"/.test(src), `${name} does its own arithmetic`);
  }
  assert.ok(/\.range\(from, from \+ PAGE - 1\)/.test(review), "a review of a BOM past 1000 links would be cut short");
  assert.ok(/"extractCostsFromDocument",/.test(read("assets/api.js")), "the AI action is not routed to portal-ai");
  assert.ok(/format: \{ type: "json_schema", schema: SCHEMA \}/.test(extract), "AI output is not schema-constrained");
  assert.ok(/stop_reason === "max_tokens"/.test(extract) && /stop_reason === "refusal"/.test(extract), "a cut-off or refused read is parsed as if it were whole");
  assert.ok(/enum: \["", \.\.\.candidates\.map\(\(c\) => c\.id\)\]/.test(extract), "the AI can name a part outside the structure");
});

test("a quote read for costs is kept, linked, and never shown to suppliers", () => {
  const ai = read("assets/cost-ai.js");
  assert.ok(/is_supplier_visible: false/.test(ai));
  assert.ok(/source_document_version_id: doc\.version_id/.test(ai), "saved costs do not point at their document");
  assert.ok(/return json\(\{ ok: true, document_id: doc\.id, version_id: ver\.id \}\);/.test(api), "uploadAndLinkComponentDocument does not return the version");
  const supplier = read("supplier.html");
  assert.ok(!/cost-ai|cost-review/.test(supplier));
});

test("AI fill reads a price into the Actual cost, not into custom specs (2026-10-10)", () => {
  const ai = read("supabase/functions/portal-ai/index.ts");
  const spec = ai.slice(ai.indexOf('if (action === "extractComponentSpecs")'), ai.indexOf("PROP-046: read a drawing's title block"));
  assert.ok(/A PRICE for this part goes in \\`price\\`, never in \\`unmapped\\`/.test(spec), "the model is not told where prices go");
  assert.ok(/required: \["matched_part", "confident_part_match", "summary", "fields", "unmapped", "price"\]/.test(spec));
  assert.ok(/normaliseExtractedLines\(\[\{ \.\.\.parsed\.price, component_id \}\], \[component_id\]\)/.test(spec), "the price is not cleaned by the shared code");
  const app = read("assets/app.js");
  assert.ok(/if \(costPick && cost\) \{[\s\S]*?"setComponentCost", \{[\s\S]*?kind: "actual"/.test(app), "a ticked price is not saved as the Actual cost");
  assert.ok(/transport_cost: keep\.transport_cost \?\? 0/.test(app), "applying a price wipes the existing transport");
});

test("the quote reader takes a pasted screenshot (2026-10-10)", () => {
  const ai = read("assets/cost-ai.js");
  assert.ok(/document\.addEventListener\("paste", onPaste\)/.test(ai), "no paste listener");
  assert.ok(/document\.removeEventListener\("paste", onPaste\)/.test(ai), "the paste listener outlives the dialog");
  assert.ok(/i\.type\.startsWith\("image\/"\)/.test(ai) && /read\(new File\(\[blob\]/.test(ai), "a pasted image is not read like a dropped file");
  assert.ok(/if \(!overlay\.isConnected \|\| !waiting\) return;/.test(ai), "a paste over the review table would start a second read");
});

test("the cost tab shows the landed unit cost with its arithmetic, and no stray 'null' (2026-10-10)", () => {
  const forms = read("assets/cost-forms.js");
  assert.ok(/"Landed unit cost"/.test(forms));
  for (const part of ['row("Unit"', 'row("Transport"', 'row("Customs"', 'row("Landed"']) assert.ok(forms.includes(part), `the breakdown lacks ${part}`);
  // replaceChildren() prints null as the text "null"; every cost screen filters first.
  for (const f of ["assets/cost-forms.js", "assets/cost-view.js", "assets/cost-ai.js", "assets/cost-review-view.js"]) {
    const src = read(f);
    assert.ok(/replaceChildren\(\.\.\.\[[\s\S]*?\]\.filter\(Boolean\)\);/.test(src), `${f} can still print "null"`);
  }
});
