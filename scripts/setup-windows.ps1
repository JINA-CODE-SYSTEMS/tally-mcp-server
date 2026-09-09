# ============================================================
# Tally MCP Server - Windows setup for a FROM-SOURCE install
# Run this ONCE on the machine (as Administrator)
#
# This is the developer / custom-deployment path. Customers use the Inno Setup installer
# (scripts/installer/), which is a different and more careful program: it bundles a portable
# Node, locks down .env, and drives the whole thing from a wizard.
#
# DEPLOYMENT MODE (#172). This script used to do exactly one thing - register an NSSM service
# running the HTTP server - which meant every from-source install was a REMOTE deployment
# whether or not anyone intended one, and both the tray and verify-deployment.ps1 then graded
# it as remote, because an absent DEPLOYMENT_MODE key is read that way. It now understands both:
#
#   local  (default for a fresh install) - no service, no listening port, no OAuth password.
#          Claude spawns dist\index.mjs over stdio on demand, and the MCP client config is
#          written for you. This is what the product defaults to.
#   remote - the previous behaviour: an NSSM service running dist\server.mjs.
#
# The mode is resolved in this order, so re-running the script on an existing box never
# silently changes what that box is:
#   1. -DeploymentMode, if you pass it
#   2. DEPLOYMENT_MODE in the existing .env
#   3. 'remote' if a service of this name already exists (a pre-#172 install)
#   4. 'local'
# ============================================================

param(
    [string]$InstallDir = "C:\tally-mcp-server",
    [string]$NodePath = "C:\Program Files\nodejs\node.exe",
    [ValidateSet('local', 'remote', '')]
    [string]$DeploymentMode = '',
    [string]$ServiceName = "TallyMCP",
    [string]$AgentTaskName = "TallyMCPAgent",
    [string]$TrayTaskName = "TallyMCPTray",
    [string]$AgentTaskUser = $env:USERNAME,
    [switch]$SkipAgentTask,
    [switch]$SkipTrayTask,
    [switch]$SkipClientConfig
)

$ErrorActionPreference = "Stop"

$envFile = Join-Path $InstallDir ".env"

# --- .env helpers -------------------------------------------------------------------------
# Deliberately minimal: these read and write a single key without disturbing the rest of the
# file, because a from-source .env is hand-maintained and clobbering it would be rude.
function Get-EnvValue {
    param([string]$Path, [string]$Key)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    foreach ($line in (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith('#')) { continue }
        $eq = $t.IndexOf('=')
        if ($eq -lt 1) { continue }
        if ($t.Substring(0, $eq).Trim() -ne $Key) { continue }
        return $t.Substring($eq + 1).Trim().Trim('"').Trim("'")
    }
    return $null
}

function Set-EnvValue {
    param([string]$Path, [string]$Key, [string]$Value)
    $lines = @()
    if (Test-Path -LiteralPath $Path) { $lines = @(Get-Content -LiteralPath $Path) }
    $done = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $t = $lines[$i].Trim()
        if (-not $t -or $t.StartsWith('#')) { continue }
        $eq = $t.IndexOf('=')
        if ($eq -lt 1) { continue }
        if ($t.Substring(0, $eq).Trim() -ne $Key) { continue }
        $lines[$i] = "$Key=$Value"
        $done = $true
        break
    }
    if (-not $done) { $lines += "$Key=$Value" }
    # UTF-8 without a BOM: dotenv reads the file as UTF-8, and a BOM on line 1 would become
    # part of the first key's name.
    [System.IO.File]::WriteAllLines($Path, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
}

# --- Step 0: Resolve the deployment mode ---------------------------------------------------
$mode = ''
$modeSource = ''
if ($DeploymentMode) {
    $mode = $DeploymentMode
    $modeSource = "-DeploymentMode $DeploymentMode"
} else {
    $fromEnv = Get-EnvValue -Path $envFile -Key 'DEPLOYMENT_MODE'
    if ($fromEnv -and (@('local', 'remote') -contains $fromEnv)) {
        $mode = $fromEnv
        $modeSource = "DEPLOYMENT_MODE in $envFile"
    } elseif (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
        # A pre-#172 install: it has a service and no mode key. Preserve what it already is,
        # rather than quietly demoting a working remote deployment to local on a re-run.
        $mode = 'remote'
        $modeSource = "existing '$ServiceName' service (pre-#172 install, preserved)"
    } else {
        $mode = 'local'
        $modeSource = 'default for a fresh install'
    }
}
Write-Host "[OK] Deployment mode: $mode  ($modeSource)" -ForegroundColor Green

