<#
.SYNOPSIS
    Tests firstrun-config.ps1 - above all its unattended upgrade mode (#177) - against a fake
    install root, with every service, task and ACL call replaced by a recording stand-in.

.DESCRIPTION
    The daily update task will run the installer silently, as SYSTEM, over a working install.
    What that must never do is change the install's settings. This harness proves it for the part
    that decides - firstrun-config.ps1 - without a VM, an installer build or administrator rights,
    and without registering or changing anything on the machine that runs it.

    How the stand-ins work: firstrun-config.ps1 runs in THIS PowerShell session via the call
    operator, so the commands it names are looked up through this script's scope first, and
    PowerShell prefers a function over a cmdlet or an .exe of the same name. Every privileged
    command it uses (Get-Service, Get/Register/Unregister/Start-ScheduledTask, icacls, schtasks,
    ...) is defined below as a function that records the call instead. nssm is invoked by path, so
    each fake install root gets a tiny compiled nssm.exe that only appends its arguments to a log.

    Before any test runs, the harness checks that every stand-in actually resolves to its function.
    If one did not, the real command would run - so it stops instead.

    What this cannot cover (the Inno Setup side, SYSTEM, a real upgrade over a real install) is in
    docs/installer-manual-test.md, section 9.

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\installer\test-firstrun-config.ps1
    Runs every case under Windows PowerShell 5.1, the way CI does. Exits 1 if any case fails.

.NOTES
    Windows PowerShell 5.1 compatible; ASCII only.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Target = Join-Path $PSScriptRoot 'firstrun-config.ps1'
if (-not (Test-Path -LiteralPath $Target)) { throw "Not found: $Target" }

# Names deliberately unlike the real ones, so even a stand-in that failed to bind could not touch
# a real TallyMCP registration.
$AgentTask  = 'FrcTestAgent'
$TrayTask   = 'FrcTestTray'
$Service    = 'FrcTestService'
$Tunnel     = 'FrcTestTunnel'
$Accountant = 'tally-test-accountant'     # the person who uses Tally; NOT the account running this

$work = Join-Path ([System.IO.Path]::GetTempPath()) ('frc-test-' + [guid]::NewGuid().ToString('n').Substring(0, 12))
New-Item -ItemType Directory -Force -Path $work | Out-Null

# --- A fake nssm.exe that records its arguments ------------------------------------------------
# Compiled with CodeDom rather than Add-Type -OutputAssembly, which also LOADS the result into this
# process - locking the file so the temp folder cannot be deleted afterwards.
$fakeNssm = Join-Path $work 'nssm.exe'
$compilerParams = New-Object System.CodeDom.Compiler.CompilerParameters
$compilerParams.GenerateExecutable = $true
$compilerParams.GenerateInMemory = $false
$compilerParams.OutputAssembly = $fakeNssm
$compiled = (New-Object Microsoft.CSharp.CSharpCodeProvider).CompileAssemblyFromSource($compilerParams, @'
using System;
using System.IO;
public static class FakeNssm {
    public static int Main(string[] args) {
        string log = Environment.GetEnvironmentVariable("FRC_NSSM_LOG");
        if (!String.IsNullOrEmpty(log)) { File.AppendAllText(log, String.Join(" | ", args) + Environment.NewLine); }
        return 0;
    }
}
'@)
if ($compiled.Errors.HasErrors) { throw "Could not compile the fake nssm.exe: $(@($compiled.Errors) -join '; ')" }

# --- Recording stand-ins -----------------------------------------------------------------------
# Load the real modules FIRST. Module autoloading, triggered later by the first real cmdlet
# firstrun-config.ps1 calls (New-ScheduledTaskAction), imports the module's functions over any
# same-named function already defined here - silently replacing the stand-ins with the real thing
# for every test after the first. Imported up front, they are shadowed by the definitions below.
Import-Module ScheduledTasks, Microsoft.PowerShell.Management, Microsoft.PowerShell.Utility, Microsoft.PowerShell.Security

# --- The services registry, redirected ------------------------------------------------------------
# firstrun-config.ps1 scrubs TUNNEL_TOKEN out of HKLM:\SYSTEM\CurrentControlSet\Services\<svc>\Parameters
# (#193). For this session the HKLM: drive is re-rooted at a scratch HKCU key, so that code runs
# unchanged against a registry the test controls and can never touch the real machine hive. (Only
# the drive is redirected; the Registry:: provider path to the real hive is untouched, and
# firstrun-config.ps1 does not use it.) Assert-StandIns checks the redirect before every run.
$ScratchRegName = 'FrcTest-' + [guid]::NewGuid().ToString('n').Substring(0, 8)
$ScratchReg     = "HKCU:\Software\$ScratchRegName"
New-Item -Path $ScratchReg -Force | Out-Null
Remove-PSDrive -Name HKLM
New-PSDrive -Name HKLM -PSProvider Registry -Root "HKEY_CURRENT_USER\Software\$ScratchRegName" -Scope Global | Out-Null

# State is global because these functions run inside firstrun-config.ps1's scope, where $script:
# would mean that script, not this one.
$global:FrcCalls    = New-Object System.Collections.ArrayList
$global:FrcTasks    = @{}
$global:FrcServices = @{}

function _FrcRecord([string]$Cmd, [string]$Target, [string]$User, [string]$Detail) {
    [void]$global:FrcCalls.Add([pscustomobject]@{ Cmd = $Cmd; Target = $Target; User = $User; Detail = $Detail })
}

# A service exists if it was set up as existing and the fake nssm log does not say it was removed
# since, or if that log says it was installed.
function _FrcServiceExists([string]$Name) {
    $present = $global:FrcServices.ContainsKey($Name)
    if ($env:FRC_NSSM_LOG -and (Test-Path -LiteralPath $env:FRC_NSSM_LOG)) {
        foreach ($line in (Get-Content -LiteralPath $env:FRC_NSSM_LOG)) {
            $parts = $line -split ' \| '
            if ($parts.Count -ge 2 -and $parts[1] -eq $Name) {
                if ($parts[0] -eq 'install') { $present = $true }
                if ($parts[0] -eq 'remove')  { $present = $false }
            }
        }
    }
    return $present
}

function Get-Service {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$Name)
    if (_FrcServiceExists $Name) {
        $status = 'Stopped'
        if ($global:FrcServices.ContainsKey($Name)) { $status = $global:FrcServices[$Name] }
        return [pscustomobject]@{ Name = $Name; Status = $status }
    }
    Write-Error "Cannot find any service with service name '$Name'."
}

function Get-ScheduledTask {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$TaskName)
    _FrcRecord 'Get-ScheduledTask' $TaskName '' ''
    if ($global:FrcTasks.ContainsKey($TaskName)) { return $global:FrcTasks[$TaskName] }
    Write-Error "No MSFT_ScheduledTask objects found with property 'TaskName' equal to '$TaskName'."
}

