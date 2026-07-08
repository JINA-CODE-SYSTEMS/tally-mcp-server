<#
.SYNOPSIS
    Tally MCP Server - status tray icon (issue #20).

.DESCRIPTION
    Polls service / agent task / agent process / Tally / public URL health every
    few seconds and surfaces a coloured tray icon plus a right-click action menu.
    Intended for non-developer operators on client deployments where the four
    Get-Service / Get-ScheduledTask / Get-CimInstance / Get-Process commands the
    issue calls out are not realistic.

    Lives in scripts/tray/ so it ships alongside the GUI agent without polluting
    the existing scripts/ root. Registered as a per-user at-logon scheduled task
    (TallyMCPTray) by firstrun-config.ps1, alongside the GUI agent task.

    No new runtime dependencies: WinForms NotifyIcon + System.Drawing for the
    icon, both already on every Win10+ box. Icons are drawn at startup as PNG
    bitmaps to avoid shipping resource files.

.PARAMETER InstallDir
    The TallyMCP install root. Defaults to the parent of this script's parent.
    Used to find the service .env (for MCP_DOMAIN) and logs folder.

.PARAMETER ServiceName
    Windows service name. Default 'TallyMCP'.

.PARAMETER AgentTaskName
    GUI agent scheduled task name. Default 'TallyMCPAgent'.

.PARAMETER PollIntervalSec
    Seconds between health polls. Default 5. Bump if the polls show up in
    Process Explorer too noisily; lower if you want faster feedback.

.PARAMETER ProbeTimeoutSec
    HTTP probe timeout for the public URL check. Default 3. Long enough for
    a healthy Caddy round-trip, short enough that one bad probe doesn't make
    the whole tray feel unresponsive.

.NOTES
    Quitting from the tray menu only hides the icon - it does NOT stop the
    service or kill the agent. The intent is "I want my taskbar back", not
    "I want to take TallyMCP down".
#>
[CmdletBinding()]
param(
    [string]$InstallDir = $null,
    [string]$ServiceName = 'TallyMCP',
    [string]$AgentTaskName = 'TallyMCPAgent',
    [int]$PollIntervalSec = 5,
    [int]$ProbeTimeoutSec = 3,
    # Passed by the "Open Tally MCP Dashboard" Start Menu / desktop shortcut. If this process becomes
    # the singleton tray it opens the dashboard immediately; if a tray is already running it just
    # signals that instance to show its dashboard and exits (see the single-instance guard below).
    [switch]$ShowDashboard
)

# Resolve InstallDir relative to this file when not provided. The tray script lives at
# <InstallDir>\scripts\tray\tally-mcp-tray.ps1, so we climb three Split-Path -Parents:
# file -> tray\ -> scripts\ -> <InstallDir>. Two splits land us inside scripts\, which
# made every Join-Path against InstallDir double up "scripts\" in dev mode.
if (-not $InstallDir -or -not $InstallDir.Trim()) {
    $InstallDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---------------------------------------------------------------------------
# Single-instance guard. Exactly one tray should run per interactive session (the TallyMCPTray
# at-logon task). The "Open Tally MCP Dashboard" Start Menu / desktop shortcut launches this script
# too; rather than stack a second tray icon, a second launch signals the running instance to pop its
# dashboard, then exits. The names have NO "Global\" prefix, so they are scoped to this desktop
# session - i.e. exactly one tray per logged-in user, which is what we want.
$script:SingletonMutex      = New-Object System.Threading.Mutex($false, 'TallyMCP.Tray.Singleton.v1')
$script:ShowDashboardSignal = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, 'TallyMCP.Tray.ShowDashboard.v1')
$ownsSingleton = $false
try   { $ownsSingleton = $script:SingletonMutex.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $ownsSingleton = $true }  # a prior tray died without releasing; we own it now
if (-not $ownsSingleton) {
    # Another tray already owns this session. Ask it to show the dashboard, then exit so the shortcut
    # click behaves like "bring the app to the front" instead of launching a duplicate tray icon.
    [void]$script:ShowDashboardSignal.Set()
    return
}

# Dot-source the Manage Companies dialog (defines Show-ManageCompaniesDialog). Lives next
# to this script so it ships in the same scripts/tray/ install payload.
$ManageDialogPath = Join-Path (Split-Path -Parent $PSCommandPath) 'manage-companies-dialog.ps1'
if (Test-Path -LiteralPath $ManageDialogPath) { . $ManageDialogPath }

# ---------------------------------------------------------------------------
# State container shared between the polling timer and the menu handlers.
# Single Hashtable rather than a class so the script stays easy to copy-paste-debug.
# ---------------------------------------------------------------------------
$State = [hashtable]::Synchronized(@{
    Service          = $null   # ServiceController | $null
    AgentTask        = $null   # ScheduledTask object | $null
    AgentProcess     = $null   # Process | $null
    TallyProcess     = $null   # Process | $null
    PublicUrl        = ''      # full probe URL or '' if no MCP_DOMAIN set
    PublicUrlOk      = $null   # $true / $false / $null (not configured)
    LoadedCompany    = ''      # best-effort name of currently loaded company, or ''
    LastLoadedAlias  = ''      # alias of most recently Test'd company (highest lastLoadedAt in registry)
    LastPoll         = $null
    LastError        = $null
    PreviousStatus   = $null   # for toast on degradation: 'green'/'yellow'/'red'/'gray'
    AgentWasRunning  = $false  # for toast on agent crash
    ServiceWasRunning = $false # for toast on service stop
})

# ---------------------------------------------------------------------------
# .env parsing - minimal. We only need MCP_DOMAIN to decide whether to probe a
# public URL. Reusing dotenv would mean shipping node, which defeats the
# zero-dependency goal.
# ---------------------------------------------------------------------------
function Read-EnvValue {
    param([string]$EnvPath, [string]$Key)
    if (-not (Test-Path -LiteralPath $EnvPath)) { return '' }
    foreach ($line in (Get-Content -LiteralPath $EnvPath -ErrorAction SilentlyContinue)) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $eq = $trimmed.IndexOf('=')
        if ($eq -lt 1) { continue }
        $k = $trimmed.Substring(0, $eq).Trim()
        if ($k -ne $Key) { continue }
        $v = $trimmed.Substring($eq + 1).Trim()
        # Strip surrounding double-quotes (firstrun-config.ps1 quotes values that may contain '#').
        # For quoted values, '#' inside the quotes is part of the value, not a comment.
        if ($v.Length -ge 2 -and $v.StartsWith('"') -and $v.EndsWith('"')) {
            return $v.Substring(1, $v.Length - 2) -replace '\\"', '"'
        }
        # Unquoted values: strip inline '# comment' (dotenv-style). Matters for .env files
        # copied from .env.example, where empty values like `TALLY_DATA_PATH=    # description`
        # would otherwise return the comment text as the value.
        $hash = $v.IndexOf('#')
        if ($hash -ge 0) { $v = $v.Substring(0, $hash).TrimEnd() }
        return $v
    }
    return ''
}

# Write (replace or append) a single KEY=VALUE in .env, preserving all other lines. Writes in place
# rather than tmp+rename: firstrun-config.ps1 grants the agent user FullControl on the .env FILE
# (icacls ${AgentTaskUser}:F) but not the Program Files directory, so we can rewrite the file but not
# create a sibling .tmp there. Used by the "Allow Claude to control Tally" toggle.
function Set-EnvValue {
    param([string]$EnvPath, [string]$Key, [string]$Value)
    $lines = @()
    if (Test-Path -LiteralPath $EnvPath) { $lines = @(Get-Content -LiteralPath $EnvPath -ErrorAction SilentlyContinue) }
    $replaced = $false
    $out = foreach ($line in $lines) {
        $trimmed = $line.Trim()
        if ($trimmed -and -not $trimmed.StartsWith('#')) {
            $eq = $trimmed.IndexOf('=')
            if ($eq -ge 1 -and $trimmed.Substring(0, $eq).Trim() -eq $Key) {
                $replaced = $true
                "$Key=$Value"
                continue
            }
        }
        $line
    }
    if (-not $replaced) { $out = @($out) + "$Key=$Value" }
    Set-Content -LiteralPath $EnvPath -Value $out -Encoding UTF8
}

