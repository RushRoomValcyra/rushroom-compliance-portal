// CORS + JSON responses. Identical headers across every portal function so the
// browser sees one contract regardless of which function served the action.
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  // Without this the browser re-runs a preflight before EVERY request, and each
  // preflight is a full edge-function invocation. Measured 2026-09-16: 302
  // OPTIONS at p50 1200ms against 669 POSTs — half the traffic, the slower half.
  "Access-Control-Max-Age": "86400",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  return null;
}