# --- Step 1: Verify Node.js ----------------------------------------------------------------
if (-not (Test-Path $NodePath)) {
    Write-Error "Node.js not found at $NodePath. Install Node.js >= 22 first."
    exit 1
}
$nodeVersion = & $NodePath --version
Write-Host "[OK] Node.js $nodeVersion found" -ForegroundColor Green

# --- Step 2: Install NSSM (remote only) ----------------------------------------------------
# Local mode registers no service, so NSSM is not a prerequisite for it. Demanding it anyway
# was one of the things that made a local install impossible from source.
if ($mode -eq 'remote') {
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
} else {
    Write-Host "[*] Local mode: skipping NSSM (no service is registered)" -ForegroundColor DarkGray
}

# --- Step 2b: Compile TallyUI.dll (Win32 interop for GUI agent) ----------------------------
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

# --- Step 3: Verify the build output -------------------------------------------------------
# The two modes have two different entry points, and checking for the wrong one is not a
# cosmetic difference: dist\server.mjs is the HTTP + OAuth listener, dist\index.mjs is the
# stdio server Claude spawns. A local install has no reason to have built the former.
if ($mode -eq 'local') {
    $entryPoint = Join-Path $InstallDir "dist\index.mjs"
} else {
    $entryPoint = Join-Path $InstallDir "dist\server.mjs"
}
if (-not (Test-Path $entryPoint)) {
    Write-Error "Entry point for $mode mode not found at $entryPoint. Clone the repo and build first:
    cd C:\
    git clone https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server.git
    cd tally-mcp-server
    npm install
    npm run build"
    exit 1
}
Write-Host "[OK] Entry point found: $entryPoint" -ForegroundColor Green

# --- Step 4: Record the mode in .env -------------------------------------------------------
# Without this key both the tray and verify-deployment.ps1 read the install as 'remote' - that
# is the documented fallback for a pre-#172 install - so a local from-source box would be graded
# against remote-mode expectations and painted red for a service it correctly does not have.
if (-not (Test-Path -LiteralPath $envFile)) {
    Write-Host "[WARN] No .env at $envFile - creating one with DEPLOYMENT_MODE only." -ForegroundColor Yellow
    Write-Host "       Copy .env.example over it and fill in the TALLY_* values before using the server." -ForegroundColor Yellow
}
Set-EnvValue -Path $envFile -Key 'DEPLOYMENT_MODE' -Value $mode
Write-Host "[OK] DEPLOYMENT_MODE=$mode written to $envFile" -ForegroundColor Green

# --- Step 5: NSSM service (remote only) ----------------------------------------------------
if ($mode -eq 'remote') {
    $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existingService) {
        Write-Host "[*] Service '$ServiceName' already exists. Removing and re-installing..." -ForegroundColor Yellow
        nssm stop $ServiceName 2>$null
        nssm remove $ServiceName confirm
    }

    nssm install $ServiceName $NodePath $entryPoint
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

    # Shutdown + restart behaviour (issue #23): stop via console Ctrl-C (Node -> SIGINT -> graceful
    # shutdown in server.mts), escalate only if it stalls, and bound each stage so Stop-Service returns
    # within ~10s instead of hanging in StopPending. Restart with a delay + throttle so a fast-dying
    # process is left stopped (error visible in logs) rather than respawned into "Running but no port".
    nssm set $ServiceName AppStopMethodSkip 0
    nssm set $ServiceName AppStopMethodConsole 6000
    nssm set $ServiceName AppStopMethodWindow 1500
    nssm set $ServiceName AppStopMethodThreads 1500
    nssm set $ServiceName AppExit Default Restart
    nssm set $ServiceName AppRestartDelay 2000
    nssm set $ServiceName AppThrottle 5000

    # Create logs directory
    New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null

    # NOTE: .env is deliberately NOT copied into the service environment via NSSM
    # AppEnvironmentExtra any more. That wrote every value, PASSWORD included, into a services
    # registry key that BUILTIN\Users can read, defeating any file-level protection on .env. It
    # was also redundant: server.mts loads .env itself by absolute path with override:true, so
    # the service gets the same values without a second, world-readable copy. Removed for the
    # same reason it was removed from the installer (firstrun-config.ps1).

    Write-Host "[OK] Service '$ServiceName' installed" -ForegroundColor Green

    nssm start $ServiceName
    Write-Host "[OK] Service '$ServiceName' started" -ForegroundColor Green

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
} else {
    # Local mode must not leave a listener behind - including one this script registered on an
    # earlier run in remote mode. Tear down unconditionally rather than trusting a marker.
    $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existingService) {
        Write-Host "[*] Local mode: removing the existing '$ServiceName' service..." -ForegroundColor Yellow
        $nssmForRemoval = (Get-Command nssm -ErrorAction SilentlyContinue).Source
        if ($nssmForRemoval) {
            & $nssmForRemoval stop $ServiceName 2>$null
            & $nssmForRemoval remove $ServiceName confirm
            Write-Host "[OK] Service '$ServiceName' removed - local mode has no service" -ForegroundColor Green
        } else {
            Write-Host "[WARN] '$ServiceName' exists but nssm is not on PATH, so it was NOT removed." -ForegroundColor Yellow
            Write-Host "       A listener is still running. Remove it with: sc.exe delete $ServiceName" -ForegroundColor Yellow
        }
    }
    New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null
    Write-Host "[OK] Local mode: no service, no listening port, no OAuth password" -ForegroundColor Green
}

