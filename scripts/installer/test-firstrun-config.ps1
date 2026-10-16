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
# The person who uses Tally; NOT the account running this. It has to be a REAL account, because
# every ACL grant is now made by SID (#230) and firstrun-config.ps1 resolves the agent user to one
# before it touches a file - an account that does not resolve stops the run. The built-in Guest
# account exists on every Windows (disabled, which does not matter: nothing runs as it - every task
# and ACL call is a stand-in). It is found by its well-known RID, 501, not by name, since the name
# is localised too.
$_me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$AccountantSid = (New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::AccountGuestSid, $_me.AccountDomainSid)).Value
$Accountant = ([System.Security.Principal.SecurityIdentifier]$AccountantSid).Translate([System.Security.Principal.NTAccount]).Value

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

# --- %ProgramData%, redirected ---------------------------------------------------------------------
# The Claudally agent folder (the vault and the GUI agent's IPC files, #230) is %ProgramData%\
# Claudally\agent, and firstrun-config.ps1 finds it through $env:ProgramData. For this session that
# points at a scratch folder, so no case can create or re-permission anything under the real
# C:\ProgramData. Assert-StandIns checks the redirect before every run; the finally block restores it.
$RealProgramData = $env:ProgramData
$FakeProgramData = Join-Path $work 'ProgramData'
New-Item -ItemType Directory -Force -Path $FakeProgramData | Out-Null
$env:ProgramData = $FakeProgramData
$FakeAgentDir = Join-Path $FakeProgramData 'Claudally\agent'
$FakeClaudallyDir = Join-Path $FakeProgramData 'Claudally'
$RealClaudallyBefore = Test-Path -LiteralPath (Join-Path $RealProgramData 'Claudally')

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

# --- A model of NTFS permissions, driven by the icacls stand-in and read back by Get-Acl ----------
# firstrun-config.ps1 locks .env, the company vault, the IPC directory and the tunnel token file down
# with icacls and then PROVES the result with Get-Acl before it trusts it (#193, #230). So the
# stand-in does not just record icacls: it applies each call to a per-path model of the ACL, and the
# Get-Acl stand-in returns that model as a real FileSecurity/DirectorySecurity, built from SDDL.
#
# THIS SIMULATES A LOCALISED WINDOWS, as far as account names go: no account NAME maps. A principal
# passed by name ('Administrators:F', 'SYSTEM:F', 'alice:F') fails the whole call with exit 1332,
# "No mapping between account names and security IDs was done", and changes nothing - exactly what
# icacls does on a German or French Windows for 'Administrators' (#230). Only *SID principals work.
# Every name that was tried is recorded in $global:FrcIcaclsNames, so a test can also assert none was.
#
# A path nobody has locked down reads as the install folder does under Program Files: inheritance
# on, inherited Full Control for SYSTEM and Administrators, and inherited read for BUILTIN\Users.
#
# Failure injection (wildcard patterns, matched against the full path):
#   $global:FrcIcaclsFail  icacls on a matching path exits 5 (access denied) and changes nothing.
#   $global:FrcAclIgnore   icacls on a matching path exits 0 but changes nothing - to prove the Get-Acl
#                          verification, not the exit code, is what the script trusts.
#   $global:FrcAclSeed     path -> list of explicit ACEs to start from (a "foreign" entry left by hand).
function _FrcMatch([string]$Path, $Patterns) {
    foreach ($p in @($Patterns)) { if ($p -and $Path -like $p) { return $true } }
    return $false
}

#   Set-FrcAcl             starts a path from a given state instead: an owner another account holds
#                          (a planted folder), or the protected shape an earlier installer left.
# And, to prove a secret never sat in a readable file: every lockdown (/inheritance:r) records the
# size the file had at that moment in $global:FrcLockedAtSize. 0 = nothing was in it yet.
function _FrcDefaultAces {
    $aces = New-Object System.Collections.ArrayList
    foreach ($s in @('S-1-5-18', 'S-1-5-32-544')) { [void]$aces.Add(@{ Sid = $s; Rights = 'FA'; Inherit = $true; Inherited = $true }) }
    [void]$aces.Add(@{ Sid = 'S-1-5-32-545'; Rights = 'FR'; Inherit = $true; Inherited = $true })
    return , $aces
}

function _FrcAclOf([string]$Path) {
    $k = $Path.ToLowerInvariant()
    if (-not $global:FrcAcl.ContainsKey($k)) {
        $aces = _FrcDefaultAces
        foreach ($seed in @($global:FrcAclSeed[$Path])) { if ($seed) { [void]$aces.Add($seed) } }
        $global:FrcAcl[$k] = @{ Protected = $false; Owner = 'S-1-5-32-544'; Aces = $aces }
    }
    return $global:FrcAcl[$k]
}

function Set-FrcAcl {
    param([string]$Path, [bool]$Protected = $false, [string]$Owner = 'S-1-5-32-544', [object[]]$Aces = $null)
    $list = New-Object System.Collections.ArrayList
    if ($null -eq $Aces) { $list = _FrcDefaultAces } else { foreach ($a in $Aces) { [void]$list.Add($a) } }
    $global:FrcAcl[$Path.ToLowerInvariant()] = @{ Protected = $Protected; Owner = $Owner; Aces = $list }
}

