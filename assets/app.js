/* Rushroom AB — Compliance Portal
 * Shared logic (window.Portal) + full-portal page init.
 * No framework, no build step. Accessibility: see README "Accessibility".
 */
(() => {
  "use strict";
  const CFG = window.PORTAL_CONFIG || {};
  const AUTH_KEY = "rushroom_portal_auth";

  /* ---------------- DOM helpers ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  function el(tag, attrs = {}, kids = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      // Boolean attributes: presence alone disables/checks an element, so
      // setAttribute("disabled", "false") would DISABLE it. false must omit it.
      else if (typeof v === "boolean") { if (v) n.setAttribute(k, ""); }
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(kids)) {
      if (c == null) continue;
      n.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return n;
  }

  // Turn literal \uXXXX escapes (sometimes emitted in AI drafts) into real chars.
  const unescapeUnicode = (s) => (s || "").replace(/\\u([0-9a-fA-F]{4})/g, (_, hx) => String.fromCharCode(parseInt(hx, 16)));

  const _scriptCache = {};
  function loadScript(src) {
    if (!_scriptCache[src]) _scriptCache[src] = new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = src;
      s.onload = res; s.onerror = () => { delete _scriptCache[src]; rej(new Error("Couldn't load a helper library (offline?)")); };
      document.head.appendChild(s);
    });
    return _scriptCache[src];
  }
  const MARKED_CDN = "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js";
  const MAMMOTH_CDN = "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js";
  const XLSX_CDN = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
  const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
  const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";

  /* ===== version-to-version text diff (yellow "what changed" highlighting) =====
   * A dependency-light word-level LCS diff that renders the NEW text with added/
   * changed words wrapped in <mark class="diff-add"> (yellow) and removed text as
   * <del>. Text is extracted from stored files client-side (md/txt/html natively,
   * docx via mammoth, xlsx via SheetJS, pdf via pdf.js). */
  async function fetchBytes(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`fetch failed (HTTP ${r.status}) — the link may have expired; reopen the library`);
    return r.arrayBuffer();
  }
  const stripHtmlToText = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d.textContent || ""; };
  async function extractPdfText(buf) {
    await loadScript(PDFJS_CDN);
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) throw new Error("PDF reader unavailable");
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      pages.push(tc.items.map((it) => it.str).join(" "));
    }
    return pages.join("\n\n");
  }
  // Returns plain text for diffing, or null if the format can't be text-extracted.
  async function extractVersionText(url, hint) {
    if (!url) return null;
    const ext = extOf(hint || url);
    const buf = await fetchBytes(url);
    const asText = () => unescapeUnicode(new TextDecoder().decode(new Uint8Array(buf)));
    if (["md", "markdown", "txt", "csv", "json", "xml", ""].includes(ext)) return asText();
    if (["html", "htm"].includes(ext)) return stripHtmlToText(asText());
    if (ext === "docx") { await loadScript(MAMMOTH_CDN); return (await window.mammoth.extractRawText({ arrayBuffer: buf })).value || ""; }
    if (["xlsx", "xls"].includes(ext)) { await loadScript(XLSX_CDN); const wb = window.XLSX.read(new Uint8Array(buf), { type: "array" }); return (wb.SheetNames || []).map((n) => `# ${n}\n${window.XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join("\n\n"); }
    if (ext === "pdf") return await extractPdfText(buf);
    return null; // image, zip, etc.
  }

  const WORD_CAP = 1800, LINE_CAP = 4000;
  const diffEsc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  // LCS over a token array → ops [{t:'='|'+'|'-', v}]
  function lcsDiff(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = []; let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ t: "=", v: b[j] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "-", v: a[i] }); i++; }
      else { ops.push({ t: "+", v: b[j] }); j++; }
    }
    while (i < n) ops.push({ t: "-", v: a[i++] });
    while (j < m) ops.push({ t: "+", v: b[j++] });
    return ops;
  }
  // Render a word-level (or line-level, for huge inputs) diff as highlighted HTML.
  function diffToHtml(oldText, newText) {
    const aw = (oldText || "").match(/\s+|\S+/g) || [], bw = (newText || "").match(/\s+|\S+/g) || [];
    let ops;
    if (aw.length <= WORD_CAP && bw.length <= WORD_CAP) ops = lcsDiff(aw, bw);
    else {
      const al = (oldText || "").split(/(\n)/), bl = (newText || "").split(/(\n)/);
      if (al.length <= LINE_CAP && bl.length <= LINE_CAP) ops = lcsDiff(al, bl);
      else return `<mark class="diff-add">${diffEsc((newText || "").slice(0, 200000))}</mark><p class="muted">(document too large for a word-level comparison — showing the current version)</p>`;
    }
    let html = "";
    for (const op of ops) {
      const v = diffEsc(op.v);
      html += op.t === "=" ? v : op.t === "+" ? `<mark class="diff-add">${v}</mark>` : `<del class="diff-del">${v}</del>`;
    }
    return html;
  }
  // Two-column (Previous | Current) HTML — removals marked on the left, additions
  // (yellow) on the right — sharing the same LCS ops as the inline view.
  function diffSides(oldText, newText) {
    const aw = (oldText || "").match(/\s+|\S+/g) || [], bw = (newText || "").match(/\s+|\S+/g) || [];
    let ops = null;
    if (aw.length <= WORD_CAP && bw.length <= WORD_CAP) ops = lcsDiff(aw, bw);
    else { const al = (oldText || "").split(/(\n)/), bl = (newText || "").split(/(\n)/); if (al.length <= LINE_CAP && bl.length <= LINE_CAP) ops = lcsDiff(al, bl); }
    if (!ops) return { left: diffEsc(oldText || ""), right: `<mark class="diff-add">${diffEsc((newText || "").slice(0, 200000))}</mark>` };
    let left = "", right = "";
    for (const op of ops) {
      const v = diffEsc(op.v);
      if (op.t === "=") { left += v; right += v; }
      else if (op.t === "-") left += `<del class="diff-del">${v}</del>`;
      else right += `<mark class="diff-add">${v}</mark>`;
    }
    return { left, right };
  }
  // A diff view with an Inline / Side-by-side toggle.
  function diffViewToggle(oldText, newText) {
    const body = el("div");
    const render = (mode) => {
      if (mode === "side") {
        const s = diffSides(oldText, newText);
        const l = el("pre", { class: "diff-view diff-col" }); l.innerHTML = s.left || "(empty)";
        const r = el("pre", { class: "diff-view diff-col" }); r.innerHTML = s.right || "(empty)";
        body.replaceChildren(el("div", { class: "diff-sbs" }, [
          el("div", {}, [el("div", { class: "diff-col-head" }, "Previous"), l]),
          el("div", {}, [el("div", { class: "diff-col-head" }, "Current"), r]),
        ]));
      } else {
        const v = el("pre", { class: "diff-view" }); v.innerHTML = diffToHtml(oldText, newText);
        body.replaceChildren(v);
      }
    };
    const bIn = el("button", { class: "subtab active", type: "button" }, "Inline");
    const bSide = el("button", { class: "subtab", type: "button" }, "Side-by-side");
    bIn.addEventListener("click", () => { bIn.classList.add("active"); bSide.classList.remove("active"); render("inline"); });
    bSide.addEventListener("click", () => { bSide.classList.add("active"); bIn.classList.remove("active"); render("side"); });
    render("inline");
    return el("div", {}, [el("div", { class: "subtabs diff-toggle" }, [bIn, bSide]), body]);
  }
  // Open a modal comparing two stored file versions with yellow-highlighted changes.
  async function openVersionDiff({ title, oldUrl, oldHint, newUrl, newHint }) {
    const body = el("div", { class: "step-form" }, el("div", { class: "loading" }, "Loading both versions…"));
    openModal(title || "Changes", body);
    try {
      const [oldText, newText] = await Promise.all([extractVersionText(oldUrl, oldHint), extractVersionText(newUrl, newHint)]);
      if (oldText == null || newText == null) { body.replaceChildren(el("div", { class: "notice warn" }, "Text comparison isn't available for this file type (e.g. image or archive). Open both versions to compare them.")); return; }
      if (!oldText.trim() && !newText.trim()) { body.replaceChildren(el("div", { class: "notice" }, "Neither version has extractable text.")); return; }
      const legend = el("div", { class: "diff-legend" }, [
        el("span", {}, [el("mark", { class: "diff-add" }, "added / changed")]),
        el("span", {}, [el("del", { class: "diff-del" }, "removed")]),
      ]);
      body.replaceChildren(el("div", {}, [legend, diffViewToggle(oldText, newText)]));
    } catch (ex) { body.replaceChildren(el("div", { class: "error" }, `Couldn't compare: ${ex.message}`)); }
  }
  // Inline highlighted diff (used where old & new text are already in hand).
  function diffInline(oldText, newText) {
    const view = el("pre", { class: "diff-view" }); view.innerHTML = diffToHtml(oldText || "", newText || "");
    return view;
  }
  // Diff modal from two in-hand strings (yellow = added/changed).
  function openTextDiffModal(title, oldText, newText) {
    const legend = el("div", { class: "diff-legend" }, [
      el("span", {}, [el("mark", { class: "diff-add" }, "added / changed")]),
      el("span", {}, [el("del", { class: "diff-del" }, "removed")]),
    ]);
    openModal(title || "Changes", el("div", {}, [legend, diffViewToggle(oldText, newText)]));
  }

  /* ---------------- password gate ---------------- */
  async function portalHash(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  window.portalHash = portalHash; // exposed for console use (see README)

  function setupGate(onUnlock) {
    const gate = $("#gate"), appEl = $("#portal-app");
    const reveal = () => {
      gate.hidden = true;
      appEl.hidden = false;
      onUnlock();
    };
    if (sessionStorage.getItem(AUTH_KEY) === "1") { reveal(); return; }

    const form = $("#gate-form"), input = $("#portal-password"), err = $("#gate-error");
    input.focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      input.setAttribute("aria-invalid", "false");
      let ok = false;
      try { ok = (await portalHash(input.value)) === CFG.passwordHash; } catch { ok = false; }
      if (ok) {
        sessionStorage.setItem(AUTH_KEY, "1");
        reveal();
        const h = appEl.querySelector("h2, h3");
        if (h) { h.setAttribute("tabindex", "-1"); h.focus(); }
      } else {
        input.setAttribute("aria-invalid", "true");
        err.textContent = "Incorrect password. Please try again.";
        input.select();
      }
    });
  }

  /* ---------------- CSV ---------------- */
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", i = 0, q = false;
    while (i < text.length) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
      i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    const header = rows.shift().map((h) => h.trim().toLowerCase());
    return rows
      .filter((r) => r.some((v) => v.trim() !== ""))
      .map((r) => Object.fromEntries(header.map((h, idx) => [h, (r[idx] ?? "").trim()])));
  }

  /* ---------------- status model ----------------
   * The action-plan sheet uses free-text status ("Done (documented)", "Open",
   * "Active"), so classification is fuzzy rather than an exact lookup. */
  const norm = (s) => (s || "").trim().toLowerCase();
  const isDone = (s) => /\bdone\b|complete|closed|signed/.test(norm(s));
  function statusInfo(raw) {
    const s = norm(raw);
    let cls = "s-todo";
    if (isDone(s)) cls = "s-done";
    else if (/progress|active|wip|started/.test(s)) cls = "s-progress";
    else if (/block(?!er)|on hold|stuck/.test(s)) cls = "s-blocked";
    return { label: (raw || "").trim() || "Open", cls, done: isDone(s) };
  }
  const isTrue = (v) => /^(true|yes|y|1)$/i.test(String(v || "").trim());
  const audienceList = (v) => String(v || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

  /* First non-empty value among the given (lowercased) header aliases. */
  const pick = (r, ...keys) => {
    for (const k of keys) { const v = r[k]; if (v != null && String(v).trim() !== "") return String(v).trim(); }
    return "";
  };

  /* When the sheet has no audience column, infer it from the step text so the
   * supplier view still shows the right rows. Everyone is "internal" by default. */
  function deriveAudience(phase, action) {
    const set = new Set(["internal"]);
    const hay = `${phase} ${action}`.toLowerCase();
    if (/supplier|reach|rohs|svhc|datasheet|declaration of compliance|component|psu|connector/.test(hay)) set.add("supplier");
    if (/self-declaration|declaration of conformity|technical file|\bdoc\b|ce mark|review/.test(hay)) set.add("reviewer");
    if (/install|manual|\buser\b|sop/.test(hay)) set.add("installer");
    return Array.from(set);
  }

  function normalizeStep(r) {
    const phase = pick(r, "phase") || "Unphased";
    const action = pick(r, "action", "action — what rushroom must do", "action - what rushroom must do");
    const priority = pick(r, "priority");
    const st = statusInfo(pick(r, "status"));
    const presaleRaw = pick(r, "presale");
    const audRaw = pick(r, "audience");
    return {
      step: Number(pick(r, "step")) || 0,
      phase,
      action,
      status: st.label,
      cls: st.cls,
      done: st.done,
      owner: pick(r, "owner", "who does it", "who"),
      where: pick(r, "where / how", "where/how", "where", "how"),
      evidence: pick(r, "output / evidence", "output/evidence", "evidence", "output"),
      folder: pick(r, "folder"),
      priority,
      presale: presaleRaw ? isTrue(presaleRaw) : /blocker|gate/i.test(priority),
      audience: audRaw ? audienceList(audRaw) : deriveAudience(phase, action),
      doc: pick(r, "doc"),
      notes: pick(r, "notes"),
    };
  }

  async function loadSteps() {
    const snapshot = () => (CFG.sampleSteps || []).map(normalizeStep);
    if (CFG.statusSheetCsvUrl) {
      try {
        const res = await fetch(CFG.statusSheetCsvUrl, { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const steps = parseCSV(await res.text()).map(normalizeStep).filter((s) => s.step || s.action);
        if (!steps.length) throw new Error("no rows parsed from CSV");
        return { steps, source: "live" };
      } catch (err) {
        // Sheet not shared/published yet, offline, or CORS-blocked → don't break
        // the page; show the bundled snapshot and explain. Switches to live as
        // soon as the Sheet becomes reachable.
        console.warn("Live status fetch failed; using bundled snapshot.", err);
        return { steps: snapshot(), source: "fallback", error: err.message };
      }
    }
    return { steps: snapshot(), source: "sample" };
  }

  /* ---------------- shared renderers ---------------- */
  function statusBadge(step) {
    return el("span", { class: `badge-status ${step.cls}` }, step.status);
  }

  // One progress tracker inside a multi-tracker card. Pass pct=null for a
  // not-yet-wired tracker (renders "—", an empty bar and muted styling).
  function complianceTracker(label, pct, sub) {
    const known = typeof pct === "number";
    return el("div", { class: "tracker" + (known ? "" : " pending") }, [
      el("div", { class: "tracker-head" }, [
        el("span", { class: "tracker-label" }, label),
        el("span", { class: "tracker-pct" }, known ? `${pct}%` : "—"),
      ]),
      el("div", { class: "progress", "aria-hidden": "true" }, el("span", { style: `width:${known ? pct : 0}%` })),
      el("div", { class: "sub" }, sub),
    ]);
  }

  function summaryTiles(steps) {
    const total = steps.length;
    const done = steps.filter((s) => s.done).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const presaleOpen = steps.filter((s) => s.presale && !s.done).length;
    return el("div", { class: "summary" }, [
      // Multi-tracker card. "Launch Compliance" is the existing action-plan
      // progress; "Company Compliance" is a placeholder — logic added later.
      el("div", { class: "card stat" }, [
        el("h3", {}, "Compliance status"),
        complianceTracker("Launch Compliance", pct, `${done} of ${total} actions complete`),
        complianceTracker("Company Compliance", null, "coming soon"),
      ]),
      el("div", { class: "card stat" }, [
        el("h3", {}, "Pre-sale blockers"),
        el("div", { class: "value", style: presaleOpen ? "color:var(--amber)" : "" }, String(presaleOpen)),
        el("div", { class: "sub" }, presaleOpen ? "must clear before first sale" : "all pre-sale actions clear"),
      ]),
      // Compliance Forecasting — placeholder tile. The old "Blocked actions"
      // logic was removed; new forecasting functionality is coming later.
      el("div", { class: "card stat" }, [
        el("h3", {}, "Compliance Forecasting"),
        el("div", { class: "value muted" }, "—"),
        el("div", { class: "sub" }, "coming soon"),
      ]),
    ]);
  }

  function phaseOverview(steps) {
    const list = el("div", { class: "phase-bars" });
    for (const [phase, items] of byPhase(steps)) {
      const done = items.filter((s) => s.done).length;
      const pct = items.length ? Math.round((done / items.length) * 100) : 0;
      list.appendChild(el("button", {
        class: "phase-bar phase-jump", type: "button",
        "aria-label": `Jump to ${phase} — ${pct}% complete`,
        onclick: () => jumpToPhase(phase),
      }, [
        el("div", { class: "phase-bar-head" }, [
          el("span", {}, phase),
          el("span", { class: "muted" }, `${done}/${items.length} · ${pct}%`),
        ]),
        el("div", { class: "progress", "aria-hidden": "true" }, el("span", { style: `width:${pct}%` })),
      ]));
    }
    return collapsibleSection("__overview__", "Progress by phase", null, list);
  }

  // Jump to a step's row in the phase sections: expand its phase, scroll it into
  // view, and briefly flash it.
  function goToStep(stepNo) {
    const row = document.getElementById(`step-${stepNo}`);
    if (!row) return;
    const details = row.closest("details.phase");
    if (details && !details.open) details.open = true;
    requestAnimationFrame(() => {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.classList.remove("step-flash"); void row.offsetWidth; // restart the animation
      row.classList.add("step-flash");
      setTimeout(() => row.classList.remove("step-flash"), 2200);
    });
  }

  function blockersPanel(steps) {
    const open = steps.filter((s) => s.presale && !s.done).sort((a, b) => a.step - b.step);
    if (!open.length) {
      return collapsibleSection("__blockers__", "Pre-sale blockers", "all clear",
        el("p", { class: "muted", style: "margin:0" }, "None — every pre-sale action is complete."));
    }
    const ul = el("ul", { class: "blockers" });
    for (const s of open) {
      const li = el("li", { class: "blocker-link", role: "link", tabindex: "0", title: `Go to action #${s.step}` }, [
        el("span", { class: "step-no" }, `#${s.step}`),
        el("span", {}, [s.action, " "]),
        statusBadge(s),
        el("span", { class: "blocker-go", "aria-hidden": "true" }, "→"),
      ]);
      li.addEventListener("click", () => goToStep(s.step));
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goToStep(s.step); } });
      ul.appendChild(li);
    }
    return collapsibleSection("__blockers__", "Pre-sale blockers", `${open.length} open`, ul);
  }

  function priorityPill(s) {
    if (s.presale) return el("span", { class: "pill-presale" }, /blocker/i.test(s.priority) ? "blocker" : (s.priority || "pre-sale"));
    if (!s.priority) return el("span", { class: "muted" }, "—");
    return el("span", { class: "pill-priority" }, s.priority);
  }

  const STATUS_OPTIONS = ["Open", "In progress", "Active", "Done", "Blocked"];
  function statusSelect(s, onStatus) {
    const opts = STATUS_OPTIONS.slice();
    if (s.status && !opts.some((o) => o.toLowerCase() === norm(s.status))) opts.unshift(s.status);
    const sel = el("select", { class: `status-select ${s.cls}`, "aria-label": `Status for action ${s.step}` },
      opts.map((o) => el("option", { value: o, selected: norm(o) === norm(s.status) ? "selected" : null }, o)));
    sel.addEventListener("change", () => onStatus(s.step, sel.value, sel));
    return sel;
  }

  function stepsTable(steps, { showAudience = false, editable = false, onStatus = null, onEditStep = null, onDeleteStep = null } = {}) {
    const manage = !!(onEditStep || onDeleteStep);
    const head = ["#", "Action", "Owner", "Status", "Priority"];
    if (showAudience) head.splice(3, 0, "Audience");
    if (manage) head.push("");
    const tbody = el("tbody");
    for (const s of steps) {
      const cells = [
        el("td", { class: "step-no-cell" }, String(s.step)),
        el("td", {}, [
          s.action,
          s.doc ? el("span", {}, [" ", el("a", { href: s.doc, target: "_blank", rel: "noopener" }, "doc ↗")]) : null,
          s.evidence ? el("div", { class: "evidence" }, `Evidence: ${s.evidence}`) : null,
        ]),
        el("td", {}, s.owner || "—"),
      ];
      if (showAudience) cells.push(el("td", { class: "muted" }, s.audience.join(", ") || "—"));
      cells.push(el("td", {}, editable && onStatus ? statusSelect(s, onStatus) : statusBadge(s)));
      cells.push(el("td", {}, priorityPill(s)));
      if (manage) cells.push(el("td", { class: "step-actions" }, [
        onEditStep ? actionBtn("Edit", "edit", { onClick: () => onEditStep(s) }) : null,
        onDeleteStep ? actionBtn("Delete", "trash", { danger: true, onClick: () => onDeleteStep(s) }) : null,
      ]));
      tbody.appendChild(el("tr", { id: `step-${s.step}`, class: "step-row" }, cells));
    }
    return el("div", { class: "table-wrap" },
      el("table", {}, [
        el("thead", {}, el("tr", {}, head.map((h) => el("th", { scope: "col" }, h)))),
        tbody,
      ]));
  }

  function byPhase(steps) {
    const groups = new Map();
    for (const s of steps) { if (!groups.has(s.phase)) groups.set(s.phase, []); groups.get(s.phase).push(s); }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }

  /* Collapsed-phase memory (persists which phases are folded, across reloads). */
  const COLLAPSE_KEY = "rushroom_portal_collapsed_phases";
  function getCollapsed() { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]")); } catch { return new Set(); } }
  function setCollapsed(set) { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* ignore */ } }
  function setAllPhases(open) {
    const names = new Set();
    for (const d of $$("details.phase")) {
      d.open = open;
      if (!open) { const n = d.dataset.phase; if (n) names.add(n); }
    }
    setCollapsed(open ? new Set() : names);
  }

  // Expand and smooth-scroll to a phase section (fast navigation from overview).
  function jumpToPhase(phase) {
    const target = $$("details.phase").find((d) => d.dataset.phase === phase);
    if (!target) return;
    target.open = true;
    const c = getCollapsed(); c.delete(phase); setCollapsed(c);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    const s = target.querySelector("summary");
    if (s && s.focus) s.focus({ preventScroll: true });
  }

  // Reusable collapsible block (same look/behaviour/persistence as phases).
  function collapsibleSection(key, title, meta, contentEl) {
    const details = el("details", { class: "phase", "data-phase": key }, [
      el("summary", { class: "phase-summary" }, [
        el("span", { class: "phase-name" }, title),
        meta ? el("span", { class: "phase-meta" }, meta) : null,
      ]),
      el("div", { class: "phase-content" }, contentEl),
    ]);
    if (!getCollapsed().has(key)) details.open = true; // set before listener to avoid a spurious save
    details.addEventListener("toggle", () => {
      const c = getCollapsed();
      if (details.open) c.delete(key); else c.add(key);
      setCollapsed(c);
    });
    return details;
  }

  function phaseToolbar() {
    return el("div", { class: "phase-tools" }, [
      actionBtn("Expand all", "expand", { onClick: () => setAllPhases(true) }),
      actionBtn("Collapse all", "collapse", { onClick: () => setAllPhases(false) }),
    ]);
  }

  function phaseSections(steps, opts = {}) {
    const collapsed = getCollapsed();
    const frag = el("div");
    for (const [phase, items] of byPhase(steps)) {
      const done = items.filter((s) => s.done).length;
      const pct = items.length ? Math.round((done / items.length) * 100) : 0;
      const details = el("details", { class: "phase", "data-phase": phase }, [
        el("summary", { class: "phase-summary" }, [
          el("span", { class: "phase-name" }, phase),
          el("span", { class: "phase-meta" }, `${done}/${items.length} done · ${pct}%`),
        ]),
        stepsTable(items.sort((a, b) => a.step - b.step), opts),
      ]);
      if (!collapsed.has(phase)) details.open = true; // set before listener to avoid a spurious save
      details.addEventListener("toggle", () => {
        const c = getCollapsed();
        if (details.open) c.delete(phase); else c.add(phase);
        setCollapsed(c);
      });
      frag.appendChild(details);
    }
    return frag;
  }

  // Two top-level sections (the second dimension), each grouped by category.
  const DOC_KINDS = [
    ["template", "Templates & Requirements", "Reference inputs to the work — version-controlled and reusable as starting points."],
    ["operational", "Company as Operated", "The actual operational documentation the AI deviation scan checks against the standards."],
  ];
  /* Blink state + remembered selection for the two-pane browsers.
   * flash(id) marks a freshly uploaded item to blink for 30s. */
  const flashUntil = new Map();   // id -> expiry timestamp (ms)
  const paneSelection = {};       // browser key -> selected item id
  const collapsedCats = new Set(); // "key::heading::category" of collapsed groups (persists across reloads)
  function flash(id) { if (id) flashUntil.set(String(id), Date.now() + 30000); }

  /* Generic Finder-style browser: a left list grouped by heading/category and a
   * right pane showing the selected item's card.
   *   key       — stable string so the selection persists across reloads
   *   tree      — [{ heading, count, action(el|null), hint, categories:[{ name, items:[{id,name,sub,data}] }] }]
   *   renderCard(item) -> element for the right pane
   */
  function twoPaneBrowser(key, tree, renderCard, opts = {}) {
    const root = el("div", { class: "browser" });
    const nav = el("nav", { class: "browser-nav", "aria-label": opts.navLabel || "Files" });
    const main = el("div", { class: "browser-main" });
    root.append(nav, main);

    const items = [];
    const rowById = new Map();
    const select = (item) => {
      if (!item) { main.replaceChildren(el("div", { class: "empty" }, opts.emptyDetail || "Select an item on the left.")); return; }
      paneSelection[key] = item.id;
      for (const [id, r] of rowById) r.classList.toggle("active", id === item.id);
      const r = rowById.get(item.id);
      if (r) { r.classList.remove("blink"); flashUntil.delete(String(item.id)); }
      main.replaceChildren(renderCard(item));
    };

    const setAll = (open) => {
      nav.querySelectorAll("details.browser-cat-group").forEach((d) => {
        d.open = open;
        if (open) collapsedCats.delete(d.dataset.catkey); else collapsedCats.add(d.dataset.catkey);
      });
    };
    // Live search over the left list (name + sub + keywords). Filters rows,
    // auto-opens matching categories, hides empty ones.
    const search = el("input", { type: "search", class: "browser-search-input", placeholder: opts.searchPlaceholder || "Search…", "aria-label": `Search ${opts.navLabel || "list"}` });
    const noResults = el("div", { class: "browser-empty muted", style: "display:none" }, "No matches.");
    const applyFilter = () => {
      const q = search.value.trim().toLowerCase();
      let total = 0;
      nav.querySelectorAll("details.browser-cat-group").forEach((d) => {
        let visible = 0;
        d.querySelectorAll(".browser-row").forEach((row) => {
          const match = !q || (row.dataset.search || "").includes(q);
          row.style.display = match ? "" : "none";
          if (match) visible++;
        });
        d.style.display = (visible || !q) ? "" : "none";
        d.open = q ? visible > 0 : !collapsedCats.has(d.dataset.catkey);
        total += visible;
      });
      noResults.style.display = (q && total === 0) ? "" : "none";
    };
    search.addEventListener("input", applyFilter);
    search.addEventListener("keydown", (e) => { if (e.key === "Escape") { search.value = ""; applyFilter(); } });
    nav.appendChild(el("div", { class: "browser-top" }, [
      search,
      el("div", { class: "browser-tools" }, [
        actionBtn("Expand all", "expand", { onClick: () => setAll(true) }),
        actionBtn("Collapse all", "collapse", { onClick: () => setAll(false) }),
      ]),
    ]));

    for (const group of tree) {
      if (group.heading || group.action || typeof group.count === "number") {
        nav.appendChild(el("div", { class: "browser-heading" }, [
          group.heading ? el("span", {}, group.heading) : null,
          typeof group.count === "number" ? el("span", { class: "count" }, `(${group.count})`) : null,
          group.action ? el("span", { class: "browser-head-action" }, group.action) : null,
        ].filter(Boolean)));
      }
      if (group.hint) nav.appendChild(el("div", { class: "browser-hint" }, group.hint));
      if (!group.categories.length) { nav.appendChild(el("div", { class: "browser-empty muted" }, opts.emptyGroup || "None yet.")); continue; }
      for (const cat of group.categories) {
        const catKey = `${key}::${group.heading || ""}::${cat.name}`;
        const rows = [];
        let hasFlash = false;
        for (const item of cat.items) {
          items.push(item);
          const row = el("button", { class: "browser-row", type: "button", "data-id": item.id, title: item.name, "data-search": `${item.name} ${item.sub || ""} ${item.keywords || ""}`.toLowerCase() }, [
            el("span", { class: "browser-row-name" }, item.name),
            item.ftypeHint ? fileTypeChip(item.ftypeHint) : null,
            item.sub ? el("span", { class: "browser-row-sub muted" }, item.sub) : null,
          ].filter(Boolean));
          rowById.set(item.id, row);
          const exp = flashUntil.get(String(item.id));
          if (exp && exp > Date.now()) { hasFlash = true; row.classList.add("blink"); setTimeout(() => row.classList.remove("blink"), exp - Date.now()); }
          row.addEventListener("click", () => select(item));
          rows.push(row);
        }
        if (hasFlash) collapsedCats.delete(catKey); // keep a flashing category open so its blink is visible
        const details = el("details", { class: "browser-cat-group", "data-catkey": catKey }, [
          el("summary", { class: "browser-cat-summary" }, [
            el("span", { class: "browser-cat-name" }, cat.name),
            el("span", { class: "browser-cat-count" }, String(cat.items.length)),
          ]),
          el("div", { class: "browser-cat-items" }, rows),
        ]);
        if (!collapsedCats.has(catKey)) details.open = true;
        details.addEventListener("toggle", () => {
          if (details.open) collapsedCats.delete(catKey); else collapsedCats.add(catKey);
        });
        nav.appendChild(details);
      }
    }
    nav.appendChild(noResults);

    // Keep the prior selection (or default to the first item). A freshly-uploaded
    // item is left to blink for attention rather than auto-opened, so its blink
    // persists until the user clicks it.
    const initial = items.find((i) => i.id === paneSelection[key]) || items[0];
    select(initial);
    return root;
  }

  // "Open ↗": PDFs open inline in a new browser tab; other types download so the
  // OS opens them in the associated app (Word/Excel) — for editing, search, etc.
  const extOf = (s) => (String(s || "").split("?")[0].split("#")[0].split(".").pop() || "").toLowerCase();
  const withDownload = (url, name) => (url ? `${url}${url.includes("?") ? "&" : "?"}download=${encodeURIComponent(name || "document")}` : url);
  function openHrefFor(url, name, hintPath) {
    return extOf(hintPath || name) === "pdf" ? url : withDownload(url, name); // PDF → inline; else → download
  }
  // A small file-type badge (PDF, DOCX, XLSX…) shown wherever files are listed,
  // so the user can see at a glance how a file opens before clicking. Colour
  // groups related formats; returns null when the type can't be determined.
  const FTYPE_CAT = { pdf: "pdf", doc: "doc", docx: "doc", rtf: "doc", odt: "doc", md: "text", txt: "text", csv: "sheet", xls: "sheet", xlsx: "sheet", ods: "sheet", ppt: "slide", pptx: "slide", png: "img", jpg: "img", jpeg: "img", gif: "img", webp: "img", svg: "img", heic: "img", zip: "zip" };
  function fileTypeOf(nameOrPath) {
    const base = String(nameOrPath || "").split("?")[0].split("#")[0].split("/").pop();
    if (!base || !base.includes(".")) return "";
    const ext = base.split(".").pop().toLowerCase();
    return ext && ext.length <= 5 ? ext : "";
  }
  function fileTypeChip(nameOrPath) {
    const ext = fileTypeOf(nameOrPath);
    if (!ext) return null;
    return el("span", { class: `ftype ftype-${FTYPE_CAT[ext] || "other"}`, title: `${ext.toUpperCase()} file` }, ext.toUpperCase());
  }

  // AI token usage → a compact "12.3k in · 2.3k out · ~$0.11" label, so the team
  // can see how much each AI operation costs. Pricing is USD per 1M tokens.
  const MODEL_PRICING = { "claude-opus-4-8": { in: 5, out: 25 }, "claude-opus-4-7": { in: 5, out: 25 }, "claude-sonnet-4-6": { in: 3, out: 15 }, "claude-haiku-4-5": { in: 1, out: 5 }, "claude-fable-5": { in: 10, out: 50 } };
  const fmtTokens = (n) => { n = n || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n); };
  function usageCostUSD(u) {
    const p = (u && MODEL_PRICING[u.model]) || MODEL_PRICING["claude-opus-4-8"];
    return (((u && u.input_tokens) || 0) * p.in + ((u && u.output_tokens) || 0) * p.out) / 1e6;
  }
  function usageLabel(u) {
    if (!u || (!u.input_tokens && !u.output_tokens)) return "";
    const c = usageCostUSD(u);
    return `${fmtTokens(u.input_tokens)} in · ${fmtTokens(u.output_tokens)} out · ~$${c < 0.01 ? c.toFixed(4) : c.toFixed(2)}`;
  }
  // A subtle inline chip for token usage (used in AI-result status lines).
  function usageChip(u) {
    const label = usageLabel(u);
    return label ? el("span", { class: "usage-chip", title: `AI tokens (${(u && u.model) || "claude-opus-4-8"})` }, `⚡ ${label}`) : null;
  }
  // Consistent inline SVG icons (feather-style, stroke = currentColor).
  const svg = (inner) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const ICONS = {
    eye: svg('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>'),
    external: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
    plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
    sparkles: svg('<path d="M12 2l1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6z"/>'),
    layers: svg('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'),
    trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
    refresh: svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
    printer: svg('<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    expand: svg('<polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/>'),
    collapse: svg('<polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/>'),
    diff: svg('<line x1="12" y1="3" x2="12" y2="21"/><polyline points="8 8 4 12 8 16"/><polyline points="16 8 20 12 16 16"/>'),
    tag: svg('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
    graph: svg('<circle cx="5" cy="6" r="2.4"/><circle cx="19" cy="6.5" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M6.9 7.4l3.6 8.2M17.2 8.2l-4 6.9M7.3 6.2h9.4"/>'),
    grid: svg('<rect x="3" y="3" width="18" height="18" rx="1"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/>'),
    gauge: svg('<path d="M3.34 19a10 10 0 1 1 17.32 0"/><path d="m12 14 4-4"/>'),
  };
  // File action chip (View / Open) — subtle pill; label hides on narrow screens.
  function fileActionBtn(label, iconKey, opts = {}) {
    const cls = "file-action" + (opts.danger ? " file-action-danger" : "");
    const kids = [el("span", { class: "fa-ico", html: ICONS[iconKey] || "" }), el("span", { class: "fa-label" }, label)];
    if (opts.href) return el("a", { class: cls, href: opts.href, target: "_blank", rel: "noopener", title: opts.title || label }, kids);
    return el("button", { class: cls, type: "button", title: opts.title || label, onclick: opts.onClick }, kids);
  }
  const viewChip = (onClick) => fileActionBtn("View", "eye", { onClick, title: "Quick inline preview" });
  const deleteChip = (onClick, title) => fileActionBtn("Delete", "trash", { onClick, danger: true, title: title || "Delete" });
  // Action button (New version / AI draft / …) — icon + label, primary/danger variants.
  function actionBtn(label, iconKey, opts = {}) {
    const cls = ["btn", "btn-sm", opts.primary ? "btn-primary" : "", opts.danger ? "doc-del" : "", opts.cls || ""].filter(Boolean).join(" ");
    const kids = [iconKey ? el("span", { class: "btn-ico", html: ICONS[iconKey] || "" }) : null, el("span", {}, label)].filter(Boolean);
    if (opts.href) return el("a", { class: cls, href: opts.href, target: opts.target || "_blank", rel: "noopener", title: opts.title || label }, kids);
    return el("button", { class: cls, type: "button", title: opts.title || label, onclick: opts.onClick }, kids);
  }
  function openInAppLink(url, name, hintPath) {
    if (!url) return null;
    const isPdf = extOf(hintPath || name) === "pdf";
    return fileActionBtn("Open", "external", { href: openHrefFor(url, name, hintPath), title: isPdf ? "Open the PDF in a new tab" : "Open in the app for this file type (Word, Excel…)" });
  }
  // View + Open chips for a stored file, grouped with consistent spacing.
  function versionFileActions(url, name, hintPath, onView) {
    if (!url) return null;
    return el("span", { class: "file-actions" }, [
      window.PortalViewer && onView ? viewChip(onView) : null,
      openInAppLink(url, name, hintPath),
    ].filter(Boolean));
  }

  // Sub-tabs within a panel (e.g. Library vs Add). Remembers the active tab
  // per key so it survives re-renders (reload after an add).
  const paneSubTab = { compliance: "status", documents: "list", standards: "list", level2: "clauses", deviations: "monitoring", accounts: "members" };
  function subTabs(key, tabs) {
    const bar = el("div", { class: "subtabs", role: "tablist" });
    const body = el("div", { class: "subtab-body" });
    const btns = {};
    const show = (id) => {
      paneSubTab[key] = id;
      for (const k in btns) { const on = k === id; btns[k].classList.toggle("active", on); btns[k].setAttribute("aria-selected", on ? "true" : "false"); }
      const t = tabs.find((x) => x.id === id) || tabs[0];
      body.replaceChildren(t.build());
    };
    for (const t of tabs) {
      const b = el("button", { class: "subtab", type: "button", role: "tab", onclick: () => show(t.id) }, [
        t.icon ? el("span", { class: "btn-ico", html: ICONS[t.icon] || "" }) : null, el("span", {}, t.label),
      ].filter(Boolean));
      btns[t.id] = b; bar.appendChild(b);
    }
    const wrap = el("div", {}, [bar, body]);
    show(tabs.some((t) => t.id === paneSubTab[key]) ? paneSubTab[key] : tabs[0].id);
    return wrap;
  }

  function documentLibrary(audienceFilter, docsInput, opts = {}) {
    const source = docsInput || CFG.documents || [];
    const docs = source.filter((d) => !audienceFilter || (d.audience || []).includes(audienceFilter));
    const wrap = el("div");
    if (!docs.length) { wrap.appendChild(el("div", { class: "empty" }, "No documents listed yet.")); return wrap; }

    const openViewer = (d) => {
      if (!window.PortalViewer) return;
      window.PortalViewer.open({ name: d.name, open_url: d.open_url || d.url, storage_path: d.storage_path || d.name });
    };
    const renderDoc = (d) => {
      const versions = d.versions || [];
      const current = versions[0];
      const currentRow = current
        ? el("div", { class: "std-current" }, [
            el("span", { class: "std-vlabel" }, `Current: v${versions.length}`),
            fileTypeChip(current.file_name || current.storage_path || d.name),
            el("span", { class: "muted" }, ` · added ${fmtDate(current.created_at)}`),
            versionFileActions(current.open_url, current.file_name || d.name, current.storage_path || d.storage_path, () => openViewer({ ...d, open_url: current.open_url, storage_path: current.storage_path || d.storage_path })),
            versions.length > 1 ? fileActionBtn("Changes", "diff", { title: "Highlight what changed vs the previous version", onClick: () => openVersionDiff({ title: `Changes — v${versions.length} vs v${versions.length - 1}`, oldUrl: versions[1].open_url, oldHint: versions[1].file_name || d.name, newUrl: current.open_url, newHint: current.file_name || d.name }) }) : null,
            opts.manage && opts.onEditVersion && d.id ? fileActionBtn("Edit", "edit", { onClick: () => opts.onEditVersion(d, current), title: "Edit this version → save as a new version" }) : null,
          ])
        : el("div", { class: "std-current muted" }, "No file uploaded yet.");
      const history = versions.length
        ? el("details", { class: "std-history" }, [
            el("summary", {}, `Version history (${versions.length})`),
            el("ul", { class: "std-versions" }, versions.map((v, vi) => {
              const sourceNotes = [];
              if (v.source_document_version) {
                sourceNotes.push(`Based on document version ${v.source_document_version.version || "—"}`);
              }
              if (Array.isArray(v.source_standard_versions) && v.source_standard_versions.length) {
                sourceNotes.push(`Referenced standards: ${v.source_standard_versions.map((sv) => `${sv.standard?.code || sv.standard?.title || "Standard"}${sv.version ? ` ${sv.version}` : ""}`).join(", ")}`);
              }
              return el("li", {}, [
                el("div", {}, [
                  el("span", { class: "std-vlabel" }, `v${versions.length - vi}`),
                  fileTypeChip(v.file_name || v.storage_path || d.name),
                  el("span", { class: "muted" }, ` · added ${fmtDate(v.created_at)}`),
                  versionFileActions(v.open_url, v.file_name || d.name, v.storage_path || d.storage_path, () => openViewer({ ...d, open_url: v.open_url, storage_path: v.storage_path || d.storage_path, name: v.file_name || d.name })),
                  vi + 1 < versions.length ? fileActionBtn("Changes", "diff", { title: "Highlight what changed vs the previous version", onClick: () => openVersionDiff({ title: `Changes — v${versions.length - vi} vs v${versions.length - vi - 1}`, oldUrl: versions[vi + 1].open_url, oldHint: versions[vi + 1].file_name || d.name, newUrl: v.open_url, newHint: v.file_name || d.name }) }) : null,
                  opts.manage && opts.onEditVersion && d.id ? fileActionBtn("Edit", "edit", { onClick: () => opts.onEditVersion(d, v), title: "Edit this version → save as a new version" }) : null,
                ]),
                v.notes ? el("div", { class: "std-notes" }, v.notes) : null,
                sourceNotes.length ? el("div", { class: "std-notes" }, sourceNotes.join(" · ")) : null,
              ]);
            })),
          ])
        : null;
      // Requirement links pointing at this document's versions (Rushroom only,
      // lazy-loaded per opened document; hidden entirely when there are none).
      const linkBox = el("div", { class: "rl-docbox" });
      if (opts.manage && versions.length) {
        const verIds = versions.map((v) => v.id).filter(Boolean);
        if (verIds.length) {
          const verLabel = new Map(versions.map((v, vi) => [v.id, `v${versions.length - vi}`]));
          API.listRequirementLinksForDocumentVersions(API.getToken(), verIds).then((r) => {
            const links = r.links || [];
            if (!links.length) { linkBox.replaceChildren(); return; }
            // "Our" side is a version of this doc OR one of its paragraphs; the
            // counterpart (usually a clause) is what we show.
            const items = links.map((l) => {
              const fromOurs = l.from && ((l.from.type === "document_version" && verIds.includes(l.from.id)) || l.from.type === "statement");
              const mine = fromOurs ? l.from : l.to;
              const other = fromOurs ? l.to : l.from;
              const ver = mine && mine.type === "statement" ? (mine.ref || "¶") : (verLabel.get(mine && mine.id) || "");
              return { l, other, ver };
            });
            linkBox.replaceChildren(el("details", { class: "rl-doclinks", open: "open" }, [
              el("summary", {}, `Linked requirements (${items.length})`),
              el("div", { class: "rl-inline" }, items.map(({ l, other, ver }) => el("span", { class: "rl-inline-item" }, [
                rlTypeChip(l.link_type),
                el("span", { class: "rl-arrow", "aria-hidden": "true" }, "→"),
                el("span", { class: "rl-target" }, [
                  el("strong", {}, (other && other.label) || "(removed)"),
                  el("span", { class: "rl-kind" }, other && other.type === "document_version" ? "doc" : "clause"),
                ]),
                ver ? el("span", { class: "rl-kind" }, ver) : null,
                rlStatusChip(l.status),
              ]))),
              el("div", { class: "muted", style: "font-size:0.78rem; margin-top:0.3rem" }, "Manage in Clauses & DPP → Links, or in “Paragraphs & links” below."),
            ]));
          }).catch(() => linkBox.replaceChildren());
        }
      }
      const link = d.open_url || d.url;
      const viewAction = link
        ? el("span", { class: "file-actions" }, [
            window.PortalViewer ? viewChip(() => openViewer(d)) : null,
            openInAppLink(link, d.name, d.storage_path || d.name),
          ].filter(Boolean))
        : el("span", { class: "pending" }, "link pending");
      const actions = [
        opts.manage && opts.onNewVersion && d.id ? actionBtn("New version", "plus", { primary: true, onClick: () => opts.onNewVersion(d) }) : null,
        opts.manage && opts.onDraft && d.id && (d.kind || "template") === "operational" ? actionBtn("AI draft", "sparkles", { onClick: () => opts.onDraft(d) }) : null,
        opts.manage && opts.onCreateOperational && d.id && (d.kind || "template") === "template" ? actionBtn("Create as-operated", "layers", { onClick: () => opts.onCreateOperational(d) }) : null,
        viewAction,
        opts.manage && opts.onDeleteDocument && d.id ? actionBtn("Delete", "trash", { danger: true, onClick: () => opts.onDeleteDocument(d) }) : null,
      ].filter(Boolean);
      return el("div", { class: "doc doc-op" }, [
        el("div", {}, [el("div", { class: "name" }, [el("span", {}, d.name), fileTypeChip((current && (current.file_name || current.storage_path)) || d.storage_path || d.url || d.name)]), el("div", { class: "audience" }, `For: ${(d.audience || []).join(", ") || "—"}`)]),
        currentRow,
        linkBox,
        // Paragraph-level linking for the current version (Rushroom only).
        opts.manage && current && current.id ? docStatementsPanel(d, current) : null,
        history,
        el("div", { class: "doc-actions" }, actions),
      ]);
    };

    const tree = [];
    for (const [kind, label, hint] of DOC_KINDS) {
      const kdocs = docs.filter((d) => (d.kind || "template") === kind);
      if (!kdocs.length && !opts.manage) continue;
      const cats = new Map();
      for (const d of kdocs) { const c = d.category || "Uncategorised"; if (!cats.has(c)) cats.set(c, []); cats.get(c).push(d); }
      const categories = [...cats].map(([name, list]) => ({
        name,
        items: list.map((d) => ({
          id: d.id || d.name,
          name: d.name,
          ftypeHint: (d.versions && d.versions[0] && d.versions[0].file_name) || d.storage_path || d.url || d.name,
          sub: `${(d.versions || []).length} version${(d.versions || []).length === 1 ? "" : "s"}`,
          keywords: `${d.category || ""} ${(d.audience || []).join(" ")}`,
          data: d,
        })),
      }));
      const action = (opts.manage && opts.onCreateNew && kind === "operational")
        ? actionBtn("New As Operated", "plus", { primary: true, cls: "doc-kind-new", onClick: () => opts.onCreateNew() })
        : null;
      tree.push({ heading: label, count: kdocs.length, action, hint, categories });
    }
    wrap.appendChild(twoPaneBrowser("documents", tree, (item) => renderDoc(item.data), {
      navLabel: "Documents", emptyDetail: "Select a document on the left.", searchPlaceholder: "Search documents…",
    }));
    return wrap;
  }

  function sourceNotice(source) {
    if (source === "live") return null;
    if (source === "fallback") {
      return el("div", { class: "notice" }, [
        "Couldn't reach the live action-plan Sheet yet, so this shows the bundled snapshot. ",
        "Set the Sheet to ", el("strong", {}, "Anyone with the link → Viewer"),
        " (or File → Share → Publish to web → CSV); the dashboard then switches to live automatically.",
      ]);
    }
    return el("div", { class: "notice" },
      "Showing the bundled snapshot of the action plan. Publish the action-plan Google Sheet to CSV and set statusSheetCsvUrl in assets/config.js to read live status.");
  }

  /* ---------------- accessible tabs ---------------- */
  function wireTabs(tablist) {
    const tabs = $$('[role="tab"]', tablist);
    const select = (tab) => {
      for (const t of tabs) {
        const sel = t === tab;
        t.setAttribute("aria-selected", sel ? "true" : "false");
        t.tabIndex = sel ? 0 : -1;
        const panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !sel;
      }
    };
    tablist.addEventListener("click", (e) => { const t = e.target.closest('[role="tab"]'); if (t) { select(t); t.focus(); } });
    tablist.addEventListener("keydown", (e) => {
      const idx = tabs.indexOf(document.activeElement);
      if (idx < 0) return;
      let next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = tabs[(idx + 1) % tabs.length];
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = tabs[(idx - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); select(next); next.focus(); }
    });
  }

  /* ---------------- API (Supabase) mode ---------------- */
  const API = window.PortalAPI;
  const apiEnabled = () => !!(API && API.configured());

  // Map a DB row from the Edge Function into the same shape the renderers use.
  function stepsFromApi(rows) {
    return (rows || []).map((r) => {
      const n = normalizeStep({
        step: r.step, phase: r.phase, action: r.action, owner: r.owner,
        "where / how": r.where_how, "output / evidence": r.evidence,
        folder: r.folder, priority: r.priority, status: r.status,
        audience: Array.isArray(r.audience) ? r.audience.join(", ") : (r.audience || ""),
      });
      n.updatedBy = r.updated_by || "";
      n.lifecycle_phase = r.lifecycle_phase || null;
      n.scope = r.scope || null;
      return n;
    });
  }

  // Login gate backed by the Edge Function (replaces the client-side hash gate).
  function setupApiGate(role, onUnlock) {
    const gate = $("#gate"), appEl = $("#portal-app");
    const reveal = () => {
      gate.hidden = true; appEl.hidden = false; onUnlock();
      const h = appEl.querySelector("h2, h3"); if (h) { h.setAttribute("tabindex", "-1"); h.focus(); }
    };
    if (API.getToken(role)) { reveal(); return; }
    addRegisterCta(gate);
    const form = $("#gate-form"), input = $("#portal-password"), err = $("#gate-error");
    input.focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = ""; input.setAttribute("aria-invalid", "false");
      const btn = form.querySelector("button"); btn.disabled = true;
      try {
        await API.login(role, input.value);
        reveal();
      } catch (ex) {
        input.setAttribute("aria-invalid", "true");
        err.textContent = ex.message || "Login failed."; input.select();
      } finally { btn.disabled = false; }
    });
  }

  // File-upload card (suppliers submit declarations; Rushroom can attach files).
  // PUT a file to a signed URL via XHR so we get real upload-progress events.
  function xhrPut(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      if (xhr.upload) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`HTTP ${xhr.status}`));
      xhr.onerror = () => reject(new Error("network error"));
      xhr.send(file);
    });
  }

  /* An upload field: drag-and-drop zone + themed Choose File + progress bar. The
   * file is uploaded to storage as soon as it is chosen or dropped, showing a
   * progress bar; dependent buttons (registered via register()) stay disabled
   * until the upload has completed. This also makes drag-and-drop robust on
   * browsers that don't allow assigning input.files (the dropped File is used
   * directly, not read back from the input). */
  function uploadZone(role, bucket, opts = {}) {
    // When true, the bar spans the whole operation: upload fills 0→UP_CAP, then
    // the AI read fills UP_CAP→100 (the consumer calls finishProcessing() when the
    // read completes). Zones with no AI read complete at 100 on upload.
    const hasProc = !!opts.processing;
    const UP_CAP = hasProc ? 55 : 100;      // share of the bar the upload phase gets
    const input = el("input", { type: "file", class: "up-file", "aria-label": opts.ariaLabel || "Choose a file" });
    const bar = el("div", { class: "up-progress-bar" });
    const pct = el("span", { class: "up-progress-pct" }, "0%");
    const barWrap = el("div", { class: "up-progress-row", hidden: "" }, [el("div", { class: "up-progress" }, bar), pct]);
    const info = el("div", { class: "dropzone-file muted" }, "No file selected.");
    // Dashed drop target holds only the hint + file picker …
    const dropbox = el("div", { class: "dropzone" }, [
      el("div", { class: "dropzone-hint" }, [
        el("span", { class: "dropzone-ico", "aria-hidden": "true" }, "⬆"),
        el("span", {}, opts.hint || "Drag & drop a file here, or"),
      ]),
      input,
    ]);
    // … and the status + progress bar sit below it, representing the full process.
    const wrap = el("div", { class: "upload-zone" }, [dropbox, info, barWrap]);

    let file = null, uploaded = null, uploading = false;
    const readyCbs = []; if (opts.onReady) readyCbs.push(opts.onReady); // run when an upload completes
    const gated = []; // { el, requireFile }
    // Gated buttons stay disabled until the bar reaches 100% — i.e. while the
    // file is uploading AND while the AI read (phase "process") is running.
    const sync = () => { for (const g of gated) g.el.disabled = uploading || phase === "process" || (g.requireFile && !uploaded); };
    const register = (btnEl, requireFile = true) => { gated.push({ el: btnEl, requireFile }); sync(); };

    // Smoothly animated 0→100 progress: the displayed value eases toward a moving
    // target, so even an instant step visibly counts up; real XHR progress and a
    // steady "trickle" both push the target forward.
    // phase: "idle" | "upload" | "process" | "done"
    let dispPct = 0, targetPct = 0, rafId = null, trickleId = null, phase = "idle";
    let doneLabel = "", doneCls = "ok";
    const paint = () => {
      const v = Math.max(0, Math.min(100, dispPct));
      bar.style.width = v.toFixed(1) + "%";
      pct.textContent = Math.round(v) + "%";           // always-updating counter
      if (file && phase === "upload") info.textContent = `Uploading “${file.name}”…`;
      else if (file && phase === "process") info.textContent = `Reading “${file.name}” with AI…`;
    };
    const tick = () => {
      const diff = targetPct - dispPct;
      if (diff <= 0.4) {
        dispPct = targetPct; paint(); rafId = null;
        if (phase === "done" && dispPct >= 100 && file) { info.className = "dropzone-file " + doneCls; info.textContent = doneLabel; }
        return;
      }
      dispPct = Math.min(targetPct, dispPct + diff * 0.12 + 0.4);
      paint();
      rafId = requestAnimationFrame(tick);
    };
    const bump = (t) => { targetPct = Math.max(targetPct, Math.min(100, t)); if (rafId == null) rafId = requestAnimationFrame(tick); };
    const stopTrickle = () => { if (trickleId) { clearInterval(trickleId); trickleId = null; } };
    const stopAnim = () => { stopTrickle(); if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } };

    const startUpload = async (f) => {
      file = f; uploaded = null; uploading = true; sync();
      stopAnim(); dispPct = 0; targetPct = 0; phase = "upload";
      info.className = "dropzone-file"; barWrap.hidden = false; paint();
      // creep toward just under the upload cap so the bar always shows movement
      const upTop = UP_CAP - 6;
      trickleId = setInterval(() => { if (phase === "upload" && targetPct < upTop) bump(targetPct + Math.max(1.2, (upTop - targetPct) * 0.06)); }, 120);
      try {
        const { signedUrl, path } = await API.signedUploadUrl(API.getToken(role), f.name, bucket);
        await xhrPut(signedUrl, f, (p) => bump(Math.min(UP_CAP - 3, p * UP_CAP / 100)));
        stopTrickle();
        uploaded = { path, fileName: f.name }; uploading = false;
        if (hasProc) {
          // Hand off to the AI-read phase: fill the remaining UP_CAP→~96 slowly
          // while the model reads the file; finishProcessing() lands it on 100.
          phase = "process"; bump(UP_CAP); paint();
          trickleId = setInterval(() => { if (phase === "process" && targetPct < 96) bump(targetPct + Math.max(0.5, (96 - targetPct) * 0.035)); }, 220);
        } else {
          phase = "done"; doneLabel = `✓ ${f.name} — uploaded`; doneCls = "ok"; bump(100);
        }
        sync(); // keep gated buttons disabled through the AI-read phase
        for (const cb of readyCbs) { try { cb(uploaded, f); } catch (_) {} }
      } catch (ex) {
        stopAnim();
        uploading = false; uploaded = null; phase = "idle"; sync();
        info.className = "dropzone-file err"; info.textContent = `Upload failed: ${ex.message}. Please try again.`;
        barWrap.hidden = true;
      }
    };

    input.addEventListener("change", () => { const f = input.files && input.files[0]; if (f) startUpload(f); });
    const setDrag = (on) => dropbox.classList.toggle("dragover", on);
    dropbox.addEventListener("dragenter", (e) => { e.preventDefault(); setDrag(true); });
    dropbox.addEventListener("dragover", (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; setDrag(true); });
    dropbox.addEventListener("dragleave", (e) => { if (!dropbox.contains(e.relatedTarget)) setDrag(false); });
    dropbox.addEventListener("drop", (e) => {
      e.preventDefault(); setDrag(false);
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      try { const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files; } catch (_) { /* Safari: ignore, we use f directly */ }
      startUpload(f);
    });

    return {
      el: wrap, bucket, register,
      onReady: (fn) => { if (fn) readyCbs.push(fn); },
      // Called by the AI-read consumer to land the bar on 100% once the read is
      // done (ok=true) or failed (ok=false, bar still completes so it never hangs).
      finishProcessing: (ok, label) => {
        if (phase !== "process") return;
        stopTrickle(); phase = "done";
        doneCls = ok ? "ok" : "warn";
        const nm = file ? file.name : "file";
        doneLabel = label || (ok ? `✓ ${nm} — uploaded & read` : `✓ ${nm} — uploaded (couldn’t read automatically)`);
        bump(100);
        sync(); // bar is at 100% — release the gated buttons
      },
      getUploaded: () => uploaded,
      getFile: () => file,
      isUploading: () => uploading,
      reset: () => {
        stopAnim();
        file = null; uploaded = null; uploading = false; phase = "idle";
        dispPct = 0; targetPct = 0;
        try { input.value = ""; } catch (_) {}
        bar.style.width = "0%"; pct.textContent = "0%"; barWrap.hidden = true;
        info.className = "dropzone-file muted"; info.textContent = "No file selected.";
        sync();
      },
    };
  }

  /* AI "read the uploaded file and fill fields" — runs automatically as soon as
   * the file finishes uploading (one batch, no separate button). Uses the file
   * already uploaded by the uploadZone, so it is instant and never re-uploads. */
  function aiAutofill(role, { zone, statusEl, onFill }) {
    zone.onReady(async (up) => {
      if (!up) return;
      statusEl.className = "up-status"; statusEl.textContent = "✨ Reading the file with AI…";
      try {
        const meta = await API.suggestFileMetadata(API.getToken(role), { path: up.path, fileName: up.fileName, bucket: zone.bucket });
        onFill(meta, up);
        statusEl.className = "up-status ok";
        statusEl.textContent = meta.summary ? `AI read: ${meta.summary} — review and approve.` : "AI filled the fields — review and approve.";
        zone.finishProcessing(true);
      } catch (ex) {
        statusEl.className = "up-status err"; statusEl.textContent = `Couldn't read the file automatically: ${ex.message}. You can still fill the fields manually.`;
        zone.finishProcessing(false);
      }
    });
  }

  function uploadCard(role, steps) {
    const zone = uploadZone(role, "uploads", { ariaLabel: "Choose a file to upload", processing: true });
    const stepSel = el("select", { class: "up-step", "aria-label": "Related action (optional)" }, [
      el("option", { value: "" }, "— related action (optional) —"),
      ...steps.map((s) => el("option", { value: String(s.step) }, `#${s.step} · ${s.action.slice(0, 60)}`)),
    ]);
    const who = role === "supplier"
      ? el("input", { type: "text", class: "up-who", placeholder: "Your company (optional)", "aria-label": "Your company" })
      : null;
    const note = el("input", { type: "text", class: "up-note", placeholder: "Note (optional)", "aria-label": "Note" });
    const status = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const btn = el("button", { class: "btn btn-primary", type: "button" }, "Upload");
    aiAutofill(role, { zone, statusEl: status, onFill: (meta) => {
      if (meta.summary && !note.value.trim()) note.value = meta.summary;
    } });
    zone.register(btn);
    btn.addEventListener("click", async () => {
      const up = zone.getUploaded();
      if (!up) { status.className = "up-status warn"; status.textContent = "Add a file first."; return; }
      btn.disabled = true; status.className = "up-status"; status.textContent = "Saving…";
      try {
        await API.recordUploadRecord(API.getToken(role), { step: stepSel.value || null, note: note.value, supplierLabel: who ? who.value : "", path: up.path, fileName: up.fileName });
        status.className = "up-status ok"; status.textContent = `Uploaded “${up.fileName}”. Thank you.`;
        zone.reset(); note.value = "";
      } catch (ex) {
        btn.disabled = false; status.className = "up-status err"; status.textContent = `Failed: ${ex.message}`;
      }
    });
    return el("div", { class: "card upload-card" }, [
      el("h3", {}, "Upload a document"),
      el("p", { class: "muted", style: "margin:0.25rem 0 1rem" }, role === "supplier"
        ? "Submit your signed declaration, test reports, datasheets, or RoHS/REACH declarations. The AI reads the file and suggests a note automatically."
        : "Attach a file to the technical file or a specific action. The AI reads the file and suggests a note automatically."),
      zone.el,
      el("div", { class: "upload-fields", style: "margin-top:0.6rem" }, [stepSel, who, note].filter(Boolean)),
      el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.6rem" }, btn),
      status,
    ]);
  }

  // Rushroom-only: add a file to the document library (stored in Supabase).
  function manageDocumentsCard(role, reload) {
    if (role !== "rushroom") return null;
    const zone = uploadZone(role, "documents", { ariaLabel: "Choose a document to add", processing: true });
    const name = el("input", { type: "text", class: "up-text", placeholder: "Display name (defaults to file name)", "aria-label": "Document name" });
    const category = el("input", { type: "text", class: "up-text", placeholder: "Category (e.g. Test reports)", "aria-label": "Category" });
    const kind = el("select", { class: "up-text", "aria-label": "Section" }, [
      el("option", { value: "template" }, "Templates & Requirements"),
      el("option", { value: "operational" }, "Company as Operated (AI-audited)"),
    ]);
    // Compliance classification (lifecycle phase × scope) — captured at creation.
    const docPhase = phaseSelect("");
    const docScope = scopeSelect("");
    const auds = ["internal", "supplier", "reviewer", "installer"].map((a) => {
      const cb = el("input", { type: "checkbox", value: a, checked: a === "internal" ? "checked" : null });
      return { a, cb, label: el("label", { class: "aud-check" }, [cb, ` ${a}`]) };
    });
    const status = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const btn = el("button", { class: "btn btn-primary", type: "button" }, "Add document");
    aiAutofill(role, { zone, statusEl: status, onFill: (meta) => {
      if (meta.name) name.value = meta.name;
      if (meta.category) category.value = meta.category;
      if (meta.kind === "template" || meta.kind === "operational") kind.value = meta.kind;
    } });
    zone.register(btn);
    btn.addEventListener("click", async () => {
      const up = zone.getUploaded();
      if (!up) { status.className = "up-status warn"; status.textContent = "Add a file first."; return; }
      const audience = auds.filter((c) => c.cb.checked).map((c) => c.a);
      if (!audience.length) audience.push("internal");
      btn.disabled = true; status.className = "up-status"; status.textContent = "Adding…";
      try {
        const res = await API.addDocumentRecord(API.getToken(role), { category: category.value, name: name.value || up.fileName, audience, kind: kind.value, path: up.path, fileName: up.fileName, lifecyclePhase: docPhase.value || null, scope: docScope.value || null });
        flash(res && res.id);
        status.className = "up-status ok"; status.textContent = `Added “${name.value || up.fileName}”.`;
        zone.reset(); name.value = ""; category.value = "";
        paneSubTab.documents = "list"; // show the new doc (blinking) in the library
        await reload();
      } catch (ex) {
        btn.disabled = false; status.className = "up-status err"; status.textContent = `Failed: ${ex.message}`;
      }
    });
    return el("div", { class: "card upload-card" }, [
      el("h3", {}, "Manage documents"),
      el("p", { class: "muted", style: "margin:0.25rem 0 1rem" }, "Upload a file — the AI reads its name, category and section for you. Review, then add. Templates can later become As Operated documents without deleting anything."),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Document file"), zone.el]),
      el("div", { class: "upload-fields" }, [name, category, kind]),
      el("div", { class: "form-row", style: "margin-top:0.6rem" }, [el("span", { class: "form-label" }, "Compliance quadrant"), el("div", { class: "cs-quad-picker" }, [docPhase, docScope])]),
      el("div", { class: "aud-checks" }, auds.map((c) => c.label)),
      el("div", { style: "margin-top:0.75rem" }, btn),
      status,
    ]);
  }

  function createOperationalFromTemplate(templateDoc, role, reload, templates) {
    documentDraftAssistant(null, role, reload, {
      templateDoc,
      templates: templates || [],
      title: `Create As Operated — ${templateDoc.name || "template"}`,
      initialName: `${templateDoc.name || "Template"} — As Operated`,
      mode: "create",
    });
  }

  // Route the per-row "Edit" action by file type: editable Office/text formats
  // go straight to the Google round-trip; PDFs (and other non-editable types)
  // can't be edited in place, so we open the upload path with an explanation.
  function editDocumentVersion(d, v, role, reload) {
    const hint = (v && (v.file_name || v.storage_path)) || d.storage_path || d.name;
    const ext = extOf(hint);
    const editable = ["docx", "md", "markdown", "html", "htm", "txt", "xlsx", "xls", ""].includes(ext);
    const gready = !!(window.PortalGDocs && window.PortalGDocs.configured());
    if (editable && gready) documentVersionEditor(d, role, reload, { sourceVersion: v, focus: "google" });
    else documentVersionEditor(d, role, reload, { sourceVersion: v, focus: "upload", reason: editable ? "google-off" : "pdf" });
  }

  // Upload a new version of a document (previous versions kept).
  // opts: { sourceVersion, focus: "google"|"upload", reason } — used by the
  // per-row Edit action; with no opts it's the full "New version" modal.
  function documentVersionEditor(d, role, reload, opts = {}) {
    const current = (d.versions || [])[0];
    const src = opts.sourceVersion || current;   // the version being edited/replaced
    const currentUrl = (src && src.open_url) || d.open_url;
    const currentHint = (src && (src.file_name || src.storage_path)) || d.storage_path || d.name;
    const gdocsReady = !!(window.PortalGDocs && window.PortalGDocs.configured());
    const currentExt = extOf(currentHint);
    const isSheet = currentExt === "xlsx" || currentExt === "xls";
    const canGoogleEdit = ["docx", "md", "markdown", "html", "htm", "txt", "xlsx", "xls", ""].includes(currentExt);
    const gTool = isSheet ? "Google Sheets" : "Google Docs";
    const focus = opts.focus; // "google" | "upload" | undefined (show both)
    const showGoogle = gdocsReady && currentUrl && canGoogleEdit && focus !== "upload";
    const showUpload = focus !== "google" || !showGoogle;

    // Shared version metadata (used by both the Google edit and the upload paths).
    const version = el("input", { type: "text", placeholder: "Leave blank to auto-number (v2, v3…) — or type a custom label" });
    const notes = el("textarea", { rows: "2", placeholder: "What changed (optional)" });

    // ---- Path A: edit the current version in Google Docs/Sheets, save back as a new version ----
    let gdocId = null, gdocKind = "doc";
    const gopen = el("button", { class: "btn btn-sm btn-primary", type: "button" }, `📝 Open current version in ${gTool}`);
    const gsave = el("button", { class: "btn btn-primary", type: "button" }, `⬆ Save ${isSheet ? "Google Sheet" : "Google Doc"} as new version`);
    const glink = el("span", { style: "font-size:0.85rem" });
    const gstatus = el("p", { class: "up-status", role: "status", "aria-live": "polite", style: "margin:0.4rem 0 0" }, "");
    gsave.disabled = true;
    const gsection = showGoogle ? el("div", { class: "src-section" }, [
      el("div", { class: "src-head" }, `Edit ${opts.sourceVersion ? "this version" : "the current version"} in ${gTool}`),
      el("p", { class: "muted", style: "margin:0.1rem 0 0.6rem" }, `Open the file, edit it in ${gTool}, then save it back as a new version — same document and references, nothing else changes.`),
      el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center" }, [gopen, glink]),
      gstatus,
      el("div", { style: "margin-top:0.5rem" }, gsave),
    ]) : null;

    // ---- Path B: upload a new file ----
    const zone = uploadZone(role, "documents", { ariaLabel: "Choose the new version file", processing: true });
    const note = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const save = el("button", { class: "btn btn-primary", type: "button" }, "Upload new version");
    aiAutofill(role, { zone, statusEl: note, onFill: (meta) => {
      if (meta.version && !version.value.trim()) version.value = meta.version;
      if (meta.summary && !notes.value.trim()) notes.value = meta.summary;
    } });
    zone.register(save);

    const reasonNote = opts.reason === "pdf"
      ? el("div", { class: "notice warn" }, `PDF files can't be edited in Google Docs. Upload a corrected file below${(d.kind || "template") === "operational" ? ", or close this and use “AI draft” to generate a new version." : "."}`)
      : opts.reason === "google-off"
        ? el("div", { class: "notice" }, "Google editing isn't set up, so upload a replacement file to create the new version.")
        : null;
    const uploadPath = showUpload ? [
      showGoogle ? el("div", { class: "muted", style: "text-align:center; margin:0.4rem 0" }, "— or upload a replacement file —") : null,
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "File"), zone.el]),
      note, el("div", { style: "margin-top:0.5rem" }, save),
    ] : [];
    const form = el("div", { class: "step-form" }, [
      reasonNote,
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Version label"), version]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Notes"), notes]),
      gsection,
      ...uploadPath,
    ].filter(Boolean));
    const close = openModal(`${focus ? "Edit" : "New version"} — ${d.name}`, form);

    save.addEventListener("click", async () => {
      const up = zone.getUploaded();
      if (!up) { note.className = "up-status warn"; note.textContent = "Add a file first."; return; }
      save.disabled = true; note.className = "up-status"; note.textContent = "Saving…";
      try {
        await API.addDocumentVersionRecord(API.getToken(role), { documentId: d.id, version: version.value, notes: notes.value, path: up.path, fileName: up.fileName });
        flash(d.id); close(); await reload();
      } catch (ex) { save.disabled = false; note.className = "up-status err"; note.textContent = `Failed: ${ex.message}`; }
    });

    gopen.addEventListener("click", async () => {
      if (!currentUrl) { gstatus.className = "up-status warn"; gstatus.textContent = "This document has no current file to edit."; return; }
      const win = window.open("", "_blank"); // opened in the gesture to avoid popup blocking
      gopen.disabled = true; gstatus.className = "up-status"; gstatus.textContent = `Preparing the file in ${gTool}…`;
      try {
        await window.PortalGDocs.getToken();
        const resp = await fetch(currentUrl);
        if (!resp.ok) throw new Error(`couldn't read the current file (HTTP ${resp.status}) — reopen the library`);
        const buf = await resp.arrayBuffer();
        const ext = extOf(currentHint);
        let blob, kind = "doc";
        if (ext === "docx") {
          blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        } else if (ext === "xlsx" || ext === "xls") {
          blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); kind = "sheet";
        } else if (ext === "md" || ext === "markdown") {
          const text = unescapeUnicode(new TextDecoder().decode(new Uint8Array(buf)));
          await loadScript(MARKED_CDN);
          blob = new Blob([window.marked.parse(text || "")], { type: "text/html" });
        } else if (ext === "html" || ext === "htm" || ext === "txt" || ext === "") {
          const text = unescapeUnicode(new TextDecoder().decode(new Uint8Array(buf)));
          blob = new Blob([text], { type: (ext === "html" || ext === "htm") ? "text/html" : "text/plain" });
        } else {
          if (win && !win.closed) win.close();
          gstatus.className = "up-status err"; gstatus.textContent = `“.${ext}” can't be edited in Google — upload a replacement below instead.`;
          gopen.disabled = false; return;
        }
        const res = await window.PortalGDocs.importDoc(blob, d.name, kind);
        gdocId = res.documentId; gdocKind = res.kind;
        if (win && !win.closed) win.location.href = res.editUrl; else window.open(res.editUrl, "_blank", "noopener");
        glink.replaceChildren(el("a", { href: res.editUrl, target: "_blank", rel: "noopener", class: "linklike" }, `Open ${gTool} ↗`));
        gsave.disabled = false;
        gstatus.className = "up-status ok"; gstatus.textContent = `Opened in ${gTool}. Edit there, then Save as new version.`;
      } catch (ex) {
        if (win && !win.closed) win.close();
        gstatus.className = "up-status err"; gstatus.textContent = `Couldn't open in ${gTool}: ${ex.message}`;
        gopen.disabled = false;
      }
    });

    gsave.addEventListener("click", async () => {
      if (!gdocId) { gstatus.className = "up-status warn"; gstatus.textContent = `Open the file in ${gTool} first.`; return; }
      gsave.disabled = true; gstatus.className = "up-status"; gstatus.textContent = "Saving the edited file as a new version…";
      try {
        const exportKind = gdocKind === "sheet" ? "xlsx" : "docx";
        const blob = await window.PortalGDocs.exportDoc(gdocId, exportKind);
        const carried = (src && Array.isArray(src.source_standard_versions)) ? src.source_standard_versions.map((sv) => sv && sv.id).filter(Boolean) : [];
        const fileName = `${(d.name || "document").replace(/[^a-z0-9._-]+/gi, "_") || "document"}.${exportKind}`;
        await API.addDocumentVersionFile(API.getToken(role), blob, { documentId: d.id, version: version.value, notes: notes.value, fileName, sourceStandardVersionIds: carried });
        flash(d.id); close(); await reload();
      } catch (ex) {
        gsave.disabled = false; gstatus.className = "up-status err"; gstatus.textContent = `Couldn't save the new version: ${ex.message}`;
      }
    });
  }

  function documentDraftAssistant(d, role, reload, options = {}) {
    const templateDoc = options.templateDoc || null;
    const templates = options.templates || [];
    const isCreateMode = options.mode === "create" || !d;
    const defaultName = options.initialName || (d ? d.name : "New As Operated");
    const name = el("input", { type: "text", class: "up-text", value: defaultName, placeholder: "Name of the As Operated document", "aria-label": "As Operated document name" });
    // A generic default name may be auto-replaced when a template is picked.
    if (isCreateMode && !options.initialName) name.dataset.auto = "1";
    const notes = el("textarea", { rows: "3", placeholder: "e.g. reflect the latest requirements, tighten wording, add the sign-off section" });
    const version = el("input", { type: "text", placeholder: "Leave blank to auto-number (v2, v3…) — or type a custom label" });
    const status = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const generate = el("button", { class: "btn btn-primary", type: "button" }, "Generate draft");
    const publish = el("button", { class: "btn btn-primary", type: "button" }, "Publish approved draft");
    const changeList = el("div", { style: "margin-top:0.75rem" });
    const draft = el("textarea", { rows: "12", style: "width:100%; margin-top:0.75rem", placeholder: "The AI-generated draft will appear here" });
    const standardsWrap = el("div", { style: "margin-top:0.4rem" });
    publish.disabled = true;
    // A second Publish button at the bottom, so you can publish right after
    // editing the draft / fetching from Google Docs without scrolling up.
    const publishBottom = el("button", { class: "btn btn-primary", type: "button" }, "✓ Publish approved draft");
    publishBottom.disabled = true;
    const publishStatus = el("p", { class: "up-status", role: "status", "aria-live": "polite", style: "margin:0.5rem 0 0" }, "");
    let draftResult = null;

    // Google Docs round-trip: edit the generated draft in Google Docs, then pull
    // the edited content back before publishing. Shown after a draft exists.
    const gdocEdit = el("button", { class: "btn btn-sm", type: "button" }, "📝 Edit in Google Docs");
    const gdocPublish = el("button", { class: "btn btn-sm btn-primary", type: "button" }, "⬆ Publish from Google Docs (Word)");
    const gdocFetch = el("button", { class: "btn btn-sm", type: "button" }, "↓ Fetch text back");
    const gdocLink = el("span", { style: "font-size:0.85rem" });
    const gdocStatus = el("p", { class: "up-status", role: "status", "aria-live": "polite", style: "margin:0.4rem 0 0" }, "");
    const gdocRow = el("div", { style: "display:none; margin-top:0.6rem" }, [
      el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center" }, [gdocEdit, gdocPublish, gdocFetch, gdocLink]),
      gdocStatus,
    ]);
    gdocFetch.style.display = "none"; gdocPublish.style.display = "none";
    let googleDocId = null;
    const gdocDocName = () => (isCreateMode ? name.value.trim() : (d ? d.name : "")) || "Rushroom compliance draft";

    // Path 1 source — a template picker (create mode) or the base document (update mode).
    let templateSelect = null;
    if (isCreateMode) {
      templateSelect = el("select", { class: "up-text", "aria-label": "Start from a template" });
      templateSelect.appendChild(el("option", { value: "" }, "— none (start from standards and/or context) —"));
      for (const t of templates) templateSelect.appendChild(el("option", { value: t.id }, t.name));
      if (templateDoc && templateDoc.id) templateSelect.value = templateDoc.id;
      templateSelect.addEventListener("change", () => {
        const t = templates.find((x) => x.id === templateSelect.value);
        if (t && (!name.value.trim() || name.dataset.auto === "1")) { name.value = `${t.name} — As Operated`; name.dataset.auto = "1"; }
        else if (!templateSelect.value && name.dataset.auto === "1") { name.value = "New As Operated"; }
      });
    }
    const selectedTemplateId = () => (templateSelect ? (templateSelect.value || "") : "");

    const source1 = isCreateMode
      ? el("label", { class: "form-row src-row" }, [
          el("span", { class: "form-label" }, "1 · Start from a template"),
          templates.length ? templateSelect : el("div", { class: "muted" }, "No templates available — you can still build from standards and/or context below."),
        ])
      : el("div", { class: "src-row" }, [
          el("span", { class: "form-label" }, "1 · Base document"),
          el("div", { class: "muted" }, `${d.name} — its current version is the starting point.`),
        ]);
    const source2 = el("div", { class: "src-row" }, [
      el("span", { class: "form-label" }, "2 · Reference standards & regulations"),
      el("div", { class: "muted", style: "margin:0.1rem 0 0.35rem" }, "Only standards with an uploaded version appear here. Add them in the Standards & Regulations section first."),
      standardsWrap,
    ]);
    const source3 = el("label", { class: "form-row src-row" }, [
      el("span", { class: "form-label" }, "3 · Context / change request"),
      notes,
    ]);
    const sourceSection = el("div", { class: "src-section" }, [
      el("div", { class: "src-head" }, "Source material — combine any of these"),
      el("p", { class: "muted", style: "margin:0.1rem 0 0.7rem" }, isCreateMode
        ? "Build a new As Operated document from a template, from one or more standards/regulations, or from both — plus optional context."
        : "Update this document from its current version, optionally guided by standards/regulations and your change notes."),
      source1, source2, source3,
    ]);

    const form = el("div", { class: "step-form" }, [
      isCreateMode ? el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Document name"), name]) : null,
      sourceSection,
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Version label"), version]),
      el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.5rem" }, [generate, publish]),
      status,
      el("div", { style: "margin-top:1rem" }, [el("strong", {}, "Suggested changes"), changeList]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Draft text"), draft]),
      (!isCreateMode && d && (d.versions || [])[0]) ? el("div", { style: "margin-top:0.4rem" }, actionBtn("Changes vs current version", "diff", { onClick: async () => {
        const cur = (d.versions || [])[0];
        try {
          const oldText = await extractVersionText(cur.open_url, cur.file_name || d.name);
          if (oldText == null) { alert("The current version's file type can't be compared as text."); return; }
          openTextDiffModal(`AI draft vs current (v${(d.versions || []).length})`, oldText, draft.value || "");
        } catch (ex) { alert(`Couldn't compare: ${ex.message}`); }
      } })) : null,
      gdocRow,
      el("div", { style: "margin-top:1rem; border-top:1px solid var(--border); padding-top:0.85rem" }, [
        el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center" }, [publishBottom]),
        publishStatus,
      ]),
    ].filter(Boolean));

    const close = openModal(options.title || (d ? `AI draft — ${d.name}` : "New As Operated document"), form);
    (isCreateMode ? name : notes).focus();

    const loadStandards = async () => {
      standardsWrap.replaceChildren(el("div", { class: "muted" }, "Loading standards…"));
      try {
        const payload = await API.standards(API.getToken(role));
        const standards = (payload.standards || []).filter((s) => Array.isArray(s.versions) && s.versions.length);
        if (!standards.length) {
          standardsWrap.replaceChildren(el("div", { class: "muted" }, "No uploaded standards or regulations are available yet. Add them in the Standards & Regulations section first."));
          return;
        }
        const list = el("div", { style: "display:grid; gap:0.8rem; margin-top:0.2rem" });
        for (const std of standards) {
          const latest = std.versions[0];
          const checkbox = el("input", { type: "checkbox", value: std.id });
          const select = el("select", { class: "up-text", disabled: "disabled", style: "margin-top:0.25rem; width:100%;" },
            std.versions.map((v) => el("option", { value: v.id, selected: v.id === latest.id ? "selected" : null }, `${v.version || "version"}${v.effective_date ? ` · ${v.effective_date}` : ""}`))
          );
          checkbox.addEventListener("change", () => { select.disabled = !checkbox.checked; });
          const item = el("div", { style: "border:1px solid var(--border); padding:0.75rem; border-radius:0.4rem;" }, [
            el("label", { style: "display:flex; gap:0.5rem; align-items:flex-start;" }, [
              checkbox,
              el("span", {}, [
                el("strong", {}, std.code || std.title || "Standard"),
                el("div", { class: "muted", style: "font-size:0.82rem; margin-top:0.1rem" }, `${std.title || ""}${latest?.version ? ` · ${latest.version}` : ""}`),
              ]),
            ]),
            el("div", { style: "display:flex; flex-direction:column; gap:0.25rem; margin-top:0.5rem" }, [
              el("span", { class: "muted", style: "font-size:0.82rem;" }, "Select the exact standard version to use for drafting."),
              select,
            ]),
          ]);
          list.appendChild(item);
        }
        standardsWrap.replaceChildren(list);
      } catch (ex) {
        standardsWrap.replaceChildren(el("div", { class: "error" }, `Couldn't load standards: ${ex.message}`));
      }
    };
    loadStandards();

    generate.addEventListener("click", async () => {
      const context = notes.value.trim();
      const selectedStandardVersionIds = Array.from(standardsWrap.querySelectorAll("input[type='checkbox']"))
        .filter((cb) => cb.checked)
        .map((cb) => {
          const select = cb.closest("div")?.querySelector("select");
          return select ? select.value : cb.value;
        })
        .filter(Boolean);
      const tmplId = selectedTemplateId();
      if (!context && !selectedStandardVersionIds.length && !tmplId && !d) {
        status.className = "up-status warn"; status.textContent = "Choose a template, select one or more standards/regulations, or add context first."; return;
      }
      generate.disabled = true; publish.disabled = true; publishBottom.disabled = true; status.className = "up-status"; status.textContent = "Generating draft…";
      try {
        draftResult = await API.suggestDocumentVersion(API.getToken(role), {
          documentId: d ? d.id : null,
          templateDocumentId: tmplId || null,
          notes: context,
          preferredVersion: version.value.trim(),
          sourceStandardVersionIds: selectedStandardVersionIds,
        });
        const proposals = Array.isArray(draftResult.proposedChanges) ? draftResult.proposedChanges : [];
        changeList.replaceChildren();
        if (proposals.length) {
          const items = proposals.map((c) => {
            const checkbox = el("input", { type: "checkbox", checked: "checked" });
            checkbox.dataset.title = c.title || "Change";
            return el("label", { style: "display:flex; gap:0.5rem; align-items:flex-start; margin-bottom:0.5rem" }, [
              checkbox,
              el("span", {}, [el("strong", {}, c.title || "Change"), el("div", { class: "muted", style: "margin-top:0.2rem" }, c.description || "")]),
            ]);
          });
          changeList.append(...items);
        } else {
          changeList.appendChild(el("div", { class: "muted" }, "No specific change list was returned. You can still publish the draft as-is."));
        }
        draft.value = unescapeUnicode(draftResult.draftText || "");
        status.className = "up-status ok"; status.textContent = draftResult.summary || "Draft ready for review.";
        publish.disabled = false; publishBottom.disabled = false;
        // fresh draft → reset any prior Google Doc round-trip (only if configured)
        googleDocId = null;
        gdocRow.style.display = (window.PortalGDocs && window.PortalGDocs.configured()) ? "block" : "none";
        gdocFetch.style.display = "none"; gdocPublish.style.display = "none"; gdocLink.replaceChildren(); gdocStatus.textContent = "";
      } catch (ex) {
        status.className = "up-status err"; status.textContent = `Failed: ${ex.message}`;
      } finally {
        generate.disabled = false;
      }
    });

    // Common publish parameters shared by the text and the Google-Docs-file paths.
    const gatherPublish = () => {
      const approved = Array.from(changeList.querySelectorAll("input[type='checkbox']")).filter((cb) => cb.checked).map((cb) => cb.dataset.title || "change").filter(Boolean);
      const selectedStandardVersionIds = Array.from(standardsWrap.querySelectorAll("input[type='checkbox']")).filter((cb) => cb.checked).map((cb) => { const s = cb.closest("div")?.querySelector("select"); return s ? s.value : cb.value; }).filter(Boolean);
      return {
        documentId: d ? d.id : null,
        newDocumentName: isCreateMode ? name.value.trim() : null,
        templateDocumentId: selectedTemplateId() || null,
        version: version.value.trim() || (draftResult && draftResult.versionHint) || "AI draft",
        notes: `Approved changes: ${approved.join(", ") || "none"}\n${notes.value.trim()}`,
        approvedChanges: approved,
        sourceStandardVersionIds: selectedStandardVersionIds,
      };
    };
    const baseFileName = () => ((isCreateMode ? name.value.trim() : (d ? d.name : "document")) || "document").replace(/[^a-z0-9._-]+/gi, "_") || "document";

    const doPublish = async (statusEl) => {
      if (!draftResult) { statusEl.className = "up-status warn"; statusEl.textContent = "Generate a draft first."; return; }
      const finalText = draft.value.trim();
      if (!finalText) { statusEl.className = "up-status warn"; statusEl.textContent = "The draft text is empty."; return; }
      publish.disabled = true; publishBottom.disabled = true; statusEl.className = "up-status"; statusEl.textContent = "Publishing draft…";
      try {
        await API.publishDocumentDraft(API.getToken(role), { ...gatherPublish(), draftText: finalText, fileName: `${baseFileName()}.md` });
        close(); await reload();
      } catch (ex) {
        publish.disabled = false; publishBottom.disabled = false; statusEl.className = "up-status err"; statusEl.textContent = `Failed: ${ex.message}`;
      }
    };
    publish.addEventListener("click", () => doPublish(status));
    publishBottom.addEventListener("click", () => doPublish(publishStatus));

    gdocEdit.addEventListener("click", async () => {
      const text = draft.value.trim();
      if (!text) { gdocStatus.className = "up-status warn"; gdocStatus.textContent = "Generate or write a draft first."; return; }
      // Open the tab synchronously (inside the click gesture) so the browser
      // doesn't block it as a popup; we point it at the Doc once it's created.
      if (!window.PortalGDocs || !window.PortalGDocs.configured()) { gdocStatus.className = "up-status err"; gdocStatus.textContent = "Google Docs isn't set up yet."; return; }
      // Pre-open the tab inside the click gesture so it isn't popup-blocked.
      const win = window.open("", "_blank");
      gdocEdit.disabled = true; gdocStatus.className = "up-status"; gdocStatus.textContent = "Opening Google — approve access if prompted…";
      try {
        await window.PortalGDocs.getToken(); // consent popup on first use (kept in the gesture)
        const res = await window.PortalGDocs.createDoc(gdocDocName(), draft.value);
        googleDocId = res.documentId;
        if (draftResult) draftResult.googleDocId = googleDocId;
        if (win && !win.closed) win.location.href = res.editUrl; else window.open(res.editUrl, "_blank", "noopener");
        gdocFetch.style.display = "inline-flex"; gdocPublish.style.display = "inline-flex";
        gdocLink.replaceChildren(el("a", { href: res.editUrl, target: "_blank", rel: "noopener", class: "linklike" }, "Open Google Doc ↗"));
        gdocStatus.className = "up-status ok"; gdocStatus.textContent = "Google Doc created in your Drive and opened in a new tab. Edit there, then “Publish from Google Docs” to save it as a formatted Word document.";
      } catch (ex) {
        if (win && !win.closed) win.close();
        gdocStatus.className = "up-status err"; gdocStatus.textContent = `Couldn't create the Google Doc: ${ex.message}`;
      } finally { gdocEdit.disabled = false; }
    });

    gdocFetch.addEventListener("click", async () => {
      if (!googleDocId) { gdocStatus.className = "up-status warn"; gdocStatus.textContent = "Create the Google Doc first."; return; }
      gdocFetch.disabled = true; gdocStatus.className = "up-status"; gdocStatus.textContent = "Fetching the edited version…";
      try {
        const content = await window.PortalGDocs.fetchDoc(googleDocId);
        draft.value = unescapeUnicode(content || "");
        gdocStatus.className = "up-status ok"; gdocStatus.textContent = "Fetched the edited text into the draft (plain text). To keep full formatting, use “Publish from Google Docs” instead.";
      } catch (ex) {
        gdocStatus.className = "up-status err"; gdocStatus.textContent = `Couldn't fetch the edited version: ${ex.message}`;
      } finally { gdocFetch.disabled = false; }
    });

    gdocPublish.addEventListener("click", async () => {
      if (!googleDocId) { gdocStatus.className = "up-status warn"; gdocStatus.textContent = "Create the Google Doc first."; return; }
      if (!draftResult) { gdocStatus.className = "up-status warn"; gdocStatus.textContent = "Generate a draft first."; return; }
      gdocPublish.disabled = true; gdocStatus.className = "up-status"; gdocStatus.textContent = "Exporting the Google Doc as Word and publishing…";
      try {
        const blob = await window.PortalGDocs.exportDoc(googleDocId, "docx");
        await API.publishDocumentFile(API.getToken(role), blob, { ...gatherPublish(), fileName: `${baseFileName()}.docx` });
        close(); await reload();
      } catch (ex) {
        gdocPublish.disabled = false; gdocStatus.className = "up-status err"; gdocStatus.textContent = `Couldn't publish from Google Docs: ${ex.message}`;
      }
    });
  }

  // Generic accessible modal (reuses the viewer's overlay/dialog styling).
  function openModal(title, contentEl) {
    const lastFocus = document.activeElement;
    const closeModal = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    };
    const onKey = (e) => { if (e.key === "Escape") closeModal(); };
    const closeBtn = el("button", { class: "btn btn-sm", type: "button", onclick: closeModal }, "✕ Close");
    const dialog = el("div", { class: "viewer-dialog", role: "dialog", "aria-modal": "true", "aria-label": title }, [
      el("div", { class: "viewer-head" }, [el("h3", { class: "viewer-title" }, title), el("span", { class: "spacer" }), closeBtn]),
      el("div", { class: "modal-body" }, contentEl),
    ]);
    const overlay = el("div", { class: "viewer-overlay", onclick: (e) => { if (e.target === overlay) closeModal(); } }, dialog);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKey);
    return closeModal;
  }

  // Add / edit a plan step (Rushroom). `existing` null = add a new step.
  function stepEditor(existing, phases, onSave) {
    const v = existing || {};
    const row = (labelText, input) => el("label", { class: "form-row" }, [el("span", { class: "form-label" }, labelText), input]);
    const prioList = el("datalist", { id: "prio-list" }, ["Foundation", "High", "High — gate", "BLOCKER", "Medium", "Conditional", "Ongoing", "Annual"].map((p) => el("option", { value: p })));
    // Phase: a dropdown of all existing phases (so they're reused, not duplicated),
    // plus an "Add new phase…" option that reveals a text field.
    const NEW_PHASE = "__new_phase__";
    const existingPhases = [...new Set((phases || []).filter(Boolean))];
    const curPhase = v.phase || "";
    const phaseInList = existingPhases.includes(curPhase);
    const phaseSel = el("select", { class: "up-text", "aria-label": "Phase" }, [
      el("option", { value: "", selected: !curPhase ? "selected" : null }, "— select phase —"),
      ...existingPhases.map((pp) => el("option", { value: pp, selected: phaseInList && pp === curPhase ? "selected" : null }, pp)),
      el("option", { value: NEW_PHASE, selected: curPhase && !phaseInList ? "selected" : null }, "＋ Add new phase…"),
    ]);
    const phaseNew = el("input", { type: "text", class: "up-text", placeholder: "New phase name, e.g. 11. New regulations", value: curPhase && !phaseInList ? curPhase : "" });
    const phaseNewWrap = el("div", { style: "margin-top:0.4rem" }, phaseNew);
    phaseNewWrap.hidden = phaseSel.value !== NEW_PHASE;
    phaseSel.addEventListener("change", () => { const isNew = phaseSel.value === NEW_PHASE; phaseNewWrap.hidden = !isNew; if (isNew) phaseNew.focus(); });
    const phaseValue = () => (phaseSel.value === NEW_PHASE ? phaseNew.value.trim() : phaseSel.value);
    const phaseField = el("div", {}, [phaseSel, phaseNewWrap]);
    const action = el("textarea", { rows: "3", placeholder: "What must Rushroom do…" }, v.action || "");
    const owner = el("input", { type: "text", value: v.owner || "", placeholder: "Who does it" });
    const priority = el("input", { type: "text", value: v.priority || "", list: "prio-list", placeholder: "e.g. High, BLOCKER" });
    const status = el("select", {}, STATUS_OPTIONS.map((o) => el("option", { value: o, selected: norm(o) === norm(v.status || "Open") ? "selected" : null }, o)));
    const evidence = el("input", { type: "text", value: v.evidence || "", placeholder: "Output / evidence" });
    const where = el("input", { type: "text", value: v.where || "", placeholder: "Where / how" });
    const auds = ["internal", "supplier", "reviewer", "installer"].map((a) => {
      const cb = el("input", { type: "checkbox", value: a, checked: (v.audience || ["internal"]).includes(a) ? "checked" : null });
      return { a, cb, label: el("label", { class: "aud-check" }, [cb, ` ${a}`]) };
    });
    // Compliance classification (lifecycle phase × scope) is captured only when
    // creating a NEW step; existing steps keep their classification untouched.
    const showClass = !existing;
    const lifePhase = phaseSelect(v.lifecycle_phase);
    const cScope = scopeSelect(v.scope);
    const note = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const save = el("button", { class: "btn btn-primary", type: "button" }, existing ? "Save changes" : "Add action");
    const form = el("div", { class: "step-form" }, [
      prioList,
      row("Phase", phaseField), row("Action", action), row("Owner", owner),
      row("Priority", priority), row("Status", status), row("Evidence", evidence), row("Where / how", where),
      showClass ? el("div", { class: "form-row" }, [el("span", { class: "form-label" }, "Compliance quadrant"), el("div", { class: "cs-quad-picker" }, [lifePhase, cScope])]) : null,
      el("div", { class: "form-row" }, [el("span", { class: "form-label" }, "Audience"), el("div", { class: "aud-checks" }, auds.map((c) => c.label))]),
      note, el("div", { style: "margin-top:0.5rem" }, save),
    ]);
    const close = openModal(existing ? `Edit action #${existing.step}` : "Add an action", form);
    phaseSel.focus();
    save.addEventListener("click", async () => {
      const actionText = action.value.trim();
      if (!actionText) { note.className = "up-status warn"; note.textContent = "Action text is required."; return; }
      const audience = auds.filter((c) => c.cb.checked).map((c) => c.a);
      const fields = { phase: phaseValue(), actionText, owner: owner.value.trim(), priority: priority.value.trim(), status: status.value, evidence: evidence.value.trim(), where: where.value.trim(), audience: audience.length ? audience : ["internal"] };
      if (showClass) { fields.lifecyclePhase = lifePhase.value || null; fields.scope = cScope.value || null; }
      save.disabled = true; note.className = "up-status"; note.textContent = "Saving…";
      try { await onSave(fields); close(); }
      catch (ex) { save.disabled = false; note.className = "up-status err"; note.textContent = `Failed: ${ex.message}`; }
    });
  }

  // Rushroom-only: list of supplier uploads with signed download links.
  async function uploadsReview(role, reload) {
    if (role !== "rushroom") return null;
    const wrap = el("div", { class: "card" }, el("h3", {}, "Supplier uploads"));
    try {
      const { uploads } = await API.listUploads(API.getToken(role));
      if (!uploads || !uploads.length) { wrap.appendChild(el("p", { class: "muted", style: "margin:0" }, "No uploads yet.")); return wrap; }
      const onDelete = async (u) => {
        if (!confirm(`Delete upload “${u.file_name}”? This removes the file permanently.`)) return;
        try { await API.deleteUpload(API.getToken(role), u.id); await reload(); }
        catch (ex) { alert(`Couldn't delete: ${ex.message}`); }
      };
      const list = el("ul", { class: "uploads" });
      for (const u of uploads) {
        const ext = (u.file_name || "").split(".").pop().toLowerCase();
        const canView = u.download_url && window.PortalViewer && ["pdf", "docx", "xlsx", "xls", "csv"].includes(ext);
        list.appendChild(el("li", {}, [
          canView
            ? el("button", { class: "linklike", type: "button", onclick: () => window.PortalViewer.open({ name: u.file_name, open_url: u.download_url, storage_path: u.file_name }) }, u.file_name)
            : (u.download_url ? el("a", { href: u.download_url, target: "_blank", rel: "noopener" }, u.file_name) : el("span", {}, u.file_name)),
          fileTypeChip(u.file_name),
          el("span", { class: "muted" }, ` — ${u.supplier_label || u.uploaded_role}${u.step ? ` · action #${u.step}` : ""}${u.note ? ` · ${u.note}` : ""}`),
          canView ? el("span", { class: "muted" }, [" · ", el("a", { href: u.download_url, target: "_blank", rel: "noopener" }, "download")]) : null,
          u.id ? el("span", {}, [" · ", el("button", { class: "linklike std-del", type: "button", onclick: () => onDelete(u) }, "delete")]) : null,
        ]));
      }
      wrap.appendChild(list);
    } catch (ex) {
      wrap.appendChild(el("p", { class: "error", style: "margin:0" }, `Couldn't load uploads: ${ex.message}`));
    }
    return wrap;
  }

  /* ---------------- Standards & Regulations register ---------------- */
  const fmtDate = (iso) => { if (!iso) return ""; try { return new Date(iso).toLocaleDateString("en-GB"); } catch { return iso; } };
  const fmtDateTime = (iso) => { if (!iso) return ""; try { return new Date(iso).toLocaleString("en-GB"); } catch { return iso; } };
  const viewFile = (v) => window.PortalViewer && window.PortalViewer.open({ name: v.file_name, open_url: v.open_url, storage_path: v.file_name });

  async function deleteStandard(s, role, reload) {
    if (!confirm(`Delete standard “${s.code || s.title}” and all its versions?`)) return;
    try { await API.deleteStandard(API.getToken(role), s.id); await reload(); } catch (ex) { alert(`Couldn't delete: ${ex.message}`); }
  }
  async function deleteStandardVersion(v, role, reload) {
    if (!confirm(`Delete version “${v.version || v.file_name}”?`)) return;
    try { await API.deleteStandardVersion(API.getToken(role), v.id); await reload(); } catch (ex) { alert(`Couldn't delete: ${ex.message}`); }
  }

  /* ---- Standards taxonomy: regulatory type + jurisdiction ----
   * Two dimensions so it's obvious what you're looking at: the TYPE/level
   * (an EU directive vs a national standard) and WHERE it applies. */
  const REG_TYPES = ["EU Directive", "EU Regulation", "Harmonised Standard (EN)", "National Standard", "International (IEC/ISO)", "Other"];
  const REG_TYPE_CLASS = { "EU Directive": "eu", "EU Regulation": "eu", "Harmonised Standard (EN)": "harm", "National Standard": "nat", "International (IEC/ISO)": "intl", "Other": "other" };
  const EU_COUNTRIES = ["Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czechia", "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary", "Ireland", "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta", "Netherlands", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia", "Spain", "Sweden"];
  const JURISDICTIONS = ["EU", "International", ...EU_COUNTRIES, "Iceland", "Liechtenstein", "Norway", "Switzerland", "United Kingdom"];
  const JUR_FLAG = { EU: "🇪🇺", International: "🌐", Austria: "🇦🇹", Belgium: "🇧🇪", Bulgaria: "🇧🇬", Croatia: "🇭🇷", Cyprus: "🇨🇾", Czechia: "🇨🇿", Denmark: "🇩🇰", Estonia: "🇪🇪", Finland: "🇫🇮", France: "🇫🇷", Germany: "🇩🇪", Greece: "🇬🇷", Hungary: "🇭🇺", Ireland: "🇮🇪", Italy: "🇮🇹", Latvia: "🇱🇻", Lithuania: "🇱🇹", Luxembourg: "🇱🇺", Malta: "🇲🇹", Netherlands: "🇳🇱", Poland: "🇵🇱", Portugal: "🇵🇹", Romania: "🇷🇴", Slovakia: "🇸🇰", Slovenia: "🇸🇮", Spain: "🇪🇸", Sweden: "🇸🇪", Iceland: "🇮🇸", Liechtenstein: "🇱🇮", Norway: "🇳🇴", Switzerland: "🇨🇭", "United Kingdom": "🇬🇧" };
  const jurFlag = (j) => JUR_FLAG[j] || "";
  const jurLabel = (j) => `${jurFlag(j) ? jurFlag(j) + " " : ""}${j}`;
  const regTypeBadge = (t) => t ? el("span", { class: `reg-badge reg-${REG_TYPE_CLASS[t] || "other"}`, title: "Regulatory type" }, t) : null;
  const jurBadge = (j) => j ? el("span", { class: "jur-badge", title: "Jurisdiction" }, jurLabel(j)) : null;

  // Standards register: grouped by regulatory type, then by jurisdiction, honouring the filters.
  function buildStandardsBrowser(standards, role, reload, filterType, filterJur) {
    const filtered = standards.filter((s) =>
      (!filterType || (s.reg_type || "") === filterType) &&
      (!filterJur || (s.jurisdiction || "") === filterJur));
    if (!filtered.length) return el("div", { class: "empty" }, "No standards match the current filter.");
    const toItem = (s) => ({
      id: s.id,
      name: s.code || s.title || "Standard",
      ftypeHint: (s.versions && s.versions[0] && (s.versions[0].file_name || s.versions[0].storage_path)) || "",
      sub: [s.category, (s.title && s.code) ? s.title : null].filter(Boolean).join(" · ") || `${(s.versions || []).length} version${(s.versions || []).length === 1 ? "" : "s"}`,
      keywords: `${s.code || ""} ${s.title || ""} ${s.category || ""} ${s.reg_type || ""} ${s.jurisdiction || ""}`,
      data: s,
    });
    const byType = new Map();
    for (const s of filtered) { const t = s.reg_type || "Uncategorised"; if (!byType.has(t)) byType.set(t, []); byType.get(t).push(s); }
    const order = [...REG_TYPES, ...[...byType.keys()].filter((t) => !REG_TYPES.includes(t))];
    const tree = [];
    for (const t of order) {
      const list = byType.get(t); if (!list) continue;
      const byJur = new Map();
      for (const s of list) { const j = s.jurisdiction || "—"; if (!byJur.has(j)) byJur.set(j, []); byJur.get(j).push(s); }
      const cats = [...byJur].sort((a, b) => a[0].localeCompare(b[0])).map(([jname, jlist]) => ({ name: jname === "—" ? "Unspecified" : jurLabel(jname), items: jlist.map(toItem) }));
      tree.push({ heading: t, count: list.length, categories: cats });
    }
    return twoPaneBrowser("standards", tree, (item) => standardCard(item.data, role, reload),
      { navLabel: "Standards & regulations", emptyDetail: "Select a standard on the left.", searchPlaceholder: "Search code, title, category, type, country…" });
  }

  function addStandardCard(role, reload) {
    const code = el("input", { type: "text", class: "up-text", placeholder: "Code (e.g. EN 60598-1)" });
    const title = el("input", { type: "text", class: "up-text", placeholder: "Title" });
    const category = el("input", { type: "text", class: "up-text", placeholder: "Domain (e.g. LVD, EMC)" });
    const regType = el("select", { class: "up-text", "aria-label": "Regulatory type" }, [el("option", { value: "" }, "— regulatory type —"), ...REG_TYPES.map((t) => el("option", { value: t }, t))]);
    const jurisdiction = el("select", { class: "up-text", "aria-label": "Jurisdiction" }, [el("option", { value: "" }, "— jurisdiction —"), ...JURISDICTIONS.map((j) => el("option", { value: j }, jurLabel(j)))]);
    const version = el("input", { type: "text", class: "up-text", placeholder: "Version (e.g. 2015+A1:2022)" });
    const eff = el("input", { type: "text", class: "up-text", placeholder: "Effective date (optional)" });
    const auds = ["internal", "supplier", "reviewer", "installer"].map((a) => {
      const cb = el("input", { type: "checkbox", value: a, checked: a === "internal" ? "checked" : null });
      return { a, cb, label: el("label", { class: "aud-check" }, [cb, ` ${a}`]) };
    });
    const status = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    // The AI read runs automatically as soon as the file finishes uploading —
    // one batch, no separate button. onReady fires when the upload completes.
    const autofill = async (up) => {
      if (!up) return;
      status.className = "up-status"; status.textContent = "✨ Reading the file with AI…";
      try {
        const meta = await API.suggestStandardMetadata(API.getToken(role), { path: up.path, fileName: up.fileName });
        if (meta.code) code.value = meta.code;
        if (meta.title) title.value = meta.title;
        if (meta.category) category.value = meta.category;
        if (meta.regType && REG_TYPES.includes(meta.regType)) regType.value = meta.regType;
        if (meta.jurisdiction && JURISDICTIONS.includes(meta.jurisdiction)) jurisdiction.value = meta.jurisdiction;
        if (meta.version) version.value = meta.version;
        if (meta.effectiveDate) eff.value = meta.effectiveDate;
        status.className = "up-status ok";
        status.textContent = meta.summary ? `AI read: ${meta.summary} — review the fields and approve.` : "AI filled the fields — review and approve.";
        zone.finishProcessing(true);
      } catch (ex) {
        status.className = "up-status err"; status.textContent = `Couldn't read the file automatically: ${ex.message}. You can still fill the fields manually.`;
        zone.finishProcessing(false);
      }
    };
    const zone = uploadZone(role, "standards", { ariaLabel: "Standard or regulation file", processing: true, onReady: (up) => autofill(up) });
    const btn = el("button", { class: "btn btn-primary", type: "button" }, "Approve & add standard");
    zone.register(btn, false);      // a file is optional; only block while uploading

    btn.addEventListener("click", async () => {
      if (!code.value.trim() && !title.value.trim()) { status.className = "up-status warn"; status.textContent = "Enter a code or title (or auto-fill from a file)."; return; }
      const audience = auds.filter((c) => c.cb.checked).map((c) => c.a);
      btn.disabled = true; status.className = "up-status"; status.textContent = "Saving…";
      try {
        const up = zone.getUploaded(); // attach the uploaded file, if any
        const { id } = await API.addStandard(API.getToken(role), { code: code.value, title: title.value, category: category.value, regType: regType.value, jurisdiction: jurisdiction.value, audience: audience.length ? audience : ["internal"] });
        if (up && id) {
          await API.addStandardVersionRecord(API.getToken(role), { standardId: id, version: version.value, effectiveDate: eff.value, notes: "", path: up.path, fileName: up.fileName });
        }
        flash(id);
        code.value = title.value = category.value = version.value = eff.value = ""; regType.value = jurisdiction.value = ""; zone.reset();
        paneSubTab.standards = "list"; // show the new standard (blinking) in the register
        await reload();
      } catch (ex) { btn.disabled = false; status.className = "up-status err"; status.textContent = `Failed: ${ex.message}`; }
    });

    return el("div", { class: "card upload-card" }, [
      el("h3", {}, "Add a standard / regulation"),
      el("p", { class: "muted", style: "margin:0.25rem 0 1rem" }, "Upload the standard file and the AI automatically reads its code, title, domain, regulatory type, jurisdiction and version for you. Review the fields, then approve. Every upload is kept for a full revision trail."),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Standard file"), zone.el]),
      el("div", { class: "upload-fields", style: "margin-top:0.5rem" }, [code, title, category]),
      el("div", { class: "upload-fields", style: "margin-top:0.5rem" }, [regType, jurisdiction]),
      el("div", { class: "upload-fields", style: "margin-top:0.5rem" }, [version, eff]),
      el("div", { class: "aud-checks" }, auds.map((c) => c.label)),
      el("div", { style: "margin-top:0.75rem" }, btn),
      status,
    ]);
  }

  function standardVersionEditor(s, role, reload) {
    const zone = uploadZone(role, "standards", { ariaLabel: "Choose the standard file", processing: true });
    const version = el("input", { type: "text", placeholder: "e.g. 2015+A1:2022 or Rev 3" });
    const eff = el("input", { type: "text", placeholder: "Effective date (optional)" });
    const notes = el("textarea", { rows: "3", placeholder: "What changed in this revision (optional)" });
    const note = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const save = el("button", { class: "btn btn-primary", type: "button" }, "Upload version");
    aiAutofill(role, { zone, statusEl: note, onFill: (meta) => {
      if (meta.version && !version.value.trim()) version.value = meta.version;
      if (meta.effectiveDate && !eff.value.trim()) eff.value = meta.effectiveDate;
      if (meta.summary && !notes.value.trim()) notes.value = meta.summary;
    } });
    zone.register(save);
    const form = el("div", { class: "step-form" }, [
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "File"), zone.el]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Version"), version]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Effective date"), eff]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Revision notes"), notes]),
      note, el("div", { style: "margin-top:0.5rem" }, save),
    ]);
    const close = openModal(`New version — ${s.code || s.title || "standard"}`, form);
    save.addEventListener("click", async () => {
      const up = zone.getUploaded();
      if (!up) { note.className = "up-status warn"; note.textContent = "Add a file first."; return; }
      save.disabled = true; note.className = "up-status"; note.textContent = "Saving…";
      try {
        await API.addStandardVersionRecord(API.getToken(role), { standardId: s.id, version: version.value, effectiveDate: eff.value, notes: notes.value, path: up.path, fileName: up.fileName });
        flash(s.id); close(); await reload();
      } catch (ex) { save.disabled = false; note.className = "up-status err"; note.textContent = `Failed: ${ex.message}`; }
    });
  }

  // Edit a standard's catalogue fields (code/title/domain/type/jurisdiction/audience)
  // without re-adding it — so existing standards can be classified.
  function standardMetaEditor(s, role, reload) {
    const code = el("input", { type: "text", class: "up-text", value: s.code || "", placeholder: "Code (e.g. EN 60598-1)" });
    const title = el("input", { type: "text", class: "up-text", value: s.title || "", placeholder: "Title" });
    const category = el("input", { type: "text", class: "up-text", value: s.category || "", placeholder: "Domain (e.g. LVD, EMC)" });
    const regType = el("select", { class: "up-text" }, [el("option", { value: "" }, "— regulatory type —"), ...REG_TYPES.map((t) => el("option", { value: t, selected: (s.reg_type || "") === t ? "selected" : null }, t))]);
    const jurisdiction = el("select", { class: "up-text" }, [el("option", { value: "" }, "— jurisdiction —"), ...JURISDICTIONS.map((j) => el("option", { value: j, selected: (s.jurisdiction || "") === j ? "selected" : null }, jurLabel(j)))]);
    const auds = ["internal", "supplier", "reviewer", "installer"].map((a) => { const cb = el("input", { type: "checkbox", value: a, checked: (s.audience || []).includes(a) ? "checked" : null }); return { a, cb, label: el("label", { class: "aud-check" }, [cb, ` ${a}`]) }; });
    const note = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const save = el("button", { class: "btn btn-primary", type: "button" }, "Save changes");
    const form = el("div", { class: "step-form" }, [
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Code"), code]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Title"), title]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Domain"), category]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Regulatory type"), regType]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Jurisdiction"), jurisdiction]),
      el("div", { class: "form-row" }, [el("span", { class: "form-label" }, "Audience"), el("div", { class: "aud-checks" }, auds.map((c) => c.label))]),
      note, el("div", { style: "margin-top:0.5rem" }, save),
    ]);
    const close = openModal(`Edit — ${s.code || s.title || "standard"}`, form);
    save.addEventListener("click", async () => {
      note.className = "up-status"; note.textContent = "Saving…"; save.disabled = true;
      try {
        const audience = auds.filter((c) => c.cb.checked).map((c) => c.a);
        await API.updateStandard(API.getToken(role), s.id, { code: code.value, title: title.value, category: category.value, regType: regType.value, jurisdiction: jurisdiction.value, audience: audience.length ? audience : ["internal"] });
        flash(s.id); close(); await reload();
      } catch (ex) { save.disabled = false; note.className = "up-status err"; note.textContent = `Failed: ${ex.message}`; }
    });
  }

  function standardCard(s, role, reload) {
    const versions = s.versions || []; // newest first (server-ordered)
    const current = versions[0];
    const manage = role === "rushroom";
    const head = el("div", { class: "std-head" }, [
      el("div", {}, [
        el("div", { class: "std-title" }, [el("strong", {}, s.code || "(no code)"), s.title ? el("span", { class: "muted" }, ` — ${s.title}`) : null]),
        el("div", { class: "std-meta" }, [
          regTypeBadge(s.reg_type),
          jurBadge(s.jurisdiction),
          s.category ? el("span", { class: "pill-priority" }, s.category) : null,
          el("span", { class: "muted" }, `${versions.length} version${versions.length === 1 ? "" : "s"}`),
        ]),
      ]),
      manage ? el("div", { class: "std-actions" }, [
        el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => standardVersionEditor(s, role, reload) }, versions.length ? "+ New version" : "Upload file"),
        actionBtn("Edit", "edit", { onClick: () => standardMetaEditor(s, role, reload) }),
        actionBtn("Delete", "trash", { danger: true, onClick: () => deleteStandard(s, role, reload) }),
      ]) : null,
    ]);
    const currentEl = current
      ? el("div", { class: "std-current" }, [
          el("span", { class: "std-vlabel" }, `Current: v${versions.length}`),
          fileTypeChip(current.file_name || current.storage_path),
          current.version ? el("span", { class: "muted" }, ` · ${current.version}`) : null,
          current.effective_date ? el("span", { class: "muted" }, ` · effective ${current.effective_date}`) : null,
          el("span", { class: "muted" }, ` · added ${fmtDate(current.created_at)}`),
          versionFileActions(current.open_url, current.file_name || s.code || s.title, current.storage_path, () => viewFile(current)),
          versions.length > 1 ? fileActionBtn("Changes", "diff", { title: "Highlight what changed vs the previous revision", onClick: () => openVersionDiff({ title: `Changes — v${versions.length} vs v${versions.length - 1}`, oldUrl: versions[1].open_url, oldHint: versions[1].file_name || s.code, newUrl: current.open_url, newHint: current.file_name || s.code }) }) : null,
        ])
      : el("div", { class: "std-current" }, [
          el("span", { class: "muted" }, "No file uploaded yet."),
          manage ? el("button", { class: "linklike std-view", type: "button", onclick: () => standardVersionEditor(s, role, reload) }, "Upload file") : null,
        ]);
    const history = versions.length
      ? el("details", { class: "std-history" }, [
          el("summary", {}, `Revision history (${versions.length})`),
          el("ul", { class: "std-versions" }, versions.map((v, vi) => el("li", {}, [
            el("div", {}, [
              el("span", { class: "std-vlabel" }, `v${versions.length - vi}`),
              fileTypeChip(v.file_name || v.storage_path),
              v.version ? el("span", { class: "muted" }, ` · ${v.version}`) : null,
              v.effective_date ? el("span", { class: "muted" }, ` · effective ${v.effective_date}`) : null,
              el("span", { class: "muted" }, ` · added ${fmtDate(v.created_at)}`),
              versionFileActions(v.open_url, v.file_name || s.code || s.title, v.storage_path, () => viewFile(v)),
              vi + 1 < versions.length ? fileActionBtn("Changes", "diff", { title: "Highlight what changed vs the previous revision", onClick: () => openVersionDiff({ title: `Changes — v${versions.length - vi} vs v${versions.length - vi - 1}`, oldUrl: versions[vi + 1].open_url, oldHint: versions[vi + 1].file_name || s.code, newUrl: v.open_url, newHint: v.file_name || s.code }) }) : null,
              manage ? deleteChip(() => deleteStandardVersion(v, role, reload)) : null,
            ]),
            v.notes ? el("div", { class: "std-notes" }, v.notes) : null,
          ]))),
        ])
      : null;
    return el("div", { class: "card std-card" }, [head, currentEl, history]);
  }

  async function renderStandards(role, mount) {
    mount.replaceChildren(el("div", { class: "loading" }, "Loading standards…"));
    let payload;
    try { payload = await API.standards(API.getToken(role)); }
    catch (ex) {
      if (/auth/i.test(ex.message)) { API.clearToken(role); location.reload(); return; }
      mount.replaceChildren(el("div", { class: "error" }, `Couldn't load standards: ${ex.message}`)); return;
    }
    const standards = payload.standards || [];
    const reload = () => renderStandards(role, mount);
    const registerTab = () => {
      const wrap = el("div");
      const presentTypes = [...new Set(standards.map((s) => s.reg_type).filter(Boolean))].sort((a, b) => REG_TYPES.indexOf(a) - REG_TYPES.indexOf(b));
      const presentJurs = [...new Set(standards.map((s) => s.jurisdiction).filter(Boolean))].sort();
      const typeSel = el("select", { class: "up-text", "aria-label": "Filter by regulatory type" }, [el("option", { value: "" }, "All types"), ...presentTypes.map((t) => el("option", { value: t }, t))]);
      const jurSel = el("select", { class: "up-text", "aria-label": "Filter by jurisdiction" }, [el("option", { value: "" }, "All jurisdictions"), ...presentJurs.map((j) => el("option", { value: j }, jurLabel(j)))]);
      const bmount = el("div", { style: "margin-top:0.7rem" });
      const rebuild = () => bmount.replaceChildren(standards.length
        ? buildStandardsBrowser(standards, role, reload, typeSel.value, jurSel.value)
        : el("div", { class: "empty" }, role === "rushroom" ? "No standards yet — add one in the Add standard tab." : "No standards shared with you yet."));
      typeSel.addEventListener("change", rebuild); jurSel.addEventListener("change", rebuild);
      wrap.append(
        standards.length ? el("div", { class: "std-filters" }, [el("span", { class: "form-label", style: "margin:0" }, "Filter"), typeSel, jurSel]) : null,
        bmount,
      );
      rebuild();
      return wrap;
    };
    if (role === "rushroom") {
      mount.replaceChildren(subTabs("standards", [
        { id: "list", label: "Register", icon: "layers", build: registerTab },
        { id: "add", label: "Add standard", icon: "plus", build: () => addStandardCard(role, reload) },
      ]));
    } else {
      mount.replaceChildren(registerTab());
    }
  }

  /* ---------------- AI Deviation Monitoring (Rushroom) ---------------- */
  const SEV_ORDER = ["Critical", "High", "Medium", "Low", "Info"];
  async function renderDeviations(role, mount, lastRun) {
    if (role !== "rushroom") { mount.replaceChildren(el("div", { class: "empty" }, "Not available for this role.")); return; }
    mount.replaceChildren(el("div", { class: "loading" }, "Loading…"));
    let payload;
    try { payload = await API.deviations(API.getToken(role)); }
    catch (ex) {
      if (/auth/i.test(ex.message)) { API.clearToken(role); location.reload(); return; }
      mount.replaceChildren(el("div", { class: "error" }, `Couldn't load: ${ex.message}`)); return;
    }
    const reload = () => renderDeviations(role, mount);
    const scan = payload.scan;
    const findings = payload.findings || [];

    const statusEl = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const runBtn = actionBtn("Run AI scan", "sparkles", { primary: true });
    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true; statusEl.className = "up-status";
      statusEl.textContent = "Checking structured interpretations, then running Claude on any uncovered documents…";
      try { const r = await API.runDeviationScan(API.getToken(role)); await renderDeviations(role, mount, r); }
      catch (ex) { runBtn.disabled = false; statusEl.className = "up-status err"; statusEl.textContent = `Scan failed: ${ex.message}`; }
    });
    // Just-run summary (shows AI cost even if the persistent usage column isn't added).
    const lastRunNote = lastRun ? el("div", { class: "notice ok" }, [
      document.createTextNode(`Scan complete — ${lastRun.structuredCount || 0} structured + ${lastRun.aiCount || 0} AI finding(s). `),
      usageChip(lastRun.usage) || document.createTextNode(lastRun.aiCount ? "" : "No AI tokens used (fully structured)."),
    ]) : null;

    const head = el("div", { class: "card upload-card" }, [
      el("h3", {}, "AI deviation monitoring"),
      el("p", { class: "muted", style: "margin:0.25rem 0 1rem" },
        "Checks reviewed clause interpretations first (instant, no AI), then uses the Claude API only for documents that have no interpretations yet. Lists deviations by severity; scans are manual."),
      el("div", {}, runBtn),
      statusEl,
      lastRunNote,
      scan ? el("div", { class: "scan-meta muted" }, [
        document.createTextNode(`Last scan: ${fmtDateTime(scan.created_at)} · ${scan.model || ""} · ${scan.docs_scanned} documents vs ${scan.standards_scanned} standards`),
        usageChip(scan.usage) ? document.createTextNode(" · ") : null, usageChip(scan.usage),
      ].filter(Boolean)) : null,
    ]);

    const body = el("div");
    if (!scan) {
      body.appendChild(el("div", { class: "empty" }, "No scan yet — click “Run AI scan” to check your documents against the standards."));
    } else {
      if (scan.summary) body.appendChild(el("div", { class: "notice" }, scan.summary));
      const counts = scan.counts || {};
      body.appendChild(el("div", { class: "sev-summary" }, SEV_ORDER.map((sev) =>
        el("span", { class: `sev-chip sev-${sev.toLowerCase()}` }, `${sev}: ${counts[sev] || 0}`))));
      const newCount = findings.filter((f) => f.is_new).length;
      if (payload.hasPrevious && newCount) body.appendChild(el("div", { class: "notice", style: "border-left:4px solid #f5c518" }, [el("span", { class: "finding-new-badge" }, "NEW"), document.createTextNode(` ${newCount} finding(s) are new since the previous scan (marked in yellow below).`)]));
      if (!findings.length) {
        body.appendChild(el("div", { class: "notice ok" }, "No deviations found in this scan."));
      } else {
        const bySev = {};
        for (const f of findings) (bySev[f.severity] || (bySev[f.severity] = [])).push(f);
        for (const sev of SEV_ORDER) {
          const items = bySev[sev];
          if (!items || !items.length) continue;
          const group = el("div", { class: "sev-group" }, el("h3", { class: `sev-head sev-${sev.toLowerCase()}` }, `${sev} (${items.length})`));
          for (const f of items) {
            group.appendChild(el("div", { class: `finding sev-border-${sev.toLowerCase()}${f.is_new ? " finding-new" : ""}` }, [
              el("div", { class: "finding-title" }, [
                el("span", {}, f.title || "(untitled)"),
                f.is_new ? el("span", { class: "finding-new-badge", title: "New since the previous scan" }, "NEW") : null,
                el("span", { class: `finding-src finding-src-${f.source === "structured" ? "structured" : "ai"}`, title: f.source === "structured" ? "From a reviewed clause interpretation (no AI)" : "Inferred by the AI scan" },
                  f.source === "structured" ? "⚙ structured" : "✨ AI"),
              ]),
              (f.document || f.standard) ? el("div", { class: "finding-refs muted" },
                `${f.document ? `Document: ${f.document}` : ""}${f.document && f.standard ? "   ·   " : ""}${f.standard ? `Standard: ${f.standard}` : ""}`) : null,
              f.description ? el("div", { class: "finding-desc" }, f.description) : null,
              f.recommendation ? el("div", { class: "finding-rec" }, [el("strong", {}, "Recommendation: "), f.recommendation]) : null,
            ]));
          }
          body.appendChild(group);
        }
      }
    }
    mount.replaceChildren(el("div", {}, [head, body]));
  }

  /* ---------------- user registration (public) ---------------- */
  const USER_ROLE_OPTS = [["supplier", "Supplier"], ["reviewer", "Reviewer"], ["installer", "Installer"], ["internal", "Internal (Rushroom staff)"]];
  // Roles an admin may assign (adds Admin, which is never self-requestable).
  const ASSIGN_ROLE_OPTS = [["admin", "Admin"], ...USER_ROLE_OPTS];
  function registerModal() {
    const role = el("select", { class: "up-text" }, USER_ROLE_OPTS.map(([v, l]) => el("option", { value: v }, l)));
    const name = el("input", { type: "text", class: "up-text", placeholder: "Full name" });
    const email = el("input", { type: "email", class: "up-text", placeholder: "you@company.com", autocomplete: "email" });
    const phone = el("input", { type: "tel", class: "up-text", placeholder: "Phone (optional)" });
    const whatsapp = el("input", { type: "tel", class: "up-text", placeholder: "WhatsApp (optional)" });
    const pass = el("input", { type: "password", class: "up-text", placeholder: "At least 8 characters", autocomplete: "new-password" });
    const pass2 = el("input", { type: "password", class: "up-text", placeholder: "Repeat password", autocomplete: "new-password" });
    const status = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const submit = el("button", { class: "btn btn-primary", type: "button" }, "Register");
    const form = el("div", { class: "step-form" }, [
      el("p", { class: "muted", style: "margin:0 0 0.4rem" }, "Request access to the Rushroom AB Compliance Portal. We'll email you a link to verify your address; an administrator then approves your access and sets your role. You'll sign in with this email and password once approved."),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Role"), role]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Name"), name]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Email"), email]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Phone"), phone]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "WhatsApp"), whatsapp]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Password"), pass]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Confirm"), pass2]),
      el("div", { style: "margin-top:0.5rem" }, submit),
      status,
    ]);
    openModal("Register for access", form);
    name.focus();
    submit.addEventListener("click", async () => {
      const emailV = email.value.trim();
      if (!name.value.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailV)) { status.className = "up-status warn"; status.textContent = "Please enter your name and a valid email."; return; }
      if (pass.value.length < 8) { status.className = "up-status warn"; status.textContent = "Choose a password of at least 8 characters."; return; }
      if (pass.value !== pass2.value) { status.className = "up-status warn"; status.textContent = "The two passwords don't match."; return; }
      submit.disabled = true; status.className = "up-status"; status.textContent = "Submitting…";
      try {
        const res = await API.registerUser({ role: role.value, name: name.value.trim(), email: emailV, phone: phone.value.trim(), whatsapp: whatsapp.value.trim(), password: pass.value });
        status.className = "up-status ok"; status.textContent = (res && res.message) || "Registered — check your email to verify.";
        name.value = email.value = phone.value = whatsapp.value = pass.value = pass2.value = "";
      } catch (ex) { submit.disabled = false; status.className = "up-status err"; status.textContent = `Failed: ${ex.message}`; }
    });
  }

  // "Forgot password" flow — emails a set-password link.
  function forgotPasswordModal(prefill) {
    const email = el("input", { type: "email", class: "up-text", placeholder: "you@company.com", value: prefill || "" });
    const status = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const submit = el("button", { class: "btn btn-primary", type: "button" }, "Send reset link");
    const form = el("div", { class: "step-form" }, [
      el("p", { class: "muted", style: "margin:0 0 0.4rem" }, "Enter your email and we'll send a link to set a new password. The link expires in 1 hour."),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Email"), email]),
      el("div", { style: "margin-top:0.5rem" }, submit), status,
    ]);
    openModal("Reset your password", form);
    email.focus();
    submit.addEventListener("click", async () => {
      const v = email.value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { status.className = "up-status warn"; status.textContent = "Enter a valid email."; return; }
      submit.disabled = true; status.className = "up-status"; status.textContent = "Sending…";
      try { const r = await API.requestPasswordReset(v); status.className = "up-status ok"; status.textContent = (r && r.message) || "If that email is registered, a link has been sent."; }
      catch (ex) { submit.disabled = false; status.className = "up-status err"; status.textContent = `Failed: ${ex.message}`; }
    });
  }
  // Adds a "Register for access" call-to-action under an access gate card.
  function addRegisterCta(gateEl) {
    const card = gateEl && gateEl.querySelector(".gate-card");
    if (!card || card.querySelector(".gate-register")) return;
    card.appendChild(el("div", { class: "gate-register" }, [
      el("p", { class: "muted", style: "margin:0 0 0.5rem; font-size:0.9rem" }, "Don't have access yet?"),
      el("button", { class: "btn btn-sm", type: "button", onclick: registerModal }, "Register for access"),
    ]));
  }

  /* ---------------- admin account management (Rushroom) ---------------- */
  function accountCard(u, role, reload) {
    const roleSel = el("select", { class: "up-text" }, [el("option", { value: "" }, "— set role —"), ...ASSIGN_ROLE_OPTS.map(([v, l]) => el("option", { value: v, selected: (u.role || "") === v ? "selected" : null }, l))]);
    const statusSel = el("select", { class: "up-text" }, ["pending", "verified", "approved", "rejected", "disabled"].map((st) => el("option", { value: st, selected: u.status === st ? "selected" : null }, st)));
    const note = el("span", { class: "up-status", style: "margin:0 0 0 0.2rem" }, "");
    const tok = () => API.getToken();
    const run = async (fn) => { try { await fn(); await reload(); } catch (ex) { note.className = "up-status err"; note.textContent = ex.message; } };
    const copyLink = async (getter, label) => {
      try { const r = await getter(); const url = r.verifyUrl || r.resetUrl; if (navigator.clipboard && url) await navigator.clipboard.writeText(url); note.className = "up-status ok"; note.textContent = r.emailed ? `Emailed + ${label} copied.` : `${label} copied to clipboard.`; }
      catch (ex) { note.className = "up-status err"; note.textContent = ex.message; }
    };
    const approve = actionBtn("Approve", "plus", { primary: true, onClick: () => {
      if (!roleSel.value) { note.className = "up-status warn"; note.textContent = "Set a role first."; return; }
      run(() => API.adminUpdateUser(tok(), u.id, { role: roleSel.value, status: "approved" }));
    } });
    const save = actionBtn("Save", "edit", { onClick: () => run(() => API.adminUpdateUser(tok(), u.id, { role: roleSel.value || undefined, status: statusSel.value })) });
    const vlink = actionBtn("Verify link", "external", { onClick: () => copyLink(() => API.adminUserVerifyLink(tok(), u.id), "Verify link") });
    const rlink = actionBtn("Reset link", "refresh", { onClick: () => copyLink(() => API.adminUserResetLink(tok(), u.id), "Reset link") });
    const del = actionBtn("Delete", "trash", { danger: true, onClick: () => { if (confirm(`Delete ${u.name} (${u.email})?`)) run(() => API.adminDeleteUser(tok(), u.id)); } });
    return el("div", { class: "card acct-card" }, [
      el("div", { class: "acct-head" }, [
        el("div", {}, [el("strong", {}, u.name), el("div", { class: "muted", style: "font-size:0.85rem" }, u.email)]),
        el("span", { class: `acct-badge acct-${u.status}` }, `${u.status}${u.email_verified ? " · verified" : " · unverified"}`),
      ]),
      el("div", { class: "muted", style: "font-size:0.85rem; margin-top:0.2rem" }, `${u.phone ? "☎ " + u.phone : "no phone"}${u.whatsapp ? "  ·  WhatsApp " + u.whatsapp : ""}  ·  requested: ${u.requested_role}`),
      el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; margin-top:0.6rem" }, [
        el("span", { class: "form-label" }, "Role"), roleSel,
        el("span", { class: "form-label" }, "Status"), statusSel,
        approve, save, vlink, rlink, del,
      ]),
      note,
    ]);
  }
  const MROLE_LABELS = [["org_admin", "Org admin"], ["manager", "Manager"], ["reviewer", "Reviewer"], ["collaborator", "Collaborator"]];
  const mroleLabel = (r) => (MROLE_LABELS.find((x) => x[0] === r) || [, r])[1];

  // Stage 3: the Accounts tab becomes an Organization area of sub-tabs. Org
  // admins get Members + Organization; platform operators also get All users,
  // Tenants (admin console) and the platform Audit log.
  async function renderAccounts(role, mount) {
    if (!API.isAdmin()) { mount.replaceChildren(el("div", { class: "empty" }, "Administrators only.")); return; }
    mount.replaceChildren(el("div", { class: "loading" }, "Loading…"));
    let ctx = {};
    try { ctx = await API.orgContext(API.getToken()); } catch { /* treat as a plain org admin */ }
    const isPlatform = !!ctx.platform_owner;
    const lazy = (loader) => { const m = el("div", {}, el("div", { class: "loading" }, "Loading…")); loader().then((n) => m.replaceChildren(n)).catch((ex) => m.replaceChildren(el("div", { class: "error" }, ex.message))); return m; };
    const tabs = [
      { id: "members", label: "Members", icon: "layers", build: () => lazy(orgMembersView) },
      { id: "org", label: "Organization", icon: "tag", build: () => orgSettingsView(ctx) },
      { id: "billing", label: "Billing & plan", icon: "sparkles", build: () => lazy(billingView) },
      { id: "security", label: "Security", icon: "tag", build: () => lazy(securityView) },
    ];
    if (isPlatform) {
      tabs.push({ id: "users", label: "All users", icon: "eye", build: () => lazy(() => usersAdminView(role)) });
      tabs.push({ id: "tenants", label: "Tenants", icon: "grid", build: () => lazy(tenantsView) });
      tabs.push({ id: "audit", label: "Audit", icon: "graph", build: () => lazy(auditView) });
    }
    mount.replaceChildren(subTabs("accounts", tabs));
  }

  // Members of the caller's organization (memberships), with invite + controls.
  async function orgMembersView() {
    const wrap = el("div");
    const box = el("div");
    const reload = async () => {
      box.replaceChildren(el("div", { class: "loading" }, "Loading members…"));
      let r; try { r = await API.orgMembers(API.getToken()); } catch (ex) { box.replaceChildren(el("div", { class: "error" }, ex.message)); return; }
      const members = r.members || [];
      box.replaceChildren(members.length
        ? el("div", { class: "acct-list" }, members.map((m) => memberRow(m, reload)))
        : el("div", { class: "empty" }, "No members yet — invite someone below."));
    };
    // Invite form
    const email = el("input", { type: "email", class: "up-text", placeholder: "teammate@company.com", style: "max-width:260px" });
    const roleSel = el("select", { class: "up-text" }, MROLE_LABELS.map(([v, l]) => el("option", { value: v, selected: v === "collaborator" ? "selected" : null }, l)));
    const note = el("span", { class: "up-status" }, "");
    const invite = actionBtn("Invite", "plus", { primary: true, onClick: async () => {
      const e = email.value.trim();
      if (!e) { note.className = "up-status warn"; note.textContent = "Enter an email."; return; }
      note.className = "up-status"; note.textContent = "Inviting…";
      try {
        const res = await API.orgInviteMember(API.getToken(), e, roleSel.value);
        note.className = "up-status ok";
        note.textContent = res.created ? (res.emailed ? "Invited — a set-password email was sent." : "Invited. Copy this link: " + res.setUrl) : "Existing user added to this organization.";
        email.value = ""; await reload();
      } catch (ex) { note.className = "up-status err"; note.textContent = ex.message; }
    } });
    wrap.append(
      el("p", { class: "muted", style: "margin:0 0 0.6rem" }, "People with access to this organization. Invite a teammate by email and choose their role; new accounts get a set-password link."),
      el("div", { class: "rl-controls" }, [el("span", { class: "form-label" }, "Invite"), email, roleSel, invite, note]),
      box,
    );
    await reload();
    return wrap;
  }

  function memberRow(m, reload) {
    const note = el("span", { class: "up-status" }, "");
    const roleSel = el("select", { class: "up-text" }, MROLE_LABELS.map(([v, l]) => el("option", { value: v, selected: m.role === v ? "selected" : null }, l)));
    roleSel.addEventListener("change", async () => {
      note.className = "up-status"; note.textContent = "Saving…";
      try { await API.orgUpdateMember(API.getToken(), m.membership_id, { role: roleSel.value }); note.className = "up-status ok"; note.textContent = "Saved."; }
      catch (ex) { note.className = "up-status err"; note.textContent = ex.message; roleSel.value = m.role; }
    });
    const suspended = m.status === "suspended";
    const toggle = actionBtn(suspended ? "Reactivate" : "Suspend", suspended ? "refresh" : "trash", { danger: !suspended, onClick: async () => {
      try { await API.orgUpdateMember(API.getToken(), m.membership_id, { status: suspended ? "active" : "suspended" }); await reload(); }
      catch (ex) { note.className = "up-status err"; note.textContent = ex.message; }
    } });
    return el("div", { class: "acct-card" }, [
      el("div", {}, [
        el("div", { class: "name" }, [el("strong", {}, m.name || m.email), m.account_status && m.account_status !== "approved" ? el("span", { class: "pill-priority", style: "margin-left:0.4rem" }, m.account_status) : null]),
        el("div", { class: "muted", style: "font-size:0.82rem" }, m.email),
      ]),
      el("div", { style: "display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap" }, [
        el("span", { class: "rl-status " + (suspended ? "rl-s-suspended" : "rl-s-accepted") }, suspended ? "Suspended" : "Active"),
        roleSel, toggle, note,
      ]),
    ]);
  }

  // Organization settings (name + read-only plan/status).
  function orgSettingsView(ctx) {
    const wrap = el("div");
    const nameInput = el("input", { type: "text", class: "up-text", style: "max-width:320px" });
    const note = el("span", { class: "up-status" }, "");
    const info = el("div", { class: "muted", style: "margin-top:0.6rem; font-size:0.85rem" }, "Loading…");
    API.orgSettings(API.getToken()).then((r) => {
      const o = r.organization || {};
      nameInput.value = o.name || ctx.organization_name || "";
      info.textContent = `Plan: ${o.plan || "—"} · Status: ${o.status || "—"} · Active members: ${r.activeMembers ?? "—"}`;
    }).catch((ex) => { info.textContent = ex.message; });
    const save = actionBtn("Save", "edit", { primary: true, onClick: async () => {
      note.className = "up-status"; note.textContent = "Saving…";
      try { await API.orgUpdateSettings(API.getToken(), { name: nameInput.value.trim() }); note.className = "up-status ok"; note.textContent = "Saved."; renderSessionActions(); }
      catch (ex) { note.className = "up-status err"; note.textContent = ex.message; }
    } });
    wrap.append(
      el("h3", {}, "Organization settings"),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Name"), nameInput]),
      el("div", { style: "display:flex; gap:0.5rem; align-items:center" }, [save, note]),
      info,
    );
    return wrap;
  }

  // Platform operator: all global user accounts (the former Accounts view).
  async function usersAdminView(role) {
    const mount = el("div");
    let payload;
    try { payload = await API.adminListUsers(API.getToken(role)); }
    catch (ex) { mount.replaceChildren(el("div", { class: "error" }, `Couldn't load accounts: ${ex.message}`)); return mount; }
    const users = payload.users || [];
    const reload = () => usersAdminView(role).then((n) => mount.replaceChildren(...n.childNodes));

    // Email-delivery status + a test-send. When Resend isn't configured, links
    // must be copied by hand; when it is, verification/reset links are emailed.
    const mailNote = el("span", { class: "up-status", style: "margin-left:0.4rem" }, "");
    const mailTo = el("input", { type: "email", class: "up-text", placeholder: (API.session() && API.session().email) || "you@company.com", style: "max-width:240px" });
    const testBtn = actionBtn("Send test email", "external", { onClick: async () => {
      mailNote.className = "up-status"; mailNote.textContent = "Sending…";
      try { const r = await API.adminSendTestEmail(API.getToken(), mailTo.value.trim() || undefined); mailNote.className = "up-status ok"; mailNote.textContent = `Sent to ${r.to}.`; }
      catch (ex) { mailNote.className = "up-status err"; mailNote.textContent = ex.message; }
    } });
    const emailBanner = payload.emailConfigured
      ? el("div", { class: "notice ok" }, [
          el("strong", {}, "Email delivery is on. "),
          document.createTextNode(`Verification and password links are emailed automatically${payload.mailFrom ? " from " + payload.mailFrom : ""}. `),
          el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; margin-top:0.5rem" }, [mailTo, testBtn, mailNote]),
        ])
      : el("div", { class: "notice warn" }, "Email delivery is off — set RESEND_API_KEY + MAIL_FROM in the function secrets to email links automatically. Until then, use the Verify/Reset link buttons to copy a link and send it yourself.");

    const search = el("input", { type: "search", class: "browser-search-input", placeholder: "Search name, email, role, status…", style: "max-width:360px" });
    const listWrap = el("div", { class: "standards", style: "margin-top:0.9rem" });
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const filtered = users.filter((u) => !q || `${u.name} ${u.email} ${u.role || ""} ${u.requested_role} ${u.status}`.toLowerCase().includes(q));
      listWrap.replaceChildren(...(filtered.length ? filtered.map((u) => accountCard(u, role, reload)) : [el("div", { class: "empty" }, "No matching accounts.")]));
    };
    search.addEventListener("input", render);
    const counts = users.reduce((m, u) => { m[u.status] = (m[u.status] || 0) + 1; return m; }, {});
    const summary = el("div", { class: "sev-summary" }, ["pending", "verified", "approved", "rejected", "disabled"].map((st) => el("span", { class: "sev-chip" }, `${st}: ${counts[st] || 0}`)));
    mount.replaceChildren(el("div", {}, [
      emailBanner,
      summary,
      el("div", { style: "margin-top:0.75rem" }, search),
      users.length ? listWrap : el("div", { class: "empty", style: "margin-top:0.75rem" }, "No registrations yet."),
    ]));
    render();
    return mount;
  }

  const FEATURE_LABELS = { core: "Core", deviation: "Deviation scan", level2: "Clauses & DPP", links: "Requirement links", classification: "Classification", cellar: "Directive analyser" };
  const fmtQuota = (n) => n == null ? "unlimited" : (n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));

  // Org admin: current plan, entitlements and this month's usage vs limits.
  async function billingView() {
    const wrap = el("div");
    let r; try { r = await API.orgBilling(API.getToken()); } catch (ex) { wrap.append(el("div", { class: "error" }, ex.message)); return wrap; }
    const aiPct = r.ai.limit ? Math.min(100, Math.round((r.ai.used / r.ai.limit) * 100)) : null;
    const seatPct = r.seats.limit ? Math.min(100, Math.round((r.seats.used / r.seats.limit) * 100)) : null;
    const bar = (pct, over) => el("div", { class: "progress", style: "max-width:320px" }, el("span", { style: `width:${pct == null ? 100 : pct}%${over ? ";background:var(--red)" : ""}` }));
    wrap.append(
      el("h3", {}, `Plan: ${r.plan_label}`),
      el("p", { class: "muted", style: "margin:0 0 0.4rem" }, `Included: ${(r.features || []).map((f) => FEATURE_LABELS[f] || f).join(" · ")}`),
      el("div", { class: "acct-card", style: "display:block" }, [
        el("div", { class: "name" }, `AI usage · ${usagePeriodLabel(r.period)}`),
        el("div", { class: "muted", style: "font-size:0.85rem; margin:0.2rem 0" }, `${fmtQuota(r.ai.used)} of ${fmtQuota(r.ai.limit)} tokens${aiPct != null ? ` (${aiPct}%)` : ""}`),
        bar(aiPct, aiPct != null && aiPct >= 100),
      ]),
      el("div", { class: "acct-card", style: "display:block; margin-top:0.5rem" }, [
        el("div", { class: "name" }, "Seats (active members)"),
        el("div", { class: "muted", style: "font-size:0.85rem; margin:0.2rem 0" }, `${r.seats.used} of ${r.seats.limit == null ? "unlimited" : r.seats.limit}`),
        bar(seatPct, seatPct != null && seatPct >= 100),
      ]),
      el("h3", { style: "margin-top:1rem" }, "Plans"),
      el("div", { class: "acct-list" }, (r.plans || []).filter((p) => p.id !== "internal").map((p) => el("div", { class: "acct-card" }, [
        el("div", {}, [el("div", { class: "name" }, [el("strong", {}, p.label), p.id === r.plan ? el("span", { class: "rl-status rl-s-accepted", style: "margin-left:0.4rem" }, "Current") : null]), el("div", { class: "muted", style: "font-size:0.8rem" }, (p.features || []).map((f) => FEATURE_LABELS[f] || f).join(" · "))]),
        el("span", { class: "muted", style: "font-size:0.82rem" }, `${fmtQuota(p.aiTokensPerMonth)} AI · ${p.maxSeats == null ? "∞" : p.maxSeats} seats`),
      ]))),
      el("p", { class: "muted", style: "font-size:0.8rem; margin-top:0.6rem" }, "To change plan, contact your account manager. (Self-serve checkout is on the roadmap.)"),
    );
    return wrap;
  }
  const usagePeriodLabel = (p) => { try { const [y, m] = String(p).split("-"); return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" }); } catch { return p; } };

  // Per-user two-factor authentication (TOTP) enrolment / removal.
  async function securityView() {
    const wrap = el("div");
    const box = el("div");
    const load = async () => {
      box.replaceChildren(el("div", { class: "loading" }, "Loading…"));
      let s; try { s = await API.mfaStatus(API.getToken()); } catch (ex) { box.replaceChildren(el("div", { class: "error" }, ex.message)); return; }
      if (!s.available) { box.replaceChildren(el("div", { class: "notice warn" }, "Two-factor authentication is available for individual email accounts, not the shared password login.")); return; }
      if (s.enabled) {
        const code = el("input", { class: "up-text", inputmode: "numeric", placeholder: "6-digit code", maxlength: "6", style: "max-width:140px" });
        const note = el("span", { class: "up-status" }, "");
        const disable = actionBtn("Turn off MFA", "trash", { danger: true, onClick: async () => { note.className = "up-status"; note.textContent = "…"; try { await API.mfaDisable(API.getToken(), code.value.trim()); await load(); } catch (ex) { note.className = "up-status err"; note.textContent = ex.message; } } });
        box.replaceChildren(el("div", { class: "notice ok" }, "Two-factor authentication is ON for your account."), el("div", { class: "rl-controls", style: "margin-top:0.5rem" }, [el("span", { class: "form-label" }, "Enter a code to disable"), code, disable, note]));
        return;
      }
      const start = actionBtn("Set up two-factor auth", "sparkles", { primary: true, onClick: async () => {
        let r; try { r = await API.mfaEnrollStart(API.getToken()); } catch (ex) { box.replaceChildren(el("div", { class: "error" }, ex.message)); return; }
        const code = el("input", { class: "up-text", inputmode: "numeric", placeholder: "6-digit code", maxlength: "6", style: "max-width:140px" });
        const note = el("span", { class: "up-status" }, "");
        const verify = actionBtn("Verify & enable", "edit", { primary: true, onClick: async () => { note.className = "up-status"; note.textContent = "Verifying…"; try { await API.mfaEnrollVerify(API.getToken(), code.value.trim()); await load(); } catch (ex) { note.className = "up-status err"; note.textContent = ex.message; } } });
        box.replaceChildren(
          el("p", { class: "muted" }, "Add this account to an authenticator app (Google Authenticator, 1Password, Authy…), then enter a code to confirm."),
          el("div", { class: "acct-card", style: "display:block" }, [
            el("div", { class: "name" }, "Setup key"),
            el("code", { style: "user-select:all; word-break:break-all" }, r.secret),
            el("div", { style: "margin-top:0.4rem" }, el("a", { href: r.otpauth, class: "btn btn-sm" }, "Open in authenticator app")),
          ]),
          el("div", { class: "rl-controls", style: "margin-top:0.5rem" }, [el("span", { class: "form-label" }, "Code"), code, verify, note]),
        );
      } });
      box.replaceChildren(el("p", { class: "muted" }, "Protect your sign-in with a second factor — a 6-digit code from an authenticator app."), start);
    };
    wrap.append(el("h3", {}, "Two-factor authentication (MFA)"), box);
    await load();
    return wrap;
  }

  const TENANT_PLANS = ["trial", "starter", "professional", "enterprise", "internal"];
  const TENANT_STATUSES = ["trial", "active", "past_due", "suspended", "cancelled"];

  // Platform operator: the internal Admin Console — tenants list, status control
  // and audited time-boxed impersonation ("Act as").
  async function tenantsView() {
    const wrap = el("div");
    const box = el("div");
    const reload = async () => {
      box.replaceChildren(el("div", { class: "loading" }, "Loading tenants…"));
      let r; try { r = await API.platformTenants(API.getToken()); } catch (ex) { box.replaceChildren(el("div", { class: "error" }, ex.message)); return; }
      const tenants = r.tenants || [];
      box.replaceChildren(el("div", { class: "acct-list" }, tenants.map((t) => tenantRow(t, reload))));
    };
    wrap.append(
      el("p", { class: "muted", style: "margin:0 0 0.6rem" }, "All organizations on this platform. Change a tenant's status, or start a time-boxed, audited support session as that tenant."),
      box,
    );
    await reload();
    return wrap;
  }

  function tenantRow(t, reload) {
    const note = el("span", { class: "up-status" }, "");
    const statusSel = el("select", { class: "up-text" }, TENANT_STATUSES.map((s) => el("option", { value: s, selected: t.status === s ? "selected" : null }, s)));
    statusSel.disabled = !!t.is_seed;
    statusSel.addEventListener("change", async () => {
      note.className = "up-status"; note.textContent = "Saving…";
      try { await API.platformSetTenantStatus(API.getToken(), t.id, statusSel.value); note.className = "up-status ok"; note.textContent = "Saved."; }
      catch (ex) { note.className = "up-status err"; note.textContent = ex.message; statusSel.value = t.status; }
    });
    const planSel = el("select", { class: "up-text", title: "Plan" }, TENANT_PLANS.map((p) => el("option", { value: p, selected: t.plan === p ? "selected" : null }, p)));
    planSel.addEventListener("change", async () => {
      note.className = "up-status"; note.textContent = "Saving…";
      try { await API.platformSetTenantPlan(API.getToken(), t.id, planSel.value); note.className = "up-status ok"; note.textContent = "Saved."; }
      catch (ex) { note.className = "up-status err"; note.textContent = ex.message; planSel.value = t.plan; }
    });
    const actAs = actionBtn("Act as", "external", { onClick: async () => {
      const reason = prompt(`Start a support session as “${t.name}”? Optionally note a reason (logged):`, "");
      if (reason === null) return;
      note.className = "up-status"; note.textContent = "Starting…";
      try {
        const r = await API.platformImpersonate(API.getToken(), t.id, reason);
        API.startImpersonation(r, t.name);
        location.reload();
      } catch (ex) { note.className = "up-status err"; note.textContent = ex.message; }
    } });
    return el("div", { class: "acct-card" }, [
      el("div", {}, [
        el("div", { class: "name" }, [el("strong", {}, t.name), t.is_seed ? el("span", { class: "pill-priority", style: "margin-left:0.4rem" }, "operator") : null]),
        el("div", { class: "muted", style: "font-size:0.82rem" }, `${t.slug || "—"} · ${t.active_members} member${t.active_members === 1 ? "" : "s"} · plan ${t.plan || "—"}`),
      ]),
      el("div", { style: "display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap" }, [planSel, statusSel, t.is_seed ? null : actAs, note].filter(Boolean)),
    ]);
  }

  // Platform operator: the append-only platform audit log.
  async function auditView() {
    const wrap = el("div");
    let r; try { r = await API.platformAudit(API.getToken()); } catch (ex) { wrap.append(el("div", { class: "error" }, ex.message)); return wrap; }
    const entries = r.entries || [];
    const exportBtn = actionBtn("Export JSON", "external", { onClick: async () => {
      try { const full = await API.platformAudit(API.getToken(), 2000); downloadBlob(JSON.stringify(full.entries || [], null, 2), `platform-audit-${new Date().toISOString().slice(0, 10)}.json`, "application/json"); }
      catch (ex) { alert(ex.message); }
    } });
    wrap.append(
      el("div", { style: "display:flex; justify-content:space-between; align-items:center; gap:0.5rem; flex-wrap:wrap" }, [el("h3", { style: "margin:0" }, "Platform audit log"), exportBtn]),
      entries.length ? el("div", { class: "acct-list" }, entries.map((e) => el("div", { class: "acct-card" }, [
        el("div", {}, [el("div", { class: "name" }, el("strong", {}, e.action)), el("div", { class: "muted", style: "font-size:0.82rem" }, `${e.actor_email || "operator"}${e.detail && e.detail.reason ? " · " + e.detail.reason : ""}`)]),
        el("span", { class: "muted", style: "font-size:0.8rem" }, fmtDate(e.created_at)),
      ]))) : el("div", { class: "empty" }, "No operator activity yet."),
    );
    return wrap;
  }

  /* ================= Level 2: clauses · interpretations · matrix · passports ===========
   * Structured, clause-level compliance. Rushroom-only. Backed by the Phase-5
   * edge actions (extract/generate/save/getInterpretations, complianceMatrix,
   * product-passport CRUD + DPP export). */
  const L2_STATUS = [["compliant", "Compliant"], ["deviation", "Deviation"], ["not_applicable", "N/A"], ["pending", "Pending"]];
  const l2StatusLabel = (st) => (L2_STATUS.find((s) => s[0] === st) || [, "—"])[1];
  const l2StatusChip = (st) => el("span", { class: `l2-status l2-${st || "none"}` }, l2StatusLabel(st) || "—");
  const l2CellGlyph = { compliant: "✓", deviation: "!", not_applicable: "–", pending: "…", none: "" };
  const taField = (attrs, val) => { const t = el("textarea", attrs); t.value = val || ""; return t; };
  function downloadBlob(text, filename, type) {
    const blob = new Blob([text], { type: type || "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function flattenStdVersions(standards) {
    const out = [];
    for (const s of standards || []) for (const v of (s.versions || [])) out.push({ id: v.id, label: `${s.code || s.title || "Standard"}${v.version ? " " + v.version : ""}`, std: s, v });
    return out;
  }
  function flattenDocVersions(documents) {
    const out = [];
    for (const d of documents || []) { const vs = d.versions || []; vs.forEach((v, i) => out.push({ id: v.id, label: `${d.name} · v${vs.length - i}`, doc: d, v })); }
    return out;
  }

  // 1) Clauses — extract and browse a standard version's clauses.
  function l2ClausesView(ctx) {
    const wrap = el("div");
    const stdVers = flattenStdVersions(ctx.standards);
    if (!stdVers.length) { wrap.appendChild(el("div", { class: "empty" }, "No standard versions yet — upload a standard file under “Standards & regulations” first.")); return wrap; }
    const sel = el("select", { class: "up-text" }, stdVers.map((o) => {
      const opt = el("option", { value: o.id, "data-base-label": o.label }, `${o.label} [Checking...]`);
      return opt;
    }));
    const out = el("div", { style: "margin-top:0.8rem" });
    const status = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    // Show per-row extraction status directly in the dropdown labels.
    const setOptionProcessedState = (versionId, state, clauseCount) => {
      const opt = [...sel.options].find((o) => o.value === versionId);
      if (!opt) return;
      const base = opt.getAttribute("data-base-label") || opt.textContent || "";
      if (state === "processed") opt.textContent = `${base} [Processed${typeof clauseCount === "number" ? `: ${clauseCount}` : ""}]`;
      else if (state === "not_processed") opt.textContent = `${base} [Not processed]`;
      else if (state === "unknown") opt.textContent = `${base} [Status unavailable]`;
      else opt.textContent = `${base} [Checking...]`;
    };
    async function updateProcessedBadges() {
      const current = sel.value;
      stdVers.forEach((o) => setOptionProcessedState(o.id, "checking"));
      await Promise.all(stdVers.map(async (o) => {
        try {
          const r = await API.getClausesForStandard(ctx.token, o.id);
          const count = (r.clauses || []).length;
          setOptionProcessedState(o.id, count > 0 ? "processed" : "not_processed", count);
        } catch {
          setOptionProcessedState(o.id, "unknown");
        }
      }));
      sel.value = current;
    }
    const load = async () => {
      out.replaceChildren(el("div", { class: "loading" }, "Loading clauses…"));
      try {
        const { clauses } = await API.getClausesForStandard(ctx.token, sel.value);
        if (!clauses.length) { out.replaceChildren(el("div", { class: "empty" }, "No clauses yet. Use “Extract clauses (AI)” to read this standard.")); return; }
        // Batch-fetch requirement links touching these clauses → per-clause counterparts.
        const byClause = new Map();
        try {
          const r = await API.listRequirementLinksForClauses(ctx.token, clauses.map((c) => c.id));
          const ours = new Set(clauses.map((c) => c.id));
          for (const l of (r.links || [])) {
            for (const side of ["from", "to"]) {
              const ep = l[side];
              if (ep && ep.type === "clause" && ours.has(ep.id)) {
                if (!byClause.has(ep.id)) byClause.set(ep.id, []);
                byClause.get(ep.id).push({ link: l, other: side === "from" ? l.to : l.from });
              }
            }
          }
        } catch { /* links are optional — the clause table still renders */ }

        const tbody = el("tbody");
        clauses.forEach((c) => {
          const entries = byClause.get(c.id) || [];
          const detail = el("tr", { class: "rl-detail", hidden: "hidden" }, el("td", { colspan: "5" }, rlInlineStrip(entries)));
          const toggle = entries.length
            ? el("button", { type: "button", class: "rl-count", "aria-expanded": "false" }, `🔗 ${entries.length}`)
            : el("span", { class: "muted", style: "font-size:0.8rem" }, "—");
          if (entries.length) toggle.addEventListener("click", () => {
            const open = detail.hasAttribute("hidden");
            if (open) detail.removeAttribute("hidden"); else detail.setAttribute("hidden", "hidden");
            toggle.setAttribute("aria-expanded", open ? "true" : "false");
          });
          tbody.append(el("tr", {}, [
            el("td", {}, el("strong", {}, c.clause_ref)),
            el("td", {}, c.clause_title || "—"),
            el("td", {}, el("span", { class: "pill-priority" }, c.requirement_type || "—")),
            el("td", { class: "l2-clausetext" }, c.clause_text || ""),
            el("td", {}, toggle),
          ]), detail);
        });
        out.replaceChildren(el("table", { class: "l2-table" }, [
          el("thead", {}, el("tr", {}, [el("th", {}, "Ref"), el("th", {}, "Title"), el("th", {}, "Type"), el("th", {}, "Requirement"), el("th", {}, "Links")])),
          tbody,
        ]));
      } catch (ex) { out.replaceChildren(el("div", { class: "error" }, ex.message)); }
    };
    const extract = actionBtn("Extract clauses (AI)", "sparkles", { primary: true, onClick: async () => {
      status.className = "up-status"; status.textContent = "Reading the standard file with AI — this can take a minute…";
      try {
        const r = await API.extractStandardClauses(ctx.token, { standardVersionId: sel.value });
        status.className = "up-status ok";
        status.replaceChildren(document.createTextNode(`Extracted ${r.inserted} clause(s). `), usageChip(r.usage) || document.createTextNode(""));
        setOptionProcessedState(sel.value, "processed", typeof r.inserted === "number" ? r.inserted : undefined);
        await load();
      }
      catch (ex) { status.className = "up-status err"; status.textContent = ex.message; }
    } });
    // Deterministic: turn explicit citations in the clause text into exact links.
    const detectCites = actionBtn("Detect citations", "diff", { onClick: async () => {
      status.className = "up-status"; status.textContent = "Scanning clause text for references to other clauses…";
      try {
        const r = await API.detectClauseCitations(ctx.token, sel.value);
        status.className = "up-status ok";
        status.textContent = r.created
          ? `Created ${r.created} citation link${r.created === 1 ? "" : "s"} from ${r.scanned} clauses.`
          : `No new citations found in ${r.scanned} clause${r.scanned === 1 ? "" : "s"}.`;
        await load();
      } catch (ex) { status.className = "up-status err"; status.textContent = ex.message; }
    }, title: "Find explicit references like “clause 4.11.6” or “EN 62471 4.3” and link them" });
    sel.addEventListener("change", load);
    wrap.append(
      el("p", { class: "muted", style: "margin:0 0 0.6rem" }, "Decompose a standard into individual clauses. The AI reads the uploaded standard file and extracts each requirement so you can interpret them one by one."),
      el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center" }, [el("span", { class: "form-label" }, "Standard"), sel, extract, detectCites]),
      status, out,
    );
    updateProcessedBadges();
    load();
    return wrap;
  }

  /* ---------------- Requirement links (cross-document clause linking) ------- */
  const RL_TYPES = [
    ["same_clause", "Same clause"], ["citation", "Citation / reference"],
    ["implements", "Implements / satisfies"], ["similar_intent", "Similar intent"],
    ["defines_terms_for", "Defines terms for"], ["supersedes", "Supersedes / amends"],
    ["conflicts_with", "Conflicts with"],
  ];
  const RL_TYPE_LABEL = (t) => (RL_TYPES.find((x) => x[0] === t) || [, t])[1];
  const RL_EXACT = new Set(["same_clause", "citation", "implements"]);
  const rlTypeChip = (t) => el("span", { class: "rl-type " + (RL_EXACT.has(t) ? "rl-exact" : "rl-semantic") }, RL_TYPE_LABEL(t));
  const RL_STATUS = { proposed: "Proposed", accepted: "Accepted", rejected: "Rejected", flagged: "Flagged", archived: "Archived" };
  const rlStatusChip = (s) => el("span", { class: "rl-status rl-s-" + (s || "proposed") }, RL_STATUS[s] || s || "—");
  const RL_SOURCE = { manual: "Manual", cited: "Cited", imported: "Imported", ai_assisted: "AI-assisted", derived: "Derived" };

  // Read-only inline strip of a clause's links (used in the Clauses tab).
  function rlInlineStrip(entries) {
    if (!entries.length) return el("span", { class: "muted" }, "No links.");
    return el("div", { class: "rl-inline" }, [
      ...entries.map(({ link, other }) => el("span", { class: "rl-inline-item" }, [
        rlTypeChip(link.link_type),
        el("span", { class: "rl-arrow", "aria-hidden": "true" }, "→"),
        el("span", { class: "rl-target" }, [
          el("strong", {}, (other && other.label) || "(removed)"),
          el("span", { class: "rl-kind" }, other && other.type === "document_version" ? "doc" : "clause"),
        ]),
        rlStatusChip(link.status),
      ])),
      el("span", { class: "muted", style: "font-size:0.78rem" }, "Manage in the Links tab."),
    ]);
  }

  /* ---- As-Operated paragraphs (statements) — addressable text units ---- */
  // Split extracted document text into paragraphs (blank-line separated, ≥3 words).
  function segmentIntoParagraphs(text) {
    return String(text || "")
      .split(/\n\s*\n+/)
      .map((p) => p.replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ").trim())
      .filter((p) => p.split(" ").filter(Boolean).length >= 3)
      .slice(0, 300);
  }

  // A document version broken into paragraphs, each linkable to a clause. Lazy.
  function docStatementsPanel(d, version) {
    const summary = el("summary", {}, "Paragraphs & links");
    const body = el("div", { class: "rl-stmt-body" });
    const node = el("details", { class: "rl-statements" }, [summary, body]);
    let stdCache = null, loaded = false;
    const getStandards = async () => stdCache || (stdCache = ((await API.standards(API.getToken())).standards) || []);

    const segment = async () => {
      body.replaceChildren(el("div", { class: "loading" }, "Reading the file and splitting into paragraphs…"));
      try {
        const text = await extractVersionText(version.open_url, version.file_name || d.name);
        if (text == null) { body.replaceChildren(el("div", { class: "notice warn" }, "This file type can’t be text-extracted (e.g. an image or scanned PDF).")); return; }
        const paras = segmentIntoParagraphs(text);
        if (!paras.length) { body.replaceChildren(el("div", { class: "muted" }, "No paragraphs found in the text.")); return; }
        await API.saveDocumentStatements(API.getToken(), version.id, paras.map((t, i) => ({ seq: i, text: t })));
        await load();
      } catch (ex) { body.replaceChildren(el("div", { class: "error" }, ex.message)); }
    };
    const load = async () => {
      body.replaceChildren(el("div", { class: "loading" }, "Loading paragraphs…"));
      let statements = [];
      try { statements = (await API.listDocumentStatements(API.getToken(), version.id)).statements || []; }
      catch (ex) { body.replaceChildren(el("div", { class: "error" }, ex.message)); return; }
      if (!statements.length) {
        body.replaceChildren(el("div", {}, [
          el("p", { class: "muted", style: "font-size:0.85rem; margin:0 0 0.45rem" }, "Break this version into paragraphs so you can link each one to the clauses it satisfies."),
          actionBtn("Break into paragraphs", "layers", { primary: true, onClick: segment }),
        ]));
        return;
      }
      const byStmt = new Map();
      try {
        const r = await API.listRequirementLinksForStatements(API.getToken(), statements.map((s) => s.id));
        for (const l of (r.links || [])) for (const side of ["from", "to"]) {
          const ep = l[side];
          if (ep && ep.type === "statement") { if (!byStmt.has(ep.id)) byStmt.set(ep.id, []); byStmt.get(ep.id).push({ link: l, other: side === "from" ? l.to : l.from }); }
        }
      } catch { /* links optional */ }
      const tools = el("div", { class: "rl-stmt-tools" }, [
        el("span", { class: "muted", style: "font-size:0.8rem" }, `${statements.length} paragraph${statements.length === 1 ? "" : "s"}`),
        actionBtn("Re-segment", "refresh", { onClick: () => { if (confirm("Re-splitting replaces the current paragraphs and removes any links attached to them. Continue?")) segment(); } }),
      ]);
      body.replaceChildren(tools, el("div", { class: "rl-stmt-list" }, statements.map((s) => docStatementRow(s, byStmt.get(s.id) || [], getStandards, load))));
    };
    node.addEventListener("toggle", () => { if (node.open && !loaded) { loaded = true; load(); } });
    return node;
  }

  function docStatementRow(s, entries, getStandards, reload) {
    const chips = entries.length ? el("div", { class: "rl-inline" }, entries.map(({ link, other }) => el("span", { class: "rl-inline-item" }, [
      rlTypeChip(link.link_type), el("span", { class: "rl-arrow", "aria-hidden": "true" }, "→"),
      el("span", { class: "rl-target" }, [el("strong", {}, (other && other.label) || "(removed)"), el("span", { class: "rl-kind" }, other && other.type === "document_version" ? "doc" : "clause")]),
      rlStatusChip(link.status),
      actionBtn("Unlink", "trash", { danger: true, onClick: async () => { if (!confirm("Remove this link?")) return; try { await API.deleteRequirementLink(API.getToken(), link.id); await reload(); } catch (ex) { alert(ex.message); } } }),
    ]))) : null;
    const form = el("div", { class: "rl-stmt-form" });
    const addBtn = actionBtn("Link to clause", "plus", { onClick: () => openStmtLinkForm(s, getStandards, reload, form, addBtn) });
    return el("div", { class: "rl-stmt" }, [
      el("div", { class: "rl-stmt-text" }, [el("span", { class: "rl-stmt-seq" }, `¶${(Number(s.seq) || 0) + 1}`), el("span", {}, s.text)]),
      chips,
      el("div", { class: "rl-stmt-actions" }, addBtn),
      form,
    ]);
  }

  async function openStmtLinkForm(s, getStandards, reload, mount, addBtn) {
    addBtn.disabled = true;
    mount.replaceChildren(el("div", { class: "loading" }, "Loading standards…"));
    let stdVers;
    try { stdVers = flattenStdVersions(await getStandards()); }
    catch (ex) { mount.replaceChildren(el("div", { class: "error" }, ex.message)); addBtn.disabled = false; return; }
    if (!stdVers.length) { mount.replaceChildren(el("div", { class: "muted" }, "No standards with clauses yet.")); addBtn.disabled = false; return; }
    const typeSel = el("select", { class: "up-text" }, RL_TYPES.map(([v, l]) => el("option", { value: v, selected: v === "implements" ? "selected" : null }, l)));
    const stdSel = el("select", { class: "up-text" }, stdVers.map((o) => el("option", { value: o.id }, o.label)));
    const clauseSel = el("select", { class: "up-text" }, [el("option", { value: "" }, "— select a clause —")]);
    const note = el("span", { class: "up-status" }, "");
    const loadC = async () => {
      clauseSel.replaceChildren(el("option", { value: "" }, "Loading…"));
      try { const r = await API.getClausesForStandard(API.getToken(), stdSel.value); const list = r.clauses || []; clauseSel.replaceChildren(el("option", { value: "" }, list.length ? "— select a clause —" : "No clauses"), ...list.map((c) => el("option", { value: c.id }, `${c.clause_ref}${c.clause_title ? " — " + c.clause_title : ""}`))); }
      catch { clauseSel.replaceChildren(el("option", { value: "" }, "Error")); }
    };
    stdSel.addEventListener("change", loadC);
    const doLink = actionBtn("Link", "plus", { primary: true, onClick: async () => {
      if (!clauseSel.value) { note.className = "up-status warn"; note.textContent = "Pick a clause."; return; }
      note.className = "up-status"; note.textContent = "Linking…";
      try { await API.createRequirementLink(API.getToken(), { fromType: "statement", fromId: s.id, toType: "clause", toId: clauseSel.value, linkType: typeSel.value, createdBy: (API.session() && API.session().name) || "rushroom" }); await reload(); }
      catch (ex) { note.className = "up-status err"; note.textContent = ex.message; }
    } });
    const cancel = actionBtn("Cancel", "collapse", { onClick: () => { mount.replaceChildren(); addBtn.disabled = false; } });
    mount.replaceChildren(
      el("div", { class: "rl-controls" }, [el("span", { class: "form-label" }, "Relationship"), typeSel, el("span", { class: "form-label" }, "Standard"), stdSel, el("span", { class: "form-label" }, "Clause"), clauseSel]),
      el("div", { style: "display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap" }, [doLink, cancel, note]),
    );
    loadC();
  }

  const rlSessionName = () => (API.session() && API.session().name) || "rushroom";

  // Endpoint label + kind tag (used in queue rows where neither side is fixed).
  const rlEndpoint = (ep) => el("span", { class: "rl-target" }, [
    el("strong", {}, (ep && ep.label) || "(removed)"),
    el("span", { class: "rl-kind" }, ep && ep.type === "document_version" ? "doc" : "clause"),
  ]);

  // One review-queue row: both endpoints shown, with Accept / Reject / Delete.
  function rlQueueRow(ctx, link, reload) {
    const note = el("span", { class: "up-status" }, "");
    const setStatus = async (s) => {
      note.className = "up-status"; note.textContent = "…";
      try { await API.setRequirementLinkStatus(ctx.token, link.id, s, rlSessionName()); await reload(); }
      catch (ex) { note.className = "up-status err"; note.textContent = ex.message; }
    };
    const del = async () => {
      if (!confirm("Delete this link? This cannot be undone.")) return;
      try { await API.deleteRequirementLink(ctx.token, link.id); await reload(); }
      catch (ex) { note.className = "up-status err"; note.textContent = ex.message; }
    };
    const conf = (typeof link.confidence === "number" && link.confidence < 1)
      ? el("span", { class: "rl-conf" }, `${Math.round(link.confidence * 100)}%`) : null;
    return el("div", { class: "rl-row" }, [
      el("div", { class: "rl-row-main" }, [
        rlEndpoint(link.from), rlTypeChip(link.link_type), el("span", { class: "rl-arrow", "aria-hidden": "true" }, "→"), rlEndpoint(link.to),
        rlStatusChip(link.status), el("span", { class: "rl-src" }, RL_SOURCE[link.source] || link.source || "manual"), conf,
      ]),
      link.rationale ? el("div", { class: "rl-rationale muted" }, link.rationale) : null,
      el("div", { class: "rl-row-actions" }, [
        actionBtn("Accept", "edit", { primary: true, onClick: () => setStatus("accepted") }),
        actionBtn("Reject", "trash", { onClick: () => setStatus("rejected") }),
        actionBtn("Delete", "trash", { danger: true, onClick: del }),
        note,
      ]),
    ]);
  }

  // Self-refreshing "needs review" panel: every proposed/flagged link, one screen.
  function rlQueuePanel(ctx) {
    const summary = el("summary", {}, "Review queue");
    const body = el("div", { class: "rl-queue-body" });
    const node = el("details", { class: "rl-queue" }, [summary, body]);
    const load = async () => {
      body.replaceChildren(el("div", { class: "loading" }, "Loading review queue…"));
      try {
        const r = await API.listRequirementLinksQueue(ctx.token, ["proposed", "flagged"]);
        const links = r.links || [];
        summary.replaceChildren(document.createTextNode(`Review queue (${links.length})`));
        body.replaceChildren(links.length
          ? el("div", { class: "rl-list" }, links.map((l) => rlQueueRow(ctx, l, load)))
          : el("div", { class: "muted", style: "font-size:0.85rem" }, "Nothing to review — no proposed or flagged links."));
      } catch (ex) { body.replaceChildren(el("div", { class: "error" }, ex.message)); }
    };
    load();
    return { node, reload: load };
  }

  // 4) Links — connect a standard clause to related clauses or As-Operated docs.
  function l2LinksView(ctx) {
    const wrap = el("div");
    const stdVers = flattenStdVersions(ctx.standards);
    const docVers = flattenDocVersions(ctx.documents);
    if (!stdVers.length) { wrap.appendChild(el("div", { class: "empty" }, "No standard versions yet — upload a standard and extract its clauses first.")); return wrap; }
    const queue = rlQueuePanel(ctx);

    const stdSel = el("select", { class: "up-text" }, stdVers.map((o) => {
      const opt = el("option", { value: o.id, "data-base-label": o.label }, `${o.label} [Checking...]`);
      return opt;
    }));
    const clauseSel = el("select", { class: "up-text" }, [el("option", { value: "" }, "— select a clause —")]);
    const status = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const panel = el("div", { style: "margin-top:0.8rem" });
    let clauses = [];

    // Show per-row extraction status directly in the standard dropdown labels.
    const setOptionProcessedState = (versionId, state, clauseCount) => {
      const opt = [...stdSel.options].find((o) => o.value === versionId);
      if (!opt) return;
      const base = opt.getAttribute("data-base-label") || opt.textContent || "";
      if (state === "processed") opt.textContent = `${base} [Processed${typeof clauseCount === "number" ? `: ${clauseCount}` : ""}]`;
      else if (state === "not_processed") opt.textContent = `${base} [Not processed]`;
      else if (state === "unknown") opt.textContent = `${base} [Status unavailable]`;
      else opt.textContent = `${base} [Checking...]`;
    };
    async function updateProcessedBadges() {
      const current = stdSel.value;
      stdVers.forEach((o) => setOptionProcessedState(o.id, "checking"));
      await Promise.all(stdVers.map(async (o) => {
        try {
          const r = await API.getClausesForStandard(ctx.token, o.id);
          const count = (r.clauses || []).length;
          setOptionProcessedState(o.id, count > 0 ? "processed" : "not_processed", count);
        } catch {
          setOptionProcessedState(o.id, "unknown");
        }
      }));
      stdSel.value = current;
    }

    const loadClauses = async () => {
      clauseSel.replaceChildren(el("option", { value: "" }, "Loading…"));
      panel.replaceChildren();
      try {
        const r = await API.getClausesForStandard(ctx.token, stdSel.value);
        clauses = r.clauses || [];
        clauseSel.replaceChildren(
          el("option", { value: "" }, clauses.length ? "— select a clause —" : "No clauses yet (extract them under “Clauses”)"),
          ...clauses.map((c) => el("option", { value: c.id }, `${c.clause_ref}${c.clause_title ? " — " + c.clause_title : ""}`)),
        );
      } catch (ex) { clauseSel.replaceChildren(el("option", { value: "" }, "Error")); status.className = "up-status err"; status.textContent = ex.message; }
    };
    const loadLinks = async () => {
      const clause = clauses.find((c) => c.id === clauseSel.value);
      if (!clause) { panel.replaceChildren(); return; }
      panel.replaceChildren(el("div", { class: "loading" }, "Loading links…"));
      try {
        const r = await API.listRequirementLinks(ctx.token, { entityType: "clause", entityId: clause.id });
        panel.replaceChildren(rlPanel(ctx, clause, r.links || [], reloadBoth, docVers, stdVers));
      } catch (ex) { panel.replaceChildren(el("div", { class: "error" }, ex.message)); }
    };
    // Per-clause actions also refresh the review queue so its count stays honest.
    const reloadBoth = async () => { await loadLinks(); await queue.reload(); };

    stdSel.addEventListener("change", loadClauses);
    clauseSel.addEventListener("change", loadLinks);
    wrap.append(
      el("p", { class: "muted", style: "margin:0 0 0.6rem" }, "Link a standard clause to related clauses in other standards or to As-Operated documents. Links are bidirectional — open either side and you’ll see the connection, with its type, source and review status."),
      queue.node,
      el("div", { class: "rl-controls" }, [
        el("span", { class: "form-label" }, "Standard"), stdSel,
        el("span", { class: "form-label" }, "Clause"), clauseSel,
      ]),
      status, panel,
    );
    updateProcessedBadges();
    loadClauses();
    return wrap;
  }

  // The per-clause link panel: the clause, its existing links, and an add form.
  function rlPanel(ctx, clause, links, reload, docVers, stdVers) {
    const box = el("div");
    box.append(el("div", { class: "rl-clause-head" }, [
      el("div", {}, [el("strong", {}, clause.clause_ref), clause.clause_title ? el("span", { class: "muted" }, ` — ${clause.clause_title}`) : null]),
      el("span", { class: "muted", style: "font-size:0.8rem" }, `${links.length} link${links.length === 1 ? "" : "s"}`),
    ]));
    if (clause.clause_text) box.append(el("details", { class: "l2-clause-req" }, [el("summary", {}, "Requirement text"), el("p", { class: "muted" }, clause.clause_text)]));

    // AI: suggest semantic links to clauses in other standards (proposals only).
    const aiNote = el("span", { class: "up-status" }, "");
    const suggest = actionBtn("Suggest links (AI)", "sparkles", { onClick: async () => {
      aiNote.className = "up-status"; aiNote.textContent = "Looking for related clauses in other standards…";
      try {
        const r = await API.suggestRequirementLinks(ctx.token, clause.id);
        aiNote.className = "up-status ok";
        const msg = r.created
          ? `Added ${r.created} suggestion${r.created === 1 ? "" : "s"} — review below. `
          : (r.candidates ? "No confident matches found. " : "No clauses from other standards to compare against yet. ");
        aiNote.replaceChildren(document.createTextNode(msg), usageChip(r.usage) || document.createTextNode(""));
        if (r.created) await reload();
      } catch (ex) { aiNote.className = "up-status err"; aiNote.textContent = ex.message; }
    } });
    box.append(el("div", { class: "rl-toolbar" }, [suggest, aiNote]));

    // Existing links
    if (!links.length) {
      box.append(el("div", { class: "rl-empty muted" }, "No links yet. Add one below."));
    } else {
      box.append(el("div", { class: "rl-list" }, links.map((l) => rlRow(ctx, clause, l, reload))));
    }
    box.append(rlAddForm(ctx, clause, reload, docVers, stdVers));
    return box;
  }

  // One existing-link row, showing the counterpart endpoint + controls.
  function rlRow(ctx, clause, link, reload) {
    // The endpoint that is NOT the current clause is the counterpart.
    const isFrom = link.from && link.from.type === "clause" && link.from.id === clause.id;
    const other = isFrom ? link.to : link.from;
    const note = el("span", { class: "up-status" }, "");
    const setStatus = async (s) => {
      note.className = "up-status"; note.textContent = "…";
      try { await API.setRequirementLinkStatus(ctx.token, link.id, s, (API.session() && API.session().name) || "rushroom"); await reload(); }
      catch (ex) { note.className = "up-status err"; note.textContent = ex.message; }
    };
    const del = async () => {
      if (!confirm("Delete this link? This cannot be undone.")) return;
      try { await API.deleteRequirementLink(ctx.token, link.id); await reload(); }
      catch (ex) { note.className = "up-status err"; note.textContent = ex.message; }
    };
    const controls = [];
    if (link.status === "proposed" || link.status === "flagged") {
      controls.push(actionBtn("Accept", "edit", { primary: true, onClick: () => setStatus("accepted") }));
      controls.push(actionBtn("Reject", "trash", { onClick: () => setStatus("rejected") }));
    }
    controls.push(actionBtn("Delete", "trash", { danger: true, onClick: del }));

    const conf = (typeof link.confidence === "number" && link.confidence < 1)
      ? el("span", { class: "rl-conf" }, `${Math.round(link.confidence * 100)}%`) : null;
    return el("div", { class: "rl-row" }, [
      el("div", { class: "rl-row-main" }, [
        rlTypeChip(link.link_type),
        el("span", { class: "rl-arrow", "aria-hidden": "true" }, "→"),
        el("span", { class: "rl-target" }, [
          el("strong", {}, other && other.label || "(removed)"),
          other && other.type === "document_version" ? el("span", { class: "rl-kind" }, "doc") : el("span", { class: "rl-kind" }, "clause"),
        ]),
        rlStatusChip(link.status),
        el("span", { class: "rl-src" }, RL_SOURCE[link.source] || link.source || "manual"),
        conf,
      ]),
      link.rationale ? el("div", { class: "rl-rationale muted" }, link.rationale) : null,
      el("div", { class: "rl-row-actions" }, [...controls, note]),
    ]);
  }

  // Add-link form: pick a target (another clause, or an As-Operated document) + type.
  function rlAddForm(ctx, clause, reload, docVers, stdVers) {
    const typeSel = el("select", { class: "up-text" }, RL_TYPES.map(([v, l]) => el("option", { value: v }, l)));
    const kindSel = el("select", { class: "up-text" }, [el("option", { value: "clause" }, "A clause"), el("option", { value: "document_version" }, "An As-Operated document")]);

    // Clause target: standard-version select + clause select (loads on change).
    const tStdSel = el("select", { class: "up-text" }, stdVers.map((o) => el("option", { value: o.id }, o.label)));
    const tClauseSel = el("select", { class: "up-text" }, [el("option", { value: "" }, "— select a clause —")]);
    const loadTargetClauses = async () => {
      tClauseSel.replaceChildren(el("option", { value: "" }, "Loading…"));
      try {
        const r = await API.getClausesForStandard(ctx.token, tStdSel.value);
        const list = (r.clauses || []).filter((c) => c.id !== clause.id);
        tClauseSel.replaceChildren(el("option", { value: "" }, list.length ? "— select a clause —" : "No other clauses"), ...list.map((c) => el("option", { value: c.id }, `${c.clause_ref}${c.clause_title ? " — " + c.clause_title : ""}`)));
      } catch { tClauseSel.replaceChildren(el("option", { value: "" }, "Error")); }
    };
    tStdSel.addEventListener("change", loadTargetClauses);
    const clausePicker = el("div", { class: "rl-controls" }, [el("span", { class: "form-label" }, "In"), tStdSel, tClauseSel]);

    // Document target: a document-version select.
    const docSel = el("select", { class: "up-text" }, [el("option", { value: "" }, "— select a document —"), ...docVers.map((o) => el("option", { value: o.id }, o.label))]);
    const docPicker = el("div", { class: "rl-controls", style: "display:none" }, [el("span", { class: "form-label" }, "Document"), docSel]);

    kindSel.addEventListener("change", () => {
      const clauseMode = kindSel.value === "clause";
      clausePicker.style.display = clauseMode ? "" : "none";
      docPicker.style.display = clauseMode ? "none" : "";
      if (clauseMode && !tClauseSel.value) loadTargetClauses();
    });

    const rationale = taField({ rows: "1", class: "up-text", placeholder: "Why are these linked? (optional)" }, "");
    const note = el("span", { class: "up-status" }, "");
    const add = actionBtn("Add link", "plus", { primary: true, onClick: async () => {
      const toType = kindSel.value;
      const toId = toType === "clause" ? tClauseSel.value : docSel.value;
      if (!toId) { note.className = "up-status warn"; note.textContent = "Pick a target first."; return; }
      note.className = "up-status"; note.textContent = "Adding…";
      try {
        await API.createRequirementLink(ctx.token, {
          fromType: "clause", fromId: clause.id, toType, toId, linkType: typeSel.value,
          rationale: rationale.value, createdBy: (API.session() && API.session().name) || "rushroom",
        });
        note.className = "up-status ok"; note.textContent = "Linked."; await reload();
      } catch (ex) { note.className = "up-status err"; note.textContent = ex.message; }
    } });

    loadTargetClauses();
    return el("details", { class: "rl-add card" }, [
      el("summary", {}, "＋ Add a link"),
      el("div", { class: "rl-controls" }, [el("span", { class: "form-label" }, "Relationship"), typeSel, el("span", { class: "form-label" }, "Link to"), kindSel]),
      clausePicker, docPicker,
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Rationale"), rationale]),
      el("div", { style: "display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap" }, [add, note]),
    ]);
  }

  // Editable interpretation card for one clause against one document version.
  function l2InterpCard(ctx, clause, interp, docVersionId, reload) {
    const text = taField({ rows: "2", class: "up-text", placeholder: "How the document implements this clause…" }, interp && interp.interpretation_text);
    const statusSel = el("select", { class: "up-text" }, L2_STATUS.map(([v, l]) => el("option", { value: v, selected: (interp && interp.compliance_status || "pending") === v ? "selected" : null }, l)));
    const rationale = taField({ rows: "1", class: "up-text", placeholder: "Rationale (optional)" }, interp && interp.rationale);
    const note = el("span", { class: "up-status" }, "");
    const genOne = actionBtn("Generate (AI)", "sparkles", { onClick: async () => {
      note.className = "up-status"; note.textContent = "AI interpreting…";
      try { await API.generateInterpretations(ctx.token, { documentVersionId: docVersionId, clauseIds: [clause.id] }); await reload(); }
      catch (ex) { note.className = "up-status err"; note.textContent = ex.message; }
    } });
    const save = actionBtn("Save", "edit", { primary: true, onClick: async () => {
      if (!interp || !interp.id) { note.className = "up-status warn"; note.textContent = "Generate first (creates the record), then edit."; return; }
      note.className = "up-status"; note.textContent = "Saving…";
      try { await API.saveInterpretation(ctx.token, interp.id, { interpretationText: text.value, complianceStatus: statusSel.value, rationale: rationale.value, reviewedBy: (API.session() && API.session().name) || "rushroom" }); note.className = "up-status ok"; note.textContent = "Saved."; }
      catch (ex) { note.className = "up-status err"; note.textContent = ex.message; }
    } });
    return el("div", { class: "card l2-interp" }, [
      el("div", { class: "l2-interp-head" }, [
        el("div", {}, [el("strong", {}, clause.clause_ref), clause.clause_title ? el("span", { class: "muted" }, ` — ${clause.clause_title}`) : null]),
        interp ? l2StatusChip(interp.compliance_status) : el("span", { class: "muted", style: "font-size:0.8rem" }, "no interpretation yet"),
      ]),
      clause.clause_text ? el("details", { class: "l2-clause-req" }, [el("summary", {}, "Requirement text"), el("p", { class: "muted" }, clause.clause_text)]) : null,
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Interpretation"), text]),
      (interp && interp.previous_interpretation_text && interp.previous_interpretation_text !== interp.interpretation_text)
        ? el("details", { class: "l2-clause-req" }, [el("summary", {}, "Changes since previous version"), diffInline(interp.previous_interpretation_text, interp.interpretation_text || "")])
        : null,
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Rationale"), rationale]),
      el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center" }, [el("span", { class: "form-label" }, "Status"), statusSel, interp && interp.id ? save : genOne, note]),
      interp && interp.reviewed_by ? el("div", { class: "muted", style: "font-size:0.8rem; margin-top:0.3rem" }, `Reviewed by ${interp.reviewed_by}${interp.reviewed_at ? " · " + fmtDate(interp.reviewed_at) : ""}${interp.ai_generated ? " · AI-drafted" : ""}`) : null,
    ]);
  }

  // 2) Interpretations — a document version × a standard's clauses.
  function l2InterpretationsView(ctx) {
    const wrap = el("div");
    const docVers = flattenDocVersions(ctx.documents);
    const stdVers = flattenStdVersions(ctx.standards);
    if (!docVers.length || !stdVers.length) { wrap.appendChild(el("div", { class: "empty" }, "Need at least one document version and one standard version. Add them in the As Operated and Standards tabs.")); return wrap; }
    const docSel = el("select", { class: "up-text" }, docVers.map((o) => el("option", { value: o.id }, o.label)));
    const stdSel = el("select", { class: "up-text" }, stdVers.map((o) => el("option", { value: o.id }, o.label)));
    const out = el("div", { style: "margin-top:0.8rem" });
    const status = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    let clauses = [];
    const load = async () => {
      out.replaceChildren(el("div", { class: "loading" }, "Loading…"));
      try {
        const [cRes, iRes] = await Promise.all([API.getClausesForStandard(ctx.token, stdSel.value), API.getInterpretations(ctx.token, docSel.value)]);
        clauses = cRes.clauses || [];
        const interps = {}; for (const i of (iRes.interpretations || [])) interps[i.clause_id] = i;
        if (!clauses.length) { out.replaceChildren(el("div", { class: "empty" }, "This standard has no clauses yet — extract them in the Clauses tab first.")); return; }
        out.replaceChildren(...clauses.map((c) => l2InterpCard(ctx, c, interps[c.id], docSel.value, load)));
      } catch (ex) { out.replaceChildren(el("div", { class: "error" }, ex.message)); }
    };
    const gen = actionBtn("Generate all (AI)", "sparkles", { primary: true, onClick: async () => {
      if (!clauses.length) { status.className = "up-status warn"; status.textContent = "Extract clauses for this standard first."; return; }
      status.className = "up-status"; status.textContent = "AI is interpreting the document against each clause — this can take a minute…";
      try { const r = await API.generateInterpretations(ctx.token, { documentVersionId: docSel.value, clauseIds: clauses.map((c) => c.id) }); status.className = "up-status ok"; status.replaceChildren(document.createTextNode(`Generated ${r.generated} interpretation(s). `), usageChip(r.usage) || document.createTextNode("")); await load(); }
      catch (ex) { status.className = "up-status err"; status.textContent = ex.message; }
    } });
    docSel.addEventListener("change", load); stdSel.addEventListener("change", load);
    wrap.append(
      el("p", { class: "muted", style: "margin:0 0 0.6rem" }, "Interpret how a document version implements each clause of a standard. Generate a first pass with AI, then review and edit each one."),
      el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center" }, [el("span", { class: "form-label" }, "Document"), docSel, el("span", { class: "form-label" }, "Standard"), stdSel, gen]),
      status, out,
    );
    load();
    return wrap;
  }

  // Edit a single matrix cell (fetches/creates the interpretation on demand).
  async function l2EditCell(ctx, clause, docVer, reload) {
    const body = el("div", { class: "step-form" }, el("div", { class: "loading" }, "Loading…"));
    const close = openModal(`${clause.clause_ref} × ${docVer.document && docVer.document.name || "document"}`, body);
    let interp = null;
    try { const r = await API.getInterpretations(ctx.token, docVer.id); interp = (r.interpretations || []).find((i) => i.clause_id === clause.id) || null; } catch { /* ignore */ }
    const card = l2InterpCard(ctx, clause, interp, docVer.id, async () => { close(); await reload(); });
    body.replaceChildren(card);
  }

  // 3) Compliance matrix — documents × clauses.
  function l2MatrixView(ctx) {
    const wrap = el("div");
    const docVers = flattenDocVersions(ctx.documents);
    const stdVers = flattenStdVersions(ctx.standards);
    if (!docVers.length || !stdVers.length) { wrap.appendChild(el("div", { class: "empty" }, "Need at least one document version and one standard version.")); return wrap; }
    const docSel = el("select", { class: "up-text", multiple: "multiple", size: String(Math.min(6, Math.max(3, docVers.length))) }, docVers.map((o) => el("option", { value: o.id }, o.label)));
    const stdSel = el("select", { class: "up-text", multiple: "multiple", size: String(Math.min(6, Math.max(3, stdVers.length))) }, stdVers.map((o) => el("option", { value: o.id }, o.label)));
    const out = el("div", { style: "margin-top:0.8rem" });
    const build = async () => {
      const docIds = [...docSel.selectedOptions].map((o) => o.value);
      const stdIds = [...stdSel.selectedOptions].map((o) => o.value);
      if (!docIds.length || !stdIds.length) { out.replaceChildren(el("div", { class: "empty" }, "Select at least one document and one standard, then Build matrix.")); return; }
      out.replaceChildren(el("div", { class: "loading" }, "Building matrix…"));
      try { const m = await API.complianceMatrix(ctx.token, { documentVersionIds: docIds, standardVersionIds: stdIds }); l2RenderMatrix(ctx, m, out, build); }
      catch (ex) { out.replaceChildren(el("div", { class: "error" }, ex.message)); }
    };
    wrap.append(
      el("p", { class: "muted", style: "margin:0 0 0.6rem" }, "Cross-reference document versions against standard clauses. Each cell shows the compliance status; click a cell to view or edit its interpretation. (Ctrl/Cmd-click to select several.)"),
      el("div", { style: "display:flex; gap:1rem; flex-wrap:wrap; align-items:flex-start" }, [
        el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Documents"), docSel]),
        el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Standards"), stdSel]),
        actionBtn("Build matrix", "layers", { primary: true, onClick: build }),
      ]),
      out,
    );
    return wrap;
  }
  function l2RenderMatrix(ctx, m, mount, reload) {
    const docs = m.docs || [], clauses = m.clauses || [], cells = m.matrix || [];
    if (!docs.length || !clauses.length) { mount.replaceChildren(el("div", { class: "empty" }, "No data — the selected standards have no extracted clauses yet (extract them in the Clauses tab).")); return; }
    const cellOf = (cid, did) => cells.find((x) => x.clause_id === cid && x.document_version_id === did);
    const head = el("tr", {}, [el("th", { class: "l2-mx-corner" }, "Clause"), ...docs.map((d) => el("th", { class: "l2-mx-doc" }, `${d.document && d.document.name || "doc"}${d.version ? " " + d.version : ""}`))]);
    const rows = clauses.map((c) => el("tr", {}, [
      el("th", { class: "l2-mx-clause", title: c.clause_title || "" }, c.clause_ref),
      ...docs.map((d) => {
        const st = (cellOf(c.id, d.id) || {}).status || "none";
        return el("td", { class: `l2-cell l2-${st}`, title: `${c.clause_ref} × ${d.document && d.document.name || ""}: ${l2StatusLabel(st) || "none"}`, onclick: () => l2EditCell(ctx, c, d, reload) }, l2CellGlyph[st] || "");
      }),
    ]));
    const legend = el("div", { class: "l2-legend" }, [...L2_STATUS, ["none", "No interpretation"]].map(([v, l]) => el("span", { class: "l2-legend-item" }, [el("span", { class: `l2-swatch l2-${v}` }), " " + l])));
    mount.replaceChildren(el("div", {}, [legend, el("div", { style: "overflow:auto; margin-top:0.5rem" }, el("table", { class: "l2-matrix" }, [el("thead", {}, head), el("tbody", {}, rows)]))]));
  }

  // 4) Passports — DPP records: create, link interpretations, export JSON-LD.
  function l2PassportsView(ctx) {
    const wrap = el("div");
    const list = el("div", { style: "margin-top:0.6rem" });
    const reload = async () => {
      list.replaceChildren(el("div", { class: "loading" }, "Loading passports…"));
      try {
        const { passports } = await API.listProductPassports(ctx.token);
        if (!passports.length) { list.replaceChildren(el("div", { class: "empty" }, "No passports yet. Create one above.")); return; }
        list.replaceChildren(...passports.map((p) => l2PassportRow(ctx, p, reload)));
      } catch (ex) { list.replaceChildren(el("div", { class: "error" }, ex.message)); }
    };
    wrap.append(
      el("p", { class: "muted", style: "margin:0 0 0.6rem" }, "EU Digital Product Passport (DPP) records. Create a passport, link the compliance interpretations that back it, and export as JSON-LD (schema.org + ESPR) for ESPR 2027 readiness."),
      actionBtn("New passport", "plus", { primary: true, onClick: () => l2PassportEditor(ctx, null, reload) }),
      list,
    );
    reload();
    return wrap;
  }
  function l2PassportRow(ctx, p, reload) {
    const note = el("span", { class: "up-status" }, "");
    const doExport = async (format) => {
      note.className = "up-status"; note.textContent = "Exporting…";
      try {
        const r = await API.exportProductPassport(ctx.token, { passportId: p.id, format });
        const fname = `${(p.product_name || "passport").replace(/[^a-z0-9._-]+/gi, "_")}.${format === "json-ld" ? "jsonld" : "json"}`;
        downloadBlob(JSON.stringify(r.data || r, null, 2), fname, "application/json");
        note.className = "up-status ok"; note.textContent = `Exported ${format}.`;
      } catch (ex) { note.className = "up-status err"; note.textContent = ex.message; }
    };
    return el("div", { class: "card l2-passport" }, [
      el("div", { class: "acct-head" }, [
        el("div", {}, [el("strong", {}, p.product_name), el("div", { class: "muted", style: "font-size:0.85rem" }, `${p.product_model ? p.product_model + " · " : ""}${p.manufacturer || ""}${p.gtin ? " · GTIN " + p.gtin : ""}`)]),
        el("span", { class: `acct-badge acct-${p.passport_status === "active" ? "approved" : p.passport_status === "superseded" ? "disabled" : "pending"}` }, p.passport_status || "draft"),
      ]),
      el("div", { class: "muted", style: "font-size:0.85rem; margin-top:0.2rem" }, `${p.link_count || 0} linked interpretation${p.link_count === 1 ? "" : "s"}`),
      el("div", { style: "display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; margin-top:0.6rem" }, [
        actionBtn("Open", "edit", { onClick: () => l2PassportEditor(ctx, p, reload) }),
        actionBtn("Export JSON-LD", "external", { onClick: () => doExport("json-ld") }),
        actionBtn("Export JSON", "external", { onClick: () => doExport("json") }),
        actionBtn("Delete", "trash", { danger: true, onClick: async () => { if (confirm(`Delete passport “${p.product_name}”?`)) { try { await API.deleteProductPassport(ctx.token, p.id); await reload(); } catch (ex) { note.className = "up-status err"; note.textContent = ex.message; } } } }),
        note,
      ]),
    ]);
  }
  function l2PassportEditor(ctx, passport, reloadList) {
    const f = passport || {};
    const productName = el("input", { type: "text", class: "up-text", placeholder: "Product name", value: f.product_name || "" });
    const productModel = el("input", { type: "text", class: "up-text", placeholder: "Model (optional)", value: f.product_model || "" });
    const manufacturer = el("input", { type: "text", class: "up-text", placeholder: "Manufacturer", value: f.manufacturer || "Rushroom AB" });
    const gtin = el("input", { type: "text", class: "up-text", placeholder: "GTIN (optional)", value: f.gtin || "" });
    const docRef = el("input", { type: "text", class: "up-text", placeholder: "Declaration of Conformity ref (optional)", value: f.declaration_of_conformity_ref || "" });
    const statusSel = el("select", { class: "up-text" }, ["draft", "active", "superseded"].map((s) => el("option", { value: s, selected: (f.passport_status || "draft") === s ? "selected" : null }, s)));
    const note = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
    const linksBox = el("div", { class: "l2-links", style: "margin-top:0.6rem" });

    const body = el("div", { class: "step-form" }, [
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Product"), productName]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Model"), productModel]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Manufacturer"), manufacturer]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "GTIN"), gtin]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "DoC ref"), docRef]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Status"), statusSel]),
      el("div", { style: "margin-top:0.5rem" }, actionBtn(passport ? "Save passport" : "Create passport", "edit", { primary: true, cls: "l2-save-passport" })),
      note,
      passport ? el("h4", { style: "margin:1rem 0 0.3rem" }, "Linked interpretations") : null,
      passport ? linksBox : null,
    ].filter(Boolean));
    const close = openModal(passport ? `Passport — ${f.product_name}` : "New product passport", body);
    body.querySelector(".l2-save-passport").addEventListener("click", async () => {
      if (!productName.value.trim()) { note.className = "up-status warn"; note.textContent = "Product name is required."; return; }
      const fields = { productName: productName.value.trim(), productModel: productModel.value.trim(), manufacturer: manufacturer.value.trim(), gtin: gtin.value.trim(), declarationOfConformityRef: docRef.value.trim(), passportStatus: statusSel.value };
      note.className = "up-status"; note.textContent = "Saving…";
      try {
        if (passport) { await API.updateProductPassport(ctx.token, passport.id, fields); note.className = "up-status ok"; note.textContent = "Saved."; }
        else { await API.createProductPassport(ctx.token, fields); close(); }
        await reloadList();
      } catch (ex) { note.className = "up-status err"; note.textContent = ex.message; }
    });
    if (passport) l2LoadPassportLinks(ctx, passport, linksBox);
    return close;
  }
  async function l2LoadPassportLinks(ctx, passport, box) {
    box.replaceChildren(el("div", { class: "loading" }, "Loading links…"));
    let links = [];
    try { const r = await API.getProductPassport(ctx.token, passport.id); links = r.links || []; } catch (ex) { box.replaceChildren(el("div", { class: "error" }, ex.message)); return; }
    const reload = () => l2LoadPassportLinks(ctx, passport, box);
    const linked = el("div", {}, links.length ? links.map((l) => {
      const i = l.interpretation || {}; const c = i.clause || {};
      return el("div", { class: "l2-link-row" }, [
        el("span", {}, [el("strong", {}, c.clause_ref || "?"), c.clause_title ? el("span", { class: "muted" }, ` — ${c.clause_title}`) : null, " ", l2StatusChip(i.compliance_status)]),
        actionBtn("Unlink", "trash", { danger: true, onClick: async () => { try { await API.unlinkPassportInterpretation(ctx.token, { passportId: passport.id, interpretationId: i.id }); await reload(); } catch (ex) { alert(ex.message); } } }),
      ]);
    }) : [el("div", { class: "muted", style: "font-size:0.85rem" }, "Nothing linked yet.")]);

    // Add-links: pick a document version, list its interpretations, link them.
    const docVers = flattenDocVersions(ctx.documents);
    const docSel = el("select", { class: "up-text" }, [el("option", { value: "" }, "— pick a document to link its interpretations —"), ...docVers.map((o) => el("option", { value: o.id }, o.label))]);
    const pickList = el("div", { style: "margin-top:0.4rem" });
    const linkedIds = new Set(links.map((l) => l.interpretation && l.interpretation.id));
    docSel.addEventListener("change", async () => {
      if (!docSel.value) { pickList.replaceChildren(); return; }
      pickList.replaceChildren(el("div", { class: "loading" }, "Loading…"));
      try {
        const r = await API.getInterpretations(ctx.token, docSel.value);
        const avail = (r.interpretations || []).filter((i) => !linkedIds.has(i.id));
        pickList.replaceChildren(...(avail.length ? avail.map((i) => el("div", { class: "l2-link-row" }, [
          el("span", {}, [el("strong", {}, i.clause && i.clause.clause_ref || "?"), " ", l2StatusChip(i.compliance_status)]),
          actionBtn("Link", "plus", { onClick: async () => { try { await API.linkPassportInterpretation(ctx.token, { passportId: passport.id, interpretationId: i.id }); await reload(); } catch (ex) { alert(ex.message); } } }),
        ])) : [el("div", { class: "muted", style: "font-size:0.85rem" }, "No unlinked interpretations for this document.")]));
      } catch (ex) { pickList.replaceChildren(el("div", { class: "error" }, ex.message)); }
    });
    box.replaceChildren(linked, el("div", { style: "margin-top:0.6rem" }, [el("span", { class: "form-label" }, "Add from document"), docSel, pickList]));
  }

  async function renderLevel2(role, mount) {
    mount.replaceChildren(el("div", { class: "loading" }, "Loading Level 2…"));
    let standards = [], documents = [];
    try {
      const [s, d] = await Promise.all([API.standards(API.getToken()), API.data(API.getToken())]);
      standards = s.standards || []; documents = d.documents || [];
    } catch (ex) { mount.replaceChildren(el("div", { class: "error" }, `Couldn't load: ${ex.message}`)); return; }
    const ctx = { role, token: API.getToken(), standards, documents };
    mount.replaceChildren(subTabs("level2", [
      { id: "clauses", label: "Clauses", icon: "layers", build: () => l2ClausesView(ctx) },
      { id: "interp", label: "Interpretations", icon: "edit", build: () => l2InterpretationsView(ctx) },
      { id: "matrix", label: "Matrix", icon: "expand", build: () => l2MatrixView(ctx) },
      { id: "links", label: "Links", icon: "graph", build: () => l2LinksView(ctx) },
      { id: "passports", label: "Passports", icon: "sparkles", build: () => l2PassportsView(ctx) },
    ]));
  }

  // ============================================================================
  // PROP-013 · Product Information System — Vertical Integration Engine
  // Two sub-tabs: BOM Tree · Status Overview (Cost Canvas removed PROP-019)
  // ============================================================================

  // --- colour tokens that mirror the compliance portal step statuses ----------
  const LIFECYCLE_COLORS = {
    active: "#2fa564", inactive: "#8b93a1", replaced: "#e5a326", flagged: "#e05454",
  };
  const MATURITY_COLORS = {
    estimate: "#e5a326", budgetary_quote: "#4a9eed", firm_quote: "#2bb5a0",
    contracted: "#2fa564", actual: "#1a8a50",
  };
  const MATURITY_LABELS = {
    estimate: "Estimate", budgetary_quote: "Budgetary quote", firm_quote: "Firm quote",
    contracted: "Contracted", actual: "Actual",
  };

  function lifecycleBadge(status) {
    const color = LIFECYCLE_COLORS[status] || "#8b93a1";
    return el("span", { class: "status-badge", style: `background:${color}20;color:${color};border:1px solid ${color}60;padding:1px 7px;border-radius:99px;font-size:0.75rem;white-space:nowrap` }, status || "—");
  }
  function maturityBadge(maturity) {
    const color = MATURITY_COLORS[maturity] || "#8b93a1";
    const label = MATURITY_LABELS[maturity] || maturity || "—";
    return el("span", { class: "status-badge", style: `background:${color}20;color:${color};border:1px solid ${color}60;padding:1px 7px;border-radius:99px;font-size:0.75rem;white-space:nowrap` }, label);
  }

  // --- BOM tree view ---------------------------------------------------------
  // component_id → number of OTHER parent assemblies (entries with count > 1 only).
  // Module-scoped on purpose: bomTreeView fills it, but openAddChildModal — a
  // sibling function, not a nested one — reads it to warn about shared edits.
  let parentCountMap = {};

  // PROP-038 — part categories, module-scoped for the same reason as
  // parentCountMap: the create modals are sibling functions, not nested ones.
  let partCategories = [];
  // Set by bomTreeView so the detail panel — a sibling function, not a nested
  // one — can refresh the list behind it after an edit that changes a list row
  // (name, part no., type, status, category, sourcing). Without this the row
  // and the category chip counts stay stale until Refresh is pressed by hand.
  let refreshBomList = null;

  // Exactly one image-paste listener may be live, and it must belong to the
  // component currently on screen. A per-panel slot (panel.__imgPasteOff) held
  // only the most recent unregister function, so a second registration orphaned
  // the first: one Cmd+V then uploaded the same image to two different
  // components. Observed 2026-09-15 — a screw photo landed on "Adjustable Legs"
  // three seconds before landing on "Confirmat Screw".
  let activeImgPasteOff = null;
  let openDetailComponentId = null;
  const categoryNameOf = (id) => (partCategories.find((c) => c.id === id) || {}).name || null;

  async function bomTreeView(token, role) {
    const wrap = el("div", { class: "pis-tree-wrap" });
    const detailPanel = el("div", { class: "pis-detail-panel", style: "display:none;margin-top:1rem;padding:1rem;background:var(--bg-2,#f5f5f5);border-radius:6px" });

    const TAB_DEFS = [
      { id: "components", label: "Parts" },
      { id: "assemblies", label: "Assemblies" },
      { id: "dynamic",    label: "Dynamic BOMs" },
    ];

    let activeTab = "components";
    let activeCategory = "all";   // "all" | "none" | <category_id>
    let allComponents = [];
    let thumbMap = {}; // component_id → signed thumbnail URL
    let searchQuery = "";
    const PAGE_SIZE = 50;
    const tabPageShown = { components: PAGE_SIZE, assemblies: PAGE_SIZE, dynamic: PAGE_SIZE };
    const expandedTrees = {}; // compId → bom | "loading" | "error"

    // Shared hover-preview tooltip — appended to body to avoid stacking-context issues
    // (position:fixed breaks inside any ancestor with transform/filter)
    document.getElementById("bom-thumb-tooltip")?.remove();
    const tooltipImg = el("img", { style: "width:200px;height:200px;object-fit:cover;display:block" });
    const imgTooltip = el("div", {
      id: "bom-thumb-tooltip",
      style: "position:fixed;z-index:9999;display:none;pointer-events:none;border-radius:8px;overflow:hidden;box-shadow:0 6px 28px #0004;border:1px solid var(--border,#e2e8f0)",
    }, tooltipImg);
    document.body.append(imgTooltip);

    const tabBarEl = el("div", { style: "display:flex;gap:0;margin-top:0.75rem;border-bottom:2px solid var(--border,#e2e8f0)" });
    // Second level, Parts only: click a category instead of typing in search.
    const catBarEl = el("div", { style: "display:none;flex-wrap:wrap;gap:0.35rem;margin-top:0.6rem" });
    const treeArea  = el("div", { class: "pis-tree-area", style: "margin-top:0.75rem" });

    let searchTimer = null;
    const searchInp = el("input", { type: "search", placeholder: "Search by name or part number…", class: "up-text",
      style: "flex:1;min-width:140px;max-width:280px",
      oninput: () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          searchQuery = searchInp.value.trim().toLowerCase();
          tabPageShown.components = tabPageShown.assemblies = tabPageShown.dynamic = PAGE_SIZE;
          renderAll();
        }, 250);
      },
    });

    wrap.replaceChildren(
      el("div", { class: "pis-toolbar", style: "display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap" }, [
        el("button", { class: "btn btn-primary btn-sm", type: "button", onclick: () => openAddComponent(token, (id, type) => { activeTab = type === "sub_assembly" ? "assemblies" : "components"; refreshTree(); }) }, "+ New BOM Node"),
        el("button", { class: "btn btn-sm", type: "button", onclick: () => refreshTree() }, "↺ Refresh"),
        searchInp,
      ]),
      tabBarEl,
      catBarEl,
      treeArea,
      detailPanel,
    );

    function groupFiltered() {
      const q = searchQuery;
      const filtered = q
        ? allComponents.filter((c) => (c.name || "").toLowerCase().includes(q) || (c.part_number || "").toLowerCase().includes(q))
        : allComponents;
      const grouped = { components: [], assemblies: [], dynamic: [] };
      filtered.forEach((c) => {
        if (c.type === "product_family") grouped.dynamic.push(c);
        else if (c.type === "sub_assembly") grouped.assemblies.push(c);
        else grouped.components.push(c);
      });
      return grouped;
    }

    function renderAll() {
      const grouped = groupFiltered();
      // Tab bar
      tabBarEl.replaceChildren(...TAB_DEFS.map((td) => {
        const count = (grouped[td.id] || []).length;
        const active = activeTab === td.id;
        return el("button", {
          type: "button",
          style: `padding:0.35rem 1rem;font-size:0.8125rem;font-weight:600;border:none;background:transparent;cursor:pointer;color:${active ? "var(--accent,#2fa564)" : "var(--muted,#888)"};border-bottom:${active ? "2px solid var(--accent,#2fa564)" : "2px solid transparent"};margin-bottom:-2px`,
          onclick: () => { activeTab = td.id; renderAll(); },
        }, `${td.label} (${count})`);
      }));
      // Category chips — Parts only. Counts come from the unfiltered Parts group,
      // so a chip always shows how many it would reveal, not how many are showing.
      if (activeTab !== "components") {
        catBarEl.style.display = "none";
        catBarEl.replaceChildren();
      } else {
        catBarEl.style.display = "flex";
        const parts = grouped.components || [];
        const countFor = (id) => id === "all" ? parts.length
          : id === "none" ? parts.filter((c) => !c.category_id).length
          : parts.filter((c) => c.category_id === id).length;
        const chip = (id, label) => {
          const count = countFor(id);
          const active = activeCategory === id;
          return el("button", {
            type: "button",
            style: `padding:0.28rem 0.7rem;font-size:0.78rem;font-weight:600;border-radius:999px;cursor:pointer;white-space:nowrap;`
              + (active
                ? "background:var(--accent,#2fa564);color:#fff;border:1px solid var(--accent,#2fa564)"
                : `background:transparent;color:var(--muted,#8b93a1);border:1px solid var(--border,#e2e8f0)${count ? "" : ";opacity:0.45"}`),
            onclick: () => { activeCategory = id; tabPageShown.components = PAGE_SIZE; renderAll(); },
          }, `${label} (${count})`);
        };
        const chips = [chip("all", "All")];
        partCategories.forEach((c) => chips.push(chip(c.id, c.name)));
        // Only offered when there is a backlog — a category is required on create,
        // so this exists for pre-PROP-038 rows and should disappear once cleared.
        if (countFor("none")) chips.push(chip("none", "Uncategorised"));
        chips.push(el("button", {
          type: "button", title: "Add, rename, reorder or delete categories",
          style: "padding:0.28rem 0.6rem;font-size:0.78rem;border-radius:999px;cursor:pointer;background:transparent;color:var(--muted,#8b93a1);border:1px dashed var(--border,#e2e8f0)",
          onclick: () => openCategoryManager(token, refreshTree),
        }, "⚙ Categories"));
        catBarEl.replaceChildren(...chips);
      }

      // List
      treeArea.replaceChildren();
      let items = grouped[activeTab] || [];
      if (activeTab === "components" && activeCategory !== "all") {
        items = items.filter((c) => activeCategory === "none" ? !c.category_id : c.category_id === activeCategory);
      }
      if (!items.length) {
        const labels = { components: "parts", assemblies: "assemblies", dynamic: "dynamic BOMs" };
        const catName = activeTab === "components" && activeCategory !== "all"
          ? (activeCategory === "none" ? "Uncategorised" : categoryNameOf(activeCategory)) : null;
        const where = catName ? ` in ${catName}` : "";
        treeArea.append(el("div", { class: "notice", style: "margin-top:1rem" },
          searchQuery ? `No ${labels[activeTab]}${where} match "${searchQuery}".`
            : catName ? `No ${labels[activeTab]} in ${catName} yet.`
            : `No ${labels[activeTab]} yet. Use + New BOM Node to create one.`));
        return;
      }
      const shown = Math.min(tabPageShown[activeTab], items.length);
      const allowExpand = activeTab !== "components";
      items.slice(0, shown).forEach((comp) => treeArea.append(renderRootRow(comp, allowExpand)));
      if (items.length > shown) {
        const remaining = items.length - shown;
        treeArea.append(el("div", { style: "text-align:center;padding:0.75rem" },
          el("button", { class: "btn btn-sm", type: "button", onclick: () => { tabPageShown[activeTab] += PAGE_SIZE; renderAll(); } },
            `Load ${Math.min(remaining, PAGE_SIZE)} more (${remaining} remaining)`)));
      }
    }

    function renderRootRow(comp, allowExpand = false) {
      const STATUS_COLOR = { active: "#2fa564", inactive: "#8b93a1", replaced: "#e5a326", flagged: "#e05454" };
      const TYPE_COLOR   = { part: "#2fa564", raw_material: "#8b93a1", sub_assembly: "#4a9eed", finished_good: "#a855f7", spare_part: "#f59e0b", product_family: "#e05454" };
      const sfg = STATUS_COLOR[comp.lifecycle_status] || "#888";
      const tfg = TYPE_COLOR[comp.type] || "#888";

      const container = el("div", { style: "border:1px solid var(--border,#e2e8f0);border-radius:6px;margin-bottom:0.4rem;overflow:hidden" });
      const treeDiv   = el("div", { style: "display:none;padding:0 0.6rem 0.6rem;border-top:1px solid var(--border,#e2e8f0)" });

      function rebuildTreeDiv() {
        const state = expandedTrees[comp.id];
        if (!state || state === "loading") {
          treeDiv.replaceChildren(el("div", { class: "loading", style: "font-size:0.8rem;padding:0.4rem" }, "Loading tree…"));
        } else if (state === "error") {
          treeDiv.replaceChildren(el("div", { class: "error", style: "font-size:0.8rem;padding:0.4rem" }, "Failed to load tree."));
        } else {
          treeDiv.replaceChildren();
          renderBomTree(comp.id, state, treeDiv, detailPanel, token, allComponents, refreshTree, role);
        }
        treeDiv.style.display = "";
      }

      const expandBtn = allowExpand && comp.has_children ? el("button", {
        type: "button", title: "Expand",
        style: "background:none;border:none;cursor:pointer;padding:0 4px;font-size:0.75rem;color:var(--accent,#2fa564);transition:transform 0.15s;flex-shrink:0",
        onclick: async (ev) => {
          ev.stopPropagation();
          const open = treeDiv.style.display !== "none";
          if (open) {
            treeDiv.style.display = "none";
            ev.currentTarget.style.transform = "rotate(0deg)";
            ev.currentTarget.title = "Expand";
          } else {
            ev.currentTarget.style.transform = "rotate(90deg)";
            ev.currentTarget.title = "Collapse";
            if (!expandedTrees[comp.id]) {
              expandedTrees[comp.id] = "loading";
              rebuildTreeDiv();
              try {
                expandedTrees[comp.id] = await API.post(token, "getBom", { root_component_id: comp.id, max_depth: 10 });
              } catch { expandedTrees[comp.id] = "error"; }
            }
            rebuildTreeDiv();
          }
        },
      }, "▶") : el("span", { style: "width:20px;display:inline-block;flex-shrink:0" }, "");

      // Restore expanded state across re-renders (only when expand is allowed — Parts tab is always flat)
      if (allowExpand && expandedTrees[comp.id] && expandedTrees[comp.id] !== "loading") {
        expandBtn.style && (expandBtn.style.transform = "rotate(90deg)");
        if (expandBtn.title !== undefined) expandBtn.title = "Collapse";
        rebuildTreeDiv();
      }

      // Inline thumbnail (if component has an image)
      const thumbUrl = thumbMap[comp.id];
      const thumbEl = thumbUrl ? el("img", {
        src: thumbUrl,
        style: "width:36px;height:36px;object-fit:cover;border-radius:4px;border:1px solid var(--border,#e2e8f0);flex-shrink:0;cursor:zoom-in",
        onclick: async (ev) => {
          ev.stopPropagation();
          imgTooltip.style.display = "none";
          // Fetch all images for this component; fall back to the thumbnail if the request fails
          let imgs = [{ url: thumbUrl }];
          try {
            const r = await API.post(token, "listComponentImages", { component_id: comp.id });
            if (r.images && r.images.length) imgs = r.images;
          } catch { /* use thumbnail fallback */ }
          // Multi-image lightbox — same behaviour as detail panel
          let idx = 0;
          const multi = imgs.length > 1;
          const lbImg = el("img", { style: "max-width:min(90vw,860px);max-height:82vh;border-radius:6px;box-shadow:0 4px 32px #0008;display:block;object-fit:contain", onclick: (e) => e.stopPropagation() });
          const lbCount = el("div", { style: "color:rgba(255,255,255,0.6);font-size:0.78rem;margin-top:0.5rem;text-align:center;min-height:1.1em" });
          function lbShow(i) {
            idx = ((i % imgs.length) + imgs.length) % imgs.length;
            lbImg.src = imgs[idx].url;
            lbCount.textContent = multi ? `${idx + 1} / ${imgs.length}` : "";
          }
          const navStyle = "background:#fff2;border:1px solid #fff3;border-radius:50%;width:42px;height:42px;color:#fff;font-size:1.4rem;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1;padding:0";
          const lbPrev = multi ? el("button", { type: "button", style: navStyle, title: "Previous (←)", onclick: (e) => { e.stopPropagation(); lbShow(idx - 1); } }, "‹") : null;
          const lbNext = multi ? el("button", { type: "button", style: navStyle, title: "Next (→)",     onclick: (e) => { e.stopPropagation(); lbShow(idx + 1); } }, "›") : null;
          function lbOnKey(e) {
            if (e.key === "ArrowLeft"  || e.key === "ArrowUp")   { e.preventDefault(); if (multi) lbShow(idx - 1); }
            if (e.key === "ArrowRight" || e.key === "ArrowDown")  { e.preventDefault(); if (multi) lbShow(idx + 1); }
            if (e.key === "Escape") lbClose();
          }
          function lbClose() { lbOver.remove(); document.removeEventListener("keydown", lbOnKey); }
          const lbOver = el("div", { "data-modal-overlay": "", style: "position:fixed;inset:0;background:#000c;z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center", onclick: lbClose });
          lbOver.append(el("div", { style: "display:flex;align-items:center;gap:1rem" }, [lbPrev, lbImg, lbNext].filter(Boolean)), lbCount);
          document.addEventListener("keydown", lbOnKey);
          lbShow(0);
          document.body.append(lbOver);
        },
        onmouseenter: (ev) => {
          if (!wrap.isConnected) { imgTooltip.style.display = "none"; return; }
          const rect = ev.currentTarget.getBoundingClientRect();
          tooltipImg.src = thumbUrl;
          const tipLeft = rect.right + 10;
          const tipTop  = Math.max(8, rect.top - 80);
          imgTooltip.style.left = (tipLeft + 200 > window.innerWidth ? rect.left - 210 : tipLeft) + "px";
          imgTooltip.style.top  = Math.min(tipTop, window.innerHeight - 216) + "px";
          imgTooltip.style.display = "";
        },
        onmouseleave: () => { imgTooltip.style.display = "none"; },
      }) : null;

      const row = el("div", {
        style: "display:flex;align-items:center;gap:0.5rem;padding:0.45rem 0.6rem;user-select:none",
        ondblclick: (ev) => { ev.stopPropagation(); openComponentDetail(comp.id, token, detailPanel, comp, role); },
      }, [
        expandBtn,
        thumbEl,
        el("div", { style: "flex:1;min-width:0;overflow:hidden" }, [
          el("span", { style: "font-weight:600;font-size:0.875rem" }, comp.name || "—"),
          comp.part_number ? el("span", { style: "font-size:0.72rem;color:var(--muted,#8b93a1);margin-left:0.4rem;font-family:monospace" }, comp.part_number) : null,
          parentCountMap[comp.id] ? el("span", {
            title: `Used in ${parentCountMap[comp.id]} assemblies — changes propagate to all of them`,
            style: "margin-left:6px;font-size:0.66rem;color:var(--muted,#94a3b8);cursor:default;white-space:nowrap;vertical-align:middle",
          }, `↗ ${parentCountMap[comp.id]}`) : null,
        ].filter(Boolean)),
        el("span", { style: `font-size:0.7rem;padding:1px 6px;border-radius:4px;background:${tfg}18;color:${tfg};white-space:nowrap;flex-shrink:0` }, comp.type || ""),
        comp.category_id ? el("span", { style: "font-size:0.7rem;padding:1px 6px;border-radius:4px;background:var(--border,#e2e8f0)66;color:var(--muted,#8b93a1);white-space:nowrap;flex-shrink:0" }, categoryNameOf(comp.category_id) || "") : null,
        (() => { const MOB_COLOR = { purchased:"#4a9eed", manufactured:"#f59e0b", assembled:"#a855f7", subcontracted:"#8b93a1" }; const mob = comp.make_or_buy || "purchased"; const mc = MOB_COLOR[mob] || "#8b93a1"; return el("span", { style: `font-size:0.7rem;padding:1px 6px;border-radius:4px;background:${mc}18;color:${mc};white-space:nowrap;flex-shrink:0` }, mob); })(),
        comp.lifecycle_status ? el("span", { style: `font-size:0.7rem;padding:1px 6px;border-radius:4px;background:${sfg}18;color:${sfg};white-space:nowrap;flex-shrink:0` }, comp.lifecycle_status) : null,
        role === "rushroom" && allowExpand ? el("button", {
          class: "btn btn-sm", type: "button",
          style: "padding:0 6px;font-size:0.72rem;flex-shrink:0",
          title: "Add child",
          onclick: (ev) => { ev.stopPropagation(); openAddChildModal(comp, allComponents, token, refreshTree, comp.id); },
        }, "+child") : null,
        el("button", {
          class: "btn btn-sm", type: "button",
          style: "color:#e05454;border-color:#e0545440;padding:0 7px;font-size:0.9rem;font-weight:700;line-height:1;flex-shrink:0",
          title: "Delete", onclick: async (ev) => {
            ev.stopPropagation();
            ev.target.disabled = true;
            try {
              const { parents } = await API.post(token, "listParentsOf", { component_id: comp.id });
              const confirmed = await new Promise((resolve) => {
                const mo = el("div", { "data-modal-overlay": "", style: "position:fixed;inset:0;background:#00000080;z-index:2000;display:flex;align-items:center;justify-content:center" });
                const close = (v) => { mo.remove(); resolve(v); };
                mo.onclick = (e) => { if (e.target === mo) close(false); };
                const rows = [
                  el("div", { style: "display:flex;align-items:center;gap:0.5rem;margin-bottom:0.75rem" }, [
                    el("span", { style: "font-size:1.3rem;line-height:1" }, "🗑"),
                    el("h3", { style: "margin:0;font-size:1rem;color:#e05454" }, `Delete "${comp.name}" from registry?`),
                  ]),
                  el("p", { style: "margin:0 0 0.75rem;font-size:0.875rem" }, "This permanently removes the component and all its compliance data."),
                ];
                if (parents && parents.length) rows.push(el("div", { style: "background:#e0545415;border:1px solid #e0545450;border-radius:6px;padding:0.6rem 0.75rem;margin-bottom:0.75rem" }, [
                  el("div", { style: "font-size:0.82rem;font-weight:700;color:#e05454;margin-bottom:0.3rem" }, `⚠ Linked in ${parents.length} assembl${parents.length > 1 ? "ies" : "y"}:`),
                  el("ul", { style: "margin:0.2rem 0 0.3rem;padding-left:1.2rem;font-size:0.82rem" }, parents.map((p) => el("li", {}, p.parent ? p.parent.name : p.parent_id))),
                  el("div", { style: "font-size:0.78rem;color:var(--muted,#8b93a1)" }, "Deleting will unlink it from all of them."),
                ]));
                if (comp.has_children) rows.push(el("p", { style: "font-size:0.82rem;color:var(--muted,#8b93a1);margin:0 0 0.5rem" }, "Direct children will become standalone BOM Nodes."));
                rows.push(el("p", { style: "font-size:0.82rem;font-weight:700;color:#e05454;margin:0 0 1.1rem" }, "This cannot be undone."));
                rows.push(el("div", { style: "display:flex;justify-content:flex-end;gap:0.5rem" }, [
                  el("button", { class: "btn btn-sm", type: "button", onclick: () => close(false) }, "Cancel"),
                  el("button", { type: "button", style: "background:#e05454;color:#fff;border:none;border-radius:6px;padding:0.45rem 1.1rem;font-size:0.875rem;font-weight:700;cursor:pointer;letter-spacing:0.01em", onclick: () => close(true) }, "Delete Permanently"),
                ]));
                mo.append(el("div", { style: "background:var(--bg,#fff);border:2px solid #e05454;border-radius:10px;padding:1.5rem;width:min(440px,95vw);max-height:90vh;overflow-y:auto;box-shadow:0 8px 40px #0003" }, rows));
                document.body.append(mo);
              });
              if (!confirmed) { ev.target.disabled = false; return; }
              await API.post(token, "deleteComponent", { component_id: comp.id });
              refreshTree();
            } catch (ex) { ev.target.disabled = false; alert(`Failed: ${ex.message}`); }
          },
        }, "×"),
      ].filter(Boolean));

      container.append(row, treeDiv);
      return container;
    }

    refreshBomList = () => refreshTree();

    async function refreshTree() {
      treeArea.replaceChildren(el("div", { class: "loading" }, "Loading BOM…"));
      try {
        const expandedIds = Object.keys(expandedTrees).filter((id) => expandedTrees[id] !== "loading" && expandedTrees[id] !== "error");
        const [{ components }, thumbRes, pcRes, catRes] = await Promise.all([
          API.post(token, "listComponents", {}),
          API.post(token, "listComponentThumbnails", {}).catch(() => ({ thumbnails: [] })),
          API.post(token, "listParentCounts", {}).catch(() => ({ parentCounts: [] })),
          API.post(token, "listPartCategories", {}).catch(() => ({ categories: [] })),
        ]);
        partCategories = catRes.categories || [];
        thumbMap = Object.fromEntries((thumbRes.thumbnails || []).map((t) => [t.component_id, t.url]));
        parentCountMap = Object.fromEntries((pcRes.parentCounts || []).map((p) => [p.component_id, p.parent_count]));
        if (!components.length) {
          tabBarEl.replaceChildren();
          detailPanel.style.display = "none";
          detailPanel.replaceChildren();
          treeArea.replaceChildren(el("div", { class: "notice", style: "margin-top:1rem" }, [
            "No components yet. Use ", el("strong", {}, "+ New BOM Node"), " to create the first one.",
          ]));
          return;
        }
        allComponents = components;
        const idSet = new Set(components.map((c) => c.id));
        Object.keys(expandedTrees).forEach((k) => { if (!idSet.has(k)) delete expandedTrees[k]; });
        if (expandedIds.length) {
          await Promise.all(expandedIds.filter((id) => idSet.has(id)).map(async (id) => {
            try { expandedTrees[id] = await API.post(token, "getBom", { root_component_id: id, max_depth: 10 }); }
            catch { expandedTrees[id] = "error"; }
          }));
        }
        renderAll();
      } catch (ex) {
        treeArea.replaceChildren(el("div", { class: "error" }, `Couldn't load: ${ex.message}`));
      }
    }

    refreshTree();
    return wrap;
  }

  function renderBomTree(rootId, bom, container, detailPanel, token, allComponents, onRefresh, role) {
    const { nodes = [], edges = [] } = bom;
    if (!nodes.length) { container.replaceChildren(el("div", { class: "notice" }, "Empty BOM.")); return; }

    const nodeMap = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const childrenOf = {};
    edges.forEach((e) => {
      if (!childrenOf[e.parent_id]) childrenOf[e.parent_id] = [];
      childrenOf[e.parent_id].push(e);
    });

    const isDynamicBom = !!(nodeMap[rootId] && nodeMap[rootId].type === "product_family");

    // Collapsed set: posNums whose children are hidden
    const collapsed = new Set();

    // DFS walk — builds a flat ordered list of rows with position numbers and
    // ancestor-last flags (used to draw ├─ / └─ / │ connectors correctly at any depth)
    function buildRows() {
      const rows = [];
      // edgeId / sibIndex / sibCount are carried so a row can reorder and move
      // itself: PROP-036 keys both on the EDGE, never on the (parent, child) pair.
      // qty is the rolled-up quantity through the tree; edgeQty is what THIS
      // edge carries. The column shows the roll-up, but only edgeQty is editable
      // — editing the roll-up would silently write the wrong number.
      function walk(nodeId, qty, posNum, depth, ancestorLastFlags, edgeCondition, parentNode, edgeId, sibIndex, sibCount, edgeQty) {
        const n = nodeMap[nodeId];
        if (!n) return;
        const children = childrenOf[nodeId] || [];
        rows.push({ n, qty, posNum, depth, ancestorLastFlags: [...ancestorLastFlags], hasChildren: children.length > 0, edgeCondition, parentNode: parentNode || null, edgeId, sibIndex, sibCount, edgeQty });
        if (collapsed.has(posNum)) return;
        children.forEach((e, i) => {
          walk(e.child_id, qty * e.quantity, `${posNum}.${i + 1}`, depth + 1, [...ancestorLastFlags, i === children.length - 1], e.variant_condition, n, e.id, i, children.length, e.quantity);
        });
      }
      // Root is already shown as the list-row header — start from its children
      const topEdges = childrenOf[rootId] || [];
      topEdges.forEach((e, i) => {
        walk(e.child_id, e.quantity, `${i + 1}`, 0, [], e.variant_condition, nodeMap[rootId] || { id: rootId }, e.id, i, topEdges.length, e.quantity);
      });
      return rows;
    }

    // Every WBS position a component occupies in THIS tree, ignoring collapse
    // state (buildRows() stops at collapsed nodes, so it cannot be used here).
    // A component can sit in several places, hence an array per id.
    function allPositions() {
      const map = {};
      (function walkAll(nodeId, prefix, depth) {
        if (depth > 12) return;  // belt-and-braces; trg_check_bom_cycle prevents loops
        (childrenOf[nodeId] || []).forEach((e, i) => {
          const pos = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
          (map[e.child_id] = map[e.child_id] || []).push(pos);
          walkAll(e.child_id, pos, depth + 1);
        });
      })(rootId, "", 0);
      return map;
    }

    // Build ASCII tree connector: e.g. depth=3, flags=[false,true,false] → "│  └─ "
    function connector(depth, ancestorLastFlags) {
      if (depth === 0) return "";
      let s = "";
      for (let i = 0; i < depth - 1; i++) s += ancestorLastFlags[i] ? "   " : "│  ";
      s += ancestorLastFlags[depth - 1] ? "└─ " : "├─ ";
      return s;
    }

    function render() {
      const rows = buildRows();
      const wrap = el("div", { style: "font-size:0.84rem;overflow-x:auto" });

      // Column header
      // Expand / Collapse all controls
    wrap.append(el("div", { style: "display:flex;gap:0.4rem;margin-bottom:0.4rem" }, [
      el("button", { class: "btn btn-sm", type: "button", onclick: () => { collapsed.clear(); render(); } }, "Expand all"),
      el("button", { class: "btn btn-sm", type: "button", onclick: () => { collapsed.clear(); buildRows().filter((r) => r.hasChildren).forEach((r) => collapsed.add(r.posNum)); render(); } }, "Collapse all"),
    ]));

    wrap.append(el("div", {
        style: "display:grid;grid-template-columns:6rem 1fr 4rem 7rem 15rem;gap:0.5rem;padding:0.2rem 0.5rem 0.35rem;font-size:0.71rem;font-weight:700;color:var(--muted,#8b93a1);text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--border,#e2e8f0);margin-bottom:0.15rem;position:sticky;top:0;z-index:1;background:var(--bg,#fff)",
      }, ["Pos.", isDynamicBom ? "Configuration" : "Part", "Qty", "Status", ""].map((t, i) => el("span", { style: i >= 2 && i <= 3 ? "text-align:center" : "" }, t))));

      rows.forEach(({ n, qty, posNum, depth, ancestorLastFlags, hasChildren, edgeCondition, parentNode, edgeId, sibIndex, sibCount, edgeQty }) => {
        const isCollapsed = collapsed.has(posNum);
        const isFamily = n.type === "product_family";
        // PROP-036 — guards say what they MEAN. `depth` is positional only (it
        // feeds connector()); because the tree never renders its own root, the
        // root's children sit at depth 0, so any permission written as
        // `depth > 0` is one level off. That mismatch caused the v202 data loss.
        const isTreeRow  = !!parentNode;                    // every row inside a tree has a parent
        const canUnlink  = isTreeRow;                       // unlink the edge, never delete the component
        const canAddChild = n.type !== "finished_good";     // PROP-029: a finished good is a leaf
        // Always rendered on a tree row, disabled when there is nothing to swap
        // with. Hiding them on single-child assemblies made the control invisible
        // and left users unable to tell the feature existed; it also made the
        // action column width vary per row, which PROP-017 fixed deliberately.
        const canReorder = isTreeRow;

        // ↑/↓ explain themselves when unavailable: a greyed button with a
        // "Move up" tooltip says nothing about WHY it will not move.
        // Deliberately aria-disabled rather than the `disabled` attribute —
        // Chrome suppresses hover events on a disabled control, so its title
        // never appears, which would defeat the whole point.
        // QTY cell. Click to edit the quantity THIS edge carries; the rolled-up
        // total is shown underneath when it differs, so the number being edited
        // is never confused with the number being displayed.
        const qtyCell = () => {
          const own = Number(edgeQty);
          const box = el("div", { style: "text-align:center;font-size:0.8rem;color:var(--muted,#8b93a1);line-height:1.15" });
          const show = () => {
            const kids = [
              el("span", {
                style: `cursor:${edgeId ? "pointer" : "default"};${edgeId ? "border-bottom:1px dashed var(--muted,#8b93a1)" : ""}`,
                title: edgeId ? "Click to change how many this assembly uses" : "",
                onclick: edgeId ? ((ev) => { ev.stopPropagation(); edit(); }) : null,
              }, `×${own}`),
            ];
            if (Number(qty) !== own) {
              kids.push(el("div", { style: "font-size:0.66rem;opacity:0.65", title: "Rolled-up total through the tree" }, `= ${qty}`));
            }
            box.replaceChildren(...kids);
          };
          const edit = () => {
            const input = el("input", {
              type: "number", min: "0.001", step: "any", value: String(own),
              style: "width:4.2rem;font-size:0.8rem;padding:1px 3px;text-align:center;box-sizing:border-box",
            });
            let settled = false;
            const commit = async () => {
              if (settled) return;
              const v = Number(input.value);
              if (!Number.isFinite(v) || v <= 0) { alert("Quantity must be greater than zero."); input.focus(); input.select(); return; }
              settled = true;
              if (v === own) { show(); return; }
              input.disabled = true;
              try { await API.post(token, "setEdgeQuantity", { edge_id: edgeId, quantity: v }); onRefresh(); }
              catch (ex) { settled = false; input.disabled = false; alert(`Failed: ${ex.message}`); show(); }
            };
            input.onkeydown = (ev) => {
              ev.stopPropagation();
              if (ev.key === "Enter") { ev.preventDefault(); commit(); }
              else if (ev.key === "Escape") { settled = true; show(); }
            };
            input.onblur = () => commit();
            input.onclick = (ev) => ev.stopPropagation();
            box.replaceChildren(input);
            input.focus(); input.select();
          };
          show();
          return box;
        };

        const reorderBtn = (dir) => {
          const blocked = sibCount <= 1
            ? "Only child — nothing to reorder"
            : dir === "up"
              ? (sibIndex === 0 ? "Already first in this assembly" : "")
              : (sibIndex === sibCount - 1 ? "Already last in this assembly" : "");
          return el("button", {
            class: "btn btn-sm", type: "button",
            title: blocked || `Move ${dir} in this assembly`,
            "aria-disabled": blocked ? "true" : "false",
            style: `padding:1px 4px;font-size:0.7rem${blocked ? ";opacity:0.4;cursor:not-allowed" : ""}`,
            onclick: async (ev) => {
              ev.stopPropagation();
              if (blocked) return;
              ev.currentTarget.disabled = true;
              try { await API.post(token, "reorderBomEdge", { edge_id: edgeId, direction: dir }); onRefresh(); }
              catch (ex) { ev.currentTarget.disabled = false; alert(`Failed: ${ex.message}`); }
            },
          }, dir === "up" ? "↑" : "↓");
        };

        // Toggle button (only for nodes with children)
        const tog = hasChildren
          ? el("span", {
              style: "cursor:pointer;user-select:none;font-size:0.65rem;margin-right:2px;color:var(--muted,#8b93a1)",
              onclick: (ev) => { ev.stopPropagation(); if (isCollapsed) collapsed.delete(posNum); else collapsed.add(posNum); render(); },
            }, isCollapsed ? "▶" : "▼")
          : el("span", { style: "display:inline-block;width:0.7rem" });

        // Variant condition tag (shown on conditional edges)
        const condTag = edgeCondition
          ? el("span", { style: "font-size:0.68rem;font-weight:600;background:#a855f720;color:#a855f7;border-radius:4px;padding:1px 5px;flex-shrink:0;white-space:nowrap;margin-left:4px" },
              "⚙ " + Object.entries(edgeCondition).map(([k, v]) => `${k}:${v}`).join(" "))
          : null;

        // Family badge for product_family roots
        const familyBadge = isFamily
          ? el("span", { style: "font-size:0.68rem;font-weight:700;background:#2fa56420;color:#2fa564;border-radius:4px;padding:1px 5px;flex-shrink:0;white-space:nowrap;margin-left:4px" }, "DYNAMIC BOM")
          : null;

        // Component cell: connector + toggle | name + badges (line 1) / part# (line 2)
        const nameBlock = el("div", { style: "min-width:0;flex:1;overflow:hidden" }, [
          el("div", { style: "display:flex;align-items:center;gap:0.2rem;min-width:0" }, [
            el("span", { style: "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, n.name),
            familyBadge, condTag,
          ].filter(Boolean)),
          el("div", { style: "font-family:monospace;font-size:0.67rem;color:var(--muted,#8b93a1);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, n.part_number),
        ]);
        const compCell = el("div", { style: "display:flex;align-items:center;gap:0.1rem;min-width:0;overflow:hidden" }, [
          el("span", { style: "font-family:monospace;white-space:pre;color:var(--muted,#8b93a1);font-size:0.76rem;flex-shrink:0;opacity:0.6" }, connector(depth, ancestorLastFlags)),
          tog,
          nameBlock,
        ]);

        const row = el("div", {
          style: `display:grid;grid-template-columns:6rem 1fr 4rem 7rem 15rem;gap:0.5rem;align-items:center;padding:0.3rem 0.5rem;border-left:3px solid ${isFamily ? "#2fa564" : "transparent"};border-radius:3px;margin-bottom:1px;cursor:default`,
          onmouseenter: (ev) => { ev.currentTarget.style.background = "var(--bg-2,rgba(0,0,0,0.03))"; },
          onmouseleave: (ev) => { ev.currentTarget.style.background = ""; },
          ondblclick: (ev) => { ev.stopPropagation(); openComponentDetail(n.id, token, detailPanel, n, role); },
        }, [
          el("span", { style: "font-family:monospace;font-size:0.78rem;font-weight:600;color:var(--muted,#8b93a1)" }, posNum),
          compCell,
          qtyCell(),
          el("div", { style: "display:flex;justify-content:center" }, lifecycleBadge(n.lifecycle_status)),
          el("div", { style: "display:flex;gap:0.2rem;flex-shrink:0;flex-wrap:nowrap" }, [
            // ⚙ variant-configure button hidden until import integration is built (PROP-018)

            canReorder ? reorderBtn("up") : null,
            canReorder ? reorderBtn("down") : null,
            isTreeRow ? el("button", { class: "btn btn-sm", type: "button", title: "Add sibling", style: "padding:1px 5px;font-size:0.7rem", onclick: () => openAddChildModal(parentNode, allComponents, token, onRefresh, rootId, { linkExistingOnly: isDynamicBom }) }, "+sib") : null,
            canAddChild ? el("button", { class: "btn btn-sm", type: "button", title: "Add child", style: "padding:1px 5px;font-size:0.7rem", onclick: () => openAddChildModal(n, allComponents, token, onRefresh, rootId, { linkExistingOnly: isDynamicBom }) }, "+child") : null,
            isTreeRow ? el("button", {
              class: "btn btn-sm", type: "button", title: "Move to another assembly",
              style: "padding:1px 5px;font-size:0.7rem",
              onclick: (ev) => { ev.stopPropagation(); openMoveModal(n, edgeId, parentNode, token, onRefresh, { positions: allPositions(), rootId, rootName: (nodeMap[rootId] || {}).name, fromPos: posNum }); },
            }, "⇄") : null,
            el("button", {
              class: "btn btn-sm", type: "button",
              style: "padding:1px 6px;font-size:0.85rem;font-weight:700;color:#e05454;border-color:#e0545440;line-height:1",
              title: canUnlink ? "Remove from this assembly" : "Delete from registry",
              onclick: async (ev) => {
                ev.stopPropagation();
                ev.target.disabled = true; ev.target.textContent = "…";
                try {
                  if (canUnlink) {
                    // Child row: unlink from this assembly only — component stays in registry
                    if (!confirm(`Remove "${n.name}" from this assembly?\n\nThe component stays in the registry and can be re-linked. This cannot be undone.`)) {
                      ev.target.disabled = false; ev.target.textContent = "×";
                      return;
                    }
                    // Key on the edge: PROP-033 allows several conditional edges
                    // between one pair, and a pair-keyed close would shut them all.
                    await API.post(token, "removeBomEdge", { edge_id: edgeId, parent_id: parentNode.id, child_id: n.id });
                  } else {
                    // Root row: delete from registry — show custom danger modal
                    const { parents } = await API.post(token, "listParentsOf", { component_id: n.id });
                    const childCount = (childrenOf[n.id] || []).length;
                    const confirmed = await new Promise((resolve) => {
                      const mo = el("div", { "data-modal-overlay": "", style: "position:fixed;inset:0;background:#00000080;z-index:2000;display:flex;align-items:center;justify-content:center" });
                      const close = (v) => { mo.remove(); resolve(v); };
                      mo.onclick = (e) => { if (e.target === mo) close(false); };
                      const rows = [
                        el("div", { style: "display:flex;align-items:center;gap:0.5rem;margin-bottom:0.75rem" }, [
                          el("span", { style: "font-size:1.3rem;line-height:1" }, "🗑"),
                          el("h3", { style: "margin:0;font-size:1rem;color:#e05454" }, `Delete "${n.name}" from registry?`),
                        ]),
                        el("p", { style: "margin:0 0 0.75rem;font-size:0.875rem" }, "This permanently removes the component and all its compliance data."),
                      ];
                      if (parents && parents.length) {
                        rows.push(el("div", { style: "background:#e0545415;border:1px solid #e0545450;border-radius:6px;padding:0.6rem 0.75rem;margin-bottom:0.75rem" }, [
                          el("div", { style: "font-size:0.82rem;font-weight:700;color:#e05454;margin-bottom:0.3rem" }, `⚠ Linked in ${parents.length} assembl${parents.length > 1 ? "ies" : "y"}:`),
                          el("ul", { style: "margin:0.2rem 0 0.3rem;padding-left:1.2rem;font-size:0.82rem" }, parents.map((p) => el("li", {}, p.parent ? p.parent.name : p.parent_id))),
                          el("div", { style: "font-size:0.78rem;color:var(--muted,#8b93a1)" }, "Deleting will unlink it from all of them."),
                        ]));
                      }
                      if (childCount) rows.push(el("p", { style: "font-size:0.82rem;color:var(--muted,#8b93a1);margin:0 0 0.5rem" }, `${childCount} direct child${childCount > 1 ? "ren" : ""} will become standalone BOM Nodes.`));
                      rows.push(el("p", { style: "font-size:0.82rem;font-weight:700;color:#e05454;margin:0 0 1.1rem" }, "This cannot be undone."));
                      rows.push(el("div", { style: "display:flex;justify-content:flex-end;gap:0.5rem" }, [
                        el("button", { class: "btn btn-sm", type: "button", onclick: () => close(false) }, "Cancel"),
                        el("button", { type: "button", style: "background:#e05454;color:#fff;border:none;border-radius:6px;padding:0.45rem 1.1rem;font-size:0.875rem;font-weight:700;cursor:pointer;letter-spacing:0.01em", onclick: () => close(true) }, "Delete Permanently"),
                      ]));
                      mo.append(el("div", { style: "background:var(--bg,#fff);border:2px solid #e05454;border-radius:10px;padding:1.5rem;width:min(440px,95vw);max-height:90vh;overflow-y:auto;box-shadow:0 8px 40px #0003" }, rows));
                      document.body.append(mo);
                    });
                    if (!confirmed) { ev.target.disabled = false; ev.target.textContent = "×"; return; }
                    await API.post(token, "deleteComponent", { component_id: n.id });
                  }
                  onRefresh();
                } catch (ex) {
                  ev.target.disabled = false; ev.target.textContent = "×";
                  alert(`Failed: ${ex.message}`);
                }
              },
            }, "×"),
          ].filter(Boolean)),
        ]);
        wrap.append(row);
      });

      container.replaceChildren(wrap);
    }

    render();
  }

  // --- Part categories (PROP-038) -------------------------------------------
  // Shared picker for both create paths and the detail panel. `typeEl`, when
  // given, drives the required-ness: assemblies and Dynamic BOMs are grouped by
  // their own tabs and are exempt.
  function categorySelect(currentId, opts) {
    const sel = el("select", { class: "up-text" }, [
      el("option", { value: "" }, (opts && opts.placeholder) || "— pick a category —"),
      ...partCategories.map((c) => el("option", { value: c.id }, c.name)),
    ]);
    sel.value = currentId || "";
    return sel;
  }
  const categoryRequiredFor = (type) => type !== "sub_assembly" && type !== "product_family";

  function openCategoryManager(token, onRefresh) {
    const overlay = el("div", { "data-modal-overlay": "", style: "position:fixed;inset:0;background:#0009;z-index:1002;display:flex;align-items:center;justify-content:center;padding:1rem" });
    const dialog = el("div", { style: "background:var(--bg,#1a1f2e);border:1px solid var(--border,#2d3748);border-radius:10px;padding:1.25rem 1.5rem;width:min(560px,96vw);max-height:88vh;display:flex;flex-direction:column;gap:0.6rem" });
    const listEl = el("div", { style: "flex:1;overflow-y:auto;border:1px solid var(--border,#2d3748);border-radius:6px;min-height:120px" });
    const errEl = el("span", { style: "color:#e05454;font-size:0.82rem;display:block;min-height:1.1rem" }, "");
    const newName = el("input", { class: "up-text", type: "text", placeholder: "New category name…", style: "flex:1" });

    const fail = (ex) => { errEl.textContent = ex.message || String(ex); };

    async function reload() {
      try {
        const { categories } = await API.post(token, "listPartCategories", {});
        partCategories = categories || [];
        draw();
      } catch (ex) { fail(ex); }
    }

    function draw() {
      if (!partCategories.length) {
        listEl.replaceChildren(el("div", { style: "padding:0.8rem;color:var(--muted,#8b93a1);font-size:0.86rem" }, "No categories yet. Add one below."));
        return;
      }
      listEl.replaceChildren(...partCategories.map((c, i) => {
        const nameInp = el("input", { class: "up-text", type: "text", value: c.name, style: "flex:1;font-size:0.86rem" });
        const save = async () => {
          const nm = nameInp.value.trim();
          if (!nm || nm === c.name) { nameInp.value = c.name; return; }
          errEl.textContent = "";
          try { await API.post(token, "updatePartCategory", { category_id: c.id, name: nm }); await reload(); onRefresh(); }
          catch (ex) { nameInp.value = c.name; fail(ex); }
        };
        nameInp.onblur = save;
        nameInp.onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); nameInp.blur(); } };
        const move = async (dir) => {
          const other = partCategories[i + dir];
          if (!other) return;
          errEl.textContent = "";
          try {
            await API.post(token, "updatePartCategory", { category_id: c.id, sort_order: other.sort_order });
            await API.post(token, "updatePartCategory", { category_id: other.id, sort_order: c.sort_order });
            await reload(); onRefresh();
          } catch (ex) { fail(ex); }
        };
        return el("div", { style: "display:flex;gap:0.4rem;align-items:center;padding:0.4rem 0.6rem;border-bottom:1px solid var(--border,#2d3748)" }, [
          nameInp,
          el("button", { class: "btn btn-sm", type: "button", title: "Move up", style: "padding:1px 6px", onclick: () => move(-1) }, "↑"),
          el("button", { class: "btn btn-sm", type: "button", title: "Move down", style: "padding:1px 6px", onclick: () => move(1) }, "↓"),
          el("button", {
            class: "btn btn-sm", type: "button", title: "Delete category",
            style: "padding:1px 7px;color:#e05454;border-color:#e0545440",
            onclick: async () => {
              errEl.textContent = "";
              // The server refuses while parts still reference it, rather than
              // orphaning them silently into Uncategorised.
              try { await API.post(token, "deletePartCategory", { category_id: c.id }); await reload(); onRefresh(); }
              catch (ex) { fail(ex); }
            },
          }, "×"),
        ]);
      }));
    }

    const addBtn = el("button", { class: "btn btn-sm btn-primary", type: "button" }, "Add");
    addBtn.onclick = async () => {
      const nm = newName.value.trim();
      if (!nm) return;
      errEl.textContent = ""; addBtn.disabled = true;
      try { await API.post(token, "createPartCategory", { name: nm }); newName.value = ""; await reload(); onRefresh(); }
      catch (ex) { fail(ex); }
      finally { addBtn.disabled = false; newName.focus(); }
    };
    newName.onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); addBtn.click(); } };

    dialog.append(
      el("div", { style: "display:flex;align-items:center;justify-content:space-between" }, [
        el("h3", { style: "margin:0;font-size:1.05rem" }, "Part categories"),
        el("button", { class: "btn btn-sm", type: "button", style: "padding:2px 9px", onclick: () => overlay.remove() }, "✕"),
      ]),
      el("p", { style: "margin:0;font-size:0.82rem;color:var(--muted,#8b93a1)" },
        "Rename in place, reorder with ↑/↓. A category still holding parts cannot be deleted — move them first."),
      listEl,
      el("div", { style: "display:flex;gap:0.4rem" }, [newName, addBtn]),
      errEl,
      el("div", { style: "display:flex;justify-content:flex-end" }, [
        el("button", { class: "btn btn-sm", type: "button", onclick: () => overlay.remove() }, "Done"),
      ]),
    );
    overlay.append(dialog);
    document.body.append(overlay);
    draw();
    newName.focus();
  }

  // --- Move modal: re-parent a child (PROP-036) -----------------------------
  // Edge-scoped on purpose: a component used in several assemblies moves ONLY in
  // the assembly on screen. Every other parent link is left exactly as it was.
  function openMoveModal(node, edgeId, currentParent, token, onRefresh, tree) {
    const positions = (tree && tree.positions) || {};
    const treeRootId = tree && tree.rootId;
    // Where a destination sits in the assembly on screen. A component can hold
    // several positions, and many legal destinations are not in this tree at all.
    function wbsOf(id) {
      if (id === treeRootId) return "root";
      const p = positions[id];
      return p && p.length ? p.join(", ") : null;   // null = lives in another assembly
    }

    const overlay = el("div", { "data-modal-overlay": "", style: "position:fixed;inset:0;background:#0009;z-index:1001;display:flex;align-items:center;justify-content:center;padding:1rem" });
    const dialog = el("div", { style: "background:var(--bg,#1a1f2e);border:1px solid var(--border,#2d3748);border-radius:10px;padding:1.25rem 1.5rem;width:min(860px,96vw);max-height:90vh;display:flex;flex-direction:column;gap:0.6rem" });

    const listEl = el("div", { style: "flex:1;min-height:180px;max-height:46vh;overflow-y:auto;border:1px solid var(--border,#2d3748);border-radius:6px" });
    const searchInput = el("input", { class: "up-text", type: "text", placeholder: "Search destination by part # or name…", style: "width:100%;box-sizing:border-box" });
    const errEl = el("span", { style: "color:#e05454;font-size:0.82rem;display:block;min-height:1.1rem" }, "");
    const selectedLabel = el("div", { style: "font-size:0.84rem;min-height:1.3rem;color:var(--muted,#8b93a1)" }, "Pick a destination below.");
    let targets = [], selectedId = null;

    const submitBtn = el("button", { class: "btn btn-sm btn-primary", type: "button", disabled: true }, "Move here");

    // One grid template shared by the header and every row, so columns line up.
    const GRID = "display:grid;grid-template-columns:7rem 11rem minmax(0,1fr) 7rem;gap:0.75rem;align-items:center";

    function rowFor(c) {
      const wbs = wbsOf(c.id);
      const isSel = selectedId === c.id;
      return el("div", {
        style: `${GRID};padding:0.45rem 0.7rem;cursor:pointer;border-bottom:1px solid var(--border,#2d3748);border-left:3px solid ${isSel ? "var(--accent,#2fa564)" : "transparent"};${isSel ? "background:var(--accent,#2fa564)18;" : ""}`,
        onclick: () => {
          selectedId = c.id;
          selectedLabel.replaceChildren(
            el("span", {}, "Move "),
            el("strong", {}, node.name),
            el("span", {}, " into "),
            el("strong", {}, c.name),
            el("span", { style: "color:var(--muted,#8b93a1)" }, wbs ? `  ·  position ${wbs} in this assembly` : "  ·  in another assembly"),
          );
          submitBtn.disabled = false;
          buildList(searchInput.value);
        },
      }, [
        el("span", { style: `font-family:monospace;font-size:0.78rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${wbs ? "color:var(--accent,#2fa564)" : "color:var(--muted,#8b93a1);opacity:0.5"}` }, wbs || "—"),
        el("span", { style: "font-family:monospace;font-size:0.76rem;color:var(--muted,#8b93a1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, c.part_number),
        el("span", { style: "font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", title: c.name }, c.name),
        el("span", { style: "font-size:0.72rem;color:var(--muted,#8b93a1);text-align:right;white-space:nowrap" }, c.type || ""),
      ]);
    }

    function sectionHeader(text) {
      return el("div", { style: "padding:0.35rem 0.7rem;font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#8b93a1);background:var(--bg-2,rgba(0,0,0,0.04));border-bottom:1px solid var(--border,#2d3748);position:sticky;top:0;z-index:1" }, text);
    }

    // Grouped rather than flat: "not in this assembly" was a long string sitting
    // in the position column, which shoved every other column out of alignment.
    // As a section heading it says the same thing once, for the whole group.
    function buildList(filter) {
      const f = (filter || "").toLowerCase();
      const shown = f ? targets.filter((c) => (c.part_number + " " + c.name).toLowerCase().includes(f)) : targets;
      if (!shown.length) {
        listEl.replaceChildren(el("div", { style: "padding:0.9rem 0.7rem;color:var(--muted,#8b93a1);font-size:0.86rem" },
          targets.length ? "No destinations match that search." : "No legal destination for this component."));
        return;
      }
      const here = shown.filter((c) => wbsOf(c.id));
      const elsewhere = shown.filter((c) => !wbsOf(c.id));
      // Shallowest position first, so the assembly reads top-down.
      here.sort((a, b) => {
        const pa = wbsOf(a.id) === "root" ? "" : wbsOf(a.id), pb = wbsOf(b.id) === "root" ? "" : wbsOf(b.id);
        return pa.split(".").length - pb.split(".").length || pa.localeCompare(pb, undefined, { numeric: true });
      });
      const out = [];
      if (here.length) { out.push(sectionHeader(`In this assembly — ${tree && tree.rootName ? tree.rootName : "current tree"}`)); here.forEach((c) => out.push(rowFor(c))); }
      if (elsewhere.length) { out.push(sectionHeader("In other assemblies")); elsewhere.forEach((c) => out.push(rowFor(c))); }
      listEl.replaceChildren(...out);
    }
    searchInput.oninput = () => buildList(searchInput.value);

    submitBtn.onclick = async () => {
      if (!selectedId) return;
      submitBtn.disabled = true; submitBtn.textContent = "Moving…"; errEl.textContent = "";
      try {
        await API.post(token, "moveComponentToParent", { edge_id: edgeId, new_parent_id: selectedId });
        overlay.remove();
        onRefresh();
      } catch (ex) {
        errEl.textContent = ex.message;
        submitBtn.disabled = false; submitBtn.textContent = "Move here";
      }
    };

    const fact = (label, value) => el("div", { style: "display:flex;gap:0.4rem;font-size:0.84rem;min-width:0" }, [
      el("span", { style: "color:var(--muted,#8b93a1);flex-shrink:0" }, label),
      el("span", { style: "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", title: value }, value),
    ]);

    dialog.append(
      el("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:1rem" }, [
        el("h3", { style: "margin:0;font-size:1.05rem" }, "Move to another assembly"),
        el("button", { class: "btn btn-sm", type: "button", style: "padding:2px 9px", onclick: () => overlay.remove() }, "✕"),
      ]),
      el("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:0.3rem 1.25rem;padding:0.6rem 0.75rem;border:1px solid var(--border,#2d3748);border-radius:6px" }, [
        fact("Moving:", `${node.name} (${node.part_number})`),
        fact("Position:", tree && tree.fromPos ? tree.fromPos : "—"),
        fact("Out of:", currentParent && currentParent.name ? currentParent.name : "this assembly"),
        fact("Assembly:", tree && tree.rootName ? tree.rootName : "—"),
      ]),
      el("div", { style: "background:#2fa56412;border:1px solid #2fa56440;border-radius:6px;padding:0.45rem 0.7rem;font-size:0.82rem" },
        "Only this assembly changes. If this component is used elsewhere, those assemblies keep it exactly as they have it."),
      searchInput,
      el("div", { style: `${GRID};padding:0.25rem 0.7rem;font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#8b93a1)` }, [
        el("span", {}, "Pos."), el("span", {}, "Part no."), el("span", {}, "Destination"), el("span", { style: "text-align:right" }, "Type"),
      ]),
      listEl,
      selectedLabel,
      errEl,
      el("div", { style: "display:flex;gap:0.5rem;justify-content:flex-end" }, [
        el("button", { class: "btn btn-sm", type: "button", onclick: () => overlay.remove() }, "Cancel"),
        submitBtn,
      ]),
    );
    overlay.append(dialog);
    document.body.append(overlay);

    listEl.replaceChildren(el("div", { class: "loading", style: "padding:0.9rem 0.7rem" }, "Loading destinations…"));
    (async () => {
      try {
        const res = await API.post(token, "listMoveTargets", { edge_id: edgeId });
        targets = res.targets || [];
        buildList("");
        searchInput.focus();
      } catch (ex) {
        listEl.replaceChildren(el("div", { style: "padding:0.9rem 0.7rem;color:#e05454;font-size:0.86rem" }, ex.message));
      }
    })();
  }

  // --- Add-child modal: link existing OR create new and link ---------------
  function openAddChildModal(parentNode, allComponents, token, onRefresh, rootId, opts) {
    const linkExistingOnly = !!(opts && opts.linkExistingOnly);
    const overlay = el("div", { "data-modal-overlay": "", style: "position:fixed;inset:0;background:#0009;z-index:1001;display:flex;align-items:center;justify-content:center" });
    const dialog = el("div", { style: "background:var(--bg,#1a1f2e);border:1px solid var(--border,#2d3748);border-radius:8px;padding:1.5rem;width:min(520px,95vw);max-height:90vh;overflow-y:auto" });

    let mode = "existing"; // "existing" | "new"

    // Shared qty / ref designator fields
    const qtyInput = el("input", { class: "up-text", type: "number", min: "0.001", step: "any", value: "1", style: "width:100px" });
    const refInput = el("input", { class: "up-text", type: "text", placeholder: "e.g. J1, J2 (optional)", style: "flex:1" });
    const errEl = el("span", { style: "color:#e05454;font-size:0.82rem;display:block;min-height:1.2rem;margin-top:0.25rem" }, "");

    // Tab bar
    const tabExisting = el("button", { type: "button", style: "flex:1;border-radius:0;border:none;padding:0.4rem 0.75rem;font-size:0.82rem;font-weight:600;cursor:pointer;transition:background 0.1s" }, "Link existing");
    const tabNew      = el("button", { type: "button", style: "flex:1;border-radius:0;border:none;padding:0.4rem 0.75rem;font-size:0.82rem;font-weight:600;cursor:pointer;transition:background 0.1s" }, "Create new");
    const tabBar = el("div", { style: `display:${linkExistingOnly ? "none" : "flex"};border:1px solid var(--border,#2d3748);border-radius:4px;overflow:hidden;margin-bottom:0.9rem` }, [tabExisting, tabNew]);

    // Existing component section
    const candidates = (allComponents || []).filter((c) => c.id !== parentNode.id).sort((a, b) => a.part_number.localeCompare(b.part_number));
    const searchInput = el("input", { class: "up-text", type: "text", placeholder: "Search by part # or name…", style: "width:100%;margin-bottom:0.5rem" });
    const listEl = el("div", { style: "max-height:200px;overflow-y:auto;border:1px solid var(--border,#2d3748);border-radius:4px;margin-bottom:0.5rem" });
    let selectedId = null;
    const selectedLabel = el("div", { style: "font-size:0.82rem;color:var(--muted,#8b93a1);margin-bottom:0.5rem;min-height:1.2rem" }, "");
    const sharedWarn = el("p", { style: "display:none;margin:4px 0 6px;font-size:0.8rem;color:#d97706;background:#fef3c715;border:1px solid #d9770640;border-radius:4px;padding:4px 8px" }, "");

    function buildList(filter) {
      const filtered = filter ? candidates.filter((c) => (c.part_number + " " + c.name).toLowerCase().includes(filter.toLowerCase())) : candidates;
      listEl.replaceChildren(...filtered.map((c) => {
        const row = el("div", {
          style: `padding:0.35rem 0.6rem;cursor:pointer;border-bottom:1px solid var(--border,#2d3748);display:flex;gap:0.5rem;align-items:center;${selectedId === c.id ? "background:var(--accent,#2fa564)22;" : ""}`,
          onclick: () => {
            selectedId = c.id;
            selectedLabel.textContent = `Selected: ${c.part_number} — ${c.name}`;
            const pc = parentCountMap[c.id];
            if (pc) {
              sharedWarn.textContent = `⚠ Already used in ${pc} other assembl${pc === 1 ? "y" : "ies"} — linking it here means structural changes propagate everywhere it is used.`;
              sharedWarn.style.display = "";
            } else {
              sharedWarn.style.display = "none";
            }
            buildList(searchInput.value);
          },
        }, [
          el("span", { style: "font-family:monospace;font-size:0.76rem;color:var(--muted,#8b93a1);flex-shrink:0" }, c.part_number),
          el("span", { style: "flex:1" }, c.name),
          lifecycleBadge(c.lifecycle_status),
        ]);
        return row;
      }));
      if (!filtered.length) listEl.replaceChildren(el("div", { style: "padding:0.5rem;color:var(--muted,#8b93a1);font-size:0.85rem" }, "No components match."));
    }
    buildList("");
    searchInput.oninput = () => buildList(searchInput.value);
    const existingSection = el("div", {}, [
      el("label", { style: "display:block;margin-bottom:0.25rem;font-size:0.82rem;font-weight:600" }, "Select child"),
      searchInput, listEl, selectedLabel, sharedWarn,
    ]);

    // Create-new section
    function genPN() {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let s = "";
      for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
      const now = new Date();
      return `RR-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-${s}`;
    }
    const TYPE_OPTS = [["part", "Part"], ["sub_assembly", "Sub-Assembly"], ["finished_good", "Finished Good"]];
    const newPN   = el("input",  { class: "up-text", type: "text" });
    const newName = el("input",  { class: "up-text", type: "text", placeholder: "Name (required)" });
    const newType = el("select", { class: "up-text" }, TYPE_OPTS.map(([v, l]) => el("option", { value: v }, l)));
    newPN.value = genPN();
    const F = "width:100%;font-size:0.875rem;padding:0.42rem 0.6rem;border:1px solid var(--border,#e2e8f0);border-radius:6px;background:var(--bg,#fff);color:var(--text,#1a1f2e);font-family:inherit;box-sizing:border-box";
    [newPN, newName].forEach((el_) => el_.style.cssText = F);
    newType.style.cssText = F + ";appearance:none;-webkit-appearance:none;cursor:pointer";
    const LBL = "display:block;font-size:0.8rem;font-weight:600;color:var(--muted,#8b93a1);margin-bottom:0.25rem";
    const ROW = "margin-bottom:0.6rem";
    // PROP-038: a category is required for anything that lands in the Parts tab.
    const newCat = categorySelect(null);
    newCat.style.cssText = F + ";appearance:none;-webkit-appearance:none;cursor:pointer";
    const newCatRow = el("div", { style: ROW }, [el("label", { style: LBL }, "Category"), newCat]);
    const syncCatRequired = () => { newCatRow.style.display = categoryRequiredFor(newType.value) ? "" : "none"; };
    newType.addEventListener("change", syncCatRequired);
    syncCatRequired();
    const newSection = el("div", {}, [
      el("div", { style: ROW }, [el("label", { style: LBL }, "Part number"), newPN]),
      el("div", { style: ROW }, [el("label", { style: LBL }, "Name"), newName]),
      el("div", { style: ROW }, [el("label", { style: LBL }, "Type"), newType]),
      newCatRow,
    ]);

    const qtyRefRow = el("div", { style: "display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:0.5rem" }, [
      el("label", { style: "display:flex;flex-direction:column;gap:0.2rem;font-size:0.82rem;font-weight:600" }, ["Quantity", qtyInput]),
      el("label", { style: "display:flex;flex-direction:column;gap:0.2rem;font-size:0.82rem;font-weight:600;flex:1" }, ["Reference designator", refInput]),
    ]);

    const submitBtn = el("button", { class: "btn btn-primary btn-sm", type: "submit" }, "Add to BOM");

    // Condition picker — shown only when root is a product_family
    let conditionMap = {};
    const condSection = el("div", { style: "display:none;border:1px solid var(--border,#2d3748);border-radius:4px;padding:0.6rem;margin-bottom:0.5rem" });
    const condToggle  = el("button", { class: "btn btn-sm", type: "button", style: "margin-bottom:0.5rem;font-size:0.75rem;display:none" }, "⚙ Set condition (optional)");

    const rootComp = rootId ? (allComponents || []).find((c) => c.id === rootId) : null;
    if (rootComp && rootComp.type === "product_family") {
      condToggle.style.display = "";
      condToggle.onclick = async () => {
        if (condSection.style.display !== "none") {
          condSection.style.display = "none";
          condToggle.textContent = "⚙ Set condition (optional)";
          conditionMap = {};
          return;
        }
        condToggle.textContent = "Loading attributes…";
        condToggle.disabled = true;
        try {
          const r = await API.post(token, "listFamilyAttributes", { family_id: rootId });
          const attrs = r.attributes || [];
          if (!attrs.length) {
            condSection.replaceChildren(el("div", { style: "font-size:0.8rem;color:var(--muted,#8b93a1)" }, "No attributes defined on this family yet."));
          } else {
            const LBL = "display:block;font-size:0.75rem;font-weight:600;color:var(--muted,#8b93a1);margin-bottom:0.15rem";
            condSection.replaceChildren(
              el("p", { style: "font-size:0.78rem;color:var(--muted,#8b93a1);margin:0 0 0.4rem" },
                "Include this child only when the following attributes are selected (leave blank = no condition):"),
              ...attrs.map((attr) => {
                const sel = el("select", { class: "up-text", style: "width:100%",
                  onchange: () => { if (sel.value) conditionMap[attr.name] = sel.value; else delete conditionMap[attr.name]; },
                }, [
                  el("option", { value: "" }, "— no condition —"),
                  ...(attr.values || []).map((v) => el("option", { value: v.value }, v.label)),
                ]);
                return el("div", { style: "margin-bottom:0.35rem" }, [el("label", { style: LBL }, attr.display_name), sel]);
              }),
            );
          }
          condSection.style.display = "";
          condToggle.textContent = "⚙ Condition (active)";
        } catch (ex) {
          condToggle.textContent = "⚙ Set condition (optional)";
          errEl.textContent = "Could not load family attributes: " + ex.message;
        } finally {
          condToggle.disabled = false;
        }
      };
    }

    function syncTabs() {
      const isExisting = mode === "existing";
      tabExisting.style.background = isExisting ? "var(--accent,#2fa564)" : "";
      tabExisting.style.color      = isExisting ? "#fff" : "";
      tabNew.style.background      = !isExisting ? "var(--accent,#2fa564)" : "";
      tabNew.style.color           = !isExisting ? "#fff" : "";
      existingSection.style.display = isExisting ? "" : "none";
      newSection.style.display      = !isExisting ? "" : "none";
      submitBtn.textContent = isExisting ? "Add to BOM" : "Create & add";
    }
    tabExisting.onclick = () => { mode = "existing"; syncTabs(); searchInput.focus(); };
    tabNew.onclick      = () => { mode = "new";      syncTabs(); newName.focus(); };
    syncTabs();

    const form = el("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        const qty = parseFloat(qtyInput.value);
        if (!qty || qty <= 0) { errEl.textContent = "Quantity must be greater than 0."; return; }
        errEl.textContent = "";
        submitBtn.disabled = true;
        submitBtn.textContent = mode === "new" ? "Creating…" : "Adding…";
        try {
          let childId = selectedId;
          if (mode === "new") {
            if (!newName.value.trim()) {
              errEl.textContent = "Name is required.";
              submitBtn.disabled = false; submitBtn.textContent = "Create & add";
              return;
            }
            if (categoryRequiredFor(newType.value) && !newCat.value) {
              errEl.textContent = "Pick a category for this part.";
              submitBtn.disabled = false; submitBtn.textContent = "Create & add";
              return;
            }
            const r = await API.post(token, "addComponent", {
              part_number: newPN.value.trim() || null,
              name:        newName.value.trim(),
              type:        newType.value,
              category_id: newCat.value || null,
            });
            childId = r.id;
          } else {
            if (!childId) {
              errEl.textContent = "Select a component first.";
              submitBtn.disabled = false; submitBtn.textContent = "Add to BOM";
              return;
            }
          }
          const cond = Object.keys(conditionMap).length > 0 ? { ...conditionMap } : null;
          await API.post(token, "addBomEdge", { parent_id: parentNode.id, child_id: childId, quantity: qty, reference_designator: refInput.value.trim() || null, variant_condition: cond });
          overlay.remove();
          if (onRefresh) onRefresh();
        } catch (ex) {
          errEl.textContent = ex.message;
          submitBtn.disabled = false;
          submitBtn.textContent = mode === "new" ? "Create & add" : "Add to BOM";
        }
      },
    });

    // PROP-036 option 3 — "allow + warn". Sub-tree edits inside a Dynamic BOM are
    // permitted, but there is no per-Dynamic-BOM copy of a sub-assembly: this writes
    // an edge on the SHARED component, so the new child lands in every assembly that
    // uses this parent. Name them before the user commits, not after.
    const blastPanel = el("div", { style: "display:none;background:#d9770615;border:1px solid #d9770650;border-radius:6px;padding:0.55rem 0.7rem;margin-bottom:0.75rem" });
    (async () => {
      const known = parentCountMap[parentNode.id];
      if (!known) return;  // not shared — nothing to warn about
      blastPanel.style.display = "";
      blastPanel.replaceChildren(el("div", { style: "font-size:0.82rem;font-weight:700;color:#d97706" },
        `⚠ This also changes ${known} other assembl${known === 1 ? "y" : "ies"}`));
      try {
        const { parents } = await API.post(token, "listParentsOf", { component_id: parentNode.id });
        if (!parents || !parents.length) return;
        blastPanel.replaceChildren(
          el("div", { style: "font-size:0.82rem;font-weight:700;color:#d97706;margin-bottom:0.25rem" },
            `⚠ "${parentNode.name}" is used in ${parents.length} other assembl${parents.length === 1 ? "y" : "ies"} — the new child appears in all of them:`),
          el("ul", { style: "margin:0.15rem 0 0.35rem;padding-left:1.2rem;font-size:0.8rem" },
            parents.map((pp) => el("li", {}, pp.parent ? `${pp.parent.name} (${pp.parent.part_number})` : pp.parent_id))),
          el("div", { style: "font-size:0.76rem;color:var(--muted,#8b93a1)" },
            "Wanted it in one configuration only? Add it with a variant condition instead, or stock the configuration as its own SKU."),
        );
      } catch { /* the count above is still shown; names are a nicety */ }
    })();

    form.append(
      el("div", { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem" }, [
        el("h3", { style: "margin:0;font-size:1rem" }, "Add child component"),
        el("button", { class: "btn btn-sm", type: "button", style: "padding:2px 8px", onclick: () => overlay.remove() }, "✕"),
      ]),
      el("p", { style: "font-size:0.82rem;color:var(--muted,#8b93a1);margin:0 0 0.75rem" }, `Parent: ${parentNode.part_number} — ${parentNode.name}`),
      blastPanel,
      tabBar,
      existingSection,
      newSection,
      qtyRefRow,
      condToggle,
      condSection,
      errEl,
      el("div", { style: "display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.75rem" }, [
        el("button", { class: "btn btn-sm", type: "button", onclick: () => overlay.remove() }, "Cancel"),
        submitBtn,
      ]),
    );
    dialog.append(form);
    overlay.append(dialog);
    document.body.append(overlay);
    searchInput.focus();
  }

  // --- PROP-040: promote a recurring custom spec to a standard field --------
  // Offered once a key appears on 3+ components. Creating the catalogue entry
  // makes it a labelled field on every component's Specifications tab; the
  // values already captured stay exactly where they are, in custom_specs.
  function openPromoteFieldModal(fieldKey, suggestedLabel, sampleValue, token, onDone) {
    const overlay = el("div", { "data-modal-overlay": "", style: "position:fixed;inset:0;background:#0009;z-index:1003;display:flex;align-items:center;justify-content:center;padding:1rem" });
    const dialog = el("div", { style: "background:var(--bg,#1a1f2e);border:1px solid var(--border,#2d3748);border-radius:10px;padding:1.25rem 1.5rem;width:min(520px,96vw);display:flex;flex-direction:column;gap:0.7rem" });
    const close = () => overlay.remove();
    const F = "width:100%;font-size:0.875rem;padding:0.42rem 0.6rem;border:1px solid var(--border,#e2e8f0);border-radius:6px;background:var(--bg,#fff);color:var(--text,#1a1f2e);font-family:inherit;box-sizing:border-box";

    const label = el("input", { class: "up-text", type: "text", value: suggestedLabel });
    const unit  = el("input", { class: "up-text", type: "text", placeholder: "e.g. mm — optional" });
    const type  = el("select", { class: "up-text" }, [
      el("option", { value: "text" }, "Text"),
      el("option", { value: "number" }, "Number"),
      el("option", { value: "boolean" }, "Yes / No"),
    ]);
    const section = el("select", { class: "up-text" }, [
      el("option", { value: "physical" }, "Physical"),
      el("option", { value: "material" }, "Material & Finish"),
      el("option", { value: "procurement" }, "Procurement"),
      el("option", { value: "quality" }, "Quality"),
      el("option", { value: "regulatory" }, "Regulatory / DPP"),
    ]);
    [label, unit].forEach((e) => e.style.cssText = F);
    [type, section].forEach((e) => e.style.cssText = F + ";appearance:none;-webkit-appearance:none;cursor:pointer");

    // A value like "Ø12mm" is almost certainly a measurement; save a click.
    if (/^[\s~<>=]*[-+]?\d/.test(String(sampleValue || "").replace(/^[^\d-+]*/, "x")) || /\d/.test(String(sampleValue || ""))) {
      const m = String(sampleValue || "").match(/([a-zA-Z%]+)\s*$/);
      if (/^\s*[^0-9]{0,2}[-+]?\d+([.,]\d+)?\s*[a-zA-Z%]*\s*$/.test(String(sampleValue || ""))) {
        type.value = "number";
        if (m) unit.value = m[1];
      }
    }

    const errEl = el("span", { style: "color:#e05454;font-size:0.82rem;min-height:1.1rem" }, "");
    const saveBtn = el("button", { class: "btn btn-sm btn-primary", type: "button" }, "Make standard field");
    saveBtn.onclick = async () => {
      if (!label.value.trim()) { errEl.textContent = "Give the field a label."; return; }
      saveBtn.disabled = true; saveBtn.textContent = "Saving…"; errEl.textContent = "";
      try {
        await API.post(token, "createCustomSpecField", {
          field_key: fieldKey, label: label.value.trim(),
          unit: unit.value.trim() || null, data_type: type.value, section: section.value,
        });
        close();
        onDone && onDone();
      } catch (ex) {
        errEl.textContent = ex.message;
        saveBtn.disabled = false; saveBtn.textContent = "Make standard field";
      }
    };

    const row = (lbl, ctrl, hint) => el("div", {}, [
      el("label", { style: "display:block;font-size:0.8rem;font-weight:600;color:var(--muted,#8b93a1);margin-bottom:0.25rem" }, lbl),
      ctrl,
      hint ? el("div", { style: "font-size:0.72rem;color:var(--muted,#8b93a1);margin-top:0.15rem" }, hint) : null,
    ].filter(Boolean));

    dialog.append(
      el("div", { style: "display:flex;align-items:center;justify-content:space-between" }, [
        el("h3", { style: "margin:0;font-size:1.05rem" }, "Make this a standard field"),
        el("button", { class: "btn btn-sm", type: "button", style: "padding:2px 9px", onclick: close }, "✕"),
      ]),
      el("p", { style: "margin:0;font-size:0.82rem;color:var(--muted,#8b93a1)" },
        `"${fieldKey}" becomes a labelled field on every component's Specifications tab. Values already captured stay where they are — nothing is migrated or lost, and you can undo it later.`),
      row("Label", label, "What the tab shows"),
      el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:0.75rem" }, [
        row("Type", type), row("Unit", unit),
      ]),
      row("Section", section, "Which group it appears under"),
      el("div", { style: "font-size:0.78rem;color:var(--muted,#8b93a1)" }, `Example value on this part: ${sampleValue || "—"}`),
      errEl,
      el("div", { style: "display:flex;gap:0.5rem;justify-content:flex-end" }, [
        el("button", { class: "btn btn-sm", type: "button", onclick: close }, "Cancel"),
        saveBtn,
      ]),
    );
    overlay.append(dialog);
    document.body.append(overlay);
    label.focus(); label.select();
  }

  // --- AI fill (PROP-039) ----------------------------------------------------
  // Reads a datasheet, drawing or pasted screenshot and proposes values for the
  // spec fields. It never writes on its own: a wrong flame-retardant class is
  // worse than an empty one, because it looks authoritative and gets exported
  // into a DPP. Designed for the shortest honest path — paste, glance, apply.
  const AI_FILL_LABELS = {
    weight_g: "Weight (g)", length_mm: "Length (mm)", width_mm: "Width (mm)", height_mm: "Height (mm)",
    base_material: "Base material", surface_treatment: "Surface treatment",
    color_specification: "Colour / finish", flame_retardant_class: "Flame retardant class",
    manufacturer_name: "Manufacturer", manufacturer_part_number: "OEM number",
    preferred_supplier_name: "Supplier", supplier_part_number: "Supplier part no.",
    lead_time_days: "Lead time (days)", moq: "MOQ", country_of_origin: "Country of origin", hs_code: "HS code",
    incoming_inspection_method: "Inspection method", inspection_sample_size: "Sample size",
    critical_to_quality: "Critical to quality", has_cpk_requirement: "Cpk required",
    weee_category: "WEEE category", battery_regulation_applicable: "Battery regulation",
    conflict_minerals_free: "Conflict minerals free", recycled_content_pct: "Recycled content (%)",
    carbon_footprint_kgco2e: "Carbon footprint (kg CO₂e)", carbon_footprint_source: "Footprint source",
    end_of_life_instruction: "End-of-life instruction", repair_spare_part_available: "Spare part available",
  };

  function openAiFillModal(componentId, token, panel, nodeData, role, existingImages) {
    const overlay = el("div", { "data-modal-overlay": "", style: "position:fixed;inset:0;background:#0009;z-index:1002;display:flex;align-items:center;justify-content:center;padding:1rem" });
    const dialog = el("div", { style: "background:var(--bg,#1a1f2e);border:1px solid var(--border,#2d3748);border-radius:10px;padding:1.25rem 1.5rem;width:min(920px,96vw);max-height:92vh;display:flex;flex-direction:column;gap:0.7rem" });
    const body = el("div", { style: "flex:1;overflow-y:auto;min-height:150px" });
    const errEl = el("span", { style: "color:#e05454;font-size:0.82rem;min-height:1.1rem;display:block" }, "");
    const close = () => { document.removeEventListener("paste", onPaste); overlay.remove(); };

    let current = {};   // existing metadata, so proposals can be shown against it

    // ---- step 1: pick a source -------------------------------------------
    function renderSourcePicker() {
      const drop = el("div", {
        style: "border:2px dashed var(--border,#2d3748);border-radius:8px;padding:1.6rem 1rem;text-align:center;font-size:0.9rem;color:var(--muted,#8b93a1);cursor:pointer",
        onclick: () => filePick.click(),
        ondragover: (ev) => { ev.preventDefault(); drop.style.borderColor = "var(--accent,#2fa564)"; },
        ondragleave: () => { drop.style.borderColor = "var(--border,#2d3748)"; },
        ondrop: (ev) => {
          ev.preventDefault(); drop.style.borderColor = "var(--border,#2d3748)";
          const f = ev.dataTransfer?.files[0]; if (f) useNewFile(f);
        },
      }, [
        el("div", { style: "font-size:1.05rem;font-weight:600;color:var(--text,#e2e8f0);margin-bottom:0.25rem" }, "Paste a screenshot  ⌘V"),
        el("div", {}, "or drop a datasheet / drawing here · or click to pick a file"),
      ]);
      const filePick = el("input", { type: "file", accept: "image/*,application/pdf,.docx,.xlsx", style: "display:none",
        onchange: (ev) => { const f = ev.target.files[0]; if (f) useNewFile(f); ev.target.value = ""; } });

      const kids = [drop, filePick];
      if (existingImages && existingImages.length) {
        kids.push(el("div", { style: "font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#8b93a1);margin:0.9rem 0 0.4rem" }, "Or use an image already attached"));
        kids.push(el("div", { style: "display:flex;flex-wrap:wrap;gap:0.5rem" }, existingImages.map((img) =>
          el("img", {
            src: img.url, title: `Read ${img.file_name}`,
            style: "width:74px;height:74px;object-fit:cover;border-radius:6px;border:1px solid var(--border,#2d3748);cursor:pointer",
            onclick: () => run({ image_id: img.id }),
          }))));
      }
      body.replaceChildren(...kids);
    }

    // A pasted or dropped file is attached to the component first, so the
    // evidence for every extracted value stays on the record.
    async function useNewFile(file) {
      body.replaceChildren(el("div", { class: "loading", style: "padding:1rem" }, "Uploading…"));
      errEl.textContent = "";
      try {
        const { signedUrl, path } = await API.post(token, "imageUploadUrl", {
          component_id: componentId, fileName: file.name || "paste.png", contentType: file.type || "image/png",
        });
        await new Promise((res, rej) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", signedUrl);
          xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
          xhr.onload = () => xhr.status < 300 ? res() : rej(new Error(`Upload failed: ${xhr.status}`));
          xhr.onerror = () => rej(new Error("Network error"));
          xhr.send(file);
        });
        // Deliberately NOT attached as a component image: a datasheet snap is
        // evidence for one extraction, and keeping it would clutter the gallery
        // and the component's version history. The server deletes it after
        // reading, so it never outlives the request.
        await run({ storage_path: path, file_name: file.name || "paste.png", ephemeral: true });
      } catch (ex) {
        errEl.textContent = ex.message;
        renderSourcePicker();
      }
    }

    // ---- step 2: extract --------------------------------------------------
    async function run(source) {
      body.replaceChildren(el("div", { class: "loading", style: "padding:1.5rem;text-align:center" }, "Reading the document…"));
      errEl.textContent = "";
      try {
        const [res, meta] = await Promise.all([
          API.post(token, "extractComponentSpecs", { component_id: componentId, ...source }),
          API.post(token, "getComponentMetadata", { component_id: componentId }).catch(() => ({ metadata: {} })),
        ]);
        current = meta.metadata || {};   // null until a component has a metadata row
        renderResults(res);
      } catch (ex) {
        errEl.textContent = ex.message;
        renderSourcePicker();
      }
    }

    // ---- step 3: review and apply ----------------------------------------
    function renderResults(res) {
      const rows = res.fields || [];
      if (!rows.length) {
        body.replaceChildren(
          el("p", { style: "padding:1rem;font-size:0.9rem" }, "Nothing could be read from that document."),
          el("p", { style: "padding:0 1rem;font-size:0.82rem;color:var(--muted,#8b93a1)" }, res.summary || ""),
        );
        return;
      }
      const isEmpty = (k) => current[k] === null || current[k] === undefined || current[k] === "";
      const picks = {};
      // Pre-ticked: confident, and the field is empty. A value you typed is
      // never overwritten by default.
      rows.forEach((f) => { picks[f.key] = f.confidence !== "low" && isEmpty(f.key); });
      const unmappedPicks = {};
      (res.unmapped || []).forEach((u, i) => { unmappedPicks[i] = false; });

      const applyBtn = el("button", { class: "btn btn-sm btn-primary", type: "button" }, "Apply");
      const syncApply = () => {
        const n = Object.values(picks).filter(Boolean).length + Object.values(unmappedPicks).filter(Boolean).length;
        applyBtn.textContent = n ? `Apply ${n} field${n > 1 ? "s" : ""}` : "Apply";
        applyBtn.disabled = !n;
      };

      const CONF = { high: ["#2fa564", "high"], medium: ["#e5a326", "medium"], low: ["#e05454", "low"] };
      const GRID = "display:grid;grid-template-columns:1.6rem 12rem 1fr 1fr 4.5rem;gap:0.5rem;align-items:start";

      const head = el("div", { style: `${GRID};padding:0.25rem 0.5rem;font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#8b93a1)` },
        [el("span", {}, ""), el("span", {}, "Field"), el("span", {}, "Current"), el("span", {}, "From document"), el("span", {}, "Conf.")]);

      const fieldRows = rows.map((f) => {
        const cb = el("input", { type: "number", style: "display:none" });
        const box = el("input", { type: "checkbox", style: "cursor:pointer;margin-top:3px" });
        box.checked = picks[f.key];
        box.onchange = () => { picks[f.key] = box.checked; syncApply(); };
        const [col, lbl] = CONF[f.confidence] || CONF.low;
        const cur = current[f.key];
        return el("div", { style: `${GRID};padding:0.4rem 0.5rem;border-top:1px solid var(--border,#2d3748)` }, [
          box,
          el("span", { style: "font-size:0.84rem;font-weight:600" }, AI_FILL_LABELS[f.key] || f.key),
          el("span", { style: `font-size:0.84rem;${isEmpty(f.key) ? "color:var(--muted,#8b93a1);opacity:0.6" : ""}` },
            isEmpty(f.key) ? "— empty —" : String(cur)),
          el("div", {}, [
            el("div", { style: "font-size:0.88rem;font-weight:600" }, String(f.value)),
            f.as_printed ? el("div", { style: "font-size:0.72rem;color:var(--muted,#8b93a1)" }, `as printed: ${f.as_printed}`) : null,
            f.evidence ? el("div", { style: "font-size:0.72rem;color:var(--muted,#8b93a1);font-style:italic;margin-top:2px" }, `“${f.evidence}”`) : null,
          ].filter(Boolean)),
          el("span", { style: `font-size:0.7rem;font-weight:700;color:${col}` }, lbl),
        ]);
      });

      const kids = [];
      if (!res.confident_part_match) {
        kids.push(el("div", { style: "background:#e0545415;border:1px solid #e0545450;border-radius:6px;padding:0.55rem 0.75rem;font-size:0.84rem;margin-bottom:0.6rem" },
          `⚠ This document may not describe this component${res.matched_part ? ` — it looks like "${res.matched_part}"` : ""}. Check each value before applying.`));
      }
      if (res.summary) kids.push(el("p", { style: "margin:0 0 0.5rem;font-size:0.82rem;color:var(--muted,#8b93a1)" }, res.summary));
      kids.push(head, ...fieldRows);

      // Values the document states that no field can hold — the signal for
      // which columns the schema is still missing. Kept in custom_specs.
      if ((res.unmapped || []).length) {
        kids.push(el("div", { style: "font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#8b93a1);margin:0.9rem 0 0.3rem" },
          `No field for these (${res.unmapped.length}) — stored as custom specs`));
        res.unmapped.forEach((u, i) => {
          const box = el("input", { type: "checkbox", style: "cursor:pointer" });
          box.onchange = () => { unmappedPicks[i] = box.checked; syncApply(); };
          kids.push(el("div", { style: "display:grid;grid-template-columns:1.6rem 12rem 1fr;gap:0.5rem;padding:0.3rem 0.5rem;border-top:1px solid var(--border,#2d3748)" }, [
            box,
            el("span", { style: "font-size:0.84rem" }, u.label),
            el("span", { style: "font-size:0.84rem;color:var(--muted,#8b93a1)" }, u.value),
          ]));
        });
      }
      body.replaceChildren(...kids);

      applyBtn.onclick = async () => {
        applyBtn.disabled = true; applyBtn.textContent = "Applying…"; errEl.textContent = "";
        try {
          const payload = { component_id: componentId };
          rows.forEach((f) => { if (picks[f.key]) payload[f.key] = f.value; });
          const custom = { ...(current.custom_specs || {}) };
          (res.unmapped || []).forEach((u, i) => { if (unmappedPicks[i]) custom[u.suggested_key || u.label] = u.value; });
          if (Object.keys(custom).length) payload.custom_specs = custom;
          await API.post(token, "upsertComponentMetadata", payload);
          close();
          openComponentDetail(componentId, token, panel, nodeData, role);
        } catch (ex) {
          errEl.textContent = ex.message;
          applyBtn.disabled = false; syncApply();
        }
      };

      footer.replaceChildren(
        el("button", { class: "btn btn-sm", type: "button", onclick: () => renderSourcePicker() }, "← Different document"),
        el("span", { style: "flex:1" }),
        el("button", { class: "btn btn-sm", type: "button", onclick: close }, "Cancel"),
        applyBtn,
      );
      syncApply();
    }

    const footer = el("div", { style: "display:flex;gap:0.5rem;align-items:center" }, [
      el("span", { style: "flex:1" }),
      el("button", { class: "btn btn-sm", type: "button", onclick: close }, "Cancel"),
    ]);

    // This modal owns the paste while it is open; the panel behind yields
    // because the overlay carries data-modal-overlay.
    function onPaste(ev) {
      if (!overlay.isConnected) { document.removeEventListener("paste", onPaste); return; }
      if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") return;
      const items = ev.clipboardData?.items || [];
      for (const item of items) {
        if (item.type.startsWith("image/")) { ev.preventDefault(); useNewFile(item.getAsFile()); return; }
      }
    }
    document.addEventListener("paste", onPaste);

    dialog.append(
      el("div", { style: "display:flex;align-items:center;justify-content:space-between" }, [
        el("h3", { style: "margin:0;font-size:1.05rem" }, `✨ AI fill — ${nodeData?.name || "component"}`),
        el("button", { class: "btn btn-sm", type: "button", style: "padding:2px 9px", onclick: close }, "✕"),
      ]),
      el("p", { style: "margin:0;font-size:0.82rem;color:var(--muted,#8b93a1)" },
        "Values are proposed, never written straight in. Confident readings of empty fields are pre-ticked; anything you already filled in is left alone unless you tick it."),
      body, errEl, footer,
    );
    overlay.append(dialog);
    document.body.append(overlay);
    renderSourcePicker();
  }

  // --- Component detail panel (slide-in below the tree) ----------------------
  async function openComponentDetail(componentId, token, panel, nodeData, role) {
    panel.style.display = "";
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    panel.replaceChildren(el("div", { class: "loading" }, "Loading…"));
    if (panel.__imgPasteOff) { panel.__imgPasteOff(); delete panel.__imgPasteOff; }
    if (activeImgPasteOff) { activeImgPasteOff(); activeImgPasteOff = null; }
    openDetailComponentId = componentId;
    const isFamily = nodeData?.type === "product_family";
    try {
      const basePromises = [
        API.post(token, "getComponentHistory",    { component_id: componentId }),
        API.post(token, "getComponentDocuments",  { component_id: componentId }),
        API.post(token, "getComponentMaterials",  { component_id: componentId }),
        API.post(token, "getComponentChangelog",  { component_id: componentId }),
        API.post(token, "listParentsOf",          { component_id: componentId }),
        API.post(token, "listComponentImages",    { component_id: componentId }),
        API.post(token, "getComponentMetadata",   { component_id: componentId }),
        API.post(token, "listComponentVariants",  { component_id: componentId }),
      ];
      const familyPromises = isFamily ? [
        API.post(token, "listFamilyAttributes", { family_id: componentId }),
        API.post(token, "listConfigurations",    { family_id: componentId }),
        API.post(token, "listVariantsByFamily",  { family_id: componentId }),
      ] : [null, null, null];
      const [hist, docs, mats, cl, usedIn, imgData, metaR, variantMembershipsR, familyAttrs, familyConfigs, variantsR, compFamiliesR, allFamiliesR, csFieldsR, csUsageR] = await Promise.all([
        ...basePromises, ...familyPromises,
        API.post(token, "listComponentFamilies", { component_id: componentId }),
        API.post(token, "listProductFamilies", {}),
        API.post(token, "listCustomSpecFields", {}).catch(() => ({ fields: [] })),
        API.post(token, "listCustomSpecUsage", {}).catch(() => ({ usage: [] })),
      ]);
      const history = hist.history || [];
      const current = history.find((v) => v.is_current) || history[0];

      // Compute next revision client-side for the preview badge (server is authoritative)
      function revRank(r) {
        let n = 0;
        for (const ch of (r || "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
        return n;
      }
      function nextRevision(revs) {
        const max = revs.length ? revs.reduce((m, r) => revRank(r) > revRank(m) ? r : m) : "";
        let num = 0;
        for (const ch of (max || "").toUpperCase()) num = num * 26 + (ch.charCodeAt(0) - 64);
        num++;
        let result = "";
        while (num > 0) { num--; result = String.fromCharCode(65 + num % 26) + result; num = Math.floor(num / 26); }
        return result;
      }
      const previewRev = nextRevision(history.map((v) => v.revision));

      // Version section
      function renderVersionSnapshot(snap) {
        if (!snap) return el("em", { style: "color:var(--muted,#64748b)" },
          "Snapshot not available — component predates this feature");
        const parts = [];
        if (snap.description) parts.push(
          el("p", { style: "margin:0 0 0.4rem" }, [el("strong", {}, "Description: "), snap.description])
        );
        if (snap.notes) parts.push(
          el("p", { style: "margin:0 0 0.4rem" }, [el("strong", {}, "Notes: "), snap.notes])
        );
        const statusLine = snap.lifecycle_status
          ? snap.lifecycle_status + (snap.replacement_note ? " — " + snap.replacement_note : "") + (snap.flag_reason ? " — " + snap.flag_reason : "")
          : null;
        if (statusLine) parts.push(
          el("p", { style: "margin:0 0 0.75rem" }, [el("strong", {}, "Status: "), statusLine])
        );
        parts.push(
          el("strong", { style: "font-size:0.8rem" }, "Documents (" + (snap.documents || []).length + ")"),
          (snap.documents || []).length
            ? el("div", { class: "table-wrap", style: "margin:0.25rem 0 0.75rem" },
                el("table", { style: "font-size:0.8rem" }, [
                  el("thead", {}, el("tr", {}, ["Category", "Document", "Label"].map((h) => el("th", {}, h)))),
                  el("tbody", {}, (snap.documents || []).map((d) =>
                    el("tr", {}, [el("td", {}, d.category), el("td", {}, d.doc_name || "—"), el("td", {}, d.label || "—")])
                  )),
                ])
              )
            : el("p", { style: "color:var(--muted,#64748b);margin:0.25rem 0 0.75rem;font-size:0.85rem" }, "No documents linked at this revision"),
          el("strong", { style: "font-size:0.8rem" }, "Materials (" + (snap.materials || []).length + ")"),
          (snap.materials || []).length
            ? el("div", { class: "table-wrap", style: "margin:0.25rem 0 0" },
                el("table", { style: "font-size:0.8rem" }, [
                  el("thead", {}, el("tr", {}, ["Substance", "CAS", "% w/w", "SVHC", "RoHS"].map((h) => el("th", {}, h)))),
                  el("tbody", {}, (snap.materials || []).map((m) =>
                    el("tr", {}, [
                      el("td", {}, m.substance_name), el("td", {}, m.cas_number || "—"),
                      el("td", {}, m.percentage_w_w != null ? m.percentage_w_w + "%" : "—"),
                      el("td", {}, m.reach_svhc ? "Yes" : "No"),
                      el("td", {}, m.rohs_restricted ? "Yes" : "No"),
                    ])
                  )),
                ])
              )
            : el("p", { style: "color:var(--muted,#64748b);margin:0.25rem 0 0;font-size:0.85rem" }, "No materials declared at this revision"),
        );
        return el("div", {}, parts);
      }
      const versionRows = [];
      for (const v of history) {
        const indicator = el("span", { style: "font-size:0.7rem;margin-right:0.3rem;color:var(--muted,#64748b)" }, "▸");
        const detailRow = el("tr", { style: "display:none" }, [
          el("td", { colspan: "4", style: "padding:0.75rem 1rem 0.85rem;background:var(--subtle,#f8fafc);border-bottom:1px solid var(--border,#e2e8f0)" },
            renderVersionSnapshot(v.version_snapshot)
          ),
        ]);
        const headerRow = el("tr", { style: "cursor:pointer", onclick: () => {
          const open = detailRow.style.display === "none";
          detailRow.style.display = open ? "" : "none";
          indicator.textContent = open ? "▾" : "▸";
        }}, [
          el("td", {}, [indicator, v.revision]),
          el("td", {}, v.spec_summary || "—"),
          el("td", {}, v.is_current ? el("strong", {}, "current") : ""),
          el("td", {}, v.created_at ? new Date(v.created_at).toLocaleDateString("sv") : ""),
        ]);
        versionRows.push(headerRow, detailRow);
      }
      const bumpSumInput = el("input", { class: "up-text", type: "text", placeholder: "What changed in this revision", style: "flex:1;min-width:12rem" });
      const bumpErr = el("span", { class: "form-error" }, "");
      const bumpForm = el("form", { style: "display:flex;gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap;align-items:center", onsubmit: async (e) => {
        e.preventDefault();
        const summary = bumpSumInput.value.trim();
        const btn = bumpForm.querySelector("button");
        btn.disabled = true; btn.textContent = "…";
        try {
          await API.post(token, "bumpComponentVersion", { component_id: componentId, spec_summary: summary || null });
          await openComponentDetail(componentId, token, panel, nodeData, role);
        } catch (ex) {
          bumpErr.textContent = ex.message;
          btn.disabled = false; btn.textContent = "Bump version";
        }
      } });
      bumpForm.append(
        el("span", { style: "font-size:0.8rem;font-weight:600;white-space:nowrap;background:var(--subtle,#f1f5f9);padding:0.38rem 0.7rem;border-radius:6px;border:1px solid var(--border,#e2e8f0);color:var(--muted,#64748b)" }, `Next: ${previewRev}`),
        bumpSumInput,
        el("button", { class: "btn btn-sm btn-primary", type: "submit" }, "Bump version"),
        bumpErr,
      );

      const versionsSection = el("div", {}, [
        el("h4", {}, "Versions"),
        el("div", { class: "table-wrap" }, el("table", { style: "font-size:0.85rem" }, [
          el("thead", {}, el("tr", {}, ["Revision", "Summary", "Status", "Created"].map((h) => el("th", {}, h)))),
          el("tbody", {}, versionRows),
        ])),
        bumpForm,
      ]);

      // Documents section
      const docRows = (docs.documents || []).map((d) =>
        el("tr", {}, [
          el("td", {}, d.category), el("td", {}, d.label || d.document_name || "—"),
          el("td", {}, d.is_supplier_visible ? "Yes" : "No"),
        ]));

      function openAddDocModal() {
        const overlay = el("div", { "data-modal-overlay": "", style: "position:fixed;inset:0;background:#0009;z-index:2000;display:flex;align-items:center;justify-content:center" });
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        const box = el("div", { style: "background:var(--bg,#fff);border-radius:8px;padding:1.5rem;width:min(520px,95vw);max-height:90vh;overflow-y:auto" });
        overlay.append(box);
        document.body.append(overlay);

        const CATS = ["datasheet", "drawing", "test_report", "declaration", "quality_cert", "other"];

        function tabBar(active) {
          return el("div", { style: "display:flex;gap:4px;margin-bottom:0.8rem" }, [
            el("button", { class: `btn btn-sm${active === "link" ? " btn-primary" : ""}`, type: "button",
              onclick: () => { if (active !== "link") renderLinkTab(); } }, "Link existing"),
            el("button", { class: `btn btn-sm${active === "upload" ? " btn-primary" : ""}`, type: "button",
              onclick: () => { if (active !== "upload") renderUploadTab(); } }, "Upload & link"),
          ]);
        }

        function renderLinkTab() {
          box.replaceChildren(el("div", { class: "loading" }, "Loading…"));
          API.post(token, "data", {}).then(({ documents: allDocs }) => {
            const versions = [];
            (allDocs || []).forEach((doc) => (doc.versions || []).forEach((v) => versions.push({ id: v.id, display: `${doc.name} — v${v.version || v.created_at?.slice(0, 10)}` })));
            const statusEl = el("span", { role: "status", style: "font-size:0.8rem;color:#e05454;display:block;min-height:1.2em" }, "");
            if (!versions.length) {
              box.replaceChildren(
                el("h3", { style: "margin:0 0 0.8rem;font-size:1rem" }, "Add document to component"),
                tabBar("link"),
                el("p", { class: "notice" }, "No documents in library yet. Use 'Upload & link' to add one now."),
                el("div", { style: "display:flex;justify-content:flex-end;margin-top:0.8rem" }, [
                  el("button", { class: "btn btn-sm", type: "button", onclick: () => overlay.remove() }, "Cancel"),
                ]),
              );
              return;
            }
            const dvSel = el("select", { class: "up-text", style: "width:100%;margin-top:4px" }, versions.map((v) => el("option", { value: v.id }, v.display)));
            const catSel = el("select", { class: "up-text", style: "margin-top:4px" }, CATS.map((c) => el("option", { value: c }, c)));
            const labelInp = el("input", { class: "up-text", type: "text", placeholder: "Optional label", style: "margin-top:4px" });
            const supVis = el("input", { type: "checkbox" });
            box.replaceChildren(
              el("h3", { style: "margin:0 0 0.8rem;font-size:1rem" }, "Add document to component"),
              tabBar("link"),
              el("div", { style: "margin-bottom:0.6rem" }, [el("div", { class: "form-label" }, "Document version"), dvSel]),
              el("div", { style: "margin-bottom:0.6rem" }, [el("div", { class: "form-label" }, "Category"), catSel]),
              el("div", { style: "margin-bottom:0.6rem" }, [el("div", { class: "form-label" }, "Label (optional)"), labelInp]),
              el("div", { style: "display:flex;align-items:center;gap:0.4rem;margin-bottom:0.9rem" }, [supVis, el("span", { style: "font-size:0.85rem" }, "Supplier visible")]),
              statusEl,
              el("div", { style: "display:flex;justify-content:flex-end;gap:0.5rem" }, [
                el("button", { class: "btn btn-sm", type: "button", onclick: () => overlay.remove() }, "Cancel"),
                el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: async (ev) => {
                  ev.target.disabled = true; statusEl.textContent = "";
                  try {
                    await API.post(token, "addComponentDocument", { component_id: componentId, document_version_id: dvSel.value, category: catSel.value, label: labelInp.value.trim() || null, is_supplier_visible: supVis.checked });
                    overlay.remove();
                    openComponentDetail(componentId, token, panel, nodeData, role);
                  } catch (ex) { statusEl.textContent = ex.message; ev.target.disabled = false; }
                } }, "Link"),
              ]),
            );
          }).catch((ex) => { box.replaceChildren(el("div", { class: "error" }, `Couldn't load: ${ex.message}`)); });
        }

        function renderUploadTab() {
          let selectedFile = null;
          const statusEl = el("span", { role: "status", style: "font-size:0.8rem;color:#e05454;display:block;min-height:1.2em" }, "");
          const barFill = el("div", { style: "height:100%;background:var(--accent,#2fa564);width:0%;transition:width 0.15s" });
          const progressEl = el("div", { style: "display:none;height:6px;background:var(--border,#e2e8f0);border-radius:3px;overflow:hidden;margin-bottom:0.5rem" }, barFill);
          const nameInp = el("input", { class: "up-text", type: "text", placeholder: "Document name", style: "margin-top:4px" });
          const docCatSel = el("select", { class: "up-text", style: "margin-top:4px" }, CATS.map((c) => el("option", { value: c }, c)));
          const verInp = el("input", { class: "up-text", type: "text", placeholder: "Version label (auto-numbered if blank)", style: "margin-top:4px" });
          const linkCatSel = el("select", { class: "up-text", style: "margin-top:4px" }, CATS.map((c) => el("option", { value: c }, c)));
          const labelInp = el("input", { class: "up-text", type: "text", placeholder: "Optional label", style: "margin-top:4px" });
          const supVis = el("input", { type: "checkbox" });
          const fileLabel = el("span", { style: "font-size:0.8rem;color:var(--muted,#8b93a1);display:block;margin-top:2px" }, "No file chosen");
          const fileInp = el("input", { type: "file", style: "margin-top:4px" });
          fileInp.onchange = () => {
            const f = fileInp.files?.[0];
            selectedFile = f || null;
            fileLabel.textContent = f ? f.name : "No file chosen";
            if (f && !nameInp.value.trim()) nameInp.value = f.name.replace(/\.[^.]+$/, "");
          };
          box.replaceChildren(
            el("h3", { style: "margin:0 0 0.8rem;font-size:1rem" }, "Add document to component"),
            tabBar("upload"),
            el("div", { style: "margin-bottom:0.6rem" }, [el("div", { class: "form-label" }, "File"), fileInp, fileLabel]),
            el("div", { style: "margin-bottom:0.6rem" }, [el("div", { class: "form-label" }, "Document name"), nameInp]),
            el("div", { style: "margin-bottom:0.6rem" }, [el("div", { class: "form-label" }, "Document category"), docCatSel]),
            el("div", { style: "margin-bottom:0.6rem" }, [el("div", { class: "form-label" }, "Version label"), verInp]),
            el("div", { style: "margin-bottom:0.6rem" }, [el("div", { class: "form-label" }, "Link category (component context)"), linkCatSel]),
            el("div", { style: "margin-bottom:0.6rem" }, [el("div", { class: "form-label" }, "Label (optional)"), labelInp]),
            el("div", { style: "display:flex;align-items:center;gap:0.4rem;margin-bottom:0.9rem" }, [supVis, el("span", { style: "font-size:0.85rem" }, "Supplier visible")]),
            progressEl,
            statusEl,
            el("div", { style: "display:flex;justify-content:flex-end;gap:0.5rem" }, [
              el("button", { class: "btn btn-sm", type: "button", onclick: () => overlay.remove() }, "Cancel"),
              el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: async (ev) => {
                if (!selectedFile) { statusEl.textContent = "Pick a file first."; return; }
                if (!nameInp.value.trim()) { statusEl.textContent = "Document name is required."; return; }
                ev.target.disabled = true; statusEl.textContent = "Uploading…";
                progressEl.style.display = "";
                try {
                  const { signedUrl, path } = await API.post(token, "docUploadUrl", { fileName: selectedFile.name });
                  await xhrPut(signedUrl, selectedFile, (p) => { barFill.style.width = `${p}%`; });
                  barFill.style.width = "100%";
                  statusEl.textContent = "Linking…";
                  await API.post(token, "uploadAndLinkComponentDocument", {
                    component_id: componentId, storage_path: path, file_name: selectedFile.name,
                    doc_name: nameInp.value.trim(), doc_category: docCatSel.value,
                    version: verInp.value.trim() || null, comp_category: linkCatSel.value,
                    label: labelInp.value.trim() || null, is_supplier_visible: supVis.checked,
                  });
                  overlay.remove();
                  openComponentDetail(componentId, token, panel, nodeData, role);
                } catch (ex) {
                  statusEl.textContent = ex.message;
                  ev.target.disabled = false;
                  barFill.style.width = "0%";
                  progressEl.style.display = "none";
                }
              } }, "Upload & link"),
            ]),
          );
        }

        renderLinkTab();
      }

      const docsSection = el("div", { style: "margin-top:1rem" }, [
        el("div", { style: "display:flex;align-items:center;gap:0.6rem;margin-bottom:0.4rem" }, [
          el("h4", { style: "margin:0" }, "Documents"),
          el("button", { class: "btn btn-sm btn-primary", type: "button", style: "font-size:0.72rem;padding:1px 8px", onclick: () => openAddDocModal() }, "+ Add document"),
        ]),
        docRows.length ? el("div", { class: "table-wrap" }, el("table", { style: "font-size:0.85rem" }, [
          el("thead", {}, el("tr", {}, ["Category", "Name", "Supplier visible"].map((h) => el("th", {}, h)))),
          el("tbody", {}, docRows),
        ])) : el("div", { class: "muted" }, "No documents attached yet."),
      ]);

      // Materials section
      const matRows = (mats.materials || []).map((m) =>
        el("tr", {}, [
          el("td", {}, m.substance_name), el("td", {}, m.cas_number || "—"),
          el("td", {}, m.percentage_w_w != null ? `${m.percentage_w_w}%` : "—"),
          el("td", {}, m.reach_svhc ? "Yes" : "No"),
          el("td", {}, m.rohs_restricted ? "Yes" : "No"),
        ]));
      const matsSection = el("div", { style: "margin-top:1rem" }, [
        el("h4", {}, "Materials (REACH / RoHS)"),
        matRows.length ? el("div", { class: "table-wrap" }, el("table", { style: "font-size:0.85rem" }, [
          el("thead", {}, el("tr", {}, ["Substance", "CAS", "% w/w", "SVHC", "RoHS restricted"].map((h) => el("th", {}, h)))),
          el("tbody", {}, matRows),
        ])) : el("div", { class: "muted" }, "No substance data yet."),
      ]);

      // Change log section — immutable trigger-sourced audit trail
      const changelog = cl.changelog || [];
      const clRows = changelog.map((entry, i) => {
        const prev = changelog[i + 1]; // next oldest entry
        function diff(field, label) {
          if (!prev) return null;
          const a = prev[field], b = entry[field];
          if (a === b || (a == null && b == null)) return null;
          return el("div", { style: "font-size:0.75rem;color:var(--muted,#8b93a1);margin-top:1px" },
            [el("span", { style: "font-weight:600;color:var(--text,#1a1f2e)" }, label + ": "),
             el("span", { style: "text-decoration:line-through;opacity:0.6;margin-right:4px" }, a || "—"),
             "→ ",
             el("span", { style: "color:var(--accent,#2fa564)" }, b || "—")]);
        }
        const isFieldEvent = entry.change_type === "created" || entry.change_type === "updated";
        const diffs = isFieldEvent ? [
          diff("part_number",      "Part #"),
          diff("oem_number",       "OEM #"),
          diff("name",             "Name"),
          diff("type",             "Type"),
          diff("description",      "Description"),
          diff("lifecycle_status", "Status"),
        ].filter(Boolean) : [];

        const BADGE_COLORS = {
          created:         ["#2fa56420", "#2fa564"],
          updated:         ["#4a9eed20", "#4a9eed"],
          version_bumped:  ["#a855f720", "#a855f7"],
          document_linked: ["#f59e0b20", "#f59e0b"],
        };
        const [bg, fg] = BADGE_COLORS[entry.change_type] || ["#8b93a120", "#8b93a1"];
        const badgeLabel = { created: "created", updated: "updated", version_bumped: "revision", document_linked: "document" }[entry.change_type] || entry.change_type;

        let changeCell;
        if (diffs.length) {
          changeCell = el("div", {}, diffs);
        } else if (!isFieldEvent && entry.notes) {
          changeCell = el("span", { style: "font-size:0.75rem;color:var(--text,#1a1f2e)" }, entry.notes);
        } else {
          changeCell = el("span", { style: "font-size:0.75rem;color:var(--muted,#8b93a1)" }, entry.change_type === "created" ? "Initial record" : "No field changes");
        }

        return el("tr", {}, [
          el("td", { style: "white-space:nowrap;font-size:0.8rem" },
            new Date(entry.changed_at).toLocaleString("sv", { dateStyle: "short", timeStyle: "short" })),
          el("td", { style: "font-size:0.8rem" },
            el("span", { style: `display:inline-block;padding:1px 6px;border-radius:99px;font-size:0.72rem;font-weight:600;background:${bg};color:${fg}` }, badgeLabel)),
          el("td", {}, changeCell),
        ]);
      });

      const usedInParents = (usedIn && usedIn.parents) || [];
      const usedInSection = el("div", { style: "margin-top:1rem" }, [
        el("h4", {}, "Used in"),
        usedInParents.length
          ? el("div", { class: "table-wrap" }, el("table", { style: "font-size:0.85rem" }, [
              el("thead", {}, el("tr", {}, ["Assembly", "Part #", "Qty", "Ref"].map((h) => el("th", {}, h)))),
              el("tbody", {}, usedInParents.map((p) => el("tr", {}, [
                el("td", {}, p.parent ? p.parent.name : "—"),
                el("td", { style: "font-family:monospace;font-size:0.78rem;color:var(--muted,#8b93a1)" }, p.parent ? p.parent.part_number : "—"),
                el("td", {}, `×${p.quantity}`),
                el("td", { style: "color:var(--muted,#8b93a1)" }, p.reference_designator || "—"),
              ]))),
            ]))
          : el("div", { style: "font-size:0.85rem;color:var(--muted,#8b93a1);margin-top:0.25rem" }, "Not linked in any assembly."),
      ]);

      const changelogSection = el("div", { style: "margin-top:1.25rem" }, [
        el("h4", { style: "margin-bottom:0.4rem" }, "Change Log"),
        el("p", { style: "font-size:0.75rem;color:var(--muted,#8b93a1);margin:0 0 0.5rem" },
          "Immutable audit trail — every field change captured automatically by the database."),
        clRows.length
          ? el("div", { class: "table-wrap" }, el("table", { style: "font-size:0.85rem;width:100%" }, [
              el("thead", {}, el("tr", {}, ["Date", "Event", "Changes"].map((h) => el("th", {}, h)))),
              el("tbody", {}, clRows),
            ]))
          : el("div", { class: "muted" }, "No history yet — changes will appear here automatically."),
      ]);

      // Configuration section — only for product_family nodes
      let configSection = null;
      if (isFamily && familyAttrs) {
        const attrs = familyAttrs.attributes || [];
        const LBL = "display:block;font-size:0.8rem;font-weight:600;color:var(--muted,#8b93a1);margin-bottom:0.2rem";
        const attrList = el("div", {});
        function renderAttrs() {
          attrList.replaceChildren(...attrs.map((attr) => {
            const valTags = (attr.values || []).map((v) =>
              el("span", { style: "display:inline-flex;align-items:center;gap:0.25rem;background:var(--subtle,#f1f5f9);border:1px solid var(--border,#e2e8f0);border-radius:4px;padding:1px 6px;font-size:0.76rem;margin-right:3px" }, [
                v.label,
                el("button", { type: "button", style: "background:none;border:none;cursor:pointer;color:#e05454;font-size:0.65rem;padding:0;line-height:1", onclick: async () => {
                  if (!confirm(`Delete value "${v.label}"?`)) return;
                  try {
                    await API.post(token, "deleteFamilyAttributeValue", { value_id: v.id });
                    attr.values = attr.values.filter((x) => x.id !== v.id);
                    renderAttrs();
                  } catch (ex) { alert(ex.message); }
                } }, "✕"),
              ]));
            const addValInput = el("input", { class: "up-text", type: "text", placeholder: "Add value…", style: "width:140px;font-size:0.8rem;padding:0.2rem 0.4rem;margin-left:4px" });
            const addValBtn = el("button", { class: "btn btn-sm", type: "button", style: "padding:1px 6px;font-size:0.75rem;margin-left:2px", onclick: async () => {
              const raw = addValInput.value.trim();
              if (!raw) return;
              try {
                const r = await API.post(token, "addFamilyAttributeValue", { attribute_id: attr.id, value: raw, label: raw });
                attr.values = [...(attr.values || []), { id: r.id, value: raw, label: raw }];
                addValInput.value = "";
                renderAttrs();
              } catch (ex) { alert(ex.message); }
            } }, "+ value");
            const delAttrBtn = el("button", { class: "btn btn-sm", type: "button", style: "padding:1px 6px;font-size:0.7rem;color:#e05454;border-color:#e0545440;margin-left:4px", onclick: async () => {
              if (!confirm(`Delete attribute "${attr.display_name}" and all its values?`)) return;
              try {
                await API.post(token, "deleteFamilyAttribute", { attribute_id: attr.id });
                attrs.splice(attrs.indexOf(attr), 1);
                renderAttrs();
              } catch (ex) { alert(ex.message); }
            } }, "✕ attr");
            return el("div", { style: "margin-bottom:0.55rem;padding:0.4rem 0.6rem;border:1px solid var(--border,#e2e8f0);border-radius:6px" }, [
              el("div", { style: "display:flex;align-items:center;gap:0.4rem;margin-bottom:0.3rem" }, [
                el("strong", { style: "font-size:0.83rem" }, attr.display_name),
                el("span", { style: "font-size:0.72rem;color:var(--muted,#8b93a1)" }, attr.is_required ? "(required)" : "(optional)"),
                delAttrBtn,
              ]),
              el("div", { style: "display:flex;flex-wrap:wrap;align-items:center;gap:2px" }, [...valTags, addValInput, addValBtn]),
            ]);
          }));
          if (!attrs.length) attrList.replaceChildren(el("div", { style: "font-size:0.82rem;color:var(--muted,#8b93a1)" }, "No attributes yet."));
        }
        renderAttrs();

        const newAttrName = el("input", { class: "up-text", type: "text", placeholder: "name (key)", style: "width:110px;font-size:0.8rem;padding:0.25rem 0.4rem" });
        const newAttrLabel = el("input", { class: "up-text", type: "text", placeholder: "display label", style: "width:130px;font-size:0.8rem;padding:0.25rem 0.4rem" });
        const newAttrReq = el("input", { type: "checkbox", checked: true, style: "margin-right:2px" });
        const addAttrBtn = el("button", { class: "btn btn-sm btn-primary", type: "button", style: "padding:2px 8px;font-size:0.78rem", onclick: async () => {
          const nm = newAttrName.value.trim(); const dl = newAttrLabel.value.trim();
          if (!nm || !dl) { alert("Both name and label are required."); return; }
          try {
            const r = await API.post(token, "addFamilyAttribute", { family_id: componentId, name: nm, display_name: dl, is_required: newAttrReq.checked });
            attrs.push({ id: r.id, name: nm, display_name: dl, is_required: newAttrReq.checked, values: [] });
            newAttrName.value = ""; newAttrLabel.value = "";
            renderAttrs();
          } catch (ex) { alert(ex.message); }
        } }, "+ Add attribute");

        function openMaterialiseModal(cfg, tkn, onRefresh) {
          const pnInput  = el("input", { class: "up-text", type: "text", placeholder: "Part number (auto-generated if blank)", style: "width:100%;box-sizing:border-box", value: cfg.part_number || "" });
          const nmInput  = el("input", { class: "up-text", type: "text", placeholder: "Name", style: "width:100%;box-sizing:border-box", value: cfg.name || "" });
          const notesInput = el("textarea", { class: "up-text", rows: "2", placeholder: "Notes (optional)", style: "width:100%;box-sizing:border-box;resize:vertical" });
          const errSpan  = el("span", { style: "color:#e05454;font-size:0.8rem;min-height:1.1em;display:block" }, "");
          const submitBtn = el("button", { class: "btn btn-primary", type: "button", onclick: async () => {
            submitBtn.disabled = true; errSpan.textContent = "";
            try {
              await API.post(tkn, "materialiseConfiguration", {
                saved_configuration_id: cfg.id,
                part_number: pnInput.value.trim() || null,
                name: nmInput.value.trim() || null,
                notes: notesInput.value.trim() || null,
              });
              overlay.remove();
              onRefresh();
            } catch (ex) { errSpan.textContent = ex.message; submitBtn.disabled = false; }
          } }, "Create Stocked Variant");
          const overlay = el("div", { "data-modal-overlay": "", style: "position:fixed;inset:0;background:#0007;z-index:2000;display:flex;align-items:center;justify-content:center", onclick: (ev) => { if (ev.target === overlay) overlay.remove(); } }, [
            el("div", { style: "background:var(--surface,#fff);border-radius:8px;padding:1.25rem;width:min(440px,95vw);display:flex;flex-direction:column;gap:0.6rem", onclick: (ev) => ev.stopPropagation() }, [
              el("h4", { style: "margin:0;font-size:1rem" }, `Materialise "${cfg.name}" as Stocked Variant`),
              el("div", { style: "font-size:0.8rem;color:var(--muted,#8b93a1)" }, Object.entries(cfg.selections || {}).map(([k, v]) => `${k}: ${v}`).join("  ·  ")),
              el("label", { style: "font-size:0.82rem;font-weight:600" }, ["Part number", pnInput]),
              el("label", { style: "font-size:0.82rem;font-weight:600" }, ["Name", nmInput]),
              el("label", { style: "font-size:0.82rem;font-weight:600" }, ["Notes", notesInput]),
              errSpan,
              el("div", { style: "display:flex;gap:0.5rem;justify-content:flex-end" }, [
                el("button", { class: "btn", type: "button", onclick: () => overlay.remove() }, "Cancel"),
                submitBtn,
              ]),
            ]),
          ]);
          document.body.appendChild(overlay);
        }

        const cfgs = familyConfigs?.configurations || [];
        const refresh = () => openComponentDetail(componentId, token, panel, nodeData, role);
        const cfgList = cfgs.length
          ? el("div", {}, cfgs.map((cfg) => el("div", { style: "display:flex;align-items:center;justify-content:space-between;padding:0.3rem 0.5rem;border:1px solid var(--border,#e2e8f0);border-radius:5px;margin-bottom:3px;font-size:0.82rem" }, [
              el("span", {}, [el("strong", {}, cfg.name), cfg.part_number ? el("span", { style: "color:var(--muted,#8b93a1);margin-left:0.4rem;font-family:monospace;font-size:0.76rem" }, cfg.part_number) : null,
                el("span", { style: "color:var(--muted,#8b93a1);margin-left:0.4rem;font-size:0.73rem" }, Object.entries(cfg.selections).map(([k, v]) => `${k}:${v}`).join(", ")),
              ].filter(Boolean)),
              el("div", { style: "display:flex;gap:0.3rem;flex-shrink:0" }, [
                el("button", { class: "btn btn-sm btn-primary", type: "button", style: "padding:1px 7px;font-size:0.7rem", onclick: () => openMaterialiseModal(cfg, token, refresh) }, "Stock"),
                el("button", { class: "btn btn-sm", type: "button", style: "padding:1px 5px;font-size:0.7rem;color:#e05454;border-color:#e0545440", onclick: async () => {
                  if (!confirm(`Delete configuration "${cfg.name}"?`)) return;
                  try { await API.post(token, "deleteConfiguration", { configuration_id: cfg.id }); refresh(); } catch (ex) { alert(ex.message); }
                } }, "Delete"),
              ]),
            ])))
          : el("div", { style: "font-size:0.82rem;color:var(--muted,#8b93a1)" }, "No saved configurations yet. Configurations will be imported from the order system (PROP-018).");

        const stockedVariants = variantsR?.variants || [];
        const LIFECYCLE_COLORS = { active: "#2fa564", inactive: "#8b93a1", replaced: "#d97706", flagged: "#e05454" };
        const variantsList = stockedVariants.length
          ? el("div", {}, stockedVariants.map((v) => {
              const lcColor = LIFECYCLE_COLORS[v.lifecycle_status] || "#8b93a1";
              return el("div", { style: "display:flex;align-items:center;justify-content:space-between;padding:0.3rem 0.5rem;border:1px solid var(--border,#e2e8f0);border-radius:5px;margin-bottom:3px;font-size:0.82rem" }, [
                el("span", {}, [
                  el("strong", {}, v.name),
                  el("span", { style: "font-family:monospace;font-size:0.76rem;color:var(--muted,#8b93a1);margin-left:0.4rem" }, v.part_number),
                  v.config_selections ? el("span", { style: "color:var(--muted,#8b93a1);margin-left:0.4rem;font-size:0.73rem" }, Object.entries(v.config_selections).map(([k, vv]) => `${k}:${vv}`).join(", ")) : null,
                ].filter(Boolean)),
                el("div", { style: "display:flex;align-items:center;gap:0.35rem;flex-shrink:0" }, [
                  el("span", { style: `font-size:0.7rem;padding:1px 6px;border-radius:10px;background:${lcColor}22;color:${lcColor};font-weight:600;text-transform:capitalize` }, v.lifecycle_status || "inactive"),
                  el("button", { class: "btn btn-sm", type: "button", style: "padding:1px 7px;font-size:0.7rem", onclick: () => openComponentDetail(v.id, token, panel, v, role) }, "Open →"),
                ]),
              ]);
            }))
          : el("div", { style: "font-size:0.82rem;color:var(--muted,#8b93a1)" }, "No stocked variants yet. Click Stock on a configuration above to materialise one.");

        configSection = el("div", { style: "margin-bottom:1rem;border:1px solid #2fa56440;border-radius:6px;padding:0.75rem" }, [
          el("h4", { style: "margin:0 0 0.5rem;color:#2fa564" }, "Dynamic BOM — Variant Setup"),
          el("div", { style: "margin-bottom:0.6rem" }, [el("label", { style: LBL }, "Attributes"), attrList]),
          el("div", { style: "display:flex;flex-wrap:wrap;align-items:center;gap:0.35rem;margin-bottom:0.75rem" }, [
            newAttrName, newAttrLabel,
            el("label", { style: "display:flex;align-items:center;gap:0.2rem;font-size:0.78rem;white-space:nowrap" }, [newAttrReq, "Required"]),
            addAttrBtn,
          ]),
          el("div", { style: "margin-bottom:0.75rem" }, [el("label", { style: LBL }, "Saved Configurations"), cfgList]),
          el("div", {}, [el("label", { style: LBL }, "Stocked Variants (PROP-033)"), variantsList]),
        ]);
      }

      // Images section (PROP-026) -----------------------------------------------
      const imgStatus = el("span", { style: "font-size:0.78rem;color:#e05454;min-height:1.1em;display:block" }, "");
      const imgGrid = el("div", { style: "display:flex;flex-wrap:wrap;gap:0.5rem;margin-top:0.5rem;min-height:2rem" });

      function openLightbox(images, startIndex) {
        let idx = startIndex ?? 0;
        const multi = images.length > 1;

        const imgEl = el("img", {
          style: "max-width:min(90vw,860px);max-height:82vh;border-radius:6px;box-shadow:0 4px 32px #0008;display:block;object-fit:contain",
          onclick: (ev) => ev.stopPropagation(),
        });
        const counter = el("div", {
          style: "color:rgba(255,255,255,0.6);font-size:0.78rem;margin-top:0.5rem;text-align:center;min-height:1.1em",
        });

        function show(i) {
          idx = ((i % images.length) + images.length) % images.length;
          imgEl.src = images[idx].url;
          counter.textContent = multi ? `${idx + 1} / ${images.length}` : "";
        }

        const navBtnStyle = "background:#fff2;border:1px solid #fff3;border-radius:50%;width:42px;height:42px;color:#fff;font-size:1.4rem;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1;padding:0";
        const prevBtn = multi ? el("button", { type: "button", style: navBtnStyle, title: "Previous (←)", onclick: (ev) => { ev.stopPropagation(); show(idx - 1); } }, "‹") : null;
        const nextBtn = multi ? el("button", { type: "button", style: navBtnStyle, title: "Next (→)",     onclick: (ev) => { ev.stopPropagation(); show(idx + 1); } }, "›") : null;

        function onKey(ev) {
          if (ev.key === "ArrowLeft"  || ev.key === "ArrowUp")    { ev.preventDefault(); if (multi) show(idx - 1); }
          if (ev.key === "ArrowRight" || ev.key === "ArrowDown")   { ev.preventDefault(); if (multi) show(idx + 1); }
          if (ev.key === "Escape") close();
        }
        function close() { over.remove(); document.removeEventListener("keydown", onKey); }

        const over = el("div", {
          "data-modal-overlay": "",
          style: "position:fixed;inset:0;background:#000c;z-index:3000;display:flex;flex-direction:column;align-items:center;justify-content:center",
          onclick: close,
        });
        over.append(
          el("div", { style: "display:flex;align-items:center;gap:1rem" }, [prevBtn, imgEl, nextBtn].filter(Boolean)),
          counter,
        );
        document.addEventListener("keydown", onKey);
        show(idx);
        document.body.append(over);
      }

      function renderImgGrid(images) {
        if (!images.length) {
          imgGrid.replaceChildren(el("div", { style: "font-size:0.82rem;color:var(--muted,#8b93a1)" }, "No images yet."));
          return;
        }
        imgGrid.replaceChildren(...images.map((img, i) => {
          const wrap = el("div", { style: "position:relative;display:inline-block" });
          const thumb = el("img", { src: img.url, style: "width:80px;height:80px;object-fit:cover;border-radius:4px;border:1px solid var(--border,#e2e8f0);cursor:pointer;display:block", title: img.file_name, onclick: () => openLightbox(images, i) });
          const delBtn = el("button", { type: "button", style: "position:absolute;top:2px;right:2px;background:#000a;border:none;border-radius:50%;width:18px;height:18px;color:#fff;font-size:0.55rem;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1", onclick: async (ev) => {
            ev.stopPropagation();
            if (!confirm(`Delete "${img.file_name}"?`)) return;
            imgStatus.textContent = "Deleting…";
            try {
              await API.post(token, "deleteComponentImage", { image_id: img.id });
              imgStatus.textContent = "";
              const fresh = await API.post(token, "listComponentImages", { component_id: componentId });
              renderImgGrid(fresh.images || []);
            } catch (ex) { imgStatus.textContent = ex.message; }
          } }, "✕");
          wrap.append(thumb, delBtn);
          return wrap;
        }));
      }
      renderImgGrid(imgData?.images || []);

      async function uploadImage(file) {
        const ALLOWED = ["image/png", "image/jpeg", "image/webp", "image/gif"];
        if (!ALLOWED.includes(file.type)) { alert("Only PNG, JPEG, WEBP, or GIF are supported."); return; }
        imgStatus.textContent = "Uploading…";
        try {
          const { signedUrl, path } = await API.post(token, "imageUploadUrl", {
            component_id: componentId, fileName: file.name || "paste.png", contentType: file.type,
          });
          await new Promise((res, rej) => {
            const xhr = new XMLHttpRequest();
            xhr.open("PUT", signedUrl);
            xhr.setRequestHeader("Content-Type", file.type);
            xhr.onload = () => xhr.status < 300 ? res() : rej(new Error(`Upload failed: ${xhr.status}`));
            xhr.onerror = () => rej(new Error("Network error"));
            xhr.send(file);
          });
          await API.post(token, "addComponentImage", {
            component_id: componentId, storage_path: path,
            file_name: file.name || "paste.png", content_type: file.type,
          });
          imgStatus.textContent = "";
          const fresh = await API.post(token, "listComponentImages", { component_id: componentId });
          renderImgGrid(fresh.images || []);
        } catch (ex) { imgStatus.textContent = ex.message; }
      }

      const imgFileInput = el("input", { type: "file", accept: "image/*", style: "display:none", onchange: (ev) => {
        const f = ev.target.files[0];
        if (f) uploadImage(f);
        imgFileInput.value = "";
      } });
      const imgDropZone = el("div", {
        style: "border:2px dashed var(--border,#e2e8f0);border-radius:6px;padding:0.5rem 0.75rem;font-size:0.8rem;color:var(--muted,#8b93a1);cursor:pointer;text-align:center;margin-top:0.4rem",
        ondragover: (ev) => { ev.preventDefault(); imgDropZone.style.borderColor = "var(--accent,#2fa564)"; },
        ondragleave: () => { imgDropZone.style.borderColor = "var(--border,#e2e8f0)"; },
        ondrop: (ev) => {
          ev.preventDefault();
          imgDropZone.style.borderColor = "var(--border,#e2e8f0)";
          const f = ev.dataTransfer?.files[0];
          if (f && f.type.startsWith("image/")) uploadImage(f);
        },
        onclick: () => imgFileInput.click(),
      }, "Drop image here · click to pick file · or paste (Cmd+V / Ctrl+V)");

      function handleImgPaste(ev) {
        if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") return;
        // Belt and braces: even if a listener somehow outlives its panel, it must
        // not upload to a component the user is no longer looking at.
        if (openDetailComponentId !== componentId) return;
        // A modal stacked above the panel owns the paste. Both this handler and
        // the create modal's are bound to `document`, so one Cmd+V fired both:
        // the image went to the component being created AND to whichever
        // component's panel was still open behind it. Observed 2026-09-15 on
        // two pairs, 12:21 and 12:23.
        if (document.querySelector("[data-modal-overlay]")) return;
        const items = ev.clipboardData?.items || [];
        for (const item of items) {
          if (item.type.startsWith("image/")) {
            ev.preventDefault();
            uploadImage(item.getAsFile());
            return;
          }
        }
      }
      if (activeImgPasteOff) { activeImgPasteOff(); activeImgPasteOff = null; }
      document.addEventListener("paste", handleImgPaste);
      activeImgPasteOff = () => document.removeEventListener("paste", handleImgPaste);
      panel.__imgPasteOff = activeImgPasteOff;

      const imagesSection = el("div", { style: "margin-top:1rem" }, [
        el("h4", {}, "Images"),
        imgDropZone, imgFileInput, imgStatus, imgGrid,
      ]);

      // --- Status edit block (rushroom only) -----------------------------------
      // --- Name + part number edit block (rushroom only) -----------------------
      // --- Unified Properties card (rushroom only) — replaces separate name/status/type/sourcing cards ---
      let propertiesSection = null;
      if (role === "rushroom") {
        const nameInp   = el("input", { class: "up-text", type: "text", value: nodeData?.name || "", style: "width:100%;font-size:0.82rem" });
        const pnInp     = el("input", { class: "up-text", type: "text", value: nodeData?.part_number || "", style: "width:100%;font-size:0.82rem;font-family:monospace" });
        // One OEM number (migration 0029): component_metadata.manufacturer_part_number.
        // Read from metaR, not `meta`: that const is declared ~170 lines below and
        // touching it here throws "Cannot access 'meta' before initialization".
        // bom_components.oem_number is legacy and no longer read or written here —
        // two columns behind one label meant a value entered on one tab was
        // invisible on the other, which is how AI fill exposed the split.
        const oemInp    = el("input", { class: "up-text", type: "text", value: (metaR?.metadata || {}).manufacturer_part_number || "", placeholder: "OEM number", style: "width:100%;font-size:0.82rem;font-family:monospace" });

        const VALID_STATUSES = ["active", "inactive", "replaced", "flagged"];
        const currentStatus = nodeData?.lifecycle_status || "inactive";
        const statusSel = el("select", { class: "up-text", style: "width:100%;padding:0.3rem 0.5rem;font-size:0.82rem;border-radius:4px;border:1px solid var(--border,#e2e8f0)" },
          VALID_STATUSES.map((s) => el("option", { value: s, selected: s === currentStatus ? "selected" : null }, s))
        );
        const replNoteArea = el("textarea", { class: "up-text", rows: "2", placeholder: "What replaced this, and why?", style: "display:none;resize:vertical;font-size:0.82rem;margin-top:0.3rem;width:100%" });
        replNoteArea.value = nodeData?.replacement_note || "";
        const flagReasonArea = el("textarea", { class: "up-text", rows: "2", placeholder: "Describe the flag reason or concern", style: "display:none;resize:vertical;font-size:0.82rem;margin-top:0.3rem;width:100%" });
        flagReasonArea.value = nodeData?.flag_reason || "";
        function syncConditionalFields() {
          const v = statusSel.value;
          replNoteArea.style.display  = v === "replaced" ? "" : "none";
          flagReasonArea.style.display = v === "flagged"  ? "" : "none";
        }
        syncConditionalFields();
        statusSel.addEventListener("change", syncConditionalFields);

        const TYPE_OPTS = [["part", "Part"], ["sub_assembly", "Sub-Assembly"], ["finished_good", "Finished Good"]];
        const currentType = nodeData?.type || "part";
        const typeSel = el("select", { class: "up-text", style: "width:100%;padding:0.3rem 0.5rem;font-size:0.82rem;border-radius:4px;border:1px solid var(--border,#e2e8f0)" },
          TYPE_OPTS.map(([v, l]) => el("option", { value: v, selected: v === currentType ? "selected" : null }, l))
        );

        const MOB_OPTS = [["purchased","Purchased (bought-in)"],["manufactured","Manufactured (made in-house)"],["assembled","Assembled (in-house from bought parts)"],["subcontracted","Subcontracted (outsourced)"]];
        const currentMOB = nodeData?.make_or_buy || "purchased";
        const mobSel = el("select", { class: "up-text", style: "width:100%;padding:0.3rem 0.5rem;font-size:0.82rem;border-radius:4px;border:1px solid var(--border,#e2e8f0)" },
          MOB_OPTS.map(([v, l]) => el("option", { value: v, selected: v === currentMOB ? "selected" : null }, l))
        );

        // PROP-038 — category. This is also the only way to clear the untagged
        // backlog: a category is required on create, but pre-existing parts have
        // none and can only be tagged from here.
        const catSel = categorySelect(nodeData?.category_id || null, { placeholder: "— none —" });
        catSel.style.cssText = "width:100%;padding:0.3rem 0.5rem;font-size:0.82rem;border-radius:4px;border:1px solid var(--border,#e2e8f0)";

        const propSaveErr = el("span", { style: "font-size:0.78rem;color:#e05454;flex:1" }, "");
        const propSaveBtn = el("button", { class: "btn btn-sm btn-primary", type: "button", style: "white-space:nowrap" }, "Save changes");
        propSaveBtn.onclick = async () => {
          const newName = nameInp.value.trim();
          if (!newName) { propSaveErr.textContent = "Name cannot be empty."; return; }
          if (categoryRequiredFor(typeSel.value) && !catSel.value) {
            propSaveErr.textContent = "Pick a category for this part.";
            return;
          }
          propSaveBtn.disabled = true; propSaveBtn.textContent = "Saving…"; propSaveErr.textContent = "";
          try {
            await Promise.all([
              API.post(token, "setComponentCategory", {
                component_id: componentId,
                category_id: catSel.value || null,
              }),
              API.post(token, "updateComponent", {
                component_id: componentId,
                name: newName,
                part_number: pnInp.value.trim() || undefined,
                type: typeSel.value,
                make_or_buy: mobSel.value,
              }),
              API.post(token, "upsertComponentMetadata", {
                component_id: componentId,
                manufacturer_part_number: oemInp.value.trim() || null,
              }),
              API.post(token, "setComponentStatus", {
                component_id: componentId,
                lifecycle_status: statusSel.value,
                replacement_note: statusSel.value === "replaced" ? replNoteArea.value.trim() || null : null,
                flag_reason:      statusSel.value === "flagged"  ? flagReasonArea.value.trim() || null : null,
              }),
            ]);
            propSaveBtn.textContent = "Saved ✓";
            // Every field in this card shows on the list row, and category also
            // drives the chip counts — so the list behind the panel must reload.
            try { refreshBomList && refreshBomList(); } catch { /* list not mounted */ }
            setTimeout(() => {
              openComponentDetail(componentId, token, panel, {
                ...nodeData,
                category_id: catSel.value || null,
                name: newName,
                part_number: pnInp.value.trim() || nodeData?.part_number,
                type: typeSel.value,
                make_or_buy: mobSel.value,
                lifecycle_status: statusSel.value,
                replacement_note: statusSel.value === "replaced" ? replNoteArea.value.trim() || null : null,
                flag_reason:      statusSel.value === "flagged"  ? flagReasonArea.value.trim() || null : null,
              }, role);
            }, 600);
          } catch (ex) {
            propSaveErr.textContent = ex.message;
            propSaveBtn.disabled = false; propSaveBtn.textContent = "Save changes";
          }
        };

        const lbl = (text) => el("span", { style: "font-size:0.72rem;font-weight:600;color:var(--muted,#8b93a1);display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:0.04em" }, text);
        const statusColWrapper = el("div", {}, [lbl("Lifecycle status"), statusSel, replNoteArea, flagReasonArea]);
        const categoryColWrapper = el("div", {}, [lbl("Category"), catSel]);

        propertiesSection = el("div", { style: "margin-bottom:1rem;padding:0.9rem;border:1px solid var(--border,#e2e8f0);border-radius:6px" }, [
          el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:0.6rem 0.75rem;margin-bottom:0.6rem" }, [
            el("div", { style: "grid-column:1/3" }, [lbl("Name"), nameInp]),
            el("div", {}, [lbl("Part no."), pnInp]),
            el("div", {}, [lbl("OEM no."), oemInp]),
            el("div", {}, [lbl("Type"), typeSel]),
            statusColWrapper,
            categoryColWrapper,
            el("div", {}, [lbl("Sourcing"), mobSel]),
          ]),
          el("div", { style: "display:flex;align-items:center;justify-content:flex-end;gap:0.5rem;margin-top:0.25rem" }, [propSaveErr, propSaveBtn]),
        ]);
      }

      // ---- Product Families section ----------------------------------------
      const compFamilies = (compFamiliesR && compFamiliesR.families) || [];
      const allFamilies  = (allFamiliesR  && allFamiliesR.families)  || [];
      const memberFamIds = new Set(compFamilies.map((f) => f.id));

      const refreshFamilySection = () => openComponentDetail(componentId, token, panel, nodeData, role);

      const familyChips = el("div", { style: "display:flex;flex-wrap:wrap;gap:0.3rem;margin-bottom:0.5rem" },
        compFamilies.length
          ? compFamilies.map((f) => {
              const chip = el("span", {
                style: "display:inline-flex;align-items:center;gap:0.25rem;padding:2px 8px;border-radius:99px;font-size:0.75rem;font-weight:600;background:var(--primary,#2fa564)22;color:var(--primary,#2fa564);border:1px solid var(--primary,#2fa564)44",
              }, [
                f.name,
                ...(role === "rushroom" ? [el("button", {
                  type: "button",
                  style: "background:none;border:none;cursor:pointer;font-size:0.8rem;line-height:1;padding:0;color:inherit;opacity:0.7",
                  title: `Remove from ${f.name}`,
                  onclick: async (e) => {
                    e.stopPropagation();
                    try { await API.post(token, "removeFamilyMember", { family_id: f.id, component_id: componentId }); refreshFamilySection(); }
                    catch (ex) { alert(ex.message); }
                  },
                }, "×")] : []),
              ]);
              return chip;
            })
          : [el("span", { style: "font-size:0.82rem;color:var(--muted,#8b93a1)" }, "Not assigned to any product family")]
      );

      let familyPickerEl = null;
      if (role === "rushroom") {
        const available = allFamilies.filter((f) => !memberFamIds.has(f.id));
        if (available.length) {
          const sel = el("select", { class: "up-text", style: "font-size:0.82rem;max-width:220px" }, [
            el("option", { value: "" }, "+ Assign to family…"),
            ...available.map((f) => el("option", { value: f.id }, f.name)),
          ]);
          sel.onchange = async () => {
            if (!sel.value) return;
            sel.disabled = true;
            try { await API.post(token, "addFamilyMember", { family_id: sel.value, component_id: componentId }); refreshFamilySection(); }
            catch (ex) { alert(ex.message); sel.disabled = false; sel.value = ""; }
          };
          familyPickerEl = sel;
        }
      }

      const productFamiliesSection = el("div", { style: "margin-top:1rem" }, [
        el("div", { style: "display:flex;align-items:center;gap:0.5rem;margin-bottom:0.4rem;flex-wrap:wrap" }, [
          el("h4", { style: "margin:0" }, "Product Families"),
          familyPickerEl,
        ].filter(Boolean)),
        familyChips,
      ]);

      // --- Component metadata sections (PROP-031) ----------------------------
      const meta = metaR?.metadata || {};
      function metaFld(v) { return v != null && v !== "" ? String(v) : "—"; }
      function metaBool(v) { return v === true ? "Yes" : v === false ? "No" : "—"; }
      function metaRow(label, value) {
        return el("div", { style: "display:contents" }, [
          el("span", { style: "font-size:0.8rem;color:var(--muted,#64748b);font-weight:500" }, label),
          el("span", { style: "font-size:0.82rem" }, value),
        ]);
      }
      function metaGrid(...rows) {
        return el("div", { style: "display:grid;grid-template-columns:auto 1fr;gap:0.3rem 1rem;margin-bottom:0.75rem" }, rows);
      }
      async function saveMeta(fields, btn, errEl, onDone) {
        btn.disabled = true; btn.textContent = "Saving…"; errEl.textContent = "";
        try {
          await API.post(token, "upsertComponentMetadata", { component_id: componentId, ...fields });
          onDone();
        } catch (ex) { errEl.textContent = ex.message; btn.disabled = false; btn.textContent = "Save"; }
      }
      function metaFldRow(label, inp) {
        return el("div", { style: "margin-bottom:0.45rem" }, [
          el("div", { class: "form-label", style: "font-size:0.75rem;margin-bottom:2px" }, label), inp,
        ]);
      }
      function metaInp(val, placeholder, type) {
        return el("input", { class: "up-text", type: type || "text", placeholder,
          style: "padding:0.25rem 0.4rem;font-size:0.82rem", value: val != null ? String(val) : "" });
      }

      // Specifications (Physical + Material + Procurement)
      const specsContainer = el("div", {});
      function renderSpecsRead() {
        const editBtn = role === "rushroom" ? el("button", { class: "btn btn-sm", type: "button", onclick: renderSpecsEdit }, "Edit") : null;
        const dimsStr = (meta.length_mm != null || meta.width_mm != null || meta.height_mm != null)
          ? `${meta.length_mm ?? "—"} × ${meta.width_mm ?? "—"} × ${meta.height_mm ?? "—"} mm` : "—";
        specsContainer.replaceChildren(
          el("div", { style: "display:flex;justify-content:space-between;align-items:center;margin-bottom:0.6rem" },
            [el("strong", { style: "font-size:0.88rem" }, "Physical"), editBtn].filter(Boolean)),
          metaGrid(
            metaRow("Weight", meta.weight_g != null ? meta.weight_g + " g" : "—"),
            metaRow("L × W × H", dimsStr),
            ...catalogueRows("physical"),
          ),
          el("strong", { style: "font-size:0.88rem;display:block;margin-bottom:0.6rem" }, "Material & Finish"),
          metaGrid(
            metaRow("Base material",     metaFld(meta.base_material)),
            metaRow("Surface treatment", metaFld(meta.surface_treatment)),
            metaRow("Color / finish",    metaFld(meta.color_specification)),
            metaRow("Flame retardant",   metaFld(meta.flame_retardant_class)),
            ...catalogueRows("material"),
          ),
          el("strong", { style: "font-size:0.88rem;display:block;margin-bottom:0.6rem" }, "Procurement"),
          metaGrid(
            metaRow("Manufacturer",          metaFld(meta.manufacturer_name)),
            metaRow("OEM number",            metaFld(meta.manufacturer_part_number)),
            metaRow("Supplier",              metaFld(meta.preferred_supplier_name)),
            metaRow("Supplier part no.",     metaFld(meta.supplier_part_number)),
            metaRow("Lead time",             meta.lead_time_days != null ? meta.lead_time_days + " days" : "—"),
            metaRow("MOQ",                   meta.moq != null ? String(meta.moq) : "—"),
            ...catalogueRows("procurement"),
          ),
          ...customSpecsBlock(),
        );
      }

      // PROP-039/040 — values a document stated that no column can hold. They
      // live in component_metadata.custom_specs. Promoted keys (PROP-040) are
      // rendered by catalogueRows() inside their own section instead, so this
      // section only ever shows the not-yet-standard remainder.
      const csFields = (csFieldsR && csFieldsR.fields) || [];
      const csUsage  = Object.fromEntries(((csUsageR && csUsageR.usage) || []).map((u) => [u.field_key, u.count]));
      const promotedKeys = new Set(csFields.map((f) => f.field_key));

      function csValue(key) {
        const cs = meta.custom_specs;
        return cs && typeof cs === "object" ? cs[key] : undefined;
      }
      async function saveCustomSpec(key, value) {
        const next = { ...(meta.custom_specs || {}) };
        if (value === "" || value === null || value === undefined) delete next[key];
        else next[key] = value;
        await API.post(token, "upsertComponentMetadata", { component_id: componentId, custom_specs: next });
        meta.custom_specs = next;
      }

      // A promoted field behaves like any other spec row, but is editable in
      // place so adding one does not mean opening the whole section editor.
      function catalogueRows(section) {
        return csFields.filter((f) => f.section === section).map((f) => {
          const box = el("span", { style: "font-size:0.82rem" });
          const draw = () => {
            const v = csValue(f.field_key);
            const shown = (v === undefined || v === null || v === "") ? "—" : String(v) + (f.unit ? " " + f.unit : "");
            box.replaceChildren(el("span", {
              style: role === "rushroom" ? "cursor:pointer;border-bottom:1px dashed var(--border,#e2e8f0)" : "",
              title: role === "rushroom" ? "Click to edit" : "",
              onclick: role === "rushroom" ? edit : null,
            }, shown));
          };
          const edit = () => {
            const inp = f.data_type === "boolean"
              ? el("select", { class: "up-text", style: "font-size:0.82rem;padding:1px 4px" },
                  [el("option", { value: "" }, "—"), el("option", { value: "true" }, "Yes"), el("option", { value: "false" }, "No")])
              : el("input", { class: "up-text", type: f.data_type === "number" ? "number" : "text", step: "any",
                  style: "font-size:0.82rem;padding:1px 4px;width:11rem" });
            const cur = csValue(f.field_key);
            inp.value = cur === undefined || cur === null ? "" : String(cur);
            let settled = false;
            const commit = async () => {
              if (settled) return; settled = true;
              let v = inp.value.trim();
              if (f.data_type === "number" && v !== "") { const n = Number(v); if (!Number.isFinite(n)) { settled = false; inp.focus(); return; } v = n; }
              if (f.data_type === "boolean" && v !== "") v = v === "true";
              try { await saveCustomSpec(f.field_key, v); } catch (ex) { alert(ex.message); }
              draw();
            };
            inp.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter") { ev.preventDefault(); commit(); } else if (ev.key === "Escape") { settled = true; draw(); } };
            inp.onblur = commit;
            box.replaceChildren(inp);
            inp.focus();
          };
          draw();
          return el("div", { style: "display:contents" }, [
            el("span", { style: "font-size:0.8rem;color:var(--muted,#64748b);font-weight:500" }, f.label),
            box,
          ]);
        });
      }

      function customSpecsBlock() {
        const cs = meta.custom_specs;
        const keys = (cs && typeof cs === "object" ? Object.keys(cs) : []).filter((k) => !promotedKeys.has(k));
        if (!keys.length) return [];
        const rows = keys.map((k) => {
          const used = csUsage[k] || 1;
          const label = k.replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase());
          const actions = [];
          // Suggested once the same key appears on 3+ parts — evidence it is a
          // real dimension of the data rather than one supplier's wording.
          if (role === "rushroom" && used >= 3) {
            actions.push(el("button", {
              class: "btn btn-sm", type: "button",
              title: `Used on ${used} parts — make this a standard field for every component`,
              style: "padding:0 7px;font-size:0.7rem;white-space:nowrap;color:var(--accent,#2fa564);border-color:#2fa56455",
              onclick: () => openPromoteFieldModal(k, label, String(cs[k]), token, () => openComponentDetail(componentId, token, panel, nodeData, role)),
            }, `＋ Make standard · ${used}`));
          } else if (used >= 2) {
            actions.push(el("span", { style: "font-size:0.68rem;color:var(--muted,#8b93a1);white-space:nowrap" }, `${used} parts`));
          }
          if (role === "rushroom") {
            actions.push(el("button", {
              class: "btn btn-sm", type: "button", title: "Remove from this component",
              style: "padding:0 6px;font-size:0.72rem;color:#e05454;border-color:#e0545440",
              onclick: async () => {
                try { await saveCustomSpec(k, ""); renderSpecsRead(); } catch (ex) { alert(ex.message); }
              },
            }, "×"));
          }
          return el("div", { style: "display:contents" }, [
            el("span", { style: "font-size:0.8rem;color:var(--muted,#64748b);font-weight:500" }, label),
            el("span", { style: "font-size:0.82rem;min-width:0;overflow-wrap:anywhere" }, String(cs[k])),
            el("div", { style: "display:flex;gap:0.3rem;align-items:center;justify-content:flex-end" }, actions),
          ]);
        });
        return [
          el("div", { style: "display:flex;align-items:center;gap:0.5rem;margin:0.9rem 0 0.5rem" }, [
            el("strong", { style: "font-size:0.88rem" }, "Custom specs"),
            el("span", { style: "font-size:0.72rem;color:var(--muted,#8b93a1)" }, "no dedicated field yet"),
          ]),
          // Its own three-column grid. The earlier version appended the delete
          // button into metaGrid's two-column layout via a display:contents row,
          // which made it a third cell and split every row in half.
          el("div", { style: "display:grid;grid-template-columns:auto 1fr auto;gap:0.3rem 1rem;margin-bottom:0.75rem;align-items:center" }, rows),
        ];
      }

      function renderSpecsEdit() {
        const wt  = metaInp(meta.weight_g,               "g",                         "number");
        const lmm = metaInp(meta.length_mm,              "mm",                        "number");
        const wmm = metaInp(meta.width_mm,               "mm",                        "number");
        const hmm = metaInp(meta.height_mm,              "mm",                        "number");
        const bm  = metaInp(meta.base_material,          "e.g. 6061-T6 aluminium");
        const st  = metaInp(meta.surface_treatment,      "e.g. anodized class II natural");
        const cs  = metaInp(meta.color_specification,    "e.g. RAL 9003 signal white");
        const fr  = metaInp(meta.flame_retardant_class,  "e.g. V-0");
        const mfr = metaInp(meta.manufacturer_name,        "Manufacturer name");
        const mfp = metaInp(meta.manufacturer_part_number, "OEM number");
        const ps  = metaInp(meta.preferred_supplier_name,  "Supplier / distributor name");
        const spn = metaInp(meta.supplier_part_number,     "Supplier's order number");
        const ltd = metaInp(meta.lead_time_days,           "calendar days",             "number");
        const moqI= metaInp(meta.moq,                     "units",                     "number");
        const errEl  = el("span", { style: "font-size:0.78rem;color:#e05454;display:block;min-height:1.1em" }, "");
        const saveBtn= el("button", { class: "btn btn-sm btn-primary", type: "button" }, "Save");
        saveBtn.onclick = () => saveMeta({
          weight_g:                   wt.value  !== "" ? parseFloat(wt.value)  : null,
          length_mm:                  lmm.value !== "" ? parseFloat(lmm.value) : null,
          width_mm:                   wmm.value !== "" ? parseFloat(wmm.value) : null,
          height_mm:                  hmm.value !== "" ? parseFloat(hmm.value) : null,
          base_material:              bm.value.trim()  || null,
          surface_treatment:          st.value.trim()  || null,
          color_specification:        cs.value.trim()  || null,
          flame_retardant_class:      fr.value.trim()  || null,
          manufacturer_name:          mfr.value.trim() || null,
          manufacturer_part_number:   mfp.value.trim() || null,
          preferred_supplier_name:    ps.value.trim()  || null,
          supplier_part_number:       spn.value.trim() || null,
          lead_time_days:             ltd.value !== "" ? parseInt(ltd.value)  : null,
          moq:                        moqI.value !== "" ? parseInt(moqI.value): null,
        }, saveBtn, errEl, () => openComponentDetail(componentId, token, panel, nodeData, role));
        specsContainer.replaceChildren(
          el("strong", { style: "font-size:0.88rem;display:block;margin-bottom:0.5rem" }, "Physical"),
          el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:0.75rem" }, [
            metaFldRow("Weight (g)", wt), metaFldRow("Length (mm)", lmm),
            metaFldRow("Width (mm)", wmm), metaFldRow("Height (mm)", hmm),
          ]),
          el("strong", { style: "font-size:0.88rem;display:block;margin-bottom:0.5rem" }, "Material & Finish"),
          el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:0.75rem" }, [
            metaFldRow("Base material", bm), metaFldRow("Surface treatment", st),
            metaFldRow("Color / finish", cs), metaFldRow("Flame retardant class", fr),
          ]),
          el("strong", { style: "font-size:0.88rem;display:block;margin-bottom:0.5rem" }, "Procurement"),
          el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:0.75rem" }, [
            metaFldRow("Manufacturer", mfr), metaFldRow("OEM number", mfp),
            metaFldRow("Supplier", ps), metaFldRow("Supplier part no.", spn),
            metaFldRow("Lead time (days)", ltd), metaFldRow("MOQ (units)", moqI),
          ]),
          errEl,
          el("div", { style: "display:flex;gap:0.5rem" }, [
            saveBtn, el("button", { class: "btn btn-sm", type: "button", onclick: renderSpecsRead }, "Cancel"),
          ]),
        );
      }
      renderSpecsRead();
      const specsSection = el("div", {}, [specsContainer]);

      // Quality & Incoming Inspection
      const qualContainer = el("div", {});
      const INSP_METHODS = ["none","visual","dimensional","functional","chemical","destructive","certificate_only"];
      function renderQualRead() {
        const editBtn = role === "rushroom" ? el("button", { class: "btn btn-sm", type: "button", onclick: renderQualEdit }, "Edit") : null;
        qualContainer.replaceChildren(
          el("div", { style: "display:flex;justify-content:space-between;align-items:center;margin-bottom:0.6rem" },
            [el("strong", { style: "font-size:0.88rem" }, "Quality & Incoming Inspection"), editBtn].filter(Boolean)),
          metaGrid(
            metaRow("Inspection method",   metaFld(meta.incoming_inspection_method)),
            metaRow("Sample size / AQL",   metaFld(meta.inspection_sample_size)),
            metaRow("Critical-to-quality", metaFld(meta.critical_to_quality)),
            metaRow("CPK required",        metaBool(meta.has_cpk_requirement)),
          ),
        );
      }
      function renderQualEdit() {
        const methodSel = el("select", { class: "up-text", style: "font-size:0.82rem;padding:0.25rem 0.4rem" },
          ["", ...INSP_METHODS].map((v) => el("option", { value: v,
            selected: v === (meta.incoming_inspection_method || "") ? "selected" : null }, v || "— select —")));
        const sampleInp = metaInp(meta.inspection_sample_size, 'e.g. "AQL 2.5" or "100%"');
        const ctqInp = el("textarea", { class: "up-text", rows: "2",
          placeholder: "Key CTQ characteristics", style: "font-size:0.82rem;padding:0.25rem 0.4rem;resize:vertical" });
        ctqInp.value = meta.critical_to_quality || "";
        const cpkChk = el("input", { type: "checkbox" }); if (meta.has_cpk_requirement) cpkChk.checked = true;
        const errEl  = el("span", { style: "font-size:0.78rem;color:#e05454;display:block;min-height:1.1em" }, "");
        const saveBtn= el("button", { class: "btn btn-sm btn-primary", type: "button" }, "Save");
        saveBtn.onclick = () => saveMeta({
          incoming_inspection_method: methodSel.value || null,
          inspection_sample_size:     sampleInp.value.trim() || null,
          critical_to_quality:        ctqInp.value.trim() || null,
          has_cpk_requirement:        cpkChk.checked,
        }, saveBtn, errEl, () => openComponentDetail(componentId, token, panel, nodeData, role));
        qualContainer.replaceChildren(
          metaFldRow("Inspection method", methodSel),
          metaFldRow("Sample size / AQL", sampleInp),
          metaFldRow("Critical-to-quality characteristics", ctqInp),
          el("div", { style: "display:flex;align-items:center;gap:0.4rem;margin-bottom:0.45rem" },
            [cpkChk, el("span", { style: "font-size:0.82rem" }, "CPK required from supplier")]),
          errEl,
          el("div", { style: "display:flex;gap:0.5rem;margin-top:0.5rem" }, [
            saveBtn, el("button", { class: "btn btn-sm", type: "button", onclick: renderQualRead }, "Cancel"),
          ]),
        );
      }
      renderQualRead();
      const qualSection = el("div", {}, [qualContainer]);

      // Regulatory / DPP
      const regContainer = el("div", {});
      function renderRegRead() {
        const editBtn = role === "rushroom" ? el("button", { class: "btn btn-sm", type: "button", onclick: renderRegEdit }, "Edit") : null;
        regContainer.replaceChildren(
          el("div", { style: "display:flex;justify-content:space-between;align-items:center;margin-bottom:0.6rem" },
            [el("strong", { style: "font-size:0.88rem" }, "Regulatory & DPP (ESPR Article 7)"), editBtn].filter(Boolean)),
          metaGrid(
            metaRow("Country of origin",      metaFld(meta.country_of_origin)),
            metaRow("HS code",                metaFld(meta.hs_code)),
            metaRow("WEEE category",          metaFld(meta.weee_category)),
            metaRow("Recycled content",       meta.recycled_content_pct != null ? meta.recycled_content_pct + " %" : "—"),
            metaRow("Carbon footprint",       meta.carbon_footprint_kgco2e != null ? meta.carbon_footprint_kgco2e + " kg CO₂e" : "—"),
            metaRow("PCF source",             metaFld(meta.carbon_footprint_source)),
            metaRow("Battery regulation",     metaBool(meta.battery_regulation_applicable)),
            metaRow("Conflict minerals free", metaBool(meta.conflict_minerals_free)),
            metaRow("Spare part available",   metaBool(meta.repair_spare_part_available)),
            metaRow("End-of-life instruction",metaFld(meta.end_of_life_instruction)),
          ),
        );
      }
      function renderRegEdit() {
        const co  = metaInp(meta.country_of_origin,       "ISO alpha-2 e.g. SE");
        const hsc = metaInp(meta.hs_code,                 "e.g. 940350");
        const wee = metaInp(meta.weee_category,           "WEEE category");
        const rcp = metaInp(meta.recycled_content_pct,   "%",        "number");
        const cfp = metaInp(meta.carbon_footprint_kgco2e,"kg CO₂e",  "number");
        const cfs = metaInp(meta.carbon_footprint_source, "e.g. EPD, Ecoinvent 3.9");
        const eol = el("textarea", { class: "up-text", rows: "2",
          placeholder: "Disassembly / recycling instruction", style: "font-size:0.82rem;padding:0.25rem 0.4rem;resize:vertical" });
        eol.value = meta.end_of_life_instruction || "";
        const batChk = el("input", { type: "checkbox" }); if (meta.battery_regulation_applicable) batChk.checked = true;
        const cmfChk = el("input", { type: "checkbox" }); if (meta.conflict_minerals_free)        cmfChk.checked = true;
        const spaChk = el("input", { type: "checkbox" }); spaChk.checked = meta.repair_spare_part_available !== false;
        const errEl  = el("span", { style: "font-size:0.78rem;color:#e05454;display:block;min-height:1.1em" }, "");
        const saveBtn= el("button", { class: "btn btn-sm btn-primary", type: "button" }, "Save");
        saveBtn.onclick = () => saveMeta({
          country_of_origin:             co.value.trim().toUpperCase() || null,
          hs_code:                       hsc.value.trim() || null,
          weee_category:                 wee.value.trim() || null,
          recycled_content_pct:          rcp.value !== "" ? parseFloat(rcp.value) : null,
          carbon_footprint_kgco2e:       cfp.value !== "" ? parseFloat(cfp.value) : null,
          carbon_footprint_source:       cfs.value.trim() || null,
          end_of_life_instruction:       eol.value.trim() || null,
          battery_regulation_applicable: batChk.checked,
          conflict_minerals_free:        cmfChk.checked || null,
          repair_spare_part_available:   spaChk.checked,
        }, saveBtn, errEl, () => openComponentDetail(componentId, token, panel, nodeData, role));
        function chkRow(label, chkEl) {
          return el("div", { style: "display:flex;align-items:center;gap:0.4rem;margin-bottom:0.45rem" },
            [chkEl, el("span", { style: "font-size:0.82rem" }, label)]);
        }
        regContainer.replaceChildren(
          el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:0.75rem" }, [
            metaFldRow("Country of origin (ISO)", co), metaFldRow("HS code", hsc),
            metaFldRow("WEEE category", wee),          metaFldRow("Recycled content (%)", rcp),
            metaFldRow("Carbon footprint (kg CO₂e)", cfp), metaFldRow("PCF source / method", cfs),
          ]),
          metaFldRow("End-of-life instruction", eol),
          chkRow("Battery Regulation 2023/1542 applicable", batChk),
          chkRow("Conflict minerals free (3TG)", cmfChk),
          chkRow("Spare part available", spaChk),
          errEl,
          el("div", { style: "display:flex;gap:0.5rem;margin-top:0.5rem" }, [
            saveBtn, el("button", { class: "btn btn-sm", type: "button", onclick: renderRegRead }, "Cancel"),
          ]),
        );
      }
      renderRegRead();
      const regulatorySection = el("div", {}, [regContainer]);

      // --- Tab bar -----------------------------------------------------------
      const relationsCount = ((usedIn && usedIn.parents) || []).length
        + ((compFamiliesR && compFamiliesR.families) || []).length
        + ((variantMembershipsR && variantMembershipsR.memberships) || []).length;
      const TAB_DEFS = [
        { id: "overview",    label: "Overview" },
        { id: "relations",   label: `Relations${relationsCount ? ` (${relationsCount})` : ""}` },
        { id: "specs",       label: "Specifications" },
        { id: "quality",     label: "Quality" },
        { id: "regulatory",  label: "Regulatory" },
        { id: "materials",   label: "Materials" },
        { id: "documents",   label: "Documents" },
        { id: "images",      label: "Images" },
        { id: "versions",    label: "Versions" },
        { id: "changelog",   label: "Change Log" },
      ];
      const tabPanels = {};
      const tabButtons = [];
      function activateDetailTab(id) {
        for (const [k, p] of Object.entries(tabPanels)) p.style.display = k === id ? "" : "none";
        for (const b of tabButtons) {
          b.style.fontWeight   = b.dataset.tab === id ? "700" : "400";
          b.style.borderBottom = b.dataset.tab === id ? "2px solid var(--accent,#2fa564)" : "2px solid transparent";
        }
      }
      const tabBar = el("div", { style: "display:flex;flex-wrap:wrap;gap:2px;margin-bottom:1rem;border-bottom:1px solid var(--border,#e2e8f0)" });
      TAB_DEFS.forEach(({ id, label }) => {
        const btn = el("button", {
          class: "btn btn-sm", type: "button", "data-tab": id,
          style: "font-size:0.76rem;padding:0.22rem 0.55rem;border-radius:4px 4px 0 0;margin-bottom:-1px;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer",
          onclick: () => activateDetailTab(id),
        }, label);
        tabButtons.push(btn);
        tabBar.append(btn);
      });

      // Stale-source callout for materialised stocked variants (PROP-033)
      let sourceCallout = null;
      if (nodeData?.source_family_id) {
        sourceCallout = el("div", { style: "margin-bottom:1rem;padding:0.65rem 0.85rem;border:1px solid #d9770680;border-radius:6px;background:#d9770610;font-size:0.82rem;color:#92400e" }, [
          el("strong", {}, "Stocked variant"),
          el("span", {}, " — materialised from "),
          el("button", { type: "button", style: "background:none;border:none;padding:0;color:#2fa564;font-size:0.82rem;cursor:pointer;font-weight:600;text-decoration:underline",
            onclick: () => openComponentDetail(nodeData.source_family_id, token, panel, { id: nodeData.source_family_id, type: "product_family" }, role) }, "the source Dynamic BOM family"),
          el("span", {}, ". If the family BOM has changed, re-materialise to pick up updates."),
        ]);
      }

      // --- Variant Groups section (PROP-035) ------------------------------------
      const variantMemberships = variantMembershipsR?.memberships || [];
      const variantGroupContainer = el("div", {});

      async function renderVariantGroups() {
        // Refetch so the section refreshes after mutations without reopening the panel
        let memberships = variantMemberships;
        try {
          const fresh = await API.post(token, "listComponentVariants", { component_id: componentId });
          memberships = fresh.memberships || [];
        } catch { /* use stale */ }

        if (!memberships.length) {
          // Not in any group — show assign UI
          let allGroups = [];
          try { allGroups = (await API.post(token, "listVariantGroups", {})).groups || []; } catch { /**/ }
          const VA_COMMON = ["Color", "Finish", "Size", "Material", "Pattern"];
          const modeNew = el("div", {});
          const modeJoin = el("div", { style: "display:none" });

          // Create-new-group flow
          const newGrpName  = el("input",  { class: "up-text", type: "text", placeholder: "Group name, e.g. Left Side Panel", style: "flex:1;min-width:120px" });
          const newGrpAttr  = el("input",  { class: "up-text", type: "text", placeholder: "Attribute (Color, Finish…)", style: "width:130px", value: "Color" });
          const newGrpVal   = el("input",  { class: "up-text", type: "text", placeholder: "Value for this component, e.g. Arctic White", style: "flex:1;min-width:140px" });
          const newGrpErr   = el("span",   { style: "color:#e05454;font-size:0.78rem;display:block;min-height:1em" }, "");
          const newGrpBtn   = el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: async () => {
            if (!newGrpName.value.trim() || !newGrpVal.value.trim()) { newGrpErr.textContent = "Group name and variant value are required."; return; }
            newGrpBtn.disabled = true; newGrpErr.textContent = "";
            try {
              const r = await API.post(token, "createVariantGroup", { name: newGrpName.value.trim(), variant_attribute: newGrpAttr.value.trim() || "Color" });
              await API.post(token, "addVariantMember", { group_id: r.id, component_id: componentId, variant_value: newGrpVal.value.trim() });
              renderVariantGroups();
            } catch (ex) { newGrpErr.textContent = ex.message; newGrpBtn.disabled = false; }
          } }, "Create & assign");
          // The attribute chips are rendered once, in the flex row below. An
          // earlier loose forEach append rendered a second, unwrapped copy.
          modeNew.append(
            el("div", { style: "display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:0.4rem;margin-top:0.3rem" }, VA_COMMON.map((a) =>
              el("button", { type: "button", style: "font-size:0.72rem;padding:1px 8px;border:1px solid var(--border,#e2e8f0);border-radius:10px;cursor:pointer;background:none", onclick: () => { newGrpAttr.value = a; } }, a)
            )),
            el("div", { style: "display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:0.3rem" }, [newGrpName, newGrpAttr]),
            el("div", { style: "display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:0.3rem" }, [newGrpVal]),
            newGrpErr,
            newGrpBtn,
          );

          // Join-existing-group flow
          const joinSel = el("select", { class: "up-text", style: "flex:1;font-size:0.82rem" },
            allGroups.length
              ? allGroups.map((g) => el("option", { value: g.id }, `${g.name} (${g.variant_attribute})`))
              : [el("option", {}, "No groups yet")]
          );
          const joinVal  = el("input",  { class: "up-text", type: "text", placeholder: "Value for this component, e.g. Arctic White", style: "flex:1;min-width:140px" });
          const joinErr  = el("span",   { style: "color:#e05454;font-size:0.78rem;display:block;min-height:1em" }, "");
          const joinBtn  = el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: async () => {
            if (!allGroups.length || !joinVal.value.trim()) { joinErr.textContent = "Select a group and enter a variant value."; return; }
            joinBtn.disabled = true; joinErr.textContent = "";
            try {
              await API.post(token, "addVariantMember", { group_id: joinSel.value, component_id: componentId, variant_value: joinVal.value.trim() });
              renderVariantGroups();
            } catch (ex) { joinErr.textContent = ex.message; joinBtn.disabled = false; }
          } }, "Join group");
          modeJoin.append(
            el("div", { style: "display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:0.3rem" }, [joinSel, joinVal]),
            joinErr,
            joinBtn,
          );

          const tabNew  = el("button", { type: "button", style: "font-size:0.78rem;padding:2px 8px;border-radius:4px;border:1px solid var(--border,#e2e8f0);cursor:pointer;font-weight:600", onclick: () => { modeNew.style.display=""; modeJoin.style.display="none"; tabNew.style.fontWeight="700"; tabJoin.style.fontWeight="400"; } }, "New group");
          const tabJoin = el("button", { type: "button", style: "font-size:0.78rem;padding:2px 8px;border-radius:4px;border:1px solid var(--border,#e2e8f0);cursor:pointer", onclick: () => { modeJoin.style.display=""; modeNew.style.display="none"; tabJoin.style.fontWeight="700"; tabNew.style.fontWeight="400"; } }, "Join existing");

          variantGroupContainer.replaceChildren(
            el("div", { style: "margin-bottom:1rem;border:1px solid var(--border,#e2e8f0);border-radius:6px;padding:0.75rem" }, [
              el("div", { style: "display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem" }, [
                el("label", { style: "font-size:0.82rem;font-weight:600;color:var(--muted,#8b93a1)" }, "Variant Group"),
              ]),
              el("div", { style: "font-size:0.82rem;color:var(--muted,#8b93a1);margin-bottom:0.5rem" }, "Not assigned to a variant group."),
              el("div", { style: "display:flex;gap:0.4rem;margin-bottom:0.6rem" }, [tabNew, tabJoin]),
              modeNew, modeJoin,
            ]),
          );
          return;
        }

        // In one or more groups — render each
        const cards = memberships.map((mem) => {
          const { group, my_variant_value, siblings } = mem;
          const chips = siblings.map((s) => {
            const isSelf = s.id === componentId;
            const chip = el("button", { type: "button", style: `display:inline-flex;align-items:center;gap:0.25rem;padding:3px 10px;border-radius:12px;border:1.5px solid ${isSelf ? "#2fa564" : "var(--border,#e2e8f0)"};font-size:0.78rem;cursor:${isSelf?"default":"pointer"};font-weight:${isSelf?"700":"400"};background:${isSelf?"#2fa56412":"none"}` }, [
              el("span", {}, s.variant_value),
            ]);
            if (!isSelf) chip.onclick = () => openComponentDetail(s.id, token, panel, s, role);
            return chip;
          });

          const addValInp = el("input", { class: "up-text", type: "text", placeholder: `Add another ${group.variant_attribute} value…`, style: "flex:1;font-size:0.8rem;min-width:160px" });
          const addCompSel = el("select", { class: "up-text", style: "flex:1;font-size:0.8rem" });
          // Populate with components not already in this group
          (async () => {
            try {
              const all = (await API.post(token, "listComponents", {})).components || [];
              const inGroup = new Set(siblings.map((s) => s.id));
              all.filter((c) => !inGroup.has(c.id)).forEach((c) => {
                addCompSel.append(el("option", { value: c.id }, `${c.name}  (${c.part_number})`));
              });
            } catch { /**/ }
          })();
          const addErr = el("span", { style: "color:#e05454;font-size:0.76rem;min-height:1em;display:block" }, "");
          const addBtn = el("button", { class: "btn btn-sm", type: "button", onclick: async () => {
            if (!addValInp.value.trim()) { addErr.textContent = "Enter a variant value."; return; }
            addBtn.disabled = true; addErr.textContent = "";
            try {
              await API.post(token, "addVariantMember", { group_id: group.id, component_id: addCompSel.value, variant_value: addValInp.value.trim() });
              renderVariantGroups();
            } catch (ex) { addErr.textContent = ex.message; addBtn.disabled = false; }
          } }, "+ Add sibling");
          const removeBtn = role === "rushroom" ? el("button", { class: "btn btn-sm", type: "button", style: "font-size:0.72rem;color:#e05454;border-color:#e0545440", onclick: async () => {
            if (!confirm(`Remove this component from group "${group.name}"?`)) return;
            try { await API.post(token, "removeVariantMember", { group_id: group.id, component_id: componentId }); renderVariantGroups(); }
            catch (ex) { alert(ex.message); }
          } }, "Remove from group") : null;

          return el("div", { style: "margin-bottom:0.75rem;border:1px solid var(--border,#e2e8f0);border-radius:6px;padding:0.75rem" }, [
            el("div", { style: "display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4rem" }, [
              el("div", {}, [
                el("span", { style: "font-size:0.82rem;font-weight:600" }, group.name),
                el("span", { style: "font-size:0.75rem;color:var(--muted,#8b93a1);margin-left:0.4rem" }, `· varies by ${group.variant_attribute}`),
              ]),
              removeBtn,
            ].filter(Boolean)),
            el("div", { style: "display:flex;flex-wrap:wrap;gap:0.35rem;margin-bottom:0.5rem" }, chips),
            role === "rushroom" ? el("div", { style: "display:flex;flex-wrap:wrap;gap:0.35rem;margin-top:0.4rem;align-items:center" }, [addCompSel, addValInp, addBtn]) : null,
            addErr,
          ].filter(Boolean));
        });
        variantGroupContainer.replaceChildren(...cards);
      }
      renderVariantGroups();
      const variantGroupSection = el("div", { style: "margin-bottom:0.5rem" }, [
        el("label", { style: "font-size:0.82rem;font-weight:600;color:var(--muted,#8b93a1);display:block;margin-bottom:0.25rem" }, "Variant Group"),
        variantGroupContainer,
      ]);

      tabPanels["overview"]   = el("div", { style: "display:none" }, [
        ...(sourceCallout      ? [sourceCallout]      : []),
        ...(propertiesSection  ? [propertiesSection]  : []),
      ]);
      tabPanels["relations"]  = el("div", { style: "display:none" }, [
        variantGroupSection,
        ...(configSection     ? [configSection]     : []),
        productFamiliesSection,
        usedInSection,
      ]);
      tabPanels["specs"]      = el("div", { style: "display:none" }, [specsSection]);
      tabPanels["quality"]    = el("div", { style: "display:none" }, [qualSection]);
      tabPanels["regulatory"] = el("div", { style: "display:none" }, [regulatorySection]);
      tabPanels["materials"]  = el("div", { style: "display:none" }, [matsSection]);
      tabPanels["documents"]  = el("div", { style: "display:none" }, [docsSection]);
      tabPanels["images"]     = el("div", { style: "display:none;padding-top:0.5rem" }, [imagesSection]);
      tabPanels["versions"]   = el("div", { style: "display:none" }, [versionsSection]);
      tabPanels["changelog"]  = el("div", { style: "display:none" }, [changelogSection]);
      activateDetailTab("overview");

      panel.replaceChildren(
        el("div", { style: "display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem" }, [
          el("div", {}, [
            el("strong", { style: "font-size:0.97rem" }, nodeData?.name || componentId.slice(0, 8) + "…"),
            nodeData?.part_number ? el("span", { style: "margin-left:0.5rem;font-family:monospace;font-size:0.78rem;color:var(--muted,#8b93a1)" }, nodeData.part_number) : null,
          ].filter(Boolean)),
          el("div", { style: "display:flex;gap:0.4rem;align-items:center" }, [
            el("button", {
              class: "btn btn-sm btn-primary", type: "button",
              title: "Read a datasheet, drawing or screenshot and fill these fields",
              onclick: () => openAiFillModal(componentId, token, panel, nodeData, role, imgData?.images || []),
            }, "✨ AI fill"),
            el("button", { class: "btn btn-sm", type: "button", onclick: () => { panel.style.display = "none"; } }, "Close"),
          ]),
        ]),
        tabBar,
        ...Object.values(tabPanels),
      );
    } catch (ex) {
      panel.replaceChildren(el("div", { class: "error" }, `Couldn't load: ${ex.message}`));
    }
  }

  // --- Add component dialog --------------------------------------------------
  function openAddComponent(token, onCreated) {
    const overlay = el("div", { class: "modal-overlay", "data-modal-overlay": "", style: "position:fixed;inset:0;background:#0008;z-index:1000;display:flex;align-items:center;justify-content:center;padding:1rem" });
    const dialog = el("div", { class: "modal-dialog", style: "background:var(--bg,#fff);border-radius:8px;padding:1.5rem;width:min(540px,95vw);max-height:90vh;overflow-y:auto" });

    // --- Part-number generator ------------------------------------------------
    function genPN() {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let s = "";
      for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
      const now = new Date();
      return `RR-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-${s}`;
    }

    // --- Fields --------------------------------------------------------------
    const TYPE_OPTS = [["part", "Part"], ["sub_assembly", "Sub-Assembly"], ["finished_good", "Finished Good"]];
    const pn   = el("input",    { class: "up-text", type: "text", placeholder: "Auto-generated if left empty" });
    const oem  = el("input",    { class: "up-text", type: "text", placeholder: "OEM / distributor reference (optional)" });
    const nm   = el("input",    { class: "up-text", type: "text", placeholder: "Name" });
    const typ  = el("select",   { class: "up-text" }, TYPE_OPTS.map(([v, l]) => el("option", { value: v }, l)));
    const cat  = categorySelect(null);   // PROP-038 — required for parts
    const desc = el("textarea", { class: "up-text", rows: "2", placeholder: "Purpose — what does this part do?" });

    // Pre-fill part number so user can see what will be saved (still editable)
    pn.value = genPN();

    // --- Upload zone + AI autofill -------------------------------------------
    const statusEl = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");

    const autofill = async (up) => {
      if (!up) return;
      statusEl.className = "up-status"; statusEl.textContent = "✨ Reading the file with AI…";
      try {
        const meta = await API.post(token, "suggestComponentMetadata", { path: up.path, fileName: up.fileName });
        if (meta.part_number) pn.value  = meta.part_number;
        if (meta.oem_number)  oem.value = meta.oem_number;   // AI suggestion; stored as manufacturer_part_number on save
        if (meta.name)        nm.value  = meta.name;
        if (meta.type && TYPE_OPTS.some(([v]) => v === meta.type)) typ.value = meta.type;
        if (meta.description) desc.value = meta.description;
        statusEl.className = "up-status ok";
        statusEl.textContent = meta.summary ? `AI read: ${meta.summary} — review and create.` : "AI filled the fields — review and create.";
        zone.finishProcessing(true);
        nm.focus();
      } catch (ex) {
        statusEl.className = "up-status err";
        statusEl.textContent = `Couldn't read the file: ${ex.message}. Fill the fields manually.`;
        zone.finishProcessing(false);
      }
    };

    const zone = uploadZone("rushroom", "documents", {
      ariaLabel: "Datasheet, drawing or specification (optional)",
      hint: "Drag & drop a datasheet or spec to auto-fill fields (optional)",
      processing: true,
      onReady: (up) => autofill(up),
    });
    // Parts are grouped by category in the list; assemblies and Dynamic BOMs
    // have their own tabs, so the field hides for those types.
    const catRow = el("div", {}, []);
    function drawCatRow() {
      if (!categoryRequiredFor(typ.value)) { catRow.replaceChildren(); catRow.style.display = "none"; return; }
      catRow.style.display = "";
      catRow.replaceChildren(frow("Category", cat, "Required — this is how the part is found in the Parts tab."));
    }
    typ.addEventListener("change", drawCatRow);

    const submitBtn = el("button", { class: "btn btn-primary btn-sm", type: "submit" }, "Create BOM Node");
    zone.register(submitBtn, false);

    // --- Photo queue (uploaded after component ID is known) ------------------
    const pendingImgs = []; // [{file, url}]
    const pendingGrid = el("div", { style: "display:flex;flex-wrap:wrap;gap:0.4rem;margin-top:0.4rem;min-height:0" });

    function renderPendingGrid() {
      pendingGrid.replaceChildren(...pendingImgs.map(({ file, url }, i) => {
        const wrap = el("div", { style: "position:relative;display:inline-block" });
        wrap.append(
          el("img", { src: url, style: "width:64px;height:64px;object-fit:cover;border-radius:4px;border:1px solid var(--border,#e2e8f0);display:block", title: file.name }),
          el("button", { type: "button", style: "position:absolute;top:2px;right:2px;background:#000a;border:none;border-radius:50%;width:16px;height:16px;color:#fff;font-size:0.5rem;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1", onclick: () => {
            URL.revokeObjectURL(url); pendingImgs.splice(i, 1); renderPendingGrid();
          } }, "✕"),
        );
        return wrap;
      }));
    }

    function addPendingImg(file) {
      const ALLOWED = ["image/png", "image/jpeg", "image/webp", "image/gif"];
      if (!ALLOWED.includes(file.type)) return;
      pendingImgs.push({ file, url: URL.createObjectURL(file) });
      renderPendingGrid();
    }

    const imgPickInput = el("input", { type: "file", accept: "image/*", style: "display:none", onchange: (ev) => {
      const f = ev.target.files[0]; if (f) addPendingImg(f); imgPickInput.value = "";
    } });
    const imgZone = el("div", {
      style: "border:2px dashed var(--border,#e2e8f0);border-radius:6px;padding:0.45rem 0.75rem;font-size:0.78rem;color:var(--muted,#8b93a1);cursor:pointer;text-align:center",
      ondragover: (ev) => { ev.preventDefault(); imgZone.style.borderColor = "var(--accent,#2fa564)"; },
      ondragleave: () => { imgZone.style.borderColor = "var(--border,#e2e8f0)"; },
      ondrop: (ev) => { ev.preventDefault(); imgZone.style.borderColor = "var(--border,#e2e8f0)"; const f = ev.dataTransfer?.files[0]; if (f && f.type.startsWith("image/")) addPendingImg(f); },
      onclick: () => imgPickInput.click(),
    }, "Drop photo · click to pick · or paste (Cmd+V / Ctrl+V)");

    function handleModalPaste(ev) {
      if (!overlay.isConnected) { document.removeEventListener("paste", handleModalPaste); return; }
      if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") return;
      const items = ev.clipboardData?.items || [];
      for (const item of items) {
        if (item.type.startsWith("image/")) { ev.preventDefault(); addPendingImg(item.getAsFile()); return; }
      }
    }
    document.addEventListener("paste", handleModalPaste);

    // --- Form submit ---------------------------------------------------------
    const errEl = el("span", { class: "form-error" }, "");
    const form = el("form", { onsubmit: async (e) => {
      e.preventDefault();
      if (!nm.value.trim()) { errEl.textContent = "Name is required."; return; }
      errEl.textContent = "";
      submitBtn.disabled = true; submitBtn.textContent = "Creating…";
      try {
        if (categoryRequiredFor(typ.value) && !cat.value) {
          errEl.textContent = "Pick a category for this part.";
          submitBtn.disabled = false; submitBtn.textContent = "Create BOM Node";
          return;
        }
        const r = await API.post(token, "addComponent", {
          part_number: pn.value.trim() || null,
          name:        nm.value.trim(),
          type:        typ.value,
          category_id: cat.value || null,
          description: desc.value.trim() || null,
        });
        // OEM number lives on component_metadata (migration 0029), so it is a
        // second call — non-fatal, the component already exists either way.
        if (r.id && oem.value.trim()) {
          try {
            await API.post(token, "upsertComponentMetadata", {
              component_id: r.id, manufacturer_part_number: oem.value.trim(),
            });
          } catch { /* the component is created; the number can be added later */ }
        }

        // Upload any queued photos — non-blocking (component creation already succeeded)
        if (pendingImgs.length && r.id) {
          submitBtn.textContent = `Uploading ${pendingImgs.length} photo${pendingImgs.length > 1 ? "s" : ""}…`;
          for (const { file } of pendingImgs) {
            try {
              const { signedUrl, path } = await API.post(token, "imageUploadUrl", {
                component_id: r.id, fileName: file.name || "photo.png", contentType: file.type,
              });
              await new Promise((res, rej) => {
                const xhr = new XMLHttpRequest();
                xhr.open("PUT", signedUrl);
                xhr.setRequestHeader("Content-Type", file.type);
                xhr.onload = () => xhr.status < 300 ? res() : rej(new Error(`${xhr.status}`));
                xhr.onerror = () => rej(new Error("Network error"));
                xhr.send(file);
              });
              await API.post(token, "addComponentImage", {
                component_id: r.id, storage_path: path,
                file_name: file.name || "photo.png", content_type: file.type,
              });
            } catch { /* photo upload is best-effort — component exists */ }
          }
          pendingImgs.forEach(({ url }) => URL.revokeObjectURL(url));
        }
        document.removeEventListener("paste", handleModalPaste);
        overlay.remove();
        if (onCreated) onCreated(r.id, typ.value);
      } catch (ex) {
        errEl.textContent = ex.message;
        submitBtn.disabled = false; submitBtn.textContent = "Create BOM Node";
      }
    } });

    // Shared field style — applied to every input/select/textarea in this modal
    const F = "width:100%;font-size:0.875rem;padding:0.42rem 0.6rem;border:1px solid var(--border,#e2e8f0);border-radius:6px;background:var(--bg,#fff);color:var(--text,#1a1f2e);font-family:inherit;box-sizing:border-box";
    [pn, oem, nm].forEach((el_) => el_.style.cssText = F);
    typ.style.cssText  = F + ";appearance:none;-webkit-appearance:none;cursor:pointer;padding-right:2rem;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238a94a6' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 0.6rem center;background-size:12px";
    desc.style.cssText = F + ";resize:vertical;min-height:64px";

    const LBL = "display:block;font-size:0.8rem;font-weight:600;color:var(--muted,#8b93a1);margin-bottom:0.25rem";
    const ROW = "margin-bottom:0.7rem";
    function frow(label, input, hint) {
      return el("div", { style: ROW }, [
        el("label", { style: LBL }, label),
        input,
        hint ? el("span", { style: "font-size:0.72rem;color:var(--muted,#8b93a1);display:block;margin-top:3px" }, hint) : null,
      ].filter(Boolean));
    }

    form.append(
      el("div", { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem" }, [
        el("h3", { style: "margin:0;font-size:1rem" }, "New BOM Node"),
        el("button", { class: "btn btn-sm", type: "button", style: "padding:2px 8px", onclick: () => { document.removeEventListener("paste", handleModalPaste); overlay.remove(); } }, "✕"),
      ]),
      el("p", { style: "font-size:0.8rem;color:var(--muted,#8b93a1);margin:0 0 0.5rem" },
        "Creates a top-level product or assembly. To add components under it, use the + child button on any tree row."),
      el("p", { style: "font-size:0.8rem;color:var(--muted,#8b93a1);margin:0 0 0.9rem" },
        "Upload a datasheet and the AI will suggest fields. Or fill in manually."),
      el("div", { style: ROW }, [el("label", { style: LBL }, "Document (optional)"), zone.el, statusEl]),
      frow("Part number", pn,   "Auto-generated if left as-is — you can edit it."),
      frow("OEM number",  oem,  null),
      frow("Name",        nm,   null),
      frow("Type",        typ,  null),
      catRow,
      frow("Description", desc, "Purpose — what does this product/assembly do?"),
      el("div", { style: ROW }, [
        el("label", { style: LBL }, "Photos (optional)"),
        imgZone, imgPickInput, pendingGrid,
      ]),
      errEl,
      el("div", { style: "display:flex;gap:0.5rem;margin-top:1.1rem;justify-content:flex-end" }, [
        el("button", { class: "btn btn-sm", type: "button", onclick: () => { document.removeEventListener("paste", handleModalPaste); overlay.remove(); } }, "Cancel"),
        submitBtn,
      ]),
    );

    drawCatRow();   // populate on open, not only on type change
    dialog.append(form);
    overlay.append(dialog);
    document.body.append(overlay);
    nm.focus();
  }

  // --- Configure modal: resolve a variant from a product family -------------
  function openConfigureModal(familyNode, token, onRefresh) {
    const overlay = el("div", { "data-modal-overlay": "", style: "position:fixed;inset:0;background:#0009;z-index:1001;display:flex;align-items:center;justify-content:center;padding:1rem" });
    const dialog  = el("div", { style: "background:var(--bg,#fff);border:1px solid var(--border,#2d3748);border-radius:8px;padding:1.5rem;width:min(600px,95vw);max-height:90vh;overflow-y:auto" });

    let attributes = [];
    const selects = {};
    let lastSelections = {};

    const errEl      = el("span", { style: "color:#e05454;font-size:0.82rem;display:block;min-height:1.2rem;margin-top:0.4rem" }, "");
    const attrForm   = el("div", {}, [el("div", { class: "loading" }, "Loading attributes…")]);
    const resultsArea = el("div", {});

    const saveName = el("input", { class: "up-text", type: "text", placeholder: "Configuration name (required)", style: "width:100%;margin-bottom:0.35rem" });
    const savePN   = el("input", { class: "up-text", type: "text", placeholder: "Sales / part number (optional)", style: "width:100%" });
    const saveErr  = el("span", { style: "color:#e05454;font-size:0.82rem;display:block;min-height:1.2rem;margin-top:0.2rem" }, "");
    const saveBtn  = el("button", { class: "btn btn-primary btn-sm", type: "button", onclick: async () => {
      if (!saveName.value.trim()) { saveErr.textContent = "Name is required."; return; }
      saveErr.textContent = "";
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      try {
        await API.post(token, "saveConfiguration", { family_id: familyNode.id, name: saveName.value.trim(), selections: lastSelections, part_number: savePN.value.trim() || null });
        saveBtn.textContent = "Saved ✓";
      } catch (ex) {
        saveErr.textContent = ex.message;
        saveBtn.disabled = false; saveBtn.textContent = "Save configuration";
      }
    } }, "Save configuration");

    const resolveBtn = el("button", { class: "btn btn-primary btn-sm", type: "button", onclick: doResolve }, "Resolve BOM");

    async function doResolve() {
      errEl.textContent = "";
      const selections = {};
      for (const attr of attributes) {
        const val = selects[attr.name]?.value;
        if (!val && attr.is_required) { errEl.textContent = `"${attr.display_name}" is required.`; return; }
        if (val) selections[attr.name] = val;
      }
      resolveBtn.disabled = true; resolveBtn.textContent = "Resolving…";
      try {
        const bom = await API.post(token, "resolveVariant", { family_id: familyNode.id, selections });
        lastSelections = { ...selections };
        const nodeCount = (bom.nodes || []).length;
        const S = "font-size:0.8rem;font-weight:600";
        resultsArea.replaceChildren(
          el("div", { style: "margin-top:0.75rem;padding:0.6rem;border:1px solid var(--border,#e2e8f0);border-radius:6px" }, [
            el("p", { style: S + ";margin:0 0 0.4rem" }, `Resolved: ${nodeCount} component${nodeCount !== 1 ? "s" : ""}`),
            el("div", { style: "max-height:180px;overflow-y:auto;border:1px solid var(--border,#e2e8f0);border-radius:4px;font-size:0.8rem;margin-bottom:0.75rem" },
              (bom.nodes || []).map((n) => el("div", { style: "padding:0.25rem 0.5rem;border-bottom:1px solid var(--border,#e2e8f0)" }, [
                el("span", { style: "font-family:monospace;font-size:0.73rem;color:var(--muted,#8b93a1);margin-right:0.4rem" }, n.part_number),
                el("span", {}, n.name),
              ]))),
            el("div", { style: "border-top:1px solid var(--border,#e2e8f0);padding-top:0.6rem" }, [
              el("p", { style: S + ";margin:0 0 0.35rem" }, "Save this configuration"),
              saveName, savePN, saveErr,
              el("div", { style: "margin-top:0.4rem;display:flex;justify-content:flex-end" }, [saveBtn]),
            ]),
          ]),
        );
        saveName.value = ""; savePN.value = "";
        saveBtn.disabled = false; saveBtn.textContent = "Save configuration";
      } catch (ex) {
        errEl.textContent = ex.message;
      } finally {
        resolveBtn.disabled = false; resolveBtn.textContent = "Resolve BOM";
      }
    }

    async function loadAttributes() {
      try {
        const r = await API.post(token, "listFamilyAttributes", { family_id: familyNode.id });
        attributes = r.attributes || [];
        if (!attributes.length) {
          attrForm.replaceChildren(el("div", { style: "font-size:0.82rem;color:var(--muted,#8b93a1);padding:0.5rem" }, "No attributes defined on this family. Open Details to add them first."));
          resolveBtn.disabled = true;
          return;
        }
        const LBL = "display:block;font-size:0.8rem;font-weight:600;color:var(--muted,#8b93a1);margin-bottom:0.2rem";
        const F = "width:100%;font-size:0.875rem;padding:0.38rem 0.55rem;border:1px solid var(--border,#e2e8f0);border-radius:6px;background:var(--bg,#fff);color:var(--text,#1a1f2e);font-family:inherit";
        attrForm.replaceChildren(...attributes.map((attr) => {
          const sel = el("select", { style: F + ";margin-bottom:0.55rem", onchange: () => { selects[attr.name] = sel; } },
            [el("option", { value: "" }, attr.is_required ? "— select —" : "— any —"),
             ...(attr.values || []).map((v) => el("option", { value: v.value }, v.label))]);
          selects[attr.name] = sel;
          return el("div", {}, [el("label", { style: LBL }, attr.display_name + (attr.is_required ? " *" : " (optional)")), sel]);
        }));
      } catch (ex) {
        attrForm.replaceChildren(el("div", { class: "error" }, ex.message));
      }
    }

    dialog.append(
      el("div", { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem" }, [
        el("h3", { style: "margin:0;font-size:1rem" }, `Configure: ${familyNode.name}`),
        el("button", { class: "btn btn-sm", type: "button", style: "padding:2px 8px", onclick: () => overlay.remove() }, "✕"),
      ]),
      el("p", { style: "font-size:0.82rem;color:var(--muted,#8b93a1);margin:0 0 0.75rem" }, "Select attribute values to resolve the BOM for a specific configuration."),
      attrForm,
      el("div", { style: "display:flex;justify-content:flex-end;margin-top:0.5rem" }, [resolveBtn]),
      errEl,
      resultsArea,
    );
    overlay.append(dialog);
    document.body.append(overlay);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    loadAttributes();
  }

  // --- Status overview dashboard ---------------------------------------------
  async function statusOverviewView(token) {
    const wrap = el("div", { class: "pis-overview-wrap" });
    const rootIdInput = el("input", { class: "up-text", type: "text", placeholder: "Root component ID", style: "width:min(320px,100%)" });
    const loadBtn = el("button", { class: "btn btn-sm", type: "button" }, "Load");
    const resultArea = el("div", { style: "margin-top:1rem" });

    loadBtn.onclick = async () => {
      const rootId = rootIdInput.value.trim(); if (!rootId) return;
      resultArea.replaceChildren(el("div", { class: "loading" }, "Analysing…"));
      try {
        const { nodes } = await API.post(token, "getBom", { root_component_id: rootId, max_depth: 99 });
        if (!nodes || !nodes.length) { resultArea.replaceChildren(el("div", { class: "notice" }, "No components found.")); return; }
        // Lifecycle status distribution
        const lcCounts = {};
        const lcOrder = ["active", "inactive", "replaced", "flagged"];
        lcOrder.forEach((s) => { lcCounts[s] = 0; });
        nodes.forEach((n) => { if (lcCounts[n.lifecycle_status] !== undefined) lcCounts[n.lifecycle_status]++; });
        const lcPills = lcOrder.map((s) => {
          const c = lcCounts[s];
          const color = LIFECYCLE_COLORS[s];
          return el("span", { style: `background:${color}20;color:${color};border:1px solid ${color}60;padding:4px 12px;border-radius:99px;font-size:0.85rem;cursor:default`, title: `${c} component${c !== 1 ? "s" : ""} at ${s}` }, `${s}: ${c}`);
        });
        resultArea.replaceChildren(
          el("h4", { style: "margin-bottom:0.5rem" }, "Lifecycle status distribution"),
          el("div", { style: "display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1.5rem" }, ...lcPills),
          el("p", { class: "muted", style: "font-size:0.82rem" }, `${nodes.length} total components in BOM (all depths).`),
        );
      } catch (ex) {
        resultArea.replaceChildren(el("div", { class: "error" }, `Couldn't load: ${ex.message}`));
      }
    };

    wrap.replaceChildren(
      el("div", { class: "pis-toolbar", style: "display:flex;gap:0.5rem;align-items:center;margin-bottom:1rem;flex-wrap:wrap" }, [rootIdInput, loadBtn]),
      resultArea,
    );
    return wrap;
  }

  // --- Main renderProduct entry point ----------------------------------------
  // PROP-030: Manufacturing BOM — Routing + Work Orders
  async function mBomView(role, mount) {
    const token = API.getToken();
    const OPTYPES = ["drill","route","insert","attach","cut","surface_treat","inspect","other"];
    const OP_LABEL = { drill:"Drill", route:"Route / CNC", insert:"Insert", attach:"Attach", cut:"Cut", surface_treat:"Surface treat", inspect:"Inspect", other:"Other" };
    const OP_COLOR = { drill:"#4a9eed", route:"#8b5cf6", insert:"#2fa564", attach:"#f59e0b", cut:"#e05454", surface_treat:"#0ea5e9", inspect:"#8b93a1", other:"#6b7280" };
    const STATUS_COLORS = { planned:"#8b93a1", in_progress:"#4a9eed", completed:"#2fa564", shipped:"#a855f7" };
    const STATUS_OPTS = ["planned","in_progress","completed","shipped"];

    async function loadFamilies() {
      const r = await API.post(token, "listProductFamilies", {});
      return r.families || [];
    }

    const opBadge = (type) => el("span", {
      style: `display:inline-block;font-size:0.7rem;font-weight:700;padding:2px 6px;border-radius:3px;background:${(OP_COLOR[type]||"#6b7280")}22;color:${OP_COLOR[type]||"#6b7280"};text-transform:uppercase;letter-spacing:0.03em`,
    }, OP_LABEL[type] || type);

    const statusBadge = (status) => el("span", {
      style: `display:inline-block;font-size:0.7rem;font-weight:700;padding:2px 7px;border-radius:3px;background:${(STATUS_COLORS[status]||"#8b93a1")}22;color:${STATUS_COLORS[status]||"#8b93a1"};text-transform:uppercase`,
    }, status.replace(/_/g, " "));

    // ---- Manufacturing Steps sub-tab ------------------------------------
    function buildRoutingTab() {
      const wrap = el("div", { style: "padding:1rem;max-width:900px" });
      const note = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
      const mgmtArea  = el("div", { style: "margin-bottom:1rem" });
      const familySel = el("select", { class: "up-text", style: "max-width:300px" }, [el("option", { value: "" }, "— choose product family —")]);
      const compArea  = el("div", { style: "margin-top:1rem" });
      const stepsArea = el("div", { style: "margin-top:1rem" });

      let selectedFamilyId = null;
      let selectedCompId   = null;
      let selectedCompName = "";
      let steps = [];
      let allFamilies = [];

      // ---- Family management (create / delete) ----------------------------
      const renderFamilyMgmt = () => {
        const createBtn = actionBtn("+ New Family", "plus", { primary: true, onClick: () => {
          const nameInp = el("input", { type: "text", class: "up-text", placeholder: "Family name…", style: "max-width:240px" });
          const descInp = el("input", { type: "text", class: "up-text", placeholder: "Description (optional)", style: "max-width:240px" });
          const errEl = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
          const saveBtn = el("button", { class: "btn btn-primary", type: "button" }, "Create");
          let closeModal;
          saveBtn.onclick = async () => {
            const name = nameInp.value.trim();
            if (!name) { errEl.textContent = "Name is required."; return; }
            saveBtn.disabled = true; saveBtn.textContent = "Creating…";
            try {
              await API.post(token, "createProductFamily", { name, description: descInp.value.trim() || null });
              if (closeModal) closeModal();
              await reloadFamilies();
            } catch (ex) { errEl.textContent = ex.message; saveBtn.disabled = false; saveBtn.textContent = "Create"; }
          };
          closeModal = openModal("New Product Family", el("div", {}, [
            el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Name"), nameInp]),
            el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Description"), descInp]),
            errEl,
            el("div", { style: "margin-top:0.75rem" }, saveBtn),
          ]));
        }});

        const chips = allFamilies.map((f) => el("span", {
          style: "display:inline-flex;align-items:center;gap:0.25rem;padding:2px 8px;border-radius:99px;font-size:0.75rem;font-weight:600;background:var(--bg-2,#f5f5f5);border:1px solid var(--border,#e2e8f0);cursor:default",
        }, [
          f.name,
          el("span", { class: "muted", style: "font-size:0.7rem" }, `(${f.member_count})`),
          el("button", {
            type: "button", title: `Delete ${f.name}`,
            style: "background:none;border:none;cursor:pointer;font-size:0.78rem;opacity:0.5;padding:0;line-height:1",
            onclick: async () => {
              if (!confirm(`Delete product family "${f.name}"? This will remove all step definitions for this family.`)) return;
              try {
                await API.post(token, "deleteProductFamily", { id: f.id });
                if (selectedFamilyId === f.id) { selectedFamilyId = null; compArea.replaceChildren(); stepsArea.replaceChildren(); }
                await reloadFamilies();
              } catch (ex) { note.textContent = ex.message; }
            },
          }, "×"),
        ]));

        mgmtArea.replaceChildren(
          el("div", { style: "display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.4rem" }, [
            el("span", { class: "form-label", style: "margin:0" }, "Product families:"),
            createBtn,
          ]),
          chips.length
            ? el("div", { style: "display:flex;flex-wrap:wrap;gap:0.3rem" }, chips)
            : el("span", { class: "muted", style: "font-size:0.82rem" }, "No product families yet — create one above."),
        );
      };

      const reloadFamilies = async () => {
        try {
          allFamilies = await loadFamilies();
          // Repopulate family picker
          const prev = familySel.value;
          familySel.replaceChildren(el("option", { value: "" }, "— choose product family —"));
          allFamilies.forEach((f) => familySel.appendChild(el("option", { value: f.id, selected: f.id === prev ? "selected" : null }, f.name)));
          if (prev && allFamilies.some((f) => f.id === prev)) familySel.value = prev;
          renderFamilyMgmt();
        } catch (ex) { note.textContent = "Could not load families: " + ex.message; }
      };

      const loadFamiliesIntoSel = reloadFamilies;

      // Fetch family members + step counts, render component cards
      const loadComponentOverview = async (familyId) => {
        compArea.replaceChildren(el("div", { class: "loading" }, "Loading components…"));
        stepsArea.replaceChildren();
        selectedCompId = null; selectedCompName = "";
        try {
          const [membersR, ovR] = await Promise.all([
            API.post(token, "listFamilyMembers", { family_id: familyId }),
            API.post(token, "listFamilyRoutingOverview", { family_id: familyId }),
          ]);
          const nodes = membersR.components || [];
          const stepCounts = ovR.step_counts || {};
          if (!nodes.length) {
            compArea.replaceChildren(el("div", { class: "empty" }, "No components in this BOM yet."));
            return;
          }
          compArea.replaceChildren(
            el("p", { class: "muted", style: "font-size:0.82rem;margin-bottom:0.5rem" },
              "Click a component to view and edit its manufacturing steps for this product family."),
            el("div", { style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0.5rem" },
              nodes.map((n) => {
                const count = stepCounts[n.id] || 0;
                const card = el("button", {
                  type: "button",
                  style: "text-align:left;padding:0.6rem 0.75rem;border:1px solid var(--border,#e2e8f0);border-radius:6px;background:var(--bg-1,#fff);cursor:pointer;width:100%;transition:border-color 0.15s",
                }, [
                  el("div", { style: "font-size:0.875rem;font-weight:600;margin-bottom:0.2rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, n.name || n.part_number || n.id),
                  n.part_number ? el("div", { class: "muted", style: "font-size:0.75rem;margin-bottom:0.3rem" }, n.part_number) : null,
                  el("div", { style: `font-size:0.72rem;font-weight:700;padding:2px 6px;border-radius:3px;display:inline-block;background:${count?"#2fa56422":"#8b93a122"};color:${count?"#2fa564":"#8b93a1"}` },
                    count ? `${count} step${count !== 1 ? "s" : ""}` : "No steps yet"),
                ].filter(Boolean));
                card.onclick = () => {
                  compArea.querySelectorAll("button").forEach((b) => b.style.removeProperty("border-color"));
                  card.style.borderColor = "var(--primary,#2fa564)";
                  loadStepsForComponent(familyId, n.id, n.name || n.part_number || n.id);
                };
                return card;
              })
            ),
          );
        } catch (ex) { compArea.replaceChildren(el("div", { class: "error" }, ex.message)); }
      };

      // Load and render steps for one component within the selected family
      const loadStepsForComponent = async (familyId, compId, compName) => {
        selectedCompId = compId; selectedCompName = compName;
        stepsArea.replaceChildren(el("div", { class: "loading" }, "Loading steps…"));
        try {
          const r = await API.post(token, "listFamilyRoutingSteps", { family_id: familyId, component_id: compId });
          steps = r.steps || [];
          renderSteps();
        } catch (ex) { stepsArea.replaceChildren(el("div", { class: "error" }, ex.message)); }
      };

      const renderSteps = () => {
        const heading = el("div", { style: "display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.5rem;padding-bottom:0.4rem;border-bottom:1px solid var(--border,#e2e8f0)" }, [
          el("span", { style: "font-size:0.875rem;font-weight:700" }, selectedCompName),
          el("span", { class: "muted", style: "font-size:0.8rem" }, `— ${steps.length} step${steps.length !== 1 ? "s" : ""}`),
          el("span", { class: "spacer" }),
          addStepBtn(),
        ]);
        if (!steps.length) {
          stepsArea.replaceChildren(heading, el("div", { class: "empty" }, "No manufacturing steps defined for this component in this family yet."));
          return;
        }
        stepsArea.replaceChildren(heading, el("div", {}, steps.map((s, i) => stepRow(s, i))));
      };

      const addStepBtn = () => actionBtn("+ Add step", "plus", { primary: true, onClick: () => openStepModal(null) });

      const stepRow = (s, idx) => el("div", { style: "padding:0.5rem 0.6rem;border-bottom:1px solid var(--border,#e2e8f0);display:flex;align-items:flex-start;gap:0.5rem" }, [
        el("span", { style: "font-size:0.75rem;font-weight:700;color:var(--muted,#8b93a1);min-width:1.6rem;text-align:right;padding-top:2px" }, `${s.step_number}.`),
        el("div", { style: "flex:1;min-width:0" }, [
          el("div", { style: "display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap" }, [
            opBadge(s.operation_type),
            s.variant_condition && Object.keys(s.variant_condition).length
              ? el("span", { style: "font-size:0.7rem;background:var(--bg-2,#f5f5f5);border-radius:3px;padding:1px 5px;color:var(--muted,#8b93a1)" }, "conditional") : null,
          ].filter(Boolean)),
          el("div", { style: "margin-top:0.25rem;font-size:0.9rem" }, s.instruction_text),
          s.reference_document_name ? el("div", { class: "muted", style: "font-size:0.78rem;margin-top:0.1rem" }, "📎 " + s.reference_document_name) : null,
          s.notes ? el("div", { class: "muted", style: "font-size:0.78rem;margin-top:0.1rem" }, s.notes) : null,
        ].filter(Boolean)),
        el("div", { style: "display:flex;gap:0.25rem;flex-shrink:0" }, [
          el("button", { class: "btn btn-sm", type: "button", title: "Move up",   disabled: idx === 0 ? "" : null, onclick: () => moveStep(idx, -1) }, "↑"),
          el("button", { class: "btn btn-sm", type: "button", title: "Move down", disabled: idx === steps.length - 1 ? "" : null, onclick: () => moveStep(idx, +1) }, "↓"),
          actionBtn("Edit", "edit", { onClick: () => openStepModal(s) }),
          actionBtn("Delete", "trash", { danger: true, onClick: () => deleteStep(s) }),
        ]),
      ]);

      const moveStep = async (idx, dir) => {
        const newIdx = idx + dir;
        if (newIdx < 0 || newIdx >= steps.length) return;
        const orderedIds = steps.map((s) => s.id);
        [orderedIds[idx], orderedIds[newIdx]] = [orderedIds[newIdx], orderedIds[idx]];
        try {
          await API.post(token, "reorderFamilyRoutingSteps", { family_id: selectedFamilyId, component_id: selectedCompId, ordered_ids: orderedIds });
          await loadStepsForComponent(selectedFamilyId, selectedCompId, selectedCompName);
        } catch (ex) { note.textContent = ex.message; }
      };

      const deleteStep = async (s) => {
        if (!confirm(`Delete step ${s.step_number}: "${s.instruction_text.slice(0, 60)}"?`)) return;
        try {
          await API.post(token, "deleteFamilyRoutingStep", { id: s.id });
          await loadStepsForComponent(selectedFamilyId, selectedCompId, selectedCompName);
          // Refresh step count badges
          loadComponentOverview(selectedFamilyId).then(() => {
            // Re-highlight the active card after reload
            compArea.querySelectorAll("button").forEach((b) => {
              if (b.textContent.includes(selectedCompName)) b.style.borderColor = "var(--primary,#2fa564)";
            });
          });
        } catch (ex) { note.textContent = ex.message; }
      };

      const openStepModal = async (existing) => {
        let docVersions = [];
        try {
          const r = await API.post(token, "data", {});
          docVersions = (r.documents || []).flatMap((d) =>
            (d.versions || []).map((v) => ({ id: v.id, label: `${d.name} (${v.version_label || v.version || "v?"})` }))
          );
        } catch { /* optional */ }

        const v = existing || {};
        const frow = (lbl, inp) => el("label", { class: "form-row" }, [el("span", { class: "form-label" }, lbl), inp]);
        const stepNumInp = el("input", { type: "number", class: "up-text", min: "1", value: existing ? String(existing.step_number) : String(steps.length + 1) });
        const opSel = el("select", { class: "up-text" }, OPTYPES.map((t) => el("option", { value: t, selected: t === (v.operation_type || "drill") ? "selected" : null }, OP_LABEL[t])));
        const instrInp = el("textarea", { rows: "3", class: "up-text", placeholder: "Describe exactly what the operator must do…" }, v.instruction_text || "");
        const refDocSel = el("select", { class: "up-text" }, [
          el("option", { value: "" }, "— no reference document —"),
          ...docVersions.map((d) => el("option", { value: d.id, selected: d.id === v.reference_document_id ? "selected" : null }, d.label)),
        ]);
        const notesInp = el("input", { type: "text", class: "up-text", placeholder: "Optional notes", value: v.notes || "" });
        const errEl2 = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
        const saveBtn = el("button", { class: "btn btn-primary", type: "button" }, existing ? "Save changes" : "Add step");

        let closeStepModal;
        saveBtn.onclick = async () => {
          const instr = instrInp.value.trim();
          if (!instr) { errEl2.textContent = "Instruction text is required."; return; }
          saveBtn.disabled = true; saveBtn.textContent = "Saving…";
          try {
            await API.post(token, "upsertFamilyRoutingStep", {
              id: existing?.id,
              family_id: selectedFamilyId,
              component_id: selectedCompId,
              step_number: Number(stepNumInp.value) || 1,
              operation_type: opSel.value,
              instruction_text: instr,
              reference_document_id: refDocSel.value || null,
              notes: notesInp.value.trim() || null,
            });
            if (closeStepModal) closeStepModal();
            await loadStepsForComponent(selectedFamilyId, selectedCompId, selectedCompName);
          } catch (ex) { errEl2.textContent = ex.message; saveBtn.disabled = false; saveBtn.textContent = existing ? "Save changes" : "Add step"; }
        };

        closeStepModal = openModal(
          `${existing ? "Edit" : "New"} step — ${selectedCompName}`,
          el("div", {}, [
            frow("Step #", stepNumInp),
            frow("Operation type", opSel),
            frow("Instruction for operator", instrInp),
            frow("Reference document", refDocSel),
            frow("Notes", notesInp),
            errEl2,
            el("div", { style: "margin-top:0.75rem" }, saveBtn),
          ])
        );
      };

      familySel.addEventListener("change", async () => {
        selectedFamilyId = familySel.value || null;
        stepsArea.replaceChildren();
        if (selectedFamilyId) await loadComponentOverview(selectedFamilyId);
        else compArea.replaceChildren();
      });

      wrap.replaceChildren(
        mgmtArea,
        el("div", { style: "display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.5rem;padding-top:0.75rem;border-top:1px solid var(--border,#e2e8f0)" }, [
          el("label", { class: "form-label", style: "margin:0;white-space:nowrap" }, "Select family:"),
          familySel,
        ]),
        note,
        compArea,
        stepsArea,
      );
      loadFamiliesIntoSel();
      return wrap;
    }

    // ---- Work Orders sub-tab --------------------------------------------
    function buildOrdersTab() {
      const wrap = el("div", { style: "padding:1rem;max-width:860px" });
      const listArea   = el("div", {});
      const detailArea = el("div", { style: "margin-top:1rem" });

      const reload = async () => {
        listArea.replaceChildren(el("div", { class: "loading" }, "Loading work orders…"));
        detailArea.replaceChildren();
        try {
          const r = await API.post(token, "listWorkOrders", {});
          renderList(r.work_orders || []);
        } catch (ex) { listArea.replaceChildren(el("div", { class: "error" }, ex.message)); }
      };

      const renderList = (orders) => {
        if (!orders.length) { listArea.replaceChildren(el("div", { class: "empty" }, "No work orders yet.")); return; }
        const TD = (content, style = "") => el("td", { style: "padding:0.4rem 0.5rem;" + style }, content);
        listArea.replaceChildren(el("table", { style: "width:100%;border-collapse:collapse;font-size:0.875rem" }, [
          el("thead", {}, [el("tr", { style: "border-bottom:2px solid var(--border,#e2e8f0)" }, [
            el("th", { style: "text-align:left;padding:0.4rem 0.5rem" }, "Family"),
            el("th", { style: "text-align:left;padding:0.4rem 0.5rem" }, "Order ref"),
            el("th", { style: "text-align:left;padding:0.4rem 0.5rem" }, "Status"),
            el("th", { style: "text-align:left;padding:0.4rem 0.5rem" }, "Steps"),
            el("th", { style: "text-align:left;padding:0.4rem 0.5rem" }, "Created"),
            el("th", {}),
          ])]),
          el("tbody", {}, orders.map((o) => el("tr", { style: "border-bottom:1px solid var(--border,#e2e8f0);cursor:pointer", onclick: () => openDetail(o.id) }, [
            TD(o.family_name || "—"),
            TD(o.external_order_id || el("span", { class: "muted" }, "—")),
            TD(statusBadge(o.status)),
            TD(`${o.steps_done}/${o.step_count}`),
            TD(fmtDate(o.created_at), "color:var(--muted,#8b93a1)"),
            TD(actionBtn("Open", "external", { onClick: (e) => { e.stopPropagation(); openDetail(o.id); } })),
          ]))),
        ]));
      };

      const openDetail = async (woId) => {
        detailArea.replaceChildren(el("div", { class: "loading" }, "Loading work order…"));
        detailArea.scrollIntoView({ behavior: "smooth", block: "nearest" });
        try {
          const r = await API.post(token, "getWorkOrder", { id: woId });
          const wo    = r.work_order;
          const steps = r.steps || [];
          const comps = r.components || [];
          const processedCompIds = new Set(steps.map((s) => s.component_id).filter(Boolean));
          const processComps = comps.filter((c) => processedCompIds.has(c.component_id));
          const packComps    = comps.filter((c) => !processedCompIds.has(c.component_id));
          const selStr = null;

          const statusSel = el("select", { class: "up-text", style: "font-size:0.85rem" },
            STATUS_OPTS.map((s) => el("option", { value: s, selected: s === wo.status ? "selected" : null }, s.replace(/_/g, " ")))
          );
          const updateStatusBtn = actionBtn("Update", "refresh", { onClick: async () => {
            updateStatusBtn.disabled = true;
            try { await API.post(token, "updateWorkOrderStatus", { id: wo.id, status: statusSel.value }); await reload(); openDetail(woId); }
            catch (ex) { alert(ex.message); updateStatusBtn.disabled = false; }
          } });

          const stepCheckRow = (s) => {
            const cb = el("input", { type: "checkbox", checked: s.status === "done" ? "checked" : null, style: "cursor:pointer;margin-top:3px;flex-shrink:0" });
            const rowEl = el("div", { style: `display:flex;align-items:flex-start;gap:0.5rem;padding:0.45rem 0;border-bottom:1px solid var(--border,#e2e8f0);opacity:${s.status==="done"?"0.6":"1"}` }, [
              el("span", { style: "font-size:0.75rem;font-weight:700;color:var(--muted,#8b93a1);min-width:1.6rem;text-align:right;padding-top:3px" }, `${s.step_number}.`),
              cb,
              el("div", { style: "flex:1;min-width:0" }, [
                el("div", { style: "font-size:0.88rem" }, s.instruction_text),
                s.component_name ? el("div", { class: "muted", style: "font-size:0.78rem" }, "→ " + s.component_name) : null,
                s.reference_document_url ? el("div", { style: "margin-top:0.15rem" }, actionBtn("Open reference", "external", { href: s.reference_document_url, target: "_blank" })) : null,
              ].filter(Boolean)),
            ]);
            cb.onchange = async () => {
              cb.disabled = true;
              try {
                const newStatus = cb.checked ? "done" : "pending";
                await API.post(token, "updateWorkOrderStepStatus", { step_id: s.id, status: newStatus });
                s.status = newStatus;
                rowEl.style.opacity = cb.checked ? "0.6" : "1";
              } catch (ex) { alert(ex.message); cb.checked = !cb.checked; }
              cb.disabled = false;
            };
            return rowEl;
          };

          const compRow = (c) => el("div", { style: "display:flex;gap:0.5rem;padding:0.3rem 0;font-size:0.875rem;border-bottom:1px solid var(--border,#e2e8f0);align-items:center" }, [
            el("span", { style: "min-width:2.5rem;text-align:right;color:var(--muted,#8b93a1);font-weight:600" }, `×${Number(c.quantity)}`),
            el("span", { style: "flex:1" }, c.name || c.component_id),
            c.part_number ? el("span", { class: "muted", style: "font-size:0.78rem" }, c.part_number) : null,
          ].filter(Boolean));

          detailArea.replaceChildren(el("div", { style: "border:1px solid var(--border,#e2e8f0);border-radius:8px;padding:1rem" }, [
            el("div", { style: "display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;flex-wrap:wrap" }, [
              el("h4", { style: "margin:0;font-size:1rem" }, `WO: ${wo.family_name}`),
              statusBadge(wo.status),
              el("span", { class: "spacer" }),
              el("button", { class: "btn btn-sm", type: "button", onclick: () => detailArea.replaceChildren() }, "✕ Close"),
            ]),
            wo.external_order_id ? el("p", { class: "muted", style: "margin:0 0 0.25rem;font-size:0.85rem" }, `Order ref: ${wo.external_order_id}`) : null,
            el("p", { class: "muted", style: "margin:0 0 0.75rem;font-size:0.85rem" }, `Config: ${selStr}`),
            el("div", { style: "display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap" }, [
              el("span", { class: "form-label", style: "margin:0" }, "Status:"),
              statusSel,
              updateStatusBtn,
            ]),
            steps.length ? el("div", { style: "margin-bottom:1rem" }, [
              el("h5", { style: "margin:0 0 0.4rem;font-size:0.875rem;font-weight:700" }, "Processing steps"),
              el("div", {}, steps.map(stepCheckRow)),
            ]) : null,
            processComps.length ? el("div", { style: "margin-bottom:1rem" }, [
              el("h5", { style: "margin:0 0 0.4rem;font-size:0.875rem;font-weight:700" }, "Pull & process"),
              el("div", {}, processComps.map(compRow)),
            ]) : null,
            packComps.length ? el("div", {}, [
              el("h5", { style: "margin:0 0 0.4rem;font-size:0.875rem;font-weight:700" }, "Pull & pack"),
              el("div", {}, packComps.map(compRow)),
            ]) : null,
          ].filter(Boolean)));
        } catch (ex) { detailArea.replaceChildren(el("div", { class: "error" }, ex.message)); }
      };

      const openNewWoModal = async () => {
        let families = [];
        try { families = await loadFamilies(); } catch (ex) { alert("Could not load families: " + ex.message); return; }
        if (!families.length) { alert("No product families defined yet."); return; }

        const famSel = el("select", { class: "up-text" }, [
          el("option", { value: "" }, "— choose product family —"),
          ...families.map((f) => el("option", { value: f.id }, `${f.name} (${f.member_count} components)`)),
        ]);
        const extOrdInp = el("input", { type: "text", class: "up-text", placeholder: "Customer order ref (optional)" });
        const notesInp2 = el("input", { type: "text", class: "up-text", placeholder: "Optional notes" });
        const errEl2 = el("p", { class: "up-status", role: "status", "aria-live": "polite" }, "");
        const createBtn = el("button", { class: "btn btn-primary", type: "button" }, "Create work order");
        let closeWoModal;

        createBtn.onclick = async () => {
          if (!famSel.value) { errEl2.textContent = "Choose a product family."; return; }
          createBtn.disabled = true; createBtn.textContent = "Creating…";
          try {
            const r = await API.post(token, "createWorkOrder", {
              family_id: famSel.value,
              external_order_id: extOrdInp.value.trim() || null,
              notes: notesInp2.value.trim() || null,
            });
            if (closeWoModal) closeWoModal();
            await reload();
            openDetail(r.work_order_id);
          } catch (ex) { errEl2.textContent = ex.message; createBtn.disabled = false; createBtn.textContent = "Create work order"; }
        };

        const frow = (lbl, inp) => el("label", { class: "form-row" }, [el("span", { class: "form-label" }, lbl), inp]);
        closeWoModal = openModal("New Work Order", el("div", {}, [
          frow("Product family", famSel),
          frow("Order ref", extOrdInp),
          frow("Notes", notesInp2),
          errEl2,
          el("div", { style: "margin-top:0.75rem" }, createBtn),
        ]));
      };

      wrap.replaceChildren(
        el("div", { style: "display:flex;gap:0.5rem;align-items:center;margin-bottom:0.75rem" }, [
          actionBtn("+ New Work Order", "plus", { primary: true, onClick: () => openNewWoModal() }),
          actionBtn("↺ Refresh", "refresh", { onClick: () => reload() }),
        ]),
        listArea,
        detailArea,
      );
      reload();
      return wrap;
    }

    mount.replaceChildren(subTabs("mbom", [
      { id: "routing", label: "Manufacturing Steps", icon: "layers", build: () => buildRoutingTab() },
      { id: "orders",  label: "Work Orders",  icon: "printer", build: () => buildOrdersTab() },
    ]));
  }

  async function renderProduct(role, mount) {
    const token = API.getToken();
    mount.replaceChildren(subTabs("product", [
      { id: "bom", label: "BOM Tree", icon: "layers", build: () => { const m = el("div", {}); bomTreeView(token, role).then((v) => m.replaceChildren(v)); return m; } },
      { id: "overview", label: "Status Overview", icon: "eye", build: () => { const m = el("div", {}); statusOverviewView(token).then((v) => m.replaceChildren(v)); return m; } },
    ]));
  }

  /* ---------------- EU Directive Relationship Analyser (D3) ---------------- */
  const D3_CDN = "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js";
  // Node colour by compliance coverage; edge style by relation type / source.
  const dgCoverageColor = (pct) => pct == null ? "#8a94a6" : pct > 80 ? "#3fb56b" : pct >= 40 ? "#d9a441" : "#e0564f";
  const dgCoverageLabel = (pct) => pct == null ? "Not assessed" : `${pct}%`;
  // Solid = requires/implements; dashed = amends/supersedes/supplements/references; dotted = ai_inferred.
  const dgEdgeDash = (e) => e.sourceKind === "ai_inferred" ? "2 4" : (["requires", "implements"].includes(e.relationType) ? null : "6 4");
  const REL_LABELS = { requires: "requires", supplements: "supplements", implements: "implements", amends: "amends", supersedes: "supersedes", references: "references", conflicts_with: "conflicts with", defines_terms_for: "defines terms for" };

  async function renderDirectiveGraph(role, mount) {
    if (role !== "rushroom") { mount.replaceChildren(el("div", { class: "empty" }, "The directive graph is available to Rushroom users.")); return; }
    mount.replaceChildren(el("div", { class: "loading" }, "Loading directive graph…"));
    let d3;
    try { await loadScript(D3_CDN); d3 = window.d3; if (!d3) throw new Error("d3 missing"); }
    catch { mount.replaceChildren(el("div", { class: "error" }, "Couldn't load the graph library (offline?). Reconnect and reload.")); return; }

    const state = { scope: "all", passportId: null, passports: [], graph: null };
    try { const pp = await API.listProductPassports(API.getToken()); state.passports = pp.passports || []; } catch { /* passports optional */ }

    // ---- controls ----
    const scopeSel = el("select", { class: "up-text", "aria-label": "Graph scope" }, [
      el("option", { value: "all" }, "All directives in the platform"),
      el("option", { value: "company" }, "Company view — applies to Rushroom AB"),
      el("option", { value: "product" }, "Product view — applies to a product"),
    ]);
    const productSel = el("select", { class: "up-text", "aria-label": "Product", hidden: "" }, [
      el("option", { value: "" }, state.passports.length ? "— choose a product —" : "No product passports yet"),
      ...state.passports.map((p) => el("option", { value: p.id }, p.product_name || p.product_model || "Untitled product")),
    ]);
    const status = el("span", { class: "up-status", role: "status", "aria-live": "polite", style: "margin:0" }, "");
    const syncBtn = actionBtn("Sync from CELLAR", "refresh", { onClick: () => syncAll() });
    const addBtn = actionBtn("Add directive", "plus", { primary: true, onClick: () => addDirectiveModal() });
    const narrativeBtn = actionBtn("Generate narrative", "sparkles", { onClick: () => narrativeModal() });
    const controls = el("div", { class: "row-tools", style: "flex-wrap:wrap; gap:0.5rem; align-items:center" }, [
      el("span", { class: "form-label", style: "margin:0" }, "View"), scopeSel, productSel,
      el("span", { class: "spacer" }), status, addBtn, syncBtn, narrativeBtn,
    ]);

    // ---- legend ----
    const legend = el("div", { class: "dg-legend" }, [
      el("span", { class: "dg-leg" }, [el("i", { class: "dg-dot", style: "background:#3fb56b" }), "Coverage >80%"]),
      el("span", { class: "dg-leg" }, [el("i", { class: "dg-dot", style: "background:#d9a441" }), "40–80%"]),
      el("span", { class: "dg-leg" }, [el("i", { class: "dg-dot", style: "background:#e0564f" }), "<40%"]),
      el("span", { class: "dg-leg" }, [el("i", { class: "dg-dot", style: "background:#8a94a6" }), "Not assessed"]),
      el("span", { class: "dg-leg" }, [el("i", { class: "dg-line solid" }), "requires / implements"]),
      el("span", { class: "dg-leg" }, [el("i", { class: "dg-line dashed" }), "references / amends"]),
      el("span", { class: "dg-leg" }, [el("i", { class: "dg-line dotted" }), "AI-inferred"]),
    ]);

    const svgWrap = el("div", { class: "dg-canvas" });
    const sidebar = el("div", { class: "dg-sidebar" }, el("div", { class: "muted", style: "padding:1rem" }, "Click a directive to see its scope, coverage and relationships."));
    const stage = el("div", { class: "dg-stage" }, [svgWrap, sidebar]);
    const gapsMount = el("div", { style: "margin-top:1rem" });
    const wrap = el("div", {}, [
      controls, legend, stage, gapsMount,
    ]);
    mount.replaceChildren(wrap);

    // ---- data + draw ----
    const load = async () => {
      status.className = "up-status"; status.textContent = "Loading…";
      if (state.scope === "product" && !state.passportId) {
        state.graph = { nodes: [], edges: [], gaps: [] };
        svgWrap.replaceChildren(el("div", { class: "empty" }, "Choose a product to see the directives assessed for it."));
        gapsMount.replaceChildren(); sidebar.replaceChildren(el("div", { class: "muted", style: "padding:1rem" }, "Choose a product above.")); status.textContent = ""; return;
      }
      try {
        const g = await API.analyseComplianceGraph(API.getToken(), { scope: state.scope, passportId: state.passportId });
        state.graph = { nodes: g.nodes || [], edges: g.edges || [], gaps: g.gaps || [] };
        status.textContent = "";
      } catch (ex) {
        svgWrap.replaceChildren(el("div", { class: "error", style: "padding:1rem" }, `Couldn't load the graph: ${ex.message}`));
        status.textContent = ""; return;
      }
      drawGraph();
      drawGaps();
      // First-load convenience: if the graph has directives but no relations yet,
      // pull them from CELLAR once per session (never blocks; may be a no-op offline).
      if (state.graph.nodes.length && !state.graph.edges.length) {
        const flag = `dg_synced_${state.scope}_${state.passportId || "co"}`;
        try { if (!sessionStorage.getItem(flag)) { sessionStorage.setItem(flag, "1"); syncAll(true); } } catch { /* ignore */ }
      }
    };

    const drawGraph = () => {
      const { nodes, edges } = state.graph;
      svgWrap.replaceChildren();
      if (!nodes.length) { svgWrap.replaceChildren(el("div", { class: "empty" }, state.scope === "product" ? "No applicable directives for this product yet." : state.scope === "company" ? "No directives marked as applying to the company yet." : "No directives in the platform yet. Run the directive SQL, or add one via “Add directive”.")); return; }
      const W = Math.max(520, svgWrap.clientWidth || 640), H = 460;
      const maxClauses = Math.max(1, ...nodes.map((n) => (n.coverage && n.coverage.total_clauses) || 0));
      const rOf = (n) => 16 + 14 * Math.sqrt(((n.coverage && n.coverage.total_clauses) || 0) / maxClauses);
      // D3 mutates copies (so our state stays clean).
      const N = nodes.map((n) => ({ ...n }));
      const byId = new Map(N.map((n) => [n.id, n]));
      const L = edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ ...e, source: e.source, target: e.target }));

      const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("class", "dg-svg").attr("width", "100%").attr("height", H);
      svg.append("defs").append("marker").attr("id", "dg-arrow").attr("viewBox", "0 -5 10 10").attr("refX", 22).attr("refY", 0).attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto")
        .append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", "#7a8699");
      const root = svg.append("g");
      svg.call(d3.zoom().scaleExtent([0.3, 3]).on("zoom", (ev) => root.attr("transform", ev.transform)));

      const sim = d3.forceSimulation(N)
        .force("link", d3.forceLink(L).id((d) => d.id).distance(130).strength(0.4))
        .force("charge", d3.forceManyBody().strength(-420))
        .force("center", d3.forceCenter(W / 2, H / 2))
        .force("collide", d3.forceCollide().radius((d) => rOf(d) + 8));

      const link = root.append("g").attr("stroke-opacity", 0.75).selectAll("line").data(L).join("line")
        .attr("stroke", (d) => d.sourceKind === "ai_inferred" ? "#8a6fd0" : "#7a8699")
        .attr("stroke-width", (d) => 1 + 1.5 * (d.confidence || 1))
        .attr("stroke-dasharray", (d) => dgEdgeDash(d))
        .attr("marker-end", "url(#dg-arrow)")
        .style("cursor", "pointer")
        .on("click", (ev, d) => { ev.stopPropagation(); showEdge(d, byId); });
      link.append("title").text((d) => `${byId.get(d.source.id || d.source)?.shortName || ""} ${REL_LABELS[d.relationType] || d.relationType} ${byId.get(d.target.id || d.target)?.shortName || ""}`);

      const node = root.append("g").selectAll("g").data(N).join("g").style("cursor", "pointer")
        .on("click", (ev, d) => { ev.stopPropagation(); showNode(d); })
        .call(d3.drag()
          .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
          .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
          .on("end", (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
      node.append("circle").attr("r", rOf).attr("fill", (d) => dgCoverageColor(d.complianceCoverage)).attr("stroke", "#0d1017").attr("stroke-width", 2)
        .attr("opacity", (d) => d.applicabilityStatus === "partial" || d.applicabilityStatus === "under_review" ? 0.6 : 1);
      node.append("text").text((d) => d.shortName).attr("text-anchor", "middle").attr("dy", "0.32em").attr("class", "dg-node-label").attr("pointer-events", "none");
      node.append("title").text((d) => `${d.shortName} (${d.celex}) — ${dgCoverageLabel(d.complianceCoverage)}`);

      svg.on("click", () => sidebar.replaceChildren(el("div", { class: "muted", style: "padding:1rem" }, "Click a directive to see its scope, coverage and relationships.")));
      sim.on("tick", () => {
        link.attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y).attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
        node.attr("transform", (d) => `translate(${d.x},${d.y})`);
      });
      svgWrap.replaceChildren(svg.node());
    };

    const showNode = (n) => {
      const rel = state.graph.edges.filter((e) => e.source === n.id || e.target === n.id);
      const byId = new Map(state.graph.nodes.map((x) => [x.id, x]));
      const cov = n.coverage || {};
      const bar = el("div", { class: "dg-cov-track" }, el("div", { class: "dg-cov-fill", style: `width:${n.complianceCoverage || 0}%; background:${dgCoverageColor(n.complianceCoverage)}` }));
      sidebar.replaceChildren(el("div", { class: "dg-side-inner" }, [
        el("div", { class: "dg-side-head" }, [el("h3", {}, n.shortName), el("span", { class: "dg-celex" }, n.celex)]),
        el("p", { class: "muted", style: "margin:0.2rem 0 0.6rem" }, n.title || ""),
        n.applicabilityStatus ? el("span", { class: "dg-pill" }, `Applicability: ${n.applicabilityStatus}`) : null,
        el("div", { class: "dg-side-block" }, [
          el("div", { class: "dg-side-label" }, `Compliance coverage — ${dgCoverageLabel(n.complianceCoverage)}`),
          bar,
          el("div", { class: "muted", style: "font-size:0.78rem; margin-top:0.3rem" }, cov.total_clauses ? `${cov.covered_clauses}/${cov.total_clauses} clauses compliant · ${cov.deviation_count} deviation(s) · ${cov.pending_count} pending` : "No clause-level interpretations mapped to this directive yet."),
        ]),
        el("div", { class: "dg-side-block" }, [
          el("div", { class: "dg-side-label" }, `Related directives (${rel.length})`),
          rel.length ? el("ul", { class: "dg-rel-list" }, rel.map((e) => {
            const otherId = e.source === n.id ? e.target : e.source;
            const other = byId.get(otherId);
            const dir = e.source === n.id ? "→" : "←";
            return el("li", {}, [el("strong", {}, other ? other.shortName : "?"), ` ${dir} ${REL_LABELS[e.relationType] || e.relationType}`, e.sourceKind === "ai_inferred" ? el("span", { class: "dg-conf" }, ` AI · ${Math.round((e.confidence || 0) * 100)}%`) : null]);
          })) : el("div", { class: "muted", style: "font-size:0.8rem" }, "No relations synced yet — use “Sync from CELLAR”."),
        ]),
        el("div", { class: "dg-side-actions" }, [
          n.celex ? el("a", { class: "btn btn-sm", href: `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${n.celex}`, target: "_blank", rel: "noopener" }, "Open in EUR-Lex") : null,
          actionBtn("Standards register", "layers", { onClick: () => { const t = $("#tab-standards"); if (t) { t.click(); t.focus(); } } }),
          state.scope === "product" && state.passportId ? actionBtn("Set applicability", "edit", { onClick: () => applicabilityModal(n) }) : null,
        ]),
      ]));
    };

    const showEdge = (e, byId) => {
      const s = byId.get(e.source.id || e.source), t = byId.get(e.target.id || e.target);
      sidebar.replaceChildren(el("div", { class: "dg-side-inner" }, [
        el("div", { class: "dg-side-head" }, [el("h3", {}, `${s?.shortName || "?"} → ${t?.shortName || "?"}`)]),
        el("div", { class: "dg-kv" }, [el("span", {}, "Relation"), el("strong", {}, REL_LABELS[e.relationType] || e.relationType)]),
        e.clauses && e.clauses.source ? el("div", { class: "dg-kv" }, [el("span", {}, "Source clause"), el("strong", {}, e.clauses.source)]) : null,
        e.clauses && e.clauses.target ? el("div", { class: "dg-kv" }, [el("span", {}, "Target clause"), el("strong", {}, e.clauses.target)]) : null,
        el("div", { class: "dg-kv" }, [el("span", {}, "Source"), el("strong", {}, e.sourceKind === "cellar_sparql" ? "CELLAR (SPARQL)" : e.sourceKind === "akn_ref_element" ? "CELLAR (text cross-ref)" : "AI-inferred")]),
        el("div", { class: "dg-kv" }, [el("span", {}, "Confidence"), el("strong", { style: `color:${(e.confidence || 1) >= 0.8 ? "#3fb56b" : "#d9a441"}` }, `${Math.round((e.confidence != null ? e.confidence : 1) * 100)}%`)]),
        e.description ? el("p", { class: "muted", style: "margin:0.5rem 0 0; font-size:0.82rem" }, e.description) : null,
        e.sourceKind === "ai_inferred" ? el("div", { class: "notice warn", style: "margin-top:0.5rem; font-size:0.8rem" }, "AI-inferred relationship — verify before relying on it.") : null,
      ]));
    };

    const drawGaps = () => {
      const gaps = state.graph.gaps || [];
      if (!gaps.length) { gapsMount.replaceChildren(); return; }
      const rows = gaps.map((g) => el("tr", {}, [
        el("td", {}, el("code", {}, g.celex)),
        el("td", {}, g.shortName || (g.inRegistry ? "—" : el("span", { class: "muted" }, "not in portal"))),
        el("td", { class: "muted", style: "font-size:0.82rem" }, g.reason),
        el("td", {}, actionBtn("Add to portal", "plus", { primary: true, onClick: (ev) => { const b = ev.currentTarget; addGapDirective(g, b); } })),
      ]));
      gapsMount.replaceChildren(el("div", { class: "card" }, [
        el("h3", { style: "margin:0 0 0.2rem" }, `Gaps — referenced directives not yet in scope (${gaps.length})`),
        el("p", { class: "muted", style: "margin:0 0 0.7rem; font-size:0.85rem" }, "Directives referenced by applicable ones that aren’t in the portal (or aren’t assessed). Add them to complete the picture."),
        el("table", { class: "dg-gap-table" }, [
          el("thead", {}, el("tr", {}, [el("th", {}, "CELEX"), el("th", {}, "Name"), el("th", {}, "Why"), el("th", {}, "")])),
          el("tbody", {}, rows),
        ]),
      ]));
    };

    const addGapDirective = async (g, btn) => {
      if (btn) btn.disabled = true;
      status.className = "up-status"; status.textContent = `Adding ${g.celex} from CELLAR…`;
      try {
        const r = await API.addDirective(API.getToken(), { celexNumber: g.celex, shortName: g.shortName || "", appliesToCompany: state.scope !== "product" });
        if (r.id) { try { await API.syncDirectiveRelations(API.getToken(), r.id); } catch { /* offline */ } }
        status.className = "up-status ok"; status.textContent = `Added ${g.celex}.`;
        await load();
      } catch (ex) { if (btn) btn.disabled = false; status.className = "up-status err"; status.textContent = `Couldn't add: ${ex.message}`; }
    };

    const syncAll = async (silent) => {
      const nodes = (state.graph && state.graph.nodes) || [];
      if (!nodes.length) { if (!silent) { status.className = "up-status warn"; status.textContent = "No directives to sync yet."; } return; }
      status.className = "up-status"; status.textContent = `Syncing ${nodes.length} directive(s) from CELLAR…`;
      let found = 0, offline = 0;
      await Promise.all(nodes.map(async (n) => {
        try { const r = await API.syncDirectiveRelations(API.getToken(), n.id); found += r.relationsFound || 0; if (r.offline) offline++; } catch { offline++; }
      }));
      if (offline === nodes.length && !found) { status.className = "up-status warn"; status.textContent = "CELLAR returned no relations (endpoint unreachable or no data yet)."; if (silent) return; }
      else { status.className = "up-status ok"; status.textContent = `Synced — ${found} relation(s) found.`; }
      await load();
    };

    // ---- modals ----
    const addDirectiveModal = () => {
      const celex = el("input", { type: "text", class: "up-text", placeholder: "CELEX number, e.g. 32014L0035" });
      const short = el("input", { type: "text", class: "up-text", placeholder: "Short name, e.g. LVD (optional)" });
      const company = el("input", { type: "checkbox", checked: state.scope !== "product" ? "checked" : null });
      const note = el("p", { class: "up-status", role: "status" }, "");
      const save = el("button", { class: "btn btn-primary", type: "button" }, "Add from CELLAR");
      const close = openModal("Add an EU directive / regulation", el("div", { class: "step-form" }, [
        el("p", { class: "muted", style: "margin:0" }, "Enter the CELEX number — the metadata (title, type, date) is fetched from CELLAR. Find CELEX numbers on EUR-Lex."),
        el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "CELEX"), celex]),
        el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Short name"), short]),
        el("label", { class: "aud-check" }, [company, " Applies to the company (show in Company view)"]),
        note, el("div", { style: "margin-top:0.5rem" }, save),
      ]));
      save.addEventListener("click", async () => {
        if (!celex.value.trim()) { note.className = "up-status warn"; note.textContent = "Enter a CELEX number."; return; }
        save.disabled = true; note.className = "up-status"; note.textContent = "Fetching from CELLAR…";
        try {
          const r = await API.addDirective(API.getToken(), { celexNumber: celex.value.trim(), shortName: short.value.trim(), appliesToCompany: company.checked });
          if (r.id) { try { await API.syncDirectiveRelations(API.getToken(), r.id); } catch { /* offline */ } }
          if (state.scope === "product" && state.passportId) { try { await API.setDirectiveApplicability(API.getToken(), { passportId: state.passportId, directiveId: r.id, status: "applicable", rationale: "" }); } catch { /* optional */ } }
          close(); await load();
        } catch (ex) { save.disabled = false; note.className = "up-status err"; note.textContent = `Failed: ${ex.message}`; }
      });
    };

    const applicabilityModal = (n) => {
      const sel = el("select", { class: "up-text" }, ["applicable", "partial", "under_review", "not_applicable"].map((s) => el("option", { value: s, selected: n.applicabilityStatus === s ? "selected" : null }, s.replace(/_/g, " "))));
      const rationale = el("textarea", { rows: "3", placeholder: "Why (optional)" });
      const note = el("p", { class: "up-status", role: "status" }, "");
      const save = el("button", { class: "btn btn-primary", type: "button" }, "Save");
      const close = openModal(`Applicability — ${n.shortName}`, el("div", { class: "step-form" }, [
        el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Status"), sel]),
        el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Rationale"), rationale]),
        note, el("div", { style: "margin-top:0.5rem" }, save),
      ]));
      save.addEventListener("click", async () => {
        save.disabled = true; note.className = "up-status"; note.textContent = "Saving…";
        try { await API.setDirectiveApplicability(API.getToken(), { passportId: state.passportId, directiveId: n.id, status: sel.value, rationale: rationale.value }); close(); await load(); }
        catch (ex) { save.disabled = false; note.className = "up-status err"; note.textContent = `Failed: ${ex.message}`; }
      });
    };

    const narrativeModal = () => {
      const lang = el("select", { class: "up-text" }, [el("option", { value: "en" }, "English"), el("option", { value: "sv" }, "Swedish")]);
      const out = el("div", { class: "dg-narrative", style: "white-space:pre-wrap; margin-top:0.7rem; min-height:3rem" }, "");
      const note = el("p", { class: "up-status", role: "status" }, "");
      const gen = el("button", { class: "btn btn-primary", type: "button" }, "✨ Generate");
      const copy = el("button", { class: "btn btn-sm", type: "button", hidden: "" }, "Copy");
      openModal("Compliance narrative", el("div", { class: "step-form" }, [
        el("p", { class: "muted", style: "margin:0" }, `AI-written summary of how the ${state.scope === "product" ? "product's" : "company's"} directives relate, for a DoC or product passport.`),
        el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Language"), lang]),
        el("div", {}, [gen, " ", copy]), note, out,
      ]));
      gen.addEventListener("click", async () => {
        gen.disabled = true; note.className = "up-status"; note.textContent = "Generating…"; out.textContent = "";
        try {
          const r = await API.generateComplianceNarrative(API.getToken(), { scope: state.scope, passportId: state.passportId, language: lang.value });
          out.textContent = r.narrative || "(empty)"; copy.hidden = false;
          const cs = r.coverageSummary;
          note.className = "up-status ok"; note.textContent = cs ? `${cs.directiveCount} directives · ${cs.relationCount} relations · ${cs.gapCount} gaps` : "Done.";
        } catch (ex) { note.className = "up-status err"; note.textContent = `Failed: ${ex.message}`; }
        finally { gen.disabled = false; }
      });
      copy.addEventListener("click", () => { try { navigator.clipboard.writeText(out.textContent); copy.textContent = "Copied ✓"; setTimeout(() => copy.textContent = "Copy", 1500); } catch { /* ignore */ } });
    };

    scopeSel.addEventListener("change", () => { state.scope = scopeSel.value; productSel.hidden = state.scope !== "product"; state.passportId = state.scope === "product" ? (productSel.value || null) : null; load(); });
    productSel.addEventListener("change", () => { state.passportId = productSel.value || null; load(); });
    await load();
  }

  /* ------- Compliance Status dimension: Lifecycle phase × Scope (2×2) ------- */
  const PHASE_LABEL = { pre_launch: "Pre Launch", monitoring: "Monitoring" };
  const SCOPE_LABEL = { company: "Company", product_services: "Product & Services" };
  const CS_QUADS = [
    { key: "pre_launch|company", phase: "pre_launch", scope: "company" },
    { key: "pre_launch|product_services", phase: "pre_launch", scope: "product_services" },
    { key: "monitoring|company", phase: "monitoring", scope: "company" },
    { key: "monitoring|product_services", phase: "monitoring", scope: "product_services" },
  ];
  const phaseSelect = (val) => el("select", { class: "cs-sel", "aria-label": "Lifecycle phase" }, [
    el("option", { value: "", selected: !val ? "selected" : null }, "— phase —"),
    el("option", { value: "pre_launch", selected: val === "pre_launch" ? "selected" : null }, "Pre Launch"),
    el("option", { value: "monitoring", selected: val === "monitoring" ? "selected" : null }, "Monitoring"),
  ]);
  const scopeSelect = (val) => el("select", { class: "cs-sel", "aria-label": "Scope" }, [
    el("option", { value: "", selected: !val ? "selected" : null }, "— scope —"),
    el("option", { value: "company", selected: val === "company" ? "selected" : null }, "Company"),
    el("option", { value: "product_services", selected: val === "product_services" ? "selected" : null }, "Product & Services"),
  ]);

  async function renderComplianceMatrix(role, mount, opts = {}) {
    const canEdit = role === "rushroom";
    const token = () => API.getToken();
    let matrix = null, items = [];
    const state = { filter: null };            // {type:'quad',key,phase,scope} | {type:'unclassified'} | null
    const selected = new Set();                // keys "entityType:id"
    let proposals = null;                       // AI proposals awaiting accept/reject

    mount.replaceChildren(el("div", { class: "loading" }, "Loading compliance matrix…"));

    const reload = async () => {
      try {
        const [m, li] = await Promise.all([API.getComplianceMatrix(token()), API.listClassificationItems(token(), {})]);
        matrix = m; items = li.items || [];
      } catch (ex) {
        if (/aren't set up/i.test(ex.message)) { mount.replaceChildren(el("div", { class: "cs-setup notice" }, "The Compliance Matrix needs its database columns — run the classification SQL in Supabase, then reload.")); return; }
        mount.replaceChildren(el("div", { class: "error" }, `Couldn't load the compliance matrix: ${ex.message}`)); return;
      }
      render();
    };
    mount.__reload = reload;   // let the steps view refresh the matrix after step edits

    const setFilter = (f) => { state.filter = f; render(); };

    const applyOne = async (item, phase, scope) => {
      try {
        await API.setClassification(token(), { entityType: item.entityType, ids: [item.id], lifecyclePhase: phase, scope, aiGenerated: false });
        await reload();
      } catch (ex) { alert(`Couldn't save: ${ex.message}`); }
    };

    const applyBulk = async (phase, scope) => {
      const byType = { document: [], interpretation: [] };
      for (const k of selected) { const [t, id] = k.split(":"); byType[t] && byType[t].push(id); }
      try {
        for (const t of ["document", "interpretation"]) if (byType[t].length) await API.setClassification(token(), { entityType: t, ids: byType[t], lifecyclePhase: phase, scope, aiGenerated: false });
        selected.clear(); await reload();
      } catch (ex) { alert(`Couldn't apply: ${ex.message}`); }
    };

    const runSuggest = async (visibleItems) => {
      const ids = visibleItems.filter((i) => !i.lifecycle_phase || !i.scope).map((i) => i.id);
      if (!ids.length) return;
      const btn = mount.querySelector(".cs-suggest-btn"); if (btn) { btn.disabled = true; btn.textContent = "Thinking…"; }
      try { const r = await API.suggestClassifications(token(), ids); proposals = r.proposals || []; render(); }
      catch (ex) { alert(`Couldn't get suggestions: ${ex.message}`); if (btn) { btn.disabled = false; btn.textContent = "✨ Suggest classifications"; } }
    };
    const acceptProposal = async (p) => {
      try { await API.setClassification(token(), { entityType: p.entityType, ids: [p.id], lifecyclePhase: p.lifecyclePhase, scope: p.scope, aiGenerated: true }); proposals = proposals.filter((x) => x.id !== p.id); await reload(); }
      catch (ex) { alert(`Couldn't accept: ${ex.message}`); }
    };
    const rejectProposal = (p) => { proposals = proposals.filter((x) => x.id !== p.id); render(); };

    const quadCard = (q) => {
      const data = (matrix.quadrants && matrix.quadrants[q.key]) || { total: 0, pct_compliant: null, colour: "grey" };
      const active = state.filter && state.filter.type === "quad" && state.filter.key === q.key;
      return el("button", { class: `cs-quad cs-${data.colour}${active ? " active" : ""}`, type: "button", onclick: () => setFilter(active ? null : { type: "quad", ...q }) }, [
        el("div", { class: "cs-quad-title" }, `${PHASE_LABEL[q.phase]} · ${SCOPE_LABEL[q.scope]}`),
        el("div", { class: "cs-quad-count" }, String(data.total)),
        el("div", { class: "cs-quad-sub" }, data.total === 0 ? "no items" : (data.pct_compliant == null ? "—" : `${data.pct_compliant}% compliant`)),
      ]);
    };

    const render = () => {
      const u = (matrix && matrix.unclassified) || { total: 0 };
      const activeU = state.filter && state.filter.type === "unclassified";
      const grid = el("div", { class: "cs-grid" }, [
        ...CS_QUADS.map(quadCard),
        el("button", { class: `cs-quad cs-unclassified${activeU ? " active" : ""}${u.total ? " has-unc" : ""}`, type: "button", onclick: () => setFilter(activeU ? null : { type: "unclassified" }) }, [
          el("div", { class: "cs-quad-title" }, "Unclassified"),
          el("div", { class: "cs-quad-count" }, String(u.total || 0)),
          el("div", { class: "cs-quad-sub" }, u.total ? "needs classifying" : "all classified"),
        ]),
      ]);

      // Filter the item list per the active quadrant / unclassified selection.
      let shown = items;
      if (state.filter) {
        if (state.filter.type === "unclassified") shown = items.filter((i) => !i.effective_phase || !i.effective_scope);
        else shown = items.filter((i) => i.effective_phase === state.filter.phase && i.effective_scope === state.filter.scope);
      }

      const header = el("div", { class: "cs-head" }, [
        el("h3", { style: "margin:0" }, "Compliance matrix"),
        el("span", { class: "muted", style: "font-size:0.82rem" }, state.filter ? `${shown.length} item(s) — ` : "Lifecycle phase × scope. "),
        state.filter ? el("button", { class: "btn btn-sm", type: "button", onclick: () => setFilter(null) }, "Clear filter") : null,
        el("span", { class: "spacer" }),
        canEdit ? el("button", { class: "btn btn-sm cs-suggest-btn", type: "button", onclick: () => runSuggest(shown) }, "✨ Suggest classifications") : null,
      ]);

      const parts = [grid, header];

      // AI proposals panel.
      if (proposals && proposals.length) {
        parts.push(el("div", { class: "cs-proposals card" }, [
          el("div", { class: "cs-prop-head" }, [el("strong", {}, `AI suggestions (${proposals.length})`), el("span", { class: "spacer" }),
            el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: async () => { for (const p of [...proposals]) await acceptProposal(p); } }, "Accept all"),
            el("button", { class: "btn btn-sm", type: "button", onclick: () => { proposals = null; render(); } }, "Dismiss"),
          ]),
          ...proposals.map((p) => el("div", { class: "cs-prop-row" }, [
            el("div", { class: "cs-prop-label" }, [el("strong", {}, p.label), p.sublabel ? el("span", { class: "muted" }, ` — ${p.sublabel}`) : null]),
            el("span", { class: "cs-pill" }, `${PHASE_LABEL[p.lifecyclePhase]} · ${SCOPE_LABEL[p.scope]}`),
            el("span", { class: "cs-conf", title: p.rationale }, `${Math.round(p.confidence * 100)}%`),
            el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => acceptProposal(p) }, "Accept"),
            el("button", { class: "btn btn-sm", type: "button", onclick: () => rejectProposal(p) }, "Reject"),
          ])),
        ]));
      } else if (proposals && !proposals.length) {
        parts.push(el("div", { class: "notice", style: "margin-top:0.5rem" }, "No AI suggestions returned."));
      }

      // Bulk bar.
      if (canEdit && selected.size) {
        const bp = phaseSelect(""), bs = scopeSelect("");
        parts.push(el("div", { class: "cs-bulk" }, [
          el("strong", {}, `${selected.size} selected`), bp, bs,
          el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => applyBulk(bp.value || null, bs.value || null) }, "Apply to selected"),
          el("button", { class: "btn btn-sm", type: "button", onclick: () => { selected.clear(); render(); } }, "Clear"),
        ]));
      }

      // Item list.
      if (!shown.length) parts.push(el("div", { class: "empty", style: "margin-top:0.6rem" }, state.filter ? "No items in this filter." : "No compliance items yet — add documents or clause interpretations."));
      else parts.push(el("div", { class: "cs-list" }, shown.map((it) => {
        const key = `${it.entityType}:${it.id}`;
        const row = el("div", { class: "cs-row" });
        if (canEdit) {
          const cb = el("input", { type: "checkbox", "aria-label": "Select", checked: selected.has(key) ? "checked" : null });
          cb.addEventListener("change", () => { if (cb.checked) selected.add(key); else selected.delete(key); render(); });
          row.appendChild(cb);
        }
        const typeTag = it.entityType === "document" ? "DOC" : it.entityType === "step" ? "ACTION" : "CLAUSE";
        row.appendChild(el("div", { class: "cs-row-main" }, [
          el("div", { class: "cs-row-label" }, [el("span", { class: `cs-type cs-type-${it.entityType}` }, typeTag), " ", it.label]),
          it.sublabel ? el("div", { class: "cs-row-sub muted" }, it.sublabel) : null,
        ]));
        if (canEdit) {
          const ps = phaseSelect(it.lifecycle_phase), ss = scopeSelect(it.scope);
          ps.addEventListener("change", () => applyOne(it, ps.value || null, ss.value || null));
          ss.addEventListener("change", () => applyOne(it, ps.value || null, ss.value || null));
          const cell = el("div", { class: "cs-row-cls" }, [ps, ss]);
          if (it.entityType === "step" && opts.onEditStep) cell.appendChild(el("button", { class: "btn btn-sm", type: "button", title: "Edit this action", onclick: () => opts.onEditStep(it) }, "Edit"));
          if (it.ai) cell.appendChild(el("span", { class: "cs-ai", title: "AI-classified — review" }, "AI"));
          if (it.inherited && (!it.lifecycle_phase || !it.scope)) cell.appendChild(el("span", { class: "cs-inherit", title: "Inherited from parent document" }, "inherited"));
          row.appendChild(cell);
        } else {
          row.appendChild(el("div", { class: "cs-row-cls" }, [
            el("span", { class: "cs-pill" }, it.effective_phase ? PHASE_LABEL[it.effective_phase] : "—"),
            el("span", { class: "cs-pill" }, it.effective_scope ? SCOPE_LABEL[it.effective_scope] : "—"),
          ]));
        }
        return row;
      })));

      mount.replaceChildren(el("div", { class: "cs-matrix card" }, parts));
    };

    await reload();
  }

  /* ------- Compliance Map: a true 2×2 board over the classification data ------- */
  async function renderComplianceMap(role, mount) {
    if (role !== "rushroom") { mount.replaceChildren(el("div", { class: "empty" }, "The compliance map is available to Rushroom users.")); return; }
    const token = () => API.getToken();
    const state = { cell: null };
    let matrix = null, items = [];
    const gridMount = el("div");
    const listMount = el("div", { class: "map-list", style: "margin-top:1rem" });

    const cellFor = (phase, scope) => {
      const key = `${phase}|${scope}`;
      const q = (matrix.quadrants && matrix.quadrants[key]) || { total: 0, steps: 0, documents: 0, interpretations: 0, pct_compliant: null, colour: "grey" };
      const active = state.cell === key;
      return el("button", { class: `map-cell map-${q.colour}${active ? " active" : ""}`, type: "button", onclick: () => { state.cell = active ? null : key; render(); } }, [
        el("div", { class: "map-count" }, String(q.total)),
        el("div", { class: "map-break muted" }, `${q.steps} actions · ${q.documents} docs · ${q.interpretations} clauses`),
        el("div", { class: "map-bar" }, el("div", { class: `map-bar-fill map-fill-${q.colour}`, style: `width:${q.pct_compliant || 0}%` })),
        el("div", { class: "map-pct" }, q.total === 0 ? "no items" : (q.pct_compliant == null ? "not rated" : `${q.pct_compliant}% done`)),
      ]);
    };

    const renderList = () => {
      if (!state.cell) { listMount.replaceChildren(); return; }
      let inCell, title;
      if (state.cell === "__unc__") { inCell = items.filter((i) => !i.effective_phase || !i.effective_scope); title = "Unclassified"; }
      else { const [phase, scope] = state.cell.split("|"); inCell = items.filter((i) => i.effective_phase === phase && i.effective_scope === scope); title = `${PHASE_LABEL[phase]} · ${SCOPE_LABEL[scope]}`; }
      listMount.replaceChildren(el("div", { class: "card" }, [
        el("div", { style: "display:flex; align-items:center; gap:0.5rem" }, [el("h3", { style: "margin:0" }, `${title} — ${inCell.length} item(s)`), el("span", { class: "spacer" }), el("button", { class: "btn btn-sm", type: "button", onclick: () => { state.cell = null; render(); } }, "Close")]),
        inCell.length ? el("div", { class: "cs-list", style: "margin-top:0.6rem" }, inCell.map((it) => el("div", { class: "cs-row" }, [
          el("div", { class: "cs-row-main" }, [
            el("div", { class: "cs-row-label" }, [el("span", { class: `cs-type cs-type-${it.entityType}` }, it.entityType === "document" ? "DOC" : it.entityType === "step" ? "ACTION" : "CLAUSE"), " ", it.label]),
            it.sublabel ? el("div", { class: "cs-row-sub muted" }, it.sublabel) : null,
          ]),
          it.compliance_status ? el("span", { class: `map-status map-st-${it.compliance_status}` }, it.compliance_status.replace(/_/g, " ")) : null,
          it.ai ? el("span", { class: "cs-ai", title: "AI-classified" }, "AI") : null,
        ]))) : el("div", { class: "empty", style: "margin-top:0.6rem" }, "No items."),
      ]));
    };

    const render = () => {
      const u = (matrix && matrix.unclassified) || { total: 0, steps: 0, documents: 0, interpretations: 0 };
      const t = (matrix && matrix.totals) || {};
      const grid = el("div", { class: "map-grid" }, [
        el("div", { class: "map-corner muted" }, "phase ╲ scope"),
        el("div", { class: "map-colh" }, "Company"),
        el("div", { class: "map-colh" }, "Product & Services"),
        el("div", { class: "map-rowh" }, "Pre Launch"),
        cellFor("pre_launch", "company"), cellFor("pre_launch", "product_services"),
        el("div", { class: "map-rowh" }, "Monitoring"),
        cellFor("monitoring", "company"), cellFor("monitoring", "product_services"),
      ]);
      const unc = u.total
        ? el("button", { class: `map-unclassified${state.cell === "__unc__" ? " active" : ""}`, type: "button", onclick: () => { state.cell = state.cell === "__unc__" ? null : "__unc__"; render(); } }, [
            el("strong", {}, `${u.total} unclassified`), el("span", { class: "muted" }, ` — ${u.steps} actions · ${u.documents} docs · ${u.interpretations} clauses (classify them in the action / document forms)`),
          ])
        : el("div", { class: "muted", style: "margin-top:0.6rem; font-size:0.85rem" }, "✓ All items are classified.");
      const summary = el("div", { class: "map-summary muted" }, `${t.classified || 0} of ${t.total || 0} items classified · ${t.steps || 0} actions · ${t.documents || 0} docs · ${t.interpretations || 0} clauses. Green ≥80% done · amber 40–79% · red <40% · grey not rated. Click a cell to list its items.`);
      gridMount.replaceChildren(el("div", {}, [grid, unc, summary]));
      renderList();
    };

    const load = async () => {
      gridMount.replaceChildren(el("div", { class: "loading" }, "Loading compliance map…"));
      try { const [m, li] = await Promise.all([API.getComplianceMatrix(token()), API.listClassificationItems(token(), {})]); matrix = m; items = li.items || []; }
      catch (ex) {
        if (/aren't set up/i.test(ex.message)) { gridMount.replaceChildren(el("div", { class: "notice" }, "The compliance map needs its database columns — run the classification SQL in Supabase, then reload.")); return; }
        gridMount.replaceChildren(el("div", { class: "error" }, `Couldn't load the compliance map: ${ex.message}`)); return;
      }
      render();
    };

    const tools = el("div", { class: "row-tools" }, [
      el("h2", { style: "margin:0; font-size:1.1rem" }, "Compliance Map"),
      el("span", { class: "spacer" }),
      actionBtn("Refresh", "refresh", { onClick: load }),
      actionBtn("Print / Save PDF", "printer", { onClick: () => window.print() }),
    ]);
    mount.replaceChildren(el("div", {}, [tools, gridMount, listMount]));
    await load();
  }

  // Full API render for a page: editable readiness + documents + uploads.
  async function renderApi(role, readinessMountId) {
    wireTabs($("#tablist"));
    // Steps are organised by their progress phase categories; the 2×2
    // classification matrix is not shown here (classification is captured in the
    // new-step form and persisted on each step/document).
    const mount = $(readinessMountId);
    const load = async () => {
      mount.replaceChildren(el("div", { class: "loading" }, "Loading…"));
      let payload;
      try { payload = await API.data(API.getToken(role)); }
      catch (ex) {
        if (/auth/i.test(ex.message)) { API.clearToken(role); location.reload(); return; }
        mount.replaceChildren(el("div", { class: "error" }, `Couldn't load: ${ex.message}`));
        return;
      }
      const steps = stepsFromApi(payload.steps);
      const onStatus = async (step, status, sel) => {
        sel.disabled = true;
        try { await API.setStatus(API.getToken(role), step, status); await load(); }
        catch (ex) { sel.disabled = false; alert(`Couldn't save: ${ex.message}`); }
      };
      const phases = [...new Set(steps.map((s) => s.phase))];
      const saveStep = (existing) => stepEditor(existing, phases, async (fields) => {
        if (existing) await API.updateStep(API.getToken(role), existing.step, fields);
        else await API.addStep(API.getToken(role), fields);
        await load();
      });
      const onDeleteStep = async (s) => {
        if (!confirm(`Delete action #${s.step}: “${(s.action || "").slice(0, 60)}”?`)) return;
        try { await API.deleteStep(API.getToken(role), s.step); await load(); }
        catch (ex) { alert(`Couldn't delete: ${ex.message}`); }
      };
      // One toolbar: Expand/Collapse all sit alongside Refresh / Add step / Print.
      const tools = el("div", { class: "row-tools" }, [
        actionBtn("Expand all", "expand", { onClick: () => setAllPhases(true) }),
        actionBtn("Collapse all", "collapse", { onClick: () => setAllPhases(false) }),
        actionBtn("Refresh", "refresh", { onClick: load }),
        role === "rushroom" ? actionBtn("Add action", "plus", { primary: true, onClick: () => saveStep(null) }) : null,
        actionBtn("Print / Save PDF", "printer", { onClick: () => window.print() }),
        el("span", { class: "spacer" }),
        el("span", { class: "updated" }, `Live · ${(API.session() && (API.session().name || API.session().urole)) || role} · ${new Date().toLocaleTimeString("en-GB")}`),
      ]);
      const frag = el("div", {}, [
        summaryTiles(steps),
        tools,
        phaseOverview(steps),
        blockersPanel(steps),
        el("h2", { class: "visually-hidden" }, "Actions by phase"),
        phaseSections(steps, role === "rushroom"
          ? { editable: true, onStatus, onEditStep: saveStep, onDeleteStep }
          : { editable: true, onStatus }),
      ]);
      // Rushroom sees the Compliance Map as a sub-tab alongside the status
      // overview; other roles get the status overview on its own.
      if (role === "rushroom") {
        mount.replaceChildren(subTabs("compliance", [
          { id: "status", label: "Status", icon: "gauge", build: () => frag },
          { id: "map", label: "Compliance Map", icon: "grid", build: () => {
            const m = el("div", {}, el("div", { class: "loading" }, "Loading compliance map…"));
            renderComplianceMap(role, m);
            return m;
          } },
        ]));
      } else {
        mount.replaceChildren(...frag.childNodes);
      }

      const templatesOf = () => (payload.documents || []).filter((d) => (d.kind || "template") === "template" && d.id);
      const onNewVersion = (d) => documentVersionEditor(d, role, load);
      const onEditVersion = (d, v) => editDocumentVersion(d, v, role, load);
      const onDraft = (d) => documentDraftAssistant(d, role, load, { templates: templatesOf() });
      const onCreateOperational = (d) => createOperationalFromTemplate(d, role, load, templatesOf());
      const onCreateNew = () => documentDraftAssistant(null, role, load, { mode: "create", templates: templatesOf() });
      // Admin/super-user only: permanently delete a document (records + files).
      const onDeleteDocument = async (d) => {
        const vc = (d.versions || []).length;
        if (!confirm(`Permanently delete “${d.name}”${vc ? ` and all ${vc} version${vc === 1 ? "" : "s"}` : ""}, including the stored files? This cannot be undone.`)) return;
        try { await API.deleteDocument(API.getToken(role), d.id); await load(); }
        catch (ex) { alert(`Couldn't delete: ${ex.message}`); }
      };
      const docsPanel = $("#documents-panel");
      const listTab = () => documentLibrary(role === "supplier" ? "supplier" : null, payload.documents, { manage: role === "rushroom", onNewVersion, onEditVersion, onDraft, onCreateOperational, onCreateNew, onDeleteDocument: API.isAdmin() ? onDeleteDocument : null });
      const addTab = () => (role === "supplier" ? uploadCard(role, steps) : manageDocumentsCard(role, load));
      // Supplier uploads is its own sub-tab (Rushroom only), alongside Library / Add document.
      const uploadsTab = () => {
        const mount = el("div", {}, el("div", { class: "loading" }, "Loading supplier uploads…"));
        uploadsReview(role, load).then((card) => mount.replaceChildren(card || el("div", { class: "empty" }, "No supplier uploads.")));
        return mount;
      };
      // Placeholder for upcoming product labels & instructions functionality.
      const labelsTab = () => el("div", { class: "card" }, [
        el("h3", {}, "Labels and Instructions"),
        el("p", { class: "muted", style: "margin:0.35rem 0 0" }, "Manage product labels (CE marking, warnings, ratings, energy labels) and the accompanying instructions and manuals here. Functionality is coming soon."),
      ]);
      const docTabs = [
        { id: "list", label: "Library", icon: "layers", build: listTab },
        { id: "add", label: role === "supplier" ? "Upload a document" : "Add document", icon: "plus", build: addTab },
      ];
      if (role === "rushroom") docTabs.push({ id: "labels", label: "Labels and Instructions", icon: "tag", build: labelsTab });
      if (role === "rushroom") docTabs.push({ id: "bom", label: "Product BOM", icon: "grid", build: () => { const m = el("div", {}); renderProduct(role, m); return m; } });
      if (role === "rushroom") docTabs.push({ id: "manufacturing", label: "Manufacturing BOM", icon: "gauge", build: () => { const m = el("div", {}); mBomView(role, m); return m; } });
      if (role === "rushroom") docTabs.push({ id: "uploads", label: "Supplier uploads", icon: "external", build: uploadsTab });
      docsPanel.replaceChildren(subTabs("documents", docTabs));
    };
    await load();
    const stdPanel = $("#standards-panel");
    if (stdPanel) renderStandards(role, stdPanel);
    // Deviation Monitoring hosts two sub-tabs: the AI scan and the Directive Graph.
    const devPanel = $("#deviations-panel");
    if (devPanel && role === "rushroom") {
      devPanel.replaceChildren(subTabs("deviations", [
        { id: "monitoring", label: "Monitoring", icon: "eye", build: () => { const m = el("div", {}, el("div", { class: "loading" }, "Loading deviation monitoring…")); renderDeviations(role, m); return m; } },
        { id: "graph", label: "Directive Graph", icon: "graph", build: () => { const m = el("div", {}, el("div", { class: "loading" }, "Loading directive graph…")); renderDirectiveGraph(role, m); return m; } },
      ]));
    }
    const acctPanel = $("#accounts-panel");
    if (acctPanel && API.isAdmin()) renderAccounts(role, acctPanel);
    const l2Panel = $("#level2-panel");
    if (l2Panel && role === "rushroom") renderLevel2(role, l2Panel);
  }

  // Hide tabs/panels the signed-in user isn't entitled to.
  function applyAccess(role, admin) {
    const gate = (tabId, panelId, ok) => {
      const t = $("#" + tabId), p = $("#" + panelId);
      if (t) t.hidden = !ok;
      if (!ok && p) p.hidden = true;
    };
    gate("tab-deviations", "deviations-panel", role === "rushroom");
    gate("tab-level2", "level2-panel", role === "rushroom");
    gate("tab-accounts", "accounts-panel", !!admin);
  }

  // Header session cluster: an admin/super-admin badge, the (admin-only)
  // Supplier-view link, and Sign out — grouped so they read as one identity.
  // Sticky banner shown while an operator is impersonating a tenant.
  function renderImpersonationBanner() {
    const app = $("#portal-app"); if (!app) return;
    let banner = $("#imp-banner");
    const imp = API.impersonation();
    if (!imp) { if (banner) banner.remove(); return; }
    if (!banner) { banner = el("div", { id: "imp-banner", class: "imp-banner" }); app.insertBefore(banner, app.firstChild); }
    banner.replaceChildren(
      el("span", {}, [el("strong", {}, "Support session · "), `Acting as ${imp.impOrg || "a tenant"}${imp.expiresAt ? " (expires " + fmtDate(imp.expiresAt) + ")" : ""}`]),
      el("button", { class: "btn btn-sm", type: "button", onclick: () => { API.endImpersonation(); location.reload(); } }, "Exit support session"),
    );
  }

  function renderSessionActions() {
    const nav = $("#session-actions");
    if (!nav) return;
    const s = API.session();
    if (!s) { nav.replaceChildren(); return; }
    const kids = [];
    if (s.admin) {
      kids.push(el("span", { class: "superadmin-badge", title: s.urole ? "Signed in as an administrator" : "Signed in with the shared super-admin password" }, s.urole ? "● Admin" : "● Super admin"));
      // Supplier view is an admin/super-admin capability (preview the supplier portal).
      kids.push(el("a", { class: "btn btn-sm btn-admin-link", href: "./supplier.html", title: "Open the supplier portal (admin)" }, "Supplier view →"));
    }
    kids.push(el("button", { class: "btn btn-sm", type: "button", onclick: () => { API.clearToken(); location.reload(); } }, "Sign out"));
    nav.replaceChildren(...kids);
  }

  // Individual email+password login gate (with forgot-password, self-register,
  // and a shared-password fallback for the bootstrap administrator).
  function setupLoginGate(onUnlock) {
    const gate = $("#gate"), appEl = $("#portal-app");
    const reveal = () => {
      const s = API.session() || {};
      applyAccess(s.role, s.admin);
      gate.hidden = true; appEl.hidden = false;
      renderSessionActions();
      renderImpersonationBanner();
      onUnlock(s);
      const h = appEl.querySelector("h2, h3"); if (h) { h.setAttribute("tabindex", "-1"); h.focus(); }
    };
    if (API.getToken()) { reveal(); return; }

    const email = el("input", { type: "email", id: "login-email", class: "up-text", autocomplete: "username", placeholder: "you@company.com", required: "" });
    const pass = el("input", { type: "password", id: "login-password", class: "up-text", autocomplete: "current-password", placeholder: "Your password", required: "" });
    const mfaInput = el("input", { type: "text", class: "up-text", inputmode: "numeric", autocomplete: "one-time-code", placeholder: "6-digit code", maxlength: "6" });
    const mfaRow = el("label", { class: "form-row", style: "display:none" }, [el("span", { class: "form-label" }, "Authenticator code"), mfaInput]);
    const err = el("p", { class: "form-error", role: "alert", "aria-live": "assertive" }, "");
    const btn = el("button", { class: "btn btn-primary", type: "submit" }, "Sign in");
    const form = el("form", { novalidate: "" }, [
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Email"), email]),
      el("label", { class: "form-row" }, [el("span", { class: "form-label" }, "Password"), pass]),
      mfaRow,
      el("div", { style: "margin-top:0.6rem" }, btn), err,
    ]);
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); err.textContent = ""; btn.disabled = true;
      try {
        await API.loginUser(email.value.trim(), pass.value, mfaInput.value.trim() || undefined);
        reveal();
      } catch (ex) {
        if (ex && (ex.code === "mfa_required" || ex.code === "mfa_invalid")) {
          mfaRow.style.display = ""; mfaInput.focus();
          err.textContent = ex.code === "mfa_invalid" ? "That code isn't valid — try again." : "Enter the code from your authenticator app.";
        } else { err.textContent = ex.message || "Sign in failed."; pass.select(); }
      } finally { btn.disabled = false; }
    });

    // Shared-password fallback (bootstrap admin / legacy).
    const sharedPass = el("input", { type: "password", class: "up-text", autocomplete: "off", placeholder: "Shared password" });
    const sharedErr = el("p", { class: "form-error" }, "");
    const sharedBtn = el("button", { class: "btn btn-sm", type: "button" }, "Unlock");
    sharedBtn.addEventListener("click", async () => {
      sharedErr.textContent = ""; sharedBtn.disabled = true;
      try { await API.login("rushroom", sharedPass.value); reveal(); }
      catch (ex) { sharedErr.textContent = ex.message || "Incorrect password."; }
      finally { sharedBtn.disabled = false; }
    });

    const card = gate.querySelector(".gate-card");
    card.replaceChildren(
      el("h2", { id: "gate-title" }, "Sign in"),
      el("p", { class: "muted" }, "Sign in with your email and password to view the portal."),
      form,
      el("div", { class: "gate-links" }, el("button", { class: "linklike", type: "button", onclick: () => forgotPasswordModal(email.value.trim()) }, "Forgot password?")),
      el("div", { class: "gate-register" }, [
        el("p", { class: "muted", style: "margin:0 0 0.5rem; font-size:0.9rem" }, "Don't have access yet?"),
        el("button", { class: "btn btn-sm", type: "button", onclick: registerModal }, "Register for access"),
      ]),
      el("details", { class: "gate-fallback" }, [
        el("summary", {}, "Administrator? Use the shared password"),
        el("div", { class: "form-row", style: "margin-top:0.5rem" }, [sharedPass, sharedBtn]),
        sharedErr,
      ]),
    );
    email.focus();
  }

  /* ---------------- expose shared API ---------------- */
  window.Portal = {
    CFG, $, $$, el, portalHash, setupGate, loadSteps, norm,
    summaryTiles, phaseOverview, phaseToolbar, blockersPanel, phaseSections, stepsTable, documentLibrary,
    sourceNotice, wireTabs, statusBadge,
    apiEnabled, setupApiGate, renderApi,
  };

  /* ---------------- full-portal page init ---------------- */
  // Clicking the brand (logo + "Compliance Portal") jumps to the Compliance
  // Status tab, once the portal is unlocked.
  function wireBrandHome() {
    const brand = $(".brand");
    if (!brand) return;
    const firstTab = $("#tablist .tab");
    brand.setAttribute("role", "link");
    brand.setAttribute("tabindex", "0");
    brand.setAttribute("title", firstTab ? `Go to ${firstTab.textContent.trim()}` : "Home");
    const go = () => {
      const app = $("#portal-app"), tab = $("#tablist .tab");
      if (app && !app.hidden && tab) { tab.click(); tab.focus(); window.scrollTo({ top: 0, behavior: "smooth" }); }
    };
    brand.addEventListener("click", go);
    brand.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  }

  // Light/dark theme toggle (persisted). The initial theme is applied by an
  // inline <head> script before paint; this just wires the button.
  const THEME_ICON = {
    dark: svg('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4l1.4-1.4M18 6l1.4-1.4"/>'),
    light: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z"/>'),
  };
  function wireThemeToggle() {
    const btn = $("#theme-toggle");
    if (!btn) return;
    const sync = () => {
      const light = document.documentElement.getAttribute("data-theme") === "light";
      btn.innerHTML = light ? THEME_ICON.light : THEME_ICON.dark; // moon while in light mode, sun while in dark mode
      const label = light ? "Switch to dark theme" : "Switch to light theme";
      btn.setAttribute("aria-label", label); btn.setAttribute("title", label);
    };
    sync();
    btn.addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("rushroom_theme", next); } catch { /* ignore */ }
      sync();
    });
  }

  function initFullPortal() {
    if (apiEnabled()) setupLoginGate((s) => renderApi(s.role || "rushroom", "#readiness-panel"));
    else setupGate(renderPortal); // read-only fallback
  }

  async function renderPortal() {
    wireTabs($("#tablist"));
    await refreshReadiness();
    $("#documents-panel").replaceChildren(documentLibrary(null));
  }

  async function refreshReadiness() {
    const mount = $("#readiness-panel");
    mount.replaceChildren(el("div", { class: "loading" }, "Loading status…"));
    try {
      const { steps, source } = await loadSteps();
      const tools = el("div", { class: "row-tools" }, [
        actionBtn("Expand all", "expand", { onClick: () => setAllPhases(true) }),
        actionBtn("Collapse all", "collapse", { onClick: () => setAllPhases(false) }),
        actionBtn("Reload status", "refresh", { onClick: refreshReadiness }),
        actionBtn("Print / Save PDF", "printer", { onClick: () => window.print() }),
        CFG.statusSheetViewUrl ? actionBtn("Open the plan", "external", { href: CFG.statusSheetViewUrl }) : null,
        el("span", { class: "spacer" }),
        el("span", { class: "updated" }, `${source === "live" ? "Live" : "Snapshot"} · loaded ${new Date().toLocaleTimeString("en-GB")}`),
      ]);
      const frag = el("div", {}, [
        sourceNotice(source),
        summaryTiles(steps),
        tools,
        phaseOverview(steps),
        blockersPanel(steps),
        el("h2", { class: "visually-hidden" }, "Actions by phase"),
        phaseSections(steps),
      ]);
      mount.replaceChildren(...frag.childNodes);
    } catch (err) {
      mount.replaceChildren(el("div", { class: "error" }, `Couldn't load status: ${err.message}. Check the published Sheet URL and sharing.`));
    }
  }

  if (document.body && document.body.dataset.page === "full") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initFullPortal);
    else initFullPortal();
  }
  // Wire the theme toggle + brand-home on any page that has them (portal, supplier).
  const wireChrome = () => { wireThemeToggle(); wireBrandHome(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireChrome);
  else wireChrome();
})();
