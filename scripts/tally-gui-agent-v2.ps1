# MCP Tally GUI Agent v2 - eyes and hands for the Tally window.
#
# This agent does NOT decide anything. It captures the Tally window on request and injects the
# keystrokes it is told to inject. The decisions are made by the MCP client (Claude), which sees
# each screenshot and chooses the next single step: look -> one step -> look again.
#
# It used to carry its own vision loop - screenshot, ask gpt-4o/Claude over HTTP for the next
# action, repeat - which meant a second, weaker model with its own API key was driving the GUI
# while the Claude session that requested the work sat idle. That loop is gone, and with it the
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
if (-not $ShowConsole) {
    try {
        Add-Type -Name _AgentConsole -Namespace _Tally -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@ -ErrorAction Stop
        $__consoleWnd = [_Tally._AgentConsole]::GetConsoleWindow()
        if ($__consoleWnd -ne [System.IntPtr]::Zero) {
            [void][_Tally._AgentConsole]::ShowWindow($__consoleWnd, 0)  # 0 = SW_HIDE
        }
    } catch { }
}

# --- Agent version (bumped whenever the IPC contract or script behavior changes) ---
# The MCP server reads this from the ping response and refuses load-company calls
# against an agent older than its required minimum (issue #15 - version handshake).
# Format: MAJOR.MINOR.PATCH. Bump MINOR on any new IPC action or response field;
# bump PATCH on internal fixes that callers can ignore.
$Script:AgentVersion = "1.8.0"

# --- Single-instance guard ---------------------------------------------------------------------
# Only ONE *watch-mode* agent may run. Multiple watchers race on the command/result files and each
# spawns its own overlay window. A named session mutex enforces this across every watch-mode launch
# path (at-logon trigger, the 1-min crash-respawn heartbeat, Restart-Self on script change, manual
# starts, reinstalls). We wait a few seconds so a Restart-Self predecessor can exit and release the
# mutex before we give up; an abandoned mutex (predecessor exited without releasing) still counts as
# acquired.
#
# One-shot (-Once) runs are exempt, and must stay exempt. They are short-lived children of the MCP
# server that read one command from stdin, print one JSON result to stdout and exit - they never poll
# the IPC files and never build the overlay, so they cannot race a watcher. Taking the mutex here
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
    # Hide the Claude-control frame so it never appears in what Claude sees, then give it a beat to
    # actually vanish before capturing.
    if (Get-Command Hide-ClaudeOverlay -ErrorAction SilentlyContinue) { Hide-ClaudeOverlay; Start-Sleep -Milliseconds 180 }
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