# ---------------------------------------------------------------------------
# Icon drawing. WinForms wants a System.Drawing.Icon, so we draw a 16x16 bitmap
# with a coloured filled circle and convert via Icon.FromHandle. We allocate
# all three colour variants once at startup and switch refs at poll time.
# ---------------------------------------------------------------------------
function New-StatusIcon {
    param([System.Drawing.Color]$Fill, [System.Drawing.Color]$Border)
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $brush = New-Object System.Drawing.SolidBrush $Fill
    $pen = New-Object System.Drawing.Pen $Border, 1.0
    $g.FillEllipse($brush, 1, 1, 13, 13)
    $g.DrawEllipse($pen, 1, 1, 13, 13)
    $g.Dispose(); $brush.Dispose(); $pen.Dispose()
    $hicon = $bmp.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($hicon)
    return @{ Icon = $icon; Bitmap = $bmp; Hicon = $hicon }
}

$IconGreen  = New-StatusIcon -Fill ([System.Drawing.Color]::FromArgb(46,160,67))   -Border ([System.Drawing.Color]::FromArgb(20,80,30))
$IconYellow = New-StatusIcon -Fill ([System.Drawing.Color]::FromArgb(218,165,32))  -Border ([System.Drawing.Color]::FromArgb(120,90,15))
$IconRed    = New-StatusIcon -Fill ([System.Drawing.Color]::FromArgb(218,54,51))   -Border ([System.Drawing.Color]::FromArgb(120,25,25))
$IconGray   = New-StatusIcon -Fill ([System.Drawing.Color]::FromArgb(150,150,150)) -Border ([System.Drawing.Color]::FromArgb(80,80,80))

# Icon.FromHandle does NOT take ownership of the HICON. We must DestroyIcon ourselves on shutdown
# or the GDI handles leak for the tray's lifetime. P/Invoke once and reuse on Quit.
Add-Type -Namespace TallyTray -Name User32 -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool DestroyIcon(System.IntPtr hIcon);
"@
function Dispose-StatusIcon {
    param([hashtable]$IconBundle)
    if (-not $IconBundle) { return }
    try { $IconBundle.Icon.Dispose() } catch {}
    try { $IconBundle.Bitmap.Dispose() } catch {}
    try { [void][TallyTray.User32]::DestroyIcon($IconBundle.Hicon) } catch {}
}

# ---------------------------------------------------------------------------
# Health polling. Each probe is wrapped in try/catch so a transient failure on
# one (e.g. agent task lookup raising on a domain-joined box without RSAT)
# never breaks the whole tray.
# ---------------------------------------------------------------------------
function Invoke-StatusPoll {
    $State.LastPoll = Get-Date
    $State.LastError = $null

    try {
        $State.Service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    } catch { $State.Service = $null; $State.LastError = "service: $_" }

    try {
        # Get-ScheduledTask returns CIM instance objects; .State is 'Running' / 'Ready' / 'Disabled' / etc.
        $State.AgentTask = Get-ScheduledTask -TaskName $AgentTaskName -ErrorAction SilentlyContinue
    } catch { $State.AgentTask = $null }

    try {
        # Find the actual running agent process (different from "task is registered"). The task can
        # be Ready (idle/registered) while the process has crashed; we want to know about that.
        # CIM filter on Name, then substring-match the command line. Loose match is fine - we only
        # care that the agent script is somewhere in the args.
        $procs = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine -like '*tally-gui-agent-v2.ps1*' }
        if ($procs) {
            $State.AgentProcess = $procs | Select-Object -First 1
        } else {
            $State.AgentProcess = $null
        }
    } catch { $State.AgentProcess = $null }

    try {
        $State.TallyProcess = Get-Process -Name 'tally' -ErrorAction SilentlyContinue | Select-Object -First 1
    } catch { $State.TallyProcess = $null }

    # Public URL probe is optional - if MCP_DOMAIN is unset, the operator is running localhost-only
    # and there's nothing to probe externally. Probe the local OAuth metadata endpoint instead so
    # at least one signal of "the HTTP listener is up" reaches the tray.
    try {
        $envFile = Join-Path $InstallDir '.env'
        $domain = Read-EnvValue -EnvPath $envFile -Key 'MCP_DOMAIN'
        if ($domain) {
            $base = $domain
            if ($base -notmatch '^https?://') { $base = "https://$base" }
            $base = $base.TrimEnd('/')
            $State.PublicUrl = "$base/.well-known/oauth-protected-resource"
        } else {
            $State.PublicUrl = 'http://127.0.0.1:3000/.well-known/oauth-protected-resource'
        }
        $resp = Invoke-WebRequest -Uri $State.PublicUrl -UseBasicParsing -TimeoutSec $ProbeTimeoutSec -ErrorAction Stop
        $State.PublicUrlOk = ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500)
    } catch {
        $State.PublicUrlOk = $false
    }

    # Pick the alias with the most recent lastLoadedAt timestamp from the company
    # registry. Used by the "Reload last company" menu item. Silently empty if
    # the registry file is missing, malformed, or no entries have ever been tested.
    try {
        $envFile = Join-Path $InstallDir '.env'
        $dataPath = Read-EnvValue -EnvPath $envFile -Key 'TALLY_DATA_PATH'
        if (-not $dataPath) { $dataPath = 'C:\Users\Public\TallyPrimeEditLog\data' }
        $regPath = Join-Path $dataPath '.tally-mcp-companies.json'
        if (Test-Path -LiteralPath $regPath) {
            $raw = (Get-Content -LiteralPath $regPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue) -replace '^﻿', ''
            if ($raw) {
                $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
                $latest = $parsed.companies | Where-Object { $_.lastLoadedAt } |
                    Sort-Object { try { [datetime]$_.lastLoadedAt } catch { [datetime]::MinValue } } -Descending |
                    Select-Object -First 1
                $State.LastLoadedAlias = if ($latest) { [string]$latest.alias } else { '' }
            }
        }
    } catch { $State.LastLoadedAlias = '' }

    # Best-effort "what's loaded right now" via the in-process Tally XML server. Fast probe (<200ms
    # when Tally is up; instant timeout when it's not). Skipped if Tally isn't running to avoid
    # poll-interval-sized delays from blocked TCP connects.
    if ($State.TallyProcess) {
        try {
            $body = '<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER></ENVELOPE>'
            $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:9000/' -Method POST -Body $body -ContentType 'text/xml; charset=utf-8' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            # Tally returns an XML-like list of companies; the first <COMPANY NAME="..."> is the active one.
            # Simple regex extract - full XML parse is unwarranted for a tooltip string.
            # Tally's "List of Companies" envelope returns <NAME>...</NAME> tags inside <COMPANY>
            # blocks (verified against a real Tally Prime Edit Log instance). Take the first <NAME>.
            $match = [regex]::Match($resp.Content, '<NAME>([^<]+)</NAME>', 'IgnoreCase')
            if ($match.Success) {
                $State.LoadedCompany = $match.Groups[1].Value.Trim()
            } else {
                $State.LoadedCompany = ''
            }
        } catch {
            $State.LoadedCompany = ''
        }
    } else {
        $State.LoadedCompany = ''
    }
}

