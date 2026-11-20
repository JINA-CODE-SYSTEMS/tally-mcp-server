<#
.SYNOPSIS
    Tally MCP Server - pre-uninstall cleanup (issue #18).

.DESCRIPTION
    Run by Inno Setup BEFORE it deletes the installed files. Stops the
    service, removes the NSSM entry, and removes the GUI agent's scheduled
    task so the box is clean afterwards.

    Defensive: every step is wrapped so a single failure (e.g. service was
    already removed manually) does not abort the uninstall.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$InstallDir,
    [string]$ServiceName   = 'TallyMCP',
    [string]$AgentTaskName = 'TallyMCPAgent',
    [string]$TrayTaskName  = 'TallyMCPTray',
    [string]$TunnelServiceName = 'TallyMCPTunnel',
    # Whether to shred the stored Tally company passwords. The uninstaller asks the operator and
    # passes the answer; default OFF so an older caller that does not know about the switch keeps
    # the data rather than destroying it silently.
    [switch]$RemoveVault
)

# The uninstaller passes the operator's answer in CLAUDALLY_UNINSTALL_REMOVE_VAULT ('1' / '0'), not on
# the command line: Inno expands [UninstallRun] parameters at INSTALL time, so a switch computed from
# the answer was always empty and the vault was never removed. The variable reaches every
# [UninstallRun] entry an upgraded install has accumulated, including ones written by older
# installers. -RemoveVault still works for a manual run.
if ($env:CLAUDALLY_UNINSTALL_REMOVE_VAULT -eq '1') { $RemoveVault = [switch]$true }

# ErrorActionPreference deliberately Continue: uninstall must finish even if a step throws.
$ErrorActionPreference = 'Continue'

$bundledNssm = Join-Path $InstallDir 'bin\nssm.exe'

Write-Host "=== Tally MCP uninstall cleanup ==="

# 0. Remove OUR entry from every user profile that has one, before anything is deleted (#172 E1).
#
# Runs first on purpose: dist\client-config.mjs and the bundled node are both about to be removed,
# and a stale entry points Claude at files that no longer exist - so every launch shows a failed
# server the user cannot explain and cannot fix without hand-editing the JSON this product exists
# to keep them out of.
#
# ACROSS EVERY PROFILE, not just AGENT_TASK_USER: the "Connect Claude to Tally" Start Menu item is
# available to anyone who logs in, so a second user may well have wired themselves up.
#
# --require-install-root is what makes touching other people's files defensible. Without it the
# ownership check compares only the script tail ("dist/index.mjs"), so a colleague running their
# OWN fork from D:\my-fork\dist\index.mjs looks identical to ours and would have been deleted.
# With it we remove only entries that actually point inside the directory being uninstalled, and
# anything else is reported and left byte-identical.
try {
    $nodeExe   = Join-Path $InstallDir 'node-portable\node.exe'
    $configCli = Join-Path $InstallDir 'dist\client-config.mjs'
    if (-not (Test-Path -LiteralPath $nodeExe) -or -not (Test-Path -LiteralPath $configCli)) {
        Write-Host "[*] client-config tooling not present - skipping Claude config cleanup"
    } else {
        $profileRoot = Split-Path -Parent $env:PUBLIC          # normally C:\Users
        $cleaned = 0; $skipped = 0
        foreach ($dir in (Get-ChildItem -Path $profileRoot -Directory -ErrorAction SilentlyContinue)) {
            $appData = Join-Path $dir.FullName 'AppData\Roaming'
            $cfg     = Join-Path $appData 'Claude\claude_desktop_config.json'
            if (Test-Path -LiteralPath $cfg) {
                try {
                    $out = & $nodeExe $configCli remove --target claude-desktop --appdata $appData --install-root $InstallDir --require-install-root --json 2>&1 | Out-String
                    $res = $null
                    try { $res = ($out | ConvertFrom-Json).results[0] } catch { }
                    if ($res -and $res.wrote) {
                        $cleaned++
                        Write-Host "[OK] Removed the Tally entry from $($dir.Name)'s Claude configuration"
                    } elseif ($res -and $res.state -eq 'foreign') {
                        $skipped++
                        Write-Host "[*]  Left $($dir.Name)'s Claude entry alone - it points at a different install"
                    }
                } catch {
                    Write-Host "[WARN] Could not clean $($dir.Name)'s Claude configuration: $_"
                }
            }
            # Per-user breadcrumb written by connect-client.ps1. Small, but it is ours and it names
            # paths that are about to stop existing.
            $crumb = Join-Path $dir.FullName 'AppData\Local\Claudally'
            if (Test-Path -LiteralPath $crumb) { Remove-Item -Recurse -Force -LiteralPath $crumb -ErrorAction SilentlyContinue }
        }
        Write-Host "[OK] Claude configuration cleanup: $cleaned removed, $skipped left alone"
    }
} catch {
    Write-Host "[WARN] client-config cleanup raised: $_"
}

