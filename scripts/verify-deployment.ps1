<#
.SYNOPSIS
    Tally MCP Server - verify the deployment's security claims (issue #172).

.DESCRIPTION
    Issue #172 sells local mode on four verifiable properties: no listening socket, no OAuth
    password, no persisted tokens, no outbound tunnel. Until this script existed those were a
    paragraph in an issue. This turns each one into a check a non-technical customer can run and
    a support engineer can ask for over the phone.

    Every check is interpreted against DEPLOYMENT_MODE from the install .env. A check that is
    meaningless in the current mode reports NA with a reason - never FAIL. That rule comes
    straight from #172's tray section ("must not show red for the absence of things that
    correctly do not exist in this mode") and applies just as much here: a remote install is
    SUPPOSED to have a service and a listening port, and painting that red would train operators
    to ignore the output.

    Each check reports one of six statuses:
      PASS     looked, and the property holds
      FAIL     looked, and found something wrong (or the check broke in a way that is itself a fault)
      UNKNOWN  could NOT look - most often because this run is not elevated and the thing to inspect
               belongs to another Windows account. Neither pass nor fail: nothing was found wrong,
               but nothing was proved either. The reason always says what to do to settle it
               (usually: re-run as Administrator).
      NA       the property is not claimed in this mode, so there is nothing to verify
      INFO     an observation that never affects the verdict
      WARN     looked, and found something worth fixing that does not weaken this install's own
               security (Tally's data folder still has the permissions an older installer gave it).
               Surfaced in the summary; never changes the verdict or the exit code
    UNKNOWN exists so that "we could not look" is never reported as "we looked and it was clean"
    (a PASS), without painting a correct install red (a FAIL) for a non-admin user. The overall
    verdict is FAIL if any check FAILed, else UNKNOWN if any check is UNKNOWN, else PASS.

    Checks, in order:
      1. Deployment mode      - which mode is configured, and is the value valid
      2. No listening socket  - owned by OUR processes; attributed by PID, never by port number
      3. No NSSM service      - the service AND its SCM registry key are gone
      4. No OAuth artefacts   - .oauth-clients.json / .oauth-tokens.json / PASSWORD in .env
      5. No outbound tunnel   - cloudflared process, tunnel service, or a token that revives it
                                (including a machine-wide TUNNEL_TOKEN environment variable)
      6. Tunnel token storage - remote mode with a tunnel: the token is in no service registry key
                                (AppEnvironmentExtra or AppEnvironment) and no machine-wide
                                environment variable, and its file is readable by SYSTEM +
                                Administrators only (#193)
      7. Company vault ACL    - the entire boundary for stored Tally passwords; BOTH modes
      8. .env, agent folder   - .env and %ProgramData%\Claudally\agent (the vault + the GUI agent's
         and Tally's folder     IPC files) are locked to SYSTEM, Administrators and the agent user,
                                the folder owned by Administrators (#230); none of our files is left
                                in Tally's data folder (FAIL), whose inheritance an older installer
                                disabled (WARN); BOTH modes
      9. Tally reachability   - INFORMATIONAL only; never affects the verdict

    Every ACL check compares principals by SID, never by display name: 'Administrators' is
    localised (Administratoren, Administrateurs, ...), and a name match would misjudge a
    non-English Windows.

    NEVER PRINTS SECRETS. Secret-valued .env keys are tested for PRESENCE through a separate
    function that cannot return the value (Test-EnvKeyPresent), so there is no code path where a
    password, a token or an admin secret can reach stdout, the JSON blob, or a support ticket.
    Nothing is decrypted either: the vault check reads the ACL, never the file body.

    Read-only. This script starts nothing, stops nothing, and writes nothing.

.PARAMETER InstallDir
    The Tally MCP install root (the directory holding .env, dist\ and scripts\). Defaults to this
    script's grandparent: <InstallDir>\scripts\verify-deployment.ps1 -> scripts\ -> <InstallDir>.

.PARAMETER ServiceName
    NSSM service name the installer registers in remote mode. Default 'TallyMCP'.

.PARAMETER TunnelServiceName
    NSSM service name for the bundled cloudflared. Default 'TallyMCPTunnel'.

.PARAMETER Json
    Emit a single JSON object instead of the human report - attach it to a support ticket. All
    human chatter is suppressed so the output stays pipeable (`... -Json | ConvertFrom-Json`).

.PARAMETER AllowUnknown
    Exit 0 instead of 3 when the verdict is UNKNOWN (no FAIL, but at least one check could not
    look). For a CI gate or a scheduled task that runs unelevated and should only break on a real
    FAIL. It changes the exit code ONLY: the report and the JSON still say UNKNOWN, with the
    reason, so the gap stays visible to whoever reads the output.

.EXAMPLE
    .\scripts\verify-deployment.ps1
    Human-readable report plus a final verdict.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File "C:\Program Files\TallyMCP\scripts\verify-deployment.ps1" -Json > verify.json
    Machine-readable output for a support ticket.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\verify-deployment.ps1 -AllowUnknown
    CI gate: fails the step on a real FAIL (exit 1) or a run that could not start (exit 2), and
    lets an unelevated UNKNOWN through with exit 0.

.NOTES
    Exit codes:
      0  PASS - every check passed, or was NA / INFO / WARN
      1  FAIL - at least one check FAILed (wins over UNKNOWN)
      2  ERROR - could not run at all (InstallDir missing)
      3  UNKNOWN - nothing FAILed, but at least one check could not look. Exit 0 instead with
         -AllowUnknown. Kept distinct from 0 by default because a clean exit is what automation
         reads as "verified", and this run did not verify everything.
    A CI gate that should break only on real failures either passes -AllowUnknown, or treats
    exit 1 and 2 as failure and 3 as a warning.

    -Json output is schemaVersion 3: a check's status can also be WARN, and counts carry a 'warn'
    field (the verdict is still PASS / FAIL / UNKNOWN). schemaVersion 2 added UNKNOWN, the 'unknown'
    count and the exitCode the payload records; schemaVersion 1 had neither.

    Windows PowerShell 5.1 compatible ON PURPOSE - customers have 5.1, not pwsh 7. So: no ternary,
    no ?? / ?., no `class`, no -Parallel. Verify any edit with the 5.1 parser, not just by running
    it under pwsh:
      powershell.exe -NoProfile -Command "$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('<path>',[ref]$null,[ref]$e); $e"
    Keep string literals ASCII-only: 5.1 reads a BOM-less .ps1 as ANSI and mis-decodes UTF-8
    bytes, which is a live parse-failure bug in scripts/deploy.ps1 right now. Do not paste an em
    dash, a curly quote or an arrow in here.
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [string]$ServiceName       = 'TallyMCP',
    [string]$TunnelServiceName = 'TallyMCPTunnel',
    [switch]$Json,
    [switch]$AllowUnknown
)

# Continue, not Stop: a verification tool that aborts on the first surprise reports nothing about
# the other checks. Each check owns its own try/catch and turns an unexpected error into a FAIL
# for that check alone (fail closed - see Invoke-Check). An UNEXPECTED error stays a FAIL, not an
# UNKNOWN: UNKNOWN is reserved for the specific, understood cases where this run lacked the access
# to look, each of which names the remedy. An exception nobody anticipated has no such remedy.
$ErrorActionPreference = 'Continue'

if (-not $InstallDir -or -not $InstallDir.Trim()) {
    # <InstallDir>\scripts\verify-deployment.ps1: one Split-Path lands in scripts\, two in the root.
    $InstallDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
$InstallDir = $InstallDir.TrimEnd('\')
if (-not (Test-Path -LiteralPath $InstallDir)) {
    if ($Json) {
        # -Json is the support-ticket contract: the caller pipes this into ConvertFrom-Json. Emitting
        # a human sentence here broke that for the one case where support most needs the detail.
        (New-Object psobject -Property ([ordered]@{
            schemaVersion = 3
            tool          = 'scripts/verify-deployment.ps1'
            issue         = 172
            generatedAt   = (Get-Date).ToString('o')
            machine       = $env:COMPUTERNAME
            installDir    = $InstallDir
            verdict       = 'ERROR'
            exitCode      = 2
            error         ="InstallDir does not exist. Pass -InstallDir <path to the Tally MCP install>."
            checks        = @()
        })) | ConvertTo-Json -Depth 4
    } else {
        Write-Host "ERROR: InstallDir '$InstallDir' does not exist. Pass -InstallDir <path to the Tally MCP install>." -ForegroundColor Red
    }
    exit 2
}
$EnvFile = Join-Path $InstallDir '.env'
# Where firstrun-config.ps1 keeps the Cloudflare Tunnel token for cloudflared's --token-file (#193).
$TunnelTokenFile = Join-Path $InstallDir '.tunnel-token'
# The Claudally agent folder: the company vault and the GUI agent's IPC files, locked to SYSTEM,
# Administrators and the agent user (#230 follow-up). Derived exactly as the installer, the server,
# the agent and the tray derive it. They used to live in Tally's data folder (TALLY_DATA_PATH).
$ProgramDataDir = if ($env:ProgramData) { $env:ProgramData } else { 'C:\ProgramData' }
$AgentDir = Join-Path $ProgramDataDir 'Claudally\agent'
# Our files that must no longer be in Tally's data folder.
$OurFilesInTallyFolder = @('.tally-mcp-companies.json', '.tally-mcp-companies.json.pre-entropy-backup', '.tally-mcp-companies.json.tmp',
                           '_mcp_gui_command.json', '_mcp_gui_result.json', '_mcp_screenshot.png')

# ---------------------------------------------------------------------------
# Can we actually READ .env? Existence is not the question - readability is.
#
# The installer locks .env down itself: `icacls <.env> /inheritance:r /grant:r *S-1-5-18:F
# *S-1-5-32-544:F *<AgentTaskUser SID>:F` (firstrun-config.ps1, by SID since #230). So for any Windows account that
# is not SYSTEM, an Administrator, or AGENT_TASK_USER, .env is present but unreadable - Test-Path
# says $true and every Get-Content returns nothing.
#
# Before this probe existed that produced a silent FALSE ALL-CLEAR, the worst possible failure for
# this script: DEPLOYMENT_MODE read back as absent, so a `DEPLOYMENT_MODE=local` install was
# reported with a green "Mode is 'remote' (inherited, not written)", and all four of #172's
# security claims were then skipped as NA "remote mode does this by design" - including a leftover
# PASSWORD= sitting in the very file we could not read. The mode line lied and nothing was checked.
#
# Distinguishing absent from unreadable is therefore load-bearing, not tidiness.
# ---------------------------------------------------------------------------
$EnvExists    = $false
$EnvReadable  = $false
$EnvReadError = ''
# Denied specifically, as opposed to any other read failure. Only a denial is the understood
# "this account may not look" case that check 1 can report as UNKNOWN; anything else stays a FAIL.
$EnvDenied    = $false
try {
    $null = Get-Item -LiteralPath $EnvFile -Force -ErrorAction Stop
    $EnvExists = $true
} catch [System.UnauthorizedAccessException] {
    # Denied on the directory itself: the file's existence cannot be settled, but "denied" is the
    # honest answer either way and must not be reported as "missing".
    $EnvExists    = $true
    $EnvReadError = 'access denied'
    $EnvDenied    = $true
} catch {
    $EnvExists = $false
}
if ($EnvExists -and -not $EnvReadError) {
    try {
        # -TotalCount 1 opens the file for real (Get-Item does not) while reading almost nothing.
        # An empty .env returns no lines and throws nothing, which is correctly "readable".
        $null = Get-Content -LiteralPath $EnvFile -TotalCount 1 -ErrorAction Stop
        $EnvReadable = $true
    } catch {
        $EnvReadError = $_.Exception.Message
        # Get-Content surfaces a denial as UnauthorizedAccessException, with an error id of
        # GetContentReaderUnauthorizedAccessError; accept either so a wrapped exception still counts.
        if (($_.Exception -is [System.UnauthorizedAccessException]) -or ("$($_.FullyQualifiedErrorId)" -like '*UnauthorizedAccess*')) {
            $EnvDenied = $true
        }
    }
}

# ---------------------------------------------------------------------------
# .env reading. Two functions on purpose.
#
# Get-EnvValue returns a value but REFUSES the secret-valued keys outright, so a later edit that
# adds "just print the config" cannot leak the OAuth password or the tunnel token by accident.
# Test-EnvKeyPresent answers presence only and never returns the value at all - which is all the
# OAuth and tunnel checks below actually need.
#
# Parsing mirrors _ReadEnvHashtable in scripts\installer\firstrun-config.ps1:88 and Read-EnvValue in
# scripts\tray\tally-mcp-tray.ps1:116 (quoted values keep a literal '#'; unquoted values are cut at
# the first '#', which is dotenv semantics and matters for .env files copied from .env.example,
# where `TALLY_DATA_PATH=    # description` would otherwise yield the comment text as the value).
# ---------------------------------------------------------------------------
$SecretEnvKeys = @('PASSWORD', 'TUNNEL_TOKEN', 'ADMIN_SECRET', 'TALLY_COMPANY_PASSWORD')

function Get-EnvLineValue {
    param([string]$Path, [string]$Key)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    foreach ($line in (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $eq = $trimmed.IndexOf('=')
        if ($eq -lt 1) { continue }
        if ($trimmed.Substring(0, $eq).Trim() -ne $Key) { continue }
        $v = $trimmed.Substring($eq + 1).Trim()
        if ($v.Length -ge 2 -and $v.StartsWith('"') -and $v.EndsWith('"')) {
            return $v.Substring(1, $v.Length - 2) -replace '\\"', '"'
        }
        $hash = $v.IndexOf('#')
        if ($hash -ge 0) { $v = $v.Substring(0, $hash).TrimEnd() }
        return $v
    }
    return $null
}

function Get-EnvValue {
    param([string]$Key)
    if ($SecretEnvKeys -contains $Key) {
        throw "Get-EnvValue refuses '$Key': it is a secret-valued key. Use Test-EnvKeyPresent instead."
    }
    $v = Get-EnvLineValue -Path $EnvFile -Key $Key
    if ($null -eq $v) { return '' }
    return $v
}

function Test-EnvKeyPresent {
    param([string]$Key)
    $v = Get-EnvLineValue -Path $EnvFile -Key $Key
    # Present-but-empty (a bare `PASSWORD=`) is NOT "configured": .env.example ships exactly that
    # line, so an install that copied it has no OAuth password and must not be failed for one.
    if ($null -eq $v) { return $false }
    return ($v.Trim().Length -gt 0)
}

# ---------------------------------------------------------------------------
# Check result plumbing. Status is one of PASS / FAIL / UNKNOWN / NA / INFO.
#   UNKNOWN the check could not look at what it was asked to verify (in practice: this run lacks the
#           access). Neither pass nor fail - it is its own verdict and its own exit code, so
#           "could not look" is never folded into "clean" and a correct install is never shown red
#           to a non-admin. The Reason must say what would settle it. Reserved for the specific,
#           understood no-access cases below; an unexpected exception is still a FAIL.
#   NA      the property is not claimed in this mode. Carries a Reason. Never a failure.
#   INFO    an observation, never a verdict input (Tally reachability).
#   Caveat  "this PASS is weaker than it looks" - printed indented under the check and surfaced in
#           the final verdict, because a security control that silently passes when it could not
#           fully see is worse than no control at all. The line between a caveat and UNKNOWN: a
#           caveated PASS did look at the thing and found nothing wrong with partial visibility;
#           UNKNOWN did not get to look at the thing at all.
# ---------------------------------------------------------------------------
$Checks = New-Object System.Collections.ArrayList

function New-Check {
    param(
        [string]$Id,
        [string]$Name,
        [string]$Status,
        [string]$Reason = '',
        [string[]]$Evidence = @(),
        [string]$Caveat = ''
    )
    $obj = New-Object psobject -Property ([ordered]@{
        id       = $Id
        name     = $Name
        status   = $Status
        reason   = $Reason
        evidence = @($Evidence)
        caveat   = $Caveat
    })
    [void]$Checks.Add($obj)
    return $obj
}

function Invoke-Check {
    # Runs one check body. An exception inside a security check means "could not verify", which is
    # reported as FAIL rather than swallowed into a PASS - fail closed. The message names the check
    # so a customer can quote it back to us.
    param([string]$Id, [string]$Name, [scriptblock]$Body)
    try {
        & $Body
    } catch {
        New-Check -Id $Id -Name $Name -Status 'FAIL' `
            -Reason "The check itself could not complete, so this property is unverified." `
            -Evidence @("error: $($_.Exception.Message)") | Out-Null
    }
}

# ---------------------------------------------------------------------------
# Process attribution. "Our processes" = anything running FROM this install tree, matched on the
# executable path or the command line. This is the load-bearing definition for the socket check:
# #172's claim is that OUR process does not listen, not that the machine has no listeners - see
# check 2's evidence, where Tally's own port 9000 is called out by name.
#
# Win32_Process hides ExecutablePath and CommandLine for processes owned by other users when this
# run is not elevated. Those are recorded separately ($UnreadableCandidates) rather than quietly
# treated as "not ours".
# ---------------------------------------------------------------------------
$Identity   = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal  = New-Object Security.Principal.WindowsPrincipal($Identity)
$IsElevated = $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# Names a listening socket could plausibly belong to us under. powershell.exe is deliberately NOT
# here: the tray and the GUI agent run under it, neither listens, and treating every powershell.exe
# on the box as suspicious would make the check useless noise.
$OurCandidateNames = @('node.exe', 'cloudflared.exe')

$OurProcesses         = @()
$UnreadableCandidates = @()
# This script LIVES in the install tree, so its own host - and the shell that launched it - carry
# <InstallDir>\scripts\verify-deployment.ps1 on their command line and match the tree test below.
# Counting the verifier as a thing being verified is wrong twice over: the evidence line then reads
# "processes running from <InstallDir>: powershell.exe, pwsh.exe" (a support engineer will take that
# literally), and if any of those hosts ever held a listening socket the check would blame this
# install for it. Nothing that is genuinely ours - node running dist\, the tray, the GUI agent -
# ever names this script, so excluding by this file's own name is exact rather than a heuristic.
$SelfScriptName = Split-Path -Leaf $PSCommandPath
# Did the process table come back at all? If it did not, no listener can be attributed either way,
# and an empty $OurProcesses would otherwise read as "nothing of ours is running" - a free PASS for a
# check that saw nothing. The socket check turns this into UNKNOWN when anything is listening.
$ProcessEnumOk    = $false
$ProcessEnumError = ''
try {
    # Escape wildcard metacharacters before using the path as a -like pattern; an install dir
    # containing '[' would otherwise silently match nothing and hand back a false PASS.
    $likePattern = '*' + [System.Management.Automation.WildcardPattern]::Escape($InstallDir) + '*'
    $selfPattern = '*' + [System.Management.Automation.WildcardPattern]::Escape($SelfScriptName) + '*'
    $allProcs = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    # A live Windows box always has processes (this one, at least), so an empty table is a failed
    # query, not an idle machine.
    $ProcessEnumOk = ($allProcs.Count -gt 0)
    if (-not $ProcessEnumOk) { $ProcessEnumError = 'Win32_Process returned no processes at all' }
    foreach ($p in $allProcs) {
        $hasPath = ($p.ExecutablePath -and $p.ExecutablePath.Length -gt 0)
        $hasCmd  = ($p.CommandLine    -and $p.CommandLine.Length    -gt 0)
        if ([int]$p.ProcessId -eq $PID) { continue }
        if ($hasCmd -and $p.CommandLine -like $selfPattern) { continue }
        if (($hasPath -and $p.ExecutablePath -like $likePattern) -or ($hasCmd -and $p.CommandLine -like $likePattern)) {
            $OurProcesses += $p
        } elseif (-not $hasPath -and -not $hasCmd -and ($OurCandidateNames -contains $p.Name)) {
            # Right name, no visible path or command line: cannot be ruled in OR out from here.
            $UnreadableCandidates += $p
        }
    }
} catch {
    # Leave both sets empty and record why; the socket check reports the shortfall as UNKNOWN.
    $OurProcesses         = @()
    $UnreadableCandidates = @()
    $ProcessEnumOk        = $false
    $ProcessEnumError     = $_.Exception.Message
}

function Format-ProcessLine {
    param($Proc)
    $where = ''
    if ($Proc.ExecutablePath) { $where = " [$($Proc.ExecutablePath)]" }
    return "$($Proc.Name) pid=$($Proc.ProcessId)$where"
}

# ---------------------------------------------------------------------------
# Listening TCP endpoints. Get-NetTCPConnection (Win8 / Server 2012+) is preferred because it hands
# back OwningProcess directly. netstat is the fallback for boxes without the NetTCPIP module.
#
# The netstat parse deliberately does NOT match the word "LISTENING": netstat localizes that column
# (German Windows prints ABHOEREN), and a state-word match would find zero listeners on a
# non-English box - a false PASS on the single most important check here. Instead it keys on the
# locale-independent fact that a listening socket has foreign port 0 (0.0.0.0:0 / [::]:0), which an
# established connection never has.
#
# Readable says whether either source actually produced a socket table. It is false only when
# Get-NetTCPConnection gave nothing AND netstat printed nothing at all (not even its header) - a
# failed query, which must not be read as "nothing is listening".
# ---------------------------------------------------------------------------
function Get-ListeningEndpoint {
    $result = New-Object System.Collections.ArrayList
    $source = ''
    $readable = $false
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $source = 'Get-NetTCPConnection'
        foreach ($c in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
            [void]$result.Add((New-Object psobject -Property ([ordered]@{
                Local     = "$($c.LocalAddress):$($c.LocalPort)"
                OwningPid = [int]$c.OwningProcess
            })))
        }
        if ($result.Count -gt 0) { $readable = $true }
    }
    if ($result.Count -eq 0) {
        $source = 'netstat -ano'
        $lines = @()
        try { $lines = @(& netstat.exe -ano 2>$null) } catch { $lines = @() }
        if ($lines.Count -gt 0) { $readable = $true }
        foreach ($line in $lines) {
            $m = [regex]::Match($line, '^\s*TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$')
            if (-not $m.Success) { continue }
            if (-not $m.Groups[2].Value.EndsWith(':0')) { continue }
            [void]$result.Add((New-Object psobject -Property ([ordered]@{
                Local     = $m.Groups[1].Value
                OwningPid = [int]$m.Groups[4].Value
            })))
        }
    }
    return (New-Object psobject -Property ([ordered]@{ Source = $source; Endpoints = @($result); Readable = $readable }))
}

# ---------------------------------------------------------------------------
# 1. Deployment mode
# ---------------------------------------------------------------------------
$Mode = ''
Invoke-Check -Id 'deployment-mode' -Name 'Deployment mode' -Body {
    if (-not $EnvExists) {
        New-Check -Id 'deployment-mode' -Name 'Deployment mode' -Status 'FAIL' `
            -Reason "There is no .env at $EnvFile, so there is no configured deployment to verify. Re-run the installer, or pass -InstallDir pointing at the real install (typically C:\Program Files\TallyMCP)." `
            -Evidence @("looked for: $EnvFile", "the path does not exist (this is 'not found', not 'access denied' - the two are told apart here)") | Out-Null
        return
    }
    if (-not $EnvReadable) {
        # Deliberately does NOT fall through to the 'remote' inheritance branch below. An unreadable
        # .env is indistinguishable from an empty one to Get-Content, and treating it as "no
        # DEPLOYMENT_MODE key, therefore remote" turned a local install into a green report with all
        # four of #172's claims skipped. Stop here instead: $Mode stays '', $ModeKnown stays false,
        # and the four mode-scoped checks report NA-undetermined rather than a fabricated all-clear.
        $ev = @(
            "config file: $EnvFile",
            "opening it failed: $EnvReadError",
            "running as: $($Identity.Name) (elevated: $IsElevated)",
            "no value was read from this file, so this run reports no mode at all rather than guessing one"
        )
        if ($EnvDenied -and -not $IsElevated) {
            # UNKNOWN, not FAIL. The installer locks .env to SYSTEM, Administrators and the agent user
            # (firstrun-config.ps1:397), so an unelevated run by any other account being denied is
            # exactly what a CORRECT install looks like from outside - painting that red is the
            # "correct state shown as a fault" #172 forbids. Nothing was verified either, so it is
            # not a PASS. The overall verdict carries the UNKNOWN; the exit code follows it.
            New-Check -Id 'deployment-mode' -Name 'Deployment mode' -Status 'UNKNOWN' `
                -Reason "The configuration file exists but this Windows account is not allowed to read it, so the deployment mode - and with it every mode-specific check below - could not be verified. That is what a correctly locked-down install looks like from an account other than the one that installed it (the installer restricts .env to SYSTEM, Administrators and the agent user), so this is not a fault. Re-run this script as Administrator, or as the account that installed Tally MCP, to get an actual answer." `
                -Evidence $ev | Out-Null
            return
        }
        # Elevated and still denied, or a read failure that is not a denial at all: the installer
        # always grants Administrators Full Control, so neither is explained by a correct install.
        $why = "reading it failed with an error that is not a permissions denial (see below), so this is not explained by which account ran the script"
        if ($IsElevated) {
            $why = "even this elevated run could not read it, and the installer always grants Administrators Full Control on .env - so something has changed the file's permissions, or it is unreadable for another reason (see below)"
        }
        New-Check -Id 'deployment-mode' -Name 'Deployment mode' -Status 'FAIL' `
            -Reason "The configuration file exists but could not be read, so nothing below could be judged against the real deployment mode: $why. Check the file and its permissions (icacls `"$EnvFile`"), then re-run." `
            -Evidence $ev | Out-Null
        return
    }
    $raw = Get-EnvValue 'DEPLOYMENT_MODE'
    if (-not $raw) {
        # An install predating #172 has no such key. firstrun-config.ps1:143 resolves that to
        # 'remote' so an upgrade keeps its service and listener; this script must read it the same
        # way or it would grade an old remote install against local-mode claims and paint it red.
        $script:Mode = 'remote'
        New-Check -Id 'deployment-mode' -Name 'Deployment mode' -Status 'PASS' `
            -Reason "Mode is 'remote' (inherited, not written)." `
            -Evidence @(
                "DEPLOYMENT_MODE is absent from $EnvFile",
                "an install predating #172 has no such key and keeps its previous behaviour, so it is read as 'remote'",
                "same fallback as scripts\installer\firstrun-config.ps1:143"
            ) | Out-Null
        return
    }
    if (@('local', 'remote') -notcontains $raw) {
        New-Check -Id 'deployment-mode' -Name 'Deployment mode' -Status 'FAIL' `
            -Reason "DEPLOYMENT_MODE is '$raw', which is neither 'local' nor 'remote'. Nothing below can be judged against a mode that does not exist. Fix it in $EnvFile and re-run." `
            -Evidence @("$EnvFile : DEPLOYMENT_MODE=$raw") | Out-Null
        return
    }
    $script:Mode = $raw
    $meaning = 'remote: a service, a listening port and an OAuth password are all expected here'
    if ($raw -eq 'local') { $meaning = 'local: no service, no listening port, no OAuth password, no tunnel' }
    New-Check -Id 'deployment-mode' -Name 'Deployment mode' -Status 'PASS' `
        -Reason "Mode is '$raw'. Every check below is interpreted against it." `
        -Evidence @("$EnvFile : DEPLOYMENT_MODE=$raw", $meaning) | Out-Null
}
$IsLocal   = ($Mode -eq 'local')
# When check 1 could not settle the mode (no .env, or a typo'd value), the four mode-scoped checks
# below have nothing to interpret themselves against. They must NOT fall through to the "remote mode
# does this by design" reason - that would tell a customer with a broken .env that their install is
# fine as remote. NA with the real reason instead; check 1 already carries the FAIL (or, for an
# unreadable .env on an unelevated run, the UNKNOWN) and with it the verdict and the exit code.
$ModeKnown = ($Mode -eq 'local' -or $Mode -eq 'remote')

function New-UndeterminedModeCheck {
    param([string]$Id, [string]$Name)
    New-Check -Id $Id -Name $Name -Status 'NA' `
        -Reason "The deployment mode could not be determined (see the first check), and this property is only claimed in one mode - so there is nothing here to judge until that is fixed." | Out-Null
}

# ---------------------------------------------------------------------------
# 2. No listening socket owned by our processes
# ---------------------------------------------------------------------------
Invoke-Check -Id 'no-listening-socket' -Name 'No listening socket owned by Tally MCP' -Body {
    if (-not $ModeKnown) { New-UndeterminedModeCheck -Id 'no-listening-socket' -Name 'No listening socket owned by Tally MCP'; return }
    if (-not $IsLocal) {
        New-Check -Id 'no-listening-socket' -Name 'No listening socket owned by Tally MCP' -Status 'NA' `
            -Reason "Remote mode serves MCP over HTTP, so a listening socket is the intended design and not a defect. This claim belongs to local mode." | Out-Null
        return
    }

    $listen = Get-ListeningEndpoint
    $ourPids = @()
    foreach ($p in $OurProcesses) { $ourPids += [int]$p.ProcessId }

    # Attribution is by owning PID and nothing else. Judging by port number would be wrong in both
    # directions: it would blame us for whatever else happens to sit on 3000, and it would miss us
    # entirely on any other port.
    $ours = @()
    foreach ($e in $listen.Endpoints) {
        if ($ourPids -contains $e.OwningPid) { $ours += $e }
    }

    $running = 'none right now'
    if ($OurProcesses.Count -gt 0) {
        $running = (($OurProcesses | ForEach-Object { Format-ProcessLine $_ }) -join '; ')
    }
    $evidence = @(
        "listener source: $($listen.Source)",
        "listening TCP endpoints on this machine: $($listen.Endpoints.Count)",
        "processes running from ${InstallDir}: $running",
        "listeners owned by those processes: $($ours.Count)"
    )

    # State the Tally caveat out loud. Tally's own XML server listens on 9000 and is a PREREQUISITE
    # of this product (docs\README.md:44 - "TallyPrime acts as = Server, Port = 9000"), so a
    # correctly installed local deployment DOES have a listening socket on the machine. Leaving
    # this out would make the check read as "nothing listens here", which the customer can disprove
    # in ten seconds with netstat - and then they stop believing the rest of the report.
    $tallyPids = @()
    try {
        foreach ($t in @(Get-Process -Name 'tally' -ErrorAction SilentlyContinue)) { $tallyPids += [int]$t.Id }
    } catch { }
    $tallyListeners = @()
    foreach ($e in $listen.Endpoints) {
        if ($tallyPids -contains $e.OwningPid) { $tallyListeners += "$($e.Local) (tally.exe pid=$($e.OwningPid))" }
    }
    if ($tallyListeners.Count -gt 0) {
        $evidence += "Tally itself is listening on $($tallyListeners -join ', '). That is Tally's own XML server, a PREREQUISITE of this product, not part of Tally MCP. This check is about our process, not about the machine."
    } else {
        $evidence += "note: Tally's own XML server normally listens on port 9000 and is a PREREQUISITE of this product, so a working install does have a listening socket on the machine. This check is about our process, not about the machine."
    }

    $caveat = ''
    if ($OurProcesses.Count -eq 0) {
        # Honest framing: in local mode the server exists only while the MCP client has it spawned,
        # so an empty process set is the expected state - and it also means very little was proved.
        # Say so instead of banking a free PASS.
        $caveat = "No Tally MCP process is running at this moment. In local mode the server only runs while the MCP client (e.g. Claude Desktop) has it open, so this is normal - but the strongest version of this check is to re-run it while the client is open."
    }
    if (-not $IsElevated) {
        $c = "This run is not elevated, so command lines of processes owned by other Windows accounts are hidden and a Tally MCP process started by another account could be missed. Re-run as Administrator for a complete answer."
        if ($caveat) { $caveat = "$caveat $c" } else { $caveat = $c }
    }

    # Fail closed on an ambiguous listener: a node.exe / cloudflared.exe whose command line we could
    # not read (see $UnreadableCandidates) and which IS listening cannot be ruled out as ours.
    $unreadablePids = @()
    foreach ($u in $UnreadableCandidates) { $unreadablePids += [int]$u.ProcessId }
    $ambiguous = @()
    foreach ($e in $listen.Endpoints) {
        if ($unreadablePids -contains $e.OwningPid) { $ambiguous += "$($e.Local) (pid=$($e.OwningPid))" }
    }

    if ($ours.Count -gt 0) {
        $detail = @()
        foreach ($e in $ours) { $detail += "$($e.Local) (pid=$($e.OwningPid))" }
        New-Check -Id 'no-listening-socket' -Name 'No listening socket owned by Tally MCP' -Status 'FAIL' `
            -Reason "A process from this install is listening on $($detail -join ', '). Local mode is supposed to bind nothing at all, so something is still running the HTTP server (dist\server.mjs) - look for a leftover service or a hand-started process." `
            -Evidence $evidence -Caveat $caveat | Out-Null
    } elseif (-not $listen.Readable) {
        # Neither Get-NetTCPConnection nor netstat produced a socket table. Zero endpoints here means
        # "did not look", not "nothing listens" - reporting it as the PASS below would be a false
        # all-clear on the single most important local-mode claim.
        New-Check -Id 'no-listening-socket' -Name 'No listening socket owned by Tally MCP' -Status 'UNKNOWN' `
            -Reason "The list of listening sockets could not be read on this machine (Get-NetTCPConnection returned nothing and netstat produced no output), so whether anything of ours is listening could not be checked at all. Re-run this script; if it still says this, run 'netstat -ano' by hand and look for a listener owned by one of the processes named below." `
            -Evidence $evidence -Caveat $caveat | Out-Null
    } elseif ($ambiguous.Count -gt 0) {
        # NOT a detection - say so in the first clause. This branch fires because the run lacked the
        # privilege to read a command line, and the named process is very often unrelated software
        # (any Node app under another Windows account looks exactly like this). It is UNKNOWN, not
        # PASS, because "we could not look" must not be reported as "we looked and it was clean" -
        # and not FAIL either, because on a correct install with an unrelated Node service that
        # painted every unelevated run red and made the exit code useless as a gate (#193).
        $settle = "Re-run this script as Administrator and it will attribute the process one way or the other."
        if ($IsElevated) {
            # Elevated and still unreadable: a protected process, or one that exited mid-run.
            # "Re-run as Administrator" would be advice this run has already followed.
            $settle = "Even this elevated run could not read its command line (a protected process, or one that exited during the check). Re-run once; if it persists, identify the process by its PID in Task Manager's Details tab."
        }
        New-Check -Id 'no-listening-socket' -Name 'No listening socket owned by Tally MCP' -Status 'UNKNOWN' `
            -Reason "Not a detection. $($ambiguous -join ', ') is listening, and this run does not have permission to read that process's command line - so it can be neither confirmed nor ruled out as Tally MCP. It is most likely unrelated software running under another Windows account. $settle" `
            -Evidence $evidence -Caveat $caveat | Out-Null
    } elseif ((-not $ProcessEnumOk) -and $listen.Endpoints.Count -gt 0) {
        # The socket table came back but the process table did not, so no listener could be tested
        # against our install tree at all - an empty "ours" here is an artefact of not looking.
        New-Check -Id 'no-listening-socket' -Name 'No listening socket owned by Tally MCP' -Status 'UNKNOWN' `
            -Reason "$($listen.Endpoints.Count) socket(s) are listening on this machine, but the process list could not be read ($ProcessEnumError), so none of them could be attributed to Tally MCP or ruled out. Re-run this script as Administrator; if it still says this, the WMI service (winmgmt) may need attention." `
            -Evidence $evidence -Caveat $caveat | Out-Null
    } else {
        New-Check -Id 'no-listening-socket' -Name 'No listening socket owned by Tally MCP' -Status 'PASS' `
            -Reason "No listening TCP socket on this machine is owned by a Tally MCP process." `
            -Evidence $evidence -Caveat $caveat | Out-Null
    }
}

# ---------------------------------------------------------------------------
# 3. No NSSM service
# ---------------------------------------------------------------------------
Invoke-Check -Id 'no-service' -Name 'No Windows service registered' -Body {
    if (-not $ModeKnown) { New-UndeterminedModeCheck -Id 'no-service' -Name 'No Windows service registered'; return }
    if (-not $IsLocal) {
        New-Check -Id 'no-service' -Name 'No Windows service registered' -Status 'NA' `
            -Reason "Remote mode registers the '$ServiceName' NSSM service by design, so its presence here is correct rather than a finding." | Out-Null
        return
    }

    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    # Get-Service alone is not enough. `nssm remove` / `sc delete` marks a service for deletion, but
    # the SCM only reaps HKLM\SYSTEM\CurrentControlSet\Services\<name> once every open handle
    # closes. Until then Get-Service reports nothing while the key still holds the whole NSSM
    # configuration - including AppEnvironmentExtra, which is where the old OAuth password lived
    # (firstrun-config.ps1 pushes every .env line into it). A pending-delete service can also come
    # back after a reboot. Check both, and say which one is the problem.
    $regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
    $regPresent = Test-Path -LiteralPath $regPath

    $svcText = 'not found'
    if ($svc) { $svcText = "present, status $($svc.Status)" }
    $regText = 'absent'
    if ($regPresent) { $regText = 'present' }
    $evidence = @(
        "Get-Service '$ServiceName': $svcText",
        "registry key ${regPath}: $regText"
    )

    if ($svc) {
        New-Check -Id 'no-service' -Name 'No Windows service registered' -Status 'FAIL' `
            -Reason "The '$ServiceName' service still exists (status $($svc.Status)). Local mode runs on demand under the MCP client and must have no service at all. Run the installer's Reconfigure shortcut to remove it." `
            -Evidence $evidence | Out-Null
    } elseif ($regPresent) {
        New-Check -Id 'no-service' -Name 'No Windows service registered' -Status 'FAIL' `
            -Reason "The service is gone from the service manager but its registry key survives at $regPath, so removal is only pending and the key still holds the old service configuration. Reboot and re-run this check, or delete it with an elevated 'sc.exe delete $ServiceName'." `
            -Evidence $evidence | Out-Null
    } else {
        New-Check -Id 'no-service' -Name 'No Windows service registered' -Status 'PASS' `
            -Reason "There is no '$ServiceName' service and no leftover registry key for one." `
            -Evidence $evidence | Out-Null
    }
}

# ---------------------------------------------------------------------------
# 4. No OAuth artefacts
# ---------------------------------------------------------------------------
Invoke-Check -Id 'no-oauth' -Name 'No OAuth password or persisted tokens' -Body {
    if (-not $ModeKnown) { New-UndeterminedModeCheck -Id 'no-oauth' -Name 'No OAuth password or persisted tokens'; return }
    if (-not $IsLocal) {
        New-Check -Id 'no-oauth' -Name 'No OAuth password or persisted tokens' -Status 'NA' `
            -Reason "Remote mode authenticates callers with OAuth, so the password and the client/token stores are expected to exist. This claim belongs to local mode." | Out-Null
        return
    }

    # Paths per src\server.mts:134 and :138 - __dirname is dist\ and the code joins '..', so both
    # land in the install root next to .env.
    $clientsFile = Join-Path $InstallDir '.oauth-clients.json'
    $tokensFile  = Join-Path $InstallDir '.oauth-tokens.json'

    # PRESENCE only. Test-EnvKeyPresent cannot return the value, so no code path below can print it.
    $passwordSet    = Test-EnvKeyPresent 'PASSWORD'
    $clientsPresent = Test-Path -LiteralPath $clientsFile
    $tokensPresent  = Test-Path -LiteralPath $tokensFile

    $clientsText = 'absent'
    if ($clientsPresent) { $clientsText = 'present' }
    $tokensText = 'absent'
    if ($tokensPresent) { $tokensText = 'present' }
    $passwordText = 'not set'
    if ($passwordSet) { $passwordText = 'present and non-empty' }

    $evidence = @(
        "${clientsFile}: $clientsText",
        "${tokensFile}: $tokensText",
        "$EnvFile : PASSWORD key $passwordText - this script tests presence only and never reads or prints the value"
    )

    $problems = @()
    if ($passwordSet)    { $problems += "PASSWORD is still set in .env, and that one credential gates read AND write on live books" }
    if ($clientsPresent) { $problems += "$clientsFile exists (persisted OAuth client secrets)" }
    if ($tokensPresent)  { $problems += "$tokensFile exists (persisted access tokens)" }

    if ($problems.Count -gt 0) {
        New-Check -Id 'no-oauth' -Name 'No OAuth password or persisted tokens' -Status 'FAIL' `
            -Reason "Leftover OAuth material found: $($problems -join '; '). In local mode none of it is used, so it is almost certainly residue from an earlier remote install. Delete the .oauth-*.json files and clear the PASSWORD line from .env." `
            -Evidence $evidence | Out-Null
    } else {
        New-Check -Id 'no-oauth' -Name 'No OAuth password or persisted tokens' -Status 'PASS' `
            -Reason "No OAuth password in .env, and no persisted client or token store on disk." `
            -Evidence $evidence | Out-Null
    }
}

# ---------------------------------------------------------------------------
# A machine-wide TUNNEL_TOKEN environment variable (#229 follow-up). Used by checks 5 and 6.
# Returns absent | present | denied - never the value.
# ---------------------------------------------------------------------------
$MachineEnvKeyPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
function Get-MachineTunnelTokenState {
    try {
        $key = Get-Item -LiteralPath $MachineEnvKeyPath -ErrorAction Stop
    } catch [System.Security.SecurityException] {
        return 'denied'
    } catch [System.UnauthorizedAccessException] {
        return 'denied'
    }
    $v = $key.GetValue('TUNNEL_TOKEN', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($null -ne $v -and "$v".Trim()) { return 'present' }
    return 'absent'
}

# ---------------------------------------------------------------------------
# 5. No outbound tunnel
# ---------------------------------------------------------------------------
Invoke-Check -Id 'no-tunnel' -Name 'No outbound tunnel' -Body {
    if (-not $ModeKnown) { New-UndeterminedModeCheck -Id 'no-tunnel' -Name 'No outbound tunnel'; return }
    if (-not $IsLocal) {
        # REMOTE_TRANSPORT (#178) records whether this remote install is meant to have one. Either
        # way a tunnel is not a defect in remote mode, so report NA and name the configured
        # transport so the reader can see which it is.
        $transport = Get-EnvValue 'REMOTE_TRANSPORT'
        if (-not $transport) { $transport = 'tunnel (the default when the key is absent)' }
        New-Check -Id 'no-tunnel' -Name 'No outbound tunnel' -Status 'NA' `
            -Reason "Remote mode may legitimately run a Cloudflare Tunnel; REMOTE_TRANSPORT is '$transport'. The no-third-party-in-the-data-path claim belongs to local mode." | Out-Null
        return
    }

    $tunnelSvc = Get-Service -Name $TunnelServiceName -ErrorAction SilentlyContinue
    $tunnelRegPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$TunnelServiceName"
    $tunnelReg = Test-Path -LiteralPath $tunnelRegPath
    $cfProcs   = @(Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue)
    # Presence only: the token is a bearer credential for the Cloudflare account and its value is
    # never read here.
    $tokenSet  = Test-EnvKeyPresent 'TUNNEL_TOKEN'
    # The file firstrun-config.ps1 hands cloudflared its token through (#193). Existence only - it is
    # locked to SYSTEM + Administrators, and this check has no reason to open it.
    $tokenFilePresent = Test-Path -LiteralPath $TunnelTokenFile

    $svcText = 'not found'
    if ($tunnelSvc) { $svcText = "present, status $($tunnelSvc.Status)" }
    $regText = 'absent'
    if ($tunnelReg) { $regText = 'present' }
    $procText = 'none'
    if ($cfProcs.Count -gt 0) { $procText = (($cfProcs | ForEach-Object { "pid=$($_.Id)" }) -join ', ') }
    $tokenText = 'not set'
    if ($tokenSet) { $tokenText = 'present and non-empty' }

    $evidence = @(
        "Get-Service '$TunnelServiceName': $svcText",
        "registry key ${tunnelRegPath}: $regText",
        "cloudflared.exe processes: $procText",
        "$EnvFile : TUNNEL_TOKEN $tokenText - presence only; the token value is never read or printed"
    )
    $tokenFileText = 'absent'
    if ($tokenFilePresent) { $tokenFileText = 'present' }
    $evidence += "${TunnelTokenFile}: $tokenFileText - existence only; the file is never opened"

    $machineToken = Get-MachineTunnelTokenState
    $machineText = 'not set'
    if ($machineToken -eq 'present') { $machineText = 'SET (value not read or printed)' }
    elseif ($machineToken -eq 'denied') { $machineText = 'could not be read by this account' }
    $evidence += "machine-wide TUNNEL_TOKEN environment variable: $machineText"

    $problems = @()
    if ($tunnelSvc)           { $problems += "the '$TunnelServiceName' service exists (status $($tunnelSvc.Status))" }
    elseif ($tunnelReg)       { $problems += "the '$TunnelServiceName' service registry key survives, so its removal is only pending" }
    if ($cfProcs.Count -gt 0) { $problems += "cloudflared.exe is running" }
    if ($tokenSet)            { $problems += "TUNNEL_TOKEN is still set in .env, so the next Reconfigure would bring the tunnel back" }
    if ($tokenFilePresent)    { $problems += "$TunnelTokenFile still holds a tunnel token, a live credential local mode never uses" }
    if ($machineToken -eq 'present') { $problems += "a machine-wide TUNNEL_TOKEN environment variable is set - a tunnel credential every local account can read (remove it from an elevated PowerShell with [Environment]::SetEnvironmentVariable('TUNNEL_TOKEN', `$null, 'Machine'); the installer leaves it, since something else may use it)" }

    if ($problems.Count -gt 0) {
        New-Check -Id 'no-tunnel' -Name 'No outbound tunnel' -Status 'FAIL' `
            -Reason "A tunnel to a third party is configured or running: $($problems -join '; '). Local mode puts nobody in the data path. Clear the tunnel token via the installer's Reconfigure shortcut, which also tears the service down." `
            -Evidence $evidence | Out-Null
    } elseif ($machineToken -eq 'denied') {
        New-Check -Id 'no-tunnel' -Name 'No outbound tunnel' -Status 'UNKNOWN' `
            -Reason "No tunnel service, process or token was found, but the machine-wide environment could not be read, so a TUNNEL_TOKEN there could not be ruled out. Re-run this script as Administrator." `
            -Evidence $evidence | Out-Null
    } else {
        New-Check -Id 'no-tunnel' -Name 'No outbound tunnel' -Status 'PASS' `
            -Reason "No cloudflared process, no tunnel service, and no tunnel token that could start one." `
            -Evidence $evidence | Out-Null
    }
}

# ---------------------------------------------------------------------------
# Principals that make a file effectively readable by every local account. Used by the tunnel-token
# and vault checks. Named, so a FAIL can say WHICH mistake was made instead of dumping a raw SID at
# a non-technical reader.
# ---------------------------------------------------------------------------
$BroadSids = @{
    'S-1-1-0'      = 'Everyone'
    'S-1-5-32-545' = 'BUILTIN\Users'
    'S-1-5-11'     = 'Authenticated Users'
    'S-1-5-4'      = 'INTERACTIVE'
    'S-1-5-32-546' = 'BUILTIN\Guests'
    'S-1-5-7'      = 'ANONYMOUS LOGON'
    'S-1-5-32-547' = 'BUILTIN\Power Users'
}

# ---------------------------------------------------------------------------
# 6. Tunnel token storage (remote mode, #193)
#
# The Cloudflare Tunnel token is a bearer credential: whoever holds it can run a connector for the
# tunnel's hostname. Installers before #193 handed it to cloudflared through NSSM's
# AppEnvironmentExtra, which lives in the service's registry key - readable by BUILTIN\Users. Now it
# goes through <InstallDir>\.tunnel-token (cloudflared --token-file), locked to SYSTEM +
# Administrators with Administrators as owner, and firstrun-config.ps1 scrubs the registry copy on
# every run. This check proves both halves:
#   - no TUNNEL_TOKEN in the environment of the tunnel service OR the main service (installs from
#     before #172 C3 copied all of .env, token included, into the main service's environment), and
#     no --token on the tunnel's command line;
#   - the token file's ACL is protected, grants only SYSTEM and Administrators, and is owned by one
#     of them (an owner can always rewrite the DACL).
# Reads registry values and the ACL only. The value of an AppEnvironmentExtra entry is never kept or
# printed - only whether its NAME is TUNNEL_TOKEN - and the token file is never opened.
# ---------------------------------------------------------------------------
function Get-NssmServiceParameters {
    # Returns State = absent | denied | read, plus what this check needs from the Parameters key.
    # NSSM keeps a service's environment in two REG_MULTI_SZ values: AppEnvironmentExtra (added to
    # the inherited environment - where installers before #193 put the token) and AppEnvironment
    # (which replaces it). A TUNNEL_TOKEN in either overrides --token-file, so both are read.
    param([string]$Name)
    $keyPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters"
    $r = New-Object psobject -Property ([ordered]@{
        KeyPath       = $keyPath
        State         = 'absent'
        EnvEntries    = 0
        EnvHasToken   = $false
        EnvTokenIn    = @()
        AppParameters = ''
    })
    $key = $null
    try {
        $key = Get-Item -LiteralPath $keyPath -ErrorAction Stop
    } catch [System.Management.Automation.ItemNotFoundException] {
        return $r
    } catch [System.Security.SecurityException] {
        $r.State = 'denied'; return $r
    } catch [System.UnauthorizedAccessException] {
        $r.State = 'denied'; return $r
    }
    $r.State = 'read'
    foreach ($valueName in @('AppEnvironmentExtra', 'AppEnvironment')) {
        foreach ($entry in @($key.GetValue($valueName))) {
            if ($null -eq $entry -or "$entry" -eq '') { continue }
            $r.EnvEntries++
            # Name test only, and only a NON-EMPTY value counts as a token. The value is never stored.
            if ("$entry" -match '^\s*TUNNEL_TOKEN\s*=\s*\S') {
                $r.EnvHasToken = $true
                if ($r.EnvTokenIn -notcontains $valueName) { $r.EnvTokenIn += $valueName }
            }
        }
    }
    $ap = $key.GetValue('AppParameters')
    if ($ap) { $r.AppParameters = "$ap" }
    return $r
}

Invoke-Check -Id 'tunnel-token-storage' -Name 'Tunnel token kept out of the service registry' -Body {
    if (-not $ModeKnown) { New-UndeterminedModeCheck -Id 'tunnel-token-storage' -Name 'Tunnel token kept out of the service registry'; return }
    if ($IsLocal) {
        New-Check -Id 'tunnel-token-storage' -Name 'Tunnel token kept out of the service registry' -Status 'NA' `
            -Reason "Local mode runs no tunnel, so there is no tunnel token to store. Any leftover token, file or service is reported by the 'No outbound tunnel' check above." | Out-Null
        return
    }

    $evidence = @()
    $problems = @()
    $unknowns = @()

    # --- Registry: the tunnel service and the main service -------------------------------------
    $tunnelParams = $null
    foreach ($svcName in @($TunnelServiceName, $ServiceName)) {
        $p = Get-NssmServiceParameters -Name $svcName
        if ($svcName -eq $TunnelServiceName) { $tunnelParams = $p }
        if ($p.State -eq 'absent') {
            $evidence += "$($p.KeyPath): absent"
        } elseif ($p.State -eq 'denied') {
            $evidence += "$($p.KeyPath): this account may not read it"
            $unknowns += "the '$svcName' service registry key could not be read"
        } else {
            if ($p.EnvHasToken) {
                $evidence += "$($p.KeyPath): the service environment (AppEnvironmentExtra + AppEnvironment) has $($p.EnvEntries) entries, including TUNNEL_TOKEN in $($p.EnvTokenIn -join ' and ') (value not read or printed)"
                $problems += "the '$svcName' service still carries TUNNEL_TOKEN in its registry environment ($($p.EnvTokenIn -join ', ')), where BUILTIN\Users can read it and where it overrides the token file"
            } else {
                $evidence += "$($p.KeyPath): the service environment (AppEnvironmentExtra + AppEnvironment) has $($p.EnvEntries) entries, none of them TUNNEL_TOKEN"
            }
        }
    }

    # --- A machine-wide TUNNEL_TOKEN environment variable --------------------------------------
    # Every service inherits the machine environment, and cloudflared gives TUNNEL_TOKEN there
    # precedence over --token-file - so this silently overrides the file, and every local account can
    # read it. The installer reports it but deliberately does not delete it (see firstrun-config.ps1).
    $machineToken = Get-MachineTunnelTokenState
    if ($machineToken -eq 'present') {
        $evidence += "${MachineEnvKeyPath}: TUNNEL_TOKEN is set machine-wide (value not read or printed)"
        $problems += "a machine-wide TUNNEL_TOKEN environment variable is set: every local account can read it, and cloudflared uses it instead of the token file"
    } elseif ($machineToken -eq 'denied') {
        $evidence += "${MachineEnvKeyPath}: this account may not read it"
        $unknowns += "the machine-wide environment could not be read, so a TUNNEL_TOKEN there could not be ruled out"
    } else {
        $evidence += "${MachineEnvKeyPath}: no TUNNEL_TOKEN"
    }
    if ($tunnelParams -and $tunnelParams.State -eq 'read') {
        # '--token-file' must not be mistaken for '--token <value>': require whitespace or '=' after it.
        if ($tunnelParams.AppParameters -match '(^|\s)--token(\s|=)') {
            $problems += "the '$TunnelServiceName' command line passes the token itself (--token), and NSSM stores that command line in the same registry key BUILTIN\Users can read"
            $evidence += "$($tunnelParams.KeyPath): AppParameters passes --token (value not printed)"
        } elseif ($tunnelParams.AppParameters -match '(^|\s)--token-file(\s|=)') {
            $evidence += "$($tunnelParams.KeyPath): AppParameters reads the token from a file (--token-file)"
        } else {
            $evidence += "$($tunnelParams.KeyPath): AppParameters does not use --token-file (a service registered before #193)"
        }
    }

    # --- Is a tunnel configured at all? --------------------------------------------------------
    $tunnelSvc = Get-Service -Name $TunnelServiceName -ErrorAction SilentlyContinue
    $envToken  = Test-EnvKeyPresent 'TUNNEL_TOKEN'
    $tokenFileExists = Test-Path -LiteralPath $TunnelTokenFile
    $tunnelConfigured = ($tunnelSvc -or $envToken -or $tokenFileExists -or ($tunnelParams -and $tunnelParams.State -ne 'absent'))

    # --- The token file's ACL ------------------------------------------------------------------
    if ($tunnelConfigured) {
        $acl = $null
        $fileDenied = $false
        try {
            $acl = Get-Acl -LiteralPath $TunnelTokenFile -ErrorAction Stop
        } catch [System.UnauthorizedAccessException] {
            $fileDenied = $true
        } catch [System.Management.Automation.ItemNotFoundException] {
            $acl = $null
        }

        if ($fileDenied) {
            $evidence += "${TunnelTokenFile}: present; reading its ACL from this account failed with Access Denied"
            if ($IsElevated) {
                # The installer grants Administrators Full Control and makes them the owner, so an
                # elevated run being shut out means something rewrote the ACL.
                $problems += "even this elevated run may not read the token file's permissions, which the installer never sets up"
            } else {
                $unknowns += "the token file's permissions could not be read (it is locked to SYSTEM + Administrators, which is what a correct install looks like from here)"
            }
        } elseif ($null -eq $acl) {
            $evidence += "${TunnelTokenFile}: absent"
            if ($tunnelSvc) {
                $problems += "the '$TunnelServiceName' service exists but there is no token file, so it was registered by an installer from before #193 (token in the registry) or the file was deleted"
            }
        } else {
            $sidType = [System.Security.Principal.SecurityIdentifier]
            $allowed = @{ 'S-1-5-18' = 'NT AUTHORITY\SYSTEM'; 'S-1-5-32-544' = 'BUILTIN\Administrators' }
            if ($acl.AreAccessRulesProtected) {
                $evidence += "${TunnelTokenFile}: inheritance disabled"
            } else {
                $evidence += "${TunnelTokenFile}: inheritance ENABLED"
                $problems += "the token file inherits its folder's permissions instead of a deliberate list (under Program Files that means BUILTIN\Users can read it)"
            }
            $ownerSid = ''
            try { $ownerSid = $acl.GetOwner($sidType).Value } catch { $ownerSid = "$($acl.Owner)" }
            if ($allowed.ContainsKey($ownerSid)) {
                $evidence += "owner: $($allowed[$ownerSid])"
            } else {
                $evidence += "owner: $($acl.Owner) (sid $ownerSid)"
                $problems += "the token file is owned by $($acl.Owner), who can rewrite its permissions and read it without elevating"
            }
            foreach ($rule in $acl.Access) {
                if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
                    $evidence += "deny entry (not a finding): $($rule.IdentityReference) : $($rule.FileSystemRights)"
                    continue
                }
                $sid = ''
                try { $sid = $rule.IdentityReference.Translate($sidType).Value } catch { $sid = "$($rule.IdentityReference)" }
                if ($allowed.ContainsKey($sid)) {
                    $evidence += "expected: $($allowed[$sid]) : $($rule.FileSystemRights)"
                    continue
                }
                # Unlike the vault, the agent user has no business here: nothing that runs as that
                # account needs the tunnel token. So there is no "indeterminate" case - any other
                # allow entry is a finding.
                $label = "$($rule.IdentityReference)"
                if ($BroadSids.ContainsKey($sid)) { $label = "$($BroadSids[$sid]) - a group that in practice means every local account" }
                $evidence += "UNEXPECTED: $label : $($rule.FileSystemRights) (sid $sid)"
                $problems += "the token file grants $label"
            }
        }
        if ($envToken) {
            # Honest about the second copy: .env keeps the token so Reconfigure and upgrades can
            # preserve it, and .env is also readable by AGENT_TASK_USER. Not a finding of this check.
            $evidence += "note: $EnvFile also holds TUNNEL_TOKEN (so Reconfigure can preserve it); that copy is protected by the .env ACL, which also admits AGENT_TASK_USER"
        }
    }

    $name = 'Tunnel token kept out of the service registry'
    if ($problems.Count -gt 0) {
        $machineFix = ''
        if ($machineToken -eq 'present') {
            $machineFix = " Remove the machine-wide variable yourself (Reconfigure leaves it, since something else may use it): from an elevated PowerShell, [Environment]::SetEnvironmentVariable('TUNNEL_TOKEN', `$null, 'Machine')."
        }
        New-Check -Id 'tunnel-token-storage' -Name $name -Status 'FAIL' `
            -Reason "The Cloudflare Tunnel token is not stored the way it should be: $($problems -join '; '). Run the installer's Reconfigure shortcut as Administrator - it writes the token to a file only SYSTEM and Administrators can read and removes it from the service registry.$machineFix If other people use this machine, also ask your Jina admin to rotate the tunnel token: the copy found here may already have been read." `
            -Evidence $evidence | Out-Null
    } elseif (-not $tunnelConfigured) {
        New-Check -Id 'tunnel-token-storage' -Name $name -Status 'NA' `
            -Reason "No Cloudflare Tunnel is configured on this remote install, so there is no tunnel token to protect." `
            -Evidence $evidence | Out-Null
    } elseif ($unknowns.Count -gt 0) {
        New-Check -Id 'tunnel-token-storage' -Name $name -Status 'UNKNOWN' `
            -Reason "Nothing was found wrong, but not everything could be looked at: $($unknowns -join '; '). Re-run this script as Administrator to confirm the tunnel token is stored correctly." `
            -Evidence $evidence | Out-Null
    } else {
        $passReason = "The tunnel token is in no service registry key and not on the command line; cloudflared reads it from a file only SYSTEM and Administrators can open."
        if (-not $tunnelSvc -and -not $tokenFileExists) {
            $passReason = "No tunnel service is registered right now, and the tunnel token is in no service registry key."
        }
        New-Check -Id 'tunnel-token-storage' -Name $name -Status 'PASS' `
            -Reason $passReason `
            -Evidence $evidence | Out-Null
    }
}

# ---------------------------------------------------------------------------
# 7. Company vault ACL
#
# THE MOST IMPORTANT FAIL THIS SCRIPT CAN REPORT, and it applies in BOTH modes. The vault
# (%ProgramData%\Claudally\agent\.tally-mcp-companies.json; in TALLY_DATA_PATH before #230's
# follow-up) holds DPAPI-protected Tally company passwords, and
# the DPAPI scope is LocalMachine (scripts\dpapi-helper.ps1:32) - so any local principal that can
# READ the file can also DECRYPT it. The entropy value is a public literal in this repo and is
# world-readable in Program Files (scripts\migrate-vault-entropy.ps1 says as much in its own
# summary). The NTFS ACL is therefore not defence in depth here; it is the entire boundary.
#
# Expected state: inheritance disabled, and allow-ACEs for exactly SYSTEM, BUILTIN\Administrators
# and AGENT_TASK_USER - what firstrun-config.ps1 sets, by SID (#230), with
#   icacls <file> /inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F *<agent user's SID>:F
# Installers before #230 named the groups ('Administrators:F'), which on a non-English Windows
# failed and left the file with its inherited ACL - exactly what the inheritance test below catches.
# Every comparison here is by SID, so a localised Windows is judged the same as an English one.
# ---------------------------------------------------------------------------
Invoke-Check -Id 'vault-acl' -Name 'Company vault ACL (stored Tally passwords)' -Body {
    $vaultPath = Get-EnvValue 'TALLY_COMPANIES_CONFIG'
    $vaultNote = ''
    if ($vaultPath) {
        $vaultNote = 'vault path overridden by TALLY_COMPANIES_CONFIG in .env'
    } else {
        # The agent folder - the same default as resolveCompanyVaultPath() in src\mcp.mts and
        # Get-CompanyVaultPath in the tray. (A vault still in Tally's data folder, where versions
        # before #230's follow-up kept it, is reported by check 8.)
        $vaultPath = Join-Path $AgentDir '.tally-mcp-companies.json'
    }
    # An unreadable .env looks exactly like one with no overrides, so the default above may not be
    # where this install keeps its vault at all. Say so rather than claiming the keys are "not set",
    # and remember it: a vault NOT found at the default is then "did not know where to look".
    $vaultLocationUnknown = ($EnvExists -and -not $EnvReadable)
    if ($vaultLocationUnknown) {
        $vaultNote = ".env could not be read by this account, so any TALLY_COMPANIES_CONFIG / AGENT_TASK_USER setting in it is unknown; this looked only at the installer default location"
    }

    # In the agent folder the vault may legitimately INHERIT its list: the tray's Manage Companies
    # saves with a .tmp-and-rename there, and the new file takes the folder's (OI)(CI) entries -
    # the same three accounts, on a folder of ours that check 8 verifies. Anywhere else, inheriting
    # means carrying whatever someone else's folder grants.
    $inAgentDir = [string]::Equals((Split-Path -Parent $vaultPath).TrimEnd('\'), $AgentDir.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)

    # ONE probe, and it must tell "not there" apart from "there, but you may not look".
    #
    # Test-Path answers $false for BOTH, and on the way it writes a raw PermissionDenied record to
    # the error stream that lands in the middle of a report aimed at a non-technical reader. Taking
    # that $false as "absent" was the worst bug this check could carry: a vault locked down exactly
    # as intended is INVISIBLE to every account that is not SYSTEM, an Administrator or
    # AGENT_TASK_USER - the installer also protects the agent folder the vault lives in
    # (lockdown-helpers.ps1, _EnsureAgentDir), so such an account cannot even list the parent - and the check
    # then told precisely the customer whose ACL was working that "there is no company vault on
    # this machine, so no Tally passwords are stored". A false all-clear on the one boundary
    # protecting stored Tally passwords.
    #
    # Get-Acl distinguishes them cleanly: UnauthorizedAccessException for denied,
    # ItemNotFoundException for absent (verified on 5.1.20348).
    $acl = $null
    $vaultDenied = $false
    try {
        $acl = Get-Acl -LiteralPath $vaultPath -ErrorAction Stop
    } catch [System.UnauthorizedAccessException] {
        $vaultDenied = $true
    } catch [System.Management.Automation.ItemNotFoundException] {
        $acl = $null
    } catch {
        # Anything else (a mangled path, an offline volume) is a genuine "could not verify" and
        # belongs to Invoke-Check's fail-closed handler, not to a silent "no vault here".
        throw
    }

    if ($vaultDenied) {
        $ev = @("vault: $vaultPath")
        if ($vaultNote) { $ev += $vaultNote }
        $ev += "reading the ACL from this account failed with Access Denied - the file is there, this account may not inspect it"
        $ev += "running as: $($Identity.Name) (elevated: $IsElevated)"
        if ($IsElevated) {
            # An Administrator being locked out is genuinely anomalous: the installer always grants
            # BUILTIN\Administrators Full Control (lockdown-helpers.ps1), so this ACL is wrong in
            # a way this run cannot even describe. Fail closed.
            New-Check -Id 'vault-acl' -Name 'Company vault ACL (stored Tally passwords)' -Status 'FAIL' `
                -Reason "The company vault exists but even this elevated run is denied permission to read its ACL. The installer always grants Administrators Full Control, so something has rewritten this file's permissions and the protection of the stored Tally passwords cannot be established at all. Take ownership and reset it: takeown /f `"$vaultPath`" then icacls `"$vaultPath`" /inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F (SYSTEM and Administrators by SID, which works in every Windows language), then run the installer's Reconfigure to add the agent account back." `
                -Evidence $ev | Out-Null
        } else {
            # UNKNOWN. Not a FAIL: this is what a correctly locked-down vault looks like from an
            # account that is supposed to be shut out, and #172's rule is that a correct state never
            # shows red. Not a PASS: inheritance and the entry list went unread. (This used to be NA
            # plus a caveat, which told the reader "not applicable" about the one check that most
            # applies in both modes, and let the run exit 0 having verified nothing here.)
            New-Check -Id 'vault-acl' -Name 'Company vault ACL (stored Tally passwords)' -Status 'UNKNOWN' `
                -Reason "The company vault exists, but this Windows account is denied permission even to read its permissions, so they could not be checked. That is what a correctly locked-down vault looks like from an account that is meant to be shut out - so this is not a fault - but it is not a verification either. Re-run this script as Administrator to confirm the vault's permissions are right." `
                -Evidence $ev | Out-Null
        }
        return
    }

    if ($null -eq $acl) {
        $ev = @("looked for: $vaultPath")
        if ($vaultNote) { $ev += $vaultNote }
        $ev += "the path does not exist (this is 'not found', not 'access denied' - the two are told apart here)"
        if ($vaultLocationUnknown) {
            # Not at the default - but .env, which is where a non-default location would be named,
            # could not be read. "No vault on this machine" would be a claim this run cannot back.
            New-Check -Id 'vault-acl' -Name 'Company vault ACL (stored Tally passwords)' -Status 'UNKNOWN' `
                -Reason "There is no company vault at the installer's default location, but this account cannot read .env, which is where a different location would be configured - so whether a vault exists elsewhere, and how it is protected, could not be checked. Re-run this script as Administrator, or as the account that installed Tally MCP." `
                -Evidence $ev | Out-Null
            return
        }
        New-Check -Id 'vault-acl' -Name 'Company vault ACL (stored Tally passwords)' -Status 'NA' `
            -Reason "There is no company vault on this machine, so no Tally passwords are stored and there is no ACL to get wrong." `
            -Evidence $ev | Out-Null
        return
    }

    # Compare by SID, never by display name: 'Administrators' is localized (Administratoren,
    # Administrateurs) and a renamed local group would walk straight past a name match.
    $allowedSids = @{ 'S-1-5-18' = 'NT AUTHORITY\SYSTEM'; 'S-1-5-32-544' = 'BUILTIN\Administrators' }
    $agentUser = Get-EnvValue 'AGENT_TASK_USER'
    $agentSid  = $null
    if ($agentUser) {
        try {
            $agentSid = (New-Object System.Security.Principal.NTAccount($agentUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
            $allowedSids[$agentSid] = "$agentUser (AGENT_TASK_USER)"
        } catch {
            # An AGENT_TASK_USER that no longer resolves (renamed account, dead domain trust) must
            # not become a silent pass for whoever else is on the ACL, so it stays out of the allow
            # set and the mismatch is reported below.
            $agentSid = $null
        }
    }

    # Principals that make the vault readable by every local account: $BroadSids, defined above check 6.

    $inheritText = 'ENABLED - the file inherits whatever the parent folder grants'
    if ($acl.AreAccessRulesProtected) { $inheritText = 'disabled (the ACL is protected, as it should be)' }
    $evidence = @("vault: $vaultPath")
    if ($vaultNote) { $evidence += $vaultNote }
    $evidence += "inheritance: $inheritText"
    try { $evidence += "owner: $($acl.Owner)" } catch { }

    $problems  = @()
    $offenders = @()
    $broadOffenders = @()
    if (-not $acl.AreAccessRulesProtected) {
        if ($inAgentDir) {
            # Every entry is still checked one by one below, inherited or not.
            $evidence += "the vault inherits from the agent folder $AgentDir (expected after a save from Manage Companies; that folder's own list is check 8)"
        } else {
            $problems += "inheritance is still enabled, so the vault carries whatever its parent folder ($(Split-Path -Parent $vaultPath)) grants rather than a deliberate list"
        }
    }

    foreach ($rule in $acl.Access) {
        # Only allow-ACEs widen access. A deny ACE narrows it, so an unexpected identity in a deny
        # entry is not a finding - list it as evidence and move on.
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            $evidence += "deny entry (not a finding): $($rule.IdentityReference) : $($rule.FileSystemRights)"
            continue
        }
        # Mark inherited vs explicit. Without it the evidence for an unprotected ACL reads
        # "expected: NT AUTHORITY\SYSTEM : FullControl" three times over and looks deliberate, when
        # in fact NONE of those entries were set on this file - they are whatever the parent folder
        # happens to grant today and will change silently the next time the parent's ACL changes.
        # That is exactly the state the live production vault is in (all three ACEs inherited).
        $origin = 'explicit'
        if ($rule.IsInherited) { $origin = 'INHERITED from the parent folder, not set on this file' }
        $sid = ''
        try { $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $sid = "$($rule.IdentityReference)" }
        if ($allowedSids.ContainsKey($sid)) {
            $evidence += "expected: $($allowedSids[$sid]) : $($rule.FileSystemRights) [$origin]"
            continue
        }
        $label = "$($rule.IdentityReference)"
        $isBroad = $BroadSids.ContainsKey($sid)
        if ($isBroad) { $label = "$($BroadSids[$sid]) - a group that in practice means every local account" }
        $offenders += "$label : $($rule.FileSystemRights)"
        if ($isBroad) { $broadOffenders += "$label : $($rule.FileSystemRights)" }
        $evidence += "UNEXPECTED: $label : $($rule.FileSystemRights) [$origin] (sid $sid)"
    }

    # An extra principal we cannot IDENTIFY is not the same finding as one we know is wrong, and
    # conflating them is how a security tool trains people to ignore it. AGENT_TASK_USER is written
    # to .env by the installer, so a run against a dev checkout - or before the first Reconfigure -
    # legitimately cannot name the third expected grant. That is an inconclusive result, not a
    # proven failure, and this script already has the right vehicle for it: a caveat, which says the
    # check could not fully see what it was asked to inspect.
    #
    # Why a caveated PASS and not UNKNOWN: this run DID read the whole ACL - inheritance, every entry
    # - and found nothing known to be wrong. What it lacks is a name for one entry. UNKNOWN is kept
    # for checks that could not look at the thing at all.
    #
    # A broad group is different. Everyone / Users / INTERACTIVE holding rights on the vault is
    # wrong no matter who the agent account turns out to be, so that stays a hard FAIL.
    $indeterminate = ($offenders.Count -gt 0) -and ($broadOffenders.Count -eq 0) -and (-not $agentSid)
    $caveat = ''

    if ($broadOffenders.Count -gt 0) {
        $problems += "a group that means every local account holds rights here: $($broadOffenders -join '; ')"
    } elseif ($indeterminate) {
        $caveat = if ($vaultLocationUnknown) {
            "This account cannot read $EnvFile, so the AGENT_TASK_USER it records is unknown and this run cannot confirm that '$($offenders -join '; ')' is the agent account the installer granted rather than an unexpected principal. Inheritance is blocked and no broad group is present, so nothing here is known to be wrong - but this is weaker than a clean pass. Re-run as Administrator."
        } elseif (-not $agentUser) {
            "AGENT_TASK_USER is not recorded in $EnvFile, so this run cannot confirm that '$($offenders -join '; ')' is the agent account the installer granted rather than an unexpected principal. Inheritance is blocked and no broad group is present, so nothing here is known to be wrong - but this is weaker than a clean pass. Re-run on the installed machine, or run the installer's Reconfigure to persist the key."
        } else {
            "AGENT_TASK_USER '$agentUser' from .env does not resolve to an account on this machine (a renamed account, or a domain that cannot be reached from here), so this run cannot tell whether '$($offenders -join '; ')' is that account or an unexpected principal."
        }
    } elseif ($offenders.Count -gt 0) {
        $problems += "unexpected allow entries: $($offenders -join '; ')"
    }

    if ($problems.Count -gt 0) {
        # The remedy must not revoke the agent account. Without it the tray and the GUI agent lose
        # access to the vault and company loading stops working, so an operator who pastes this
        # blindly would trade a permissions finding for a broken install.
        # By SID: 'Administrators' is localised, and on a non-English Windows the name form of this
        # command fails and changes nothing (#230) - the very failure that leaves a vault like this.
        $expectGrant = "*S-1-5-18:F *S-1-5-32-544:F"
        $grantNote = ''
        if ($agentSid) {
            $expectGrant = "$expectGrant *${agentSid}:F"
            $grantNote = " (the last SID is $agentUser)"
        } elseif ($agentUser) {
            $expectGrant = "$expectGrant '${agentUser}:F'"
        } else {
            $grantNote = " Add the agent account to that command as well ('<user>:F') - it is the account the tray and GUI agent run as, and omitting it will stop company loading working."
        }
        New-Check -Id 'vault-acl' -Name 'Company vault ACL (stored Tally passwords)' -Status 'FAIL' `
            -Reason "The stored Tally company passwords are not properly protected: $($problems -join '; '). This ACL is the ENTIRE boundary - the passwords are DPAPI-protected at LocalMachine scope, so any local account that can read this file can also decrypt it. Fix it from an elevated prompt with: icacls `"$vaultPath`" /inheritance:r /grant:r $expectGrant$grantNote" `
            -Evidence $evidence | Out-Null
    } elseif ($indeterminate) {
        New-Check -Id 'vault-acl' -Name 'Company vault ACL (stored Tally passwords)' -Status 'PASS' `
            -Reason "$(if ($acl.AreAccessRulesProtected) { 'Inheritance is disabled' } else { 'It inherits from the agent folder' }) and no broad group can reach the vault." `
            -Evidence $evidence -Caveat $caveat | Out-Null
    } else {
        $who = 'SYSTEM and Administrators'
        if ($agentSid) { $who = "SYSTEM, Administrators and $agentUser" }
        $locCaveat = ''
        if ($vaultLocationUnknown) {
            $locCaveat = "This is the vault at the installer's default location. This account cannot read .env, so if the install is configured to keep its vault somewhere else, that one was not checked. Re-run as Administrator to be sure."
        }
        New-Check -Id 'vault-acl' -Name 'Company vault ACL (stored Tally passwords)' -Status 'PASS' `
            -Reason "$(if ($acl.AreAccessRulesProtected) { 'Inheritance is disabled and only' } else { 'It inherits from the agent folder, and only' }) $who can reach the vault." `
            -Evidence $evidence -Caveat $locCaveat | Out-Null
    }
}

# ---------------------------------------------------------------------------
# 8. .env, the agent folder, and Tally's data folder (#230) - BOTH modes
#
# The installer restricts two things to SYSTEM, Administrators and AGENT_TASK_USER:
#   .env                          holds PASSWORD (remote) and TUNNEL_TOKEN (tunnel installs);
#   %ProgramData%\Claudally\agent the company vault and the GUI agent's IPC files: whoever can write
#                                 a command file there can type keystrokes - stored company
#                                 passwords included - into Tally. Also owned by Administrators:
#                                 %ProgramData% lets any user create folders, so an owner that is
#                                 not SYSTEM or Administrators means someone else made it.
# Installers before #230 named the groups ('Administrators:F'), which on a non-English Windows
# failed, changed nothing and left .env with its inherited ACL, readable by BUILTIN\Users under
# Program Files. Every comparison is by SID, never by display name, so a localised Windows is judged
# exactly like an English one. UNKNOWN when this account may not read the ACL (which is also what a
# correct lockdown looks like to an account outside it).
#
# And Tally's data folder, which is Tally's, not ours. Versions before #230's follow-up kept the vault
# and the IPC files there and locked the whole folder down, which shut every other Windows account on
# the PC out of the books. Any of our files still there is a FAIL (the upgrade moves them); inheritance
# still disabled is a WARN, with the command that restores it.
# ---------------------------------------------------------------------------
$AgentUserForAcl = ''
$AgentSidForAcl  = $null
if ($EnvReadable) { $AgentUserForAcl = Get-EnvValue 'AGENT_TASK_USER' }
if ($AgentUserForAcl) {
    try {
        $AgentSidForAcl = (New-Object System.Security.Principal.NTAccount($AgentUserForAcl)).Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        $AgentSidForAcl = $null
    }
}

function Invoke-LockdownAclCheck {
    param([string]$Id, [string]$Name, [string]$Path, [string]$What, [string]$Exposure, [switch]$Container, [switch]$CheckOwner)
    $sidType = [System.Security.Principal.SecurityIdentifier]
    $acl = $null
    $denied = $false
    try {
        $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    } catch [System.UnauthorizedAccessException] {
        $denied = $true
    } catch [System.Management.Automation.ItemNotFoundException] {
        $acl = $null
    }
    $evidence = @("${What}: $Path", "running as: $($Identity.Name) (elevated: $IsElevated)")

    if ($denied) {
        $evidence += 'reading its ACL from this account failed with Access Denied'
        if ($IsElevated) {
            New-Check -Id $Id -Name $Name -Status 'FAIL' `
                -Reason "Even this elevated run may not read the permissions of the $What, and the installer always grants Administrators Full Control - so something has rewritten them and its protection cannot be established. Run the installer's Reconfigure as Administrator." `
                -Evidence $evidence | Out-Null
        } else {
            New-Check -Id $Id -Name $Name -Status 'UNKNOWN' `
                -Reason "This Windows account may not read the permissions of the $What. That is what a correct lockdown looks like from an account outside it, so it is not a fault - but it is not a verification either. Re-run this script as Administrator." `
                -Evidence $evidence | Out-Null
        }
        return
    }
    if ($null -eq $acl) {
        New-Check -Id $Id -Name $Name -Status 'NA' `
            -Reason "There is no $What at $Path, so there are no permissions to check here." `
            -Evidence $evidence | Out-Null
        return
    }

    $allowed = @{ 'S-1-5-18' = 'NT AUTHORITY\SYSTEM'; 'S-1-5-32-544' = 'BUILTIN\Administrators' }
    if ($AgentSidForAcl) { $allowed[$AgentSidForAcl] = "$AgentUserForAcl (AGENT_TASK_USER)" }
    $problems = @()
    $unidentified = @()
    $explicitForeign = @()
    if ($acl.AreAccessRulesProtected) {
        $evidence += 'inheritance: disabled (the ACL is protected, as it should be)'
    } else {
        $evidence += 'inheritance: ENABLED'
        $problems += "it inherits whatever its parent folder grants instead of the installer's list - the state an installer before #230 left behind on a non-English Windows"
    }
    if ($CheckOwner) {
        $ownerSid = ''
        try { $ownerSid = $acl.GetOwner($sidType).Value } catch { $ownerSid = "$($acl.Owner)" }
        if (@('S-1-5-18', 'S-1-5-32-544') -contains $ownerSid) {
            $evidence += "owner: $($allowed[$ownerSid])"
        } else {
            $evidence += "owner: $($acl.Owner) (sid $ownerSid)"
            $problems += "it is owned by $($acl.Owner), not SYSTEM or Administrators - an owner can rewrite its permissions at will, and a folder in %ProgramData% owned by someone else may have been planted there"
        }
    }
    foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
        $sid = $rule.IdentityReference.Value
        $display = $sid
        try { $display = $rule.IdentityReference.Translate([System.Security.Principal.NTAccount]).Value } catch { $display = $sid }
        $origin = 'explicit'
        if ($rule.IsInherited) { $origin = 'inherited' }
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            $evidence += "deny entry (not a finding): $display : $($rule.FileSystemRights)"
            continue
        }
        if ($allowed.ContainsKey($sid)) {
            $evidence += "expected: $($allowed[$sid]) : $($rule.FileSystemRights) [$origin]"
            continue
        }
        if (-not $rule.IsInherited -and $explicitForeign -notcontains $sid) { $explicitForeign += $sid }
        if ($BroadSids.ContainsKey($sid)) {
            $evidence += "UNEXPECTED: $($BroadSids[$sid]) : $($rule.FileSystemRights) [$origin] (sid $sid)"
            $problems += "$($BroadSids[$sid]) - a group that in practice means every local account - holds $($rule.FileSystemRights)"
            continue
        }
        $evidence += "UNEXPECTED: $display : $($rule.FileSystemRights) [$origin] (sid $sid)"
        $unidentified += "$display : $($rule.FileSystemRights)"
    }
    # As for the vault: an extra principal is only a proven finding when the agent account is known.
    $caveat = ''
    if ($unidentified.Count -gt 0) {
        if ($AgentSidForAcl) {
            $problems += "unexpected allow entries: $($unidentified -join '; ')"
        } else {
            $caveat = "AGENT_TASK_USER is not known to this run (not recorded, not resolvable, or .env unreadable), so it cannot confirm that '$($unidentified -join '; ')' is the agent account the installer granted. Nothing here is known to be wrong, but this is weaker than a clean pass."
        }
    }

    if ($problems.Count -gt 0) {
        $flags = ''
        if ($Container) { $flags = '(OI)(CI)' }
        $agentGrant = " '<the agent account>:${flags}F'"
        if ($AgentSidForAcl) { $agentGrant = " *${AgentSidForAcl}:${flags}F" }
        elseif ($AgentUserForAcl) { $agentGrant = " '${AgentUserForAcl}:${flags}F'" }
        # /grant:r leaves explicit entries for anyone it does not name, so those need a /remove.
        $removeText = ''
        foreach ($s in $explicitForeign) { $removeText += ", then: icacls `"$Path`" /remove *$s" }
        New-Check -Id $Id -Name $Name -Status 'FAIL' `
            -Reason "The $What is not locked down: $($problems -join '; '). $Exposure Run the installer's Reconfigure as Administrator, or fix it from an elevated prompt with: icacls `"$Path`" /inheritance:r /grant:r *S-1-5-18:${flags}F *S-1-5-32-544:${flags}F$agentGrant$removeText (by SID, which works in every Windows language)." `
            -Evidence $evidence | Out-Null
    } else {
        $who = 'SYSTEM and Administrators'
        if ($AgentSidForAcl) { $who = "SYSTEM, Administrators and $AgentUserForAcl" }
        New-Check -Id $Id -Name $Name -Status 'PASS' `
            -Reason "Inheritance is disabled and only $who can reach the $What." `
            -Evidence $evidence -Caveat $caveat | Out-Null
    }
}

Invoke-Check -Id 'env-acl' -Name 'Configuration file ACL (.env)' -Body {
    Invoke-LockdownAclCheck -Id 'env-acl' -Name 'Configuration file ACL (.env)' -Path $EnvFile -What 'configuration file (.env)' `
        -Exposure 'It holds the OAuth password in remote mode and the tunnel token on a tunnel install, so any account that can read it has them.'
}

Invoke-Check -Id 'agent-dir-acl' -Name 'Agent folder ACL (vault + GUI agent IPC)' -Body {
    Invoke-LockdownAclCheck -Id 'agent-dir-acl' -Name 'Agent folder ACL (vault + GUI agent IPC)' -Path $AgentDir -What 'Claudally agent folder' -Container -CheckOwner `
        -Exposure "It holds the company vault and the GUI agent's command files: any account that can read it can decrypt the stored Tally passwords, and any that can write a command file there can send keystrokes into the Tally session. If it is owned by an account you do not recognise, delete the folder and run Reconfigure, which recreates it."
}

Invoke-Check -Id 'tally-data-folder' -Name "Tally's data folder left to Tally" -Body {
    $name = "Tally's data folder left to Tally"
    if ($EnvExists -and -not $EnvReadable) {
        New-Check -Id 'tally-data-folder' -Name $name -Status 'UNKNOWN' `
            -Reason "This account cannot read .env, so where this install's Tally data folder is (TALLY_DATA_PATH) is unknown and it could not be checked. Re-run this script as Administrator." `
            -Evidence @("config file: $EnvFile (unreadable from this account)") | Out-Null
        return
    }
    $dataPath = Get-EnvValue 'TALLY_DATA_PATH'
    if (-not $dataPath) { $dataPath = 'C:\Users\Public\TallyPrimeEditLog\data' }
    $evidence = @("Tally data folder: $dataPath")
    if (-not (Test-Path -LiteralPath $dataPath -PathType Container)) {
        New-Check -Id 'tally-data-folder' -Name $name -Status 'NA' `
            -Reason "There is no Tally data folder at $dataPath, so there is nothing of ours to find in it." `
            -Evidence $evidence | Out-Null
        return
    }

    # Our files that must have left it. Names only; nothing is opened.
    $leftovers = @()
    $denied = $false
    foreach ($n in $OurFilesInTallyFolder) {
        $p = Join-Path $dataPath $n
        try {
            $null = Get-Item -LiteralPath $p -Force -ErrorAction Stop
            $leftovers += $n
        } catch [System.UnauthorizedAccessException] {
            $denied = $true
        } catch [System.Management.Automation.ItemNotFoundException] {
            $null = $_
        }
    }
    foreach ($f in @(Get-ChildItem -LiteralPath $dataPath -Force -File -Filter '_mcp_gui_*' -ErrorAction SilentlyContinue)) {
        if ($leftovers -notcontains $f.Name) { $leftovers += $f.Name }
    }

    # Inheritance: earlier installers turned it off on the whole folder.
    $inheritanceOff = $false
    $aclDenied = $false
    try {
        $inheritanceOff = (Get-Acl -LiteralPath $dataPath -ErrorAction Stop).AreAccessRulesProtected
    } catch [System.UnauthorizedAccessException] {
        $aclDenied = $true
    }
    if ($aclDenied) { $evidence += 'its permissions could not be read from this account' }
    elseif ($inheritanceOff) { $evidence += 'inheritance: DISABLED - other Windows accounts may be shut out of the Tally companies in it' }
    else { $evidence += 'inheritance: enabled (as Tally set it up)' }

    if ($leftovers.Count -gt 0) {
        $evidence += "still there: $($leftovers -join ', ')"
        New-Check -Id 'tally-data-folder' -Name $name -Status 'FAIL' `
            -Reason "Files of ours are still in Tally's data folder: $($leftovers -join ', '). The company vault and a GUI agent command file can hold company passwords, and this folder is readable by the Windows accounts that use Tally. Run the installer's Reconfigure as Administrator: it moves the vault to $AgentDir (locked before the move, old copy shredded) and shreds the rest." `
            -Evidence $evidence | Out-Null
    } elseif ($inheritanceOff) {
        New-Check -Id 'tally-data-folder' -Name $name -Status 'WARN' `
            -Reason "Nothing of ours is left in Tally's data folder, but its permission inheritance is still disabled - which is what versions before #230's follow-up did to it, and it can shut other Windows accounts on this PC out of their Tally companies. Reconfigure restores it if it recognises its own change; otherwise, from an elevated prompt: icacls `"$dataPath`" /inheritance:e" `
            -Evidence $evidence | Out-Null
    } elseif ($denied -or $aclDenied) {
        New-Check -Id 'tally-data-folder' -Name $name -Status 'UNKNOWN' `
            -Reason "Not everything in Tally's data folder could be looked at from this account. Re-run this script as Administrator." `
            -Evidence $evidence | Out-Null
    } else {
        New-Check -Id 'tally-data-folder' -Name $name -Status 'PASS' `
            -Reason "None of our files are in Tally's data folder, and it inherits its permissions as Tally set it up." `
            -Evidence $evidence | Out-Null
    }
}

# ---------------------------------------------------------------------------
# 9. Tally reachability - INFORMATIONAL
#
# Deliberately not pass/fail. Tally being closed is a normal weekday-evening state, not a security
# defect, and a red line here would swamp the four claims this script exists to prove.
# ---------------------------------------------------------------------------
Invoke-Check -Id 'tally-reachable' -Name 'Tally XML server reachable (informational)' -Body {
    $tallyHost = Get-EnvValue 'TALLY_HOST'
    if (-not $tallyHost) { $tallyHost = '127.0.0.1' }
    $tallyPort = 9000
    $tallyPortText = Get-EnvValue 'TALLY_PORT'
    # TryParse writes 0 into the [ref] when it fails, so restore the default explicitly.
    if ($tallyPortText -and -not [int]::TryParse($tallyPortText, [ref]$tallyPort)) { $tallyPort = 9000 }

    $ok  = $false
    $err = ''
    $client = $null
    try {
        # Bounded async connect rather than Test-NetConnection: that cmdlet is absent on some
        # installs and can take many seconds on a filtered port, and this line is informational.
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($tallyHost, $tallyPort, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(2000, $false)) {
            $client.EndConnect($iar)   # throws on refused / reset
            $ok = $true
        } else {
            $err = 'timed out after 2s'
        }
    } catch {
        $err = $_.Exception.Message
    } finally {
        if ($client) { try { $client.Close() } catch { } }
    }

    if ($ok) {
        New-Check -Id 'tally-reachable' -Name 'Tally XML server reachable (informational)' -Status 'INFO' `
            -Reason "Something is accepting connections on ${tallyHost}:${tallyPort}, so Tally's XML server looks up." `
            -Evidence @(
                "TCP connect to ${tallyHost}:${tallyPort} succeeded",
                "a successful connect only proves a port is open; it does not prove the responder is Tally"
            ) | Out-Null
    } else {
        New-Check -Id 'tally-reachable' -Name 'Tally XML server reachable (informational)' -Status 'INFO' `
            -Reason "Nothing answered on ${tallyHost}:${tallyPort}. This is not a security finding: it usually just means Tally is closed, or its XML server is off (in Tally: F1 > Settings > Connectivity > Client/Server Configuration; TallyPrime acts as Server, Port 9000)." `
            -Evidence @("TCP connect to ${tallyHost}:${tallyPort} failed: $err") | Out-Null
    }
}

# ---------------------------------------------------------------------------
# Verdict and output
# ---------------------------------------------------------------------------
$passCount    = @($Checks | Where-Object { $_.status -eq 'PASS'    }).Count
$failCount    = @($Checks | Where-Object { $_.status -eq 'FAIL'    }).Count
$unknownCount = @($Checks | Where-Object { $_.status -eq 'UNKNOWN' }).Count
$naCount      = @($Checks | Where-Object { $_.status -eq 'NA'      }).Count
$infoCount    = @($Checks | Where-Object { $_.status -eq 'INFO'    }).Count
$warnCount    = @($Checks | Where-Object { $_.status -eq 'WARN'    }).Count
$warnNames    = @($Checks | Where-Object { $_.status -eq 'WARN' } | ForEach-Object { $_.name })
$caveated     = @($Checks | Where-Object { $_.caveat })
$unknownNames = @($Checks | Where-Object { $_.status -eq 'UNKNOWN' } | ForEach-Object { $_.name })

# FAIL outranks UNKNOWN: a run that found a real problem is a FAIL whatever else it could not see.
# UNKNOWN outranks PASS: a run that could not look at something has not verified the deployment.
$verdict = 'PASS'
if ($failCount -gt 0) { $verdict = 'FAIL' }
elseif ($unknownCount -gt 0) { $verdict = 'UNKNOWN' }

# Exit codes - see .NOTES. 3 is kept apart from 1 so a CI gate can tell "found a problem" from "could
# not look", and apart from 0 so nothing reads an unverified run as a verified one unless the caller
# opted in with -AllowUnknown.
$exitCode = 0
if ($verdict -eq 'FAIL') { $exitCode = 1 }
elseif ($verdict -eq 'UNKNOWN' -and -not $AllowUnknown) { $exitCode = 3 }

if ($Json) {
    $payload = New-Object psobject -Property ([ordered]@{
        schemaVersion  = 3
        tool           = 'scripts/verify-deployment.ps1'
        issue          = 172
        generatedAt    = (Get-Date).ToString('o')
        machine        = $env:COMPUTERNAME
        installDir     = $InstallDir
        deploymentMode = $Mode
        elevated       = $IsElevated
        runAs          = $Identity.Name
        verdict        = $verdict
        exitCode       = $exitCode
        allowUnknown   = [bool]$AllowUnknown
        counts         = (New-Object psobject -Property ([ordered]@{
            pass    = $passCount
            fail    = $failCount
            unknown = $unknownCount
            na      = $naCount
            info    = $infoCount
            warn    = $warnCount
        }))
        checks         = @($Checks)
    })
    # Depth 6: the deepest path is checks -> evidence -> string, but ConvertTo-Json's default of 2
    # would render the whole checks array as bare type names.
    $payload | ConvertTo-Json -Depth 6
    exit $exitCode
}

function Write-Wrapped {
    # Word-wrap continuation text under a fixed indent. The reasons here are full sentences aimed
    # at a non-technical reader; unwrapped they become one unreadable line in a default console.
    param([string]$Text, [string]$Indent = '       ')
    $width = 96
    $line = ''
    foreach ($w in ($Text -split '\s+')) {
        if (-not $w) { continue }
        if ($line.Length -eq 0) { $line = $w }
        # The "$line.Length -le 2" arm keeps a bullet glued to the token after it. Evidence lines
        # start "- <full path>", and paths here routinely exceed the wrap width on their own, so a
        # pure width test emitted a line containing nothing but "-" and dropped the path to the next
        # line. Never wrap immediately after the bullet.
        elseif ($line.Length -le 2 -or ($line.Length + 1 + $w.Length) -le $width) { $line = "$line $w" }
        else { Write-Host "$Indent$line"; $line = $w }
    }
    if ($line.Length -gt 0) { Write-Host "$Indent$line" }
}

$elevatedText = 'no'
if ($IsElevated) { $elevatedText = 'yes' }
$modeText = 'undetermined'
if ($Mode) { $modeText = $Mode }

Write-Host ""
Write-Host "=== Tally MCP deployment verification ===" -ForegroundColor Cyan
Write-Host "Install dir : $InstallDir"
Write-Host "Mode        : $modeText"
Write-Host "Running as  : $($Identity.Name) (elevated: $elevatedText)"
Write-Host "Checked at  : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host ""

foreach ($c in $Checks) {
    $colour = 'Gray'
    if ($c.status -eq 'PASS')     { $colour = 'Green' }
    elseif ($c.status -eq 'FAIL') { $colour = 'Red' }
    elseif ($c.status -eq 'UNKNOWN') { $colour = 'Yellow' }
    elseif ($c.status -eq 'NA')   { $colour = 'DarkGray' }
    elseif ($c.status -eq 'INFO') { $colour = 'Cyan' }
    elseif ($c.status -eq 'WARN') { $colour = 'Yellow' }
    # PadRight(7) = len('UNKNOWN'), so the check names still line up in one column.
    Write-Host ("[" + $c.status.PadRight(7) + "] " + $c.name) -ForegroundColor $colour
    if ($c.reason) { Write-Wrapped -Text $c.reason }
    if ($c.evidence) {
        foreach ($e in $c.evidence) { Write-Wrapped -Text "- $e" -Indent '         ' }
    }
    if ($c.caveat) { Write-Wrapped -Text "! $($c.caveat)" -Indent '         ' }
    Write-Host ""
}

# "not applicable" is not always about the mode: the vault check reports NA when there is no vault at
# all. Appending "to <mode> mode" unconditionally mislabelled that, so name the mode only in the
# sentence's own clause below.
$summary = "$passCount passed, $failCount failed, $unknownCount unknown, $warnCount warning(s), $naCount not applicable"
$elevateHint = ''
if (-not $IsElevated) {
    $elevateHint = " This run is not elevated, which is the usual cause: re-run this script as Administrator and those checks will get an actual answer."
}
if ($verdict -eq 'PASS') {
    Write-Host "VERDICT: PASS - $summary (mode: $modeText)." -ForegroundColor Green
    if ($IsLocal -and $caveated.Count -eq 0) {
        Write-Wrapped -Indent '' -Text "The security claims this install makes for local mode hold on this machine right now: nothing of ours is listening, no service is registered, no OAuth password or token store exists, and no tunnel is running."
    } elseif ($IsLocal) {
        # Do not read that flat claim out over caveated results. A caveat means a check could not
        # fully see what it was asked to look at (no Tally MCP process was running, or the run
        # lacked the privilege to inspect something); asserting the claims "hold" on top of that is
        # the exact over-statement the caveat mechanism exists to prevent.
        Write-Wrapped -Indent '' -Text "Nothing was found wrong with this local-mode install. Read the '!' lines above before treating that as proof: those checks could not fully see what they were asked to inspect, so they did not confirm the claim so much as fail to contradict it."
    }
} elseif ($verdict -eq 'UNKNOWN') {
    # Neither green nor red, and never phrased as either. Name the checks, so a reader who only
    # looks at the last lines still learns which properties went unverified.
    Write-Host "VERDICT: UNKNOWN - $summary (mode: $modeText)." -ForegroundColor Yellow
    Write-Wrapped -Indent '' -Text "Nothing was found wrong, but this is NOT a pass: $unknownCount check(s) could not look at what they were asked to verify ($($unknownNames -join '; ')). Each UNKNOWN above says why and what would settle it.$elevateHint"
    if ($AllowUnknown) {
        Write-Wrapped -Indent '' -Text "Exiting 0 because -AllowUnknown was passed; without it this result exits 3."
    }
} else {
    Write-Host "VERDICT: FAIL - $summary." -ForegroundColor Red
    Write-Wrapped -Indent '' -Text "Each FAIL above says what to do about it. Re-run with -Json and send the output to support if you would like help."
    if ($unknownCount -gt 0) {
        Write-Wrapped -Indent '' -Text "In addition, $unknownCount check(s) could not look at what they were asked to verify ($($unknownNames -join '; ')), so they are UNKNOWN rather than passed.$elevateHint"
    }
}
if ($warnCount -gt 0) {
    Write-Host ""
    Write-Wrapped -Indent '' -Text "$warnCount warning(s) ($($warnNames -join '; ')): nothing there weakens this install's own security, so they do not change the verdict or the exit code - but each WARN above is worth fixing and says how."
}
if ($caveated.Count -gt 0) {
    Write-Host ""
    Write-Host "$($caveated.Count) check(s) carry a caveat (the lines starting '!') - those results are weaker than a clean pass." -ForegroundColor Yellow
}
Write-Host ""

exit $exitCode
