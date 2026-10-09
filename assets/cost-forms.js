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

  async function mountPartForm(container, comp, token) {
    container.replaceChildren(el("div", { class: "loading" }, "Loading cost…"));
    let data, rates;
    try { [data, rates] = await Promise.all([post(token, "getComponentCost", { component_id: comp.id }), latestRates(token)]); }
    catch (ex) { container.replaceChildren(el("div", { class: "error" }, `Could not load the cost: ${ex.message}`)); return; }
    const c = data.cost || {};
    const unit = numInput(c.unit_cost, "Unit cost"), unitCur = curSelect(c.unit_currency || "SEK");
    const trans = numInput(c.transport_cost, "Transport per unit"), transCur = curSelect(c.transport_currency || c.unit_currency || "SEK");
    const customs = el("input", { class: "up-text", type: "number", min: "0", max: "100", step: "any", value: c.customs_pct ?? "", "aria-label": "Customs %", style: "width:6rem" });
    const quoted = el("input", { class: "up-text", type: "date", value: c.quoted_on || "" });
    const note = el("input", { class: "up-text", type: "text", maxlength: "500", value: c.source_note || "", placeholder: "e.g. quote Häfele 2026-10", style: "width:100%;box-sizing:border-box" });
    const preview = el("div", { style: "font-size:0.875rem;margin-top:0.25rem" });
    const msg = el("div", { role: "status", style: "font-size:0.8125rem;min-height:1.1rem" });
    const save = el("button", { class: "btn btn-sm btn-primary", type: "button" }, "Save cost");
    const clear = el("button", { class: "btn btn-sm", type: "button", disabled: !data.cost }, "Clear");

    const paintPreview = () => {
      if (unit.value === "") { preview.replaceChildren(el("span", { style: MUTED }, "No cost entered.")); return; }
      const l = M().landed({ unit_cost: unit.value, unit_currency: unitCur.value, transport_cost: trans.value || 0, transport_currency: transCur.value, customs_pct: customs.value || 0 }, rates);
      preview.replaceChildren(l.missing === "rate"
        ? el("span", { style: "color:#b45309" }, `No ${[unitCur.value, transCur.value].filter((x) => x !== "SEK" && !rates[x]).join(" / ")} rate yet — add one under Rates.`)
        : el("span", {}, ["Landed: ", el("strong", {}, M().sek(l.landedSEK)), el("span", { style: MUTED }, ` per unit ex VAT (unit ${M().sek(l.unitSEK)} · transport ${M().sek(l.transportSEK)} · customs ${M().sek(l.customsSEK)}) at today's rates`)]));
    };
    [unit, unitCur, trans, transCur, customs].forEach((f) => f.addEventListener("input", paintPreview));

    save.onclick = async () => {
      save.disabled = true; msg.textContent = "";
      try {
        await post(token, "setComponentCost", {
          component_id: comp.id, unit_cost: unit.value, unit_currency: unitCur.value,
          transport_cost: trans.value || 0, transport_currency: transCur.value, customs_pct: customs.value || 0,
          quoted_on: quoted.value || null, source_note: note.value.trim() || null,
        });
        msg.textContent = "Saved."; clear.disabled = false;
      } catch (ex) { msg.textContent = ex.message; msg.style.color = "#e05454"; }
      save.disabled = false;
    };
    clear.onclick = async () => {
      if (!confirm(`Remove the cost of ${comp.name}?`)) return;
      try { await post(token, "setComponentCost", { component_id: comp.id, clear: true }); mountPartForm(container, comp, token); }
      catch (ex) { msg.textContent = ex.message; }
    };

    container.replaceChildren(
      el("p", { style: `font-size:0.8125rem;margin:0 0 0.75rem;${MUTED}` }, "Planning cost per unit, ex VAT. Customs is a % of the unit cost. Each amount in its own currency, converted to SEK at dated rates."),
      data.has_real_children ? el("p", { style: "font-size:0.8125rem;color:#b45309;margin:0 0 0.75rem" }, "This has real children — in a cost view its cost is the sum of them, and the value here is ignored.") : null,
      el("div", { style: "display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-end" }, [
        el("label", { style: LBL }, ["Unit cost", el("span", { style: "display:flex;gap:0.3rem" }, [unit, unitCur])]),
        el("label", { style: LBL }, ["Transport per unit", el("span", { style: "display:flex;gap:0.3rem" }, [trans, transCur])]),
        el("label", { style: LBL }, ["Customs %", customs]),
        el("label", { style: LBL }, ["Quote date", quoted]),
      ]),
      el("label", { style: `${LBL};margin-top:0.6rem` }, ["Source", note]),
      preview,
      el("div", { style: "display:flex;gap:0.5rem;align-items:center;margin-top:0.75rem" }, [save, clear, el("button", { class: "btn btn-sm", type: "button", onclick: () => openRates(token, async () => { rates = await latestRates(token); paintPreview(); }) }, "Rates…"), msg]),
      data.cost ? el("div", { style: `font-size:0.75rem;margin-top:0.4rem;${MUTED}` }, `Last changed ${String(data.cost.updated_at || "").slice(0, 10)}`) : null,
    );
    paintPreview();
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
