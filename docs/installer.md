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
| `scripts/tray/tally-mcp-tray.ps1`       | Status tray icon (issue #20). WinForms NotifyIcon + polling loop. |

## Re-configuring an installed instance

Start Menu → "Tally MCP Server" → "Reconfigure Tally MCP Server" launches
`firstrun-config.ps1` again with new wizard inputs. The script is
idempotent: it stops + re-registers the service so settings actually take
effect.

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
