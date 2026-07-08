# Cloudflare Tunnel provisioning (per client)

## Why

Most tax accountants run Tally on an office PC with **no public domain, no static
IP, and no reverse proxy** — so the browser-based **claude.ai custom connector**
(which needs an HTTPS URL) is out of reach, and they're stuck on Claude Desktop's
local `stdio` config.

**Cloudflare Tunnel** fixes this for free: a bundled `cloudflared` service makes an
**outbound-only** connection to Cloudflare's edge and gets a stable public HTTPS URL
(e.g. `https://client123.tally.jinacode.systems`) that forwards to the MCP server on
`localhost:3000` — **zero router/port-forward/firewall config** on the client's box.
Because the connection is outbound, the MCP server binds **loopback-only**
(`BIND_HOST=127.0.0.1`), which is strictly safer than the bring-your-own reverse-proxy
path (which must bind `0.0.0.0`).

## Provisioning model (v1: white-glove)

A `cloudflared` service needs a **named-tunnel token** to run non-interactively — the
free "quick tunnel" mode generates a random URL that changes on every restart, which
would silently break the client's registered connector. Named tunnels require a
one-time setup per client under Jina's Cloudflare account.

There is no self-serve provisioning API yet, so **v1 is manual**: Jina staff
pre-provision the tunnel (a ~2-minute Cloudflare dashboard step) during onboarding and
hand the **token + hostname** to whoever runs the installer — the same white-glove
pattern already used for the OAuth `PASSWORD`. A hosted provisioning API is a natural
v2 if this needs to scale.

## Prerequisites (one-time, Jina side)

- A Cloudflare account with **`jinacode.systems`** added as a zone (Cloudflare
  nameservers active). A dedicated subdomain like `tally.jinacode.systems` keeps client
  hostnames tidy.
- Access to **Zero Trust → Networks → Tunnels** in the Cloudflare dashboard.

## Per-client steps (Cloudflare Zero Trust dashboard)

1. **Create the tunnel.** Zero Trust → **Networks → Tunnels → Create a tunnel** →
   type **Cloudflared** → name it with the client id (e.g. `client123`) → **Save**.
2. **Copy the token.** The next screen shows an install command containing
   `--token eyJ...`. Copy **just the token** (the `eyJ...` string). This is what goes
   into the installer's "Cloudflare Tunnel token" field. (The installer bundles
   `cloudflared` itself, so ignore the rest of the shown command.)
3. **Add the public hostname.** Open the tunnel → **Public Hostname → Add a public
   hostname**:
   - **Subdomain:** `client123`  •  **Domain:** `tally.jinacode.systems`  •  **Path:** *(blank)*
   - **Service:** Type **HTTP**, URL **`localhost:3000`**
   - **Save.** This creates the DNS record **and** the ingress rule (hostname → the
     local MCP server) in one step.
4. **Hand off to the installer operator:**
   - **Token** → paste into the wizard's **"Cloudflare Tunnel token"** field.
   - **Hostname** `https://client123.tally.jinacode.systems` → paste into the wizard's
     **"Public domain / Cloudflare Tunnel hostname"** field.

> **CLI equivalent** (if you prefer the terminal, after a one-time `cloudflared tunnel
> login`): `cloudflared tunnel create client123` then `cloudflared tunnel route dns
> client123 client123.tally.jinacode.systems`, and read the token with `cloudflared
> tunnel token client123`. Note that for a **token-run** tunnel the hostname→service
> ingress still lives in the dashboard (step 3), so the dashboard flow above is the
> simplest end to end.

## What the installer does with it

When the "Cloudflare Tunnel token" field is non-empty, `firstrun-config.ps1`:

- writes `TUNNEL_TOKEN` and `MCP_DOMAIN=<hostname>` to `.env`, and forces
  `BIND_HOST=127.0.0.1` (loopback-only — cloudflared reaches the server locally);
- registers a second NSSM service **`TallyMCPTunnel`** running the bundled
  `cloudflared tunnel run`, with the token supplied via the service **environment**
  (`TUNNEL_TOKEN`) so it never appears on the process command line;
- starts it (auto-start, auto-restart on exit), logging to `logs\tunnel.log`.

The token is **preserved across "Reconfigure"** (read back from `.env`), and **blanking
it on a Reconfigure tears the tunnel service down** and reverts `BIND_HOST`.

## Verify (on the client box / from outside)

