/* Rushroom AB — Engineering & Compliance Platform: cost view of an assembly (PROP-072)
 *
 *   PortalCost.mountAssembly(container, comp, token, { pickComponent })
 *
 * The BOM rolled up to landed SEK ex VAT at a chosen rate date; inline what-if
 * (cost, currency, swap a part) computed in the browser and never saved unless
 * "Save" is pressed on that row; baselines to compare against, with each change
 * split into quantity, price and exchange rate; opportunities. Arithmetic is in
 * cost-math.js. Loaded on index.html only, never on supplier.html.
 */
(() => {
  const CUR = ["SEK", "EUR", "USD", "PLN"];
  const M = () => window.PortalCostMath;
  const post = (token, action, body) => window.PortalAPI.post(token, action, body);
  const MUTED = "color:var(--muted,#8b93a1)";
  const WARN = "#b45309";
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
  const pct = (v) => `${(v * 100).toFixed(1)} %`;
  const signed = (v) => (v > 0.005 ? "+" : "") + M().sek(v);

  async function mountAssembly(container, comp, token, opts = {}) {
    const st = { view: null, rateDate: new Date().toISOString().slice(0, 10), overrides: {}, swaps: {}, baseline: null, baselines: [] };

    async function load() {
      container.replaceChildren(el("div", { class: "loading" }, "Rolling up the cost…"));
      try {
        const [view, bl] = await Promise.all([
          post(token, "getCostView", { root_component_id: comp.id, rate_date: st.rateDate }),
          post(token, "listCostBaselines", { root_component_id: comp.id }),
        ]);
        st.view = view; st.baselines = bl.baselines || [];
        render();
      } catch (ex) { container.replaceChildren(el("div", { class: "error" }, `Could not load the cost view: ${ex.message}`)); }
    }

    const costOf = (line) => ({ unit_cost: line.unit_cost ?? 0, unit_currency: line.unit_currency || "SEK", transport_pct: line.transport_pct ?? 0, customs_pct: line.customs_pct ?? 0 });
    const setWhatIf = (line, patch) => { st.overrides[line.component_id] = { ...costOf(line), ...(st.overrides[line.component_id] || {}), ...patch }; render(); };

    function costCells(line) {
      const ro = !!line.swapped_from;   // a swapped-in part shows its own cost; change it on that part
      const num = (key, w) => el("input", { class: "up-text", type: "number", min: "0", step: "any", disabled: ro, value: line[key] ?? "", style: `width:${w};font-size:0.8125rem`, "aria-label": key, onchange: (ev) => setWhatIf(line, { [key]: ev.target.value === "" ? 0 : Number(ev.target.value) }) });
      const cur = (key) => el("select", { class: "up-text", disabled: ro, style: "font-size:0.75rem", "aria-label": key, onchange: (ev) => setWhatIf(line, { [key]: ev.target.value }) }, CUR.map((c) => el("option", { value: c, selected: (line[key] || "SEK") === c ? "selected" : null }, c)));
      return [
        el("span", { style: "display:flex;gap:0.2rem" }, [num("unit_cost", "5.5rem"), cur("unit_currency")]),
        num("transport_pct", "3.5rem"),
        num("customs_pct", "3.5rem"),
      ];
    }

    function render() {
      const { view } = st;
      // PROP-073: both roll-ups — actual (what-if applies here) and estimated.
      const ea = M().estimateVsActual(view, { overrides: st.overrides, swaps: st.swaps });
      const result = ea.actual;
      const estLine = (path) => ea.estimatedByPath[path];
      const estGroup = (path) => ea.estimatedGroupByPath[path];
      const deltaCell = (act, est) => {
        if (act === null || est === null || est === undefined) return el("span", { style: "text-align:right" }, "");
        const d = act - est, rel = est ? d / est : 0;
        return el("span", { style: `text-align:right;${rel > M().OVER_ESTIMATE ? "color:#b91c1c;font-weight:600" : rel < -0.005 ? "color:#15803d" : ""}`, title: est ? `${(rel * 100).toFixed(1)} % vs estimate` : "" }, signed(d));
      };
      const cmp = st.baseline ? M().compare(result, view.rates, st.baseline) : null;
      const deltaOf = cmp ? Object.fromEntries(cmp.rows.map((r) => [r.path, r])) : {};
      const opp = M().opportunities(result, ea.estimatedByPath);
      const whatIfs = Object.keys(st.overrides).length + Object.keys(st.swaps).length;
      const share = (v) => (result.total ? pct(v / result.total) : "—");
      const GRID = `display:grid;grid-template-columns:minmax(12rem,1fr) 3.5rem 9rem 4.5rem 4.5rem 7rem 7.5rem 7rem 6.5rem 4rem${cmp ? " 7rem" : ""} 8rem;gap:0.4rem;align-items:center;padding:0.25rem 0.4rem;font-size:0.8125rem;border-bottom:1px solid var(--border,#e2e8f0)`;

      const rateDate = el("input", { class: "up-text", type: "date", value: st.rateDate, "aria-label": "Rate date", onchange: (ev) => { st.rateDate = ev.target.value; load(); } });
      const used = Object.entries(view.rates || {}).filter(([c, r]) => c !== "SEK" && r).map(([c, r]) => `${c} ${r.rate} (${r.valid_on})`).join(" · ");
      const blSelect = el("select", { class: "up-text", "aria-label": "Compare with", onchange: async (ev) => {
        if (!ev.target.value) { st.baseline = null; render(); return; }
        try { st.baseline = (await post(token, "getCostBaseline", { id: ev.target.value })).baseline; render(); } catch (ex) { alert(ex.message); }
      } }, [el("option", { value: "" }, "Compare with: —"), ...st.baselines.map((b) => el("option", { value: b.id, selected: st.baseline && st.baseline.id === b.id ? "selected" : null }, `${b.name} · ${String(b.created_at).slice(0, 10)} · ${M().sek(Number(b.total_sek))}`))]);
      const saveBl = el("button", { class: "btn btn-sm", type: "button", onclick: async () => {
        const name = prompt(whatIfs ? `Name this baseline (it includes ${whatIfs} what-if change${whatIfs === 1 ? "" : "s"})` : "Name this baseline", `${comp.name} · ${st.rateDate}`);
        if (!name) return;
        try {
          await post(token, "saveCostBaseline", { root_component_id: comp.id, name, rate_date: st.rateDate, rates: view.rates, total_sek: result.total, incomplete: result.incomplete, lines: M().baselineLines(result) });
          st.baselines = (await post(token, "listCostBaselines", { root_component_id: comp.id })).baselines || []; render();
        } catch (ex) { alert(ex.message); }
      } }, "Save baseline");

      const card = (label, value, sub, tone) => el("div", { style: "padding:0.5rem 0.75rem;border:1px solid var(--border,#e2e8f0);border-radius:8px;min-width:9rem" }, [
        el("div", { style: `font-size:0.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;${MUTED}` }, label),
        el("div", { style: `font-size:1.05rem;font-weight:700;${tone ? `color:${tone}` : ""}` }, value),
        sub ? el("div", { style: `font-size:0.75rem;${MUTED}` }, sub) : null,
      ]);

      const rows = [...result.groups.map((g) => ({ g, seq: g.seq })), ...result.lines.map((l) => ({ l, seq: l.seq }))].sort((a, b) => a.seq - b.seq);
      const tableRows = rows.map(({ g, l }) => {
        const indent = `padding-left:${(g || l).depth * 1.1}rem`;
        if (g) return el("div", { style: `${GRID};background:var(--bg-2,rgba(0,0,0,0.03));font-weight:700` }, [
          el("span", { style: indent }, [g.name, g.incomplete ? el("span", { style: `color:${WARN};font-weight:400` }, " · incomplete") : null]),
          el("span", {}, `×${g.qty}`), el("span"), el("span"), el("span"), el("span"),
          el("span", { style: "text-align:right" }, M().sek(g.subtotalSEK)),
          el("span", { style: "text-align:right;font-weight:400" }, estGroup(g.path) ? M().sek(estGroup(g.path).subtotalSEK) : "—"),
          deltaCell(g.subtotalSEK, estGroup(g.path) ? estGroup(g.path).subtotalSEK : null),
          el("span", { style: "text-align:right" }, share(g.subtotalSEK)),
          cmp ? el("span") : null, el("span"),
        ].filter((x) => x !== null));
        const d = deltaOf[l.path];
        const changed = l.overridden || l.swapped_from;
        return el("div", { style: `${GRID}${changed ? `;background:${WARN}12` : ""}` }, [
          el("span", { style: indent, title: l.part_number }, [l.name, l.swapped_from ? el("span", { style: `color:${WARN}` }, " · swapped (what-if)") : null]),
          el("span", {}, `×${l.qty}`),
          ...costCells(l),
          el("span", { style: `text-align:right${l.missing ? `;color:${WARN}` : ""}` }, l.missing === "cost" ? "no cost" : l.missing === "rate" ? "no rate" : M().sek(l.landedSEK)),
          el("span", { style: "text-align:right;font-weight:600" }, l.missing ? "—" : M().sek(l.lineSEK)),
          el("span", { style: `text-align:right;${MUTED}` }, estLine(l.path) && !estLine(l.path).missing ? M().sek(estLine(l.path).lineSEK) : "—"),
          deltaCell(l.missing ? null : l.lineSEK, estLine(l.path) && !estLine(l.path).missing ? estLine(l.path).lineSEK : null),
          el("span", { style: "text-align:right" }, l.missing ? "" : share(l.lineSEK)),
          cmp ? el("span", { style: "text-align:right", title: d ? `qty ${M().sek(d.qty)} · price ${M().sek(d.price)} · rate ${M().sek(d.rate)}` : "" }, d && d.status !== "same" ? `${d.status === "added" ? "new " : d.status === "swapped" ? "swap " : ""}${signed(d.delta)}` : "") : null,
          el("span", { style: "display:flex;gap:0.2rem;justify-content:flex-end" }, [
            l.overridden ? el("button", { class: "btn btn-xs", type: "button", title: "Write this cost to the part", onclick: async () => {
              try { await post(token, "setComponentCost", { component_id: l.component_id, ...st.overrides[l.component_id] }); delete st.overrides[l.component_id]; load(); } catch (ex) { alert(ex.message); }
            } }, "Save") : null,
            changed ? el("button", { class: "btn btn-xs", type: "button", title: "Undo this what-if", onclick: () => { delete st.overrides[l.component_id]; if (l.swapped_from) delete st.swaps[l.swapped_from]; render(); } }, "↺") : null,
            !l.swapped_from && opts.pickComponent ? el("button", { class: "btn btn-xs", type: "button", title: "What if a different part were used here?", onclick: () => opts.pickComponent({ title: `Swap “${l.name}” (what-if)`, excludeIds: [l.component_id, comp.id] }, async (picked) => {
              const { cost } = await post(token, "getComponentCost", { component_id: picked.id });
              st.swaps[l.component_id] = { node: { id: picked.id, part_number: picked.part_number, name: picked.name }, cost }; render();
            }) }, "Swap…") : null,
          ].filter(Boolean)),
        ].filter((x) => x !== null));
      });
      const removed = cmp ? cmp.rows.filter((r) => r.status === "removed") : [];

      container.replaceChildren(...[
        el("div", { style: "display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;margin-bottom:0.6rem" }, [
          el("label", { style: `font-size:0.75rem;font-weight:600;${MUTED};display:flex;gap:0.3rem;align-items:center` }, ["Rates at", rateDate]),
          el("span", { style: `font-size:0.75rem;${MUTED}` }, used || "no foreign rates yet"),
          el("button", { class: "btn btn-sm", type: "button", onclick: () => window.PortalCost.openRates(token, load) }, "Rates…"),
          el("span", { style: `font-size:0.75rem;${MUTED}` }, view.rates_updated_on ? `rates last updated ${view.rates_updated_on}` : ""),
          el("span", { style: "flex:1" }),
          window.PortalCost.openReadQuote ? el("button", { class: "btn btn-sm", type: "button", title: "Read prices from a quote, price list or invoice — one document, many parts", onclick: () => window.PortalCost.openReadQuote({ scope: comp, token, onSaved: load }) }, "✨ Read a quote…") : null,
          blSelect, saveBl,
        ]),
        el("div", { style: "display:flex;gap:0.6rem;flex-wrap:wrap;margin-bottom:0.75rem" }, [
          card("Actual ex VAT", M().sek(result.total), result.incomplete ? `incomplete — ${result.missing.length} line${result.missing.length === 1 ? "" : "s"} without cost or rate` : "complete", result.incomplete ? WARN : null),
          card("Estimated", M().sek(ea.estimated.total), ea.estimated.incomplete ? `incomplete — ${ea.estimated.missing.length} without an estimate` : "complete", ea.estimated.incomplete ? WARN : null),
          card("Actual vs estimated", signed(ea.delta), ea.estimated.total ? `${((ea.delta / ea.estimated.total) * 100).toFixed(1)} %` : "", ea.delta > 0.005 ? "#b91c1c" : ea.delta < -0.005 ? "#15803d" : null),
          card("Price", M().sek(result.parts.price), result.total ? share(result.parts.price) : ""),
          card("Transport", M().sek(result.parts.transport), result.total ? share(result.parts.transport) : ""),
          card("Customs", M().sek(result.parts.customs), result.total ? share(result.parts.customs) : ""),
          whatIfs ? card("What-if", `${whatIfs} change${whatIfs === 1 ? "" : "s"}`, el("button", { class: "btn btn-xs", type: "button", onclick: () => { st.overrides = {}; st.swaps = {}; render(); } }, "Reset all"), WARN) : null,
          cmp ? card(`Since ${st.baseline.name}`, signed(cmp.delta), `quantity ${signed(cmp.qty)} · price ${signed(cmp.price)} · rate ${signed(cmp.rate)}`) : null,
        ].filter(Boolean)),
        el("div", { style: `${GRID};font-size:0.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;${MUTED}` },
          ["Item", "Qty", "Unit cost", "Transport %", "Customs %", "Landed / unit", "Actual", "Estimated", "Δ est.", "Share", cmp ? "Δ baseline" : null, ""].filter((x) => x !== null).map((t) => el("span", {}, t))),
        ...tableRows,
        removed.length ? el("div", { style: `font-size:0.8125rem;margin-top:0.5rem;color:${WARN}` }, `Removed since the baseline: ${removed.map((r) => `${r.line.name} (${signed(r.delta)})`).join(", ")}`) : null,
        el("div", { style: "margin-top:0.9rem;padding:0.6rem 0.8rem;border:1px solid var(--border,#e2e8f0);border-radius:8px;font-size:0.8125rem;display:flex;flex-direction:column;gap:0.3rem" }, [
          el("strong", {}, "Opportunities"),
          opp.pareto.length ? el("div", {}, `${opp.pareto.length} line${opp.pareto.length === 1 ? "" : "s"} make ${pct(opp.paretoShare)} of the cost: ${opp.pareto.map((l) => l.name).join(", ")}.`) : null,
          opp.overhead.length ? el("div", {}, `Transport + customs above ${pct(M().OVERHEAD_SHARE)} of the unit price: ${opp.overhead.map((l) => l.name).join(", ")}.`) : null,
          Object.keys(opp.exposure).length ? el("div", {}, `Currency exposure: ${Object.entries(opp.exposure).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${pct(v)}`).join(" · ")}.`) : null,
          opp.overEstimate.length ? el("div", { style: "color:#b91c1c" }, `Actual above estimate by more than ${pct(M().OVER_ESTIMATE)}: ${opp.overEstimate.map((l) => l.name).join(", ")}.`) : null,
          opp.missing.length ? el("div", { style: `color:${WARN}` }, `No cost or rate: ${opp.missing.map((l) => l.name).join(", ")}.`) : null,
          el("div", { style: `font-size:0.75rem;${MUTED}` }, "In-the-box contents are inside their parent's price. Hub and site work are not costed yet."),
        ].filter(Boolean)),
      ].filter(Boolean));
    }
    await load();
  }

  window.PortalCost = Object.assign(window.PortalCost || {}, { mountAssembly });
})();
