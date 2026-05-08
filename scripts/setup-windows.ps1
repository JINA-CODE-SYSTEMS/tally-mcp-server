# ============================================================
# Tally MCP Server - Windows VM Setup Script
# Run this ONCE on the Windows VM via RDP (as Administrator)
# ============================================================

param(
    [string]$InstallDir = "C:\tally-mcp-server",
    [string]$NodePath = "C:\Program Files\nodejs\node.exe",
    [string]$ServiceName = "TallyMCP",
    [string]$AgentTaskName = "TallyMCPAgent",
    [string]$TrayTaskName = "TallyMCPTray",
    [string]$AgentTaskUser = $env:USERNAME,
    [switch]$SkipAgentTask,
    [switch]$SkipTrayTask
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

# --- Step 7: Register the GUI agent as a Scheduled Task at logon ---
# Why: tally-gui-agent-v2.ps1 must run in the user's interactive desktop session (not Session 0)
# because it spawns and keystrokes into tally.exe. Manual launch survives only until the user
# logs out or closes the window. Registering at-logon makes the agent come back automatically
# after every reboot/login (issue #15 - agent persistence, option A).
if ($SkipAgentTask) {
    Write-Host "[*] Skipping GUI agent task registration (-SkipAgentTask)" -ForegroundColor DarkGray
} else {
    $agentScript = Join-Path $InstallDir "scripts\tally-gui-agent-v2.ps1"
    if (-not (Test-Path $agentScript)) {
        Write-Host "[WARN] Agent script not found at $agentScript - skipping at-logon registration" -ForegroundColor Yellow
    } else {
        Write-Host "[*] Registering GUI agent at logon for user '$AgentTaskUser'..." -ForegroundColor Yellow
        # Remove any prior registration so re-runs of this script are idempotent
        schtasks /Delete /TN $AgentTaskName /F 2>$null | Out-Null

        $taskAction = "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Minimized -File `"$agentScript`""
        # /RL LIMITED so the task runs with the user's normal token (admin keystrokes don't reach
        # non-elevated Tally windows due to UIPI, and Tally Prime ships unelevated by default).
        & schtasks /Create /TN $AgentTaskName /SC ONLOGON /RU $AgentTaskUser /RL LIMITED /TR $taskAction /F | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] Scheduled task '$AgentTaskName' registered (runs at logon, as $AgentTaskUser)" -ForegroundColor Green
            Write-Host "     The agent will start automatically on next logon. To start now without re-logging in:" -ForegroundColor DarkGray
            Write-Host "       schtasks /Run /TN $AgentTaskName" -ForegroundColor DarkGray
        } else {
            Write-Host "[WARN] schtasks /Create returned $LASTEXITCODE - register manually if needed" -ForegroundColor Yellow
        }
    }
}

# --- Step 8: Register the tray status app as a Scheduled Task at logon ---
# Why: a non-developer operator should be able to see TallyMCP health at a glance
# without running Get-Service / Get-ScheduledTask / Get-Process by hand. The tray
# polls every few seconds and surfaces a coloured icon plus a right-click action
# menu for restart / view-logs / launch-Tally / reconfigure (issue #20).
if ($SkipTrayTask) {
    Write-Host "[*] Skipping tray task registration (-SkipTrayTask)" -ForegroundColor DarkGray
} else {
    $trayScript = Join-Path $InstallDir "scripts\tray\tally-mcp-tray.ps1"
    if (-not (Test-Path $trayScript)) {
        Write-Host "[WARN] Tray script not found at $trayScript - skipping at-logon registration" -ForegroundColor Yellow
    } else {
        Write-Host "[*] Registering tray status app at logon for user '$AgentTaskUser'..." -ForegroundColor Yellow
        schtasks /Delete /TN $TrayTaskName /F 2>$null | Out-Null

        # WindowStyle Hidden so the PowerShell host doesn't flash a console at every logon.
        # Tray uses NotifyIcon, which lives on the user's interactive desktop, so we need
        # /RL LIMITED + an at-logon trigger as the same user (NOT SYSTEM, which has no
        # interactive desktop and would silently no-op).
        $taskAction = "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$trayScript`" -InstallDir `"$InstallDir`" -ServiceName `"$ServiceName`" -AgentTaskName `"$AgentTaskName`""
        & schtasks /Create /TN $TrayTaskName /SC ONLOGON /RU $AgentTaskUser /RL LIMITED /TR $taskAction /F | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] Scheduled task '$TrayTaskName' registered (runs at logon, as $AgentTaskUser)" -ForegroundColor Green
            Write-Host "     The tray icon will appear automatically on next logon. To start now without re-logging in:" -ForegroundColor DarkGray
            Write-Host "       schtasks /Run /TN $TrayTaskName" -ForegroundColor DarkGray
        } else {
            Write-Host "[WARN] schtasks /Create returned $LASTEXITCODE - tray task NOT registered" -ForegroundColor Yellow
        }
    }
}

Write-Host ""
Write-Host "Useful commands:" -ForegroundColor Yellow
Write-Host "  nssm status $ServiceName             # Check service status"
Write-Host "  nssm restart $ServiceName            # Restart service"
Write-Host "  nssm stop $ServiceName               # Stop service"
Write-Host "  nssm edit $ServiceName               # Edit config (GUI)"
Write-Host "  schtasks /Query /TN $AgentTaskName   # Check agent task status"
Write-Host "  schtasks /Run /TN $AgentTaskName     # Start agent now"
Write-Host "  schtasks /End /TN $AgentTaskName     # Stop agent"
Write-Host "  schtasks /Run /TN $TrayTaskName      # Start tray icon now"
Write-Host "  schtasks /End /TN $TrayTaskName      # Hide tray icon"