# ---------------------------------------------------------------------------
# Status -> icon colour. Green = everything we expect to be running is running.
# Yellow = at least one degraded but core service is up (e.g. agent down but
# service alive - load-company will fail but read-only tools still work).
# Red = the MCP service itself is down or missing.
# Gray = first poll hasn't completed yet.
# ---------------------------------------------------------------------------
function Get-OverallStatus {
    if (-not $State.LastPoll) { return 'gray' }
    $serviceOk = $State.Service -and $State.Service.Status -eq 'Running'
    $agentOk   = ($State.AgentTask -and $State.AgentTask.State -in @('Running', 'Ready')) -and $State.AgentProcess
    $urlOk     = $State.PublicUrlOk -eq $true

    if (-not $serviceOk) { return 'red' }
    if ($agentOk -and $urlOk) { return 'green' }
    # Service running but something downstream is degraded - yellow rather than red. The MCP
    # endpoint may still be reachable and useful for read-only tools even with no agent.
    return 'yellow'
}

function Format-Tooltip {
    $lines = @("TallyMCP")
    if (-not $State.LastPoll) {
        $lines += '  (initializing...)'
        return ($lines -join "`r`n")
    }
    if ($State.Service) {
        $lines += "  Service:  $($State.Service.Status)"
    } else {
        $lines += "  Service:  not installed"
    }
    if ($State.AgentTask) {
        $procPart = if ($State.AgentProcess) { "PID $($State.AgentProcess.ProcessId)" } else { 'no process' }
        $lines += "  Agent:    $($State.AgentTask.State) ($procPart)"
    } else {
        $lines += "  Agent:    task not registered"
    }
    if ($State.TallyProcess) {
        $cmp = if ($State.LoadedCompany) { " - $($State.LoadedCompany)" } else { '' }
        $lines += "  Tally:    Running$cmp"
    } else {
        $lines += "  Tally:    not running"
    }
    if ($null -ne $State.PublicUrlOk) {
        $urlState = if ($State.PublicUrlOk) { 'OK' } else { 'unreachable' }
        $lines += "  URL:      $urlState"
    }
    return ($lines -join "`r`n")
}

# ---------------------------------------------------------------------------
# Tray icon + menu setup
# ---------------------------------------------------------------------------
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $IconGray.Icon
$tray.Text = 'TallyMCP (initializing)'  # NotifyIcon.Text is capped at 63 chars on older Win versions
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

# Header items - these are status read-outs, not actions. Disabled but not hidden.
$miHeader = $menu.Items.Add('TallyMCP - polling...')
$miHeader.Enabled = $false

$miServiceState = $menu.Items.Add('  Service: -')
$miServiceState.Enabled = $false
$miAgentState = $menu.Items.Add('  Agent task: -')
$miAgentState.Enabled = $false
$miTallyState = $menu.Items.Add('  Tally: -')
$miTallyState.Enabled = $false
$miUrlState = $menu.Items.Add('  Public URL: -')
$miUrlState.Enabled = $false

[void]$menu.Items.Add('-')

# Action items
$miOpenLogs = $menu.Items.Add('Open logs folder')
$miOpenLogs.Add_Click({
    $logsDir = Join-Path $InstallDir 'logs'
    if (Test-Path -LiteralPath $logsDir) {
        Start-Process -FilePath 'explorer.exe' -ArgumentList $logsDir
    } else {
        [System.Windows.Forms.MessageBox]::Show("Logs folder not found at $logsDir", 'TallyMCP', 'OK', 'Warning') | Out-Null
    }
})

# Opens File Explorer with the registry .json highlighted. Useful for support
# scenarios where you need to email someone the file, or hand-edit a stray entry.
$miOpenRegistry = $menu.Items.Add('Open registry file')
$miOpenRegistry.Add_Click({
    $envFile = Join-Path $InstallDir '.env'
    $dataPath = Read-EnvValue -EnvPath $envFile -Key 'TALLY_DATA_PATH'
    if (-not $dataPath) { $dataPath = 'C:\Users\Public\TallyPrimeEditLog\data' }
    $regPath = Join-Path $dataPath '.tally-mcp-companies.json'
    if (Test-Path -LiteralPath $regPath) {
        Start-Process -FilePath 'explorer.exe' -ArgumentList "/select,`"$regPath`""
    } elseif (Test-Path -LiteralPath $dataPath) {
        $msg = "Registry file does not exist yet:`n  $regPath`n`nIt is created on the first Add or Import CSV. Opening the parent folder instead."
        [System.Windows.Forms.MessageBox]::Show($msg, 'TallyMCP', 'OK', 'Information') | Out-Null
        Start-Process -FilePath 'explorer.exe' -ArgumentList $dataPath
    } else {
        [System.Windows.Forms.MessageBox]::Show("Registry data folder not found: $dataPath", 'TallyMCP', 'OK', 'Warning') | Out-Null
    }
})

$miRestartService = $menu.Items.Add('Restart service')
$miRestartService.Add_Click({
    try {
        # Service control needs admin. RunAs verb prompts UAC; the actual stop/start runs
        # in a separate elevated PowerShell so the tray (running unelevated as the user) doesn't
        # have to be admin itself.
        # IMPORTANT: do NOT use Restart-Service / Stop-Service. Node-under-NSSM does not have a
        # working SIGTERM/SIGINT handler in service context, so graceful stop hangs reliably and
        # SCM ends up in StopPending. Mirror deploy.ps1's pattern: taskkill node, then Start-Service.
        $cmd = @"
taskkill /F /IM node.exe 2>`$null | Out-Null
Start-Sleep -Seconds 3
Start-Service -Name '$ServiceName' -ErrorAction Stop
Start-Sleep -Seconds 2
Get-Service -Name '$ServiceName' | Out-String | Write-Host
Start-Sleep -Seconds 3
"@
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', $cmd) -Verb RunAs -WindowStyle Hidden
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Restart failed: $_", 'TallyMCP', 'OK', 'Error') | Out-Null
    }
})

# Fully stop the service (leaves it Stopped, not respawned). Use 'Restart service' to start it again.
$miStopService = $menu.Items.Add('Stop service')
$miStopService.Add_Click({
    try {
        $confirm = [System.Windows.Forms.MessageBox]::Show(
            "Stop the TallyMCP service?`n`nAll MCP tools become unavailable (any Claude session using them will fail) until you start it again with `"Restart service`".",
            'TallyMCP', 'OKCancel', 'Warning')
        if ($confirm -ne 'OK') { return }
        # Elevated, like Restart. Use `sc.exe stop` (non-blocking — it sends the STOP control and
        # returns immediately, so this can't hang the hidden window in StopPending), which puts NSSM
        # into stopping mode, then taskkill node as a fallback: on a pre-#23 install whose graceful
        # stop stalls, killing node lets NSSM finish reaching Stopped. Because the service is already
        # stopping, NSSM will NOT respawn the killed process.
        $cmd = @"
sc.exe stop '$ServiceName' | Out-Null
Start-Sleep -Seconds 2
taskkill /F /IM node.exe 2>`$null | Out-Null
Start-Sleep -Seconds 2
sc.exe query '$ServiceName' | Out-String | Write-Host
"@
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', $cmd) -Verb RunAs -WindowStyle Hidden
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Stop failed: $_", 'TallyMCP', 'OK', 'Error') | Out-Null
    }
})

$miRestartAgent = $menu.Items.Add('Restart GUI agent')
$miRestartAgent.Add_Click({
    try {
        # If the agent task was never registered (e.g. the install didn't finish the agent step),
        # Start-ScheduledTask below throws a cryptic "cannot find the file specified". Detect that
        # up front and point the operator at Reconfigure, which registers the task.
        if (-not (Get-ScheduledTask -TaskName $AgentTaskName -ErrorAction SilentlyContinue)) {
            [System.Windows.Forms.MessageBox]::Show(
                "The GUI agent scheduled task ('$AgentTaskName') is not registered, so there is nothing to restart.`n`nRun `"Reconfigure...`" to register it (or re-run the installer). Make sure the Windows user shown in the wizard is your actual logon name.",
                'TallyMCP', 'OK', 'Warning') | Out-Null
            return
        }
        # Agent task runs as the current user already, so no elevation needed.
        Stop-ScheduledTask -TaskName $AgentTaskName -ErrorAction SilentlyContinue
        # Also kill any leftover powershell.exe instances running the agent script - Stop-ScheduledTask
        # ends the task, but if the agent was launched manually it's not a task instance.
        # Tighten the match: also require -File pointing at the bundled agent path, so we don't
        # accidentally kill a maintainer's own PowerShell window that happens to have the script
        # name in scrollback or a different command line.
        $bundledAgent = Join-Path $InstallDir 'scripts\tally-gui-agent-v2.ps1'
        Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine -like "*-File*" -and
                $_.CommandLine -like "*$bundledAgent*"
            } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

        # Wait for the task to actually report not-Running before starting again. Stop-ScheduledTask
        # returns before the underlying process is fully gone; a too-quick Start can collide with
        # the engine still tearing down the previous instance.
        $deadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $deadline) {
            $t = Get-ScheduledTask -TaskName $AgentTaskName -ErrorAction SilentlyContinue
            if (-not $t -or $t.State -ne 'Running') { break }
            Start-Sleep -Milliseconds 200
        }

        Start-ScheduledTask -TaskName $AgentTaskName -ErrorAction Stop
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Restart agent failed: $_", 'TallyMCP', 'OK', 'Error') | Out-Null
    }
})