function icacls {
    $target = ''
    if ($args.Count -gt 0) { $target = "$($args[0])" }
    $rest = @($args | Select-Object -Skip 1 | ForEach-Object { "$_" })
    _FrcRecord 'icacls' $target '' ($rest -join ' ')
    if (_FrcMatch $target $global:FrcIcaclsFail) {
        $global:LASTEXITCODE = 5
        return "${target}: Access is denied."
    }
    $cur = _FrcAclOf $target
    $new = @{ Protected = $cur.Protected; Owner = $cur.Owner; Aces = New-Object System.Collections.ArrayList }
    foreach ($a in $cur.Aces) { [void]$new.Aces.Add($a) }
    $toSid = {
        param([string]$Principal)
        if ($Principal.StartsWith('*')) { return $Principal.Substring(1) }
        [void]$global:FrcIcaclsNames.Add($Principal)
        return $null
    }
    $i = 0
    while ($i -lt $rest.Count) {
        $flag = $rest[$i]; $i++
        if ($flag -eq '/inheritance:r') {
            $size = -1
            if (Test-Path -LiteralPath $target -PathType Leaf) { $size = (Get-Item -LiteralPath $target -Force).Length }
            if (-not $global:FrcLockedAtSize.ContainsKey($target.ToLowerInvariant())) { $global:FrcLockedAtSize[$target.ToLowerInvariant()] = $size }
            $new.Protected = $true
            $keep = @($new.Aces | Where-Object { -not $_.Inherited })
            $new.Aces = New-Object System.Collections.ArrayList; foreach ($a in $keep) { [void]$new.Aces.Add($a) }
        } elseif ($flag -eq '/inheritance:e') {
            # What the parent passes down comes back: modelled as the default inherited entries.
            $new.Protected = $false
            if (-not @($new.Aces | Where-Object { $_.Inherited }).Count) { foreach ($a in (_FrcDefaultAces)) { [void]$new.Aces.Add($a) } }
        } elseif ($flag -eq '/remove:g') {
            $p = $rest[$i]; $i++
            $sid = & $toSid $p
            if (-not $sid) { $global:LASTEXITCODE = 1332; return "${p}: No mapping between account names and security IDs was done." }
            $keep = @($new.Aces | Where-Object { $_.Inherited -or $_.Sid -ne $sid })
            $new.Aces = New-Object System.Collections.ArrayList; foreach ($a in $keep) { [void]$new.Aces.Add($a) }
        } elseif ($flag -eq '/grant:r') {
            while ($i -lt $rest.Count -and -not $rest[$i].StartsWith('/')) {
                $spec = $rest[$i]; $i++
                $colon = $spec.IndexOf(':')
                $sid = & $toSid $spec.Substring(0, $colon)
                if (-not $sid) { $global:LASTEXITCODE = 1332; return "$($spec.Substring(0, $colon)): No mapping between account names and security IDs was done." }
                $perm = $spec.Substring($colon + 1)
                $keep = @($new.Aces | Where-Object { $_.Inherited -or $_.Sid -ne $sid })
                $new.Aces = New-Object System.Collections.ArrayList; foreach ($a in $keep) { [void]$new.Aces.Add($a) }
                [void]$new.Aces.Add(@{ Sid = $sid; Rights = $(if ($perm -match 'F$') { 'FA' } else { 'FR' }); Inherit = ($perm -like '*(OI)(CI)*'); Inherited = $false })
            }
        } elseif ($flag -eq '/setowner' -or $flag -eq '/remove') {
            $p = $rest[$i]; $i++
            $sid = & $toSid $p
            if (-not $sid) { $global:LASTEXITCODE = 1332; return "${p}: No mapping between account names and security IDs was done." }
            if ($flag -eq '/setowner') { $new.Owner = $sid }
            else {
                $keep = @($new.Aces | Where-Object { $_.Inherited -or $_.Sid -ne $sid })
                $new.Aces = New-Object System.Collections.ArrayList; foreach ($a in $keep) { [void]$new.Aces.Add($a) }
            }
        } else {
            $global:LASTEXITCODE = 87
            return "Invalid parameter `"$flag`""
        }
    }
    if (-not (_FrcMatch $target $global:FrcAclIgnore)) { $global:FrcAcl[$target.ToLowerInvariant()] = $new }
    $global:LASTEXITCODE = 0
    return "processed file: $target"
}

# The model as SIDs, for assertions: "S-1-5-18:FA:OICI" ... sorted, plus whether it is protected.
function Get-FrcAclText([string]$Path) {
    $m = _FrcAclOf $Path
    $aces = @($m.Aces | ForEach-Object { "$($_.Sid):$($_.Rights)$(if ($_.Inherit) { ':OICI' })$(if ($_.Inherited) { ':inherited' })" } | Sort-Object)
    return "protected=$($m.Protected) owner=$($m.Owner) " + ($aces -join ' ')
}

function schtasks {
    _FrcRecord 'schtasks' '' '' ($args -join ' ')
    $global:LASTEXITCODE = 0
}

function Start-Sleep {
    [CmdletBinding()]
    param([int]$Seconds, [int]$Milliseconds)
}

# Returns the modelled ACL of a path (see the icacls stand-in above) as the real .NET type Get-Acl
# returns, built from SDDL, so firstrun-config.ps1's verification runs its real code on it.
function Get-Acl {
    [CmdletBinding()]
    param([Parameter(Position = 0)][string]$Path, [string]$LiteralPath)
    $p = $LiteralPath; if (-not $p) { $p = $Path }
    _FrcRecord 'Get-Acl' $p '' ''
    $m = _FrcAclOf $p
    $sddl = "O:$($m.Owner)D:$(if ($m.Protected) { 'P' })"
    foreach ($a in $m.Aces) {
        $flags = ''
        if ($a.Inherit) { $flags += 'OICI' }
        if ($a.Inherited) { $flags += 'ID' }
        $sddl += "(A;$flags;$($a.Rights);;;$($a.Sid))"
    }
    if (Test-Path -LiteralPath $p -PathType Container) { $sec = New-Object System.Security.AccessControl.DirectorySecurity }
    else { $sec = New-Object System.Security.AccessControl.FileSecurity }
    $sec.SetSecurityDescriptorSddlForm($sddl)
    return $sec
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
    if ($env:ProgramData -ne $FakeProgramData) {
        throw "`$env:ProgramData is '$env:ProgramData', not the scratch folder; refusing to run firstrun-config.ps1 against the real %ProgramData%."
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

# A service's NSSM AppEnvironmentExtra (or, with -Value AppEnvironment, AppEnvironment), in the
# redirected registry.
function Set-FakeServiceEnv([string]$Service, [string[]]$Entries, [string]$Value = 'AppEnvironmentExtra') {
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$Service\Parameters"
    if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -LiteralPath $key -Name $Value -PropertyType MultiString -Value $Entries -Force | Out-Null
}
function Get-FakeServiceEnv([string]$Service, [string]$Value = 'AppEnvironmentExtra') {
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$Service\Parameters"
    if (-not (Test-Path -LiteralPath $key)) { return $null }
    $p = Get-ItemProperty -LiteralPath $key -Name $Value -ErrorAction SilentlyContinue
    if ($null -eq $p) { return $null }
    return @($p.$Value)
}

# The machine-wide environment, in the redirected registry.
$MachineEnvKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
function Set-FakeMachineEnv([string]$Name, [string]$Value) {
    if (-not (Test-Path -LiteralPath $MachineEnvKey)) { New-Item -Path $MachineEnvKey -Force | Out-Null }
    New-ItemProperty -LiteralPath $MachineEnvKey -Name $Name -PropertyType String -Value $Value -Force | Out-Null
}
function Get-FakeMachineEnv([string]$Name) {
    $p = Get-ItemProperty -LiteralPath $MachineEnvKey -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $p) { return $null }
    return "$($p.$Name)"
}

# Every file under a fake install root that contains $Needle - to prove a secret reached no disk.
function Find-Secret([string]$Root, [string]$Needle) {
    return @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File | Where-Object {
        [System.IO.File]::ReadAllText($_.FullName).IndexOf($Needle) -ge 0
    } | ForEach-Object { $_.FullName })
}

function Reset-Fakes {
    $global:FrcCalls.Clear()
    $global:FrcTasks = @{}
    $global:FrcServices = @{}
    $global:FrcAcl = @{}
    $global:FrcAclSeed = @{}
    $global:FrcIcaclsFail = @()
    $global:FrcAclIgnore = @()
    $global:FrcIcaclsNames = New-Object System.Collections.ArrayList
    $global:FrcLockedAtSize = @{}
    # The fake %ProgramData%: emptied between cases. A junction a case planted is unlinked first,
    # on its own, so the recursive delete below can never follow it into its target.
    if (Test-Path -LiteralPath $FakeProgramData) {
        foreach ($d in @((Join-Path $FakeProgramData 'Claudally\agent'), (Join-Path $FakeProgramData 'Claudally'))) {
            if ((Test-Path -LiteralPath $d) -and ((Get-Item -LiteralPath $d -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                [System.IO.Directory]::Delete($d)
            }
        }
        Get-ChildItem -LiteralPath $FakeProgramData -Force | Remove-Item -Recurse -Force
    }
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
    # A fresh install with no .env and no -TallyDataPath would fall back to the REAL default Tally data
    # folder (C:\Users\Public\...) and create the vault there. Point it at the fake root instead. (An
    # upgrade takes no setting parameters, and reads the path from its .env.)
    if (-not $base.ContainsKey('Upgrade') -and -not $base.ContainsKey('TallyDataPath') -and
        -not (Test-Path -LiteralPath (Join-Path $base.InstallDir '.env'))) {
        $base['TallyDataPath'] = Join-Path $base.InstallDir 'data'
    }
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

# firstrun-config.ps1's fallback data folder. No test may reach it (see Invoke-Firstrun).
$DefaultDataPath = 'C:\Users\Public\TallyPrimeEditLog\data'
function Get-DefaultDataState {
    $v = Join-Path $DefaultDataPath '.tally-mcp-companies.json'
    if (-not (Test-Path -LiteralPath $DefaultDataPath)) { return 'absent' }
    if (-not (Test-Path -LiteralPath $v)) { return 'folder only' }
    return "vault written $((Get-Item -LiteralPath $v -Force).LastWriteTimeUtc.Ticks)"
}
$DefaultDataBefore = Get-DefaultDataState

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
    # (An upgrade re-runs the preflight's checks first, so the two probe files are locked down too.)
    # %ProgramData%\Claudally itself is SYSTEM + Administrators only; everything else also to the accountant.
    $real = @($grants | Where-Object { $_.Target -notlike '*.preflight' })
    Check ((@($real | ForEach-Object { $_.Target }) -join '|') -eq (@((Join-Path $root '.env'), $FakeClaudallyDir, $FakeAgentDir, (Join-Path $FakeAgentDir '.tally-mcp-companies.json')) -join '|') -and
           @($grants | Where-Object { $_.Target -ne $FakeClaudallyDir -and $_.Detail -notmatch [regex]::Escape("*${AccountantSid}:") }).Count -eq 0) "ACL grants (.env, the agent folder, the vault) go to '$Accountant' only, by SID"
    Check (@(Calls 'icacls' | Where-Object { $_.Target -like "$(Join-Path $root 'data')*" }).Count -eq 0) "Tally's data folder is not re-permissioned (it was never locked, so there is nothing to restore)"
    Check ($global:FrcIcaclsNames.Count -eq 0) 'no account is ever passed to icacls by name'
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
    # And in NSSM's other environment value, AppEnvironment, which replaces the environment instead
    # of adding to it. Nothing we shipped wrote it, but `nssm set` by hand could have (#229 review).
    Set-FakeServiceEnv $Tunnel  @('HTTPS_PROXY=http://proxy:8080', " tunnel_token = $TokenValue") -Value 'AppEnvironment'
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
    $tunnelAppEnv = Get-FakeServiceEnv $Tunnel -Value 'AppEnvironment'
    Check ($null -ne $tunnelAppEnv -and (@($tunnelAppEnv) -join '|') -eq 'HTTPS_PROXY=http://proxy:8080') 'TUNNEL_TOKEN scrubbed from the tunnel AppEnvironment value too (any case, any spacing); the other entry kept'
    Check ($r.Output -match 'TUNNEL_TOKEN from the .* \(AppEnvironment\)') 'says it scrubbed AppEnvironment'
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
    # icacls "succeeds" on the real token file but changes nothing: only the Get-Acl check can tell.
    $global:FrcAclIgnore = @('*\.tunnel-token')
    $before = Get-FileHashText (Join-Path $root '.env')
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; Unattended = $true }
    Check ($null -ne $r.Error -and "$($r.Error)" -match "'$Tunnel' service could not be registered \(it existed before this run") 'the run FAILS (so Setup exits 10 and the updater rolls back)'
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
    Check ((Test-Path -LiteralPath $report) -and ((Get-Content -Raw -LiteralPath $report) -match "^OK: .*$([regex]::Escape($Accountant))")) 'report says OK and names the preserved user'
    $probeCalls = @($global:FrcCalls | Where-Object { $_.Cmd -in @('icacls', 'Get-Acl') })
    Check (@($global:FrcCalls | Where-Object { $_.Cmd -ne 'Get-ScheduledTask' -and $probeCalls -notcontains $_ }).Count -eq 0 -and
           @($probeCalls | Where-Object { $_.Target -notlike '*\.tally-mcp-acl.preflight' }).Count -eq 0) 'nothing changed (the only ACL calls are on the preflight probe files)'
    $probedIn = (@(Calls 'icacls' | Where-Object { $_.Detail -like '/inheritance:r*' } | ForEach-Object { Split-Path -Parent $_.Target }) -join '|')
    Check ($probedIn -eq (@($root, $FakeProgramData) -join '|')) 'the lockdown was dry-run in the install folder and where the agent folder will go (%ProgramData%, as it does not exist yet) - not in Tally''s data folder'
    Check (@(Get-ChildItem -LiteralPath $root, $FakeProgramData -Recurse -Force -Filter '*.preflight').Count -eq 0) 'no probe file left behind'
    Check (-not (Test-Path -LiteralPath $FakeClaudallyDir)) 'the agent folder was not created (a preflight changes nothing)'
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
        @{ Name = 'token file cannot be locked down'; Env = $legacyRemoteEnv; Ignore = @('*'); Match = 'locked-down tunnel token file cannot be written' }
        @{ Name = 'tunnel service but no TUNNEL_TOKEN in .env'; Env = ($legacyRemoteEnv -replace "(?m)^TUNNEL_TOKEN=.*\r?\n", ''); Ignore = @(); Match = 'has no TUNNEL_TOKEN' }
    )
    foreach ($case in $tunnelCases) {
        Reset-Fakes; $script:FailuresBefore = $script:Failures
        $root = New-FakeInstall -EnvText $case.Env
        Add-FakeTask $AgentTask $Accountant $root
        $global:FrcServices[$Service] = 'Running'
        $global:FrcServices[$Tunnel]  = 'Running'
        Set-FakeServiceEnv $Tunnel @("TUNNEL_TOKEN=$TokenValue")
        $global:FrcAclIgnore = $case.Ignore
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
    Check ($envText -match "(?m)^AGENT_TASK_USER=`"$([regex]::Escape($Accountant))`"\s*$") 'and records the agent user'
    Show-OnFailure $r

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[9] Outside upgrade mode, passed values still win over .env (Reconfigure semantics)"
    Write-Host "    This is why the installer must pass nothing on an unattended upgrade."
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $localEnv
    Add-FakeTask $AgentTask $Accountant $root
    $r = Invoke-Firstrun @{ InstallDir = $root; Unattended = $true; TallyEdition = 'silver'; TallyExePath = 'C:\Program Files\TallyPrime\tally.exe'; AgentTaskUser = $runningUser; EnableGuiControl = 'true'; EntryOrder = ''; DeploymentMode = '' }
    Check ($null -eq $r.Error) 'completes'
    $envText = Get-Content -Raw -LiteralPath (Join-Path $root '.env')
    Check ($envText -match '(?m)^TALLY_EDITION=silver') 'edition overwritten by the passed value'
    Check ($envText -match '(?m)^DEPLOYMENT_MODE=local') 'mode still preserved (passed as empty, as the installer does)'
    Check ($envText -notmatch 'READONLY_MODE') 'keys the template does not know are dropped - so an upgrade must not rewrite .env'
    Show-OnFailure $r

    # ==========================================================================================
    # #230: .env, the company vault and the IPC directory are locked down by SID, verified, and a
    # lockdown that fails stops the run. (#229 follow-ups after that.)
    # ==========================================================================================
    $FreshPassword = 'fresh-install-pw-#230-not-real'
    function New-CredentialsFile {
        $p = Join-Path $work ('creds-' + [guid]::NewGuid().ToString('n').Substring(0, 6) + '.json')
        [System.IO.File]::WriteAllText($p, "{`"password`":`"$FreshPassword`"}", (New-Object System.Text.UTF8Encoding $false))
        return $p
    }
    # A fresh remote install with a tunnel, the way the wizard runs it: every secret this script can
    # write is in play (the OAuth password, the tunnel token).
    function Invoke-FreshRemote([string]$Root, [string]$Creds) {
        return Invoke-Firstrun @{ InstallDir = $Root; Unattended = $true; AgentTaskUser = $Accountant; DeploymentMode = 'remote'
                                  CredentialsFile = $Creds; TunnelToken = $TokenValue; McpDomain = 'https://client42.tally.example.com'; EnableGuiControl = 'true' }
    }

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[10] A .env that cannot be locked down is never written (fresh remote install)"
    $envFailModes = @(
        @{ Name = 'icacls fails';                               Fail = @('*\.env.tmp'); Ignore = @() }
        @{ Name = 'icacls exits 0 but the ACL did not change';  Fail = @();             Ignore = @('*\.env.tmp') }
    )
    foreach ($mode in $envFailModes) {
        Reset-Fakes; $script:FailuresBefore = $script:Failures
        $root = New-FakeInstall -EnvText ''
        $creds = New-CredentialsFile
        $global:FrcIcaclsFail = $mode.Fail; $global:FrcAclIgnore = $mode.Ignore
        $r = Invoke-FreshRemote $root $creds
        Check ($null -ne $r.Error -and "$($r.Error)" -match '\.env was NOT written') "$($mode.Name): the run FAILS, saying .env was not written"
        Check (-not (Test-Path -LiteralPath (Join-Path $root '.env')) -and -not (Test-Path -LiteralPath (Join-Path $root '.env.tmp'))) "$($mode.Name): no .env and no .env.tmp on disk"
        Check ((Find-Secret $root $FreshPassword).Count -eq 0 -and (Find-Secret $root $TokenValue).Count -eq 0) "$($mode.Name): neither the password nor the tunnel token is in any file under the install"
        Check (-not (Test-Path -LiteralPath $creds)) "$($mode.Name): the installer's credentials file was still shredded"
        Check (@(NssmLog).Count -eq 0 -and @(Calls 'Register-ScheduledTask').Count -eq 0) "$($mode.Name): nothing registered - the run stopped there"
        Check (-not (Test-Path -LiteralPath (Join-Path $root 'data\.tally-mcp-companies.json'))) "$($mode.Name): the vault was not created either"
        Show-OnFailure $r
    }

    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $legacyRemoteEnv
    Add-FakeTask $AgentTask $Accountant $root
    $before = Get-FileHashText (Join-Path $root '.env')
    $global:FrcIcaclsFail = @('*\.env.tmp')
    $r = Invoke-Firstrun @{ InstallDir = $root; Unattended = $true; TallyEdition = 'gold' }
    Check ($null -ne $r.Error -and "$($r.Error)" -match '\.env was NOT written') 'Reconfigure: the run FAILS when the new .env cannot be locked down'
    Check ((Get-FileHashText (Join-Path $root '.env')) -eq $before) 'Reconfigure: the existing .env is exactly as it was (the change was not written anywhere)'
    Show-OnFailure $r

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[11] On a Windows where no account NAME maps (as 'Administrators' on a localised one), a full install still locks everything down"
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText ''
    $dataDir = Join-Path $root 'data'
    $r = Invoke-FreshRemote $root (New-CredentialsFile)
    Check ($null -eq $r.Error) 'completes without error'
    Check ($global:FrcIcaclsNames.Count -eq 0) 'no account was ever passed to icacls by name (every name would have failed here)'
    $fileAcl = "protected=True owner=S-1-5-32-544 $(@("S-1-5-18:FA", "S-1-5-32-544:FA", "${AccountantSid}:FA") | Sort-Object)"
    Check ((Get-FrcAclText (Join-Path $root '.env.tmp')) -eq $fileAcl) '.env (locked as .env.tmp before a byte was written, then renamed): SYSTEM, Administrators and the agent user only, inheritance off'
    Check ((Get-FrcAclText $FakeClaudallyDir) -eq "protected=True owner=S-1-5-32-544 S-1-5-18:FA:OICI S-1-5-32-544:FA:OICI") '%ProgramData%\Claudally: SYSTEM and Administrators only, owned by Administrators (Users can no longer create anything in it)'
    Check ((Get-FrcAclText $FakeAgentDir) -eq "protected=True owner=S-1-5-32-544 $(@("S-1-5-18:FA:OICI", "S-1-5-32-544:FA:OICI", "${AccountantSid}:FA:OICI") | Sort-Object)") 'agent folder: SYSTEM, Administrators and the agent user, (OI)(CI) so the IPC files inherit it, owned by Administrators'
    Check ((Get-FrcAclText (Join-Path $FakeAgentDir '.tally-mcp-companies.json')) -eq $fileAcl) 'company vault, in the agent folder: SYSTEM, Administrators and the agent user only, inheritance off'
    Check ($global:FrcLockedAtSize[(Join-Path $FakeAgentDir '.tally-mcp-companies.json').ToLowerInvariant()] -eq 0) 'the vault was locked while still empty'
    Check (-not (Test-Path -LiteralPath (Join-Path $dataDir '.tally-mcp-companies.json')) -and @(Calls 'icacls' | Where-Object { $_.Target -like "$dataDir*" }).Count -eq 0) "nothing written to or re-permissioned in Tally's data folder"
    Check ((Get-FrcAclText (Join-Path $root '.tunnel-token')) -eq "protected=True owner=S-1-5-32-544 S-1-5-18:FA S-1-5-32-544:FA") 'tunnel token file: SYSTEM and Administrators only, owned by Administrators'
    $envText = Get-Content -Raw -LiteralPath (Join-Path $root '.env')
    Check ($envText -match [regex]::Escape("PASSWORD=`"$FreshPassword`"") -and $envText -match 'DEPLOYMENT_MODE=remote') '.env was written, with the password'
    Check (-not (Test-Path -LiteralPath (Join-Path $root '.env.tmp'))) 'no .env.tmp left behind'
    Show-OnFailure $r

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[12] The vault and the agent folder fail closed too"
    $otherFails = @(
        @{ Name = 'vault: icacls exits 0 but nothing changed'; Ignore = @('*\.tally-mcp-companies.json'); Fail = @(); Match = 'company password vault .* could not be moved or locked down' }
        @{ Name = 'agent folder: icacls fails';                Ignore = @(); Fail = @('*\Claudally\agent'); Match = 'Claudally agent folder .* could not be set up' }
    )
    foreach ($case in $otherFails) {
        Reset-Fakes; $script:FailuresBefore = $script:Failures
        $root = New-FakeInstall -EnvText ''
        $global:FrcAclIgnore = $case.Ignore; $global:FrcIcaclsFail = $case.Fail
        $r = Invoke-Firstrun @{ InstallDir = $root; Unattended = $true; AgentTaskUser = $Accountant }
        Check ($null -ne $r.Error -and "$($r.Error)" -match $case.Match) "$($case.Name): the run FAILS and names it"
        Check (@(Calls 'Register-ScheduledTask').Count -eq 0) "$($case.Name): nothing registered after it"
        Check (-not (Test-Path -LiteralPath (Join-Path $FakeAgentDir '.tally-mcp-companies.json'))) "$($case.Name): no vault is left behind that was not locked down"
        Show-OnFailure $r
    }

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[13] Upgrade: the preflight finds a lockdown that would fail before anything is stopped"
    $preflightCases = @(
        @{ Name = 'the agent folder cannot be locked down'; Env = $localEnv; Fail = @('*\ProgramData\.tally-mcp-acl.preflight'); Match = 'cannot be locked down to SYSTEM, Administrators' }
        @{ Name = 'the agent user does not resolve to a SID'; Env = ($localEnv -replace "(?m)^AGENT_TASK_USER=.*$", 'AGENT_TASK_USER="no-such-user-230"'); Fail = @(); Match = "'no-such-user-230' does not resolve" }
    )
    foreach ($case in $preflightCases) {
        Reset-Fakes; $script:FailuresBefore = $script:Failures
        $root = New-FakeInstall -EnvText $case.Env
        $global:FrcIcaclsFail = $case.Fail
        $report = Join-Path $work ('preflight-acl-' + [guid]::NewGuid().ToString('n').Substring(0, 6) + '.txt')
        $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; PreflightOnly = $true; ReportFile = $report }
        Check ($r.ExitCode -eq 1 -and (Get-Content -Raw -LiteralPath $report) -match $case.Match) "$($case.Name): preflight refuses (Setup exits 7) and says why"
        Check (@(NssmLog).Count -eq 0 -and @(Calls 'Register-ScheduledTask').Count -eq 0 -and
               @(Calls 'icacls' | Where-Object { $_.Target -notlike '*.preflight' }).Count -eq 0) "$($case.Name): nothing stopped, registered or re-permissioned"
        Check (@(Get-ChildItem -LiteralPath $root, $FakeProgramData -Recurse -Force -Filter '*.preflight').Count -eq 0) "$($case.Name): no probe file left behind"
        Show-OnFailure $r
    }

    # The preflight passed, then the real lockdown fails after the copy: exit 10, .env untouched.
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $legacyRemoteEnv
    Add-FakeTask $AgentTask $Accountant $root
    $global:FrcServices[$Service] = 'Running'
    $before = Get-FileHashText (Join-Path $root '.env')
    $global:FrcAclIgnore = @('*\.env')
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; Unattended = $true }
    Check ($null -ne $r.Error -and "$($r.Error)" -match '\.env could not be locked down') 'upgrade: a .env lockdown that fails after the copy FAILS the run (Setup exits 10)'
    Check ((Get-FileHashText (Join-Path $root '.env')) -eq $before) 'upgrade: .env untouched'
    Show-OnFailure $r

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[14] A machine-wide TUNNEL_TOKEN is reported loudly, and left in place (#229 follow-up)"
    foreach ($case in @(@{ Name = 'same token'; Value = $TokenValue; Match = 'same token as this install' },
                        @{ Name = 'another token'; Value = 'eyJvdGhlci10dW5uZWwtdG9rZW4ifQ=='; Match = 'THAT token' })) {
        Reset-Fakes; $script:FailuresBefore = $script:Failures
        $root = New-FakeInstall -EnvText $legacyRemoteEnv
        Add-FakeTask $AgentTask $Accountant $root
        $global:FrcServices[$Service] = 'Running'
        $global:FrcServices[$Tunnel]  = 'Running'
        Set-FakeMachineEnv 'TUNNEL_TOKEN' $case.Value
        $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; Unattended = $true }
        Check ($null -eq $r.Error) "$($case.Name): the run still completes (nothing here can fix it; failing would only make every upgrade roll back)"
        Check ($r.Output -match 'SECURITY: a machine-wide TUNNEL_TOKEN' -and $r.Output -match $case.Match) "$($case.Name): reported, saying what it means"
        Check ((Get-FakeMachineEnv 'TUNNEL_TOKEN') -ceq $case.Value) "$($case.Name): the variable is NOT deleted"
        Check (($r.Output.IndexOf($TokenValue) -lt 0) -and ($r.Output.IndexOf($case.Value) -lt 0)) "$($case.Name): neither value is printed"
        Show-OnFailure $r
    }

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[15] Outside upgrade mode, a tunnel that cannot be registered fails the run (#229 follow-up)"
    foreach ($case in @(@{ Name = 'token file cannot be locked down'; Ignore = @('*\.tunnel-token'); NoCloudflared = $false; Match = 'Could not write a locked-down tunnel token file' },
                        @{ Name = 'cloudflared.exe is missing';        Ignore = @();                    NoCloudflared = $true;  Match = 'cloudflared.exe is not at' })) {
        Reset-Fakes; $script:FailuresBefore = $script:Failures
        $root = New-FakeInstall -EnvText $legacyRemoteEnv
        Add-FakeTask $AgentTask $Accountant $root
        $global:FrcServices[$Tunnel] = 'Running'
        if ($case.NoCloudflared) { Remove-Item -LiteralPath (Join-Path $root 'bin\cloudflared.exe') -Force }
        $global:FrcAclIgnore = $case.Ignore
        $r = Invoke-Firstrun @{ InstallDir = $root; Unattended = $true }
        Check ($null -ne $r.Error -and "$($r.Error)" -match "'$Tunnel' service could not be registered") "$($case.Name): the run FAILS (non-zero), not just an [ERROR] line and exit 0"
        Check ($r.Output -match [regex]::Escape($case.Match) -and $r.Output -match 'Configuration INCOMPLETE' -and $r.Output -notmatch 'Configuration complete') "$($case.Name): says why, and does not claim the configuration is complete"
        Check (@(NssmLog | Where-Object { $_ -like "install | $Tunnel | *" }).Count -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $root '.tunnel-token'))) "$($case.Name): no tunnel registered, no token file left"
        Check (@(Calls 'Register-ScheduledTask' | Where-Object { $_.Target -eq $AgentTask }).Count -eq 1) "$($case.Name): the rest of the install was still configured first"
        Show-OnFailure $r
    }


    # ==========================================================================================
    # Tally's data folder is Tally's (#237 owner decision): our files move out to
    # %ProgramData%\Claudally\agent, the vault is migrated without a readable copy, and the
    # permissions earlier versions took from Tally's folder are given back.
    # ==========================================================================================
    $DpapiHelper = Join-Path (Split-Path -Parent $PSScriptRoot) 'dpapi-helper.ps1'
    function Invoke-Dpapi([string]$Action, [string]$Text) {
        $out = $Text | & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $DpapiHelper -Action $Action
        return ("$out").Trim()
    }
    $ace = { param($Sid, $Rights = 'FA') @{ Sid = $Sid; Rights = $Rights; Inherit = $true; Inherited = $false } }
    $OtherTallyUser = 'S-1-5-21-1111-2222-3333-4444'    # another Windows account someone granted by hand
    # What every installer up to #230 left on Tally's data folder: inheritance off, and SYSTEM,
    # Administrators and the agent user with explicit Full Control (OI)(CI).
    $oldInstallerShape = @((& $ace 'S-1-5-18'), (& $ace 'S-1-5-32-544'), (& $ace $AccountantSid))

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[17] Upgrade moves the vault out of Tally's data folder with no readable copy, and it still decrypts"
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $legacyRemoteEnv
    $dataDir = Join-Path $root 'data'
    Add-FakeTask $AgentTask $Accountant $root
    $global:FrcServices[$Service] = 'Running'
    $companyPassword = 'Tally-company-pw-#17-not-real'
    $blob = Invoke-Dpapi 'encrypt' $companyPassword
    $oldVault = Join-Path $dataDir '.tally-mcp-companies.json'
    $vaultJson = "{`"schemaVersion`":1,`"companies`":[{`"alias`":`"main`",`"folderId`":`"10000`",`"username`":`"owner`",`"passwordEnc`":`"$blob`"}]}"
    [System.IO.File]::WriteAllText($oldVault, $vaultJson, (New-Object System.Text.UTF8Encoding $false))
    [System.IO.File]::WriteAllText("$oldVault.pre-entropy-backup", 'pre-entropy-backup-bytes', (New-Object System.Text.UTF8Encoding $false))
    [System.IO.File]::WriteAllText("$oldVault.tmp", $vaultJson, (New-Object System.Text.UTF8Encoding $false))
    $stalePassword = 'stale-plaintext-pw-#17'
    foreach ($n in @('_mcp_gui_command.json', '_mcp_gui_command.json.tmp.123.456', '_mcp_gui_result.json', '_mcp_screenshot.png')) {
        [System.IO.File]::WriteAllText((Join-Path $dataDir $n), "{`"password`":`"$stalePassword`"}", (New-Object System.Text.UTF8Encoding $false))
    }
    $oldBytes = [System.IO.File]::ReadAllBytes($oldVault)
    Set-FrcAcl -Path $dataDir -Protected $true -Aces (@($oldInstallerShape) + @((& $ace $OtherTallyUser 'FR')))
    $before = Get-FileHashText (Join-Path $root '.env')
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; Unattended = $true }
    Check ($null -eq $r.Error) 'completes without error'
    $newVault = Join-Path $FakeAgentDir '.tally-mcp-companies.json'
    Check ((Test-Path -LiteralPath $newVault) -and [System.Linq.Enumerable]::SequenceEqual([byte[]][System.IO.File]::ReadAllBytes($newVault), [byte[]]$oldBytes)) 'the vault is in the agent folder, byte for byte'
    $moved = $null
    try { $moved = (Get-Content -Raw -LiteralPath $newVault | ConvertFrom-Json).companies[0].passwordEnc } catch { $moved = $null }
    Check ($moved -and (Invoke-Dpapi 'decrypt' $moved) -ceq $companyPassword) 'the stored company password still decrypts from the new location (DPAPI LocalMachine + the fixed entropy)'
    Check ($global:FrcLockedAtSize[$newVault.ToLowerInvariant()] -eq 0) 'the new vault was locked while it was still empty: no readable copy at any point'
    Check ((Get-FrcAclText $newVault) -eq "protected=True owner=S-1-5-32-544 $(@("S-1-5-18:FA", "S-1-5-32-544:FA", "${AccountantSid}:FA") | Sort-Object)") 'and is SYSTEM, Administrators and the agent user only'
    Check (-not (Test-Path -LiteralPath $oldVault) -and -not (Test-Path -LiteralPath "$oldVault.tmp") -and -not (Test-Path -LiteralPath "$oldVault.pre-entropy-backup")) "the old vault, its partial .tmp and its pre-entropy backup are gone from Tally's folder"
    Check ((Test-Path -LiteralPath "$newVault.pre-entropy-backup") -and ([System.IO.File]::ReadAllText("$newVault.pre-entropy-backup") -ceq 'pre-entropy-backup-bytes')) 'the pre-entropy backup moved the same way'
    Check (@(Get-ChildItem -LiteralPath $dataDir -Force -File | Where-Object { $_.Name -like '_mcp_*' }).Count -eq 0) "the stale IPC files in Tally's folder are gone"
    Check ((Find-Secret $root $stalePassword).Count -eq 0 -and (Find-Secret $root $blob).Count -eq 0) "neither the stale IPC password nor the vault's blob is left in any file under the install"
    $m = _FrcAclOf $dataDir
    $explicit = @($m.Aces | Where-Object { -not $_.Inherited } | ForEach-Object { $_.Sid } | Sort-Object)
    Check (-not $m.Protected) "Tally's data folder inherits its permissions again"
    Check (($explicit -join ',') -eq ((@($AccountantSid, $OtherTallyUser) | Sort-Object) -join ',')) "only the explicit SYSTEM and Administrators grants the old installer added were removed (inheritance gives them the same); the agent user's and the hand-added grant are kept"
    Check ($r.Output -match 'Re-enabled permission inheritance on Tally data folder' -and $r.Output -match 'Removed the explicit Full Control entry for') 'says what it restored'
    Check ((Get-FileHashText (Join-Path $root '.env')) -eq $before) '.env unchanged'
    Show-OnFailure $r

    # Both copies exist and differ: the one in the agent folder stays; the old one still leaves Tally's folder.
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $localEnv
    $dataDir = Join-Path $root 'data'
    Add-FakeTask $AgentTask $Accountant $root
    New-Item -ItemType Directory -Force -Path $FakeAgentDir | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $FakeAgentDir '.tally-mcp-companies.json'), '{"schemaVersion":1,"companies":[],"which":"new"}')
    [System.IO.File]::WriteAllText((Join-Path $dataDir '.tally-mcp-companies.json'), '{"schemaVersion":1,"companies":[],"which":"old"}')
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; Unattended = $true }
    Check ($null -eq $r.Error) 'conflict: completes'
    Check ((Get-Content -Raw -LiteralPath (Join-Path $FakeAgentDir '.tally-mcp-companies.json')) -match '"which":"new"') 'conflict: the vault the server reads is kept'
    $aside = @(Get-ChildItem -LiteralPath $FakeAgentDir -Force -Filter '.tally-mcp-companies.json.from-tally-data-folder-*')
    Check ($aside.Count -eq 1 -and (Get-Content -Raw -LiteralPath $aside[0].FullName) -match '"which":"old"' -and -not (Test-Path -LiteralPath (Join-Path $dataDir '.tally-mcp-companies.json'))) 'conflict: the old one is moved in beside it, locked, not left in Tally''s folder'
    Check ($r.Output -match 'differs from') 'conflict: and says so'
    Show-OnFailure $r

    # The move fails part-way (the new file cannot be locked): the run stops, and the old vault is untouched.
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $localEnv
    $dataDir = Join-Path $root 'data'
    Add-FakeTask $AgentTask $Accountant $root
    [System.IO.File]::WriteAllText((Join-Path $dataDir '.tally-mcp-companies.json'), $vaultJson)
    $oldHash = Get-FileHashText (Join-Path $dataDir '.tally-mcp-companies.json')
    Set-FrcAcl -Path $dataDir -Protected $true -Aces $oldInstallerShape
    $global:FrcAclIgnore = @('*\Claudally\agent\.tally-mcp-companies.json')
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; Unattended = $true }
    Check ($null -ne $r.Error -and "$($r.Error)" -match 'could not be moved or locked down') 'failed move: the run FAILS (Setup exits 10)'
    Check ((Get-FileHashText (Join-Path $dataDir '.tally-mcp-companies.json')) -eq $oldHash) 'failed move: the old vault is exactly as it was - nothing lost'
    Check (-not (Test-Path -LiteralPath (Join-Path $FakeAgentDir '.tally-mcp-companies.json'))) 'failed move: no unlocked copy left in the agent folder'
    Check ((_FrcAclOf $dataDir).Protected) "failed move: Tally's folder is not opened up while the vault is still in it"
    Show-OnFailure $r

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[18] Tally's data folder is only restored when it carries the old installer's fingerprint"
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $localEnv
    $dataDir = Join-Path $root 'data'
    Add-FakeTask $AgentTask $Accountant $root
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; Unattended = $true }
    Check ($null -eq $r.Error -and $r.Output -match 'already inherits its permissions; nothing to restore') 'never changed: a no-op, and says so'
    Check (@(Calls 'icacls' | Where-Object { $_.Target -eq $dataDir }).Count -eq 0) 'never changed: no icacls call on it at all'
    Show-OnFailure $r

    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $localEnv
    $dataDir = Join-Path $root 'data'
    Add-FakeTask $AgentTask $Accountant $root
    # Protected, but by someone else: SYSTEM and a named accountant, no Administrators entry.
    Set-FrcAcl -Path $dataDir -Protected $true -Aces @((& $ace 'S-1-5-18'), (& $ace $OtherTallyUser))
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; Unattended = $true }
    Check ($null -eq $r.Error) 'someone else''s shape: the run completes'
    Check ($r.Output -match 'not in the shape an earlier version of this installer left it') 'someone else''s shape: a warning, with the fix command'
    Check (@(Calls 'icacls' | Where-Object { $_.Target -eq $dataDir }).Count -eq 0 -and (_FrcAclOf $dataDir).Protected) 'someone else''s shape: left exactly as it is'
    Show-OnFailure $r

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[19] A folder planted in %ProgramData% is refused, not used; our own is taken back"
    $junctionTarget = Join-Path $work 'junction-target'
    $plantedCases = @(
        @{ Name = 'agent folder owned by another account'; Plant = { New-Item -ItemType Directory -Force -Path $FakeAgentDir | Out-Null; Set-FrcAcl -Path $FakeAgentDir -Owner $OtherTallyUser }; Match = 'owned by' }
        @{ Name = 'Claudally folder owned by another account'; Plant = { New-Item -ItemType Directory -Force -Path $FakeClaudallyDir | Out-Null; Set-FrcAcl -Path $FakeClaudallyDir -Owner $OtherTallyUser }; Match = 'owned by' }
        @{ Name = 'agent folder is a junction'; Plant = {
                New-Item -ItemType Directory -Force -Path $junctionTarget, $FakeClaudallyDir | Out-Null
                Set-Content -LiteralPath (Join-Path $junctionTarget 'marker.txt') -Value 'untouched'
                New-Item -ItemType Junction -Path $FakeAgentDir -Target $junctionTarget | Out-Null }; Match = 'junction or symbolic link' }
    )
    foreach ($case in $plantedCases) {
        Reset-Fakes; $script:FailuresBefore = $script:Failures
        $root = New-FakeInstall -EnvText ''
        & $case.Plant
        $r = Invoke-Firstrun @{ InstallDir = $root; Unattended = $true; AgentTaskUser = $Accountant }
        Check ($null -ne $r.Error -and "$($r.Error)" -match $case.Match) "$($case.Name): the run FAILS and says why"
        Check (@(Calls 'icacls' | Where-Object { $_.Target -like "$FakeClaudallyDir*" -or $_.Target -like "$junctionTarget*" }).Count -eq 0) "$($case.Name): nothing under it (or behind it) re-permissioned"
        Check (-not (Test-Path -LiteralPath (Join-Path $FakeAgentDir '.tally-mcp-companies.json')) -and @(Get-ChildItem -LiteralPath $junctionTarget -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'marker.txt' }).Count -eq 0) "$($case.Name): nothing written into it"
        Check (@(Calls 'Register-ScheduledTask').Count -eq 0) "$($case.Name): nothing registered"
        Show-OnFailure $r
    }

    # The same, found by the preflight before an upgrade stops anything.
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText $localEnv
    Add-FakeTask $AgentTask $Accountant $root
    New-Item -ItemType Directory -Force -Path $FakeAgentDir | Out-Null
    Set-FrcAcl -Path $FakeAgentDir -Owner $OtherTallyUser
    $report = Join-Path $work 'preflight-planted.txt'
    $r = Invoke-Firstrun @{ InstallDir = $root; Upgrade = $true; PreflightOnly = $true; ReportFile = $report }
    Check ($r.ExitCode -eq 1 -and (Get-Content -Raw -LiteralPath $report) -match 'owned by') 'preflight refuses a planted agent folder (Setup exits 7)'
    Check (@(Calls 'icacls').Count -eq 0) 'and touches nothing, not even a probe'
    Show-OnFailure $r

    # Ours, from a dev box: the agent user's tray created it. Taken back: owner Administrators, list reset.
    Reset-Fakes; $script:FailuresBefore = $script:Failures
    $root = New-FakeInstall -EnvText ''
    New-Item -ItemType Directory -Force -Path $FakeAgentDir | Out-Null
    Set-FrcAcl -Path $FakeAgentDir -Owner $AccountantSid -Aces @((& $ace $AccountantSid), (& $ace 'S-1-5-32-545' 'FR'))
    $r = Invoke-Firstrun @{ InstallDir = $root; Unattended = $true; AgentTaskUser = $Accountant }
    Check ($null -eq $r.Error) 'agent user''s own folder: completes'
    Check (@(Calls 'icacls' | Where-Object { $_.Target -eq $FakeAgentDir -and $_.Detail -eq '/setowner *S-1-5-32-544' }).Count -eq 1 -and (_FrcAclOf $FakeAgentDir).Owner -eq 'S-1-5-32-544') 'agent user''s own folder: taken back (owner Administrators)'
    Check ($r.Output -match 'Removed an extra permission entry for .*S-1-5-32-545') 'agent user''s own folder: the extra BUILTIN\Users entry removed, and named'
    Show-OnFailure $r

    # ------------------------------------------------------------------------------------------
    Write-Host "`n[16] Nothing outside the scratch folders was touched"
    Check ((Get-DefaultDataState) -eq $DefaultDataBefore) "the real default Tally data folder ($DefaultDataPath) was not created or changed"
    Check ((Test-Path -LiteralPath (Join-Path $RealProgramData 'Claudally')) -eq $RealClaudallyBefore) 'the real %ProgramData%\Claudally was not created or removed'
}
finally {
    Remove-Item Env:\FRC_NSSM_LOG -ErrorAction SilentlyContinue
    $env:ProgramData = $RealProgramData
    # Unlink any junction a case planted before the recursive delete, so it cannot follow one.
    foreach ($d in @($FakeAgentDir, $FakeClaudallyDir)) {
        if ((Test-Path -LiteralPath $d) -and ((Get-Item -LiteralPath $d -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            [System.IO.Directory]::Delete($d)
        }
    }
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Variable -Scope Global -Name FrcCalls, FrcTasks, FrcServices, FrcAcl, FrcAclSeed, FrcIcaclsFail, FrcAclIgnore, FrcIcaclsNames, FrcLockedAtSize -ErrorAction SilentlyContinue
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
