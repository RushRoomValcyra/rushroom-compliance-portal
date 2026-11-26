# Supplier portal — accounts per supplier, exactly their files

Status: CONTRACT, 2026-11-25, built the same day. Asked for by ziirvass:
"speed develop the supplier login, what he sees, and secure that he sees the
exact files that I want him to see. Super professional. Today."

## 1 What exists and what is wrong

A supplier signs in to `supplier.html` with one shared password (`login`,
role `supplier`) or a personal account approved by an admin (`loginUser`,
role `supplier`). The shell shows four tabs: Supplier Documents, Drawings,
Standards & Regulations, Product BOM. The server scopes a supplier to
**released** drawing issues flagged `is_supplier_visible` — a per-drawing
yes/no — and `listSupplierComponents` lists **every active part**. Nothing
ties a supplier company to the parts it makes, nothing records what a
supplier fetched, and the admin preview runs on the admin's own session, so
it does not show what a supplier sees. CAD files never reach a supplier.

## 2 The model

- A **supplier** is a company: `suppliers (id, organization_id, name,
  contact_name, contact_email, notes, status active|inactive, created_at,
  created_by)`.
- A supplier **user** is a `users` row with `role = 'supplier'` and
  `users.supplier_id` set. A supplier user whose account has no supplier is
  refused at login: "Your account is not linked to a supplier yet. Contact
  Rushroom." The shared supplier password is retired: `login` with role
  `supplier` answers 403 "Supplier access is by personal account."
- **Access** is per part: `supplier_components (id, organization_id,
  supplier_id, component_id, drawings boolean default true, cad boolean
  default false, notes, created_at, created_by, UNIQUE (organization_id,
  supplier_id, component_id))`. A supplier sees a part's released drawing
  issues when `drawings` is on and the drawing is `is_supplier_visible`
  (both gates hold); the part's released CAD STEP when `cad` is on.
  Surgery-template drawings never.
- **Audit**: `supplier_file_events (id, organization_id, supplier_id,
  user_id, kind drawing|cad, drawing_revision_id, cad_file_id, file_name,
  at)` — one row every time a signed URL is issued to a supplier session.
  Indexed `(organization_id, supplier_id, at DESC)`.
- All three tables in `TENANT_TABLES`, RLS deny-all. Migration
  `0065_suppliers.sql`, re-runnable, with `users.supplier_id UUID
  REFERENCES suppliers(id) ON DELETE SET NULL` and an index on it.

The session of a supplier user carries `sid` (the supplier id). Every
supplier-facing action reads `session.sid`; a supplier session without one
answers 403 everywhere a part or file is involved.

## 3 API — portal-api

Supplier role (`role === "supplier"`, `session.sid` required):

| action | body | returns |
|---|---|---|
| `supplierHome` | `{}` | `{ supplier: { id, name, contact_name, contact_email }, user: { name, email }, parts: [{ component_id, part_number, name, description, drawings: [{ drawing_id, drawing_number, title, issue, released_at, file_name, drawing_revision_id, supplier_drawing_number }], cad: { cad_model_revision_id, revision, released_at, file_name, fusion_version, sha8, cad_file_id } \| null, updated_at }], documents_count, updated_at }` — one call for the whole portal. Parts are the supplier's assignments, sorted by part number. `drawings` holds released issues of supplier-visible engineering drawings linked to the part (owner or `drawing_components`), newest release first per drawing, one row per drawing (its released issue). `cad` only when the assignment has `cad` and the part's CAD model has a released revision with a STEP file. `updated_at` = the newest `released_at` among them. |
| `supplierFileUrl` | `{ kind: "drawing" \| "cad", id }` (`drawing_revision_id` or `cad_file_id`) | `{ url, file_name, expires_in: 600 }` after checking: the revision/file belongs to a part assigned to `session.sid` with the matching access flag, the drawing issue is released and supplier-visible / the CAD revision is released. Writes one `supplier_file_events` row. 404 otherwise (never 403: no enumeration). |

