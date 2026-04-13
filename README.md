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

Most report tools cache their output in a temporary DuckDB table (returned as `tableID`). Use `query-database` to run analytical SQL — aggregate, filter, join, sort — on those cached tables. Tables auto-expire after 15 minutes.

## Security

- **OAuth 2.1 + PKCE** with constant-time token comparison
- **Helmet** security headers
- **CORS** restricted to configured origins
- **Rate limiting** on authentication endpoints (10 req/min)
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

## Credits

Originally created by [Dhananjay Gokhale](https://github.com/dhananjay1405/tally-mcp-server). This fork is maintained by [Jinacode Systems](https://github.com/JINA-CODE-SYSTEMS).

## License

[AGPL-3.0-or-later](LICENSE)