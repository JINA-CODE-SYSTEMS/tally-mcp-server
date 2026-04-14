# ============================================================
# Tally MCP Server - Windows VM Setup Script
# Run this ONCE on the Windows VM via RDP (as Administrator)
# ============================================================

param(
    [string]$InstallDir = "C:\tally-mcp-server",
    [string]$NodePath = "C:\Program Files\nodejs\node.exe",
    [string]$ServiceName = "TallyMCP"
)

$ErrorActionPreference = "Stop"

# --- Step 1: Verify Node.js ---
if (-not (Test-Path $NodePath)) {
    Write-Error "Node.js not found at $NodePath. Install Node.js >= 21 first."
    exit 1
}
$nodeVersion = & $NodePath --version
Write-Host "[OK] Node.js $nodeVersion found" -ForegroundColor Green

# --- Step 2: Install NSSM ---
$nssmPath = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssmPath) {
    Write-Host "[*] Installing NSSM via winget..." -ForegroundColor Yellow
    winget install --id nssm.nssm --accept-source-agreements --accept-package-agreements
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $nssmPath = (Get-Command nssm -ErrorAction SilentlyContinue).Source
    if (-not $nssmPath) {
        Write-Error "NSSM install failed. Download manually from https://nssm.cc/download and add to PATH."
        exit 1
    }
}
Write-Host "[OK] NSSM found at $nssmPath" -ForegroundColor Green

# --- Step 2b: Compile TallyUI.dll (Win32 interop for GUI agent) ---
$cscPath = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$csFile = Join-Path $InstallDir "scripts\TallyUI.cs"
$dllFile = Join-Path $InstallDir "scripts\TallyUI.dll"
if (Test-Path $csFile) {
    Write-Host "[*] Compiling TallyUI.dll..." -ForegroundColor Yellow
    & $cscPath /nologo /target:library /reference:System.Drawing.dll /out:$dllFile $csFile
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] TallyUI.dll compiled" -ForegroundColor Green
    } else {
        Write-Host "[WARN] TallyUI.dll compilation failed" -ForegroundColor Red
    }
}

# --- Step 3: Verify repo exists ---
if (-not (Test-Path "$InstallDir\dist\server.mjs")) {
    Write-Error "Server entry point not found at $InstallDir\dist\server.mjs. Clone the repo and build first:
    cd C:\
    git clone https://github.com/jain-t/tally-mcp-server.git
    cd tally-mcp-server
    npm install
    npx tsc"
    exit 1
}
Write-Host "[OK] Server found at $InstallDir" -ForegroundColor Green

# --- Step 4: Install NSSM service ---
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Host "[*] Service '$ServiceName' already exists. Removing and re-installing..." -ForegroundColor Yellow
    nssm stop $ServiceName 2>$null
    nssm remove $ServiceName confirm
}

nssm install $ServiceName $NodePath "$InstallDir\dist\server.mjs"
nssm set $ServiceName AppDirectory $InstallDir
nssm set $ServiceName Description "Tally Prime MCP Server - Model Context Protocol"
nssm set $ServiceName Start SERVICE_AUTO_START
nssm set $ServiceName AppStdout "$InstallDir\logs\service.log"
nssm set $ServiceName AppStderr "$InstallDir\logs\service.log"
nssm set $ServiceName AppRotateFiles 1
nssm set $ServiceName AppRotateOnline 1
nssm set $ServiceName AppRotateSeconds 86400
nssm set $ServiceName AppRotateBytes 5242880
nssm set $ServiceName AppStdoutCreationDisposition 4
nssm set $ServiceName AppStderrCreationDisposition 4

# Create logs directory
New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null

# Load .env variables into service environment if .env exists
if (Test-Path "$InstallDir\.env") {
    $envVars = @()
    Get-Content "$InstallDir\.env" | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $envVars += $line
        }
    }
    if ($envVars.Count -gt 0) {
        $envString = $envVars -join "`n"
        nssm set $ServiceName AppEnvironmentExtra $envString
        Write-Host "[OK] Loaded $($envVars.Count) env vars from .env" -ForegroundColor Green
    }
}

Write-Host "[OK] Service '$ServiceName' installed" -ForegroundColor Green

# --- Step 5: Start the service ---
nssm start $ServiceName
Write-Host "[OK] Service '$ServiceName' started" -ForegroundColor Green

# --- Step 6: Verify ---
Start-Sleep -Seconds 3
$svc = Get-Service -Name $ServiceName
if ($svc.Status -eq "Running") {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host " Tally MCP Server is running as service" -ForegroundColor Cyan
    Write-Host " Service: $ServiceName" -ForegroundColor Cyan
    Write-Host " Status:  $($svc.Status)" -ForegroundColor Cyan
    Write-Host " Logs:    $InstallDir\logs\" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
} else {
    Write-Warning "Service status: $($svc.Status). Check logs at $InstallDir\logs\"
}

Write-Host ""
Write-Host "Useful commands:" -ForegroundColor Yellow
Write-Host "  nssm status $ServiceName     # Check status"
Write-Host "  nssm restart $ServiceName    # Restart"
Write-Host "  nssm stop $ServiceName       # Stop"
Write-Host "  nssm edit $ServiceName       # Edit config (GUI)"
