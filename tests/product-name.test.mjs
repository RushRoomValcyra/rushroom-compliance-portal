// Product name — static, no credentials.
//
// A rename is easy to do half of: the page title changes and a verification
// email still carries the old name weeks later. These assert the user-facing
// surfaces agree, and that the rename stopped where it should have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const NAME = "Engineering & Compliance Platform";
const NAME_HTML = "Engineering &amp; Compliance Platform";

test("every page shell carries the new name in its title", () => {
  for (const page of ["index.html", "supplier.html", "reset.html", "verify.html"]) {
    const src = read(page);
    const title = (src.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
    assert.ok(title.includes(NAME_HTML), `${page} title still reads "${title}"`);
  }
});

test("the visible header matches the title", () => {
  for (const page of ["index.html", "reset.html", "verify.html"]) {
    const src = read(page);
    assert.ok(src.includes(`<h1>${NAME_HTML}</h1>`), `${page} header was not renamed`);
  }
});

test("outbound emails use the new name", () => {
  // The likeliest place for a rename to go stale: nobody sees these until a
  // real person registers or resets a password.
  const api = read("supabase/functions/portal-api/index.ts");
  const stale = [...api.matchAll(/sendEmail\([^)]*Compliance Portal/g)].map((m) => m[0].slice(0, 60));
  assert.deepEqual(stale, [], `emails still say "Compliance Portal":\n  ${stale.join("\n  ")}`);
  assert.ok(api.includes(`Verify your Rushroom ${NAME} registration`), "the verification email was not renamed");
  assert.ok(api.includes(`Set your Rushroom ${NAME} password`), "the password email was not renamed");
});

test("the tagline does not contradict the name", () => {
  // "Engineering & Compliance Platform" over a tagline promising only
  // compliance documents would have the header arguing with itself.
  const tagline = (read("index.html").match(/<p class="tagline">([^<]*)</) || [])[1] || "";
  assert.ok(/BOM|drawings/i.test(tagline), `the tagline still describes a compliance-only system: "${tagline}"`);
});

test("infrastructure identifiers were deliberately left alone", () => {
  // Renaming the deployed function slugs would break the live endpoint URLs for
  // no user-visible gain. This is a product rename, not an infrastructure one.
  const api = read("assets/api.js");
  assert.ok(/portal-api/.test(api), "the portal-api slug was renamed — the deployed endpoint would 404");
  assert.ok(/portal-ai/.test(api) && /portal-cellar/.test(api), "a heavy-function slug was renamed");
  assert.ok(/PortalViewer/.test(read("assets/viewer.js")), "the viewer global was renamed");
  assert.ok(/portal-app/.test(read("index.html")), "the app container id was renamed");
});

test("applied migrations keep their original headers", () => {
  // Migrations are history. Editing one that has run — even a comment — makes
  // the checked-in file stop matching what was applied.
  assert.ok(read("supabase/migrations/0001_baseline.sql").includes("Rushroom Compliance Portal"),
    "an applied migration was edited for the rename");
});
