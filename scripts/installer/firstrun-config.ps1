<#
.SYNOPSIS
    Tally MCP Server - first-run configuration script (issue #18).

.DESCRIPTION
    Invoked by tally-mcp.iss after files are unpacked. Writes .env from the
    wizard's collected values, registers (or re-registers) the NSSM service
    using the BUNDLED node-portable\node.exe + bin\nssm.exe (no system Node
    needed), and registers the GUI agent at-logon scheduled task.

    Re-runnable: stops/removes any existing service before re-registering, so
    operators can re-launch this script via the "Reconfigure" Start Menu
    shortcut to update settings.

.PARAMETER InstallDir
    Where the installer placed the app. Inno passes {app}.

.PARAMETER Password
    OAuth password collected by the wizard. Becomes the PASSWORD env var.

.PARAMETER TallyEdition
    "silver" or "gold". Becomes TALLY_EDITION.

.PARAMETER TallyExePath
    Absolute path to tally.exe.

.PARAMETER TallyDataPath
    Tally's data directory (where the digit-named company folders live).

.PARAMETER TallyIniPath
    Absolute path to tally.ini (the file load-company edits).

.PARAMETER McpDomain
    Public domain for OAuth metadata. Empty -> localhost-only mode.

.PARAMETER AgentTaskUser
    Windows user the GUI agent task runs as. Must be the user who logs into
    the box and uses Tally interactively.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$InstallDir,
    [string]$ServiceName    = 'TallyMCP',
    [string]$AgentTaskName  = 'TallyMCPAgent',
    # The OAuth password is read from a JSON credentials file (written by Inno Setup into the
    # installer's user-only temp folder). Avoids exposing the password on the command line where
    # it would be visible to any local process via Get-CimInstance Win32_Process / wmic during
    # the ~30s install window. The file is deleted immediately after read.
    [Parameter(Mandatory=$true)] [string]$CredentialsFile,
    [string]$TallyEdition   = 'silver',
    [string]$TallyExePath   = 'C:\Program Files\TallyPrimeEditLog\tally.exe',
    [string]$TallyDataPath  = 'C:\Users\Public\TallyPrimeEditLog\data',
    [string]$TallyIniPath   = 'C:\Program Files\TallyPrimeEditLog\tally.ini',
    [string]$McpDomain      = '',
    [string]$AgentTaskUser  = $env:USERNAME
)

# --- Read + delete credentials file before any other work ---
# Even if anything below throws, the credentials file should not survive.
if (-not (Test-Path -LiteralPath $CredentialsFile)) {
    throw "Credentials file not found at '$CredentialsFile'. Inno Setup should have written it before invoking this script."
}
$credsRaw = $null
try {
    $credsRaw = [System.IO.File]::ReadAllText($CredentialsFile, [System.Text.Encoding]::UTF8)
} finally {
    # Best-effort secure delete: overwrite with zeros, then unlink. Even on a power loss between
    # those two ops, the file is in the user's temp folder (auto-cleaned by Inno); residual
    # exposure is bounded.
    try {
        $size = (Get-Item -LiteralPath $CredentialsFile -ErrorAction SilentlyContinue).Length
        if ($size -gt 0) {
            $zeros = New-Object byte[] $size
            [System.IO.File]::WriteAllBytes($CredentialsFile, $zeros)
        }
    } catch {}
    Remove-Item -LiteralPath $CredentialsFile -Force -ErrorAction SilentlyContinue
}
$creds = $null
try {
    $creds = $credsRaw | ConvertFrom-Json
} catch {
    throw "Credentials file '$CredentialsFile' is not valid JSON: $_"
}
if (-not $creds.password) {
    throw "Credentials file did not contain a 'password' field."
}
$Password = [string]$creds.password
# Hint to GC: drop the raw JSON string from memory once we've extracted the field.
$credsRaw = $null

$ErrorActionPreference = 'Stop'
$transcript = Join-Path $InstallDir 'logs\firstrun-config.log'
New-Item -ItemType Directory -Force -Path (Split-Path $transcript) | Out-Null
Start-Transcript -Path $transcript -Append | Out-Null

