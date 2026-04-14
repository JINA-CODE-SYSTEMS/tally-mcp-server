# MCP Tally Company Loader - Enhanced UI Automation
# Uses Win32 APIs for reliable window focus and key simulation
# Unlike SendKeys, this properly brings Tally to foreground before input

param(
    [Parameter(Mandatory=$true)]
    [string]$TallyExePath,
    
    [Parameter(Mandatory=$true)]
    [string]$CompanyDataPath,

    [Parameter(Mandatory=$false)]
    [int]$StartupWaitSeconds = 10,

    [Parameter(Mandatory=$false)]
    [int]$MaxRetries = 5
)

# Load Win32 interop for window management
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;

public class TallyWin32 {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    
    [DllImport("user32.dll")]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);
    
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    
    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    
    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    public const int SW_RESTORE = 9;
    public const int SW_SHOW = 5;
    public const byte VK_RETURN = 0x0D;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    
    // Force window to foreground using thread input attachment trick
    public static bool ForceForeground(IntPtr targetHwnd) {
        IntPtr foregroundHwnd = GetForegroundWindow();
        if (foregroundHwnd == targetHwnd) return true;
        
        uint foregroundThread = 0;
        uint foregroundPid = 0;
        uint targetThread = 0;
        uint targetPid = 0;
        
        foregroundThread = GetWindowThreadProcessId(foregroundHwnd, out foregroundPid);
        targetThread = GetWindowThreadProcessId(targetHwnd, out targetPid);
        
        // Attach input threads to allow SetForegroundWindow to work
        if (foregroundThread != targetThread) {
            AttachThreadInput(foregroundThread, targetThread, true);
        }
        
        ShowWindow(targetHwnd, SW_RESTORE);
        BringWindowToTop(targetHwnd);
        bool result = SetForegroundWindow(targetHwnd);
        
        if (foregroundThread != targetThread) {
            AttachThreadInput(foregroundThread, targetThread, false);
        }
        
        return result;
    }
    
    public static void SendEnterKey() {
        keybd_event(VK_RETURN, 0, 0, 0);           // key down
        System.Threading.Thread.Sleep(50);
        keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, 0); // key up
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

# --- Main execution ---
Write-Output "=== MCP Tally Company Loader ==="
Write-Output "Tally executable: $TallyExePath"
Write-Output "Company data path: $CompanyDataPath"

# Step 1: Kill existing Tally process
Write-Output "Stopping existing Tally process..."
$existingTally = Get-Process -Name "tally" -ErrorAction SilentlyContinue
if ($existingTally) {
    Stop-Process -Name "tally" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    Write-Output "Tally process stopped."
} else {
    Write-Output "No existing Tally process found."
}

# Step 2: Start Tally with /path: argument pointing to company data folder
Write-Output "Starting Tally with /path:$CompanyDataPath ..."
Start-Process -FilePath $TallyExePath -ArgumentList "/path:$CompanyDataPath"

# Step 3: Wait for Tally window to appear
Write-Output "Waiting for Tally window ($StartupWaitSeconds seconds)..."
Start-Sleep -Seconds $StartupWaitSeconds

# Step 4: Find Tally window and force foreground
$hwnd = Find-TallyWindow
if ($hwnd -eq [IntPtr]::Zero) {
    Write-Output "ERROR: Could not find Tally window. Tally may not have started."
    exit 1
}

Write-Output "Found Tally window handle: $hwnd"

# Step 5: Bring Tally to foreground and send Enter key
# Try multiple times with delays (Tally GUI may take time to render the Select Company dialog)
$success = $false
for ($i = 0; $i -lt $MaxRetries; $i++) {
    Write-Output "Attempt $($i + 1) of $MaxRetries - Focusing Tally window..."
    
    # Refresh handle in case it changed
    $hwnd = Find-TallyWindow
    if ($hwnd -eq [IntPtr]::Zero) {
        Write-Output "  Window handle lost, waiting..."
        Start-Sleep -Seconds 2
        continue
    }
    
    # Force foreground using thread attachment
    $focused = [TallyWin32]::ForceForeground($hwnd)
    Write-Output "  SetForegroundWindow result: $focused"
    
    Start-Sleep -Milliseconds 500
    
    # Verify we have foreground
    $fgHwnd = [TallyWin32]::GetForegroundWindow()
    if ($fgHwnd -eq $hwnd) {
        Write-Output "  Tally is now in foreground. Sending Enter key..."
        [TallyWin32]::SendEnterKey()
        Start-Sleep -Milliseconds 200
        [TallyWin32]::SendEnterKey()  # Second Enter for safety
        $success = $true
        break
    } else {
        Write-Output "  Foreground window mismatch. Retrying in 2 seconds..."
        Start-Sleep -Seconds 2
    }
}

if ($success) {
    Write-Output "SUCCESS: Enter key sent to Tally. Company should be loading."
} else {
    Write-Output "WARNING: Could not reliably focus Tally window after $MaxRetries attempts."
    Write-Output "Attempting fallback: sending Enter anyway..."
    [TallyWin32]::SendEnterKey()
    Start-Sleep -Milliseconds 200
    [TallyWin32]::SendEnterKey()
}

Write-Output "Done. Waiting 5 seconds for company to load..."
Start-Sleep -Seconds 5
Write-Output "=== Script complete ==="
