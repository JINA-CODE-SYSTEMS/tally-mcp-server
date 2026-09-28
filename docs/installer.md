# Tally MCP Server - Windows Installer

A double-click installer that takes a Windows box from "nothing installed" to
"TallyMCP fully running" in under 5 minutes. Tracks issue
[#18](https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/issues/18).

## What it does

1. Unpacks `dist/`, `scripts/`, prebuilt `TallyUI.dll`, portable Node.js, `nssm.exe`, and `cloudflared.exe` to `C:\Program Files\TallyMCP\`.
2. Runs a wizard that collects:
   - Tally exe / data / ini paths (auto-detected; user can override)
   - Tally edition (Silver / Gold)
   - Windows user the GUI agent runs as
   - Whether Claude may drive the Tally window (screenshots + keystrokes) - on by default

   New installs are **local** (`DEPLOYMENT_MODE=local`). No OAuth password is collected, because
   there is no listener to gate. Remote access is not currently offered by the installer
   ([#192](https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/issues/192)); an existing remote
   install keeps its mode, password, domain and service across an upgrade, because the wizard
   passes no mode at all and `firstrun-config.ps1` preserves whatever the install already has.
3. Writes `.env` from the collected values. In local mode `PASSWORD`, `BIND_HOST`, `MCP_DOMAIN` and
   `TUNNEL_TOKEN` are not written at all.
4. **Remote mode only:** registers the `TallyMCP` Windows service via the bundled NSSM, pointing at
   the bundled portable Node (no system Node required). A local install registers no service -
   Claude starts the stdio entrypoint on demand - and instead writes the entry into the user's
   `claude_desktop_config.json`, merging into it rather than replacing it.
5. **If a Cloudflare Tunnel token was supplied**, registers a second NSSM service `TallyMCPTunnel`
   running the bundled `cloudflared` so the box gets a stable public HTTPS URL with no router/domain
   config (the MCP server then binds loopback-only — cloudflared connects to it on `127.0.0.1`).
6. Registers the `TallyMCPAgent` scheduled task at-logon for the configured user.
7. Registers the `TallyMCPTray` scheduled task at-logon (status tray icon — issue #20).
8. Starts the service(s) and triggers both scheduled tasks immediately so the operator sees
   a working tray icon when the wizard finishes (rather than only after the next logon).

The uninstaller stops + removes the `TallyMCP` service (and `TallyMCPTunnel`
if it was configured), deletes the scheduled tasks, kills any leftover
`node.exe` / `cloudflared.exe`, and removes installed files. `.env` is
scrubbed and removed on uninstall (it holds the OAuth password and, when a
tunnel is configured, `TUNNEL_TOKEN`).

For the Cloudflare Tunnel path — what it's for, how Jina staff pre-provision a
tunnel per client, and where the token/hostname come from — see
[cloudflare-tunnel-provisioning.md](cloudflare-tunnel-provisioning.md).

## Building the installer

The installer is built on a Windows box with Inno Setup 6+ installed.

```powershell
# From the repo root, in an admin PowerShell:
.\scripts\installer\build-installer.ps1 -DownloadDeps
```

That:
- runs `npm ci --ignore-scripts` + `npm run build` (so `dist/` is fresh, built from the lockfile,
  with no dependency lifecycle scripts — none are needed; see the comment in the script)
- compiles `scripts/TallyUI.dll` from `TallyUI.cs` (so the installer ships
  a prebuilt DLL — clients don't need `csc.exe`)
- downloads portable Node.js, NSSM and `cloudflared` into `installer-staging/`,
  each pinned to an exact version and SHA-256 (see below)
- invokes `ISCC.exe` on `scripts/installer/tally-mcp.iss`
- emits `dist-installer/Claudally-Setup-<version>.exe`

For repeat builds, drop the `-DownloadDeps` flag — Node, NSSM and `cloudflared`
will be reused from `installer-staging/` (and re-verified against their pins).

### Pinned dependencies

Every third-party binary the installer ships is pinned in the **"Pinned build inputs"** block at
the top of `scripts/installer/build-installer.ps1`: an exact version, its download URL, and a
committed SHA-256. The build fails — it does not warn — if a pin is missing or malformed, or if a
downloaded *or hand-placed* file does not match. There is no parameter or CI variable to override
a pin; changing one is a reviewed commit.

| Input | Pinned | Checked |
|-------|--------|---------|
| Node.js portable (win-x64) | `build-installer.ps1` | the zip before it is expanded, then `node-portable\node.exe` |
| NSSM | `build-installer.ps1` | the zip, then the staged `nssm.exe` (win64) |
| `cloudflared` | `build-installer.ps1` | `cloudflared.exe` (versioned release URL, never `latest`) |
| Inno Setup compiler (CI/release) | `install-innosetup.ps1` | the Inno Setup installer before it runs |

**Offline / air-gapped builds.** Put the pinned files in `installer-staging/` by hand —
`node-v<ver>-win-x64.zip`, `nssm-<ver>.zip`, and `cloudflared.exe` (the
`cloudflared-windows-amd64.exe` release asset, renamed) — and run with `-DownloadDeps`. Files that are
already present and match are used without touching the network; anything that doesn't match is
rejected. A hand-populated `node-portable\` or `nssm.exe` is also accepted, as long as `node.exe` /
`nssm.exe` match their pins (NSSM must be `win64\nssm.exe` from the pinned zip — the 2.24-101
pre-release builds that Chocolatey/Scoop/winget ship will not match).

#### Bumping a pinned dependency

Change the version **and** the hash in the same commit, and record in the comment beside the pin
where the hash came from and what you cross-checked it against. Never take a hash from the same
download you are checking it against and call it verified — corroborate it:

- **Node.js** — take the `node-v<ver>-win-x64.zip` and `win-x64/node.exe` lines from
  `https://nodejs.org/dist/v<ver>/SHASUMS256.txt`, and verify that file's signature
  (`SHASUMS256.txt.asc`) with `gpg --verify` against a releaser key listed in the
  [nodejs/node README](https://github.com/nodejs/node#release-keys) (keys are in
  [nodejs/release-keys](https://github.com/nodejs/release-keys)). Bump `package.json`'s
  `engines.node` alongside, and read the Node notes above the pin first.
- **cloudflared** — use a stable release from
  [cloudflare/cloudflared releases](https://github.com/cloudflare/cloudflared/releases). The
  release notes list a SHA256 for `cloudflared-windows-amd64.exe`; confirm it matches the asset
  digest GitHub shows (`gh api repos/cloudflare/cloudflared/releases/tags/<ver> --jq '.assets[] | select(.name=="cloudflared-windows-amd64.exe") | .digest'`),
  download the versioned asset, hash it, and check `Get-AuthenticodeSignature` reports a valid
  signature from "Cloudflare, Inc.".
- **NSSM** — nssm.cc publishes no SHA-256 and no signature, and `nssm.exe` is unsigned, so this is
  the weakest link: hash the zip you download, then corroborate it with at least one independent
  record made *before* you looked — the SHA-1 nssm.cc lists on its download page, and the checksum
  in the Chocolatey `nssm` package for that exact zip (`chocolateyInstall.ps1` or
  `legal/VERIFICATION.txt` in the `.nupkg`). Pin `win64\nssm.exe` from inside that zip as well. If
  you cannot corroborate a new NSSM hash, do not bump.
- **Inno Setup** — `scripts/installer/install-innosetup.ps1`. Take the SHA-256 GitHub shows for
  the installer asset on [jrsoftware/issrc releases](https://github.com/jrsoftware/issrc/releases),
  cross-check it against the Chocolatey `innosetup` package's `legal/VERIFICATION.txt`, and check
  the Authenticode signature. Staying on 6.x matters: the scripts look for "Inno Setup 6".

After bumping, run a full `build-installer.ps1 -DownloadDeps` locally: it prints each verified
hash, and a mistyped pin fails there rather than in the release job.

To iterate just on the wizard without rebuilding the project:

```powershell
.\scripts\installer\build-installer.ps1 -SkipBuild
```

### Checking the script without building

CI compiles the `.iss` on every PR against a tree of stub files, so the Pascal Script and every
section are checked in seconds without downloading a portable Node. Run the same check locally:

```powershell
.\scripts\installer\check-iss.ps1
```

It fails on ISCC warnings as well as errors. What no compiler can check - wizard page `Values[]`
indices, interactivity, privilege boundaries, upgrade paths - is in
[installer-manual-test.md](installer-manual-test.md).

## Files

| Path | Purpose |
|------|---------|
| `scripts/installer/tally-mcp.iss`       | Inno Setup script (sources, dirs, wizard, [Run] / [UninstallRun]) |
| `scripts/installer/build-installer.ps1` | Build orchestrator (npm build → pinned, hash-verified dep staging → ISCC) |
| `scripts/installer/install-innosetup.ps1` | Installs the pinned, hash-verified Inno Setup compiler (CI and release) |
| `scripts/installer/firstrun-config.ps1` | Post-install: writes .env, registers service (+ optional `TallyMCPTunnel` cloudflared service) + agent task + tray task, starts them |
| `scripts/installer/uninstall-cleanup.ps1` | Pre-uninstall: stops the service(s) incl. `TallyMCPTunnel`, removes NSSM entries, deletes both scheduled tasks |
| `scripts/installer/test-firstrun-config.ps1` | Tests `firstrun-config.ps1` (above all `-Upgrade`) against fake install roots with every service/task/ACL call stubbed; run in CI |
| `scripts/tray/tally-mcp-tray.ps1`       | Status tray icon (issue #20). WinForms NotifyIcon + polling loop. |

## Re-configuring an installed instance

Start Menu → "Tally MCP Server" → "Reconfigure Tally MCP Server" launches
`firstrun-config.ps1` again with new wizard inputs. The script is
idempotent: it stops + re-registers the service so settings actually take
effect.

## Unattended upgrade and silent installs

The daily `TallyMCPUpdate` task ([#177](https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/issues/177),
[update-manifest.md §7](dev/update-manifest.md#7-applying-an-update)) applies updates by running
this installer silently, as SYSTEM, in both deployment modes. Nobody is there to answer the wizard,
so the installer must not treat the wizard's pre-filled defaults as answers. Before this mode
existed it did: a silent run over an install passed auto-detected Tally paths, edition Silver, a
GUI-control choice remembered from the *original* install, and the running account as the agent
user to `firstrun-config.ps1`, where passed values win over `.env`. Run as SYSTEM it never got that
far - it hung on an error dialog nobody could see.

### Which run is which

"Existing install" means the target folder has a `.env` (what `firstrun-config.ps1` writes).

| How Setup is run | Existing install? | Result |
|---|---|---|
| `/SILENT` or `/VERYSILENT` | yes | **Unattended upgrade** |
| with `/UPDATE` (silent or not) | yes | **Unattended upgrade** |
| with `/UPDATE` | no | Refused, exit code 7. `/UPDATE` never creates an install |
| `/SILENT` or `/VERYSILENT` | no | New install. **Requires `/AGENTUSER=<user>`**; refused with exit code 7 without it |
| interactive | either | The wizard, as before |

### What an unattended upgrade keeps

It skips every settings page, passes no settings, and runs `firstrun-config.ps1 -Upgrade`, which:

- **never writes `.env`.** Every line stays byte-for-byte as it was, including keys the installer
  does not know about (`TALLY_PORT`, `CORS_ORIGINS`, `READONLY_MODE`, anything added by hand or by
  the tray). No password is read, prompted for, or passed.
- **takes the GUI-agent user from `AGENT_TASK_USER` in `.env`**, or, for an install that predates
  that key, from the existing `TallyMCPAgent` task. Never from the account running Setup. It
  refuses if the two disagree, if neither exists, or if the answer is SYSTEM, LocalService,
  NetworkService or a computer account.
- **never changes the deployment mode.** `DEPLOYMENT_MODE` is read, not written; an install from
  before the key existed is remote, as on every run, and its `.env` stays keyless.
- **re-registers what exists, and creates nothing new.** The `TallyMCP` and `TallyMCPTunnel`
  services and the `TallyMCPAgent` and `TallyMCPTray` tasks are each re-registered with the same
  identity (same user, same token from `.env`) so the new release's definition applies, then
  restarted - they were stopped to replace their files. One that did not exist before is not
  created; the log says so. What `.env` rules out is still removed, as on every run: a `TallyMCP`
  service in local mode, a tunnel with no `TUNNEL_TOKEN`.
- **leaves the Claude client configuration alone**, unless the install has moved (the existing
  agent task points at a different folder), in which case it is rewritten for the agent user.
- re-applies the NTFS lockdown on `.env`, the company registry and the IPC directory, for the same
  user.

To *change* a setting, use Reconfigure or run the installer interactively; an unattended upgrade
never will.

**Not covered: interactive upgrades.** Run by hand over an existing install, the wizard still
pre-fills auto-detected defaults (Tally paths, edition Silver, the current account) and the
GUI-control choice from the *previous wizard run* rather than from `.env`, and clicking through
applies them - including undoing a GUI-control change made from the tray. That is the pre-existing
behaviour, left for a follow-up that pre-fills the wizard from `.env`.

### Order of events, and exit codes

1. **Preflight.** Before anything is stopped or copied, `PrepareToInstall` runs *this* version's
   `firstrun-config.ps1 -Upgrade -PreflightOnly`, which works out everything above and changes
   nothing. If it cannot keep every setting, Setup stops with **exit code 7** and the reason in its
   log, and the running version is untouched.
2. Services and tasks are stopped, files are replaced.
3. `firstrun-config.ps1 -Upgrade` runs. If it fails, Setup exits with **code 10**: the new files are
   in place but services or tasks may be stopped - the caller must roll back. Its own log is
   `{app}\logs\firstrun-config.log`.

| Exit code | Meaning | Updater action |
|---|---|---|
| 0 | Upgraded; every setting kept | Health check ([update-manifest.md §7.4](dev/update-manifest.md#74-behaviour-per-deployment-mode)) |
| 7 | Refused before anything changed (no existing install, or preflight refused) | Report; do not roll back - nothing changed |
| 10 | Files replaced, reconfiguration failed | Roll back |
| any other | An Inno Setup failure ([Setup exit codes](https://jrsoftware.org/ishelp/index.php?topic=setupexitcodes)) | Roll back if files may have changed (4, 5) |

### How the updater invokes it

```
Claudally-Setup-<v>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /UPDATE /LOG="%ProgramData%\Claudally\update\logs\install-<v>.log"
```

Always pass `/UPDATE`, even though silent-over-an-existing-install is already an upgrade: it turns
"the install is not where I expected" into a refusal (exit 7) instead of an attempt at a new
install. Keep the `/LOG`: the preflight's reason for a refusal is written there.

### Silent new install

```
Claudally-Setup-<v>.exe /VERYSILENT /SUPPRESSMSGBOXES /AGENTUSER=<windows user who uses Tally>
```

A silent install onto a machine with nothing installed has nobody to ask whose desktop Tally is
on, and the only guess available - the account running Setup - is wrong in exactly the cases that
run silently (SYSTEM under a deployment tool, an IT admin who never opens Tally). So it is told, or
it refuses. `/AGENTUSER` must be an existing local account (`DOMAIN\user` is accepted and checked by
`firstrun-config.ps1`), and not a service or computer account. Everything else takes the wizard's
defaults - auto-detected Tally paths, Silver, GUI control on, local mode - and can be changed
afterwards with Reconfigure. On an interactive install `/AGENTUSER` just pre-fills the field.

## Why Inno Setup, not WiX

Inno Setup is approachable: single `.iss` script, easy to maintain, handles
95% of typical install needs out of the box. WiX is the "correct" answer for
enterprise deployment but has a steep XML learning curve and is overkill for
v1. Output is a single `.exe`, fine for direct download. We can add a
WiX/MSI build later if a client needs it for SCCM/GPO managed deployment.

## What's intentionally out of scope (v1)

- **Code signing for SmartScreen.** Costs $300-500/yr for an EV cert; defer
  until we have paying clients on Windows boxes that block unsigned
  executables.
- **Auto-update on the installer side.** Tied to issue #15's agent update
  story — orthogonal concern.
- **macOS / Linux installers.** Tally is Windows-only.
- **Group Policy deployment templates** (`.admx` / `.adml`). Add when
  enterprise demand surfaces.
- **Bundling Caddy / a TLS terminator.** The MCP server binds to
  `127.0.0.1:3000`; let the customer terminate TLS upstream however they
  already do (Caddy, IIS, Cloudflare Tunnel).
