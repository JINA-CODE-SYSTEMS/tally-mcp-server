<#
.SYNOPSIS
    Tally MCP Server - first-run configuration script (issue #18).

.DESCRIPTION
    Invoked by tally-mcp.iss after files are unpacked. Writes .env from the
    wizard's collected values, registers (or re-registers) the NSSM service
    using the BUNDLED node-portable\node.exe + bin\nssm.exe (no system Node
    needed), and registers the GUI agent at-logon scheduled task.

    Re-runnable: stops/removes any existing service before re-registering, so
    operators can re-launch this script via the "Reconfigure" Start Menu
    shortcut to update settings.

.PARAMETER InstallDir
    Where the installer placed the app. Inno passes {app}.

.PARAMETER Password
    OAuth password collected by the wizard. Becomes the PASSWORD env var.

.PARAMETER TallyEdition
    "silver" or "gold". Becomes TALLY_EDITION.

.PARAMETER TallyExePath
    Absolute path to tally.exe.

.PARAMETER TallyDataPath
    Tally's data directory (where the digit-named company folders live).

.PARAMETER TallyIniPath
    Absolute path to tally.ini (the file load-company edits).

.PARAMETER McpDomain
    Public domain for OAuth metadata. Empty -> localhost-only mode.

.PARAMETER AgentTaskUser
    Windows user the GUI agent task runs as. Must be the user who logs into
    the box and uses Tally interactively.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$InstallDir,
    [string]$ServiceName    = 'TallyMCP',
    [string]$AgentTaskName  = 'TallyMCPAgent',
    [string]$TrayTaskName   = 'TallyMCPTray',
    # The OAuth password is read from a JSON credentials file (written by Inno Setup into the
    # installer's user-only temp folder). Avoids exposing the password on the command line where
    # it would be visible to any local process via Get-CimInstance Win32_Process / wmic during
    # the ~30s install window. The file is deleted immediately after read.
    # When the script is re-run interactively (Start Menu "Reconfigure"), this is omitted and we
    # try to preserve the existing PASSWORD from .env before falling back to a prompt.
    [string]$CredentialsFile = '',
    # NOTE: the Tally* / McpDomain / AgentTaskUser params have NO defaults here. After the param
    # block we read the existing .env and apply this fallback chain:
    #   1. explicitly-passed -Param value (highest priority)
    #   2. value already in .env (preserved across reconfigures)
    #   3. hardcoded default (only when .env doesn't have it either)
    # Without this, re-running the script with just -CredentialsFile + -McpDomain wiped fields
    # like TALLY_EXE_PATH back to their hardcoded defaults; running without -McpDomain wiped
    # MCP_DOMAIN entirely, dropping production back to localhost-only.
    [string]$TallyEdition,
    [string]$TallyExePath,
    [string]$TallyDataPath,
    [string]$TallyIniPath,
    [string]$McpDomain,
    [string]$AgentTaskUser,
    [switch]$SkipTrayTask
)

# --- Preserve-on-reconfigure: read existing .env to fill in any blank params ---
function _ReadEnvHashtable {
    param([string]$Path)
    $h = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $h }
    foreach ($line in (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $eq = $trimmed.IndexOf('=')
        if ($eq -lt 1) { continue }
        $k = $trimmed.Substring(0, $eq).Trim()
        $v = $trimmed.Substring($eq + 1).Trim()
        if ($v.Length -ge 2 -and $v.StartsWith('"') -and $v.EndsWith('"')) {
            $v = $v.Substring(1, $v.Length - 2) -replace '\\"', '"'
        }
        # Strip inline `# comment` for unquoted values (matches dotenv semantics).
        if (-not ($trimmed.Substring($eq + 1).Trim().StartsWith('"'))) {
            $hashIdx = $v.IndexOf('#')
            if ($hashIdx -ge 0) { $v = $v.Substring(0, $hashIdx).TrimEnd() }
        }
        $h[$k] = $v
    }
    return $h
}
$_existingEnv = _ReadEnvHashtable (Join-Path $InstallDir '.env')