function Register-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, $InputObject, $Action, $Principal, $Settings, $Trigger, [switch]$Force, $Description)
    $p = $Principal; $a = $Action
    if ($InputObject) { $p = $InputObject.Principal; $a = $InputObject.Actions }
    $argText = (@($a) | ForEach-Object { "$($_.Arguments)" }) -join ' '
    _FrcRecord 'Register-ScheduledTask' $TaskName "$($p.UserId)" $argText
    $global:FrcTasks[$TaskName] = [pscustomobject]@{
        TaskName  = $TaskName
        Principal = [pscustomobject]@{ UserId = "$($p.UserId)" }
        Actions   = @([pscustomobject]@{ Arguments = $argText })
    }
}

function Unregister-ScheduledTask {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([string]$TaskName)
    _FrcRecord 'Unregister-ScheduledTask' $TaskName '' ''
    $global:FrcTasks.Remove($TaskName)
}

function Start-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName)
    _FrcRecord 'Start-ScheduledTask' $TaskName '' ''
}

function Get-ScheduledTaskInfo {
    [CmdletBinding()]
    param([string]$TaskName)
    return [pscustomobject]@{ TaskName = $TaskName; LastTaskResult = 0 }
}

# The real one resolves the principal's account to a SID, and the test accountant does not exist.
# It registers nothing, so standing in for it loses no coverage of what gets registered.
function New-ScheduledTask {
    [CmdletBinding()]
    param($Action, $Trigger, $Principal, $Settings, [string]$Description)
    return [pscustomobject]@{ Actions = @($Action); Triggers = @($Trigger); Principal = $Principal; Settings = $Settings; Description = $Description }
}

function icacls {
    $target = ''
    if ($args.Count -gt 0) { $target = "$($args[0])" }
    _FrcRecord 'icacls' $target '' (($args | Select-Object -Skip 1) -join ' ')
    $global:LASTEXITCODE = 0
}

function schtasks {
    _FrcRecord 'schtasks' '' '' ($args -join ' ')
    $global:LASTEXITCODE = 0
}

function Start-Sleep {
    [CmdletBinding()]
    param([int]$Seconds, [int]$Milliseconds)
}

