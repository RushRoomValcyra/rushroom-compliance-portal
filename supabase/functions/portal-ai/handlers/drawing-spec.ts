// Dynamic drawings, layer 2 — the dialogue (docs/DYNAMIC_DRAWINGS.md §4.2,
// §5.2; refined in docs/DRAWING_DIALOGUE.md §3–§7, Phase 5).
//
// proposeDrawingSpecOps: prose plus the marked entities (and the marquee's
// model rectangle) become a PROPOSAL — operations over the closed SPEC_VOCAB,
// refusals naming where the change actually lives, questions when the ask is
// ambiguous. Nothing is applied here: the browser posts the checked ops to
// portal-api applyDrawingSpecOps (callout / drawing scope) or
// promoteDrawingSpecOps (template scope), which re-validate every op.
//
// The model never writes a patch, never sees a storage path, and cannot widen
// the vocabulary: the op enum of its JSON schema is OPS from the shared core,
// every proposed op goes through validateOps before it is shown, and the
// LEVEL of an op (callout · drawing · template) is a constant of the core,
// never a field the model fills. The scope is the engineer's choice on the
// prompt row; here it is a ceiling the handler applies (§3).
//
// SCAN_MODEL (claude-opus-4-8): reasoning over a closed grammar against a
// dimension list and free-text intent is not metadata; a plausible wrong
// tolerance is the failure PROP-039 warns about. One call per turn.
import { json } from "../../_shared/http.ts";
import {
  SPEC_VOCAB, OPS, OP_LEVEL, LEVELS, REFUSAL_CATEGORIES, LIVES_IN, TOLERANCE_KINDS, OVERRIDE_KINDS, POS_OVERRIDE_KINDS,
  VIEW_KIND_REQUIRED, levelOf, validateOps, isBareNumber,
} from "../../_shared/drawing-spec-core.mjs";

type Ctx = {
  role: string;
  tdb: (table: string) => any;
  db: any;
  apiKey: string;
  model: string;
  docBucket: string;
  meterAi: (aj: any) => Promise<void>;
  session: any;
};

const PROMPT_MAX = 2000;
const DIMS_MAX = 400;

// ---------------------------------------------------------------------------
// The vocabulary card, rendered from the constant (one source: the validator
// admits exactly these ops with exactly these args).
// ---------------------------------------------------------------------------
const ARG_TYPE_WORDS: Record<string, string> = {
  tol: "tolerance string: ±n | +n -n | +n -0 | 0 -n (ISO 2768-[fmcv] for general only)",
  text: "text, never a bare number",
  text_null: "text or null (clears it)",
  number: "number ≥ 0 (a selector or threshold drawset owns, never a printed value)",
  integer: "integer ≥ 1",
  index: "integer ≥ 0",
  scale: "one of 1, 2, 5, 10, 20",
  at: "a geometric address copied from a dimension row: {type:'hole', axis, D, pos:[p0,p1]} | {type:'groove', axis, offset} | {type:'pocket', at:[x,y]}",
  only_at: "[[x, y], …] hole positions",
  range: "[a, b] numbers, a ≤ b",
  id: "a view id as printed (A, B-B)",
  id_list: "[view id, …]",
  labels: "{ z_min?: text, z_max?: text }",
  through: "{ D, axis?, open_at?, index? } the hole class a section cuts",
  around: "{ D, index? } the hole a detail is drawn around",
  box: "{ x_from_datum, y_half }",
  ctq_end: "{ D, column: rearmost | frontmost }",
  about: "{ D }",
};

function vocabularyCard(): string {
  const lines: string[] = [];
  for (const [op, def] of Object.entries(SPEC_VOCAB as Record<string, any>)) {
    const args = Object.entries(def.args as Record<string, any>).map(([k, t]) => {
      const opt = def.required.includes(k) ? "" : "?";
      const type = Array.isArray(t) ? t.join("|") : String(t);
      return `${k}${opt}: ${type}`;
    });
    lines.push(`- ${op}(${args.join(", ")}) — level ${(OP_LEVEL as Record<string, string>)[op]}`);
  }
  const types = Object.entries(ARG_TYPE_WORDS).map(([k, v]) => `  ${k}: ${v}`).join("\n");
  return `${lines.join("\n")}\n\nArgument types:\n${types}\n\nView kinds and what each needs: ${Object.entries(VIEW_KIND_REQUIRED as Record<string, string[]>).map(([k, v]) => `${k} → ${v.join(" + ")}`).join("; ")}.`;
}

