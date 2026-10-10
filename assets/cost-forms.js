/* Rushroom AB — Engineering & Compliance Platform: cost of one part, and rates (PROP-072)
 *
 *   PortalCost.mountPartForm(container, comp, token)  the Cost tab on a bought item
 *   PortalCost.openRates(token, onChanged)            dated EUR/USD/PLN → SEK rates
 *
 * Planning numbers, ex VAT, isolated from bookkeeping. Loaded on index.html
 * only — never on supplier.html. Arithmetic lives in cost-math.js.
 */
(() => {
  const CUR = ["SEK", "EUR", "USD", "PLN"];
  const RATE_CUR = ["EUR", "USD", "PLN"];
  const M = () => window.PortalCostMath;
  const post = (token, action, body) => window.PortalAPI.post(token, action, body);
  const today = () => new Date().toISOString().slice(0, 10);

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
  const MUTED = "color:var(--muted,#8b93a1)";
  const LBL = "display:flex;flex-direction:column;gap:0.2rem;font-size:0.75rem;font-weight:600;color:var(--muted,#8b93a1)";
  const curSelect = (value) => el("select", { class: "up-text", "aria-label": "Currency" }, CUR.map((c) => el("option", { value: c, selected: c === value ? "selected" : null }, c)));
  const numInput = (value, label) => el("input", { class: "up-text", type: "number", min: "0", step: "any", "aria-label": label, value: value ?? "", style: "width:8rem" });

  // Latest rate on or before today, per currency — for the live preview.
  async function latestRates(token) {
    const { rates } = await post(token, "listCurrencyRates", {});
    const out = { SEK: { rate: 1 } };
    for (const r of rates || []) {
      if (r.valid_on <= today() && !out[r.currency]) out[r.currency] = { rate: Number(r.rate_to_sek), valid_on: r.valid_on };
    }
    return out;
  }

  // PROP-073: two costs side by side — Estimated (our planning cost) and
  // Actual (what the supplier's document says).
  async function mountPartForm(container, comp, token) {
    container.replaceChildren(el("div", { class: "loading" }, "Loading cost…"));
    let data, rates;
    try { [data, rates] = await Promise.all([post(token, "getComponentCost", { component_id: comp.id }), latestRates(token)]); }
    catch (ex) { container.replaceChildren(el("div", { class: "error" }, `Could not load the cost: ${ex.message}`)); return; }
    const reload = () => mountPartForm(container, comp, token);
    const histBox = el("div");
    const paintHistory = (h) => histBox.replaceChildren(...[historyList(h || [], rates)].filter(Boolean));
    const refreshHistory = async () => { try { paintHistory((await post(token, "getComponentCost", { component_id: comp.id })).history); } catch { /* the save itself succeeded */ } };
    paintHistory(data.history);

    const section = (kind, c) => {
      c = c || {};
      const title = kind === "actual" ? "Actual" : "Estimated";
      const hint = kind === "actual" ? "What the supplier's quote, price list or invoice says." : "Our planning cost — what we expect it to cost.";
      const unit = numInput(c.unit_cost, `${title} unit cost`), unitCur = curSelect(c.unit_currency || "SEK");
      const trans = el("input", { class: "up-text", type: "number", min: "0", max: "1000", step: "any", value: c.transport_pct ?? "", "aria-label": `${title} transport %`, style: "width:6rem" });
      const customs = el("input", { class: "up-text", type: "number", min: "0", max: "100", step: "any", value: c.customs_pct ?? "", "aria-label": `${title} customs %`, style: "width:6rem" });
      const quoted = el("input", { class: "up-text", type: "date", value: c.quoted_on || "", "aria-label": `${title} date` });
      const supplier = el("input", { class: "up-text", type: "text", maxlength: "200", value: c.supplier_name || "", placeholder: "e.g. Häfele", "aria-label": `${title} supplier`, style: "width:100%;box-sizing:border-box" });
      const note = el("input", { class: "up-text", type: "text", maxlength: "500", value: c.source_note || "", placeholder: "e.g. quote no. 4711, line 3", style: "width:100%;box-sizing:border-box" });
      // The answer the inputs exist for: landed unit cost in SEK, with the
      // arithmetic shown line by line, so nobody has to work it out.
      const preview = el("div", { style: "margin-top:0.6rem" });
      const msg = el("span", { role: "status", style: "font-size:0.8125rem" });
      const rateText = (cur) => (cur === "SEK" ? "" : rates[cur] ? ` × ${rates[cur].rate} (${cur} ${rates[cur].valid_on})` : ` × — (no ${cur} rate)`);
      const paint = () => {
        if (unit.value === "") { preview.replaceChildren(el("div", { style: `font-size:0.8125rem;${MUTED}` }, `No ${title.toLowerCase()} cost.`)); return; }
        const l = M().landed({ unit_cost: unit.value, unit_currency: unitCur.value, transport_pct: trans.value || 0, customs_pct: customs.value || 0 }, rates);
        const row = (label, how, value, strong) => el("div", { style: `display:grid;grid-template-columns:6.5rem 1fr auto;gap:0.5rem;font-size:0.8125rem;${strong ? "font-weight:700;border-top:1px solid var(--border,#e2e8f0);padding-top:0.3rem;margin-top:0.2rem" : ""}` },
          [el("span", { style: strong ? "" : MUTED }, label), el("span", { style: MUTED }, how), el("span", { style: "text-align:right;font-variant-numeric:tabular-nums" }, value)]);
        if (l.missing === "rate") {
          preview.replaceChildren(el("div", { style: "font-size:0.8125rem;color:#b45309" }, `No ${unitCur.value} rate yet — add one under Rates to see the landed cost.`));
          return;
        }
        preview.replaceChildren(el("div", { style: "display:flex;gap:1rem;align-items:stretch;flex-wrap:wrap;border:1px solid var(--border,#e2e8f0);border-radius:8px;padding:0.6rem 0.8rem;background:var(--bg,#fff)" }, [
          el("div", { style: "min-width:9rem" }, [
            el("div", { style: `font-size:0.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;${MUTED}` }, "Landed unit cost"),
            el("div", { style: "font-size:1.35rem;font-weight:700;font-variant-numeric:tabular-nums" }, M().sek(l.landedSEK)),
            el("div", { style: `font-size:0.75rem;${MUTED}` }, "per unit, ex VAT, today's rates"),
          ]),
          el("div", { style: "flex:1;min-width:16rem;display:flex;flex-direction:column;gap:0.15rem" }, [
            row("Unit", `${Number(unit.value)} ${unitCur.value}${rateText(unitCur.value)}`, M().sek(l.unitSEK)),
            row("Transport", Number(trans.value) ? `${Number(trans.value)} % of the unit cost` : "none", M().sek(l.transportSEK)),
            row("Customs", Number(customs.value) ? `${Number(customs.value)} % of the unit cost` : "none", M().sek(l.customsSEK)),
            row("Landed", "", M().sek(l.landedSEK), true),
          ]),
        ]));
      };
      [unit, unitCur, trans, customs].forEach((f) => f.addEventListener("input", paint));
      const save = el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: async () => {
        save.disabled = true; msg.textContent = ""; msg.style.color = "";
        try {
          await post(token, "setComponentCost", {
            component_id: comp.id, kind, unit_cost: unit.value, unit_currency: unitCur.value,
            transport_pct: trans.value || 0, customs_pct: customs.value || 0,
            quoted_on: quoted.value || null, supplier_name: supplier.value.trim() || null, source_note: note.value.trim() || null,
          });
          msg.textContent = "Saved.";
          refreshHistory();   // the save is now the newest line of the history
        } catch (ex) { msg.textContent = ex.message; msg.style.color = "#e05454"; }
        save.disabled = false;
      } }, `Save ${title.toLowerCase()}`);
      const clear = c.unit_cost !== undefined ? el("button", { class: "btn btn-sm", type: "button", onclick: async () => {
        if (!confirm(`Remove the ${title.toLowerCase()} cost of ${comp.name}?`)) return;
        try { await post(token, "setComponentCost", { component_id: comp.id, kind, clear: true }); reload(); } catch (ex) { msg.textContent = ex.message; }
      } }, "Clear") : null;
      paint();
      return el("div", { style: `flex:1;min-width:20rem;border:1px solid var(--border,#e2e8f0);border-radius:8px;padding:0.75rem 0.9rem;${kind === "estimated" ? "background:var(--bg-2,rgba(0,0,0,0.02))" : ""}` }, [
        el("div", { style: "font-weight:700;font-size:0.9rem" }, title),
        el("div", { style: `font-size:0.75rem;margin-bottom:0.6rem;${MUTED}` }, hint),
        el("div", { style: "display:flex;gap:0.8rem;flex-wrap:wrap;align-items:flex-end" }, [
          el("label", { style: LBL }, ["Unit cost", el("span", { style: "display:flex;gap:0.3rem" }, [unit, unitCur])]),
          el("label", { style: LBL }, ["Transport % of unit cost", trans]),
          el("label", { style: LBL }, ["Customs %", customs]),
          el("label", { style: LBL }, [kind === "actual" ? "Quote date" : "Date", quoted]),
        ]),
        preview,
        el("div", { style: "display:grid;grid-template-columns:1fr 1.6fr;gap:0.6rem;margin-top:0.5rem" }, [
          el("label", { style: LBL }, ["Supplier", supplier]),
          el("label", { style: LBL }, ["Source", note]),
        ]),
        c.source_document_version_id ? el("div", { style: `font-size:0.75rem;${MUTED}` }, "Read from a document — see Documents. " + (Array.isArray(c.evidence) && c.evidence[0] ? `“${c.evidence[0]}”` : "")) : null,
        el("div", { style: "display:flex;gap:0.5rem;align-items:center;margin-top:0.6rem" }, [save, clear, msg]),
        c.updated_at ? el("div", { style: `font-size:0.75rem;margin-top:0.3rem;${MUTED}` }, `Last changed ${String(c.updated_at).slice(0, 10)}`) : null,
      ]);
    };

    // replaceChildren() prints a null as the text "null" — filter first.
    container.replaceChildren(...[
      el("div", { style: "display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;margin-bottom:0.75rem" }, [
        el("span", { style: `font-size:0.8125rem;flex:1;${MUTED}` }, "Planning costs per unit, ex VAT, converted to SEK at dated rates. Transport and customs are a % of the unit cost. Every save is kept below."),
        window.PortalCost.openReadQuote ? el("button", { class: "btn btn-sm", type: "button", onclick: () => window.PortalCost.openReadQuote({ scope: comp, token, onSaved: reload }) }, "✨ Read from document") : null,
        el("button", { class: "btn btn-sm", type: "button", onclick: () => openRates(token, async () => { rates = await latestRates(token); reload(); }) }, "Rates…"),
      ]),
      data.has_real_children ? el("p", { style: "font-size:0.8125rem;color:#b45309;margin:0 0 0.75rem" }, "This has real children — in a cost view its cost is the sum of them, and the values here are ignored.") : null,
      el("div", { style: "display:flex;gap:0.8rem;flex-wrap:wrap" }, [section("actual", data.actual), section("estimated", data.estimated)]),
      histBox,
    ].filter(Boolean));
  }

  // 0049: every save and clear, newest first — kept by the database, never edited.
  // Landed is recomputed at today's rates so old and new prices compare directly.
  function historyList(history, rates) {
    if (!history.length) return null;
    const GRID = "display:grid;grid-template-columns:8.5rem 5.5rem 7rem 4.5rem 4.5rem 6.5rem minmax(7rem,1fr) minmax(8rem,1.4fr) 7rem;gap:0.5rem;align-items:center;padding:0.3rem 0.5rem;border-bottom:1px solid var(--border,#e2e8f0);font-size:0.8125rem";
    const when = (iso) => new Date(iso).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
    return el("div", { style: "margin-top:1rem" }, [
      el("div", { style: `font-size:0.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:0.3rem;${MUTED}` }, `History — ${history.length} save${history.length === 1 ? "" : "s"}`),
      el("div", { style: `${GRID};font-size:0.6875rem;font-weight:700;${MUTED}` },
        ["Saved", "Cost", "Unit", "Transport", "Customs", "Landed today", "Supplier", "Source", "By"].map((t) => el("span", {}, t))),
      ...history.map((h) => {
        const kind = el("span", { style: h.kind === "actual" ? "font-weight:600" : MUTED }, h.kind === "actual" ? "Actual" : "Estimated");
        if (h.event === "cleared") return el("div", { style: GRID }, [el("span", {}, when(h.saved_at)), kind, el("span", { style: "grid-column:span 6;color:#b45309" }, "cleared"), el("span", { style: MUTED }, h.saved_by_name || "—")]);
        const l = M().landed(h, rates);
        return el("div", { style: GRID }, [
          el("span", {}, when(h.saved_at)), kind,
          el("span", { style: "font-variant-numeric:tabular-nums" }, `${Number(h.unit_cost)} ${h.unit_currency}`),
          el("span", {}, `${Number(h.transport_pct || 0)} %`),
          el("span", {}, `${Number(h.customs_pct || 0)} %`),
          el("span", { style: "font-variant-numeric:tabular-nums" }, l.missing ? `no ${h.unit_currency} rate` : M().sek(l.landedSEK)),
          el("span", {}, h.supplier_name || "—"),
          el("span", { style: MUTED, title: h.source_note || "" }, [h.quoted_on ? `${h.quoted_on} · ` : "", h.source_note || (h.source_document_version_id ? "read from a document" : "—")]),
          el("span", { style: MUTED }, h.saved_by_name || "—"),
        ]);
      }),
    ]);
  }

  async function openRates(token, onChanged) {
    const overlay = el("div", { "data-modal-overlay": "", class: "modal-scrim" });
    const list = el("div", { style: "max-height:50vh;overflow-y:auto;border:1px solid var(--border,#e2e8f0);border-radius:6px" });
    const err = el("div", { role: "alert", style: "color:#e05454;font-size:0.8125rem;min-height:1rem" });
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); if (onChanged) onChanged(); };
    const onKey = (ev) => { if (ev.key === "Escape") close(); };
    const cur = el("select", { class: "up-text", "aria-label": "Currency" }, RATE_CUR.map((c) => el("option", { value: c }, c)));
    const date = el("input", { class: "up-text", type: "date", value: today(), "aria-label": "Valid from" });
    const rate = el("input", { class: "up-text", type: "number", min: "0", step: "any", placeholder: "e.g. 11.20", "aria-label": "SEK per unit", style: "width:8rem" });
    const src = el("input", { class: "up-text", type: "text", placeholder: "source (optional)", maxlength: "200", style: "flex:1;min-width:8rem" });
    const add = el("button", { class: "btn btn-sm btn-primary", type: "button" }, "Save rate");

    async function paint() {
      list.replaceChildren(el("div", { class: "loading", style: "padding:0.6rem" }, "Loading…"));
      try {
        const { rates } = await post(token, "listCurrencyRates", {});
        list.replaceChildren(...(rates.length ? rates.map((r) => el("div", { style: "display:grid;grid-template-columns:4rem 7rem 1fr auto;gap:0.6rem;align-items:center;padding:0.35rem 0.6rem;border-bottom:1px solid var(--border,#e2e8f0);font-size:0.8125rem" }, [
          el("strong", {}, r.currency), el("span", {}, r.valid_on),
          el("span", {}, [`1 ${r.currency} = ${Number(r.rate_to_sek)} SEK`, r.source_note ? el("span", { style: MUTED }, ` · ${r.source_note}`) : null]),
          el("button", { class: "btn btn-xs", type: "button", title: "Delete this rate", onclick: async () => {
            if (!confirm(`Delete the ${r.currency} rate of ${r.valid_on}?`)) return;
            try { await post(token, "deleteCurrencyRate", { id: r.id }); paint(); } catch (ex) { err.textContent = ex.message; }
          } }, "✕"),
        ])) : [el("div", { style: `padding:0.6rem;font-size:0.8125rem;${MUTED}` }, "No rates yet. SEK is always 1.")]));
      } catch (ex) { list.replaceChildren(el("div", { class: "error" }, ex.message)); }
    }
    add.onclick = async () => {
      err.textContent = ""; add.disabled = true;
      try { await post(token, "setCurrencyRate", { currency: cur.value, valid_on: date.value, rate_to_sek: rate.value, source_note: src.value.trim() || null }); rate.value = ""; src.value = ""; paint(); }
      catch (ex) { err.textContent = ex.message; }
      add.disabled = false;
    };
    overlay.append(el("div", { role: "dialog", "aria-modal": "true", "aria-label": "Currency rates", style: "background:var(--bg,#fff);border:1px solid var(--border,#e2e8f0);border-radius:10px;padding:1.1rem 1.25rem;width:min(640px,94vw);display:flex;flex-direction:column;gap:0.6rem" }, [
      el("div", { style: "display:flex;align-items:center" }, [el("strong", { style: "flex:1;font-size:1rem" }, "Currency rates"), el("button", { class: "btn btn-xs", type: "button", onclick: close }, "✕")]),
      el("div", { style: `font-size:0.8125rem;${MUTED}` }, "SEK per 1 unit of the currency, from the given date. Planning rates only — not bookkeeping. A cost view uses the latest rate on or before its rate date."),
      el("div", { style: "display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center" }, [cur, date, rate, src, add]),
      err, list,
    ]));
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    paint();
    rate.focus();
  }

  window.PortalCost = Object.assign(window.PortalCost || {}, { mountPartForm, openRates, latestRates });
})();
