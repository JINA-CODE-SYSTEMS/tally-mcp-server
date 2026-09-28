# ADR 0001 — Remote transport for device-paired access

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-09-27 |
| **Decides** | the transport under #178, the first box of #192, and whether #193 item 1 survives |
| **Related** | #192 (re-enable remote), #178 (device-paired remote access), #193 (deferred remote items), #179 (roadmap), #175 (signing), #177 (signed auto-update), #37 (closed: central broker) |

This is the first decision record in the repository. Records live in `docs/adr/`, numbered, and
are never rewritten once accepted — a later decision supersedes an earlier one by number.

**Scope limit.** Per #178, provisioning API contracts, credential formats, key encodings and
operational hostnames do not belong in this public repository. This record stays at the level of
architecture and properties. Where a design detail is needed to judge a property (for example,
"pairing uses a PAKE"), the property is stated and the mechanism is left to internal design.

---

## 1. Context

Remote access is parked (#192). The installer offers local mode only; existing remote installs are
preserved untouched (`GetWizardMode()` returns `''` on purpose so `firstrun-config.ps1` keeps each
install's own mode). The mode machinery is already in place and is orthogonal:

| `.env` key | Values today | Meaning |
|---|---|---|
| `DEPLOYMENT_MODE` | `local` \| `remote` | Is there a service and a listening port? (#172) |
| `REMOTE_AUTH` | `oauth-password` \| `paired` | How do remote callers authenticate? (#178) |
| `REMOTE_TRANSPORT` | `tunnel` \| `lan` | How do they reach us? (#178) |

Every remote install in the field is `remote + oauth-password + tunnel` (or a bring-your-own
reverse proxy): an Express server (`src/server.mts`) exposing `/mcp`, `/register`, `/authorize`,
`/token` and the `.well-known` OAuth metadata, gated by one shared `PASSWORD`, reached through a
`cloudflared` service (`TallyMCPTunnel`) whose token is supplied via NSSM's `AppEnvironmentExtra`
(#193 item 1). Local mode is different in kind: the MCP client spawns `dist/index.mjs` over stdio,
in the user's session, with no listener, no OAuth and no `PASSWORD`.

### What is wrong with the current remote design

1. **The trust claim is false as designed.** "We are never in the data path" (#178, #37's closing
   comment) does not survive a literal reading. The tunnel is in Jina's Cloudflare account, so the
   account holder can attach a Worker to the route, enable Logpush, or add itself to an Access
   policy — invisibly to the customer's machine. Cloudflare terminates TLS, so plaintext books exist
   at the edge on every request.
2. **There is no zone.** `docs/cloudflare-tunnel-provisioning.md` lists a Cloudflare zone for
   `jinacode.systems` as an existing prerequisite. It does not exist: the domain is on GoDaddy
   nameservers with live Google Workspace MX, so delegating it risks company email, and no
   separate domain has been registered.
3. **Provisioning is a human per client** (dashboard, copy a token, paste a hostname).
4. **One shared password gates read and write**, with no per-device identity, attribution or
   revocation, and the OAuth endpoints answer the public internet.

### What must be true before remote is un-hidden (#192)

- a transport whose broker cannot read the traffic, or payload encryption above one that can
- provisioning that needs no human per client
- per-device identity and individual revocation
- a security claim that survives a customer reading it literally

### The observation that reframes the problem

A public HTTPS hostname — and therefore a domain, DNS, certificates and a TLS-terminating edge — is
needed for exactly one class of client: MCP clients that run in someone else's cloud (the claude.ai
browser connector, and any client that only speaks remote HTTP MCP). If remote access is delivered
through **our own stdio bridge** on the remote machine, as #178 already plans, the client end is our
code, and the requirement for a public hostname per customer disappears. The question then becomes
only: *how do two pieces of our own software, on two machines, reach each other so that nobody in
between can read or join the conversation?*

---

## 2. Criteria

Stated as they will be judged, including where every option is weak.

| # | Criterion | What "pass" means |
|---|---|---|
| C1 | **Can the broker, or Jina, read traffic?** | Literal truth: no party other than the two endpoints holds a key that decrypts payloads, *and* no such party can silently enrol a device that would then receive plaintext. Passive and active both count. |
| C2 | **Provisioning, no human per client** | A new customer goes live with no action by Jina staff. |
| C3 | **Per-device identity and individual revocation** | Each device has its own credential; one can be revoked without touching the others; revocation is authoritative. |
| C4 | **Pairing-code UX** (#178) | Tally machine: tick a box, read an 8-character code. Remote machine: install, type the code, restart the client. Nothing about domains, DNS, ports, routers, certificates, firewalls or IPs. |
| C5 | **Domain / DNS / certs / public listener** | What infrastructure must exist, per customer and in total. |
| C6 | **Tally machine loopback-only, outbound-only** | No inbound port on the Tally machine from any network. |
| C7 | **Locked-down corporate remote machines** | Works without admin rights, drivers or unusual egress. |
| C8 | **Browser-based clients** | Can the claude.ai web connector (or any cloud-hosted MCP client) use it at all? |
| C9 | **Dependence on #175 / #177** | What cannot ship before signing and signed auto-update. |
| C10 | **Cost and third-party dependency** | Money, operations, and whose terms of service we live under. |
| C11 | **Migration** | Existing OAuth / shared-password installs keep working; deprecation is deliberate, never a forced conversion on upgrade. |
| C12 | **Effect on #193 item 1** | Does a bearer tunnel token still need protecting in the registry? |

**An irreducible caveat that applies to every option, including local mode.** Jina ships the code
that runs at both ends. A malicious or compromised build can exfiltrate anything, whatever the
transport. No transport design removes vendor trust; what it can do is make the vendor's
*infrastructure* irrelevant to confidentiality, so that the only remaining trust is in the
*software*, which is public (AGPL), signed (#175) and delivered through a verifiable channel
(#177). Likewise, the MCP client's model provider (Anthropic, for Claude) necessarily sees what the
model is shown; that is a property of using an LLM at all, not of the transport, and must be said
separately in customer-facing text.

---

## 3. Options

### (a) Cloudflare Tunnel as currently designed — baseline

`cloudflared` on the Tally machine dials Cloudflare; a public hostname in Jina's account routes to
`localhost:3000`; OAuth + shared password at the Node process. #178's refinement adds Cloudflare
Access with per-device service tokens presented by our bridge, so unauthenticated requests stop at
the edge.

- **C1 — fails.** Cloudflare terminates TLS and sees plaintext. As account holder Jina can route,
  log, or add itself to the Access policy with nothing on the customer's machine able to observe it.
  Access improves *who else* can reach the endpoint; it does nothing for the edge or the account
  holder.
- **C2** — automatable via Cloudflare's API, but only once a zone exists, and the provisioning
  service then holds an API credential able to reconfigure every customer's tunnel — a
  high-value target and a standing instance of the C1 problem.
- **C3** — possible with Access service tokens per device; revocation is at Cloudflare, operated by
  whoever holds the account (Jina), not by the customer.
- **C4** — achievable, via a provisioning service redeeming the code.
- **C5** — needs a Cloudflare zone (blocked today: GoDaddy + live MX) and a public hostname per
  customer.
- **C6** — passes: outbound-only, `BIND_HOST=127.0.0.1`.
- **C7** — best of all options for the *generic* connector (nothing installed on the remote
  machine); with #178's bridge it needs an install like every other option.
- **C8** — the only option that supports browser clients, because it is the only one with a
  public HTTPS endpoint.
- **C9** — the browser path needs no connector, so it does not depend on #175; the bridge path does.
- **C10** — tunnels themselves are free; the dependency is total (Cloudflare's edge and terms).
- **C11** — it *is* the legacy path.
- **C12** — the bearer token stays; #193 item 1 must be fixed.

Variant considered: the tunnel in the **customer's** own Cloudflare account. Removes Jina from the
account (C1 partly) but Cloudflare still terminates TLS, and it requires every accountant to own a
domain and a Cloudflare account — C4 fails outright. Useful only as a documented expert path, which
the existing bring-your-own `MCP_DOMAIN` + reverse-proxy path already is.

Same class, same verdict: ngrok, Microsoft Dev Tunnels, and other hosted reverse tunnels that
terminate TLS at the provider.

### (b) Mesh VPN — Tailscale (hosted) and headscale (self-hosted)

Both machines join a WireGuard mesh. Traffic is encrypted end-to-end between nodes; DERP relays,
when used, forward ciphertext. Our bridge (or the existing stdio server behind a small listener on
the tailnet address) carries MCP over the mesh.

- **C1 — passive: passes. Active: fails unless the control plane is neutralised.** Nobody on the
  path can decrypt WireGuard. But the coordination server distributes node public keys and ACLs,
  so whoever controls it can add a node and grant it access — the exact "add ourselves to the
  Access policy" problem, one layer down.
  - *Hosted Tailscale, one Jina tailnet for all customers:* Jina's admin can enrol a node anywhere
    and edit ACLs; tenant isolation is by ACL only. Tailscale's **Tailnet Lock** mitigates this by
    requiring node keys to be signed by trusted keys held on devices, but it is per-tailnet, so in
    a shared tailnet the signing authority is still not per-customer.
  - *Hosted Tailscale, one tailnet per customer:* fixes isolation, but each tailnet is a sign-up
    against an identity provider — not something we can create by API for an accountant.
  - *headscale:* Jina runs the control plane, so Jina is the party that can enrol nodes. As far as
    we know headscale does not implement Tailnet Lock (verify at decision time).
- **C2** — hosted: pre-auth keys can be minted by API, in a Jina-owned tailnet (C1 problem).
  headscale: fully automatable, by Jina.
- **C3** — per-node identity, individually removable — by the control-plane admin, i.e. Jina, not
  the customer. Revocation on the Tally machine itself is not authoritative.
- **C4** — achievable via a provisioning service that exchanges the pairing code for a pre-auth
  key, *if* the remote machine can run a Tailscale client (see C7).
- **C5** — no per-customer domain, certificates or public listener. headscale needs one public
  HTTPS endpoint for the control server (and DERP, unless Tailscale's public DERP is used, which is
  a terms question).
- **C6** — passes for the internet: the Tally machine only dials out. It does listen on its tailnet
  interface, reachable only by tailnet peers the ACL admits — which brings C1's control-plane issue
  back in.
- **C7 — poor.** The standard Windows client installs a virtual network adapter and a system
  service; it needs admin, is routinely blocked by corporate policy, and can conflict with a
  corporate VPN. An embedded userspace node (Tailscale's `tsnet`) avoids the driver and admin, but
  is a Go library — a second runtime and binary for us to ship, sign and update.
- **C8** — no. Cloud-hosted clients are not tailnet members. Tailscale **Funnel** can publish a
  node publicly and, per Tailscale's documentation, terminates TLS on the node rather than at the
  relay — the one "public HTTPS without a TLS-terminating broker" option in this review — but it
  re-exposes the endpoint (and its OAuth surface) to the internet, and the hostname lives in the
  tailnet owner's account. Recorded, not recommended.
- **C9** — needs a signed installer and connector (#175); our own components need #177; the
  Tailscale client updates itself on its own schedule.
- **C10** — hosted: per-user business pricing and terms that must permit embedding in a commercial
  product for third parties (to be confirmed with Tailscale; not assumed here). headscale: a server,
  its uptime, and its security — Jina becomes an operator of the network that reaches every
  customer's books.
- **C11** — coexists with the legacy path.
- **C12** — no tunnel token; the node key lives in Tailscale's own state, outside our control.

**A cheap, legitimate by-product.** Customers who *already* run their own tailnet (or any VPN
giving IP reachability) can use option (c) over it with zero work from us. That is "bring your
own mesh", and it is worth documenting — as a customer's choice, not our transport.

### (c) LAN-only transport via our own stdio bridge — no third party

For the same-office case. The remote machine runs our connector, which the MCP client spawns over
stdio exactly as it spawns the local server today. The connector reaches a **host agent** on the
Tally machine over the office LAN, over a mutually authenticated encrypted channel, and the host
agent spawns the existing stdio server (`dist/index.mjs`) for the session and pumps bytes. The MCP
server itself does not change: no HTTP, no OAuth, no `PASSWORD`.

- **C1 — passes, literally.** There is no broker. The only machines holding keys are the Tally
  machine and the paired device.
- **C2** — nothing to provision; keys are generated on each machine.
- **C3** — each device has its own key pair, generated on the device; the Tally machine keeps the
  list of paired device public keys. Revocation is removing a key locally and dropping live
  sessions: authoritative, immediate, and independent of any server.
- **C4** — passes. The pairing code is redeemed over the LAN with a **PAKE** (password-authenticated
  key exchange), so an observer on the LAN cannot brute-force the code offline and cannot
  man-in-the-middle the pairing; after pairing, the code is worthless. Discovery is by local
  service advertisement, so the user never types an address.
- **C5** — none. No domain, DNS, certificates or public listener.
- **C6 — partial, stated honestly.** Someone must listen. In this design the Tally host agent
  listens on the LAN interface (not the internet), with a Windows Firewall rule scoped to the local
  subnet, off by default, switched on by the tray's remote toggle. The channel handshake rejects any
  peer whose key is not paired before any MCP byte is processed. This is a narrower surface than
  today's legacy path (a password prompt on the public internet), but it is not "no listener".
- **C7** — the connector can be a per-user install (no admin, no driver). It only helps if the
  remote machine is on the same LAN, which a locked-down *corporate* machine usually is not.
  Application allowlisting (AppLocker/WDAC) will block it unless signed (#175).
- **C8** — no. Cloud-hosted clients cannot run a local bridge.
- **C9** — host agent and connector must be signed before non-technical users see them (#175).
  #177 is strongly advised but LAN exposure is lower-stakes than internet exposure.
- **C10** — zero running cost; zero third parties.
- **C11** — coexists with the legacy path on the same machine; migration can be device by device.
- **C12** — no tunnel token. The host's private key replaces it and must be stored DPAPI-protected
  with a locked ACL (the existing vault pattern), never in a service's registry environment.

### (d) Our own stdio bridge + payload E2E encryption over an untrusted relay

The same bridge, host agent, channel and pairing as (c), with one change: instead of a LAN socket,
**both ends dial out** to a relay, which pairs the two connections by an opaque rendezvous
identifier and forwards bytes. The relay is untrusted *by design*: the channel is end-to-end
encrypted and mutually authenticated between the host agent and the device, so the relay handles
only ciphertext. The relay can be a small Jina-operated forwarder, a serverless WebSocket service,
or — for a customer who insists — their own tunnel or relay. Transport security to the relay (TLS)
is kept, but confidentiality does not depend on it.

- **C1 — passes for content, with named residuals.**
  - The relay cannot read payloads: it holds no key.
  - The relay cannot enrol a device: devices are authorised by the Tally machine, which accepts
    only device keys it paired itself; pairing uses a PAKE so the relay, which forwards the pairing
    exchange, learns nothing that lets it impersonate either side or guess the code offline.
  - The relay cannot alter or replay traffic undetected.
  - **Residual, stated in customer text:** the relay sees metadata — IP addresses, timing, volume,
    and which rendezvous identifiers connect. It can deny service. And the vendor-software caveat
    in §2 applies, as it does everywhere.
  - This is the claim that survives a literal reading: *"Jina runs the relay that connects your
    devices, but holds no key that can read your books, and cannot add a device to your machine.
    Only devices you paired on the Tally machine can connect, and you can remove any of them
    there."*
- **C2** — passes. Nothing is provisioned per customer. The relay admits connections on a valid
  licence (to keep it from being an open relay) and forwards; it never mints a credential. This
  also shrinks what must stay internal: there is no provisioning API that issues credentials, only
  an admission check and the relay's hostname.
- **C3** — as (c): per-device keys, authoritative local revocation on the Tally machine, with no
  server-side state to keep in sync.
- **C4** — passes. The 8-character code carries a short rendezvous part (so the relay can put the
  two parties together) and a secret part used only as the PAKE password. Codes are single-use,
  short-lived, rate-limited per rendezvous, and cancellable from the tray mid-flight.
- **C5** — no per-customer domain, DNS, certificate or public listener. **One** public endpoint for
  the relay, total. It does not need a Cloudflare zone and does not require delegating
  `jinacode.systems`: a single record in the existing DNS, a separate domain, or a platform-provided
  hostname all work. (Which one is an owner decision, and the answer goes in internal docs.)
- **C6 — passes fully.** The Tally machine binds nothing beyond loopback (in fact binds nothing:
  the host agent talks to the MCP server over a child process's stdio) and only dials out.
- **C7 — best of the bridge options.** Per-user install, no admin, no driver; outbound HTTPS/WSS on
  443 through the system proxy. A TLS-inspecting corporate proxy sees only the inner ciphertext.
  Still fails where application allowlisting blocks unsigned code (#175), where the proxy blocks
  WebSockets or unknown hosts (a long-poll fallback helps the first, an IT allowlist the second),
  or where policy forbids installing anything at all.
- **C8** — no. Same reason as (c).
- **C9** — must be signed (#175). And because this is internet-facing, security-critical crypto,
  it must be patchable in the field before general availability (#177).
- **C10** — one small, stateless service. Traffic is JSON text (screenshots from `gui-screenshot`
  are the largest payloads), so bandwidth is modest. The operational burden is availability and
  abuse control, not confidentiality. No third party in the trust path; a hosting provider in the
  availability path.
- **C11** — coexists with legacy; same migration as (c).
- **C12** — moot. There is no tunnel token.

Design risk to name now: a **vetted PAKE implementation** in our runtime. The channel itself can
use a well-established pattern (Noise-style mutual authentication over static keys) from a mature
library; PAKE libraries are scarcer and less audited. Library choice and an external review of the
channel design belong in phase 2 below, before any code that handles books is written against it.

### (e) Other options judged serious

**e1. Keep remote out of the product; use remote desktop into the Tally machine.** Accountants in
this market already run AnyDesk/RDP to reach Tally. With local mode, Claude Desktop runs *on* the
Tally machine and the user drives it remotely. Zero work, zero new exposure beyond what the
customer already accepted, and a real answer for locked-down machines that can run a remote-desktop
client but not our connector. It does not meet "Claude on my laptop", but it should be written down
as the supported interim answer, not left implicit.

**e2. Direct peer-to-peer (NAT traversal) under the E2E channel.** Hole-punching between host agent
and device, with the relay from (d) as fallback. Same trust properties as (d), less relay load and
latency, significantly more complexity. A later optimisation of (d), not a separate decision.

**e3. Central broker (#37).** Rejected there and still rejected: all books transit Jina
permanently. Listed only so nobody re-proposes it without reading why.

**e4. Browser-client tier on the legacy path, restricted.** Not a transport, but the only way C8
is ever met: keep the OAuth + tunnel endpoint for cloud-hosted clients, with the weaker claim
stated plainly and, optionally, read-only enforced (`READONLY_MODE=true`). See owner decisions.

---

## 4. Summary

| | (a) CF tunnel | (b) Tailscale hosted | (b) headscale | (c) LAN bridge | (d) Bridge + E2E relay |
|---|---|---|---|---|---|
| C1 broker can read? | **Yes** (TLS at edge; account holder) | Passive no; control plane can enrol nodes | Passive no; Jina can enrol nodes | **No broker** | **No** (metadata only) |
| C2 no human per client | After zone + API | API keys in Jina tailnet | Yes | Nothing to provision | Nothing to provision |
| C3 per-device, local revocation | At edge, by Jina | At control plane | At control plane | **On Tally machine** | **On Tally machine** |
| C4 8-char pairing UX | Via provisioning svc | If client installable | If client installable | Yes (PAKE, LAN) | Yes (PAKE via relay) |
| C5 domain/DNS/certs | Zone + hostname per client | None per client | One control endpoint | None | One relay endpoint total |
| C6 Tally outbound-only | Yes | Yes (tailnet listener) | Yes (tailnet listener) | **No** — LAN listener, subnet-scoped | **Yes**, binds nothing |
| C7 locked-down remote | Generic connector: yes | Poor (driver, admin) | Poor | Rarely same LAN | Best of bridges; needs signing |
| C8 browser clients | **Only option** | No (Funnel aside) | No | No | No |
| C9 needs #175 / #177 | Bridge: #175 | #175 | #175 | #175 (#177 advised) | #175 **and** #177 |
| C10 cost / dependency | Free; total CF dependency | Per-user; ToS | Jina ops | None | Small service; Jina ops |
| C12 #193 item 1 | Must fix | Moot | Moot | Moot | Moot |

---

## 5. Decision (proposed)

**Adopt one bridge and one channel, with two transports under it, delivered LAN first.**

1. **Build the stdio bridge (#178's connector) and a host agent on the Tally machine, speaking one
   end-to-end encrypted, mutually authenticated channel with PAKE-based pairing and per-device
   keys.** The host agent spawns the unchanged stdio MCP server per session, passing the device's
   identity (for audit attribution) and its permissions (for example, read-only per device via the
   existing `READONLY_MODE`). Revocation lives on the Tally machine.
2. **Ship it first over the LAN — option (c), `REMOTE_AUTH=paired`, `REMOTE_TRANSPORT=lan`** (both
   values already exist in `firstrun-config.ps1`). No third party at all; the claim is trivially
   true.
3. **Then over an untrusted relay — option (d), adding `REMOTE_TRANSPORT=relay`** — for internet
   access. Same channel, same pairing, same revocation; the relay is a replaceable forwarder of
   ciphertext.
4. **Do not build `paired + tunnel`.** #178's original shape (device credential presented to a
   Cloudflare Access edge in Jina's account) leaves C1 failing; this record supersedes that
   combination. `REMOTE_TRANSPORT=tunnel` remains valid only for `oauth-password` installs.
5. **Do not adopt a mesh VPN as our transport.** It moves the trust problem from the data plane to
   the control plane rather than removing it, and it performs worst on locked-down machines. Do
   document "bring your own mesh" (option c over a customer's existing tailnet or VPN) as
   supported.
6. **Keep the legacy OAuth path working, frozen, and deprecated for new installs** — see §7.
7. **Write down e1** (remote desktop into a local-mode Tally machine) as the supported interim
   answer until the LAN release ships.

What #192's checklist becomes under this decision:

- *broker cannot read traffic* — met by (c) (no broker) and (d) (E2E above an untrusted relay)
- *no human per client* — met: nothing per client is provisioned
- *per-device identity and revocation* — met, and revocation is local and authoritative
- *a claim that survives a literal reading* — met, **provided** customer text names the relay's
  metadata visibility, the vendor-software caveat, and that the model provider sees what the model
  is shown

---

## 6. Decisions that need the owner

1. **Accept the architecture** — bridge + E2E channel, LAN then relay — versus a mesh VPN.
2. **Browser-based clients (claude.ai web, and any cloud-hosted MCP client).** No option except the
   legacy tunnel can serve them. Choose one:
   - keep them on the legacy path for *existing* installs only, and never offer it to new installs
     (**recommended**); or
   - offer a clearly labelled "browser tier" to new installs with the weaker claim stated, ideally
     read-only by default (e4), which also means resolving the missing zone; or
   - drop them for books-grade data, with a sunset date for existing installs.
3. **Locked-down corporate machines.** Choose between: unsupported (say so up front); an IT
   allowlisting guide (signed publisher, relay host, outbound 443); remote desktop into the Tally
   machine (e1); or the browser tier if (2) keeps one.
4. **Coordination / relay hosting.** Jina-operated relay versus a serverless platform versus
   letting a customer point at their own relay; and the relay's hostname — a record in the existing
   DNS, a new domain, or a platform hostname. None requires moving `jinacode.systems` or touching
   MX. (If the owner prefers a mesh VPN after all: hosted Tailscale vs headscale is the equivalent
   question, and Tailscale's commercial terms must be confirmed first.)
5. **Cost and operations.** Budget for the relay (small), its monitoring and abuse handling, and an
   availability expectation — remote access being down must never affect local use, but customers
   will notice.
6. **External review.** Whether to fund an independent review of the channel and pairing design
   before the internet release. Recommended.
7. **Release gates.** Whether the LAN release waits only on #175, or on #175 and #177. (This record
   requires both for the relay release.)
8. **Legacy deprecation.** Timeline and communication for existing `oauth-password` installs, and
   whether #193 item 1 gets a small legacy-only fix (recommended if legacy will live longer than a
   few months — see §7).

---

## 7. Migration and the legacy path

- **Nothing is converted on upgrade.** `GetWizardMode()` keeps returning `''` for existing installs;
  an install carrying `REMOTE_AUTH=oauth-password` stays that way until its owner acts.
- **Coexistence.** The paired host agent is a separate component from the HTTP server. A legacy
  install can pair devices while its tunnel still runs, move users one device at a time, and then
  use a tray action — *turn off password access* — that stops and removes `TallyMCPTunnel`, the HTTP
  service, `PASSWORD`, `TUNNEL_TOKEN` and the persisted `.oauth-*.json` stores, and re-runs
  `verify-deployment.ps1` to prove it.
- **New installs** are offered `paired` only (whichever transports have shipped). The legacy remote
  page is not re-enabled for new installs unless decision 2 creates a browser tier.
- **#193 item 1 (token in the registry).** Moot for every new configuration — there is no tunnel
  token. For legacy installs it remains a live bearer credential readable by local users. If legacy
  is expected to outlive a short deprecation window, move the token to an ACL-locked file (or DPAPI
  with a start-up wrapper) rather than the service environment; confirm the bundled `cloudflared`
  version's support for reading its token from a file before choosing.
- **#193 item 3 (unreachable remote wizard values).** Answered by the tray: paired mode is managed
  there, and legacy values are only ever *removed* (by the switch-off action), not edited.
- **Docs.** `docs/cloudflare-tunnel-provisioning.md` describes a zone that does not exist and a
  claim this record retracts; it should be relabelled as the legacy path's reference.

---

## 8. Implementation breakdown

Phases are ordered by dependency. **Unblocked** means work can start now; the gates say what can
*ship* to non-technical users and when.

| Phase | Work | Status |
|---|---|---|
| **P0** | Owner review of this record (§6). Relabel the tunnel doc as legacy and correct its zone prerequisite. Write down e1 as the interim answer. Update #178's scope to match §5 (drop "tunnel + DNS + edge identity" from provisioning). | **Unblocked** |
| **P1** | Channel and pairing threat model: parties, keys, what the relay sees, pairing-code lifetime and rate limits, revocation semantics, key storage at rest (DPAPI + ACL). Choose the channel library and the PAKE library. Public part in-repo at the level of this record; formats and operational detail internal. | **Unblocked** |
| **P2** | Host agent on the Tally machine: key generation and DPAPI storage; paired-device list; accepts channel sessions; spawns `dist/index.mjs` per session with per-device identity (audit tagging on the `[audit]` stderr stream) and per-device permissions (`READONLY_MODE`); session limits. Transport-agnostic behind an interface. | **Unblocked** |
| **P3** | Connector on the remote machine: per-user install, stdio ↔ channel pump, device key generation and storage, code entry, writes the client entry through the existing `src/client-config.mts` engine (already designed for this). | **Unblocked** (build); ships under G1 |
| **P4** | LAN transport: host listener on the LAN interface only, subnet-scoped firewall rule, off by default; local service discovery; PAKE pairing over LAN. `REMOTE_TRANSPORT=lan`. | **Unblocked** |
| **P5** | Tray and installer: remote toggle, pairing-code display with cancel, paired-device list with individual revoke, visible *turn remote access off*. Re-enable the wizard's remote page per #192's restore steps, offering `paired` only. | **Unblocked** (build); ships under G1 |
| **P6** | `verify-deployment.ps1` for paired mode: no public listener, LAN listener only when `lan` is on and firewall scoped, no `PASSWORD`/`TUNNEL_TOKEN`/OAuth stores, keys ACL-locked. Fold in #193 item 2 (`UNKNOWN` status) here. | **Unblocked** |
| **G1** | **LAN release to non-technical users.** Signed host installer and signed connector. | **Gated on #175**; #177 per owner decision 7 |
| **P7** | Relay: stateless forwarder pairing connections by rendezvous id; licence-based admission; rate limits and abuse monitoring; proxy-friendly (WSS with long-poll fallback). `REMOTE_TRANSPORT=relay` in `firstrun-config.ps1` and `verify-deployment.ps1`. Hostname and admission details in internal docs only. | Build **unblocked**; deploy needs owner decisions 4–5 |
| **P8** | External review of P1's design and P2–P7's implementation of it. | Unblocked once P7 exists; needs owner decision 6 |
| **G2** | **Internet (relay) release.** | **Gated on #175 and #177**, and P8 |
| **P9** | Legacy migration: *turn off password access* tray action; deprecation notice for existing `oauth-password` installs; legacy-only fix for #193 item 1 if decision 8 says so. | Unblocked (build); timeline per owner decision 8 |
| **Later** | Direct peer-to-peer path under the same channel (e2). Browser tier only if decision 2 creates one. | Deferred |

When G1 ships, #192's first three checkboxes are met for the LAN case; when G2 ships, for the
internet case. #192 should close at G1 or G2 by the owner's choice, and #193 item 1 closes as
"moot for new configurations" at G1 plus whatever decision 8 says for legacy.

---

## 9. Consequences

**Positive.** The security claim becomes literally true for new remote installs. Nothing per
customer is provisioned, so onboarding scales and there is no provisioning API able to reconfigure
every customer. Revocation is in the customer's hands on the machine that holds the books. The MCP
server is unchanged — the same stdio server serves local and remote — and the HTTP/OAuth surface
stops growing. No Cloudflare zone, no domain delegation, no per-customer DNS.

**Negative.** Browser-based clients are not served by the new path; that is a product decision, not
a technical gap we will close. We own a piece of cryptographic protocol composition, which needs
review and must be patchable (#177). We operate one relay service. Three remote configurations
(legacy tunnel, LAN, relay) coexist during migration — a maintenance cost, not a swap. LAN mode is
not strictly outbound-only on the Tally machine.

**Neutral.** Vendor trust in the shipped software is unchanged by any transport; signing (#175) and
a signed update channel (#177) are where that trust is earned.
