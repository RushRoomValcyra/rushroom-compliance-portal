/* Rushroom AB — Engineering & Compliance Platform: the supplier pick list (0066)
 *
 *   PortalSupplierPicker.create({ token, supplierId, supplierName, label })
 *     → { el, value() }   value(): { supplier_id, supplier_name }
 *
 * A part's supplier and a price's supplier are picked from the one supplier
 * register, never typed, so one supplier cannot become two by spelling. A name
 * typed before the register stays shown as "not in the register" until an
 * admin links it on Accounts → Suppliers. "+ New supplier…" adds one on the
 * spot with its name and currency.
 */
(() => {
  const CUR = ["SEK", "EUR", "USD", "PLN"];
  const NEW = "__new__", TYPED = "__typed__";
  const post = (token, action, body) => window.PortalAPI.post(token, action, body);
  let cache = null;
  const load = (token) => (cache ||= post(token, "listSupplierOptions", {}).then((r) => r.suppliers || []).catch((e) => { cache = null; throw e; }));

  function el(tag, attrs = {}, kids = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(kids)) { if (c != null) n.appendChild(typeof c === "object" ? c : document.createTextNode(String(c))); }
    return n;
  }

  function create({ token, supplierId = null, supplierName = "", label = "Supplier" } = {}) {
    let selectedId = supplierId || null;
    const typed = !supplierId && supplierName ? String(supplierName).trim() : "";
    const select = el("select", { class: "up-text", "aria-label": label, style: "width:100%;box-sizing:border-box" }, el("option", { value: "" }, "Loading suppliers…"));
    const newName = el("input", { class: "up-text", type: "text", maxlength: "160", placeholder: "Supplier name", "aria-label": "New supplier name", style: "flex:1;min-width:10rem" });
    const newCur = el("select", { class: "up-text", "aria-label": "New supplier currency" }, CUR.map((c) => el("option", { value: c }, c)));
    const err = el("div", { role: "alert", style: "font-size:0.75rem;color:#e05454" });
    const addBtn = el("button", { class: "btn btn-sm btn-primary", type: "button" }, "Add");
    const cancelBtn = el("button", { class: "btn btn-sm", type: "button" }, "Cancel");
    const addRow = el("div", { style: "display:none;gap:0.35rem;align-items:center;flex-wrap:wrap;margin-top:0.35rem" }, [newName, newCur, addBtn, cancelBtn]);
    const root = el("div", { style: "display:flex;flex-direction:column" }, [select, addRow, err]);

    const paint = (list) => {
      const opts = [el("option", { value: "" }, "— none —")];
      if (typed) opts.push(el("option", { value: TYPED }, `${typed} (not in the register)`));
      for (const s of list) {
        if (s.status === "inactive" && s.id !== selectedId) continue;
        opts.push(el("option", { value: s.id }, s.name + (s.currency ? ` · ${s.currency}` : "") + (s.status === "inactive" ? " (inactive)" : "")));
      }
      opts.push(el("option", { value: NEW }, "+ New supplier…"));
      select.replaceChildren(...opts);
      select.value = selectedId || (typed ? TYPED : "");
    };
    load(token).then(paint).catch((ex) => { select.replaceChildren(el("option", { value: typed ? TYPED : "" }, typed || "—")); err.textContent = ex.message; });

    select.addEventListener("change", () => {
      err.textContent = "";
      if (select.value === NEW) {
        addRow.style.display = "flex";
        newName.focus();
        return;
      }
      addRow.style.display = "none";
      selectedId = select.value && select.value !== TYPED ? select.value : null;
    });
    const closeAdd = () => { addRow.style.display = "none"; select.value = selectedId || (typed ? TYPED : ""); };
    cancelBtn.addEventListener("click", closeAdd);
    const add = async () => {
      err.textContent = "";
      if (!newName.value.trim()) { err.textContent = "Name the supplier."; newName.focus(); return; }
      addBtn.disabled = true;
      try {
        const r = await post(token, "addSupplier", { name: newName.value.trim(), currency: newCur.value });
        cache = null;
        selectedId = r.supplier.id;
        paint(await load(token));
        newName.value = "";
        addRow.style.display = "none";
      } catch (ex) { err.textContent = ex.message; }
      addBtn.disabled = false;
    };
    addBtn.addEventListener("click", add);
    newName.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });

    return {
      el: root,
      value() {
        if (select.value === TYPED) return { supplier_id: null, supplier_name: typed };
        if (selectedId) return { supplier_id: selectedId, supplier_name: null };
        return { supplier_id: null, supplier_name: null };
      },
    };
  }

  window.PortalSupplierPicker = { create, forget: () => { cache = null; } };
})();
