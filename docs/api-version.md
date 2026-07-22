# Claudally — REST API Version

**Drive Tally Prime from any application over plain HTTPS.**

This is the **API edition** of Claudally. The engine is identical to the
[MCP server](README.md) — the same Tally XML bridge, the same company/report/voucher
logic, the same local GUI-agent deployment. **Only the north-bound surface changes:**
instead of an MCP client (Claude, ChatGPT, Copilot) speaking the Model Context Protocol,
**your own backend calls a REST/JSON API.**

> **A [Jina Code Systems LLP](https://github.com/JINA-CODE-SYSTEMS) project.**
> Copyright © 2026 Jina Code Systems LLP. Licensed under [AGPL-3.0-or-later](../LICENSE).

---

## MCP version vs. API version

Everything below the "engine" line is shared. Pick the access mode that fits the caller.

| | **MCP version** | **API version** |
| --- | --- | --- |
| **Caller** | An AI assistant / MCP client (Claude, ChatGPT, Copilot, any MCP host) | Any application or backend — Node, Python, Go, PHP, n8n, a spreadsheet macro |
| **Wire protocol** | MCP (JSON-RPC 2.0 over Streamable HTTP) at `POST /mcp` | REST/JSON at `POST\|GET /api/v1/…` |
| **Discovery** | `tools/list` handshake | This document + `GET /api/v1/tools` |
| **Auth** | OAuth 2.1 + PKCE (interactive browser sign-in) | **Bearer API key** (server-to-server) |
| **Session** | `mcp-session-id` header, SSE for notifications | Stateless request/response |
| **Best for** | Chat-driven, human-in-the-loop workflows | Programmatic integration, ETL, scheduled jobs, your own UI |
| **Engine** | Tally XML bridge · DuckDB analytics · company session · GUI agent — **identical** | |

Both modes can run **side by side in the same process** — MCP on `/mcp`, REST on `/api/v1` —
so one deployment serves an AI assistant and your billing system at once.

> **Scope of this document.** The Tally engine, tools, and deployment described here already
> ship in this repository (they power the MCP server). This document specifies the **REST access
> layer** over that engine: its routes, auth, and payloads. Treat it as the contract for the API
> edition. Endpoints marked _optional_ are gated behind an env flag exactly as their MCP-tool
> counterparts are.

---

## Architecture

The deployment is exactly the MCP topology with a different client on the left.

```
┌──────────────┐   HTTPS    ┌───────────────────────────┐    XML     ┌─────────────┐
│  Your app /  │ ─────────▶ │      Claudally engine      │ ─────────▶ │ Tally Prime │
│   backend    │  REST/JSON │  Express · REST API layer  │  :9000     │  Silver /   │
│  (any lang)  │ ◀───────── │  DuckDB · API-key auth     │ ◀───────── │   Gold      │
└──────────────┘            └───────────────────────────┘            └─────────────┘
                                          │
                                          │ JSON-file IPC (Windows Session 0 bridge)
                                          ▼
                                 ┌───────────────────┐
                                 │  GUI agent (local │  launches tally.exe, keystrokes
                                 │  desktop session) │  through credential prompts
                                 └───────────────────┘
```

- **Windows box (with Tally):** the engine runs as a service; the **GUI agent**
  (`scripts/tally-gui-agent-v2.ps1`) runs in the interactive session to launch/unlock Tally.
  Both are installed by the standard [Windows installer](installer.md) — **no API-specific setup**.
- **Linux server (Tally over SSH tunnel):** deploy exactly as the
  [Linux server guide](server-setup-linux.md); Tally's port 9000 is forwarded in over SSH.
- The **local agent is the same binary/scripts** as the MCP version. Nothing about how Tally is
  reached, how companies are loaded, or how vouchers are posted changes.

---

## Deployment

Deploy the engine exactly as for the MCP version — then turn the API layer on with one env var.

1. Install the engine:
   - **Windows:** [Windows installer](installer.md) or [remote server (Windows)](server-setup-windows.md)
   - **Linux:** [remote server (Linux)](server-setup-linux.md) (Tally via SSH tunnel)
2. Enable the API layer in `.env` (see [Configuration](#configuration)):
   ```dotenv
   API_KEYS=live_9c2b…,ci_57a1…      # one or more Bearer keys (comma-separated)
   PUBLIC_URL=https://tally.myfirm.com
   READONLY_MODE=false               # true = reads only, all writes 403
   ```
3. Front it with the same reverse proxy (nginx / Caddy / Cloudflare Tunnel) that terminates TLS
   for the MCP server. The API lives under `/api/v1` on the same port, so **no new proxy rule** is
   needed beyond what already forwards `/`.
4. Smoke-test:
   ```bash
   curl -s https://tally.myfirm.com/api/v1/status \
     -H "Authorization: Bearer live_9c2b…"
   ```

---

## Authentication

The API uses a **static Bearer API key** — the natural fit for server-to-server calls (no browser,
no redirect, no PKCE dance). Configure one or more keys in `API_KEYS` and send one on every request:

```
Authorization: Bearer live_9c2b7f…
```

- Keys are compared in **constant time** (same primitive the OAuth path uses).
- Rotate by adding the new key to `API_KEYS`, deploying, moving clients over, then dropping the old
  key. Multiple keys let you give each integration its own revocable credential.
- Missing/invalid key → **`401 Unauthorized`**.
- If `API_KEYS` is unset, the API layer is **disabled** (the MCP `/mcp` surface is unaffected).

> **Reusing OAuth instead.** The server already implements OAuth 2.1 for MCP. If you'd rather issue
> OAuth tokens to API callers, the OAuth **client-credentials** grant can front `/api/v1` for parity
> with the MCP auth server — send the resulting bearer token in the same header. API keys remain the
> recommended default for backend jobs.

---

## Conventions

- **Base URL:** `https://<your-domain>/api/v1`
- **Content type:** `application/json` on both request and response (`GET` routes take query
  strings; everything with a payload is `POST` with a JSON body).
- **Company selection:** pass `targetCompany` (exact name) in the body to target a specific loaded
  company; omit it to use the **active** company. Load/switch companies with the
  [company endpoints](#company-management).
- **Dates:** always `YYYY-MM-DD`. Call [`GET /api/v1/period`](#system--context) first so you post
  and report inside the company's valid range instead of guessing.
- **Idempotency:** write endpoints accept `idempotencyKey` (and vouchers a bank `reference` +
  `skipIfExists`) so retries and concurrent posts don't duplicate.

### Success envelope

```json
{
  "ok": true,
  "tool": "trial-balance",
  "data": { "tableID": "tb_7f3a91", "count": 42 },
  "meta": { "company": "Acme Ltd", "durationMs": 128 }
}
```

`data` mirrors the underlying tool's JSON output verbatim. Report endpoints cache their rows in an
in-memory **DuckDB** table and return a `tableID`; run analytical SQL against it with
[`POST /api/v1/query`](#analytics). Tables auto-expire after 15 minutes.

### Error envelope

Failures return the engine's classified error envelope with `ok: false` and an HTTP status mapped
from the code:

```json
{
  "ok": false,
  "error": {
    "code": "UNBALANCED",
    "message": "Voucher does not balance: debits 1000 != credits 900.",
    "retryable": false,
    "remedy": "Fix the entries so debits equal credits, then retry."
  }
}
```

| Error `code` | HTTP | Meaning |
| --- | --- | --- |
| _(bad/missing API key)_ | `401` | Authentication failed |
| `READONLY` | `403` | Write attempted while `READONLY_MODE=true` |
| `PASSWORD_REQUIRED` | `422` | Company is password-protected — resend with `userName` + `password` |
| `OUT_OF_PERIOD` | `422` | Voucher date outside the company's open period |
| `UNBALANCED` | `422` | Voucher debits ≠ credits |
| `MASTER_NOT_FOUND` | `422` | Referenced ledger / stock item does not exist |
| `AMBIGUOUS` / `AMBIGUOUS_INPUT` | `422` | Input matched more than one master/company |
| `PRECONDITION_FAILED` | `422` | A required config/input precondition failed (see `remedy`) |
| `COMPANY_NOT_FOUND` | `404` | No such loaded company |
| `DUPLICATE` | `409` | A matching voucher already exists |
| `UNSAVED_ENTRY_OPEN` | `409` | Tally has an unsaved entry blocking the write |
| `TALLY_DOWN` | `503` | Tally XML server unreachable |
| `AGENT_UNREACHABLE` / `AGENT_TOO_OLD` | `503` | GUI agent not responding / too old to act |
| `UNKNOWN` | `500` | Unclassified failure (see `logs`) |

`retryable` tells a client whether a blind retry could ever succeed; `remedy` is a
human-actionable next step when one exists.

---

## Endpoint reference

Every endpoint maps 1:1 to an engine tool, so behaviour, arguments, and guarantees match the MCP
docs exactly. `GET` = no body; `POST` = JSON body.

### System & context

| Method & path | Maps to | Description |
| --- | --- | --- |
| `GET /api/v1/status` | `status` / `open-company-debug` | Live health: agent liveness + version, Tally reachability, edition, build |
| `GET /api/v1/context` | `get-context` | One-shot snapshot: `{ edition, readonly, activeCompany, agentAlive, tallyReachable, requirements }` |
| `GET /api/v1/period` | `get-period` | Active company's period: `{ company, fyFrom, fyTo, booksFrom, currentDate, lastEntryDate }` — call before posting/reporting |
| `GET /api/v1/tools` | _(discovery)_ | Machine-readable list of enabled endpoints + input schemas |

### Company management

> **Recommended flow:** `POST /companies/resolve` to turn a folder id / name / alias into one
> canonical record, then `POST /companies/load-by-alias`. No exact-name guessing.

| Method & path | Maps to | Description |
| --- | --- | --- |
| `GET  /api/v1/companies` | `list-companies` | Company folders in the data directory (no open company needed) |
| `GET  /api/v1/companies/available` | `list-available-companies` | Recursive scan + display names + credential-requirement hints |
| `GET  /api/v1/companies/configured` | `list-configured-companies` | Companies declared in the credential-hint config |
| `GET  /api/v1/companies/loaded` | `list-loaded-companies` | Companies currently resident in Tally |
| `POST /api/v1/companies/resolve` | `resolve-company` | Resolve one id/name/alias → canonical `{ name, folderId, alias, isLoaded, isProtected }` |
| `POST /api/v1/companies/load` | `load-company` | Load by editing `tally.ini` + restarting Tally. Edition-aware. Accepts `userName`/`password` |
| `POST /api/v1/companies/load-by-alias` | `load-company-by-alias` | Load by configured alias (recommended load path) |
| `POST /api/v1/companies/active` | `set-active-company` / `use-company` / `switch-company` | Point the active-company pointer at an already-loaded company (Gold) |
| `POST /api/v1/companies/open` | `open-company` / `open-tally` | Legacy multi-strategy loader (_experimental_) |
| `POST /api/v1/companies/unlock` | `unlock-stored-credentials` | Unlock a company using server-stored credentials |

### Financial reports

| Method & path | Maps to | Key body params |
| --- | --- | --- |
| `POST /api/v1/reports/chart-of-accounts` | `chart-of-accounts` | `targetCompany?` |
| `POST /api/v1/reports/trial-balance` | `trial-balance` | `fromDate`, `toDate`, `targetCompany?` |
| `POST /api/v1/reports/profit-loss` | `profit-loss` | `fromDate`, `toDate`, `targetCompany?` |
| `POST /api/v1/reports/balance-sheet` | `balance-sheet` | `toDate`, `targetCompany?` |
| `POST /api/v1/reports/ledger-balance` | `ledger-balance` | `ledgerName`, `toDate`, `targetCompany?` |
| `POST /api/v1/reports/ledger-account` | `ledger-account` | `ledgerName`, `fromDate`, `toDate`, `targetCompany?` |
| `POST /api/v1/reports/bills-outstanding` | `bills-outstanding` | `partyType?`, `toDate`, `targetCompany?` |

### Inventory

| Method & path | Maps to | Key body params |
| --- | --- | --- |
| `POST /api/v1/inventory/stock-summary` | `stock-summary` | `fromDate`, `toDate`, `targetCompany?` |
| `POST /api/v1/inventory/stock-item-balance` | `stock-item-balance` | `stockItem`, `toDate`, `targetCompany?` |
| `POST /api/v1/inventory/stock-item-account` | `stock-item-account` | `stockItem`, `fromDate`, `toDate`, `targetCompany?` |

### GST

| Method & path | Maps to | Key body params |
| --- | --- | --- |
| `POST /api/v1/gst/voucher-details` | `gst-voucher-details` | `fromDate`, `toDate`, `targetCompany?` |
| `POST /api/v1/gst/stock-items` | `stock-item-gst` | `targetCompany?` |
| `POST /api/v1/gst/hsn-summary` | `gst-hsn-summary` | `fromDate`, `toDate`, `targetCompany?` |
| `POST /api/v1/gst/gstr1` | `gstr1-summary` | `fromDate`, `toDate`, `targetCompany?` |
| `POST /api/v1/gst/gstr2` | `gstr2-summary` | `fromDate`, `toDate`, `targetCompany?` |

> **Known limitation (same as MCP):** GST statutory returns only auto-populate when the tax ledgers
> carry Tally's GST configuration. Create/alter GST ledgers in Tally (or via `set-ledger-gst`) before
> posting so `gstr1` / GSTR-3B classify correctly.

### Master data

| Method & path | Maps to | Key body params |
| --- | --- | --- |
| `POST /api/v1/masters/list` | `list-master` | `collection` (ledger, group, stockitem, vouchertype…), `targetCompany?` |
| `POST /api/v1/masters/search` | `search-master` | `collection`, `query`, `targetCompany?` |

### Vouchers — lookup & write

> Write endpoints return `403 READONLY` when `READONLY_MODE=true`.

| Method & path | Maps to | Notes |
| --- | --- | --- |
| `POST   /api/v1/vouchers/locate` | `locate-voucher` | Resolve a voucher's internal `master_id` |
| `POST   /api/v1/vouchers/find-by-reference` | `find-voucher-by-reference` | Find a live voucher by its bank `reference` (idempotency key) |
| `POST   /api/v1/vouchers` | `create-voucher` | Post one voucher. `entries[]` must balance. Supports `dryRun`, `idempotencyKey`, `skipIfExists` |
| `POST   /api/v1/vouchers/batch` | `create-vouchers` | Post many vouchers in one call |
| `POST   /api/v1/vouchers/gst` | `create-gst-voucher` | GST-compliant voucher with auto tax-ledger allocation |
| `POST   /api/v1/vouchers/reverse` | `reverse-voucher` | Cancel a voucher by `master_id` |
| `DELETE /api/v1/vouchers/{masterId}` | `delete-voucher` | Permanent hard delete (double-gated by `master_id`) |
| `POST   /api/v1/vouchers/delete-batch` | `delete-vouchers` | Batch hard delete (two-phase, `master_id`-bound) |

### Masters — write

| Method & path | Maps to | Notes |
| --- | --- | --- |
| `POST /api/v1/ledgers` | `create-ledger` | Create a GL ledger master |
| `POST /api/v1/ledgers/gst` | `set-ledger-gst` | Set/alter a ledger's GST configuration |
| `POST /api/v1/stock-items` | `create-stock-item` | Create a stock item master |

### Analytics

| Method & path | Maps to | Key body params |
| --- | --- | --- |
| `POST /api/v1/query` | `query-database` | `sql` — **`SELECT`-only** DuckDB query over cached report tables (`tableID`) |

### Optional / guarded

Off by default; enable per its env flag exactly as the MCP tool requires.

| Method & path | Maps to | Enable with |
| --- | --- | --- |
| `POST /api/v1/gui/screenshot` | `gui-screenshot` | `ENABLE_GUI_CONTROL=true` |
| `POST /api/v1/gui/send-keys` | `gui-send-keys` | `ENABLE_GUI_CONTROL=true` |
| `POST /api/v1/debug/raw-xml` | `tally-raw-xml-probe` | `TALLY_DEBUG_XML=1` |

---

## Examples

### 1. Check the period, then pull a trial balance

```bash
BASE=https://tally.myfirm.com/api/v1
KEY="Authorization: Bearer live_9c2b7f…"

# What dates are valid?
curl -s "$BASE/period" -H "$KEY"
# → { "ok": true, "data": { "company": "Acme Ltd", "fyFrom": "2025-04-01", "fyTo": "2026-03-31", ... } }

# Trial balance for the year
curl -s "$BASE/reports/trial-balance" -H "$KEY" -H 'Content-Type: application/json' \
  -d '{ "fromDate": "2025-04-01", "toDate": "2026-03-31" }'
# → { "ok": true, "data": { "tableID": "tb_7f3a91", "count": 42 }, "meta": { "company": "Acme Ltd" } }
```

### 2. Run SQL on the cached report

```bash
curl -s "$BASE/query" -H "$KEY" -H 'Content-Type: application/json' \
  -d '{ "sql": "SELECT ledger_name, closing_balance FROM tb_7f3a91 ORDER BY closing_balance DESC LIMIT 10" }'
```

### 3. Load a company by alias

```bash
curl -s "$BASE/companies/load-by-alias" -H "$KEY" -H 'Content-Type: application/json' \
  -d '{ "alias": "acme" }'
```

### 4. Post a balanced journal voucher

```bash
curl -s "$BASE/vouchers" -H "$KEY" -H 'Content-Type: application/json' -d '{
  "voucherType": "Payment",
  "date": "2026-01-15",
  "entries": [
    { "ledger": "Rent",              "drCr": "dr", "amount": 25000 },
    { "ledger": "HDFC Bank",         "drCr": "cr", "amount": 25000 }
  ],
  "narration": "Office rent — January",
  "reference": "NEFT-UTR-XY12345",
  "skipIfExists": true,
  "idempotencyKey": "rent-2026-01"
}'
# → { "ok": true, "data": { "success": true, "created": 1, "lastVchId": "…" } }
```

Add `"dryRun": true` to validate every invariant and echo the exact posting **without** writing.

### 5. Handle an error

```bash
curl -s -o body.json -w '%{http_code}' "$BASE/vouchers" -H "$KEY" \
  -H 'Content-Type: application/json' \
  -d '{ "voucherType": "Journal", "date": "2026-01-15",
        "entries": [ { "ledger": "Rent", "drCr": "dr", "amount": 1000 },
                     { "ledger": "HDFC Bank", "drCr": "cr", "amount": 900 } ] }'
# 422
# body.json → { "ok": false, "error": { "code": "UNBALANCED", "retryable": false, ... } }
```

### Client quickstart

**Node.js**

```js
const BASE = "https://tally.myfirm.com/api/v1";
const KEY = process.env.TALLY_API_KEY;

async function tally(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${json.error.code}: ${json.error.message}`);
  return json.data;
}

const period = await tally("/period");
const tb = await tally("/reports/trial-balance", { fromDate: period.fyFrom, toDate: period.fyTo });
```

**Python**

```python
import os, requests

BASE = "https://tally.myfirm.com/api/v1"
S = requests.Session()
S.headers["Authorization"] = f"Bearer {os.environ['TALLY_API_KEY']}"

def tally(path, body=None):
    r = S.post(BASE + path, json=body) if body else S.get(BASE + path)
    j = r.json()
    if not j["ok"]:
        raise RuntimeError(f"{j['error']['code']}: {j['error']['message']}")
    return j["data"]

period = tally("/period")
tb = tally("/reports/trial-balance", {"fromDate": period["fyFrom"], "toDate": period["fyTo"]})
```

---

## Editions (unchanged from MCP)

`TALLY_EDITION` drives `load-company` semantics identically to the MCP version:

| Edition | Resident companies | `load` behaviour |
| --- | --- | --- |
| `silver` | **1** | Always a SWAP — restarts Tally with only the requested company (`replace` forced) |
| `gold` | many | Additive — appends `Load=`, restarts with the new company plus previous ones; switch for free via `POST /companies/active` |

Silver callers query one company at a time (paying the ~10–30 s restart between switches); Gold
callers pre-load subsidiaries and flip the active pointer with no restart. See
[Editions](README.md#editions) for the full rationale.

---

## Configuration

The API edition adds a few keys to the [MCP `.env`](README.md#configuration); everything else
(Tally connection, edition, GUI-agent, rate-limit, analytics keys) is shared.

| Variable | Default | Description |
| --- | --- | --- |
| `API_KEYS` | *(unset → API disabled)* | Comma-separated Bearer API keys accepted on `/api/v1`. |
| `API_BASE_PATH` | `/api/v1` | Mount path for the REST layer. |
| `PUBLIC_URL` | `MCP_DOMAIN` | Public HTTPS base URL (used in docs/self-links). |
| `READONLY_MODE` | `false` | `true` → all write endpoints return `403 READONLY`. |
| `CORS_ORIGINS` | *(MCP_DOMAIN)* | Allowed browser origins (only relevant if calling from a browser). |
| `AUTH_RATE_LIMIT_WINDOW_MS` / `AUTH_RATE_LIMIT_MAX` | `60000` / `10` | Rate-limit window/size, shared with OAuth endpoints. |
| `BIND_HOST` / `PORT` | `127.0.0.1` / `3000` | Bind address/port (`0.0.0.0` only behind a reverse proxy). |

---

## Security

- **Bearer API keys**, constant-time compared; unset `API_KEYS` disables the surface entirely.
- **Read-only mode** — one env var turns the whole deployment into a safe reporting API.
- **Rate limiting** on auth-sensitive routes (shared config with OAuth).
- **CORS** restricted to configured origins for browser callers; server-to-server needs no origin.
- **SQL guard** — `/query` accepts `SELECT` only; anything else is rejected before execution.
- **Audit logging** — every call is logged with timestamp, args (secrets redacted), and duration.
- **Bind loopback + TLS at the proxy** — never expose `3000` directly; terminate HTTPS at
  nginx / Caddy / Cloudflare Tunnel, same as the MCP deployment.

Before exposing **write** endpoints to the internet, read the
[Security assessment](security-assessment.md) and
[Cloudflare Tunnel hardening](cloudflare-tunnel-provisioning.md#security--hardening).

---

## See also

- [Full documentation & MCP setup](README.md)
- [Windows installer](installer.md) · [remote server (Windows)](server-setup-windows.md) · [remote server (Linux)](server-setup-linux.md)
- [Security assessment](security-assessment.md) · [Changelog](CHANGELOG.md)

---

## License

[AGPL-3.0-or-later](../LICENSE) — Copyright © 2026 **Jina Code Systems LLP**. Per AGPL-3.0 § 7(b),
the "A Jina Code Systems LLP project" attribution is a **required notice** — see [NOTICE](../NOTICE).