Existing supplier-reachable actions are scoped to the assignment: `listDrawings`, `getDrawing`, `drawingFileUrl` (delegates to the same check as `supplierFileUrl` and logs), `listSupplierComponents` (only assigned parts), `getBom` for suppliers (only assigned parts; a supplier never sees the structure above its parts). Steps and documents with audience `supplier` stay as they are: company-level compliance material.

Rushroom role (admin or internal):

| action | body | returns |
|---|---|---|
| `listSuppliers` | `{}` | `{ suppliers: [{ id, name, contact_name, contact_email, status, users: [{ id, name, email, status, email_verified }], parts_count, last_activity_at, created_at }] }` |
| `saveSupplier` | `{ id?, name, contact_name?, contact_email?, notes?, status? }` | `{ supplier }` — create or update; name required, unique per org (409) |
| `setSupplierParts` | `{ supplier_id, parts: [{ component_id, drawings, cad }] }` | `{ ok, count }` — replaces the assignment set (insert new, update flags, delete missing), writes `bom_component_history` "updated" on every added/removed part: "Supplier <name> given access (drawings[, CAD])" / "Supplier <name> access removed" |
| `getSupplier` | `{ supplier_id }` | `{ supplier, users, parts: [{ component_id, part_number, name, drawings, cad, released_drawings: n, released_cad: "B" \| null }], events: last 100 of supplier_file_events with user name and file name }` |
| `addSupplierUser` | `{ supplier_id, email, name }` | `{ user, emailed, set_password_url }` — creates the `users` row (role supplier, status approved, email_verified true, supplier_id) or links an existing user with role supplier and no supplier; sends the set-password email through `resetLinkFor` + `sendPasswordEmail`; returns the link too so the admin can hand it over when mail is not configured. An existing user with another role → 409. |
| `removeSupplierUser` | `{ user_id }` | `{ ok }` — sets `supplier_id` null and `status` disabled |
| `adminViewAsSupplier` | `{ supplier_id }` | `{ token, supplier }` — a session `{ role: "supplier", sid, imp: true, actor: <admin email>, uid: <admin uid> }` with a 30-minute TTL. File events written under this session carry the admin's `user_id`. |

`loginUser` for a user with role supplier: `sid = users.supplier_id`; without it 403 with the text above. `orgContext` (or the `loginUser` answer) returns `supplier: { id, name }` for supplier sessions so the page can show the company.

## 4 The supplier page — `supplier.html`, `assets/supplier.js`

Sign in: email + password (+ MFA code when the API asks), "Forgot password?" → `requestPasswordReset`. No shared password form. Header: badge "Rushroom AB · Supplier portal", h1 = the supplier's name, tagline = the signed-in user's name and email. Theme toggle stays; "Full portal →" goes (a supplier has none).

Tabs: **Parts & files** (default) · **Supplier Documents** · **Standards & Regulations**. The Drawings and Product BOM tabs go (the first is now inside Parts & files; the second listed every part).

Parts & files, from one `supplierHome` call: a toolbar line "N parts · last release <date>" and Refresh. One table, no explanatory text:

| Part no. | Part | Drawing | CAD | Released |
|---|---|---|---|---|
| mono | name, description muted below | per drawing: number · **Issue B** chip Released · title muted · **Open** · **Download** (file name as title) | **Rev C** chip Released · file name · **Download**, or "—" | date of the newest release on the row |

Open renders the PDF inline with `window.PortalViewer` (the same viewer the engineer uses), in a surface with the drawing number, issue and a Download. Download fetches `supplierFileUrl` and navigates to the signed URL (so every fetch is logged). An empty assignment shows "No parts assigned yet." A supplier session without a supplier shows the sign-in error, never an empty portal.

Supplier Documents and Standards & Regulations keep today's content (steps with audience supplier, the document library filtered to supplier, the standards flagged supplier). The declaration-upload card stays if `supplierUploadUrl` is configured. Footer: "Rushroom AB · Supplier portal". The "governed by Google Drive sharing" sentence goes.

