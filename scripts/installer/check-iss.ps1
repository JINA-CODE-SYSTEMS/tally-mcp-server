<#
.SYNOPSIS
    Compile-checks tally-mcp.iss on every PR, without building a real installer.

.DESCRIPTION
    The installer's [Code] section is Pascal Script, and nothing in CI ever compiled it.
    That matters more than it sounds: ISCC is the only thing that will ever tell you a
    wizard page function is misspelled, that a {code:...} reference points at a function
    that no longer exists, or that the [Code] block does not compile at all. Until now the
    only compile happened on tag push in release.yml - long after review, and only if
    someone cut a release.

    A real compile needs a populated installer-staging/ (portable Node, nssm.exe,
    cloudflared.exe - tens of megabytes of downloads) plus a finished npm build. That is
    far too slow to run per-PR. So this script builds a throwaway tree of stub files at
    exactly the paths the .iss declares, points RepoRoot and StagingRoot at it with
    ISCC /D overrides, and compiles that. Everything except the file *contents* is real:
    the [Setup] directives, [Files], [Icons], [Run], [UninstallRun] and, crucially, the
    whole Pascal Script.

    What this deliberately does NOT catch: a Source: entry naming a file that does not
    exist in the repo, because the stub tree conjures every declared path into being. The
    release build is the check for that, and it is the right place for it - a missing
    source file is a packaging error, not a code error.

    Note the limit of any compiler here. ISCC has no bounds checking on the wizard pages'
    Values[] arrays, so reindexing a page's fields compiles clean and misreads the wrong
    input at runtime. That class of bug needs an index audit or a manual run; see
    docs/installer-manual-test.md.

.PARAMETER IssPath
    The .iss to check. Defaults to tally-mcp.iss beside this script.

.PARAMETER InnoSetupPath
    Path to ISCC.exe. Defaults to PATH, then the standard Inno Setup 6 install location.

.PARAMETER KeepTemp
    Leave the stub tree and ISCC output on disk for inspection instead of deleting them.

.EXAMPLE
    pwsh scripts\installer\check-iss.ps1
#>
[CmdletBinding()]
param(
    [string]$IssPath,
    [string]$InnoSetupPath,
    [switch]$KeepTemp
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if (-not $IssPath) { $IssPath = Join-Path $PSScriptRoot 'tally-mcp.iss' }
if (-not (Test-Path -LiteralPath $IssPath)) { throw "Not found: $IssPath" }
$IssPath = (Resolve-Path -LiteralPath $IssPath).Path

# --- Locate ISCC ---------------------------------------------------------------------
if (-not $InnoSetupPath) {
    $onPath = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($onPath) {
        $InnoSetupPath = $onPath.Source
    } else {
        $candidates = @(
            'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
            'C:\Program Files\Inno Setup 6\ISCC.exe'
        )
        foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { $InnoSetupPath = $c; break } }
    }
}
if (-not $InnoSetupPath) {
    throw "ISCC.exe not found. Install Inno Setup 6 (choco install innosetup) or pass -InnoSetupPath."
}
Write-Host "ISCC:       $InnoSetupPath"
Write-Host "Checking:   $IssPath"

# --- Build the stub tree -------------------------------------------------------------
$work        = Join-Path ([System.IO.Path]::GetTempPath()) ("iss-check-" + [guid]::NewGuid().ToString('n'))
$stubRepo    = Join-Path $work 'repo'
$stubStaging = Join-Path $work 'staging'
$outDir      = Join-Path $work 'out'
$null = New-Item -ItemType Directory -Path $stubRepo, $stubStaging, $outDir -Force

function New-Stub {
    param([string]$Target)

    if ($Target -match '[*?]') {
        # A wildcard source: ISCC fails outright if the directory matches no files, so the
        # directory must exist AND contain something.
        $dir = Split-Path -Parent $Target
        $null = New-Item -ItemType Directory -Path $dir -Force
        Set-Content -LiteralPath (Join-Path $dir 'stub.txt') -Value 'iss compile check stub' -Encoding ASCII
        return $dir
    }

    $dir = Split-Path -Parent $Target
    if ($dir) { $null = New-Item -ItemType Directory -Path $dir -Force }
    Set-Content -LiteralPath $Target -Value 'iss compile check stub' -Encoding ASCII
    return $Target
}

$stubbed = @()
$lines = Get-Content -LiteralPath $IssPath
foreach ($line in $lines) {
    $trimmed = $line.TrimStart()
    if ($trimmed.StartsWith(';')) { continue }          # commented-out entry
    $m = [regex]::Match($trimmed, '^(?:Source:\s*|LicenseFile\s*=\s*)"?([^";]+)"?')
    if (-not $m.Success) { continue }

    $src = $m.Groups[1].Value.Trim()
    if ($src -notmatch '^\{#(RepoRoot|StagingRoot)\}') { continue }   # relative to the .iss - real file

    $resolved = $src.Replace('{#RepoRoot}', $stubRepo).Replace('{#StagingRoot}', $stubStaging)
    $stubbed += (New-Stub -Target $resolved)
}

if ($stubbed.Count -eq 0) {
    throw "Parsed no Source: entries out of $IssPath - the parser and the .iss have drifted apart."
}
Write-Host "Stub tree:  $work  ($($stubbed.Count) path(s))"

# --- Compile -------------------------------------------------------------------------
# /O overrides OutputDir so nothing lands in the repo. The version is deliberately marked
# so that a stub build can never be mistaken for a release artifact.
$issccArgs = @(
    "/DRepoRoot=$stubRepo"
    "/DStagingRoot=$stubStaging"
    '/DMyAppVersion=0.0.0-iss-check'
    "/O$outDir"
    $IssPath
)
Write-Host ''
$output = & $InnoSetupPath @issccArgs 2>&1
$exit = $LASTEXITCODE
$output | ForEach-Object { Write-Host $_ }
Write-Host ''

if (-not $KeepTemp) {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "Kept: $work"
}

if ($exit -ne 0) { throw "ISCC failed with exit code $exit - the installer script does not compile." }

# ISCC exits 0 on warnings and hints, and those are the useful half of what it knows: an unused
# variable, an unreachable branch, a [Code] construct it had to guess at. The script compiles
# with none today, so failing on them costs nothing and keeps it that way. If a future warning
# is genuinely acceptable, silence it at the source rather than loosening this.
$warnings = @($output | Where-Object { "$_" -match '^\s*Warning:' })
if ($warnings.Count -gt 0) {
    Write-Host "ISCC reported $($warnings.Count) warning(s):"
    $warnings | ForEach-Object { Write-Host "::error::$_" }
    throw 'ISCC compiled with warnings - fix them at the source.'
}

Write-Host 'tally-mcp.iss compiles cleanly, with no warnings (Pascal Script included).'
