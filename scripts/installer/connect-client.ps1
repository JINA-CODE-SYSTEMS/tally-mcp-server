<#
.SYNOPSIS
    Point the user's MCP client at this Tally MCP install (issue #172, step C4).

.DESCRIPTION
    Local mode's entire promise is that the accountant never hand-edits JSON. This is the script
    that keeps it: it runs the client-config engine (src/client-config.mts -> dist/client-config.mjs)
    to MERGE an entry into claude_desktop_config.json, and leaves a result file the wizard and the
    tray can read back.

    IT MUST RUN AS THE PERSON WHO USES CLAUDE, NOT AS THE INSTALLING ADMIN.
    claude_desktop_config.json lives in %APPDATA%, which is per-user. The installer runs elevated,
    and on the common over-the-shoulder UAC path the elevated account is an admin who will never
    open Claude. Writing from there silently configures the WRONG profile, and the accountant sees
    no Tally tools with nothing anywhere explaining why. So this script refuses to guess: it writes
    for whoever is running it, and the installer reaches the right user by launching it through a
    scheduled task registered against AGENT_TASK_USER (see firstrun-config.ps1).

    Three routes, all landing here, all idempotent so running two of them is harmless:
      1. install time  - firstrun-config.ps1 launches it as AGENT_TASK_USER
      2. Start Menu    - "Connect Claude to Tally", for the very common case where Claude Desktop
                         is installed AFTER Claudally, or a second user needs connecting
      3. the tray      - same command, for a user who has already dismissed the installer

    Writing the entry when Claude Desktop is not installed yet is DELIBERATE, not a bug: the config
    is read at Claude's startup, so pre-writing it means "install Claude later" just works instead
    of requiring the user to come back and re-run anything.

.PARAMETER InstallDir
    The Tally MCP install root. Defaults to this script's grandparent.

.PARAMETER Target
    claude-desktop (default), vscode, or all. VS Code needs -Workspace.

.PARAMETER Workspace
    Workspace folder for the VS Code target (.vscode/mcp.json is per-project).

.PARAMETER Remove
    Remove our entry instead of adding it. Used by the uninstaller.

.PARAMETER Json
    Emit the raw JSON report instead of the human summary.

.NOTES
    Windows PowerShell 5.1 compatible; ASCII string literals only (5.1 reads a BOM-less .ps1 as
    ANSI and mis-decodes UTF-8).
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [ValidateSet('claude-desktop', 'vscode', 'all')]
    [string]$Target = 'claude-desktop',
    [string]$Workspace,
    [switch]$Remove,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

