# Tally MCP Server — Security Assessment

**Prepared for:** CTO Review  

**Repo:** `jain-t/tally-mcp-server` (branch: `kuwar-dev`)  
**Stack:** Node.js / Express 5 / TypeScript / DuckDB / MCP SDK  

---

## What This Server Does

Bridges AI agents (LLMs) with Tally Prime ERP. Exposes **read tools** (financial reports, GST data, ledger balances) and **write tools** (create vouchers, ledgers, stock items) against live Tally company data.

---

## Production Architecture

```
LLM Client ──── HTTPS (✅) ────► Cloud MCP Server ──── VPN/SSH Tunnel ────► Office Tally (:9000)
```

- MCP server hosted on cloud VPS with custom domain + HTTPS
- Tally Prime runs on a local office machine
- Connection between cloud ↔ office must go through an encrypted tunnel

### Connecting Cloud MCP to Office Tally

| Method | Security | Use? |
|--------|----------|------|
| **Reverse SSH Tunnel** | Encrypted, no ports exposed | ✅ |
| **VPN (WireGuard/Tailscale)** | Encrypted, private mesh | ✅ |
| **Port-forward Tally directly** | Tally XML API naked on internet | ❌ Never |

---

## Threat Summary

### CRITICAL — Fix Before Production

| Threat | What Can Happen | Where in Code |
|--------|----------------|---------------|
| **Default password `'password'`** | Anyone can authenticate — password is hardcoded as fallback | `server.mts` line 20: `process.env.PASSWORD \|\| 'password'` |
| **Open `/register` (no auth)** | Anyone can create OAuth clients, then log in with default password = full access | `server.mts` — `POST /register` has zero auth |
| **SQL → file system escape** | `query-database` passes raw SQL to DuckDB. Attacker/LLM can use `COPY TO`, `read_csv_auto()` to read/write **any file** on server disk. On cloud = full server compromise | `database.mts` — `executeSQL()` runs raw `conn.runAndReadAll(sql)` |

### HIGH — Fix Before Going Live

| Threat | What Can Happen |
|--------|----------------|
| **GET/DELETE `/mcp` skip auth** | Only POST checks bearer token. Attacker with a session ID can eavesdrop (GET) or kill sessions (DELETE) |
| **No CORS policy** | Any website can make requests to your server from a browser |
| **DNS rebinding** | Malicious website rebinds to `localhost` and calls MCP tools — works even locally |
| **Write tools with no guardrails** | LLM can `create-voucher` / `create-ledger` in production Tally with no approval step. Prompt injection or hallucination = bogus vouchers |
| **`/token` ignores `client_secret`** | Client secret is extracted but never verified — any client_id works |
| **Tally XML unencrypted** | If not using VPN/tunnel, financial data + company credentials travel as plaintext |
| **Multi-tenant: no isolation** | `targetCompany` is just a string — Client A can query Client B's company by name |

### MEDIUM / LOW

| Threat | Severity |
|--------|----------|
| Binds to `0.0.0.0` (all interfaces) | MEDIUM |
| No rate limiting on auth endpoints | MEDIUM |
| Refresh token = access token (same value) | MEDIUM |
| Client secrets stored as plain-text JSON on disk | MEDIUM |
| Tally credentials in `.env` on cloud VPS | MEDIUM |
| Tally machine offline = MCP server useless | MEDIUM |
| Loose `==` password comparison | LOW |
| Auth failure returns HTTP 200 instead of 401 | LOW |

---

## Jailbreak & Prompt Injection Risks

These threats come **through the AI itself**, not from network attackers.

| Attack Vector | How It Works | Impact |
|--------------|-------------|--------|
| **DuckDB file escape** | Malicious prompt tricks LLM into running `SELECT read_text('C:\Users\...\passwords.txt')` or `COPY ... TO '/path/file'` via `query-database` tool | Read/write arbitrary files on MCP server |
| **Prompt injection in Tally data** | Attacker puts malicious instructions inside a Tally narration field, party name, or ledger name. When LLM reads this data, it follows the injected instructions | LLM executes attacker's commands — could exfiltrate data, create fake vouchers, or run destructive SQL |
| **Write tool abuse** | Injected prompt tells LLM to call `create-voucher` with fabricated amounts or `create-ledger` with fake accounts | Fraudulent entries in production Tally, impacting financials and GST compliance |
| **Data exfiltration** | Injected prompt tells LLM to read financial data and include it in a response, or write it to an attacker-controlled location via DuckDB `COPY TO` | Company financial data leaked |

