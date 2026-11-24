<#
.SYNOPSIS
    Tray side of the coordination files (docs/dev/coordination.md sections 1 and 3).
    Dot-sourced by tally-mcp-tray.ps1; defines functions only.

.DESCRIPTION
    #22 AI-activity outline. A topmost, click-through, never-activating orange frame around the
        Tally window while any server process reports fresh activity in _mcp_activity\<pid>.json.
        Ported from the GUI agent's overlay. It runs on its OWN STA thread (a runspace with its own
        message loop and a 200 ms WinForms timer), not on the tray's UI thread: the tray's status
        poll blocks that thread for up to a few seconds (CIM queries, HTTP probes), and the frame
        must still vanish within one tick when a record says hideForScreenshot, or it ends up in
        the screenshot the model sees.

    #25 Restart countdown. _mcp_restart_request.json -> a small topmost dialog with a live countdown
        and Cancel / Restart now, answered through _mcp_restart_response.json. This one lives on the
        tray's UI thread (it needs the tray's balloon, and its 250 ms timer only has to be roughly
        on time).

    Everything is best-effort: every tick and file read is wrapped, and a failure here only means
    the frame or dialog does not appear.

.NOTES
    Windows PowerShell 5.1 compatible; ASCII only.
#>

# --- Native helpers + form subclasses ------------------------------------------------------------
# ShowWithoutActivation is a protected virtual property and CreateParams a protected one, so neither
# can be set from PowerShell; a tiny C# subclass is the only way to get a window that never takes
# focus from the person typing in Tally.
#   OverlayForm - click-through (WS_EX_TRANSPARENT|WS_EX_LAYERED), tool window (no taskbar/Alt+Tab),
#                 WS_EX_NOACTIVATE + ShowWithoutActivation, topmost from creation, hit-test transparent.
#   QuietForm   - an ordinary clickable dialog that simply does not steal focus when it appears, so a
#                 keystroke meant for Tally cannot land on one of its buttons.
$script:TrayFormTypesOk = $false
try {
    if (-not ('TallyTray.OverlayForm' -as [type])) {
        Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace TallyTray {
    public class QuietForm : Form {
        protected override bool ShowWithoutActivation { get { return true; } }
    }

    public class OverlayForm : Form {
        private const int WS_EX_TOPMOST     = 0x00000008;
        private const int WS_EX_TRANSPARENT = 0x00000020;
        private const int WS_EX_TOOLWINDOW  = 0x00000080;
        private const int WS_EX_LAYERED     = 0x00080000;
        private const int WS_EX_NOACTIVATE  = 0x08000000;
        private const int WM_NCHITTEST      = 0x0084;
        private const int WM_MOUSEACTIVATE  = 0x0021;
        private const int HTTRANSPARENT     = -1;
        private const int MA_NOACTIVATE     = 3;
        private const uint SWP_NOSIZE       = 0x0001;
        private const uint SWP_NOMOVE       = 0x0002;
        private const uint SWP_NOACTIVATE   = 0x0010;

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams {
            get {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_TOPMOST | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOACTIVATE;
                return cp;
            }
        }

        protected override void WndProc(ref Message m) {
            if (m.Msg == WM_NCHITTEST) { m.Result = new IntPtr(HTTRANSPARENT); return; }
            if (m.Msg == WM_MOUSEACTIVATE) { m.Result = new IntPtr(MA_NOACTIVATE); return; }
            base.WndProc(ref m);
        }

        // Re-assert topmost without activating. The TopMost property setter calls SetWindowPos
        // WITHOUT SWP_NOACTIVATE, which can pull focus away from Tally; this never does.
        public void KeepOnTop() {
            if (!IsHandleCreated) { return; }
            SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
        }
    }

    public static class OverlayNative {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsWindowVisible(IntPtr hWnd);
    }
}
'@
    }
    $script:TrayFormTypesOk = $true
} catch {
    $script:TrayFormTypesOk = $false
}

# ISO-8601 (or an already-parsed DateTime, which is what pwsh 7's ConvertFrom-Json hands back) to
# UTC, or $null. Windows PowerShell 5.1's ConvertFrom-Json leaves ISO strings as strings.
function ConvertTo-TrayUtc {
    param($Value)
    if ($null -eq $Value) { return $null }
    try {
        if ($Value -is [datetime]) { return $Value.ToUniversalTime() }
        $s = [string]$Value
        if (-not $s) { return $null }
        return [datetime]::Parse($s, [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]'AdjustToUniversal, AssumeUniversal')
    } catch { return $null }
}

