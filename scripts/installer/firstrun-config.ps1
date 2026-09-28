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

.PARAMETER Upgrade
    Unattended upgrade of an existing install (#177). The installer passes this for a silent run
    over an existing install, and for any run with /UPDATE; the daily TallyMCPUpdate task runs the
    installer that way as SYSTEM. In this mode:
      - .env is never written. Every setting comes from it and every line stays byte-for-byte as it was.
      - No setting parameter is accepted; passing one is refused rather than silently ignored.
      - The GUI-agent user comes from AGENT_TASK_USER in .env, or from the existing TallyMCPAgent
        task if .env predates that key. Never from the account running this script. If the two
        disagree, or neither exists, or the answer is SYSTEM or another service account, the run
        is refused.
      - The deployment mode is read, never changed.
      - Services and tasks that already exist are re-registered with the same identity (so the new
        release's definition applies) and restarted. Nothing that did not exist is created.
      - The Claude client configuration is left alone, unless the install has moved.
      - An existing tunnel service is re-registered with --token-file, the token file written from
        the TUNNEL_TOKEN in .env, and the registry copy scrubbed (#193). If the file cannot be
        locked down the tunnel is left unregistered and the run fails, so Setup exits 10.
      - The NTFS lockdown of .env, the company vault and the IPC directory is re-applied, by SID.
        If it cannot be, the run stops with an error (Setup exits 10); the preflight checks for
        this first.
    See docs/installer.md, "Unattended upgrade".

.PARAMETER PreflightOnly
    With -Upgrade: check that an upgrade can preserve everything, report, and change nothing. Exit 0
    if it can, 1 if not. The installer runs this before it stops or copies anything, so a refused
    upgrade leaves the running version untouched. The one thing it writes: scratch files holding no
    secret, to dry-run the lockdowns the upgrade will apply, each shredded again straight away -
    .tally-mcp-acl.preflight in the install folder and in the Tally data folder (the .env and vault
    lockdown, #230), and .tunnel-token.preflight when there is a tunnel to migrate (#193).

.NOTES
    Exit codes: 0 when everything was configured; non-zero (1) when anything failed - including a
    lockdown of .env, the company vault or the IPC directory that could not be applied and verified
    (the run stops there, #230), and a configured Cloudflare Tunnel that could not be registered
    (reported after the agent and tray are restarted). The installer reports a non-zero exit to the
    person installing it and, for a silent run, as Setup exit code 10.

.PARAMETER ReportFile
    With -PreflightOnly: also write the verdict to this file, so the installer can put the reason
    in its log.

.PARAMETER NoElevate
    Do not relaunch elevated. For the test harness (scripts\installer\test-firstrun-config.ps1),
    which replaces every privileged call with a stand-in. Run for real without elevation, the
    privileged steps simply fail.
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
    # '' is a MEANINGFUL value here: it means the wizard's "ask me later" option was chosen, so no
    # ENTRY_ORDER key is written and the server puts the question to the user at first write.
    [string]$EntryOrder,
    # Set by the installer, which knows it is running us in a hidden window with no keyboard.
    # NOT inferred from -CredentialsFile any more: local mode deliberately passes no credentials
    # file, so that inference made every local install hang on the "Press Enter" pause below,
    # waiting for a keypress the window could never receive.
    [switch]$Unattended,
    # --- Deployment mode: three orthogonal axes, not one key (#172, #177, #178) ---
    # No defaults here, per the fallback-chain convention above; they are resolved after .env is read.
    #   DEPLOYMENT_MODE  local|remote            is there a service and a listening port?      (#172)
    #   REMOTE_AUTH      oauth-password|paired   how do remote callers authenticate?           (#178)
    #   REMOTE_TRANSPORT tunnel|lan              how do they reach us?                         (#178)
    # These are deliberately separate. A paired remote install is remote + paired + tunnel, so
    # collapsing the first two onto one key leaves that configuration unexpressible - which is the
    # bug the three planning streams each hit independently.
    [string]$DeploymentMode,
    [string]$RemoteAuth,
    [string]$RemoteTransport,
    # Cloudflare Tunnel. When -TunnelToken is non-empty, a second NSSM service ($TunnelServiceName)
    # runs cloudflared so a NAT'd box gets a stable public HTTPS URL with no router config. Blank on a
    # bare Reconfigure -> preserved from .env below (like McpDomain), so a reconfigure doesn't drop it.
    [string]$TunnelServiceName = 'TallyMCPTunnel',
    [string]$TunnelToken,
    [switch]$SkipTrayTask,
    # --- Unattended upgrade (#177); see the comment-based help above ---
    [switch]$Upgrade,
    [switch]$PreflightOnly,
    [string]$ReportFile = '',
    [switch]$NoElevate
)

# --- Elevate, or say why we cannot (#172 C2) -----------------------------------------------------
# Almost everything below needs administrator rights: icacls on .env and the company vault, nssm,
# Register-ScheduledTask for another user. The installer always runs us elevated, but the
# "Reconfigure" Start Menu shortcut launches powershell.exe with no runas verb - so that path ran
# unelevated and every privileged call failed. Most are wrapped in `2>$null | Out-Null` to swallow
# benign stderr, which meant they failed SILENTLY: the operator saw a script that appeared to
# succeed while changing nothing.
#
# That is worse than an error. A "reconfigure" that silently skips the icacls calls can leave the
# .env and the company vault LESS protected than before, on a machine whose owner has just been told
# everything is fine.
#
# Relaunch ourselves elevated rather than merely warning, because a warning on a path people use to
# fix things is a warning nobody reads. Forward every bound parameter so the relaunched run behaves
# identically. If elevation is declined or unavailable, stop with a clear reason instead of doing
# half the work.
#
# A preflight changes nothing, so it has nothing to elevate for.
$_principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $PreflightOnly -and -not $NoElevate -and
    -not $_principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[*] Administrator rights are required; requesting elevation..." -ForegroundColor Yellow

    $_fwd = @('-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', "`"$PSCommandPath`"")
    foreach ($kv in $PSBoundParameters.GetEnumerator()) {
        if ($kv.Value -is [switch]) {
            if ($kv.Value.IsPresent) { $_fwd += "-$($kv.Key)" }
        } else {
            $_fwd += @("-$($kv.Key)", "`"$($kv.Value)`"")
        }
    }

    try {
        $_child = Start-Process -FilePath 'powershell.exe' -ArgumentList $_fwd -Verb RunAs -PassThru -Wait -ErrorAction Stop
        exit $_child.ExitCode
    } catch {
        Write-Host ""
        Write-Host "[ERROR] This script needs to run as Administrator and elevation was declined or unavailable." -ForegroundColor Red
        Write-Host "        Without it the service, the scheduled tasks and the NTFS lockdown on .env and the" -ForegroundColor Red
        Write-Host "        company password vault cannot be changed - and those failures would be silent." -ForegroundColor Red
        Write-Host "        Right-click 'Reconfigure Claudally' and choose 'Run as administrator'." -ForegroundColor Red
        Write-Host ""
        exit 1
    }
}

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

# --- Who may the GUI agent run as? ----------------------------------------------------------------
# The agent and the tray are interactive, per-user tasks: they drive the Tally window on the
# desktop of the person who uses it. A service identity has no such desktop. SYSTEM is exactly the
# account the daily update task runs as (#177), and $env:USERNAME under SYSTEM is the machine
# account ("HOSTNAME$"), so either would register a task that can never see Tally - and would
# re-point every ACL grant below at it. Returns why a user is unusable, or '' if it is fine.
function _AgentUserProblem {
    param([string]$User)
    $u = "$User".Trim()
    if (-not $u) { return 'it is empty' }
    $leaf = $u.Substring($u.LastIndexOf('\') + 1).ToUpperInvariant()
    if ($leaf -in @('SYSTEM', 'LOCALSYSTEM', 'LOCAL SERVICE', 'LOCALSERVICE', 'NETWORK SERVICE', 'NETWORKSERVICE')) {
        return "'$u' is a service account, not a person who can use Tally"
    }
    if ($leaf.EndsWith('$')) {
        return "'$u' is a computer or managed service account, not a person who can use Tally"
    }
    try {
        $sid = ([System.Security.Principal.NTAccount]$u).Translate([System.Security.Principal.SecurityIdentifier]).Value
        if ($sid -in @('S-1-5-18', 'S-1-5-19', 'S-1-5-20')) {
            return "'$u' resolves to a service account ($sid), not a person who can use Tally"
        }
    } catch {
        # Unresolvable here (e.g. a domain account with no DC in reach). Not grounds to refuse: task
        # registration below reports a genuinely unknown account.
        $null = $_
    }
    return ''
}

# Same account? Compare SIDs when both names resolve, so "alice", ".\alice" and "PC01\alice" match.
function _SameAccount {
    param([string]$A, [string]$B)
    $sids = foreach ($n in @($A, $B)) {
        try { ([System.Security.Principal.NTAccount]$n).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { '' }
    }
    if ($sids[0] -and $sids[1]) { return $sids[0] -eq $sids[1] }
    $strip = {
        param($n)
        $n = "$n".Trim()
        foreach ($p in @('.\', "$env:COMPUTERNAME\")) {
            if ($n.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase)) { $n = $n.Substring($p.Length) }
        }
        $n
    }
    return [string]::Equals((& $strip $A), (& $strip $B), [System.StringComparison]::OrdinalIgnoreCase)
}

function _GetTaskOrNull {
    param([string]$Name)
    try { return (Get-ScheduledTask -TaskName $Name -ErrorAction Stop | Select-Object -First 1) } catch { return $null }
}

# --- NTFS lockdown, by SID (#193, #230) -----------------------------------------------------------
# Defined here rather than beside the steps that use them because the -Upgrade preflight below
# dry-runs them before the installer stops anything; see there.
#
# Every lockdown in this script names its principals by SID, never by name. 'Administrators' is
# localised (Administratoren, Administrateurs, ...), and on a Windows whose language is not English
# `icacls ... 'Administrators:F'` fails with "No mapping between account names and security IDs"
# and changes NOTHING - so .env, the company vault and the IPC directory used to keep their
# inherited ACL (BUILTIN\Users can read Program Files) behind a yellow warning (#230). The agent
# user is resolved to its SID up front for the same reason, and so that an account that cannot be
# resolved at all stops the step before a file is touched.
$Script:SidSystem = 'S-1-5-18'
$Script:SidAdmins = 'S-1-5-32-544'

# Zero the bytes, then unlink: the same best-effort shred used for the credentials file and the
# .oauth-*.json stores below, so a removed secret is not trivially recoverable from free space.
# Returns $true when the file is gone afterwards.
function _ShredFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    try {
        $len = (Get-Item -LiteralPath $Path -Force).Length
        if ($len -gt 0) { [System.IO.File]::WriteAllBytes($Path, (New-Object byte[] $len)) }
    } catch {
        # Best effort: a file that cannot be zeroed is still unlinked below, and the return value
        # reports whether it is gone. Nothing to add here, so record that it was considered.
        $null = $_
    }
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return (-not (Test-Path -LiteralPath $Path))
}

# The SID of a Windows account, or a throw that says which account could not be resolved.
function _AccountSid([string]$Account) {
    try {
        return ([System.Security.Principal.NTAccount]$Account).Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        $e = $_.Exception
        if ($e.InnerException) { $e = $e.InnerException }
        throw "the Windows account '$Account' does not resolve to a security identifier on this machine, so nothing can be granted to it ($($e.Message))"
    }
}

# Runs icacls and returns its exit code, plus its output when it failed. With ErrorActionPreference
# 'Continue' (local to this function): under the 'Stop' the main body uses, Windows PowerShell 5.1
# turns a native command's stderr into a terminating error, so a failure would surface as a bare
# "No mapping between account names..." record rather than a message saying which path and why.
function _Icacls {
    $ErrorActionPreference = 'Continue'
    $out = @(& icacls @args 2>&1)
    $code = $LASTEXITCODE
    $text = ''
    if ($code -ne 0) { $text = (($out | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) -join ' ') }
    return [pscustomobject]@{ Code = $code; Text = $text }
}

# Restricts $Path to exactly SYSTEM, Administrators and $ExtraSids, then PROVES it with Get-Acl, or
# throws. Never trusts an exit code alone: the whole of #230 was a lockdown whose failure was only
# ever a return value. -Container adds (OI)(CI) so files created inside later inherit the same list;
# -OwnerAdministrators also makes Administrators the owner (an owner can always rewrite the DACL).
#
# /grant:r only replaces entries for the principals it names, so an explicit entry for anyone else
# (put there by hand, or by another program) would survive it and leave the "locked" path readable
# or writable by that account. Such entries are removed, by SID, and named in the output - the
# contract has always been "only these principals", and verify-deployment.ps1 fails the vault on
# any other allow entry. Returns the display names of what was removed.
function _LockDown {
    param([string]$Path, [string[]]$ExtraSids = @(), [switch]$Container, [switch]$OwnerAdministrators)
    $sids = @(@($Script:SidSystem, $Script:SidAdmins) + @($ExtraSids | Where-Object { $_ }) | Select-Object -Unique)
    $flags = ''
    if ($Container) { $flags = '(OI)(CI)' }
    $grants = @($sids | ForEach-Object { "*${_}:${flags}F" })
    $r = _Icacls $Path /inheritance:r /grant:r @grants
    if ($r.Code -ne 0) { throw "icacls exit $($r.Code) while setting the ACL on ${Path}: $($r.Text)" }
    if ($OwnerAdministrators) {
        $r = _Icacls $Path /setowner "*$Script:SidAdmins"
        if ($r.Code -ne 0) { throw "icacls exit $($r.Code) while setting the owner of ${Path}: $($r.Text)" }
    }

    $sidType = [System.Security.Principal.SecurityIdentifier]
    $removed = @()
    $foreign = @((Get-Acl -LiteralPath $Path).GetAccessRules($true, $true, $sidType) |
                 Where-Object { -not $_.IsInherited -and $sids -notcontains $_.IdentityReference.Value } |
                 ForEach-Object { $_.IdentityReference.Value } | Select-Object -Unique)
    foreach ($f in $foreign) {
        $r = _Icacls $Path /remove "*$f"
        if ($r.Code -ne 0) { throw "icacls exit $($r.Code) while removing the entry for $f from ${Path}: $($r.Text)" }
        $name = $f
        try { $name = "$(([System.Security.Principal.SecurityIdentifier]$f).Translate([System.Security.Principal.NTAccount]).Value) ($f)" } catch { $null = $_ }
        $removed += $name
    }

    # Prove it. Deny entries are ignored: they can only narrow access.
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) { throw "inheritance is still enabled on $Path" }
    $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
    $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $allows = @($acl.GetAccessRules($true, $true, $sidType) |
                Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow })
    foreach ($rule in $allows) {
        if ($sids -notcontains $rule.IdentityReference.Value) { throw "$Path still grants access to $($rule.IdentityReference.Value)" }
    }
    foreach ($sid in $sids) {
        $ok = @($allows | Where-Object {
            $_.IdentityReference.Value -eq $sid -and
            (($_.FileSystemRights -band $fullControl) -eq $fullControl) -and
            ((-not $Container) -or (($_.InheritanceFlags -band $inherit) -eq $inherit))
        })
        if ($ok.Count -eq 0) { throw "the grant to $sid did not take effect on $Path" }
    }
    if ($OwnerAdministrators) {
        $ownerSid = $acl.GetOwner($sidType).Value
        if (@($Script:SidSystem, $Script:SidAdmins) -notcontains $ownerSid) { throw "the owner of $Path is $ownerSid, not Administrators" }
    }
    return , $removed
}

# Creates $Path EMPTY and locks it down before anything is written to it, or throws having written
# nothing (and leaves no file behind). Until the lockdown it carries its folder's inherited ACL, so
# it must hold nothing worth reading during that window. Starts from a fresh file: an old one could
# carry entries of its own. Overwriting it afterwards keeps the DACL.
function _NewLockedFile {
    param([string]$Path, [string[]]$ExtraSids = @(), [switch]$OwnerAdministrators)
    if (-not (_ShredFile $Path)) { throw "could not remove the existing $Path" }
    [System.IO.File]::WriteAllBytes($Path, (New-Object byte[] 0))
    try {
        $null = _LockDown -Path $Path -ExtraSids $ExtraSids -OwnerAdministrators:$OwnerAdministrators
    } catch {
        $null = _ShredFile $Path
        throw
    }
}

# The tunnel token (#193): readable by SYSTEM + Administrators only, owned by Administrators - the
# descriptor cloudflared's own `service install` gives its token file. Not the agent user: nothing
# that runs as that account needs the token. Throws having written no secret.
function _WriteLockedTokenFile([string]$Path, [string]$Token) {
    _NewLockedFile -Path $Path -OwnerAdministrators
    # No BOM and no newline: cloudflared TrimSpace()s the contents, but a BOM is not whitespace and
    # would make the token unparseable.
    [System.IO.File]::WriteAllText($Path, $Token, (New-Object System.Text.UTF8Encoding($false)))
}

# Dry run of the .env / company-vault lockdown in $Dir, on a scratch file holding no secret, through
# the same function the real step uses; shredded again whatever happens. For the -Upgrade preflight.
# Returns '' on success or why it failed.
function _ProbeLockDown([string]$Dir, [string]$AgentSid) {
    $probe = Join-Path $Dir '.tally-mcp-acl.preflight'
    $why = ''
    try {
        _NewLockedFile -Path $probe -ExtraSids @($AgentSid)
    } catch {
        $why = $_.Exception.Message
    }
    if (-not (_ShredFile $probe)) { $why = ("$why could not remove the probe file $probe afterwards.").Trim() }
    return $why
}

# --- Unattended upgrade: resolve everything from what is already there (#177) --------------------
# The daily update task runs the installer silently, as SYSTEM, with nobody to ask. Before this
# mode existed, the installer handed its wizard's auto-detected DEFAULTS to this script - not the
# install's values - and passed values win over .env (see the fallback chain above). So a silent
# upgrade reset custom Tally paths and the edition, re-applied a stale GUI-control choice, and
# re-pointed the agent task at whoever ran it. -Upgrade takes nothing from the command line and
# nothing from the running account: only from .env and the registrations that already exist.
# Everything it cannot establish for certain is refused - before anything is changed.
$_upgradeProblems      = @()
$_upgradeAgentUser     = ''
$_upgradeTaskExisted   = @{}
$_upgradeInstallMoved  = $false
if ($PreflightOnly -and -not $Upgrade) {
    throw '-PreflightOnly only applies together with -Upgrade.'
}
if ($Upgrade) {
    $_settingParams = @('TallyEdition', 'TallyExePath', 'TallyDataPath', 'TallyIniPath', 'McpDomain',
                        'AgentTaskUser', 'EnableGuiControl', 'EntryOrder', 'DeploymentMode', 'RemoteAuth',
                        'RemoteTransport', 'TunnelToken', 'CredentialsFile')
    $_passed = @($_settingParams | Where-Object { $PSBoundParameters.ContainsKey($_) })
    if ($_passed.Count -gt 0) {
        $_upgradeProblems += ("an upgrade takes every setting from the existing .env, but these were passed: -" +
                              ($_passed -join ', -') + ". Drop them, or run without -Upgrade to change settings.")
    }

    $_envPath = Join-Path $InstallDir '.env'
    if (-not (Test-Path -LiteralPath $_envPath)) {
        $_upgradeProblems += "there is no $_envPath, so there is no existing configuration to preserve. A new install needs the interactive installer, or /AGENTUSER=<windows user> for a silent one."
    } elseif ($_existingEnv.Count -eq 0) {
        $_upgradeProblems += "$_envPath has no settings in it (or could not be read), so there is nothing to preserve. Run Reconfigure from the Start Menu to repair it."
    } else {
        $_agentTask = _GetTaskOrNull $AgentTaskName
        $_trayTask  = _GetTaskOrNull $TrayTaskName
        $_upgradeTaskExisted[$AgentTaskName] = [bool]$_agentTask
        $_upgradeTaskExisted[$TrayTaskName]  = [bool]$_trayTask

        $_envUser  = "$($_existingEnv['AGENT_TASK_USER'])".Trim()
        $_taskUser = ''
        foreach ($_t in @($_agentTask, $_trayTask)) {
            if (-not $_taskUser -and $_t -and $_t.Principal -and $_t.Principal.UserId) { $_taskUser = "$($_t.Principal.UserId)".Trim() }
        }
        if ($_envUser -and $_taskUser -and -not (_SameAccount $_envUser $_taskUser)) {
            $_upgradeProblems += "AGENT_TASK_USER in .env is '$_envUser' but the existing agent task runs as '$_taskUser'. An unattended upgrade will not guess which is right; run Reconfigure from the Start Menu to settle it."
        } else {
            $_upgradeAgentUser = _Coalesce $_envUser $_taskUser
            if (-not $_upgradeAgentUser) {
                $_upgradeProblems += "neither .env (AGENT_TASK_USER) nor an existing $AgentTaskName task says which Windows user runs Tally. Run Reconfigure from the Start Menu once, as that user's administrator."
            } else {
                $_why = _AgentUserProblem $_upgradeAgentUser
                if ($_why) { $_upgradeProblems += "the recorded GUI-agent user is unusable: $_why. Run Reconfigure from the Start Menu to set the right one." }
            }
        }

        # Has the install moved since the agent task was registered? That is the one case in which
        # the Claude client configuration (which records the install path) must be rewritten.
        if ($_agentTask) {
            $_taskArgs = (@($_agentTask.Actions) | ForEach-Object { "$($_.Arguments)" }) -join ' '
            $_here = $InstallDir.TrimEnd('\') + '\scripts\'
            if ($_taskArgs -and $_taskArgs.IndexOf($_here, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
                $_upgradeInstallMoved = $true
            }
        }

        foreach ($_k in @(@('DEPLOYMENT_MODE', @('local', 'remote')), @('REMOTE_AUTH', @('oauth-password', 'paired')), @('REMOTE_TRANSPORT', @('tunnel', 'lan')))) {
            $_v = $_existingEnv[$_k[0]]
            if ($_v -and ($_k[1] -notcontains $_v)) {
                $_upgradeProblems += "$($_k[0]) in .env is '$_v', which is not one of: $($_k[1] -join ', '). Fix it in $_envPath."
            }
        }

        # The Cloudflare Tunnel (#193). An upgrade re-registers an existing tunnel service with
        # --token-file, writing the token from .env into a file locked to SYSTEM + Administrators, and
        # fails closed - no tunnel - if it cannot lock that file down. Find out now, before the
        # installer stops anything, whether that step can succeed:
        #   - a tunnel service with no TUNNEL_TOKEN in .env could only be removed, not re-registered
        #     (its only other copy of the token is the service registry, which #193 no longer uses);
        #   - the lockdown itself is dry-run on a scratch file in the same folder, with a value that
        #     is not a secret, through the very function the real step uses, then shredded.
        # Only relevant in remote mode: a local-mode run removes any tunnel, as on every run.
        $_mode = _Coalesce $_existingEnv['DEPLOYMENT_MODE'] 'remote'
        $_tunnelSvc = Get-Service -Name $TunnelServiceName -ErrorAction SilentlyContinue
        if ($_mode -eq 'remote' -and $_tunnelSvc) {
            if (-not "$($_existingEnv['TUNNEL_TOKEN'])".Trim()) {
                $_upgradeProblems += "the '$TunnelServiceName' service exists but .env has no TUNNEL_TOKEN, so an upgrade could only remove the tunnel. Run Reconfigure from the Start Menu to set the token (or blank it deliberately)."
            } else {
                $_probe = Join-Path $InstallDir '.tunnel-token.preflight'
                try {
                    _WriteLockedTokenFile $_probe 'upgrade-preflight-probe-not-a-token'
                } catch {
                    $_upgradeProblems += "a locked-down tunnel token file cannot be written in ${InstallDir} ($($_.Exception.Message)), so the upgrade would have to leave the '$TunnelServiceName' service unregistered. Run Setup elevated, or check that folder's permissions."
                } finally {
                    if (-not (_ShredFile $_probe)) { $_upgradeProblems += "could not remove the preflight probe file $_probe." }
                }
            }
        }

        # The .env, company-vault and IPC-directory lockdowns (#230). An upgrade re-applies all three
        # and fails closed if it cannot - after the installer has stopped the service. So find out
        # now: the agent user must resolve to a SID (every grant is by SID), and the lockdown is
        # dry-run on a scratch file, holding no secret, in the install folder (.env) and in the Tally
        # data folder (the vault, and the IPC directory it lives in). Only once nothing else has
        # refused: the probes need a known agent user, and a refused run should write nothing.
        if ($_upgradeProblems.Count -eq 0) {
            $_agentSid = ''
            try { $_agentSid = _AccountSid $_upgradeAgentUser } catch { $_upgradeProblems += "$($_.Exception.Message). Run Reconfigure from the Start Menu to set a user that exists." }
            if ($_agentSid) {
                $_dataDir = _Coalesce $_existingEnv['TALLY_DATA_PATH'] 'C:\Users\Public\TallyPrimeEditLog\data'
                foreach ($_probeDir in @($InstallDir, $_dataDir)) {
                    # A data folder that does not exist yet is created by the real step under its
                    # parent's permissions; there is nothing to probe until then.
                    if (-not (Test-Path -LiteralPath $_probeDir -PathType Container)) { continue }
                    $_why = _ProbeLockDown $_probeDir $_agentSid
                    if ($_why) {
                        $_upgradeProblems += "the configuration files in ${_probeDir} cannot be locked down to SYSTEM, Administrators and '$_upgradeAgentUser' ($_why), and an upgrade will not leave them readable by other local accounts. Run Setup elevated, or check that folder's permissions."
                    }
                }
            }
        }
    }

    $_verdict = if ($_upgradeProblems.Count -eq 0) {
        $_modeShown = _Coalesce $_existingEnv['DEPLOYMENT_MODE'] 'remote (no DEPLOYMENT_MODE key; an install that predates it)'
        "OK: the upgrade can preserve this install. Deployment mode: $_modeShown. GUI-agent user: $_upgradeAgentUser."
    } else {
        "REFUSED: an unattended upgrade cannot preserve this install, so nothing was changed.`r`n" +
            (($_upgradeProblems | ForEach-Object { " - $_" }) -join "`r`n")
    }

    if ($PreflightOnly) {
        Write-Host $_verdict
        if ($ReportFile) {
            try { [System.IO.File]::WriteAllText($ReportFile, $_verdict, (New-Object System.Text.UTF8Encoding $false)) } catch { Write-Host "[WARN] Could not write ${ReportFile}: $_" }
        }
        if ($_upgradeProblems.Count -eq 0) { exit 0 } else { exit 1 }
    }
    if ($_upgradeProblems.Count -gt 0) {
        # The transcript has not started yet; leave the reason where support will look for it.
        try {
            $_log = Join-Path $InstallDir 'logs\firstrun-config.log'
            New-Item -ItemType Directory -Force -Path (Split-Path $_log) | Out-Null
            Add-Content -LiteralPath $_log -Value "[$(Get-Date -Format 'o')] $_verdict"
        } catch { $null = $_ }
        throw $_verdict
    }
}

$TallyEdition   = _Coalesce $TallyEdition   $_existingEnv['TALLY_EDITION']   'silver'
$TallyExePath   = _Coalesce $TallyExePath   $_existingEnv['TALLY_EXE_PATH']   'C:\Program Files\TallyPrimeEditLog\tally.exe'
$TallyDataPath  = _Coalesce $TallyDataPath  $_existingEnv['TALLY_DATA_PATH']  'C:\Users\Public\TallyPrimeEditLog\data'
$TallyIniPath   = _Coalesce $TallyIniPath   $_existingEnv['TALLY_INI_PATH']   'C:\Program Files\TallyPrimeEditLog\tally.ini'
# MCP_DOMAIN has no hardcoded default - blank means "localhost-only mode".
$McpDomain      = _Coalesce $McpDomain      $_existingEnv['MCP_DOMAIN']       ''
# AGENT_TASK_USER is persisted in .env (below) and preferred over $env:USERNAME so a Reconfigure run
# by a DIFFERENT admin (the bare-InstallDir path omits -AgentTaskUser) does not silently re-point the
# agent task + all the icacls grants to that admin - which would break the IPC ACL for the real user.
#
# The running account is only a fallback for a person at a keyboard (a bare Reconfigure of an install
# that predates the key). An unattended run has no such person - under the update task it is SYSTEM -
# so it must be told, or be an upgrade, which resolved the user above from what already exists.
if ($Upgrade) {
    $AgentTaskUser = $_upgradeAgentUser
} else {
    $AgentTaskUser = _Coalesce $AgentTaskUser $_existingEnv['AGENT_TASK_USER'] $(if ($Unattended) { '' } else { $env:USERNAME })
}
$_agentUserWhy = _AgentUserProblem $AgentTaskUser
if ($_agentUserWhy) {
    throw ("Cannot choose the Windows user the GUI agent runs as: $_agentUserWhy. Pass -AgentTaskUser <the person who uses Tally>" +
           $(if ($Unattended) { " (for a silent install: /AGENTUSER=<user>)." } else { "." }))
}
# ENABLE_GUI_CONTROL is ON by default, matching the installer checkbox (tally-mcp.iss), which has
# always defaulted it checked. This fallback only applies when NO value is passed and none is on
# record - a bare Reconfigure of a pre-flag install, or a manual/dev run of this script. It used to
# say 'false', which meant those paths silently disagreed with the wizard and shipped a server whose
# GUI tools were absent.
#
# On by default because it is the SUPERVISED path: gui-screenshot + gui-send-keys are how Claude
# looks at the Tally window before deciding each keystroke. Turning it off does not stop keystroke
# injection - the company-loading tools still send keys - it only removes the ability to SEE, which
# leaves a modal dialog on screen that nothing can then clear.
#
# An operator who deliberately set 'false' keeps it: $_existingEnv is consulted first.
$EnableGuiControl = _Coalesce $EnableGuiControl $_existingEnv['ENABLE_GUI_CONTROL'] 'true'
if ($EnableGuiControl -ne 'true') { $EnableGuiControl = 'false' }
# Update notification. Opt-OUT: an install that cannot learn a newer release exists can only be
# reached by emailing its owner, which is the position this replaces. Preserved across a
# Reconfigure, so an operator who turned it off keeps it off.
$UpdateCheck = _Coalesce $_existingEnv['UPDATE_CHECK'] 'true'
if ($UpdateCheck -ne 'false') { $UpdateCheck = 'true' }

# Voucher entry order. Unlike every other setting here there is NO default: an absent key is how the
# server knows nobody has answered yet, which is what makes it ask the user instead of silently
# deciding how every voucher in their books will read. An existing value is preserved; an
# unrecognised one is dropped so a typo becomes "ask" rather than a layout nobody chose.
$EntryOrder = _Coalesce $EntryOrder $_existingEnv['ENTRY_ORDER'] ''
if ($EntryOrder -notin @('credit-first', 'debit-first')) { $EntryOrder = '' }
# Cloudflare Tunnel token: preserve across a bare Reconfigure (like MCP_DOMAIN). Blank = no tunnel,
# and a previously-configured tunnel is torn down below. Trim so a stray-space value counts as blank.
$TunnelToken = ("$(_Coalesce $TunnelToken $_existingEnv['TUNNEL_TOKEN'] '')").Trim()

# --- Deployment mode ------------------------------------------------------------------------------
# UPGRADE SAFETY IS THE WHOLE POINT OF THIS BLOCK. An install created before these keys existed has
# no DEPLOYMENT_MODE in .env, and must keep behaving exactly as it does today: service, listener,
# OAuth password. So an EXISTING install falls back to 'remote' while a FRESH one defaults to
# 'local'. Backwards, this silently tears the service out of every deployed instance on upgrade.
$_isExistingInstall = $_existingEnv.Count -gt 0

$DeploymentMode  = _Coalesce $DeploymentMode  $_existingEnv['DEPLOYMENT_MODE']  $(if ($_isExistingInstall) { 'remote' } else { 'local' })
$RemoteAuth      = _Coalesce $RemoteAuth      $_existingEnv['REMOTE_AUTH']      'oauth-password'
$RemoteTransport = _Coalesce $RemoteTransport $_existingEnv['REMOTE_TRANSPORT'] 'tunnel'

# Validate terminally, and never coalesce an unrecognised value to a default - a typo in .env must
# stop the run, not quietly pick a deployment mode for the operator.
#
# A [ValidateSet] on the parameter DOES re-validate on assignment (verified: assigning an
# out-of-set value throws ValidationMetadataException, it does not silently keep the old one), so
# the attribute alone would fail closed. It is not used here because the exception it raises names
# a PowerShell internal and says nothing about which file to edit - useless to whoever is watching
# an installer. Check explicitly and say what to do instead.
function _AssertOneOf {
    param([string]$Name, [string]$Value, [string[]]$Allowed)
    if ($Allowed -notcontains $Value) {
        throw ("$Name is '$Value', which is not one of: " + ($Allowed -join ', ') +
               ". Fix it in " + (Join-Path $InstallDir '.env') + " and re-run, or pass -$Name explicitly.")
    }
}
_AssertOneOf 'DEPLOYMENT_MODE'  $DeploymentMode  @('local','remote')
_AssertOneOf 'REMOTE_AUTH'      $RemoteAuth      @('oauth-password','paired')
_AssertOneOf 'REMOTE_TRANSPORT' $RemoteTransport @('tunnel','lan')

# --- Resolve OAuth password ---
# Two entry paths:
#   1. Inno Setup wizard: passes -CredentialsFile pointing at a JSON in the installer's user-only
#      temp folder. We read + delete it immediately so the password never sits on a process command
#      line where Get-CimInstance Win32_Process could observe it.
#   2. Interactive "Reconfigure" Start Menu shortcut: re-runs this script with only -InstallDir.
#      We prompt the operator securely via Read-Host -AsSecureString.
#
# LOCAL MODE HAS NO PASSWORD AT ALL (#172). The OAuth password exists to gate an HTTP listener;
# local mode has no listener, so the credential that currently gates read AND write on live books
# simply does not exist. That is the single strongest security property #172 claims, and it is only
# true if we never create it - not if we create one and leave it unused. So the whole block below
# is skipped, and any credentials file the installer wrote is still shredded rather than left on
# disk for the next process to find.
$Password = $null
if ($Upgrade) {
    # Nothing to resolve: an upgrade never rewrites .env, so the password (if any) stays exactly
    # where it is and is never read, prompted for or passed anywhere.
    Write-Host "[OK] Upgrade: the existing .env (and any password in it) is left as it is"
} elseif ($DeploymentMode -eq 'local') {
    if ($CredentialsFile -and (Test-Path -LiteralPath $CredentialsFile)) {
        $null = _ShredFile $CredentialsFile
        Write-Host "[OK] Local mode: no OAuth password is created; the installer's credentials file was shredded"
    } else {
        Write-Host "[OK] Local mode: no OAuth password is created"
    }
} elseif ($CredentialsFile -and $CredentialsFile.Trim().Length -gt 0) {
    if (-not (Test-Path -LiteralPath $CredentialsFile)) {
        throw "Credentials file not found at '$CredentialsFile'. Inno Setup should have written it before invoking this script."
    }
    $credsRaw = $null
    try {
        $credsRaw = [System.IO.File]::ReadAllText($CredentialsFile, [System.Text.Encoding]::UTF8)
    } finally {
        # Best-effort secure delete: overwrite with zeros, then unlink. Bounded residual exposure.
        $null = _ShredFile $CredentialsFile
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
} elseif ($Unattended) {
    # Nobody is at a keyboard ([Run] is runhidden; the update task has no desktop), so the prompt
    # below would hang the install forever. Say what is missing instead.
    throw "Remote mode needs an OAuth password, and none was supplied or found in $(Join-Path $InstallDir '.env'). Run Reconfigure from the Start Menu to set one."
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
# host closes the window the moment the script returns - success or failure -
# which is why operators reported "nothing happens, window flashes shut" on the
# RDC: the script completed, they just couldn't see the output. Pause at the
# end so they can read it.
# -Unattended is authoritative. The CredentialsFile heuristic is kept only as a fallback for a
# caller that predates the switch: it is right for remote installs (which always pass one) and
# wrong for local ones, which is exactly the bug the switch exists to close.
$Script:IsInteractiveRun = (-not $Unattended) -and (-not $Upgrade) -and [string]::IsNullOrWhiteSpace($CredentialsFile)
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
    Write-Host "Mode         = $DeploymentMode$(if ($Upgrade) { ' (unattended upgrade: every setting preserved)' })"

    $bundledNode = Join-Path $InstallDir 'node-portable\node.exe'
    $bundledNssm = Join-Path $InstallDir 'bin\nssm.exe'
    $serverEntry = Join-Path $InstallDir 'dist\server.mjs'
    $envFile     = Join-Path $InstallDir '.env'
    $agentScript = Join-Path $InstallDir 'scripts\tally-gui-agent-v2.ps1'

    # The prerequisite list is mode-dependent, and was not (#172 C3/C5). Local mode registers no
    # service, so it never invokes nssm.exe, and it runs dist\index.mjs rather than dist\server.mjs -
    # yet a local install refused to proceed without both. That is not merely pedantic: it blocks a
    # local-only installer from dropping the service tooling it will never call, and an install that
    # demands files it does not use is telling the operator something untrue about what it needs.
    $required = @($bundledNode, $agentScript)
    if ($DeploymentMode -eq 'remote') {
        $required += $bundledNssm    # only the service path shells out to nssm
        $required += $serverEntry    # dist\server.mjs is the HTTP entrypoint
    } else {
        $required += (Join-Path $InstallDir 'dist\index.mjs')   # the stdio entrypoint local mode uses
    }

    foreach ($p in $required) {
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
    # An upgrade writes no .env, so there is nothing to normalize - and refusing an update over a
    # value the running version already accepts would help nobody.
    if ($Upgrade) {
        # Leave $McpDomain exactly as .env has it.
    } elseif ($McpDomain -and $McpDomain.Trim().Length -gt 0) {
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
        "TALLY_EDITION=$TallyEdition"
        "TALLY_HOST=127.0.0.1"
        "TALLY_PORT=9000"
        "TALLY_EXE_PATH=$(_envQuote $TallyExePath)"
        "TALLY_DATA_PATH=$(_envQuote $TallyDataPath)"
        "TALLY_INI_PATH=$(_envQuote $TallyIniPath)"
        # Persisted so a later Reconfigure preserves the agent user instead of falling back to
        # whoever runs the wizard (see the _Coalesce for $AgentTaskUser above).
        "AGENT_TASK_USER=$(_envQuote $AgentTaskUser)"
        # Claude-driven GUI control (gui-screenshot / gui-send-keys). On unless the operator opted out.
        "ENABLE_GUI_CONTROL=$EnableGuiControl"
        # Update notification. The tray checks once a day whether a newer release exists and, if so,
        # says so. It downloads and runs NOTHING - that is a separate, signed channel (#177). Written
        # explicitly rather than left to a default so the key is visible to anyone auditing .env, and
        # so turning it off is a one-word edit.
        "UPDATE_CHECK=$UpdateCheck"
        # Written ONLY when the operator actually chose one. The key's absence is the signal that
        # the question is still open - see the comment on $EntryOrder above.
        if ($EntryOrder) { "ENTRY_ORDER=$EntryOrder" }
        # Deployment mode (#172). 'local' means no service, no listening port and no OAuth password;
        # 'remote' is the pre-existing behaviour and stays the fallback for any install that predates
        # this key. REMOTE_AUTH and REMOTE_TRANSPORT are consumed by #178 and are written now so the
        # three epics cannot collide over one key's vocabulary.
        "DEPLOYMENT_MODE=$DeploymentMode"
        "REMOTE_AUTH=$RemoteAuth"
        "REMOTE_TRANSPORT=$RemoteTransport"
    )

    # PASSWORD is written ONLY in remote mode. It gates the HTTP listener; local mode has no
    # listener, so writing an unused credential would falsify the claim #172 is built on ("the
    # credential that currently gates read and write on live books does not exist in this mode")
    # while still leaving a secret on disk for anyone who later reads .env. Absence is the feature.
    if ($DeploymentMode -eq 'remote') {
        $envLines += "PASSWORD=$(_envQuote $Password)"
    }
    # Bind address (security): only listen on all interfaces when a public domain / reverse proxy
    # is explicitly configured. When MCP_DOMAIN is blank ("localhost-only mode") bind to loopback
    # so the OAuth-gated server is NOT reachable from the LAN. Older versions always wrote
    # BIND_HOST=0.0.0.0 even in the localhost-only path, silently exposing the server network-wide
    # (and the adjacent "binds to localhost only" comment was false).
    # None of the network keys are written in local mode. There is no listener to bind, no public
    # hostname to advertise, and no tunnel to run, so BIND_HOST / MCP_DOMAIN / TUNNEL_TOKEN would
    # all be inert - and TUNNEL_TOKEN in particular is a live bearer credential that must not sit in
    # a file it can never be used from. A token supplied to a local-mode run is a contradiction
    # rather than an oversight, so say so instead of silently dropping it.
    if ($DeploymentMode -eq 'local') {
        $envLines += "# Local mode: no listener, so BIND_HOST / MCP_DOMAIN / CORS_ORIGINS are not written."
        if ($TunnelToken) {
            Write-Host "[WARN] A Cloudflare Tunnel token was supplied but DEPLOYMENT_MODE is 'local'." -ForegroundColor Yellow
            Write-Host "       Local mode runs no listener for a tunnel to reach, so the token is NOT being written" -ForegroundColor Yellow
            Write-Host "       to .env and no tunnel service will be registered. Re-run with -DeploymentMode remote" -ForegroundColor Yellow
            Write-Host "       if a tunnel is what you wanted." -ForegroundColor Yellow
        }
    } elseif ($TunnelToken -and -not $McpDomain) {
        Write-Host "[WARN] A Cloudflare Tunnel token was supplied but MCP_DOMAIN (the public hostname) is blank." -ForegroundColor Yellow
        Write-Host "       The tunnel will run, but the OAuth metadata URL will be wrong until you set the hostname (Reconfigure)." -ForegroundColor Yellow
    }
    if ($DeploymentMode -eq 'local') {
        # Nothing to add - the comment line above records why.
    } elseif ($TunnelToken) {
        # Cloudflare Tunnel: cloudflared makes an OUTBOUND connection to Cloudflare's edge and reaches
        # the MCP server on loopback, so the server never needs to listen beyond 127.0.0.1 - strictly
        # more secure than the bring-your-own reverse-proxy path below (which must bind 0.0.0.0).
        # MCP_DOMAIN stays the public hostname so OAuth discovery advertises the right URL.
        $envLines += "BIND_HOST=127.0.0.1"
        if ($McpDomain) { $envLines += "MCP_DOMAIN=$McpDomain" }
        $envLines += "TUNNEL_TOKEN=$(_envQuote $TunnelToken)"
    } elseif ($McpDomain) {
        # A reverse proxy (Caddy/IIS) the operator runs themselves sits in front and restricts access.
        # Node listens only on 127.0.0.1 by default; a proxy that resolves `localhost` to ::1
        # first on Windows then gets 502, so bind all interfaces for the proxy to reach it.
        $envLines += "BIND_HOST=0.0.0.0"
        $envLines += "MCP_DOMAIN=$McpDomain"
    } else {
        $envLines += "BIND_HOST=127.0.0.1"
        $envLines += "# MCP_DOMAIN intentionally unset - server binds to localhost only (127.0.0.1)"
    }

    # An upgrade does not write .env at all. Regenerating it from the template above - even from
    # values read out of it - would drop every key the template does not know (TALLY_PORT is
    # hard-coded to 9000 there, CORS_ORIGINS and READONLY_MODE are not in it at all) and reformat
    # the rest. Byte-for-byte unchanged is the only property an unattended run can promise. (Its
    # ACL is still re-applied, below.)
    #
    # Lock down .env (security): it holds PASSWORD, the sole OAuth gate for every MCP tool, and
    # TUNNEL_TOKEN on a tunnel install. Without this it inherits the install dir ACL (Program Files
    # grants Users read by default, and an upgrade previously widened it further), leaving the
    # password readable by any local user. Strip inheritance and grant only SYSTEM + Administrators
    # + the agent task user (the tray rewrites .env in place as that user), by SID - see _LockDown.
    #
    # FAIL CLOSED (#230). A lockdown that fails stops the run, with an error and a non-zero exit;
    # it used to print a yellow [WARN] and carry on with the password readable by every local
    # account. And the new .env is written into a file that is ALREADY locked down - created empty
    # as .env.tmp, locked and verified, then filled and renamed over .env (a rename keeps the
    # file's own ACL) - so a failed lockdown writes no secret at all and leaves the previous .env
    # exactly as it was.
    $agentSid = _AccountSid $AgentTaskUser
    if ($Upgrade) {
        Write-Host "[OK] Upgrade: $envFile left exactly as it was"
        try {
            $removedAces = _LockDown -Path $envFile -ExtraSids @($agentSid)
        } catch {
            throw "$envFile could not be locked down to SYSTEM, Administrators and ${AgentTaskUser}: $($_.Exception.Message). It holds the OAuth password (and any tunnel token); stopping rather than leaving it readable by other local accounts."
        }
    } else {
        $envTmp = "$envFile.tmp"
        try {
            _NewLockedFile -Path $envTmp -ExtraSids @($agentSid)
        } catch {
            throw "$envFile was NOT written: a locked-down file could not be created for it ($($_.Exception.Message)). Nothing was changed; the previous .env, if any, is as it was."
        }
        $removedAces = @()
        # Set-Content truncates the existing (locked) file rather than replacing it, so the ACL stays.
        Set-Content -LiteralPath $envTmp -Value $envLines -Encoding UTF8
        Move-Item -LiteralPath $envTmp -Destination $envFile -Force
        Write-Host "[OK] Wrote $envFile ($($envLines.Count) lines)"
    }
    foreach ($r in @($removedAces)) { Write-Host "[WARN] Removed an extra permission entry for $r from $envFile" -ForegroundColor Yellow }
    Write-Host "[OK] Locked NTFS ACL on $envFile (SYSTEM + Administrators + $AgentTaskUser, by SID; verified)"

    # --- 1b. Initialize + lock down the companies registry file -----------
    # The registry stores DPAPI-encrypted passwords for the alias feature. We pre-create an empty
    # file so the ACL is in place before anything sensitive is written, then strip inheritance and
    # grant access only to SYSTEM (the MCP service) and Administrators (operator + tray when
    # elevated). The DPAPI blob is defense-in-depth; the NTFS ACL is the real access boundary.
    #
    # icacls /inheritance:r removes inherited ACEs; /grant:r replaces (not adds) the named ACEs;
    # every principal is named by SID (see _LockDown). Because the ACL is the real boundary (the
    # DPAPI scope is LocalMachine), a failed lockdown stops the run, as for .env (#230), instead of
    # warning and leaving the stored Tally passwords readable.
    #
    # IMPORTANT: also grant the agent task user explicit Full Control. The tray scheduled task
    # runs with -RunLevel Limited (non-elevated), which filters the Administrators group from
    # the process token even when the user IS in Administrators. Without an explicit user grant,
    # the Manage Companies dialog's Move-Item -Force silently fails on overwrite - the .tmp file
    # gets written but never gets renamed to the real .json, so Save reports success and
    # nothing actually persists.
    $registryFile = Join-Path $TallyDataPath '.tally-mcp-companies.json'
    if (-not (Test-Path -LiteralPath (Split-Path $registryFile))) {
        New-Item -ItemType Directory -Force -Path (Split-Path $registryFile) | Out-Null
    }
    $removedAces = @()
    try {
        if (-not (Test-Path -LiteralPath $registryFile)) {
            # Locked before it holds anything, as for .env; if that fails no file is left behind.
            _NewLockedFile -Path $registryFile -ExtraSids @($agentSid)
            Set-Content -LiteralPath $registryFile -Value '{"schemaVersion":1,"companies":[]}' -Encoding UTF8 -NoNewline
            Write-Host "[OK] Created empty company registry at $registryFile"
        } else {
            Write-Host "[*] Existing company registry detected at $registryFile (preserved)"
            $removedAces = _LockDown -Path $registryFile -ExtraSids @($agentSid)
        }
    } catch {
        throw "The company password vault $registryFile could not be locked down to SYSTEM, Administrators and ${AgentTaskUser}: $($_.Exception.Message). Its passwords are decryptable by any local account that can read it, so the run stops here."
    }
    foreach ($r in @($removedAces)) { Write-Host "[WARN] Removed an extra permission entry for $r from $registryFile" -ForegroundColor Yellow }
    Write-Host "[OK] Locked NTFS ACL on $registryFile (SYSTEM + Administrators + $AgentTaskUser, by SID; verified)"

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
    #
    # Fails closed like .env and the vault (#230), for the same kind of reason: an IPC directory that
    # every local user can write to is a way to type keystrokes - including stored company
    # passwords - into the accountant's Tally session. Nothing here is worth that. By SID, and any
    # explicit entry for another account is removed and named in the output (see _LockDown).
    $ipcDir = Split-Path $registryFile
    if (Test-Path -LiteralPath $ipcDir) {
        try {
            $removedAces = _LockDown -Path $ipcDir -ExtraSids @($agentSid) -Container
        } catch {
            throw "The GUI agent IPC directory $ipcDir could not be locked down to SYSTEM, Administrators and ${AgentTaskUser}: $($_.Exception.Message). Left as it is, other local accounts could send keystrokes to Tally through it, so the run stops here."
        }
        foreach ($r in @($removedAces)) { Write-Host "[WARN] Removed an extra permission entry for $r from $ipcDir" -ForegroundColor Yellow }
        Write-Host "[OK] Locked NTFS ACL on IPC directory $ipcDir (SYSTEM + Administrators + $AgentTaskUser, by SID; verified)"

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
    # Recorded before the teardown: an upgrade re-registers what was there and creates nothing new.
    $serviceExisted = [bool]$existing
    $skipServiceForUpgrade = $Upgrade -and ($DeploymentMode -eq 'remote') -and -not $serviceExisted
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

    # --- 3. Register NSSM service (REMOTE MODE ONLY) -----------------------
    # The teardown above is deliberately unconditional while only this registration is gated, so
    # "switch to local" is expressed as a property of the control flow rather than of a marker we
    # have to trust: whatever the mode, any existing service is stopped and removed first, and a
    # local-mode run simply never re-creates it. There is no path that leaves a listener behind.
    #
    # The service also no longer receives .env through NSSM AppEnvironmentExtra. That handed every
    # value INCLUDING PASSWORD to a services registry key BUILTINUsers can read, which defeated
    # the icacls lockdown ~150 lines above whose own comment claims the password is not readable by
    # other local users. Removing it costs nothing: both entrypoints already load .env themselves by
    # absolute path with override:true (src/mcp.mts, src/server.mts), so the registry copy was
    # redundant as well as leaky.
    #
    # An upgrade re-registers the service only if it was there: a remote install whose service has
    # gone was changed by someone, and an unattended run is not the place to second-guess them.
    if ($skipServiceForUpgrade) {
        Write-Host "[WARN] Upgrade: remote mode, but no '$ServiceName' service existed before this run, so none is created. Run Reconfigure to register it." -ForegroundColor Yellow
    } elseif ($DeploymentMode -eq 'remote') {
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
        # the "Running but nothing listening" limbo we saw on cold installs - the real error then shows
        # up in logs/service.log (e.g. the PASSWORD FATAL line) instead of a silent crash-loop.
        & $bundledNssm set $ServiceName AppExit Default Restart    | Out-Null
        & $bundledNssm set $ServiceName AppRestartDelay 2000       | Out-Null
        & $bundledNssm set $ServiceName AppThrottle 5000           | Out-Null


        Write-Host "[OK] Service '$ServiceName' registered with bundled node + nssm"
    } else {
        # Local mode: the MCP client spawns dist\index.mjs over stdio for the duration of a
        # session. Nothing to register, nothing listening, nothing running while the user is not
        # working - which is the property #172 is sold on.
        Write-Host "[OK] Local mode: no Windows service registered (the MCP client starts the server on demand)"

        # --- Point the user's Claude at this install, AS THAT USER (#172 C4) ------------------
        # claude_desktop_config.json lives in %APPDATA%, which is per-user, and this script is
        # running elevated. On the ordinary over-the-shoulder UAC path the elevated account is an
        # admin who will never open Claude, so writing from here would configure the wrong profile
        # and the accountant would see no Tally tools with nothing explaining why.
        #
        # So drop to AGENT_TASK_USER through a one-shot scheduled task - the same mechanism the
        # agent and tray tasks already use, and the only way to reach that user's profile from an
        # elevated session without their password.
        #
        # Failure here is NOT fatal. connect-client.ps1 is idempotent and is also on the Start Menu,
        # which is the route for the very common case of Claude Desktop being installed afterwards.
        # A missed auto-connect costs one click; a failed install costs the whole session.
        #
        # An upgrade leaves it alone: the entry records the install path, which has not changed, and
        # the user may have edited or removed it on purpose. The exception is an install that has
        # moved (its agent task still points at the old folder), where the old entry is now wrong.
        $connectScript = Join-Path $InstallDir 'scripts\installer\connect-client.ps1'
        if ($Upgrade -and -not $_upgradeInstallMoved) {
            Write-Host "[OK] Upgrade: Claude client configuration left as it is (the install path has not changed)"
        } elseif (-not (Test-Path -LiteralPath $connectScript)) {
            Write-Host "[WARN] $connectScript not found - skipping auto-connect. Use the 'Connect Claude to Tally' Start Menu item." -ForegroundColor Yellow
        } else {
            $connectTask = 'TallyMCPConnectOnce'
            # schtasks writes "cannot find the file specified" to stderr when the task does not
            # exist - which is the NORMAL case on a first install - and under
            # ErrorActionPreference='Stop' PowerShell 5.1 promotes a native command's stderr to a
            # terminating error. That killed the whole auto-connect step (and then the script) on
            # exactly the path it was written for. The nssm calls in this file already relax the
            # preference for the same reason; this block has to as well.
            $savedPrefC = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                schtasks /Delete /TN $connectTask /F 2>$null | Out-Null

                $connectAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
                    -Argument ('-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "' + $connectScript + '" -InstallDir "' + $InstallDir + '"')
                # Interactive + Limited: this must land in the user's own profile with their normal
                # token, not an elevated one, or %APPDATA% resolves somewhere they will never read.
                $connectPrincipal = New-ScheduledTaskPrincipal -UserId $AgentTaskUser -LogonType Interactive -RunLevel Limited
                $connectSettings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
                Register-ScheduledTask -TaskName $connectTask -Action $connectAction -Principal $connectPrincipal -Settings $connectSettings -Force | Out-Null
                Start-ScheduledTask -TaskName $connectTask

                # Bounded wait: the task only runs if that user has an active session. If they are not
                # logged on it stays queued, which is fine - the Start Menu item covers it.
                $deadlineC = (Get-Date).AddSeconds(30)
                do {
                    Start-Sleep -Milliseconds 500
                    $info = Get-ScheduledTaskInfo -TaskName $connectTask -ErrorAction SilentlyContinue
                } while ($info -and $info.LastTaskResult -eq 267009 -and (Get-Date) -lt $deadlineC)  # 267009 = still running

                $resultFile = Join-Path (Split-Path (Split-Path $env:APPDATA -Parent) -Parent) "$AgentTaskUser\AppData\Local\Claudally\last-connect-result.json"
                if ($info -and $info.LastTaskResult -eq 0) {
                    Write-Host "[OK] Claude Desktop configuration written for '$AgentTaskUser'"
                } elseif ($info -and $info.LastTaskResult -eq 267011) {
                    Write-Host "[*]  Auto-connect queued: '$AgentTaskUser' is not logged on right now." -ForegroundColor Yellow
                    Write-Host "     They should run 'Connect Claude to Tally' from the Start Menu after signing in." -ForegroundColor Yellow
                } else {
                    $code = 'unknown'
                    if ($info) { $code = $info.LastTaskResult }
                    Write-Host "[WARN] Auto-connect finished with result $code. Run 'Connect Claude to Tally' from the Start Menu as $AgentTaskUser." -ForegroundColor Yellow
                }
            } catch {
                Write-Host "[WARN] Could not run auto-connect: $_" -ForegroundColor Yellow
                Write-Host "       Use the 'Connect Claude to Tally' Start Menu item instead." -ForegroundColor Yellow
            } finally {
                schtasks /Delete /TN $connectTask /F 2>$null | Out-Null
                $ErrorActionPreference = $savedPrefC
            }
        }

        # Revoke rather than abandon. Switching remote -> local must not leave the artefacts of the
        # old mode lying around: a stale token store is a credential, and a stale OAuth client list
        # tells an attacker what used to be trusted. verify-deployment.ps1 checks for exactly these.
        foreach ($leftover in @('.oauth-clients.json', '.oauth-tokens.json')) {
            $lp = Join-Path $InstallDir $leftover
            if (Test-Path -LiteralPath $lp) {
                try {
                    $len = (Get-Item -LiteralPath $lp).Length
                    if ($len -gt 0) { [System.IO.File]::WriteAllBytes($lp, (New-Object byte[] $len)) }
                    Remove-Item -LiteralPath $lp -Force
                    Write-Host "[OK] Removed $leftover (not used in local mode)"
                } catch {
                    Write-Host "[WARN] Could not remove ${leftover}: $_" -ForegroundColor Yellow
                }
            }
        }
    }

    # --- 3b. Cloudflare Tunnel service (optional) --------------------------
    # When a tunnel token is configured, register cloudflared as a second NSSM service so a NAT'd box
    # gets a stable public HTTPS URL with no router/domain config. Idempotent: ALWAYS stop/remove any
    # prior instance first (mirrors the main-service teardown above), then re-register ONLY if a token
    # is present - so blanking the token on a Reconfigure tears the tunnel down cleanly.
    #
    # WHERE THE TOKEN LIVES (#193). The token is a bearer credential: whoever holds it can run a
    # connector for this tunnel's hostname. It is handed to cloudflared as a FILE, via
    # `tunnel run --token-file`, and nowhere else:
    #   - not on the command line: NSSM stores AppParameters in the service's registry key, which
    #     BUILTIN\Users can read (exactly how cloudflared's own Windows service leaked it, fixed
    #     upstream as VULN-143514);
    #   - not in the service environment: NSSM keeps AppEnvironmentExtra in that same registry key.
    #     That is where it used to be, and the migration below takes it back out on every existing
    #     install.
    # The file is readable by SYSTEM (the account NSSM runs cloudflared under - no ObjectName is set,
    # so it is LocalSystem) and Administrators only. Not the agent user: nothing that runs as that
    # account needs the token. --token-file exists in cloudflared since 2025.4.0 (the pinned
    # build-installer.ps1 version is later), and it is what cloudflared's own `service install` does on
    # Windows, with the same owner and ACL. Note cloudflared gives TUNNEL_TOKEN in its environment
    # precedence over --token-file, so a stale registry copy would also silently override a rotated
    # token - another reason the migration is not optional.
    #
    # .env still carries TUNNEL_TOKEN so Reconfigure and upgrades can preserve it; that copy is also
    # readable by AGENT_TASK_USER (see the .env lockdown above), so it is the weaker of the two.
    $cloudflaredExe = Join-Path $InstallDir 'bin\cloudflared.exe'
    # Relative to AppDirectory ($InstallDir), which NSSM makes the service's working directory - the
    # same reason the main service passes 'dist\server.mjs': no path with spaces has to survive NSSM's
    # quoting.
    $tunnelTokenLeaf = '.tunnel-token'
    $tunnelTokenFile = Join-Path $InstallDir $tunnelTokenLeaf

    # Removes TUNNEL_TOKEN=... entries from an NSSM service's environment (REG_MULTI_SZ values under
    # <service>\Parameters) and leaves every other entry exactly as it was. NSSM has two such values:
    # AppEnvironmentExtra (added to the inherited environment - where earlier installers put the
    # token) and AppEnvironment (which REPLACES it; nothing here ever set it, but `nssm set` by hand
    # could have, and a token there would override --token-file just the same). Both are scrubbed.
    # Outputs the names of the values it changed (nothing when it changed nothing). Takes the key
    # path rather than a service name so it can be exercised against a scratch HKCU key.
    function _RemoveTunnelTokenFromServiceEnv([string]$ParametersKey) {
        $changed = @()
        if (-not (Test-Path -LiteralPath $ParametersKey)) { return }
        foreach ($valueName in @('AppEnvironmentExtra', 'AppEnvironment')) {
            $prop = Get-ItemProperty -LiteralPath $ParametersKey -Name $valueName -ErrorAction SilentlyContinue
            if ($null -eq $prop) { continue }
            $entries = @($prop.$valueName)
            # Windows environment names are case-insensitive, and so is -notmatch.
            $keep = @($entries | Where-Object { "$_" -notmatch '^\s*TUNNEL_TOKEN\s*=' })
            if ($keep.Count -eq $entries.Count) { continue }
            if ($keep.Count -gt 0) {
                New-ItemProperty -LiteralPath $ParametersKey -Name $valueName -PropertyType MultiString -Value ([string[]]$keep) -Force | Out-Null
            } else {
                Remove-ItemProperty -LiteralPath $ParametersKey -Name $valueName -ErrorAction Stop
            }
            $changed += $valueName
        }
        return $changed
    }

    $existingTunnel = Get-Service -Name $TunnelServiceName -ErrorAction SilentlyContinue
    $tunnelExisted = [bool]$existingTunnel
    if ($existingTunnel) {
        Write-Host "[*] Existing tunnel service detected; stopping and removing..."
        $savedPrefT = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            if ($existingTunnel.Status -eq 'Running') {
                & $bundledNssm stop $TunnelServiceName 2>$null | Out-Null
                Start-Sleep -Seconds 2
            }
            & $bundledNssm remove $TunnelServiceName confirm 2>$null | Out-Null
        } finally {
            $ErrorActionPreference = $savedPrefT
        }
        $deadlineT = (Get-Date).AddSeconds(15)
        while ((Get-Service -Name $TunnelServiceName -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadlineT)) {
            Start-Sleep -Milliseconds 500
        }
    }

    # Migration (#193): no TUNNEL_TOKEN in any service's registry environment, on every run. An install
    # configured before this change has the token in TallyMCPTunnel's AppEnvironmentExtra. The
    # teardown above normally deletes that key with the service, but `nssm remove` only MARKS a
    # service for deletion; while anything holds a handle to it (the tray polls service status) the
    # key - token included - survives, and it survives a failed re-registration too. So scrub
    # explicitly rather than trusting the teardown. The main service is included because installs
    # from before #172 C3 copied all of .env, TUNNEL_TOKEN with it, into ITS environment. Only the
    # TUNNEL_TOKEN entry is touched; any other entry is left as it was.
    foreach ($svcForScrub in @($TunnelServiceName, $ServiceName)) {
        try {
            foreach ($v in @(_RemoveTunnelTokenFromServiceEnv "HKLM:\SYSTEM\CurrentControlSet\Services\$svcForScrub\Parameters")) {
                Write-Host "[OK] Removed TUNNEL_TOKEN from the '$svcForScrub' service environment in the registry ($v)"
            }
        } catch {
            Write-Host "[WARN] Could not remove TUNNEL_TOKEN from the '$svcForScrub' service registry key: $($_.Exception.Message)" -ForegroundColor Yellow
            Write-Host "       It is readable by local users there. Remove the TUNNEL_TOKEN entry from AppEnvironmentExtra / AppEnvironment under HKLM\SYSTEM\CurrentControlSet\Services\$svcForScrub\Parameters by hand." -ForegroundColor Yellow
        }
    }

    # A MACHINE-WIDE TUNNEL_TOKEN environment variable. cloudflared gives TUNNEL_TOKEN in its
    # environment precedence over --token-file, and a service inherits the machine environment, so
    # such a variable silently overrides the token file - with a stale token after a rotation, or
    # with somebody else's tunnel. It is also readable by every local account (it sits under
    # HKLM\...\Session Manager\Environment and in every process's environment). This installer never
    # sets one, so something or someone else did.
    #
    # Reported, loudly, but NOT deleted. A machine variable is shared configuration: another program
    # (a second cloudflared, a script) may depend on it, removing it changes the environment of every
    # process started afterwards, and deleting configuration we did not create, unasked, from a run
    # that may be an unattended upgrade is not ours to decide. Nor does it fail the run: nothing this
    # script can do would fix it, so failing would only make every upgrade roll back over a problem
    # that would still be there. verify-deployment.ps1 reports it as a FAIL until it is gone. The
    # value is compared with the configured token but never printed.
    $machineEnvKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
    $machineTokenProp = Get-ItemProperty -LiteralPath $machineEnvKey -Name 'TUNNEL_TOKEN' -ErrorAction SilentlyContinue
    if ($null -ne $machineTokenProp -and "$($machineTokenProp.TUNNEL_TOKEN)".Trim()) {
        $sameToken = $TunnelToken -and ("$($machineTokenProp.TUNNEL_TOKEN)".Trim() -ceq $TunnelToken)
        Write-Host ""
        Write-Host "[WARN] SECURITY: a machine-wide TUNNEL_TOKEN environment variable is set on this computer." -ForegroundColor Red
        if ($sameToken) {
            Write-Host "       It holds the same token as this install, so every local account can read that token" -ForegroundColor Red
            Write-Host "       from its own environment. Remove the variable, then rotate the tunnel token." -ForegroundColor Red
        } else {
            Write-Host "       cloudflared gives it precedence over the token file, so the tunnel service would run with" -ForegroundColor Red
            Write-Host "       THAT token, not the one configured here - and every local account can read it." -ForegroundColor Red
        }
        Write-Host "       It was left in place because something else may use it. To remove it (elevated):" -ForegroundColor Red
        Write-Host "         [Environment]::SetEnvironmentVariable('TUNNEL_TOKEN', `$null, 'Machine')" -ForegroundColor Red
        Write-Host ""
    }

    # Same shape as the main service: teardown above is unconditional, registration below is gated.
    # The mode test is NOT redundant with the token test. $TunnelToken is a parameter, so a local-mode
    # run can still be handed one - the .env write above refuses to persist it, and without this guard
    # the tunnel service would be registered anyway, leaving an outbound connection and a public
    # hostname pointing at a machine that #172 promises has neither.
    #
    # An upgrade re-registers the tunnel only if it was there, and this is also how every install
    # configured before #193 receives the migration: the existing service comes back with
    # --token-file, the file is written from the TUNNEL_TOKEN .env already holds (.env itself is not
    # touched), and the scrub above has removed the registry copy.
    $tunnelRegistered = $false
    if ($Upgrade -and $DeploymentMode -eq 'remote' -and $TunnelToken -and -not $tunnelExisted) {
        # As for the main service: an upgrade re-registers what was there and adds nothing.
        Write-Host "[WARN] Upgrade: TUNNEL_TOKEN is set but no '$TunnelServiceName' service existed before this run, so none is created. Run Reconfigure to register it." -ForegroundColor Yellow
    } elseif ($DeploymentMode -eq 'remote' -and $TunnelToken) {
        $tokenFileOk = $false
        if (-not (Test-Path -LiteralPath $cloudflaredExe)) {
            # An error, not a warning: any previous tunnel was removed above, so the tunnel is down.
            Write-Host "[ERROR] A tunnel token is configured but cloudflared.exe is not at $cloudflaredExe." -ForegroundColor Red
            Write-Host "        The Cloudflare Tunnel service is NOT registered. Re-run the installer to put it back." -ForegroundColor Red
        } else {
            try {
                _WriteLockedTokenFile $tunnelTokenFile $TunnelToken
                $tokenFileOk = $true
                Write-Host "[OK] Wrote the tunnel token to $tunnelTokenFile (SYSTEM + Administrators only)"
            } catch {
                # Fail closed: no tunnel is better than a token in a file anyone can read, and there is
                # no less-protected fallback worth having - that is the problem this replaced.
                $null = _ShredFile $tunnelTokenFile
                Write-Host "[ERROR] Could not write a locked-down tunnel token file: $($_.Exception.Message)" -ForegroundColor Red
                Write-Host "        The Cloudflare Tunnel service is NOT registered. Re-run Reconfigure as Administrator." -ForegroundColor Red
            }
        }
        if ($tokenFileOk) {
            & $bundledNssm install $TunnelServiceName $cloudflaredExe                               | Out-Null
            # Only the file's PATH is on the command line - a path is not a secret.
            & $bundledNssm set $TunnelServiceName AppParameters "tunnel run --token-file $tunnelTokenLeaf" | Out-Null
            & $bundledNssm set $TunnelServiceName AppDirectory $InstallDir                          | Out-Null
            & $bundledNssm set $TunnelServiceName Description  'Claudally Cloudflare Tunnel (cloudflared)' | Out-Null
            & $bundledNssm set $TunnelServiceName Start        SERVICE_AUTO_START                   | Out-Null
            & $bundledNssm set $TunnelServiceName AppStdout    (Join-Path $InstallDir 'logs\tunnel.log') | Out-Null
            & $bundledNssm set $TunnelServiceName AppStderr    (Join-Path $InstallDir 'logs\tunnel.log') | Out-Null
            & $bundledNssm set $TunnelServiceName AppRotateFiles 1                                  | Out-Null
            & $bundledNssm set $TunnelServiceName AppRotateOnline 1                                 | Out-Null
            & $bundledNssm set $TunnelServiceName AppRotateSeconds 86400                            | Out-Null
            & $bundledNssm set $TunnelServiceName AppRotateBytes 5242880                            | Out-Null
            & $bundledNssm set $TunnelServiceName AppStdoutCreationDisposition 4                    | Out-Null
            & $bundledNssm set $TunnelServiceName AppStderrCreationDisposition 4                    | Out-Null
            & $bundledNssm set $TunnelServiceName AppExit Default Restart                           | Out-Null
            & $bundledNssm set $TunnelServiceName AppRestartDelay 2000                              | Out-Null
            & $bundledNssm set $TunnelServiceName AppThrottle 5000                                  | Out-Null
            # No AppEnvironmentExtra: the token comes from the file above, never the environment.
            $savedPrefT2 = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try { & $bundledNssm start $TunnelServiceName 2>$null | Out-Null } finally { $ErrorActionPreference = $savedPrefT2 }
            $tunnelRegistered = $true
            Write-Host "[OK] Cloudflare Tunnel service '$TunnelServiceName' registered and started (cloudflared)"
        }
    } else {
        Write-Host "[*] No Cloudflare Tunnel token configured - tunnel service not registered"
    }
    # No tunnel running means no token on disk for one: blanking the token, switching to local mode or
    # a skipped registration all leave nothing behind for the next reader to find.
    if (-not $tunnelRegistered -and (Test-Path -LiteralPath $tunnelTokenFile)) {
        if (_ShredFile $tunnelTokenFile) {
            Write-Host "[OK] Removed the tunnel token file $tunnelTokenFile (no tunnel is configured)"
        } else {
            Write-Host "[WARN] Could not remove $tunnelTokenFile - delete it by hand; it holds a tunnel credential." -ForegroundColor Yellow
        }
    }
    # Fail closed, AND say so - on every run, not only an upgrade. A tunnel that is configured but
    # could not be registered (no locked-down token file, no cloudflared.exe) fails the run with a
    # non-zero exit. That used to be an [ERROR] line followed by "Configuration complete." and exit 0,
    # which nobody sees in a hidden installer window: the installer now reports the failure, the
    # Reconfigure window stops on it, and an unattended upgrade exits 10 so the update task rolls
    # back rather than report success over an outage. Raised at the end, after the agent and tray
    # below have been restarted, so the rest of the install is not left down with it. (An upgrade
    # that deliberately created no tunnel, because none existed before, is not a failure.)
    $deferredFailures = @()
    if (($DeploymentMode -eq 'remote') -and $TunnelToken -and -not $tunnelRegistered -and -not ($Upgrade -and -not $tunnelExisted)) {
        $deferredFailures += "the Cloudflare Tunnel is configured but the '$TunnelServiceName' service could not be registered$(if ($tunnelExisted) { ' (it existed before this run and has been removed)' }) - see the [ERROR] above. It has been left unregistered rather than protected less well."
    }

    # --- 4. Register the GUI agent at-logon Scheduled Task -----------------
    # Use the ScheduledTasks PowerShell module rather than schtasks.exe. schtasks.exe via the
    # `&` operator with /TR mangles the inner quotes around paths with spaces (e.g.
    # "C:\Program Files\TallyMCP\scripts\tally-gui-agent-v2.ps1"), producing
    # "Invalid argument/option - 'Files\...'". The cmdlet route uses real argument arrays so
    # paths with spaces survive without escape gymnastics. The module is built-in on
    # Windows Server 2008 R2+ / Windows 10+, so this is safe across our supported targets.
    $taskRegistered = $false
    # An upgrade refreshes the task only if it already existed, and always for the same user it had.
    if ($Upgrade -and -not $_upgradeTaskExisted[$AgentTaskName]) {
        Write-Host "[WARN] Upgrade: no '$AgentTaskName' task existed before this run, so none is created. Run Reconfigure to register it." -ForegroundColor Yellow
    } else {
        try {
            # Best-effort cleanup of any stale registration. SilentlyContinue handles "not found".
            Unregister-ScheduledTask -TaskName $AgentTaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null

            $taskAction = New-ScheduledTaskAction `
                -Execute 'powershell.exe' `
                -Argument "-ExecutionPolicy Bypass -NoProfile -WindowStyle Minimized -File `"$agentScript`""
            # At-logon trigger is the reliable baseline. Crash-supervision (#88 H-2) is added on top via
            # RestartCount/Interval + an optional 1-min heartbeat - but BOTH are built best-effort so a
            # picky Windows build can never abort registration (which previously left the task unregistered).
            $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $AgentTaskUser
            $taskPrincipal = New-ScheduledTaskPrincipal -UserId $AgentTaskUser -LogonType Interactive -RunLevel Limited

            # Supervision settings: respawn ~1 min after an abnormal exit; IgnoreNew avoids a double-instance.
            # Fall back to basic settings if the enhanced set is rejected.
            try {
                $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
                    -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
            } catch {
                Write-Host "[WARN] enhanced task settings unavailable; using basic: $_" -ForegroundColor Yellow
                $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
            }

            # Optional heartbeat trigger - re-fires the task every minute as a belt for the "process gone
            # but the engine thinks it completed" case. Some Windows builds reject the repetition params,
            # so build it in a try/catch and register logon-only if it fails (RestartCount still covers crashes).
            # NOTE: use a finite 10-year duration, NOT [TimeSpan]::MaxValue, which overflows and threw here.
            $taskTriggers = @($logonTrigger)
            try {
                $heartbeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
                $taskTriggers += $heartbeatTrigger
            } catch {
                Write-Host "[WARN] heartbeat trigger unavailable (crash-respawn still covered by RestartCount): $_" -ForegroundColor Yellow
            }

            $taskDef = New-ScheduledTask -Action $taskAction -Trigger $taskTriggers -Principal $taskPrincipal -Settings $taskSettings -Description "Tally MCP GUI agent (companion to TallyMCP service; spawns Tally + keystrokes credentials in user session). Auto-respawns within ~1 min if it crashes."
            Register-ScheduledTask -TaskName $AgentTaskName -InputObject $taskDef -Force | Out-Null
            $taskRegistered = $true
            Write-Host "[OK] Scheduled task '$AgentTaskName' registered (runs at logon, as $AgentTaskUser)"
        } catch {
            Write-Host "[WARN] Register-ScheduledTask failed: $_" -ForegroundColor Yellow
            Write-Host "       GUI agent task NOT registered. Re-run the wizard or register manually." -ForegroundColor Yellow
        }
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
    } elseif ($Upgrade -and -not $_upgradeTaskExisted[$TrayTaskName]) {
        # Someone removed it (or installed with -SkipTrayTask); an unattended upgrade does not bring it back.
        Write-Host "[*] Upgrade: no '$TrayTaskName' task existed before this run, so none is created" -ForegroundColor DarkGray
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

    # --- 5. Start the service (remote mode only) ----------------------------
    # Local mode registered no service, so there is nothing to start - and nssm.exe may not even be
    # present, since it is no longer a prerequisite on that path. Reaching here unguarded threw
    # "nssm.exe is not recognized" AFTER everything else had succeeded, which is the worst place to
    # fail: the install was complete and correct, and the operator was told it had errored.
    if ($DeploymentMode -eq 'remote' -and -not $skipServiceForUpgrade) {
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
    }

    # --- 6. Tell the operator what's next ----------------------------------
    Write-Host ""
    if ($deferredFailures.Count -gt 0) {
        Write-Host "Configuration INCOMPLETE - see the errors above and below." -ForegroundColor Red
    } else {
        Write-Host "Configuration complete."
    }
    Write-Host "  Service:        $ServiceName  ($($svc.Status))"
    Write-Host "  Tunnel:         $(if ($tunnelRegistered) { "$TunnelServiceName (cloudflared -> $McpDomain, token in $tunnelTokenFile)" } else { 'not configured' })"
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

    if ($deferredFailures.Count -gt 0) {
        throw ("Configuration did not complete: " + ($deferredFailures -join ' '))
    }
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