export const DRAWING_SPEC_PROMPT_V1 = `You turn an engineer's request about one production drawing into OPERATIONS over a closed vocabulary. The drawing is rendered by a program (drawset) from the part's STEP file, a house template and a per-drawing patch; the patch is the only thing that can change here. You propose; the engineer applies. You never write the patch yourself.

THE VOCABULARY (the only operations that exist; anything else is a refusal):
${vocabularyCard()}

HOUSE RULES THAT BIND THE SPEC
- No value may be typed into the spec. drawset prints what it measures in the STEP. A request to change a printed number ("make the 37 a 38", "move the hole") is a CAD change: refuse with category not_in_step, lives_in STEP.
- A tolerance sits on the dimension (override_dimension with tol) or on a kind (set_tolerance). A per-hole POSITION tolerance does not exist: hole_position is one tolerance per drawing (needs_code, drawset.py face_sheet).
- A per-dimension DATUM exists: override_dimension kind pos_x or pos_y with from: min | max names the edge that one hole is measured from (drawset then prints it as pos_x_far / pos_y_top). "In general" (every hole) is set_datum axis side, and set_from_top_rule within for the band near the top edge.
- Sheet order: set_sheet_plan face_order bottom_up numbers the face sheets from the bottom band up (top_down is the house default). Do NOT express this as set_sheet y_range ops.
- A hole dimensioned centre-to-centre (a pair, kind cc) or a CTQ end carries a RELATION, not a datum: a datum ask on it is a refusal, category relation, lives_in drawset.py.
- Names only on a diameter callout (kind dia). Standard scales only. One callout per hole. No hole table, no NOTES block, filled arrows, ISO 2768 only as the general tolerance.
- Addresses: copy \`at\` exactly from the dimension rows you were given. Never invent a position. If the marked rows span two feature classes and the request does not say which, ask a question and propose nothing.

WHAT IS CODE, NOT SPEC (refuse with needs_code and the file named): a new dimension kind; a cone or countersink callout; a slot class; a section with a normal other than x; a front- or rear-edge view; moving a text; the c/c–CTQ overprint (drawset.py face_sheet, right y-stack column 0); a per-hole position tolerance (drawset.py face_sheet, ptol per sheet); suppressing one dimension; a hole table; a NOTES block; a non-standard scale; any typed length. Anything about the 3D model or the STEP file: not_in_step, lives_in STEP. Anything that contradicts a house rule above: house_style, lives_in house_rule.

SCOPE
The engineer chose a scope before asking: callout, drawing or template. You never choose or change it; propose the operations the request needs and let the levels in the vocabulary card speak. Under scope callout, prefer operations that carry an \`at\` taken from the marked rows; when the request plainly reaches past them (a kind tolerance, a sheet plan, a datum for every hole), still propose the operation without \`at\`: the portal offers it unticked, and the engineer decides. Never refuse a request only because of the scope. Under scope template, prefer kind-level and rule-level operations (set_tolerance, set_datum, set_sheet_plan, set_hole_rule …) over per-feature overrides.

OUTPUT
JSON only, in the schema given. For each operation: op, args_json (the arguments as one JSON object string, exactly the keys the card lists), a reason ≤ 160 characters in the engineer's words, and targets (the feature ids the rows you used carry, e.g. "H21"). Refusals name the request in the engineer's words, the category, where it lives and one line of detail. Questions are one sentence each. summary is one sentence.

WORKED EXAMPLES
1. Marked: two rows "Ø8 at (569, 811) depth 13 +0.3 -0" and "Ø8 at (569, 2163) depth 13 +0.3 -0". Ask: "tighten depth on these to +0.3/-0.1". → two override_dimension {at: <copied>, kind: "depth", tol: "+0.3 -0.1"}.
2. Nothing marked, scope drawing. Ask: "general tolerance ISO 2768-f". → set_tolerance {kind: "general", tol: "ISO 2768-f"}.
3. Nothing marked. Ask: "start the face sheets from the bottom, not the top". → set_sheet_plan {face_order: "bottom_up"}, reason "face sheets numbered from the bottom band".
4. Marked: one row "Ø5 at (41, 1319) pos_y 1319 ±0.2". Ask: "measure this one from the top edge". → override_dimension {at: <copied>, kind: "pos_y", from: "max"}.
5. Marked: fifteen rows of the right y-stack including "c/c 96" and a CTQ. Ask: "these from the top". → one override_dimension pos_y from max per hole row; the c/c and CTQ rows → one refusal, category relation, lives_in drawset.py, detail "c/c and CTQ carry a relation between two holes; they have no datum".
6. Ask: "move the c/c text clear of the CTQ value". → refusal needs_code, lives_in drawset.py, detail "face_sheet, right y-stack column 0 overprint".
7. Ask: "change the 37 to 38". → refusal not_in_step, lives_in STEP.`;

