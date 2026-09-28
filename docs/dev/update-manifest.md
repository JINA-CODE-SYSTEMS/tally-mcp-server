# Signed auto-update channel — manifest format and signing scheme

> **Status: Accepted — 2026-09-28, by the owner (Tapan Jain, @jain-t), without independent review.**
> #177 asked for the design to be reviewed by someone who did not write it; that review did not
> happen, and the owner accepted the design without it
> ([threat model, status](update-channel-threat-model.md)). The owner's answers to the open
> questions are in [§13](#13-owner-decisions) and are reflected throughout.
>
> Design only. Nothing here is implemented, no key has been generated, and the example values
> below (hashes, key ids, URLs under `/update/`) are placeholders. The reasoning for every decision
> is in the companion threat model, [update-channel-threat-model.md](update-channel-threat-model.md);
> this document is the *what*, that one is the *why*. Threat ids (A1–A14) refer to its §4.
>
> Part of #177 (actions 1 and 2). Depends on nothing from #175: the manifest keys are our own and
> separate from any code-signing certificate. How the two combine once #175 lands is in
> [threat model §8](update-channel-threat-model.md#8-where-it-interacts-with-authenticode-175).

---

## 1. Decisions at a glance

| Question | Decision |
|---|---|
| Tooling | **Minimal custom scheme with TUF semantics**, not full TUF. No new runtime dependency in the privileged updater ([§3](#3-tooling-evaluation-and-recommendation)) |
| Signature | **Ed25519**, via Node's built-in `crypto` (OpenSSL). No hand-written crypto |
| Envelope | **DSSE** (the in-toto / sigstore signing envelope) — a published spec, so the signed bytes are unambiguous and outside auditors can verify with existing tools |
| Roles | **Root** (offline, 1 of 1 — a single holder for now; 2 of 3 is the upgrade path) signs `keys.json`; **release** (offline, 1 of N) signs `manifest.json`. No online keys. Custody: passphrase-encrypted keys on a dedicated offline signing laptop ([threat model §5.3–5.4](update-channel-threat-model.md#53-thresholds-decided-a-single-holder-for-now)) |
| Documents | Two, both small JSON in DSSE envelopes, published from this repository's `site/` to `https://claudally.jinacode.systems/update/v1/` |
| Artifact | The existing `Claudally-Setup-<v>.exe` on GitHub Releases, pinned by SHA-256 **and** size |
| Rollback | Monotonic `sequence` and key-set `version`; never install below the installed version through the channel |
| Freeze | Manifest expires after 45 days; re-signed at least every 30 |
| Urgency | Per install, from `security_floor` and `blocked_versions` — not a per-release flag |
| Bypass | **None.** No flag, variable, registry value or build flavour ([§9](#9-no-bypass-explicit-rules)) |
| Authenticode | Required by root-signed policy once #175 lands; a one-way latch; both checks must pass |
| Who applies | A short-lived daily SYSTEM scheduled task, `TallyMCPUpdate`, in both deployment modes, local mode included ([§7.1](#71-who-runs-the-updater)) |
| Policy | Security updates always install automatically; feature updates wait for consent in the tray; `UPDATE_CHECK=false` stops feature updates only. Same in both modes ([§7.1](#71-who-runs-the-updater)) |
| Tally writes | Never interrupted: a write-lease / drain protocol ([§7.3](#73-never-interrupt-a-tally-write)) |
| Failed start | Automatic reinstall of the cached, previously verified build; never loops ([§7.5](#75-rollback-to-known-good)) |

---

## 2. Constraints from the code as it stands

These shape the design more than any general principle does.

- **The artifact is a full Inno Setup installer** that needs admin, stops the service and tasks in
  `PrepareToInstall`, kills this install's processes via `stop-install-processes.ps1` (sparing
  anything under `{app}\update`), and re-runs `firstrun-config.ps1`. The updater drives that
  installer; it does not replace files itself.
- **Windows PowerShell 5.1 runs on .NET Framework, which has no Ed25519.** The repository's
  PowerShell must stay 5.1-compatible (`check-powershell-compat.ps1`). Verification therefore lives
  in Node, which is already bundled and whose `crypto.verify` does Ed25519 through OpenSSL. Windows-only
  pieces (Authenticode via `WinVerifyTrust`, scheduled tasks) stay in PowerShell.
- **The installer replaces `{app}\node-portable`.** An updater running on that `node.exe` would
  hold it locked, and would be killed mid-install anyway. The updater therefore runs from a copy
  under `{app}\update\run\` — the directory the installer's process-stopper already spares.
- **Local mode has no privileged process at all.** Claude Desktop spawns `dist\index.mjs` as the
  user; the tray and GUI agent are at-logon tasks as the user. Installing into Program Files needs
  elevation that nothing on a local-mode box currently has.
- **Local-mode server processes belong to Claude Desktop sessions.** Stopping one disconnects that
  session's Tally tools until Claude Desktop is fully restarted, and there may be more than one.
- **The idempotency store records a write only after it succeeds** (`src/idempotency.mts`), so a
  server killed during an XML import can leave a posted voucher with no record — and a retry then
  posts it twice.
- **`{app}\logs` and `{app}\data` are `users-modify`** in the `.iss`. Nothing the updater trusts may
  live there (A11).

---

## 3. Tooling evaluation and recommendation

| Option | What it gives | What it costs here | Verdict |
|---|---|---|---|
| **Full TUF** — `python-tuf` or `go-tuf` for the repository, [`tuf-js`](https://github.com/theupdateframework/tuf-js) as the Node client, or [`tuf-on-ci`](https://github.com/theupdateframework/tuf-on-ci) to run signing through GitHub PRs | The most thoroughly analysed answer to this exact threat list; root rotation, thresholds, freeze protection via timestamp role, mix-and-match protection via snapshot | Four roles and their metadata to operate. Timestamp and snapshot want an **online** key (in CI or a cloud KMS) or daily offline signing — the first reintroduces A3, the second is not sustainable for one maintainer. `tuf-js` brings a dependency tree (HTTP client, models, glob matching) into a process that runs as SYSTEM. Snapshot and delegations protect against problems a single-artifact, single-channel repository does not have | **Not now.** Adopt its model; revisit on the triggers in [threat model §9](update-channel-threat-model.md#9-why-not-full-tuf-here) |
| **minisign / signify** | Small, well-regarded signing tools; minisign has passphrase-encrypted keys and a one-line verify command auditors know | A signature primitive and a key-file format — nothing about expiry, rollback, rotation, revocation, thresholds or channels, which are the hard part. minisign signs a BLAKE2b prehash in its own format, so keys cannot move into a hardware token later, and the client would still need a hand-written minisign parser | **Close second.** Would still need every document in [§4](#4-documents) around it |
| **Sigstore / cosign keyless** | Signing identity = the GitHub Actions workflow, logged in Rekor. Already in use here via `actions/attest-build-provenance` | The signer *is* CI, so A3/A4 are sufficient to sign — exactly what #177 rules out. Client verification needs Fulcio roots, Rekor and OIDC semantics in the privileged updater | **Use at the ceremony, not as the client's trust root.** The provenance check stays; the client does not depend on it |
| **Windows update frameworks** — Squirrel.Windows / Velopack, WinSparkle, Omaha | Ready-made download/apply UX; WinSparkle signs its appcast with Ed25519 | Squirrel/Velopack install per-user into `%LOCALAPPDATA%`, not a Program Files install that registers services. WinSparkle's signature has no expiry, rollback or rotation story. Omaha is far too heavy | **Rejected.** None fits an admin Inno Setup installer that manages NSSM services |
| **Minimal custom scheme** (adopted) | Exactly the TUF subset that matters for one artifact: root/release split, thresholds, versions, expiry, rotation by cross-signing, revocation. DSSE envelope + Ed25519 from `node:crypto` | Our own code to get right — mitigated by keeping it to one small, heavily tested verification module and the review checklist (independent review was waived by the owner) | **Adopted** |

**Why Ed25519 rather than ECDSA P-256.** ECDSA P-256 would let PowerShell 5.1 verify without Node,
but its signatures depend on a per-signature nonce, and nonce mistakes leak the key. Ed25519 is
deterministic, has one encoding, is the default in minisign, signify, TUF, WinSparkle and OpenSSH,
and is available both in Node and on hardware tokens that support it (e.g. YubiKey 5 firmware 5.7+).

**Why DSSE.** Signing "the JSON" is ambiguous — whitespace, key order and encoding all change the
bytes. DSSE signs a byte string with its type bound in (pre-authentication encoding), so the signed
bytes are exactly the bytes delivered, the client verifies before it parses, and a signature over a
key set can never be replayed as a signature over a manifest. It is the envelope in-toto and
GitHub's own attestations use, so auditors can check it with existing libraries.

---

## 4. Documents

### 4.1 Layout and hosting

```
https://claudally.jinacode.systems/update/v1/
    keys.json                  current key set          (DSSE, signed by root)
    keys/1.json, keys/2.json…  every key set ever issued (DSSE; needed to walk root rotations)
    stable/manifest.json       current stable manifest  (DSSE, signed by release keys)

https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/releases/download/v<ver>/Claudally-Setup-<ver>.exe
                               the artifact, unchanged from today
```

- The files are committed under `site/update/v1/` and published by the existing Pages workflow.
  **Every signed document ever issued is therefore in git history** — an append-only log anyone can
  audit, and what the monitor ([threat model §6](update-channel-threat-model.md#6-the-release-signing-ceremony))
  compares against.
- Hosting is not a trust input (A1). A mirror can be added later without any change to what is
  trusted.
- `v1` is the spec version. A future incompatible format is published under `v2/` **alongside**
  `v1/`, and the last `v1` manifest points at a release that understands `v2`. Old clients are
  never stranded by a format change.

### 4.2 `keys.json` (payload, before enveloping)

```json
{
  "type": "claudally.update.keys",
  "spec_version": 1,
  "version": 3,
  "issued": "2026-10-01T09:00:00Z",
  "expires": "2027-10-01T09:00:00Z",
  "root": {
    "threshold": 1,
    "keys": [
      { "keyid": "<sha256 hex of raw public key>", "public_key": "<base64, 32 bytes>", "holder": "root-1" }
    ]
  },
  "release": {
    "threshold": 1,
    "keys": [
      { "keyid": "…", "public_key": "…", "holder": "release-A", "expires": "2027-10-01T09:00:00Z" }
    ]
  },
  "revoked_keyids": [],
  "channels": ["stable"],
  "authenticode": {
    "required": false,
    "signers": []
  }
}
```

| Field | Meaning | Threat |
|---|---|---|
| `type`, `spec_version` | Must equal `claudally.update.keys` and `1` | A8 (type confusion) |
| `version` | Monotonic. The client refuses anything lower than it already trusts; equal only if byte-identical | A6 — replaying the key set from before a revocation |
| `issued`, `expires` | RFC 3339 UTC (`Z`). Expired key set → fail closed and say so | A7 |
| `root.threshold`, `root.keys` | Who may sign the *next* `keys.json`. Changing this set is a root rotation ([§6](#6-client-verification-order-normative), step 2). One key, threshold 1, for now (owner decision); moving to 2 of 3 is a rotation, not a client change | A5, A10 |
| `release.threshold`, `release.keys[].expires` | Who may sign manifests, and until when | A5 |
| `revoked_keyids` | Explicit, so a revoked key is refused even if it somehow reappears in a list | A5 |
| `channels` | Channels this key set authorises. Only `stable` in v1 | A8 |
| `authenticode.required` | `false` until #175 lands. **Latched** client-side once `true` | A5 after #175; see threat model §8 |
| `authenticode.signers[]` | `{ "subject": "<exact subject DN>", "issuer_ca_sha256": ["<SHA-256 of issuing CA cert>"], "require_timestamp": true }`. Pins subject and issuing CA, **not** the leaf thumbprint, so a routine renewal needs no root ceremony | A13 |

`keyid` is always recomputed by the client from `public_key`; a mismatch rejects the document.

### 4.3 `manifest.json` (payload, before enveloping)

```json
{
  "type": "claudally.update.manifest",
  "spec_version": 1,
  "channel": "stable",
  "sequence": 17,
  "issued": "2026-10-01T09:30:00Z",
  "expires": "2026-11-15T09:30:00Z",
  "min_keys_version": 3,
  "release": {
    "version": "0.8.0",
    "upgrade_from_min": "0.7.0",
    "artifact": {
      "url": "https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/releases/download/v0.8.0/Claudally-Setup-0.8.0.exe",
      "size": 98765432,
      "sha256": "<64 hex>"
    },
    "provenance": {
      "tag": "v0.8.0",
      "commit": "<40 hex>",
      "workflow": ".github/workflows/release.yml",
      "build_sha256": "<64 hex: the CI output named in the SLSA attestation>"
    },
    "notes_url": "https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/releases/tag/v0.8.0"
  },
  "security_floor": "0.8.0",
  "blocked_versions": [],
  "advisory": null
}
```

| Field | Meaning | Threat |
|---|---|---|
| `type`, `spec_version` | Must equal `claudally.update.manifest` and `1` | A8 |
| `channel` | Must equal the channel the client follows | A8 — a beta manifest served as stable |
| `sequence` | Monotonic per channel; bumped on every signing, including refreshes. Lower → reject; equal → accept only if byte-identical | A6 |
| `issued` | Rejected if more than 1 hour in the future (clock skew allowance) | A6 |
| `expires` | 45 days after `issued`. Expired → no install, tray amber | A7 |
| `min_keys_version` | The client must hold at least this key set, so a manifest cannot be paired with an older key set in which a since-revoked key was still valid | A8, A5 |
| `release.version` | Strict `MAJOR.MINOR.PATCH`. A prerelease suffix on `stable` is rejected | — |
| `release.upgrade_from_min` | The oldest installed version that may upgrade directly (for migrations). Older installs are told to update by hand, never force-upgraded | Reliability |
| `release.artifact.url` | HTTPS only, on `github.com`; redirects are followed only to HTTPS. Not a trust input — just where to fetch, so the redirect host GitHub happens to use is not pinned | — |
| `release.artifact.size` | Exact byte count; also the download cap | A9 |
| `release.artifact.sha256` | Of the **final** file — after Authenticode signing, once that exists | A1, A2, A3 |
| `release.provenance` | What the ceremony checked. Informational to the client; lets auditors tie a manifest to a build and a commit | A3 (audit) |
| `security_floor` | The lowest version with no known security issue. Installed below it → security path | Urgency |
| `blocked_versions` | Versions withdrawn after release. Installed one of these → security path | Revocation of a bad build |
| `advisory` | Optional `{ "id": "GHSA-…", "summary": "…", "url": "…" }`, shown in the tray on the security path | Honest surfacing |

**Why urgency is not a per-release flag.** "Security vs feature" is a property of *the gap between
what is installed and what is safe*, not of the latest release. An install two releases behind a
security fix needs the security path even when the newest release is a feature release;
`security_floor` expresses that directly, a `kind: security` flag on the latest release does not.

**What the manifest deliberately does not contain:** any public key, any instruction to trust
something, any script or command, any second artifact. It can only describe one file.

---

## 5. Signature scheme

- **Algorithm:** Ed25519 (RFC 8032), pure mode, verified with `crypto.verify(null, pae, publicKey, sig)`.
- **Envelope:** [DSSE v1](https://github.com/secure-systems-lab/dsse/blob/master/envelope.md):

  ```json
  {
    "payloadType": "application/vnd.claudally.update.manifest+json; version=1",
    "payload": "<base64 of the exact manifest.json bytes>",
    "signatures": [ { "keyid": "<sha256 hex of raw public key>", "sig": "<base64, 64 bytes>" } ]
  }
  ```

  The signed message is DSSE's pre-authentication encoding:
  `"DSSEv1" SP len(payloadType) SP payloadType SP len(payload) SP payload`, lengths as ASCII
  decimal byte counts, `payload` as raw bytes.
- **Payload types:** `application/vnd.claudally.update.keys+json; version=1` (root keys only) and
  `application/vnd.claudally.update.manifest+json; version=1` (release keys only). The payload's own
  `type` field must agree with its `payloadType`.
- **Key ids** are hints for lookup. A signature counts toward a threshold only if it verifies under a
  key the client already trusts for that role; each distinct key counts once however many times its
  signature appears; unknown key ids are ignored, not errors.
- **Private keys** are generated and used only on the signing device — by owner decision, a dedicated
  offline laptop — stored as passphrase-encrypted PKCS#8 (which `node:crypto` reads natively).
  Hardware tokens were declined for now; the format does not change if custody moves to hardware
  later.
- **Anyone can verify** with a short published script, or with OpenSSL:
  `openssl pkeyutl -verify -pubin -inkey release.pem -rawin -in pae.bin -sigfile sig.bin`
  after building `pae.bin` as above. Publishing that recipe is #177's fifth action.

---

## 6. Client verification order (normative)

Nothing is acted on — not parsed beyond the envelope, not downloaded, not shown to the user as
available — until the step that verifies it has passed. Any failure stops the run at that step
([§8](#8-failure-surfacing) says what is reported).

**State** lives in `%ProgramData%\Claudally\update\state.json`, ACL'd SYSTEM + Administrators full
control, Users read. It holds the trusted key set (bytes and version), the highest manifest
sequence seen, the Authenticode latch, the installed version as last verified, and the known-good
record.

1. **Load trust anchors.** Root public keys are constants compiled into the updater. The trusted key
   set is the one in state, or — on first run — none, in which case the updater requires a key set
   signed by the compiled-in root.
2. **Refresh the key set.** Fetch `keys.json` (HTTPS, cap 64 KiB, timeouts). If its `version` is
   above the trusted one, fetch each intermediate `keys/<n>.json` in order and for each:
   verify the DSSE envelope with `payloadType` = keys; require `threshold` valid signatures from the
   **currently trusted** root keys **and**, if the root set changed, `threshold` from the **new**
   root keys; require `type`/`spec_version` match; require `version` = previous + 1; require every
   `keyid` to match its `public_key`. Only then parse and adopt. Finally check the newest one's
   `expires` is in the future. Persist.
   - Fetch failed but the trusted key set is unexpired → continue with it.
   - Fetch failed and it has expired → stop; tray amber "update keys expired".
   - A lower `version` is served → stop; treat as an attack signal (loud).
   - If the adopted key set has `authenticode.required = true`, set the latch in state. It is never
     cleared.
3. **Fetch the manifest.** `stable/manifest.json`, HTTPS, cap 64 KiB.
4. **Verify the manifest.** DSSE with `payloadType` = manifest; `release.threshold` valid signatures
   from release keys in the trusted key set that are not in `revoked_keyids` and whose `expires` has
   not passed. Then parse, and require: `type`, `spec_version`, `channel` match; `min_keys_version` ≤
   trusted key-set `version`; `sequence` ≥ stored (equal only if byte-identical); `issued` ≤ now + 1h;
   `expires` > now; `release.version` is strict semver without prerelease; URL scheme and host as
   in [§4.3](#43-manifestjson-payload-before-enveloping). Persist `sequence`.
5. **Decide** ([§7.2](#72-what-happens-for-a-given-install)). If `release.version` ≤ installed, stop:
   nothing to do. The channel **never** installs a lower version.
6. **Wait** for consent (feature path) or a drain window (security path) — [§7.3](#73-never-interrupt-a-tally-write).
7. **Download** the artifact over HTTPS to `%ProgramData%\Claudally\update\staging\` (SYSTEM +
   Administrators only). Read at most `size` + 1 bytes; require exactly `size`. Compute SHA-256 over
   the bytes as they are written; require equality with `artifact.sha256`. On mismatch, delete and
   retry the download once from scratch; a second mismatch is loud.
8. **Authenticode.** If the latch is set or `authenticode.required` is true: `WinVerifyTrust` must
   report valid, with revocation checking on; the signer must match one entry of
   `authenticode.signers` (subject and issuing CA); a timestamp countersignature must be present if
   required. "Revocation server unreachable" defers quietly — it is never a pass. If not required and
   the file is signed, the signature must still be valid and, if `signers` is non-empty, match it: a
   file signed by *someone else* is rejected even in Phase 0.
9. **Re-hash** the staged file immediately before execution, from the protected directory, and hold
   it open with write sharing denied until the installer process has started.
10. **Apply** ([§7.4](#74-behaviour-per-deployment-mode)), **health-check**, then either record the
    new version as known-good or **roll back** ([§7.5](#75-rollback-to-known-good)).

---

## 7. Applying an update

### 7.1 Who runs the updater

**Decided: one SYSTEM scheduled task, `TallyMCPUpdate`, registered by the installer in both
deployment modes, local mode included.** It runs once a day at a randomised time and ten minutes after boot, exits when
done, listens on nothing, and can be started on demand. It is the only component that downloads,
verifies or installs.

- It executes from `{app}\update\run\<id>\`: at the start of each run it copies the updater script
  and `{app}\node-portable\node.exe` there and checks both against hashes recorded at install time.
  The installer never writes into `{app}\update\run\`, and `stop-install-processes.ps1` already
  spares it, so the updater outlives the install it is driving and is there to roll it back.
- **The tray becomes display and consent only.** It reads `%ProgramData%\Claudally\update\status.json`
  (written by the updater, read-only to users) and replaces today's unauthenticated GitHub-API
  notifier, so there is one source of truth for "is there an update". "Install now" writes a consent
  request (`{ "version": "0.8.0", "sha256": "…" }`) and starts the task. A request is only a hint:
  it can make a verified update happen sooner, never choose what is installed (A11).
- **For local mode this is a change to the product's promise** — until now nothing privileged runs
  on a local-mode box. The owner accepted it ([§13](#13-owner-decisions), 1): the task is short-lived
  (it runs once a day and exits), listens on nothing, and customer-facing text must say it exists.
  The alternative, not adopted, was for the tray to request elevation through UAC for each update:
  that kept the promise but made security updates wait for a person to click a UAC prompt.

Settings, in `.env`, preserved across reconfigure like the rest:

| `UPDATE_POLICY` | Behaviour |
|---|---|
| `security-auto` (default) | Security path applies automatically (subject to [§7.3](#73-never-interrupt-a-tally-write) and, in local mode, the deadline in [§7.4](#74-behaviour-per-deployment-mode)); feature updates surface in the tray and wait for "Install now" |
| `security-only` | Security path exactly as above; feature updates are not offered |

**Security updates always install; no setting stops them** (owner decision, [§13](#13-owner-decisions), 2).
The existing `UPDATE_CHECK=false` maps to `security-only`: it stops feature updates, never security
updates. An install with it set therefore still fetches `keys.json` and the manifest — a change from
what `UPDATE_CHECK=false` meant before (no update check at all), which the release that ships the
updater must state in its notes. Remote-mode machines follow the same policy as local ones.

*Not adopted:* `notify` and `off` (both would let an install stop receiving security fixes) and
`all-auto` (feature updates without consent, proposed for unattended remote-mode machines).

None of these settings affects *what* is trusted or *how* it is checked — only *when* an already
verified update is applied.

### 7.2 What happens for a given install

After step 4 of [§6](#6-client-verification-order-normative) has passed:

| Condition | Path |
|---|---|
| installed ≥ `release.version` | Nothing. Status "up to date, checked <time>" |
| installed < `upgrade_from_min` | No automatic update. Tray: "This version is too old to update automatically — install <version> by hand", with the release link |
| installed < `security_floor`, or installed ∈ `blocked_versions` | **Security path** |
| otherwise | **Feature path** |

### 7.3 Never interrupt a Tally write

A cross-process protocol, because in local mode there may be several server processes (one per
Claude Desktop session) and the updater is a different process again.

- **Write lease.** Before any tool that writes to Tally — an XML import, or any GUI-agent action,
  since an interrupted keystroke sequence can leave Tally in a half-completed dialog — the server
  creates `%ProgramData%\Claudally\run\writes\<pid>-<random>.lease` containing its PID, image path,
  start time and tool name, and deletes it when the tool returns, on every path.
- **Drain flag.** Before applying, the updater creates `%ProgramData%\Claudally\run\drain` with the
  target version and a deadline.
- **Ordering.** The server creates its lease **then** checks for the drain flag; the updater creates
  the flag **then** scans for leases. Whichever order the two interleave, at least one sees the
  other. A server that finds the flag deletes its lease and refuses the write with a plain message —
  "Claudally is installing an update; nothing was written; try again in a couple of minutes." Reads
  continue.
- **Waiting.** The updater waits up to 10 minutes for live leases to clear. A lease is live if its
  PID is running and that process's image is `node.exe` under the install directory; anything else
  is stale and removed. If leases remain at the deadline, the updater removes the flag, applies
  nothing, and retries on its next run. It never stops a process holding a live lease.
- **Crash safety.** Servers ignore a drain flag whose deadline has passed, so a crashed updater cannot
  block writes indefinitely.
- A user who fakes leases can only *delay* updates (A11); repeated deferral is surfaced in the tray.

### 7.4 Behaviour per deployment mode

| | Local mode (no service) | Remote mode (NSSM service) |
|---|---|---|
| What runs | Server processes spawned by Claude Desktop, as the user; GUI agent and tray tasks | `TallyMCP` service; optional `TallyMCPTunnel`; GUI agent and tray tasks |
| Feature path | Applied when the user clicks "Install now" (the dialog says Claude Desktop must be fully restarted afterwards) | Applied on "Install now" in the tray — the same policy as local mode; a machine nobody watches gets security updates but not feature updates until someone consents |
| Security path | Applied at the next moment no server process is running. If Claude Desktop stays open, the tray shows a red "Security update ready — Install now"; after **24 hours** the updater applies it after a **5-minute** tray countdown (owner decision) — still only through the drain protocol, never mid-write | Applied on the next run, after draining. Remote callers see a short outage while the service restarts |
| What the install does to running processes | Stops this install's `node.exe` processes, disconnecting open Claude Desktop sessions from Tally tools | Stops the service and tunnel, then re-registers and restarts them |
| Health check | Spawn `dist\index.mjs` and complete an MCP `initialize` + `tools/list` over stdio within 60 s, with the server reporting the new version; `TallyMCPAgent` and `TallyMCPTray` tasks registered and, if a user is logged on, running | `TallyMCP` Running continuously for 60 s with no NSSM restart in that window; a loopback HTTP request to `/.well-known/oauth-protected-resource` returns 200; `TallyMCPTunnel` Running if configured |
| After success | Tray: "Updated to <v>. Quit and reopen Claude Desktop to use it." | Tray: "Updated to <v>." |

### 7.5 Rollback to known-good

- **The known-good cache** is `%ProgramData%\Claudally\update\known-good\`: the installer of the
  currently installed version plus its SHA-256, recorded when it was installed. A manually run
  installer puts itself there (`{srcexe}`) during installation; an updater-driven install puts the
  verified download there after a successful health check.
- **Before applying**, the updater backs up `.env` and `{app}\data` alongside it.
- **If the health check fails**, the updater re-hashes the cached installer against its record,
  re-runs it silently, restores the `.env` backup, and health-checks again. The failed version is
  recorded and **not retried automatically** until a manifest with a higher `sequence` offers a
  different version.
- **If rollback also fails**, the updater stops. Tray red: what happened, that Tally data was not
  touched, and to contact Jina. No loops.
- **Rollback is not a downgrade through the channel.** It reinstalls the version that was already
  installed, from a copy that was verified when it was installed. The network is never consulted,
  and a network-supplied older version is never accepted.
- **Consequence for releases:** a release must be able to start against the `.env` and data left by
  the version before it, and vice versa. No one-way migrations between adjacent releases without a
  written rollback story. This becomes a release-checklist item.

### 7.6 Invoking the installer

`Claudally-Setup-<v>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /LOG="<ProgramData>\Claudally\update\logs\install-<v>.log"`,
exit code checked, log kept for support.

**This does not work safely today** — see [§12](#12-prerequisites-found-in-the-current-code).

---

## 8. Failure surfacing

"A silently broken updater is worse than none." Every state below is shown in the tray, written to
`status.json`, and logged to the Windows Application event log under a `Claudally` source with a
fixed event id, so a managed IT team can alert on it.

| State | Tray | Meaning |
|---|---|---|
| Up to date | Normal, "checked <time>" | Verified manifest, nothing newer |
| Feature update available | Normal + menu item | Waiting for "Install now" |
| Security update pending | **Red** | Waiting for a drain window, or for Claude Desktop to close |
| Deferred — write in progress | Amber after 3 consecutive deferrals | Leases did not clear |
| Applied | Normal; local mode asks for a Claude Desktop restart | — |
| Rolled back | **Amber** | New version failed its health check; previous version restored |
| Rollback failed | **Red** | Manual help needed |
| **Verification failed** | **Red**: "An update was rejected because it could not be verified. Nothing was installed. Please tell Jina." | Bad signature, revoked or expired key, lower sequence or key-set version, hash or size mismatch after a retry, Authenticode mismatch |
| Stale | **Amber** after 7 days without a successful verified check; **red** once the stored manifest has expired | Could not reach the update server; possibly a freeze (A7) |
| Update keys expired | **Red** | The trusted key set expired and no newer one could be fetched |
| Feature updates off | Grey, permanent text: security fixes still install | `UPDATE_POLICY=security-only` (or `UPDATE_CHECK=false`) |

**Classifying failures matters as much as reporting them.** HTTP errors, TLS errors, timeouts and a
body that is not a DSSE envelope at all (a captive portal, a proxy's error page) are *transport*
failures: quiet, retried, and counted toward "stale". A well-formed envelope that then fails any
check is a *verification* failure: loud, immediately. Getting this wrong in either direction is
harmful — cry wolf and people learn to ignore red; stay quiet and an attack goes unseen.

**What the tray never says:** "download it manually instead", or anything else that teaches a user
to route around a failed verification.

---

## 9. No bypass: explicit rules

These are requirements on the implementation, and each should have a test.

1. **No input changes trust.** No command-line flag, environment variable, `.env` key, registry value,
   marker file or build define changes which keys are trusted, skips a check, lowers a threshold, or
   permits installing an unverified file. There is no "development" or "debug" flavour of the updater
   with checks relaxed.
2. **Root keys and URLs are constants in the source.** The verification module takes keys as
   function arguments so its tests can supply a test hierarchy; the production entrypoint has no
   parameter, variable or file through which to supply them. Development testing uses that test
   hierarchy against a local server, driven by the test harness.
3. **Failure is terminal for the run.** No fall-through to "install anyway", to asking the user
   whether to proceed, or to the old notifier path.
4. **TLS validation is never disabled.** The updater clears `NODE_TLS_REJECT_UNAUTHORIZED` and
   `NODE_OPTIONS` in its own process. To work behind TLS-intercepting corporate proxies it uses the
   Windows certificate store (Node's system-CA support; confirm the bundled Node version has it) —
   adding a CA, never removing validation. TLS is defence in depth; no signature check depends on it.
5. **Rollback only ever uses the local known-good cache**, re-verified against its recorded hash.
6. **The Authenticode latch cannot be cleared**, including by a root-signed key set.

---

## 10. Release signing ceremony

Per release, and at least every 30 days as a refresh (same steps, new `sequence`/`issued`/`expires`,
same `release` block).

**On a networked workstation** (not the signing device):

1. Confirm the tag's commit is on `main`: `git merge-base --is-ancestor v<ver> origin/main`.
2. Read `git log --oneline v<last signed>..v<ver>` and the diff summary. Do not sign a release you
   cannot explain.
3. Download the release artifact and its `.sha256`; compute SHA-256 and size; they must match.
4. Verify provenance, pinned to this repository, the release workflow and the tag — for example
   `gh attestation verify <file> -R JINA-CODE-SYSTEMS/tally-mcp-server --signer-workflow JINA-CODE-SYSTEMS/tally-mcp-server/.github/workflows/release.yml --source-ref refs/tags/v<ver>`
   (flag names to be confirmed against the `gh` version in use).
5. After #175: `Get-AuthenticodeSignature` is `Valid` and matches the policy in `keys.json`.
6. Generate the **unsigned** payload with a script that takes only these verified values plus
   `security_floor`, `blocked_versions` and `advisory`; copy it to removable media.

**On the signing device** (offline):

7. The signing script renders the payload in plain language — version, hash, size, floor, blocked
   versions, expiry — and requires the signer to type the version to confirm. It signs, writes the
   DSSE envelope, and verifies the envelope against the current `keys.json` before finishing.

**Back on the workstation:**

8. Verify the envelope with the same verification module the client uses, commit it under
   `site/update/v1/stable/manifest.json` in a pull request, and merge; the Pages workflow publishes it.
9. The monitor job confirms the live manifest verifies, matches the commit, and its artifact still
   matches the release asset.

Root ceremonies (`keys.json` changes) follow the same shape, signed with the root key on the same
signing laptop by its single holder. Once root moves to 2 of 3, holders sign in turn on their own
devices and pass the envelope between them on removable media.

---

## 11. Testing requirements

Before any build with an updater is released:

- **Known-answer tests** for the DSSE pre-authentication encoding and Ed25519 verification, using
  fixed vectors.
- **Negative tests, each must reject:** bad signature; valid signature by an unknown key; by a revoked
  key; by an expired release key; the same key's signature duplicated to fake a threshold; threshold
  not met; wrong `payloadType`; `payloadType` and `type` disagreeing; a key set signed where a
  manifest is expected and vice versa; wrong `channel`; lower `sequence`; equal `sequence` with
  different bytes; expired manifest; `issued` beyond skew; `min_keys_version` above the trusted key
  set; key-set `version` rollback; a key-set version gap; root rotation signed only by the old roots,
  or only by the new ones; `keyid` not matching `public_key`; prerelease version on stable; version
  not above installed; installed below `upgrade_from_min`; artifact short by one byte and long by
  one byte; hash mismatch; oversized metadata; Authenticode required but unsigned; signed by the
  wrong subject or CA; latch cleared by a later key set.
- **Protocol tests:** the lease/drain ordering under interleaving; stale-lease handling; drain
  deadline expiry; deferral after a held lease.
- **Apply tests** in both modes on a real Windows VM: success; health-check failure → rollback;
  rollback failure → stops without looping; upgrade preserves `.env`, the Tally paths and the GUI
  agent's user.
- **A no-bypass test** asserting that the production entrypoint accepts no key, threshold, URL or
  skip input.
- **The compromise drill** from [threat model §7.4](update-channel-threat-model.md#74-key-compromise-response),
  run end to end against a test key hierarchy: revoke a release key, rotate root, block a version.

---

## 12. Prerequisites found in the current code

Things that would make the updater unsafe or wrong if built on today's code as-is. To verify and fix
as part of the implementation, not in this PR.

1. **Resolved in [#231](https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/pull/231)** (unattended upgrade mode; [installer.md](../installer.md#unattended-upgrade-and-silent-installs)). **A silent install run as SYSTEM appears to overwrite configuration.** In `tally-mcp.iss`, the
   wizard fields are filled with auto-detected defaults (not the previous install's values), and the
   GUI-agent user defaults to `GetUserNameString()` — under the SYSTEM account that is `SYSTEM`. The
   `[Run]` entry passes these to `firstrun-config.ps1`, which prefers a passed value over the one in
   `.env`. A silent, SYSTEM-run update would therefore seem to reset a non-default Tally path and
   re-register `TallyMCPAgent` for SYSTEM, where it cannot drive the user's Tally window. The updater
   needs an explicit update mode in which the installer passes no wizard values, so
   `firstrun-config.ps1`'s existing preserve-on-reconfigure path applies.
2. **The tray's GitHub-API notifier** should be retired in the release that ships the updater, so
   the tray does not show two answers from two sources, one of them unauthenticated.
3. **`cloudflared` is downloaded from `releases/latest` with no pinned version or hash** in
   `build-installer.ps1`, and the NSSM hash check is skipped when the `NSSM_SHA256` variable is
   unset. Both are CI build inputs (A3) that end up in a SYSTEM service; they should be pinned the
   way Node already is. Independent of the updater, but the ceremony's provenance check cannot catch
   a poisoned upstream binary.
4. **An Event Log source** needs registering at install time for [§8](#8-failure-surfacing).
5. **The uninstaller** should remove `{app}\update\` and `%ProgramData%\Claudally\update\`, and
   unregister `TallyMCPUpdate`.

---

## 13. Owner decisions

Answered by the owner on 2026-09-28. Numbering follows the questions as they were put.

1. **Local mode and a SYSTEM task — yes.** Local mode uses the short-lived daily SYSTEM scheduled
   task `TallyMCPUpdate`, like remote mode. It is an exception to "nothing running while you are not
   working" and customer-facing text says so. The UAC-prompt-per-update alternative is not adopted.
2. **Default policy.** Security updates always install automatically; feature updates surface in the
   tray for consent. `UPDATE_CHECK=false` stops feature updates only — never security updates
   ([§7.1](#71-who-runs-the-updater)).
3. **Local-mode deadline.** A security update waits up to **24 hours** while Claude Desktop is open,
   then installs after a **5-minute** tray countdown, through the drain protocol. (The proposal said a
   10-minute countdown; the owner chose 5.)
4. **Remote-mode feature updates.** Same policy as decision 2: tray consent. `all-auto` is not
   adopted.
5. **Key holders.** A **single holder** — the lead maintainer — for root and release, not 2 of 3.
   Loss is covered by an encrypted offline backup in a separate physical location; theft is not
   covered and is an accepted residual risk. Revisit when there is a second trusted person at Jina or
   the install count grows ([threat model §5.3](update-channel-threat-model.md#53-thresholds-decided-a-single-holder-for-now)).
6. **Custody hardware.** Passphrase-encrypted keys on a **dedicated offline (air-gapped) laptop** used
   only for signing, with full-disk encryption, never networked; backup on a separate encrypted drive
   stored elsewhere. Hardware tokens declined for now
   ([threat model §5.4](update-channel-threat-model.md#54-custody-decided-an-offline-signing-laptop)).
7. **Freeze window.** Accepted as proposed: manifest expiry 45 days, re-signed at least every
   30 days.
8. **Hosting.** The manifest and key sets are hosted on the existing site,
   `claudally.jinacode.systems` (GitHub Pages, from this repository's `site/`); installers stay on
   GitHub Releases. Hosting is not a trust input (A1); the monitor in
   [threat model §6](update-channel-threat-model.md#6-the-release-signing-ceremony) is how a
   tampered host is noticed.
9. **Failure reporting.** No phone-home on a rejected update. The tray (and the event log) shows it
   locally.
10. **Authenticode (#175).** Where signing happens and which subject the certificate carries are
    decided when the #175 certificate is bought; the signer policy in `keys.json` follows from that.
