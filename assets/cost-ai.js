/* Rushroom AB — Engineering & Compliance Platform: read costs from a quote (PROP-073)
 *
 *   PortalCost.openReadQuote({ scope: {id, name}, token, onSaved })
 *
 * Drop a quote, price list or invoice (PDF, image, Excel, Word). The AI reads
 * every priced line and matches it to a bought part under `scope` (an assembly,
 * or a single part); the user checks each line — part, price, currency,
 * evidence — and saves the ticked ones as Actual (default) or Estimated. The
 * document is kept on `scope` (never visible to suppliers) and every saved
 * cost points to it. Nothing is written before Save.
 */
(() => {
  const CUR = ["SEK", "EUR", "USD", "PLN"];
  const post = (token, action, body) => window.PortalAPI.post(token, action, body);
  const MUTED = "color:var(--muted,#8b93a1)";
  const TONE = { high: "#15803d", medium: "#b45309", low: "#b91c1c" };
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

  function openReadQuote({ scope, token, onSaved }) {
    const overlay = el("div", { "data-modal-overlay": "", class: "modal-scrim" });
    const body = el("div", { style: "display:flex;flex-direction:column;gap:0.6rem;min-height:0" });
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); document.removeEventListener("paste", onPaste); };
    const onKey = (ev) => { if (ev.key === "Escape") close(); };
    overlay.append(el("div", { role: "dialog", "aria-modal": "true", "aria-label": "Read costs from a document", style: "background:var(--bg,#fff);border:1px solid var(--border,#e2e8f0);border-radius:10px;padding:1.1rem 1.25rem;width:min(1180px,96vw);max-height:92vh;overflow:auto;display:flex;flex-direction:column;gap:0.6rem" }, [
      el("div", { style: "display:flex;align-items:center" }, [el("strong", { style: "flex:1;font-size:1rem" }, `✨ Read costs from a document — ${scope.name}`), el("button", { class: "btn btn-xs", type: "button", onclick: close }, "✕")]),
      body,
    ]));
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);

    // --- step 1: the file ----------------------------------------------------
    const file = el("input", { type: "file", accept: ".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.docx", style: "display:none" });
    const drop = el("div", { style: "border:2px dashed var(--border,#e2e8f0);border-radius:8px;padding:1.6rem;text-align:center;cursor:pointer;font-size:0.875rem", onclick: () => file.click(),
      ondragover: (ev) => { ev.preventDefault(); drop.style.borderColor = "var(--accent,#2fa564)"; },
      ondragleave: () => { drop.style.borderColor = "var(--border,#e2e8f0)"; },
      ondrop: (ev) => { ev.preventDefault(); const f = ev.dataTransfer?.files?.[0]; if (f) read(f); } }, [
      el("div", { style: "font-weight:600" }, "Drop a quote, price list or invoice, paste a screenshot (⌘V / Ctrl+V) — or click to choose"),
      el("div", { style: `font-size:0.8125rem;margin-top:0.3rem;${MUTED}` }, "PDF, image, Excel or Word. The AI only reads what the document states; you check every line before anything is saved."),
    ]);
    file.onchange = () => { if (file.files[0]) read(file.files[0]); };

    // A pasted screenshot is read like a dropped file — only while the dialog
    // is still waiting for one (not over the review table). The panel behind
    // yields the paste because this overlay carries data-modal-overlay.
    let waiting = true;
    function onPaste(ev) {
      if (!overlay.isConnected || !waiting) return;
      const item = [...(ev.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      if (!item) return;
      ev.preventDefault();
      const blob = item.getAsFile();
      const ext = (item.type.split("/")[1] || "png").replace("jpeg", "jpg");
      read(new File([blob], `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`, { type: item.type }));
    }
    document.addEventListener("paste", onPaste);
    body.replaceChildren(drop, file);

    async function read(f) {
      waiting = false;
      body.replaceChildren(el("div", { class: "loading" }, `Uploading ${f.name}…`));
      let path;
      try {
        const up = await post(token, "imageUploadUrl", { component_id: scope.id, fileName: f.name, contentType: f.type || "application/octet-stream" });
        const res = await fetch(up.signedUrl, { method: "PUT", headers: { "Content-Type": f.type || "application/octet-stream" }, body: f });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        path = up.path;
        body.replaceChildren(el("div", { class: "loading" }, `Reading ${f.name} — this can take a minute for a long price list…`));
        const out = await post(token, "extractCostsFromDocument", { scope_component_id: scope.id, storage_path: path, file_name: f.name });
        review(out, { path, fileName: f.name });
      } catch (ex) {
        body.replaceChildren(el("div", { class: "error" }, ex.message), el("button", { class: "btn btn-sm", type: "button", onclick: () => { waiting = true; body.replaceChildren(drop, file); } }, "Try another file"));
      }
    }

    // --- step 2: check every line ------------------------------------------
    function review(out, src) {
      const opts = out.candidates || [];
      const rows = [...(out.lines || []).map((l) => ({ ...l, take: true })), ...(out.unmatched || []).map((l) => ({ ...l, component_id: "", take: false }))];
      const kind = el("select", { class: "up-text", "aria-label": "Save as" }, [el("option", { value: "actual" }, "Save as Actual"), el("option", { value: "estimated" }, "Save as Estimated")]);
      const err = el("div", { role: "alert", style: "color:#e05454;font-size:0.8125rem;min-height:1rem" });
      const save = el("button", { class: "btn btn-sm btn-primary", type: "button" }, "Save ticked lines");
      const GRID = "display:grid;grid-template-columns:1.6rem minmax(12rem,1.2fr) minmax(10rem,1fr) 10rem 7rem 5rem 7rem 4.5rem;gap:0.4rem;align-items:center;padding:0.3rem 0.4rem;border-bottom:1px solid var(--border,#e2e8f0);font-size:0.8125rem";

      const lineRow = (r) => {
        const partSel = el("select", { class: "up-text", style: "width:100%;font-size:0.8125rem", "aria-label": "Part", onchange: (ev) => { r.component_id = ev.target.value; r.take = !!ev.target.value; tick.checked = r.take; } },
          [el("option", { value: "" }, "— not one of ours —"), ...opts.map((c) => el("option", { value: c.id, selected: c.id === r.component_id ? "selected" : null }, `${c.name} · ${c.part_number}`))]);
        const tick = el("input", { type: "checkbox", checked: r.take, "aria-label": "Save this line", onchange: (ev) => { r.take = ev.target.checked; } });
        const price = el("input", { class: "up-text", type: "number", min: "0", step: "any", value: r.unit_cost, style: "width:5.5rem;font-size:0.8125rem", "aria-label": "Unit cost", onchange: (ev) => { r.unit_cost = Number(ev.target.value); } });
        const cur = el("select", { class: "up-text", style: "font-size:0.75rem", "aria-label": "Currency", onchange: (ev) => { r.unit_currency = ev.target.value; } }, CUR.map((c) => el("option", { value: c, selected: c === r.unit_currency ? "selected" : null }, c)));
        return el("div", { style: GRID }, [
          tick, partSel,
          el("span", { title: r.evidence ? `“${r.evidence}”` : "" }, [r.description || "—", el("div", { style: `font-size:0.75rem;${MUTED}` }, r.as_printed + (r.per_quantity > 1 ? ` · price per ${r.per_quantity}, shown per unit` : ""))]),
          el("span", { style: "display:flex;gap:0.2rem" }, [price, cur]),
          el("span", {}, r.transport_cost ? `${r.transport_cost} ${r.transport_currency}` : "—"),
          el("span", {}, r.customs_pct ? `${r.customs_pct} %` : "—"),
          el("span", {}, r.quote_date || "—"),
          el("span", { style: `font-weight:700;font-size:0.75rem;color:${TONE[r.confidence] || TONE.low}`, title: r.evidence ? `Evidence: “${r.evidence}”` : "" }, r.confidence),
        ]);
      };

      body.replaceChildren(...[
        el("div", { style: "display:flex;gap:1rem;flex-wrap:wrap;font-size:0.8125rem" }, [
          el("span", {}, [el("strong", {}, out.supplier || "Unknown supplier"), ` · ${String(out.document_type || "").replace("_", " ")} · ${out.document_date || "no date"}`]),
          out.freight_note ? el("span", { style: "color:#b45309" }, `Freight per shipment, not on the lines: ${out.freight_note}`) : null,
          out.notes ? el("span", { style: MUTED }, out.notes) : null,
        ]),
        el("div", { style: `font-size:0.8125rem;${MUTED}` }, `${(out.lines || []).length} line${(out.lines || []).length === 1 ? "" : "s"} matched to our parts, ${(out.unmatched || []).length} not matched (choose a part to save one). Hover a line for the text it was read from.`),
        el("div", { style: `${GRID};font-size:0.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;${MUTED}` }, ["", "Our part", "In the document", "Unit cost", "Transport", "Customs", "Date", "Sure?"].map((t) => el("span", {}, t))),
        ...rows.map(lineRow),
        (out.rejected || []).length ? el("div", { style: "font-size:0.8125rem;color:#b45309" }, `Could not use: ${out.rejected.map((r) => `${r.description || r.as_printed} (${r.reason})`).join("; ")}`) : null,
        err,
        el("div", { style: "display:flex;gap:0.5rem;justify-content:flex-end;align-items:center" }, [
          el("span", { style: `font-size:0.75rem;${MUTED};flex:1` }, `The document is kept on ${scope.name} (not visible to suppliers) and each saved cost points to it.`),
          kind, el("button", { class: "btn btn-sm", type: "button", onclick: close }, "Cancel"), save,
        ]),
      ].filter(Boolean));

      save.onclick = async () => {
        err.textContent = "";
        const chosen = rows.filter((r) => r.take && r.component_id);
        if (!chosen.length) { err.textContent = "Tick at least one line with a part."; return; }
        const dupe = chosen.find((r, i) => chosen.findIndex((x) => x.component_id === r.component_id) !== i);
        if (dupe) { err.textContent = `Two ticked lines are matched to the same part (${opts.find((c) => c.id === dupe.component_id)?.name}). Keep one.`; return; }
        if (chosen.some((r) => !(r.unit_cost >= 0) || !CUR.includes(r.unit_currency))) { err.textContent = "Every ticked line needs a price and a currency."; return; }
        save.disabled = true; save.textContent = "Saving…";
        try {
          const doc = await post(token, "uploadAndLinkComponentDocument", {
            component_id: scope.id, storage_path: src.path, file_name: src.fileName,
            doc_name: `${(out.document_type || "Document").replace("_", " ")} — ${out.supplier || "supplier"}${out.document_date ? " " + out.document_date : ""}`,
            doc_category: "Supplier pricing", comp_category: "other", label: "Read for costs", is_supplier_visible: false,
          });
          const r = await post(token, "setComponentCosts", {
            kind: kind.value, source_document_version_id: doc.version_id || null,
            items: chosen.map((x) => ({
              component_id: x.component_id, unit_cost: x.unit_cost, unit_currency: x.unit_currency,
              transport_cost: x.transport_cost || 0, transport_currency: x.transport_currency || x.unit_currency,
              customs_pct: x.customs_pct || 0, quoted_on: x.quote_date || null,
              source_note: `${out.supplier || "Supplier"}: ${x.as_printed || x.description}`.slice(0, 500),
              evidence: x.evidence ? [x.evidence] : null,
            })),
          });
          close();
          if (onSaved) onSaved(r.saved);
        } catch (ex) { err.textContent = ex.message; save.disabled = false; save.textContent = "Save ticked lines"; }
      };
    }
  }

  window.PortalCost = Object.assign(window.PortalCost || {}, { openReadQuote });
})();
