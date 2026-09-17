// Shared environment + Supabase client.
// Every portal function creates the SAME service-role client here. The key never
// leaves the edge runtime; the browser only ever holds a signed session token.
export const BUCKET = "supplier-uploads";
export const DOC_BUCKET = "documents";
export const STD_BUCKET = "standards";
export const TOKEN_TTL_SECONDS = 60 * 60 * 8; // 8 hours

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const TOKEN_SECRET = Deno.env.get("TOKEN_SECRET") ?? "";
export const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
export const SCAN_MODEL = "claude-opus-4-8";
// PROP-046: reading a title block is the metadata task CLAUDE.md says must not
// use opus. Kept as its own constant so cheap calls can be moved over one at a
// time — today only extractDrawingMeta uses it; the older metadata actions
// still run on SCAN_MODEL and are recorded in ROADMAP as worth migrating.
export const META_MODEL = "claude-haiku-4-5-20251001";

export const PW_HASH: Record<string, string | undefined> = {
  rushroom: Deno.env.get("RUSHROOM_PW_HASH")?.toLowerCase(),
  supplier: Deno.env.get("SUPPLIER_PW_HASH")?.toLowerCase(),
};

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
export const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
export const enc = new TextEncoder();