# Reads a coordination JSON file: tolerates a leading BOM, and returns $null for a missing,
# empty, locked or half-written file (the contract says: treat those as absent).
function Read-TrayCoordinationJson {
    param([string]$Path)
    try {
        if (-not [System.IO.File]::Exists($Path)) { return $null }
        $txt = [System.IO.File]::ReadAllText($Path)
        if ($null -eq $txt) { return $null }
        $txt = $txt.TrimStart([char]0xFEFF).Trim()
        if (-not $txt) { return $null }
        return (ConvertFrom-Json -InputObject $txt -ErrorAction Stop)
    } catch { return $null }
}

# Writes JSON the way the contract requires: UTF-8 WITHOUT a BOM, to a temp file, then renamed into
# place so a reader never sees half of it. Throws on failure (callers report it).
function Write-TrayCoordinationJson {
    param([string]$Path, $Object)
    $json = $Object | ConvertTo-Json -Compress -Depth 6
    $tmp = "$Path.tmp.$PID"
    try {
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        if ([System.IO.File]::Exists($Path)) {
            try { [System.IO.File]::Replace($tmp, $Path, $null) }
            catch {
                # Replace can refuse on some file systems / ACLs; fall back to delete + move.
                [System.IO.File]::Delete($Path)
                [System.IO.File]::Move($tmp, $Path)
            }
        } else {
            [System.IO.File]::Move($tmp, $Path)
        }
    } finally {
        try { if ([System.IO.File]::Exists($tmp)) { [System.IO.File]::Delete($tmp) } } catch { }
    }
}

# =================================================================================================
# #22 AI-activity outline
# =================================================================================================

# Shared with the overlay thread. The status poll keeps Dir / Enabled / PortOwnerPid current; the
# overlay thread only reads them (and writes LastError for debugging).
$script:OverlayShared = [hashtable]::Synchronized(@{
    Dir          = ''      # coordination folder (TALLY_DATA_PATH)
    Enabled      = $false  # off while Tally is on another computer
    PortOwnerPid = 0       # when several Tally copies run: the one holding the XML port, if known
    Stop         = $false
    LastError    = ''
})
$script:OverlayPs = $null

