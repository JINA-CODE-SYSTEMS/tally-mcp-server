# MCP Tally GUI Agent v2 — LLM-Guided (Computer Use style)
# Takes screenshots of the Tally window, sends to an LLM for analysis,
# executes the LLM's recommended action, and loops until the goal is achieved.
#
# RUN: In the interactive desktop session where Tally is visible
#   powershell -ExecutionPolicy Bypass -File tally-gui-agent-v2.ps1
#
# REQUIRES: ANTHROPIC_API_KEY or OPENAI_API_KEY in environment

param(
    [string]$WatchDir = $null,
    [string]$LLMProvider = $null,   # "anthropic" or "openai" (auto-detected from available API key)
    [int]$MaxSteps = 15             # Safety limit per command
)

if (-not $WatchDir) {
    $WatchDir = if ($env:TALLY_DATA_PATH) { $env:TALLY_DATA_PATH } else { "C:\Users\Public\TallyPrimeEditLog\data" }
}

$CommandFile = Join-Path $WatchDir "_mcp_gui_command.json"
$ResultFile  = Join-Path $WatchDir "_mcp_gui_result.json"

# --- Detect LLM provider ---
if (-not $LLMProvider) {
    if ($env:ANTHROPIC_API_KEY) { $LLMProvider = "anthropic" }
    elseif ($env:OPENAI_API_KEY) { $LLMProvider = "openai" }
    else {
        Write-Host "[ERROR] Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable."
        exit 1
    }
}
Write-Host "LLM Provider: $LLMProvider"

# --- Win32 interop ---
Add-Type @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;

public class TallyUI2 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, uint extra);
    [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public const int SW_RESTORE = 9;
    public const byte VK_RETURN  = 0x0D;
    public const byte VK_ESCAPE  = 0x1B;
    public const byte VK_MENU    = 0x12;
    public const byte VK_CONTROL = 0x11;
    public const byte VK_SHIFT   = 0x10;
    public const byte VK_TAB     = 0x09;
    public const byte VK_BACK    = 0x08;
    public const byte VK_F1      = 0x70;
    public const byte VK_F2      = 0x71;
    public const byte VK_F3      = 0x72;
    public const byte VK_F4      = 0x73;
    public const byte VK_F5      = 0x74;
    public const byte VK_F10     = 0x79;
    public const byte VK_F12     = 0x7B;
    public const byte VK_DOWN    = 0x28;
    public const byte VK_UP      = 0x26;
    public const byte VK_LEFT    = 0x25;
    public const byte VK_RIGHT   = 0x27;
    public const uint KEYEVENTF_KEYUP = 0x0002;

    public static bool ForceForeground(IntPtr hwnd) {
        IntPtr fg = GetForegroundWindow();
        if (fg == hwnd) return true;
        uint fgThread, fgPid, tThread, tPid;
        fgThread = GetWindowThreadProcessId(fg, out fgPid);
        tThread  = GetWindowThreadProcessId(hwnd, out tPid);
        if (fgThread != tThread) AttachThreadInput(fgThread, tThread, true);
        ShowWindow(hwnd, SW_RESTORE);
        BringWindowToTop(hwnd);
        bool ok = SetForegroundWindow(hwnd);
        if (fgThread != tThread) AttachThreadInput(fgThread, tThread, false);
        return ok;
    }

    public static void PressKey(byte vk) {
        keybd_event(vk, 0, 0, 0);
        Thread.Sleep(30);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
        Thread.Sleep(100);
    }

    public static void PressCombo(byte modifier, byte key) {
        keybd_event(modifier, 0, 0, 0);
        Thread.Sleep(30);
        keybd_event(key, 0, 0, 0);
        Thread.Sleep(30);
        keybd_event(key, 0, KEYEVENTF_KEYUP, 0);
        Thread.Sleep(30);
        keybd_event(modifier, 0, KEYEVENTF_KEYUP, 0);
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

    // Capture screenshot of a specific window
    public static Bitmap CaptureWindow(IntPtr hwnd) {
        RECT rect;
        GetWindowRect(hwnd, out rect);
        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0) return null;
        Bitmap bmp = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        using (Graphics g = Graphics.FromImage(bmp)) {
            g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height));
        }
        return bmp;
    }
}
"@ -ReferencedAssemblies System.Drawing

function Find-TallyWindow {
    $proc = Get-Process -Name "tally" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
        return $proc.MainWindowHandle
    }
    return [IntPtr]::Zero
}