try {
    Write-Host "=== Tally MCP first-run configuration ==="
    Write-Host "InstallDir   = $InstallDir"
    Write-Host "ServiceName  = $ServiceName"
    Write-Host "TallyEdition = $TallyEdition"
    Write-Host "AgentUser    = $AgentTaskUser"

    $bundledNode = Join-Path $InstallDir 'node-portable\node.exe'
    $bundledNssm = Join-Path $InstallDir 'bin\nssm.exe'
    $serverEntry = Join-Path $InstallDir 'dist\server.mjs'
    $envFile     = Join-Path $InstallDir '.env'
    $agentScript = Join-Path $InstallDir 'scripts\tally-gui-agent-v2.ps1'

    foreach ($p in @($bundledNode, $bundledNssm, $serverEntry, $agentScript)) {
        if (-not (Test-Path -LiteralPath $p)) {
            throw "Required file missing: $p (installer payload incomplete?)"
        }
    }

    # --- 1. Write .env -----------------------------------------------------
    # Atomic-ish: write to .tmp, then rename, so a half-written .env never appears.
    # We do NOT log the password itself; the transcript captures parameter binding which
    # is acceptable for a first-run install but operators should rotate the password if
    # the log is sensitive (see logs/firstrun-config.log cleanup hint at end).
    $envLines = @(
        "# Generated by Tally MCP first-run wizard at $(Get-Date -Format 'o')"
        "# Edit by hand or re-run scripts\installer\firstrun-config.ps1 to regenerate."
        "PASSWORD=$Password"
        "TALLY_EDITION=$TallyEdition"
        "TALLY_HOST=127.0.0.1:9000"
        "TALLY_EXE_PATH=$TallyExePath"
        "TALLY_DATA_PATH=$TallyDataPath"
        "TALLY_INI_PATH=$TallyIniPath"
    )
    if ($McpDomain) {
        $envLines += "MCP_DOMAIN=$McpDomain"
    } else {
        $envLines += "# MCP_DOMAIN intentionally unset - server binds to localhost only"
    }

    $envTmp = "$envFile.tmp"
    Set-Content -Path $envTmp -Value $envLines -Encoding UTF8
    Move-Item -Path $envTmp -Destination $envFile -Force
    Write-Host "[OK] Wrote $envFile ($($envLines.Count) lines)"

    # --- 2. Stop and remove any existing service (idempotent re-runs) ------
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "[*] Existing service detected; stopping and removing..."
        & $bundledNssm stop $ServiceName 2>$null | Out-Null
        & $bundledNssm remove $ServiceName confirm | Out-Null
    }

    # --- 3. Register NSSM service pointing at bundled node + dist/server.mjs --
    & $bundledNssm install $ServiceName $bundledNode $serverEntry | Out-Null
    & $bundledNssm set $ServiceName AppDirectory $InstallDir                            | Out-Null
    & $bundledNssm set $ServiceName Description  'Tally Prime MCP Server'               | Out-Null
    & $bundledNssm set $ServiceName Start        SERVICE_AUTO_START                     | Out-Null
    & $bundledNssm set $ServiceName AppStdout    (Join-Path $InstallDir 'logs\service.log') | Out-Null
    & $bundledNssm set $ServiceName AppStderr    (Join-Path $InstallDir 'logs\service.log') | Out-Null
    & $bundledNssm set $ServiceName AppRotateFiles 1                                    | Out-Null
    & $bundledNssm set $ServiceName AppRotateOnline 1                                   | Out-Null
    & $bundledNssm set $ServiceName AppRotateSeconds 86400                              | Out-Null
    & $bundledNssm set $ServiceName AppRotateBytes 5242880                              | Out-Null
    & $bundledNssm set $ServiceName AppStdoutCreationDisposition 4                      | Out-Null
    & $bundledNssm set $ServiceName AppStderrCreationDisposition 4                      | Out-Null

    # Hand .env values to the service through NSSM's AppEnvironmentExtra. NSSM expects a
    # newline-separated list of KEY=VALUE pairs.
    $nssmEnv = ($envLines | Where-Object { $_ -and -not $_.StartsWith('#') }) -join "`n"
    & $bundledNssm set $ServiceName AppEnvironmentExtra $nssmEnv | Out-Null

    Write-Host "[OK] Service '$ServiceName' registered with bundled node + nssm"

    # --- 4. Register the GUI agent at-logon Scheduled Task -----------------
    schtasks /Delete /TN $AgentTaskName /F 2>$null | Out-Null
    $taskAction = "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Minimized -File `"$agentScript`""
    & schtasks /Create /TN $AgentTaskName /SC ONLOGON /RU $AgentTaskUser /RL LIMITED /TR $taskAction /F | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] Scheduled task '$AgentTaskName' registered (runs at logon, as $AgentTaskUser)"
    } else {
        Write-Host "[WARN] schtasks /Create returned $LASTEXITCODE - GUI agent task NOT registered. Re-run the wizard or register manually." -ForegroundColor Yellow
    }

    # --- 5. Start the service ----------------------------------------------
    & $bundledNssm start $ServiceName | Out-Null
    Start-Sleep -Seconds 3
    $svc = Get-Service -Name $ServiceName
    Write-Host "[OK] Service status after start: $($svc.Status)"

    # --- 6. Tell the operator what's next ----------------------------------
    Write-Host ""
    Write-Host "Configuration complete."
    Write-Host "  Service:        $ServiceName  ($($svc.Status))"
    Write-Host "  Agent task:     $AgentTaskName"
    Write-Host "  .env:           $envFile"
    Write-Host "  Logs:           $(Join-Path $InstallDir 'logs')"
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  1. Log out and back in (or run 'schtasks /Run /TN $AgentTaskName') to start the GUI agent."
    Write-Host "  2. Hit http://127.0.0.1:3000/.well-known/oauth-protected-resource to confirm the server responds."
    Write-Host "  3. (Production) point a reverse proxy at 127.0.0.1:3000 to terminate TLS."
    Write-Host ""
    Write-Host "NOTE: $transcript captures install activity. Delete it if PowerShell parameter binding"
    Write-Host "      may have logged the OAuth password and the box is shared with other admins."
}
finally {
    Stop-Transcript | Out-Null
}
