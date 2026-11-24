# MCP Tally GUI Agent v2 - eyes and hands for the Tally window.
#
# This agent does NOT decide anything. It captures the Tally window on request and injects the
# keystrokes it is told to inject. The decisions are made by the MCP client (Claude), which sees
# each screenshot and chooses the next single step: look -> one step -> look again.
#
# It used to carry its own vision loop - screenshot, ask gpt-4o/Claude over HTTP for the next
# action, repeat - which meant a second, weaker model with its own API key was driving the GUI
# while the assistant session that requested the work sat idle. That loop is gone, and with it the
# ANTHROPIC_API_KEY / OPENAI_API_KEY requirement: this agent now needs no credentials at all.
#
# RUN: In the interactive desktop session where Tally is visible
#   powershell -ExecutionPolicy Bypass -File tally-gui-agent-v2.ps1
#
# In local (same-machine) deployments the MCP server already runs in that session and invokes this
# script directly with -Once, so there is no long-running agent and no file IPC.

param(
    [string]$WatchDir = $null,
    [switch]$NoSelfRestart,         # Disable self-watching auto-restart (for debugging)
    [switch]$ShowConsole,           # Keep the console window visible (debugging); hidden by default
    # One-shot mode: read a single command as JSON on stdin, execute it, print the result as JSON on
    # stdout, exit. Used when the MCP server already runs in the user's interactive session and can
    # invoke this script directly, so there is nothing to bridge and no file IPC. The command never
    # touches disk, which matters because select-and-unlock-company carries a decrypted password.
    [switch]$Once
)

# --- Hide our own console window --------------------------------------------------------------
# The agent MUST run in the interactive desktop session (it drives the Tally GUI and takes
# screenshots - a Session-0 service can't). But its console window is just noise a user can
# accidentally close, which kills GUI control until the crash-respawn heartbeat brings it back.
# Hide the window so it isn't visible or closeable; the tray dashboard shows the agent's real
# status (Running + PID). Runs first so the window is gone almost immediately. Pass -ShowConsole
# (or run the script by hand with it) to keep the console visible for debugging.
#
# The same small inline type also carries the idle / session probes (#24, #35): GetLastInputInfo,
# GetTickCount, OpenInputDesktop and the WTS session queries. They live here rather than in
# TallyUI.cs on purpose: deploy.ps1 updates this script by git pull and the agent self-restarts, but
# nothing recompiles TallyUI.dll on that path, so a method added there would be missing on every
# machine updated that way. One Add-Type compile covers both uses, so a one-shot run pays for a
# single compile as before. None of these calls inject input. If the compile fails, console hiding
# and the idle / session gating are skipped (fail open) - exactly the pre-1.9.0 behaviour.
$Script:NativeOk = $false
try {
    if (-not ('TallyMcpAgent.Native' -as [type])) {
        Add-Type -Language CSharp -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace TallyMcpAgent {
    public static class Native {
        [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [StructLayout(LayoutKind.Sequential)]
        private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
        [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
        [DllImport("kernel32.dll")] private static extern uint GetTickCount();
        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
        [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr hDesktop);
        [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "WTSQuerySessionInformationW", SetLastError = true)]
        private static extern bool WTSQuerySessionInformation(IntPtr hServer, int sessionId, int infoClass, out IntPtr ppBuffer, out uint pBytesReturned);
        [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr pMemory);
        [DllImport("kernel32.dll")] private static extern uint WTSGetActiveConsoleSessionId();

        public const int WTS_CURRENT_SESSION = -1;

        // Milliseconds since boot; wraps every ~49.7 days (callers use modular arithmetic).
        public static uint TickNow() { return GetTickCount(); }

        // GetTickCount value of the last keyboard/mouse input in this session (ours or a person's),
        // or -1 when the call fails.
        public static long LastInputTick() {
            LASTINPUTINFO li = new LASTINPUTINFO();
            li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            if (!GetLastInputInfo(ref li)) return -1;
            return (long)li.dwTime;
        }

        // False when the input desktop cannot be opened - the workstation is locked (Winlogon desktop),
        // a secure screen saver is up, or the session has no input desktop. Closes the handle it opens.
        public static bool InputDesktopAvailable() {
            IntPtr h = OpenInputDesktop(0, false, 0x0100); // DESKTOP_SWITCHDESKTOP
            if (h == IntPtr.Zero) return false;
            CloseDesktop(h);
            return true;
        }

        // WTS_CONNECTSTATE_CLASS of a session (0 = WTSActive, 4 = WTSDisconnected, ...), or -1 on failure.
        public static int ConnectState(int sessionId) {
            IntPtr buf = IntPtr.Zero;
            uint n = 0;
            if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, 8, out buf, out n)) return -1; // 8 = WTSConnectState
            try {
                if (buf == IntPtr.Zero || n < 4) return -1;
                return Marshal.ReadInt32(buf);
            } finally {
                if (buf != IntPtr.Zero) WTSFreeMemory(buf);
            }
        }

        // DOMAIN\user signed in to a session, "" when nobody is, or null when the query fails.
        public static string SessionUser(int sessionId) {
            string user = QueryString(sessionId, 5);   // WTSUserName
            if (user == null) return null;
            if (user.Length == 0) return "";
            string domain = QueryString(sessionId, 7); // WTSDomainName
            if (String.IsNullOrEmpty(domain)) return user;
            return domain + "\\" + user;
        }

        private static string QueryString(int sessionId, int infoClass) {
            IntPtr buf = IntPtr.Zero;
            uint n = 0;
            if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, infoClass, out buf, out n)) return null;
            try {
                if (buf == IntPtr.Zero) return null;
                return Marshal.PtrToStringUni(buf);
            } finally {
                if (buf != IntPtr.Zero) WTSFreeMemory(buf);
            }
        }

        // Session attached to the physical console; 0xFFFFFFFF while a switch is in progress.
        public static long ActiveConsoleSessionId() { return (long)WTSGetActiveConsoleSessionId(); }
    }
}
'@
    }
    $Script:NativeOk = $true
} catch { $Script:NativeOk = $false }

if ((-not $ShowConsole) -and $Script:NativeOk) {
    try {
        $__consoleWnd = [TallyMcpAgent.Native]::GetConsoleWindow()
        if ($__consoleWnd -ne [System.IntPtr]::Zero) {
            [void][TallyMcpAgent.Native]::ShowWindow($__consoleWnd, 0)  # 0 = SW_HIDE
        }
    } catch { }
}

# --- Agent version (bumped whenever the IPC contract or script behavior changes) ---
# The MCP server reads this from the ping response and refuses load-company calls
# against an agent older than its required minimum (issue #15 - version handshake).
# Format: MAJOR.MINOR.PATCH. Bump MINOR on any new IPC action or response field;
# bump PATCH on internal fixes that callers can ignore.
# 1.9.0: idle / session gating before every screen action (USER_ACTIVE, SESSION_LOCKED,
#        SESSION_DISCONNECTED, WRONG_USER result codes; userIdleSec / userIdleWaitSec command fields),
#        the idle-status and show-voucher actions, and no agent-side overlay (the tray draws the frame).
# 1.10.0: idle-status reports humanIdleMs (a person's idle time, which our own keystrokes no longer
#        hide), and the USER_ACTIVE gate counts a person's input recorded before our later keys;
#        show-voucher checks the screen before every Enter / F2 and reports screenChecks; tick files
#        are per session and ignored when written before the current boot.
$Script:AgentVersion = "1.10.0"

# --- Single-instance guard ---------------------------------------------------------------------
# Only ONE *watch-mode* agent may run. Multiple watchers race on the command/result files. A named
# session mutex enforces this across every watch-mode launch
# path (at-logon trigger, the 1-min crash-respawn heartbeat, Restart-Self on script change, manual
# starts, reinstalls). We wait a few seconds so a Restart-Self predecessor can exit and release the
# mutex before we give up; an abandoned mutex (predecessor exited without releasing) still counts as
# acquired.
#
# One-shot (-Once) runs are exempt, and must stay exempt. They are short-lived children of the MCP
# server that read one command from stdin, print one JSON result to stdout and exit - they never poll
# the IPC files, so they cannot race a watcher. Taking the mutex here
# broke in-session transport on exactly the machines that matter: any box with the companion agent
# installed holds this mutex for the agent's whole lifetime, so every one-shot child was refused with
# a plain-text line and exit 0 - which the caller cannot tell apart from a timeout.
if (-not $Once) {
    $Script:SingleInstanceMutex = New-Object System.Threading.Mutex($false, 'TallyMCPAgentSingleInstance')
    $haveMutex = $false
    try { $haveMutex = $Script:SingleInstanceMutex.WaitOne(4000) }
    catch [System.Threading.AbandonedMutexException] { $haveMutex = $true }
    if (-not $haveMutex) {
        Write-Host "Another Tally GUI agent is already running - exiting this duplicate instance."
        exit 0
    }
}

if (-not $WatchDir) {
    $WatchDir = if ($env:TALLY_DATA_PATH) { $env:TALLY_DATA_PATH } else { "C:\Users\Public\TallyPrimeEditLog\data" }
}

$CommandFile = Join-Path $WatchDir "_mcp_gui_command.json"
$ResultFile  = Join-Path $WatchDir "_mcp_gui_result.json"
# GetTickCount of the last keystroke this agent injected, shared by the watch-mode agent and every
# one-shot run (each one-shot is a fresh process, so memory alone would forget the previous step and
# read our own keystrokes as a person typing). Agent-private; see docs/dev/coordination.md section 4.
#
# Next to it, the tick of the last input that was a PERSON's, sampled just before every injection:
# GetLastInputInfo only keeps the newest input, so once we type, an earlier keystroke by a person is
# gone unless we wrote it down first. idle-status reports humanIdleMs from it (#25 restart gate).
#
# Both names carry the Windows session id. GetLastInputInfo is per session while this folder is
# machine-wide, so a stamp written by an agent in another session must never be read as ours.
$Script:AgentSessionId = -1
try { $Script:AgentSessionId = [int][System.Diagnostics.Process]::GetCurrentProcess().SessionId } catch { $Script:AgentSessionId = -1 }
$__tickSuffix = if ($Script:AgentSessionId -ge 0) { ".s$($Script:AgentSessionId)" } else { '' }
$Script:AgentInputTickFile = Join-Path $WatchDir "_mcp_agent_input_tick$__tickSuffix.txt"
$Script:HumanInputTickFile = Join-Path $WatchDir "_mcp_human_input_tick$__tickSuffix.txt"
$Script:LastAgentInputTick = $null
$Script:LastSavedHumanTick = $null

# --- Load precompiled Win32 interop DLL (avoids AMSI/Defender false positives from inline Add-Type) ---
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dllPath = Join-Path $scriptDir "TallyUI.dll"
if (-not (Test-Path $dllPath)) {
    Write-Host "[ERROR] TallyUI.dll not found at $dllPath"
    Write-Host "  Run: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:library /reference:System.Drawing.dll /out:scripts\TallyUI.dll scripts\TallyUI.cs"
    exit 1
}
Add-Type -Path $dllPath

# --- Which Tally? --------------------------------------------------------------------------------
# A machine can run several Tally instances at once (an old Prime kept open for a closed financial
# year alongside the current one). Only ONE of them owns the XML port, and that is the instance the
# MCP server reads every ledger and voucher from. So it is the only instance we may keystroke into.
#
# This used to be "Get-Process -Name tally | Select-Object -First 1" - whichever one Windows
# enumerated first. When that disagreed with the port owner, Claude read one company's books and
# typed into another company's window, with nothing anywhere reporting an error. That is the
# "erratic on multi-version machines" behaviour.
#
# When the instance cannot be identified we return nothing and say why. Guessing is worse than
# failing: these keystrokes land in whatever screen the wrong Tally happens to have open.
$Script:TallyResolveReason = ''

