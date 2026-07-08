# Tally MCP Server - Windows Installer

A double-click installer that takes a Windows box from "nothing installed" to
"TallyMCP fully running" in under 5 minutes. Tracks issue
[#18](https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/issues/18).

## What it does

1. Unpacks `dist/`, `scripts/`, prebuilt `TallyUI.dll`, portable Node.js, `nssm.exe`, and `cloudflared.exe` to `C:\Program Files\TallyMCP\`.
2. Runs a wizard that collects:
   - OAuth password (`PASSWORD`, min 12 chars)
   - Tally edition (Silver / Gold)
   - Tally exe / data / ini paths (auto-detected; user can override)
   - Public domain / Cloudflare Tunnel hostname (blank = localhost-only)
   - Cloudflare Tunnel token (optional — enables the tunnel path below)
   - Windows user the GUI agent runs as
3. Writes `.env` from the collected values.
4. Registers the `TallyMCP` Windows service via the bundled NSSM, pointing at the bundled
   `node-portable\node.exe` (no system Node required).
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
- runs `npm install` + `npm run build` (so `dist/` is fresh)
- compiles `scripts/TallyUI.dll` from `TallyUI.cs` (so the installer ships
  a prebuilt DLL — clients don't need `csc.exe`)
- downloads portable Node.js + NSSM into `installer-staging/`
- invokes `ISCC.exe` on `scripts/installer/tally-mcp.iss`
- emits `dist-installer/TallyMCP-Setup-<version>.exe`

For repeat builds, drop the `-DownloadDeps` flag — Node + NSSM will be
reused from `installer-staging/`.

To iterate just on the wizard without rebuilding the project:

```powershell
.\scripts\installer\build-installer.ps1 -SkipBuild
```

## Files

| Path | Purpose |
|------|---------|
| `scripts/installer/tally-mcp.iss`       | Inno Setup script (sources, dirs, wizard, [Run] / [UninstallRun]) |
| `scripts/installer/build-installer.ps1` | Build orchestrator (npm build → dep staging → ISCC) |
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
