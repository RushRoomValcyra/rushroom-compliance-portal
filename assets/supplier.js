/* Rushroom AB — Engineering & Compliance Platform (supplier portal)
 * docs/SUPPLIER_PORTAL.md §4. A supplier signs in with a personal account
 * (loginUser, role supplier, session.sid = the supplier). The page shows the
 * parts assigned to that supplier with their released drawing issues and CAD
 * (one supplierHome call), the supplier documents and the standards flagged
 * for suppliers. Every file leaves through supplierFileUrl, so every fetch is
 * logged server-side; no storage path ever reaches this page.
 *
 * Reuses window.Portal (app.js) for el/$ and for renderApi, which fills the
 * documents and standards panels (and the hidden steps panel) exactly as
 * before. window.PortalAPI (api.js) keeps the session; window.PortalViewer
 * (viewer.js) renders the PDF inline.
 */
(() => {
  "use strict";
  if (!document.body || document.body.dataset.page !== "supplier") return;

  const P = window.Portal;
  const API = window.PortalAPI;
  if (!P || !API) { console.error("supplier.js requires api.js and app.js to load first"); return; }
  const { el, $ } = P;
  const ROLE = "supplier";

  // api.js keeps the one active session under this key (sessionStorage) and
  // exposes no setter, so the admin preview token is parked there by hand in
  // the same shape API.loginUser saves. The preview tab inherits the admin's
  // sessionStorage from window.open, including pim_supplier_preview.
  const SESSION_KEY = "rushroom_portal_session";
  const PREVIEW_KEY = "pim_supplier_preview";

  const fmtDate = (iso) => { if (!iso) return ""; try { return new Date(iso).toLocaleDateString("en-GB"); } catch { return iso; } };
  const setChildren = (node, ...kids) => node.replaceChildren(...kids.filter(Boolean));

  // Same markup as drawingStatusChip in app.js (Released tone).
  function statusChip(status) {
    const tone = { draft: "#64748b", released: "#15803d", superseded: "#b45309" }[status] || "#64748b";
    const label = status ? status.charAt(0).toUpperCase() + status.slice(1) : "";
    return el("span", {
      style: `display:inline-block;font-size:0.75rem;font-weight:600;padding:1px 8px;border-radius:999px;color:${tone};border:1px solid ${tone}44;background:${tone}12`,
    }, label);
  }
  const dash = () => el("span", { class: "muted" }, "—");

  /* ---------------- admin preview (impersonation) ---------------- */
  // Read once: the key leaves sessionStorage the moment it is read, so a
  // stale token is never adopted again on a later load of this tab.
  function readPreview() {
    let raw = null;
    try { raw = sessionStorage.getItem(PREVIEW_KEY); sessionStorage.removeItem(PREVIEW_KEY); } catch { /* ignore */ }
    if (!raw) return null;
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === "object" && o.token) return { token: o.token, supplier: o.supplier || null, actor: o.actor || "" };
    } catch { /* a bare token */ }
    return { token: raw, supplier: null, actor: "" };
  }
  function adoptPreview(pv) {
    const s = { token: pv.token, role: ROLE, admin: false, name: "preview", imp: true };
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  }
  function clearPreview() { try { sessionStorage.removeItem(PREVIEW_KEY); } catch { /* ignore */ } }

  /* ---------------- header + session ---------------- */
  function paintHeader(home, preview) {
    const h1 = $("#supplier-name"), tag = $("#supplier-user");
    const supplier = (home && home.supplier) || (preview && preview.supplier) || null;
    if (h1 && supplier && supplier.name) h1.textContent = supplier.name;
    const u = (home && home.user) || {};
    if (tag) tag.textContent = [u.name, u.email].filter(Boolean).join(" · ");
    document.title = `${(supplier && supplier.name) || "Supplier portal"} · Rushroom Engineering & Compliance Platform`;
  }

  function paintSessionActions(preview) {
    const nav = $("#session-actions");
    if (!nav) return;
    const out = () => { API.clearToken(); clearPreview(); location.reload(); };
    setChildren(nav, preview
      ? el("button", { class: "btn btn-sm", type: "button", onclick: () => { clearPreview(); API.clearToken(); window.close(); showGate(""); } }, "Close preview")
      : el("button", { class: "btn btn-sm", type: "button", onclick: out }, "Sign out"));
  }

  function paintPreviewBar(preview, home, actor) {
    const app = $("#portal-app");
    let bar = $("#imp-banner");
    if (!preview) { if (bar) bar.remove(); return; }
    if (!bar) { bar = el("div", { id: "imp-banner", class: "imp-banner", style: "padding:0.35rem 0.9rem" }); app.insertBefore(bar, app.firstChild); }
    const name = (home && home.supplier && home.supplier.name) || (preview.supplier && preview.supplier.name) || "supplier";
    setChildren(bar, el("span", {}, [el("strong", {}, "Viewing as "), name, actor ? ` · ${actor}` : ""]));
  }

  // The admin behind a preview: supplierHome's viewing_as (the token's actor),
  // else the stored preview record, else orgContext's actor, else the user
  // supplierHome reports.
  async function resolveActor(preview, home) {
    if (home && home.viewing_as) return home.viewing_as;
    if (preview.actor) return preview.actor;
    try {
      const ctx = await API.orgContext(API.getToken(ROLE));
      const a = ctx && (ctx.actor || (ctx.session && ctx.session.actor) || (ctx.impersonation && ctx.impersonation.actor));
      if (a) return a;
    } catch { /* not every deployment answers orgContext to a supplier */ }
    return (home && home.user && (home.user.email || home.user.name)) || "";
  }

  /* ---------------- sign-in gate ---------------- */
  function showGate(message) {
    const gate = $("#gate"), app = $("#portal-app");
    gate.hidden = false; app.hidden = true;
    const h1 = $("#supplier-name"), tag = $("#supplier-user"), nav = $("#session-actions"), bar = $("#imp-banner");
    if (h1) h1.textContent = "Supplier portal";
    if (tag) tag.textContent = "";
    if (nav) nav.replaceChildren();
    if (bar) bar.remove();
    document.title = "Supplier portal · Rushroom Engineering & Compliance Platform";
    const err = $("#gate-error");
    if (message) err.textContent = message;
    const email = $("#login-email");
    if (email && !email.value) email.focus();
  }

  function wireGate() {
    const form = $("#gate-form"), email = $("#login-email"), pass = $("#login-password");
    const mfaField = $("#login-mfa-field"), mfa = $("#login-mfa"), err = $("#gate-error"), note = $("#gate-note");
    const btn = form.querySelector('button[type="submit"]');
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = ""; note.textContent = "";
      email.setAttribute("aria-invalid", "false"); pass.setAttribute("aria-invalid", "false"); mfa.setAttribute("aria-invalid", "false");
      if (!email.value.trim()) { email.setAttribute("aria-invalid", "true"); err.textContent = "Email required"; email.focus(); return; }
      if (!pass.value) { pass.setAttribute("aria-invalid", "true"); err.textContent = "Password required"; pass.focus(); return; }
      btn.disabled = true;
      try {
        const r = await API.loginUser(email.value.trim(), pass.value, mfa.value.trim() || undefined);
        if (r && r.role !== ROLE) {
          // Not a supplier account: this page has nothing for it.
          API.clearToken();
          err.textContent = "Not a supplier account";
          return;
        }
        await enter(null, r);
      } catch (ex) {
        if (ex && (ex.code === "mfa_required" || ex.code === "mfa_invalid")) {
          mfaField.hidden = false; mfa.focus();
          if (ex.code === "mfa_invalid") { mfa.setAttribute("aria-invalid", "true"); err.textContent = "Code not valid"; }
        } else {
          pass.setAttribute("aria-invalid", "true");
          err.textContent = ex.message || "Sign in failed";
          pass.select();
        }
      } finally { btn.disabled = false; }
    });

    $("#forgot-password").addEventListener("click", async () => {
      err.textContent = ""; note.textContent = "";
      const addr = email.value.trim();
      if (!addr) { email.setAttribute("aria-invalid", "true"); err.textContent = "Email required"; email.focus(); return; }
      try { await API.requestPasswordReset(addr); note.textContent = `Reset link sent to ${addr}`; }
      catch (ex) { err.textContent = ex.message || "Reset failed"; }
    });
  }

  /* ---------------- Parts & files ---------------- */
  let homeCache = null;

  async function loadHome() {
    homeCache = await API.post(API.getToken(ROLE), "supplierHome", {});
    return homeCache;
  }

  function newestRelease(part) {
    const dates = [...(part.drawings || []).map((d) => d.released_at), part.cad ? part.cad.released_at : null].filter(Boolean);
    if (part.updated_at) dates.push(part.updated_at);
    return dates.sort().pop() || "";
  }

  // inline: true asks for a URL the viewers can render; without it the URL is
  // signed as an attachment, so opening it saves the file.
  async function fileUrl(kind, id, opts) {
    return API.post(API.getToken(ROLE), "supplierFileUrl", Object.assign({ kind, id }, opts || {}));
  }

  // Every download goes through supplierFileUrl (the server logs the event
  // and the path stays hidden), then the signed attachment URL opens in a new
  // tab — never this one, so the portal stays where it is.
  function openInNewTab(url) {
    // One anchor click, one tab: window.open with "noopener" answers null even
    // when it opened, so it cannot tell a blocked popup from a successful one.
    const a = el("a", { href: url, target: "_blank", rel: "noopener", hidden: "" });
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function download(kind, id, btn) {
    const was = btn.textContent; btn.disabled = true;
    try {
      const { url } = await fileUrl(kind, id);
      openInNewTab(url);
    } catch (ex) {
      btn.textContent = "Not available"; setTimeout(() => { btn.textContent = was; }, 2500);
    } finally { btn.disabled = false; }
  }

  // CAD preview: the shared 3D viewer (app.js openCadViewer, o3dv) on an
  // inline-signed URL. Without the viewer the file is downloaded instead.
  async function previewCad(part, c, btn) {
    const was = btn.textContent; btn.disabled = true;
    try {
      if (!P.openCadViewer) { await download("cad", c.cad_file_id, btn); return; }
      const { url } = await fileUrl("cad", c.cad_file_id, { inline: true });
      P.openCadViewer({ download_url: url, format: "step", revision: c.revision, file_name: c.file_name || "" }, part.name || part.part_number || "");
    } catch (ex) {
      btn.textContent = "Not available"; setTimeout(() => { btn.textContent = was; }, 2500);
    } finally { btn.disabled = false; }
  }

  function partsPanel(home) {
    const mount = $("#parts-panel");
    const parts = home.parts || [];
    const last = (home.updated_at || parts.map(newestRelease).filter(Boolean).sort().pop() || "");
    const tools = el("div", { class: "row-tools" }, [
      el("span", { class: "updated" }, `${parts.length} ${parts.length === 1 ? "part" : "parts"}${last ? ` · last release ${fmtDate(last)}` : ""}`),
      el("span", { class: "spacer" }),
      el("button", { class: "btn btn-sm", type: "button", onclick: refreshParts }, "Refresh"),
    ]);
    if (!parts.length) { setChildren(mount, tools, el("div", { class: "empty" }, "No parts assigned yet.")); return; }

    const drawingCell = (p) => {
      if (!(p.drawings || []).length) return dash();
      return el("div", { style: "display:grid;gap:0.45rem" }, p.drawings.map((d) => {
        const dl = el("button", { class: "btn btn-xs", type: "button", title: d.file_name || "" }, "Download");
        dl.addEventListener("click", () => download("drawing", d.drawing_revision_id, dl));
        return el("div", { style: "display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap" }, [
          el("span", { style: "font-weight:600;white-space:nowrap" }, d.drawing_number),
          d.supplier_drawing_number ? el("span", { style: "font-family:var(--mono,monospace);font-size:0.75rem;color:var(--muted,#8b93a1);white-space:nowrap" }, d.supplier_drawing_number) : null,
          el("span", { style: "white-space:nowrap;font-weight:600" }, `Issue ${d.issue}`),
          statusChip("released"),
          d.title ? el("span", { class: "muted" }, d.title) : null,
          el("button", { class: "btn btn-xs", type: "button", onclick: () => openDrawing(p, d) }, "Open"),
          dl,
        ]);
      }));
    };
    const cadCell = (p) => {
      const c = p.cad;
      if (!c) return dash();
      const dl = el("button", { class: "btn btn-xs", type: "button", title: c.file_name || "" }, "Download");
      dl.addEventListener("click", () => download("cad", c.cad_file_id, dl));
      const pv = el("button", { class: "btn btn-xs", type: "button", title: c.file_name || "" }, "Preview");
      pv.addEventListener("click", () => previewCad(p, c, pv));
      return el("div", { style: "display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap" }, [
        el("span", { style: "white-space:nowrap;font-weight:600" }, `Rev ${c.revision}`),
        statusChip("released"),
        c.file_name ? el("span", { class: "muted", style: "font-family:var(--mono,monospace);font-size:0.75rem" }, c.file_name) : null,
        pv,
        dl,
      ]);
    };

    const table = el("div", { class: "table-wrap" }, el("table", {}, [
      el("thead", {}, el("tr", {}, ["Part no.", "Part", "Drawing", "CAD", "Released"].map((h) => el("th", { scope: "col" }, h)))),
      el("tbody", {}, parts.map((p) => el("tr", {}, [
        el("td", { style: "font-family:var(--mono,monospace);white-space:nowrap" }, p.part_number || ""),
        el("td", {}, [
          el("div", {}, p.name || ""),
          p.description ? el("div", { class: "muted t-sm" }, p.description) : null,
        ]),
        el("td", {}, drawingCell(p)),
        el("td", {}, cadCell(p)),
        el("td", { style: "white-space:nowrap" }, fmtDate(newestRelease(p)) || dash()),
      ]))),
    ]));
    setChildren(mount, tools, table);
  }

  async function refreshParts() {
    const mount = $("#parts-panel");
    setChildren(mount, el("div", { class: "loading" }, "Loading parts…"));
    try { partsPanel(await loadHome()); }
    catch (ex) {
      if (ex && (ex.status === 401 || ex.status === 403 || /auth/i.test(ex.message || ""))) { API.clearToken(); clearPreview(); showGate(ex.message || "Session ended"); return; }
      setChildren(mount, el("div", { class: "error" }, `Couldn't load parts: ${ex.message}`));
    }
  }

  // The drawing surface takes the panel over: drawing number, issue, title,
  // Download and Back on one row; the PDF below through the shared viewer.
  async function openDrawing(part, d) {
    const mount = $("#parts-panel");
    let dispose = () => {};
    const back = () => { try { dispose(); } catch { /* gone */ } partsPanel(homeCache); };
    const dl = el("button", { class: "btn btn-sm", type: "button", title: d.file_name || "" }, "Download");
    dl.addEventListener("click", () => download("drawing", d.drawing_revision_id, dl));
    const head = el("div", { class: "row-tools" }, [
      el("button", { class: "btn btn-sm", type: "button", onclick: back }, "← Parts"),
      el("span", { style: "font-weight:700" }, d.drawing_number),
      el("span", { style: "font-weight:600;white-space:nowrap" }, `Issue ${d.issue}`),
      statusChip("released"),
      d.title ? el("span", { class: "muted" }, d.title) : null,
      el("span", { class: "muted t-sm" }, `${part.part_number || ""} ${part.name || ""}`.trim()),
      el("span", { class: "spacer" }),
      dl,
    ]);
    const filePane = el("div", { class: "drawing-file" }, el("div", { class: "loading" }, `Loading Issue ${d.issue}…`));
    setChildren(mount, head, filePane);
    try {
      const { url } = await fileUrl("drawing", d.drawing_revision_id, { inline: true });
      dispose = await window.PortalViewer.render(filePane, {
        name: `${d.drawing_number} Issue ${d.issue}`,
        open_url: url,
        storage_path: d.file_name || "",
      });
    } catch (ex) {
      setChildren(filePane, el("div", { class: "viewer-msg" }, el("p", { class: "error" }, `Couldn't open this issue: ${ex.message}`)));
    }
  }

  /* ---------------- enter the portal ---------------- */
  async function enter(preview, login) {
    const gate = $("#gate"), app = $("#portal-app");
    let home = null, loadError = null;
    try { home = await loadHome(); }
    catch (ex) {
      // A supplier account without a supplier (403), an expired token: the
      // sign-in error, never an empty portal.
      if (ex && (ex.status === 401 || ex.status === 403 || /auth/i.test(ex.message || ""))) {
        API.clearToken(); clearPreview();
        showGate(ex.message || "Sign in failed");
        return;
      }
      loadError = ex;
    }
    if (home && !home.supplier && login && login.supplier) home.supplier = login.supplier;
    paintHeader(home || { supplier: login && login.supplier }, preview);
    paintSessionActions(preview);
    gate.hidden = true; app.hidden = false;
    if (preview) paintPreviewBar(preview, home, await resolveActor(preview, home));
    if (home) partsPanel(home);
    else setChildren($("#parts-panel"),
      el("div", { class: "row-tools" }, [el("span", { class: "spacer" }), el("button", { class: "btn btn-sm", type: "button", onclick: refreshParts }, "Refresh")]),
      el("div", { class: "error" }, `Couldn't load parts: ${loadError.message}`));
    // Documents, standards and the (hidden) steps panel: the shared renderer,
    // which also wires the tab bar.
    try { await P.renderApi(ROLE, "#steps-panel"); }
    catch (ex) { console.error("renderApi", ex); }
    const h = app.querySelector("h2, h3"); if (h) { h.setAttribute("tabindex", "-1"); h.focus(); }
  }

  function init() {
    wireGate();
    if (!(P.apiEnabled && P.apiEnabled())) { showGate("API not configured"); return; }
    const preview = readPreview();
    if (preview) { adoptPreview(preview); enter(preview, null); return; }
    const s = API.session();
    if (s && s.token && s.role === ROLE && !s.imp) { enter(null, null); return; }
    // An admin's rushroom session (or a stale preview session): the gate, not
    // supplierHome — that would only 403 and land here again.
    showGate(s && s.token && s.role !== ROLE ? "Sign in with a supplier account" : "");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
