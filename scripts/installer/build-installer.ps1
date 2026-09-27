<#
.SYNOPSIS
    Builds Claudally-Setup-<version>.exe from a clean source tree (issue #18).

.DESCRIPTION
    Orchestrates the installer build:
        1. npm install + npm run build (so dist/ is fresh)
        2. Compile TallyUI.dll from TallyUI.cs (so the installer ships a prebuilt DLL)
        3. Stage portable Node.js, nssm.exe and cloudflared.exe under ./installer-staging/
           (downloaded if -DownloadDeps is passed; otherwise expects them to already be there).
           Every one of them is checked against a SHA-256 pinned in this file - see
           "Pinned build inputs" below. A missing pin or a mismatch fails the build.
        4. Invoke ISCC.exe on scripts/installer/tally-mcp.iss
        5. Output is ./dist-installer/Claudally-Setup-<version>.exe

    Run from the repo root in an admin PowerShell (admin needed only if you
    download deps to Program Files; default uses CWD).

.PARAMETER DownloadDeps
    Stage portable Node + NSSM + cloudflared into installer-staging/, downloading whichever of
    the pinned files (Node zip, NSSM zip, cloudflared.exe) is not already there. A file that is
    already there is verified against its pin and used as-is, so an offline/air-gapped build can
    place those files in installer-staging/ by hand and run with -DownloadDeps: nothing is
    fetched, and everything is still hash-checked. Without this switch, the already-staged
    node-portable\node.exe, nssm.exe and cloudflared.exe are reused - and still hash-checked.

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
    # Version stamped into the installer and its filename. CI passes the git tag; a local build
    # that omits it gets the .iss fallback (0.0.0-dev), which is meant to look unreleasable.
    [string]$Version       = '',
    [switch]$DownloadDeps,
    [switch]$SkipBuild,
    [string]$InnoSetupPath = $null
)

$ErrorActionPreference = 'Stop'

# =================================================================================================
# Pinned build inputs
# =================================================================================================
# Every third-party binary the installer ships is pinned here to an exact version AND an exact
# SHA-256, committed to the repo. Nothing is taken from a "latest" URL, and nothing is verified
# against a hash that comes from the same place (or the same moment) as the download itself - so
# a compromised mirror, a repointed release or a MITM cannot change what we bundle without also
# changing this file in a reviewed commit. These binaries land in an installer that runs as
# Administrator and registers services that run as SYSTEM.
#
# There is deliberately no parameter or CI variable to override a pin: an override is exactly how
# verification used to get silently skipped (release.yml passed an NSSM_SHA256 repo variable that
# was never set, so every release shipped an unverified nssm.exe). A missing or malformed pin is a
# hard failure, not a warning. To change a version, change it here - how to obtain and corroborate
# the new hash is in docs/installer.md ("Bumping a pinned dependency").

# --- Node.js (portable, win-x64) -----------------------------------------------------------------
# This is the runtime the customer's MCP client actually spawns against live books, so it must be
# in security maintenance. Node 20 left maintenance on 2026-04-30 and was still pinned here until
# #172 - which matters more than it looks, because there is no update channel yet (#177), so a
# runtime CVE cannot be shipped to an installed machine at all.
# Do NOT jump to 24 without checking the test runner: `node --test dist` resolves `dist` as a
# module there and fails with MODULE_NOT_FOUND. The repo's own form
# (`find dist -name '*.test.mjs' -exec node --test {} +`) is unaffected, but any tooling that uses
# the short form will break. Bump along with package.json's engines.node.
#
# Provenance: both hashes are the `node-v22.23.2-win-x64.zip` and `win-x64/node.exe` lines of
# https://nodejs.org/dist/v22.23.2/SHASUMS256.txt, whose detached signature SHASUMS256.txt.asc
# verifies ("Good signature") against release key CC68F5A3106FF448322E48ED27F5E38D5B0A215F
# (Marco Ippolito), a releaser key listed in the nodejs/node README and nodejs/release-keys.
# Cross-checked 2026-09-27 by downloading the zip and hashing it and its node.exe independently.
$NodeVersion   = '22.23.2'
$NodeZipUrl    = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$NodeZipSha256 = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97'
$NodeExeSha256 = '0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4'