if (-not $InstallDir -or -not $InstallDir.Trim()) {
    $InstallDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
$InstallDir = $InstallDir.TrimEnd('\')

$cli = Join-Path $InstallDir 'dist\client-config.mjs'
if (-not (Test-Path -LiteralPath $cli)) {
    throw "client-config.mjs not found at $cli. Is InstallDir correct, and was the project built?"
}

# Use the BUNDLED runtime, never whatever node happens to be on PATH. The entry we write becomes the
# command Claude executes for the life of the install: pointing it at a system Node means the server
# stops working the day the user uninstalls or upgrades that unrelated Node, and on a machine with no
# Node at all it would never have worked. Fall back to PATH only when the bundle is absent, which is
# the from-source developer case rather than a customer one.
$bundledNode = Join-Path $InstallDir 'node-portable\node.exe'
if (-not (Test-Path -LiteralPath $bundledNode)) {
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if (-not $onPath) {
        throw "No Node runtime found: expected the bundled $bundledNode, and 'node' is not on PATH either."
    }
    $bundledNode = $onPath.Source
    Write-Host "[warn] bundled Node not found; falling back to $bundledNode (expected on a from-source install)"
}

$command = 'apply'
if ($Remove) { $command = 'remove' }

$cliArgs = @($cli, $command, '--target', $Target, '--install-root', $InstallDir, '--node', $bundledNode, '--json')
if ($Workspace) { $cliArgs += @('--workspace', $Workspace) }

# --allow-comment-loss is deliberately NOT passed. The engine refuses to rewrite a config carrying
# // comments rather than silently deleting a user's own notes, and that refusal must survive being
# wrapped: an installer that quietly destroys someone's annotated config is exactly the behaviour
# #172 says is not acceptable for the file-merging path. The refusal is reported below with the
# manual remedy instead.
$raw = & $bundledNode @cliArgs 2>&1
$exit = $LASTEXITCODE
$rawText = ($raw | Out-String).Trim()

$report = $null
try { $report = $rawText | ConvertFrom-Json } catch { }

# The result file goes to LOCALAPPDATA, not the install directory: this script runs as the ordinary
# user, who cannot write under Program Files. It is also the right trust domain - it describes files
# in this user's own profile.
$resultDir = Join-Path $env:LOCALAPPDATA 'Claudally'
$resultFile = Join-Path $resultDir 'last-connect-result.json'
try {
    New-Item -ItemType Directory -Force -Path $resultDir | Out-Null
    $payload = [ordered]@{
        schemaVersion = 1
        ranAt         = (Get-Date).ToString('o')
        ranAs         = "$env:USERDOMAIN\$env:USERNAME"
        installDir    = $InstallDir
        nodeUsed      = $bundledNode
        command       = $command
        exitCode      = $exit
        report        = $report
        rawOutput     = $(if ($report) { $null } else { $rawText })
    }
    ($payload | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $resultFile -Encoding UTF8
} catch {
    Write-Host "[warn] could not write $resultFile : $_"
}

if ($Json) { Write-Output $rawText; exit $exit }

# --- Human summary -------------------------------------------------------------------------------
Write-Host ""
Write-Host "Connect Claude to Tally" -ForegroundColor Cyan
Write-Host ("  running as : {0}\{1}" -f $env:USERDOMAIN, $env:USERNAME)
Write-Host ("  install    : {0}" -f $InstallDir)
Write-Host ""

if (-not $report) {
    Write-Host "[FAIL] The client-config tool did not return a readable result." -ForegroundColor Red
    if ($rawText) { Write-Host $rawText }
    Write-Host ("  Details saved to {0}" -f $resultFile)
    exit $(if ($exit -eq 0) { 1 } else { $exit })
}

$anyWrote = $false
$anyBlocked = $false
foreach ($r in @($report.results)) {
    if ($r.skipped) {
        Write-Host ("[skip] {0}: {1}" -f $r.target, $r.skipped)
        continue
    }
    if ($r.note) {
        $anyBlocked = $true
        Write-Host ("[STOP] {0}" -f $r.target) -ForegroundColor Yellow
        Write-Host ("       {0}" -f $r.note) -ForegroundColor Yellow
        Write-Host ("       Nothing was changed. Your file is at: {0}" -f $r.file) -ForegroundColor Yellow
        continue
    }
    if ($r.state -eq 'hijacked') {
        $anyBlocked = $true
        Write-Host ("[STOP] {0}: an entry under our name already exists and points somewhere else." -f $r.target) -ForegroundColor Yellow
        Write-Host ("       Left untouched so nothing of yours is overwritten: {0}" -f $r.file) -ForegroundColor Yellow
        continue
    }
    if ($r.wrote) {
        $anyWrote = $true
        Write-Host ("[OK]   {0}: updated {1}" -f $r.target, $r.file) -ForegroundColor Green
        if ($r.backup) { Write-Host ("       backup: {0}" -f $r.backup) }
    } else {
        Write-Host ("[OK]   {0}: already configured, nothing to change" -f $r.target) -ForegroundColor Green
    }
}

Write-Host ""
if ($anyBlocked) {
    Write-Host "Some targets need a manual step - see above." -ForegroundColor Yellow
} elseif ($Remove) {
    Write-Host "Claude will no longer see this Tally server." -ForegroundColor Green
} elseif ($anyWrote) {
    # The restart is not optional and not obvious: Claude Desktop reads this file once at startup,
    # so a user who leaves it running sees no Tally tools and concludes the install failed.
    Write-Host "Done. Now QUIT Claude Desktop COMPLETELY and reopen it -" -ForegroundColor Green
    Write-Host "closing the window is not enough; use File > Exit, or the tray icon." -ForegroundColor Green
    Write-Host "Tally tools appear once it restarts." -ForegroundColor Green
} else {
    Write-Host "Already connected. Nothing needed doing." -ForegroundColor Green
}
Write-Host ""
Write-Host ("Result saved to {0}" -f $resultFile) -ForegroundColor DarkGray

exit $exit