# Runs on the overlay thread. Self-contained on purpose: functions defined in the tray's runspace
# are not visible here, only the shared hashtable and the TallyTray.* types (one AppDomain).
$script:OverlayThreadScript = {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $S = $OverlayShared

        $barH = 26      # banner strip height
        $th   = 6       # frame thickness
        $banners = @{
            posting     = "Your AI assistant is posting to Tally"
            controlling = "Your AI assistant is controlling Tally - please don't use the keyboard or mouse"
            loading     = "Your AI assistant is reopening Tally"
        }
        # Stronger warning wins when several records are fresh.
        $rank = @{ posting = 1; controlling = 2; loading = 3 }

        $orange = [System.Drawing.Color]::FromArgb(255, 140, 0)
        $form = New-Object TallyTray.OverlayForm
        $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
        $form.ShowInTaskbar   = $false
        $form.StartPosition   = [System.Windows.Forms.FormStartPosition]::Manual
        # Set before the handle exists, so it only feeds CreateParams (WS_EX_TOPMOST) and never
        # calls the activating SetWindowPos path.
        $form.TopMost   = $true
        $form.BackColor = $orange
        # Opacity below 1 is what makes WinForms apply the layered alpha. At exactly 1.0 a window
        # carrying WS_EX_LAYERED composites fully transparent, so it is kept within 0.70 .. 0.92.
        $form.Opacity = 0.9
        # No initial Bounds: the first tick that shows the frame places it before Show().

        $label = New-Object System.Windows.Forms.Label
        $label.Dock      = [System.Windows.Forms.DockStyle]::Top
        $label.Height    = $barH
        $label.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
        $label.BackColor = $orange
        $label.ForeColor = [System.Drawing.Color]::White
        $label.Font      = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
        $label.AutoEllipsis = $true
        $form.Controls.Add($label)

        # Mutable state for the tick handler (assignments inside a handler would create locals).
        $ctx = @{
            Files  = @{}                    # path -> @{ Stamp; Rec } so unchanged files are not re-parsed
            Hwnd   = [IntPtr]::Zero
            HwndAt = [datetime]::MinValue
            Kind   = ''
            Bounds = ''
            Glow   = 0
        }

        $timer = New-Object System.Windows.Forms.Timer
        $timer.Interval = 200
        $timer.Add_Tick({
            try {
                if ($S.Stop) {
                    $timer.Stop()
                    try { $form.Close() } catch { }
                    [System.Windows.Forms.Application]::ExitThread()
                    return
                }
                $dir = [string]$S.Dir
                if (-not $S.Enabled -or -not $dir) { if ($form.Visible) { $form.Hide() }; return }

                # --- 1. Which record (if any) to show ---------------------------------------
                $actDir = [System.IO.Path]::Combine($dir, '_mcp_activity')
                $nowUtc = [datetime]::UtcNow
                $best = $null; $bestRank = 0; $screenshot = $false
                if ([System.IO.Directory]::Exists($actDir)) {
                    $seen = @{}
                    foreach ($f in [System.IO.Directory]::GetFiles($actDir, '*.json')) {
                        $seen[$f] = $true
                        $rec = $null
                        try {
                            $stamp = [System.IO.File]::GetLastWriteTimeUtc($f).Ticks
                            $cached = $ctx.Files[$f]
                            if ($cached -and $cached.Stamp -eq $stamp) {
                                $rec = $cached.Rec
                            } else {
                                $txt = [System.IO.File]::ReadAllText($f)
                                $txt = ([string]$txt).TrimStart([char]0xFEFF).Trim()
                                if ($txt) {
                                    $j = ConvertFrom-Json -InputObject $txt -ErrorAction Stop
                                    $at = $null
                                    if ($j.at -is [datetime]) { $at = $j.at.ToUniversalTime() }
                                    elseif ($j.at) {
                                        $at = [datetime]::Parse([string]$j.at, [System.Globalization.CultureInfo]::InvariantCulture,
                                            [System.Globalization.DateTimeStyles]'AdjustToUniversal, AssumeUniversal')
                                    }
                                    if ($at) {
                                        $rec = @{ Kind = ([string]$j.kind).ToLowerInvariant(); At = $at; Hide = ($j.hideForScreenshot -eq $true) }
                                    }
                                }
                                # Cached only after a clean parse: a half-written read is retried next tick.
                                $ctx.Files[$f] = @{ Stamp = $stamp; Rec = $rec }
                            }
                        } catch { $rec = $null }
                        if (-not $rec) { continue }
                        # Fresh = now - at <= 4 s.
                        if (($nowUtc - $rec.At).TotalSeconds -gt 4) { continue }
                        # A screenshot is being captured by SOME server: the frame must not be in it,
                        # whichever record would otherwise be shown.
                        if ($rec.Hide) { $screenshot = $true }
                        $r = $rank[$rec.Kind]
                        if (-not $r) { continue }
                        if ($r -gt $bestRank) { $bestRank = $r; $best = $rec }
                    }
                    if ($ctx.Files.Count -gt $seen.Count) {
                        foreach ($k in @($ctx.Files.Keys)) { if (-not $seen.ContainsKey($k)) { $ctx.Files.Remove($k) } }
                    }
                }
                if ($screenshot -or -not $best) { if ($form.Visible) { $form.Hide() }; return }

                # --- 2. Find Tally's main window (re-resolved every 2 s, or when it went away) ---
                $h = [IntPtr]$ctx.Hwnd
                $valid = ($h -ne [IntPtr]::Zero) -and [TallyTray.OverlayNative]::IsWindow($h)
                if (-not $valid -or ($nowUtc - $ctx.HwndAt).TotalSeconds -ge 2) {
                    $h = [IntPtr]::Zero
                    $procs = @(Get-Process -Name 'tally' -ErrorAction SilentlyContinue)
                    $owner = 0
                    try { $owner = [int]$S.PortOwnerPid } catch { $owner = 0 }
                    $pick = $null
                    if ($owner -gt 0) {
                        $pick = $procs | Where-Object { $_.Id -eq $owner -and $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
                    }
                    if (-not $pick) {
                        $pick = $procs | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
                    }
                    if ($pick) { $h = $pick.MainWindowHandle }
                    $ctx.Hwnd = $h
                    $ctx.HwndAt = $nowUtc
                }
                # Not running, minimised or hidden: no frame, and no error either.
                if ($h -eq [IntPtr]::Zero) { if ($form.Visible) { $form.Hide() }; return }
                if ([TallyTray.OverlayNative]::IsIconic($h) -or -not [TallyTray.OverlayNative]::IsWindowVisible($h)) {
                    if ($form.Visible) { $form.Hide() }; return
                }
                $wr = New-Object TallyTray.OverlayNative+RECT
                if (-not [TallyTray.OverlayNative]::GetWindowRect($h, [ref]$wr)) { if ($form.Visible) { $form.Hide() }; return }

                # --- 3. Place the frame --------------------------------------------------------
                # Clamp to the work area of Tally's monitor so the frame and banner are always on
                # screen (a maximised window overhangs its monitor by a few pixels).
                $rect = New-Object System.Drawing.Rectangle $wr.Left, $wr.Top, ($wr.Right - $wr.Left), ($wr.Bottom - $wr.Top)
                $wa = ([System.Windows.Forms.Screen]::FromRectangle($rect)).WorkingArea
                $left   = [Math]::Max($wr.Left, $wa.Left)
                $top    = [Math]::Max($wr.Top, $wa.Top)
                $right  = [Math]::Min($wr.Right, $wa.Right)
                $bottom = [Math]::Min($wr.Bottom, $wa.Bottom)
                $vw = $right - $left; $vh = $bottom - $top
                if ($vw -le (2 * $th) -or $vh -le ($barH + $th)) { if ($form.Visible) { $form.Hide() }; return }

                # Windowed with room: banner above the window, frame hugging the outside edges, so no
                # Tally content is covered. Maximised / against a screen edge: frame inset inside the
                # visible area with the banner along its top.
                $fitsAbove = ($top - $barH) -ge $wa.Top
                $fitsSides = (($left - $th) -ge $wa.Left) -and (($right + $th) -le $wa.Right) -and (($bottom + $th) -le $wa.Bottom)
                if ($fitsAbove -and $fitsSides) {
                    $fLeft = $left - $th; $fTop = $top - $barH; $fW = $vw + 2 * $th; $fH = $vh + $barH + $th
                } else {
                    $fLeft = $left; $fTop = $top; $fW = $vw; $fH = $vh
                }
                $key = "$fLeft,$fTop,$fW,$fH"
                if ($key -ne $ctx.Bounds) {
                    $form.Bounds = New-Object System.Drawing.Rectangle $fLeft, $fTop, $fW, $fH
                    $rgn = New-Object System.Drawing.Region (New-Object System.Drawing.Rectangle 0, 0, $fW, $fH)
                    $rgn.Exclude((New-Object System.Drawing.Rectangle $th, $barH, ($fW - 2 * $th), ($fH - $barH - $th)))
                    $oldRgn = $form.Region
                    $form.Region = $rgn
                    if ($oldRgn) { $oldRgn.Dispose() }
                    $ctx.Bounds = $key
                }
                if ($best.Kind -ne $ctx.Kind) {
                    $label.Text = '  ' + $banners[$best.Kind] + '  '
                    $ctx.Kind = $best.Kind
                }

                # Gentle glow: breathe the opacity and shimmer from deep orange toward amber.
                $ctx.Glow = ($ctx.Glow + 1) % 100000
                $phase = ([Math]::Sin($ctx.Glow * 0.45) + 1) / 2
                $form.Opacity = 0.72 + 0.2 * $phase
                $col = [System.Drawing.Color]::FromArgb(255, [int](120 + 60 * $phase), 0)
                $form.BackColor = $col
                $label.BackColor = $col

                if (-not $form.Visible) { $form.Show() }
                $form.KeepOnTop()
            } catch {
                try { $S.LastError = "$_" } catch { }
            }
        })
        $timer.Start()
        # A message loop with no main form: the frame is shown and hidden by the timer alone.
        [System.Windows.Forms.Application]::Run()
        try { $timer.Dispose() } catch { }
        try { $form.Dispose() } catch { }
    } catch {
        try { $OverlayShared.LastError = "$_" } catch { }
    }
}

