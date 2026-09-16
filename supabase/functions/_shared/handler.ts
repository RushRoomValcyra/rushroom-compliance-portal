// The request envelope shared by every portal function.
//
// It reproduces portal-api's original gate order exactly, because the contract
// depends on it: OPTIONS first, then POST-only, then TOKEN_SECRET, then JSON
// parse, then auth — so a protected action is rejected BEFORE dispatch and a
// forged organization_id in the body can never reach a query.
import { CORS, json, preflight } from "./http.ts";
import { TOKEN_SECRET } from "./env.ts";
import { verifySession } from "./auth.ts";
import { makeTdb, RUSHROOM_ORG_ID } from "./tenant.ts";
import { startTimer, type Timer } from "./timing.ts";

export interface Ctx {
  body: any;
  action: string;
  session: any;
  role: string;
  isAdmin: boolean;
  organizationId: string;
  tdb: ReturnType<typeof makeTdb>;
  timer: Timer;
}

/** Actions a function serves without a session. Kept tiny and explicit. */
export interface ServeOptions {
  fn: string;
  publicActions?: string[];
  handle: (ctx: Ctx) => Promise<Response | null>;
}

export function serve(opts: ServeOptions) {
  const publicActions = new Set(opts.publicActions ?? []);

  Deno.serve(async (req) => {
    const pre = preflight(req);
    if (pre) return pre;
    if (!TOKEN_SECRET) return json({ error: "Server not configured (TOKEN_SECRET missing)" }, 500);

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    const action = String(body.action || "");
    const timer = startTimer(opts.fn, action);

    // No database, no session, no work — so cold-start and gateway latency can
    // be measured on its own. Deliberately public and deliberately first.
    if (action === "health") {
      timer.done(200);
      return json({ ok: true, fn: opts.fn, ts: Date.now() });
    }

    try {
      let session: any = null;
      if (!publicActions.has(action)) {
        session = await verifySession(body.token);
        if (!session) {
          timer.done(401);
          return json({ error: "Not authenticated" }, 401);
        }
      }

      // Tenancy is session-derived. A body organization_id is ignored.
      const organizationId = session?.org || RUSHROOM_ORG_ID;
      const ctx: Ctx = {
        body, action, session,
        role: session?.role ?? "",
        isAdmin: session?.admin === true,
        organizationId,
        tdb: makeTdb(organizationId),
        timer,
      };

      const res = await opts.handle(ctx);
      if (res) { timer.done(res.status); return res; }
      timer.done(400);
      return json({ error: `Unknown action: ${action}` }, 400);
    } catch (e) {
      timer.done(500);
      return json({ error: String((e as Error)?.message ?? e) }, 500);
    }
  });
}

export { CORS, json };