**Key point:** Even with perfect network security and auth, prompt injection works because the LLM is the authorized user. The LLM has a valid token and can call any tool — the attack exploits the AI's trust, not the server's auth.

---

## What's Already Secure

| ✅ | Detail |
|----|--------|
| HTTPS | Custom domain with TLS — tokens and data encrypted in transit |
| OAuth 2.0 + PKCE | Authorization code flow with S256 challenge — prevents code interception |
| Bearer token auth on POST `/mcp` | MCP tool calls require valid access token |
| XML injection prevention | `utility.String.escapeHTML()` used for Tally XML inputs |
| Input validation | Regex patterns validate tool inputs before sending to Tally |
| Token expiry | Access tokens expire in 1 hour, auth codes in 10 minutes |
| Auto-cleanup | DuckDB tables auto-drop after 15 minutes |

---

## Fix Priority

### P0 — Must-Fix (blocks production)

| # | Fix | Effort |
|---|-----|--------|
| 1 | Restrict `query-database` to `SELECT` only — block `DROP`, `CREATE`, `COPY`, `ATTACH`, file-access functions | ~30 lines |
| 2 | Remove default password — require `PASSWORD` env var or fail on startup | 3 lines |
| 3 | Add auth to `/register` — require admin secret | ~10 lines |
| 4 | Use VPN or reverse SSH tunnel for Tally connectivity | Infra |

### P1 — Required for production

| # | Fix | Effort |
|---|-----|--------|
| 5 | Add bearer token check to GET/DELETE `/mcp` | ~15 lines |
| 6 | Add CORS middleware with allowed origins | ~5 lines |
| 7 | Verify `client_secret` in `/token` endpoint | ~5 lines |
| 8 | Enable DNS rebinding protection (uncomment 1 line in `server.mts`) | 1 line |
| 9 | Add audit logging for all tool calls | ~20 lines |
| 10 | Add confirmation workflow for write tools — or disable them | Design decision |

### P2 — Hardening

| # | Fix | Effort |
|---|-----|--------|
| 11 | Rate limiting on auth endpoints | ~10 lines |
| 12 | Tenant isolation for multi-client use | ~30 lines |
| 13 | Separate refresh tokens | ~15 lines |
| 14 | Bind to `127.0.0.1` + reverse proxy | 1 line + infra |
| 15 | `helmet` middleware for security headers | 2 lines |

---

## Production Readiness Checklist

| Requirement | Status |
|------------|--------|
| HTTPS on MCP server | ✅ Done |
| Encrypted tunnel to Tally (VPN/SSH) | ⬜ Infra |
| SQL restricted to read-only | ✅ Done — `validateSQL()` + `enable_external_access=false` |
| Real password set (not default) | ✅ Done — startup fails if `PASSWORD` missing |
| `/register` requires auth | ✅ Done — `ADMIN_SECRET` bearer token required |
| Write tools have approval workflow | ✅ Done — `destructiveHint` + `READONLY_MODE` env var |
| Audit logging | ✅ Done — all write tools + `query-database` |
| Auth on GET/DELETE `/mcp` | ✅ Done — bearer token validated |
| CORS configured | ✅ Done — `CORS_ORIGINS` env var |
| DNS rebinding protection | ✅ Done — enabled in transport |
| Client secret verification | ✅ Done — `/token` verifies `client_secret` |
| Separate refresh tokens | ✅ Done |
| Rate limiting | ✅ Done — 10 req/min on auth endpoints |
| Bind to 127.0.0.1 | ✅ Done — `BIND_HOST` env var, defaults to `127.0.0.1` |
| Helmet security headers | ✅ Done |
| Timing-safe comparison | ✅ Done — `crypto.timingSafeEqual` |
| Tenant isolation | ⬜ Future — requires design |

---

*Report generated from code audit of `src/server.mts`, `src/mcp.mts`, `src/tally.mts`, `src/database.mts`, `src/index.mts`, `src/utility.mts`, and `authorize.html`.*