function Get-Screenshot {
    param([IntPtr]$Hwnd)
    $screenshotPath = Join-Path $WatchDir "_mcp_screenshot.png"
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

function Invoke-LLM {
    param([string]$ScreenshotPath, [string]$Goal, [string]$PreviousActions)

    $imageBytes = [System.IO.File]::ReadAllBytes($ScreenshotPath)
    $base64Image = [Convert]::ToBase64String($imageBytes)

    $systemPrompt = @"
You are a GUI automation agent controlling Tally Prime accounting software on Windows.
You can see a screenshot of the Tally window and must decide the SINGLE next action to take.

TALLY PRIME KEYBOARD SHORTCUTS:
- Alt+F3: Company Info menu (Select/Shut/Create/Alter company)
- F1: Select/open items in lists
- Enter: Confirm/select
- Escape: Go back/cancel
- Alt+F1: Detailed view
- Alt+F2: Change period
- Ctrl+A: Alter
- Arrow keys: Navigate lists

IMPORTANT RULES:
- Return EXACTLY ONE action per response
- If the goal appears achieved (company is loaded, shown in title bar or Gateway), return {"action":"done","reason":"..."}
- If stuck after multiple attempts, return {"action":"fail","reason":"..."}
- Be precise with text — company names are case-sensitive in Tally

RESPOND WITH ONLY A JSON OBJECT, no other text:
{"action":"<action_type>","value":"<value>","reason":"<brief explanation>"}

Action types:
- "key": Press a key. value = "enter"|"escape"|"tab"|"backspace"|"up"|"down"|"left"|"right"|"f1"|"f2"|"f3"|"f4"|"f5"|"f10"|"f12"
- "combo": Key combo. value = "alt+f3"|"alt+f1"|"alt+f2"|"ctrl+a"|etc.
- "type": Type text. value = the text to type
- "wait": Wait and take another screenshot. value = milliseconds (e.g. "2000")
- "done": Goal achieved.
- "fail": Cannot achieve goal.
"@

    $userMessage = "GOAL: $Goal`n`nPREVIOUS ACTIONS TAKEN:`n$PreviousActions`n`nLook at the screenshot and decide the next single action."

    if ($LLMProvider -eq "anthropic") {
        return Invoke-Claude -SystemPrompt $systemPrompt -UserMessage $userMessage -Base64Image $base64Image
    } else {
        return Invoke-OpenAI -SystemPrompt $systemPrompt -UserMessage $userMessage -Base64Image $base64Image
    }
}

function Invoke-Claude {
    param([string]$SystemPrompt, [string]$UserMessage, [string]$Base64Image)

    $body = @{
        model = "claude-sonnet-4-20250514"
        max_tokens = 300
        system = $SystemPrompt
        messages = @(
            @{
                role = "user"
                content = @(
                    @{
                        type = "image"
                        source = @{
                            type = "base64"
                            media_type = "image/png"
                            data = $Base64Image
                        }
                    },
                    @{
                        type = "text"
                        text = $UserMessage
                    }
                )
            }
        )
    } | ConvertTo-Json -Depth 10

    $headers = @{
        "x-api-key" = $env:ANTHROPIC_API_KEY
        "anthropic-version" = "2023-06-01"
        "content-type" = "application/json"
    }

    try {
        $response = Invoke-RestMethod -Uri "https://api.anthropic.com/v1/messages" -Method POST -Headers $headers -Body $body -TimeoutSec 30
        $text = $response.content[0].text
        Write-Host "  LLM response: $text"
        return $text | ConvertFrom-Json
    } catch {
        Write-Host "  Claude API error: $_"
        return @{ action = "fail"; reason = "API error: $_" }
    }
}

function Invoke-OpenAI {
    param([string]$SystemPrompt, [string]$UserMessage, [string]$Base64Image)

    $body = @{
        model = "gpt-4o"
        max_tokens = 300
        messages = @(
            @{ role = "system"; content = $SystemPrompt },
            @{
                role = "user"
                content = @(
                    @{
                        type = "image_url"
                        image_url = @{ url = "data:image/png;base64,$Base64Image" }
                    },
                    @{ type = "text"; text = $UserMessage }
                )
            }
        )
    } | ConvertTo-Json -Depth 10

    $headers = @{
        "Authorization" = "Bearer $($env:OPENAI_API_KEY)"
        "Content-Type" = "application/json"
    }

    try {
        $response = Invoke-RestMethod -Uri "https://api.openai.com/v1/chat/completions" -Method POST -Headers $headers -Body $body -TimeoutSec 30
        $text = $response.choices[0].message.content
        Write-Host "  LLM response: $text"
        return $text | ConvertFrom-Json
    } catch {
        Write-Host "  OpenAI API error: $_"
        return @{ action = "fail"; reason = "API error: $_" }
    }
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
            $vk = $keyMap[$Action.value.ToLower()]
            if ($vk) {
                Write-Host "  Action: Press $($Action.value)"
                [TallyUI2]::PressKey($vk)
            }
        }
        "combo" {
            $parts = $Action.value.ToLower() -split '\+'
            $modMap = @{ "alt" = [TallyUI2]::VK_MENU; "ctrl" = [TallyUI2]::VK_CONTROL; "shift" = [TallyUI2]::VK_SHIFT }
            $keyMap = @{
                "f1" = [TallyUI2]::VK_F1; "f2" = [TallyUI2]::VK_F2; "f3" = [TallyUI2]::VK_F3
                "f4" = [TallyUI2]::VK_F4; "f5" = [TallyUI2]::VK_F5; "f10" = [TallyUI2]::VK_F10
                "a" = 0x41; "c" = 0x43; "v" = 0x56; "x" = 0x58
            }
            if ($parts.Count -ge 2) {
                $mod = $modMap[$parts[0]]
                $key = $keyMap[$parts[1]]
                if ($mod -and $key) {
                    Write-Host "  Action: Combo $($Action.value)"
                    [TallyUI2]::PressCombo($mod, $key)
                }
            }
        }
        "type" {
            Write-Host "  Action: Type '$($Action.value)'"
            [TallyUI2]::TypeString($Action.value)
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

function Invoke-LLMGuidedAction {
    param([string]$CompanyName, [string]$Action)

    $hwnd = Find-TallyWindow
    if ($hwnd -eq [IntPtr]::Zero) {
        Write-Result -Status "error" -Message "Tally window not found. Is Tally running?" -Strategy "llm-gui"
        return
    }

    # Focus Tally
    [TallyUI2]::ForceForeground($hwnd)
    Start-Sleep -Milliseconds 500

    $goal = if ($Action -eq "select-company") {
        "Open/load the company named '$CompanyName' in Tally Prime. Navigate to Company Info (Alt+F3), select the company, and load it. The goal is achieved when the company name appears in the Tally title bar or Gateway screen."
    } elseif ($Action -eq "load-on-startup") {
        "Tally just started and is showing the Select Company screen. Load the company named '$CompanyName'. Type the name to filter, then select it."
    } else {
        "Perform action: $Action for company '$CompanyName'"
    }

    $actionHistory = ""
    $stepCount = 0

    Write-Host "  Goal: $goal"
    Write-Host "  Starting LLM-guided loop (max $MaxSteps steps)..."

    for ($step = 0; $step -lt $MaxSteps; $step++) {
        $stepCount++
        Write-Host "`n  --- Step $stepCount ---"

        # Ensure focus
        [TallyUI2]::ForceForeground($hwnd)
        Start-Sleep -Milliseconds 300

        # Take screenshot
        $screenshotPath = Get-Screenshot -Hwnd $hwnd
        if (-not $screenshotPath) {
            Write-Host "  Failed to capture screenshot"
            Start-Sleep -Seconds 1
            continue
        }

        # Ask LLM what to do
        $llmAction = Invoke-LLM -ScreenshotPath $screenshotPath -Goal $goal -PreviousActions $actionHistory

        if ($null -eq $llmAction -or $null -eq $llmAction.action) {
            Write-Host "  LLM returned invalid response, retrying..."
            $actionHistory += "Step ${stepCount}: (invalid response, retried)`n"
            continue
        }

        # Check if done or failed
        if ($llmAction.action -eq "done") {
            Write-Host "  LLM says DONE: $($llmAction.reason)"
            Write-Result -Status "success" -Message "Company '$CompanyName' loaded. LLM: $($llmAction.reason)" -Strategy "llm-gui"
            return
        }
        if ($llmAction.action -eq "fail") {
            Write-Host "  LLM says FAIL: $($llmAction.reason)"
            Write-Result -Status "error" -Message "LLM could not achieve goal: $($llmAction.reason)" -Strategy "llm-gui"
            return
        }

        # Execute the action
        $actionDesc = "$($llmAction.action): $($llmAction.value) ($($llmAction.reason))"
        $actionHistory += "Step ${stepCount}: $actionDesc`n"
        Execute-Action -Action $llmAction
    }

    Write-Result -Status "error" -Message "Reached max steps ($MaxSteps) without achieving goal" -Strategy "llm-gui"
}

# --- Main watch loop ---
Write-Host "=== MCP Tally GUI Agent v2 (LLM-Guided) ==="
Write-Host "Watching: $CommandFile"
Write-Host "Results:  $ResultFile"
Write-Host "Provider: $LLMProvider"
Write-Host "Max steps per command: $MaxSteps"
Write-Host "Agent started. Polling every 500ms for commands..."

while ($true) {
    if (Test-Path $CommandFile) {
        try {
            Start-Sleep -Milliseconds 200
            $cmdText = [System.IO.File]::ReadAllText($CommandFile, [System.Text.Encoding]::UTF8)
            $cmd = $cmdText | ConvertFrom-Json
            Remove-Item $CommandFile -Force -ErrorAction SilentlyContinue

            Write-Host "`n=== Received command: $($cmd.action) ==="

            switch ($cmd.action) {
                "select-company" {
                    Invoke-LLMGuidedAction -CompanyName $cmd.companyName -Action "select-company"
                }
                "load-on-startup" {
                    Invoke-LLMGuidedAction -CompanyName $cmd.companyName -Action "load-on-startup"
                }
                "ping" {
                    Write-Result -Status "success" -Message "Agent v2 is alive (LLM: $LLMProvider)" -Strategy "ping"
                }
                "exit" {
                    Write-Result -Status "success" -Message "Shutting down" -Strategy "exit"
                    exit 0
                }
                default {
                    Write-Result -Status "error" -Message "Unknown action: $($cmd.action)" -Strategy "unknown"
                }
            }
        }
        catch {
            Write-Host "Error: $_"
            Write-Result -Status "error" -Message "Exception: $_" -Strategy "error"
            Remove-Item $CommandFile -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Milliseconds 500
}
