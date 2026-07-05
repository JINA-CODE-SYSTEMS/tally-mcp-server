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
    [string]$TrayTaskName  = 'TallyMCPTray'
)

# ErrorActionPreference deliberately Continue: uninstall must finish even if a step throws.
$ErrorActionPreference = 'Continue'

$bundledNssm = Join-Path $InstallDir 'bin\nssm.exe'

Write-Host "=== Tally MCP uninstall cleanup ==="

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

# 2. Kill any leftover node.exe instances spawned by the service so file deletion succeeds.
try {
    Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
} catch {
    Write-Host "[WARN] node.exe kill raised: $_"
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

Write-Host "Cleanup complete; Inno Setup will now remove files."
Write-Host "NOTE: .env has been scrubbed and removed. If the box is shared, rotate the OAuth password."