# Toggle Claude-driven GUI control (ENABLE_GUI_CONTROL). Checkable; reflects current .env at build
# time. Enabling warns (arbitrary keystroke injection + screenshots) and restarts the service so the
# server re-reads .env. Since #23 the server loads .env by absolute path, so a plain restart applies it.
$miGuiControl = $menu.Items.Add('Allow Claude to control Tally (advanced)')
$miGuiControl.Checked = ((Read-EnvValue -EnvPath (Join-Path $InstallDir '.env') -Key 'ENABLE_GUI_CONTROL') -eq 'true')
$miGuiControl.Add_Click({
    try {
        $envFile = Join-Path $InstallDir '.env'
        $cur = Read-EnvValue -EnvPath $envFile -Key 'ENABLE_GUI_CONTROL'
        $newVal = if ($cur -eq 'true') { 'false' } else { 'true' }
        if ($newVal -eq 'true') {
            $warn = "Enable Claude-driven GUI control?`n`nThis lets Claude capture screenshots of the Tally window and send arbitrary keystrokes to it. Only enable on a machine you trust.`n`nThe service will restart to apply the change."
            if ([System.Windows.Forms.MessageBox]::Show($warn, 'TallyMCP', 'OKCancel', 'Warning') -ne 'OK') { return }
        }
        Set-EnvValue -EnvPath $envFile -Key 'ENABLE_GUI_CONTROL' -Value $newVal
        $this.Checked = ($newVal -eq 'true')
        # Same elevated restart as 'Restart service' (node-under-NSSM: taskkill + Start-Service).
        $cmd = @"
taskkill /F /IM node.exe 2>`$null | Out-Null
Start-Sleep -Seconds 3
Start-Service -Name '$ServiceName' -ErrorAction Stop
"@
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', $cmd) -Verb RunAs -WindowStyle Hidden
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Toggle GUI control failed: $_", 'TallyMCP', 'OK', 'Error') | Out-Null
    }
})

$miLaunchTally = $menu.Items.Add('Launch Tally Prime')
$miLaunchTally.Add_Click({
    $envFile = Join-Path $InstallDir '.env'
    $exe = Read-EnvValue -EnvPath $envFile -Key 'TALLY_EXE_PATH'
    if (-not $exe) { $exe = 'C:\Program Files\TallyPrimeEditLog\tally.exe' }
    if (-not (Test-Path -LiteralPath $exe)) {
        [System.Windows.Forms.MessageBox]::Show("tally.exe not found at: $exe`n`nUpdate TALLY_EXE_PATH in .env via Reconfigure.", 'TallyMCP', 'OK', 'Warning') | Out-Null
        return
    }
    try {
        Start-Process -FilePath $exe
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Launch failed: $_", 'TallyMCP', 'OK', 'Error') | Out-Null
    }
})

# Reloads whichever company was most recently Test'd via the Manage Companies
# dialog (looked up by max(lastLoadedAt) on each poll). Decrypts the stored
# password via the DPAPI helper, then hands the load off to the GUI agent IPC
# (same path the dialog's Test button uses). Disabled when no alias has ever
# been Test'd or when the helper functions aren't loaded.
$miReloadLast = $menu.Items.Add('Reload last company')
$miReloadLast.Enabled = $false
$miReloadLast.Add_Click({
    if (-not $State.LastLoadedAlias) { return }
    $alias = $State.LastLoadedAlias
    $envFile = Join-Path $InstallDir '.env'
    $dataPath = Read-EnvValue -EnvPath $envFile -Key 'TALLY_DATA_PATH'
    if (-not $dataPath) { $dataPath = 'C:\Users\Public\TallyPrimeEditLog\data' }
    $regPath = Join-Path $dataPath '.tally-mcp-companies.json'
    $dpapi   = Join-Path $InstallDir 'scripts\dpapi-helper.ps1'
    if (-not (Get-Command Read-CompanyRegistry -ErrorAction SilentlyContinue) -or
        -not (Get-Command Invoke-LoadCompanyViaAgent -ErrorAction SilentlyContinue)) {
        [System.Windows.Forms.MessageBox]::Show("Manage Companies helpers not loaded. Reinstall TallyMCP to restore.", 'TallyMCP', 'OK', 'Warning') | Out-Null
        return
    }
    try {
        $reg = Read-CompanyRegistry -Path $regPath
        $entry = $reg.companies | Where-Object { $_.alias -eq $alias } | Select-Object -First 1
        if (-not $entry) {
            [System.Windows.Forms.MessageBox]::Show("Alias '$alias' is no longer in the registry.", 'TallyMCP', 'OK', 'Warning') | Out-Null
            return
        }
        $plain = ''
        if ($entry.passwordEnc) {
            try { $plain = Unprotect-PasswordViaHelper -HelperPath $dpapi -Blob $entry.passwordEnc }
            catch {
                [System.Windows.Forms.MessageBox]::Show("Could not decrypt password for '$alias': $_", 'TallyMCP', 'OK', 'Error') | Out-Null
                return
            }
        }
        $tray.ShowBalloonTip(2500, 'TallyMCP', "Reloading '$alias'...", [System.Windows.Forms.ToolTipIcon]::Info)
        $result = Invoke-LoadCompanyViaAgent -RegistryPath $regPath -FolderId $entry.folderId -Username $entry.username -Password $plain
        if ($result.ok) {
            $tray.ShowBalloonTip(4000, 'TallyMCP', "Reloaded '$alias': $($result.message)", [System.Windows.Forms.ToolTipIcon]::Info)
        } else {
            $tray.ShowBalloonTip(6000, 'TallyMCP - reload failed', "Couldn't reload '$alias' - $($result.message)", [System.Windows.Forms.ToolTipIcon]::Warning)
        }
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Reload last company failed: $_", 'TallyMCP', 'OK', 'Error') | Out-Null
    }
})

$miManageCompanies = $menu.Items.Add('Manage Companies...')
$miManageCompanies.Add_Click({
    if (-not (Get-Command Show-ManageCompaniesDialog -ErrorAction SilentlyContinue)) {
        [System.Windows.Forms.MessageBox]::Show("Manage Companies dialog script not loaded.`nExpected: $ManageDialogPath", 'TallyMCP', 'OK', 'Warning') | Out-Null
        return
    }
    # Resolve registry + DPAPI helper paths from InstallDir. Falls back to the install-time
    # default if TALLY_DATA_PATH is unset; the dialog itself handles a missing file gracefully.
    $envFile = Join-Path $InstallDir '.env'
    $dataPath = Read-EnvValue -EnvPath $envFile -Key 'TALLY_DATA_PATH'
    if (-not $dataPath) { $dataPath = 'C:\Users\Public\TallyPrimeEditLog\data' }
    $registryPath = Join-Path $dataPath '.tally-mcp-companies.json'
    $dpapiHelper  = Join-Path $InstallDir 'scripts\dpapi-helper.ps1'
    if (-not (Test-Path -LiteralPath $dpapiHelper)) {
        [System.Windows.Forms.MessageBox]::Show("DPAPI helper not found at: $dpapiHelper`nReinstall TallyMCP to restore.", 'TallyMCP', 'OK', 'Warning') | Out-Null
        return
    }
    try {
        Show-ManageCompaniesDialog -RegistryPath $registryPath -DpapiHelperPath $dpapiHelper
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Manage Companies dialog failed: $_", 'TallyMCP', 'OK', 'Error') | Out-Null
    }
})