# --- Step 6: Point the MCP client at this install (local only) ------------------------------
# In remote mode the client connects over HTTP and there is nothing to write locally.
if ($mode -eq 'local' -and -not $SkipClientConfig) {
    $connectScript = Join-Path $InstallDir "scripts\installer\connect-client.ps1"
    if (-not (Test-Path $connectScript)) {
        Write-Host "[WARN] connect-client.ps1 not found at $connectScript - configure Claude manually" -ForegroundColor Yellow
    } else {
        # connect-client.ps1 writes %APPDATA%\Claude\claude_desktop_config.json for WHOEVER RUNS
        # IT. If this script was elevated as a different account than the one that opens Claude,
        # the warning below says so rather than silently configuring the wrong profile. The
        # installer solves this with a scheduled-task trampoline; this from-source path
        # deliberately does not, because a developer can just run one command as themselves.
        Write-Host "[*] Connecting the MCP client for '$env:USERNAME'..." -ForegroundColor Yellow
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $connectScript -InstallDir $InstallDir
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] Claude Desktop config updated for '$env:USERNAME'" -ForegroundColor Green
        } else {
            Write-Host "[WARN] connect-client.ps1 exited $LASTEXITCODE - see its output above" -ForegroundColor Yellow
        }
        if ($AgentTaskUser -and $AgentTaskUser -ne $env:USERNAME) {
            Write-Host "[WARN] You are '$env:USERNAME' but the agent will run as '$AgentTaskUser'." -ForegroundColor Yellow
            Write-Host "       Claude reads a per-user config, so run this as $AgentTaskUser too:" -ForegroundColor Yellow
            Write-Host "         powershell -ExecutionPolicy Bypass -File `"$connectScript`" -InstallDir `"$InstallDir`"" -ForegroundColor Yellow
        }
    }
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
        # NOTE (#88 H-2): this legacy schtasks path registers an at-logon trigger only - no native
        # crash supervision (schtasks.exe can't set RestartCount / a safe IgnoreNew heartbeat without
        # risking a double-launch). The shipped Inno installer path (firstrun-config.ps1) uses the
        # ScheduledTasks cmdlets with a 1-min heartbeat trigger + -MultipleInstances IgnoreNew +
        # -RestartCount to auto-respawn the agent within ~1 min of a crash. Prefer that installer.
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
if ($mode -eq 'remote') {
    Write-Host "  nssm status $ServiceName             # Check service status"
    Write-Host "  nssm restart $ServiceName            # Restart service"
    Write-Host "  nssm stop $ServiceName               # Stop service"
    Write-Host "  nssm edit $ServiceName               # Edit config (GUI)"
} else {
    Write-Host "  # Local mode has no service - Claude starts the server on demand over stdio."
    Write-Host "  powershell -File scripts\installer\connect-client.ps1 -InstallDir `"$InstallDir`"    # (re)connect a user's Claude"
}
Write-Host "  powershell -File scripts\verify-deployment.ps1        # Check the deployment against its mode"
Write-Host "  schtasks /Query /TN $AgentTaskName   # Check agent task status"
Write-Host "  schtasks /Run /TN $AgentTaskName     # Start agent now"
Write-Host "  schtasks /End /TN $AgentTaskName     # Stop agent"
Write-Host "  schtasks /Run /TN $TrayTaskName      # Start tray icon now"
Write-Host "  schtasks /End /TN $TrayTaskName      # Hide tray icon"
