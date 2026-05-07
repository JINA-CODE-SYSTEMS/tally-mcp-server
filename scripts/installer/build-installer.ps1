<#
.SYNOPSIS
    Builds TallyMCP-Setup-<version>.exe from a clean source tree (issue #18).

.DESCRIPTION
    Orchestrates the installer build:
        1. npm install + npm run build (so dist/ is fresh)
        2. Compile TallyUI.dll from TallyUI.cs (so the installer ships a prebuilt DLL)
        3. Stage portable Node.js + nssm.exe under ./installer-staging/ (downloaded
           if -DownloadDeps is passed; otherwise expects them to already be there)
        4. Invoke ISCC.exe on scripts/installer/tally-mcp.iss
        5. Output is ./dist-installer/TallyMCP-Setup-<version>.exe

    Run from the repo root in an admin PowerShell (admin needed only if you
    download deps to Program Files; default uses CWD).

.PARAMETER NodeVersion
    Portable Node version to bundle. Default 20.18.1 (current LTS as of writing).
    Bump along with package.json's engines.node when the project moves up.

.PARAMETER NssmVersion
    NSSM version to bundle. Default 2.24.

.PARAMETER DownloadDeps
    If set, downloads portable Node + NSSM into installer-staging/. Skip if you've
    already populated that directory (e.g. on an air-gapped build box).

.PARAMETER SkipBuild
    Skip npm install + build. Use when iterating just on the installer config.

.PARAMETER InnoSetupPath
    Override the path to ISCC.exe. Default checks PATH then the standard install location.

.EXAMPLE
    .\scripts\installer\build-installer.ps1 -DownloadDeps
    Full build from a clean clone, including dependency downloads.

.EXAMPLE
    .\scripts\installer\build-installer.ps1 -SkipBuild
    Re-run just the .iss compile after tweaking the wizard.
#>
[CmdletBinding()]
param(
    [string]$NodeVersion   = '20.18.1',
    [string]$NssmVersion   = '2.24',
    [switch]$DownloadDeps,
    [switch]$SkipBuild,
    [string]$InnoSetupPath = $null
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot

$staging = Join-Path $repoRoot 'installer-staging'
$nodeStaging = Join-Path $staging 'node-portable'
New-Item -ItemType Directory -Force -Path $staging, $nodeStaging | Out-Null

# --- 1. Build the TS project (unless skipped) -----------------------------
if (-not $SkipBuild) {
    Write-Host "==> npm install" -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

    Write-Host "==> npm run build" -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

    # Compile TallyUI.dll so the installer ships a ready-to-load DLL (clients don't need csc.exe).
    $cscPath = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (Test-Path $cscPath) {
        Write-Host "==> Compiling TallyUI.dll" -ForegroundColor Cyan
        & $cscPath /nologo /target:library /reference:System.Drawing.dll `
            /out:scripts\TallyUI.dll scripts\TallyUI.cs
        if ($LASTEXITCODE -ne 0) { throw "TallyUI.dll compile failed" }
    } else {
        Write-Warning "csc.exe not found at $cscPath - skipping TallyUI.dll compile. The installer will package a stale DLL if one exists."
    }
} else {
    Write-Host "==> Build skipped (-SkipBuild)" -ForegroundColor DarkGray
}

# --- 2. Stage portable Node.js -------------------------------------------
if ($DownloadDeps) {
    $nodeZip  = Join-Path $staging "node-v$NodeVersion-win-x64.zip"
    $nodeUrl  = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
    if (-not (Test-Path $nodeZip)) {
        Write-Host "==> Downloading Node.js portable v$NodeVersion" -ForegroundColor Cyan
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip
    }
    Write-Host "==> Expanding Node.js into $nodeStaging" -ForegroundColor Cyan
    Get-ChildItem -Path $nodeStaging -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $nodeZip -DestinationPath $staging -Force
    # Zip extracts to ./node-v<ver>-win-x64/ - flatten into node-portable/
    $extracted = Join-Path $staging "node-v$NodeVersion-win-x64"
    if (Test-Path $extracted) {
        Get-ChildItem -Path $extracted | Move-Item -Destination $nodeStaging -Force
        Remove-Item -Path $extracted -Recurse -Force
    }
}
if (-not (Test-Path (Join-Path $nodeStaging 'node.exe'))) {
    throw "node.exe not found in $nodeStaging. Re-run with -DownloadDeps, or place a portable Node distribution there manually."
}

# --- 3. Stage NSSM ---------------------------------------------------------
$nssmTarget = Join-Path $staging 'nssm.exe'
if ($DownloadDeps) {
    $nssmZip = Join-Path $staging "nssm-$NssmVersion.zip"
    $nssmUrl = "https://nssm.cc/release/nssm-$NssmVersion.zip"
    if (-not (Test-Path $nssmZip)) {
        Write-Host "==> Downloading NSSM v$NssmVersion" -ForegroundColor Cyan
        Invoke-WebRequest -Uri $nssmUrl -OutFile $nssmZip
    }
    $nssmExtracted = Join-Path $staging "nssm-$NssmVersion"
    if (-not (Test-Path $nssmExtracted)) {
        Expand-Archive -Path $nssmZip -DestinationPath $staging -Force
    }
    $nssm64 = Join-Path $nssmExtracted 'win64\nssm.exe'
    if (-not (Test-Path $nssm64)) { throw "Expected $nssm64 after extraction" }
    Copy-Item -Path $nssm64 -Destination $nssmTarget -Force
}
if (-not (Test-Path $nssmTarget)) {
    throw "nssm.exe not found at $nssmTarget. Re-run with -DownloadDeps, or place nssm.exe (x64) there manually."
}

# --- 4. Locate ISCC.exe ---------------------------------------------------
if (-not $InnoSetupPath) {
    $candidate = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($candidate) {
        $InnoSetupPath = $candidate.Source
    } elseif (Test-Path 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe') {
        $InnoSetupPath = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
    } else {
        throw "ISCC.exe not found. Install Inno Setup 6 from https://jrsoftware.org/isdl.php and re-run, or pass -InnoSetupPath."
    }
}
Write-Host "==> Using ISCC.exe: $InnoSetupPath" -ForegroundColor Cyan

# --- 5. Compile the installer --------------------------------------------
$iss = Join-Path $repoRoot 'scripts\installer\tally-mcp.iss'
Write-Host "==> Compiling $iss" -ForegroundColor Cyan
& $InnoSetupPath $iss
if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit $LASTEXITCODE" }

$out = Get-ChildItem -Path (Join-Path $repoRoot 'dist-installer') -Filter 'TallyMCP-Setup-*.exe' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if ($out) {
    Write-Host ""
    Write-Host "Installer ready: $($out.FullName)" -ForegroundColor Green
    Write-Host "Size: $([math]::Round($out.Length / 1MB, 1)) MB"
} else {
    Write-Warning "ISCC reported success but no installer found in dist-installer/"
}
