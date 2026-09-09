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

    Checks, in order:
      1. Deployment mode      - which mode is configured, and is the value valid
      2. No listening socket  - owned by OUR processes; attributed by PID, never by port number
      3. No NSSM service      - the service AND its SCM registry key are gone
      4. No OAuth artefacts   - .oauth-clients.json / .oauth-tokens.json / PASSWORD in .env
      5. No outbound tunnel   - cloudflared process, tunnel service, or a token that revives it
      6. Company vault ACL    - the entire boundary for stored Tally passwords; BOTH modes
      7. Tally reachability   - INFORMATIONAL only; never affects the verdict

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

.EXAMPLE
    .\scripts\verify-deployment.ps1
    Human-readable report plus a final verdict.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File "C:\Program Files\TallyMCP\scripts\verify-deployment.ps1" -Json > verify.json
    Machine-readable output for a support ticket.

.NOTES
    Exit codes (so this can gate CI later):
      0  no check FAILed
      1  at least one check FAILed
      2  could not run at all (InstallDir missing)

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
    [switch]$Json
)

# Continue, not Stop: a verification tool that aborts on the first surprise reports nothing about
# the other six checks. Each check owns its own try/catch and turns an unexpected error into a FAIL
# for that check alone (fail closed - see Invoke-Check).
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
            schemaVersion = 1
            tool          = 'scripts/verify-deployment.ps1'
            issue         = 172
            generatedAt   = (Get-Date).ToString('o')
            machine       = $env:COMPUTERNAME
            installDir    = $InstallDir
            verdict       = 'ERROR'
            error         = "InstallDir does not exist. Pass -InstallDir <path to the Tally MCP install>."
            checks        = @()
        })) | ConvertTo-Json -Depth 4
    } else {
        Write-Host "ERROR: InstallDir '$InstallDir' does not exist. Pass -InstallDir <path to the Tally MCP install>." -ForegroundColor Red
    }
    exit 2
}
$EnvFile = Join-Path $InstallDir '.env'

