# MCP Tally GUI Agent v2 - LLM-Guided (Computer Use style)
# Takes screenshots of the Tally window, sends to an LLM for analysis,
# executes the LLM's recommended action, and loops until the goal is achieved.
#
# RUN: In the interactive desktop session where Tally is visible
#   powershell -ExecutionPolicy Bypass -File tally-gui-agent-v2.ps1
#
# REQUIRES: ANTHROPIC_API_KEY or OPENAI_API_KEY in environment (optional - only for LLM-guided actions)

param(
    [string]$WatchDir = $null,
    [string]$LLMProvider = $null,   # "anthropic" or "openai" (auto-detected from available API key)
    [int]$MaxSteps = 15,            # Safety limit per command
    [switch]$NoSelfRestart          # Disable self-watching auto-restart (for debugging)
)

# --- Agent version (bumped whenever the IPC contract or script behavior changes) ---
# The MCP server reads this from the ping response and refuses load-company calls
# against an agent older than its required minimum (issue #15 - version handshake).
# Format: MAJOR.MINOR.PATCH. Bump MINOR on any new IPC action or response field;
# bump PATCH on internal fixes that callers can ignore.
$Script:AgentVersion = "1.6.1"

# --- Single-instance guard ---------------------------------------------------------------------
# Only ONE agent may run. Multiple instances race on the command/result files and each spawns its own
# overlay window. A named session mutex enforces this across EVERY launch path (at-logon trigger, the
# 1-min crash-respawn heartbeat, Restart-Self on script change, manual starts, reinstalls). We wait a
# few seconds so a Restart-Self predecessor can exit and release the mutex before we give up; an
# abandoned mutex (predecessor exited without releasing) still counts as acquired.
$Script:SingleInstanceMutex = New-Object System.Threading.Mutex($false, 'TallyMCPAgentSingleInstance')
$haveMutex = $false
try { $haveMutex = $Script:SingleInstanceMutex.WaitOne(4000) }
catch [System.Threading.AbandonedMutexException] { $haveMutex = $true }
if (-not $haveMutex) {
    Write-Host "Another Tally GUI agent is already running - exiting this duplicate instance."
    exit 0
}

if (-not $WatchDir) {
    $WatchDir = if ($env:TALLY_DATA_PATH) { $env:TALLY_DATA_PATH } else { "C:\Users\Public\TallyPrimeEditLog\data" }
}

$CommandFile = Join-Path $WatchDir "_mcp_gui_command.json"
$ResultFile  = Join-Path $WatchDir "_mcp_gui_result.json"

# --- Detect LLM provider (optional) ---
# Deterministic actions (ping, start-tally, exit) work without any LLM key.
# Only LLM-guided actions (select-company, load-on-startup) require a key - those error at dispatch time
# if the key is missing, instead of refusing to start the agent.
if (-not $LLMProvider) {
    if ($env:ANTHROPIC_API_KEY) { $LLMProvider = "anthropic" }
    elseif ($env:OPENAI_API_KEY) { $LLMProvider = "openai" }
    else { $LLMProvider = "none" }
}
Write-Host "LLM Provider: $LLMProvider$(if ($LLMProvider -eq 'none') { ' (LLM-guided actions disabled - set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable)' })"

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
- Be precise with text - company names are case-sensitive in Tally

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
                "a" = 0x41; "c" = 0x43; "v" = 0x56; "x" = 0x58
            }
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
            # Log the length only, NEVER the text itself - a caller (gui-send-keys / the LLM loop) may
            # route a password through here, and Write-Host lands in the agent's console/transcript.
            Write-Host "  Action: Type ($($Action.value.Length) chars)"
            # PREFER clipboard paste: char-by-char keybd_event double-registers/drops on Tally's UI
            # ("JJINAA CODE..."), which is unacceptable for masked fields (a mistyped password = lockout).
            # Paste sets the field atomically. Fall back to (scan-code) char typing only if the clipboard
            # is unavailable. NOTE: a few Tally fields (e.g. TallyVault) may block paste — the caller must
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
    $result = $payload | ConvertTo-Json -Depth 3
    # Write UTF-8 WITHOUT BOM. .NET's [Encoding]::UTF8 prepends a BOM, which breaks Node's JSON.parse on the read side.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ResultFile, $result, $utf8NoBom)
    Write-Host "[$Status] $Message (commandId: $CommandId)"
}