function Resolve-TallyProcess {
    $Script:TallyResolveReason = ''
    $port = if ($env:TALLY_PORT) { [int]$env:TALLY_PORT } else { 9000 }

    # 1. Who owns the XML port? That is the authoritative answer.
    $ownerPid = 0
    try {
        $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | Select-Object -First 1
        if ($conn) { $ownerPid = [int]$conn.OwningProcess }
    } catch {
        # Get-NetTCPConnection is missing on older hosts, and throws when nothing matches. Parse
        # netstat instead rather than falling straight through to the guess.
        try {
            foreach ($line in (netstat -ano -p TCP)) {
                if ($line -match '^\s*TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$') {
                    $localAddr = $Matches[1]
                    $foreign   = $Matches[2]
                    $linePid   = [int]$Matches[4]
                    $idx = $localAddr.LastIndexOf(':')
                    if ($idx -lt 0) { continue }
                    $localPort = $localAddr.Substring($idx + 1)
                    if ($localPort -notmatch '^\d+$') { continue }
                    if ([int]$localPort -ne $port) { continue }
                    if ($foreign -match ':0$') { $ownerPid = $linePid; break }
                }
            }
        } catch { }
    }

    if ($ownerPid -gt 0) {
        $owner = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
        if ($owner -and $owner.ProcessName -like 'tally*') { return $owner }
        if ($owner) {
            $Script:TallyResolveReason = "Port $port is held by $($owner.ProcessName) (pid $ownerPid), which is not Tally."
            return $null
        }
    }

    # 2. No port owner. Safe only when the answer is unambiguous.
    $all = @(Get-Process -Name 'tally' -ErrorAction SilentlyContinue)
    if ($all.Count -eq 1) { return $all[0] }
    if ($all.Count -eq 0) {
        $Script:TallyResolveReason = 'Tally is not running.'
        return $null
    }
    $pidList = ($all | ForEach-Object { $_.Id }) -join ', '
    $Script:TallyResolveReason = "$($all.Count) Tally instances are running (pids $pidList) and none is serving port $port, so there is no way to tell which one you mean. In the instance you want this to drive, press F1 > Settings > Connectivity > Client/Server Configuration and set 'TallyPrime acts as' = Server, Port = $port. Or close the instances you are not using."
    return $null
}

function Find-TallyWindow {
    $proc = Resolve-TallyProcess
    if ($null -eq $proc) { return [IntPtr]::Zero }
    if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { return $proc.MainWindowHandle }
    $Script:TallyResolveReason = "Tally (pid $($proc.Id)) is running but has no main window yet - it may still be starting, or be minimised to the tray."
    return [IntPtr]::Zero
}

# Message for a failed resolve. Never blank: a bare "Tally window not found" sent a user hunting a
# closed Tally when the real problem was two open ones.
function Get-TallyResolveMessage {
    if ($Script:TallyResolveReason) { return $Script:TallyResolveReason }
    return 'Tally window not found - is Tally running?'
}

function Get-Screenshot {
    param([IntPtr]$Hwnd)
    $screenshotPath = Join-Path $WatchDir "_mcp_screenshot.png"
    # The AI-activity frame is the tray's now: the server sets hideForScreenshot in its activity
    # record before asking for a capture, so nothing here has to hide anything.
    try {
        $bmp = [TallyUI2]::CaptureWindow($Hwnd)
        if ($null -eq $bmp) { return $null }
        $bmp.Save($screenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        return $screenshotPath
    } catch {
        Write-Host "  Screenshot error: $_"
        return $null
    }
}

# --- Our own injected input (#24) ----------------------------------------------------------------
# GetLastInputInfo cannot tell a person's keystroke from one we injected with keybd_event. So every
# injection goes through the Send-Agent* wrappers below, which stamp the tick right after the keys
# went out. Input that arrives more than $Script:AgentInputSlackMs after our stamp is a person's.
# Never call [TallyUI2]::PressKey / PressCombo / TypeString directly: an unstamped injection would
# read as a person typing and make the next screen action wait, then fail with USER_ACTIVE.
#
# The wrappers also record a person's input BEFORE injecting (Save-HumanInputTick): our keys are
# about to become the newest input and would hide it. Best effort - a key a person presses while one
# of our injections is in flight (milliseconds, or the length of a typed string) is still hidden.
$Script:AgentInputSlackMs = 150

# Tick files hold "<tick> <writeTick>": the tick itself (our keystroke, or a person's last input) and
# GetTickCount at the moment the file was written. 1.9.0 wrote the tick alone; that still reads, with
# the tick doubling as the write tick (it was written right after the stamp).
#
# PURE: is a tick file's write tick from THIS boot? GetTickCount restarts at every boot, so a file
# written before a restart holds a number on the old clock that can land anywhere on the new one -
# even a few seconds "ahead", which would read as brand new and turn the idle gate off. The file's
# own last-write time (wall clock) says how long ago it was written; on the same boot that agrees
# with the tick-count age to within file-time resolution and scheduling noise. A mismatch means
# another boot (or a tick so old the 49.7-day counter has wrapped): ignore the file. A wall-clock
# step (NTP correction) can also cause a mismatch; ignoring the file then is the safe direction.
function Test-TickFileFromThisBoot {
    param([int64]$WriteTick, [int64]$NowTick, [double]$WallAgeMs, [double]$ToleranceMs = 5000)
    $age = Get-TickElapsedMs -From $WriteTick -To $NowTick
    if (Test-TickJustAhead -AgeMs $age) { $age = 0 }
    return ([Math]::Abs($WallAgeMs - [double]$age) -le $ToleranceMs)
}

# PURE: parse tick-file text. Returns @{ Tick; WriteTick } or $null when it is not one or two
# unsigned 32-bit numbers, or the tick is after the write (impossible for a file we wrote).
function ConvertFrom-TickFileText {
    param([string]$Text)
    if ($null -eq $Text) { return $null }
    $parts = @($Text.Trim() -split '\s+' | Where-Object { $_ -ne '' })
    if ($parts.Count -lt 1 -or $parts.Count -gt 2) { return $null }
    $a = [uint32]0
    if (-not [uint32]::TryParse($parts[0], [ref]$a)) { return $null }
    $w = $a
    if ($parts.Count -eq 2) {
        if (-not [uint32]::TryParse($parts[1], [ref]$w)) { return $null }
    }
    # The tick was taken at or before the write, so from tick to write is a forward step.
    if ([int64]$a -ne [int64]$w) {
        if (Test-TickJustAhead -AgeMs (Get-TickElapsedMs -From ([int64]$a) -To ([int64]$w))) { return $null }
    }
    return @{ Tick = [int64]$a; WriteTick = [int64]$w }
}

# Tick from a tick file, or $null when the file is missing, unreadable, malformed or not from this
# boot (see Test-TickFileFromThisBoot).
function Read-TickFile {
    param([string]$Path)
    if (-not $Script:NativeOk) { return $null }
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        $written = [System.IO.File]::GetLastWriteTimeUtc($Path)
        $parsed = ConvertFrom-TickFileText -Text ([System.IO.File]::ReadAllText($Path))
        if ($null -eq $parsed) { return $null }
        $now = [int64][TallyMcpAgent.Native]::TickNow()
        $wallAgeMs = ([datetime]::UtcNow - $written).TotalMilliseconds
        if (-not (Test-TickFileFromThisBoot -WriteTick $parsed.WriteTick -NowTick $now -WallAgeMs $wallAgeMs)) { return $null }
        return $parsed.Tick
    } catch { return $null }
}

# Writes "<tick> <now>" through a temp file and a rename, so a reader in another one-shot process
# never sees a half-written number. If the rename fails (a reader holds the file open that instant,
# or the folder's file system cannot replace), it writes in place instead: a torn read only fails to
# parse, which reads as "no tick". Best effort: a lost write costs precision, never safety (an unknown
# agent tick makes our keys look like a person's; an unknown human tick reads as null).
function Write-TickFile {
    param([string]$Path, [int64]$Tick)
    $text = ''
    try {
        $text = "{0} {1}" -f $Tick, ([int64][TallyMcpAgent.Native]::TickNow())
    } catch { return }
    $tmp = "$Path.$PID.tmp"
    try {
        [System.IO.File]::WriteAllText($tmp, $text)
        if (Test-Path -LiteralPath $Path) {
            # NullString, not $null: PowerShell passes $null to a string parameter as "", which
            # File.Replace rejects as a backup path.
            [System.IO.File]::Replace($tmp, $Path, [System.Management.Automation.Language.NullString]::Value)
        } else {
            [System.IO.File]::Move($tmp, $Path)
        }
    } catch {
        try { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } catch { }
        try { [System.IO.File]::WriteAllText($Path, $text) } catch { }
    }
}

function Update-AgentInputTick {
    if (-not $Script:NativeOk) { return }
    try {
        $t = [int64][TallyMcpAgent.Native]::TickNow()
        $Script:LastAgentInputTick = $t
        Write-TickFile -Path $Script:AgentInputTickFile -Tick $t
    } catch { }
}

# Tick of the most recent injection by any agent process in this session: this process's memory or
# the shared file, whichever is newer. $null when neither is known. The file is trusted only when it
# was written in this boot (Read-TickFile). There is no age cut-off beyond that: an old stamp is still
# the right answer to "was the newest input ours?", and it cannot alias a newer input.
function Get-LastAgentInputTick {
    $best = $Script:LastAgentInputTick
    try {
        $fromFile = Read-TickFile -Path $Script:AgentInputTickFile
        if ($null -ne $fromFile) {
            if ($null -eq $best) {
                $best = $fromFile
            } elseif ($Script:NativeOk) {
                $now = [int64][TallyMcpAgent.Native]::TickNow()
                if ((Get-TickElapsedMs -From $fromFile -To $now) -lt (Get-TickElapsedMs -From ([int64]$best) -To $now)) {
                    $best = $fromFile
                }
            }
        }
    } catch { }
    return $best
}

# Tick of the last input known to be a PERSON's, from the shared file; $null when none is recorded.
# Read from disk every time rather than cached, so a watch-mode agent running for weeks never
# compares a tick from before a 49.7-day wrap (Read-TickFile rejects those).
function Get-LastHumanInputTick {
    return (Read-TickFile -Path $Script:HumanInputTickFile)
}

# Called just before every injection: if the newest input is a person's, write its tick down, since
# our keys are about to hide it from GetLastInputInfo.
function Save-HumanInputTick {
    if (-not $Script:NativeOk) { return }
    try {
        $last = [TallyMcpAgent.Native]::LastInputTick()   # read BEFORE now
        $now = [int64][TallyMcpAgent.Native]::TickNow()
        if ($last -lt 0) { return }
        $agentTick = Get-LastAgentInputTick
        # Any-age threshold: only asks "is the newest input a person's?"
        if (-not (Test-HumanInputRecent -LastInputTick $last -NowTick $now -LastAgentInputTick $agentTick -ThresholdMs 4294967296 -SlackMs $Script:AgentInputSlackMs)) { return }
        if ($null -ne $Script:LastSavedHumanTick -and [int64]$Script:LastSavedHumanTick -eq [int64]$last) { return }
        Write-TickFile -Path $Script:HumanInputTickFile -Tick ([int64]$last)
        $Script:LastSavedHumanTick = [int64]$last
    } catch { }
}

function Send-AgentKey {
    param([byte]$Vk)
    Save-HumanInputTick
    try { [TallyUI2]::PressKey($Vk) } finally { Update-AgentInputTick }
}

function Send-AgentCombo {
    param([byte]$Modifier, [byte]$Key)
    Save-HumanInputTick
    try { [TallyUI2]::PressCombo($Modifier, $Key) } finally { Update-AgentInputTick }
}

function Send-AgentText {
    param([string]$Text)
    Save-HumanInputTick
    try { [TallyUI2]::TypeString($Text) } finally { Update-AgentInputTick }
}

# --- Idle and session decisions (#24, #35) ---------------------------------------------------------

# Milliseconds from tick $From to tick $To on the 32-bit GetTickCount clock, which wraps every
# ~49.7 days. Modular, so a wrap between the two readings still gives the right small answer.
function Get-TickElapsedMs {
    param([int64]$From, [int64]$To)
    $d = ($To - $From) % 4294967296
    if ($d -lt 0) { $d += 4294967296 }
    return [int64]$d
}

# True when a modular age is really a tick slightly AHEAD of "now" (a read race: another process
# stamped between our two reads), not ~49 days. A real race is milliseconds, so the band is a few
# seconds. It used to be a minute, which let a tick file from before a reboot - whose old-clock value
# sat just ahead of the new clock - read as brand new.
function Test-TickJustAhead {
    param([int64]$AgeMs)
    return ($AgeMs -gt (4294967296 - 5000))
}

