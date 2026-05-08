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
        # Any running agent has TallyUI.dll loaded via Add-Type, which takes an exclusive read lock
        # on Windows. csc.exe can't overwrite the file while that lock exists. Stop the agent first;
        # the operator can restart it after the build (or the at-logon task picks it up next login).
        $agentTaskName = 'TallyMCPAgent'
        $stoppedAny = $false
        try { & schtasks /End /TN $agentTaskName 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $stoppedAny = $true } } catch {}
        try {
            Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -and $_.CommandLine -like '*tally-gui-agent-v2.ps1*' } |
                ForEach-Object {
                    Write-Host "    Stopping running agent (pid=$($_.ProcessId)) so TallyUI.dll can be replaced..." -ForegroundColor DarkGray
                    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
                    $stoppedAny = $true
                }
        } catch {}
        if ($stoppedAny) { Start-Sleep -Seconds 2 }

        # Compile to a temp file then atomic-rename, so a future locked-DLL race doesn't leave us with
        # a half-written DLL. (Tracks the deploy.yml pattern.)
        $finalDll = Join-Path $repoRoot 'scripts\TallyUI.dll'
        $tempDll  = "$finalDll.new"
        Write-Host "==> Compiling TallyUI.dll" -ForegroundColor Cyan
        & $cscPath /nologo /target:library /reference:System.Drawing.dll `
            /out:$tempDll scripts\TallyUI.cs
        if ($LASTEXITCODE -ne 0) { throw "TallyUI.dll compile failed" }
        Move-Item -Force -LiteralPath $tempDll -Destination $finalDll

        if ($stoppedAny) {
            Write-Host "    Agent was stopped to release the DLL lock. Restart it manually after the build:" -ForegroundColor DarkYellow
            Write-Host "      schtasks /Run /TN $agentTaskName" -ForegroundColor DarkGray
            Write-Host "      (or relaunch tally-gui-agent-v2.ps1 in your interactive session)" -ForegroundColor DarkGray
        }
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
# nssm.cc is frequently flaky (502/503). We try the primary URL first with retries, then fall back
# to a known-good mirror on web.archive.org. If neither works, the operator can drop nssm.exe
# (x64) into installer-staging/ manually and re-run without -DownloadDeps.
$nssmTarget = Join-Path $staging 'nssm.exe'
if ($DownloadDeps) {
    $nssmZip = Join-Path $staging "nssm-$NssmVersion.zip"
    $nssmUrls = @(
        "https://nssm.cc/release/nssm-$NssmVersion.zip",
        "https://web.archive.org/web/2024/https://nssm.cc/release/nssm-$NssmVersion.zip"
    )
    if (-not (Test-Path $nssmZip)) {
        $downloaded = $false
        foreach ($url in $nssmUrls) {
            for ($attempt = 1; $attempt -le 3; $attempt++) {
                Write-Host "==> Downloading NSSM v$NssmVersion (attempt $attempt) from $url" -ForegroundColor Cyan
                try {
                    Invoke-WebRequest -Uri $url -OutFile $nssmZip -ErrorAction Stop
                    $downloaded = $true
                    break
                } catch {
                    Write-Warning "  download failed: $($_.Exception.Message)"
                    if ($attempt -lt 3) { Start-Sleep -Seconds (3 * $attempt) }
                }
            }
            if ($downloaded) { break }
        }
        if (-not $downloaded) {
            throw "Could not download NSSM from any source. Manual workaround: download nssm.exe (x64) from any reliable source (e.g. chocolatey: 'choco install nssm', or scoop: 'scoop install nssm'), copy it to '$nssmTarget', then re-run this script WITHOUT -DownloadDeps."
        }
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
    throw "nssm.exe not found at $nssmTarget. Re-run with -DownloadDeps, or place nssm.exe (x64) there manually (e.g. via 'choco install nssm' then copy)."
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