Admin preview: the Accounts tab's "View as supplier" stores the impersonation token in `sessionStorage` under `pim_supplier_preview` and opens `supplier.html`; `supplier.js` uses that token when present (and shows a thin amber bar "Viewing as <supplier> · <admin>") and otherwise the supplier's own session from `sessionStorage` (api.js keeps every session there: closing the tab signs the supplier out, the token itself lasts 8 hours). The old "Open the supplier portal (admin)" link on index.html goes.

## 5 Admin — Accounts tab, a "Suppliers" section (app.js)

Above the users list, Rushroom admins only (`isPlatformOwner` or org admin, the same gate the users list uses):

- A table: Name · Contact · Users · Parts · Last activity · actions **Parts** · **Users** · **View as supplier** · Edit. "+ New supplier" opens a one-row modal: Name · Contact name · Contact email · Save.
- **Parts** opens a modal: search box over the active parts (part number + name), a list with one row per part: checkbox (assigned) · part number · name · released drawing issue(s) · released CAD letter · a **CAD** checkbox (enabled when assigned). Save calls `setSupplierParts` with the full set.
- **Users** opens a modal listing the supplier's users (name, email, status, verified) with **Remove**, and a one-row form Email · Name · **Add** → `addSupplierUser`; the answer's set-password link is shown with a copy button when it was not emailed.
- **View as supplier** → `adminViewAsSupplier`, opens the supplier page in a new tab as above.
- Below the table, when a supplier row is selected: the last 100 file events (when · user · part · file) from `getSupplier`.

Labels outside boxes, no explanatory text, single-row forms, the neighbouring styles of the Accounts tab.

## 6 Security rules (tests guard them)

1. A supplier session reaches a drawing revision or CAD file only through `supplierFileUrl` / `drawingFileUrl`, and both answer 404 unless the assignment, the access flag, the released status and (drawings) `is_supplier_visible` all hold.
2. `listDrawings`, `getDrawing`, `listSupplierComponents`, `getBom` for a supplier session never return a part outside the assignment, nor a drawing of type `surgery_template`, nor an unreleased issue.
3. `supplierHome` and every action above answer 403 to a supplier session without `sid`.
4. The shared supplier password no longer issues a session.
5. Every signed URL issued to a supplier session writes a `supplier_file_events` row; the admin sees them per supplier.
6. The impersonation token is role `supplier` with `imp: true`, expires in 30 minutes, and cannot call Rushroom-only actions.
7. Tenant: the three new tables are in `TENANT_TABLES`; `users.supplier_id` is checked against a supplier of the same organization when set.

Cache: app.js → v460; supplier.js → v460 (app.js v464 after the 2026-11-26 fixes below).

## 7 As built — 2026-11-25

- **Deny-by-default.** portal-api refuses any action outside `SUPPLIER_ACTIONS`
  for a supplier session (24 names: the page's reads, the compliance tabs'
  reads, and the writes `setStatus`, `uploadUrl`, `recordUpload`,
  `docUploadUrl`, `addDocument` plus the account's own MFA); the impersonation
  token gets the reads only. portal-ai serves no action to a supplier
  (`suggestFileMetadata` read any storage path it was handed, so it stays
  Rushroom-only until it scopes the path). portal-cellar was already closed.
- **Liveness.** Every supplier request re-reads the supplier's status and, for
  a personal session, the user's status and `supplier_id`, in the gate: a
  removed user or an inactive company is refused on the next request, not
  after the 8-hour token.
- **Files.** `supplierFileUrl { kind, id, inline? }`: a Download is signed as
  an attachment (`Content-Disposition`), Open and the 3D Preview as inline;
  every call writes the audit row before signing. The supplier page gets the
  engineer's 3D STEP viewer (`window.Portal.openCadViewer`), whose colour
  pass no longer throws on online-3d-viewer 0.18.
- **getDrawing** hands a supplier the drawing's identity only (number, title,
  type, current issue id, supplier drawing no., and the owner only when
  assigned); `listDrawings` blanks an unassigned owner.
- **Landing.** `resetLinkFor(uid, "supplier")` appends `&to=supplier`, which
  reset.html turns into links to supplier.html; a supplier-role sign-in on
  index.html is redirected to supplier.html.