# PURE decision: was the NEWEST input a person's, and within the last $ThresholdMs?
#   LastInputTick      - GetLastInputInfo().dwTime (any input: ours or a person's)
#   NowTick            - GetTickCount(), read AFTER LastInputTick
#   LastAgentInputTick - tick stamped right after our own last injection, or $null if none known
# Input no more than $SlackMs newer than our own last injection is ours. All tick math is modular.
# Looks at the newest input only; Get-IdleFigures adds the person's input recorded behind ours.
function Test-HumanInputRecent {
    param(
        [int64]$LastInputTick,
        [int64]$NowTick,
        $LastAgentInputTick = $null,
        [int64]$ThresholdMs,
        [int64]$SlackMs = 150
    )
    $inputAge = Get-TickElapsedMs -From $LastInputTick -To $NowTick
    # A tick slightly "in the future" (another process stamped it between our reads) is brand new,
    # not 49 days old.
    if (Test-TickJustAhead -AgeMs $inputAge) { $inputAge = 0 }
    if ($inputAge -gt $ThresholdMs) { return $false }
    if ($null -eq $LastAgentInputTick) { return $true }
    $agentAge = Get-TickElapsedMs -From ([int64]$LastAgentInputTick) -To $NowTick
    if (Test-TickJustAhead -AgeMs $agentAge) { $agentAge = 0 }
    # The last input is at most $SlackMs newer than our last injection: it was us.
    if (($inputAge + $SlackMs) -ge $agentAge) { return $false }
    return $true
}

# PURE: the idle figures idle-status reports and the screen gate decides on, from one set of reads.
#   IdleMs            - since the newest input of any kind (ours or a person's)
#   LastInputWasAgent - that newest input was our own injected keystroke
#   HumanIdleMs       - since the newest input that was a PERSON's: IdleMs when the newest input is
#                       theirs; else the age of the recorded human tick ($LastHumanInputTick, saved
#                       before each injection); $null when the newest input is ours and no person's
#                       input is on record. $null means unknown - not "idle for ever", not "just now".
#                       Never the age of our own stamp: that is seconds old and says nothing about
#                       the person.
function Get-IdleFigures {
    param(
        [int64]$LastInputTick,
        [int64]$NowTick,
        $LastAgentInputTick = $null,
        $LastHumanInputTick = $null,
        [int64]$SlackMs = 150
    )
    $idleMs = Get-TickElapsedMs -From $LastInputTick -To $NowTick
    if (Test-TickJustAhead -AgeMs $idleMs) { $idleMs = 0 }
    $wasAgent = -not (Test-HumanInputRecent -LastInputTick $LastInputTick -NowTick $NowTick -LastAgentInputTick $LastAgentInputTick -ThresholdMs 4294967296 -SlackMs $SlackMs)
    $humanIdleMs = $null
    if (-not $wasAgent) {
        $humanIdleMs = $idleMs
    } elseif ($null -ne $LastHumanInputTick) {
        $h = Get-TickElapsedMs -From ([int64]$LastHumanInputTick) -To $NowTick
        if (Test-TickJustAhead -AgeMs $h) { $h = 0 }
        # A person's input cannot be newer than the newest input of any kind.
        if ($h -lt $idleMs) { $h = $idleMs }
        $humanIdleMs = [int64]$h
    }
    return @{ IdleMs = [int64]$idleMs; LastInputWasAgent = [bool]$wasAgent; HumanIdleMs = $humanIdleMs }
}

# PURE: would a screen action be refused as USER_ACTIVE? A person's input within the threshold.
# Unknown human idle time (HumanIdleMs $null: the newest input is ours and nothing older is on record)
# does not block - the per-action gate has always treated our own keystrokes that way.
function Test-UserActive {
    param($Figures, [int64]$ThresholdMs)
    if ($ThresholdMs -le 0) { return $false }
    if ($null -eq $Figures -or $null -eq $Figures.HumanIdleMs) { return $false }
    return ([int64]$Figures.HumanIdleMs -le $ThresholdMs)
}

# Reads the input ticks and returns Get-IdleFigures for right now, or $null when the probes are
# unavailable (the inline type failed to compile, or GetLastInputInfo failed).
function Get-CurrentIdleFigures {
    if (-not $Script:NativeOk) { return $null }
    $last = [TallyMcpAgent.Native]::LastInputTick()   # read BEFORE now
    $now = [int64][TallyMcpAgent.Native]::TickNow()
    if ($last -lt 0) { return $null }
    return (Get-IdleFigures -LastInputTick $last -NowTick $now -LastAgentInputTick (Get-LastAgentInputTick) -LastHumanInputTick (Get-LastHumanInputTick) -SlackMs $Script:AgentInputSlackMs)
}

# Windows session state for the session this agent runs in:
#   @{ state = 'active'|'locked'|'disconnected'|'wrong-user'; user = 'DOMAIN\name'; sessionId = n }
# wrong-user adds consoleUser. Returns quickly. Every probe is best-effort: if detection itself fails
# the state stays 'active' - a broken probe must never block screen control.
function Get-SessionState {
    $user = "$env:USERDOMAIN\$env:USERNAME"
    try { $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name } catch { }
    $sessionId = -1
    try { $sessionId = [int][System.Diagnostics.Process]::GetCurrentProcess().SessionId } catch { }
    $result = @{ state = 'active'; user = $user; sessionId = $sessionId }
    if (-not $Script:NativeOk) { return $result }

    # 1. Disconnected (or another user at the console). Checked first: a disconnected session has no
    #    input desktop either, so the lock probe below would misreport it as locked.
    try {
        $connectState = [TallyMcpAgent.Native]::ConnectState([TallyMcpAgent.Native]::WTS_CURRENT_SESSION)
        if ($connectState -ge 0 -and $connectState -ne 0) {   # 0 = WTSActive
            $result.state = 'disconnected'
            # Someone else has the physical console and we are not in an active remote session either.
            try {
                $consoleId = [int64][TallyMcpAgent.Native]::ActiveConsoleSessionId()
                if ($consoleId -ne 4294967295 -and $sessionId -ge 0 -and $consoleId -ne [int64]$sessionId) {
                    $consoleUser = [TallyMcpAgent.Native]::SessionUser([int]$consoleId)
                    # "" = the console is at the sign-in screen with nobody signed in: just sign back in.
                    if ($null -eq $consoleUser -or ($consoleUser -ne '' -and $consoleUser -ne $user)) {
                        $result.state = 'wrong-user'
                        if ($consoleUser) { $result.consoleUser = $consoleUser }
                    }
                }
            } catch { }
            return $result
        }
    } catch { }

    # 2. Locked: no input desktop, or LogonUI owns the foreground.
    try {
        if (-not [TallyMcpAgent.Native]::InputDesktopAvailable()) {
            $result.state = 'locked'
            return $result
        }
    } catch { }
    try {
        $fg = [TallyUI2]::GetForegroundWindow()
        if ($fg -ne [IntPtr]::Zero) {
            $fgPid = [uint32]0
            [void][TallyUI2]::GetWindowThreadProcessId($fg, [ref]$fgPid)
            if ($fgPid -gt 0) {
                $fgProc = Get-Process -Id ([int]$fgPid) -ErrorAction SilentlyContinue
                if ($fgProc -and $fgProc.ProcessName -eq 'LogonUI') { $result.state = 'locked' }
            }
        }
    } catch { }
    return $result
}

# Seconds as a number from a command field, else the default. 0 is a real value, not "missing".
function Get-CommandSeconds {
    param($Cmd, [string]$Name, [double]$Default, [double]$Max)
    $v = $null
    try { if ($null -ne $Cmd) { $v = $Cmd.$Name } } catch { $v = $null }
    $n = $Default
    if ($null -ne $v -and [string]$v -ne '') {
        try { $n = [double]$v } catch { $n = $Default }
    }
    if ($n -lt 0) { $n = 0 }
    if ($n -gt $Max) { $n = $Max }
    return $n
}

function Get-UserIdleSettings {
    param($Cmd)
    $envDefault = 5.0
    if ($env:GUI_USER_IDLE_SEC) {
        try { $envDefault = [double]$env:GUI_USER_IDLE_SEC } catch { $envDefault = 5.0 }
    }
    $idleSec = Get-CommandSeconds -Cmd $Cmd -Name 'userIdleSec' -Default $envDefault -Max 600
    $waitSec = Get-CommandSeconds -Cmd $Cmd -Name 'userIdleWaitSec' -Default 10 -Max 120
    return @{ ThresholdMs = [int64]($idleSec * 1000); WaitMs = [int64]($waitSec * 1000) }
}

$Script:UserActiveMessage = 'Someone is using the keyboard or mouse on the Tally PC. Ask them to stop for a moment, then try again.'

# Why the screen must not be driven right now, or $null if it may be. A blocker is
#   @{ errorCode = ...; message = ...; extra = @{ ... } }
# The session check is immediate. The idle check waits up to userIdleWaitSec for the person to stop
# (polling every 250 ms) unless -NoWait, which is for re-checks between the steps of a sequence:
# there, any input newer than our own last keystroke means a person has started using the PC.
# userIdleSec = 0 turns the idle check off.
function Get-ScreenBlocker {
    param($Cmd, [switch]$NoWait)

    $session = Get-SessionState
    switch ($session.state) {
        'locked' {
            return @{ errorCode = 'SESSION_LOCKED'; message = 'The Tally PC is locked, so the screen was not touched. Unlock the Tally PC, then try again.'; extra = @{ session = $session } }
        }
        'disconnected' {
            return @{ errorCode = 'SESSION_DISCONNECTED'; message = "The Windows session on the Tally PC is disconnected, so the screen was not touched. Sign back in to the Tally PC as $($session.user) (reconnect the remote desktop session), then try again."; extra = @{ session = $session } }
        }
        'wrong-user' {
            $who = if ($session.consoleUser) { "Windows user $($session.consoleUser)" } else { 'a different Windows user' }
            return @{ errorCode = 'WRONG_USER'; message = "The Tally PC is being used by $who, so the screen was not touched. Sign in to Windows on the Tally PC as $($session.user), then try again."; extra = @{ session = $session } }
        }
    }

    if (-not $Script:NativeOk) { return $null }
    $settings = Get-UserIdleSettings -Cmd $Cmd
    if ($settings.ThresholdMs -le 0) { return $null }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $figures = $null
        try { $figures = Get-CurrentIdleFigures } catch { return $null }
        if ($null -eq $figures) { return $null }

        # Same decision idle-status reports as userActive: a person's input (the newest input, or one
        # recorded before our own later keystrokes hid it) within the threshold.
        if (-not (Test-UserActive -Figures $figures -ThresholdMs $settings.ThresholdMs)) { return $null }

        if ($NoWait -or $sw.ElapsedMilliseconds -ge $settings.WaitMs) {
            # idleMs here is the PERSON's idle time - the figure that made us refuse.
            return @{ errorCode = 'USER_ACTIVE'; message = $Script:UserActiveMessage; extra = @{ idleMs = [int64]$figures.HumanIdleMs } }
        }
        Start-Sleep -Milliseconds 250
    }
}

function Write-ScreenBlockedResult {
    param($Blocker, [string]$CmdId, [string]$Strategy, [int]$StepsDone = -1, [int]$StepsTotal = -1)
    $extra = @{ errorCode = $Blocker.errorCode; retryable = $true }
    foreach ($k in $Blocker.extra.Keys) { $extra[$k] = $Blocker.extra[$k] }
    $msg = $Blocker.message
    if ($StepsDone -ge 0) {
        $extra.stepsDone = $StepsDone
        $of = if ($StepsTotal -ge 0) { " of $StepsTotal" } else { '' }
        $stopped = "Stopped after $StepsDone$of step(s); the rest were not sent."
        if ($Blocker.errorCode -eq 'USER_ACTIVE') {
            $msg = "Someone is using the keyboard or mouse on the Tally PC. $stopped Ask them to stop for a moment, then try again."
        } else {
            $msg = "$stopped $msg"
        }
    }
    Write-Result -Status "error" -Message $msg -Strategy $Strategy -CommandId $CmdId -Extra $extra
}

# Gate for every screen-driving action. Returns $true when it is safe to act. Otherwise writes the
# error result itself (nothing has been sent) and returns $false, so callers just skip their work.
function Assert-ScreenAvailable {
    param($Cmd, [string]$CmdId, [string]$Strategy)
    $blocker = $null
    try { $blocker = Get-ScreenBlocker -Cmd $Cmd } catch { $blocker = $null }
    if ($null -eq $blocker) { return $true }
    Write-ScreenBlockedResult -Blocker $blocker -CmdId $CmdId -Strategy $Strategy
    return $false
}

# Re-check between the steps of a multi-step sequence, without waiting. Same contract as
# Assert-ScreenAvailable; the error message says how many steps already ran.
function Assert-ScreenStillAvailable {
    param($Cmd, [string]$CmdId, [string]$Strategy, [int]$StepsDone, [int]$StepsTotal = -1)
    $blocker = $null
    try { $blocker = Get-ScreenBlocker -Cmd $Cmd -NoWait } catch { $blocker = $null }
    if ($null -eq $blocker) { return $true }
    Write-ScreenBlockedResult -Blocker $blocker -CmdId $CmdId -Strategy $Strategy -StepsDone $StepsDone -StepsTotal $StepsTotal
    return $false
}