function Start-ActivityOverlay {
    if (-not $script:TrayFormTypesOk) { return }
    if ($script:OverlayPs) { return }
    try {
        $rs = [runspacefactory]::CreateRunspace()
        $rs.ApartmentState = [System.Threading.ApartmentState]::STA
        $rs.ThreadOptions  = [System.Management.Automation.Runspaces.PSThreadOptions]::ReuseThread
        $rs.Open()
        $rs.SessionStateProxy.SetVariable('OverlayShared', $script:OverlayShared)
        $ps = [powershell]::Create()
        $ps.Runspace = $rs
        # As text: the block is re-parsed inside the new runspace, not bound to this one.
        [void]$ps.AddScript($script:OverlayThreadScript.ToString())
        [void]$ps.BeginInvoke()
        $script:OverlayPs = $ps
    } catch {
        $script:OverlayPs = $null
    }
}

function Stop-ActivityOverlay {
    try { $script:OverlayShared.Stop = $true } catch { }
}

# Activity files of server processes that are gone. The contract allows the tray to remove them;
# doing it keeps a crashed server's last "posting" record from being parsed forever. Only files older
# than 60 s whose pid is not running.
$script:ActivityCleanupAt = [datetime]::MinValue
function Remove-StaleActivityFiles {
    param([string]$Dir)
    try {
        if (-not $Dir) { return }
        if (((Get-Date) - $script:ActivityCleanupAt).TotalSeconds -lt 30) { return }
        $script:ActivityCleanupAt = Get-Date
        $actDir = [System.IO.Path]::Combine($Dir, '_mcp_activity')
        if (-not [System.IO.Directory]::Exists($actDir)) { return }
        $nowUtc = [datetime]::UtcNow
        foreach ($f in [System.IO.Directory]::GetFiles($actDir, '*.json')) {
            try {
                if (($nowUtc - [System.IO.File]::GetLastWriteTimeUtc($f)).TotalSeconds -le 60) { continue }
                $procId = 0
                $rec = Read-TrayCoordinationJson -Path $f
                if ($rec -and $rec.pid) { try { $procId = [int]$rec.pid } catch { $procId = 0 } }
                if ($procId -le 0) {
                    $n = 0
                    if ([int]::TryParse([System.IO.Path]::GetFileNameWithoutExtension($f), [ref]$n)) { $procId = $n }
                }
                $alive = $false
                if ($procId -gt 0) {
                    try { $null = Get-Process -Id $procId -ErrorAction Stop; $alive = $true } catch { $alive = $false }
                }
                if (-not $alive) { [System.IO.File]::Delete($f) }
            } catch { }
        }
    } catch { }
}

