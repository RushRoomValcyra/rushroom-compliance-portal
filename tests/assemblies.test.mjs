// listAssemblies — the small integration endpoint.
//
// Unauthenticated assertions always run. The credentialed ones (shape, sorting,
// sub_assembly filtering) run only when TEST_RUSHROOM_PASSWORD is set, and the
// cross-tenant one only with two org accounts — matching the harness convention
// so a fresh checkout and CI stay green without secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { API_URL, CREDS, call, loginShared, loginUser } from "./config.mjs";

async function callWith(body, headers = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

/** The deployed copy may predate this endpoint; skip rather than fail. */
function notDeployed(r) {
  return /unknown action/i.test(r.json?.error ?? "");
}

test("listAssemblies without a token is rejected", async () => {
  const r = await call("listAssemblies");
  assert.notEqual(r.status, 200, "unauthenticated call returned 200");
  assert.ok(/auth|token|not authenticated/i.test(r.json?.error ?? ""), `unexpected error: ${r.json?.error}`);
});

test("listAssemblies with an invalid token is rejected", async () => {
  const r = await call("listAssemblies", { token: "not.a.valid.token" });
  assert.notEqual(r.status, 200);
});

test("a forged organization_id cannot select another tenant", async () => {
  // Without a session the request is rejected outright; the point is that the
  // body is never the source of tenancy.
  const r = await call("listAssemblies", { organization_id: "11111111-1111-1111-1111-111111111111" });
  assert.notEqual(r.status, 200);
});

test("an Authorization: Bearer token is accepted (Postman / integrations)", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const r = await callWith({ action: "listAssemblies" }, { authorization: `Bearer ${token}` });
  if (notDeployed(r)) return t.skip("listAssemblies not deployed yet");
  assert.equal(r.status, 200, `bearer auth failed: ${r.json?.error}`);
  assert.ok(Array.isArray(r.json?.assemblies), "expected an assemblies array");
});

test("response shape is { assemblies: [{id, name}], count }", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const r = await call("listAssemblies", { token });
  if (notDeployed(r)) return t.skip("listAssemblies not deployed yet");
  assert.equal(r.status, 200, `error: ${r.json?.error}`);
  const { assemblies, count } = r.json ?? {};
  assert.ok(Array.isArray(assemblies), "assemblies must be an array");
  assert.equal(count, assemblies.length, "count must match the array length");
  for (const a of assemblies) {
    assert.equal(typeof a.id, "string", "id must be a string");
    assert.equal(typeof a.name, "string", "name must be a string");
    // A narrow contract: extra columns here would leak schema into integrations.
    assert.deepEqual(Object.keys(a).sort(), ["id", "name"], `unexpected keys: ${Object.keys(a)}`);
  }
});

test("results are sorted alphabetically by name", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const r = await call("listAssemblies", { token });
  if (notDeployed(r)) return t.skip("listAssemblies not deployed yet");
  const names = (r.json?.assemblies ?? []).map((a) => a.name);
  const sorted = [...names].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: "base" }));
  assert.deepEqual(names, sorted, "assemblies are not name-sorted");
});

test("only sub_assembly rows are returned", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const asm = await call("listAssemblies", { token });
  if (notDeployed(asm)) return t.skip("listAssemblies not deployed yet");
  const all = await call("listComponents", { token });
  if (all.status !== 200) return t.skip("listComponents unavailable for cross-check");

  const byId = new Map((all.json?.components ?? []).map((c) => [c.id, c]));
  const returned = asm.json?.assemblies ?? [];
  for (const a of returned) {
    const full = byId.get(a.id);
    if (full) assert.equal(full.type, "sub_assembly", `"${a.name}" is ${full.type}, not sub_assembly`);
  }
  // And nothing of that type is missing — the filter must not be narrower than
  // the Assemblies tab, which applies no lifecycle filter.
  const expected = (all.json?.components ?? []).filter((c) => c.type === "sub_assembly").length;
  assert.equal(returned.length, expected,
    `returned ${returned.length} assemblies but listComponents has ${expected} sub_assembly rows`);
});

test("inactive assemblies are included (matches the Assemblies tab)", async (t) => {
  if (!CREDS.rushroomPassword) return t.skip("TEST_RUSHROOM_PASSWORD not set");
  const token = await loginShared("rushroom", CREDS.rushroomPassword);
  const asm = await call("listAssemblies", { token });
  if (notDeployed(asm)) return t.skip("listAssemblies not deployed yet");
  const all = await call("listComponents", { token });
  if (all.status !== 200) return t.skip("listComponents unavailable");
  const inactive = (all.json?.components ?? [])
    .filter((c) => c.type === "sub_assembly" && c.lifecycle_status === "inactive");
  if (!inactive.length) return t.skip("no inactive assemblies in this tenant");
  const ids = new Set((asm.json?.assemblies ?? []).map((a) => a.id));
  for (const c of inactive) {
    assert.ok(ids.has(c.id), `inactive assembly "${c.name}" is missing — endpoint disagrees with the tab`);
  }
});

test("a supplier session cannot list assemblies", async (t) => {
  if (!CREDS.supplierPassword) return t.skip("TEST_SUPPLIER_PASSWORD not set");
  const token = await loginShared("supplier", CREDS.supplierPassword);
  const r = await call("listAssemblies", { token });
  if (notDeployed(r)) return t.skip("listAssemblies not deployed yet");
  assert.equal(r.status, 403, `supplier got ${r.status}, expected 403`);
});

test("tenants never see each other's assemblies", async (t) => {
  const { orgAEmail, orgAPassword, orgBEmail, orgBPassword } = CREDS;
  if (!orgAEmail || !orgAPassword || !orgBEmail || !orgBPassword) {
    return t.skip("two-org credentials not configured");
  }
  const a = await loginUser(orgAEmail, orgAPassword);
  const b = await loginUser(orgBEmail, orgBPassword);
  const ra = await call("listAssemblies", { token: a.token });
  const rb = await call("listAssemblies", { token: b.token });
  if (notDeployed(ra)) return t.skip("listAssemblies not deployed yet");

  const idsA = new Set((ra.json?.assemblies ?? []).map((x) => x.id));
  const overlap = (rb.json?.assemblies ?? []).filter((x) => idsA.has(x.id));
  assert.equal(overlap.length, 0, `tenant B sees ${overlap.length} of tenant A's assemblies`);
});
