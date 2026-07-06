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
    # Opt-in for Claude-driven GUI control (gui-screenshot / gui-send-keys). Wizard passes
    # 'true'/'false'; a bare Reconfigure omits it, so we preserve the existing .env value below.
    [string]$EnableGuiControl,
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
# AGENT_TASK_USER is persisted in .env (below) and preferred over $env:USERNAME so a Reconfigure run
# by a DIFFERENT admin (the bare-InstallDir path omits -AgentTaskUser) does not silently re-point the
# agent task + all the icacls grants to that admin - which would break the IPC ACL for the real user.
$AgentTaskUser  = _Coalesce $AgentTaskUser  $_existingEnv['AGENT_TASK_USER']  $env:USERNAME
# ENABLE_GUI_CONTROL is off by default (arbitrary keystroke injection + screenshots). Preserve the
# existing value on a bare Reconfigure; normalize anything that isn't the literal 'true' to 'false'.
$EnableGuiControl = _Coalesce $EnableGuiControl $_existingEnv['ENABLE_GUI_CONTROL'] 'false'
if ($EnableGuiControl -ne 'true') { $EnableGuiControl = 'false' }

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

# Distinguish silent installer-driven runs (Inno passes -CredentialsFile and the
# window is auto-closed by the installer) from interactive reconfigure runs
# launched via the Start Menu shortcut. On the interactive path, the PowerShell
# host closes the window the moment the script returns — success or failure —
# which is why operators reported "nothing happens, window flashes shut" on the
# RDC: the script completed, they just couldn't see the output. Pause at the
# end so they can read it.
$Script:IsInteractiveRun = [string]::IsNullOrWhiteSpace($CredentialsFile)
function _PauseIfInteractive {
    if ($Script:IsInteractiveRun) {
        Write-Host ""
        Read-Host "Press Enter to close this window"
    }
}

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
            throw @"
Required file missing: $p

This script configures an installed Tally MCP deployment (it needs the bundled
node-portable, nssm, and built dist/ that the .exe installer drops alongside
itself). It can't run against a bare source checkout.

If you're trying to reconfigure a real installation, launch this from the
"Reconfigure Tally MCP" Start Menu shortcut (which points at the install dir,
typically C:\Program Files\TallyMCP\).

If you're a developer testing changes to firstrun-config.ps1 itself, either:
  - install the .exe first, then run the shortcut, OR
  - copy this script into an existing install dir and run it from there.
