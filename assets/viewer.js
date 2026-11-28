/* Rushroom AB — Engineering & Compliance Platform: in-portal document viewer
 * Renders PDF / Word (.docx) / Excel (.xlsx) inline in a modal, client-side —
 * the file bytes are fetched from Supabase straight into the browser and rendered
 * locally (nothing is sent to any third-party viewer). The rendering libraries
 * (mammoth for .docx, SheetJS for .xlsx) are lazy-loaded from a CDN on first use.
 * Exposes window.PortalViewer.open(doc).
 */
(() => {
  "use strict";

  const CDN = {
    mammoth: "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js",
    xlsx: "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
    marked: "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js",
  };
  // Some AI drafts contain literal \uXXXX escapes — turn them back into real chars.
  const unescapeUnicode = (s) => (s || "").replace(/\\u([0-9a-fA-F]{4})/g, (_, hx) => String.fromCharCode(parseInt(hx, 16)));
  const scriptPromises = {};
  function loadScript(src) {
    if (!scriptPromises[src]) {
      scriptPromises[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { delete scriptPromises[src]; reject(new Error("Couldn't load viewer library (offline?)")); };
        document.head.appendChild(s);
      });
    }
    return scriptPromises[src];
  }

  /* tiny DOM helper */
  function h(tag, attrs, kids) {
    const n = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(kids || [])) {
      if (c == null) continue;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return n;
  }

  const extOf = (s) => (s || "").split("?")[0].split("#")[0].split(".").pop().toLowerCase();
  const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"]);

  let cleanup = null, lastFocus = null;
  function close() {
    document.removeEventListener("keydown", onKey);
    const m = document.getElementById("doc-modal");
    if (m) m.remove();
    if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function onKey(e) {
    if (e.key === "Escape") close();
    if (e.key === "Tab") {
      // simple focus trap within the dialog
      const f = [...document.querySelectorAll("#doc-modal button, #doc-modal a[href], #doc-modal [tabindex]")].filter((x) => !x.disabled);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  /**
   * Render a document into ANY element and return a disposer.
   *
   * This used to live inside open(), which meant the only way to show a file
   * was to put a full-screen modal over whatever you were already looking at.
   * PROP-047 needs the same rendering embedded in the drawing surface, so the
   * chain moved here and open() became a wrapper around it.
   *
   * The disposer is RETURNED rather than written to the module-level `cleanup`:
   * an embedded render and the modal can now exist at once, and if the embedded
   * one stole that slot, closing the modal would revoke the embedded blob URL
   * and the drawing would silently go blank.
   */
  async function render(target, doc) {
    const url = doc.open_url || doc.url;
    if (!url) return () => {};
    const ext = extOf(doc.storage_path || doc.name || url);
    let dispose = () => {};
    const fallback = (msgEl) => target.replaceChildren(h("div", { class: "viewer-msg" }, msgEl));

    try {
      if (ext === "pdf") {
        const buf = await fetchBytes(url);
        const blobUrl = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
        dispose = () => URL.revokeObjectURL(blobUrl);
        target.replaceChildren(h("iframe", { class: "viewer-frame", src: blobUrl, title: doc.name || "PDF preview" }));
      } else if (IMAGE_EXT.has(ext)) {
        // Drawings arrive as scans and photographs at least as often as PDFs.
        // Without this branch those fell through to "no inline preview", which
        // is the one case where a preview matters most.
        const buf = await fetchBytes(url);
        const blobUrl = URL.createObjectURL(new Blob([buf]));
        dispose = () => URL.revokeObjectURL(blobUrl);
        target.replaceChildren(h("img", {
          class: "viewer-frame viewer-image", src: blobUrl,
          alt: doc.name || "Drawing", loading: "lazy",
        }));
      } else if (ext === "docx") {
        const buf = await fetchBytes(url);
        await loadScript(CDN.mammoth);
        const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
        target.replaceChildren(h("div", { class: "doc-render", html: result.value || "<p>(empty document)</p>" }));
      } else if (ext === "md" || ext === "markdown") {
        const buf = await fetchBytes(url);
        const text = unescapeUnicode(new TextDecoder().decode(new Uint8Array(buf)));
        await loadScript(CDN.marked);
        const html = window.marked.parse(text || "");
        target.replaceChildren(h("div", { class: "doc-render markdown-render", html: html || "<p>(empty document)</p>" }));
      } else if (ext === "txt") {
        const buf = await fetchBytes(url);
        const text = unescapeUnicode(new TextDecoder().decode(new Uint8Array(buf)));
        target.replaceChildren(h("pre", { class: "viewer-text", style: "white-space:pre-wrap; word-break:break-word; padding:1rem; background:#f7f9fc; border-radius:8px" }, text));
      } else if (ext === "xlsx" || ext === "xls" || ext === "csv") {
        const buf = await fetchBytes(url);
        await loadScript(CDN.xlsx);
        renderWorkbook(target, window.XLSX.read(new Uint8Array(buf), { type: "array" }));
      } else {
        fallback([
          h("p", {}, `No inline preview for \u201c.${ext}\u201d files.`),
          h("a", { class: "btn btn-primary", href: url, target: "_blank", rel: "noopener", download: doc.name || "" }, "Download to open"),
        ]);
      }
    } catch (err) {
      fallback([
        h("p", { class: "error" }, `Couldn't render this document: ${err.message}`),
        h("a", { class: "btn btn-primary", href: url, target: "_blank", rel: "noopener", download: doc.name || "" }, "Download instead"),
      ]);
    }
    return dispose;
  }

  async function open(doc) {
    const url = doc.open_url || doc.url;
    if (!url) return;
    lastFocus = document.activeElement;

    const body = h("div", { class: "viewer-body" }, h("div", { class: "loading" }, "Loading preview\u2026"));
    const closeBtn = h("button", { class: "btn btn-sm", type: "button", onclick: close, "aria-label": "Close preview" }, "\u2715 Close");
    const dl = h("a", { class: "btn btn-sm", href: url, target: "_blank", rel: "noopener", download: doc.name || "" }, "\u2913 Download");
    const dialog = h("div", { class: "viewer-dialog", role: "dialog", "aria-modal": "true", "aria-label": `Preview: ${doc.name || "document"}` }, [
      h("div", { class: "viewer-head" }, [
        h("h3", { class: "viewer-title" }, doc.name || "Document"),
        h("span", { class: "spacer" }),
        dl, closeBtn,
      ]),
      body,
    ]);
    const overlay = h("div", { id: "doc-modal", class: "viewer-overlay", onclick: (e) => { if (e.target === overlay) close(); } }, dialog);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
    closeBtn.focus();

    cleanup = await render(body, doc);
  }

  async function fetchBytes(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`fetch failed (HTTP ${res.status}) — the link may have expired; reopen the library`);
    return res.arrayBuffer();
  }

  function renderWorkbook(body, wb) {
    const names = wb.SheetNames || [];
    if (!names.length) { body.replaceChildren(h("div", { class: "viewer-msg" }, "Empty workbook.")); return; }
    const sheetWrap = h("div", { class: "sheet-render" });
    const show = (name) => sheetWrap.replaceChildren(h("div", { class: "sheet-table", html: window.XLSX.utils.sheet_to_html(wb.Sheets[name]) }));
    const tabs = h("div", { class: "sheet-tabs", role: "tablist" }, names.map((name, i) =>
      h("button", { class: "sheet-tab" + (i === 0 ? " active" : ""), type: "button", role: "tab",
        onclick: (e) => {
          [...e.target.parentNode.children].forEach((b) => b.classList.remove("active"));
          e.target.classList.add("active");
          show(name);
        } }, name)));
    body.replaceChildren(...(names.length > 1 ? [tabs, sheetWrap] : [sheetWrap]));
    show(names[0]);
  }

  const SVG_NS = "http://www.w3.org/2000/svg";

  /**
   * Dynamic drawings, Phase 4 (docs/DYNAMIC_DRAWINGS.md §6 "The sheet"): the
   * render's sheet PNGs with the entities sidecar drawn over them as SVG in
   * paper millimetres. drawset draws every sheet on a matplotlib figure whose
   * axes span exactly [0, W] × [0, H] mm with the origin bottom-left, so the
   * PNG maps linearly: viewBox "0 0 W H", y flipped. No pdf.js, no CDN; the
   * PDF stays the artefact of record and the iframe path stays for files
   * without a sidecar.
   *
   * opts: { pngs: [url per sheet], entities: { sheets: [...] } (the sidecar),
   *         name, tools: [nodes for the bar], onSelect({ sheet, ids, add,
   *         region }), onHover(id | null), onSheet(n),
   *         onPaperClick({ sheet, x_mm, y_mm }) — every plain click, in paper mm
   *         with the origin bottom-left, as the boxes }.
   * Returns { dispose, showSheet(n), sheet, setSelected(ids), setTouched(ids),
   *           setRings([{ sheet, x_mm, y_mm, r_mm, cls, label? }]) } — ids are
   *           "sheet:index" strings. Rings are circles in the same overlay that
   *           never take a click (Drawing Templates phase 2: the holes a rule takes).
   */
  function renderSheets(target, opts) {
    const pngs = Array.isArray(opts.pngs) ? opts.pngs : [];
    const sheets = (opts.entities && Array.isArray(opts.entities.sheets) ? opts.entities.sheets : []).slice()
      .sort((a, b) => Number(a.sheet) - Number(b.sheet));
    const idOf = (sheet, idx) => `${sheet}:${idx}`;
    let selected = new Set(), touched = new Set(), hover = null;
    let fit = true, currentSheet = sheets.length ? Number(sheets[0].sheet) : 1;
    const rects = new Map();           // id → rect node (current sheet only)
    let rings = [], ringLayer = null, ringH = 297;
    const paintRings = () => {
      if (!ringLayer) return;
      const kids = [];
      for (const r of rings) {
        if (Number(r.sheet) !== currentSheet || !Number.isFinite(r.x_mm) || !Number.isFinite(r.y_mm)) continue;
        const c = document.createElementNS(SVG_NS, "circle");
        c.setAttribute("class", `sheet-ring${r.cls ? ` ${r.cls}` : ""}`);
        c.setAttribute("cx", r.x_mm); c.setAttribute("cy", ringH - r.y_mm); c.setAttribute("r", Math.max(Number(r.r_mm) || 0, 0.5));
        c.setAttribute("vector-effect", "non-scaling-stroke");
        kids.push(c);
        if (r.label != null && r.label !== "") {
          const t = document.createElementNS(SVG_NS, "text");
          t.setAttribute("class", `sheet-ring-label${r.cls ? ` ${r.cls}` : ""}`);
          t.setAttribute("x", r.x_mm + (Number(r.r_mm) || 0) + 0.8); t.setAttribute("y", ringH - r.y_mm - (Number(r.r_mm) || 0) - 0.8);
          t.textContent = String(r.label);
          kids.push(t);
        }
      }
      ringLayer.replaceChildren(...kids);
    };
    const paint = () => {
      for (const [id, r] of rects) {
        r.classList.toggle("is-selected", selected.has(id));
        r.classList.toggle("is-touched", touched.has(id));
        r.classList.toggle("is-hover", hover === id);
      }
    };

    const stage = h("div", { class: "sheet-stage" });
    const tabs = h("div", { class: "sheet-tabs sheet-bar", role: "tablist" });
    const fitBtn = h("button", { class: "sheet-tab", type: "button", onclick: () => { fit = !fit; applyZoom(); } }, "Fit");
    const applyZoom = () => {
      fitBtn.textContent = fit ? "Fit" : "100%";
      fitBtn.classList.toggle("active", !fit);
      const page = stage.querySelector(".sheet-page");
      if (page) page.classList.toggle("is-fit", fit);
    };

    function showSheet(n) {
      currentSheet = Number(n);
      for (const b of tabs.querySelectorAll("[data-sheet]")) b.classList.toggle("active", Number(b.dataset.sheet) === currentSheet);
      rects.clear();
      const sh = sheets.find((x) => Number(x.sheet) === currentSheet) || null;
      const url = pngs[currentSheet - 1] || null;
      if (!url) { stage.replaceChildren(h("div", { class: "viewer-msg" }, `No PNG for sheet ${currentSheet}.`)); return; }
      const [W, H] = sh && Array.isArray(sh.size_mm) ? sh.size_mm : [420, 297];
      const img = h("img", { class: "sheet-img", src: url, alt: `${opts.name || "Drawing"} sheet ${currentSheet}`, draggable: "false" });
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "sheet-svg");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("preserveAspectRatio", "none");
      // Paper mm (origin bottom-left) → SVG user units (origin top-left).
      const toSvg = (box) => ({ x: box[0], y: H - box[3], w: box[2] - box[0], h: box[3] - box[1] });
      const rect = (cls, box) => {
        const b = toSvg(box);
        const r = document.createElementNS(SVG_NS, "rect");
        r.setAttribute("class", cls);
        r.setAttribute("x", b.x); r.setAttribute("y", b.y); r.setAttribute("width", Math.max(b.w, 0.01)); r.setAttribute("height", Math.max(b.h, 0.01));
        r.setAttribute("vector-effect", "non-scaling-stroke");
        return r;
      };
      // The sheet frame drawset draws at (20, 10) → (W−10, H−10): the one box
      // that must sit on its line on every sheet, so a misread size shows at once.
      svg.appendChild(rect("sheet-frame", [20, 10, W - 10, H - 10]));
      const ents = sh && Array.isArray(sh.entities) ? sh.entities : [];
      ents.forEach((e, idx) => {
        if (!Array.isArray(e.box_mm) || e.box_mm.length !== 4) return;
        const id = idOf(currentSheet, idx);
        const linked = Array.isArray(e.features) && e.features.length > 0;
        const r = rect(`sheet-ent${linked ? " is-linked" : ""}`, e.box_mm);
        r.dataset.id = id;
        const title = document.createElementNS(SVG_NS, "title");
        title.textContent = e.text || "";
        r.appendChild(title);
        r.addEventListener("pointerenter", () => { hover = id; paint(); if (opts.onHover) opts.onHover(id); });
        r.addEventListener("pointerleave", () => { if (hover === id) { hover = null; paint(); if (opts.onHover) opts.onHover(null); } });
        rects.set(id, r);
        svg.appendChild(r);
      });
      ringLayer = document.createElementNS(SVG_NS, "g");
      ringLayer.setAttribute("class", "sheet-rings");
      ringH = H;
      svg.appendChild(ringLayer);

      // Click selects one box (shift adds); a drag draws a marquee that selects
      // every box it touches and reports the rectangle, mapped through the
      // sheet's face view to model coordinates when it crosses one.
      const marquee = document.createElementNS(SVG_NS, "rect");
      marquee.setAttribute("class", "sheet-marquee"); marquee.setAttribute("vector-effect", "non-scaling-stroke");
      marquee.style.display = "none";
      svg.appendChild(marquee);
      const mm = (ev) => {
        const b = svg.getBoundingClientRect();
        return [((ev.clientX - b.left) / b.width) * W, H - ((ev.clientY - b.top) / b.height) * H];
      };
      let down = null, dragging = false;
      svg.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        down = { p: mm(ev), x: ev.clientX, y: ev.clientY, shift: ev.shiftKey, target: ev.target };
        dragging = false;
        svg.setPointerCapture(ev.pointerId);
      });
      svg.addEventListener("pointermove", (ev) => {
        if (!down) return;
        if (!dragging && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 4) return;
        dragging = true;
        const q = mm(ev);
        const box = [Math.min(down.p[0], q[0]), Math.min(down.p[1], q[1]), Math.max(down.p[0], q[0]), Math.max(down.p[1], q[1])];
        const b = toSvg(box);
        marquee.setAttribute("x", b.x); marquee.setAttribute("y", b.y); marquee.setAttribute("width", b.w); marquee.setAttribute("height", b.h);
        marquee.style.display = "";
        marquee.__box = box;
      });
      const up = (ev) => {
        if (!down) return;
        const d = down; down = null;
        try { svg.releasePointerCapture(ev.pointerId); } catch { /* not captured */ }
        if (dragging) {
          const box = marquee.__box; marquee.style.display = "none"; dragging = false;
          if (!box || !opts.onSelect) return;
          const hit = [];
          ents.forEach((e, idx) => {
            const b = e.box_mm; if (!Array.isArray(b)) return;
            if (b[0] <= box[2] && b[2] >= box[0] && b[1] <= box[3] && b[3] >= box[1]) hit.push(idOf(currentSheet, idx));
          });
          opts.onSelect({ sheet: currentSheet, ids: hit, add: d.shift, region: regionOf(sh, box) });
          return;
        }
        const id = d.target && d.target.dataset ? d.target.dataset.id : null;
        if (opts.onPaperClick) opts.onPaperClick({ sheet: currentSheet, x_mm: d.p[0], y_mm: d.p[1] });
        if (!opts.onSelect) return;
        if (id) opts.onSelect({ sheet: currentSheet, ids: [id], add: d.shift, region: null });
        else if (!d.shift) opts.onSelect({ sheet: currentSheet, ids: [], add: false, region: null });
      };
      svg.addEventListener("pointerup", up);
      svg.addEventListener("pointercancel", () => { down = null; dragging = false; marquee.style.display = "none"; });

      const page = h("div", { class: "sheet-page" }, [img, svg]);
      stage.replaceChildren(page);
      applyZoom(); paint(); paintRings();
      if (opts.onSheet) opts.onSheet(currentSheet);
    }

    // A marquee in paper mm → the face view's model rectangle: drawset maps
    // paper x = ox + (sx·x − p0)·s and paper y = oy + (y − ya)·s (REC.view).
    function regionOf(sh, box) {
      const v = sh && Array.isArray(sh.views) ? sh.views.find((x) => x.kind === "face" && x.s) : null;
      if (!v) return null;
      // The dimension stacks stand beside the face view, so a marquee counts
      // as "on" the view when it shares its x range or its y range; one far
      // from it on both axes (the title block) keeps no rectangle.
      const bb = Array.isArray(v.bbox_mm) ? v.bbox_mm : null;
      if (bb && !(bb[0] <= box[2] && bb[2] >= box[0]) && !(bb[1] <= box[3] && bb[3] >= box[1])) return null;
      const sx = v.sx || 1;
      const X = (px) => ((px - v.ox) / v.s + (v.p0 || 0)) / sx;
      const Y = (py) => (py - v.oy) / v.s + (v.ya || 0);
      const xs = [X(box[0]), X(box[2])].sort((a, b) => a - b);
      const ys = [Y(box[1]), Y(box[3])].sort((a, b) => a - b);
      return { face: v.face || "", view: v.id || "face", x: xs, y: ys };
    }

    const n = Math.max(pngs.length, sheets.length);
    for (let i = 1; i <= n; i++) {
      tabs.appendChild(h("button", { class: "sheet-tab", type: "button", role: "tab", "data-sheet": String(i), onclick: () => showSheet(i) }, String(i)));
    }
    tabs.appendChild(h("span", { class: "spacer" }));
    tabs.appendChild(fitBtn);
    for (const t of opts.tools || []) tabs.appendChild(t);
    target.replaceChildren(h("div", { class: "sheet-viewer" }, [tabs, stage]));
    showSheet(currentSheet);

    return {
      dispose() { rects.clear(); rings = []; ringLayer = null; },
      showSheet,
      get sheet() { return currentSheet; },
      setSelected(ids) { selected = new Set(ids || []); paint(); },
      setTouched(ids) { touched = new Set(ids || []); paint(); },
      setRings(list) { rings = Array.isArray(list) ? list.slice() : []; paintRings(); },
      ids(sheet) { return (sheets.find((x) => Number(x.sheet) === Number(sheet))?.entities || []).map((_, i) => idOf(sheet, i)); },
    };
  }

  window.PortalViewer = { open, render, renderSheets };
})();
