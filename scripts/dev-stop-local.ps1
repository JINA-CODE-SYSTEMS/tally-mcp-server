# Kills the processes spawned by scripts/dev-run-local.ps1.
# Reads PIDs from scripts/.dev-pids (one "PID Label" per line, written at spawn time).
# Used mainly with `npm run dev -- -Silent` since silent windows can't be Ctrl+C'd.
#
# RUN:
#   npm run dev:stop
#   powershell -ExecutionPolicy Bypass -File scripts\dev-stop-local.ps1

$ErrorActionPreference = 'SilentlyContinue'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$pidFile = Join-Path $repoRoot 'scripts\.dev-pids'

if (-not (Test-Path $pidFile)) {
    Write-Host "No .dev-pids file found - nothing tracked." -ForegroundColor DarkGray
    Write-Host "(Either dev mode was never started, or it was started before this script existed.)"
    exit 0
}

$killed = 0
$skipped = 0
foreach ($line in (Get-Content -Path $pidFile)) {
    if (-not $line.Trim()) { continue }
    $parts = $line -split '\s+', 2
    $procId = [int]$parts[0]
    $label = if ($parts.Length -gt 1) { $parts[1] } else { '<unlabeled>' }

    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $proc) {
        Write-Host "[-] $label (pid $procId) - already gone" -ForegroundColor DarkGray
        $skipped++
        continue
    }
    # Tree-kill via taskkill /T so child processes (tsc, node, agent script) also die.
    # Stop-Process alone only kills the parent powershell, leaving node etc. orphaned.
    & taskkill.exe /PID $procId /T /F 2>$null | Out-Null
    Write-Host "[x] $label (pid $procId) - killed" -ForegroundColor Yellow
    $killed++
}

Remove-Item -Path $pidFile -Force -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "[OK] Stopped $killed, skipped $skipped already-dead." -ForegroundColor Cyan
