# MCP Tally GUI Agent - Runs in the interactive user session
# Watches for command files from the MCP server and executes GUI automation
# against the Tally Prime window (keystrokes, menu navigation)
#
# INSTALL: Run this at user login (e.g., via Startup folder or Task Scheduler)
#   powershell -ExecutionPolicy Bypass -File "C:\path\to\tally-gui-agent.ps1"

param(
    [string]$WatchDir = $null  # Directory to watch for command files
)

# Resolve watch directory from TALLY_DATA_PATH or default
if (-not $WatchDir) {
    $WatchDir = if ($env:TALLY_DATA_PATH) { $env:TALLY_DATA_PATH } else { "C:\Users\Public\TallyPrimeEditLog\data" }
}

$CommandFile = Join-Path $WatchDir "_mcp_gui_command.json"
$ResultFile  = Join-Path $WatchDir "_mcp_gui_result.json"

Write-Host "=== MCP Tally GUI Agent ==="
Write-Host "Watching: $CommandFile"
Write-Host "Results:  $ResultFile"

# --- Win32 interop ---
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class TallyUI {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, uint extra);
    [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    public const int SW_RESTORE = 9;
    public const byte VK_RETURN  = 0x0D;
    public const byte VK_ESCAPE  = 0x1B;
    public const byte VK_MENU    = 0x12;  // Alt key
    public const byte VK_F3      = 0x72;
    public const byte VK_SHIFT   = 0x10;
    public const byte VK_DOWN    = 0x28;
    public const byte VK_UP      = 0x26;
    public const byte VK_BACK    = 0x08;
    public const uint KEYEVENTF_KEYUP = 0x0002;

    public static bool ForceForeground(IntPtr hwnd) {
        IntPtr fg = GetForegroundWindow();
        if (fg == hwnd) return true;

        uint fgThread, fgPid, tThread, tPid;
        fgThread = GetWindowThreadProcessId(fg, out fgPid);
        tThread  = GetWindowThreadProcessId(hwnd, out tPid);

        if (fgThread != tThread)
            AttachThreadInput(fgThread, tThread, true);

        ShowWindow(hwnd, SW_RESTORE);
        BringWindowToTop(hwnd);
        bool ok = SetForegroundWindow(hwnd);

        if (fgThread != tThread)
            AttachThreadInput(fgThread, tThread, false);

        return ok;
    }

    public static void PressKey(byte vk) {
        keybd_event(vk, 0, 0, 0);
        Thread.Sleep(30);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
        Thread.Sleep(80);
    }

    public static void PressAltKey(byte vk) {
        keybd_event(VK_MENU, 0, 0, 0);        // Alt down
        Thread.Sleep(30);
        keybd_event(vk, 0, 0, 0);              // key down
        Thread.Sleep(30);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);  // key up
        Thread.Sleep(30);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);  // Alt up
        Thread.Sleep(100);
    }

    public static void TypeString(string text) {
        foreach (char c in text) {
            short vk = VkKeyScan(c);
            byte lo = (byte)(vk & 0xFF);
            bool needShift = ((vk >> 8) & 1) != 0;
            if (needShift) keybd_event(VK_SHIFT, 0, 0, 0);
            keybd_event(lo, 0, 0, 0);
            Thread.Sleep(20);
            keybd_event(lo, 0, KEYEVENTF_KEYUP, 0);
            if (needShift) keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, 0);
            Thread.Sleep(40);
        }
    }
}
"@

function Find-TallyWindow {
    $proc = Get-Process -Name "tally" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
        return $proc.MainWindowHandle
    }
    return [IntPtr]::Zero
}

function Write-Result {
    param([string]$Status, [string]$Message, [string]$Strategy)
    $result = @{
        status    = $Status
        message   = $Message
        strategy  = $Strategy
        timestamp = (Get-Date -Format "o")
    } | ConvertTo-Json -Depth 3
    [System.IO.File]::WriteAllText($ResultFile, $result, [System.Text.Encoding]::UTF8)
    Write-Host "[$Status] $Message"
}

