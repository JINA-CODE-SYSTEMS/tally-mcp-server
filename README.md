<div align="center">

<img src="scripts/tray/assets/claudally-logo.png" width="96" alt="Claudally logo">

# Claudally

**Drive Tally Prime with Claude.** A Tally Prime ERP ↔ [MCP](https://modelcontextprotocol.io/) server for Claude, ChatGPT, Copilot, and any MCP client.

by **JINA CODE SYSTEMS LLP** &nbsp;<img src="scripts/tray/assets/jina-logo.png" height="26" alt="JINA CODE SYSTEMS LLP logo">

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

</div>

*(“Claudally” = Claude + Tally. Formerly “Tally Prime MCP Server”.)*

**A [Jina Code Systems LLP](https://github.com/JINA-CODE-SYSTEMS) project.**
Copyright © 2026 Jina Code Systems LLP. Licensed under [AGPL-3.0-or-later](LICENSE).
This attribution is a required notice under AGPL-3.0 § 7(b) and **must be preserved** in
all copies, forks, and derivative works — see [NOTICE](NOTICE) for the full clause.

**Claudally** bridges **Tally Prime ERP** with AI assistants (Claude, ChatGPT, GitHub Copilot, any MCP client) — query financial reports, manage masters, create vouchers, and analyse GST, all through natural language.

## 📖 Documentation

**→ [Full documentation & setup guide](docs/README.md)**

| Topic | Guides |
| --- | --- |
| **Install** | [Windows installer](docs/installer.md) · [remote server (Windows)](docs/server-setup-windows.md) · [remote server (Linux)](docs/server-setup-linux.md) |
| **Connect** | [Which URL?](docs/README.md#connecting--which-url) · [Cloudflare Tunnel](docs/cloudflare-tunnel-provisioning.md) · [Security & hardening](docs/cloudflare-tunnel-provisioning.md#security--hardening) |
| **Reference** | [Security assessment](docs/security-assessment.md) · [Changelog](docs/CHANGELOG.md) · [Design notes](docs/dev/) |

## Quick start (from source)

```bash
git clone https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server.git
cd tally-mcp-server
npm install && npx tsc
```

For a production Windows deployment use the **[installer](docs/installer.md)** — it takes a box from "nothing installed" to "service running" in under 5 minutes (bundles portable Node.js, NSSM, and `cloudflared`). Everything else — configuration, tools, editions, connecting a client — is in the **[full docs](docs/README.md)**.

## License

[AGPL-3.0-or-later](LICENSE). Copyright © 2026 JINA CODE SYSTEMS LLP. The attribution above and in [NOTICE](NOTICE) must be preserved (AGPL § 7(b)).