# =================================================================================================
# #25 Restart countdown
# =================================================================================================

# Cancel and Restart now stop working this long BEFORE the deadline, and the dialog then says
# "Restarting Tally...". The server keeps reading answers until (a little after) the deadline, so an
# answer written before this cutoff is one it is sure to read. A click that arrives later (the tray's
# UI thread can be busy for a few seconds with the status poll) is refused, never reported as a
# cancel the server did not honour.
$script:RestartAnswerCutoffSec = 1.0

$script:Countdown = @{
    Form      = $null
    Label     = $null
    BtnCancel = $null
    BtnNow    = $null
    RequestId = ''
    Deadline  = [datetime]::MinValue   # UTC
    Company   = ''
    Handled   = @{}                    # requestIds already shown (or already past), never shown twice
    Stamp     = 0                      # LastWriteTime ticks of the request file last parsed
    Req       = $null                  # the last parsed request
    Pending   = $null                  # @{ RequestId; Deadline } of a Cancel written, not yet confirmed
}

function Get-RestartCountdownCutoff {
    return $script:Countdown.Deadline.AddSeconds(-$script:RestartAnswerCutoffSec)
}

function Get-RestartCountdownText {
    $what = 'a company'
    if ($script:Countdown.Company) { $what = $script:Countdown.Company }
    if ([datetime]::UtcNow -ge (Get-RestartCountdownCutoff)) {
        return "Restarting Tally to load $what..."
    }
    $secs = [int][Math]::Ceiling(($script:Countdown.Deadline - [datetime]::UtcNow).TotalSeconds)
    if ($secs -lt 0) { $secs = 0 }
    return "Your AI assistant will restart Tally in ${secs}s to load $what. Anyone entering data in Tally will lose unsaved work."
}

