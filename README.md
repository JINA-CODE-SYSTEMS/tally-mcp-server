# Tally Prime MCP Server

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

> **Note:** Git history was rewritten on 16 Apr 2026 to remove accidentally committed auth tokens. All leaked credentials have been rotated. Thanks to [@Journeyman1987](https://github.com/Journeyman1987) for flagging this.

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that bridges **Tally Prime ERP** with AI assistants like Claude, ChatGPT, GitHub Copilot, and any MCP-compatible client. Query financial reports, manage masters, create vouchers, and analyse GST data — all through natural language.

## Features

- **23 MCP tools** — financial reports, master data, stock, GST, voucher creation
- **DuckDB in-memory analytics** — cached report tables for complex SQL queries
- **OAuth 2.1 + PKCE** authentication for remote/cloud deployments
- **Security hardened** — Helmet, CORS, rate limiting, audit logging, read-only mode
- **Local & remote** — run as a local stdio server or a cloud HTTP server behind a reverse proxy

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

A double-click `TallyMCP-Setup-<version>.exe` takes a Windows box from
"nothing installed" to "service running" in under 5 minutes. Bundles portable
Node.js + NSSM, prompts for the few values it can't auto-detect, registers
the Windows service and the GUI agent at-logon task. See
[docs/installer.md](docs/installer.md) for build instructions.

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

Tally Prime has **no XML or TDL primitive that loads a company from disk into memory**. We confirmed this by reverse-engineering every dispatch surface the XML server exposes (see [`notes/tdl-experiments.md`](notes/tdl-experiments.md)). The built-in `$$CmpLoadCompany` is misleadingly named — it's "select among already-loaded companies", not "load from disk". Loading is exclusively initiated by Tally process startup (via `Load=` directives in `tally.ini`) or the Tally UI (Alt+F3).

Therefore `load-company` works the only way it can: rewrites `tally.ini`, kills `tally.exe`, and asks the GUI agent (which lives in the user's interactive desktop session) to start it again. This is unavoidable until Tally exposes a load verb in a future protocol version.

### Operational requirement: GUI agent must be running

Because the MCP server typically runs as a Windows service in **Session 0** (no desktop), it cannot spawn `tally.exe` directly. The companion script [`scripts/tally-gui-agent-v2.ps1`](scripts/tally-gui-agent-v2.ps1) runs in the user's interactive session and acts as the bridge — `load-company` IPCs to it to perform the spawn.

- **Install** the agent to start at user logon. `setup-windows.ps1` registers a `TallyMCPAgent` Scheduled Task at-logon for the configured user — no manual setup needed. The Windows installer (option A above) does the same automatically.
- **Self-update on deploy.** When a `git pull` replaces `tally-gui-agent-v2.ps1` on disk, the running agent detects the mtime change between commands and re-launches into the new version. Combined with the at-logon task, deploys propagate without operator intervention.
- **Version handshake.** The agent reports `agentVersion` on every response. `load-company` refuses to call destructive actions on an agent older than `REQUIRED_AGENT_VERSION` and returns a clear remediation message instead of silently no-op'ing on unrecognized IPC fields. `open-company-debug` surfaces both the running version and `versionOk` status.
- **No LLM key required** for the deterministic actions (`ping`, `start-tally`, `select-and-unlock-company`). Only set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` if you want the LLM-guided UI navigation fallback (`open-company` Strategy 3).
- **`load-company` pings the agent before doing anything destructive** — if the agent isn't responding (or is too old), the tool refuses to kill Tally and returns a clear error. So a misconfigured deployment never ends up worse than it started.
- **Check liveness** any time via `open-company-debug` — it returns `guiAgentResponding`, `guiAgentVersion`, `guiAgentVersionOk`, and `guiAgentVersionRequired`.

## Setup

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

The server uses OAuth 2.1 with PKCE for authentication. Detailed setup guides:
- [Linux-based Server](docs/server-setup-linux.md) (recommended — Tally connects via SSH tunnel)
- [Windows Server](docs/server-setup-windows.md)

## Available Tools

### Company Management

| Tool | Description |
|------|-------------|
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

One-time setup to register the MCP server as a Windows service via [NSSM](https://nssm.cc/). Configures auto-start, log rotation, and loads `.env` variables. See [Windows Server Setup](docs/server-setup-windows.md) for the full guide.

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

Originally created by [Dhananjay Gokhale](https://github.com/dhananjay1405/tally-mcp-server). This fork is maintained by [Jinacode Systems](https://github.com/JINA-CODE-SYSTEMS).

## License

[AGPL-3.0-or-later](LICENSE)