# Rushroom Compliance Portal — External API

For integrations and manual calls (Postman, scripts). The portal's own frontend
uses the same endpoints through `assets/api.js`.

## Shape of every call

One `POST` per action. The action name goes in the body — there are no REST
paths per resource.

```
POST https://iwoqujpwhsoywudjtsnj.supabase.co/functions/v1/portal-api
Content-Type: application/json
```

Actions are served by one of three functions. Same host, same contract; only the
last path segment differs:

| Function | Serves |
|---|---|
| `portal-api` | auth, CRUD, tenants, accounts, BOM |
| `portal-ai` | Anthropic-backed actions and document parsing |
| `portal-cellar` | EU CELLAR directive sync |

## Authentication

Obtain a session token, then send it on every subsequent call.

```bash
curl -s -X POST "$BASE/portal-api" \
  -H 'Content-Type: application/json' \
  -d '{"action":"login","role":"rushroom","password":"<shared password>"}'
# → {"token":"<session token>","role":"rushroom","admin":true}
```

Two accepted ways to present the token — pick one:

| Method | Use |
|---|---|
| `Authorization: Bearer <token>` | Postman, integrations, anything header-based |
| `"token": "<token>"` in the body | what the portal frontend sends |

If both are present the body wins. Tokens expire after 8 hours.

**The organization is never taken from the request.** It is read from the signed
token, so sending `organization_id` in the body has no effect — you cannot reach
another tenant's data by asking for it.

## Health

No session, no database, no work. Use it to measure availability and latency
without the application in the way.

```bash
curl -s -X POST "$BASE/portal-api" \
  -H 'Content-Type: application/json' -d '{"action":"health"}'
# → {"ok":true,"fn":"portal-api","ts":1789500000000}
```

All three functions answer it, each reporting its own `fn`.

---

## `listAssemblies`

Returns the assemblies available in the Product BOM — every `bom_components`
row of type `sub_assembly` in the caller's organization, as `id` and `name`,
sorted alphabetically by name.

**Function:** `portal-api` · **Role:** `rushroom` (a supplier session gets `403`)

### Request

```bash
curl -s -X POST "$BASE/portal-api" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"action":"listAssemblies"}'
```

Postman: `POST` the URL above, set the **Authorization** header to
`Bearer <token>`, and use a raw JSON body of `{"action":"listAssemblies"}`.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `action` | string | yes | `"listAssemblies"` |
| `include_inactive` | boolean | no | defaults to `true` — see below |

### Response

```json
{
  "assemblies": [
    { "id": "124a8382-b0ef-4722-9d55-bc591c676ef2", "name": "Prepared Left Side Panel - White" },
    { "id": "11f6ac7b-5301-417c-8346-70a31c5332d7", "name": "Prepared Right Side Panel - White" },
    { "id": "418ea3d8-54cb-4e80-b55c-9622f9e50abc", "name": "S Prepared Shelf - White" }
  ],
  "count": 3
}
```

`count` always equals `assemblies.length`.

Only `id` and `name` are returned, deliberately. A narrow response is one that
does not break integrations when columns are added to `bom_components`.

### Status codes

| Code | Meaning |
|---|---|
| `200` | success |
| `401` | missing, malformed or expired token |
| `403` | valid session without the `rushroom` role |
| `400` | malformed JSON, or a database error |

### Inactive assemblies are included — and why

By default the endpoint returns assemblies **regardless of lifecycle status**,
including `inactive` ones.

This matches the Assemblies tab, which is the screen this endpoint mirrors. That
tab groups purely on `type === "sub_assembly"` with no lifecycle filter
(`groupFiltered` in `assets/app.js`), which is why every assembly in the portal
today displays `inactive` and is still listed.

The decision was checked against production rather than assumed: all three
assemblies currently carry `lifecycle_status = 'inactive'`, so excluding them
would return an empty list while the tab shows three — an endpoint quietly
disagreeing with the UI it is named after.

To narrow it explicitly:

```json
{ "action": "listAssemblies", "include_inactive": false }
```

### From the portal frontend

```js
const { assemblies, count } = await PortalAPI.listAssemblies(token);
// or: PortalAPI.listAssemblies(token, { include_inactive: false })
```
