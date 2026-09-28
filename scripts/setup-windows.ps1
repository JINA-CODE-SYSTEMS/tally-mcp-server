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
#   2. DEPLOYMENT_MODE in the existing .env (an unrecognised value stops the run)
#   3. 'remote' if a service of this name already exists AND points at this InstallDir
#      (a pre-#172 from-source install)
#   4. 'local'
#
# This is the same precedence firstrun-config.ps1 applies for the packaged installer, with one
# deliberate difference in step 3. There, "an .env already exists" is the evidence of a pre-#172
# install, because only the installer ever writes that file. Here it is not: a from-source .env is
# hand-made from .env.example before this script is ever run, so its presence says nothing about
# what the box used to be. The one artefact the old version of this script always left behind is
# the NSSM service, so that is the evidence used - and only when the service is ours, since the
# packaged installer registers a service with the same default name.
#
# The three .env keys mean exactly what they mean to the installer, the tray and
# verify-deployment.ps1: DEPLOYMENT_MODE (local|remote), REMOTE_AUTH (oauth-password|paired) and
# REMOTE_TRANSPORT (tunnel|lan). They are validated the same way - a typo stops the run rather
# than being coalesced to a default - and existing values are preserved.
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
#
# Parsing mirrors _ReadEnvHashtable in installer\firstrun-config.ps1 and Get-EnvLineValue in
# verify-deployment.ps1, i.e. dotenv semantics: a double-quoted value keeps a literal '#', an
# unquoted one is cut at the first '#'. That matters because this .env is usually a copy of
# .env.example, whose lines carry inline comments - without the cut, `DEPLOYMENT_MODE=remote  # ...`
# read back as an unrecognised mode, and a recorded remote box was quietly treated as a fresh one.
#
# Both read the file as UTF-8. Windows PowerShell 5.1's Get-Content otherwise decodes a BOM-less
# file as ANSI, and Set-EnvValue then wrote that mojibake back as UTF-8 - corrupting every
# non-ASCII character in the file (.env.example has an em dash) a little further on every run.
function Get-EnvValue {
    param([string]$Path, [string]$Key)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction SilentlyContinue)) {
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith('#')) { continue }
        $eq = $t.IndexOf('=')
        if ($eq -lt 1) { continue }
        if ($t.Substring(0, $eq).Trim() -ne $Key) { continue }
        $v = $t.Substring($eq + 1).Trim()
        if ($v.Length -ge 2 -and $v.StartsWith('"') -and $v.EndsWith('"')) {
            return $v.Substring(1, $v.Length - 2) -replace '\\"', '"'
        }
        $hash = $v.IndexOf('#')
        if ($hash -ge 0) { $v = $v.Substring(0, $hash).TrimEnd() }
        return $v.Trim("'")
    }
    return $null
}

function Set-EnvValue {
    param([string]$Path, [string]$Key, [string]$Value)
    $lines = @()
    if (Test-Path -LiteralPath $Path) { $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8) }
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

# --- Native-command helper -----------------------------------------------------------------
# Under $ErrorActionPreference = 'Stop', Windows PowerShell 5.1 turns anything a native command
# writes to a REDIRECTED stderr into a terminating error. `schtasks /Delete ... 2>$null` on a task
# that does not exist yet - the normal case on a first run - therefore aborted this script half
# way through, after .env was written but before the agent and tray tasks were registered. nssm
# does the same for "service not running". firstrun-config.ps1 relaxes the preference around the
# same calls for the same reason; this is that, in one place. Callers check $LASTEXITCODE.
function Invoke-Native {
    param([scriptblock]$Command)
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Command } finally { $ErrorActionPreference = $saved }
}

