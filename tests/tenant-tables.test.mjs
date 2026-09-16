// Tenant-scoping drift — no network, no credentials, always runs.
//
// makeTdb() filters and stamps organization_id only for tables listed in
// TENANT_TABLES. A tenant table missing from that set passes straight through:
// every organization reads every row, and NOTHING ERRORS. It is a silent
// cross-tenant leak, the same shape as the silent-write defects that kept
// surfacing — a write that succeeds into a place nobody reads.
//
// So the guard is mechanical: every table a migration creates with an
// organization_id column must appear in TENANT_TABLES.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Tables declared in TENANT_TABLES. */
function declaredTables() {
  const src = readFileSync(join(root, "supabase/functions/_shared/tenant.ts"), "utf8");
  const block = src.match(/export const TENANT_TABLES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(block, "TENANT_TABLES not found in _shared/tenant.ts");
  // Strip comments first: a table named only inside a comment is not declared.
  const body = block[1].replace(/\/\/.*$/gm, "");
  return new Set([...body.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]));
}

// Account and platform tables that deliberately bypass makeTdb. These cross
// the tenant boundary by design — an operator administers memberships across
// organizations — so each call site scopes by hand with an explicit
// .eq("organization_id", …). Verified against portal-api on 2026-09-16.
const INTENTIONALLY_UNSCOPED = new Map([
  ["memberships",     "account administration spans organizations; scoped per call site"],
  ["invitations",     "an invitation is written before the invitee belongs to the org"],
  ["ai_usage_events", "platform metering; written by the server, read per org explicitly"],
]);

/**
 * Tables any migration creates carrying an organization_id column, minus those
 * a later migration drops — otherwise the COGS layer removed in 0012 and the
 * routing tables rebuilt in 0018 would fail this guard forever.
 */
function tenantTablesInMigrations() {
  const dir = join(root, "supabase/migrations");
  const found = new Map();   // table -> migration file that created it
  const dropped = new Set();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, f), "utf8").replace(/^\s*--.*$/gm, "");
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z0-9_]+)\s*\(([\s\S]*?)\n\)\s*;/gi;
    let m;
    while ((m = re.exec(sql))) {
      const [, table, body] = m;
      dropped.delete(table);   // re-created after a drop
      if (/\borganization_id\b/i.test(body) && !found.has(table)) found.set(table, f);
    }
    for (const d of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([a-z0-9_]+)/gi)) {
      dropped.add(d[1]);
    }
  }
  for (const t of dropped) found.delete(t);
  for (const t of INTENTIONALLY_UNSCOPED.keys()) found.delete(t);
  return found;
}

test("every tenant table created by a migration is scoped by makeTdb", () => {
  const declared = declaredTables();
  const missing = [];
  for (const [table, file] of tenantTablesInMigrations()) {
    if (!declared.has(table)) missing.push(`${table} (created in ${file})`);
  }
  assert.deepEqual(missing, [],
    `these tables carry organization_id but are NOT in TENANT_TABLES, so makeTdb leaves them unscoped:\n  ${missing.join("\n  ")}`);
});

test("TENANT_TABLES names no table that no migration creates", () => {
  // A stale entry is harmless at runtime but means the list has drifted from
  // the schema, which is how the first kind of drift goes unnoticed.
  const created = new Set();
  const dir = join(root, "supabase/migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
    const sql = readFileSync(join(dir, f), "utf8");
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z0-9_]+)/gi)) created.add(m[1]);
  }
  const stale = [...declaredTables()].filter((t) => !created.has(t));
  // Note: a table dropped by a later migration is still "created" by an earlier
  // one, so this only catches names that never existed — a typo in the set.
  assert.deepEqual(stale, [], `TENANT_TABLES lists tables no migration creates: ${stale.join(", ")}`);
});
