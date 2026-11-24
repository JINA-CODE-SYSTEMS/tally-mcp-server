<#
.SYNOPSIS
    Tally-facing tray actions. Dot-sourced by tally-mcp-tray.ps1; defines functions only.

.DESCRIPTION
    #33 Start Tally, tell "closed" from "open but its XML server is off", switch the XML server on
        through tally.ini (with tally-ini-xml.ps1), and wait for Tally to answer.
    #34 List every running copy of Tally and close one, gracefully first.
    #37 Tally on another computer: test and save TALLY_HOST / TALLY_PORT.

    Uses the tray's $State, $InstallDir, $tray, Read-EnvValue and Set-EnvValue at call time.

.NOTES
    Windows PowerShell 5.1 compatible; ASCII only.
#>

# --- Endpoint -------------------------------------------------------------------------------------

function Get-TrayEnvPath { return (Join-Path $InstallDir '.env') }

# Is this host name this computer? Anything else means Tally runs somewhere we cannot see its
# process, start it, close it or draw around its window.
# Same rule as the server's isRemoteTallyHost (src/mcp.mts), so both sides agree: loopback names and
# addresses, '0.0.0.0', or a host that equals this computer's name or whose first DNS label does
# (case-insensitive). "This computer's name" is [System.Net.Dns]::GetHostName() - the value Node's
# os.hostname() returns on Windows, not cut to 15 characters - and also $env:COMPUTERNAME (the
# NetBIOS name, which can be a cut-down form of it).
function Test-TallyHostIsLocal {
    param([string]$HostName)
    $h = ([string]$HostName).Trim().ToLowerInvariant() -replace '^\[|\]$', ''
    if (-not $h) { return $true }
    if ($h -eq 'localhost' -or $h -eq '::1' -or $h -eq '0.0.0.0') { return $true }
    if ($h.StartsWith('127.')) { return $true }
    $first = $h.Split('.')[0]
    $names = @()
    try { $names += ([string][System.Net.Dns]::GetHostName()).Trim().ToLowerInvariant() } catch { }
    try { $names += ([string]$env:COMPUTERNAME).Trim().ToLowerInvariant() } catch { }
    foreach ($me in $names) {
        if (-not $me) { continue }
        if ($h -eq $me -or $first -eq $me) { return $true }
    }
    return $false
}

# @{ Host; Port; IsRemote } from .env. Defaults match the server (src/tally.mts) and the installer.
function Get-TallyEndpoint {
    $envFile = Get-TrayEnvPath
    $h = ''
    $p = 9000
    try {
        $h = Read-EnvValue -EnvPath $envFile -Key 'TALLY_HOST'
        $raw = Read-EnvValue -EnvPath $envFile -Key 'TALLY_PORT'
        $n = 0
        if ($raw -and [int]::TryParse($raw, [ref]$n) -and $n -gt 0 -and $n -lt 65536) { $p = $n }
    } catch { }
    if (-not $h) { $h = '127.0.0.1' }
    return @{ Host = $h; Port = $p; IsRemote = (-not (Test-TallyHostIsLocal $h)) }
}

function Get-TallyUrl {
    param([string]$HostName, [int]$Port)
    $h = $HostName
    if ($h.Contains(':') -and -not $h.StartsWith('[')) { $h = "[$h]" }
    return "http://${h}:$Port/"
}