# ---------------------------------------------------------------------------
# Can we actually READ .env? Existence is not the question - readability is.
#
# The installer locks .env down itself: `icacls <.env> /inheritance:r /grant:r 'SYSTEM:F'
# 'Administrators:F' "<AgentTaskUser>:F"` (firstrun-config.ps1:397). So for any Windows account that
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
try {
    $null = Get-Item -LiteralPath $EnvFile -Force -ErrorAction Stop
    $EnvExists = $true
} catch [System.UnauthorizedAccessException] {
    # Denied on the directory itself: the file's existence cannot be settled, but "denied" is the
    # honest answer either way and must not be reported as "missing".
    $EnvExists    = $true
    $EnvReadError = 'access denied'
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
# Check result plumbing. Status is one of PASS / FAIL / NA / INFO.
#   NA     the property is not claimed in this mode. Carries a Reason. Never a failure.
#   INFO   an observation, never a verdict input (Tally reachability).
#   Caveat "this PASS is weaker than it looks" - printed indented under the check and surfaced in
#          the final verdict, because a security control that silently passes when it could not
#          actually see anything is worse than no control at all.
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
try {
    # Escape wildcard metacharacters before using the path as a -like pattern; an install dir
    # containing '[' would otherwise silently match nothing and hand back a false PASS.
    $likePattern = '*' + [System.Management.Automation.WildcardPattern]::Escape($InstallDir) + '*'
    $selfPattern = '*' + [System.Management.Automation.WildcardPattern]::Escape($SelfScriptName) + '*'
    foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
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
    # Leave both sets empty; the socket check reports the shortfall through its own caveat.
    $UnreadableCandidates = @()
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
# ---------------------------------------------------------------------------
function Get-ListeningEndpoint {
    $result = New-Object System.Collections.ArrayList
    $source = ''
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $source = 'Get-NetTCPConnection'
        foreach ($c in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
            [void]$result.Add((New-Object psobject -Property ([ordered]@{
                Local     = "$($c.LocalAddress):$($c.LocalPort)"
                OwningPid = [int]$c.OwningProcess
            })))
        }
    }
    if ($result.Count -eq 0) {
        $source = 'netstat -ano'
        $lines = @()
        try { $lines = @(& netstat.exe -ano 2>$null) } catch { $lines = @() }
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
    return (New-Object psobject -Property ([ordered]@{ Source = $source; Endpoints = @($result) }))
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
        New-Check -Id 'deployment-mode' -Name 'Deployment mode' -Status 'FAIL' `
            -Reason "The configuration file exists but this Windows account cannot read it, so nothing below could be judged against the real deployment mode. The installer locks .env to SYSTEM, Administrators and the agent user only - so this normally just means the script is being run by a different Windows account than the one that installed Tally MCP. Re-run it as Administrator, or as the account that installed the product." `
            -Evidence @(
                "config file: $EnvFile",
                "opening it failed: $EnvReadError",
                "running as: $($Identity.Name) (elevated: $IsElevated)",
                "no value was read from this file, so this run reports no mode at all rather than guessing one"
            ) | Out-Null
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
# fine as remote. NA with the real reason instead; check 1 already carries the FAIL and the exit code.
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
    } elseif ($ambiguous.Count -gt 0) {
        # NOT a detection - say so in the first clause. This branch fires because the run lacked the
        # privilege to read a command line, and the named process is very often unrelated software
        # (any Node app under another Windows account looks exactly like this). It stays a FAIL
        # because "we could not look" must not be reported as "we looked and it was clean", but a
        # reason worded as an accusation would send customers hunting a listener they do not have.
        New-Check -Id 'no-listening-socket' -Name 'No listening socket owned by Tally MCP' -Status 'FAIL' `
            -Reason "UNVERIFIED, not a detection. $($ambiguous -join ', ') is listening, and this run does not have permission to read that process's command line - so it can be neither confirmed nor ruled out as Tally MCP. It is most likely unrelated software running under another Windows account. Re-run this script as Administrator and it will attribute the process one way or the other." `
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

    $problems = @()
    if ($tunnelSvc)           { $problems += "the '$TunnelServiceName' service exists (status $($tunnelSvc.Status))" }
    elseif ($tunnelReg)       { $problems += "the '$TunnelServiceName' service registry key survives, so its removal is only pending" }
    if ($cfProcs.Count -gt 0) { $problems += "cloudflared.exe is running" }
    if ($tokenSet)            { $problems += "TUNNEL_TOKEN is still set in .env, so the next Reconfigure would bring the tunnel back" }

    if ($problems.Count -gt 0) {
        New-Check -Id 'no-tunnel' -Name 'No outbound tunnel' -Status 'FAIL' `
            -Reason "A tunnel to a third party is configured or running: $($problems -join '; '). Local mode puts nobody in the data path. Clear the tunnel token via the installer's Reconfigure shortcut, which also tears the service down." `
            -Evidence $evidence | Out-Null
    } else {
        New-Check -Id 'no-tunnel' -Name 'No outbound tunnel' -Status 'PASS' `
            -Reason "No cloudflared process, no tunnel service, and no tunnel token that could start one." `
            -Evidence $evidence | Out-Null
    }
}

# ---------------------------------------------------------------------------
# 6. Company vault ACL
#
# THE MOST IMPORTANT FAIL THIS SCRIPT CAN REPORT, and it applies in BOTH modes. The vault
# (<TALLY_DATA_PATH>\.tally-mcp-companies.json) holds DPAPI-protected Tally company passwords, and
# the DPAPI scope is LocalMachine (scripts\dpapi-helper.ps1:32) - so any local principal that can
# READ the file can also DECRYPT it. The entropy value is a public literal in this repo and is
# world-readable in Program Files (scripts\migrate-vault-entropy.ps1 says as much in its own
# summary). The NTFS ACL is therefore not defence in depth here; it is the entire boundary.
#
# Expected state: inheritance disabled, and allow-ACEs for exactly SYSTEM, BUILTIN\Administrators
# and AGENT_TASK_USER - what firstrun-config.ps1 sets with
#   icacls <file> /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' "${AgentTaskUser}:F"
# ---------------------------------------------------------------------------
Invoke-Check -Id 'vault-acl' -Name 'Company vault ACL (stored Tally passwords)' -Body {
    $vaultPath = Get-EnvValue 'TALLY_COMPANIES_CONFIG'
    $vaultNote = ''
    if ($vaultPath) {
        $vaultNote = 'vault path overridden by TALLY_COMPANIES_CONFIG in .env'
    } else {
        $dataPath = Get-EnvValue 'TALLY_DATA_PATH'
        if (-not $dataPath) {
            $dataPath  = 'C:\Users\Public\TallyPrimeEditLog\data'
            $vaultNote = "TALLY_DATA_PATH is not set in .env, so this used the installer default $dataPath"
        }
        # Same default as src\mcp.mts:5186 and the tray (scripts\tray\tally-mcp-tray.ps1:270).
        $vaultPath = Join-Path $dataPath '.tally-mcp-companies.json'
    }

    # Is the default installer data path in play? Only then may the FAIL text talk about what
    # C:\Users\Public grants - see the inheritance problem below, which used to assert that
    # parenthetical about every vault regardless of where the vault actually lived.
    $DefaultDataPath = 'C:\Users\Public\TallyPrimeEditLog\data'
    $onDefaultPath = ($vaultPath -like ($DefaultDataPath + '\*'))

    # ONE probe, and it must tell "not there" apart from "there, but you may not look".
    #
    # Test-Path answers $false for BOTH, and on the way it writes a raw PermissionDenied record to
    # the error stream that lands in the middle of a report aimed at a non-technical reader. Taking
    # that $false as "absent" was the worst bug this check could carry: a vault locked down exactly
    # as intended is INVISIBLE to every account that is not SYSTEM, an Administrator or
    # AGENT_TASK_USER - the installer also strips inheritance on the whole data directory
    # (firstrun-config.ps1:452), so such an account cannot even list the parent - and the check
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
            # BUILTIN\Administrators Full Control (firstrun-config.ps1:428), so this ACL is wrong in
            # a way this run cannot even describe. Fail closed.
            New-Check -Id 'vault-acl' -Name 'Company vault ACL (stored Tally passwords)' -Status 'FAIL' `
                -Reason "The company vault exists but even this elevated run is denied permission to read its ACL. The installer always grants Administrators Full Control, so something has rewritten this file's permissions and the protection of the stored Tally passwords cannot be established at all. Take ownership and reset it: takeown /f `"$vaultPath`" then icacls `"$vaultPath`" /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F'" `
                -Evidence $ev | Out-Null
        } else {
            # NOT a FAIL. This is what a correctly locked-down vault looks like from an account that
            # is supposed to be shut out, and #172's rule is that a correct state never shows red.
            # It is not a PASS either - inheritance and the entry list went unread - so it carries a
            # caveat, which the verdict footer counts.
            New-Check -Id 'vault-acl' -Name 'Company vault ACL (stored Tally passwords)' -Status 'NA' `
                -Reason "The company vault exists, but this Windows account is denied permission even to read its permissions. That is what a correctly locked-down vault looks like from an account that is meant to be shut out - so this is not a fault. It does mean nothing here was actually verified." `
                -Evidence $ev `
                -Caveat "This check verified nothing. To confirm the vault's permissions are right, re-run this script as Administrator." | Out-Null
        }
        return
    }

    if ($null -eq $acl) {
        $ev = @("looked for: $vaultPath")
        if ($vaultNote) { $ev += $vaultNote }
        $ev += "the path does not exist (this is 'not found', not 'access denied' - the two are told apart here)"
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

    # Principals that make this vault effectively readable by every local account. Named, so the
    # FAIL message can say WHICH mistake was made instead of dumping a raw SID at a non-technical
    # reader.
    $broadSids = @{
        'S-1-1-0'      = 'Everyone'
        'S-1-5-32-545' = 'BUILTIN\Users'
        'S-1-5-11'     = 'Authenticated Users'
        'S-1-5-4'      = 'INTERACTIVE'
        'S-1-5-32-546' = 'BUILTIN\Guests'
        'S-1-5-7'      = 'ANONYMOUS LOGON'
        'S-1-5-32-547' = 'BUILTIN\Power Users'
    }

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
        # Only name C:\Users\Public when the vault is actually under it. The parenthetical used to
        # be unconditional, so a vault on a custom TALLY_DATA_PATH was failed with a sentence about
        # a folder that had nothing to do with it - evidence a customer can disprove in one command,
        # after which they stop believing the rest of the report.
        $inheritProblem = "inheritance is still enabled, so the vault carries whatever its parent folder ($(Split-Path -Parent $vaultPath)) grants rather than a deliberate list"
        if ($onDefaultPath) {
            $inheritProblem = "$inheritProblem - and on the installer's default data path under C:\Users\Public that means BUILTIN\Users can write"
        }
        $problems += $inheritProblem
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
        $isBroad = $broadSids.ContainsKey($sid)
        if ($isBroad) { $label = "$($broadSids[$sid]) - a group that in practice means every local account" }
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
    # A broad group is different. Everyone / Users / INTERACTIVE holding rights on the vault is
    # wrong no matter who the agent account turns out to be, so that stays a hard FAIL.
    $indeterminate = ($offenders.Count -gt 0) -and ($broadOffenders.Count -eq 0) -and (-not $agentSid)
    $caveat = ''

    if ($broadOffenders.Count -gt 0) {
        $problems += "a group that means every local account holds rights here: $($broadOffenders -join '; ')"
    } elseif ($indeterminate) {
        $caveat = if (-not $agentUser) {
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
        $expectGrant = "'SYSTEM:F' 'Administrators:F'"
        $grantNote = ''
        if ($agentUser) {
            $expectGrant = "$expectGrant '${agentUser}:F'"
        } else {
            $grantNote = " Add the agent account to that command as well ('<user>:F') - it is the account the tray and GUI agent run as, and omitting it will stop company loading working."
        }
        New-Check -Id 'vault-acl' -Name 'Company vault ACL (stored Tally passwords)' -Status 'FAIL' `
            -Reason "The stored Tally company passwords are not properly protected: $($problems -join '; '). This ACL is the ENTIRE boundary - the passwords are DPAPI-protected at LocalMachine scope, so any local account that can read this file can also decrypt it. Fix it from an elevated prompt with: icacls `"$vaultPath`" /inheritance:r /grant:r $expectGrant$grantNote" `
            -Evidence $evidence | Out-Null
    } elseif ($indeterminate) {
        New-Check -Id 'vault-acl' -Name 'Company vault ACL (stored Tally passwords)' -Status 'PASS' `
            -Reason "Inheritance is disabled and no broad group can reach the vault." `
            -Evidence $evidence -Caveat $caveat | Out-Null
    } else {
        $who = 'SYSTEM and Administrators'
        if ($agentSid) { $who = "SYSTEM, Administrators and $agentUser" }
        New-Check -Id 'vault-acl' -Name 'Company vault ACL (stored Tally passwords)' -Status 'PASS' `
            -Reason "Inheritance is disabled and only $who can reach the vault." `
            -Evidence $evidence | Out-Null
    }
}

# ---------------------------------------------------------------------------
# 7. Tally reachability - INFORMATIONAL
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
$passCount = @($Checks | Where-Object { $_.status -eq 'PASS' }).Count
$failCount = @($Checks | Where-Object { $_.status -eq 'FAIL' }).Count
$naCount   = @($Checks | Where-Object { $_.status -eq 'NA'   }).Count
$infoCount = @($Checks | Where-Object { $_.status -eq 'INFO' }).Count
$caveated  = @($Checks | Where-Object { $_.caveat })
$verdict = 'PASS'
if ($failCount -gt 0) { $verdict = 'FAIL' }

if ($Json) {
    $payload = New-Object psobject -Property ([ordered]@{
        schemaVersion  = 1
        tool           = 'scripts/verify-deployment.ps1'
        issue          = 172
        generatedAt    = (Get-Date).ToString('o')
        machine        = $env:COMPUTERNAME
        installDir     = $InstallDir
        deploymentMode = $Mode
        elevated       = $IsElevated
        runAs          = $Identity.Name
        verdict        = $verdict
        counts         = (New-Object psobject -Property ([ordered]@{
            pass = $passCount
            fail = $failCount
            na   = $naCount
            info = $infoCount
        }))
        checks         = @($Checks)
    })
    # Depth 6: the deepest path is checks -> evidence -> string, but ConvertTo-Json's default of 2
    # would render the whole checks array as bare type names.
    $payload | ConvertTo-Json -Depth 6
    if ($failCount -gt 0) { exit 1 }
    exit 0
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
    elseif ($c.status -eq 'NA')   { $colour = 'DarkGray' }
    elseif ($c.status -eq 'INFO') { $colour = 'Cyan' }
    Write-Host ("[" + $c.status.PadRight(4) + "] " + $c.name) -ForegroundColor $colour
    if ($c.reason) { Write-Wrapped -Text $c.reason }
    if ($c.evidence) {
        foreach ($e in $c.evidence) { Write-Wrapped -Text "- $e" -Indent '         ' }
    }
    if ($c.caveat) { Write-Wrapped -Text "! $($c.caveat)" -Indent '         ' }
    Write-Host ""
}

# "not applicable" is not always about the mode: the vault check reports NA when there is no vault at
# all, and when an unprivileged account is denied the ACL. Appending "to <mode> mode" unconditionally
# mislabelled those, so name the mode only in the sentence's own clause below.
$summary = "$passCount passed, $failCount failed, $naCount not applicable"
if ($verdict -eq 'PASS') {
    Write-Host "VERDICT: PASS - $summary (mode: $modeText)." -ForegroundColor Green
    if ($IsLocal -and $caveated.Count -eq 0) {
        Write-Wrapped -Indent '' -Text "The security claims this install makes for local mode hold on this machine right now: nothing of ours is listening, no service is registered, no OAuth password or token store exists, and no tunnel is running."
    } elseif ($IsLocal) {
        # Do not read that flat claim out over caveated results. A caveat means a check could not
        # actually see what it was asked to look at (no Tally MCP process was running, or the run
        # lacked the privilege to inspect something); asserting the claims "hold" on top of that is
        # the exact over-statement the caveat mechanism exists to prevent.
        Write-Wrapped -Indent '' -Text "Nothing was found wrong with this local-mode install. Read the '!' lines above before treating that as proof: those checks could not fully see what they were asked to inspect, so they did not confirm the claim so much as fail to contradict it."
    }
} else {
    Write-Host "VERDICT: FAIL - $summary." -ForegroundColor Red
    Write-Wrapped -Indent '' -Text "Each FAIL above says what to do about it. Re-run with -Json and send the output to support if you would like help."
}
if ($caveated.Count -gt 0) {
    Write-Host ""
    Write-Host "$($caveated.Count) check(s) carry a caveat (the lines starting '!') - those results are weaker than a clean pass." -ForegroundColor Yellow
}
Write-Host ""

if ($failCount -gt 0) { exit 1 }
exit 0