const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: [...OPS] },
          args_json: { type: "string", description: "The op's arguments as one JSON object" },
          reason: { type: "string" },
          targets: { type: "array", items: { type: "string" } },
        },
        required: ["op", "args_json", "reason", "targets"],
      },
    },
    refusals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          request: { type: "string" },
          category: { type: "string", enum: [...REFUSAL_CATEGORIES] },
          lives_in: { type: "string", enum: [...LIVES_IN] },
          detail: { type: "string" },
        },
        required: ["request", "category", "lives_in", "detail"],
      },
    },
    questions: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "operations", "refusals", "questions"],
};

// ---------------------------------------------------------------------------
// Loading what the model reads (portal-api owns the rows; this handler reads them)
// ---------------------------------------------------------------------------
const num = (v: unknown) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);
const rowWords = (r: any) => {
  const at = r && r.at && typeof r.at === "object" ? ` at=${JSON.stringify(r.at)}` : "";
  return `sheet ${r.sheet} · ${r.feature} · ${r.kind} · ${num(r.value)}${r.tol ? " " + r.tol : ""}${r.text ? ` · "${r.text}"` : ""}${r.view ? " · " + r.view : ""}${r.relation ? " · relation" : ""}${at}`;
};

async function loadDims(db: any, bucket: string, path: unknown): Promise<any[]> {
  if (!path || typeof path !== "string") return [];
  try {
    const { data, error } = await db.storage.from(bucket).download(path);
    if (error || !data) return [];
    const parsed = JSON.parse(await data.text());
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.rows)) return parsed.rows;
      if (Array.isArray(parsed.dimensions)) return parsed.dimensions;
    }
  } catch { /* no sidecar: the model works from the part summary alone */ }
  return [];
}

/** Sheets as the engineer sees them: rows per sheet and the y band the position rows cover. */
function sheetSummary(dims: any[]): string {
  const by = new Map<number, { n: number; ys: number[]; views: Set<string> }>();
  for (const r of dims) {
    const s = Number(r.sheet);
    if (!by.has(s)) by.set(s, { n: 0, ys: [], views: new Set() });
    const e = by.get(s)!;
    e.n++;
    if (r.view) e.views.add(String(r.view));
    if (["pos_y", "pos_y_top"].includes(String(r.kind)) && r.at && Array.isArray(r.at.pos)) e.ys.push(Number(r.at.pos[1]));
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([s, e]) => {
    const band = e.ys.length ? ` · holes at y ${Math.min(...e.ys)}–${Math.max(...e.ys)}` : "";
    return `sheet ${s}: ${e.n} rows · views ${[...e.views].join(", ") || "—"}${band}`;
  }).join("\n");
}