# The token-file lockdown (#193) runs icacls - stood in for above, so it changes nothing - and then
# PROVES the result with Get-Acl before writing the secret. This returns the descriptor a correct
# lockdown produces (protected, SYSTEM + Administrators, owner Administrators), or, to exercise
# fail-closed, an unprotected one:
#   $global:FrcAclMode = 'good'        every file locks down
#   $global:FrcAclMode = 'broken'      nothing locks down (the preflight probe fails too)
#   $global:FrcAclMode = 'broken-real' only the real .tunnel-token fails (the preflight passed)
function Get-Acl {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$Path, [string]$LiteralPath)
    $p = $LiteralPath; if (-not $p) { $p = $Path }
    _FrcRecord 'Get-Acl' $p '' ''
    $broken = ($global:FrcAclMode -eq 'broken') -or ($global:FrcAclMode -eq 'broken-real' -and $p -like '*\.tunnel-token')
    $fs = New-Object System.Security.AccessControl.FileSecurity
    $fs.SetAccessRuleProtection((-not $broken), $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $fs.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier $sid), 'FullControl', 'Allow')))
    }
    $fs.SetOwner((New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'))
    return $fs
}

$StandIns = @('Get-Service', 'Get-ScheduledTask', 'Register-ScheduledTask', 'Unregister-ScheduledTask',
              'Start-ScheduledTask', 'Get-ScheduledTaskInfo', 'New-ScheduledTask', 'icacls', 'schtasks', 'Start-Sleep',
              'Get-Acl')
function Assert-StandIns {
    foreach ($name in $StandIns) {
        $resolved = Get-Command -Name $name
        if ($resolved.CommandType -ne 'Function' -or $resolved.Source) {
            throw "Stand-in for '$name' does not take precedence (resolves to $($resolved.CommandType) '$($resolved.Source)'); refusing to run firstrun-config.ps1 against real commands."
        }
    }
    $root = (Get-PSDrive -Name HKLM).Root
    if ($root -ne "HKEY_CURRENT_USER\Software\$ScratchRegName") {
        throw "The HKLM: drive is not redirected to the scratch key (root is '$root'); refusing to run firstrun-config.ps1 against the real services registry."
    }
}
Assert-StandIns

# --- Fixtures ----------------------------------------------------------------------------------
$script:Failures = 0
$script:Passes = 0
function Check([bool]$Condition, [string]$What) {
    if ($Condition) { $script:Passes++; Write-Host "    ok    $What" }
    else { $script:Failures++; Write-Host "    FAIL  $What" -ForegroundColor Red }
}

# A fake install root with every file firstrun-config.ps1 checks for. The space in the name is
# deliberate: the real one is under "Program Files".
function New-FakeInstall {
    param([string]$EnvText)
    $root = Join-Path $work ('Tally MCP ' + [guid]::NewGuid().ToString('n').Substring(0, 6))
    foreach ($d in @('node-portable', 'bin', 'dist', 'scripts\installer', 'scripts\tray', 'logs', 'data')) {
        New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null
    }
    foreach ($f in @('node-portable\node.exe', 'dist\index.mjs', 'dist\server.mjs', 'scripts\tally-gui-agent-v2.ps1',
                     'scripts\installer\connect-client.ps1', 'scripts\tray\tally-mcp-tray.ps1', 'bin\cloudflared.exe')) {
        Set-Content -LiteralPath (Join-Path $root $f) -Value '' -Encoding ASCII
    }
    Copy-Item -LiteralPath $fakeNssm -Destination (Join-Path $root 'bin\nssm.exe')
    if ($EnvText) {
        $text = $EnvText.Replace('{DATA}', (Join-Path $root 'data'))
        [System.IO.File]::WriteAllText((Join-Path $root '.env'), $text, (New-Object System.Text.UTF8Encoding $false))
    }
    return $root
}

function Add-FakeTask([string]$Name, [string]$User, [string]$Root, [string]$Script = 'scripts\tally-gui-agent-v2.ps1') {
    $global:FrcTasks[$Name] = [pscustomobject]@{
        TaskName  = $Name
        Principal = [pscustomobject]@{ UserId = $User }
        Actions   = @([pscustomobject]@{ Arguments = "-ExecutionPolicy Bypass -NoProfile -WindowStyle Minimized -File `"$(Join-Path $Root $Script)`"" })
    }
}

# A service's NSSM AppEnvironmentExtra, in the redirected registry.
function Set-FakeServiceEnv([string]$Service, [string[]]$Entries) {
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$Service\Parameters"
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -LiteralPath $key -Name 'AppEnvironmentExtra' -PropertyType MultiString -Value $Entries -Force | Out-Null
}
function Get-FakeServiceEnv([string]$Service) {
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$Service\Parameters"
    if (-not (Test-Path -LiteralPath $key)) { return $null }
    $p = Get-ItemProperty -LiteralPath $key -Name 'AppEnvironmentExtra' -ErrorAction SilentlyContinue
    if ($null -eq $p) { return $null }
    return @($p.AppEnvironmentExtra)
}

function Reset-Fakes {
    $global:FrcCalls.Clear()
    $global:FrcTasks = @{}
    $global:FrcServices = @{}
    $global:FrcAclMode = 'good'
    Get-ChildItem -LiteralPath $ScratchReg -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    $env:FRC_NSSM_LOG = Join-Path $work ('nssm-' + [guid]::NewGuid().ToString('n').Substring(0, 8) + '.log')
}

function Get-FileHashText([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '<missing>' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function NssmLog {
    if (Test-Path -LiteralPath $env:FRC_NSSM_LOG) { return @(Get-Content -LiteralPath $env:FRC_NSSM_LOG) }
    return @()
}

# Runs firstrun-config.ps1 in-process. Returns output, exit code and any terminating error.
function Invoke-Firstrun {
    param([hashtable]$Params)
    $buf = New-Object System.Collections.ArrayList
    $err = $null
    $global:LASTEXITCODE = 0
    $base = @{ ServiceName = $Service; AgentTaskName = $AgentTask; TrayTaskName = $TrayTask; TunnelServiceName = $Tunnel; NoElevate = $true }
    foreach ($k in $Params.Keys) { $base[$k] = $Params[$k] }
    Assert-StandIns     # before EVERY run: see the Import-Module note above
    try {
        & $Target @base *>&1 | ForEach-Object { [void]$buf.Add("$_") }
    } catch {
        $err = $_
    }
    return [pscustomobject]@{ Output = ($buf -join "`n"); ExitCode = $global:LASTEXITCODE; Error = $err }
}

function Calls([string]$Cmd) { return @($global:FrcCalls | Where-Object { $_.Cmd -eq $Cmd }) }

function Show-OnFailure($Result) {
    if ($script:Failures -gt $script:FailuresBefore) {
        Write-Host '    --- firstrun-config.ps1 output ---' -ForegroundColor DarkGray
        Write-Host $Result.Output -ForegroundColor DarkGray
        if ($Result.Error) { Write-Host "    error: $($Result.Error)" -ForegroundColor DarkGray }
    }
}

# A customised local install: every value differs from what the wizard would auto-detect, plus
# keys the .env template does not know. An upgrade must leave all of it byte-for-byte.
$localEnv = @"
# Hand-tuned by the operator
TALLY_EDITION=gold
TALLY_HOST=127.0.0.1
TALLY_PORT=9001
TALLY_EXE_PATH="D:\Tally\Prime 4\tally.exe"
TALLY_DATA_PATH="{DATA}"
TALLY_INI_PATH="D:\Tally\Prime 4\tally.ini"
AGENT_TASK_USER="$Accountant"
ENABLE_GUI_CONTROL=false
UPDATE_CHECK=false
ENTRY_ORDER=debit-first
DEPLOYMENT_MODE=local
REMOTE_AUTH=oauth-password
REMOTE_TRANSPORT=tunnel
READONLY_MODE=true
"@

# A made-up tunnel token. It must reach the token file and nowhere else: not the output, not the
# transcript, not the fake nssm log, not any service's registry environment.
$TokenValue = 'eyJhIjoiZmFrZS10dW5uZWwtdG9rZW4ifQ=='

# A remote install from before DEPLOYMENT_MODE existed: no mode key at all, a password, a public
# domain and a tunnel.
$legacyRemoteEnv = @"
TALLY_EDITION=silver
TALLY_EXE_PATH="C:\Program Files\TallyPrime\tally.exe"
TALLY_DATA_PATH="{DATA}"
TALLY_INI_PATH="C:\Program Files\TallyPrime\tally.ini"
AGENT_TASK_USER="$Accountant"
ENABLE_GUI_CONTROL=true
PASSWORD="correct horse battery #staple"
BIND_HOST=127.0.0.1
MCP_DOMAIN=https://client42.tally.example.com
TUNNEL_TOKEN="$TokenValue"
CORS_ORIGINS=https://claude.ai
"@

$runningUser = $env:USERNAME
if ($runningUser -eq $Accountant) { throw "Run this as any account other than '$Accountant'." }

try {
    # ------------------------------------------------------------------------------------------
    Write-Host "`n[1] Upgrade of a customised local install, run by an account that is not the accountant"
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $localEnv
    Add-FakeTask $AgentTask $Accountant $root
    Add-FakeTask $TrayTask  $Accountant $root 'scripts\tray\tally-mcp-tray.ps1'
    $before = Get-FileHashText (Join-Path $root '.env')
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; Unattended = $true }
    Check ($null -eq $r.Error) 'completes without error'
    Check ((Get-FileHashText (Join-Path $root '.env')) -eq $before) '.env is byte-for-byte unchanged'
    Check (-not (Test-Path -LiteralPath (Join-Path $root '.env.tmp'))) 'no .env.tmp left behind'
    $reg = Calls 'Register-ScheduledTask'
    Check (@($reg | Where-Object { $_.Target -eq $AgentTask -and $_.User -eq $Accountant }).Count -eq 1) "agent task re-registered for '$Accountant'"
    Check (@($reg | Where-Object { $_.Target -eq $TrayTask -and $_.User -eq $Accountant }).Count -eq 1) "tray task re-registered for '$Accountant'"
    Check (@($reg | Where-Object { $_.User -ne $Accountant }).Count -eq 0) "no task registered for anyone else (not '$runningUser', not SYSTEM)"
    Check (@($reg | Where-Object { $_.Target -eq 'TallyMCPConnectOnce' }).Count -eq 0) 'Claude client configuration left alone (no connect task)'
    Check (@(Calls 'Start-ScheduledTask' | Where-Object { $_.Target -in @($AgentTask, $TrayTask) }).Count -eq 2) 'agent and tray restarted'
    $grants = @(Calls 'icacls' | Where-Object { $_.Detail -match '/grant' })
    Check ($grants.Count -ge 2 -and @($grants | Where-Object { $_.Detail -notmatch [regex]::Escape("${Accountant}:") }).Count -eq 0) "ACL grants go to '$Accountant' only"
    Check (@(NssmLog).Count -eq 0) 'no service touched (local mode)'
    Check ($r.Output -match 'left exactly as it was') 'says .env was left as it was'
    Show-OnFailure $r

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[2] Upgrade of a legacy remote install (no DEPLOYMENT_MODE key, token in the service registry)"
    Write-Host "    This is how every install configured before #193 receives that migration."
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $legacyRemoteEnv
    Add-FakeTask $AgentTask $Accountant $root
    Add-FakeTask $TrayTask  $Accountant $root 'scripts\tray\tally-mcp-tray.ps1'
    $global:FrcServices[$Service] = 'Running'
    $global:FrcServices[$Tunnel]  = 'Running'
    # What pre-#193 installers left behind: the token in the tunnel's environment next to an unrelated
    # entry that must survive, and (installs from before #172 C3) in the main service's too.
    Set-FakeServiceEnv $Tunnel  @("TUNNEL_TOKEN=$TokenValue", 'NO_PROXY=localhost')
    Set-FakeServiceEnv $Service @("TUNNEL_TOKEN=$TokenValue")
    $before = Get-FileHashText (Join-Path $root '.env')
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; Unattended = $true }
    Check ($null -eq $r.Error) 'completes without error (no password prompt, no credentials file needed)'
    Check ((Get-FileHashText (Join-Path $root '.env')) -eq $before) '.env is byte-for-byte unchanged (still no DEPLOYMENT_MODE key)'
    $log = NssmLog
    Check (@($log | Where-Object { $_ -like "install | $Service | *" }).Count -eq 1) 'remote mode kept: service re-registered'
    Check (@($log | Where-Object { $_ -eq "set | $Service | Start | SERVICE_AUTO_START" }).Count -eq 1) 'service set back to automatic start'
    Check (@($log | Where-Object { $_ -eq "start | $Service" }).Count -eq 1) 'service started'
    Check (@($log | Where-Object { $_ -eq "install | $Tunnel | $(Join-Path $root 'bin\cloudflared.exe')" }).Count -eq 1) 'existing tunnel service re-registered'
    Check (@($log | Where-Object { $_ -eq "set | $Tunnel | AppParameters | tunnel run --token-file .tunnel-token" }).Count -eq 1) 'tunnel now reads its token with --token-file'
    Check (@($log | Where-Object { $_ -match 'AppEnvironmentExtra' }).Count -eq 0) 'no service is given an environment'
    Check (@($log | Where-Object { $_ -eq "start | $Tunnel" }).Count -eq 1) 'tunnel started'
    $tokenFile = Join-Path $root '.tunnel-token'
    Check ((Test-Path -LiteralPath $tokenFile) -and ([System.IO.File]::ReadAllText($tokenFile) -ceq $TokenValue)) 'token file holds exactly the token from .env (no BOM, no newline)'
    $lock = @(Calls 'icacls' | Where-Object { $_.Target -eq $tokenFile })
    Check (@($lock | Where-Object { $_.Detail -eq '/inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F' }).Count -eq 1 -and
           @($lock | Where-Object { $_.Detail -eq '/setowner *S-1-5-32-544' }).Count -eq 1) 'token file locked to SYSTEM + Administrators, owned by Administrators'
    $tunnelEnv = Get-FakeServiceEnv $Tunnel
    Check ($null -ne $tunnelEnv -and (@($tunnelEnv) -join '|') -eq 'NO_PROXY=localhost') 'TUNNEL_TOKEN scrubbed from the tunnel registry environment; the other entry kept'
    Check ($null -eq (Get-FakeServiceEnv $Service)) 'TUNNEL_TOKEN scrubbed from the main service registry environment'
    $transcriptText = ''
    $tp = Join-Path $root 'logs\firstrun-config.log'
    if (Test-Path -LiteralPath $tp) { $transcriptText = [System.IO.File]::ReadAllText($tp) }
    Check (($r.Output + ($log -join "`n") + $transcriptText).IndexOf($TokenValue) -lt 0) 'the token value appears in no output, transcript or nssm call'
    Check (@(Calls 'Register-ScheduledTask' | Where-Object { $_.User -ne $Accountant }).Count -eq 0) "tasks only for '$Accountant'"
    Check (-not (Test-Path -LiteralPath (Join-Path $root '.tunnel-token.preflight'))) 'no preflight probe file left behind'
    Show-OnFailure $r

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[2b] Upgrade fails closed when the token file cannot be locked down after the preflight passed"
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $legacyRemoteEnv
    Add-FakeTask $AgentTask $Accountant $root
    $global:FrcServices[$Service] = 'Running'
    $global:FrcServices[$Tunnel]  = 'Running'
    Set-FakeServiceEnv $Tunnel @("TUNNEL_TOKEN=$TokenValue")
    $global:FrcAclMode = 'broken-real'
    $before = Get-FileHashText (Join-Path $root '.env')
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; Unattended = $true }
    Check ($null -ne $r.Error -and "$($r.Error)" -match 'could not be re-registered') 'the run FAILS (so Setup exits 10 and the updater rolls back)'
    $log = NssmLog
    Check (@($log | Where-Object { $_ -like "install | $Tunnel | *" }).Count -eq 0) 'tunnel left unregistered rather than protected less well'
    Check (-not (Test-Path -LiteralPath (Join-Path $root '.tunnel-token'))) 'no token file left behind'
    Check ($null -eq (Get-FakeServiceEnv $Tunnel)) 'registry copy still scrubbed'
    Check (@(Calls 'Register-ScheduledTask' | Where-Object { $_.Target -eq $AgentTask -and $_.User -eq $Accountant }).Count -eq 1) 'the agent task was still restored before the failure was raised'
    Check ((Get-FileHashText (Join-Path $root '.env')) -eq $before) '.env unchanged'
    Check ((($r.Output + "$($r.Error)").IndexOf($TokenValue)) -lt 0) 'the token value appears in no output'
    Show-OnFailure $r

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[3] Upgrade with no AGENT_TASK_USER in .env takes the user from the existing agent task"
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText ($localEnv -replace "(?m)^AGENT_TASK_USER=.*\r?\n", '')
    Add-FakeTask $AgentTask $Accountant $root
    $before = Get-FileHashText (Join-Path $root '.env')
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true }
    Check ($null -eq $r.Error) 'completes without error'
    Check (@(Calls 'Register-ScheduledTask' | Where-Object { $_.Target -eq $AgentTask -and $_.User -eq $Accountant }).Count -eq 1) "agent task stays with '$Accountant'"
    Check (@(Calls 'Register-ScheduledTask' | Where-Object { $_.Target -eq $TrayTask }).Count -eq 0) 'tray task did not exist, so it is not created'
    Check ((Get-FileHashText (Join-Path $root '.env')) -eq $before) '.env unchanged (the user is not written back)'
    Show-OnFailure $r

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[4] Upgrade refuses, changing nothing, when it cannot know the agent user"
    $refusals = @(
        @{ Name = 'no AGENT_TASK_USER and no agent task'; Env = ($localEnv -replace "(?m)^AGENT_TASK_USER=.*\r?\n", ''); TaskUser = $null; Params = @{} }
        @{ Name = 'AGENT_TASK_USER=SYSTEM';               Env = ($localEnv -replace "(?m)^AGENT_TASK_USER=.*$", 'AGENT_TASK_USER=SYSTEM'); TaskUser = $null; Params = @{} }
        @{ Name = 'agent task runs as SYSTEM';            Env = ($localEnv -replace "(?m)^AGENT_TASK_USER=.*\r?\n", ''); TaskUser = 'SYSTEM'; Params = @{} }
        @{ Name = 'agent user is a machine account';      Env = ($localEnv -replace "(?m)^AGENT_TASK_USER=.*$", 'AGENT_TASK_USER=PC01$'); TaskUser = $null; Params = @{} }
        @{ Name = '.env and the agent task disagree';     Env = $localEnv; TaskUser = 'someone-else'; Params = @{} }
        @{ Name = 'wizard values passed with -Upgrade';   Env = $localEnv; TaskUser = $Accountant; Params = @{ TallyEdition = 'silver'; AgentTaskUser = 'SYSTEM'; EnableGuiControl = 'true' } }
        @{ Name = 'DEPLOYMENT_MODE in .env is garbage';   Env = ($localEnv -replace 'DEPLOYMENT_MODE=local', 'DEPLOYMENT_MODE=lcoal'); TaskUser = $Accountant; Params = @{} }
        @{ Name = 'no .env at all';                       Env = ''; TaskUser = $Accountant; Params = @{} }
    )
    foreach ($case in $refusals) {
        Reset-Fakes; $script:FailuresBefore = $script:Failures
        $root = New-FakeInstall -EnvText $case.Env
        if ($case.TaskUser) { Add-FakeTask $AgentTask $case.TaskUser $root }
        $before = Get-FileHashText (Join-Path $root '.env')
        $p = @{ InstallDir = $root; Upgrade = $true; Unattended = $true }
        foreach ($k in $case.Params.Keys) { $p[$k] = $case.Params[$k] }
        $r = Invoke-Firstrun $p
        Check ($null -ne $r.Error -and "$($r.Error)" -match 'REFUSED') "$($case.Name): refused"
        Check ((Get-FileHashText (Join-Path $root '.env')) -eq $before) "$($case.Name): .env untouched"
        $changes = @($global:FrcCalls | Where-Object { $_.Cmd -ne 'Get-ScheduledTask' })
        Check ($changes.Count -eq 0 -and @(NssmLog).Count -eq 0) "$($case.Name): nothing registered, removed or re-permissioned"
        Show-OnFailure $r
    }

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[5] Preflight: answers without changing anything, and says why when it refuses"
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $localEnv
    Add-FakeTask $AgentTask $Accountant $root
    $report = Join-Path $work 'preflight-ok.txt'
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; PreflightOnly = $true; ReportFile = $report }
    Check ($null -eq $r.Error -and $r.ExitCode -eq 0) 'exit 0 when the upgrade can preserve everything'
    Check ((Test-Path -LiteralPath $report) -and ((Get-Content -Raw -LiteralPath $report) -match "^OK: .*$Accountant")) 'report says OK and names the preserved user'
    Check (@($global:FrcCalls | Where-Object { $_.Cmd -ne 'Get-ScheduledTask' }).Count -eq 0) 'nothing changed'
    Check (-not (Test-Path -LiteralPath (Join-Path $root 'logs\firstrun-config.log'))) 'no log written'
    Show-OnFailure $r

    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $localEnv
    Add-FakeTask $AgentTask 'someone-else' $root
    $report = Join-Path $work 'preflight-refused.txt'
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; PreflightOnly = $true; ReportFile = $report }
    Check ($null -eq $r.Error -and $r.ExitCode -eq 1) 'exit 1 when it cannot'
    Check ((Test-Path -LiteralPath $report) -and ((Get-Content -Raw -LiteralPath $report) -match '^REFUSED:[\s\S]*someone-else')) 'report says REFUSED and why'
    Show-OnFailure $r

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[5b] Preflight refuses, before anything is stopped, what would break the tunnel (#193)"
    $tunnelCases = @(
        @{ Name = 'token file cannot be locked down'; Env = $legacyRemoteEnv; Acl = 'broken'; Match = 'locked-down tunnel token file cannot be written' }
        @{ Name = 'tunnel service but no TUNNEL_TOKEN in .env'; Env = ($legacyRemoteEnv -replace "(?m)^TUNNEL_TOKEN=.*\r?\n", ''); Acl = 'good'; Match = 'has no TUNNEL_TOKEN' }
    )
    foreach ($case in $tunnelCases) {
        Reset-Fakes; $script:FailuresBefore = $script:Failures
        $root = New-FakeInstall -EnvText $case.Env
        Add-FakeTask $AgentTask $Accountant $root
        $global:FrcServices[$Service] = 'Running'
        $global:FrcServices[$Tunnel]  = 'Running'
        Set-FakeServiceEnv $Tunnel @("TUNNEL_TOKEN=$TokenValue")
        $global:FrcAclMode = $case.Acl
        $report = Join-Path $work ('preflight-tunnel-' + [guid]::NewGuid().ToString('n').Substring(0, 6) + '.txt')
        $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; PreflightOnly = $true; ReportFile = $report }
        Check ($r.ExitCode -eq 1 -and (Get-Content -Raw -LiteralPath $report) -match $case.Match) "$($case.Name): preflight refuses and says why"
        Check (@(NssmLog).Count -eq 0 -and @(Calls 'Register-ScheduledTask').Count -eq 0) "$($case.Name): nothing stopped or registered"
        Check (-not (Test-Path -LiteralPath (Join-Path $root '.tunnel-token.preflight')) -and -not (Test-Path -LiteralPath (Join-Path $root '.tunnel-token'))) "$($case.Name): no probe or token file left behind"
        Check ((@(Get-FakeServiceEnv $Tunnel) -join '|') -eq "TUNNEL_TOKEN=$TokenValue") "$($case.Name): registry untouched (the preflight changes nothing)"
        Check ((($r.Output + (Get-Content -Raw -LiteralPath $report)).IndexOf($TokenValue)) -lt 0) "$($case.Name): the token value appears in no output"
        Show-OnFailure $r
    }

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[6] Upgrade of an install that has moved rewrites the Claude client configuration"
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $localEnv
    Add-FakeTask $AgentTask $Accountant 'D:\Old Place\TallyMCP'
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true }
    Check ($null -eq $r.Error) 'completes without error'
    Check (@(Calls 'Register-ScheduledTask' | Where-Object { $_.Target -eq 'TallyMCPConnectOnce' -and $_.User -eq $Accountant }).Count -eq 1) "connect-client runs once, as '$Accountant'"
    Check (@(Calls 'Register-ScheduledTask' | Where-Object { $_.Target -eq $AgentTask -and $_.Detail -like "*$root*" }).Count -eq 1) 'agent task now points at the new location'
    Show-OnFailure $r

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[7] Upgrade of a remote install whose service is gone does not re-create it"
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText ($legacyRemoteEnv + "`r`nDEPLOYMENT_MODE=remote`r`n")
    Add-FakeTask $AgentTask $Accountant $root
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true }
    Check ($null -eq $r.Error) 'completes without error'
    Check (@(NssmLog | Where-Object { $_ -like "install | *" }).Count -eq 0) 'no service or tunnel created'
    Check ($r.Output -match 'none is created') 'says so'
    Show-OnFailure $r

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[8] Outside upgrade mode: an unattended run never falls back to the running account"
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText ''
    $r = Invoke-Firstrun @{ InstallDir = $root; Unattended = $true }
    Check ($null -ne $r.Error -and "$($r.Error)" -match 'Cannot choose the Windows user') "fresh unattended run with no agent user refuses (does not pick '$runningUser')"
    Check (-not (Test-Path -LiteralPath (Join-Path $root '.env'))) 'no .env written'
    Show-OnFailure $r

    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText ''
    $r = Invoke-Firstrun @{ InstallDir = $root; Unattended = $true; AgentTaskUser = 'SYSTEM' }
    Check ($null -ne $r.Error -and "$($r.Error)" -match 'service account') '-AgentTaskUser SYSTEM refuses'
    Check (@(Calls 'Register-ScheduledTask').Count -eq 0) 'nothing registered'
    Show-OnFailure $r

    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText ''
    $r = Invoke-Firstrun @{ InstallDir = $root; Unattended = $true; AgentTaskUser = $Accountant; EnableGuiControl = 'true' }
    Check ($null -eq $r.Error) "fresh unattended run with an explicit user completes"
    $envText = Get-Content -Raw -LiteralPath (Join-Path $root '.env')
    Check ($envText -match "(?m)^DEPLOYMENT_MODE=local\s*$") 'a fresh install is local'
    Check ($envText -match "(?m)^AGENT_TASK_USER=`"$Accountant`"\s*$") 'and records the agent user'
    Show-OnFailure $r

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[9] Outside upgrade mode, passed values still win over .env (Reconfigure semantics)"
    Write-Host "    This is why the installer must pass nothing on an unattended upgrade."
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $localEnv
    Add-FakeTask $AgentTask $Accountant $root
    $r = Invoke-Firstrun @{ InstallDir = $root; Unattended = $true; TallyEdition = 'silver'; TallyExePath = 'C:\Program Files\TallyPrime\tally.exe'; AgentTaskUser = 'wizard-default-user'; EnableGuiControl = 'true'; EntryOrder = ''; DeploymentMode = '' }
    Check ($null -eq $r.Error) 'completes'
    $envText = Get-Content -Raw -LiteralPath (Join-Path $root '.env')
    Check ($envText -match '(?m)^TALLY_EDITION=silver') 'edition overwritten by the passed value'
    Check ($envText -match '(?m)^DEPLOYMENT_MODE=local') 'mode still preserved (passed as empty, as the installer does)'
    Check ($envText -notmatch 'READONLY_MODE') 'keys the template does not know are dropped - so an upgrade must not rewrite .env'
    Show-OnFailure $r
}
finally {
    Remove-Item Env:\FRC_NSSM_LOG -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Variable -Scope Global -Name FrcCalls, FrcTasks, FrcServices, FrcAclMode -ErrorAction SilentlyContinue
    # Put the real HKLM: drive back, then drop the scratch key.
    Remove-PSDrive -Name HKLM -ErrorAction SilentlyContinue
    New-PSDrive -Name HKLM -PSProvider Registry -Root 'HKEY_LOCAL_MACHINE' -Scope Global | Out-Null
    Remove-Item -LiteralPath $ScratchReg -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($script:Failures -gt 0) {
    Write-Host "$($script:Failures) check(s) FAILED, $($script:Passes) passed." -ForegroundColor Red
    exit 1
}
Write-Host "All $($script:Passes) checks passed." -ForegroundColor Green
exit 0