function Invoke-SelectCompany {
    param([string]$CompanyName)

    $hwnd = Find-TallyWindow
    if ($hwnd -eq [IntPtr]::Zero) {
        Write-Result -Status "error" -Message "Tally window not found. Is Tally Prime running?" -Strategy "gui-select"
        return $false
    }

    # Step 1: Focus the Tally window
    Write-Host "  Focusing Tally window..."
    $focused = [TallyUI]::ForceForeground($hwnd)
    if (-not $focused) {
        Write-Result -Status "error" -Message "Could not focus Tally window" -Strategy "gui-select"
        return $false
    }
    Start-Sleep -Milliseconds 500

    # Step 2: Press Escape a few times to get to Gateway (clear any open dialogs)
    Write-Host "  Clearing dialogs (Escape x3)..."
    for ($i = 0; $i -lt 3; $i++) {
        [TallyUI]::PressKey([TallyUI]::VK_ESCAPE)
        Start-Sleep -Milliseconds 300
    }
    Start-Sleep -Milliseconds 500

    # Step 3: Alt+F3 to open "Select Company" / Company Info
    Write-Host "  Sending Alt+F3 (Select Company)..."
    [TallyUI]::PressAltKey([TallyUI]::VK_F3)
    Start-Sleep -Seconds 1

    # Step 4: Press 'S' to select "Select Company" option (if Company Info menu appeared)
    # In Tally Prime, Alt+F3 from Gateway opens Company Info with options:
    #   Select Cmp / Shut Cmp / Create Cmp / Alter / ...
    # Pressing 'S' selects "Select Cmp"
    Write-Host "  Pressing 'S' (Select Cmp)..."
    [TallyUI]::TypeString("S")
    Start-Sleep -Seconds 1

    # Step 5: Press Enter to confirm Select Company
    [TallyUI]::PressKey([TallyUI]::VK_RETURN)
    Start-Sleep -Seconds 2

    # Step 6: Now in the company list - type the company name to filter
    Write-Host "  Typing company name: $CompanyName"
    [TallyUI]::TypeString($CompanyName)
    Start-Sleep -Seconds 1

    # Step 7: Press Enter to select the company
    Write-Host "  Pressing Enter to load company..."
    [TallyUI]::PressKey([TallyUI]::VK_RETURN)
    Start-Sleep -Seconds 3

    # Step 8: Press Enter again in case there's a confirmation
    [TallyUI]::PressKey([TallyUI]::VK_RETURN)
    Start-Sleep -Seconds 2

    Write-Result -Status "success" -Message "GUI automation completed for company: $CompanyName" -Strategy "gui-select"
    return $true
}

function Invoke-LoadOnStartup {
    # When Tally is on the Select Company screen (just started), press Enter to load the first/default company
    param([string]$CompanyName)

    $hwnd = Find-TallyWindow
    if ($hwnd -eq [IntPtr]::Zero) {
        Write-Result -Status "error" -Message "Tally window not found" -Strategy "gui-startup"
        return $false
    }

    Write-Host "  Focusing Tally window..."
    [TallyUI]::ForceForeground($hwnd)
    Start-Sleep -Milliseconds 500

    if ($CompanyName) {
        Write-Host "  Typing company name: $CompanyName"
        [TallyUI]::TypeString($CompanyName)
        Start-Sleep -Seconds 1
    }

    Write-Host "  Pressing Enter..."
    [TallyUI]::PressKey([TallyUI]::VK_RETURN)
    Start-Sleep -Seconds 3
    [TallyUI]::PressKey([TallyUI]::VK_RETURN)
    Start-Sleep -Seconds 2

    Write-Result -Status "success" -Message "Startup load completed for: $CompanyName" -Strategy "gui-startup"
    return $true
}

# --- Main watch loop ---
Write-Host "Agent started. Polling every 500ms for commands..."

while ($true) {
    if (Test-Path $CommandFile) {
        try {
            Start-Sleep -Milliseconds 200  # Let the file finish writing
            $cmdText = [System.IO.File]::ReadAllText($CommandFile, [System.Text.Encoding]::UTF8)
            $cmd = $cmdText | ConvertFrom-Json

            # Delete command file immediately to prevent re-execution
            Remove-Item $CommandFile -Force -ErrorAction SilentlyContinue

            Write-Host "`n--- Received command: $($cmd.action) ---"

            switch ($cmd.action) {
                "select-company" {
                    Invoke-SelectCompany -CompanyName $cmd.companyName
                }
                "load-on-startup" {
                    Invoke-LoadOnStartup -CompanyName $cmd.companyName
                }
                "ping" {
                    Write-Result -Status "success" -Message "Agent is alive" -Strategy "ping"
                }
                "exit" {
                    Write-Result -Status "success" -Message "Agent shutting down" -Strategy "exit"
                    Write-Host "Exiting..."
                    exit 0
                }
                default {
                    Write-Result -Status "error" -Message "Unknown action: $($cmd.action)" -Strategy "unknown"
                }
            }
        }
        catch {
            Write-Host "Error processing command: $_"
            Write-Result -Status "error" -Message "Exception: $_" -Strategy "error"
            Remove-Item $CommandFile -Force -ErrorAction SilentlyContinue
        }
    }

    Start-Sleep -Milliseconds 500
}
