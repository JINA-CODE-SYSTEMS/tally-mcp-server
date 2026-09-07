# Quickstart

Two pieces: the **server** (engine, installed once on the Tally machine) and this **plugin**
(the skill, installed in Cowork). They meet at a connector you control.

## 1. Server — on the Tally machine
    git clone https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server.git
    cd tally-mcp-server && npm install && npx tsc
    cp .env.example .env         # set TALLY_HOST, TALLY_PORT=9000, TALLY_DATA_PATH
Enable Tally's XML server: F1 -> Settings -> Connectivity -> Client/Server -> acts as Server, Port 9000.
(Node.js 20+ required.)

## 2. Connect the server to Cowork
- Same machine (stdio): add `{ "command": "node", "args": ["<repo>/dist/index.mjs"] }` to your
  Claude desktop MCP config.
- Central server (HTTP + OAuth): deploy it, then add
  `{ "type": "http", "url": "https://your-domain/mcp" }`. See the repo's server-setup docs.

## 3. Plugin — in Cowork
Install `tally-feeding.plugin`, then connect a working folder for client sheets.

## 4. Go
Say "feed data for [client]" — on a fresh client the skill profiles how the firm posts,
confirms it, then previews each entry and posts on your OK.