# 0b. Stored Tally company passwords (#172 E1).
#
# The vault lives OUTSIDE the install directory - in the Claudally agent folder,
# %ProgramData%\Claudally\agent (before #230's follow-up: Tally's data folder, TALLY_DATA_PATH) - so
# neither this script nor Inno's [UninstallDelete] used to touch it. Uninstalling therefore
# left DPAPI-encrypted Tally passwords on disk, protected by an NTFS ACL that nothing maintains any
# more. DPAPI at LocalMachine scope means any local account that can READ that file can decrypt it,
# so that ACL was the whole protection.
#
# The operator is asked rather than assumed at: these are credentials WE created and are useless
# without this product, which argues for removing them - but they are also passwords a human typed
# and may want back after a reinstall, which argues for keeping them. The uninstaller poses the
# question and defaults to removing.
# The agent folder, derived the way the installer, the server and the tray derive it.
$programDataDir = if ($env:ProgramData) { $env:ProgramData } else { 'C:\ProgramData' }
$agentDirNow = Join-Path $programDataDir 'Claudally\agent'
if ($RemoveVault) {
    try {
        # Where it is now, and - for an install that was never reconfigured by a version that moves
        # it - where it used to be, in Tally's data folder.
        $envFile = Join-Path $InstallDir '.env'
        $dataPath = ''
        if (Test-Path -LiteralPath $envFile) {
            $dataLine = Select-String -LiteralPath $envFile -Pattern '^\s*TALLY_DATA_PATH\s*=' -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($dataLine) { $dataPath = ($dataLine.Line -split '=', 2)[1].Trim().Trim('"') }
        }
        if (-not $dataPath) { $dataPath = Join-Path $env:PUBLIC 'TallyPrimeEditLog\data' }
        $vaultPaths = @((Join-Path $agentDirNow '.tally-mcp-companies.json'), (Join-Path $dataPath '.tally-mcp-companies.json'))

        $found = $false
        foreach ($vaultPath in $vaultPaths) {
            # The vault, the pre-entropy backup migrate-vault-entropy.ps1 may have left (it holds the
            # OLD, weakly-protected blobs), and a half-written .tmp from the tray.
            foreach ($f in @($vaultPath, "$vaultPath.pre-entropy-backup", "$vaultPath.tmp")) {
                if (-not (Test-Path -LiteralPath $f)) { continue }
                $found = $true
                # Overwrite before unlinking: the file holds encrypted credentials, and a plain delete
                # leaves them recoverable from free space.
                try {
                    $len = (Get-Item -LiteralPath $f -Force).Length
                    if ($len -gt 0) { [System.IO.File]::WriteAllBytes($f, (New-Object byte[] $len)) }
                } catch { $null = $_ }
                Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
                Write-Host "[OK] Saved Tally company passwords shredded and removed ($f)"
            }
        }
        if (-not $found) { Write-Host "[*] No saved company passwords found" }
    } catch {
        Write-Host "[WARN] Company vault removal raised: $_"
    }
} else {
    Write-Host "[*] Saved Tally company passwords KEPT at the operator's request, in $agentDirNow"
    Write-Host "    They stay readable only to SYSTEM, Administrators and the agent account, and are"
    Write-Host "    useless on any other machine (DPAPI is bound to this one)."
}

