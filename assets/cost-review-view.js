/* Rushroom AB — Engineering & Compliance Platform: full BOM cost review (PROP-073)
 *
 *   PortalCost.openCostReview(token, { openProduct })
 *
 * "Run review now" costs every top-level product at this date and time with
 * the rates in force (portal-api runCostReview) and stores it. The report:
 * per product Estimated · Actual · Δ · Δ % · since the previous review · what
 * is missing — and past reviews to open. Each product's lines are kept as a
 * baseline, so its Cost view can compare against any review.
 */
(() => {
  const post = (token, action, body) => window.PortalAPI.post(token, action, body);
  const MUTED = "color:var(--muted,#8b93a1)";
  const M = () => window.PortalCostMath;
  function el(tag, attrs = {}, kids = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (typeof v === "boolean") { if (v) n.setAttribute(k, ""); }
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(kids)) { if (c != null) n.appendChild(typeof c === "object" ? c : document.createTextNode(String(c))); }
    return n;
  }
  const signed = (v) => (v > 0.005 ? "+" : "") + M().sek(v);
  const when = (iso) => new Date(iso).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });

  function openCostReview(token, opts = {}) {
    const overlay = el("div", { "data-modal-overlay": "", class: "modal-scrim" });
    const side = el("div", { style: "width:15rem;flex-shrink:0;border-right:1px solid var(--border,#e2e8f0);padding-right:0.75rem;display:flex;flex-direction:column;gap:0.4rem;overflow-y:auto" });
    const main = el("div", { style: "flex:1;min-width:0;overflow:auto" });
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (ev) => { if (ev.key === "Escape") close(); };
    const runBtn = el("button", { class: "btn btn-sm btn-primary", type: "button" }, "Σ Run review now");
    overlay.append(el("div", { role: "dialog", "aria-modal": "true", "aria-label": "Full BOM cost review", style: "background:var(--bg,#fff);border:1px solid var(--border,#e2e8f0);border-radius:10px;padding:1.1rem 1.25rem;width:min(1240px,96vw);height:min(820px,92vh);display:flex;flex-direction:column;gap:0.75rem" }, [
      el("div", { style: "display:flex;align-items:center;gap:0.6rem" }, [
        el("strong", { style: "flex:1;font-size:1rem" }, "Full BOM cost review"),
        el("span", { style: `font-size:0.75rem;${MUTED}` }, "Every top-level product, at this date and time, with the current rates."),
        runBtn, el("button", { class: "btn btn-xs", type: "button", onclick: close }, "✕"),
      ]),
      el("div", { style: "display:flex;gap:1rem;flex:1;min-height:0" }, [side, main]),
    ]));
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);

    async function paintList(selectId) {
      side.replaceChildren(el("div", { class: "loading" }, "Loading…"));
      try {
        const { reviews } = await post(token, "listCostReviews", {});
        side.replaceChildren(el("div", { style: `font-size:0.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;${MUTED}` }, "Reviews"),
          ...(reviews.length ? reviews.map((r) => el("button", {
            class: "btn btn-sm", type: "button", "data-review": r.id,
            style: `text-align:left;white-space:normal;${r.id === selectId ? "border-color:var(--accent,#2fa564);background:#2fa56412" : ""}`,
            onclick: () => { paintList(r.id); show(r.id); },
          }, [el("div", { style: "font-weight:600" }, when(r.reviewed_at)), el("div", { style: `font-size:0.75rem;${MUTED}` }, `${r.products} products · ${M().sek(r.actual)}`)]))
            : [el("div", { style: `font-size:0.8125rem;${MUTED}` }, "No reviews yet.")]));
        if (!selectId && reviews[0]) { show(reviews[0].id); paintList(reviews[0].id); }
        if (!reviews.length) main.replaceChildren(el("p", { style: `font-size:0.875rem;${MUTED}` }, "Run the first review to cost every product at today's rates."));
      } catch (ex) { side.replaceChildren(el("div", { class: "error" }, ex.message)); }
    }

    async function show(id) {
      main.replaceChildren(el("div", { class: "loading" }, "Loading review…"));
      try {
        const { review, previous } = await post(token, "getCostReview", { id });
        const prev = Object.fromEntries(((previous && previous.summary) || []).map((p) => [p.root_id, p]));
        const rows = review.summary || [];
        const tot = (k) => rows.reduce((a, p) => a + Number(p[k] || 0), 0);
        const rates = Object.entries(review.rates || {}).filter(([c, r]) => c !== "SEK" && r).map(([c, r]) => `${c} ${r.rate} (${r.valid_on})`).join(" · ") || "no foreign rates";
        const GRID = "display:grid;grid-template-columns:minmax(14rem,1fr) 8rem 8rem 8rem 5rem 8rem 9rem;gap:0.5rem;align-items:center;padding:0.35rem 0.5rem;border-bottom:1px solid var(--border,#e2e8f0);font-size:0.8125rem";
        const dCell = (a, e) => {
          if (!e) return el("span", { style: "text-align:right" }, "—");
          const d = a - e, rel = d / e;
          return el("span", { style: `text-align:right;${rel > M().OVER_ESTIMATE ? "color:#b91c1c;font-weight:600" : rel < -0.005 ? "color:#15803d" : ""}` }, signed(d));
        };
        main.replaceChildren(
          el("div", { style: "font-size:0.8125rem;margin-bottom:0.5rem" }, [el("strong", {}, when(review.reviewed_at)), el("span", { style: MUTED }, ` · rates: ${rates}${previous ? ` · compared with the review of ${when(previous.reviewed_at)}` : ""}`)]),
          el("div", { style: "display:flex;gap:0.6rem;flex-wrap:wrap;margin-bottom:0.6rem" }, [
            ["Actual, all products", M().sek(tot("actual"))], ["Estimated", M().sek(tot("estimated"))],
            ["Actual vs estimated", signed(tot("actual") - tot("estimated"))],
            ["Lines without a cost", String(tot("missing_actual"))],
          ].map(([l, v]) => el("div", { style: "padding:0.45rem 0.7rem;border:1px solid var(--border,#e2e8f0);border-radius:8px;min-width:9rem" }, [
            el("div", { style: `font-size:0.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;${MUTED}` }, l), el("div", { style: "font-weight:700" }, v)]))),
          el("div", { style: `${GRID};font-size:0.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;${MUTED}` },
            ["Product", "Estimated", "Actual", "Δ est.", "Δ %", "Since previous", "Missing"].map((t, i) => el("span", { style: i ? "text-align:right" : "" }, t))),
          ...rows.map((p) => el("div", { style: `${GRID};cursor:${opts.openProduct ? "pointer" : "default"}`, title: opts.openProduct ? "Open this product's Cost view" : "", onclick: () => { if (opts.openProduct) { close(); opts.openProduct(p.root_id); } } }, [
            el("span", {}, [el("strong", {}, p.name || "—"), el("span", { style: `font-family:monospace;font-size:0.75rem;margin-left:0.4rem;${MUTED}` }, p.part_number || "")]),
            el("span", { style: "text-align:right" }, p.estimated ? M().sek(p.estimated) : "—"),
            el("span", { style: "text-align:right;font-weight:600" }, M().sek(p.actual)),
            dCell(p.actual, p.estimated),
            el("span", { style: "text-align:right" }, p.estimated ? `${(((p.actual - p.estimated) / p.estimated) * 100).toFixed(1)} %` : "—"),
            el("span", { style: "text-align:right" }, prev[p.root_id] ? signed(p.actual - Number(prev[p.root_id].actual || 0)) : "new"),
            el("span", { style: `text-align:right;${p.missing_actual ? "color:#b45309" : MUTED}` }, p.missing_actual ? `${p.missing_actual} of ${p.lines} lines` : "complete"),
          ])),
          el("p", { style: `font-size:0.75rem;margin-top:0.6rem;${MUTED}` }, "A product with lines missing a cost or a rate is understated. Each product's lines are saved as a baseline — open its Cost view and pick this review under “Compare with” to see what changed, split into quantity, price and exchange rate."),
        );
      } catch (ex) { main.replaceChildren(el("div", { class: "error" }, ex.message)); }
    }

    runBtn.onclick = async () => {
      runBtn.disabled = true; runBtn.textContent = "Costing every product…";
      try { const r = await post(token, "runCostReview", {}); await paintList(r.review_id); show(r.review_id); }
      catch (ex) { main.replaceChildren(el("div", { class: "error" }, ex.message)); }
      runBtn.disabled = false; runBtn.textContent = "Σ Run review now";
    };
    paintList(null);
  }

  window.PortalCost = Object.assign(window.PortalCost || {}, { openCostReview });
})();