function Execute-Action {
    param($Action)

    switch ($Action.action) {
        "key" {
            $keyMap = @{
                "enter" = [TallyUI2]::VK_RETURN; "escape" = [TallyUI2]::VK_ESCAPE
                "tab" = [TallyUI2]::VK_TAB; "backspace" = [TallyUI2]::VK_BACK
                "up" = [TallyUI2]::VK_UP; "down" = [TallyUI2]::VK_DOWN
                "left" = [TallyUI2]::VK_LEFT; "right" = [TallyUI2]::VK_RIGHT
                "f1" = [TallyUI2]::VK_F1; "f2" = [TallyUI2]::VK_F2
                "f3" = [TallyUI2]::VK_F3; "f4" = [TallyUI2]::VK_F4
                "f5" = [TallyUI2]::VK_F5; "f10" = [TallyUI2]::VK_F10
                "f12" = [TallyUI2]::VK_F12
            }
            # Letters a-z (VK 0x41..0x5A) and digits 0-9 (VK 0x30..0x39) as single key
            # presses - needed for Tally menu hotkeys (e.g. "k" = Day Book) and Yes/No
            # confirmations ("y"/"n"), which the clipboard-paste "type" action cannot fire.
            foreach ($c in 97..122) { $keyMap["$([char]$c)"] = $c - 32 }
            foreach ($d in 48..57)  { $keyMap["$([char]$d)"] = $d }
            $vk = $keyMap[$Action.value.ToLower()]
            if ($vk) {
                Write-Host "  Action: Press $($Action.value)"
                Send-AgentKey -Vk $vk
            } else {
                Write-Host "  Action: (unmapped key '$($Action.value)' - ignored)"
            }
        }
        "combo" {
            $parts = $Action.value.ToLower() -split '\+'
            $modMap = @{ "alt" = [TallyUI2]::VK_MENU; "ctrl" = [TallyUI2]::VK_CONTROL; "shift" = [TallyUI2]::VK_SHIFT }
            $keyMap = @{
                "f1" = [TallyUI2]::VK_F1; "f2" = [TallyUI2]::VK_F2; "f3" = [TallyUI2]::VK_F3
                "f4" = [TallyUI2]::VK_F4; "f5" = [TallyUI2]::VK_F5; "f10" = [TallyUI2]::VK_F10
            }
            # All letters a-z (VK 0x41..0x5A) and digits 0-9 so any modifier chord works -
            # notably Alt+D (delete voucher), Alt+X (cancel voucher), Alt+2 (delete line),
            # Alt+R, Ctrl+Enter, etc. Previously only a/c/v/x were mapped, so Alt+D was
            # silently dropped ("unmapped combo ... ignored").
            foreach ($c in 97..122) { $keyMap["$([char]$c)"] = $c - 32 }
            foreach ($d in 48..57)  { $keyMap["$([char]$d)"] = $d }
            if ($parts.Count -ge 2) {
                $mod = $modMap[$parts[0]]
                $key = $keyMap[$parts[1]]
                if ($mod -and $key) {
                    Write-Host "  Action: Combo $($Action.value)"
                    Send-AgentCombo -Modifier $mod -Key $key
                } else {
                    Write-Host "  Action: (unmapped combo '$($Action.value)' - ignored)"
                }
            }
        }
        "type" {
            # Log the length only, NEVER the text itself - a caller (gui-send-keys) may
            # route a password through here, and Write-Host lands in the agent's console/transcript.
            Write-Host "  Action: Type ($($Action.value.Length) chars)"
            # PREFER clipboard paste: char-by-char keybd_event double-registers/drops on Tally's UI
            # ("JJINAA CODE..."), which is unacceptable for masked fields (a mistyped password = lockout).
            # Paste sets the field atomically. Fall back to (scan-code) char typing only if the clipboard
            # is unavailable. NOTE: a few Tally fields (e.g. TallyVault) may block paste - the caller must
            # screenshot-verify the field after a masked entry.
            $text = $Action.value
            $pasted = $false
            try { Set-Clipboard -Value $text -ErrorAction Stop; $pasted = $true } catch {
                try { $text | clip.exe; if ($LASTEXITCODE -eq 0) { $pasted = $true } } catch {}
            }
            if ($pasted) {
                Start-Sleep -Milliseconds 120
                Send-AgentCombo -Modifier ([TallyUI2]::VK_CONTROL) -Key ([byte]0x56)  # Ctrl+V
            } else {
                Write-Host "  (clipboard unavailable - falling back to char typing)"
                Send-AgentText -Text $text
            }
        }
        "wait" {
            $ms = [int]$Action.value
            if ($ms -lt 100) { $ms = 1000 }
            if ($ms -gt 10000) { $ms = 10000 }
            Write-Host "  Action: Wait ${ms}ms"
            Start-Sleep -Milliseconds $ms
        }
    }
    Start-Sleep -Milliseconds 500  # Brief pause after every action
}

function Write-Result {
    param(
        [string]$Status,
        [string]$Message,
        [string]$Strategy,
        [string]$CommandId = "",
        [hashtable]$Extra = $null
    )
    $payload = [ordered]@{
        status       = $Status
        message      = $Message
        strategy     = $Strategy
        commandId    = $CommandId
        timestamp    = (Get-Date -Format "o")
        agentVersion = $Script:AgentVersion
    }
    if ($Extra) {
        foreach ($k in $Extra.Keys) { $payload[$k] = $Extra[$k] }
    }
    $result = $payload | ConvertTo-Json -Depth 3 -Compress
    if ($Once) {
        # One-shot: the caller reads our stdout. Emitted on a single line so the parent can pick the
        # result out of any surrounding PowerShell host chatter.
        [Console]::Out.WriteLine($result)
        [Console]::Out.Flush()
        return
    }
    # Write UTF-8 WITHOUT BOM. .NET's [Encoding]::UTF8 prepends a BOM, which breaks Node's JSON.parse on the read side.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ResultFile, $result, $utf8NoBom)
    Write-Host "[$Status] $Message (commandId: $CommandId)"
}

# --- Ground-truth load verification -----------------------------------------------------------------
# The keystroke-driven load flows (deterministic select-and-unlock, and assistant-driven sendkeys) are
# open-loop: they blast keys and used to report success without ever confirming Tally accepted them.
# A wrong/rejected password, an unfocused list, or a premature "looks done" would still be reported as
# success. These helpers close the loop by asking Tally itself what is loaded.

# Query Tally's in-process XML server for the companies currently loaded in memory. Mirrors the probe
# the status tray uses (scripts/tray/tally-mcp-tray.ps1 ~L238-251): same "List of Companies" Export
# envelope and same <NAME>...</NAME> regex, so both components agree on what "loaded" means.
# Returns @{ Queried = <bool>; Companies = @(names) }:
#   Queried = $false -> the query itself failed/timed out (Tally not answering on :9000); ground truth
#                       is UNKNOWN and callers must NOT treat that as either success or a load failure.
#   Queried = $true  -> Companies holds the loaded company names (empty array = nothing loaded).
function Get-LoadedCompanyNames {
    $body = '<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER></ENVELOPE>'
    try {
        $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:9000/' -Method POST -Body $body -ContentType 'text/xml; charset=utf-8' -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        $names = @()
        foreach ($m in [regex]::Matches([string]$resp.Content, '<NAME>([^<]+)</NAME>', 'IgnoreCase')) {
            $n = $m.Groups[1].Value.Trim()
            if ($n) { $names += $n }
        }
        return @{ Queried = $true; Companies = $names }
    } catch {
        return @{ Queried = $false; Companies = @() }
    }
}

# Verify a company actually loaded, THEN write the appropriate result - never report a blind success.
# $Requested is the caller's identifier for the target: a folder id (select-and-unlock) or a company
# name. Matching is deliberately loose because a folder id rarely equals the display name.
# Never echoes credentials - messages only ever contain the requested id and the loaded company names.
function Write-VerifiedLoadResult {
    param(
        [string]$Requested,
        [string]$Strategy,
        [string]$CommandId = "",
        [string]$Context = ""     # short, non-secret suffix e.g. " with credentials"
    )

    $probe     = Get-LoadedCompanyNames
    $loaded     = @($probe.Companies)
    $loadedStr  = if ($loaded.Count) { $loaded -join ', ' } else { '(none)' }
    $extra      = @{ verified = $false; loadedCompanies = $loaded }

    if (-not $probe.Queried) {
        # The verification query itself failed - Tally's XML server on 127.0.0.1:9000 did not answer.
        # We genuinely cannot confirm the outcome; distinct 'unverified' status so this is not read as
        # a confirmed success (downstream treats any non-'success' as a load failure - fails closed).
        Write-Result -Status "unverified" -Message "Keystrokes sent for '$Requested'$Context, but could not verify: Tally XML server (127.0.0.1:9000) did not respond. Company may or may not be loaded." -Strategy $Strategy -CommandId $CommandId -Extra $extra
        return
    }

    if ($loaded.Count -eq 0) {
        # Ground truth: nothing is loaded. The keystrokes did not take - wrong credentials, a dialog
        # that never accepted input, or the wrong screen. Report an actionable error, NOT success.
        Write-Result -Status "error" -Message "Keystrokes sent but no company appears loaded - credentials may be wrong or the dialog did not accept input (requested '$Requested')." -Strategy $Strategy -CommandId $CommandId -Extra $extra
        return
    }

    # Loose match: the requested id/name may be a substring of a loaded display name (or vice versa).
    $matched = $false
    if ($Requested) {
        foreach ($c in $loaded) {
            if ($c -and ($c -eq $Requested -or $c -like "*$Requested*" -or $Requested -like "*$c*")) { $matched = $true; break }
        }
    }

    if ($matched) {
        $extra.verified = $true
        Write-Result -Status "success" -Message "Company '$Requested' loaded and verified$Context (loaded: $loadedStr)." -Strategy $Strategy -CommandId $CommandId -Extra $extra
        return
    }

    if ($loaded.Count -eq 1) {
        # Exactly one company loaded but its name doesn't obviously match the requested id (a folder id
        # is rarely the display name). Right after our own keystrokes the single loaded company is very
        # likely the one we opened - accept as success but name what actually loaded for sanity-checking.
        $extra.verified = $true
        Write-Result -Status "success" -Message "Company loaded and verified$Context (requested '$Requested', loaded '$($loaded[0])')." -Strategy $Strategy -CommandId $CommandId -Extra $extra
        return
    }

    # Several companies loaded and none matched the request - cannot tell which one the caller wanted.
    # Do NOT report plain success on a possible mismatch; flag unverified so downstream fails closed.
    Write-Result -Status "unverified" -Message "Keystrokes sent for '$Requested'$Context; $($loaded.Count) companies loaded ($loadedStr) but none matched the request - cannot confirm the correct company loaded." -Strategy $Strategy -CommandId $CommandId -Extra $extra
}

# Self-update detection: tracks the script's mtime at startup. If the file changes on disk
# (e.g. a deploy.ps1 git pull replaced it), Test-ScriptUpdated returns true and the main
# loop calls Restart-Self before the next command. Combined with Task Scheduler at-logon,
# this is the agent-update story from issue #15.
$Script:AgentScriptPath  = $PSCommandPath
$Script:AgentScriptMTime = if (Test-Path -LiteralPath $Script:AgentScriptPath) {
    (Get-Item -LiteralPath $Script:AgentScriptPath).LastWriteTimeUtc
} else { $null }

function Test-ScriptUpdated {
    if ($NoSelfRestart) { return $false }
    if (-not $Script:AgentScriptPath) { return $false }
    if (-not (Test-Path -LiteralPath $Script:AgentScriptPath)) { return $false }
    $current = (Get-Item -LiteralPath $Script:AgentScriptPath).LastWriteTimeUtc
    if (-not $Script:AgentScriptMTime) { return $false }
    return ($current -ne $Script:AgentScriptMTime)
}

function Restart-Self {
    Write-Host "[self-restart] script changed on disk; re-launching new version..."
    # Re-launch under the same powershell host with the same arguments. We pass -NoSelfRestart NOT,
    # so the new process picks up its own mtime and watches from there.
    $argList = @('-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', $Script:AgentScriptPath)
    if ($WatchDir)    { $argList += @('-WatchDir',    $WatchDir) }
    try {
        Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Normal | Out-Null
    } catch {
        Write-Host "[self-restart] Start-Process failed: $_  (this instance will keep running)"
        return
    }
    exit 0
}