$miReconfigure = $menu.Items.Add('Reconfigure...')
$miReconfigure.Add_Click({
    $script = Join-Path $InstallDir 'scripts\installer\firstrun-config.ps1'
    if (-not (Test-Path -LiteralPath $script)) {
        [System.Windows.Forms.MessageBox]::Show("Reconfigure script not found at: $script", 'TallyMCP', 'OK', 'Warning') | Out-Null
        return
    }
    # Reconfigure modifies .env and re-registers the NSSM service, both admin-only operations.
    # Build a single -ArgumentList string with the path values wrapped in embedded double-quotes.
    # Windows PowerShell 5.1 joins an ARRAY -ArgumentList with single spaces and does NOT quote
    # elements containing spaces, so the default install path C:\Program Files\TallyMCP (has a
    # space) would truncate -File / -InstallDir and the elevated window would error out. Mirror
    # firstrun-config.ps1's idiom (`"$path`"). -NoExit leaves the window open so the operator
    # can read the result.
    $reconfigArgs = "-ExecutionPolicy Bypass -NoProfile -NoExit -File `"$script`" -InstallDir `"$InstallDir`""
    Start-Process -FilePath 'powershell.exe' -ArgumentList $reconfigArgs -Verb RunAs
})

[void]$menu.Items.Add('-')

