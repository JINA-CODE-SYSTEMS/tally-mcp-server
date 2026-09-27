# Signed auto-update channel — threat model

> **Status: Proposed — needs review by someone who did not write it.**
>
> #177 makes independent review a requirement, not a courtesy: "whoever controls the manifest key
> controls every deployment." Nothing here is implemented, and no key has been generated. The
> reviewer checklist is at the end ([§12](#12-reviewer-checklist)). Until someone other than the
> author has worked through it, treat every decision below as a draft.
>
> Companion document: [update-manifest.md](update-manifest.md) — the manifest format, signature
> scheme and client behaviour that this threat model is the justification for.
>
> Scope: the first two actions of #177. Implementation, the key-compromise drill and publishing the
> scheme come later and are tracked there.

---

## 1. Why this needs writing down first

An updater that downloads and runs a program is a remote code execution channel into every customer
machine, and it runs with more privilege than the customer does: the installer is `PrivilegesRequired=admin`,
and on a remote-mode box the result runs as a Windows service. An attacker who can make that
channel install their build owns the books of every accounting practice that installed Claudally,
without any customer clicking anything.

The goal of this design is narrow and strict:

> **No single compromise — of GitHub, of CI, of the network, of a hosting provider, or of one key
> — is sufficient to make an installed client run a build we did not deliberately release.**
> Where a single compromise *is* still sufficient (see [§10](#10-residual-risk)), that is stated
> plainly, with the reason we accept it.

A second, equally important goal: **a broken or blocked updater must be visible.** An install that
believes it is up to date when it is not is worse than one that knows it has no updater.

---

## 2. What exists today

This is the ground the design has to stand on. Everything here was read from the repository, not
assumed.

| Piece | Today | Relevance |
|---|---|---|
| Release build | `.github/workflows/release.yml`: tag-triggered (`v*`) or dispatched from the default branch; runs in the protected `release` environment (human approval); `npm ci --ignore-scripts`; actions pinned to SHAs; publishes `Claudally-Setup-<v>.exe` + `.sha256` and an SLSA build-provenance attestation | The artifact the updater will install, and the provenance the signing ceremony checks |
| Artifact | One Inno Setup installer. Full install, not a delta. Bundles `dist/`, `node_modules`, portable Node, NSSM, `cloudflared` | The only thing the manifest has to describe |
| Code signing | **None.** #175: SignPath Foundation declined (7 Sep 2026); Azure Trusted Signing closed until the LLP is three years old; Certum cloud / commercial OV under consideration | Before a cert exists, the manifest signature is the *only* authenticity check the updater has |
| Update notification | `scripts/tray/tally-mcp-tray.ps1` asks the GitHub API for `releases/latest` once a day and shows "a newer version exists". Downloads nothing; the link it opens is hardcoded. Opt-out via `UPDATE_CHECK=false` | Unauthenticated, and deliberately harmless. Replaced by the signed channel's status, not extended |
| Room for an updater | `stop-install-processes.ps1` and the `.iss` already spare any process running from `<install>\update`, because "#177's updater orchestrator runs from there and must outlive the install it is driving" | The design uses exactly that carve-out |
| Local mode (`DEPLOYMENT_MODE=local`, the only mode the wizard currently offers) | **No Windows service, no listening port, no OAuth password.** Claude Desktop spawns `dist\index.mjs` over stdio per session, as the user. Two at-logon tasks: `TallyMCPAgent` (GUI agent) and `TallyMCPTray` | Nothing privileged is running to perform an update. The product is sold on "nothing running while the user is not working" |
| Remote mode (`DEPLOYMENT_MODE=remote`, hidden in the wizard, still supported on upgrade) | NSSM service `TallyMCP` runs `dist\server.mjs`; optional `TallyMCPTunnel` runs `cloudflared` | A SYSTEM process exists; restarting it disconnects remote callers |
| Writes to Tally | XML import over localhost, or keystrokes via the GUI agent. A file-backed idempotency store (`src/idempotency.mts`) records a result only after a *successful* write | Killing the server mid-write can commit a voucher in Tally with no idempotency record, so a retry posts it twice. This is the concrete harm behind "never interrupt a write" |
| Team | One listed maintainer (`MAINTAINERS.md`), six contributors | Directly limits which key-custody thresholds are achievable (see [§5](#5-keys-roles-and-custody)) |

---

## 3. Assets

In priority order.

1. **Code execution on customer machines**, as SYSTEM/Administrator. The asset the whole design
   protects.
2. **Customer books** — Tally data reachable from that code, and the stored company passwords in
   the DPAPI vault.
3. **The update signing keys** — root keys and release keys ([§5](#5-keys-roles-and-custody)).
   Whoever holds enough of them *is* asset 1.
4. **Integrity of in-flight Tally writes.** An update that kills the server during an import can
   leave a posted voucher with no record that it was posted.
5. **Availability and honesty of the update channel.** An install that silently stops receiving
   security fixes is a slow-motion compromise.
6. **The Authenticode identity** (once #175 lands). Separate from the manifest keys, and held by a
   third party's HSM.

---

## 4. Adversaries and what each one gets

The table is the core of the document. "Control" names the mechanism; the mechanism itself is
specified in [update-manifest.md](update-manifest.md).

| # | Adversary | Capability | Without controls, they get… | Control | Residual |
|---|---|---|---|---|---|
| A1 | **Compromised hosting** — GitHub Releases, GitHub Pages, the `claudally.jinacode.systems` DNS, or any CDN in front of them | Serve arbitrary bytes at every update URL | Every client installs their build | The manifest is verified against keys **pinned in the installed client**, and the artifact against the manifest's SHA-256 and size. Hosting is treated as untrusted storage | Can withhold updates (freeze, A7) or serve an *old* signed manifest (A6). Both are bounded and detected |
| A2 | **Compromised transport** — MITM, DNS spoofing, a TLS-intercepting corporate proxy, a hostile Wi-Fi | Read and rewrite traffic | Same as A1 | HTTPS with normal certificate validation (defence in depth), **but no security property depends on TLS**: A2 is strictly weaker than A1 and is defeated by the same signature check. No bypass for validation failures, and `NODE_TLS_REJECT_UNAUTHORIZED` / `NODE_OPTIONS` are cleared in the updater's own process | Same as A1. A captive portal or proxy error page must *not* be reported as an attack ([manifest §8](update-manifest.md#8-failure-surfacing)) |
| A3 | **Compromised CI** — a malicious action or npm dependency, a poisoned runner, a modified workflow, or a stolen `GITHUB_TOKEN` | Produce a malicious installer with **valid SLSA provenance**, publish it as a release, publish arbitrary files to Pages | A malicious release that looks entirely legitimate, including to `gh attestation verify` | **CI holds no update signing key.** Signing is a separate, offline, human step ([§6](#6-the-release-signing-ceremony)) that verifies the artifact and reviews what changed before signing. Provenance proves *where* a build came from, not that it is *good*; the ceremony is where a human decides that | A malicious build that also survives the ceremony's review. See A5 |
| A4 | **Compromised maintainer GitHub account** | Push a tag, approve the `release` environment (with one maintainer, the approver and the tagger are the same account), edit workflows, publish releases | Everything A3 gets, with no code review | Same as A3: the offline key is not in GitHub. The ceremony checks that the tagged commit is on `main` and reviews the diff since the previous signed release | If the same person holds the GitHub account *and* the only release key, and both are compromised together (e.g. one stolen laptop holding both) — see [§5.4](#54-custody-rules-that-matter-more-than-the-algorithm) |
| A5 | **Stolen release (manifest) key** | Sign any manifest | Before #175: push any build to every client. After #175: nothing by itself, because the build must also carry our Authenticode signature | Offline custody; the key is **revocable by root** without touching clients ([§7.2](#72-revocation)); release-key expiry bounds an undetected theft; every signed manifest is published to an append-only log in the repo, so an unexpected one is visible | **Before #175 lands, a stolen release key is sufficient on its own.** Accepted for now because the alternative is no update channel at all while the CVE backlog grows; revisited once Authenticode exists |
| A6 | **Rollback attack** — serve an older, validly signed manifest or artifact | Replay anything we ever signed | Downgrade clients onto a known-vulnerable build | Monotonic `sequence` in the manifest and `version` in the key set, persisted client-side; the client **never installs a version lower than the one installed** via the channel. A bad release is fixed by rolling *forward* ([manifest §6](update-manifest.md#6-client-verification-order-normative)) | None through the channel. Local rollback-to-known-good is a separate path that uses only a locally cached, previously verified installer ([manifest §7.5](update-manifest.md#75-rollback-to-known-good)) |
| A7 | **Freeze attack** — keep serving the latest manifest the client has already seen, or nothing | Stop clients learning about a security release | Clients stay vulnerable, believing they are current | Manifest `expires` (45 days); key-set `expires` (365 days); a client that cannot obtain an unexpired manifest says so in the tray, amber, with the date of the last good check | An attacker can hold a client for up to the manifest's remaining lifetime before it notices. This is the price of not running an online timestamp key ([§9](#9-why-not-full-tuf-here)) |
| A8 | **Mix-and-match** — combine pieces of different signed documents (an old manifest with a new key set, a beta artifact with a stable manifest, one release's hash with another's URL) | Construct a combination we never signed | Install something no one approved as a unit | The manifest is **one signed document** holding version, URL, hash, size, channel and policy together — there is nothing to mix inside it. It names its `channel` and the minimum key-set `version` it expects. Documents carry a `type` and are verified only with the role that may sign that type | None identified. Would reappear if the design grew multiple independently signed targets files — which is one of the triggers to move to full TUF |
| A9 | **Endless-data / slow-retrieval** | Stream forever, or trickle | Fill the disk, hang the updater | Hard size caps on metadata (64 KiB) before verification; the artifact is read to at most the manifest's `size` + 1 bytes; connect and total timeouts | Can delay an update (a freeze, A7) but not force one |
| A10 | **Malicious insider** — a release-key holder, or someone who can reach a key | Sign a malicious manifest deliberately | Same as A5 | Two-person rule where the team size allows it ([§5.3](#53-thresholds-and-what-the-team-size-allows)); the append-only manifest log; the ceremony record; after #175, the insider also needs the Authenticode path | With one maintainer, **the lead maintainer is trusted absolutely**. Stated rather than hidden; it is also true of the source code today |
| A11 | **Non-admin local user or malware on the customer machine** | Write to user-writable paths (`{app}\logs`, `{app}\data` are `users-modify`), write the consent file, create fake write leases, run as the logged-on user | TOCTOU: swap the staged installer between verification and execution → code as SYSTEM | Staging, state and the known-good cache live under `%ProgramData%\Claudally\update\`, ACL'd SYSTEM + Administrators full control, Users read-only. The SHA-256 is recomputed on the protected copy immediately before execution. Anything a user can write (consent requests, write leases) is an **untrusted hint**: it can make a *signed* update happen earlier or later, never choose what is installed | Can delay updates by faking write leases — bounded by lease validation and the deferral limit, and surfaced |
| A12 | **Local administrator** | Anything | — | Out of scope. They already own the machine, the service and the vault | — |
| A13 | **Compromised Authenticode signing** (after #175) | Sign arbitrary executables as us | Customers who download manually run it; SmartScreen is satisfied | Not sufficient for the updater, which also requires the manifest. Revoke the certificate through the CA immediately ([§7.4](#74-key-compromise-response)) | Manual downloads during the window between compromise and revocation |
| A14 | **Our own bug in the updater** | — | A client that silently stops updating, installs something unverified because of a logic error, or loops rolling back | Verification written once, in one small module, with the negative-test list in [manifest §11](update-manifest.md#11-testing-requirements); a test key set that exists only inside the test suite; no configuration that changes trust | The residual risk every implementation carries. This is why the review requirement exists |

### What the updater does *not* change

As proposed ([manifest §7](update-manifest.md#7-applying-an-update)), updates install as SYSTEM
through a scheduled task, so **SmartScreen and UAC never see them** —
unlike a customer's manual download, which carries Mark-of-the-Web. The updater's own verification
therefore has to be at least as strong as what Authenticode plus SmartScreen would give a manual
download, and before #175 it is the only thing standing there.

---

## 5. Keys, roles and custody

### 5.1 Two roles, not one key

The smallest design — one key, pinned in every client — cannot recover from its own compromise. To
rotate it you ship an update signed by it; an attacker holding it can do exactly the same, so after
a theft the only remedy is a manual reinstall on every machine, which is the position #177 exists
to escape.

So the design separates **who is trusted** from **what is released**, which is the core idea of
TUF, without the rest of TUF ([§9](#9-why-not-full-tuf-here)):

| Role | Signs | Held | Used | Threshold | Expiry |
|---|---|---|---|---|---|
| **Root** | `keys.json` — the list of valid release keys, the Authenticode policy, the root keys themselves | Offline, split across people and places | Rarely: key rotation, revocation, annual key-set refresh, the Authenticode switch | **2 of 3** (see [§5.3](#53-thresholds-and-what-the-team-size-allows)) | Root public keys are pinned in the client and do not expire; `keys.json` expires after 365 days |
| **Release** | `manifest.json` — what the current release is and how urgent | Offline, on a signing device separate from the build machine | Every release, and a refresh at least every 30 days | 1 (2 once a second key holder exists) | Each release key carries its own expiry in `keys.json`, one year |

Both use Ed25519 ([manifest §5](update-manifest.md#5-signature-scheme)). There is deliberately **no
online key** in v1: no key sits in CI, a cloud KMS, or on a server. See [§9](#9-why-not-full-tuf-here)
for what that costs.

### 5.2 Why the release key is offline too

#177 asks for the manifest to be "signed with a key held offline". It would be simpler to keep the
release key in CI and reserve offline custody for root, and many update systems do. It is not done
here because it makes A3 and A4 sufficient on their own: a compromised workflow, dependency or
maintainer account would then sign its own manifest. With one maintainer and auto-merging patch
dependencies (#168), CI is the most likely thing in this system to be compromised, so it is the
thing that must not hold a key.

The cost is a human step per release. Releases already require a human approval in the `release`
environment, so the step is moved rather than added.

### 5.3 Thresholds and what the team size allows

`MAINTAINERS.md` lists one maintainer. A 2-of-3 root needs three key holders, and a two-person rule
on releases needs two people who can each sign. What is realistic:

- **Root, 2 of 3.** Three root keys held by: (1) the lead maintainer; (2) a second person at Jina —
  a partner of the LLP need not be an engineer; they need to follow a written procedure once a year;
  (3) an escrow copy — sealed, offline, stored somewhere physically separate (e.g. a bank locker),
  used only if one of the other two is lost. No single person can re-key the channel, and the loss
  of any one key is survivable.
- **Release, 1 of N for now.** One release key held by the lead maintainer, plus — as soon as a
  second person can do the ceremony — a second release key, either sufficient on its own. The
  second key is about **availability** during a CVE (the only signer being on leave must not block a
  security release). Moving to a 2-of-2 release threshold is the upgrade path once two people
  routinely release; it is a `keys.json` change, not a client change.

If a third root holder cannot be found, 2 of 2 with an escrowed copy of one of them is the fallback;
1 of 1 is not acceptable for root, because then losing that key means reinstalling every customer.

### 5.4 Custody rules that matter more than the algorithm

- **A signing key never touches a machine that holds GitHub credentials, runs CI, or browses the
  web.** The failure this prevents is A4: one stolen laptop yielding both the account and the key.
  Concretely: a dedicated signing device (an old laptop with networking disabled and full-disk
  encryption is enough), or a hardware token that performs Ed25519 (e.g. a YubiKey 5 on firmware
  5.7 or later via PIV). The format is raw Ed25519, so custody can move from a passphrase-encrypted
  file to hardware later without any client change.
- **Private keys are stored encrypted at rest** (passphrase-encrypted PKCS#8, or non-exportable in
  hardware). The passphrase is never stored with the key.
- **Each root key is backed up once, offline**, to a medium kept with that holder's other root
  material — not with any other holder's.
- **Keys are generated on the signing device**, never on a networked machine, and the public half
  is carried out on removable media. No private key is ever committed to this repository, pasted
  into an issue, or stored in a GitHub secret.
- **The public keys are committed** (the client pins root; `keys.json` lists release keys), so
  every change to who is trusted is a reviewed diff with history.

### 5.5 Bootstrap: trust on first install

The root public keys ship inside the installer. A customer's trust in them therefore comes from how
they obtained their *first* installer: today the published SHA-256 and the SLSA provenance
attestation (`docs/README.md`), after #175 the Authenticode signature too. This is the one point the
update channel cannot protect, and it is why #175 still matters for the updater.

Every install made from `v0.1.0`–`v0.7.x` has **no updater** and must be upgraded by hand once, to
the first release that contains one. The existing tray notifier is how those installs will learn
that release exists.

---

## 6. The release signing ceremony

Where A3 and A4 are actually stopped. Specified step by step in
[manifest §10](update-manifest.md#10-release-signing-ceremony); the security-relevant checks are:

1. The tag's commit is on `main`, and the signer has read the log and diff summary since the
   previous **signed** release. A release the signer cannot explain is not signed.
2. The artifact's SHA-256 and size are computed by the signer from a fresh download, and match the
   release's `.sha256` asset.
3. `gh attestation verify` passes for that file, pinned to this repository and the release workflow,
   from that tag. (Done on a networked machine; only the resulting hash, size, version and commit
   are carried to the signing device.)
4. After #175: the Authenticode signature is valid and matches the pinned identity. The manifest
   pins the hash of the **final, Authenticode-signed** file — signing changes the bytes, so the
   hash is taken after it.
5. The signer reads the manifest as rendered on the signing device before signing it — version,
   URL, hash, `kind`, `security_floor`, expiry — and signs only that.
6. The signed manifest and its signature are committed to the repository (the append-only log) and
   published.

A scheduled monitor job (read-only, no keys) fetches the live manifest, verifies it, and alerts the
maintainers if it differs from the latest one committed, or if its artifact hash no longer matches
the release asset. Customers' clients never phone home, so this is how *we* find out about an A1.

---

## 7. Rotation, revocation and compromise response

### 7.1 Rotation

| What | When | How | Client effect |
|---|---|---|---|
| Release key | Yearly (its `expires`), or on a holder change | Generate on the signing device; root signs a new `keys.json` listing old and new; sign with the new key from then on; drop the old key in the next `keys.json` | None visible. Clients accept the new key once they have fetched the new `keys.json` |
| `keys.json` refresh | Yearly, even with no change | Root re-signs with a higher `version` and new `expires` | None. Doubles as the annual drill of the root procedure |
| Root keys | On a holder change, suspected loss, or every few years | New `keys.json` signed by **both** the current root threshold **and** the new root threshold (the TUF rule); clients then pin the new root set | Clients move to the new root set after verifying both signatures. An install offline across the whole rotation still has the old root and follows the chain on its next check, so old `keys.json` versions stay published |
| Authenticode certificate (after #175) | On CA renewal | Nothing, if the new certificate has the same subject and issuing CA (the policy pins those, not the leaf thumbprint). A different CA or subject needs a root-signed `keys.json` change | None for a routine renewal |

### 7.2 Revocation

- **A release key** is revoked by root publishing a `keys.json` that no longer lists it and names its
  key id under `revoked_keyids`. Clients refuse manifests signed only by it from their next check.
- **A released build** is revoked by the release key publishing a manifest that lists it in
  `blocked_versions` and moves `security_floor` above it. Clients on it treat the next release as a
  security update. There is no "revoke and downgrade": the fix for a bad release is a new release
  with a higher version.
- **A root key** is removed by a root rotation that excludes it ([§7.1](#71-rotation)). Because root
  is 2 of 3, one lost or stolen root key is a rotation, not an emergency.

### 7.3 What the client must do for revocation to mean anything

- Fetch `keys.json` **before** trusting any manifest, on every check.
- Refuse a `keys.json` with a lower `version` than the one already trusted (otherwise an attacker
  replays the key set from before the revocation).
- Fail closed when the trusted `keys.json` has expired and no newer one can be fetched — and say so.

### 7.4 Key-compromise response

To be turned into a runbook and **exercised against a test key set before the updater ships**
(#177's last action). The shape of each:

**Release key stolen or suspected (A5).**

1. Stop signing with it. Do not publish anything signed by it from this point.
2. Root holders (2 of 3) sign a `keys.json` that revokes it and adds a replacement key generated on
   the signing device. Publish immediately.
3. Sign a new manifest with the replacement key and a `sequence` above anything the stolen key could
   plausibly have signed (e.g. jump by 1000), so a client that has already seen an attacker's
   manifest still accepts ours.
4. Check the append-only log and the monitor for manifests that were not ours. If one was served:
   everything below applies.
5. Before #175, a manifest the attacker served *was* sufficient to push a build. Publish a GitHub
   security advisory naming the window, the hash of the malicious artifact if known, and what a
   customer should do, and contact every customer directly — the install base is small enough that
   this is feasible, and the tray cannot be trusted to tell them.

**One root key lost or stolen (below threshold).** Rotate root ([§7.1](#71-rotation)) with the two
remaining holders. Not an emergency, but done within days, because a second loss would be.

**Root threshold compromised (two keys).** The channel cannot be recovered in-band: whoever holds
two root keys can publish a `keys.json` of their own. Publish an advisory, take the manifest
offline so honest clients at least freeze visibly, and ship a new installer with new root keys that
customers install by hand. This is the scenario the custody rules in [§5.4](#54-custody-rules-that-matter-more-than-the-algorithm)
exist to make implausible.

**CI or GitHub account compromised (A3/A4).** Rotate every GitHub credential, review workflow and
tag history, and check whether a release was published that was not signed. Nothing is published to
clients by CI alone, so this is a repository incident, not an update-channel one — *unless* the
ceremony signed a compromised build, in which case treat the affected version as a bad release:
`blocked_versions` plus a higher-versioned fix.

**Authenticode key compromised (A13, after #175).** Ask the CA to revoke with the earliest plausible
compromise date, so signatures timestamped after it fail. Updater clients are not exposed by this
alone. Obtain a new certificate; if the subject or issuing CA changes, root signs a `keys.json`
updating the Authenticode policy.

**Hosting compromised (A1).** Signatures hold; this is an availability incident. Restore the
correct files and check the monitor's history for how long the wrong ones were served.

---

## 8. Where it interacts with Authenticode (#175)

The manifest key and the Authenticode certificate are **independent** and answer different
questions: the manifest says "Jina intends this exact file to be the current release, with this
urgency"; Authenticode says "this file was signed by the holder of our CA-issued identity". The
design uses both, and never lets one stand in for the other.

**Phase 0 — now, no certificate.** Manifest signature plus pinned SHA-256 and size are the whole of
the check. `keys.json` carries `"authenticode": {"required": false}`. An installer that *happens* to
be Authenticode-signed is not rejected, but its signature is not relied on either. A5 is sufficient
on its own in this phase — the single most important residual risk in this document.

**Phase 1 — certificate in hand.** Root signs a `keys.json` with `required: true` and a signer policy
(subject, issuing CA, required timestamp countersignature). From then on the client requires **both**:
the manifest verifies, the hash matches, *and* `WinVerifyTrust` reports a valid signature that
satisfies the policy. Failure of either aborts.

**The switch is a one-way latch.** Once a client has trusted a `keys.json` with `required: true`, it
records that locally and never accepts `false` again, even from a validly root-signed `keys.json`.
Without the latch, a later root compromise could quietly switch Authenticode checking off.

**Why the policy lives in `keys.json` (root-signed), not the manifest (release-signed).** If the
release key could say "Authenticode not required", then after Phase 1 a stolen release key would
again be sufficient on its own — exactly what Phase 1 is meant to end.

**Where the Authenticode signing happens changes what the manifest pins.** The #175 discussion
leaves open whether Certum's cloud signing can run unattended in CI. Either way the manifest hash
is of the final signed bytes. If signing happens outside CI, the SLSA attestation's subject (the
unsigned CI output) is not the file customers run; the ceremony should then confirm the two
correspond — the Authenticode PE digest excludes the signature, so it should be identical for the
unsigned and signed file — and record both hashes in the manifest's `provenance` block. This needs
verifying against a real Inno Setup output before it is relied on.

**Revocation checking.** `WinVerifyTrust` is called with revocation checking on. "Could not reach the
revocation server" defers the update quietly and retries; it is never treated as a pass.

**Publisher identity.** A Certum Open Source certificate is issued to an individual and may show a
personal name rather than "JINA CODE SYSTEMS LLP". The signer policy pins whatever subject is
actually issued; the choice of certificate is #175's, but it decides what this policy says.

---

## 9. Why not full TUF here

[The Update Framework](https://theupdateframework.io/) is the reference design for exactly this
threat list, and this design borrows its central ideas: separate root and signing roles, signature
thresholds, versioned and expiring metadata, root rotation by cross-signing. What it leaves out,
and why:

| TUF piece | What it protects against | Why it is omitted here | Revisit when |
|---|---|---|---|
| **Timestamp role** (online key, short expiry, re-signed frequently) | Freeze attacks, bounding them to hours | It needs an online key. Putting it in CI reintroduces A3 for freezes; signing it offline daily is not sustainable for one maintainer. The 45-day manifest expiry bounds freezes more loosely and detects them | Security releases need to reach clients within hours rather than days, or there is infrastructure for an online key outside CI |
| **Snapshot role** | Mix-and-match across many targets files | There is one targets document with one artifact. Nothing to mix | More than one independently signed artifact or channel |
| **Delegations** | Third parties signing a subset of targets | No third parties | Never, probably |
| **Consistent snapshots, hashed file names** | Races while the repository updates | One small document, updated atomically | The repository grows |

The recommendation in [manifest §3](update-manifest.md#3-tooling-evaluation-and-recommendation) is
therefore a minimal scheme whose concepts map one-to-one onto a subset of TUF, so that moving to
`tuf-js` and a TUF repository later is a migration of format, not of trust model. The root keys can
be reused.

---

## 10. Residual risk

Stated so that nobody mistakes the design for more than it is.

1. **Before #175, one stolen release key is enough** to push a build to every client that fetches
   the manifest before the key is revoked. Mitigated by offline custody, key expiry, the manifest
   log and the monitor; not eliminated.
2. **With one maintainer, that person is trusted absolutely.** True of the source today; the update
   channel does not make it worse, but does not make it better either until a second person holds a
   release key.
3. **Freezes are detected, not prevented**, within the manifest's lifetime.
4. **First install is trust-on-first-use**, via the download checks available at the time.
5. **A compromised build that passes review** at the ceremony is signed. Provenance and review raise
   the cost; they do not make it impossible.
6. **No telemetry.** A client that rejects a malicious update knows; we do not, unless the customer
   tells us or the monitor catches the cause. That is consistent with the product's "nothing leaves
   your machine" position and is a deliberate trade.

---

## 11. Non-goals

- Delta updates, staged rollouts, per-customer channels.
- Updating Tally, Claude Desktop, or anything the installer does not install.
- Protecting against a local administrator.
- Replacing #175. The updater does not make SmartScreen go away for first installs.

---

## 12. Reviewer checklist

For the independent reviewer #177 requires. Please answer each in the PR, not just approve.

- [ ] Is there any path by which an installed client runs code that was not both (a) described by a
      manifest verified against keys chained to the pinned root and (b) matched to that manifest's
      SHA-256 and size? Include error paths, retries, rollback, and "first run after install".
- [ ] Is there any configuration, environment variable, registry value, file, or build flavour that
      changes which keys are trusted or skips a check? (There must be none.)
- [ ] Can anything a non-admin local user writes influence *what* is installed, rather than *when*?
- [ ] Is the root/release split justified, or is it complexity the team will not operate correctly?
      Would a simpler scheme be safer in practice?
- [ ] Are the thresholds in [§5.3](#53-thresholds-and-what-the-team-size-allows) achievable with the
      people Jina actually has?
- [ ] Is 45 days an acceptable freeze window? Is 30-day refresh signing sustainable?
- [ ] Does the Authenticode latch ([§8](#8-where-it-interacts-with-authenticode-175)) have a failure
      mode that strands clients (e.g. a CA change that the policy cannot express)?
- [ ] Is each compromise response in [§7.4](#74-key-compromise-response) something the team can
      actually carry out, and is anything missing?
- [ ] Do the per-mode behaviours in [manifest §7](update-manifest.md#7-applying-an-update) honour
      "never interrupt a Tally write" in *every* mode, including multiple Claude Desktop sessions in
      local mode?

---

## 13. Open questions

The ones that belong to the owner rather than the reviewer — key holders, custody hardware, the
freeze window, and whether local mode may run a SYSTEM task — are collected in
[manifest §13](update-manifest.md#13-open-questions-for-the-owner) so there is one list.