# 1. Stop and remove the NSSM service.
try {
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
        if (Test-Path -LiteralPath $bundledNssm) {
            Write-Host "[*] Stopping service via bundled nssm..."
            & $bundledNssm stop $ServiceName 2>$null | Out-Null
            & $bundledNssm remove $ServiceName confirm | Out-Null
        } else {
            Write-Host "[*] Bundled nssm not found; falling back to sc.exe"
            & sc.exe stop $ServiceName | Out-Null
            Start-Sleep -Seconds 2
            & sc.exe delete $ServiceName | Out-Null
        }
        Write-Host "[OK] Service '$ServiceName' removed"
    } else {
        Write-Host "[*] Service '$ServiceName' not found - already removed"
    }
} catch {
    Write-Host "[WARN] Service removal raised: $_"
}

# 1b. Stop and remove the Cloudflare Tunnel NSSM service (same shape as step 1), then kill any
#     leftover cloudflared.exe so file deletion succeeds. No-op when no tunnel was configured.
try {
    if (Get-Service -Name $TunnelServiceName -ErrorAction SilentlyContinue) {
        if (Test-Path -LiteralPath $bundledNssm) {
            Write-Host "[*] Stopping tunnel service via bundled nssm..."
            & $bundledNssm stop $TunnelServiceName 2>$null | Out-Null
            & $bundledNssm remove $TunnelServiceName confirm | Out-Null
        } else {
            Write-Host "[*] Bundled nssm not found; falling back to sc.exe for tunnel"
            & sc.exe stop $TunnelServiceName | Out-Null
            Start-Sleep -Seconds 2
            & sc.exe delete $TunnelServiceName | Out-Null
        }
        Write-Host "[OK] Service '$TunnelServiceName' removed"
    } else {
        Write-Host "[*] Service '$TunnelServiceName' not found - already removed / never configured"
    }
} catch {
    Write-Host "[WARN] Tunnel service removal raised: $_"
}
try {
    Get-Process -Name cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
} catch {
    Write-Host "[WARN] cloudflared.exe kill raised: $_"
}

# 2. Stop leftover processes from THIS install so file deletion succeeds.
#
# This was `Get-Process -Name node | Stop-Process -Force`, which killed EVERY node.exe on the
# machine - the customer's editor, their build, an unrelated Electron app, another product's
# service. tally-mcp.iss learned that lesson years ago and filtered by command line; the
# uninstaller never did, and in local mode (#172) it would additionally kill the user's own
# client-spawned server. Reuse the installer's ownership rules rather than inventing a third
# answer to the same question (#172 C1).
$stopHelper = Join-Path $InstallDir 'scripts\installer\stop-install-processes.ps1'
if (Test-Path -LiteralPath $stopHelper) {
    try {
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $stopHelper -InstallDir $InstallDir
    } catch {
        Write-Host "[WARN] stop-install-processes raised: $_"
    }
} else {
    # An install from before this helper shipped, or a partially-deleted tree. Fall back to the
    # narrow case rather than the old machine-wide kill: only node.exe running from THIS install.
    Write-Host "[WARN] $stopHelper not found; falling back to a path-scoped node.exe stop"
    try {
        $root = $InstallDir.TrimEnd('\') + '\'
        Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and $_.Path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
        } | Stop-Process -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Host "[WARN] node.exe kill raised: $_"
    }
}

# 3. Remove the GUI agent at-logon scheduled task.
try {
    & schtasks /Delete /TN $AgentTaskName /F 2>$null | Out-Null
    Write-Host "[OK] Scheduled task '$AgentTaskName' removed (or did not exist)"
} catch {
    Write-Host "[WARN] schtasks /Delete raised: $_"
}

