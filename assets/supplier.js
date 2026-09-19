/* Rushroom AB — Engineering & Compliance Platform (supplier view)
 * Slimmed page: only supplier-relevant documents and supplier step statuses,
 * plus a declaration-upload panel. Reuses shared helpers from window.Portal
 * (app.js). Nothing internal is shown.
 */
(() => {
  "use strict";
  if (!document.body || document.body.dataset.page !== "supplier") return;

  const P = window.Portal;
  if (!P) { console.error("supplier.js requires app.js (window.Portal) to load first"); return; }
  const { el, CFG, setupGate, loadSteps, summaryTiles, phaseOverview, phaseToolbar, phaseSections, documentLibrary, sourceNotice } = P;

  const init = () => {
    if (P.apiEnabled && P.apiEnabled()) P.setupApiGate("supplier", () => P.renderApi("supplier", "#steps-panel"));
    else setupGate(render); // read-only fallback
  };

  async function render() {
    P.wireTabs(P.$("#tablist"));
    await refreshSteps();
    P.$("#documents-panel").replaceChildren(el("div", {}, [
      uploadPanel(),
      documentLibrary("supplier"),
    ]));
  }

  /* Declaration upload — links out to a configured form/endpoint (Google Form,
   * Formspree, Drive upload-request…), since GitHub Pages can't accept uploads. */
  function uploadPanel() {
    if (!CFG.supplierUploadUrl) return null;
    return el("div", { class: "card upload-card" }, [
      el("h3", {}, "Submit your declaration"),
      el("p", { class: "muted", style: "margin:0.25rem 0 1rem" },
        "Return your signed Supplier Declaration of Compliance, test reports, datasheets and RoHS/REACH declarations here."),
      el("a", { class: "btn btn-primary", href: CFG.supplierUploadUrl, target: "_blank", rel: "noopener" }, "Upload declaration ↗"),
    ]);
  }

  async function refreshSteps() {
    const mount = P.$("#steps-panel");
    mount.replaceChildren(el("div", { class: "loading" }, "Loading status…"));
    try {
      const { steps, source } = await loadSteps();
      const supplierSteps = steps.filter((s) => s.audience.includes("supplier"));
      if (!supplierSteps.length) {
        mount.replaceChildren(el("div", { class: "empty" }, "No supplier actions are defined yet."));
        return;
      }
      const tools = el("div", { class: "row-tools" }, [
        el("button", { class: "btn btn-sm", type: "button", onclick: refreshSteps }, "↻ Reload status"),
        el("button", { class: "btn btn-sm", type: "button", onclick: () => window.print() }, "🖨 Print / Save PDF"),
        el("span", { class: "spacer" }),
        el("span", { class: "updated" }, `${source === "live" ? "Live" : "Snapshot"} · loaded ${new Date().toLocaleTimeString("en-GB")}`),
      ]);
      const frag = el("div", {}, [
        sourceNotice(source),
        tools,
        summaryTiles(supplierSteps),
        phaseToolbar(),
        phaseOverview(supplierSteps),
        phaseSections(supplierSteps),
      ]);
      mount.replaceChildren(...frag.childNodes);
    } catch (err) {
      mount.replaceChildren(el("div", { class: "error" }, `Couldn't load status: ${err.message}.`));
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
