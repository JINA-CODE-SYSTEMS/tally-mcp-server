# Local dev runner - spawns all TallyMCP components from source, no installer needed.
# By default each piece runs in its own visible PowerShell window so you can read logs and
# Ctrl+C any one without taking the others down. Pass -Silent to hide the windows for a
# production-like feel (use `npm run dev:stop` to kill the hidden processes afterwards).
#
# RUN:
#   npm run dev                                                # visible windows
#   npm run dev -- -Silent                                     # hidden windows, prod-like
#   npm run dev -- -NoTray -NoAgent                            # just TS watcher + server
#   powershell -ExecutionPolicy Bypass -File scripts\dev-run-local.ps1
#
# FLAGS:
#   -Silent    Hide all spawned windows. Stop with `npm run dev:stop`.
#   -NoAgent   Skip the GUI agent (use when not driving Tally).
#   -NoTray    Skip the tray icon (use when you don't want a tray indicator).
#   -NoBuild   Skip the initial tsc compile.
#
# WHAT THE INSTALLER NORMALLY DOES THAT WE SKIP HERE:
#   - Registers an NSSM Windows service for the Node server (we run `node --watch` directly)
#   - Registers a scheduled task for the GUI agent (we spawn the .ps1 directly)
#   - Registers a scheduled task for the tray (we spawn the .ps1 directly)
#   - Writes .env from wizard answers + locks down the registry file ACL
# The tray will show RED status for "service" / "agent task" because it's looking for the
# installer-registered NSSM service and scheduled task - those genuinely aren't running in
# dev mode. The tray icon and dashboard window still appear and most actions still work
# (Open logs, Launch Tally, status of node + tally processes).

param(
    [switch]$Silent,
    [switch]$NoAgent,
    [switch]$NoTray,
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $repoRoot

Write-Host ""
Write-Host "=== TallyMCP local dev ===" -ForegroundColor Cyan
Write-Host "Repo: $repoRoot"
if ($Silent) { Write-Host "Mode: SILENT (windows hidden - stop with 'npm run dev:stop')" -ForegroundColor DarkGray }
Write-Host ""

# .env must exist for the server to start (server.mts hard-fails without PASSWORD).
$envFile = Join-Path $repoRoot '.env'
if (-not (Test-Path $envFile)) {
    if (-not (Test-Path "$repoRoot\.env.example")) {
        throw "No .env or .env.example found in $repoRoot."
    }
    Copy-Item "$repoRoot\.env.example" $envFile
    Write-Host "[*] Created .env from .env.example" -ForegroundColor DarkGray
}

# Ensure PASSWORD is non-empty - server.mts exits 1 otherwise.
# Walk line-by-line so the match is reliable across `PASSWORD=`, `PASSWORD=    `, and
# `PASSWORD=    # comment` (the shape .env.example ships with). A real value like
# `PASSWORD=foo` (with or without a trailing comment) won't match and is left untouched.
$lines = Get-Content -Path $envFile
$changed = $false
$patched = foreach ($line in $lines) {
    if ($line -match '^\s*PASSWORD\s*=\s*(#.*)?$') {
        $changed = $true
        'PASSWORD=dev-local-do-not-use-in-prod'
    } else {
        $line
    }
}
if ($changed) {
    Set-Content -Path $envFile -Value $patched -Encoding UTF8
    Write-Host "[*] Injected dev PASSWORD into .env ('dev-local-do-not-use-in-prod')" -ForegroundColor DarkGray
    Write-Host "    For production use, edit .env and set a real password." -ForegroundColor DarkGray
}

# Make sure dist/ exists before node --watch tries to load it. Skippable if dist/ is current.
if (-not $NoBuild) {
    Write-Host "[*] Initial tsc build..." -ForegroundColor DarkGray
    npx tsc
    if ($LASTEXITCODE -ne 0) { throw "tsc build failed - fix errors before continuing" }
}

# Track PIDs of spawned windows so `npm run dev:stop` can find and kill them later.
# Lives in scripts/ so it sits next to the dev runner and the stop script.
$pidFile = Join-Path $repoRoot 'scripts\.dev-pids'
if (Test-Path $pidFile) { Remove-Item -Path $pidFile -Force }

function Start-DevWindow([string]$Label, [string]$Color, [string]$Command) {
    $banner = "Write-Host '=== $Label ===' -ForegroundColor $Color"
    $full = "cd '$repoRoot'; $banner; $Command"
    $args = @('-NoExit', '-NoProfile', '-Command', $full)
    $windowStyle = if ($Silent) { 'Hidden' } else { 'Normal' }
    $proc = Start-Process powershell -ArgumentList $args -WindowStyle $windowStyle -PassThru
    Add-Content -Path $pidFile -Value "$($proc.Id) $Label"
}

Start-DevWindow 'TS WATCHER' 'Magenta' 'npx tsc --watch'
Start-DevWindow 'MCP SERVER' 'Green'   'node --watch --env-file=.env dist/server.mjs'
if (-not $NoAgent) { Start-DevWindow 'GUI AGENT' 'Yellow' '& .\scripts\tally-gui-agent-v2.ps1' }
if (-not $NoTray)  { Start-DevWindow 'TRAY'      'Cyan'   "& .\scripts\tray\tally-mcp-tray.ps1 -InstallDir '$repoRoot'" }

Write-Host "[OK] Spawned:"
Write-Host "  - TS watcher  - rebuilds dist/ on every src/ save"
Write-Host "  - MCP server  - http://localhost:3000  (auto-restart on .mjs change)"
if (-not $NoAgent) { Write-Host "  - GUI agent   - types into Tally when commands arrive on IPC" }
if (-not $NoTray)  { Write-Host "  - Tray icon   - in system tray (service/agent indicators will show RED in dev mode)" }
Write-Host ""
Write-Host "Smoke test:"
Write-Host "  curl http://localhost:3000/.well-known/oauth-protected-resource"
Write-Host ""
if ($Silent) {
    Write-Host "Stop: npm run dev:stop  (kills processes listed in scripts/.dev-pids)"
} else {
    Write-Host "Stop: close the spawned windows, or 'npm run dev:stop' to kill them all at once."
}
Write-Host ""