# --- Ground-truth load verification -----------------------------------------------------------------
# The keystroke-driven load flows (deterministic select-and-unlock, and the LLM "done" path) are
# open-loop: they blast keys and used to report success without ever confirming Tally accepted them.
# A wrong/rejected password, an unfocused list, or a premature LLM "done" would still be reported as
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
# name (LLM path). Matching is deliberately loose because a folder id rarely equals the display name.
# Never echoes credentials - messages only ever contain the requested id and the loaded company names.
function Write-VerifiedLoadResult {
    param(
        [string]$Requested,
        [string]$Strategy,
        [string]$CommandId = "",
        [string]$Context = ""     # short, non-secret suffix e.g. " with credentials" or " (LLM: ...)"
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
    if ($LLMProvider) { $argList += @('-LLMProvider', $LLMProvider) }
    if ($MaxSteps)    { $argList += @('-MaxSteps',    [string]$MaxSteps) }
    try {
        Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Normal | Out-Null
    } catch {
        Write-Host "[self-restart] Start-Process failed: $_  (this instance will keep running)"
        return
    }
    exit 0
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
            # The model saying "done" is a claim, not proof - a hallucinated or premature "done" would
            # otherwise surface as a false success. Confirm against Tally's loaded-company list before
            # reporting success; the verifier downgrades to error/unverified if nothing (or the wrong
            # thing) is actually loaded.
            Write-VerifiedLoadResult -Requested $CompanyName -Strategy "llm-gui" -CommandId $CommandId -Context " (LLM: $($llmAction.reason))"
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
Write-Host "Version:  $Script:AgentVersion"
Write-Host "Watching: $CommandFile"
Write-Host "Results:  $ResultFile"
Write-Host "Provider: $LLMProvider"
Write-Host "Max steps per command: $MaxSteps"
Write-Host "Self-restart on script change: $(-not $NoSelfRestart)"
Write-Host "Agent started. Polling every 500ms for commands..."

# --- Claude-control visual overlay -------------------------------------------------------------
# A topmost, CLICK-THROUGH orange frame around the Tally window while the agent is driving it, so the
# user can see "Claude has the wheel - hands off". Runs on its own STA WinForms thread (a runspace)
# because the agent's polling loop has no message pump. ENTIRELY best-effort: every touchpoint is
# wrapped in try/catch, so if anything here fails the overlay simply won't appear and GUI control is
# unaffected. It auto-hides ~6s after the last action, and is hidden during screenshot capture so it
# never appears in what Claude sees.
$Script:OverlayState = [hashtable]::Synchronized(@{ Show = $false; Until = [datetime]::MinValue; Rect = $null; Hwnd = [IntPtr]::Zero; Stop = $false })
try {
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
            # Opacity < 1 makes WinForms apply the LAYERED alpha — WITHOUT this the manual WS_EX_LAYERED
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
                    # (and the outside borders) off-screen — the reason it wasn't visible in full screen.
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
                    $gc = [int](120 + 70 * $phase)                        # green channel 120..190 (orange→amber)
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
            $cmd = $cmdText | ConvertFrom-Json
            $cmdId = if ($cmd.commandId) { [string]$cmd.commandId } else { "" }
            $cmdMaxSteps = if ($cmd.maxSteps) { [int]$cmd.maxSteps } else { 0 }
            Write-Host "`n=== Received command: $($cmd.action) ==="

            # Show the "Claude is controlling Tally" frame for GUI-driving commands (screenshot/ping
            # excluded — screenshot must be clean, ping is passive). Auto-hides ~6s after the last action.
            if (@('select-company','load-on-startup','sendkeys','select-and-unlock-company','switch-company','start-tally') -contains ([string]$cmd.action)) {
                if (Get-Command Show-ClaudeOverlay -ErrorAction SilentlyContinue) { Show-ClaudeOverlay }
            }

            switch ($cmd.action) {
                "select-company" {
                    if ($LLMProvider -eq "none") {
                        Write-Result -Status "error" -Message "select-company requires an LLM key (ANTHROPIC_API_KEY or OPENAI_API_KEY). Use load-company (tally.ini-driven) for LLM-free company loading." -Strategy "select-company" -CommandId $cmdId
                    } else {
                        Invoke-LLMGuidedAction -CompanyName $cmd.companyName -Action "select-company" -CommandId $cmdId -MaxStepsOverride $cmdMaxSteps
                    }
                }
                "load-on-startup" {
                    if ($LLMProvider -eq "none") {
                        Write-Result -Status "error" -Message "load-on-startup requires an LLM key. Use load-company (tally.ini-driven) instead." -Strategy "load-on-startup" -CommandId $cmdId
                    } else {
                        Invoke-LLMGuidedAction -CompanyName $cmd.companyName -Action "load-on-startup" -CommandId $cmdId -MaxStepsOverride $cmdMaxSteps
                    }
                }
                "ping" {
                    $extra = @{
                        llmProvider = $LLMProvider
                        scriptPath  = $Script:AgentScriptPath
                        scriptMTime = if ($Script:AgentScriptMTime) { $Script:AgentScriptMTime.ToString('o') } else { $null }
                        pid         = $PID
                    }
                    Write-Result -Status "success" -Message "Agent v2 is alive (LLM: $LLMProvider, version: $Script:AgentVersion)" -Strategy "ping" -CommandId $cmdId -Extra $extra
                }
                "screenshot" {
                    # Capture the current Tally window so the caller (an MCP client / Claude) can SEE the
                    # on-screen state and choose the next keystrokes - the interactive, human-supervised
                    # alternative to the blind deterministic select-and-unlock sequence. Pairs with "sendkeys".
                    try {
                        $hwnd = Find-TallyWindow
                        if ($hwnd -eq [IntPtr]::Zero) {
                            Write-Result -Status "error" -Message "Tally window not found - is Tally running?" -Strategy "screenshot" -CommandId $cmdId
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
                    # password into another window. Reuses Execute-Action, the same primitive the LLM loop uses.
                    try {
                        $hwnd = Find-TallyWindow
                        if ($hwnd -eq [IntPtr]::Zero) {
                            Write-Result -Status "error" -Message "Tally window not found - is Tally running?" -Strategy "sendkeys" -CommandId $cmdId
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
                    # No LLM, works regardless of password type. Used by load-company when auto-load via tally.ini's
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
                                Write-Result -Status "error" -Message "Tally window not found - is Tally running?" -Strategy "select-and-unlock" -CommandId $cmdId
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
                    #   1. PREFIX (open Select Company on a running Tally): Alt+F3 -> F1. This mirrors the LLM
                    #      select-company fallback above (search "typed company name search"), which empirically
                    #      opens the Select Company list on this Tally build. Alt+F3 = Company menu, F1 = Select Company.
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
                                Write-Result -Status "error" -Message "Tally window not found - is Tally running?" -Strategy "switch-company" -CommandId $cmdId
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
                    # Step-by-step primitive: press one named key. Lets an LLM drive Tally
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
                                Write-Result -Status "error" -Message "Tally window not found - is Tally running?" -Strategy "press-key" -CommandId $cmdId
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
                                Write-Result -Status "error" -Message "Tally window not found - is Tally running?" -Strategy "type-text" -CommandId $cmdId
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
                    # Quick state probe + focus. Useful before an LLM-driven sequence to make
                    # sure subsequent press-key / type-text actions land in Tally and not in
                    # some other window the user accidentally clicked into.
                    try {
                        $hwnd = Find-TallyWindow
                        if ($hwnd -eq [IntPtr]::Zero) {
                            Write-Result -Status "error" -Message "Tally window not found - is Tally running?" -Strategy "bring-foreground" -CommandId $cmdId
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
    }
    catch {
        Write-Host "Error processing command: $_"
        Write-Result -Status "error" -Message "Exception: $_" -Strategy "error"
        Remove-Item $CommandFile -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
}