"@
        }
    }

    # --- 0. Normalize + validate MCP_DOMAIN before it reaches .env ----------
    # server.mjs builds every OAuth metadata URL by string-concatenating MCP_DOMAIN and also
    # calls `new URL(mcpDomain)`. A bare host (e.g. tally-mcp.attention.sh) therefore emits
    # schemeless OAuth metadata that every MCP client rejects, and a malformed value (e.g. an
    # accidental https:///host from a fat-fingered paste) yields broken metadata or throws at
    # startup. Operators type this by hand in the wizard, and this script is the single choke
    # point before the value is persisted, so normalize aggressively here and only fail when the
    # value is genuinely unparseable. Blank MUST stay blank ("localhost-only mode") - we never
    # turn an empty value into a scheme-only URL.
    if ($McpDomain -and $McpDomain.Trim().Length -gt 0) {
        $McpDomainOriginal = $McpDomain
        $normalized = $McpDomain.Trim()
        # 1. Ensure a scheme. A bare host -> https:// (the safe default for a public OAuth server).
        if ($normalized -notmatch '^https?://') {
            $normalized = "https://$normalized"
        }
        # 2. Collapse an accidental 3+ slashes right after the scheme (https:///host) to exactly two.
        $normalized = $normalized -replace '^(https?:)/+', '$1//'
        # 3. Strip trailing slash(es) so downstream string-concatenation doesn't double them.
        $normalized = $normalized.TrimEnd('/')
        # 4. Validate: it must parse to an absolute http/https URI with a non-empty host.
        $parsed = $normalized -as [uri]
        if (-not $parsed -or -not $parsed.IsAbsoluteUri -or `
            ($parsed.Scheme -ne 'http' -and $parsed.Scheme -ne 'https') -or `
            [string]::IsNullOrEmpty($parsed.Host)) {
            throw "MCP_DOMAIN value '$McpDomainOriginal' could not be normalized into a valid http(s) URL (best effort was '$normalized'). Fix it in the wizard or .env (expected e.g. https://tally-mcp.example.com)."
        }
        $McpDomain = $normalized
        if ($McpDomain -ne $McpDomainOriginal) {
            Write-Host "[OK] Normalized MCP_DOMAIN '$McpDomainOriginal' -> '$McpDomain'"
        }
    } else {
        # Whitespace-only (e.g. "   ") is not a domain - treat it as blank so the .env write below
        # takes the localhost-only branch instead of persisting MCP_DOMAIN=<spaces>.
        $McpDomain = ''
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
        "TALLY_HOST=127.0.0.1"
        "TALLY_PORT=9000"
        "TALLY_EXE_PATH=$(_envQuote $TallyExePath)"
        "TALLY_DATA_PATH=$(_envQuote $TallyDataPath)"
        "TALLY_INI_PATH=$(_envQuote $TallyIniPath)"
        # Persisted so a later Reconfigure preserves the agent user instead of falling back to
        # whoever runs the wizard (see the _Coalesce for $AgentTaskUser above).
        "AGENT_TASK_USER=$(_envQuote $AgentTaskUser)"
        # Claude-driven GUI control (gui-screenshot / gui-send-keys). Off unless the operator opted in.
        "ENABLE_GUI_CONTROL=$EnableGuiControl"
    )
    # Bind address (security): only listen on all interfaces when a public domain / reverse proxy
    # is explicitly configured. When MCP_DOMAIN is blank ("localhost-only mode") bind to loopback
    # so the OAuth-gated server is NOT reachable from the LAN. Older versions always wrote
    # BIND_HOST=0.0.0.0 even in the localhost-only path, silently exposing the server network-wide
    # (and the adjacent "binds to localhost only" comment was false).
    if ($McpDomain) {
        # A reverse proxy (Caddy/IIS/Cloudflare Tunnel) sits in front and restricts access.
        # Node listens only on 127.0.0.1 by default; a proxy that resolves `localhost` to ::1
        # first on Windows then gets 502, so bind all interfaces for the proxy to reach it.
        $envLines += "BIND_HOST=0.0.0.0"
        $envLines += "MCP_DOMAIN=$McpDomain"
    } else {
        $envLines += "BIND_HOST=127.0.0.1"
        $envLines += "# MCP_DOMAIN intentionally unset - server binds to localhost only (127.0.0.1)"
    }

    $envTmp = "$envFile.tmp"
    Set-Content -Path $envTmp -Value $envLines -Encoding UTF8
    Move-Item -Path $envTmp -Destination $envFile -Force
    Write-Host "[OK] Wrote $envFile ($($envLines.Count) lines)"

    # Lock down .env (security): it holds PASSWORD, the sole OAuth gate for every MCP tool.
    # Without this it inherits the install dir ACL (Program Files grants Users read by default,
    # and an upgrade previously widened it further), leaving the password readable by any local
    # user. Strip inheritance and grant only SYSTEM + Administrators + the agent task user,
    # mirroring the company-registry lockdown below.
    & icacls $envFile /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' "${AgentTaskUser}:F" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] Locked NTFS ACL on $envFile (SYSTEM + Administrators only)"
    } else {
        Write-Host "[WARN] icacls exit $LASTEXITCODE on $envFile - .env is not locked down" -ForegroundColor Yellow
    }

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

    # --- 1c. Lock down the GUI-agent IPC directory ------------------------
    # Security: the GUI agent and MCP server exchange commands via _mcp_gui_command.json /
    # _mcp_gui_result.json in the Tally data dir. Those commands type credentials and drive
    # keystrokes into the interactive Tally session, so the channel must NOT be world-writable.
    # The default data dir (C:\Users\Public\...\data) grants BUILTIN\Users write by default, so
    # any local user could drop a command file and inject keystrokes. Restrict the directory to
    # SYSTEM + Administrators + the agent task user. The (OI)(CI) inheritance flags are REQUIRED and
    # must be explicit: icacls does NOT reliably default to inheritable ACEs, so a bare "user:F" grants
    # the FOLDER only. Without (OI)(CI) the transient IPC files the SYSTEM service creates here do not
    # inherit the agent-user grant, and the GUI agent - which runs under a UAC-filtered (Limited) token
    # that drops Administrators - fails every read with "Access is denied". (Observed in the field: a
    # dir ACE of "tapanjain:(F)" instead of "tapanjain:(OI)(CI)(F)" left _mcp_gui_command.json granting
    # only SYSTEM + Administrators, and load-company looped on Access-denied.) NOTE for reviewers: this
    # changes the ACL of TALLY_DATA_PATH; validate Tally (interactive user = agent task user) still has
    # access on multi-account / service-account deployments.
    $ipcDir = Split-Path $registryFile
    if (Test-Path -LiteralPath $ipcDir) {
        & icacls $ipcDir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' "${AgentTaskUser}:(OI)(CI)F" 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] Locked NTFS ACL on IPC directory $ipcDir (SYSTEM + Administrators + $AgentTaskUser)"
        } else {
            Write-Host "[WARN] icacls exit $LASTEXITCODE on $ipcDir - GUI agent IPC directory is not locked down" -ForegroundColor Yellow
        }

        # Self-heal: clear any STALE IPC files left by a previous install/reconfigure. The MCP service
        # overwrites _mcp_gui_command.json IN PLACE, so a file created under an older/narrower ACL (e.g.
        # before this hardening, or by a reconfigure that ran as a different admin) KEEPS that stale ACL
        # forever. The GUI agent runs under a UAC-filtered "Limited" token (no Administrators), so if the
        # file lacks a direct grant to the agent user it fails with "Access is denied" and load-company
        # silently breaks. Deleting them here means the service recreates them fresh (atomic temp+rename),
        # inheriting the directory ACL we just set - so the operator never has to touch icacls by hand.
        foreach ($ipcName in @('_mcp_gui_command.json', '_mcp_gui_result.json', '_mcp_screenshot.png')) {
            $stale = Join-Path $ipcDir $ipcName
            if (Test-Path -LiteralPath $stale) {
                Remove-Item -LiteralPath $stale -Force -ErrorAction SilentlyContinue
                if (-not (Test-Path -LiteralPath $stale)) {
                    Write-Host "[OK] Cleared stale IPC file $ipcName (service recreates it with the correct ACL)"
                } else {
                    Write-Host "[WARN] Could not remove stale IPC file $stale - a running agent/service may hold it; it will be recreated on next command" -ForegroundColor Yellow
                }
            }
        }
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

    # --- Shutdown + restart behaviour (issue #23) --------------------------
    # Stop the service by sending a console Ctrl-C FIRST: Node receives it as SIGINT and runs the
    # graceful-shutdown path in server.mts (which drops MCP connections and exits in <1s). Only if
    # that stalls does NSSM escalate to WM_CLOSE -> thread messages -> TerminateProcess. Bounding the
    # console wait to 6s (and the next two stages to 1.5s each) keeps Stop-Service returning inside
    # ~10s even in the worst case, instead of hanging in StopPending until a manual taskkill.
    & $bundledNssm set $ServiceName AppStopMethodSkip    0     | Out-Null   # 0 = try every stop method
    & $bundledNssm set $ServiceName AppStopMethodConsole 6000  | Out-Null   # graceful Ctrl-C window
    & $bundledNssm set $ServiceName AppStopMethodWindow  1500  | Out-Null
    & $bundledNssm set $ServiceName AppStopMethodThreads 1500  | Out-Null
    # On an unexpected exit, restart with a sane delay rather than hammering. Throttle detection
    # (AppThrottle) means a process that keeps dying fast is left stopped instead of respawned into
    # the "Running but nothing listening" limbo we saw on cold installs — the real error then shows
    # up in logs/service.log (e.g. the PASSWORD FATAL line) instead of a silent crash-loop.
    & $bundledNssm set $ServiceName AppExit Default Restart    | Out-Null
    & $bundledNssm set $ServiceName AppRestartDelay 2000       | Out-Null
    & $bundledNssm set $ServiceName AppThrottle 5000           | Out-Null

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
catch {
    # Show the error in the console (PowerShell already prints it but the transcript
    # may have wrapped it). Then pause so the user can read it before the window closes.
    Write-Host ""
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Transcript: $transcript"
    _PauseIfInteractive
    throw
}
finally {
    Stop-Transcript | Out-Null
}
_PauseIfInteractive