# Helper: pick first non-empty among the candidates.
function _Coalesce { foreach ($v in $args) { if ($null -ne $v -and "$v" -ne '') { return $v } }; return '' }

$TallyEdition   = _Coalesce $TallyEdition   $_existingEnv['TALLY_EDITION']   'silver'
$TallyExePath   = _Coalesce $TallyExePath   $_existingEnv['TALLY_EXE_PATH']   'C:\Program Files\TallyPrimeEditLog\tally.exe'
$TallyDataPath  = _Coalesce $TallyDataPath  $_existingEnv['TALLY_DATA_PATH']  'C:\Users\Public\TallyPrimeEditLog\data'
$TallyIniPath   = _Coalesce $TallyIniPath   $_existingEnv['TALLY_INI_PATH']   'C:\Program Files\TallyPrimeEditLog\tally.ini'
# MCP_DOMAIN has no hardcoded default — blank means "localhost-only mode".
$McpDomain      = _Coalesce $McpDomain      $_existingEnv['MCP_DOMAIN']       ''
$AgentTaskUser  = _Coalesce $AgentTaskUser  $env:USERNAME

# --- Resolve OAuth password ---
# Two entry paths:
#   1. Inno Setup wizard: passes -CredentialsFile pointing at a JSON in the installer's user-only
#      temp folder. We read + delete it immediately so the password never sits on a process command
#      line where Get-CimInstance Win32_Process could observe it.
#   2. Interactive "Reconfigure" Start Menu shortcut: re-runs this script with only -InstallDir.
#      We prompt the operator securely via Read-Host -AsSecureString.
$Password = $null
if ($CredentialsFile -and $CredentialsFile.Trim().Length -gt 0) {
    if (-not (Test-Path -LiteralPath $CredentialsFile)) {
        throw "Credentials file not found at '$CredentialsFile'. Inno Setup should have written it before invoking this script."
    }
    $credsRaw = $null
    try {
        $credsRaw = [System.IO.File]::ReadAllText($CredentialsFile, [System.Text.Encoding]::UTF8)
    } finally {
        # Best-effort secure delete: overwrite with zeros, then unlink. Bounded residual exposure.
        try {
            $size = (Get-Item -LiteralPath $CredentialsFile -ErrorAction SilentlyContinue).Length
            if ($size -gt 0) {
                $zeros = New-Object byte[] $size
                [System.IO.File]::WriteAllBytes($CredentialsFile, $zeros)
            }
        } catch {}
        Remove-Item -LiteralPath $CredentialsFile -Force -ErrorAction SilentlyContinue
    }
    try {
        $creds = $credsRaw | ConvertFrom-Json
    } catch {
        throw "Credentials file '$CredentialsFile' is not valid JSON: $_"
    }
    if (-not $creds.password) {
        throw "Credentials file did not contain a 'password' field."
    }
    $Password = [string]$creds.password
    # Hint to GC: drop the raw JSON string from memory once we've extracted the field.
    $credsRaw = $null
} elseif ($_existingEnv['PASSWORD']) {
    # Reconfigure-without-creds path: preserve the existing PASSWORD from .env instead of
    # prompting for it again. Lets the operator re-run the script (e.g. to update one specific
    # parameter) without retyping the OAuth password every time.
    $Password = [string]$_existingEnv['PASSWORD']
    Write-Host ""
    Write-Host "Tally MCP Reconfigure" -ForegroundColor Cyan
    Write-Host "(re-running first-run wizard; preserving OAuth password from existing .env)"
    Write-Host ""
} else {
    # Interactive prompt path. Reached only when no .env exists yet AND no credentials file was
    # passed (e.g. fresh install via the Reconfigure shortcut after the .env was deleted).
    # SecureString -> plaintext extraction; SecureString is just a roadblock here, not real
    # protection (the password ends up in $Password as a plain string for use in .env-writing).
    Write-Host ""
    Write-Host "Tally MCP Reconfigure" -ForegroundColor Cyan
    Write-Host "(re-running first-run wizard interactively; press Ctrl+C to abort)"
    Write-Host ""
    $secure = Read-Host -Prompt "OAuth password (min 12 chars)" -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $Password = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    if ($Password.Length -lt 12) {
        throw "Password too short (got $($Password.Length) chars, need >= 12)."
    }
}