# --- Main watch loop ---
# The startup banner is for the watch-mode console. In one-shot mode the caller parses our stdout,
# so keep it quiet.
if (-not $Once) {
    Write-Host "=== MCP Tally GUI Agent v2 (eyes and hands; the AI assistant decides) ==="
    Write-Host "Version:  $Script:AgentVersion"
    Write-Host "Watching: $CommandFile"
    Write-Host "Results:  $ResultFile"
    Write-Host "Self-restart on script change: $(-not $NoSelfRestart)"
    Write-Host "Agent started. Polling every 500ms for commands..."
}

# --- show-voucher helpers (#23) ------------------------------------------------------------------
# After a posting the server may ask the agent to put the posted voucher on screen so the person at
# the PC sees what the AI did. It is meant as a display only, and the server treats ANY failure
# (including USER_ACTIVE) as "skip silently".
#
# The sequence opens a read-only report:
#   Alt+G (Go To) -> paste "Day Book" -> Enter          opens the Day Book (a display-only report)
#   F2 (Date)     -> paste DD-MM-YYYY -> Enter          moves it to the voucher's date (only when a date is given)
#
# The danger is not the report, it is what the keys do when Tally is NOT where we think. TallyPrime
# draws its Yes/No prompts ("Accept?" at the end of a voucher, "Quit?" at the Gateway) inside its own
# window, so no window check can see them, and Enter is their default answer: Yes. A person who
# keyed a voucher, reached "Accept?" and stepped away (or switched to the chat window - we bring
# Tally forward ourselves) would have that voucher saved by our first Enter, or Tally closed with its
# XML port. Neither the idle gate nor the foreground check can catch that.
#
# So no Enter or F2 is ever sent on an unconfirmed screen. Before each checked step we take a steady
# sample of Tally's window; after it we wait for the window to change the way that step should
# change it (Alt+G opens the Go To box; the paste filters its list; Enter replaces the screen with
# the Day Book; F2 opens the date box). If it does not, we stop and send nothing more. An open
# Yes/No prompt ignores Alt+G, so the window stays the same and the sequence ends there, harmlessly,
# before any Enter. The checks are coarse (a sampled grid, not screen reading): they are a fail-closed
# guard, not proof that the right box opened. The thresholds below are first estimates - the result
# reports what each check measured (screenChecks) so they can be tuned on a real PC.
#
# Also deliberately NOT used: Escape (at the Gateway it raises "Quit?"), typed characters (a Yes/No
# prompt would take the 'y' in "Day" as Yes - text is pasted with Ctrl+V instead, and if the
# clipboard is unavailable we stop rather than fall back to typing), and re-grabbing focus
# mid-sequence (if something else took the foreground, the next key would land there - we stop).
# The date paste and the Enter after it are not checked: the date box was confirmed open by the F2
# check, a date edit is too small for the grid to see, and Enter there only sets the report's date.
#
# VERIFY ON EVERY SUPPORTED TallyPrime RELEASE before relying on this: the hotkeys are
# version-dependent and could not be exercised where this was written. In TallyPrime, Go To from a
# voucher-entry screen opens the report on top of the entry without saving or discarding it; older
# releases (Tally.ERP 9) have no Alt+G Go To (the Alt+G check then stops the sequence).
# dryKeys = true returns this plan without sending anything.

# Screen-check tuning. Fractions are of the sampled grid points whose colour changed by more than
# ChannelTolerance in any channel. The margins keep out Tally's title bar and the tray's breathing
# AI-activity frame and banner, which sit on the window's edges when it is maximised.
$Script:ShowCheck = @{
    GridCols         = 80
    GridRows         = 50
    MarginTop        = 48      # px: title bar + the tray's 26 px banner and 6 px frame
    MarginSide       = 16      # px: the tray frame on the other edges
    ChannelTolerance = 24
    SteadyMax        = 0.002   # two samples 200 ms apart differ at most this much (a caret blink)
    ChangeTimeoutMs  = 2500    # how long to wait for a step's change to appear
    # Minimum change per kind of check (see the plan).
    Min = @{
        'box'       = 0.01     # the Go To box opens over the screen
        'text'      = 0.004    # pasted text filters the Go To list
        'screen'    = 0.05     # the Day Book replaces the screen
        'small-box' = 0.004    # the small date box opens
    }
}

# PURE: the planned steps. Each is @{ action = 'combo'|'paste'|'key'; value; label; waitMs; check;
# expect }. check is '' (no screen check) or a key of $Script:ShowCheck.Min; expect names what the
# step should open, for messages.
function Get-ShowVoucherPlan {
    param([string]$TallyDate = '')   # DD-MM-YYYY, or '' to stay on the Day Book's own date
    $plan = @(
        @{ action = 'combo'; value = 'alt+g';    label = 'Alt+G';               waitMs = 700;  check = 'box';    expect = 'the Go To box' },
        @{ action = 'paste'; value = 'Day Book'; label = 'pasting "Day Book"';  waitMs = 500;  check = 'text';   expect = 'the Day Book entry in the Go To box' },
        @{ action = 'key';   value = 'enter';    label = 'Enter';               waitMs = 1500; check = 'screen'; expect = 'the Day Book' }
    )
    if ($TallyDate) {
        $plan += @{ action = 'key';   value = 'f2';       label = 'F2';             waitMs = 700;  check = 'small-box'; expect = 'the date box' }
        $plan += @{ action = 'paste'; value = $TallyDate; label = 'pasting the date'; waitMs = 400;  check = '';          expect = '' }
        $plan += @{ action = 'key';   value = 'enter';    label = 'Enter';          waitMs = 1200; check = '';          expect = '' }
    }
    return $plan
}

# PURE: sample a bitmap on a fixed grid inside the margins. Returns @{ Width; Height; Pixels = int[] }
# (ARGB per grid point), or $null when the window is too small to sample.
function Get-BitmapSample {
    param($Bitmap)
    $c = $Script:ShowCheck
    $w = [int]$Bitmap.Width
    $h = [int]$Bitmap.Height
    $x0 = [int]$c.MarginSide
    $x1 = $w - [int]$c.MarginSide
    $y0 = [int]$c.MarginTop
    $y1 = $h - [int]$c.MarginSide
    $cols = [int]$c.GridCols
    $rows = [int]$c.GridRows
    if (($x1 - $x0) -lt $cols -or ($y1 - $y0) -lt $rows) { return $null }
    $px = New-Object 'int[]' ($cols * $rows)
    $i = 0
    for ($r = 0; $r -lt $rows; $r++) {
        $y = $y0 + [int][Math]::Floor(($y1 - $y0) * ($r + 0.5) / $rows)
        for ($k = 0; $k -lt $cols; $k++) {
            $x = $x0 + [int][Math]::Floor(($x1 - $x0) * ($k + 0.5) / $cols)
            $px[$i] = $Bitmap.GetPixel($x, $y).ToArgb()
            $i++
        }
    }
    return @{ Width = $w; Height = $h; Pixels = $px }
}

# Sample of Tally's window as it is on screen right now, or $null when it cannot be captured.
function Get-TallyScreenSample {
    param([IntPtr]$Hwnd)
    $bmp = $null
    try {
        $bmp = [TallyUI2]::CaptureWindow($Hwnd)
        if ($null -eq $bmp) { return $null }
        return (Get-BitmapSample -Bitmap $bmp)
    } catch {
        return $null
    } finally {
        if ($null -ne $bmp) { $bmp.Dispose() }
    }
}

# PURE: fraction (0..1) of grid points whose colour changed by more than $Tolerance in any channel,
# or -1 when the two samples cannot be compared (missing, or the window changed size). Callers treat
# -1 as "not confirmed" - a resize is not evidence that the expected box opened.
function Get-ScreenChangeFraction {
    param($Before, $After, [int]$Tolerance = 24)
    if ($null -eq $Before -or $null -eq $After) { return -1.0 }
    if ($Before.Width -ne $After.Width -or $Before.Height -ne $After.Height) { return -1.0 }
    $a = $Before.Pixels
    $b = $After.Pixels
    if ($null -eq $a -or $null -eq $b -or $a.Length -ne $b.Length -or $a.Length -eq 0) { return -1.0 }
    $changed = 0
    for ($i = 0; $i -lt $a.Length; $i++) {
        $p = [int]$a[$i]
        $q = [int]$b[$i]
        if ($p -eq $q) { continue }
        $dr = [Math]::Abs((($p -shr 16) -band 255) - (($q -shr 16) -band 255))
        $dg = [Math]::Abs((($p -shr 8) -band 255) - (($q -shr 8) -band 255))
        $db = [Math]::Abs(($p -band 255) - ($q -band 255))
        if ($dr -gt $Tolerance -or $dg -gt $Tolerance -or $db -gt $Tolerance) { $changed++ }
    }
    return ([double]$changed / [double]$a.Length)
}

# A sample of Tally's window that is holding still (two captures 200 ms apart agree), or $null when
# it cannot be captured or keeps changing - then no later change could be told apart from the noise.
function Get-SteadyTallyScreen {
    param([IntPtr]$Hwnd)
    $c = $Script:ShowCheck
    $prev = Get-TallyScreenSample -Hwnd $Hwnd
    for ($try = 0; $try -lt 4; $try++) {
        if ($null -eq $prev) { return $null }
        Start-Sleep -Milliseconds 200
        $next = Get-TallyScreenSample -Hwnd $Hwnd
        $f = Get-ScreenChangeFraction -Before $prev -After $next -Tolerance $c.ChannelTolerance
        if ($f -ge 0 -and $f -le $c.SteadyMax) { return $next }
        $prev = $next
    }
    return $null
}

# Waits up to ChangeTimeoutMs for Tally's window to differ from $Before by at least $MinFraction.
# Returns @{ Changed; Fraction (largest seen); Reason = ''|'unchanged'|'foreground'|'capture' }.
function Wait-TallyScreenChange {
    param([IntPtr]$Hwnd, $Before, [double]$MinFraction)
    $c = $Script:ShowCheck
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $best = 0.0
    while ($true) {
        # Another window in front of Tally would also read as "changed" - it is not the box we want.
        if ([TallyUI2]::GetForegroundWindow() -ne $Hwnd) { return @{ Changed = $false; Fraction = $best; Reason = 'foreground' } }
        $f = Get-ScreenChangeFraction -Before $Before -After (Get-TallyScreenSample -Hwnd $Hwnd) -Tolerance $c.ChannelTolerance
        if ($f -lt 0) { return @{ Changed = $false; Fraction = $best; Reason = 'capture' } }
        if ($f -gt $best) { $best = $f }
        if ($f -ge $MinFraction) { return @{ Changed = $true; Fraction = $f; Reason = '' } }
        if ($sw.ElapsedMilliseconds -ge $c.ChangeTimeoutMs) { return @{ Changed = $false; Fraction = $best; Reason = 'unchanged' } }
        Start-Sleep -Milliseconds 200
    }
}

# PURE: a fraction as a percentage for messages, culture-independent ("1.25%").
function Format-ChangePercent {
    param([double]$Fraction)
    return [string]::Format([System.Globalization.CultureInfo]::InvariantCulture, '{0:0.##}%', ($Fraction * 100))
}

# PURE: the message for a screen check that stopped the sequence after $Done of $Total steps.
function Get-ShowVoucherCheckMessage {
    param($Step, $Seen, [double]$MinFraction, [int]$Done, [int]$Total)
    $stopped = "show-voucher stopped after $Done of $Total step(s) and sent nothing more, so no Enter could answer a prompt."
    switch ([string]$Seen.Reason) {
        'foreground' { return "Tally stopped being the foreground window after $($Step.label). $stopped" }
        'capture'    { return "Tally's window could not be captured to check what $($Step.label) did. $stopped" }
        'no-baseline' { return "Tally's window could not be captured, or kept changing on its own, so there was no way to check what $($Step.label) would do; it was not sent. $stopped" }
    }
    return "Tally's screen did not change as expected after $($Step.label) ($(Format-ChangePercent $Seen.Fraction) of the window changed; at least $(Format-ChangePercent $MinFraction) was needed), so $($Step.expect) probably did not open - a Yes/No prompt or another box may be waiting for the person at the PC. $stopped Anything that did open is left as it is."
}

# Paste text with Ctrl+V. Returns $false (sending nothing) when the clipboard cannot be set - never
# falls back to typing characters (see above).
function Send-AgentPaste {
    param([string]$Text)
    try { Set-Clipboard -Value $Text -ErrorAction Stop } catch { return $false }
    Start-Sleep -Milliseconds 120
    Send-AgentCombo -Modifier ([TallyUI2]::VK_CONTROL) -Key ([byte]0x56)   # Ctrl+V
    return $true
}