# --- Service ownership -----------------------------------------------------------------------
# The packaged installer registers a service with the same default name (TallyMCP), pointing at
# its own install root. A service of that name is therefore only evidence about THIS checkout if
# its NSSM AppDirectory is this InstallDir - otherwise it belongs to another install, and this
# script must neither adopt it (remote: re-point someone else's service at our dist\) nor delete
# it (local: tear the listener out of a working deployment we did not create).
function Get-ServiceOwnership {
    param([string]$Name, [string]$Dir)
    if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) {
        return @{ State = 'none'; AppDirectory = '' }
    }
    $appDir = ''
    try {
        $p = Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters" -Name AppDirectory -ErrorAction Stop
        $appDir = [string]$p.AppDirectory
    } catch { $appDir = '' }
    $norm = {
        param([string]$x)
        if (-not $x) { return '' }
        try { $x = [System.IO.Path]::GetFullPath($x) } catch { }
        return $x.TrimEnd('\').ToLowerInvariant()
    }
    if ($appDir -and ((& $norm $appDir) -eq (& $norm $Dir))) {
        return @{ State = 'ours'; AppDirectory = $appDir }
    }
    return @{ State = 'foreign'; AppDirectory = $appDir }
}

function Test-EnvValueSet {
    param([string]$Key)
    $v = Get-EnvValue -Path $envFile -Key $Key
    return ($null -ne $v -and $v.Trim().Length -gt 0)
}

# --- Step 0: Resolve the deployment mode ---------------------------------------------------
# Everything in this step is read-only. Every mode-related reason to refuse is found here, before
# .env is touched and before any existing service is stopped - so a refusal leaves the install
# exactly as it was.
$svcInfo      = Get-ServiceOwnership -Name $ServiceName -Dir $InstallDir
$recordedMode = Get-EnvValue -Path $envFile -Key 'DEPLOYMENT_MODE'
if ($null -eq $recordedMode) { $recordedMode = '' }

# An unrecognised recorded value is terminal unless -DeploymentMode overrides it, exactly as in
# firstrun-config.ps1 and verify-deployment.ps1: a typo in .env must stop the run, not quietly
# pick a deployment mode (and with it, whether a service exists) for the operator.
if (-not $DeploymentMode -and $recordedMode -and (@('local', 'remote') -notcontains $recordedMode)) {
    Write-Error ("DEPLOYMENT_MODE in $envFile is '$recordedMode', which is not one of: local, remote. " +
                 "Fix it in .env and re-run, or pass -DeploymentMode local|remote explicitly.")
    exit 1
}

$mode = ''
$modeSource = ''
if ($DeploymentMode) {
    $mode = $DeploymentMode
    $modeSource = "-DeploymentMode $DeploymentMode"
} elseif ($recordedMode) {
    $mode = $recordedMode
    $modeSource = "DEPLOYMENT_MODE in $envFile"
} elseif ($svcInfo.State -eq 'ours') {
    # A pre-#172 install: it has our service and no mode key. Preserve what it already is,
    # rather than quietly demoting a working remote deployment to local on a re-run.
    $mode = 'remote'
    $modeSource = "existing '$ServiceName' service for this InstallDir (pre-#172 install, preserved)"
} else {
    $mode = 'local'
    $modeSource = 'default for a fresh install'
}
Write-Host "[OK] Deployment mode: $mode  ($modeSource)" -ForegroundColor Green

# Changing an existing box's mode is only ever the result of an explicit choice (the flag, or a
# DEPLOYMENT_MODE someone wrote into .env). Say so out loud, because remote -> local removes a
# service that something may depend on.
$previousMode = ''
if (@('local', 'remote') -contains $recordedMode) { $previousMode = $recordedMode }
elseif ($svcInfo.State -eq 'ours') { $previousMode = 'remote' }
if ($previousMode -and $previousMode -ne $mode) {
    Write-Host "[*] Changing this install from '$previousMode' to '$mode' because $modeSource." -ForegroundColor Yellow
    if ($mode -eq 'local' -and $svcInfo.State -eq 'ours') {
        Write-Host "    The '$ServiceName' service will be removed: local mode has no service and no listener." -ForegroundColor Yellow
    }
}

