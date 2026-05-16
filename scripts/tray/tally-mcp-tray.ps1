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
# <InstallDir>\scripts\tray\tally-mcp-tray.ps1, so we climb three Split-Path -Parents:
# file -> tray\ -> scripts\ -> <InstallDir>. Two splits land us inside scripts\, which
# made every Join-Path against InstallDir double up "scripts\" in dev mode.
if (-not $InstallDir -or -not $InstallDir.Trim()) {
    $InstallDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

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
$DashboardLabels = $null     # hashtable of the live-updating status labels

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
    $form.Text          = 'TallyMCP - Dashboard'
    $form.Size          = New-Object System.Drawing.Size 640, 660
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $form.MinimumSize   = New-Object System.Drawing.Size 560, 580
    $form.BackColor     = [System.Drawing.Color]::White
    $form.Font          = New-Object System.Drawing.Font 'Segoe UI', 9

    # --- Header band: logo + product name + version. Anchored top, fixed-height. ---
    $header = New-Object System.Windows.Forms.Panel
    $header.Dock      = [System.Windows.Forms.DockStyle]::Top
    $header.Height    = 120
    $header.BackColor = [System.Drawing.Color]::White
    $form.Controls.Add($header)

    $logoPath = Join-Path $PSScriptRoot 'assets\jina-logo.png'
    if (Test-Path -LiteralPath $logoPath) {
        $pic = New-Object System.Windows.Forms.PictureBox
        $pic.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
        $pic.Location = New-Object System.Drawing.Point 16, 12
        $pic.Size     = New-Object System.Drawing.Size 96, 96
        try { $pic.Image = [System.Drawing.Image]::FromFile($logoPath) } catch {}
        $header.Controls.Add($pic)
    }

    $lblProduct = New-Object System.Windows.Forms.Label
    $lblProduct.Text     = 'Tally MCP Server'
    $lblProduct.Font     = New-Object System.Drawing.Font 'Segoe UI Semibold', 16
    $lblProduct.AutoSize = $true
    $lblProduct.Location = New-Object System.Drawing.Point 128, 24
    $header.Controls.Add($lblProduct)

    $lblPublisher = New-Object System.Windows.Forms.Label
    $lblPublisher.Text     = 'by JINA CODE SYSTEMS LLP'
    $lblPublisher.Font     = New-Object System.Drawing.Font 'Segoe UI', 9
    $lblPublisher.ForeColor = [System.Drawing.Color]::FromArgb(90, 90, 90)
    $lblPublisher.AutoSize = $true
    $lblPublisher.Location = New-Object System.Drawing.Point 128, 56
    $header.Controls.Add($lblPublisher)

    $lblVersion = New-Object System.Windows.Forms.Label
    $lblVersion.Text     = 'v1.1.0'
    $lblVersion.Font     = New-Object System.Drawing.Font 'Segoe UI', 9
    $lblVersion.ForeColor = [System.Drawing.Color]::FromArgb(120, 120, 120)
    $lblVersion.AutoSize = $true
    $lblVersion.Location = New-Object System.Drawing.Point 128, 80
    $header.Controls.Add($lblVersion)

    # --- Status panel: 4 live-updating lines, refreshed by Update-DashboardUi. ---
    $status = New-Object System.Windows.Forms.GroupBox
    $status.Text     = ' Status '
    $status.Location = New-Object System.Drawing.Point 16, 130
    $status.Size     = New-Object System.Drawing.Size 600, 110
    $status.Anchor   = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
    $form.Controls.Add($status)

    $labels = @{}
    $rowY = 22
    foreach ($name in @('Service','Agent','Tally','PublicUrl')) {
        $caption = New-Object System.Windows.Forms.Label
        $caption.Text     = switch ($name) {
            'Service'   { 'Service:' }
            'Agent'     { 'Agent:' }
            'Tally'     { 'Tally:' }
            'PublicUrl' { 'Public URL:' }
        }
        $caption.Location = New-Object System.Drawing.Point 16, $rowY
        $caption.Size     = New-Object System.Drawing.Size 100, 18
        $caption.Font     = New-Object System.Drawing.Font 'Segoe UI Semibold', 9
        $status.Controls.Add($caption)

        $value = New-Object System.Windows.Forms.Label
        $value.Text     = '-'
        $value.Location = New-Object System.Drawing.Point 120, $rowY
        $value.Size     = New-Object System.Drawing.Size 460, 18
        $status.Controls.Add($value)

        $labels[$name] = $value
        $rowY += 20
    }

    # --- Action buttons: 2x3 grid of the same actions exposed by the right-click menu.
    # Each button .PerformClick()s the corresponding ToolStripMenuItem so the
    # implementations stay in one place (no duplicated restart/reconfigure logic). ---
    $actions = New-Object System.Windows.Forms.GroupBox
    $actions.Text     = ' Actions '
    $actions.Location = New-Object System.Drawing.Point 16, 250
    $actions.Size     = New-Object System.Drawing.Size 600, 150
    $actions.Anchor   = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
    $form.Controls.Add($actions)

    # Grid: 3 columns x 3 rows. Each button .PerformClick()s the corresponding ToolStripMenuItem
    # so the implementation stays in one place (no duplicated restart/reconfigure logic).
    $btnSpecs = @(
        @{ Text = 'Restart service';     X =  16; Y =  24; Click = { $miRestartService.PerformClick() } },
        @{ Text = 'Restart GUI agent';   X = 210; Y =  24; Click = { $miRestartAgent.PerformClick() } },
        @{ Text = 'Reconfigure...';      X = 404; Y =  24; Click = { $miReconfigure.PerformClick() } },
        @{ Text = 'Launch Tally';        X =  16; Y =  64; Click = { $miLaunchTally.PerformClick() } },
        @{ Text = 'Open logs';           X = 210; Y =  64; Click = { $miOpenLogs.PerformClick() } },
        @{ Text = 'Copy public URL';     X = 404; Y =  64; Click = {
            if ($State.PublicUrl) {
                try { [System.Windows.Forms.Clipboard]::SetText($State.PublicUrl) } catch {}
            }
        } },
        @{ Text = 'Manage Companies...'; X =  16; Y = 104; Click = { $miManageCompanies.PerformClick() } }
    )
    foreach ($spec in $btnSpecs) {
        $btn = New-Object System.Windows.Forms.Button
        $btn.Text     = $spec.Text
        $btn.Location = New-Object System.Drawing.Point $spec.X, $spec.Y
        $btn.Size     = New-Object System.Drawing.Size 180, 32
        $btn.Add_Click($spec.Click)
        $actions.Controls.Add($btn)
    }

    # --- License panel: read-only multi-line viewer of the bundled LICENSE file.
    # Anchored to all four sides so the user can resize the window to read more
    # without horizontal scroll. ---
    $licenseGroup = New-Object System.Windows.Forms.GroupBox
    $licenseGroup.Text     = ' License '
    $licenseGroup.Location = New-Object System.Drawing.Point 16, 410
    $licenseGroup.Size     = New-Object System.Drawing.Size 600, 200
    $licenseGroup.Anchor   = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
    $form.Controls.Add($licenseGroup)

    $licenseBox = New-Object System.Windows.Forms.TextBox
    $licenseBox.Multiline  = $true
    $licenseBox.ReadOnly   = $true
    $licenseBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
    $licenseBox.WordWrap   = $true
    $licenseBox.Font       = New-Object System.Drawing.Font 'Consolas', 9
    $licenseBox.BackColor  = [System.Drawing.Color]::FromArgb(248, 248, 248)
    $licenseBox.Dock       = [System.Windows.Forms.DockStyle]::Fill
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

    if ($State.Service) {
        $script:DashboardLabels['Service'].Text = "$($State.Service.Status)"
    } else {
        $script:DashboardLabels['Service'].Text = 'not installed'
    }

    if ($State.AgentTask) {
        $procPart = if ($State.AgentProcess) { "PID $($State.AgentProcess.ProcessId)" } else { 'no process' }
        $script:DashboardLabels['Agent'].Text = "$($State.AgentTask.State) ($procPart)"
    } else {
        $script:DashboardLabels['Agent'].Text = 'task not registered'
    }

    if ($State.TallyProcess) {
        $cmp = if ($State.LoadedCompany) { " - $($State.LoadedCompany)" } else { '' }
        $script:DashboardLabels['Tally'].Text = "Running$cmp"
    } else {
        $script:DashboardLabels['Tally'].Text = 'not running'
    }

    if ($null -eq $State.PublicUrlOk) {
        $script:DashboardLabels['PublicUrl'].Text = 'not configured'
    } elseif ($State.PublicUrlOk) {
        $script:DashboardLabels['PublicUrl'].Text = "OK ($($State.PublicUrl))"
    } else {
        $script:DashboardLabels['PublicUrl'].Text = "unreachable ($($State.PublicUrl))"
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
