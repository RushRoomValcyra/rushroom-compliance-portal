/* Rushroom AB — Engineering & Compliance Platform: adding to a part (PROP-069)
 *
 * A part never holds real children. +child on a part offers two things, one
 * line each (docs/BOM_LOGIC_REVIEW.html §0b):
 *
 *   In the box         what comes with this order line — visual, no stock of
 *                      its own, may carry Hub/Site. Opens the normal picker.
 *   Prepared assembly  a new assembly with this part inside, the part
 *                      unchanged. One field to confirm, then the picker on it.
 *
 * childRule mirrors bom_child_rule() in the database (latest: migration 0042)
 * and bomChildRule() in portal-api/handlers/bom-structure.ts;
 * tests/bom-structure-rules.test.mjs fails if the three disagree.
 * Exposed as window.PortalBomRules — app.js is a closed function.
 */
(() => {
  const PART_TYPES = ["part", "raw_material", "spare_part"];

  // null = allowed; otherwise the reason it is not.
  function childRule(type, makeOrBuy, isReference) {
    if (type === "finished_good") {
      return "A finished good is bought and passed on untouched — it never holds children.";
    }
    if (PART_TYPES.includes(type) && !isReference) {
      return "A part never holds real children. Put it In the box, or make a Prepared assembly.";
    }
    if (type === "sub_assembly" && makeOrBuy === "purchased" && !isReference) {
      return "This assembly is bought complete — what is inside it goes In the box.";
    }
    if (isReference && ["sub_assembly", "phantom_assembly", "product_family"].includes(type) && !(type === "sub_assembly" && makeOrBuy === "purchased")) {
      return "Only a part, or an assembly we buy complete, has an In the box.";
    }
    return null;
  }

  // Takes In the box rather than real children: any part, whatever its
  // Sourcing, and an assembly we buy complete.
  const takesInTheBox = (c) => !!c && (PART_TYPES.includes(c.type) || (c.type === "sub_assembly" && c.make_or_buy === "purchased"));

  function el(tag, attrs = {}, kids = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (typeof v === "boolean") { if (v) n.setAttribute(k, ""); }
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(kids)) {
      if (c == null) continue;
      n.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return n;
  }

  const MUTED = "color:var(--muted,#8b93a1)";

  function option(icon, iconStyle, title, detail, onclick) {
    return el("button", {
      type: "button", role: "menuitem",
      style: "display:flex;gap:0.6rem;align-items:flex-start;width:100%;text-align:left;padding:0.55rem 0.6rem;border:0;border-radius:6px;background:transparent;cursor:pointer;color:inherit;font:inherit",
      onmouseenter: (ev) => { ev.currentTarget.style.background = "var(--hover,#f1f5f9)"; },
      onmouseleave: (ev) => { ev.currentTarget.style.background = "transparent"; },
      onclick,
    }, [
      el("span", { style: `width:1.6rem;height:1.6rem;border-radius:5px;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0;${iconStyle}` }, icon),
      el("span", {}, [
        el("div", { style: "font-weight:700;font-size:0.875rem" }, title),
        el("div", { style: `font-size:0.75rem;${MUTED}` }, detail),
      ]),
    ]);
  }

  // The two choices, as a small menu anchored to the button that opened it.
  // Shared by +child (openAddMenu) and by Move onto a part (app.js).
  function openTwoWays({ anchor, label, onInTheBox, onPrepared }) {
    document.querySelectorAll("[data-add-menu]").forEach((m) => m.remove());
    const menu = el("div", {
      "data-add-menu": "", role: "menu", "aria-label": label,
      // Above dialogs (--z-modal 1000): Move opens it from inside one.
      style: "position:fixed;z-index:calc(var(--z-modal, 1000) + 50);width:min(340px,92vw);padding:0.35rem;border:1px solid var(--border,#e2e8f0);border-radius:10px;background:var(--bg,#fff);box-shadow:0 8px 28px rgba(0,0,0,.16)",
    });
    const close = () => { menu.remove(); document.removeEventListener("mousedown", outside, true); document.removeEventListener("keydown", onKey, true); };
    const outside = (ev) => { if (!menu.contains(ev.target) && ev.target !== anchor) close(); };
    const onKey = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
    menu.append(
      option("▢", "background:var(--grey-bg,#f1f5f9)", "In the box",
        "What comes with this order line. No stock of its own.",
        () => { close(); onInTheBox(); }),
      option("⧉", "background:#e8f5ec;color:#15803d", "Prepared assembly",
        "New assembly with this part inside. Part unchanged.",
        () => { close(); onPrepared(); }),
    );
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    menu.style.top = `${r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", onKey, true);
    menu.querySelector("button").focus();
  }

  // +child on a part: In the box opens the picker; Prepared assembly builds
  // the wrapper and then opens the picker on it.
  // onAddTo(target, { reference }) opens the portal's normal add-child picker.
  function openAddMenu({ anchor, node, parentNode, token, onAddTo, onChanged }) {
    openTwoWays({
      anchor, label: `Add to ${node.name}`,
      onInTheBox: () => onAddTo(node, { reference: true }),
      onPrepared: () => openWrap({ node, parentNode, token, onAddTo, onChanged }),
    });
  }

  // Prepared assembly: one field. An existing Prepared assembly for this part
  // is offered first, so a second one is never made by accident. Inside a tree
  // the new one takes the part's place there; from the Parts list it stands alone.
  // onCreated(wrapper), when given, replaces "open the picker on it" — Move
  // uses it to drop the moved row straight into the new assembly.
  async function openWrap({ node, parentNode, token, onAddTo, onChanged, onCreated }) {
    const done = (w) => (onCreated ? onCreated(w) : onAddTo && onAddTo(w, { reference: false }));
    const overlay = el("div", { "data-modal-overlay": "", class: "modal-scrim" });
    const body = el("div", { style: "display:flex;flex-direction:column;gap:0.6rem" });
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (ev) => { if (ev.key === "Escape") close(); };
    overlay.append(el("div", {
      role: "dialog", "aria-modal": "true", "aria-label": "Prepared assembly",
      style: "background:var(--bg,#fff);border:1px solid var(--border,#e2e8f0);border-radius:10px;padding:1.1rem 1.25rem;width:min(480px,94vw);display:flex;flex-direction:column;gap:0.6rem",
    }, [el("strong", { style: "font-size:1rem" }, "Prepared assembly"), body]));
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);

    let existing = [];
    try {
      const r = await window.PortalAPI.post(token, "listParentsOf", { component_id: node.id });
      existing = (r.parents || []).filter((l) => l.parent && !l.is_reference)
        .map((l) => l.parent).filter((p) => p.type === "sub_assembly" && p.make_or_buy === "assembled");
    } catch { /* offering an existing one is a convenience, not a requirement */ }

    const nameInput = el("input", { class: "up-text", type: "text", value: `Prepared ${node.name}`, maxlength: "200", "aria-label": "Name", style: "width:100%;box-sizing:border-box" });
    const err = el("div", { role: "alert", style: "color:#e05454;font-size:0.8125rem;min-height:1rem" }, "");
    const createBtn = el("button", { class: "btn btn-sm btn-primary", type: "button" }, "Create");

    if (existing.length) {
      body.append(...existing.map((w) => el("button", {
        class: "btn btn-sm", type: "button", style: "text-align:left;white-space:normal",
        onclick: () => { close(); done(w); },
      }, `Use ${w.name}`)));
      body.append(el("div", { style: `font-size:0.75rem;${MUTED}` }, "or create a new one:"));
    }
    body.append(nameInput, err, el("div", { style: "display:flex;gap:0.5rem;justify-content:flex-end" }, [
      el("button", { class: "btn btn-sm", type: "button", onclick: close }, "Cancel"),
      createBtn,
    ]));

    const create = async () => {
      const name = nameInput.value.trim();
      if (!name) { err.textContent = "Give it a name."; nameInput.focus(); return; }
      createBtn.disabled = true; err.textContent = "";
      try {
        const r = await window.PortalAPI.post(token, "wrapInPrepared", {
          part_id: node.id, parent_id: parentNode ? parentNode.id : null, name,
        });
        close();
        if (onChanged) onChanged();
        done({ id: r.wrapper_id, name: r.name, part_number: r.part_number, type: "sub_assembly", make_or_buy: "assembled" });
      } catch (ex) {
        err.textContent = ex.message;
        createBtn.disabled = false;
      }
    };
    createBtn.addEventListener("click", create);
    nameInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") create(); });
    nameInput.focus();
    nameInput.select();
  }

  window.PortalBomRules = { childRule, takesInTheBox, openTwoWays, openAddMenu, openWrap };
})();
