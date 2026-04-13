# Contributing to Tally Prime MCP Server

Thank you for your interest in contributing! This project bridges Tally Prime ERP with AI assistants via the Model Context Protocol, and contributions from the accounting/developer community are welcome.

## Getting Started

1. Fork the repository
2. Clone your fork and install dependencies:
   ```bash
   git clone https://github.com/<your-username>/tally-mcp-server.git
   cd tally-mcp-server
   npm install
   ```
3. Copy `.env.example` to `.env` and configure for your environment
4. Build and run:
   ```bash
   npx tsc
   node dist/index.mjs
   ```

## Development Setup

- **Node.js** 20+ required
- **TypeScript** — all source is in `src/`, compiled to `dist/`
- **Tally Prime** with XML Server on port 9000 (required to test most tools)

### Project Structure

```
src/
  index.mts      # Entry point (stdio mode)
  server.mts     # Express HTTP server + OAuth
  mcp.mts        # MCP tool registrations
  tally.mts      # Tally XML communication
  database.mts   # DuckDB in-memory cache
  models.mts     # Data models
  utility.mts    # Helpers
pull/            # Nunjucks XML templates for read operations
push/            # Nunjucks XML templates for write operations
```

### Building

```bash
npx tsc            # Compile TypeScript
```

There is no test suite yet — contributions to add one are welcome.

## How to Contribute

### Reporting Issues

- Use [GitHub Issues](https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/issues)
- Include your Tally Prime version, Node.js version, and OS
- For data issues, include the XML request/response (redact sensitive company data)

### Submitting Changes

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/your-feature
   ```
2. Make your changes — keep commits focused and descriptive
3. Ensure the project builds cleanly: `npx tsc`
4. Push and open a Pull Request against `main`

### Adding a New MCP Tool

Most contributions will be adding new read/write tools. The pattern:

1. **Create an XML template** in `pull/` (read) or `push/` (write) using Nunjucks
2. **Add template config** in `pull/config.json` or `push/config.json`
3. **Register the tool** in `src/mcp.mts` with input schema (Zod), description, and handler
4. **Test** against a running Tally instance

Look at existing tools in `src/mcp.mts` for the pattern — most follow the same `handlePull` → `cacheTable` → return `tableID` flow.

### Adding TDL Templates

XML templates use [Nunjucks](https://mozilla.github.io/nunjucks/) for variable interpolation. Key variables available:

- `fromDate`, `toDate` — date range parameters
- `targetCompany` — optional company name
- Any custom parameters defined in config.json

## Code Style

- TypeScript strict mode
- Use `const` over `let` where possible
- Prefer `Map` for parameter passing (matches existing pattern)
- Include audit logging in write tools
- Validate inputs at the tool boundary (Zod schemas + manual checks)

## Security

This project handles financial data. Please:

- Never log sensitive data (passwords, tokens, company financials)
- Validate all SQL in `query-database` — only `SELECT` is allowed
- Respect `READONLY_MODE` in write tools
- Report security vulnerabilities privately via [GitHub Security Advisories](https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/security/advisories)

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0-or-later](LICENSE) license.
