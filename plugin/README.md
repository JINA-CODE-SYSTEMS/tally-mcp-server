# Tally Feeding — Cowork plugin (skill only)

Client-consistent bookkeeping data entry into Tally Prime. Claude profiles how a firm
*actually posts* (numbering, narration house-style, ledger pairings), confirms it with you,
then feeds ledgers, stock items and vouchers (GST and non-GST) that match — staying
consistent across sessions via a per-client instruction sheet.

This plugin ships the **skill only**. It does not contain or configure the MCP server — you
connect that separately (below), so the connection lives in *your* settings and stays
editable. No client data is included.

## What you need
1. **Tally Prime MCP server** (open source): https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server
   — installed and connected as an MCP connector. This is the engine that talks to Tally.
2. **TallyPrime** (Silver/Gold) with its XML server enabled — F1 -> Settings -> Connectivity
   -> Client/Server Configuration -> acts as Server, Port 9000 — on a machine the server can reach.
3. A **connected working folder** in Cowork, so per-client sheets persist.

## Install the server (once, on the Tally machine)
    git clone https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server.git
    cd tally-mcp-server
    npm install
    npx tsc
    cp .env.example .env        # set TALLY_HOST, TALLY_PORT=9000, TALLY_DATA_PATH, ...
Requires Node.js 20+.

## Connect it to Claude / Cowork
- **Same machine (local, stdio):** add to your Claude desktop MCP config —
  `{ "command": "node", "args": ["<path-to-repo>/dist/index.mjs"] }`
- **Remote / central server (HTTP + OAuth 2.1):** deploy the server on a box that can reach
  Tally, expose it over HTTPS, then add
  `{ "type": "http", "url": "https://your-domain/mcp" }`
  (see the repo's docs/server-setup-linux.md or server-setup-windows.md).

The connection lives in *your* connector settings, not in this read-only plugin — so each
user sets and edits their own command/URL. That is how you change it after install.

> Note: the MCP endpoint is the *server's* HTTP port (default 3000, e.g.
> `http://localhost:3000/mcp`) or a local stdio launch — not Tally's XML port (9000).

## Install this plugin
Install `tally-feeding.plugin` in Cowork (button or marketplace). It lands read-only in
Capabilities; client sheets grow in your connected folder as `tally-clients/<company-slug>.md`.

## Using it
"feed data for [client]", "load [client] and post these receipts", "book this purchase",
"record GST sales", "create a ledger". On a fresh client the skill first **profiles how the
firm posts** (numbering, narration, ledger pairings) from real vouchers and confirms it with
you; then every entry is conformed to that profile, previewed, and posted only on approval.
If the server's tools aren't connected yet, the skill asks you to install/connect it first.

## License
The MCP server is AGPL-3.0 (see its repo). This plugin bundles only the generic skill and no
client data.
