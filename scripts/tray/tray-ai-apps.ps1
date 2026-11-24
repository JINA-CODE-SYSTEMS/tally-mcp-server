<#
.SYNOPSIS
    Per-app connection status (#38) and offers to connect apps installed later (#39, tray part).
    Dot-sourced by tally-mcp-tray.ps1; defines functions only.

.DESCRIPTION
    Two sources, combined into one row per app:
      - sightings: %LOCALAPPDATA%\Claudally\clients\*.json written by the server each time an app
        completes the MCP handshake (src/client-sighting.mts), plus the copies Windows redirects
        into a packaged app's LocalCache. Proof the app actually STARTED Tally.
      - config files we know how to write (scripts/installer/connect-client.ps1 ->
        dist/client-config.mjs). Proof only that the entry is THERE.

    Connect / Fix run connect-client.ps1 -Target <name>. Its -Target today accepts apps,
    claude-desktop, cursor, vscode and all; 'windsurf' and 'lmstudio' are being added alongside the
    client-config engine. Until a build has them, the hidden run fails parameter validation (exit
    code 1) and the user is offered the visible connect window, which shows why.

    Uses the tray's $State, $InstallDir, $tray, Get-ClaudeConfigFiles and Invoke-ClaudeAutoFix.

.NOTES
    Windows PowerShell 5.1 compatible; ASCII only.
#>

# Every app the tray knows how to connect. Installed = the app's PROGRAM folder is present. Settings
# folders are deliberately not evidence: connect-client.ps1 pre-writes Claude's config before Claude
# is installed (by design), which creates %APPDATA%\Claude on a PC that has no Claude. The one
# exception is LM Studio's ~\.lmstudio, which only LM Studio itself creates.
function Get-AiAppDefinitions {
    $la = $env:LOCALAPPDATA
    $up = $env:USERPROFILE
    $apps = @()

    # Classic installer, packaged (MSIX) build, or a later packaged build's data folder.
    $claudeInstalled = (Test-Path -LiteralPath (Join-Path $la 'AnthropicClaude')) -or
        (@(Get-ChildItem -LiteralPath (Join-Path $la 'Packages') -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue).Count -gt 0) -or
        (@(Get-ChildItem -LiteralPath (Join-Path $la 'Claude-Data') -Directory -Filter 'claude_*' -ErrorAction SilentlyContinue).Count -gt 0)
    $apps += @{ Key = 'claude-desktop'; Label = 'Claude Desktop'; Target = 'claude-desktop'; Configs = @(Get-ClaudeConfigFiles); Installed = [bool]$claudeInstalled }

    # The same two program folders are in the cursor target's appFolder (src/client-config.mts), so
    # connect-client.ps1 -Target cursor agrees that Cursor is installed even before its first
    # launch has created ~\.cursor. Change both together, or the offer ends in "not installed".
    $cursorInstalled = (Test-Path -LiteralPath (Join-Path $la 'Programs\cursor')) -or
        ($env:ProgramFiles -and (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'cursor')))
    $apps += @{ Key = 'cursor'; Label = 'Cursor'; Target = 'cursor'; Configs = @(Join-Path $up '.cursor\mcp.json'); Installed = [bool]$cursorInstalled }

    $windsurfInstalled = (Test-Path -LiteralPath (Join-Path $la 'Programs\Windsurf'))
    $apps += @{ Key = 'windsurf'; Label = 'Windsurf'; Target = 'windsurf'; Configs = @(Join-Path $up '.codeium\windsurf\mcp_config.json'); Installed = [bool]$windsurfInstalled }

    $lmInstalled = (Test-Path -LiteralPath (Join-Path $la 'Programs\LM Studio')) -or (Test-Path -LiteralPath (Join-Path $up '.lmstudio'))
    $apps += @{ Key = 'lmstudio'; Label = 'LM Studio'; Target = 'lmstudio'; Configs = @(Join-Path $up '.lmstudio\mcp.json'); Installed = [bool]$lmInstalled }

    return $apps
}

