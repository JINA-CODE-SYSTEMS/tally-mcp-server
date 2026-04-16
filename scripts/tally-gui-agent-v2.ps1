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

# --- Configurable LLM settings (override via environment variables) ---
$ClaudeModel   = if ($env:CLAUDE_MODEL)        { $env:CLAUDE_MODEL }        else { "claude-sonnet-4-20250514" }
$OpenAIModel   = if ($env:OPENAI_MODEL)        { $env:OPENAI_MODEL }        else { "gpt-4o" }
$LLMMaxTokens  = if ($env:LLM_MAX_TOKENS)      { [int]$env:LLM_MAX_TOKENS } else { 300 }
$LLMTimeoutSec = if ($env:LLM_TIMEOUT_SEC)     { [int]$env:LLM_TIMEOUT_SEC } else { 30 }
$AnthropicVer  = if ($env:ANTHROPIC_API_VERSION){ $env:ANTHROPIC_API_VERSION } else { "2023-06-01" }

# --- Load precompiled Win32 interop DLL (avoids AMSI/Defender false positives from inline Add-Type) ---
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dllPath = Join-Path $scriptDir "TallyUI.dll"
if (-not (Test-Path $dllPath)) {
    Write-Host "[ERROR] TallyUI.dll not found at $dllPath"
    Write-Host "  Run: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:library /reference:System.Drawing.dll /out:scripts\TallyUI.dll scripts\TallyUI.cs"
    exit 1
}
Add-Type -Path $dllPath

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
        model = $ClaudeModel
        max_tokens = $LLMMaxTokens
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
        "anthropic-version" = $AnthropicVer
        "content-type" = "application/json"
    }

    try {
        $response = Invoke-RestMethod -Uri "https://api.anthropic.com/v1/messages" -Method POST -Headers $headers -Body $body -TimeoutSec $LLMTimeoutSec
        $text = $response.content[0].text
        Write-Host "  LLM response: $text"
        return Convert-LLMTextToAction -Text $text
    } catch {
        Write-Host "  Claude API error: $_"
        return @{ action = "fail"; reason = "API error: $_" }
    }
}

function Convert-LLMTextToAction {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return @{ action = "fail"; reason = "Empty LLM response" }
    }

    $trimmed = $Text.Trim()

    # Strip fenced code blocks if present.
    if ($trimmed.StartsWith('```')) {
        $trimmed = $trimmed -replace '^```(?:json)?\s*', ''
        $trimmed = $trimmed -replace '\s*```$', ''
        $trimmed = $trimmed.Trim()
    }

    # Extract first JSON object from verbose replies.
    $firstBrace = $trimmed.IndexOf('{')
    $lastBrace = $trimmed.LastIndexOf('}')
    if ($firstBrace -ge 0 -and $lastBrace -gt $firstBrace) {
        $trimmed = $trimmed.Substring($firstBrace, $lastBrace - $firstBrace + 1)
    }

    try {
        return $trimmed | ConvertFrom-Json
    } catch {
        return @{ action = "fail"; reason = "Unparseable LLM JSON response" }
    }
}