# Quick TCP connect with a hard timeout, so an unreachable host costs at most TimeoutMs of the UI
# thread instead of a full HTTP timeout.
function Test-TcpPort {
    param([string]$HostName, [int]$Port, [int]$TimeoutMs = 800)
    $client = $null
    try {
        $ip = $null
        if ([System.Net.IPAddress]::TryParse($HostName.Trim('[', ']'), [ref]$ip) -and $ip.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) {
            $client = New-Object System.Net.Sockets.TcpClient([System.Net.Sockets.AddressFamily]::InterNetworkV6)
        } else {
            $client = New-Object System.Net.Sockets.TcpClient
        }
        $ar = $client.BeginConnect($HostName.Trim('[', ']'), $Port, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($ar)
        return $true
    } catch {
        return $false
    } finally {
        if ($client) { try { $client.Close() } catch { } }
    }
}

# The tray's XML probe: "List of Companies" export. @{ Ok; Company; Error }.
# HttpWebRequest rather than Invoke-WebRequest: it lets us skip the system proxy (a LAN Tally must
# not be sent through a corporate proxy) and the Expect: 100-continue round trip.
function Test-TallyXml {
    param([string]$HostName, [int]$Port, [int]$TimeoutSec = 2)
    $r = @{ Ok = $false; Company = ''; Error = '' }
    if (-not (Test-TcpPort -HostName $HostName -Port $Port -TimeoutMs 800)) {
        $r.Error = "nothing answered on $HostName port $Port"
        return $r
    }
    $resp = $null
    try {
        $body = '<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER></ENVELOPE>'
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $req = [System.Net.WebRequest]::Create((Get-TallyUrl -HostName $HostName -Port $Port))
        $req.Method = 'POST'
        $req.ContentType = 'text/xml; charset=utf-8'
        $req.Proxy = $null
        $req.KeepAlive = $false
        $req.ServicePoint.Expect100Continue = $false
        $req.Timeout = $TimeoutSec * 1000
        $req.ReadWriteTimeout = $TimeoutSec * 1000
        $req.ContentLength = $bytes.Length
        $rs = $req.GetRequestStream()
        try { $rs.Write($bytes, 0, $bytes.Length) } finally { $rs.Close() }
        $resp = $req.GetResponse()
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        try { $content = $sr.ReadToEnd() } finally { $sr.Close() }
        # Tally's "List of Companies" envelope returns <NAME>...</NAME> inside <COMPANY> blocks
        # (verified against a real Tally Prime Edit Log instance). The first one is the active company.
        $m = [regex]::Match([string]$content, '<NAME>([^<]+)</NAME>', 'IgnoreCase')
        if ($m.Success) { $r.Company = $m.Groups[1].Value.Trim() }
        $r.Ok = $true
    } catch {
        $r.Error = $_.Exception.Message
    } finally {
        if ($resp) { try { $resp.Close() } catch { } }
    }
    return $r
}

# PID of the process listening on the XML port, or 0. Same two-step lookup as the GUI agent's
# Resolve-TallyProcess (Get-NetTCPConnection, netstat when that is missing).
function Get-TallyPortOwnerPid {
    param([int]$Port)
    try {
        $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1
        if ($conn) { return [int]$conn.OwningProcess }
    } catch {
        try {
            foreach ($line in (netstat -ano -p TCP)) {
                if ($line -match '^\s*TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$') {
                    $localAddr = $Matches[1]; $foreign = $Matches[2]; $linePid = [int]$Matches[4]
                    $idx = $localAddr.LastIndexOf(':')
                    if ($idx -lt 0) { continue }
                    $lp = $localAddr.Substring($idx + 1)
                    if ($lp -notmatch '^\d+$' -or [int]$lp -ne $Port) { continue }
                    if ($foreign -match ':0$') { return $linePid }
                }
            }
        } catch { }
    }
    return 0
}

function Get-TallyExePath {
    $exe = ''
    try { $exe = Read-EnvValue -EnvPath (Get-TrayEnvPath) -Key 'TALLY_EXE_PATH' } catch { }
    if (-not $exe) { $exe = 'C:\Program Files\TallyPrimeEditLog\tally.exe' }
    return $exe
}

# The tally.ini Tally actually reads is the one next to tally.exe. TALLY_INI_PATH (what load-company
# edits) is the fallback for an install where the exe path is not set or not found.
function Get-TallyIniPath {
    $exe = Get-TallyExePath
    try {
        $dir = Split-Path -Parent $exe
        if ($dir) {
            $p = Join-Path $dir 'tally.ini'
            if (Test-Path -LiteralPath $p) { return $p }
        }
    } catch { }
    $setting = ''
    try { $setting = Read-EnvValue -EnvPath (Get-TrayEnvPath) -Key 'TALLY_INI_PATH' } catch { }
    if ($setting -and (Test-Path -LiteralPath $setting)) { return $setting }
    return ''
}

# The steps a person can follow by hand, for messages.
function Get-TallyXmlMenuPath {
    param([int]$Port = 9000)
    return "In Tally: F1 (Help) > Settings > Connectivity > Client/Server Configuration, set 'TallyPrime acts as' to Server and Port to $Port, then press Ctrl+A."
}

# --- #34 Copies ------------------------------------------------------------------------------------

# Every running tally.exe with what a person needs to tell them apart.
function Get-TallyCopies {
    param([int]$PortOwnerPid = 0)
    $out = @()
    foreach ($p in @(Get-Process -Name 'tally' -ErrorAction SilentlyContinue)) {
        $path = ''; $ver = ''; $start = $null; $title = ''
        try { $path = [string]$p.Path } catch { }
        if ($path) { try { $ver = [string](Get-Item -LiteralPath $path -ErrorAction Stop).VersionInfo.FileVersion } catch { } }
        try { $start = $p.StartTime } catch { }
        try { $title = [string]$p.MainWindowTitle } catch { }
        $out += New-Object PSObject -Property @{
            Id        = $p.Id
            Path      = $path
            Version   = $ver
            StartTime = $start
            Title     = $title
            HoldsPort = ($PortOwnerPid -gt 0 -and $p.Id -eq $PortOwnerPid)
        }
    }
    return $out
}

function Format-TallyCopyText {
    param($Copy, [int]$Index)
    $head = "Copy $Index  (process $($Copy.Id))"
    if ($Copy.HoldsPort) { $head += '  -  this one has the data connection' }
    $prog = $Copy.Path
    if (-not $prog) { $prog = '(location not readable)' }
    if ($Copy.Version) { $prog += "   (version $($Copy.Version))" }
    $started = 'unknown'
    if ($Copy.StartTime) { $started = $Copy.StartTime.ToString('dd MMM yyyy HH:mm') }
    $win = $Copy.Title
    if (-not $win) { $win = '(no window title)' }
    $company = ''
    if ($Copy.HoldsPort -and $State.LoadedCompany) { $company = "    Company: $($State.LoadedCompany)" }
    return "$head`r`nProgram: $prog`r`nStarted: $started    Window: $win$company"
}

# Close one copy: confirm, ask it to close like clicking X, and only force it after a SECOND
# confirmation if it is still there ~10 s later. Returns $true when the process is gone.
function Close-TallyCopy {
    param([int]$ProcessId, [string]$Description)
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { return $true }
    $msg = "Close this copy of Tally?`r`n`r`n$Description`r`n`r`nAnyone entering data in this copy will lose work that is not saved yet.`r`n`r`nClaudally asks Tally to close, the same as clicking its X. If Tally asks whether to quit, answer Yes."
    $ans = [System.Windows.Forms.MessageBox]::Show($msg, 'Close Tally', [System.Windows.Forms.MessageBoxButtons]::OKCancel,
        [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
    if ($ans -ne [System.Windows.Forms.DialogResult]::OK) { return $false }

    $asked = $false
    try { $asked = $p.CloseMainWindow() } catch { $asked = $false }
    if ($asked) {
        try { [void]$p.WaitForExit(10000) } catch { }
    }
    if (Test-TallyProcessGone -Process $p -ProcessId $ProcessId) { return $true }

    $why = 'Tally did not close within 10 seconds. It may be waiting for an answer - look at the Tally window - or it may be stuck.'
    if (-not $asked) { $why = 'This copy of Tally has no window Claudally can ask to close (it may still be starting, or be stuck).' }
    $force = [System.Windows.Forms.MessageBox]::Show(
        "$why`r`n`r`nForce it to close now? Anything not saved in this copy WILL be lost.",
        'Force Tally to close?', [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
    if ($force -ne [System.Windows.Forms.DialogResult]::Yes) { return $false }
    try { Stop-Process -Id $ProcessId -Force -ErrorAction Stop } catch { }
    try { [void]$p.WaitForExit(5000) } catch { }
    if (Test-TallyProcessGone -Process $p -ProcessId $ProcessId) { return $true }
    [System.Windows.Forms.MessageBox]::Show("Windows did not let Claudally close this copy of Tally (it may be running as administrator). Close it from its own window.", 'Claudally', 'OK', 'Warning') | Out-Null
    return $false
}

# HasExited throws for a process we may not query (another user, or elevated); ask Windows again.
function Test-TallyProcessGone {
    param($Process, [int]$ProcessId)
    try { return [bool]$Process.HasExited } catch { }
    return (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
}

# One dialog listing every copy, each with its own Close button. Re-opens itself with a fresh list
# after a copy is closed, until one (or none) is left.
function Show-TallyCopiesDialog {
    while ($true) {
        $ownerPid = 0
        try { $ownerPid = Get-TallyPortOwnerPid -Port $State.TallyPort } catch { }
        $copies = @(Get-TallyCopies -PortOwnerPid $ownerPid)
        if ($copies.Count -le 1) {
            $txt = 'No copy of Tally is open now.'
            if ($copies.Count -eq 1) { $txt = 'Only one copy of Tally is open now. Your AI assistant can work with it.' }
            [System.Windows.Forms.MessageBox]::Show($txt, 'Tally copies', 'OK', 'Information') | Out-Null
            return
        }

        $f = New-Object System.Windows.Forms.Form
        $f.Text            = 'Claudally - copies of Tally that are open'
        $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
        $f.MaximizeBox     = $false
        $f.MinimizeBox     = $false
        $f.StartPosition   = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $f.BackColor       = [System.Drawing.Color]::White
        $f.Font            = New-Object System.Drawing.Font 'Segoe UI', 9
        $f.TopMost         = $true

        $intro = New-Object System.Windows.Forms.Label
        $intro.Location = New-Object System.Drawing.Point 14, 12
        $intro.Size     = New-Object System.Drawing.Size 640, 64
        $intro.Text     = "$($copies.Count) copies of Tally are open at the same time. Only one of them can hold the data connection (port $($State.TallyPort)), and your AI assistant will not load or switch companies while it is unclear which copy you mean - keystrokes sent to the wrong copy would land in a different company's window.`r`nClose the copies you are not using."
        $f.Controls.Add($intro)

        $list = New-Object System.Windows.Forms.Panel
        $list.Location   = New-Object System.Drawing.Point 10, 80
        $list.AutoScroll = $true
        $rowH = 74
        $visibleRows = [Math]::Min($copies.Count, 5)
        $list.Size = New-Object System.Drawing.Size 650, ($visibleRows * $rowH + 4)
        $f.Controls.Add($list)

        $i = 0
        foreach ($c in $copies) {
            $i++
            $y = ($i - 1) * $rowH
            $desc = Format-TallyCopyText -Copy $c -Index $i
            $lbl = New-Object System.Windows.Forms.Label
            $lbl.Location = New-Object System.Drawing.Point 4, ($y + 4)
            $lbl.Size     = New-Object System.Drawing.Size 470, ($rowH - 8)
            $lbl.AutoEllipsis = $true
            $lbl.Text     = $desc
            if ($c.HoldsPort) { $lbl.Font = New-Object System.Drawing.Font 'Segoe UI Semibold', 9 }
            $list.Controls.Add($lbl)

            $btn = New-Object System.Windows.Forms.Button
            $btn.Text     = 'Close this copy'
            $btn.Location = New-Object System.Drawing.Point 486, ($y + 16)
            $btn.Size     = New-Object System.Drawing.Size 140, 30
            # Per-row data travels on the button itself, not in a variable the handler would read
            # after the loop has moved on.
            $btn.Tag      = @{ Id = [int]$c.Id; Desc = $desc }
            $btn.Add_Click({
                try {
                    $info = $this.Tag
                    if (Close-TallyCopy -ProcessId $info.Id -Description $info.Desc) {
                        $this.FindForm().DialogResult = [System.Windows.Forms.DialogResult]::Retry
                    }
                } catch { }
            })
            $list.Controls.Add($btn)
        }

        $btnRefresh = New-Object System.Windows.Forms.Button
        $btnRefresh.Text     = 'Refresh'
        $btnRefresh.Size     = New-Object System.Drawing.Size 100, 30
        $btnRefresh.Location = New-Object System.Drawing.Point 450, ($list.Bottom + 12)
        $btnRefresh.DialogResult = [System.Windows.Forms.DialogResult]::Retry
        $f.Controls.Add($btnRefresh)

        $btnDone = New-Object System.Windows.Forms.Button
        $btnDone.Text     = 'Done'
        $btnDone.Size     = New-Object System.Drawing.Size 100, 30
        $btnDone.Location = New-Object System.Drawing.Point 558, ($list.Bottom + 12)
        $btnDone.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
        $f.Controls.Add($btnDone)
        $f.CancelButton = $btnDone

        $f.ClientSize = New-Object System.Drawing.Size 672, ($btnDone.Bottom + 12)
        $res = $f.ShowDialog()
        $f.Dispose()
        if ($res -ne [System.Windows.Forms.DialogResult]::Retry) { return }
    }
}

# --- #33 Start Tally and wait for it -------------------------------------------------------------

$script:TallyReady = @{ Active = $false; Deadline = [datetime]::MinValue; StartedAt = [datetime]::MinValue; Timer = $null }

function Stop-TallyReadyWatch {
    $script:TallyReady.Active = $false
    if ($script:TallyReady.Timer) { try { $script:TallyReady.Timer.Stop() } catch { } }
}

# Polls the XML port every 2 s for up to 90 s after Tally is started, then says once whether Tally
# is ready. A WinForms timer, so the tray stays responsive the whole time.
function Start-TallyReadyWatch {
    if (-not $script:TallyReady.Timer) {
        $t = New-Object System.Windows.Forms.Timer
        $t.Interval = 2000
        $t.Add_Tick({ try { Invoke-TallyReadyTick } catch { } })
        $script:TallyReady.Timer = $t
    }
    $script:TallyReady.Active    = $true
    $script:TallyReady.StartedAt = Get-Date
    $script:TallyReady.Deadline  = (Get-Date).AddSeconds(90)
    $script:TallyReady.Timer.Start()
}

function Invoke-TallyReadyTick {
    if (-not $script:TallyReady.Active) { Stop-TallyReadyWatch; return }
    $port = $State.TallyPort
    if (-not $port) { $port = 9000 }
    $probe = Test-TallyXml -HostName '127.0.0.1' -Port $port -TimeoutSec 2
    if ($probe.Ok) {
        Stop-TallyReadyWatch
        $State.TallyXmlOk = $true
        $what = 'Your AI assistant can reach it now.'
        if ($probe.Company) { $what = "Company open: $($probe.Company). Your AI assistant can reach it now." }
        $tray.ShowBalloonTip(5000, 'Tally is ready', $what, [System.Windows.Forms.ToolTipIcon]::Info)
        return
    }
    $running = @(Get-Process -Name 'tally' -ErrorAction SilentlyContinue).Count -gt 0
    if (-not $running -and ((Get-Date) - $script:TallyReady.StartedAt).TotalSeconds -gt 20) {
        # The person closed it (or it failed to start): nothing to report on.
        Stop-TallyReadyWatch
        return
    }
    if ((Get-Date) -ge $script:TallyReady.Deadline) {
        Stop-TallyReadyWatch
        $script:BalloonAction = 'enable-xml'
        $tray.ShowBalloonTip(15000, "Tally is open, but its XML server is off",
            "Your AI assistant cannot reach Tally on port $port. Click here to switch it on, or: F1 > Settings > Connectivity > Client/Server Configuration, 'TallyPrime acts as' = Server, Port = $port.",
            [System.Windows.Forms.ToolTipIcon]::Warning)
    }
}

# Start Tally from TALLY_EXE_PATH and watch for it to come up. Asks first when a copy is already
# open (two copies stop the AI from loading or switching companies).
function Start-TallyFromTray {
    if ($State.TallyIsRemote) {
        [System.Windows.Forms.MessageBox]::Show("Claudally is set to use the Tally on $($State.TallyHost). Start Tally on that computer.`r`n`r`nIf Tally is on this computer after all, right-click the tray icon and choose 'Tally is on this computer'.", 'Claudally', 'OK', 'Information') | Out-Null
        return
    }
    $exe = Get-TallyExePath
    if (-not (Test-Path -LiteralPath $exe)) {
        [System.Windows.Forms.MessageBox]::Show("tally.exe not found at: $exe`n`nUpdate TALLY_EXE_PATH in .env via Reconfigure.", 'TallyMCP', 'OK', 'Warning') | Out-Null
        return
    }
    if (@(Get-Process -Name 'tally' -ErrorAction SilentlyContinue).Count -gt 0) {
        $ans = [System.Windows.Forms.MessageBox]::Show(
            "Tally is already open.`r`n`r`nStart another copy anyway? With two copies open your AI assistant cannot tell which one to use, and will not load or switch companies until one is closed.",
            'Claudally', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question,
            [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
        if ($ans -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    }
    try {
        Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Launch failed: $_", 'TallyMCP', 'OK', 'Error') | Out-Null
        return
    }
    $tray.ShowBalloonTip(4000, 'Starting Tally', 'Claudally will tell you when your AI assistant can reach it.', [System.Windows.Forms.ToolTipIcon]::Info)
    Start-TallyReadyWatch
}

# --- #33 Switch on the XML server ----------------------------------------------------------------

# The whole flow behind "Switch on Tally's XML server": Tally must be closed (Tally rewrites
# tally.ini when it exits, so an edit made while it runs can be lost), confirm, back up, edit, offer
# to start Tally.
function Invoke-EnableTallyXmlServer {
    if ($State.TallyIsRemote) {
        [System.Windows.Forms.MessageBox]::Show("Claudally is set to use the Tally on $($State.TallyHost). Switch its XML server on at that computer:`r`n`r`n$(Get-TallyXmlMenuPath -Port $State.TallyPort)", 'Claudally', 'OK', 'Information') | Out-Null
        return
    }
    $port = $State.TallyPort
    if (-not $port) { $port = 9000 }
    if (-not (Get-Command Set-TallyIniXmlServer -ErrorAction SilentlyContinue)) {
        [System.Windows.Forms.MessageBox]::Show("Part of the tray is missing from this install (tally-ini-xml.ps1). Reinstall Claudally to repair it, or switch it on by hand:`r`n`r`n$(Get-TallyXmlMenuPath -Port $port)", 'Claudally', 'OK', 'Warning') | Out-Null
        return
    }
    $ini = Get-TallyIniPath
    if (-not $ini) {
        [System.Windows.Forms.MessageBox]::Show("Claudally could not find Tally's settings file (tally.ini) next to $(Get-TallyExePath).`r`n`r`nSwitch the XML server on by hand:`r`n`r`n$(Get-TallyXmlMenuPath -Port $port)", 'Claudally', 'OK', 'Warning') | Out-Null
        return
    }

    $copies = @(Get-Process -Name 'tally' -ErrorAction SilentlyContinue)
    if ($copies.Count -gt 0) {
        # The tray offers this whenever Tally runs but does not answer. That also happens when the
        # XML server is already on and Tally is just busy or stuck behind a message box (a licence
        # reminder, say). Look at tally.ini before offering to close Tally for nothing.
        $pre = $null
        try { $pre = Get-TallyIniXmlSettings -Path $ini } catch { $pre = $null }
        if ($pre -and $pre.Ok -and $pre.ServerOn -and $pre.Port -eq [string]$port) {
            $again = [System.Windows.Forms.MessageBox]::Show(
                "Tally's XML server is already switched on in its settings (Client Server = $($pre.ClientServer), Port = $($pre.Port)), but Tally is not answering on port $port.`r`n`r`nTally is probably busy (a long report or import) or waiting at a message box, such as a licence reminder. Look at the Tally window, answer any message there, and wait a moment.`r`n`r`nRestarting Tally is usually not needed. Close Tally and restart it anyway? Anyone entering data in Tally will lose work that is not saved yet.",
                "Tally is not answering", [System.Windows.Forms.MessageBoxButtons]::YesNo,
                [System.Windows.Forms.MessageBoxIcon]::Information, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
            if ($again -ne [System.Windows.Forms.DialogResult]::Yes) { return }
        }
        $ans = [System.Windows.Forms.MessageBox]::Show(
            "Tally has to be closed while Claudally changes its settings.`r`n`r`nSave your work in Tally first. Close Tally now? Claudally asks it to close the same way clicking its X does.`r`n`r`n(Or choose No, close Tally yourself, and run this again.)",
            "Switch on Tally's XML server", [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
        if ($ans -ne [System.Windows.Forms.DialogResult]::Yes) { return }
        foreach ($p in $copies) {
            $desc = "Process $($p.Id)"
            try { if ($p.Path) { $desc += " - $($p.Path)" } } catch { }
            if (-not (Close-TallyCopy -ProcessId $p.Id -Description $desc)) {
                [System.Windows.Forms.MessageBox]::Show("Tally is still open, so its settings were not changed.", 'Claudally', 'OK', 'Information') | Out-Null
                return
            }
        }
    }

    $cur = Get-TallyIniXmlSettings -Path $ini
    $curCs = $cur.ClientServer; if (-not $curCs) { $curCs = '(not set)' }
    $curPort = $cur.Port; if (-not $curPort) { $curPort = '(not set)' }
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $confirm = [System.Windows.Forms.MessageBox]::Show(
        "Claudally will change Tally's settings file so Tally answers your AI assistant on port ${port}:`r`n`r`n  $ini`r`n`r`n  'TallyPrime acts as' (Client Server): now $curCs - set to Server (or Both if it is Client)`r`n  Port: now $curPort - set to $port`r`n`r`nNothing else in the file changes. A backup copy is saved first as tally.ini.bak-$stamp.`r`n`r`nContinue?",
        "Switch on Tally's XML server", [System.Windows.Forms.MessageBoxButtons]::OKCancel, [System.Windows.Forms.MessageBoxIcon]::Question)
    if ($confirm -ne [System.Windows.Forms.DialogResult]::OK) { return }
    # The confirmation can stay open for any length of time, and Tally can be started meanwhile (by
    # the person, or by the AI's open-tally). Tally rewrites tally.ini when it exits, so an edit made
    # now could be lost: check again right before writing.
    if (Test-TallyRunningAgain) { return }

    $res = Set-TallyIniXmlServer -Path $ini -Port $port -BackupStamp $stamp
    if (-not $res.Ok -and $res.AccessDenied) {
        # Usually Program Files. Same edit, done by an elevated copy of the helper script.
        $helper = Join-Path $script:TrayDir 'tally-ini-xml.ps1'
        $elev = [System.Windows.Forms.MessageBox]::Show(
            "Windows needs administrator permission to change Tally's settings file in`r`n$(Split-Path -Parent $ini)`r`n`r`nContinue? Windows will ask you to confirm.",
            'Claudally', [System.Windows.Forms.MessageBoxButtons]::OKCancel, [System.Windows.Forms.MessageBoxIcon]::Question)
        if ($elev -ne [System.Windows.Forms.DialogResult]::OK) { return }
        if (Test-TallyRunningAgain) { return }
        try {
            $argLine = "-ExecutionPolicy Bypass -NoProfile -File `"$helper`" -TallyIniEditPath `"$ini`" -TallyIniEditPort $port -TallyIniEditBackupStamp $stamp"
            $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argLine -Verb RunAs -WindowStyle Hidden -Wait -PassThru
            $after = Get-TallyIniXmlSettings -Path $ini
            if ($proc.ExitCode -eq 0 -and $after.ServerOn -and $after.Port -eq [string]$port) {
                $res = @{ Ok = $true; Changed = $true; Backup = "$ini.bak-$stamp"; Summary = "Client Server = $($after.ClientServer); Port = $($after.Port)"; Error = '' }
            } else {
                $res = @{ Ok = $false; Error = "The administrator step did not finish (exit code $($proc.ExitCode))." }
            }
        } catch {
            # Includes the person saying No at the UAC prompt.
            $res = @{ Ok = $false; Error = "Administrator permission was not given ($($_.Exception.Message))." }
        }
    }
    if (-not $res.Ok) {
        [System.Windows.Forms.MessageBox]::Show("Tally's settings were not changed.`r`n`r`n$($res.Error)`r`n`r`nYou can switch it on by hand:`r`n$(Get-TallyXmlMenuPath -Port $port)", 'Claudally', 'OK', 'Warning') | Out-Null
        return
    }
    $done = "Tally's XML server is switched on in its settings."
    if ($res.Summary) { $done += "`r`n`r`n$($res.Summary)" }
    if ($res.Backup) { $done += "`r`nBackup: $($res.Backup)" }
    # A copy that started in the last moments before the write would overwrite the change when it
    # exits. Say so rather than offering to start yet another copy.
    $runningNow = 0
    try { $runningNow = @(Get-Process -Name 'tally' -ErrorAction SilentlyContinue).Count } catch { $runningNow = 0 }
    if ($runningNow -gt 0) {
        [System.Windows.Forms.MessageBox]::Show("$done`r`n`r`nBut Tally was started again while the settings were being changed, and Tally may put the old settings back when it closes. If your AI assistant still cannot reach Tally, close Tally and run this again.", 'Claudally', 'OK', 'Warning') | Out-Null
        return
    }
    $start = [System.Windows.Forms.MessageBox]::Show("$done`r`n`r`nStart Tally now?", 'Claudally', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Information)
    if ($start -eq [System.Windows.Forms.DialogResult]::Yes) { Start-TallyFromTray }
}

# True (after telling the person) when a copy of Tally is running again, so tally.ini must not be
# changed now. Any failure to ask Windows counts as "not running", the same as the first check.
function Test-TallyRunningAgain {
    $n = 0
    try { $n = @(Get-Process -Name 'tally' -ErrorAction SilentlyContinue).Count } catch { $n = 0 }
    if ($n -le 0) { return $false }
    try {
        [System.Windows.Forms.MessageBox]::Show("Tally was started again, so its settings were not changed (Tally puts its own settings back when it closes).`r`n`r`nClose Tally and run this again.", 'Claudally', 'OK', 'Information') | Out-Null
    } catch { }
    return $true
}

# --- Settings that the server reads at start --------------------------------------------------------

# After a .env change: in remote mode restart the service (same elevated taskkill + Start-Service as
# the "Allow the AI assistant to control Tally" toggle); in local mode there is no service, and each
# AI app starts its own server, so the app has to be restarted.
# In remote mode the person is asked first, because the restart cuts off whatever the AI assistant
# is doing right now. -AlreadyConfirmed: the caller has already asked, with words that name the
# restart, so only say what was saved.
function Invoke-EnvChangeApply {
    param([string]$What, [switch]$AlreadyConfirmed)
    if ($State.DeploymentMode -eq 'local') {
        [System.Windows.Forms.MessageBox]::Show("$What`r`n`r`nYour AI app picks this up the next time it starts Tally: quit it completely (closing the window is not enough) and open it again.", 'Claudally', 'OK', 'Information') | Out-Null
        return
    }
    $later = "The setting is saved, but the Claudally service is still using the old one. It takes effect the next time the service restarts (tray menu: Restart service)."
    if (-not $AlreadyConfirmed) {
        $ask = [System.Windows.Forms.MessageBox]::Show(
            "$What`r`n`r`nThe Claudally service will restart to apply this (Windows will ask for permission). Anything your AI assistant is doing in Tally right now will be cut off.`r`n`r`nRestart the service now?",
            'Claudally', [System.Windows.Forms.MessageBoxButtons]::OKCancel, [System.Windows.Forms.MessageBoxIcon]::Question)
        if ($ask -ne [System.Windows.Forms.DialogResult]::OK) {
            [System.Windows.Forms.MessageBox]::Show($later, 'Claudally', 'OK', 'Information') | Out-Null
            return
        }
    }
    $cmd = @"
taskkill /F /IM node.exe 2>`$null | Out-Null
Start-Sleep -Seconds 3
Start-Service -Name '$ServiceName' -ErrorAction Stop
"@
    try {
        Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', $cmd) -Verb RunAs -WindowStyle Hidden -ErrorAction Stop
    } catch {
        # Includes the person saying No at the UAC prompt.
        [System.Windows.Forms.MessageBox]::Show("The service was not restarted ($($_.Exception.Message)).`r`n`r`n$later", 'Claudally', 'OK', 'Warning') | Out-Null
        return
    }
    if ($AlreadyConfirmed) {
        try { $tray.ShowBalloonTip(5000, 'Restarting the Claudally service', $What, [System.Windows.Forms.ToolTipIcon]::Info) } catch { }
    }
}

# --- #37 Tally on another computer -----------------------------------------------------------------

function Show-RemoteTallyDialog {
    $ep = Get-TallyEndpoint
    $f = New-Object System.Windows.Forms.Form
    $f.Text            = 'Claudally - Tally on another computer'
    $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $f.MaximizeBox     = $false
    $f.MinimizeBox     = $false
    $f.StartPosition   = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $f.ClientSize      = New-Object System.Drawing.Size 440, 210
    $f.Font            = New-Object System.Drawing.Font 'Segoe UI', 9
    $f.TopMost         = $true

    $intro = New-Object System.Windows.Forms.Label
    $intro.Location = New-Object System.Drawing.Point 14, 12
    $intro.Size     = New-Object System.Drawing.Size 412, 54
    $intro.Text     = "Use a Tally that runs on another computer on your network. That Tally must be open, with its XML server on, and its Windows Firewall must let this computer in on the port."
    $f.Controls.Add($intro)

    $lh = New-Object System.Windows.Forms.Label
    $lh.Text = 'Computer name or IP address:'
    $lh.Location = New-Object System.Drawing.Point 14, 76
    $lh.AutoSize = $true
    $f.Controls.Add($lh)
    $tbHost = New-Object System.Windows.Forms.TextBox
    $tbHost.Location = New-Object System.Drawing.Point 14, 96
    $tbHost.Size     = New-Object System.Drawing.Size 300, 24
    if ($ep.IsRemote) { $tbHost.Text = $ep.Host }
    $f.Controls.Add($tbHost)

    $lp = New-Object System.Windows.Forms.Label
    $lp.Text = 'Port:'
    $lp.Location = New-Object System.Drawing.Point 326, 76
    $lp.AutoSize = $true
    $f.Controls.Add($lp)
    $tbPort = New-Object System.Windows.Forms.TextBox
    $tbPort.Location = New-Object System.Drawing.Point 326, 96
    $tbPort.Size     = New-Object System.Drawing.Size 100, 24
    $tbPort.Text     = [string]$ep.Port
    $f.Controls.Add($tbPort)

    $btnOk = New-Object System.Windows.Forms.Button
    $btnOk.Text = 'Test and save'
    $btnOk.Size = New-Object System.Drawing.Size 120, 30
    $btnOk.Location = New-Object System.Drawing.Point 200, 160
    $btnOk.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $f.Controls.Add($btnOk)
    $f.AcceptButton = $btnOk

    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = 'Cancel'
    $btnCancel.Size = New-Object System.Drawing.Size 100, 30
    $btnCancel.Location = New-Object System.Drawing.Point 326, 160
    $btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $f.Controls.Add($btnCancel)
    $f.CancelButton = $btnCancel

    $res = $f.ShowDialog()
    $hostName = $tbHost.Text.Trim()
    $portText = $tbPort.Text.Trim()
    $f.Dispose()
    if ($res -ne [System.Windows.Forms.DialogResult]::OK) { return }

    $port = 0
    if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        [System.Windows.Forms.MessageBox]::Show("'$portText' is not a port number (1 to 65535). Nothing was changed.", 'Claudally', 'OK', 'Warning') | Out-Null
        return
    }
    if (-not $hostName -or $hostName -match '[\s/\\"]') {
        [System.Windows.Forms.MessageBox]::Show("Enter the other computer's name (for example ACCOUNTS-PC) or its IP address (for example 192.168.1.20). Nothing was changed.", 'Claudally', 'OK', 'Warning') | Out-Null
        return
    }
    if (Test-TallyHostIsLocal $hostName) {
        Set-TallyOnThisComputer -Port $port
        return
    }

    $old = [System.Windows.Forms.Cursor]::Current
    [System.Windows.Forms.Cursor]::Current = [System.Windows.Forms.Cursors]::WaitCursor
    $probe = $null
    try {
        $tcpOk = Test-TcpPort -HostName $hostName -Port $port -TimeoutMs 3000
        if ($tcpOk) { $probe = Test-TallyXml -HostName $hostName -Port $port -TimeoutSec 5 }
    } finally { [System.Windows.Forms.Cursor]::Current = $old }

    if (-not $probe -or -not $probe.Ok) {
        $why = "Nothing answered on $hostName port $port."
        if ($probe -and $probe.Error) { $why = "$hostName port $port answered, but not like Tally: $($probe.Error)" }
        $save = [System.Windows.Forms.MessageBox]::Show(
            "$why`r`n`r`nCheck that, on that computer:`r`n  - Tally is open,`r`n  - its XML server is on: $(Get-TallyXmlMenuPath -Port $port)`r`n  - Windows Firewall allows incoming connections on port $port.`r`n`r`nSave $hostName anyway (for example because Tally is closed there right now)?",
            'Claudally - Tally not reachable', [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
        if ($save -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    }

    try {
        Set-EnvValue -EnvPath (Get-TrayEnvPath) -Key 'TALLY_HOST' -Value $hostName
        Set-EnvValue -EnvPath (Get-TrayEnvPath) -Key 'TALLY_PORT' -Value ([string]$port)
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Could not save the setting: $_", 'Claudally', 'OK', 'Error') | Out-Null
        return
    }
    $msg = "Saved: your AI assistant will use the Tally on $hostName, port $port."
    if ($probe -and $probe.Ok -and $probe.Company) { $msg = "Connected to the Tally on $hostName (company open: $($probe.Company)) and saved." }
    elseif ($probe -and $probe.Ok) { $msg = "Connected to the Tally on $hostName and saved." }
    Invoke-EnvChangeApply -What $msg
}

function Set-TallyOnThisComputer {
    param([int]$Port = 0)
    try {
        Set-EnvValue -EnvPath (Get-TrayEnvPath) -Key 'TALLY_HOST' -Value '127.0.0.1'
        if ($Port -gt 0) { Set-EnvValue -EnvPath (Get-TrayEnvPath) -Key 'TALLY_PORT' -Value ([string]$Port) }
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Could not save the setting: $_", 'Claudally', 'OK', 'Error') | Out-Null
        return
    }
    Invoke-EnvChangeApply -What 'Saved: your AI assistant will use the Tally on this computer.'
}
