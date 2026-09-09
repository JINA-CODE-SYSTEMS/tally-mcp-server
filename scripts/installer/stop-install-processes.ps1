<#
.SYNOPSIS
    Stop processes belonging to THIS Tally MCP install, so an upgrade can replace its files.

.DESCRIPTION
    Shared by the installer's PrepareToInstall step and by uninstall-cleanup.ps1, because both
    need exactly the same question answered - "which running processes are ours?" - and answering
    it two different ways is how they drifted apart.

    WHAT WAS WRONG BEFORE (#172 C1):

    1. The installer used three `wmic process where ... delete` calls. wmic is a Feature-on-Demand
       that is ABSENT BY DEFAULT on Windows 11 24H2 and Server 2025, so on a current machine all
       three are silent no-ops: nothing is killed, the file-copy phase then hits a locked file, and
       the upgrade fails with a DeleteFile error that says nothing about a running process.

    2. Two of those filters matched any powershell.exe whose command line merely CONTAINED
       'tally-mcp' or 'TallyMCP' - anywhere, including another install, a support session, or an
       editor with the repo open. Too wide in one direction.

    3. The node.exe filter matched only '%server.mjs%', which is the REMOTE entrypoint. Local mode
       (#172) runs dist\index.mjs, so a local-mode server would have survived and locked the very
       files being replaced. Too narrow in the other direction.

    4. uninstall-cleanup.ps1 did `Get-Process -Name node | Stop-Process -Force`, killing every
       node.exe on the machine - the customer's editor, their build, anything.

    HOW OWNERSHIP IS DECIDED NOW: a process is ours if its executable lives under the install
    directory (which catches the bundled node.exe whatever entrypoint it runs), or if its command
    line references the install directory (which catches powershell.exe running our scripts, since
    its ExecutablePath is always System32 and can never identify it).

    EXCLUSIONS, both deliberate:
      - Anything under <install>\update is left alone. #177's updater orchestrator runs from there
        and must SURVIVE the install it is driving - it is what runs the rollback if the new build
        fails to start. Killing it would strand the machine with no way back.
      - This process and its parent, since our own command line necessarily contains the install
        directory and would otherwise match.

.PARAMETER InstallDir
    The install root. Processes under it, or naming it on their command line, are considered ours.

.PARAMETER WhatIf
    List what would be stopped and stop nothing.

.NOTES
    Windows PowerShell 5.1 compatible: no ternary, no ?? / ?., no classes. ASCII string literals
    only - 5.1 reads a BOM-less .ps1 as ANSI and mis-decodes UTF-8 bytes.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$InstallDir,
    [switch]$WhatIf
)

$ErrorActionPreference = 'SilentlyContinue'

$root = $InstallDir.TrimEnd('\')
if (-not $root) { Write-Host '[stop] no InstallDir given; nothing to do'; exit 0 }

# Trailing separator so a sibling directory cannot match as a prefix: without it, an install at
# C:\Program Files\TallyMCP would also claim processes from C:\Program Files\TallyMCP-old.
$rootWithSep = $root + '\'
$updateDir   = Join-Path $root 'update'

# Our own process and its parent name the install directory on their command lines, so they match
# the ownership test and would be killed mid-run.
$selfIds = @($PID)
try {
    $me = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
    if ($me -and $me.ParentProcessId) { $selfIds += [int]$me.ParentProcessId }
} catch { }

try {
    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
} catch {
    # No CIM at all is a genuinely broken box, but failing the whole install over it is worse than
    # letting the file copy report a locked file with its own (clearer) error.
    Write-Host "[stop] WARNING: could not query processes ($($_.Exception.Message)); skipping"
    exit 0
}

$targets = @()
foreach ($p in $all) {
    if ($selfIds -contains [int]$p.ProcessId) { continue }

    $exe = "$($p.ExecutablePath)"
    $cmd = "$($p.CommandLine)"

    $byExe = $exe -and $exe.StartsWith($rootWithSep, [System.StringComparison]::OrdinalIgnoreCase)
    $byCmd = $cmd -and ($cmd.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    if (-not ($byExe -or $byCmd)) { continue }

    # #177's updater must outlive the install it is driving.
    $inUpdate = ($exe -and $exe.StartsWith($updateDir + '\', [System.StringComparison]::OrdinalIgnoreCase)) -or
                ($cmd -and ($cmd.IndexOf($updateDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0))
    if ($inUpdate) {
        Write-Host ("[stop] leaving pid {0} ({1}) - runs from the update directory" -f $p.ProcessId, $p.Name)
        continue
    }

    $targets += $p
}

if ($targets.Count -eq 0) { Write-Host '[stop] no processes from this install are running'; exit 0 }

foreach ($t in $targets) {
    $why = 'command line'
    $exe = "$($t.ExecutablePath)"
    if ($exe -and $exe.StartsWith($rootWithSep, [System.StringComparison]::OrdinalIgnoreCase)) { $why = 'executable path' }
    if ($WhatIf) {
        Write-Host ("[stop] WHATIF pid {0} ({1}) - matched by {2}" -f $t.ProcessId, $t.Name, $why)
        continue
    }
    Write-Host ("[stop] stopping pid {0} ({1}) - matched by {2}" -f $t.ProcessId, $t.Name, $why)
    try { Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop }
    catch { Write-Host ("[stop] could not stop pid {0}: {1}" -f $t.ProcessId, $_.Exception.Message) }
}

exit 0