# REMOTE_AUTH / REMOTE_TRANSPORT: preserved if present, defaulted exactly as firstrun-config.ps1
# defaults them, and validated the same way. They describe the remote path (#178) and are inert
# in local mode, but are recorded in both so every install carries the same three keys.
$remoteAuth = Get-EnvValue -Path $envFile -Key 'REMOTE_AUTH'
if (-not $remoteAuth) { $remoteAuth = 'oauth-password' }
$remoteTransport = Get-EnvValue -Path $envFile -Key 'REMOTE_TRANSPORT'
if (-not $remoteTransport) { $remoteTransport = 'tunnel' }
if (@('oauth-password', 'paired') -notcontains $remoteAuth) {
    Write-Error "REMOTE_AUTH in $envFile is '$remoteAuth', which is not one of: oauth-password, paired. Fix it in .env and re-run."
    exit 1
}
if (@('tunnel', 'lan') -notcontains $remoteTransport) {
    Write-Error "REMOTE_TRANSPORT in $envFile is '$remoteTransport', which is not one of: tunnel, lan. Fix it in .env and re-run."
    exit 1
}

$svcOwner = $svcInfo.AppDirectory
if (-not $svcOwner) { $svcOwner = 'an unknown location (not an NSSM service of this project)' }
if ($mode -eq 'remote') {
    # Never adopt another install's service. Re-registering it would point the packaged
    # product's service at this checkout's dist\ - converting that install behind its back.
    if ($svcInfo.State -eq 'foreign') {
        $owner = $svcOwner
        Write-Error ("A service named '$ServiceName' already exists and belongs to $owner, not $InstallDir. " +
                     "Refusing to re-point it. Pass -ServiceName with a different name for this install.")
        exit 1
    }
    # server.mts exits FATAL at startup without PASSWORD, and NSSM's restart throttle then leaves
    # the service stopped. Registering it anyway would replace a working service with a dead one,
    # so check first. The value is tested for presence only and never printed.
    if (-not (Test-EnvValueSet 'PASSWORD')) {
        Write-Error ("Remote mode needs PASSWORD set in $envFile - it is the OAuth password that gates the HTTP " +
                     "server, and dist\server.mjs refuses to start without it. Set it (see .env.example) and re-run, " +
                     "or run without -DeploymentMode remote for a local install, which needs no password.")
        exit 1
    }
} else {
    if ($svcInfo.State -eq 'foreign') {
        Write-Host "[*] A '$ServiceName' service exists but belongs to $svcOwner, not this InstallDir; it will be left alone." -ForegroundColor DarkGray
    }
    # This script writes no secret in local mode, but a hand-made .env may already hold one -
    # typically copied from the remote setup guide. Nothing in local mode reads it, and
    # verify-deployment.ps1 fails a local install that still has it. It is not deleted here,
    # because the .env is the operator's file and the likelier story is "meant remote, forgot
    # the flag" - so say which it is and how to resolve either way.
    foreach ($secretKey in @('PASSWORD', 'TUNNEL_TOKEN')) {
        if (Test-EnvValueSet $secretKey) {
            Write-Host "[WARN] $secretKey is set in $envFile, but local mode never uses it." -ForegroundColor Yellow
            Write-Host "       If you meant a remote deployment, re-run with -DeploymentMode remote." -ForegroundColor Yellow
            Write-Host "       Otherwise clear that line: an unused credential on disk is still a credential, and" -ForegroundColor Yellow
            Write-Host "       verify-deployment.ps1 reports it as a FAIL for a local install." -ForegroundColor Yellow
        }
    }
}

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
Set-EnvValue -Path $envFile -Key 'REMOTE_AUTH' -Value $remoteAuth
Set-EnvValue -Path $envFile -Key 'REMOTE_TRANSPORT' -Value $remoteTransport
Write-Host "[OK] DEPLOYMENT_MODE=$mode (REMOTE_AUTH=$remoteAuth, REMOTE_TRANSPORT=$remoteTransport) written to $envFile" -ForegroundColor Green

