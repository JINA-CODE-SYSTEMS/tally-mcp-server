<#
.SYNOPSIS
    Installs the pinned, hash-verified Inno Setup compiler that builds the installer.

.DESCRIPTION
    ISCC is a build input in its own right: it embeds its own setup stub into every
    Claudally-Setup-*.exe, and that stub is the code a customer runs as Administrator. CI used
    to take whatever `choco install innosetup` (or the runner image) happened to provide - an
    unpinned version from a third-party package feed. This script instead downloads one exact
    Inno Setup release from the project's own GitHub releases, refuses to run it unless it
    matches the SHA-256 pinned below, and installs it in portable mode into a directory of
    its own, so a preinstalled copy on the runner can never be picked up by accident.

    Portable mode (/PORTABLE=1, supported by Inno Setup's own installer) writes no uninstall
    entry, no file association and no shortcuts, and /CURRENTUSER needs no elevation.

    Prints the full path of the verified ISCC.exe as the last line of output, and when run
    under GitHub Actions also writes it to $GITHUB_OUTPUT as `iscc`.

.PARAMETER Destination
    Directory to install into. Defaults to $env:RUNNER_TEMP\innosetup-<version> under Actions,
    otherwise %TEMP%\innosetup-<version>. It is emptied first.

.EXAMPLE
    $iscc = .\scripts\installer\install-innosetup.ps1 | Select-Object -Last 1
    .\scripts\installer\check-iss.ps1 -InnoSetupPath $iscc
#>
[CmdletBinding()]
param(
    [string]$Destination
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# --- Pin --------------------------------------------------------------------------------------
# Provenance: the SHA-256 is the asset digest GitHub reports for innosetup-6.7.1.exe on
# https://github.com/jrsoftware/issrc/releases/tag/is-6_7_1 (the Inno Setup project's own
# releases). Cross-checked 2026-09-27 against the independent Chocolatey `innosetup` 6.7.1
# package, which embeds the same installer and lists the same checksum in legal/VERIFICATION.txt;
# the installer carries a valid Authenticode signature from "Pyrsys B.V." (the Inno Setup
# publisher). Stays on 6.x: the scripts and docs expect Inno Setup 6. How to bump:
# docs/installer.md ("Bumping a pinned dependency").
$InnoVersion = '6.7.1'
$InnoUrl     = 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_1/innosetup-6.7.1.exe'
$InnoSha256  = '4d11e8050b6185e0d49bd9e8cc661a7a59f44959a621d31d11033124c4e8a7b0'

if ($InnoSha256 -notmatch '^[0-9A-Fa-f]{64}$') {
    throw "No valid pinned SHA-256 for Inno Setup $InnoVersion; refusing to run an unverified installer."
}

$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
if (-not $Destination) { $Destination = Join-Path $tempRoot "innosetup-$InnoVersion" }
$setupExe = Join-Path $tempRoot "innosetup-$InnoVersion.exe"

# --- Download and verify ------------------------------------------------------------------------
$downloaded = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
    Write-Host "==> Downloading Inno Setup $InnoVersion (attempt $attempt) from $InnoUrl"
    try {
        Invoke-WebRequest -Uri $InnoUrl -OutFile $setupExe -UseBasicParsing -ErrorAction Stop
        $downloaded = $true
        break
    } catch {
        Write-Warning "  download failed: $($_.Exception.Message)"
        if ($attempt -lt 3) { Start-Sleep -Seconds (3 * $attempt) }
    }
}
if (-not $downloaded) { throw "Could not download Inno Setup $InnoVersion from $InnoUrl" }

$actual = (Get-FileHash -LiteralPath $setupExe -Algorithm SHA256).Hash
if ($actual -ne $InnoSha256) {
    Remove-Item -LiteralPath $setupExe -Force -ErrorAction SilentlyContinue
    throw "Inno Setup $InnoVersion SHA-256 mismatch: expected $($InnoSha256.ToUpperInvariant()), got $actual - refusing to run it."
}
Write-Host "==> Verified Inno Setup $InnoVersion SHA-256 ($actual)"

# --- Install (portable, per-user, into its own directory) ---------------------------------------
if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
$log = Join-Path $tempRoot "innosetup-$InnoVersion-install.log"
$setupArgs = @(
    '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-',
    '/CURRENTUSER', '/PORTABLE=1', '/NOICONS',
    "/DIR=`"$Destination`"", "/LOG=`"$log`""
)
$proc = Start-Process -FilePath $setupExe -ArgumentList $setupArgs -Wait -PassThru
Remove-Item -LiteralPath $setupExe -Force -ErrorAction SilentlyContinue
if ($proc.ExitCode -ne 0) {
    if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 40 | Write-Host }
    throw "Inno Setup $InnoVersion install failed with exit code $($proc.ExitCode)."
}

$iscc = Join-Path $Destination 'ISCC.exe'
if (-not (Test-Path -LiteralPath $iscc)) {
    throw "Inno Setup $InnoVersion reported success but $iscc does not exist."
}
Write-Host "==> Inno Setup $InnoVersion installed: $iscc"
# AppendAllText writes UTF-8 without a BOM under both 5.1 and 7 (Out-File -Encoding utf8 on 5.1
# would prepend one if the file were empty, corrupting the first key).
if ($env:GITHUB_OUTPUT) { [System.IO.File]::AppendAllText($env:GITHUB_OUTPUT, "iscc=$iscc`n") }
$iscc