$ErrorActionPreference = 'Stop'
$transcript = Join-Path $InstallDir 'logs\firstrun-config.log'
New-Item -ItemType Directory -Force -Path (Split-Path $transcript) | Out-Null
Start-Transcript -Path $transcript -Append | Out-Null

try {
    Write-Host "=== Tally MCP first-run configuration ==="
    Write-Host "InstallDir   = $InstallDir"
    Write-Host "ServiceName  = $ServiceName"
    Write-Host "TallyEdition = $TallyEdition"
    Write-Host "AgentUser    = $AgentTaskUser"

    $bundledNode = Join-Path $InstallDir 'node-portable\node.exe'
    $bundledNssm = Join-Path $InstallDir 'bin\nssm.exe'
    $serverEntry = Join-Path $InstallDir 'dist\server.mjs'
    $envFile     = Join-Path $InstallDir '.env'
    $agentScript = Join-Path $InstallDir 'scripts\tally-gui-agent-v2.ps1'

    foreach ($p in @($bundledNode, $bundledNssm, $serverEntry, $agentScript)) {
        if (-not (Test-Path -LiteralPath $p)) {
            throw "Required file missing: $p (installer payload incomplete?)"
        }
    }

    # --- 1. Write .env -----------------------------------------------------
    # Atomic-ish: write to .tmp, then rename, so a half-written .env never appears.
    # We do NOT log the password itself; the transcript captures parameter binding which
    # is acceptable for a first-run install but operators should rotate the password if
    # the log is sensitive (see logs/firstrun-config.log cleanup hint at end).
    # Helper: wrap a value in double-quotes for .env so dotenv treats `#` as a literal char rather
    # than starting an inline comment (PASSWORD=Welcome#2527 would otherwise parse to "Welcome").
    # Escapes any double-quote inside the value with backslash, since dotenv supports \" in
    # quoted values.
    function _envQuote([string]$value) {
        $escaped = $value -replace '"', '\"'
        return '"' + $escaped + '"'
    }
    $envLines = @(
        "# Generated by Tally MCP first-run wizard at $(Get-Date -Format 'o')"
        "# Edit by hand or re-run scripts\installer\firstrun-config.ps1 to regenerate."
        "PASSWORD=$(_envQuote $Password)"
        "TALLY_EDITION=$TallyEdition"
        "TALLY_HOST=127.0.0.1:9000"
        "TALLY_EXE_PATH=$(_envQuote $TallyExePath)"
        "TALLY_DATA_PATH=$(_envQuote $TallyDataPath)"
        "TALLY_INI_PATH=$(_envQuote $TallyIniPath)"
        # The installer's whole reason for existing is "Node + reverse proxy on the same box",
        # so we bind to all interfaces. The reverse proxy in front (Caddy/IIS/Cloudflare Tunnel)
        # is responsible for restricting access. Without this, a Caddyfile that says
        # `reverse_proxy localhost:3000` resolves localhost to ::1 first on Windows, but Node
        # only listens on 127.0.0.1 (the upstream library default), and Caddy returns 502.
        "BIND_HOST=0.0.0.0"
    )
    if ($McpDomain) {
        $envLines += "MCP_DOMAIN=$McpDomain"
    } else {
        $envLines += "# MCP_DOMAIN intentionally unset - server binds to localhost only"
    }

    $envTmp = "$envFile.tmp"
    Set-Content -Path $envTmp -Value $envLines -Encoding UTF8
    Move-Item -Path $envTmp -Destination $envFile -Force
    Write-Host "[OK] Wrote $envFile ($($envLines.Count) lines)"

    # --- 1b. Initialize + lock down the companies registry file -----------
    # The registry stores DPAPI-encrypted passwords for the alias feature. We pre-create an empty
    # file so the ACL is in place before anything sensitive is written, then strip inheritance and
    # grant access only to SYSTEM (the MCP service) and Administrators (operator + tray when
    # elevated). The DPAPI blob is defense-in-depth; the NTFS ACL is the real access boundary.
    $registryFile = Join-Path $TallyDataPath '.tally-mcp-companies.json'
    if (-not (Test-Path -LiteralPath (Split-Path $registryFile))) {
        New-Item -ItemType Directory -Force -Path (Split-Path $registryFile) | Out-Null
    }
    if (-not (Test-Path -LiteralPath $registryFile)) {
        Set-Content -Path $registryFile -Value '{"schemaVersion":1,"companies":[]}' -Encoding UTF8 -NoNewline
        Write-Host "[OK] Created empty company registry at $registryFile"
    } else {
        Write-Host "[*] Existing company registry detected at $registryFile (preserved)"
    }
    # icacls /inheritance:r removes inherited ACEs; /grant:r replaces (not adds) the named ACEs.
    # 2>$null suppresses the per-line "Successfully processed..." stdout chatter from icacls.
    #
    # IMPORTANT: also grant the agent task user explicit Full Control. The tray scheduled task
    # runs with -RunLevel Limited (non-elevated), which filters the Administrators group from
    # the process token even when the user IS in Administrators. Without an explicit user grant,
    # the Manage Companies dialog's Move-Item -Force silently fails on overwrite — the .tmp file
    # gets written but never gets renamed to the real .json, so Save reports success and
    # nothing actually persists.
    & icacls $registryFile /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' "${AgentTaskUser}:F" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] Locked NTFS ACL on $registryFile (SYSTEM + Administrators only)"
    } else {
        Write-Host "[WARN] icacls exit $LASTEXITCODE on $registryFile - registry file is not locked down" -ForegroundColor Yellow
    }

    # --- 2. Stop and remove any existing service (idempotent re-runs) ------
    # nssm.exe writes benign "service not running" / "service does not exist" messages to stderr,
    # which PowerShell 5.x with ErrorActionPreference=Stop promotes to terminating errors and
    # aborts the script. Only call `stop` when the service is actually running, and temporarily
    # relax the preference around the nssm invocations so unexpected stderr doesn't kill us.
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "[*] Existing service detected; stopping and removing..."
        $savedPref = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            if ($existing.Status -eq 'Running') {
                & $bundledNssm stop $ServiceName 2>$null | Out-Null
                Start-Sleep -Seconds 2
            }
            & $bundledNssm remove $ServiceName confirm 2>$null | Out-Null
        } finally {
            $ErrorActionPreference = $savedPref
        }
        # Wait for SCM to fully reap the service registration before we re-install.
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
            Start-Sleep -Milliseconds 500
        }
    }

    # --- 3. Register NSSM service pointing at bundled node + dist/server.mjs --
    # IMPORTANT: pass the script as a RELATIVE path ('dist\server.mjs') against AppDirectory rather
    # than the absolute path 'C:\Program Files\TallyMCP\dist\server.mjs'. NSSM's storage of the
    # AppParameters value via the install command's third positional arg loses the quoting around
    # spaces somewhere in the PowerShell -> nssm.exe -> Windows registry chain, so the resulting
    # service launches as `node.exe C:\Program Files\TallyMCP\dist\server.mjs` (unquoted), which
    # Node tokenizes at the first space and tries to load `C:\Program` as a module. Relative paths
    # with no spaces sidestep the whole quoting fragility. AppDirectory is set on the next line.
    $serverEntryRelative = 'dist\server.mjs'
    & $bundledNssm install $ServiceName $bundledNode $serverEntryRelative | Out-Null
    & $bundledNssm set $ServiceName AppDirectory $InstallDir                            | Out-Null
    & $bundledNssm set $ServiceName Description  'Tally Prime MCP Server'               | Out-Null
    & $bundledNssm set $ServiceName Start        SERVICE_AUTO_START                     | Out-Null
    & $bundledNssm set $ServiceName AppStdout    (Join-Path $InstallDir 'logs\service.log') | Out-Null
    & $bundledNssm set $ServiceName AppStderr    (Join-Path $InstallDir 'logs\service.log') | Out-Null
    & $bundledNssm set $ServiceName AppRotateFiles 1                                    | Out-Null
    & $bundledNssm set $ServiceName AppRotateOnline 1                                   | Out-Null
    & $bundledNssm set $ServiceName AppRotateSeconds 86400                              | Out-Null
    & $bundledNssm set $ServiceName AppRotateBytes 5242880                              | Out-Null
    & $bundledNssm set $ServiceName AppStdoutCreationDisposition 4                      | Out-Null
    & $bundledNssm set $ServiceName AppStderrCreationDisposition 4                      | Out-Null

    # Hand .env values to the service through NSSM's AppEnvironmentExtra. NSSM expects a
    # newline-separated list of KEY=VALUE pairs.
    $nssmEnv = ($envLines | Where-Object { $_ -and -not $_.StartsWith('#') }) -join "`n"
    & $bundledNssm set $ServiceName AppEnvironmentExtra $nssmEnv | Out-Null

    Write-Host "[OK] Service '$ServiceName' registered with bundled node + nssm"

    # --- 4. Register the GUI agent at-logon Scheduled Task -----------------
    # Use the ScheduledTasks PowerShell module rather than schtasks.exe. schtasks.exe via the
    # `&` operator with /TR mangles the inner quotes around paths with spaces (e.g.
    # "C:\Program Files\TallyMCP\scripts\tally-gui-agent-v2.ps1"), producing
    # "Invalid argument/option - 'Files\...'". The cmdlet route uses real argument arrays so
    # paths with spaces survive without escape gymnastics. The module is built-in on
    # Windows Server 2008 R2+ / Windows 10+, so this is safe across our supported targets.
    $taskRegistered = $false
    try {
        # Best-effort cleanup of any stale registration. SilentlyContinue handles "not found".
        Unregister-ScheduledTask -TaskName $AgentTaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null

        $taskAction = New-ScheduledTaskAction `
            -Execute 'powershell.exe' `
            -Argument "-ExecutionPolicy Bypass -NoProfile -WindowStyle Minimized -File `"$agentScript`""
        $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $AgentTaskUser
        $taskPrincipal = New-ScheduledTaskPrincipal -UserId $AgentTaskUser -LogonType Interactive -RunLevel Limited
        $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        $taskDef = New-ScheduledTask -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Description "Tally MCP GUI agent (companion to TallyMCP service; spawns Tally + keystrokes credentials in user session)"
        Register-ScheduledTask -TaskName $AgentTaskName -InputObject $taskDef -Force | Out-Null
        $taskRegistered = $true
        Write-Host "[OK] Scheduled task '$AgentTaskName' registered (runs at logon, as $AgentTaskUser)"
    } catch {
        Write-Host "[WARN] Register-ScheduledTask failed: $_" -ForegroundColor Yellow
        Write-Host "       GUI agent task NOT registered. Re-run the wizard or register manually." -ForegroundColor Yellow
    }

    # Trigger the task once now so the agent is alive immediately, not just from next logon.
    # Without this, load-company calls fail with "GUI agent did not respond" until the user
    # logs out + back in. With it, the agent is running by the time the wizard finishes.
    if ($taskRegistered) {
        try {
            Start-ScheduledTask -TaskName $AgentTaskName
            Write-Host "[OK] GUI agent started in the current user session (PID will appear after a few seconds)"
        } catch {
            Write-Host "[WARN] Start-ScheduledTask failed: $_" -ForegroundColor Yellow
            Write-Host "       Task is registered but did not start now. It will start on next logon, or run 'Start-ScheduledTask -TaskName $AgentTaskName' manually." -ForegroundColor Yellow
        }
    }

    # --- 4b. Register the tray status app at-logon Scheduled Task ----------
    # Optional companion to the agent task (issue #20). Gives the operator a coloured tray
    # icon + right-click action menu so they don't need to run Get-Service / Get-ScheduledTask
    # by hand to know the system is healthy. Same constraints as the agent task (interactive
    # desktop only, runs as the same user, /RL LIMITED), so we mirror the registration code.
    $trayScript = Join-Path $InstallDir 'scripts\tray\tally-mcp-tray.ps1'
    $trayTaskRegistered = $false
    if ($SkipTrayTask) {
        Write-Host "[*] Skipping tray task registration (-SkipTrayTask)" -ForegroundColor DarkGray
    } elseif (-not (Test-Path -LiteralPath $trayScript)) {
        Write-Host "[WARN] Tray script not found at $trayScript - skipping at-logon registration" -ForegroundColor Yellow
    } else {
        try {
            Unregister-ScheduledTask -TaskName $TrayTaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null

            $trayArgs = "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$trayScript`" -InstallDir `"$InstallDir`" -ServiceName `"$ServiceName`" -AgentTaskName `"$AgentTaskName`""
            $trayAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $trayArgs
            $trayTrigger = New-ScheduledTaskTrigger -AtLogOn -User $AgentTaskUser
            $trayPrincipal = New-ScheduledTaskPrincipal -UserId $AgentTaskUser -LogonType Interactive -RunLevel Limited
            $traySettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
            $trayDef = New-ScheduledTask -Action $trayAction -Trigger $trayTrigger -Principal $trayPrincipal -Settings $traySettings -Description "Tally MCP status tray icon (issue #20; polls service/agent/Tally health and exposes admin actions)"
            Register-ScheduledTask -TaskName $TrayTaskName -InputObject $trayDef -Force | Out-Null
            $trayTaskRegistered = $true
            Write-Host "[OK] Scheduled task '$TrayTaskName' registered (runs at logon, as $AgentTaskUser)"
        } catch {
            Write-Host "[WARN] Tray Register-ScheduledTask failed: $_" -ForegroundColor Yellow
            Write-Host "       Tray icon NOT registered. Re-run the wizard or register manually." -ForegroundColor Yellow
        }
    }

    if ($trayTaskRegistered) {
        try {
            Start-ScheduledTask -TaskName $TrayTaskName
            Write-Host "[OK] Tray icon started in the current user session"
        } catch {
            Write-Host "[WARN] Tray Start-ScheduledTask failed: $_" -ForegroundColor Yellow
        }
    }

    # --- 5. Start the service ----------------------------------------------
    # Same defensive pattern: nssm start can write to stderr in benign cases (e.g. service
    # already running because Windows auto-started it on registration with SERVICE_AUTO_START).
    $savedPref3 = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $bundledNssm start $ServiceName 2>$null | Out-Null
    } finally {
        $ErrorActionPreference = $savedPref3
    }
    Start-Sleep -Seconds 3
    $svc = Get-Service -Name $ServiceName
    Write-Host "[OK] Service status after start: $($svc.Status)"

    # --- 6. Tell the operator what's next ----------------------------------
    Write-Host ""
    Write-Host "Configuration complete."
    Write-Host "  Service:        $ServiceName  ($($svc.Status))"
    Write-Host "  Agent task:     $AgentTaskName"
    Write-Host "  Tray task:      $TrayTaskName"
    Write-Host "  .env:           $envFile"
    Write-Host "  Logs:           $(Join-Path $InstallDir 'logs')"
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  1. Log out and back in (or run 'schtasks /Run /TN $AgentTaskName') to start the GUI agent."
    Write-Host "  2. Hit http://127.0.0.1:3000/.well-known/oauth-protected-resource to confirm the server responds."
    Write-Host "  3. (Production) point a reverse proxy at 127.0.0.1:3000 to terminate TLS."
    Write-Host ""
    Write-Host "NOTE: $transcript captures install activity. Delete it if PowerShell parameter binding"
    Write-Host "      may have logged the OAuth password and the box is shared with other admins."
}
finally {
    Stop-Transcript | Out-Null
}
