// Contract guard for Order Operations' read of the surgery template register (PROP-0059).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("listSurgeryTemplates uses service auth, a strict request and the seed org, ahead of session auth", () => {
  const api = read("supabase/functions/portal-api/index.ts");
  const at = api.indexOf('action === "listSurgeryTemplates"');
  const gate = api.indexOf("// --- everything else requires a valid token");
  assert.ok(at > 0, "listSurgeryTemplates action missing");
  // Order Operations calls with its service key and no session: behind the session check it always answered 401.
  assert.ok(at < gate, "listSurgeryTemplates must sit before session auth");
  const block = api.slice(at, gate);
  for (const fragment of ["operationsServiceRefusal(req, ", "allowedKeys", "contract_version !== 1", "makeTdb(RUSHROOM_ORG_ID)", '.eq("status", "active")']) {
    assert.ok(block.includes(fragment), `listSurgeryTemplates lacks ${fragment}`);
  }
});
