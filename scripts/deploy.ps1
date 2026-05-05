<#
.SYNOPSIS
    Deploy the latest origin/main to a running TallyMCP Windows service.

.DESCRIPTION
    Pulls, optionally reinstalls dependencies, rebuilds, and restarts the service.
    Halts on any error rather than leaving a half-deployed state.

    Must be run from an elevated (admin) PowerShell — Restart-Service requires it.

.PARAMETER ServiceName
    Name of the Windows service. Defaults to "TallyMCP".

.PARAMETER InstallDir
    Repo root on disk. Defaults to "C:\tally-mcp-server".

.PARAMETER SkipInstall
    Skip `npm install`. Use when you know package.json hasn't changed (~10s saved).

.PARAMETER NoRestart
    Pull and build but don't restart the service. Use when staging a deploy
    you'll restart later.

.EXAMPLE
    .\scripts\deploy.ps1
    Standard deploy: pull, install, build, restart.

.EXAMPLE
    .\scripts\deploy.ps1 -SkipInstall
    Quick deploy when only source files changed.
#>
[CmdletBinding()]
param(
    [string]$ServiceName = 'TallyMCP',
    [string]$InstallDir  = 'C:\tally-mcp-server',
    [switch]$SkipInstall,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$startedAt = Get-Date

function Step {
    param([string]$Label, [scriptblock]$Block)
    $stepStart = Get-Date
    Write-Host "==> $Label" -ForegroundColor Cyan
    & $Block
    $elapsed = [int]((Get-Date) - $stepStart).TotalSeconds
    Write-Host "    done in ${elapsed}s" -ForegroundColor DarkGray
}

# Sanity: must be admin to restart a service
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $NoRestart -and -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Must be run from an admin PowerShell (Restart-Service requires elevation). Re-run as administrator, or pass -NoRestart to skip the restart step."
}

if (-not (Test-Path $InstallDir)) {
    Write-Error "InstallDir '$InstallDir' does not exist."
}
Set-Location $InstallDir
Write-Host "Deploying $ServiceName from $InstallDir"
Write-Host ""

Step "git pull origin main" {
    git pull origin main
    if ($LASTEXITCODE -ne 0) { throw "git pull failed (exit $LASTEXITCODE)" }
}

if (-not $SkipInstall) {
    Step "npm install" {
        npm install --silent
        if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
    }
} else {
    Write-Host "==> npm install (skipped)" -ForegroundColor DarkGray
}

Step "npm run build" {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)" }
}

if ($NoRestart) {
    Write-Host "==> Restart-Service (skipped, -NoRestart)" -ForegroundColor DarkGray
} else {
    Step "Restart-Service $ServiceName" {
        Restart-Service -Name $ServiceName -Force
        # Wait briefly for the new process to bind, then confirm
        Start-Sleep -Seconds 3
        $svc = Get-Service -Name $ServiceName
        if ($svc.Status -ne 'Running') {
            throw "Service status is $($svc.Status), expected 'Running'. Check logs/service-*.log for the error."
        }
    }
}

$totalElapsed = [int]((Get-Date) - $startedAt).TotalSeconds
Write-Host ""
Write-Host "Deploy complete in ${totalElapsed}s." -ForegroundColor Green
if (-not $NoRestart) {
    Write-Host "Service '$ServiceName' is running. Smoke-test with:" -ForegroundColor Green
    Write-Host "  curl.exe -i http://127.0.0.1:3000/.well-known/oauth-protected-resource"
}