# $true when any of the files has an entry pointing at THIS install, $false when none does, $null
# when a file could not be read. Same rule as Test-ClientConfigured: match on the install path (raw
# or JSON-escaped), not on the entry name, which a user may rename.
function Test-ConfigFilesPointHere {
    param([string[]]$Files, [string]$InstallRoot)
    try {
        $needles = @($InstallRoot, $InstallRoot.Replace('\', '\\'))
        foreach ($cfg in $Files) {
            if (-not $cfg -or -not (Test-Path -LiteralPath $cfg)) { continue }
            $raw = Get-Content -LiteralPath $cfg -Raw -ErrorAction Stop
            if (-not $raw) { continue }
            foreach ($n in $needles) {
                if ($raw.IndexOf($n, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
            }
        }
        return $false
    } catch {
        return $null
    }
}

# Which known app a client name (from the MCP handshake) belongs to, or ''.
function Get-ClientAppKey {
    param([string]$Client)
    $c = ([string]$Client).ToLowerInvariant()
    if ($c -match 'claude' -and $c -match 'code') { return 'claude-code' }
    if ($c -match 'claude') { return 'claude-desktop' }
    if ($c -match 'cursor') { return 'cursor' }
    if ($c -match 'windsurf') { return 'windsurf' }
    if ($c -match 'lm-?studio' -or $c -match 'lm studio') { return 'lmstudio' }
    return ''
}

function Get-ClientFriendlyName {
    param([string]$Client)
    switch (Get-ClientAppKey $Client) {
        'claude-desktop' { return 'Claude Desktop' }
        'claude-code'    { return 'Claude Code' }
        'cursor'         { return 'Cursor' }
        'windsurf'       { return 'Windsurf' }
        'lmstudio'       { return 'LM Studio' }
    }
    if ($Client) { return [string]$Client }
    return 'Unknown app'
}

# Newest sighting per app: key -> @{ Client; Label; Version; SeenAt (UTC) }. Apps we do not know get
# the key 'other:<client name>' so each still gets a row.
function Get-ClientSightings {
    $out = @{}
    $globs = @(
        (Join-Path $env:LOCALAPPDATA 'Claudally\clients\*.json'),
        (Join-Path $env:LOCALAPPDATA 'Packages\*\LocalCache\Local\Claudally\clients\*.json')
    )
    foreach ($g in $globs) {
        foreach ($f in @(Get-ChildItem -Path $g -File -ErrorAction SilentlyContinue)) {
            try {
                $s = Read-TrayCoordinationJson -Path $f.FullName
                if (-not $s) { continue }
                $seen = ConvertTo-TrayUtc $s.seenAt
                if (-not $seen) { continue }
                $client = [string]$s.client
                $key = Get-ClientAppKey $client
                if (-not $key) { $key = 'other:' + $client.ToLowerInvariant() }
                $prev = $out[$key]
                if (-not $prev -or $seen -gt $prev.SeenAt) {
                    $out[$key] = @{ Client = $client; Label = (Get-ClientFriendlyName $client); Version = [string]$s.clientVersion; SeenAt = $seen }
                }
            } catch { }
        }
    }
    return $out
}

function Format-RelativeTime {
    param($WhenUtc)
    if (-not $WhenUtc) { return 'at an unknown time' }
    $span = [datetime]::UtcNow - $WhenUtc
    if ($span.TotalSeconds -lt 90) { return 'just now' }
    if ($span.TotalMinutes -lt 60) { return "$([int]$span.TotalMinutes) min ago" }
    if ($span.TotalHours -lt 24) {
        $h = [int][Math]::Floor($span.TotalHours)
        if ($h -eq 1) { return '1 hour ago' }
        return "$h hours ago"
    }
    $d = [int][Math]::Floor($span.TotalDays)
    if ($d -eq 1) { return 'yesterday' }
    return "$d days ago"
}

# One row per app worth mentioning: @{ Key; Label; Text; Health; Action ('fix'|'connect'|''); Target }.
function Get-AiAppRows {
    param([string]$InstallRoot)
    $rows = @()
    $sightings = Get-ClientSightings
    foreach ($app in Get-AiAppDefinitions) {
        $configured = Test-ConfigFilesPointHere -Files $app.Configs -InstallRoot $InstallRoot
        $s = $sightings[$app.Key]
        $row = @{ Key = $app.Key; Label = $app.Label; Target = $app.Target; Text = ''; Health = 'gray'; Action = '' }
        if ($configured -eq $true) {
            if ($s) {
                $row.Text = "configured, last started Tally $(Format-RelativeTime $s.SeenAt)"
                $row.Health = 'green'
            } elseif ($app.Installed) {
                $row.Text = 'configured, never started'
                $row.Health = 'amber'
                $row.Action = 'fix'
            } else {
                # Pre-written on purpose (connect-client writes the entry before the app exists).
                $row.Text = 'configured, app not installed yet'
            }
        } elseif ($s) {
            # Started Tally from settings we did not write (a project file, say). It works; say so.
            $row.Text = "last started Tally $(Format-RelativeTime $s.SeenAt)"
            $row.Health = 'green'
        } elseif ($app.Installed) {
            $row.Text = 'not configured'
            $row.Action = 'connect'
        } elseif ($null -eq $configured) {
            $row.Text = 'could not read its settings file'
        } else {
            continue   # not on this PC: no row
        }
        $rows += $row
    }
    # Apps we have no config writer for (Claude Code, VS Code, a custom agent...) still get a row
    # when they have started Tally.
    foreach ($k in @($sightings.Keys | Sort-Object)) {
        if ($k -in @('claude-desktop', 'cursor', 'windsurf', 'lmstudio')) { continue }
        $s = $sightings[$k]
        $rows += @{ Key = $k; Label = $s.Label; Target = ''; Text = "last started Tally $(Format-RelativeTime $s.SeenAt)"; Health = 'green'; Action = '' }
    }
    return $rows
}

# Connect (or repair) one app: run connect-client.ps1 for that target, hidden, then tell the person
# what is left to do. Claude Desktop goes through the tray's existing one-click fix, which also
# offers to restart Claude.
function Invoke-ConnectApp {
    param([string]$Target, [string]$Label)
    if (-not $Label) { $Label = $Target }
    if ($Target -eq 'claude-desktop') { Invoke-ClaudeAutoFix; $script:AiAppsRefreshAt = [datetime]::MinValue; return }
    $connectScript = Join-Path $InstallDir 'scripts\installer\connect-client.ps1'
    if (-not (Test-Path -LiteralPath $connectScript)) {
        [System.Windows.Forms.MessageBox]::Show("The connect step is missing from this install ($connectScript). Reinstall Claudally to repair it.", 'Claudally', 'OK', 'Warning') | Out-Null
        return
    }
    $base = "-ExecutionPolicy Bypass -NoProfile -File `"$connectScript`" -InstallDir `"$InstallDir`" -Target $Target"
    $exitCode = 1
    try {
        $p = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -Wait -PassThru -ArgumentList $base
        $exitCode = $p.ExitCode
    } catch { $exitCode = 1 }
    $script:AiAppsRefreshAt = [datetime]::MinValue

    $app = Get-AiAppDefinitions | Where-Object { $_.Target -eq $Target } | Select-Object -First 1
    $nowConfigured = $false
    if ($app) { $nowConfigured = ((Test-ConfigFilesPointHere -Files $app.Configs -InstallRoot $InstallDir) -eq $true) }

    if ($exitCode -ne 0 -or -not $nowConfigured) {
        $ans = [System.Windows.Forms.MessageBox]::Show(
            "Claudally could not connect $Label to Tally automatically.`r`n`r`nOpen the detailed connect window to see why?",
            'Claudally', 'YesNo', 'Warning')
        if ($ans -eq 'Yes') {
            try { Start-Process -FilePath 'powershell.exe' -ArgumentList "-ExecutionPolicy Bypass -NoProfile -NoExit -File `"$connectScript`" -InstallDir `"$InstallDir`" -Target $Target" } catch { }
        }
        return
    }
    [System.Windows.Forms.MessageBox]::Show(
        "Tally is set up for $Label.`r`n`r`n$Label reads this only when it starts: quit it completely (close every $Label window) and open it again. The Tally tools appear after that.",
        'Claudally', 'OK', 'Information') | Out-Null
}

# Row button handler. Tag = @{ Action; Target; Label }.
function Invoke-AiAppAction {
    param($Info)
    if (-not $Info -or -not $Info.Target) { return }
    Invoke-ConnectApp -Target $Info.Target -Label $Info.Label
}

# --- #39 Offer to connect apps installed after Claudally ----------------------------------------

function Get-TrayStatePath {
    $dir = Join-Path $env:LOCALAPPDATA 'Claudally'
    if (-not (Test-Path -LiteralPath $dir)) {
        try { New-Item -ItemType Directory -Path $dir -Force | Out-Null } catch { return $null }
    }
    return (Join-Path $dir 'tray-state.json')
}

function Read-TrayState {
    $st = @{ schemaVersion = 1; offered = @{} }
    try {
        $path = Get-TrayStatePath
        if (-not $path) { return $st }
        $o = Read-TrayCoordinationJson -Path $path
        if ($o -and $o.offered) {
            foreach ($prop in $o.offered.PSObject.Properties) { $st.offered[$prop.Name] = [string]$prop.Value }
        }
    } catch { }
    return $st
}

function Save-TrayState {
    param($St)
    try {
        $path = Get-TrayStatePath
        if (-not $path) { return }
        $obj = [ordered]@{ schemaVersion = 1; offered = $St.offered }
        [System.IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

# Called from the status poll; does real work at most every 3 minutes (and not in the first 3
# minutes after the tray starts, so the installer's own connect step has time to finish). One
# balloon per check, one offer per app ever: the offer is remembered when it is SHOWN, so dismissing
# it counts as an answer.
$script:LateInstallCheckedAt = Get-Date
function Invoke-LateInstallOffers {
    try {
        if ($State.DeploymentMode -ne 'local') { return }
        if (((Get-Date) - $script:LateInstallCheckedAt).TotalMinutes -lt 3) { return }
        $script:LateInstallCheckedAt = Get-Date
        $st = Read-TrayState
        foreach ($app in Get-AiAppDefinitions) {
            if ($app.Key -notin @('cursor', 'windsurf', 'lmstudio')) { continue }
            if (-not $app.Installed) { continue }
            if ($st.offered.ContainsKey($app.Key)) { continue }
            $cfg = Test-ConfigFilesPointHere -Files $app.Configs -InstallRoot $InstallDir
            if ($cfg -ne $false) { continue }   # connected already, or we cannot tell: do not nag
            $st.offered[$app.Key] = (Get-Date).ToString('o')
            Save-TrayState -St $st
            $script:BalloonAction = "connect:$($app.Target)|$($app.Label)"
            $tray.ShowBalloonTip(15000, "Connect $($app.Label) to Tally?",
                "$($app.Label) is installed on this PC. Click here and Claudally will connect it to Tally.",
                [System.Windows.Forms.ToolTipIcon]::Info)
            return
        }
    } catch { }
}