/** The part in words: outline, hole classes with count and depth, grooves, pockets. */
function partSummary(dims: any[]): string {
  const out: string[] = [];
  const outline: Record<string, unknown> = {};
  for (const r of dims) if (r.feature === "outline" || (r.at && r.at.type === "outline")) outline[String(r.kind)] = num(r.value);
  if (Object.keys(outline).length) out.push(`outline: ${Object.entries(outline).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const classes = new Map<string, { n: Set<string>; depths: Set<unknown> }>();
  for (const r of dims) {
    if (!r.at || r.at.type !== "hole") continue;
    const key = `Ø${num(r.at.D)} ${String(r.at.axis || "").toUpperCase()}`;
    if (!classes.has(key)) classes.set(key, { n: new Set(), depths: new Set() });
    const c = classes.get(key)!;
    c.n.add(String(r.feature));
    if (r.kind === "depth" && !r.relation) c.depths.add(num(r.value));
  }
  for (const [k, c] of classes) out.push(`${k}: ${c.n.size} holes${c.depths.size ? ` · depth ${[...c.depths].join("/")}` : ""}`);
  const grooves = new Set<string>(), pockets = new Set<string>();
  for (const r of dims) {
    if (r.at && r.at.type === "groove") grooves.add(`groove ${String(r.at.axis || "").toUpperCase()} at ${num(r.at.offset)}`);
    if (r.at && r.at.type === "pocket") pockets.add(`pocket at (${num(r.at.at?.[0])}, ${num(r.at.at?.[1])})`);
  }
  if (grooves.size) out.push([...grooves].join(", "));
  if (pockets.size) out.push([...pockets].join(", "));
  return out.join("\n") || "(no dimension list yet)";
}

/** Which rows the model reads in full: the marked sheet's and the marked features'; everything when nothing is marked; summarised beyond DIMS_MAX. */
function dimsForModel(dims: any[], selection: any): string {
  const entities: any[] = Array.isArray(selection?.entities) ? selection.entities : [];
  const features = new Set(entities.map((e) => String(e.feature)));
  const sheet = selection?.sheet != null ? Number(selection.sheet) : null;
  let rows = dims;
  if (features.size || sheet != null) rows = dims.filter((r) => features.has(String(r.feature)) || (sheet != null && Number(r.sheet) === sheet));
  if (rows.length <= DIMS_MAX) return rows.map(rowWords).join("\n") || "(none)";
  const per = new Map<string, number>();
  for (const r of rows) {
    const k = r.at && r.at.type === "hole" ? `${r.kind} Ø${num(r.at.D)}` : String(r.kind);
    per.set(k, (per.get(k) || 0) + 1);
  }
  const head = rows.filter((r) => features.has(String(r.feature))).slice(0, DIMS_MAX).map(rowWords).join("\n");
  return `${head}\n… ${rows.length} rows in all, per kind: ${[...per.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")}`;
}

const pick = (o: any, keys: string[]) => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && !(typeof o[k] === "object" && !Array.isArray(o[k]) && !Object.keys(o[k]).length) && !(Array.isArray(o[k]) && !o[k].length)) out[k] = o[k];
  return out;
};

// ---------------------------------------------------------------------------
// The action
// ---------------------------------------------------------------------------
export async function proposeDrawingSpecOps(body: any, ctx: Ctx): Promise<Response> {
  const { role, tdb, db, apiKey, model, docBucket, meterAi, session } = ctx;
  if (role !== "rushroom") return json({ error: "Rushroom only" }, 403);
  if (!apiKey) return json({ error: "AI is not configured — set ANTHROPIC_API_KEY in the function secrets." }, 400);

  const drawing_id = String(body.drawing_id ?? "").trim();
  const prompt = String(body.prompt ?? "").trim();
  const scope = LEVELS.includes(body.scope) ? String(body.scope) : "drawing";
  if (!drawing_id) return json({ error: "drawing_id required" }, 400);
  if (!prompt) return json({ error: "prompt required" }, 400);
  if (prompt.length > PROMPT_MAX) return json({ error: `prompt longer than ${PROMPT_MAX} characters` }, 400);
  const selection = body.selection && typeof body.selection === "object" && !Array.isArray(body.selection) ? body.selection : { entities: [] };
  const entities: any[] = Array.isArray(selection.entities) ? selection.entities.slice(0, 200) : [];
  if (scope === "callout" && !entities.length) {
    return json({ error: "This callout needs a marked dimension; mark one on the sheet or choose This drawing" }, 400);
  }

  // ---- what governs the drawing -------------------------------------------
  const { data: drawing } = await tdb("drawings").select("id, drawing_number, title, render_spec, current_revision_id, spec_patch_id").eq("id", drawing_id).maybeSingle();
  if (!drawing) return json({ error: "Drawing not found" }, 404);
  const { data: patches } = await tdb("drawing_spec_patches").select("id, seq, patch, spec_version_id, status, origin, operations")
    .eq("drawing_id", drawing_id).order("seq", { ascending: true });
  const chain: any[] = patches || [];
  const latest = chain.length ? chain[chain.length - 1] : null;
  const { data: rev } = drawing.current_revision_id
    ? await tdb("drawing_revisions").select("id, revision, status, render_job_id, spec_version_id").eq("id", drawing.current_revision_id).maybeSingle()
    : { data: null };
  let versionId: string | null = latest?.spec_version_id ?? rev?.spec_version_id ?? null;
  let job: any = null;
  if (rev?.render_job_id) {
    const { data: j } = await tdb("drawing_render_jobs").select("id, result, spec_version_id").eq("id", rev.render_job_id).maybeSingle();
    job = j || null;
    if (!versionId && job?.spec_version_id) versionId = job.spec_version_id;
  }
  if (!versionId && drawing.render_spec) {
    const { data: cat } = await tdb("drawing_render_specs").select("current_version_id").eq("name", drawing.render_spec).maybeSingle();
    versionId = cat?.current_version_id ?? null;
  }
  const { data: version } = versionId
    ? await tdb("drawing_spec_versions").select("id, name, version, kind, body").eq("id", versionId).maybeSingle()
    : { data: null };
  if (!version) return json({ error: "The drawing has no governed spec yet; render an issue from a registered template first" }, 400);
  if (scope === "template" && version.kind !== "template") {
    return json({ error: `${version.name} is a per-part spec, not a template; migrate the drawing to flat_panel before promoting` }, 400);
  }
  const dims = await loadDims(db, docBucket, job?.result?.artifacts?.dimensions);
  const { data: recent } = await tdb("drawing_spec_turns").select("prompt, proposal, scope, created_at")
    .eq("drawing_id", drawing_id).eq("accepted", true).order("created_at", { ascending: false }).limit(5);

  // ---- the user block --------------------------------------------------------
  const bodyKeys = ["tolerances", "datums", "plan", "edge_names", "edge_band", "features", "pairs", "ctq"];
  const patchNow = latest?.patch || {};
  const region = selection.region_model && typeof selection.region_model === "object" ? selection.region_model : null;
  const recentWords = (recent || []).map((t: any) => {
    const ops = Array.isArray(t.proposal?.operations) ? t.proposal.operations.map((o: any) => o.op).join(", ") : "";
    return `- [${t.scope || "drawing"}] "${String(t.prompt || "").slice(0, 160)}" → ${ops || "no ops"}`;
  }).join("\n");
  const user = [
    `DRAWING: ${drawing.drawing_number} — ${drawing.title || ""} · Issue ${rev?.revision || "?"} (${rev?.status || "draft"})`,
    `SCOPE CHOSEN BY THE ENGINEER: ${scope}`,
    `TEMPLATE ${version.name} v${version.version} (${version.kind}):\n${JSON.stringify(pick(version.body, bodyKeys))}`,
    `PATCH NOW (seq ${latest?.seq ?? 0}):\n${JSON.stringify(pick(patchNow, [...bodyKeys, "overrides"]))}`,
    `SHEETS:\n${sheetSummary(dims)}`,
    `PART:\n${partSummary(dims)}`,
    entities.length ? `MARKED ROWS (${entities.length}):\n${entities.map(rowWords).join("\n")}` : "MARKED ROWS: none",
    region ? `MARKED REGION (model mm on the ${region.face || "face"}): x ${JSON.stringify(region.x)}, y ${JSON.stringify(region.y)}` : "",
    `DIMENSION ROWS:\n${dimsForModel(dims, selection)}`,
    recentWords ? `RECENT ACCEPTED TURNS:\n${recentWords}` : "",
    `REQUEST:\n${prompt}`,
  ].filter(Boolean).join("\n\n");

  // ---- the one call ----------------------------------------------------------
  let apiJson: any;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium", format: { type: "json_schema", schema: PROPOSAL_SCHEMA } },
        system: [{ type: "text", text: DRAWING_SPEC_PROMPT_V1, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: [{ type: "text", text: user }] }],
      }),
    });
    apiJson = await res.json();
    if (!res.ok) return json({ error: apiJson?.error?.message || "AI request failed" }, 400);
  } catch (e: any) {
    return json({ error: `AI request failed: ${e?.message || e}` }, 400);
  }
  await meterAi(apiJson);
  if (apiJson.stop_reason === "refusal") return json({ error: "The model declined this request" }, 502);

  let parsed: any;
  try {
    const txt = (apiJson.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    parsed = JSON.parse(txt);
  } catch {
    return json({ error: "The AI reply could not be read; ask again" }, 502);
  }

  // ---- coerce, validate, apply the scope ceiling --------------------------------
  const refusals: any[] = (Array.isArray(parsed.refusals) ? parsed.refusals : []).map((r: any) => ({
    request: String(r?.request ?? "").slice(0, 300),
    category: REFUSAL_CATEGORIES.includes(r?.category) ? r.category : "needs_code",
    lives_in: LIVES_IN.includes(r?.lives_in) ? r.lives_in : "drawset.py",
    detail: String(r?.detail ?? "").slice(0, 400),
  }));
  const operations: any[] = [];
  for (const o of Array.isArray(parsed.operations) ? parsed.operations : []) {
    const opName = String(o?.op ?? "");
    let args: any = {};
    try { args = JSON.parse(String(o?.args_json ?? "{}")); } catch { args = null; }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      refusals.push({ request: `${opName} ${String(o?.reason ?? "")}`.trim(), category: "ambiguous", lives_in: "portal", detail: "the proposed arguments were not an object" });
      continue;
    }
    const raw = { ...args, op: opName, reason: String(o?.reason ?? "").slice(0, 160) };
    const v = validateOps([raw]);
    if (!v.ok.length) {
      const reason = v.rejected[0]?.reason || "refused";
      const bare = /bare number/.test(reason) || isBareNumber(args.tol) || isBareNumber(args.name);
      refusals.push({ request: `${opName}: ${raw.reason || JSON.stringify(args).slice(0, 120)}`, category: bare ? "value_in_spec" : "needs_code", lives_in: "portal", detail: reason });
      continue;
    }
    const op = v.ok[0];
    const level = levelOf(op);
    // A per-part spec writes its sheets by hand: the sheet plan is derived only
    // for a template, so on side_panel_left the op would render as a no-op.
    if (op.op === "set_sheet_plan" && version.kind !== "template") {
      refusals.push({ request: raw.reason || opName, category: "house_style", lives_in: "portal", detail: `${version.name} is a per-part spec with hand-written sheets; migrate the drawing to flat_panel first (decision 5)` });
      continue;
    }
    // Under This callout an op without an address reaches past the marked rows.
    // It is offered unticked rather than refused: the engineer widens the scope
    // by ticking it, and portal-api applies it at its own level.
    const above_scope = scope === "callout" && op.at === undefined;
    operations.push({
      ...op,
      level,
      above_scope,
      promotable: scope === "template" && level === "template",
      stays_on_drawing: scope === "template" && level !== "template",
      targets: Array.isArray(o?.targets) ? o.targets.map((t: any) => String(t)).slice(0, 50) : [],
    });
  }
  const proposal = {
    summary: String(parsed.summary ?? "").slice(0, 400),
    operations,
    refusals,
    questions: (Array.isArray(parsed.questions) ? parsed.questions : []).map((q: any) => String(q).slice(0, 300)).slice(0, 5),
  };

  // ---- the turn row ------------------------------------------------------------
  const u = apiJson?.usage || {};
  const { data: turn, error } = await tdb("drawing_spec_turns").insert({
    drawing_id, drawing_revision_id: rev?.id ?? null, prompt, selection: { ...selection, entities },
    proposal, refusal_categories: [...new Set(refusals.map((r) => r.category))],
    model: apiJson?.model || model, input_tokens: u.input_tokens ?? null, output_tokens: u.output_tokens ?? null,
    accepted: null, scope, created_by: session?.uid || null,
  }).select("id").maybeSingle();
  if (error) return json({ error: error.message }, 400);
  return json({
    turn_id: turn?.id ?? null, scope, proposal,
    usage: { model: apiJson?.model || model, input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0 },
  });
}

/** Static guard for the tests: the schema's op enum IS the vocabulary. */
export const PROPOSAL_OP_ENUM = (PROPOSAL_SCHEMA.properties.operations.items.properties.op as any).enum as string[];
export { TOLERANCE_KINDS, OVERRIDE_KINDS, POS_OVERRIDE_KINDS };
