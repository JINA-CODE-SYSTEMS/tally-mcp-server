# Remote channel and pairing: threat model, protocol and library choice

> **Status: Accepted, 2026-09-29, by the owner (Tapan Jain, @jain-t), without independent review
> (ADR 0001 D7).** Proposed 2026-09-28. The owner's answers to the three open questions are recorded
> in [§11](#11-owner-decisions): CPace built from audited primitives (D-P1), symmetric per-device
> keys (D-P2), and the pairing-code parameters as proposed (D-P3). Nothing here is implemented yet.
>
> This is phase **P1** of [ADR 0001](../adr/0001-remote-transport.md) (#219, part of #178). It
> picks the channel and pairing protocols and the libraries that implement them, under the ADR's
> **D7** rule: no home-made cryptography, only well-known audited libraries and standard protocols,
> used as documented. It also writes the review checklist that the internal review (P8, #226) works
> through before the relay release.
>
> **The PAKE part does not fully meet D7 as written, and this document says so.** No audited CPace
> or SPAKE2 implementation exists for Node, in JS or WASM ([§5.3](#53-pake)). D7 says that finding
> goes back to the owner, not around them. It did. **The owner chose CPace built strictly from
> audited primitives, pinned by the draft's published test vectors, and accepted that the glue is
> unaudited** ([§11](#11-owner-decisions), D-P1). The one audited PAKE that does exist (OPAQUE) was
> the alternative and was not taken.
>
> **Scope limit (#178).** This public document gives properties, protocol names, libraries and
> parameters where a reviewer needs them to judge a property. It does **not** give wire formats,
> labels, the pairing code's layout, relay admission, credential encodings or hostnames. Those go
> in internal docs. The throwaway spike under
> [`scripts/dev/spike-channel/`](../../scripts/dev/spike-channel/README.md) uses placeholder labels
> that nobody should implement against.
>
> Companion reading: [ADR 0001](../adr/0001-remote-transport.md) (the decision this implements) and
> [update-channel-threat-model.md](update-channel-threat-model.md) (the house style for threat
> models, and the "never interrupt a Tally write" rule that revocation below has to respect).

---

## 1. Summary

| | Choice | Why, in one line |
|---|---|---|
| **Channel** | **TLS 1.3 from Node's own `node:tls`** (the OpenSSL bundled in Node 22), external-PSK mode with `psk_dhe_ke`, one 256-bit key per paired device, TLS 1.3 only, SHA-256 suites only | The most scrutinised protocol implementation there is. It is already inside the runtime we ship and adds no dependency. Every Noise implementation for Node is unaudited ([§5.1](#51-channel)) |
| **Pairing (PAKE)** | **CPace, suite `CPACE-P256_XMD:SHA-256_SSWU_NU_-SHA256`** per draft-irtf-cfrg-cpace-21, initiator-responder mode, built on the public API of **`@noble/curves`** (audited), with hashing and HKDF from `node:crypto` | The CFRG's chosen balanced PAKE, and the case we have: both ends know a one-time code. The draft's test vectors pin every intermediate value. **No audited implementation exists; the owner accepted this (D-P1)** |
| **Binding PAKE to channel** | CPace output → HKDF-SHA256 → TLS 1.3 external PSK for a pairing handshake. The TLS `Finished` messages are the key confirmation. The device key comes from the TLS exporter of that handshake | This is the integration the CPace draft itself names (§10.4–10.5: "explicit authentication … as e.g. done in the Finished messages in TLS1.3"). We write no confirmation or KDF construction of our own |
| **Third-party code** | `@noble/curves` 2.4.0 and its one dependency `@noble/hashes` 2.4.0. MIT, pure JS, no install scripts, ~2.3 MB on disk, used **only while pairing** | Every session after pairing runs on `node:tls` alone |
| **Keys at rest** | Host: DPAPI machine scope, app entropy, ACL for SYSTEM and Administrators **by SID**, fail closed (#230). Connector: DPAPI CurrentUser, app entropy, in the user's profile | The existing vault pattern, with #230's lessons applied from the start |

The spike shows that all of this works on the pinned runtime: Node 22.23.2 (OpenSSL 3.5.7) on
Windows x64. It passes 49 checks, covering the published vectors and the negative tests in [§10](#10-internal-review-checklist-for-p8).

---

## 2. What is being protected, and from whom

### 2.1 Parties and keys

| Party | Runs as | Holds |
|---|---|---|
| **Host agent** (Tally machine, P2) | A Windows service or task (P2 decides), never exposed to the internet except through its outbound relay connection | The paired-device table (device id, label, permissions, **device key**). The active pairing code, in memory only |
| **Connector** (remote machine, P3) | The signed-in user, per-user install, no admin | Its own device record: device id, **device key**, how to reach the host |
| **Relay** (P7) | A serverless platform under Jina's account (D4), behind a CNAME (D5) | **No key at all.** It forwards bytes between two outbound connections that it pairs by rendezvous id |
| **Tray** (P5) | The signed-in user on the Tally machine | Nothing secret. It asks the host agent over a local, ACL'd channel to show a code, list devices or revoke one |

Keys, and where each one exists:

| Key | Lifetime | Exists on | Never exists on |
|---|---|---|---|
| Pairing code (8 characters) | ≤ 10 minutes, single use | Host memory; tray screen; the user's head; connector memory while pairing | Disk, logs, relay, any Jina system |
| CPace scalars, `K`, `ISK` | One pairing attempt | Host and connector memory, wiped best-effort after use (JS gives no guarantee, see R6) | Anywhere else |
| Pairing PSK (HKDF of ISK) | One pairing handshake | Host and connector memory | Anywhere else |
| **Device key** (256-bit, TLS exporter output) | Until the device is removed | Host device table (DPAPI machine scope); connector record (DPAPI CurrentUser) | The wire (it is derived by both ends and never sent), relay, logs |
| TLS session keys | One session | `node:tls` inside each process | Anywhere else |

### 2.2 Assets

In priority order:

1. **The books**, meaning what the MCP server can read from Tally and, for devices that are not
   read-only, **write** to it. A session is as good as a signed-in accountant.
2. **The right to add a device.** Whoever can enrol a device gets asset 1 indefinitely, until
   someone notices and revokes it.
3. **Device keys**, on both ends. A stolen device key is a session.
4. **The pairing code** during its ten-minute life.
5. **Integrity of in-flight Tally writes**. Revocation and disconnects must not kill a write
   halfway ([update-channel threat model §2](update-channel-threat-model.md#2-what-exists-today)).
6. **Availability** of remote access. Local use never depends on it (D6).
7. **Metadata**: who connects, when, from where, and how much.

---

## 3. Threat model

"Control" names the mechanism, which is specified in [§6](#6-protocol-design)–[§8](#8-key-lifecycle).
Residual is what stays true after the control.

| # | Adversary | Capability | Without controls they get… | Control | Residual |
|---|---|---|---|---|---|
| T1 | **LAN attacker** (same office Wi-Fi, a compromised printer, a guest laptop) | Sees and rewrites all LAN traffic. Can connect to the host's LAN listener. Can answer local discovery | A session; or the code via offline brute force; or a MITM during pairing | Unpaired peers fail inside the TLS handshake, before any MCP byte (spike: tested). Pairing uses CPace, so an observer learns nothing it can test offline, and an active attacker gets **one guess per attempt**. Three attempts per code, then it dies. Discovery results are not trusted: whoever answers must prove the key or the code | Can burn a pairing code, so the user has to issue another one. Can see that a device talks to the host, when, and how much. Can make discovery fail (DoS). **The LAN listener exists at all**: ADR §3(c) C6, stated honestly |
| T2 | **Malicious or compromised relay** | Everything T1 has on the internet path, plus: it pairs connections, so it can pick who talks to whom, replay, drop, delay, reorder and inject | Same as T1, at internet scale | Same as T1. The relay holds no key and cannot make one. Its forwarding is covered by TLS record integrity (spike: one flipped bit kills the session). Replaying a recorded pairing fails, because the host's fresh nonce and scalar change `sid` and ISK (spike: tested). The host alone counts attempts, so the relay cannot reset them | **What the relay still sees, stated for customer text**: both endpoints' IP addresses; the rendezvous id; connection times and durations; the size and timing of every record, which reveals roughly how much was asked and answered; whether a connection is a pairing or a session; and, in sessions, the device's **opaque PSK identity**, a stable random id sent in clear in the TLS ClientHello (spike: confirmed, [§5.1](#51-channel) R3). It can **deny service completely**. It can burn codes |
| T3 | **Malicious insider at Jina** controlling the relay or the DNS record | T2, plus: point the CNAME at a relay of their choosing, and act as "support" to a customer | T2's gains; enrolment by talking the customer into it | Everything in T2. **Jina has no channel to enrol a device except the code on the Tally machine's screen.** The tray says, next to the code, that nobody from Jina will ever ask for it. The host shows a notification and a new row in the device list whenever a device is added | Social engineering: a customer who reads the code to a caller hands over asset 2. Mitigated by the tray wording, the ten-minute life and the visible device list; not prevented. The vendor-software caveat in ADR §2 still applies: a malicious *build* beats every control here, which is what #175 and #177 exist for |
| T4 | **Shoulder-surfed or phished code** | Knows the code while it is live | Enrol their own device | Single use: the first successful pairing consumes it. Ten-minute expiry. Cancel from the tray at any time, mid-flight included. The device list shows the label, time and transport of every enrolment, and a notification fires on each | A thief who uses the code before the user does wins that race, and the user's own pairing then fails. That failure is a visible signal ("code already used"). The device list is how the user finds out and revokes |
| T5 | **Stolen or lost remote laptop** | The disk, and possibly the signed-in session | A session, as that device, until revoked | The device key is DPAPI CurrentUser-protected, so an offline disk without the user's Windows password does not yield it (with the caveats in R5). Revocation on the Tally machine is immediate and authoritative ([§8.4](#84-revocation)). Per-device read-only limits the damage from devices that never need write | Between loss and revocation, anyone signed in as that user has that device's access. BitLocker or equivalent is the customer's control, not ours. We recommend it in the IT guide (P10) |
| T6 | **Malware on the remote PC**, running as the user | Anything the user can do: read DPAPI CurrentUser secrets, drive the connector, read the MCP client's screen | That device's access, and exfiltration of the device key for use elsewhere | None that holds against same-user malware. This is true of every credential on a compromised machine. We contain it: device-scoped revocation, read-only per device, and audit lines per device | **Accepted and stated.** Removing the device on the Tally machine ends it, including a key copied elsewhere. Symmetric keys make this slightly worse: a stolen device key also lets the thief impersonate *the host* to that device ([§5.1](#51-channel) R2) |
| T7 | **Replay** (of pairing messages, handshake messages or records) | Record and resend any bytes | A second enrolment or a repeated command | Pairing: `sid` includes a fresh host nonce, the host's scalar is fresh, and the code is single use (spike: tested). Sessions: every TLS 1.3 handshake is fresh with (EC)DHE. Node does not implement TLS 0-RTT, so there is no early data to replay. Records carry implicit sequence numbers | None identified in the channel. Application-level idempotency of Tally writes is the existing `src/idempotency.mts`, unchanged |
| T8 | **Downgrade** (to an older protocol version, weaker suite, TLS 1.2, PSK without DHE, the legacy OAuth path, or a pairing-vs-session confusion) | Rewrite negotiation fields | A weaker or unauthenticated channel | TLS 1.3 only (min = max, spike: TLS 1.2 refused). Explicit SHA-256 AEAD suites. The client offers only `psk_dhe_ke` (spike: parsed from the ClientHello). TLS 1.3 authenticates its whole negotiation in `Finished`. Our protocol version and suite name go into CPace's CI and AD, so a mismatch changes ISK and fails. The version is also checked explicitly before any CPace share is sent (spike: tested). Pairing and sessions use different ALPN values and different PSKs. The transport (LAN or relay) is bound into CI (spike: tested). The connector has **no** fallback to the legacy HTTP endpoint | A future protocol version must keep "exact match or refuse", not "negotiate down". A checklist item |
| T9 | **Denial of service** | Flood the LAN listener or the relay; burn codes; hold handshakes open | Remote access unavailable | Handshake and frame timeouts; maximum frame size; cap on concurrent pairing attempts (one at a time) and on sessions per device and in total; exponential cool-down on the host after repeated code lockouts, surfaced in the tray; relay-side rate limits per rendezvous and source (P7, defence in depth only) | **Not preventable** by the relay design or on a hostile LAN. The relay can always refuse to forward. Local use is unaffected (D6) |
| T10 | **Malware or another user on the Tally machine** (non-admin) | Read user-readable files, talk to local IPC | The device table; codes; a way to enrol or revoke | Device table ACL'd to SYSTEM + Administrators by SID, and fail closed if that cannot be applied (#230). Codes are never written to disk. The tray↔host-agent channel is ACL'd so only the configured user and admins can ask for a code or revoke | A process running *as the configured tray user* can ask for a code the way the tray does. The same user can already drive Tally itself |
| T11 | **Local administrator on the Tally machine** | Anything | — | Out of scope, as in the update-channel model (A12). They already own the books | — |
| T12 | **Our own composition bug** | — | Any of the above | D7's rule; the published vectors pinned in CI; the negative tests; the P8 checklist ([§10](#10-internal-review-checklist-for-p8)); the LAN release before the relay release; #177 to patch in the field | **The main residual risk (R1).** D7 accepts it. The checklist makes it smaller; it does not remove it |
| T13 | **Side channels in JS crypto** | Precise timing of the host's pairing computations | Bits of the code-derived generator, narrowing offline guesses | P-256 was chosen over ristretto255 partly because noble blinds P-256 scalar multiplications ([§5.3](#53-pake)). Pairing is rare, the code dies in ten minutes, and the attacker gets one timing sample per attempt over a network path | JS cannot promise constant time, and noble says so. Accepted and stated (R6) |

---

## 4. Requirements the design must meet

Drawn from ADR 0001 (§3 (c)–(d), §5, D1, D7), #178 and #219–#226:

1. **E2E and mutual authentication.** No party but the host and a paired device holds a key that
   opens session traffic, and neither end accepts a peer that cannot prove the per-device key.
2. **An unpaired peer is rejected in the handshake, before any MCP byte is processed** (#220, #222).
3. **Pairing with a short-lived, single-use 8-character code through a PAKE**, so a LAN or relay
   attacker can neither brute-force the code offline nor MITM the pairing.
4. **Per-device keys, revoked on the Tally machine**, immediately for new sessions, and with
   defined behaviour for live ones.
5. **D7: no home-made cryptography.** No new primitives, handshakes or KDF constructions, and no
   home-grown framing of key material.
6. **Runtime**: the bundled Node 22 on Windows x64. The connector runs per-user without admin.
   Everything ships in the Inno Setup installer.
7. **Supply chain**: every build input pinned and hash-verified (#216 did this for the installer's
   binaries), `npm ci --ignore-scripts`, so a dependency that needs a postinstall or a native build
   is a real cost.
8. **License**: compatible with AGPL-3.0-or-later.

---

## 5. Options considered and the choice

### 5.1 Channel

| | **TLS 1.3, `node:tls`** (chosen) | **Noise** (XX or IK, e.g. `Noise_XXpsk0` for pairing) | **libsodium** `crypto_kx` + `secretstream` over a PAKE key |
|---|---|---|---|
| Standard | RFC 8446. External PSKs per RFC 8446 §2.2 and §4.2.11, with the guidance in RFC 9257 | Noise Protocol Framework rev. 34. Sound, simple, no negotiation | `kx` and `secretstream` are libsodium constructions, not a handshake protocol |
| Implementation for Node 22 | OpenSSL 3.5.7, inside the Node binary we already pin and hash-verify. It is the most audited and fuzzed TLS stack in existence | `noise-handshake` 4.2.0 (holepunchto, Apache-2.0, maintained): only NN, NNpsk0, XX, XXpsk0, IK and XK; BLAKE2b through `sodium-universal`, which on Node is **`sodium-native`**, a native addon whose `engines` now names only `bare`. `noise-protocol` 3.0.2 (ISC): "BETA", no PSK patterns, last commit 2023. `@chainsafe/libp2p-noise` 17.0.0: XX only, libp2p-specific payloads, past CVE-2022-24759. **None audited** | `libsodium-wrappers` 0.8.4 (ISC, WASM, no install scripts). The 2017 audit covered the C library at 1.0.12/1.0.13, not the JS/WASM build |
| D7 fit | **Passes.** We configure a standard protocol through a documented API. No handshake code of ours | **Fails as things stand.** Using an unaudited implementation is outside D7. Writing Noise ourselves from `node:crypto` primitives is the home-made handshake D7 forbids | **Fails.** `kx` alone gives neither forward secrecy nor authentication of ephemerals. Making it do so means composing our own handshake |
| Install cost | None | Native addon (`sodium-native`, 18 MB with prebuilds) or a pure-JS fallback | 1.8 MB WASM-in-JS |
| Negotiation surface | Version, suites and modes all pinned to one value each (T8) | None, which is Noise's advantage | None |

**Why TLS 1.3 in PSK mode, not with certificates.** Mutual TLS with self-signed certificates pinned
at pairing would give each device an *asymmetric* key. That matches the wording of ADR §3(c) C3 and
#220 ("device public keys"). But **Node has no API to create an X.509 certificate.** It needs
either a third-party generator (for example `@peculiar/x509` and its ~10 dependencies, none
audited) or DER written by hand. The first adds unaudited supply chain on the session path. The
second is the home-grown framing of key material D7 forbids. External-PSK mode needs neither.
What it costs, as stated to the owner, who accepted it ([§11](#11-owner-decisions), D-P2):

- **R2, symmetric device keys.** The host holds each device's key, not just a public half. The host
  table must therefore be kept secret as well as intact. It is: DPAPI machine scope plus an ACL,
  exactly like the host's own key would be. Also, a stolen device key lets the thief impersonate the
  host *to that device*. That matters only if the thief is also on the network path, and T6 already
  gives such a thief that device's access.
- **R3, identity in clear.** TLS 1.3 sends the PSK identity unencrypted in the ClientHello. So the
  relay and a LAN observer see an opaque, random, stable per-device id. Certificates would be
  encrypted in TLS 1.3. The id carries no name, but it links a device's sessions together. IP
  addresses already largely do that.
- **The device key is derived jointly, not generated on the device.** #221 asks that the device key
  be generated on the device and never leave it. In PSK mode it is never transmitted: both ends
  derive it from the pairing handshake's exporter. The host necessarily holds a copy. P2/P3
  acceptance wording was updated to match when D-P2 was decided.

Choosing PSK mode now does not close the door. Certificate-based sessions can be added later over
the same pairing (the pairing channel would carry the certificates instead of deriving a PSK)
without changing CPace or the code UX.

**Node's documented TLS-PSK constraints, and how the design meets each** (quoted from the Node 22
`tls` docs, "Pre-shared keys"):

- "PSK ciphers are disabled by default, and using TLS-PSK thus requires explicitly specifying a
  cipher suite". The design pins `TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256`.
- "a custom `checkServerIdentity` should be passed because the default one will fail in the absence
  of a certificate". With PSK the server is authenticated by the PSK, and the connector must never
  accept a certificate instead.
- "doesn't support asynchronous PSK callbacks". The host keeps the device table in memory and looks
  it up synchronously.
- "Deriving a shared secret from a password or other low-entropy sources is not secure". That is
  exactly why the code goes through CPace first. Every PSK is 256 bits of CPace or exporter output.

**Spike findings that change the implementation** (both are in the checklist):

- `TLSSocket.isSessionReused()` returns **true for every external-PSK handshake**, so it cannot
  detect ticket resumption. The host must treat a connection as authenticated only if its
  `pskCallback` ran for this handshake and returned the key of a currently paired device. The
  spike's host sets the device identity *only* inside that callback.
- The server **does issue TLS 1.3 session tickets** in PSK mode, and Node exposes no switch to stop
  it. The spike confirms that a revoked device presenting a saved ticket is refused. The connector
  never offers a ticket anyway. P2 must keep the "identity only from the callback" rule, and must
  not share one `SecureContext` across revocations without testing resumption again.

### 5.2 Why not Noise, given the ADR names it

The ADR gives Noise "via a maintained implementation" as the example of what D7 allows. Noise is a
good protocol, and for a greenfield native codebase it would be the first choice. On *our* runtime,
the maintained implementation (`noise-handshake`) is unaudited, depends on a native addon we would
have to ship and pin per architecture, and uses a BLAKE2b suite of its own choosing. The audited
thing already in our runtime is OpenSSL's TLS 1.3. **Revisit** if an audited, maintained pure-JS or
WASM Noise implementation appears. The pairing design would carry over unchanged: CPace output as
the Noise PSK, `XXpsk0`.

### 5.3 PAKE

No audited CPace or SPAKE2 implementation exists for Node. We found none in Rust or Go either.
Each candidate's own README says it is unaudited, or it is years out of date:

| Candidate | What it is | Status |
|---|---|---|
| `cpace-ts` 0.1.4 | CPace draft-18 on @noble/curves | Unaudited ("audit-friendly") |
| `@cipherman/pake-js` 0.1.1 | CPace draft-20 ristretto255 and SPAKE2+ on @noble/curves | README: do not deploy without your own independent audit |
| `@niomon/spake2`, `spake2`, `spake2-wasm`, `spake2-ee` | SPAKE2 drafts, 2019–2022 | Unaudited, stale drafts |
| RustCrypto `spake2` | SPAKE2, draft-10 | "never received an independent third party audit" |
| `pake-cpace`, `pakery-cpace` (Rust); `filippo.io/cpace` (Go) | CPace, old drafts or experimental | Unaudited |
| **`@serenity-kit/opaque` 1.1.0** (WASM of Rust `opaque-ke` 4.0.0) | **OPAQUE, RFC 9807** | **Audited: 7ASecurity, Oct–Nov 2023** ([report](https://7asecurity.com/reports/pentest-report-opaque.pdf); version not stated in the report). The Rust core was audited by NCC Group in 2021 at 0.5.0 (OPAQUE draft-03), not the current line |

That left two honest paths. The owner chose Option A ([§11](#11-owner-decisions), D-P1).

**Option A (recommended, and chosen): CPace from audited primitives.** Suite
`CPACE-P256_XMD:SHA-256_SSWU_NU_-SHA256`, from
[draft-irtf-cfrg-cpace-21](https://www.ietf.org/archive/id/draft-irtf-cfrg-cpace-21.txt)
(23 April 2026; IESG review completed, in the RFC Editor queue, not yet an RFC). Every group
operation is one documented public call into `@noble/curves`:

- generator: `p256_hasher.encodeToCurve` (RFC 9380 `P256_XMD:SHA-256_SSWU_NU_`)
- scalar: `p256.utils.randomSecretKey` (uniform in [1, n−1], draft §10.7)
- share and DH: `p256.getSharedSecret`, which rejects invalid and neutral points
- hashing and HKDF: `node:crypto` (OpenSSL)

What we write is the draft's own string handling (`prepend_len`, `lv_cat`, `generator_string`,
`transcript_ir`) and the order of calls. That is about 60 lines in the spike. The draft's Appendix
B.5 pins every intermediate value: the generator string, generator, both shares, `K` and ISK. The
B.5.11 vectors pin the abort on invalid points. The spike reproduces all of them.

This is *not* "an audited PAKE implementation". It is a standard PAKE, composed from audited
primitives, with a test vector for every intermediate value. D7's residual risk (composition) is
exactly what it carries. Why this suite in particular:

- **P-256, not ristretto255.** The noble README states a known limitation. Multiplying a non-base
  Edwards or ristretto255 point by a secret scalar is *not* blinded. CPace does exactly that: it
  multiplies a code-derived generator. P-256 multiplications are blinded. The draft also lists the
  P-256 suite as RECOMMENDED, and the ristretto255 suite only as usable. Noble's ristretto255 code is
  also not named in the Cure53 report.
- **Not X25519.** That suite needs the Elligator2 map on its own. Noble exposes it only as
  `_map_to_curve_elligator2_curve25519`, marked private and "may be renamed". That is not a
  documented API.
- **Not SPAKE2 (RFC 9382).** It is published as an RFC, but it needs the M and N constants, point
  addition and our own password-to-scalar step. Its RFC vectors cover only P-256/HKDF/HMAC, and the
  CFRG chose CPace for the balanced case. CPace has fewer moving parts and more vectors.
- **Balanced, not augmented.** Both ends know the code in clear. That is CPace's case, and the draft
  itself sends stored-password client/server setups to OPAQUE instead (§4).

**Option B: OPAQUE through `@serenity-kit/opaque`.** It is the only audited PAKE callable from Node,
and it needs no PAKE glue of ours. Against it:

- It is an *augmented* PAKE designed for a server that stores a password file. Using it for a
  one-time code means the host runs registration against itself and then serves one login. The
  protocol run is exactly as specified, but it is off-label.
- The audit's version is unstated, and the current core (RFC 9807 line) has no audit.
- It adds an 890 KB WASM blob built with a Rust toolchain we cannot reproduce or pin from our side.
- It still needs the same TLS binding as Option A.

Option A was recommended because the protocol fits the use, and every value it computes is checked
against a published vector. Option B would have been the choice only if D7 were read as requiring
an audited *implementation* over a fitting *protocol*. The owner did not read it that way (D-P1).

**Rejected outright: Noise or TLS with the code as the PSK.** A low-entropy PSK lets anyone who
completes one handshake test guesses offline. The Node docs say so, RFC 9257 says so, and it is
precisely what the owner's decision rules out.

### 5.4 Libraries

| Library | Version (pin) | Role | Audit | Maintenance | License | Form | Install scripts | Size | Node 22 / Windows |
|---|---|---|---|---|---|---|---|---|---|
| **Node `node:tls`, `node:crypto`** (OpenSSL) | Node 22.23.2 (OpenSSL 3.5.7), pinned by hash in `build-installer.ps1` (#216) | Channel; SHA-256, HKDF, AEAD, CSPRNG | OpenSSL: continuous external audits and OSS-Fuzz; the most reviewed TLS stack | Node LTS security releases; OpenSSL 3.5 LTS | MIT (Node), Apache-2.0 (OpenSSL) | Built into the runtime | — | 0 added | It is the runtime |
| **`@noble/curves`** | 2.4.0 exact | CPace group operations (P-256, RFC 9380) | Trail of Bits, Feb 2023, v0.7.3: [report](https://github.com/trailofbits/publications/blob/master/reviews/2023-01-ryanshea-noblecurveslibrary-securityreview.pdf), covering Weierstrass and hash-to-curve. Kudelski, Sep 2023, v1.2.0: [report](https://github.com/paulmillr/noble-curves/blob/main/audit/2023-09-kudelski-audit-starknet.pdf), covering Weierstrass. Cure53, Sep 2024, README says v1.6.0 (the PDF says sources 1.5.0): [report](https://cure53.de/audit-report_noble-crypto-libs.pdf), covering hash-to-curve and others. Trail of Bits, Aug 2026, v2.3.0, "everything", under "Patch the Planet": fixes listed on the [dashboard](https://trailofbits.com/patch-the-planet/dashboard), **no report PDF found (unverified)**. 2.4.0 is one minor release past the last audit | Active (last commit 2026-09); signed commits; npm provenance ("verified attestations" in `npm audit signatures`) | MIT | Pure JS (ESM) | None | 1.59 MB unpacked | Pure JS; runs in the spike on Node 22.23.2 win-x64 |
| **`@noble/hashes`** | 2.4.0 exact (dependency of curves) | SHA-256 and HMAC inside noble's hash-to-curve | Cure53, Jan 2022, v1.0.0: [report](https://cure53.de/pentest-report_hashing-libs.pdf) | Active | MIT | Pure JS | None | 0.69 MB | As above |

`@noble/ciphers` (Cure53 2024) is **not** needed: TLS does the AEAD. `libsodium-wrappers`,
`sodium-native` and the Noise packages are not used ([§5.1](#51-channel)). All versions, dates,
licenses, scripts and sizes above come from the npm registry (`npm view`) and the projects' READMEs
as of 2026-09-28. Audit claims link to the reports. Anything not confirmed from a primary source is
marked.

**Pinning.** When P2/P3 add `@noble/curves` to the main `package.json`, they add it with an exact
version (no `^`). `package-lock.json` carries its sha512 integrity, which `npm ci` enforces, and the
build keeps `--ignore-scripts`. A bump is a reviewed PR that:

- shows `npm diff` between the versions
- runs `npm audit signatures`
- re-runs the CPace vectors

It is **not** added to the main `package.json` in this PR. Nothing in the product uses it yet, and
it should arrive with the code that needs it.

---

## 6. Protocol design

The detail below is at the level a reviewer needs. Exact encodings, labels and the code layout are
internal.

### 6.1 Roles

The host is always **CPace initiator A** and **TLS server**. The connector is always **CPace
responder B** and **TLS client**. Roles never swap. That closes CPace's reflection and role-confusion
cases (draft §10.1.2) and TLS 1.3's "Selfie" reflection on shared PSKs.

### 6.2 Pairing

1. **Connector → host:** protocol version and a fresh 16-byte nonce. The host refuses any version
   that is not an exact match before it computes anything (T8).
2. **Host → connector:** a fresh 16-byte host nonce, CPace share `Ya`, and `ADa`. `sid` is the two
   nonces concatenated, as the draft recommends (§10.9). The host counts this as an attempt against
   the code **before** sending `Ya`.
3. **Connector → host:** CPace share `Yb` and `ADb`. Both sides compute ISK. Either side aborts on
   an invalid or neutral peer element (draft §7.2).
4. **Pairing PSK** = HKDF-SHA256(ISK, salt = `sid`, info = a fixed label), 32 bytes. HKDF is the
   KDF the draft recommends for ISK (§4, §10.3).
5. **TLS 1.3 handshake** with that PSK, under the pairing ALPN. A wrong code gives a different ISK,
   so the PSK binder fails and the host logs a failed attempt. `Finished` in both directions is the
   explicit key confirmation, and it covers the full TLS transcript (draft §10.4–10.5).
6. **Inside that TLS session**:
   - the host assigns a random device id and sends it with its own display label
   - both ends derive the **device key** = TLS exporter (RFC 8446 §7.5) with a fixed label and the
     device id as context
   - the connector stores its record, then acknowledges with its label
   - the host commits the device, marks the code used, and confirms

   Nothing key-shaped crosses the wire at any step.

**CPace inputs:**

- **PRS** is the normalised code.
- **CI** carries both role names, the protocol version and the transport (`lan` or `relay`), so a
  view that differs on any of them yields a different key. CI is the draft's preferred place for
  identities (§10.1.1).
- **ADa and ADb** carry the protocol version, the suite and the role, which is the draft's
  suggestion for downgrade protection (§4.1).

**Relay rendezvous** is a separate, public part of the code that the relay uses to put the two
connections together. It is also inside PRS, but security rests only on the secret part
([§7](#7-pairing-code)).

**What is authenticated, and when**

| Data | Protected by | Confirmed at |
|---|---|---|
| Version, nonces, `Ya`, `Yb`, AD | Folded into ISK through `sid`, CI, AD and the CPace transcript | TLS `Finished` in step 5 (a mismatch anywhere breaks the PSK) |
| Knowledge of the code (both ends) | CPace | Step 5 |
| Device id, labels, the device key | TLS 1.3 record protection, under the confirmed PSK | Step 6 acknowledgements |
| The host's decision to enrol | Committed only after the connector has confirmed it stored the key | Step 6 |

### 6.3 Sessions

- **TLS 1.3 external PSK**, `psk_dhe_ke` only (fresh ECDHE, so forward secrecy per session), the
  session ALPN, and the PSK identity = the device id.
- The host's `pskCallback` returns the key **only** for a device that is in the table *now*.
  Otherwise the handshake fails with `unknown_psk_identity`, before any application byte.
- The host starts the MCP server for the session only after the TLS `secure` event, and only if:
  - the callback ran for this handshake
  - the ALPN matches
  - the device is still present
- The host then spawns `dist/index.mjs` with the device id (for `[audit]` tagging) and the device's
  permissions (`READONLY_MODE`), and pipes the TLS stream to its stdio.
- MCP bytes are the TLS payload as-is. No framing of ours inside the channel.
- The connector sends no session ticket and no early data. It accepts no certificate. It never
  falls back to any other endpoint.

---

## 7. Pairing code

| Property | Value | Why |
|---|---|---|
| Length | 8 characters, shown as two groups of four | #178 / ADR C4 |
| Alphabet | Crockford base32: `0-9` and `A-Z` without `I L O U`. Input is case-insensitive; `O` reads as `0`, `I` and `L` as `1`; hyphens and spaces are ignored | No ambiguous characters to misread, and the common misreadings are corrected rather than rejected. A published standard, not a design of ours |
| Entropy | 5 bits per character, 40 bits per code, from `crypto.randomInt` (CSPRNG). **At least 30 bits are secret.** The rest is the public rendezvous part on the relay | 30 secret bits with 3 attempts gives an attacker at most 3 × 2⁻³⁰ ≈ 2.8 × 10⁻⁹ per code |
| Lifetime | 10 minutes from display | Long enough to walk to the other machine; short enough that a photographed code goes stale |
| Use | Single use: consumed by the first successful pairing | T4 |
| Attempts | 3 per code, counted by the host when it commits its CPace share; then the code is dead | Online guessing is the only attack CPace leaves open |
| Concurrency | One live code per host; one pairing attempt in progress at a time | Parallel attempts cannot outrun the counter |
| Lockout | After 3 dead codes within an hour, the host refuses new codes for an hour and the tray says someone may be guessing | Makes repeated guessing visible; bounds a loop that burns codes |
| Cancel | The tray cancels the live code at any moment, mid-flight included; an attempt in progress then fails | #178 "revocable mid-flight" |
| Storage | Memory only on the host. Shown by the tray, never logged, never written to disk | T10 |
| Errors shown to the connector | "Wrong or expired code" as one message; no hint about which part was wrong | Nothing to probe |

---

## 8. Key lifecycle

### 8.1 Generation

- **Pairing:** CPace scalars come from `p256.utils.randomSecretKey`, backed by `crypto.getRandomValues`.
  Nonces and device ids come from `crypto.randomBytes`.
- **Device key:** the TLS exporter of the pairing session. It is 256 bits, derived independently by
  both ends, and never transmitted.
- No other long-term key exists in this design. In particular there is no host private key.

### 8.2 Storage at rest

**Host: the paired-device table**

- DPAPI **LocalMachine** scope with application-specific entropy, as in `scripts/dpapi-helper.ps1`,
  but with its own entropy string.
- The file lives beside the vault, ACL'd to SYSTEM and Administrators only. Grants use SIDs
  (`*S-1-5-18`, `*S-1-5-32-544`), not names, and the step **fails closed**. That is #230's fix,
  applied from day one, because the vault's name-based grants silently fail on non-English Windows.
- The ACL is the real boundary. DPAPI machine scope stops a copied file being read on another
  machine; it does not stop other processes on this one.
- Never in the registry, a service environment, a command line or a log (C12 in the ADR; #193 item 1).

**Host: management access**

- The tray reaches the table only through the host agent, over a local channel ACL'd to the
  configured user and Administrators.
- Revocation has to go through the host agent anyway, because it must cut live sessions.

**Connector: its own record**

- DPAPI **CurrentUser** scope with application-specific entropy.
- Stored in the user's local (non-roaming) app-data folder, which inherits the profile's
  user/SYSTEM/Administrators ACL.
- No admin rights are needed at any point.
- DPAPI CurrentUser protects against other users and against a disk read offline without the
  user's password. It does not protect against code running as the user (T6), nor against an
  offline attack on a weak Windows password (R5).

**Verification:** `verify-deployment.ps1` (P6) checks the host table's ACL by SID, and checks that
no secret appears in the registry or in `.env`.

### 8.3 Rotation

- **Version 1: rotation is re-pairing.** The user removes the device and pairs it again. That is
  standard, visible and already fully tested.
- An in-band rotation, deriving a fresh key from a new exporter label inside a live session, is a
  possible later addition. It would need its own review and is not in scope.
- There is no expiry on device keys by default. The tray shows each device's "last connected"
  time. P5 offers, but never forces, removal of devices unseen for 90 days (D-P3).
- DPAPI master keys rotate on Windows' own schedule, transparently.

### 8.4 Revocation

- **New sessions: immediate and authoritative.** Removing a device deletes it from the in-memory
  table first. The next handshake's `pskCallback` returns nothing, and the handshake fails before
  any MCP byte. The on-disk table is rewritten before the tray reports success. No server is
  involved (spike: tested).
- **Live sessions:**
  - The host stops reading from the device at once, so no new request is accepted.
  - A tool call already running is allowed to finish, up to a bound (P2 sets it; around 30 s).
    Killing the MCP server mid-write can post a voucher in Tally with no idempotency record
    ([update-channel threat model §2](update-channel-threat-model.md#2-what-exists-today)).
  - The result is **not** returned to the revoked device.
  - Then the TLS connection and the child process end. The spike shows the "cut" half; P2 owns the
    drain.
- **Resumption cannot bypass it.** A saved TLS ticket from before the revocation is refused
  (spike: tested). See the finding in [§5.1](#51-channel).
- **Turn remote access off** ends every live session the same way and stops the LAN listener or
  the relay connection. Devices stay paired until removed.
- **Cancel a pairing code:** [§7](#7-pairing-code).

### 8.5 What is logged

The host agent writes these audit events to its own log, and passes the device id into the MCP
server's `[audit]` stream for every tool call:

| Event | Fields |
|---|---|
| Code issued / cancelled / expired / locked | time, who (Windows user of the tray) |
| Pairing attempt failed | time, transport, reason class (version, abort, confirmation failure, timeout), attempt count. **Never the code or a guess** |
| Device paired | time, device id, device label, transport, who issued the code |
| Session start / end | time, device id, label, transport, peer address on LAN (the relay's address on the relay), duration, end reason |
| Session rejected | time, transport, reason class (unknown or revoked identity, ALPN, not authenticated, handshake error) |
| Device revoked / permissions changed | time, device id, who |
| Remote access turned on / off | time, who |

**Never logged**: codes, CPace values, ISK, PSKs, device keys, exporter output, or MCP payloads
(the MCP server's own `[audit]` rules are unchanged). The spike checks that its audit log carries
device ids but neither the code nor any key.

---

## 9. Residual risk

Stated so nobody mistakes this design for more than it is.

1. **R1: composition, reviewed internally only.** The pieces are audited. How we join them is not
   independently reviewed: CPace string handling and call order, the HKDF step, the TLS PSK
   binding, the exporter, and the host's authorisation rule. That is D7's accepted risk. The
   draft's vectors, the negative tests and the P8 checklist make it smaller; they do not make it
   go away.
2. **R2: symmetric device keys** ([§5.1](#51-channel)). The host table must stay secret, and a
   stolen device key can impersonate the host to that device. Accepted by the owner (D-P2).
3. **R3: relay-visible metadata.** IPs, timing, record sizes, rendezvous id, pairing versus session,
   and a stable opaque device id in each ClientHello. The relay can deny service. Customer text
   must say so, as the ADR requires.
4. **R4: no audited CPace implementation.** Option A is our own composition of audited primitives.
   Accepted by the owner (D-P1).
5. **R5: DPAPI CurrentUser on the remote laptop** is only as strong as the user's Windows password
   and disk encryption, and gives nothing against same-user malware.
6. **R6: JS is not constant-time.** Neither is it guaranteed that secrets are wiped from memory.
   Noble states both. It matters most while pairing, where the generator is derived from the code.
   It is bounded by pairing being rare and one-shot, and by P-256's blinded multiplications.
7. **R7: the CPace draft may still change** before it becomes an RFC. The suite and draft revision
   are pinned in the protocol version, so a later change is a new version with new vectors, never a
   silent drift.
8. **R8: the LAN listener exists.** It is subnet-scoped and off by default, but LAN mode is not
   "no listener" (ADR C6).
9. **R9: social engineering of the code** (T3, T4). Mitigated by wording and visibility, not
   prevented.
10. **R10: vendor software.** A malicious or compromised build of the connector or host agent
    defeats all of the above. That trust is earned by #175 and #177, not by this design.

---

## 10. Internal review checklist (for P8)

For #226. Each item is **answered in writing** in the P8 record, with evidence (a test name, a code
reference, or a transcript), not just ticked. "Spike" marks items the spike already demonstrates in
throwaway form. The product code must prove them again.

### A. Nothing home-made (D7)

- [ ] List every cryptographic operation in P2–P7 and the library call that performs it. Each one
      is `node:crypto` / `node:tls` or a documented public export of `@noble/curves`. No private or
      underscore-prefixed export is used, and no primitive, handshake or KDF construction is ours.
- [ ] The only cryptographic glue we wrote is the CPace string handling and call order. Each line
      cites the draft section it implements.
- [ ] No key material is serialised in a format of ours. Stored records hold raw 32-byte keys
      inside DPAPI blobs; nothing is derived from the container format.

### B. CPace

- [ ] The draft-21 Appendix B.5 vectors run in CI and pass: generator string, generator, `Ya`, `Yb`,
      `K` both ways, and ISK (initiator/responder). So do the A.1 and A.3 string vectors. *(spike)*
- [ ] The B.5.11 invalid-point and neutral-element vectors make `scalar_mult_vfy` return G.I, and a
      protocol run including them aborts. *(spike)*
- [ ] Negative tests: wrong code; right code but different CI (transport, version, roles); swapped
      roles; a truncated or oversized share; a share not on the curve; the point at infinity; a
      compressed encoding (must be refused).
- [ ] Scalars are fresh per attempt and never reused. `sid` includes a fresh nonce from each side.
- [ ] `K` is never returned, logged or stored (draft §10.3). ISK is used only as HKDF input.
- [ ] The code is normalised identically on both sides before becoming PRS. There is a test for
      each normalisation rule.
- [ ] The draft revision and suite are pinned in the protocol version string.

### C. Binding and key confirmation

- [ ] The pairing PSK is HKDF-SHA256 over ISK with `sid` as salt and a fixed, versioned label, and
      nothing else.
- [ ] No pairing data is trusted before TLS `Finished` has been verified in both directions.
- [ ] The device key comes only from `exportKeyingMaterial` on the confirmed pairing session, with a
      fixed label and the device id as context. Test: both ends derive the same value, and a
      different device id gives a different value.
- [ ] The host commits a device only after the connector confirms it stored the key. There is a
      test for a disconnect at each step (no half-enrolled device can connect).

### D. TLS configuration

- [ ] `minVersion` = `maxVersion` = TLS 1.3 on both ends. A TLS 1.2 attempt fails. *(spike)*
- [ ] The cipher suites are exactly the two SHA-256 AEAD suites. No certificate, key or `ca` option
      is set anywhere in the channel.
- [ ] The ClientHello offers `psk_dhe_ke` only. Checked by parsing a captured ClientHello in a test.
      *(spike)*
- [ ] The host's authorisation state is set **only** in `pskCallback`, from a live table lookup. A
      handshake where the callback did not run (resumption) is refused. `isSessionReused()` is not
      relied on. *(spike)*
- [ ] A revoked device presenting a saved ticket is refused, tested against the product's real
      `SecureContext` lifetime. *(spike, with a per-connection context)*
- [ ] ALPN is checked on both sides: pairing and session each refuse the other's ALPN.
- [ ] The connector's `checkServerIdentity` accepts only PSK-authenticated connections and can
      never accept a certificate-authenticated server.
- [ ] There is no early data and no fallback: to another TLS version, to the legacy HTTP endpoint,
      or to plaintext.
- [ ] PSK identities are random device ids, within OpenSSL's 128-byte limit, and carry no name or
      user data.

### E. Pairing code and rate limits

- [ ] The code is generated with `crypto.randomInt` over the Crockford alphabet. At least 30 bits
      are secret.
- [ ] Every rule in [§7](#7-pairing-code) is tested: TTL, single use, attempts counted before the
      share is sent, one attempt at a time, lockout, cancel mid-flight, and a generic error. Some are
      in the spike.
- [ ] The code never reaches disk, logs, crash dumps, telemetry or the relay's view. Grep the logs
      of a full test run.
- [ ] Relay-side rate limits exist (P7), and nothing on the host depends on them.

### F. Replay and downgrade

- [ ] Replaying a recorded pairing to a fresh code fails, including when the same code value is
      reissued. *(spike)*
- [ ] An old or unknown protocol version is refused before any CPace share is sent. *(spike)*
- [ ] A LAN/relay transport confusion fails. *(spike)*
- [ ] A reordered, duplicated or dropped TLS record kills the session. A single flipped ciphertext
      bit kills the session. *(spike, bit flip)*

### G. Frame parser and DoS

- [ ] The pre-TLS parser is strict: exact field count, per-field maximum, minimal length encoding,
      no trailing bytes, maximum frame size. *(spike)*
- [ ] The parser is fuzzed in CI, with a fixed iteration budget and a seed corpus of valid frames.
      Only the parser's own error type may escape. *(spike, 20,000 mutations)*
- [ ] Truncated frames, slow senders (byte-at-a-time) and a connection that never finishes a
      handshake all hit a timeout and free their resources.
- [ ] There are caps on concurrent handshakes, total sessions and sessions per device, each with a
      test.

### H. Constant-time and secret handling

- [ ] Our code compares no secret itself. Binder and `Finished` checks are inside OpenSSL. If any
      secret comparison is ever added, it uses `crypto.timingSafeEqual` on equal-length buffers.
- [ ] Our glue does not branch on secret values. PRS enters only `generator_string`.
- [ ] Secret buffers are zero-filled after use (best effort; see R6). No secret is kept in a
      long-lived string.
- [ ] The JS timing limitation (R6) is restated in the P8 record, with whatever measurement was
      done.

### I. Key storage (with #230)

- [ ] Host table: DPAPI LocalMachine plus app entropy; ACL by SID for SYSTEM and Administrators
      only; the install or enable step aborts if the ACL cannot be applied; `verify-deployment.ps1`
      checks it by SID.
- [ ] Connector record: DPAPI CurrentUser plus app entropy, in the local profile; no elevation at
      any point.
- [ ] No key or code appears in the registry, service environment, command lines or `.env`.

### J. Revocation

- [ ] Revoking a device refuses its next handshake, with a test. *(spike)*
- [ ] It stops reading from a live session at once, drains an in-flight tool call within the bound
      without returning its result, then closes, with a test that includes a write in flight.
      *(spike: the cut only)*
- [ ] "Turn remote access off" ends all sessions and removes the listener or relay connection.
- [ ] The persisted table is rewritten before the tray reports success. A crash in between leaves
      the device revoked.

### K. Relay metadata and trust

- [ ] A trace from P7 shows the relay forwarding only ciphertext and never holding or deriving a
      key. *(spike: no plaintext, code or key in forwarded bytes)*
- [ ] Customer-facing text lists exactly what [§3](#3-threat-model) T2 says the relay sees, and says
      it can deny service.

### L. Dependencies

- [ ] `@noble/curves` and `@noble/hashes` are pinned to exact versions, with lockfile integrity, and
      installed by `npm ci --ignore-scripts`.
- [ ] `npm audit signatures` passes (signatures and provenance attestations). *(spike)*
- [ ] Any bump is a PR showing `npm diff` and re-running the CPace vectors.
- [ ] Each audit report in [§5.4](#54-libraries) is re-checked for coverage of the version shipped.

### M. Audit logging

- [ ] Every event in [§8.5](#85-what-is-logged) is emitted, with the device id. A grep of the logs
      from a full test run finds no code, key or payload. *(spike: in part)*
- [ ] `[audit]` lines from the MCP server carry the device id of the session that caused them.

---

## 11. Owner decisions

Decided by the owner on 2026-09-29, without independent review (ADR 0001 D7). The questions were
put as Q1–Q3 in the proposal; each is recorded here as a decision, with its reasoning and what it
leaves behind.

**D-P1 (was Q1): the PAKE is CPace built from audited primitives: option A.** No audited CPace or
SPAKE2 implementation exists for Node ([§5.3](#53-pake)), so under D7 the choice came to the owner.
The decision is CPace, suite `CPACE-P256_XMD:SHA-256_SSWU_NU_-SHA256`:

- built only from `@noble/curves` public calls and `node:crypto`
- strictly per draft-irtf-cfrg-cpace, pinned to the draft revision in the protocol version
- verified against the draft's Appendix B.5 test vectors, including the B.5.11 invalid-point cases

*Why:* the protocol fits the use (a balanced PAKE for a code both ends know), every intermediate
value is pinned by a published vector, and the only third-party code is audited primitives.

*Residual, accepted:* the glue is unaudited. That means the string handling and call order in CPace,
and the HKDF and TLS binding. This is exactly the composition risk D7 names (R1, R4). The checklist
in [§10](#10-internal-review-checklist-for-p8) sections A–C is how P8 keeps it small.

*Not taken:* OPAQUE through `@serenity-kit/opaque`, which is audited but off-label for a one-time
code and brings a large WASM blob (option B). Also not taken: waiting for an audited CPace (option C).

**D-P2 (was Q2): symmetric per-device keys (TLS 1.3 external PSK), not certificates.**

- Each device has a 256-bit key derived by both ends from the TLS exporter of the pairing session,
  never transmitted.
- The host keeps the device-key table DPAPI-protected (machine scope) with a locked, by-SID ACL
  ([§8.2](#82-storage-at-rest)).
- Revocation removes the device's entry.

*Why:* it keeps the session path free of any third-party code. Certificates would need an unaudited
X.509 generator or hand-written DER.

*Residual, accepted:*

- R2: the host table must stay secret, and a stolen device key can impersonate the host to that
  device.
- R3: the relay and LAN observers see an opaque, stable device id in each ClientHello.

*Follow-up done:* the wording of #220 and #221 (and any other child issue that said "device public
keys" or "generated on the device") was updated to match. Certificate-based sessions remain possible
later over the same pairing ([§5.1](#51-channel)).

**D-P3 (was Q3): the pairing-code parameters in [§7](#7-pairing-code), as proposed.**

- A 10-minute code lifetime.
- 3 attempts per code.
- A 1-hour refusal of new codes after 3 dead codes within an hour.
- Devices unseen for 90 days are **offered** for removal in the tray, not removed automatically.

*Why:* this bounds online guessing at about 2.8 × 10⁻⁹ per code while leaving time to walk to the
other machine, and removal stays a human decision.

## 12. References

- ADR 0001, §3 (c)–(d), §5, §6 D7: [../adr/0001-remote-transport.md](../adr/0001-remote-transport.md)
- CPace: [draft-irtf-cfrg-cpace-21](https://www.ietf.org/archive/id/draft-irtf-cfrg-cpace-21.txt)
  ([datatracker](https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/))
- TLS 1.3: [RFC 8446](https://www.rfc-editor.org/rfc/rfc8446). External PSK guidance:
  [RFC 9257](https://www.rfc-editor.org/rfc/rfc9257)
- Hashing to curves: [RFC 9380](https://www.rfc-editor.org/rfc/rfc9380). HKDF:
  [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)
- SPAKE2: [RFC 9382](https://www.rfc-editor.org/rfc/rfc9382). OPAQUE:
  [RFC 9807](https://www.rfc-editor.org/rfc/rfc9807). ristretto255:
  [RFC 9496](https://www.rfc-editor.org/rfc/rfc9496)
- Node 22 TLS-PSK: [nodejs.org/docs/latest-v22.x/api/tls.html](https://nodejs.org/docs/latest-v22.x/api/tls.html) ("Pre-shared keys")
- noble-curves security and audits: [github.com/paulmillr/noble-curves#security](https://github.com/paulmillr/noble-curves#security)
- libsodium 1.0.12/1.0.13 assessment (2017): [PDF](https://www.privateinternetaccess.com/blog/wp-content/uploads/2017/08/libsodium.pdf)
- OPAQUE (serenity-kit) assessment, 7ASecurity 2023: [PDF](https://7asecurity.com/reports/pentest-report-opaque.pdf)
- Noise implementations reviewed: [holepunchto/noise-handshake](https://github.com/holepunchto/noise-handshake),
  [emilbayes/noise-protocol](https://github.com/emilbayes/noise-protocol),
  [ChainSafe/js-libp2p-noise](https://github.com/ChainSafe/js-libp2p-noise)
- Spike: [scripts/dev/spike-channel/](../../scripts/dev/spike-channel/README.md)