# Refresh the countdown text, and switch both buttons off once the cutoff has passed.
function Update-RestartCountdownView {
    try {
        if ([datetime]::UtcNow -ge (Get-RestartCountdownCutoff)) {
            foreach ($b in @($script:Countdown.BtnCancel, $script:Countdown.BtnNow)) {
                if ($b -and -not $b.IsDisposed -and $b.Enabled) { try { $b.Enabled = $false } catch { } }
            }
        }
        $lbl = $script:Countdown.Label
        if ($lbl -and -not $lbl.IsDisposed) { $lbl.Text = Get-RestartCountdownText }
    } catch { }
}

function Close-RestartCountdown {
    $f = $script:Countdown.Form
    $script:Countdown.Form = $null
    $script:Countdown.Label = $null
    $script:Countdown.BtnCancel = $null
    $script:Countdown.BtnNow = $null
    # Close() on a form shown with Show() also disposes it.
    if ($f -and -not $f.IsDisposed) { try { $f.Close() } catch { } }
}

# What happened to a Cancel that was written:
#   'pending' - the request is still there; the server has not answered yet
#   'acked'   - the request went away before the deadline and our answer was read: cancelled
#   'late'    - the request went away but our answer is still lying there unread
#   'unknown' - cannot tell (noticed only after the deadline, or no answer long after it)
# The server deletes the response when it reads it and the request when it is done, in that order.
function Get-RestartCancelState {
    param([string]$Dir, [string]$RequestId, [datetime]$Deadline)
    $reqPath  = [System.IO.Path]::Combine($Dir, '_mcp_restart_request.json')
    $respPath = [System.IO.Path]::Combine($Dir, '_mcp_restart_response.json')
    $nowUtc = [datetime]::UtcNow
    $reqLive = $false
    if ([System.IO.File]::Exists($reqPath)) {
        $j = Read-TrayCoordinationJson -Path $reqPath
        # Unreadable for a moment (being written or read): still there, as far as we know.
        if (-not $j -or -not $j.requestId -or [string]$j.requestId -eq $RequestId) { $reqLive = $true }
    }
    if ($reqLive) {
        if ($nowUtc -ge $Deadline.AddSeconds(5)) { return 'unknown' }
        return 'pending'
    }
    $respOurs = $false
    if ([System.IO.File]::Exists($respPath)) {
        $r = Read-TrayCoordinationJson -Path $respPath
        if (-not $r -or [string]$r.requestId -eq $RequestId) { $respOurs = $true }
    }
    if ($respOurs) { return 'late' }
    if ($nowUtc -lt $Deadline) { return 'acked' }
    return 'unknown'
}

function Show-RestartCancelOutcome {
    param([string]$Outcome)
    try {
        if ($Outcome -eq 'acked') {
            $tray.ShowBalloonTip(5000, 'Tally restart cancelled', 'Your AI assistant will not restart Tally.', [System.Windows.Forms.ToolTipIcon]::Info)
        } elseif ($Outcome -eq 'late') {
            $tray.ShowBalloonTip(8000, 'Cancel came too late', 'Your AI assistant did not get the Cancel in time. Tally may be restarting now.', [System.Windows.Forms.ToolTipIcon]::Warning)
        } elseif ($Outcome -eq 'unknown') {
            $tray.ShowBalloonTip(8000, 'Cancel not confirmed', 'Claudally sent your Cancel but could not confirm that your AI assistant got it in time. Tally may be restarting - check it before you enter data.', [System.Windows.Forms.ToolTipIcon]::Warning)
        }
    } catch { }
}

