# Tally Prime MCP Server

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

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
| `open-company` | Attempts to load a company into Tally (**[experimental — see #1](https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/issues/1)**) |

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

### GUI Agent v1 — Keystroke Automation

```powershell
powershell -ExecutionPolicy Bypass -File scripts\tally-gui-agent.ps1 [-WatchDir <path>]
```

Runs in the **interactive desktop session** where Tally is visible. Watches for command files from the MCP server and injects keystrokes (F-keys, Enter, Escape, menu navigation) into the Tally window to load companies.

- **Install:** Add to Windows Startup folder or Task Scheduler (run at user logon)
- `-WatchDir` defaults to `$env:TALLY_DATA_PATH` or `C:\Users\Public\TallyPrimeEditLog\data`

### GUI Agent v2 — LLM-Guided (Computer Use)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\tally-gui-agent-v2.ps1 [-LLMProvider anthropic|openai] [-MaxSteps 15]
```

Advanced agent that takes **screenshots** of the Tally window, sends them to an LLM (Claude or GPT-4o) for visual analysis, executes the recommended action, and loops until the goal is achieved. Requires `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

- **Install:** Same as v1 — run in interactive session
- Requires `TallyUI.dll` (see below)
- LLM model, tokens, and timeout are configurable via env vars (see [Configuration](#configuration))

### Company Loader UI Script

```powershell
powershell -ExecutionPolicy Bypass -File scripts\open-company-ui.ps1 -TallyExePath "..." -CompanyDataPath "..."
```

Standalone script to load a specific company into Tally via Win32 keystroke injection. Used internally by the `open-company` tool's Strategy 2.

### TDL Add-on — Programmatic Company Loading

```
scripts/mcp-company-loader.tdl
```

A Tally TDL add-on that enables company loading via the XML server API (Strategy 1 of `open-company`). Install by copying to the Tally directory and adding to `tally.ini`:

```ini
[Tally]
TDL = yes
Default TDL = mcp-company-loader.tdl
```

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