$miQuit = $menu.Items.Add('Quit (hide tray)')
$miQuit.Add_Click({
    $tray.Visible = $false
    $tray.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

$tray.ContextMenuStrip = $menu

# ---------------------------------------------------------------------------
# Dashboard window (double-click target). Single modeless Form that mirrors
# the tray menu's status read-out + actions, plus the JINA CODE SYSTEMS brand
# and the bundled LICENSE text. Built lazily on first double-click and re-used
# on subsequent opens (so the logo bitmap is loaded once, not per-open).
#
# Wired to the existing menu items via PerformClick so the dashboard buttons
# and the right-click menu share one implementation per action.
# ---------------------------------------------------------------------------
$Dashboard       = $null     # the Form instance, or $null if never opened / disposed
$DashboardLabels = $null     # per-row hashtable { Pill; Dot; Word; Detail } of the live status widgets

# ---------------------------------------------------------------------------
# Dashboard skin helpers (flat/modern reskin). All best-effort: any failure degrades
# gracefully (e.g. a square pill instead of a rounded one) rather than breaking the form.
# ---------------------------------------------------------------------------

# Rounded-rectangle region for pills/dots. R is the corner radius; R = height/2 gives a full pill.
function New-RoundedRegion {
    param([int]$W, [int]$H, [int]$R)
    try {
        if ($R * 2 -gt $W) { $R = [int]($W / 2) }
        if ($R * 2 -gt $H) { $R = [int]($H / 2) }
        $d = 2 * $R
        $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
        $gp.AddArc(0, 0, $d, $d, 180, 90)
        $gp.AddArc($W - $d, 0, $d, $d, 270, 90)
        $gp.AddArc($W - $d, $H - $d, $d, $d, 0, 90)
        $gp.AddArc(0, $H - $d, $d, $d, 90, 90)
        $gp.CloseFigure()
        return New-Object System.Drawing.Region $gp
    } catch { return $null }
}

# Colours for a health state: dot fill, pill background tint, pill text.
function Get-HealthPalette {
    param([string]$Health)
    switch ($Health) {
        'green' { @{ Dot = [System.Drawing.Color]::FromArgb(22,163,74);  Bg = [System.Drawing.Color]::FromArgb(220,247,233); Text = [System.Drawing.Color]::FromArgb(21,128,61) } }
        'amber' { @{ Dot = [System.Drawing.Color]::FromArgb(217,119,6);  Bg = [System.Drawing.Color]::FromArgb(254,243,199); Text = [System.Drawing.Color]::FromArgb(146,64,14) } }
        'red'   { @{ Dot = [System.Drawing.Color]::FromArgb(220,69,69);  Bg = [System.Drawing.Color]::FromArgb(254,226,226); Text = [System.Drawing.Color]::FromArgb(153,27,27) } }
        default { @{ Dot = [System.Drawing.Color]::FromArgb(156,163,175); Bg = [System.Drawing.Color]::FromArgb(243,244,246); Text = [System.Drawing.Color]::FromArgb(75,85,99) } }
    }
}

# A borderless "card": white panel with a 1px light border drawn in Paint + an optional bold header.
function New-DashCard {
    param([int]$X, [int]$Y, [int]$W, [int]$H, [System.Windows.Forms.AnchorStyles]$Anchor, [string]$Title)
    $card = New-Object System.Windows.Forms.Panel
    $card.Location  = New-Object System.Drawing.Point $X, $Y
    $card.Size      = New-Object System.Drawing.Size $W, $H
    $card.BackColor = [System.Drawing.Color]::White
    $card.Anchor    = $Anchor
    $card.Add_Paint({
        param($s, $e)
        $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(229,231,235))
        $e.Graphics.DrawRectangle($pen, 0, 0, $s.ClientSize.Width - 1, $s.ClientSize.Height - 1)
        $pen.Dispose()
    })
    # Redraw the whole border when the card is resized (anchored cards grow with the window),
    # otherwise the right/bottom edge can smear.
    $card.Add_Resize({ param($s, $e) $s.Invalidate() })
    if ($Title) {
        $hl = New-Object System.Windows.Forms.Label
        $hl.Text      = $Title
        $hl.Font      = New-Object System.Drawing.Font 'Segoe UI Semibold', 10
        $hl.ForeColor = [System.Drawing.Color]::FromArgb(55,65,81)
        $hl.BackColor = [System.Drawing.Color]::Transparent
        $hl.AutoSize  = $true
        $hl.Location  = New-Object System.Drawing.Point 14, 10
        $card.Controls.Add($hl)
    }
    return $card
}

# Flat button styling with brand-accent hover. Kind = 'primary' (orange) | 'danger' (red) | 'secondary'.
function Set-FlatButton {
    param($Btn, [string]$Kind = 'secondary')
    $Btn.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $Btn.Font      = New-Object System.Drawing.Font 'Segoe UI', 9
    $Btn.Cursor    = [System.Windows.Forms.Cursors]::Hand
    $Btn.UseVisualStyleBackColor = $false
    switch ($Kind) {
        'primary' {
            $Btn.BackColor = [System.Drawing.Color]::FromArgb(255,140,0)
            $Btn.ForeColor = [System.Drawing.Color]::White
            $Btn.FlatAppearance.BorderSize = 0
            $Btn.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(255,158,46)
            $Btn.FlatAppearance.MouseDownBackColor = [System.Drawing.Color]::FromArgb(230,126,0)
        }
        'danger' {
            $Btn.BackColor = [System.Drawing.Color]::White
            $Btn.ForeColor = [System.Drawing.Color]::FromArgb(185,28,28)
            $Btn.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(252,205,205)
            $Btn.FlatAppearance.BorderSize = 1
            $Btn.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(254,242,242)
        }
        default {
            $Btn.BackColor = [System.Drawing.Color]::White
            $Btn.ForeColor = [System.Drawing.Color]::FromArgb(55,65,81)
            $Btn.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(209,213,219)
            $Btn.FlatAppearance.BorderSize = 1
            $Btn.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(243,244,246)
        }
    }
}

# Update one status row: colour the pill/dot/text, size the pill to its word, slide the detail after it.
function Set-StatusRow {
    param($Row, [string]$Word, [string]$Detail, [string]$Health)
    if (-not $Row) { return }
    $pal = Get-HealthPalette $Health
    $Row.Word.Text      = $Word
    $Row.Word.ForeColor  = $pal.Text
    $Row.Pill.BackColor = $pal.Bg
    $Row.Dot.BackColor  = $pal.Dot
    $Row.Detail.Text    = $Detail
    $pillW = 26 + $Row.Word.PreferredWidth + 12
    $Row.Pill.Width = $pillW
    $rgn = New-RoundedRegion $pillW $Row.Pill.Height ([int]($Row.Pill.Height / 2))
    if ($rgn) { $Row.Pill.Region = $rgn }
    $Row.Detail.Left = $Row.Pill.Right + 10
}

function Show-Dashboard {
    if ($Dashboard -and -not $Dashboard.IsDisposed) {
        # Already open - just bring to front. Set TopMost briefly so it pops above
        # other windows even when called from a tray click that has no input focus.
        if ($Dashboard.WindowState -eq [System.Windows.Forms.FormWindowState]::Minimized) {
            $Dashboard.WindowState = [System.Windows.Forms.FormWindowState]::Normal
        }
        $Dashboard.TopMost = $true; $Dashboard.TopMost = $false
        $Dashboard.Activate()
        return
    }

    $form = New-Object System.Windows.Forms.Form
    $form.Text          = 'Claudally - Dashboard'
    $form.Size          = New-Object System.Drawing.Size 660, 720
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $form.MinimumSize   = New-Object System.Drawing.Size 580, 640
    # Light-grey canvas so the white cards read as raised surfaces (modern flat look).
    $form.BackColor     = [System.Drawing.Color]::FromArgb(244, 245, 247)
    $form.Font          = New-Object System.Drawing.Font 'Segoe UI', 9
    $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi

    # --- Header band: Claudally logo + product name + publisher + version, with a thin orange
    #     brand rule along its bottom edge. White, anchored top, fixed height. ---
    $header = New-Object System.Windows.Forms.Panel
    $header.Dock      = [System.Windows.Forms.DockStyle]::Top
    $header.Height    = 96
    $header.BackColor = [System.Drawing.Color]::White
    $form.Controls.Add($header)

    $accent = New-Object System.Windows.Forms.Panel
    $accent.Dock      = [System.Windows.Forms.DockStyle]::Bottom
    $accent.Height    = 3
    $accent.BackColor = [System.Drawing.Color]::FromArgb(255, 140, 0)
    $header.Controls.Add($accent)

    # Prefer the Claudally brand mark; fall back to the legacy JINA logo if it isn't present.
    $logoPath = Join-Path $PSScriptRoot 'assets\claudally-logo.png'
    if (-not (Test-Path -LiteralPath $logoPath)) { $logoPath = Join-Path $PSScriptRoot 'assets\jina-logo.png' }
    if (Test-Path -LiteralPath $logoPath) {
        $pic = New-Object System.Windows.Forms.PictureBox
        $pic.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
        $pic.Location = New-Object System.Drawing.Point 20, 16
        $pic.Size     = New-Object System.Drawing.Size 64, 64
        try { $pic.Image = [System.Drawing.Image]::FromFile($logoPath) } catch {}
        $header.Controls.Add($pic)
    }

    $lblProduct = New-Object System.Windows.Forms.Label
    $lblProduct.Text      = 'Claudally'
    $lblProduct.Font      = New-Object System.Drawing.Font 'Segoe UI Semibold', 18
    $lblProduct.ForeColor = [System.Drawing.Color]::FromArgb(31, 41, 55)
    $lblProduct.BackColor = [System.Drawing.Color]::Transparent
    $lblProduct.AutoSize  = $true
    $lblProduct.Location  = New-Object System.Drawing.Point 100, 18
    $header.Controls.Add($lblProduct)

    $lblPublisher = New-Object System.Windows.Forms.Label
    $lblPublisher.Text      = 'by JINA CODE SYSTEMS LLP'
    $lblPublisher.Font      = New-Object System.Drawing.Font 'Segoe UI', 9
    $lblPublisher.ForeColor = [System.Drawing.Color]::FromArgb(107, 114, 128)
    $lblPublisher.BackColor = [System.Drawing.Color]::Transparent
    $lblPublisher.AutoSize  = $true
    $lblPublisher.Location  = New-Object System.Drawing.Point 102, 52
    $header.Controls.Add($lblPublisher)

    $lblVersion = New-Object System.Windows.Forms.Label
    $lblVersion.Text      = 'v1.1.0'
    $lblVersion.Font      = New-Object System.Drawing.Font 'Segoe UI', 9
    $lblVersion.ForeColor = [System.Drawing.Color]::FromArgb(156, 163, 175)
    $lblVersion.BackColor = [System.Drawing.Color]::Transparent
    $lblVersion.AutoSize  = $true
    $lblVersion.Location  = New-Object System.Drawing.Point 102, 70
    $header.Controls.Add($lblVersion)

    # --- Status card: 4 live rows (Service / Agent / Tally / Public URL), each a health "pill"
    #     (coloured dot + word) plus a plain detail string. Refreshed by Update-DashboardUi. ---
    $status = New-DashCard 16 104 600 150 ([System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right) 'Status'
    $form.Controls.Add($status)

    $labels = @{}
    $rowY = 42
    foreach ($name in @('Service','Agent','Tally','PublicUrl')) {
        $caption = New-Object System.Windows.Forms.Label
        $caption.Text      = switch ($name) {
            'Service'   { 'Service' }
            'Agent'     { 'GUI agent' }
            'Tally'     { 'Tally' }
            'PublicUrl' { 'Public URL' }
        }
        $caption.Location  = New-Object System.Drawing.Point 16, ($rowY + 2)
        $caption.Size      = New-Object System.Drawing.Size 84, 18
        $caption.Font      = New-Object System.Drawing.Font 'Segoe UI Semibold', 9
        $caption.ForeColor = [System.Drawing.Color]::FromArgb(55, 65, 81)
        $caption.BackColor = [System.Drawing.Color]::Transparent
        $status.Controls.Add($caption)

        # Pill: rounded tinted badge holding the dot + status word.
        $pill = New-Object System.Windows.Forms.Panel
        $pill.Location  = New-Object System.Drawing.Point 104, ($rowY - 1)
        $pill.Size      = New-Object System.Drawing.Size 96, 22
        $pill.BackColor = [System.Drawing.Color]::FromArgb(243, 244, 246)
        $rgn0 = New-RoundedRegion 96 22 11
        if ($rgn0) { $pill.Region = $rgn0 }
        $status.Controls.Add($pill)

        $dot = New-Object System.Windows.Forms.Panel
        $dot.Location  = New-Object System.Drawing.Point 11, 7
        $dot.Size      = New-Object System.Drawing.Size 8, 8
        $dot.BackColor = [System.Drawing.Color]::FromArgb(156, 163, 175)
        $dotRgn = New-RoundedRegion 8 8 4
        if ($dotRgn) { $dot.Region = $dotRgn }
        $pill.Controls.Add($dot)

        $word = New-Object System.Windows.Forms.Label
        $word.Text      = '-'
        $word.Font      = New-Object System.Drawing.Font 'Segoe UI Semibold', 9
        $word.ForeColor = [System.Drawing.Color]::FromArgb(75, 85, 99)
        $word.BackColor = [System.Drawing.Color]::Transparent
        $word.AutoSize  = $true
        $word.Location  = New-Object System.Drawing.Point 24, 3
        $pill.Controls.Add($word)

        $detail = New-Object System.Windows.Forms.Label
        $detail.Text      = ''
        $detail.Font      = New-Object System.Drawing.Font 'Segoe UI', 9
        $detail.ForeColor = [System.Drawing.Color]::FromArgb(107, 114, 128)
        $detail.BackColor = [System.Drawing.Color]::Transparent
        $detail.AutoEllipsis = $true
        $detail.Location  = New-Object System.Drawing.Point 210, ($rowY + 2)
        $detail.Size      = New-Object System.Drawing.Size 372, 18
        $detail.Anchor    = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
        $status.Controls.Add($detail)

        $labels[$name] = @{ Pill = $pill; Dot = $dot; Word = $word; Detail = $detail }
        $rowY += 27
    }

    # --- Actions card: 3x3 grid of flat buttons. Each .PerformClick()s the corresponding
    # right-click ToolStripMenuItem so the implementation stays in one place. ---
    $actions = New-DashCard 16 266 600 174 ([System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right) 'Actions'
    $form.Controls.Add($actions)

    $btnSpecs = @(
        @{ Text = 'Restart service';      X =  14; Y = 42;  Kind = 'primary';   Click = { $miRestartService.PerformClick() } },
        @{ Text = 'Restart GUI agent';    X = 202; Y = 42;  Kind = 'secondary'; Click = { $miRestartAgent.PerformClick() } },
        @{ Text = 'Reconfigure...';       X = 390; Y = 42;  Kind = 'secondary'; Click = { $miReconfigure.PerformClick() } },
        @{ Text = 'Launch Tally';         X =  14; Y = 84;  Kind = 'secondary'; Click = { $miLaunchTally.PerformClick() } },
        @{ Text = 'Open logs';            X = 202; Y = 84;  Kind = 'secondary'; Click = { $miOpenLogs.PerformClick() } },
        @{ Text = 'Copy public URL';      X = 390; Y = 84;  Kind = 'secondary'; Click = {
            if ($State.PublicUrl) {
                try { [System.Windows.Forms.Clipboard]::SetText($State.PublicUrl) } catch {}
            }
        } },
        @{ Text = 'Manage Companies...';  X =  14; Y = 126; Kind = 'secondary'; Click = { $miManageCompanies.PerformClick() } },
        @{ Text = 'Stop service';         X = 202; Y = 126; Kind = 'danger';    Click = { $miStopService.PerformClick() } },
        @{ Text = 'Claude GUI control...';X = 390; Y = 126; Kind = 'secondary'; Click = { $miGuiControl.PerformClick() } }
    )
    foreach ($spec in $btnSpecs) {
        $btn = New-Object System.Windows.Forms.Button
        $btn.Text     = $spec.Text
        $btn.Location = New-Object System.Drawing.Point $spec.X, $spec.Y
        $btn.Size     = New-Object System.Drawing.Size 182, 34
        Set-FlatButton $btn $spec.Kind
        $btn.Add_Click($spec.Click)
        $actions.Controls.Add($btn)
    }

    # --- License card: read-only viewer of the bundled LICENSE file. Anchored to all four sides
    # so the user can resize the window to read more without horizontal scroll. ---
    $licenseGroup = New-DashCard 16 452 600 210 ([System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right) 'License'
    $form.Controls.Add($licenseGroup)

    $licenseBox = New-Object System.Windows.Forms.TextBox
    $licenseBox.Multiline  = $true
    $licenseBox.ReadOnly   = $true
    $licenseBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
    $licenseBox.WordWrap   = $true
    $licenseBox.Font       = New-Object System.Drawing.Font 'Consolas', 9
    $licenseBox.BorderStyle = [System.Windows.Forms.BorderStyle]::None
    $licenseBox.BackColor  = [System.Drawing.Color]::FromArgb(250, 250, 250)
    $licenseBox.ForeColor  = [System.Drawing.Color]::FromArgb(75, 85, 99)
    # Sit inside the card, clear of its header label; anchored all four so it grows with the card.
    $licenseBox.Location   = New-Object System.Drawing.Point 12, 36
    $licenseBox.Size       = New-Object System.Drawing.Size 576, 160
    $licenseBox.Anchor     = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
    # The shipped LICENSE (AGPL v3) is ~34KB; default TextBox.MaxLength = 32767 chars
    # would silently truncate the closing sections of the license, which is exactly the
    # opposite of what an operator opening this dialog wants to see. 0 disables the cap.
    $licenseBox.MaxLength  = 0
    # LICENSE is copied to the install root by the installer (see tally-mcp.iss [Files]).
    $licensePath = Join-Path $InstallDir 'LICENSE'
    if (Test-Path -LiteralPath $licensePath) {
        try {
            $licenseBox.Text = (Get-Content -LiteralPath $licensePath -Raw -ErrorAction Stop)
        } catch {
            $licenseBox.Text = "Unable to read LICENSE file at $licensePath`r`n$_"
        }
    } else {
        $licenseBox.Text = "LICENSE file not found at $licensePath."
    }
    $licenseGroup.Controls.Add($licenseBox)

    # Clear the script-scoped references when the form is disposed so the next double-click
    # creates a fresh one rather than touching a dead handle. Use the script: scope explicitly
    # since the closure runs outside the Show-Dashboard function frame. The PictureBox + its
    # backing Image dispose automatically as child controls of the form.
    $form.add_FormClosed({
        $script:Dashboard = $null
        $script:DashboardLabels = $null
    })

    $script:Dashboard = $form
    $script:DashboardLabels = $labels
    Update-DashboardUi  # populate immediately so it doesn't flash a row of '-' before the next poll tick
    $form.Show()
    $form.Activate()
}

function Update-DashboardUi {
    if (-not $script:Dashboard -or $script:Dashboard.IsDisposed -or -not $script:DashboardLabels) { return }

    # Service
    if ($State.Service) {
        $s = "$($State.Service.Status)"
        $sh = switch ($s) { 'Running' { 'green' } 'Stopped' { 'red' } default { 'amber' } }
        Set-StatusRow $script:DashboardLabels['Service'] $s '' $sh
    } else {
        Set-StatusRow $script:DashboardLabels['Service'] 'Not installed' '' 'gray'
    }

    # GUI agent
    if ($State.AgentTask) {
        if ($State.AgentProcess) {
            $ah = if ($State.AgentTask.State -eq 'Running') { 'green' } else { 'amber' }
            Set-StatusRow $script:DashboardLabels['Agent'] "$($State.AgentTask.State)" "PID $($State.AgentProcess.ProcessId)" $ah
        } else {
            Set-StatusRow $script:DashboardLabels['Agent'] "$($State.AgentTask.State)" 'no process running' 'amber'
        }
    } else {
        Set-StatusRow $script:DashboardLabels['Agent'] 'Not registered' '' 'red'
    }

    # Tally
    if ($State.TallyProcess) {
        $cmp = if ($State.LoadedCompany) { "$($State.LoadedCompany)" } else { '' }
        Set-StatusRow $script:DashboardLabels['Tally'] 'Running' $cmp 'green'
    } else {
        Set-StatusRow $script:DashboardLabels['Tally'] 'Not running' '' 'gray'
    }

    # Public URL
    if ($null -eq $State.PublicUrlOk) {
        Set-StatusRow $script:DashboardLabels['PublicUrl'] 'Not configured' '' 'gray'
    } elseif ($State.PublicUrlOk) {
        Set-StatusRow $script:DashboardLabels['PublicUrl'] 'OK' "$($State.PublicUrl)" 'green'
    } else {
        Set-StatusRow $script:DashboardLabels['PublicUrl'] 'Unreachable' "$($State.PublicUrl)" 'red'
    }
}

# Double-click the tray icon -> open the dashboard (Logs is still one click away in
# the right-click menu and as a dashboard button).
$tray.add_DoubleClick({ Show-Dashboard })

# ---------------------------------------------------------------------------
# Polling timer. Drives the icon colour + menu header text from $State after
# Invoke-StatusPoll updates it. Runs on the WinForms message loop thread so
# we can safely touch UI properties from inside the handler.
# ---------------------------------------------------------------------------
function Update-TrayUi {
    $status = Get-OverallStatus
    switch ($status) {
        'green'  { $tray.Icon = $IconGreen.Icon }
        'yellow' { $tray.Icon = $IconYellow.Icon }
        'red'    { $tray.Icon = $IconRed.Icon }
        default  { $tray.Icon = $IconGray.Icon }
    }
    $miHeader.Text = "TallyMCP - $status"

    # "Reload last company" enable + dynamic text
    if ($State.LastLoadedAlias) {
        $miReloadLast.Enabled = $true
        $miReloadLast.Text    = "Reload last company: $($State.LastLoadedAlias)"
    } else {
        $miReloadLast.Enabled = $false
        $miReloadLast.Text    = 'Reload last company (none yet)'
    }

    # Toast notifications fire only on STATE TRANSITIONS so a sustained bad
    # state doesn't spam the user. Three triggers:
    #   1. Overall status degrades from green to anything non-green.
    #   2. Service was Running and is now anything else.
    #   3. Agent process was running and has now disappeared.
    # And one "all clear" trigger when we transition back to green.
    if ($State.PreviousStatus -and $State.PreviousStatus -ne $status) {
        if ($status -eq 'red') {
            $tray.ShowBalloonTip(8000, 'TallyMCP - service down', "The MCP service is not running. Tools will be unreachable.", [System.Windows.Forms.ToolTipIcon]::Error)
        } elseif ($status -eq 'yellow' -and $State.PreviousStatus -eq 'green') {
            $tray.ShowBalloonTip(6000, 'TallyMCP - degraded', "Something downstream is unhealthy. Open the dashboard to see details.", [System.Windows.Forms.ToolTipIcon]::Warning)
        } elseif ($status -eq 'green' -and $State.PreviousStatus -in @('yellow', 'red')) {
            $tray.ShowBalloonTip(4000, 'TallyMCP - healthy', "All services back up.", [System.Windows.Forms.ToolTipIcon]::Info)
        }
    }
    $serviceRunning = ($State.Service -and $State.Service.Status -eq 'Running')
    if ($State.ServiceWasRunning -and -not $serviceRunning) {
        $tray.ShowBalloonTip(8000, 'TallyMCP - service stopped', "The Windows service stopped unexpectedly. Right-click tray > Restart service.", [System.Windows.Forms.ToolTipIcon]::Error)
    }
    $agentRunning = ($State.AgentProcess -ne $null)
    if ($State.AgentWasRunning -and -not $agentRunning) {
        $tray.ShowBalloonTip(6000, 'TallyMCP - agent stopped', "The GUI agent process is no longer running. Password-protected company loading will fail until restarted.", [System.Windows.Forms.ToolTipIcon]::Warning)
    }
    $State.PreviousStatus    = $status
    $State.ServiceWasRunning = $serviceRunning
    $State.AgentWasRunning   = $agentRunning

    if ($State.Service) {
        $miServiceState.Text = "  Service:  $($State.Service.Status)"
    } else {
        $miServiceState.Text = "  Service:  not installed"
    }

    if ($State.AgentTask) {
        $procPart = if ($State.AgentProcess) { "PID $($State.AgentProcess.ProcessId)" } else { 'no process' }
        $miAgentState.Text = "  Agent:    $($State.AgentTask.State) ($procPart)"
    } else {
        $miAgentState.Text = "  Agent:    task not registered"
    }

    if ($State.TallyProcess) {
        $cmp = if ($State.LoadedCompany) { " - $($State.LoadedCompany)" } else { '' }
        $miTallyState.Text = "  Tally:    Running$cmp"
    } else {
        $miTallyState.Text = "  Tally:    not running"
    }

    if ($null -eq $State.PublicUrlOk) {
        $miUrlState.Text = "  Public URL: not configured"
    } elseif ($State.PublicUrlOk) {
        $miUrlState.Text = "  Public URL: OK"
    } else {
        $miUrlState.Text = "  Public URL: unreachable"
    }

    # NotifyIcon.Text caps at 63 chars in legacy .NET Framework (which is what PowerShell 5
    # binds against), even on Win10/11. Newer .NET Core/.NET 5+ allow 127, but we can't rely
    # on that here. Clamp to 63 to avoid the "Text length must be less than 64 characters"
    # exception that the old-style WinForms NotifyIcon throws.
    $tip = Format-Tooltip
    if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
    $tray.Text = $tip
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1000, $PollIntervalSec * 1000)
$timer.Add_Tick({
    Invoke-StatusPoll
    Update-TrayUi
    Update-DashboardUi
})

# First poll synchronously so the icon shows real status from the moment the tray appears
# (Timer's first Tick fires AFTER Interval elapses; otherwise the icon would sit gray for
# ~5 seconds and look broken).
Invoke-StatusPoll
Update-TrayUi
$timer.Start()

# Watch for "show dashboard" requests from a second launch (the Open Dashboard shortcut). Poll the
# named event on the UI thread so Show-Dashboard runs on the WinForms message-loop thread (WinForms
# requires UI calls on that thread). WaitOne(0) is a non-blocking kernel check - cheap to poll.
$showDashTimer = New-Object System.Windows.Forms.Timer
$showDashTimer.Interval = 400
$showDashTimer.Add_Tick({
    try { if ($script:ShowDashboardSignal.WaitOne(0)) { Show-Dashboard } } catch {}
})
$showDashTimer.Start()

# Launched via the Open Dashboard shortcut while no tray was running yet -> THIS process is now the
# singleton tray, so open the dashboard immediately. (When a tray is already running, that launch
# takes the -not $ownsSingleton branch above and signals us through $ShowDashboardSignal instead.)
if ($ShowDashboard) { Show-Dashboard }

[System.Windows.Forms.Application]::Run()

# Cleanup on Application.Exit
$tray.Visible = $false
$tray.Dispose()
$timer.Dispose()
# Free GDI HICONs we allocated via Bitmap.GetHicon (Icon.FromHandle did not take ownership).
Dispose-StatusIcon $IconGreen
Dispose-StatusIcon $IconYellow
Dispose-StatusIcon $IconRed
Dispose-StatusIcon $IconGray