1. Services `TallyMCP` and `TallyMCPTunnel` are both **Running** (tray dashboard, or
   `Get-Service TallyMCP,TallyMCPTunnel`).
2. `logs\tunnel.log` shows `Registered tunnel connection` (4 edge connections).
3. From an external network:
   `https://client123.tally.jinacode.systems/.well-known/oauth-protected-resource`
   returns the OAuth metadata JSON.
4. Add it as a **claude.ai custom connector**: URL
   `https://client123.tally.jinacode.systems/mcp`, complete the OAuth prompt with the
   `PASSWORD`, and confirm a tool call (e.g. `status`) works end to end.
5. Run **Reconfigure** with the token blanked → `TallyMCPTunnel` stops and is removed,
   `BIND_HOST` reverts. Uninstall → both services removed, no orphaned `cloudflared.exe`.

## Security & hardening

The tunnel exposes a server that can **read *and write* live books**, so treat the following as
part of every deployment — not optional.

### The OAuth password is the primary gate — get it right

Every MCP call requires an authenticated OAuth 2.1 + PKCE session using the `PASSWORD` set in the
wizard; unauthenticated requests to `/mcp` get nothing, and auth attempts are rate-limited
server-side. That password is effectively the single key to the books:

- **Use a strong, unique 16+ character random password.** Never reuse it.
- **Rotate it** if it was ever shared over an insecure channel, or on staff changes — Start Menu →
  **Reconfigure** → re-enter → it rewrites `.env` and restarts the service.
- The installer already **ACL-locks `.env`** (SYSTEM + Administrators + the agent user) so the
  password isn't readable by other local users. Don't loosen that.

### What the tunnel already gives you

- **No inbound ports, no LAN exposure** — the server binds `127.0.0.1` only and `cloudflared`
  connects *outbound*. The only path in is Cloudflare's tunnel + the OAuth gate.
- **TLS + DDoS protection** at Cloudflare's edge, free.

### Edge hardening that is compatible with the MCP connector

Add these on the tunnel's zone in the Cloudflare dashboard — they raise the bar without breaking the
connector:

- **Rate-limiting rule** on `/oauth/token` and `/mcp` (e.g. N req/min/IP) — a second brake on
  credential-guessing on top of the app's own limiter.
- **Geo restriction** — a WAF rule allowing only the country/countries the client operates from;
  most attack traffic is foreign and this cuts it cheaply.
- **Bot Fight Mode / Managed WAF** — Cloudflare's baseline bot + exploit filtering.
- **IP allowlist** — *only if* the Claude client runs from a fixed IP (e.g. Claude Desktop on the
  office PC, or a known office/home line): a WAF rule allowing just that IP makes the endpoint
  invisible to everyone else. This does **not** work for the claude.ai **browser** connector, whose
  calls originate from Anthropic's cloud (no stable client IP to allowlist).

### Cloudflare Access (Zero Trust) — powerful but caveated

Access can gate the hostname behind an identity check (email OTP / SSO) *before* any request reaches
the server. It works cleanly for **browser-only** apps, but a remote MCP connector makes
**server-to-server** calls (claude.ai's backend exchanges the OAuth token and calls `/mcp` directly),
which cannot complete an interactive Access login. Using Access here needs Access **service tokens**
(`CF-Access-Client-Id` / `-Secret` headers) **and** a client that can send custom headers — which the
claude.ai / Claude Desktop connectors generally do not expose. So treat Access as
**advanced/conditional**, not a drop-in; for most deployments the strong password + the WAF rules
above are the practical layers.

### Read-only clients

For a client who only needs **reporting** (no voucher/ledger writes), set `READONLY_MODE=true` in
`.env` (Reconfigure preserves it). Every write tool is then refused server-side (`READONLY`),
removing the write-attack surface entirely — a strong risk reducer when writes aren't needed.

### Operational

- Traffic transits **Cloudflare** (TLS terminated at their edge) and the client is **Anthropic**
  (claude.ai / Desktop) — the same trust model as any SaaS; name it to the client.
- Review the server **audit log** periodically (every tool call is logged).
- Keep `cloudflared` + the server updated by re-running the installer (refreshes the bundled binaries).

## Out of scope (v2 candidates)

- Self-serve/automated provisioning (a hosted API that calls Cloudflare's API at install
  time) — noted if manual per-client provisioning stops scaling.
- Tray-icon surfacing of tunnel connectivity status — a follow-up, not required here.