# Answer the request on screen. Decision: 'cancel' or 'proceed'.
function Send-RestartDecision {
    param([string]$Decision)
    $reqId = $script:Countdown.RequestId
    $deadline = $script:Countdown.Deadline
    $cached = $script:Countdown.Req
    $dir = $script:OverlayShared.Dir
    Close-RestartCountdown
    if (-not $reqId -or -not $dir) { return }
    $isCancel = ($Decision -eq 'cancel')

    # Only answer a request that is still there and still before the cutoff. The buttons are switched
    # off at the cutoff, but a click made while the UI thread was busy can arrive after it.
    $live = $false
    try {
        $reqPath = [System.IO.Path]::Combine($dir, '_mcp_restart_request.json')
        if ([System.IO.File]::Exists($reqPath)) {
            $j = Read-TrayCoordinationJson -Path $reqPath
            if ($j -and $j.requestId) {
                if ([string]$j.requestId -eq $reqId) {
                    $live = $true
                    $fileDeadline = ConvertTo-TrayUtc $j.deadline
                    if ($fileDeadline -and $fileDeadline -lt $deadline) { $deadline = $fileDeadline }
                }
            } elseif ($cached -and $cached.RequestId -eq $reqId) {
                # Being read or written this instant. The server never rewrites a live request, so
                # what we parsed before still holds.
                $live = $true
            }
        }
    } catch { $live = $false }
    if (-not $live -or [datetime]::UtcNow -ge $deadline.AddSeconds(-$script:RestartAnswerCutoffSec)) {
        if ($isCancel) {
            try { $tray.ShowBalloonTip(8000, 'Too late to cancel', 'Your AI assistant is already restarting Tally.', [System.Windows.Forms.ToolTipIcon]::Warning) } catch { }
        }
        return
    }

    try {
        $answer = [ordered]@{
            schemaVersion = 1
            requestId     = $reqId
            decision      = $Decision
            at            = [datetime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [System.Globalization.CultureInfo]::InvariantCulture)
        }
        Write-TrayCoordinationJson -Path ([System.IO.Path]::Combine($dir, '_mcp_restart_response.json')) -Object $answer
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Claudally could not pass your answer to the AI assistant:`r`n$($_.Exception.Message)`r`n`r`nWithout an answer Tally restarts when the countdown ends.", 'Claudally', 'OK', 'Warning') | Out-Null
        return
    }
    if (-not $isCancel) { return }

    # Say "cancelled" only once the server has taken the answer (it reads every 250 ms, so this is
    # normally quick). If it takes longer, the 250 ms coordination timer keeps watching.
    $outcome = 'pending'
    try {
        $waitUntil = [datetime]::UtcNow.AddMilliseconds(1500)
        if ($waitUntil -gt $deadline) { $waitUntil = $deadline }
        while ($true) {
            $outcome = Get-RestartCancelState -Dir $dir -RequestId $reqId -Deadline $deadline
            if ($outcome -ne 'pending') { break }
            if ([datetime]::UtcNow -ge $waitUntil) { break }
            Start-Sleep -Milliseconds 50
        }
    } catch { $outcome = 'pending' }
    if ($outcome -eq 'pending') {
        $script:Countdown.Pending = @{ RequestId = $reqId; Deadline = $deadline }
    } else {
        Show-RestartCancelOutcome -Outcome $outcome
    }
}