# 4. Stop any agent processes still running in user sessions. Best-effort: PowerShell instances
#    running tally-gui-agent-v2.ps1 will have their command line in the process info if visible.
try {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*tally-gui-agent-v2.ps1*' } |
        ForEach-Object {
            Write-Host "[*] Stopping agent process pid=$($_.ProcessId)"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
} catch {
    Write-Host "[WARN] agent process stop raised: $_"
}

# 5. Remove the tray status app at-logon scheduled task and kill any running tray process.
#    Same shape as the agent cleanup above; both are interactive-session-only and won't be
#    visible if the uninstaller is invoked from an admin session different from the user's.
try {
    & schtasks /Delete /TN $TrayTaskName /F 2>$null | Out-Null
    Write-Host "[OK] Scheduled task '$TrayTaskName' removed (or did not exist)"
} catch {
    Write-Host "[WARN] tray schtasks /Delete raised: $_"
}
try {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*tally-mcp-tray.ps1*' } |
        ForEach-Object {
            Write-Host "[*] Stopping tray process pid=$($_.ProcessId)"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
} catch {
    Write-Host "[WARN] tray process stop raised: $_"
}

# 6. Scrub the .env file. It holds the OAuth PASSWORD and other secrets; leaving it behind
#    after uninstall is a stale-credential exposure. Overwrite the bytes first so the plaintext
#    isn't trivially recoverable from the freed disk blocks, then delete.
try {
    $envFile = Join-Path $InstallDir '.env'
    if (Test-Path -LiteralPath $envFile) {
        try {
            $len = (Get-Item -LiteralPath $envFile).Length
            if ($len -gt 0) {
                $zeros = New-Object byte[] $len
                [System.IO.File]::WriteAllBytes($envFile, $zeros)
            }
        } catch {
            Write-Host "[WARN] .env overwrite raised: $_"
        }
        Remove-Item -LiteralPath $envFile -Force -ErrorAction SilentlyContinue
        Write-Host "[OK] .env scrubbed and removed"
    } else {
        Write-Host "[*] .env not found - nothing to scrub"
    }
} catch {
    Write-Host "[WARN] .env cleanup raised: $_"
}

# 6b. Scrub the Cloudflare Tunnel token file (#193). firstrun-config.ps1 hands cloudflared its token
#     through this file rather than the service registry; it is a bearer credential for the tunnel's
#     hostname. Same zero-then-delete as .env. The tunnel service was stopped in step 1b, so nothing
#     holds it open. No-op when no tunnel was ever configured.
try {
    $tunnelTokenFile = Join-Path $InstallDir '.tunnel-token'
    if (Test-Path -LiteralPath $tunnelTokenFile) {
        try {
            $len = (Get-Item -LiteralPath $tunnelTokenFile -Force).Length
            if ($len -gt 0) {
                [System.IO.File]::WriteAllBytes($tunnelTokenFile, (New-Object byte[] $len))
            }
        } catch {
            Write-Host "[WARN] tunnel token overwrite raised: $_"
        }
        Remove-Item -LiteralPath $tunnelTokenFile -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $tunnelTokenFile) {
            Write-Host "[WARN] Could not remove $tunnelTokenFile - delete it by hand; it holds a tunnel credential."
        } else {
            Write-Host "[OK] Tunnel token file scrubbed and removed"
        }
    } else {
        Write-Host "[*] No tunnel token file - nothing to scrub"
    }
} catch {
    Write-Host "[WARN] tunnel token cleanup raised: $_"
}

Write-Host "Cleanup complete; Inno Setup will now remove files."
Write-Host "NOTE: .env has been scrubbed and removed. If the box is shared, rotate the OAuth password"
Write-Host "      (and, if a Cloudflare Tunnel was configured, have the tunnel token rotated or the tunnel deleted)."
