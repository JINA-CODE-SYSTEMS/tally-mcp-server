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
    [int]$ProbeTimeoutSec = 3
)

# Resolve InstallDir relative to this file when not provided. The tray script lives at
# <InstallDir>\scripts\tray\tally-mcp-tray.ps1 - climb two levels.
if (-not $InstallDir -or -not $InstallDir.Trim()) {
    $InstallDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---------------------------------------------------------------------------
# State container shared between the polling timer and the menu handlers.
# Single Hashtable rather than a class so the script stays easy to copy-paste-debug.
# ---------------------------------------------------------------------------
$State = [hashtable]::Synchronized(@{
    Service       = $null   # ServiceController | $null
    AgentTask     = $null   # ScheduledTask object | $null
    AgentProcess  = $null   # Process | $null
    TallyProcess  = $null   # Process | $null
    PublicUrl     = ''      # full probe URL or '' if no MCP_DOMAIN set
    PublicUrlOk   = $null   # $true / $false / $null (not configured)
    LoadedCompany = ''      # best-effort name of currently loaded company, or ''
    LastPoll      = $null
    LastError     = $null
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
        # Strip surrounding double-quotes (firstrun-config.ps1 quotes values that may contain '#')
        if ($v.Length -ge 2 -and $v.StartsWith('"') -and $v.EndsWith('"')) {
            $v = $v.Substring(1, $v.Length - 2) -replace '\\"', '"'
        }
        return $v
    }
    return ''
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

$miRestartAgent = $menu.Items.Add('Restart GUI agent')
$miRestartAgent.Add_Click({
    try {
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

$miReconfigure = $menu.Items.Add('Reconfigure...')
$miReconfigure.Add_Click({
    $script = Join-Path $InstallDir 'scripts\installer\firstrun-config.ps1'
    if (-not (Test-Path -LiteralPath $script)) {
        [System.Windows.Forms.MessageBox]::Show("Reconfigure script not found at: $script", 'TallyMCP', 'OK', 'Warning') | Out-Null
        return
    }
    # Reconfigure modifies .env and re-registers the NSSM service, both admin-only operations.
    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-ExecutionPolicy', 'Bypass', '-NoProfile',
        '-NoExit',  # leave the window open so the operator can read the result
        '-File', $script,
        '-InstallDir', $InstallDir
    ) -Verb RunAs
})

[void]$menu.Items.Add('-')

$miQuit = $menu.Items.Add('Quit (hide tray)')
$miQuit.Add_Click({
    $tray.Visible = $false
    $tray.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

$tray.ContextMenuStrip = $menu

# Double-click the tray icon -> open logs (most-frequent action when something looks off)
$tray.add_DoubleClick({ $miOpenLogs.PerformClick() })

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

    # NotifyIcon.Text caps at 127 chars on Win10+ (63 on older). Format-Tooltip is short
    # enough to fit; we still defensively clamp.
    $tip = Format-Tooltip
    if ($tip.Length -gt 127) { $tip = $tip.Substring(0, 127) }
    $tray.Text = $tip
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1000, $PollIntervalSec * 1000)
$timer.Add_Tick({
    Invoke-StatusPoll
    Update-TrayUi
})

# First poll synchronously so the icon shows real status from the moment the tray appears
# (Timer's first Tick fires AFTER Interval elapses; otherwise the icon would sit gray for
# ~5 seconds and look broken).
Invoke-StatusPoll
Update-TrayUi
$timer.Start()

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
