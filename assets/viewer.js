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
        renderSheets(target, window.XLSX.read(new Uint8Array(buf), { type: "array" }));
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

  function renderSheets(body, wb) {
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

  window.PortalViewer = { open, render };
})();