# Send one planned step. Returns $false when it could not be sent.
function Invoke-ShowVoucherStep {
    param($Step)
    $action = [string]$Step.action
    $value = [string]$Step.value
    if ($action -eq 'combo' -and $value -eq 'alt+g') {
        Send-AgentCombo -Modifier ([TallyUI2]::VK_MENU) -Key ([byte]0x47)    # Alt+G
        return $true
    }
    if ($action -eq 'key' -and $value -eq 'enter') {
        Send-AgentKey -Vk ([TallyUI2]::VK_RETURN)
        return $true
    }
    if ($action -eq 'key' -and $value -eq 'f2') {
        Send-AgentKey -Vk ([TallyUI2]::VK_F2)
        return $true
    }
    if ($action -eq 'paste') {
        return (Send-AgentPaste -Text $value)
    }
    return $false
}

# The command handler, shared by both transports.
#
#   watch mode (-Once absent) polls _mcp_gui_command.json and writes _mcp_gui_result.json. That
#   file IPC exists only to cross Windows Session 0 isolation, which applies when the MCP server
#   runs as a service and therefore has no desktop of its own.
#
#   one-shot mode (-Once) reads a single command from stdin and prints the result to stdout. Used
#   when the MCP server already runs in the interactive session, so nothing has to be bridged -
#   and, importantly, no credential is written to disk on the way.
#
# Identical dispatch either way: the transport changes, the behaviour does not.
function Invoke-AgentCommand {
    param([Parameter(Mandatory = $true)] $Cmd)

    # The switch body below was written against $cmd and $cmdId.
    $cmd = $Cmd
    $cmdId = if ($cmd.commandId) { [string]$cmd.commandId } else { "" }

        Write-Host "`n=== Received command: $($cmd.action) ==="

        switch ($cmd.action) {
            "ping" {
                $extra = @{
                    scriptPath  = $Script:AgentScriptPath
                    scriptMTime = if ($Script:AgentScriptMTime) { $Script:AgentScriptMTime.ToString('o') } else { $null }
                    pid         = $PID
                }
                Write-Result -Status "success" -Message "Agent v2 is alive (version: $Script:AgentVersion)" -Strategy "ping" -CommandId $cmdId -Extra $extra
            }
            "screenshot" {
                # Capture the current Tally window so the caller (an MCP client / Claude) can SEE the
                # on-screen state and choose the next keystrokes - the interactive, human-supervised
                # alternative to the blind deterministic select-and-unlock sequence. Pairs with "sendkeys".
                try {
                    $hwnd = Find-TallyWindow
                    if ($hwnd -eq [IntPtr]::Zero) {
                        Write-Result -Status "error" -Message (Get-TallyResolveMessage) -Strategy "screenshot" -CommandId $cmdId
                    } elseif (-not (Assert-ScreenAvailable -Cmd $cmd -CmdId $cmdId -Strategy "screenshot")) {
                        # Locked / disconnected / someone at the keyboard: the error result is written and
                        # Tally was not brought forward. (A locked screen would capture as black anyway.)
                    } else {
                        [TallyUI2]::ForceForeground($hwnd) | Out-Null
                        Start-Sleep -Milliseconds 300
                        $shot = Get-Screenshot -Hwnd $hwnd
                        if ($shot) {
                            Write-Result -Status "success" -Message "Captured Tally window" -Strategy "screenshot" -CommandId $cmdId -Extra @{ screenshotFile = (Split-Path $shot -Leaf) }
                        } else {
                            Write-Result -Status "error" -Message "Screenshot capture failed (window may be minimized)" -Strategy "screenshot" -CommandId $cmdId
                        }
                    }
                } catch {
                    Write-Result -Status "error" -Message "Screenshot exception: $_" -Strategy "screenshot" -CommandId $cmdId
                }
            }
            "sendkeys" {
                # Execute an ordered list of keystroke steps (type / key / combo / wait) in the Tally
                # window. Focus is re-asserted before each step so a stray focus-steal can't leak a typed
                # password into another window. Reuses Execute-Action, the same primitive sendkeys uses.
                try {
                    $hwnd = Find-TallyWindow
                    if ($hwnd -eq [IntPtr]::Zero) {
                        Write-Result -Status "error" -Message (Get-TallyResolveMessage) -Strategy "sendkeys" -CommandId $cmdId
                    } elseif (-not $cmd.keys) {
                        Write-Result -Status "error" -Message "No keys provided" -Strategy "sendkeys" -CommandId $cmdId
                    } elseif (-not (Assert-ScreenAvailable -Cmd $cmd -CmdId $cmdId -Strategy "sendkeys")) {
                        # Error result already written; no keystroke was sent.
                    } else {
                        [TallyUI2]::ForceForeground($hwnd) | Out-Null
                        Start-Sleep -Milliseconds 300
                        $validSteps = @(@($cmd.keys) | Where-Object { $null -ne $_ -and $_.action })
                        $total = $validSteps.Count
                        $done = 0
                        $aborted = $false
                        foreach ($step in $validSteps) {
                            # Between steps: stop as soon as a person touches the keyboard or mouse (or the
                            # PC locks). The gate above covered the first step.
                            if ($done -gt 0) {
                                if (-not (Assert-ScreenStillAvailable -Cmd $cmd -CmdId $cmdId -Strategy "sendkeys" -StepsDone $done -StepsTotal $total)) {
                                    $aborted = $true
                                    break
                                }
                            }
                            if ([TallyUI2]::GetForegroundWindow() -ne $hwnd) {
                                [TallyUI2]::ForceForeground($hwnd) | Out-Null
                                Start-Sleep -Milliseconds 200
                            }
                            Execute-Action -Action $step
                            $done++
                        }
                        if (-not $aborted) {
                            Write-Result -Status "success" -Message "Executed $done key action(s)" -Strategy "sendkeys" -CommandId $cmdId -Extra @{ steps = $done }
                        }
                    }
                } catch {
                    Write-Result -Status "error" -Message "sendkeys exception: $_" -Strategy "sendkeys" -CommandId $cmdId
                }
            }
            "select-and-unlock-company" {
                # Deterministic keystroke flow: type company id (already at Select Company) -> Enter -> type credentials -> Enter.
                # IMPORTANT: do NOT send Alt+F3 first - on Tally Prime Edit Log it activates a "Specify Path" sub-mode,
                # not the regular Select Company list. After Tally launches with no company loaded, the company list is
                # already in focus and accepts typed input directly.
                # Deterministic, works regardless of password type. Used by load-company when auto-load via tally.ini's
                # Load= directive can't proceed past the credential prompt.
                $companyId = if ($cmd.companyId) { [string]$cmd.companyId } else { "" }
                $userName  = if ($cmd.userName)  { [string]$cmd.userName }  else { "" }
                $password  = if ($cmd.password)  { [string]$cmd.password }  else { "" }
                $waitMsAfterEnter = if ($cmd.waitMsAfterEnter) { [int]$cmd.waitMsAfterEnter } else { 3000 }
                $waitMsAfterCreds = if ($cmd.waitMsAfterCreds) { [int]$cmd.waitMsAfterCreds } else { 3000 }
                if (-not $companyId) {
                    Write-Result -Status "error" -Message "Missing companyId" -Strategy "select-and-unlock" -CommandId $cmdId
                } else {
                    try {
                        $hwnd = Find-TallyWindow
                        if ($hwnd -eq [IntPtr]::Zero) {
                            Write-Result -Status "error" -Message (Get-TallyResolveMessage) -Strategy "select-and-unlock" -CommandId $cmdId
                        } elseif (-not (Assert-ScreenAvailable -Cmd $cmd -CmdId $cmdId -Strategy "select-and-unlock")) {
                            # Error result already written; no keystroke was sent.
                        } else {
                          $hasCreds = [bool]($userName -or $password)
                          $stepsTotal = if ($hasCreds) { 4 } else { 2 }
                          $finished = $false
                          # One-pass block: 'break' leaves it as soon as a re-check between steps finds a
                          # person at the keyboard/mouse or a locked session (the re-check has then written
                          # the error result, naming how many steps ran).
                          do {
                            [TallyUI2]::ForceForeground($hwnd) | Out-Null
                            Start-Sleep -Milliseconds 500

                            # Reset to a known state by Escaping out of any wedged dialog from a prior run.
                            # Two Escapes is safe: closes innermost dialog, then any outer modal. If we were already
                            # at the bare Select Company list, Escape there is a no-op.
                            Send-AgentKey -Vk ([TallyUI2]::VK_ESCAPE)
                            Start-Sleep -Milliseconds 300
                            Send-AgentKey -Vk ([TallyUI2]::VK_ESCAPE)
                            Start-Sleep -Milliseconds 500

                            if (-not (Assert-ScreenStillAvailable -Cmd $cmd -CmdId $cmdId -Strategy "select-and-unlock" -StepsDone 1 -StepsTotal $stepsTotal)) { break }

                            # Type the company id (folder id) directly into the Select Company list.
                            # Tally auto-jumps the highlight to the matching folder as we type.
                            Send-AgentText -Text $companyId
                            Start-Sleep -Milliseconds 800

                            # Tally Prime's standard data layout is folder -> company. The first Enter
                            # drills into the highlighted folder; the second Enter selects the company
                            # inside it. After the second Enter, Tally either loads the company directly
                            # (no password) or shows the credential prompt (password-protected).
                            # Caller can override the count via $cmd.enterPresses (default: 2).
                            $enterPresses = if ($cmd.enterPresses) { [int]$cmd.enterPresses } else { 2 }
                            if ($enterPresses -lt 1) { $enterPresses = 1 }
                            if ($enterPresses -gt 4) { $enterPresses = 4 }
                            for ($_ep = 0; $_ep -lt $enterPresses; $_ep++) {
                                Send-AgentKey -Vk ([TallyUI2]::VK_RETURN)
                                if ($_ep -lt ($enterPresses - 1)) {
                                    # Inter-Enter wait: let Tally render the folder contents before the next Enter.
                                    Start-Sleep -Milliseconds 1500
                                }
                            }
                            Start-Sleep -Milliseconds $waitMsAfterEnter

                            if ($hasCreds) {
                                if (-not (Assert-ScreenStillAvailable -Cmd $cmd -CmdId $cmdId -Strategy "select-and-unlock" -StepsDone 2 -StepsTotal $stepsTotal)) { break }
                            }

                            # If credentials were supplied, enter them
                            if ($userName) {
                                Send-AgentText -Text $userName
                                Start-Sleep -Milliseconds 300
                                Send-AgentKey -Vk ([TallyUI2]::VK_TAB)
                                Start-Sleep -Milliseconds 300
                            }
                            if ($password) {
                                # Re-assert focus right before typing the password so a stray click or
                                # focus-steal between the Enters above and now doesn't leak the password
                                # into another window. Cheap re-check with existing helpers; ForceForeground
                                # is a no-op when Tally is already the foreground window.
                                if ([TallyUI2]::GetForegroundWindow() -ne $hwnd) {
                                    [TallyUI2]::ForceForeground($hwnd) | Out-Null
                                    Start-Sleep -Milliseconds 300
                                }
                                Send-AgentText -Text $password
                                Start-Sleep -Milliseconds 300
                            }
                            if ($hasCreds) {
                                # Last look before the Enter that submits the credentials.
                                if (-not (Assert-ScreenStillAvailable -Cmd $cmd -CmdId $cmdId -Strategy "select-and-unlock" -StepsDone 3 -StepsTotal $stepsTotal)) { break }
                                Send-AgentKey -Vk ([TallyUI2]::VK_RETURN)
                                Start-Sleep -Milliseconds $waitMsAfterCreds
                            }
                            $finished = $true
                          } while ($false)

                          if ($finished) {
                            # VERIFY GROUND TRUTH before claiming success. Everything above is open-loop:
                            # Tally may have rejected the password, the list may never have had focus, or
                            # the wrong folder/company may have been highlighted. Ask Tally what is actually
                            # loaded and let the verifier report success / error / unverified accordingly,
                            # instead of unconditionally reporting "keystrokes sent" as success.
                            $ctx = if ($userName -or $password) { " with credentials" } else { "" }
                            Write-VerifiedLoadResult -Requested $companyId -Strategy "select-and-unlock" -CommandId $cmdId -Context $ctx
                          }
                        }
                    } catch {
                        Write-Result -Status "error" -Message "Exception: $_" -Strategy "select-and-unlock" -CommandId $cmdId
                    }
                }
            }
            "switch-company" {
                # Switch the RESIDENT company on a LIVE Tally WITHOUT restarting it. This is the whole point:
                # load-company kills + relaunches tally.exe, which drops the XML port 9000 and the hosted OAuth
                # session -> forces a manual reconnect. Switching via Tally's own "Select Company" screen keeps
                # Tally (and the connection) up.
                #
                # Composition of two ALREADY-PROVEN sequences:
                #   1. PREFIX (open Select Company on a running Tally): Alt+F3 -> F1. Established empirically
                #      on this Tally build by the (now removed) vision loop, which converged on this pair every
                #      time before it was deleted. Alt+F3 = Company menu, F1 = Select Company.
                #   2. TAIL (pick + unlock): identical to select-and-unlock-company - type the folder id, Enter to
                #      drill the folder, Enter to select the company, then type credentials if supplied.
                #
                # SAFETY: we deliberately do NOT send a blind Escape first. From the Gateway a stray Escape pops
                # the "Quit?" prompt (which has bitten us before). The caller is expected to anchor at a READ-ONLY
                # screen (Gateway / a report) first - the MCP tool documents this and short-circuits when the target
                # is already resident. Everything here is open-loop, so we VERIFY the outcome against Tally's XML
                # server (Write-VerifiedLoadResult) and fail closed: a wrong/failed switch is never reported as success.
                $companyId   = if ($cmd.companyId)   { [string]$cmd.companyId }   else { "" }
                $companyName = if ($cmd.companyName) { [string]$cmd.companyName } else { "" }
                $userName    = if ($cmd.userName)    { [string]$cmd.userName }    else { "" }
                $password    = if ($cmd.password)    { [string]$cmd.password }    else { "" }
                $waitMsAfterEnter = if ($cmd.waitMsAfterEnter) { [int]$cmd.waitMsAfterEnter } else { 3000 }
                $waitMsAfterCreds = if ($cmd.waitMsAfterCreds) { [int]$cmd.waitMsAfterCreds } else { 3000 }
                if (-not $companyId) {
                    Write-Result -Status "error" -Message "Missing companyId" -Strategy "switch-company" -CommandId $cmdId
                } else {
                    try {
                        $hwnd = Find-TallyWindow
                        if ($hwnd -eq [IntPtr]::Zero) {
                            Write-Result -Status "error" -Message (Get-TallyResolveMessage) -Strategy "switch-company" -CommandId $cmdId
                        } elseif (-not (Assert-ScreenAvailable -Cmd $cmd -CmdId $cmdId -Strategy "switch-company")) {
                            # Error result already written; no keystroke was sent.
                        } else {
                          $hasCreds = [bool]($userName -or $password)
                          $stepsTotal = if ($hasCreds) { 4 } else { 2 }
                          $finished = $false
                          # One-pass block; 'break' = a re-check between steps stopped the sequence (and wrote
                          # the error result). Same checkpoints as select-and-unlock-company.
                          do {
                            [TallyUI2]::ForceForeground($hwnd) | Out-Null
                            Start-Sleep -Milliseconds 500

                            # PREFIX: open the Select Company list on the running Tally (Alt+F3 -> F1).
                            Send-AgentCombo -Modifier ([TallyUI2]::VK_MENU) -Key ([TallyUI2]::VK_F3)
                            Start-Sleep -Milliseconds 800
                            Send-AgentKey -Vk ([TallyUI2]::VK_F1)
                            Start-Sleep -Milliseconds 900

                            if (-not (Assert-ScreenStillAvailable -Cmd $cmd -CmdId $cmdId -Strategy "switch-company" -StepsDone 1 -StepsTotal $stepsTotal)) { break }

                            # TAIL: type the folder id; Tally auto-jumps the highlight to the matching folder.
                            Send-AgentText -Text $companyId
                            Start-Sleep -Milliseconds 800

                            # folder -> company drill (default 2 Enters), same as select-and-unlock-company.
                            $enterPresses = if ($cmd.enterPresses) { [int]$cmd.enterPresses } else { 2 }
                            if ($enterPresses -lt 1) { $enterPresses = 1 }
                            if ($enterPresses -gt 4) { $enterPresses = 4 }
                            for ($_ep = 0; $_ep -lt $enterPresses; $_ep++) {
                                Send-AgentKey -Vk ([TallyUI2]::VK_RETURN)
                                if ($_ep -lt ($enterPresses - 1)) {
                                    Start-Sleep -Milliseconds 1500
                                }
                            }
                            Start-Sleep -Milliseconds $waitMsAfterEnter

                            if ($hasCreds) {
                                if (-not (Assert-ScreenStillAvailable -Cmd $cmd -CmdId $cmdId -Strategy "switch-company" -StepsDone 2 -StepsTotal $stepsTotal)) { break }
                            }

                            # Credentials, if the company is protected. TypeString (scan-code) not clipboard paste:
                            # masked/TallyVault fields can silently reject a paste, so char typing is safer here.
                            if ($userName) {
                                Send-AgentText -Text $userName
                                Start-Sleep -Milliseconds 300
                                Send-AgentKey -Vk ([TallyUI2]::VK_TAB)
                                Start-Sleep -Milliseconds 300
                            }
                            if ($password) {
                                if ([TallyUI2]::GetForegroundWindow() -ne $hwnd) {
                                    [TallyUI2]::ForceForeground($hwnd) | Out-Null
                                    Start-Sleep -Milliseconds 300
                                }
                                Send-AgentText -Text $password
                                Start-Sleep -Milliseconds 300
                            }
                            if ($hasCreds) {
                                if (-not (Assert-ScreenStillAvailable -Cmd $cmd -CmdId $cmdId -Strategy "switch-company" -StepsDone 3 -StepsTotal $stepsTotal)) { break }
                                Send-AgentKey -Vk ([TallyUI2]::VK_RETURN)
                                Start-Sleep -Milliseconds $waitMsAfterCreds
                            }
                            $finished = $true
                          } while ($false)

                          if ($finished) {
                            # CHECKPOINT: ground-truth verify (get-period / loaded-list agrees). Prefer the real
                            # display name for the match; fall back to the folder id.
                            $requested = if ($companyName) { $companyName } else { $companyId }
                            $ctx = if ($userName -or $password) { " with credentials" } else { "" }
                            Write-VerifiedLoadResult -Requested $requested -Strategy "switch-company" -CommandId $cmdId -Context $ctx
                          }
                        }
                    } catch {
                        Write-Result -Status "error" -Message "Exception: $_" -Strategy "switch-company" -CommandId $cmdId
                    }
                }
            }
            "start-tally" {
                # Spawn tally.exe in this agent's session (which is the user's interactive desktop session).
                # The MCP service can't do this directly when running in Session 0 - that's why it delegates here.
                # Security: the executable path comes from trusted local config (TALLY_EXE_PATH from .env,
                # else the standard install path), NOT from the IPC command. Honouring $cmd.exePath would let
                # any writer of the (previously world-writable) command file launch an arbitrary executable
                # in the operator's interactive session.
                $exe = if ($env:TALLY_EXE_PATH) { [string]$env:TALLY_EXE_PATH } else { "C:\Program Files\TallyPrimeEditLog\tally.exe" }
                $waitSec = if ($cmd.waitSec) { [int]$cmd.waitSec } else { 30 }
                if (-not (Test-Path $exe)) {
                    Write-Result -Status "error" -Message "tally.exe not found at $exe" -Strategy "start-tally" -CommandId $cmdId
                } else {
                    try {
                        Start-Process -FilePath $exe | Out-Null
                        # Poll for the Tally window to appear - confirms the GUI is up before declaring success
                        $deadline = (Get-Date).AddSeconds($waitSec)
                        $hwnd = [IntPtr]::Zero
                        while ((Get-Date) -lt $deadline) {
                            $hwnd = Find-TallyWindow
                            if ($hwnd -ne [IntPtr]::Zero) { break }
                            Start-Sleep -Milliseconds 500
                        }
                        if ($hwnd -ne [IntPtr]::Zero) {
                            Write-Result -Status "success" -Message "Tally started; window detected within timeout" -Strategy "start-tally" -CommandId $cmdId
                        } else {
                            Write-Result -Status "error" -Message "Tally process spawned but no window appeared within ${waitSec}s" -Strategy "start-tally" -CommandId $cmdId
                        }
                    } catch {
                        Write-Result -Status "error" -Message "Start-Process failed: $_" -Strategy "start-tally" -CommandId $cmdId
                    }
                }
            }
            "press-key" {
                # Step-by-step primitive: press one named key. Lets Claude drive Tally
                # interactively (screenshot -> reason -> press a key -> screenshot ->
                # reason -> ...) instead of relying on the monolithic
                # select-and-unlock-company keystroke blast.
                $keyName = if ($cmd.keyName) { [string]$cmd.keyName } else { "" }
                $keyMap = @{
                    "enter" = [TallyUI2]::VK_RETURN; "return" = [TallyUI2]::VK_RETURN
                    "escape" = [TallyUI2]::VK_ESCAPE; "esc" = [TallyUI2]::VK_ESCAPE
                    "tab" = [TallyUI2]::VK_TAB; "backspace" = [TallyUI2]::VK_BACK; "back" = [TallyUI2]::VK_BACK
                    "up" = [TallyUI2]::VK_UP; "down" = [TallyUI2]::VK_DOWN
                    "left" = [TallyUI2]::VK_LEFT; "right" = [TallyUI2]::VK_RIGHT
                    "f1" = [TallyUI2]::VK_F1; "f2" = [TallyUI2]::VK_F2; "f3" = [TallyUI2]::VK_F3
                    "f4" = [TallyUI2]::VK_F4; "f5" = [TallyUI2]::VK_F5
                    "f10" = [TallyUI2]::VK_F10; "f12" = [TallyUI2]::VK_F12
                }
                $vk = $keyMap[$keyName.ToLower()]
                if (-not $vk) {
                    $valid = ($keyMap.Keys | Sort-Object) -join ', '
                    Write-Result -Status "error" -Message "Unknown keyName '$keyName'. Valid: $valid" -Strategy "press-key" -CommandId $cmdId
                } else {
                    try {
                        $hwnd = Find-TallyWindow
                        if ($hwnd -eq [IntPtr]::Zero) {
                            Write-Result -Status "error" -Message (Get-TallyResolveMessage) -Strategy "press-key" -CommandId $cmdId
                        } elseif (-not (Assert-ScreenAvailable -Cmd $cmd -CmdId $cmdId -Strategy "press-key")) {
                            # Error result already written; nothing was sent.
                        } else {
                            [TallyUI2]::ForceForeground($hwnd) | Out-Null
                            Start-Sleep -Milliseconds 300
                            Send-AgentKey -Vk $vk
                            Start-Sleep -Milliseconds 300
                            Write-Result -Status "success" -Message "Pressed $keyName" -Strategy "press-key" -CommandId $cmdId
                        }
                    } catch {
                        Write-Result -Status "error" -Message "Exception: $_" -Strategy "press-key" -CommandId $cmdId
                    }
                }
            }
            "type-text" {
                # Step-by-step primitive: type a string into the current Tally focus.
                $text = if ($cmd.text) { [string]$cmd.text } else { "" }
                if (-not $text) {
                    Write-Result -Status "error" -Message "Missing 'text' field" -Strategy "type-text" -CommandId $cmdId
                } else {
                    try {
                        $hwnd = Find-TallyWindow
                        if ($hwnd -eq [IntPtr]::Zero) {
                            Write-Result -Status "error" -Message (Get-TallyResolveMessage) -Strategy "type-text" -CommandId $cmdId
                        } elseif (-not (Assert-ScreenAvailable -Cmd $cmd -CmdId $cmdId -Strategy "type-text")) {
                            # Error result already written; nothing was sent.
                        } else {
                            [TallyUI2]::ForceForeground($hwnd) | Out-Null
                            Start-Sleep -Milliseconds 300
                            Send-AgentText -Text $text
                            Start-Sleep -Milliseconds 300
                            # Length only - never echo the text itself in case a caller
                            # routes a password through here.
                            Write-Result -Status "success" -Message "Typed $($text.Length) chars" -Strategy "type-text" -CommandId $cmdId
                        }
                    } catch {
                        Write-Result -Status "error" -Message "Exception: $_" -Strategy "type-text" -CommandId $cmdId
                    }
                }
            }
            "bring-foreground" {
                # Quick state probe + focus. Useful before an assistant-driven sequence to make
                # sure subsequent press-key / type-text actions land in Tally and not in
                # some other window the user accidentally clicked into.
                try {
                    $hwnd = Find-TallyWindow
                    if ($hwnd -eq [IntPtr]::Zero) {
                        Write-Result -Status "error" -Message (Get-TallyResolveMessage) -Strategy "bring-foreground" -CommandId $cmdId
                    } elseif (-not (Assert-ScreenAvailable -Cmd $cmd -CmdId $cmdId -Strategy "bring-foreground")) {
                        # Error result already written; nothing was sent.
                    } else {
                        [TallyUI2]::ForceForeground($hwnd) | Out-Null
                        Start-Sleep -Milliseconds 300
                        Write-Result -Status "success" -Message "Tally brought to foreground" -Strategy "bring-foreground" -CommandId $cmdId
                    }
                } catch {
                    Write-Result -Status "error" -Message "Exception: $_" -Strategy "bring-foreground" -CommandId $cmdId
                }
            }
            "idle-status" {
                # Touches nothing on screen, so it is exempt from the idle / session gate. Reports how long
                # since the last keyboard/mouse input of any kind (idleMs), whether that input was our own
                # injected keystroke (lastInputWasAgent), how long since a PERSON last used the PC
                # (humanIdleMs - what the server's restart gate must judge, since our own keys reset
                # idleMs), whether a screen action would be refused as USER_ACTIVE right now (userActive,
                # against this command's userIdleSec), and the session state. Each idle figure is null
                # when unknown. Reads tick files only; never writes one, so it is safe to run outside
                # the machine lock alongside a screen action.
                try {
                    $session = Get-SessionState
                    $idleMs = $null
                    $humanIdleMs = $null
                    $lastWasAgent = $false
                    $userActive = $false
                    $figures = Get-CurrentIdleFigures
                    if ($null -ne $figures) {
                        $idleMs = $figures.IdleMs
                        $humanIdleMs = $figures.HumanIdleMs
                        $lastWasAgent = $figures.LastInputWasAgent
                        $settings = Get-UserIdleSettings -Cmd $cmd
                        $userActive = Test-UserActive -Figures $figures -ThresholdMs $settings.ThresholdMs
                    }
                    $idleText = if ($null -ne $idleMs) { "last input $idleMs ms ago" } else { 'input idle time unavailable' }
                    if ($null -ne $figures -and $lastWasAgent) {
                        $whose = if ($null -ne $humanIdleMs) { " (ours; a person's $humanIdleMs ms ago)" } else { " (ours; no earlier input by a person on record)" }
                        $idleText = $idleText + $whose
                    }
                    Write-Result -Status "success" -Message "Session $($session.state); $idleText" -Strategy "idle-status" -CommandId $cmdId -Extra @{ idleMs = $idleMs; humanIdleMs = $humanIdleMs; lastInputWasAgent = $lastWasAgent; userActive = $userActive; session = $session }
                } catch {
                    Write-Result -Status "error" -Message "idle-status exception: $_" -Strategy "idle-status" -CommandId $cmdId
                }
            }
            "show-voucher" {
                # Put a just-posted voucher on screen (#23): opens the Day Book at the voucher's date. Meant
                # never to alter data, but keys sent to the wrong screen can (Enter answers "Accept?" Yes),
                # so every Enter / F2 waits for a screen check of the step before it - see the
                # "show-voucher helpers" comment above, and verify the sequence on each supported
                # TallyPrime release. The server treats any error here as "skip silently". Fields: masterId (digits), voucherType, voucherNumber,
                # date (YYYY-MM-DD), banner (optional, echoed back - the tray owns on-screen banners),
                # dryKeys (true = return the planned steps without sending anything).
                $masterId      = if ($null -ne $cmd.masterId)      { ([string]$cmd.masterId).Trim() } else { '' }
                $voucherType   = if ($null -ne $cmd.voucherType)   { [string]$cmd.voucherType }   else { '' }
                $voucherNumber = if ($null -ne $cmd.voucherNumber) { [string]$cmd.voucherNumber } else { '' }
                $dateIso = ''
                if ($cmd.date -is [datetime]) {
                    # A JSON parser that turns ISO strings into dates (pwsh 7) - take the calendar date back.
                    $dateIso = $cmd.date.ToString('yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture)
                } elseif ($null -ne $cmd.date) {
                    $dateIso = ([string]$cmd.date).Trim()
                }
                $banner        = if ($null -ne $cmd.banner)        { [string]$cmd.banner }        else { '' }
                $dry = ($cmd.dryKeys -eq $true)

                $invalid = ''
                $tallyDate = ''
                if ($masterId -and $masterId -notmatch '^\d+$') { $invalid = "masterId must be digits, got '$masterId'." }
                if ($dateIso) {
                    if ($dateIso -notmatch '^\d{4}-\d{2}-\d{2}$') {
                        $invalid = "date must be YYYY-MM-DD, got '$dateIso'."
                    } else {
                        try {
                            $parsedDate = [datetime]::ParseExact($dateIso, 'yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture)
                            $tallyDate = $parsedDate.ToString('dd-MM-yyyy', [System.Globalization.CultureInfo]::InvariantCulture)
                        } catch {
                            $invalid = "date '$dateIso' is not a real date."
                        }
                    }
                }
                $echo = @{ masterId = $masterId; voucherType = $voucherType; voucherNumber = $voucherNumber; date = $dateIso; banner = $banner }

                if ($invalid) {
                    $extra = @{ shown = 'none' }
                    foreach ($k in $echo.Keys) { $extra[$k] = $echo[$k] }
                    Write-Result -Status "error" -Message "show-voucher: $invalid Nothing was sent." -Strategy "show-voucher" -CommandId $cmdId -Extra $extra
                } else {
                    $plan = @(Get-ShowVoucherPlan -TallyDate $tallyDate)
                    $total = $plan.Count
                    if ($dry) {
                        $extra = @{ shown = 'none'; dryRun = $true; keys = $plan }
                        foreach ($k in $echo.Keys) { $extra[$k] = $echo[$k] }
                        Write-Result -Status "success" -Message "Dry run: $total planned key step(s); nothing was sent." -Strategy "show-voucher" -CommandId $cmdId -Extra $extra
                    } else {
                        try {
                            $hwnd = Find-TallyWindow
                            if ($hwnd -eq [IntPtr]::Zero) {
                                Write-Result -Status "error" -Message (Get-TallyResolveMessage) -Strategy "show-voucher" -CommandId $cmdId -Extra @{ shown = 'none' }
                            } elseif (-not (Assert-ScreenAvailable -Cmd $cmd -CmdId $cmdId -Strategy "show-voucher")) {
                                # Error result already written; nothing was sent.
                            } else {
                                # Keep the person's clipboard: the paste steps overwrite it. Text only - other
                                # clipboard formats cannot be put back.
                                $savedClip = $null
                                try { $savedClip = Get-Clipboard -Raw -ErrorAction Stop } catch { $savedClip = $null }
                                $done = 0
                                $aborted = $false
                                $failure = ''
                                # What is on screen so far: 'day-book' once the Enter that opens it was
                                # confirmed by its screen check. A later stop leaves it there.
                                $shownSoFar = 'none'
                                $checks = @()
                                try {
                                    [TallyUI2]::ForceForeground($hwnd) | Out-Null
                                    Start-Sleep -Milliseconds 300
                                    foreach ($step in $plan) {
                                        # A checked step needs a still picture of the screen BEFORE it is
                                        # sent, so the change it causes can be told from noise.
                                        $baseline = $null
                                        if ($step.check) {
                                            $baseline = Get-SteadyTallyScreen -Hwnd $hwnd
                                            if ($null -eq $baseline) {
                                                $failure = Get-ShowVoucherCheckMessage -Step $step -Seen @{ Reason = 'no-baseline'; Fraction = 0.0 } -MinFraction 0 -Done $done -Total $total
                                                break
                                            }
                                        }
                                        if ($done -gt 0) {
                                            if (-not (Assert-ScreenStillAvailable -Cmd $cmd -CmdId $cmdId -Strategy "show-voucher" -StepsDone $done -StepsTotal $total)) {
                                                $aborted = $true
                                                break
                                            }
                                        }
                                        if ([TallyUI2]::GetForegroundWindow() -ne $hwnd) {
                                            $failure = "Tally is not the foreground window, so show-voucher stopped after $done of $total step(s); the rest were not sent."
                                            break
                                        }
                                        if (-not (Invoke-ShowVoucherStep -Step $step)) {
                                            $failure = "The clipboard was not available, so show-voucher stopped after $done of $total step(s); the rest were not sent."
                                            break
                                        }
                                        $done++
                                        if ($step.check) {
                                            $minFraction = [double]$Script:ShowCheck.Min[[string]$step.check]
                                            $seen = Wait-TallyScreenChange -Hwnd $hwnd -Before $baseline -MinFraction $minFraction
                                            $checks += @{ step = [string]$step.label; changed = [Math]::Round([double]$seen.Fraction, 4); needed = $minFraction; ok = [bool]$seen.Changed }
                                            if (-not $seen.Changed) {
                                                $failure = Get-ShowVoucherCheckMessage -Step $step -Seen $seen -MinFraction $minFraction -Done $done -Total $total
                                                break
                                            }
                                            if ([string]$step.check -eq 'screen') { $shownSoFar = 'day-book' }
                                        }
                                        Start-Sleep -Milliseconds ([int]$step.waitMs)
                                    }
                                } finally {
                                    if ($null -ne $savedClip -and [string]$savedClip -ne '') {
                                        try { Set-Clipboard -Value $savedClip -ErrorAction Stop } catch { }
                                    }
                                }
                                if ($aborted) {
                                    # Assert-ScreenStillAvailable already wrote the error result.
                                } elseif ($failure) {
                                    $extra = @{ shown = $shownSoFar; stepsDone = $done; screenChecks = $checks }
                                    foreach ($k in $echo.Keys) { $extra[$k] = $echo[$k] }
                                    Write-Result -Status "error" -Message $failure -Strategy "show-voucher" -CommandId $cmdId -Extra $extra
                                } else {
                                    $extra = @{ shown = 'day-book'; steps = $done; screenChecks = $checks }
                                    foreach ($k in $echo.Keys) { $extra[$k] = $echo[$k] }
                                    $on = if ($tallyDate) { " for $tallyDate" } else { '' }
                                    Write-Result -Status "success" -Message "Opened the Day Book$on so the posted voucher is on screen." -Strategy "show-voucher" -CommandId $cmdId -Extra $extra
                                }
                            }
                        } catch {
                            Write-Result -Status "error" -Message "show-voucher exception: $_" -Strategy "show-voucher" -CommandId $cmdId -Extra @{ shown = 'none' }
                        }
                    }
                }
            }
            "exit" {
                Write-Result -Status "success" -Message "Shutting down" -Strategy "exit" -CommandId $cmdId
                exit 0
            }
            default {
                Write-Result -Status "error" -Message "Unknown action: $($cmd.action)" -Strategy "unknown" -CommandId $cmdId
            }
        }
}

# --- One-shot entry ------------------------------------------------------------------------------
# Runs a single command from stdin and exits. Deliberately placed before the watch loop so one-shot
# invocations never start polling, never self-restart, and never touch the IPC files.
if ($Once) {
    try {
        $stdin = [Console]::In.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($stdin)) {
            Write-Result -Status "error" -Message "No command received on stdin." -Strategy "once"
            exit 1
        }
        $onceCmd = $stdin | ConvertFrom-Json
        Invoke-AgentCommand -Cmd $onceCmd
        exit 0
    }
    catch {
        # Report as a normal result so the caller gets structured output on every path rather than
        # having to distinguish a crash from a refusal.
        Write-Result -Status "error" -Message "Exception: $_" -Strategy "once"
        exit 1
    }
}

while ($true) {
    # Check if our own script file changed on disk between iterations. If so, the user/deploy
    # has shipped a new agent version; re-launch into the new version and exit this process.
    if (Test-ScriptUpdated) { Restart-Self }
    try {
        # Atomically try to read and delete - avoids TOCTOU race with MCP server
        $cmdText = $null
        try {
            $cmdText = [System.IO.File]::ReadAllText($CommandFile, [System.Text.Encoding]::UTF8)
            Remove-Item $CommandFile -Force -ErrorAction SilentlyContinue
        } catch [System.IO.FileNotFoundException] {
            # File doesn't exist - normal, just keep polling
        } catch [System.IO.DirectoryNotFoundException] {
            # Directory doesn't exist yet
        }

        if ($cmdText) {
            # Invoke-AgentCommand derives the commandId from the command itself.
            $cmd = $cmdText | ConvertFrom-Json
            Invoke-AgentCommand -Cmd $cmd
        }
    }
    catch {
        Write-Host "Error processing command: $_"
        Write-Result -Status "error" -Message "Exception: $_" -Strategy "error"
        Remove-Item $CommandFile -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
}
