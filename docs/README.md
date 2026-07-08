<div align="center">

<img src="../scripts/tray/assets/claudally-logo.png" width="96" alt="Claudally logo">

# Claudally

**Drive Tally Prime with Claude.** A Tally Prime ERP ↔ [MCP](https://modelcontextprotocol.io/) server for Claude, ChatGPT, Copilot, and any MCP client.

by **JINA CODE SYSTEMS LLP** &nbsp;<img src="../scripts/tray/assets/jina-logo.png" height="26" alt="JINA CODE SYSTEMS LLP logo">

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](../LICENSE)

</div>

*(“Claudally” = Claude + Tally. Formerly “Tally Prime MCP Server”.)*

**A [Jina Code Systems LLP](https://github.com/JINA-CODE-SYSTEMS) project.**
Copyright © 2026 Jina Code Systems LLP. Licensed under [AGPL-3.0-or-later](../LICENSE).
This attribution is a required notice under AGPL-3.0 § 7(b) and **must be preserved** in
all copies, forks, and derivative works — see [NOTICE](../NOTICE) for the full clause.

**Claudally** is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that bridges **Tally Prime ERP** with AI assistants like Claude, ChatGPT, GitHub Copilot, and any MCP-compatible client. Query financial reports, manage masters, create vouchers, and analyse GST data — all through natural language.

## Features

- **29 MCP tools** — financial reports, master data, stock, GST, voucher creation, plus dedicated company-management tools (`load-company`, `set-active-company`, `list-loaded-companies`, `list-available-companies`)
- **Cold-load with credentials** — load a password-protected company from a Tally with nothing resident, end-to-end via MCP. Edition-aware (Silver swaps, Gold accumulates). Documented in [Editions](#editions).
- **Companion GUI agent** — runs in the user session, bridges Windows Session 0 isolation so the Session-0 service can spawn `tally.exe` and keystroke through credential prompts. Self-restarts on script update; version handshake refuses stale agents.
- **DuckDB in-memory analytics** — cached report tables for complex SQL queries
- **OAuth 2.1 + PKCE** authentication for remote/cloud deployments
- **Security hardened** — Helmet, CORS, rate limiting, audit logging, read-only mode
- **Local & remote** — run as a local stdio server or a cloud HTTP server behind a reverse proxy
- **Windows installer** ([#18](https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/issues/18)) — double-click `.exe` from "nothing installed" to "service running" in under 5 minutes. Bundles portable Node + NSSM; no admin pre-reqs beyond UAC.
- **Status tray icon** ([#20](https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/issues/20)) — at-a-glance health for non-developer operators. Service + agent + Tally + public URL all visible in one click.

## Prerequisites

- **Tally Prime** (Silver / Gold) with XML Server enabled
- **Node.js** 20+

Enable the XML server in Tally: **F1 → Settings → Connectivity → Client/Server Configuration**
```
TallyPrime acts as = Server
Port = 9000
```

> **Note:** Avoid the Educational edition — its date-range limitations produce incomplete data.

## Installation

### Option A — Windows installer (recommended for client deployments)

A double-click **`Claudally-Setup-<version>.exe`** takes a Windows box from
"nothing installed" to "service running" in under 5 minutes. Bundles portable
Node.js, NSSM, and `cloudflared`; registers the Windows service and the GUI
agent at-logon task. See [docs/installer.md](installer.md) for build
instructions.

**The setup wizard collects (most values auto-detect — usually just click Next):**

- **Page 1 — Tally MCP Configuration:** OAuth password (min 12 chars — this gates every tool), Tally exe / data / `tally.ini` paths, and the Windows user the GUI agent runs as.
- **Page 2 — Remote Access (optional):** a public domain / Cloudflare Tunnel hostname and a Cloudflare Tunnel token. **Leave both blank for localhost-only** (Claude Desktop on the same PC needs nothing here) — see [Connecting — which URL?](#connecting--which-url) below.
- **Page 3 — Tally Edition:** Silver / Gold, plus a checkbox to let **Claude control Tally directly** (screenshots + keystrokes for login / company switching) — on by default.

Change any of these later via the **Reconfigure** Start-Menu shortcut, or manage saved companies from the tray icon → **Manage Companies**.

### Option B — From source (development / custom deployments)

```bash
git clone https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server.git
cd tally-mcp-server
npm install
npx tsc
```

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Default | Description |
|----------|---------|-------------|
| **Core** | | |
| `PASSWORD` | *(required for remote)* | OAuth authentication password |
| `TALLY_HOST` | `localhost` | Tally Prime XML server hostname |
| `TALLY_PORT` | `9000` | Tally Prime XML server port |
| `TALLY_DATA_PATH` | `C:\Users\Public\TallyPrime\data` | Tally data directory (for `list-companies`) |
| `TALLY_EXE_PATH` | `C:\Program Files\TallyPrime\tally.exe` | Tally executable path |
| `TALLY_INI_PATH` | `C:\Program Files\TallyPrimeEditLog\tally.ini` | Path to tally.ini (used by `load-company`) |
| `TALLY_COMPANIES_CONFIG` | `<TALLY_DATA_PATH>/.tally-mcp-companies.json` | Optional credential-hint config for `list-available-companies`. See "Optional credential-hint config" below. |
| `TALLY_EDITION` | `silver` | `silver` or `gold`. Drives `load-company` semantics — see [Editions](#editions) below. |
| `TALLY_DEBUG_XML` | *(unset)* | Set to `1` to enable the `tally-raw-xml-probe` tool for protocol RE. Leave unset in production. |
| `PORT` | `3000` | HTTP server port |
| `MCP_DOMAIN` | `http://localhost:3000` | Public-facing URL |
| `BIND_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` only behind reverse proxy) |
| `CORS_ORIGINS` | *(defaults to MCP_DOMAIN)* | Comma-separated allowed origins |
| `READONLY_MODE` | `false` | Set `true` to disable all write tools |
| `ADMIN_SECRET` | | Optional secret for manual client registration |
| **Auth & Rate Limiting** | | |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in ms (1 minute) |
| `AUTH_RATE_LIMIT_MAX` | `10` | Max auth attempts per window |
| `AUTH_CODE_EXPIRY_MS` | `600000` | Authorization code TTL in ms (10 minutes) |
| `ACCESS_TOKEN_EXPIRY_SEC` | `3600` | Access token TTL in seconds (1 hour) |
| `TOKEN_CLEANUP_INTERVAL_MS` | `60000` | Expired token cleanup interval in ms |
| **Analytics** | | |
| `DB_TABLE_RETENTION_MS` | `900000` | DuckDB temp table TTL in ms (15 minutes) |
| `LOG_RETAIN_COUNT` | `10` | Max rotated log files to keep |
| **Health endpoint** | | |
| `STATUS_ENDPOINT_PUBLIC` | *(unset)* | Set to `1`/`true` to expose an unauthenticated `GET /status` health endpoint (disabled by default). |
| `GIT_COMMIT` / `BUILD_TIME` | *(unset)* | Optional build info surfaced in `/status` `build.commit` / `build.builtAt`. |
| **GUI Agent (open-company)** | | |
| `OPEN_COMPANY_GUI_TIMEOUT_SEC` | `180` | GUI agent timeout in seconds (min 90) |
| `OPEN_COMPANY_GUI_MAX_STEPS` | `25` | Max LLM-guided steps per command (min 12) |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | Anthropic model for GUI agent |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI model for GUI agent |
| `LLM_MAX_TOKENS` | `300` | Max tokens per LLM response |
| `LLM_TIMEOUT_SEC` | `30` | LLM API request timeout in seconds |
| `ANTHROPIC_API_VERSION` | `2023-06-01` | Anthropic API version header |

## Editions

Tally Prime ships in two relevant editions, and `load-company` adapts its behavior to each. **You must set `TALLY_EDITION` correctly** — defaulting to `silver` is the safe assumption.

| Edition | Companies resident at once | `load-company` behavior |
| ------- | -------------------------- | ----------------------- |
| `silver` | **1** (engine limit) | Always a SWAP — strips other `Load=` entries, restarts Tally with only the requested company. `replace=true` is forced regardless of what was passed. `list-loaded-companies` will only ever return 0 or 1 entry. |
| `gold` | many | Additive by default — appends `Load=<id>` to `tally.ini`, restarts Tally with the new company plus all previous ones. Pass `replace=true` to force a swap. After loading several, switch between them via `set-active-company` (in-memory pointer flip, no restart). |

**Why this matters for the multi-subsidiary cross-reference workflow:** Silver clients can only query one company at a time, so an LLM doing "compare ledgers across 3 subsidiaries" will pay the ~10–30s restart latency between each. Gold clients can pre-load all subsidiaries and switch between them for free.

**Why no auto-detection:** Tally's edition isn't reliably exposed via the XML server. Rather than ship a fragile auto-detect that could miscategorize and silently degrade behavior, the server takes the configured value as authoritative.

### Background: why Tally must be restarted to load a company

Tally Prime has **no XML or TDL primitive that loads a company from disk into memory**. We confirmed this by reverse-engineering every dispatch surface the XML server exposes (see [`notes/tdl-experiments.md`](../notes/tdl-experiments.md)). The built-in `$$CmpLoadCompany` is misleadingly named — it's "select among already-loaded companies", not "load from disk". Loading is exclusively initiated by Tally process startup (via `Load=` directives in `tally.ini`) or the Tally UI (Alt+F3).

Therefore `load-company` works the only way it can: rewrites `tally.ini`, kills `tally.exe`, and asks the GUI agent (which lives in the user's interactive desktop session) to start it again. This is unavoidable until Tally exposes a load verb in a future protocol version.

### Operational requirement: GUI agent must be running

Because the MCP server typically runs as a Windows service in **Session 0** (no desktop), it cannot spawn `tally.exe` directly. The companion script [`scripts/tally-gui-agent-v2.ps1`](../scripts/tally-gui-agent-v2.ps1) runs in the user's interactive session and acts as the bridge — `load-company` IPCs to it to perform the spawn.

- **Install** the agent to start at user logon. `setup-windows.ps1` registers a `TallyMCPAgent` Scheduled Task at-logon for the configured user — no manual setup needed. The Windows installer (option A above) does the same automatically.
- **Self-update on deploy.** When a `git pull` replaces `tally-gui-agent-v2.ps1` on disk, the running agent detects the mtime change between commands and re-launches into the new version. Combined with the at-logon task, deploys propagate without operator intervention.
- **Version handshake.** The agent reports `agentVersion` on every response. `load-company` refuses to call destructive actions on an agent older than `REQUIRED_AGENT_VERSION` and returns a clear remediation message instead of silently no-op'ing on unrecognized IPC fields. `open-company-debug` surfaces both the running version and `versionOk` status.
- **No LLM key required** for the deterministic actions (`ping`, `start-tally`, `select-and-unlock-company`). Only set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` if you want the LLM-guided UI navigation fallback (`open-company` Strategy 3).
- **`load-company` pings the agent before doing anything destructive** — if the agent isn't responding (or is too old), the tool refuses to kill Tally and returns a clear error. So a misconfigured deployment never ends up worse than it started.
- **Check liveness** any time via `open-company-debug` — it returns `guiAgentResponding`, `guiAgentVersion`, `guiAgentVersionOk`, and `guiAgentVersionRequired`.

## Setup

### Connecting — which URL?

Where your Claude client runs decides what URL to point it at. **Rule of thumb: you only need a public URL when the client is *not* on the Tally PC.**

| Your Claude client | URL to use | Wizard "Remote Access" page |
| --- | --- | --- |
| **Claude Desktop on the Tally PC** | local (stdio, or `http://127.0.0.1:3000/mcp`) | leave both fields blank |
| **Claude Desktop on another PC** | the public HTTPS URL | fill it in (tunnel or own domain) |
| **claude.ai / ChatGPT in a browser** | the public HTTPS URL | fill it in (tunnel or own domain) |

Two ways to get that public HTTPS URL:

- **Cloudflare Tunnel** *(in progress)* — no domain, no static IP, no router config. A Jina admin provisions a token + hostname; you paste both into the wizard's Remote Access page and the bundled `cloudflared` gives the box a stable HTTPS URL. The server binds **loopback-only** (safest). See [docs/cloudflare-tunnel-provisioning.md](cloudflare-tunnel-provisioning.md).
- **Your own domain** — you have a domain, a routable/static IP, and can run a reverse proxy. Put your `https://…` URL in the hostname field, leave the token blank; the server binds `0.0.0.0` and **you** terminate TLS with a reverse proxy (e.g. Caddy) in front of `127.0.0.1:3000`.

Either way, add the URL (with `/mcp`) as a custom connector in your client and sign in with the OAuth password from the wizard. Before exposing writes to the internet, read [Security & hardening](cloudflare-tunnel-provisioning.md#security--hardening).

### Local (Claude Desktop)

Add to your `claude_desktop_config.json` (File → Settings → Developer):

```json
{
  "mcpServers": {
    "Tally Prime": {
      "command": "node",
      "args": ["<path-to-repo>/dist/index.mjs"]
    }
  }
}
```

### Local (VS Code / GitHub Copilot)

Add to your workspace `.vscode/mcp.json`:

```json
{
  "servers": {
    "tally-prime": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to-repo>/dist/index.mjs"]
    }
  }
}
```

### Remote / Cloud

For browser-based clients (ChatGPT, Claude web, Copilot) that can't reach a local Tally install, deploy the server on a machine that can access Tally and expose it over HTTPS.

```json
{
  "servers": {
    "tally-prime": {
      "type": "http",
      "url": "https://your-domain.example/mcp"
    }
  }
}
```

The server uses OAuth 2.1 with PKCE for authentication. See [Connecting — which URL?](#connecting--which-url) above for which path fits your client.

**No public domain or static IP?** *(in progress)* — the Windows installer can bundle **Cloudflare Tunnel**: fill in the token + hostname on the wizard's Remote Access page and `cloudflared` gives the box a stable public HTTPS URL (e.g. `https://<client>.tally.jinacode.systems`) with **zero router/port-forward config**, binding the server loopback-only. See [docs/cloudflare-tunnel-provisioning.md](cloudflare-tunnel-provisioning.md).

**Own domain instead?** Put your `https://…` URL in the hostname field, leave the token blank (server binds `0.0.0.0`), and terminate TLS with a reverse proxy in front of `127.0.0.1:3000`. Caddy is the quickest — auto HTTPS:

```caddy
tally.myfirm.com {
    reverse_proxy 127.0.0.1:3000
}
```

Detailed setup guides:
- [Linux-based Server](server-setup-linux.md) (recommended — Tally connects via SSH tunnel)
- [Windows Server](server-setup-windows.md)
- [Cloudflare Tunnel provisioning](cloudflare-tunnel-provisioning.md) (per-client tunnel setup for NAT'd boxes)

## Available Tools

### Company Management

> **Recommended flow:** use `resolve-company` to turn a folder id, exact name, or configured alias into one canonical record, then load by alias with `load-company-by-alias`. That's the happy path — no exact-name guessing across the `list-*` tools.

| Tool | Description |
|------|-------------|
| `resolve-company` | Resolves one folder id / exact name / configured alias → `{ name, folderId, alias, isLoaded, isProtected }`, typed `ok`/`ambiguous`/`not-found`. The recommended entry point for company identity. |
| `load-company-by-alias` | Loads a company by its configured alias — the recommended load path (no exact-name matching). |
| `list-companies` | Lists company folders in the Tally data directory (no open company required) |
| `list-available-companies` | Recursive scan with display names + credential-requirement hints. Handles both stock layout and Tally Prime Edit Log's nested layout. Use this BEFORE `load-company` so an LLM/human knows which folder to load and whether credentials are needed. |
| `list-loaded-companies` | Lists companies currently resident in Tally (no restart needed) |
| `load-company` | Loads a company by editing `tally.ini` and restarting Tally. Edition-aware. Accepts optional `userName` + `password` for password-protected companies. |
| `set-active-company` | Cheap pointer flip between already-loaded companies (Gold edition) |
| `open-company` | Legacy multi-strategy loader (**[experimental — see #1](https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/issues/1)**) |
| `open-company-debug` | Reports server config, agent liveness, agent version, edition, and Tally XML reachability |

**Optional credential-hint config** (used by `list-available-companies`): drop a `.tally-mcp-companies.json` into the Tally data path (or set `TALLY_COMPANIES_CONFIG` to point elsewhere) with the shape:

```json
{
  "100000": { "requiresCredentials": true,  "knownUsername": "admin", "notes": "Edit Log; user-based security" },
  "200000": { "requiresCredentials": false, "notes": "Auto-loads cleanly" }
}
```

The config never stores passwords — only the hint that one is needed, so callers can prompt the human up-front instead of waiting for `load-company` to fail.

### Financial Reports

| Tool | Description |
|------|-------------|
| `chart-of-accounts` | Group hierarchy with BS/PL classification, Dr/Cr nature |
| `trial-balance` | Ledger-wise opening, debit, credit, closing for a period |
| `balance-sheet` | Balance sheet as on date |
| `profit-loss` | Profit & Loss statement for a period |
| `ledger-balance` | Closing balance of a single ledger as on date |
| `ledger-account` | Voucher-level ledger statement with GST breakup |
| `bills-outstanding` | Outstanding receivables / payables with overdue days |

### Inventory

| Tool | Description |
|------|-------------|
| `stock-summary` | Stock item summary with opening, inward, outward, closing |
| `stock-item-balance` | Available quantity of a stock item as on date |
| `stock-item-account` | Voucher-level stock item statement with tracking numbers |

### GST

| Tool | Description |
|------|-------------|
| `gst-voucher-details` | GST tax breakup of Sales/Purchase vouchers |
| `stock-item-gst` | GST configuration of all stock items (HSN, rates) |
| `gst-hsn-summary` | HSN-wise GST summary for return filing |
| `gstr1-summary` | GSTR-1 outward supplies summary (B2B/B2C) |
| `gstr2-summary` | GSTR-2 inward supplies summary for ITC reconciliation |

> **⚠️ Known limitation — GST returns need GST-configured ledgers.** `create-ledger` does not yet set a
> ledger's GST configuration (the tax type on CGST/SGST/IGST ledgers, nor GST applicability / nature-of-supply /
> HSN / rate on sales-purchase ledgers). So for a GST company, vouchers **book the CGST/SGST/IGST amounts
> correctly** — the accounts reconcile and `gst-voucher-details` / `ledger-account` show the tax — but Tally's
> **statutory `gstr1-summary` / GSTR-3B will not auto-populate**, because Tally classifies returns by those
> ledger GST settings, which aren't applied on server-created ledgers.
> **Workaround:** create the GST/tax ledgers in Tally first (or set their GST details once via *Alter → Set/alter
> GST details*), then post against them — returns then populate normally. Having `create-ledger` set GST nature is
> a planned **server** fix (not a skill/plugin fix).

### Master Data

| Tool | Description |
|------|-------------|
| `list-master` | List any master collection (ledger, group, stockitem, vouchertype, etc.) |

### Write Operations

| Tool | Description |
|------|-------------|
| `create-voucher` | Create vouchers (Sales, Purchase, Payment, Receipt, Journal, etc.) |
| `create-gst-voucher` | Create GST-compliant vouchers with auto tax ledger allocation |
| `create-ledger` | Create a new GL ledger master |
| `create-stock-item` | Create a new stock item master |

> Write tools are disabled when `READONLY_MODE=true`.

### Analytics

| Tool | Description |
|------|-------------|
| `query-database` | Run SQL queries on DuckDB against cached report tables |

Most report tools cache their output in a temporary DuckDB table (returned as `tableID`). Use `query-database` to run analytical SQL — aggregate, filter, join, sort — on those cached tables. Tables auto-expire after 15 minutes (configurable via `DB_TABLE_RETENTION_MS`).

## Security

- **OAuth 2.1 + PKCE** with constant-time token comparison
- **Helmet** security headers
- **CORS** restricted to configured origins
- **Rate limiting** on authentication endpoints (configurable via `AUTH_RATE_LIMIT_*`)
- **SQL validation** — only `SELECT` statements allowed in `query-database`
- **Audit logging** — every tool invocation logged with timestamp, args (secrets redacted), and duration
- **Read-only mode** — disable all write operations via env var

## Architecture

```
┌─────────────┐     ┌──────────────────────┐     ┌─────────────┐
│  MCP Client │────▶│   Tally MCP Server   │────▶│ Tally Prime │
│  (Claude,   │ MCP │  Express + MCP SDK   │ XML │  Port 9000  │
│  Copilot…)  │◀────│  DuckDB · OAuth 2.1  │◀────│             │
└─────────────┘     └──────────────────────┘     └─────────────┘
```

## Scripts & Utilities

The `scripts/` directory contains Windows-specific automation tools used by the `open-company` feature and server deployment.

### GUI Agent — Companion Script for Cross-Session Operations

```powershell
powershell -ExecutionPolicy Bypass -File scripts\tally-gui-agent-v2.ps1 [-LLMProvider anthropic|openai] [-MaxSteps 15]
```

Runs in the **interactive desktop session** where Tally is visible. The MCP server (which typically runs in Windows Session 0 with no desktop) communicates with this agent via JSON file IPC to perform actions that need a real desktop — most importantly **launching `tally.exe`** for `load-company` and **automating Alt+F3 → Select Company** for the optional LLM-guided fallback.

- **Install:** Add to Windows Startup folder or Task Scheduler (run at user logon)
- Requires `TallyUI.dll` (see below)
- **LLM key is OPTIONAL.** Deterministic actions (`ping`, `start-tally`) work without one. Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` only if you need the LLM-guided UI navigation fallback (`open-company` Strategy 3).
- LLM model, tokens, and timeout are configurable via env vars (see [Configuration](#configuration))

### TallyUI.dll — Win32 Interop Library

```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:library /reference:System.Drawing.dll /out:scripts\TallyUI.dll scripts\TallyUI.cs
```

Compiled C# library wrapping Windows APIs for window management, keystroke injection, and screenshot capture. Required by GUI Agent v2. The `setup-windows.ps1` script compiles this automatically.

### Windows Service Setup

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 [-InstallDir C:\tally-mcp-server] [-NodePath "..."] [-ServiceName TallyMCP]
```

One-time setup to register the MCP server as a Windows service via [NSSM](https://nssm.cc/). Configures auto-start, log rotation, loads `.env` variables, and registers two at-logon scheduled tasks: `TallyMCPAgent` (the GUI agent) and `TallyMCPTray` (the status tray icon). See [Windows Server Setup](server-setup-windows.md) for the full guide.

### Status Tray Icon (issue #20)

```powershell
powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts\tray\tally-mcp-tray.ps1
```

Runs in the user's interactive desktop session and surfaces a coloured tray icon (green/yellow/red/gray) reflecting overall TallyMCP health. Polls every few seconds for: service status, GUI agent task + process, Tally Prime process, and a public-URL OAuth metadata probe. Right-click for one-click admin actions:

- **Open logs folder** (also: double-click the tray icon)
- **Restart service** (prompts UAC for admin)
- **Restart GUI agent**
- **Launch Tally Prime** (uses `TALLY_EXE_PATH` from `.env`)
- **Reconfigure...** (re-runs `firstrun-config.ps1` for `.env` changes)
- **Quit (hide tray)** — hides the icon only; service and agent keep running

`setup-windows.ps1` registers this as `TallyMCPTray` ONLOGON; the Windows installer (Option A above) does the same. Pass `-SkipTrayTask` to either if you don't want the tray icon (e.g. headless server install).

No new runtime dependencies — uses WinForms `NotifyIcon` + `System.Drawing` already present on every Windows 10+ box.

### Deploy a New Version

After pushing changes to `origin/main`, refresh the running service on the Windows box.

**One command (recommended):**

```powershell
# From an admin PowerShell on the Tally box
cd C:\tally-mcp-server
.\scripts\deploy.ps1
```

The script halts on any failure rather than leaving a half-deployed state. It runs:

1. `git pull origin main`
2. `npm install` (skip with `-SkipInstall` when `package.json` hasn't changed)
3. `npm run build`
4. Force-stops the service (kills the `node.exe` process — graceful stop is unreliable under NSSM on Windows), then `Start-Service TallyMCP` and verifies the service is `Running` afterwards

**Useful flags:**

| Flag | Purpose |
| ---- | ------- |
| `-SkipInstall` | Skip `npm install` (~10s faster) — use when only source files changed |
| `-NoRestart` | Pull and build, but don't restart — for staging a deploy |
| `-ServiceName` | Override service name (default `TallyMCP`) |
| `-InstallDir` | Override repo path (default `C:\tally-mcp-server`) |

**Smoke test after deploy** (from anywhere):

```bash
curl -sS https://<your-domain>/.well-known/oauth-protected-resource
```

A JSON body with `resource` confirms the server is up. A `502` means the upstream Node process didn't come back — tail `logs\service-*.log` for the cause (most often a missing env var or a port collision).

**Manual fallback** — if `deploy.ps1` ever misbehaves, the equivalent five-step recipe is:

```powershell
cd C:\tally-mcp-server
git pull origin main
npm install
npm run build
Restart-Service TallyMCP
Get-Service TallyMCP
```

## Development

```bash
npm run build          # Compile TypeScript
npm test               # Build + run tests
npx tsc --noEmit       # Type-check without emitting
npm audit              # Check for dependency vulnerabilities
```

## Credits

Originally created by [Dhananjay Gokhale](https://github.com/dhananjay1405/tally-mcp-server) under the MIT licence (the original MIT notice is preserved in [NOTICE](../NOTICE)). This fork is maintained by **[Jina Code Systems LLP](https://github.com/JINA-CODE-SYSTEMS)** and is licensed under AGPL-3.0-or-later.

## License

[AGPL-3.0-or-later](../LICENSE) — Copyright © 2026 **Jina Code Systems LLP**.

Per AGPL-3.0 § 7(b), the "A Jina Code Systems LLP project" attribution at the top of this README, in [NOTICE](../NOTICE), and in the application's `--version` / startup banner output is a **required notice**. Forks and derivative works must keep it intact (modifications and additions to the surrounding text are welcome; removal of the attribution is not). See [NOTICE](../NOTICE) for the canonical clause.