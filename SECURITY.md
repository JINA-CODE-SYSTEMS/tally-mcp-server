# Security Policy

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Please report security vulnerabilities through [GitHub Security Advisories](https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/security/advisories/new).

You will receive an acknowledgment within 48 hours and a detailed response within 7 days.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Security Model

This server bridges AI assistants with Tally Prime ERP (financial data). Key controls:

- **OAuth 2.1 + PKCE** — Required for remote/cloud mode
- **SQL validation** — SELECT-only queries to DuckDB (no INSERT/DELETE/DROP/file access)
- **XML injection prevention** — All parameters HTML-escaped before Tally XML injection
- **Rate limiting** — 10 req/min on authentication endpoints
- **Audit logging** — All tool invocations logged with sensitive fields redacted
- **Read-only mode** — `READONLY_MODE=true` disables all write tools

See [docs/security-assessment.md](docs/security-assessment.md) for the full threat model.

## Responsible Disclosure

We follow coordinated disclosure. We ask that you:

1. Allow us reasonable time to fix the issue before public disclosure
2. Avoid accessing or modifying other users' data
3. Act in good faith to avoid privacy violations and service disruption