function Show-RestartCountdown {
    param($Req)
    $script:Countdown.RequestId = $Req.RequestId
    $script:Countdown.Deadline  = $Req.Deadline
    $script:Countdown.Company   = $Req.Company

    if ($script:TrayFormTypesOk) { $f = New-Object TallyTray.QuietForm } else { $f = New-Object System.Windows.Forms.Form }
    $f.Text            = 'Claudally - Tally is about to restart'
    $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    # No close box: closing would be neither answer. The two buttons are the only ways out (or the
    # deadline, which means proceed).
    $f.ControlBox      = $false
    $f.ShowInTaskbar   = $true
    $f.TopMost         = $true
    $f.StartPosition   = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $f.ClientSize      = New-Object System.Drawing.Size 460, 150
    $f.BackColor       = [System.Drawing.Color]::White
    $f.Font            = New-Object System.Drawing.Font 'Segoe UI', 10

    $strip = New-Object System.Windows.Forms.Panel
    $strip.Dock      = [System.Windows.Forms.DockStyle]::Top
    $strip.Height    = 4
    $strip.BackColor = [System.Drawing.Color]::FromArgb(255, 140, 0)
    $f.Controls.Add($strip)

    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Location = New-Object System.Drawing.Point 18, 20
    $lbl.Size     = New-Object System.Drawing.Size 424, 70
    $lbl.ForeColor = [System.Drawing.Color]::FromArgb(31, 41, 55)
    $f.Controls.Add($lbl)

    # Deliberately no AcceptButton / CancelButton: Enter or Esc typed for Tally must not answer this.
    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text     = 'Cancel'
    $btnCancel.Location = New-Object System.Drawing.Point 196, 100
    $btnCancel.Size     = New-Object System.Drawing.Size 120, 34
    $btnCancel.Add_Click({ try { Send-RestartDecision -Decision 'cancel' } catch { } })
    $f.Controls.Add($btnCancel)
    $script:Countdown.BtnCancel = $btnCancel

    $btnNow = New-Object System.Windows.Forms.Button
    $btnNow.Text     = 'Restart now'
    $btnNow.Location = New-Object System.Drawing.Point 322, 100
    $btnNow.Size     = New-Object System.Drawing.Size 120, 34
    $btnNow.Add_Click({ try { Send-RestartDecision -Decision 'proceed' } catch { } })
    $f.Controls.Add($btnNow)
    $script:Countdown.BtnNow = $btnNow

    $script:Countdown.Form  = $f
    $script:Countdown.Label = $lbl
    Update-RestartCountdownView
    # Show(), not ShowDialog(): the tray's message loop keeps running, so the countdown keeps ticking
    # and the frame keeps following Tally.
    $f.Show()

    $what = 'a company'
    if ($Req.Company) { $what = $Req.Company }
    try {
        $tray.ShowBalloonTip(8000, 'Tally is about to restart',
            "Your AI assistant will restart Tally to load $what. Use Cancel in the countdown window to stop it.",
            [System.Windows.Forms.ToolTipIcon]::Warning)
    } catch { }
}

# Called every 250 ms on the tray's UI thread.
function Update-RestartCountdown {
    $dir = $script:OverlayShared.Dir
    if (-not $dir) { return }
    $reqPath = [System.IO.Path]::Combine($dir, '_mcp_restart_request.json')

    $req = $null
    if ([System.IO.File]::Exists($reqPath)) {
        $stamp = 0
        try { $stamp = [System.IO.File]::GetLastWriteTimeUtc($reqPath).Ticks } catch { $stamp = 0 }
        if ($stamp -ne 0 -and $stamp -eq $script:Countdown.Stamp) {
            $req = $script:Countdown.Req
        } else {
            $j = Read-TrayCoordinationJson -Path $reqPath
            if ($j -and $j.requestId) {
                $req = @{
                    RequestId = [string]$j.requestId
                    Company   = [string]$j.company
                    Deadline  = (ConvertTo-TrayUtc $j.deadline)
                }
                $script:Countdown.Stamp = $stamp
                $script:Countdown.Req   = $req
            } else {
                # Locked or half-written for a moment: keep what we last knew rather than flicker the
                # dialog closed. A file that stays unreadable simply runs into its deadline.
                $req = $script:Countdown.Req
            }
        }
    } else {
        $script:Countdown.Stamp = 0
        $script:Countdown.Req   = $null
    }

    $nowUtc = [datetime]::UtcNow

    # A Cancel that was written but not yet confirmed (see Send-RestartDecision).
    $pend = $script:Countdown.Pending
    if ($pend) {
        try {
            $outcome = Get-RestartCancelState -Dir $dir -RequestId $pend.RequestId -Deadline $pend.Deadline
            if ($outcome -ne 'pending') {
                $script:Countdown.Pending = $null
                Show-RestartCancelOutcome -Outcome $outcome
            }
        } catch { $script:Countdown.Pending = $null }
    }

    $f = $script:Countdown.Form
    if ($f -and -not $f.IsDisposed) {
        if (-not $req -or $req.RequestId -ne $script:Countdown.RequestId -or $nowUtc -ge $script:Countdown.Deadline) {
            Close-RestartCountdown
        } else {
            Update-RestartCountdownView
            return
        }
    } elseif ($f) {
        $script:Countdown.Form = $null
    }

    if ($req -and $req.RequestId -and -not $script:Countdown.Handled.ContainsKey($req.RequestId)) {
        if ($script:Countdown.Handled.Count -gt 200) { $script:Countdown.Handled.Clear() }
        $script:Countdown.Handled[$req.RequestId] = $true
        if ($req.Deadline -and $req.Deadline -gt $nowUtc.AddMilliseconds(500)) {
            Show-RestartCountdown -Req $req
        }
    }
}