# --- NSSM (service host for the TallyMCP / TallyMCPTunnel services) ------------------------------
# nssm.cc publishes no SHA-256 and no signature, and nssm.exe is not Authenticode-signed, so this
# pin is the ONLY integrity check the bundled service host gets. Provenance of the zip hash:
#   - derived: sha256 of https://nssm.cc/release/nssm-2.24.zip, downloaded 2026-09-27;
#   - corroborated by nssm.cc itself: https://nssm.cc/download lists SHA-1
#     be7b3577c6e3a280e5106a9e9db5b3775931cefc for nssm-2.24.zip, which matches the same download;
#   - corroborated independently by the Chocolatey community `nssm` package (published 2016-2017,
#     years before this pin): v2.24.0.20161223's chocolateyInstall.ps1 hard-codes this exact
#     sha256 for nssm-2.24.zip, and v2.24.0.20170619 embeds nssm-2.24.zip (which hashes to this
#     value) with the same value in its legal/VERIFICATION.txt.
# The nssm.exe hash is win64\nssm.exe inside that verified zip. It is checked separately so a
# hand-placed nssm.exe (the offline path) is held to the same standard. Note Chocolatey/Scoop/winget
# now ship the 2.24-101/-103 pre-release builds, whose nssm.exe will NOT match this pin.
$NssmVersion   = '2.24'
$NssmZipUrl    = "https://nssm.cc/release/nssm-$NssmVersion.zip"
$NssmZipSha256 = '727d1e42275c605e0f04aba98095c38a8e1e46def453cdffce42869428aa6743'
$NssmExeSha256 = 'f689ee9af94b00e9e3f0bb072b34caaf207f32dcb4f5782fc9ca351df9a06c97'

# --- cloudflared (Cloudflare Tunnel client) ------------------------------------------------------
# Provenance: the cloudflared-windows-amd64.exe line of the SHA256 list in Cloudflare's GitHub
# release notes for 2026.9.3 (https://github.com/cloudflare/cloudflared/releases/tag/2026.9.3),
# which also matches the asset digest GitHub reports for that release. Cross-checked 2026-09-27 by
# downloading the versioned asset and hashing it; the binary also carries a valid Authenticode
# signature from "Cloudflare, Inc.".
$CloudflaredVersion = '2026.9.3'
$CloudflaredUrl     = "https://github.com/cloudflare/cloudflared/releases/download/$CloudflaredVersion/cloudflared-windows-amd64.exe"
$CloudflaredSha256  = 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2'

# --- Verification helpers ------------------------------------------------------------------------
# Windows PowerShell 5.1 may not offer TLS 1.2 by default, which github.com requires; and its
# progress bar makes Invoke-WebRequest many times slower on large files.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

