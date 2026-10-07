/* Rushroom AB — Engineering & Compliance Platform: BOM structure rules (PROP-067)
 *
 * Which parent may hold which child is decided by the database (migration
 * 0040). This file holds the browser's side of that rule:
 *
 *   childRule        the same matrix, so the tree only offers what the
 *                    database will accept (three copies exist — SQL,
 *                    portal-api/handlers/bom-structure.ts and this one;
 *                    tests/bom-structure-rules.test.mjs fails if they differ)
 *   openChildIntent  "+child" on something we buy complete: what is this child?
 *                      1. we fit it        → a Prepared wrapper (openWrap)
 *                      2. comes with its order → In the box (PROP-068)
 *                      3. we work on the part  → an operation, nothing added
 *   openWrap         build "Prepared <name>" around a bought part, or add to the
 *                    Prepared assembly it already sits in
 *
 * See docs/BOM_LOGIC_REVIEW.html §5b. Exposed as window.PortalBomRules, the
 * same way viewer.js exposes PortalViewer — app.js is a closed function.
 */
(() => {
  const BOUGHT_COMPLETE_TYPES = ["part", "raw_material", "spare_part", "sub_assembly"];

  // null = allowed; otherwise the reason it is not. Keep in step with
  // bom_child_rule() in supabase/migrations/0040_bom_structure_rules.sql.
  function childRule(type, makeOrBuy, isReference) {
    if (type === "finished_good") {
      return "A finished good is bought and passed on untouched — it never holds children.";
    }
    if (isReference && (makeOrBuy !== "purchased" || type === "phantom_assembly" || type === "product_family")) {
      return "Only something we buy complete has an In the box: what comes with its order line.";
    }
    if (!isReference && makeOrBuy === "purchased" && BOUGHT_COMPLETE_TYPES.includes(type)) {
      return "This is bought complete. Something ordered separately and fitted to it goes into its Prepared wrapper; something that comes with its order is In the box.";
    }
    if (!isReference && makeOrBuy === "assembled" && ["part", "raw_material", "spare_part"].includes(type)) {
      return "A part we put together is a sub-assembly. Change its Type first.";
    }
    return null;
  }

  // Bought complete: fitted children are refused, reference children are not.
  const isBoughtComplete = (c) => !!c && c.make_or_buy === "purchased" && BOUGHT_COMPLETE_TYPES.includes(c.type);

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

  // Same chrome as the portal's other BOM dialogs (openMoveModal).
  function shell(title) {
    const overlay = el("div", { "data-modal-overlay": "", class: "modal-scrim" });
    const body = el("div", { style: "display:flex;flex-direction:column;gap:0.75rem" });
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (ev) => { if (ev.key === "Escape") close(); };
    const dialog = el("div", {
      role: "dialog", "aria-modal": "true", "aria-label": title,
      style: "background:var(--bg,#1a1f2e);border:1px solid var(--border,#2d3748);border-radius:10px;padding:1.25rem 1.5rem;width:min(640px,96vw);max-height:90vh;overflow-y:auto;display:flex;flex-direction:column;gap:0.75rem",
    }, [
      el("div", { style: "display:flex;align-items:center;gap:0.5rem" }, [
        el("strong", { style: "flex:1;font-size:1rem" }, title),
        el("button", { class: "btn btn-xs", type: "button", "aria-label": "Close", onclick: close }, "✕"),
      ]),
      body,
    ]);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    overlay.append(dialog);
    document.body.append(overlay);
    return { body, close };
  }

  const note = (text) => el("div", { style: "font-size:0.8125rem;color:var(--muted,#8b93a1);line-height:1.45" }, text);
  const errorLine = () => el("div", { role: "alert", style: "color:#e05454;font-size:0.8125rem;min-height:1.1rem" }, "");

  function choice(title, detail, onclick) {
    return el("button", {
      type: "button", class: "btn",
      style: "display:block;width:100%;text-align:left;padding:0.7rem 0.9rem;white-space:normal;line-height:1.4",
      onclick,
    }, [
      el("div", { style: "font-weight:700;font-size:0.875rem" }, title),
      el("div", { style: "font-size:0.8125rem;color:var(--muted,#8b93a1);margin-top:2px;font-weight:400" }, detail),
    ]);
  }

  // node:       the bought item the user pressed +child on
  // parentNode: the assembly it sits in on screen (null outside a tree)
  // onAddTo(target, opts): open the normal add-child picker on target;
  //                        opts.reference = true for path 2
  function openChildIntent({ node, parentNode, token, onAddTo, onChanged }) {
    const { body, close } = shell("What is this child?");
    body.append(
      note(`You buy ${node.name} complete. What you add under it decides what gets built.`),
      choice("We order it separately and fit it to this part",
        "Its own order line — hardware, pins, a switch we mount. It goes into a Prepared assembly next to the part, which stays exactly what we buy.",
        () => { close(); openWrap({ node, parentNode, token, onAddTo, onChanged }); }),
      choice("It comes In the box with this part",
        "Part of the same order line — loose or already fitted. Never ordered or picked on its own; you can still say where we fit it (Hub or Site). Counts for compliance.",
        () => { close(); onAddTo(node, { reference: true }); }),
      choice("We work on the part — holes, cut-outs, a finish",
        "That is an operation on the work order, not a part. Nothing is added here.",
        () => {
          body.replaceChildren(
            note("Work done to a part — customer holes, cut-outs, fitting a cover — belongs on the work order as an operation (BOM rule 3). The BOM stays what we buy and pick, so nothing is added."),
            el("div", { style: "display:flex;justify-content:flex-end" },
              el("button", { class: "btn btn-sm", type: "button", onclick: close }, "Close")),
          );
        }),
    );
  }

  // Build "Prepared <name>" around a bought part — or, if the part already sits
  // in an assembly we build, offer that one instead of a second wrapper.
  async function openWrap({ node, parentNode, token, onAddTo, onChanged }) {
    const { body, close } = shell(`Prepared assembly for ${node.name}`);
    body.append(note("Checking where this part is used…"));
    let links = [];
    try {
      const r = await window.PortalAPI.post(token, "listParentsOf", { component_id: node.id });
      links = (r.parents || []).filter((l) => l.parent && !l.is_reference);
    } catch (ex) {
      body.replaceChildren(note(`Could not load where ${node.name} is used: ${ex.message}`));
      return;
    }

    const wrappers = links.map((l) => l.parent).filter((p) => p.type === "sub_assembly" && p.make_or_buy === "assembled");
    const others = links.map((l) => l.parent).filter((p) => !parentNode || p.id !== parentNode.id);
    body.replaceChildren();

    if (wrappers.length && onAddTo) {
      body.append(
        el("div", { style: "font-weight:700;font-size:0.875rem" }, "It already sits in an assembly we build"),
        ...wrappers.map((w) => choice(`Add the child to ${w.name}`,
          `${w.part_number} — no new assembly is created.`,
          () => { close(); onAddTo(w, { reference: false }); })),
        el("div", { style: "border-top:1px solid var(--border,#2d3748);margin:0.25rem 0" }),
      );
    } else if (wrappers.length) {
      // Opened from the part's panel: no picker to hand over to, but a second
      // wrapper should still be a deliberate choice, not an accident.
      body.append(note(`It already sits in an assembly we build: ${wrappers.map((w) => w.name).join(", ")}. Add what you fit there — open it under Assemblies — unless you really want a second one.`));
    }

    const nameInput = el("input", { class: "up-text", type: "text", value: `Prepared ${node.name}`, maxlength: "200", style: "width:100%;box-sizing:border-box" });
    const everywhere = el("input", { type: "checkbox" });
    const err = errorLine();
    const createBtn = el("button", { class: "btn btn-sm btn-primary", type: "button" }, "Create assembly");

    body.append(
      el("div", { style: "font-weight:700;font-size:0.875rem" }, wrappers.length ? "Or create a new assembly" : "Create a new assembly"),
      note(parentNode
        ? `It takes the place of ${node.name} in ${parentNode.name} — same quantity, same Hub/Site. ${node.name} stays exactly as it is, inside it ×1. It appears under Assemblies.`
        : `It is created on its own under Assemblies, holding ${node.name} ×1. ${node.name} stays exactly as it is.`),
      el("label", { style: "display:flex;flex-direction:column;gap:0.25rem;font-size:0.8125rem" }, ["Name", nameInput]),
      others.length
        ? el("label", { style: "display:flex;gap:0.5rem;align-items:flex-start;font-size:0.8125rem;line-height:1.4" }, [
            everywhere,
            el("span", {}, [
              parentNode ? "Also replace it in " : "Replace it in ",
              el("strong", {}, others.map((p) => p.name).join(", ")),
            ]),
          ])
        : null,
      err,
      el("div", { style: "display:flex;gap:0.5rem;justify-content:flex-end" }, [
        el("button", { class: "btn btn-sm", type: "button", onclick: close }, "Cancel"),
        createBtn,
      ]),
    );

    createBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) { err.textContent = "Give the assembly a name."; nameInput.focus(); return; }
      createBtn.disabled = true; createBtn.textContent = "Creating…"; err.textContent = "";
      try {
        const r = await window.PortalAPI.post(token, "wrapInPrepared", {
          part_id: node.id,
          parent_id: parentNode ? parentNode.id : null,
          replace_everywhere: everywhere.checked,
          name,
        });
        close();
        if (onChanged) onChanged();
        const wrapper = { id: r.wrapper_id, name: r.name, part_number: r.part_number, type: "sub_assembly", make_or_buy: "assembled" };
        if (onAddTo) onAddTo(wrapper, { reference: false });
      } catch (ex) {
        err.textContent = ex.message;
        createBtn.disabled = false; createBtn.textContent = "Create assembly";
      }
    });
    nameInput.focus();
    nameInput.select();
  }

  window.PortalBomRules = { childRule, isBoughtComplete, openChildIntent, openWrap };
})();