# --- Step 5: NSSM service (remote only) ----------------------------------------------------
if ($mode -eq 'remote') {
    # Step 0 has already refused a service that belongs to another install, so one that exists
    # here is ours.
    $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existingService) {
        Write-Host "[*] Service '$ServiceName' already exists. Removing and re-installing..." -ForegroundColor Yellow
        Invoke-Native { & $nssmPath stop $ServiceName 2>$null | Out-Null }
        Invoke-Native { & $nssmPath remove $ServiceName confirm 2>$null | Out-Null }
        # Wait for the SCM to reap the registration; installing over one still marked for
        # deletion fails.
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
            Start-Sleep -Milliseconds 500
        }
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
    # earlier run in remote mode. Tear down on the service's existence rather than trusting a
    # marker. Only OUR service, though: one pointing at another install is not this script's to
    # remove (step 0 already said it is being left alone).
    $serviceGone = $true
    if ($svcInfo.State -eq 'ours') {
        Write-Host "[*] Local mode: removing the existing '$ServiceName' service..." -ForegroundColor Yellow
        $nssmForRemoval = (Get-Command nssm -ErrorAction SilentlyContinue).Source
        if ($nssmForRemoval) {
            Invoke-Native { & $nssmForRemoval stop $ServiceName 2>$null | Out-Null }
            Invoke-Native { & $nssmForRemoval remove $ServiceName confirm 2>$null | Out-Null }
        } else {
            # NSSM is not a prerequisite of local mode, so it may well be gone from PATH. The SCM
            # can remove the service without it.
            try { Stop-Service -Name $ServiceName -Force -ErrorAction Stop } catch { }
            Invoke-Native { & sc.exe delete $ServiceName 2>$null | Out-Null }
        }
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
            Start-Sleep -Milliseconds 500
        }
        if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
            $serviceGone = $false
            Write-Host "[WARN] '$ServiceName' could NOT be removed, so this box may still be listening." -ForegroundColor Yellow
            Write-Host "       Re-run this script as Administrator, or remove it with: sc.exe delete $ServiceName" -ForegroundColor Yellow
        } else {
            Write-Host "[OK] Service '$ServiceName' removed - local mode has no service" -ForegroundColor Green
        }
    }

    # Revoke rather than abandon, as firstrun-config.ps1 does: the OAuth client and token stores
    # are written by the HTTP server, not by hand, and in local mode nothing reads them. A stale
    # token store is a live credential, and verify-deployment.ps1 fails a local install that has
    # one. Zeroed before deletion so the bytes do not linger in the freed clusters.
    foreach ($leftover in @('.oauth-clients.json', '.oauth-tokens.json')) {
        $lp = Join-Path $InstallDir $leftover
        if (Test-Path -LiteralPath $lp) {
            try {
                $len = (Get-Item -LiteralPath $lp).Length
                if ($len -gt 0) { [System.IO.File]::WriteAllBytes($lp, (New-Object byte[] $len)) }
                Remove-Item -LiteralPath $lp -Force
                Write-Host "[OK] Removed $leftover (not used in local mode)" -ForegroundColor Green
            } catch {
                Write-Host "[WARN] Could not remove ${leftover}: $_" -ForegroundColor Yellow
            }
        }
    }

    New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null
    if ($serviceGone -and -not (Test-EnvValueSet 'PASSWORD')) {
        Write-Host "[OK] Local mode: no service, no listening port, no OAuth password" -ForegroundColor Green
    } elseif ($serviceGone) {
        Write-Host "[OK] Local mode: no service, no listening port (PASSWORD is still in .env - see the warning above)" -ForegroundColor Green
    }
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
        Invoke-Native { schtasks /Delete /TN $AgentTaskName /F 2>$null | Out-Null }

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
        Invoke-Native { schtasks /Delete /TN $TrayTaskName /F 2>$null | Out-Null }

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