- **Admin preview.** The token is written into the preview tab only; the
  preview page removes it from sessionStorage on adoption; "Close preview"
  closes the tab.
- **Not in scope, recorded:** the compliance tabs (`data`, `standards`) still
  hand a supplier 60-minute signed URLs for supplier-audience documents
  without a `supplier_file_events` row — company-level documents, outside the
  per-part model; the events table's kind is `drawing | cad`.

## 8 Walked through as Postęp — 2026-11-26

The page was opened through "View as supplier" and every screen read; four
readers went through supplier.js, portal-api, this document and production.
What Szymon sees: three tabs — Parts & files (51 rows, each Rev B released
STEP with Preview and Download; one drawing, Side Panel Left Issue B; 50 rows
"—" under Drawing), Supplier Documents (four supplier-audience documents and
the Upload a document card), Standards & Regulations (empty: no standard is
tagged supplier). He had not signed in: `users.password` was NULL, the
set-password link lives one hour and the one from 2026-11-25 had expired; the
four `supplier_file_events` rows were the admin's previews. Mail is
configured (Resend), so "Forgot password?" delivers.

Fixed the same day (migration 0066, portal-api, app.js v464, reset.html):

- **Upload card.** A supplier's upload no longer calls `suggestFileMetadata`
  (portal-ai refuses supplier sessions, so every upload ended on a red
  "Couldn't read the file automatically: Not available to supplier accounts");
  the bar completes on upload and the copy no longer promises an AI read.
- **Standards tab** printed a literal "null" above "No standards shared with
  you yet." (`Element.append(null)` in the register tab). Gone.
- **Who sent it.** `uploads.supplier_id` and `uploads.user_id` (0066) are
  written from the signed session on `recordUpload`; the free-text "Your
  company" label is kept as what was typed. Documents → Supplier uploads names
  the company and the account. `setStatus` by a supplier writes
  `updated_by = "supplier (<company> · <email>)"`.
- **Document card** for an external reader: no "For: internal, supplier"
  audience line; a legacy single-file document reads "Single file — no version
  history yet." instead of "No file uploaded yet."; a document with no file no
  longer shows the internal "link pending" placeholder.
- **reset.html** with `to=supplier` is badged and footed "Rushroom AB ·
  Supplier portal", its back link reads "Back to sign in", and it loads the
  same api.js as supplier.html.

Still as designed, recorded: no acknowledgement of a release exists (the file
event is a one-way fetch log); the five supplier-audience steps render into
the hidden `#steps-panel` and `setStatus` stays reachable only by API; the
upload card's related-action dropdown shows the steps' internal wording; MFA
actions are allowed but have no supplier UI; `uploads`, `docUploadUrl`,
`addDocument` and `listRequirementLinksForDocumentVersions` are in
`SUPPLIER_ACTIONS` but answer "Rushroom only" inside the handler; the two
compliance tabs' signed URLs are not logged.

## 9 Download all STEP — 2026-11-26

Asked for by Postęp the day after going live: one download for all 51 STEP
files. "Download all STEP (n)" on Parts & files (supplier.js v461, shown when
at least one assigned part has a released STEP) calls
`supplierBatchFileUrls { kind: cad | drawing }`, which walks the assignment in
part-number order and issues every released file through `issueSupplierFile`
— one call, one `supplier_file_events` row per file, inline-signed for ten
minutes, a drawing linked to several assigned parts issued once — and signs
nothing itself. The browser fetches four files at a time,
counts them on the button, zips them with JSZip (CDN with a subresource-integrity hash, loaded
before the server is asked so a blocked CDN never leaves phantom audit rows,
deflate) together with `manifest.csv` (UTF-8 BOM; part number, name,
revision, entry name; a leading = + - @ neutralised), and saves
`<supplier>-STEP-<date>.zip`. Entry names are the file names, prefixed with
the part number when they do not start with it, and made unique. A file the gate refuses is
counted in `skipped` and left out; a fetch that fails is left out and the
button reads "50 of 51 zipped" for a few seconds. No edge function holds the
files; no storage path reaches the page. The admin preview may use it (a read),
and its events carry the admin's user id as every preview fetch does.