function Invoke-OpenAI {
    param([string]$SystemPrompt, [string]$UserMessage, [string]$Base64Image)

    $body = @{
        model = $OpenAIModel
        max_tokens = $LLMMaxTokens
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
        $response = Invoke-RestMethod -Uri "https://api.openai.com/v1/chat/completions" -Method POST -Headers $headers -Body $body -TimeoutSec $LLMTimeoutSec
        $text = $response.choices[0].message.content
        Write-Host "  LLM response: $text"
        return Convert-LLMTextToAction -Text $text
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
    param([string]$Status, [string]$Message, [string]$Strategy, [string]$CommandId = "")
    $result = @{
        status    = $Status
        message   = $Message
        strategy  = $Strategy
        commandId = $CommandId
        timestamp = (Get-Date -Format "o")
    } | ConvertTo-Json -Depth 3
    [System.IO.File]::WriteAllText($ResultFile, $result, [System.Text.Encoding]::UTF8)
    Write-Host "[$Status] $Message (commandId: $CommandId)"
}

function Invoke-LLMGuidedAction {
    param([string]$CompanyName, [string]$Action, [string]$CommandId = "", [int]$MaxStepsOverride = 0)

    $hwnd = Find-TallyWindow
    if ($hwnd -eq [IntPtr]::Zero) {
        Write-Result -Status "error" -Message "Tally window not found. Is Tally running?" -Strategy "llm-gui" -CommandId $CommandId
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
    $effectiveMaxSteps = if ($MaxStepsOverride -gt 0) { $MaxStepsOverride } else { $MaxSteps }
    $typedSearchFallbackUsed = $false
    $consecutiveNavActions = 0

    Write-Host "  Goal: $goal"
    Write-Host "  Starting LLM-guided loop (max $effectiveMaxSteps steps)..."

    for ($step = 0; $step -lt $effectiveMaxSteps; $step++) {
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
            Write-Result -Status "success" -Message "Company '$CompanyName' loaded. LLM: $($llmAction.reason)" -Strategy "llm-gui" -CommandId $CommandId
            return
        }
        if ($llmAction.action -eq "fail") {
            Write-Host "  LLM says FAIL: $($llmAction.reason)"
            Write-Result -Status "error" -Message "LLM could not achieve goal: $($llmAction.reason)" -Strategy "llm-gui" -CommandId $CommandId
            return
        }

        # Execute the action
        $actionDesc = "$($llmAction.action): $($llmAction.value) ($($llmAction.reason))"
        $actionHistory += "Step ${stepCount}: $actionDesc`n"
        Execute-Action -Action $llmAction

        $keyValue = if ($llmAction.value) { [string]$llmAction.value } else { "" }
        if ($llmAction.action -eq "key" -and ($keyValue.ToLower() -in @("down", "up", "enter"))) {
            $consecutiveNavActions++
        } else {
            $consecutiveNavActions = 0
        }

        if (-not $typedSearchFallbackUsed -and $Action -eq "select-company" -and -not [string]::IsNullOrWhiteSpace($CompanyName) -and $consecutiveNavActions -ge 4) {
            Write-Host "  Fallback: trying direct company name search by typing '$CompanyName'"
            [TallyUI2]::PressCombo([TallyUI2]::VK_MENU, [TallyUI2]::VK_F3)
            Start-Sleep -Milliseconds 600
            [TallyUI2]::PressKey([TallyUI2]::VK_F1)
            Start-Sleep -Milliseconds 600
            [TallyUI2]::TypeString($CompanyName)
            Start-Sleep -Milliseconds 400
            [TallyUI2]::PressKey([TallyUI2]::VK_RETURN)
            Start-Sleep -Milliseconds 700
            $typedSearchFallbackUsed = $true
            $consecutiveNavActions = 0
            $actionHistory += "Fallback: typed company name search executed`n"
        }
    }

    Write-Result -Status "error" -Message "Reached max steps ($effectiveMaxSteps) without achieving goal" -Strategy "llm-gui" -CommandId $CommandId
}

# --- Main watch loop ---
Write-Host "=== MCP Tally GUI Agent v2 (LLM-Guided) ==="
Write-Host "Watching: $CommandFile"
Write-Host "Results:  $ResultFile"
Write-Host "Provider: $LLMProvider"
Write-Host "Max steps per command: $MaxSteps"
Write-Host "Agent started. Polling every 500ms for commands..."

while ($true) {
    try {
        # Atomically try to read and delete — avoids TOCTOU race with MCP server
        $cmdText = $null
        try {
            $cmdText = [System.IO.File]::ReadAllText($CommandFile, [System.Text.Encoding]::UTF8)
            Remove-Item $CommandFile -Force -ErrorAction SilentlyContinue
        } catch [System.IO.FileNotFoundException] {
            # File doesn't exist — normal, just keep polling
        } catch [System.IO.DirectoryNotFoundException] {
            # Directory doesn't exist yet
        }

        if ($cmdText) {
            $cmd = $cmdText | ConvertFrom-Json
            $cmdId = if ($cmd.commandId) { [string]$cmd.commandId } else { "" }
            $cmdMaxSteps = if ($cmd.maxSteps) { [int]$cmd.maxSteps } else { 0 }
            Write-Host "`n=== Received command: $($cmd.action) ==="

            switch ($cmd.action) {
                "select-company" {
                    Invoke-LLMGuidedAction -CompanyName $cmd.companyName -Action "select-company" -CommandId $cmdId -MaxStepsOverride $cmdMaxSteps
                }
                "load-on-startup" {
                    Invoke-LLMGuidedAction -CompanyName $cmd.companyName -Action "load-on-startup" -CommandId $cmdId -MaxStepsOverride $cmdMaxSteps
                }
                "ping" {
                    Write-Result -Status "success" -Message "Agent v2 is alive (LLM: $LLMProvider)" -Strategy "ping" -CommandId $cmdId
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
    }
    catch {
        Write-Host "Error processing command: $_"
        Write-Result -Status "error" -Message "Exception: $_" -Strategy "error"
        Remove-Item $CommandFile -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
}