function Test-PinnedSha256 {
    # $true if the file matches the pin, $false if it does not. Throws when there is no usable pin:
    # an empty or malformed pin must never read as "nothing to check".
    param([string]$Path, [string]$Sha256, [string]$What)
    if ($Sha256 -notmatch '^[0-9A-Fa-f]{64}$') {
        throw "No valid pinned SHA-256 for $What (got '$Sha256'); refusing to bundle an unverified binary. Fix the pin in build-installer.ps1."
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($actual -eq $Sha256) {
        Write-Host "==> Verified $What SHA-256 ($actual)" -ForegroundColor Green
        return $true
    }
    Write-Warning "$What SHA-256 mismatch at ${Path}: expected $($Sha256.ToUpperInvariant()), got $actual"
    return $false
}

function Assert-PinnedFile {
    # A staged file must exist and match its pin, whether we downloaded it or someone placed it
    # there by hand.
    param([string]$Path, [string]$Sha256, [string]$What, [string]$Remedy)
    if (-not (Test-Path -LiteralPath $Path)) { throw "$What not found at $Path. $Remedy" }
    if (-not (Test-PinnedSha256 -Path $Path -Sha256 $Sha256 -What $What)) {
        throw "$What at $Path does not match its pinned SHA-256 - refusing to bundle it (stale, wrong version, or tampered). $Remedy"
    }
}

function Get-PinnedFile {
    # Ensures $Path holds the pinned file. An existing file is verified and kept; if it does not
    # match and -Download is set it is replaced. A download lands in a .partial file and is only
    # moved into place after it verifies, so an unverified file never sits at $Path.
    param([string]$Path, [string]$Url, [string]$Sha256, [string]$What, [switch]$Download)
    $remedy = "Re-run with -DownloadDeps, or download $Url by hand and save it as $Path (it is verified against the pin either way)."
    if (Test-Path -LiteralPath $Path) {
        if (Test-PinnedSha256 -Path $Path -Sha256 $Sha256 -What $What) { return }
        if (-not $Download) { throw "$What at $Path does not match its pinned SHA-256 - refusing to bundle it. $remedy" }
        Write-Warning "Discarding $Path and downloading the pinned $What."
        Remove-Item -LiteralPath $Path -Force
    } elseif (-not $Download) {
        throw "$What not found at $Path. $remedy"
    } elseif ($Sha256 -notmatch '^[0-9A-Fa-f]{64}$') {
        # Fail before spending a download on something we could never verify.
        throw "No valid pinned SHA-256 for $What (got '$Sha256'); refusing to download an unverifiable binary. Fix the pin in build-installer.ps1."
    }

    $partial = "$Path.partial"
    $downloaded = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        Write-Host "==> Downloading $What (attempt $attempt) from $Url" -ForegroundColor Cyan
        try {
            Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing -ErrorAction Stop
            $downloaded = $true
            break
        } catch {
            Write-Warning "  download failed: $($_.Exception.Message)"
            if ($attempt -lt 3) { Start-Sleep -Seconds (3 * $attempt) }
        }
    }
    if (-not $downloaded) {
        Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
        throw "Could not download $What from $Url. Manual workaround: download it by hand, save it as $Path, and re-run (it is verified against the pinned SHA-256)."
    }
    if (-not (Test-PinnedSha256 -Path $partial -Sha256 $Sha256 -What $What)) {
        Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
        throw "$What downloaded from $Url does not match its pinned SHA-256 - aborting rather than bundle a tampered or unexpected binary."
    }
    Move-Item -LiteralPath $partial -Destination $Path -Force
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot

# Echo how we were actually invoked. A caller that fails to bind -DownloadDeps (PowerShell array
# splatting passes elements positionally and will NOT set a switch) otherwise skips dependency
# staging in silence and dies later on a "node.exe not found ... re-run with -DownloadDeps"
# message, which points at the one thing the caller believed it had already done.
Write-Host "==> build-installer: Version='$Version' DownloadDeps=$DownloadDeps SkipBuild=$SkipBuild" -ForegroundColor DarkGray

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
# The zip is verified against the pinned hash before it is expanded, and node.exe is verified again
# after staging - so a hand-populated or left-over node-portable\ is held to the same pin.
if ($DownloadDeps) {
    $nodeZip = Join-Path $staging "node-v$NodeVersion-win-x64.zip"
    Get-PinnedFile -Path $nodeZip -Url $NodeZipUrl -Sha256 $NodeZipSha256 -What "Node.js v$NodeVersion zip" -Download
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
Assert-PinnedFile -Path (Join-Path $nodeStaging 'node.exe') -Sha256 $NodeExeSha256 -What "node.exe (Node.js v$NodeVersion)" `
    -Remedy "Re-run with -DownloadDeps (put node-v$NodeVersion-win-x64.zip from $NodeZipUrl in $staging first for an offline build)."

# --- 3. Stage NSSM ---------------------------------------------------------
# Only the canonical HTTPS origin. A former web.archive.org fallback served an unauthenticated,
# mutable snapshot; with the hash pinned a mirror would now be safe, but nssm.cc being flaky is
# better handled by the retries in Get-PinnedFile or by placing the zip by hand.
$nssmTarget = Join-Path $staging 'nssm.exe'
if ($DownloadDeps) {
    $nssmZip = Join-Path $staging "nssm-$NssmVersion.zip"
    Get-PinnedFile -Path $nssmZip -Url $NssmZipUrl -Sha256 $NssmZipSha256 -What "NSSM v$NssmVersion zip" -Download
    # Always re-expand from the verified zip, never trust a previously extracted tree.
    $nssmExtracted = Join-Path $staging "nssm-$NssmVersion"
    if (Test-Path $nssmExtracted) { Remove-Item -Path $nssmExtracted -Recurse -Force }
    Expand-Archive -Path $nssmZip -DestinationPath $staging -Force
    $nssm64 = Join-Path $nssmExtracted 'win64\nssm.exe'
    if (-not (Test-Path $nssm64)) { throw "Expected $nssm64 after extraction" }
    Copy-Item -Path $nssm64 -Destination $nssmTarget -Force
}
Assert-PinnedFile -Path $nssmTarget -Sha256 $NssmExeSha256 -What "nssm.exe (NSSM v$NssmVersion win64)" `
    -Remedy "Re-run with -DownloadDeps (put nssm-$NssmVersion.zip from $NssmZipUrl in $staging first for an offline build), or copy win64\nssm.exe out of that exact zip. Package-manager builds (2.24-101 etc.) will not match."

# --- 3b. Stage cloudflared (Cloudflare Tunnel client) ---------------------
# A single self-contained .exe. Only used at runtime when the operator supplies a Cloudflare Tunnel
# token in the wizard; harmless to bundle otherwise (the installer ships it unconditionally, like
# nssm). Downloaded from Cloudflare's official GitHub release for the pinned version - never
# "latest". A copy left from an earlier build is reused only if it matches the pin.
$cloudflaredTarget = Join-Path $staging 'cloudflared.exe'
Get-PinnedFile -Path $cloudflaredTarget -Url $CloudflaredUrl -Sha256 $CloudflaredSha256 -What "cloudflared $CloudflaredVersion" -Download:$DownloadDeps

# --- 4. Locate ISCC.exe ---------------------------------------------------
if (-not $InnoSetupPath) {
    $candidate = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($candidate) {
        $InnoSetupPath = $candidate.Source
    } elseif (Test-Path 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe') {
        $InnoSetupPath = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
    } else {
        throw "ISCC.exe not found. Install Inno Setup 6 (scripts\installer\install-innosetup.ps1 installs the pinned, hash-verified version the release uses and prints its ISCC path), then pass -InnoSetupPath."
    }
}
Write-Host "==> Using ISCC.exe: $InnoSetupPath" -ForegroundColor Cyan

# --- 5. Compile the installer --------------------------------------------
$iss = Join-Path $repoRoot 'scripts\installer\tally-mcp.iss'
Write-Host "==> Compiling $iss" -ForegroundColor Cyan
$isccArgs = @()
if ($Version) {
    Write-Host "==> Stamping version $Version" -ForegroundColor Cyan
    $isccArgs += "/DMyAppVersion=$Version"
}
$isccArgs += $iss
& $InnoSetupPath @isccArgs
if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit $LASTEXITCODE" }

$out = Get-ChildItem -Path (Join-Path $repoRoot 'dist-installer') -Filter 'Claudally-Setup-*.exe' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if ($out) {
    Write-Host ""
    Write-Host "Installer ready: $($out.FullName)" -ForegroundColor Green
    Write-Host "Size: $([math]::Round($out.Length / 1MB, 1)) MB"
} else {
    Write-Warning "ISCC reported success but no installer found in dist-installer/"
}