function Execute-Action {
    param($Action)

    # Signal "Claude is driving" while we act on the window (best-effort; no-op if overlay unavailable).
    if (Get-Command Show-ClaudeOverlay -ErrorAction SilentlyContinue) { Show-ClaudeOverlay }

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
                [TallyUI2]::PressKey($vk)
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
                    [TallyUI2]::PressCombo($mod, $key)
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
                [TallyUI2]::PressCombo([TallyUI2]::VK_CONTROL, 0x56)  # Ctrl+V
            } else {
                Write-Host "  (clipboard unavailable - falling back to char typing)"
                [TallyUI2]::TypeString($text)
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
# The keystroke-driven load flows (deterministic select-and-unlock, and Claude-driven sendkeys) are
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
# so keep it quiet - and skip the overlay runspace below, which costs an STA thread and a WinForms
# load that a single short-lived command has no use for.
if (-not $Once) {
    Write-Host "=== MCP Tally GUI Agent v2 (eyes and hands; Claude decides) ==="
    Write-Host "Version:  $Script:AgentVersion"
    Write-Host "Watching: $CommandFile"
    Write-Host "Results:  $ResultFile"
    Write-Host "Self-restart on script change: $(-not $NoSelfRestart)"
    Write-Host "Agent started. Polling every 500ms for commands..."
}

# --- Claude-control visual overlay -------------------------------------------------------------
# A topmost, CLICK-THROUGH orange frame around the Tally window while the agent is driving it, so the
# user can see "Claude has the wheel - hands off". Runs on its own STA WinForms thread (a runspace)
# because the agent's polling loop has no message pump. ENTIRELY best-effort: every touchpoint is
# wrapped in try/catch, so if anything here fails the overlay simply won't appear and GUI control is
# unaffected. It auto-hides ~6s after the last action, and is hidden during screenshot capture so it
# never appears in what Claude sees.
$Script:OverlayState = [hashtable]::Synchronized(@{ Show = $false; Until = [datetime]::MinValue; Rect = $null; Hwnd = [IntPtr]::Zero; Stop = $false })
try {
    if ($Once) { throw 'overlay skipped in one-shot mode' }
    $rs = [runspacefactory]::CreateRunspace()
    $rs.ApartmentState = 'STA'; $rs.ThreadOptions = 'ReuseThread'; $rs.Open()
    $rs.SessionStateProxy.SetVariable('State', $Script:OverlayState)
    $overlayPs = [powershell]::Create(); $overlayPs.Runspace = $rs
    [void]$overlayPs.AddScript({
        try {
            Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing
            Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class ClaudeOverlayNative {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
            $orange = [System.Drawing.Color]::FromArgb(255, 140, 0)
            # Thicker border reads as a softer "glow"; the pulse (below) breathes its opacity + amber shimmer.
            $barH = 26; $th = 8
            $form = New-Object System.Windows.Forms.Form
            $form.FormBorderStyle = 'None'; $form.ShowInTaskbar = $false; $form.TopMost = $true
            $form.StartPosition = 'Manual'; $form.BackColor = $orange; $form.Visible = $false
            # Opacity < 1 makes WinForms apply the LAYERED alpha - WITHOUT this the manual WS_EX_LAYERED
            # composites the window fully transparent (invisible), which is why the frame never showed.
            $form.Opacity = 0.9
            # Suppress the brief startup flash from Application.Run showing the form before the timer.
            $form.Add_Shown({ try { $form.Hide() } catch {} })
            $label = New-Object System.Windows.Forms.Label
            $label.Text = "  Claude is controlling Tally - please don't use the keyboard or mouse  "
            $label.Dock = 'Top'; $label.Height = $barH; $label.TextAlign = 'MiddleCenter'
            $label.BackColor = $orange; $label.ForeColor = [System.Drawing.Color]::White
            $label.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
            $form.Controls.Add($label)
            $form.Add_HandleCreated({
                # Make the window click-through + non-activating: WS_EX_LAYERED|TRANSPARENT|TOOLWINDOW|NOACTIVATE
                $ex = [ClaudeOverlayNative]::GetWindowLong($form.Handle, -20)
                [void][ClaudeOverlayNative]::SetWindowLong($form.Handle, -20, ($ex -bor 0x80000 -bor 0x20 -bor 0x80 -bor 0x8000000))
            })
            # Glow pulse counter (mutable-by-ref hashtable so the timer closure can bump it).
            $glow = @{ n = 0 }
            $timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 100
            $timer.Add_Tick({
                try {
                    if ($State.Stop) { $timer.Stop(); $form.Close(); return }
                    $active = $State.Show -and ((Get-Date) -lt $State.Until)
                    if (-not $active) { if ($form.Visible) { $form.Hide() }; return }

                    # LIVE window rect: re-read every tick so the frame FOLLOWS a window that is moved,
                    # resized or (un)maximized while Claude is driving. Fall back to the rect captured
                    # when the overlay was last shown if the live read fails.
                    $r = $null
                    try {
                        $hwnd = [IntPtr]$State.Hwnd
                        if ($hwnd -ne [IntPtr]::Zero) {
                            $wr = New-Object ClaudeOverlayNative+RECT
                            if ([ClaudeOverlayNative]::GetWindowRect($hwnd, [ref]$wr)) {
                                $r = @{ Left = $wr.Left; Top = $wr.Top; Width = ($wr.Right - $wr.Left); Height = ($wr.Bottom - $wr.Top) }
                            }
                        }
                    } catch {}
                    if (-not $r) { $r = $State.Rect }
                    if (-not $r) { if ($form.Visible) { $form.Hide() }; return }

                    # Clamp to the target monitor's visible work area so the frame is ALWAYS on-screen. A
                    # maximized Tally overhangs the monitor by a few px, which used to push the top banner
                    # (and the outside borders) off-screen - the reason it wasn't visible in full screen.
                    $rect = New-Object System.Drawing.Rectangle ([int]$r.Left), ([int]$r.Top), ([int]$r.Width), ([int]$r.Height)
                    $wa = ([System.Windows.Forms.Screen]::FromRectangle($rect)).WorkingArea
                    $left   = [Math]::Max([int]$r.Left, $wa.Left)
                    $top    = [Math]::Max([int]$r.Top,  $wa.Top)
                    $right  = [Math]::Min([int]$r.Left + [int]$r.Width,  $wa.Right)
                    $bottom = [Math]::Min([int]$r.Top  + [int]$r.Height, $wa.Bottom)
                    $vw = $right - $left; $vh = $bottom - $top
                    if ($vw -le (2 * $th) -or $vh -le ($barH + $th)) { if ($form.Visible) { $form.Hide() }; return }

                    # Mode A (windowed, with room): float the banner ABOVE the window and hug the OUTSIDE
                    # edges so no Tally content is covered. Mode B (maximized / hard against a screen edge):
                    # INSET the frame inside the visible area with the banner along the top, so both the
                    # banner text and the glowing border stay on-screen.
                    $fitsAbove = ($top - $barH) -ge $wa.Top
                    $fitsSides = (($left - $th) -ge $wa.Left) -and (($right + $th) -le $wa.Right) -and (($bottom + $th) -le $wa.Bottom)
                    if ($fitsAbove -and $fitsSides) {
                        $fLeft = $left - $th; $fTop = $top - $barH; $fW = $vw + 2 * $th; $fH = $vh + $barH + $th
                    } else {
                        $fLeft = $left; $fTop = $top; $fW = $vw; $fH = $vh
                    }
                    $form.Bounds = New-Object System.Drawing.Rectangle $fLeft, $fTop, $fW, $fH
                    $rgn = New-Object System.Drawing.Region (New-Object System.Drawing.Rectangle 0, 0, $fW, $fH)
                    $rgn.Exclude((New-Object System.Drawing.Rectangle $th, $barH, ($fW - 2 * $th), ($fH - $barH - $th)))
                    $form.Region = $rgn

                    # Glow: breathe the opacity and shimmer the frame from deep orange toward hot amber.
                    $glow.n = ($glow.n + 1) % 100000
                    $phase = ([Math]::Sin($glow.n * 0.22) + 1) / 2       # 0..1, ~2.9s cycle at 100ms
                    $form.Opacity = 0.70 + 0.25 * $phase                  # 0.70 .. 0.95
                    $gc = [int](120 + 70 * $phase)                        # green channel 120..190 (orange->amber)
                    $col = [System.Drawing.Color]::FromArgb(255, $gc, 0)
                    $form.BackColor = $col; $label.BackColor = $col

                    if (-not $form.Visible) { $form.Show() }
                    $form.TopMost = $true
                } catch {}
            })
            $timer.Start()
            [System.Windows.Forms.Application]::Run($form)
        } catch {}
    })
    [void]$overlayPs.BeginInvoke()
    Write-Host "[overlay] Claude-control indicator ready"
} catch { $Script:OverlayState = $null; Write-Host "[overlay] unavailable (non-fatal): $_" }

function Show-ClaudeOverlay {
    if (-not $Script:OverlayState) { return }
    try {
        $hwnd = Find-TallyWindow
        if ($hwnd -ne [IntPtr]::Zero) {
            $rect = New-Object TallyUI2+RECT
            [void][TallyUI2]::GetWindowRect($hwnd, [ref]$rect)
            $Script:OverlayState.Rect = @{ Left = $rect.Left; Top = $rect.Top; Width = ($rect.Right - $rect.Left); Height = ($rect.Bottom - $rect.Top) }
            # Publish the hwnd so the overlay's own timer can re-read the LIVE rect each tick and follow
            # the window (moved / resized / maximized) instead of freezing at this captured snapshot.
            $Script:OverlayState.Hwnd = $hwnd
            $Script:OverlayState.Show = $true
            $Script:OverlayState.Until = (Get-Date).AddSeconds(6)
        }
    } catch {}
}
function Hide-ClaudeOverlay { if ($Script:OverlayState) { try { $Script:OverlayState.Show = $false } catch {} } }

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

        # Show the "Claude is controlling Tally" frame for GUI-driving commands (screenshot/ping
        # excluded - screenshot must be clean, ping is passive). Auto-hides ~6s after the last action.
        if (@('sendkeys','select-and-unlock-company','switch-company','start-tally') -contains ([string]$cmd.action)) {
            if (Get-Command Show-ClaudeOverlay -ErrorAction SilentlyContinue) { Show-ClaudeOverlay }
        }

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
                    } else {
                        [TallyUI2]::ForceForeground($hwnd) | Out-Null
                        Start-Sleep -Milliseconds 300
                        $done = 0
                        foreach ($step in @($cmd.keys)) {
                            if ($null -eq $step -or -not $step.action) { continue }
                            if ([TallyUI2]::GetForegroundWindow() -ne $hwnd) {
                                [TallyUI2]::ForceForeground($hwnd) | Out-Null
                                Start-Sleep -Milliseconds 200
                            }
                            Execute-Action -Action $step
                            $done++
                        }
                        Write-Result -Status "success" -Message "Executed $done key action(s)" -Strategy "sendkeys" -CommandId $cmdId -Extra @{ steps = $done }
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
                        } else {
                            [TallyUI2]::ForceForeground($hwnd) | Out-Null
                            Start-Sleep -Milliseconds 500

                            # Reset to a known state by Escaping out of any wedged dialog from a prior run.
                            # Two Escapes is safe: closes innermost dialog, then any outer modal. If we were already
                            # at the bare Select Company list, Escape there is a no-op.
                            [TallyUI2]::PressKey([TallyUI2]::VK_ESCAPE)
                            Start-Sleep -Milliseconds 300
                            [TallyUI2]::PressKey([TallyUI2]::VK_ESCAPE)
                            Start-Sleep -Milliseconds 500

                            # Type the company id (folder id) directly into the Select Company list.
                            # Tally auto-jumps the highlight to the matching folder as we type.
                            [TallyUI2]::TypeString($companyId)
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
                                [TallyUI2]::PressKey([TallyUI2]::VK_RETURN)
                                if ($_ep -lt ($enterPresses - 1)) {
                                    # Inter-Enter wait: let Tally render the folder contents before the next Enter.
                                    Start-Sleep -Milliseconds 1500
                                }
                            }
                            Start-Sleep -Milliseconds $waitMsAfterEnter

                            # If credentials were supplied, enter them
                            if ($userName) {
                                [TallyUI2]::TypeString($userName)
                                Start-Sleep -Milliseconds 300
                                [TallyUI2]::PressKey([TallyUI2]::VK_TAB)
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
                                [TallyUI2]::TypeString($password)
                                Start-Sleep -Milliseconds 300
                            }
                            if ($userName -or $password) {
                                [TallyUI2]::PressKey([TallyUI2]::VK_RETURN)
                                Start-Sleep -Milliseconds $waitMsAfterCreds
                            }

                            # VERIFY GROUND TRUTH before claiming success. Everything above is open-loop:
                            # Tally may have rejected the password, the list may never have had focus, or
                            # the wrong folder/company may have been highlighted. Ask Tally what is actually
                            # loaded and let the verifier report success / error / unverified accordingly,
                            # instead of unconditionally reporting "keystrokes sent" as success.
                            $ctx = if ($userName -or $password) { " with credentials" } else { "" }
                            Write-VerifiedLoadResult -Requested $companyId -Strategy "select-and-unlock" -CommandId $cmdId -Context $ctx
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
                        } else {
                            [TallyUI2]::ForceForeground($hwnd) | Out-Null
                            Start-Sleep -Milliseconds 500

                            # PREFIX: open the Select Company list on the running Tally (Alt+F3 -> F1).
                            [TallyUI2]::PressCombo([TallyUI2]::VK_MENU, [TallyUI2]::VK_F3)
                            Start-Sleep -Milliseconds 800
                            [TallyUI2]::PressKey([TallyUI2]::VK_F1)
                            Start-Sleep -Milliseconds 900

                            # TAIL: type the folder id; Tally auto-jumps the highlight to the matching folder.
                            [TallyUI2]::TypeString($companyId)
                            Start-Sleep -Milliseconds 800

                            # folder -> company drill (default 2 Enters), same as select-and-unlock-company.
                            $enterPresses = if ($cmd.enterPresses) { [int]$cmd.enterPresses } else { 2 }
                            if ($enterPresses -lt 1) { $enterPresses = 1 }
                            if ($enterPresses -gt 4) { $enterPresses = 4 }
                            for ($_ep = 0; $_ep -lt $enterPresses; $_ep++) {
                                [TallyUI2]::PressKey([TallyUI2]::VK_RETURN)
                                if ($_ep -lt ($enterPresses - 1)) {
                                    Start-Sleep -Milliseconds 1500
                                }
                            }
                            Start-Sleep -Milliseconds $waitMsAfterEnter

                            # Credentials, if the company is protected. TypeString (scan-code) not clipboard paste:
                            # masked/TallyVault fields can silently reject a paste, so char typing is safer here.
                            if ($userName) {
                                [TallyUI2]::TypeString($userName)
                                Start-Sleep -Milliseconds 300
                                [TallyUI2]::PressKey([TallyUI2]::VK_TAB)
                                Start-Sleep -Milliseconds 300
                            }
                            if ($password) {
                                if ([TallyUI2]::GetForegroundWindow() -ne $hwnd) {
                                    [TallyUI2]::ForceForeground($hwnd) | Out-Null
                                    Start-Sleep -Milliseconds 300
                                }
                                [TallyUI2]::TypeString($password)
                                Start-Sleep -Milliseconds 300
                            }
                            if ($userName -or $password) {
                                [TallyUI2]::PressKey([TallyUI2]::VK_RETURN)
                                Start-Sleep -Milliseconds $waitMsAfterCreds
                            }

                            # CHECKPOINT: ground-truth verify (get-period / loaded-list agrees). Prefer the real
                            # display name for the match; fall back to the folder id.
                            $requested = if ($companyName) { $companyName } else { $companyId }
                            $ctx = if ($userName -or $password) { " with credentials" } else { "" }
                            Write-VerifiedLoadResult -Requested $requested -Strategy "switch-company" -CommandId $cmdId -Context $ctx
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
                        } else {
                            [TallyUI2]::ForceForeground($hwnd) | Out-Null
                            Start-Sleep -Milliseconds 300
                            [TallyUI2]::PressKey($vk)
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
                        } else {
                            [TallyUI2]::ForceForeground($hwnd) | Out-Null
                            Start-Sleep -Milliseconds 300
                            [TallyUI2]::TypeString($text)
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
                # Quick state probe + focus. Useful before a Claude-driven sequence to make
                # sure subsequent press-key / type-text actions land in Tally and not in
                # some other window the user accidentally clicked into.
                try {
                    $hwnd = Find-TallyWindow
                    if ($hwnd -eq [IntPtr]::Zero) {
                        Write-Result -Status "error" -Message (Get-TallyResolveMessage) -Strategy "bring-foreground" -CommandId $cmdId
                    } else {
                        [TallyUI2]::ForceForeground($hwnd) | Out-Null
                        Start-Sleep -Milliseconds 300
                        Write-Result -Status "success" -Message "Tally brought to foreground" -Strategy "bring-foreground" -CommandId $cmdId
                    }
                } catch {
                    Write-Result -Status "error" -Message "Exception: $_" -Strategy "bring-foreground" -CommandId $cmdId
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
