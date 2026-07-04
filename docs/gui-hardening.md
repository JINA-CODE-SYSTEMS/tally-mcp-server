# Windows GUI Hardening

## What this is

This document catalogues every confirmed fragility finding from an adversarially-verified,
multi-agent audit of the project's **Windows GUI surface**:

- the **system tray / dashboard** (`scripts/tray/tally-mcp-tray.ps1`),
- the **GUI automation agent** (`scripts/tally-gui-agent-v2.ps1`, `scripts/TallyUI.cs`), and
- the **installer wizard** (`scripts/installer/tally-mcp.iss`, `scripts/installer/firstrun-config.ps1`).

Six independent auditors each probed one fragility dimension; a separate verification pass
adversarially re-checked every finding against the actual code and rejected the ones that did
not hold up (6 rejected). What remains below are the **50 confirmed findings**.

### Headline verdict — roughly 5/10 robustness

> Moderately fragile. The happy path works, but the whole surface degrades badly at the edges,
> and the automation core is architecturally **open-loop**: it reports success on *bytes sent*,
> not on *results*. Nothing here corrupts data on a clean run, but several failures are both
> silent and consequential — a company reported "loaded" when it isn't, a cleartext password
> typed into the wrong window, a reconfigure that is a silent no-op — all of which surface to
> the caller as success.

**Weakest link:** the GUI agent (`scripts/tally-gui-agent-v2.ps1`). Not because it has the most
findings (the tray does), but because its failures are the only ones that are simultaneously
*silent, downstream-corrupting, and security-relevant*. Every other component degrades visibly;
this one lies.

### Severity counts

| Severity | Count |
|----------|------:|
| High     | 4     |
| Medium   | 32    |
| Low      | 14    |
| **Total**| **50**|

### By dimension

| Dimension | Confirmed |
|-----------|----------:|
| GUI agent automation | 14 |
| Installer wizard     | 10 |
| External state       | 9  |
| Silent failures      | 7  |
| WinForms lifecycle   | 6  |
| Elevation            | 4  |

---

## Fixed on branch `fix/gui-hardening`

Five fixes are applied on this branch. The first three are the highest-leverage items from the
audit: #1 removes the only *dangerous* fragility, #2 unbreaks the default install path, #3
unblocks every public/domain deployment. #4 and #5 make the GUI-agent IPC channel self-heal so an
operator never has to run `icacls`/`Remove-Item` by hand.

1. **GUI agent ground-truth verification** — `scripts/tally-gui-agent-v2.ps1`
   After the keystroke sequence and on the LLM's `done`, query the Tally XML server for the
   currently-loaded company (or read the window title) and only write `status=success` if it
   matches `companyId`; otherwise return a distinct, retryable error. This is the same discipline
   `load-company` already uses at `mcp.mts:1579`. Collapses the whole open-loop false-success
   class into detectable errors. Addresses findings **#1** (`:578`) and **#16** (`:411`).

2. **Reconfigure path-quoting** — `scripts/tray/tally-mcp-tray.ps1`
   Pre-quote `$script` and `$InstallDir` when launching the elevated child, mirroring the quoting
   already used at `firstrun-config.ps1:445`. One-line fix to a bug that breaks Reconfigure on the
   default `C:\Program Files\TallyMCP` install path. Addresses finding **#0** (`:518`).

3. **MCP_DOMAIN validation / normalization** — `scripts/installer/firstrun-config.ps1`
   Validate and normalize the domain before writing `.env`: trim, prepend `https://` if
   schemeless, strip trailing slash/path, parse with `[uri]`, then `_envQuote` it like every other
   value. Without this, a bare `mcp.acme.com` makes the server throw `Invalid URL` and emit
   schemeless OAuth metadata every client rejects. Addresses finding **#2** (`:261`).

4. **IPC command file written atomically** — `src/mcp.mts`
   Route the three `_mcp_gui_command.json` writes through the existing `atomicWriteFile` (temp +
   rename) instead of overwriting in place, so every command file is a fresh inode that re-inherits
   the directory ACL. Fixes the `Access is denied` the Limited-token agent hits when the file keeps
   a stale/narrower ACL (the runtime half of the IPC-permissions failure).

5. **Persist `AGENT_TASK_USER` + self-heal stale IPC files** — `scripts/installer/firstrun-config.ps1`
   Persist `AGENT_TASK_USER` in `.env` and prefer it over `$env:USERNAME` so a reconfigure by a
   different admin can't repoint the task + ACL grants to the wrong user; and after locking the IPC
   dir ACL, delete stale `_mcp_gui_command.json`/`_mcp_gui_result.json`/`_mcp_screenshot.png` so the
   service recreates them with the correct inherited ACL. Makes the fix an install-time step, not an
   operator shell command. Addresses the repointing finding below.

---

## High severity (4)

### GUI agent automation

- [x] **`select-and-unlock` reports success on "keystrokes sent", never verifying the company loaded or credentials were accepted** — `scripts/tally-gui-agent-v2.ps1:578` — **Fixed on `fix/gui-hardening`**
  - Why: the entire deterministic credential flow is a blind keystroke blast (type id, N Enters, fixed sleep, user/TAB/pass/Enter) then unconditionally `status=success` — no screenshot, title read, or XML query confirms anything.
  - Fails when: cold-start/large company still rendering after the 2nd Enter → username lands in the Select-Company type-ahead filter, password goes nowhere, no company loads — yet MCP tells the user it's open and every downstream call hits the wrong/no company.
  - Fix: after the keystrokes, query the Tally XML server (or read the window title) for the loaded company and only report success if it matches `companyId`; otherwise a distinct error.

### Installer wizard

- [x] **`MCP_DOMAIN` written verbatim with no scheme validation/normalization (the schemeless-OAuth bug)** — `scripts/installer/firstrun-config.ps1:261` — **Fixed on `fix/gui-hardening`**
  - Why: the wizard field says "Public domain", so operators type a bare host; it's written as `MCP_DOMAIN=$McpDomain` with no scheme prepend, no trim, not even `_envQuote`'d — but the server treats it as a full URL (`new URL(mcpDomain)`, `issuer: mcpDomain`).
  - Fails when: operator types `mcp.acme.com` → `new URL()` throws `Invalid URL` on the well-known routes and `/.well-known/oauth-authorization-server` advertises a schemeless issuer that Claude Desktop / VS Code OAuth discovery rejects. Install reports success.
  - Fix: trim, reject internal whitespace, prepend `https://` if schemeless, strip trailing `/`/path, parse with `[uri]`, write through `_envQuote`, and echo the normalized value back to the operator.

- [x] ✅ **Fixed on `fix/gui-hardening`. Reconfigure run by a different admin silently repoints the GUI agent task and ACLs to the wrong Windows user** — `scripts/installer/firstrun-config.ps1:105`
  - Why: `AgentTaskUser` is never persisted in `.env`, so line 105 falls back to `$env:USERNAME` whenever `-AgentTaskUser` is omitted — exactly what the Reconfigure shortcut does — then bakes that user into the task principal and every `icacls` grant.
  - Fails when: a roaming `Administrator` RDPs in and clicks Reconfigure → agent task + `.env`/registry/IPC ACLs re-point from `TallyOperator` to `Administrator`; the agent no longer runs in the interactive session, `load-company` silently stops working.
  - Fix: persist `AGENT_TASK_USER=` in `.env` and add it to the `_Coalesce` chain (param → existing `.env` → `$env:USERNAME`) like the Tally paths.

### Elevation

- [x] **Reconfigure passes `-File`/`-InstallDir` as unquoted array elements; breaks on the default `C:\Program Files\TallyMCP` path** — `scripts/tray/tally-mcp-tray.ps1:518` — **Fixed on `fix/gui-hardening`**
  - Why: `Start-Process powershell.exe -ArgumentList @(... '-File', $script, '-InstallDir', $InstallDir) -Verb RunAs` under PS 5.1 joins array elements with single spaces and does not quote ones containing spaces; both paths derive from the space-containing default install dir.
  - Fails when: default install → the elevated command becomes `-File C:\Program Files\TallyMCP\...` and `-File` binds only `C:\Program`, which doesn't exist. Reconfigure never runs on the majority install path (works only on space-free custom dirs).
  - Fix: pre-quote each space-capable element, mirroring `firstrun-config.ps1:445`.

---

## Medium severity (32)

### GUI agent automation

- [x] **LLM `done` is trusted blindly and written as success with no verification that the company loaded** — `scripts/tally-gui-agent-v2.ps1:411` — **Fixed on `fix/gui-hardening`**
  - Why: when the model returns `{"action":"done"}` the agent writes `status=success "Company loaded"` purely on the model's say-so, reasoning over a possibly stale/occluded/black/wrong-window screenshot; vision models routinely hallucinate completion.
  - Fails when: a black frame (locked/RDP session) prompts a hallucinated `done` (false success); or the company *is* loaded but the model keeps navigating, hits max steps, and a real success is reported as error.
  - Fix: on `done`, run an independent check (Tally XML "current company" or title match) before writing success.

- [ ] **Malformed LLM action (missing `value`) throws in `Execute-Action`; the top-level catch writes a result with NO `commandId`, so the MCP can never match it and blocks the full timeout** — `scripts/tally-gui-agent-v2.ps1:256`
  - Why: `$Action.value.ToLower()` with no null guard throws on a value-less `key`/`combo`; there's no per-step try/catch, so it unwinds to the main-loop catch which calls `Write-Result` without `-CommandId`, and the MCP discards it as stale.
  - Fails when: model emits `{"action":"key","reason":"..."}` (no value) → agent crashes the action, MCP ignores the id-less error, `open-company` hangs the full 180s and reports a generic timeout.
  - Fix: null/empty-guard `$Action.value` in every branch, wrap the per-step body in try/catch, and include the current `$cmdId` in the top-level `Write-Result`.

- [ ] **No retry/backoff on LLM API errors — a single transient 429/500/timeout aborts the whole multi-step operation** — `scripts/tally-gui-agent-v2.ps1:168`
  - Why: `Invoke-Claude`/`Invoke-OpenAI` catch *any* exception (network blip, 429, 529, socket timeout) and return `@{action='fail'}`; the loop treats `fail` as a terminal model verdict and immediately errors out — no retry, no distinction from a genuine give-up.
  - Fails when: step 6 of 25 hits HTTP 529 (overloaded) → the entire `open-company` aborts even though the prior 5 steps navigated correctly and one retry would have succeeded.
  - Fix: separate transport failures from a model `fail` verdict; retry the step with capped exponential backoff (honoring `Retry-After`).

- [ ] **Agent has no wall-clock budget: ~13 min worst case vastly exceeds the MCP's 180s wait, so the server gives up while the agent keeps injecting keystrokes and queued commands stack** — `scripts/tally-gui-agent-v2.ps1:385`
  - Why: the loop counts steps, never elapsed time (25 × 30s LLM timeout ≈ 13 min) while the MCP's `open-company` waits only 180s; the two clocks are uncoordinated.
  - Fails when: MCP hits 180s first and reports "Agent did not respond"; the user retries while the agent is still mid-loop injecting Alt+F3/type/Enter, and the retried command sits unread then double-drives Tally on an unknown UI state.
  - Fix: give the loop an absolute deadline derived from the caller's timeout, abort with a `commandId`-tagged result before the MCP gives up, and make the agent single-flight.

- [ ] **Foreground/focus is best-effort and never verified; `keybd_event` injects globally, so on any focus-steal the password lands in the wrong window** — `scripts/tally-gui-agent-v2.ps1:529`
  - Why: every input path calls `ForceForeground($hwnd) | Out-Null` and discards the return; `SetForegroundWindow` often silently refuses, and `keybd_event` posts to the global input queue with no `GetForegroundWindow==hwnd` re-check before typing.
  - Fails when: a toast/UAC/Teams popup, screensaver, or an alt-tab steals foreground the moment before the blast → the username and cleartext password are typed into a chat window or address bar, visible/logged there, while the agent reports success.
  - Fix: check `ForceForeground`'s return AND re-read `GetForegroundWindow==hwnd` immediately before each `TypeString`/`PressKey`; abort if focus isn't confirmed. Prefer `SendInput`.

- [ ] **`TypeString` via `VkKeyScan` is keyboard-layout/locale dependent and silently mistypes or drops characters** — `scripts/TallyUI.cs:74`
  - Why: `VkKeyScan(c)` maps against the calling thread's active layout and returns `-1` for un-typable chars (unchecked → sends VK `0xFF`); only the shift bit is honored, the AltGr/Ctrl+Alt bit is ignored, so `@ € # \ { }` on European layouts type wrong. Errors are silent.
  - Fails when: a UK/German/Indian layout with a password containing `@` or an accent → Tally receives a different password, auth fails — but the deterministic flow reports success unconditionally, so it looks like "won't open for no reason".
  - Fix: check `VkKeyScan==-1` and fail loudly, handle AltGr, or switch to `SendInput` with `KEYEVENTF_UNICODE`.

- [ ] **Blind fixed sleeps in the credential flow with no readiness check; slow Tally causes username/password to be typed into the company-list type-ahead filter** — `scripts/tally-gui-agent-v2.ps1:560`
  - Why: the sequence is paced by hardcoded sleeps (800ms, 1500ms inter-Enter, 3000ms after Enter, 300ms between fields), none of which poll for the dialog/field to exist; keystrokes are fire-and-forget.
  - Fails when: a large company's credential dialog takes 5s to appear but `waitMsAfterEnter=3000` → the username is typed while the Select-Company list still has focus, acting as a type-ahead that jumps to a different company.
  - Fix: replace fixed sleeps with bounded polling for the expected window/child controls before typing each field.

- [ ] **`Execute-Action` has no default branch and silently ignores unknown/unmapped actions/keys, recording them in history as if performed** — `scripts/tally-gui-agent-v2.ps1:244`
  - Why: the `switch` has cases only for key/combo/type/wait and no default; a hallucinated `click`/`scroll` or an unmapped key (`space`, `f11`) does nothing, yet the caller already appended it to `actionHistory` as done.
  - Fails when: model returns `{"action":"click","value":"the ACME row"}` → nothing happens but history says step done; the model repeats/diverges, burns all 25 steps, ends in "Reached max steps" with no diagnostic.
  - Fix: add a default (and unmapped-key/combo) branch that records in history that the action was NOT executed and why.

- [ ] **Two blind Escape presses as "reset to known state" assume a specific pre-state and can trigger a Quit/unsaved-data prompt** — `scripts/tally-gui-agent-v2.ps1:535`
  - Why: `select-and-unlock` opens with `ESC ESC` to reset, but Escape's effect in Tally is state-dependent (can pop a "Quit? Yes/No" at a data-entry screen or exit-confirmation at Gateway); the following `companyId` is typed into whatever that produced.
  - Fails when: Tally left at Gateway with a company loaded → `ESC ESC` surfaces "Quit Tally?", the id chars type into it, a following Enter answers Yes and closes Tally — then everything goes nowhere and the flow still reports success.
  - Fix: detect/normalize the actual current screen (screenshot/title/child-window) before deciding how to reset.

- [ ] **Screenshot uses `GetWindowRect` + `CopyFromScreen`, capturing physical pixels — occluded/off-screen/minimized/locked/RDP/DPI-scaled windows yield wrong or black frames the LLM reasons over** — `scripts/TallyUI.cs:88`
  - Why: it blits from the *screen* at the window's rect, not from the window's own DC, so it captures whatever is physically there; the only guard is `width/height<=0`.
  - Fails when: operator locks the workstation (Win+L) mid-run → `CopyFromScreen` returns a black/secure-desktop frame; the model can't see Tally and either hallucinates `done` or flails to max steps. Same for 4K per-monitor DPI offsets.
  - Fix: capture via `PrintWindow(hwnd, PW_RENDERFULLCONTENT)`, make the process per-monitor DPI aware, verify visibility before capture, and reject all-black/low-variance frames.

- [ ] **`Find-TallyWindow` picks an arbitrary process by name and relies on cached `MainWindowHandle` — can target a second instance or the splash window** — `scripts/tally-gui-agent-v2.ps1:59`
  - Why: `Get-Process -Name 'tally' | Select -First 1` is arbitrary across instances, `MainWindowHandle` is cached at first access (can be the splash), and the process name is hardcoded; only guard is `handle != Zero`.
  - Fails when: `start-tally` races an existing Tally or grabs the handle while the splash shows → `ForceForeground` + the credential blast target the splash/wrong instance; keystrokes drop or hit the wrong company; success reported.
  - Fix: match the specific PID the agent launched, require the real main-window class/title (not splash), refresh the handle, and handle multi-instance explicitly.

- [ ] **LLM `max_tokens` default 300 with no JSON/stop enforcement; model preamble truncates the JSON and null-content/refusal/`stop_reason` is unhandled** — `scripts/tally-gui-agent-v2.ps1:45`
  - Why: 300-token cap with no stop sequences / JSON mode means a reasoning preamble cuts the JSON mid-string; the first-brace/last-brace slice then fails `ConvertFrom-Json` → `action=fail`. It also assumes `content[0].text` is present (null on refusal/content-filter/`max_tokens`).
  - Fails when: the model returns short chain-of-thought before the JSON and the cap truncates the closing brace → scored as a parse fail and (because fail aborts) the operation ends, with no signal it was truncation.
  - Fix: raise `max_tokens`, add stop sequences / provider JSON mode, handle null/non-text content, and retry the step on a parse/truncation failure instead of treating it as terminal.

### Installer wizard

- [ ] **Reconfigure Start Menu shortcut launches PowerShell non-elevated; service/ACL/task operations fail** — `scripts/installer/tally-mcp.iss:127`
  - Why: `PrivilegesRequired=admin` but the shortcut launches `powershell.exe -File firstrun-config.ps1` with no runas verb or manifest, and the script has no `#Requires -RunAsAdministrator` / self-elevation; even an Administrators member gets a filtered token by default.
  - Fails when: operator double-clicks "Reconfigure" → `nssm` errors swallowed by `2>$null`, `icacls` downgraded to `[WARN]`, `Register-ScheduledTask` throws "Access is denied" — leaving a half-reconfigured, possibly password-readable, agent-less install that looks like it mostly worked.
  - Fix: add a self-elevation guard at the top of `firstrun-config.ps1` (WindowsPrincipal Admin check → relaunch `-Verb RunAs` forwarding args), or make the shortcut elevate.

- [ ] **Partial failures are reported to the operator as overall success** — `scripts/installer/firstrun-config.ps1:485`
  - Why: agent/tray `Register-ScheduledTask` and all three `icacls` lockdowns downgrade failures to yellow `[WARN]` and continue, then the script unconditionally prints "Configuration complete."; the `[Run]` entry uses `runhidden waituntilterminated` with no `Check:`, and Inno ignores a non-zero exit.
  - Fails when: `Register-ScheduledTask` fails during a normal `.exe` install (GPO blocks it) → hidden window logs an unseen warning, Inno shows green "Setup completed successfully", `load-company` fails at first use with no line back to the failed registration.
  - Fix: track a `$failures` list, exit non-zero on any required-step failure, and add a `Check`/`AfterInstall` MsgBox showing "COMPLETED WITH ERRORS" + the transcript path — always, not only on the interactive branch.

- [ ] **Tally exe/data/ini paths are never validated for existence; auto-detected defaults can be silently wrong** — `scripts/installer/tally-mcp.iss:184`
  - Why: auto-detect probes only the two conventional `C:\Program Files\TallyPrime*` locations and still pre-fills a plausible default when neither exists; `NextButtonClick` validates password length and agent user but never checks the paths exist and never Trims them.
  - Fails when: Tally is under `Program Files (x86)` or `D:\` → the wizard pre-fills a non-existent `tally.exe`, the operator clicks Next (looks right), `.env` gets a bad `TALLY_EXE_PATH`, and `load-company` later fails to launch Tally with no link to setup.
  - Fix: Trim and `FileExists()`/`DirExists()`-check exe/data/ini before allowing Next; broaden auto-detect (Program Files (x86), registry) and leave the field blank rather than guessing.

- [ ] **The "Reconfigure" shortcut cannot actually change any setting it claims to** — `scripts/installer/firstrun-config.ps1:11`
  - Why: the synopsis tells operators to re-launch "to update settings," but the shortcut passes only `-InstallDir` and the script has no interactive prompts — the preserve-on-reconfigure chain deliberately re-reads everything from the existing `.env`, so a run re-writes the same values.
  - Fails when: operator moves Tally's data folder and clicks Reconfigure to re-point → never prompted for anything, the old `TALLY_DATA_PATH` is silently preserved, and they conclude the tool is broken or keep hitting stale-path failures.
  - Fix: either re-open the Inno wizard pages pre-populated from `.env`, or give the script an interactive Enter-to-keep mode; update the synopsis to match.

- [ ] **`_envQuote` escapes double-quotes but not backslashes; a backslash in the password corrupts `.env`** — `scripts/installer/firstrun-config.ps1:236`
  - Why: it escapes `"`→`\"` but leaves backslashes untouched then wraps in double quotes; dotenv treats `\` as an escape introducer, so a trailing `\` consumes the closing quote and interior `\n`/`\t` expand into control chars. Password validation only enforces length ≥ 12.
  - Fails when: operator sets `Domain\User2027!` or a password ending `...\` → `.env` is mis-parsed (auth always fails, operator locked out) or the following `TALLY_EDITION` line is mangled. Wizard reported success.
  - Fix: escape backslashes before quotes in `_envQuote`, make `_ReadEnvHashtable` un-escaping symmetric, and warn on brittle password characters.

- [ ] **Local-only `net user` check rejects valid domain agent accounts** — `scripts/installer/tally-mcp.iss:303`
  - Why: the agent-user existence check runs `net user "<name>"`, which queries only the local SAM; on a domain-joined box `DOMAIN\user` returns non-zero even though the account is valid, and the wizard hard-blocks (`Result := False`).
  - Fails when: operator enters `CORP\tallyops` (a real domain account) → "does not exist on this box" and the installer refuses to continue, forcing a wrong local account or abandonment.
  - Fix: resolve domain accounts (`whoami /user` comparison, `LookupAccountName`, or `net user /domain` when a domain component is present) and treat lookup failure as a soft warning.

- [ ] **Masked password field has no confirmation entry** — `scripts/installer/tally-mcp.iss:175`
  - Why: the OAuth password (the sole gate for every MCP tool) is a single masked field with only a min-12 length check — no confirm field, so a typo in the masked input is invisible.
  - Fails when: operator fat-fingers the password → passes length check, written to `.env`, service starts, and every OAuth login fails with the password they *think* they set, locking out all clients until a full reconfigure.
  - Fix: add a "Confirm password" field and reject in `NextButtonClick` when the two don't match.

- [ ] **Data-dir ACL hardening is applied to whatever path the operator enters, with no sanity guard** — `scripts/installer/firstrun-config.ps1:327`
  - Why: `icacls <TallyDataPath> /inheritance:r /grant:r SYSTEM:F Administrators:F <user>:F` strips inherited ACEs and restricts to three principals, but `TallyDataPath` comes straight from the un-validated wizard field with no guard that it's a plausible Tally data dir.
  - Fails when: operator mistypes the data folder as `C:\Users\Public` → the script strips inheritance from that broad tree and locks every other user out of the Public profile — a machine-wide side effect from one mistyped field.
  - Fix: before hardening, validate the path exists, isn't a drive root or well-known profile/system root, and looks like a Tally data dir; refuse and warn otherwise.

### External state

- [ ] **Health poll runs synchronous network I/O on the WinForms UI thread — a slow/hung probe freezes the entire tray** — `scripts/tray/tally-mcp-tray.ps1:209`
  - Why: `System.Windows.Forms.Timer.Tick` fires on the message-loop thread; `Invoke-StatusPoll` then runs public + Tally `Invoke-WebRequest`, `Get-Service`/`Get-ScheduledTask`/WMI, and two `.env` reads on that thread. `-TimeoutSec` doesn't bound DNS/TLS/redirect chains.
  - Fails when: internet/DNS is down → each 5s poll blocks ~3s+ on the UI thread, so the menu is openable only ~40% of the time and the icon looks frozen; the first synchronous poll before `Application.Run()` makes the menu dead at logon.
  - Fix: run `Invoke-StatusPoll` in a background runspace/`Start-Job`, marshal only the state hand-off back via a short Forms.Timer, hard-cap probe time, and disable auto-redirect.

- [ ] **Timeout, connection-refused, DNS failure, and 5xx all collapse to identical "unreachable", and a single dropped probe flips the tray to yellow and fires a false "degraded" toast** — `scripts/tray/tally-mcp-tray.ps1:211`
  - Why: the catch sets `PublicUrlOk=$false` for every failure mode with no distinction and no retry/debounce; one failed probe drops `urlOk`, `Get-OverallStatus` returns yellow, and `Update-TrayUi` fires a green→yellow toast on that single tick.
  - Fails when: a momentary LAN/DNS blip while service+agent are healthy → the icon flips yellow with a "Something downstream is unhealthy" toast, next poll recovers with "All services back up"; repeated flapping trains operators to ignore the toasts.
  - Fix: require N consecutive failures before degrading (N successes to clear), and classify the `WebException` (Timeout vs ConnectFailure vs NameResolution vs 5xx).

- [ ] **"Restart service" runs `taskkill /F /IM node.exe`, force-killing every Node process on the machine** — `scripts/tray/tally-mcp-tray.ps1:375`
  - Why: the elevated restart force-kills all `node.exe` by image name with no PID/service scoping and doesn't go through NSSM despite surrounding comments.
  - Fails when: on a dev/multi-service box also running other Node apps → clicking "Restart service" kills all of them, causing unrelated data loss or downtime.
  - Fix: restart via the service manager only (`nssm restart`, or `Stop-Service`/`Start-Service`), or resolve and kill only the service-owned node PID.

### Silent failures

- [ ] **Reconfigure handler runs `Start-Process -Verb RunAs` with no try/catch; declined/failed UAC throws invisibly** — `scripts/tray/tally-mcp-tray.ps1:511`
  - Why: the twin Restart handler wraps the identical call in try/catch + MessageBox, but Reconfigure issues the elevated launch with no guard; declined UAC or a non-admin account raises a terminating `Win32Exception` (ERROR_CANCELLED). Reached from the dashboard button too.
  - Fails when: operator clicks No on UAC → the exception routes to `Application.ThreadException` (generic .NET error dialog) or is swallowed, instead of the clean "cancelled" message the Restart handler shows for the same case.
  - Fix: wrap lines 518-523 in try/catch mirroring `miRestartService`; special-case ERROR_CANCELLED (1223) to a soft "Reconfigure cancelled." message.

- [ ] **"Copy public URL" button swallows `Clipboard.SetText` failure in an empty catch and gives no success feedback** — `scripts/tray/tally-mcp-tray.ps1:662`
  - Why: `try { Clipboard::SetText(...) } catch {}` is fully empty; `SetText` frequently throws `ExternalException` when another process holds the clipboard (clipboard managers, RDP/VDI sync), and there's no success confirmation either.
  - Fails when: clipboard momentarily locked → nothing is copied, no error appears, and the operator pastes a stale/empty value into a support email believing it's the public URL.
  - Fix: on success show a "Public URL copied" balloon, on failure a MessageBox "Could not copy to clipboard: $_"; at minimum log the exception.

- [ ] **Restart service assumes success: the actual stop/start runs in a hidden elevated window whose errors are never surfaced** — `scripts/tray/tally-mcp-tray.ps1:382`
  - Why: the outer try/catch only catches failure to *launch* the elevated process; once UAC is accepted, `taskkill` + `Start-Service` run in a `-WindowStyle Hidden` powershell whose diagnostics and any `Start-Service` error go to an invisible window, and the tray never inspects the outcome.
  - Fails when: `Start-Service` fails inside the hidden window (disabled service, bad NSSM binpath, SCM stuck) → error invisible, icon stays red/yellow with no message, operator concludes the restart "did nothing".
  - Fix: drop `-WindowStyle Hidden` (or `-NoExit`), or have the elevated child write its outcome/exit code to a temp file the tray reads back and reflects in a balloon/MessageBox.

### WinForms lifecycle

- [ ] **Health poll does blocking network + WMI I/O directly on the UI thread every tick, freezing the whole tray** — `scripts/tray/tally-mcp-tray.ps1:853`
  - Why: `Timer.Tick` fires on the message-loop thread; the handler runs two blocking `Invoke-WebRequest` probes plus a `Get-CimInstance Win32_Process` WMI query with no worker thread — the `[hashtable]::Synchronized` wrapper only *looks* concurrent (pure overhead).
  - Fails when: `MCP_DOMAIN` is slow/down → each 5s tick blocks up to 3s on the public probe (+2s if the Tally XML port hangs, + WMI latency); during that window the icon won't repaint, the menu won't open, and toasts queue.
  - Fix: move `Invoke-StatusPoll` onto a background runspace/`System.Threading.Timer` that only writes `$State`; keep the Forms.Timer solely for repainting; hard-bound every probe.

- [ ] **`PictureBox Image.FromFile` leaks a GDI bitmap (and holds a file lock) on every Dashboard open/close cycle** — `scripts/tray/tally-mcp-tray.ps1:582`
  - Why: `FormClosed` nulls the dashboard refs, so the form (including a fresh `Image::FromFile`) is fully rebuilt on the next open; `PictureBox.Dispose` does not dispose a user-assigned `.Image`, and neither do the several `New-Object Drawing.Font` instances — each open leaks a Bitmap + Fonts.
  - Fails when: operator repeatedly opens/closes the dashboard over a long session → each open leaks a ~200KB-source GDI Bitmap + Font handles for the tray's lifetime, and `FromFile` keeps `jina-logo.png` locked so an in-place upgrade can't replace it.
  - Fix: load the logo via a disposable stream copy and dispose it in `FormClosed` (or reuse the form via `FormClosing` + `Hide()`); dispose the explicitly-created Fonts.

- [ ] **Restart-GUI-agent menu handler blocks the UI thread with a `Start-Sleep` wait loop (up to 5s) plus `Stop-ScheduledTask`/WMI** — `scripts/tray/tally-mcp-tray.ps1:411`
  - Why: `Add_Click` handlers run on the UI thread; this one runs `Stop-ScheduledTask`, a WMI `Stop-Process` enumeration, and a `while` loop polling with `Start-Sleep -Milliseconds 200` to a 5s deadline — all synchronously. "Reload last company" similarly blocks on IPC.
  - Fails when: the task is slow to report non-Running → the tray icon, menu, and dashboard are frozen and unclickable for up to ~5s (Windows may show "Not Responding").
  - Fix: run these off the UI thread (runspace/`Start-Job`) and report completion via a `BeginInvoke`-marshalled balloon so the handler returns immediately.

- [ ] **Timer tick and UI-update phase have no top-level try/catch; an exception escapes to the message loop** — `scripts/tray/tally-mcp-tray.ps1:853`
  - Why: `Add_Tick` calls `Invoke-StatusPoll`/`Update-TrayUi`/`Update-DashboardUi` unguarded; `Invoke-StatusPoll` guards its probes, but the UI-update phase (`ShowBalloonTip`, icon/label writes) can throw and propagates into the WinForms loop.
  - Fails when: a session lock/unlock or Explorer restart makes `ShowBalloonTip` throw inside a tick → with no `ThreadException` handler the default .NET error dialog pops or the tray terminates, silently killing status monitoring.
  - Fix: wrap the tick body (and each menu handler) in try/catch that logs+swallows, and install `SetUnhandledExceptionMode` + `Add_ThreadException` before `Application.Run`.

### Elevation

- [ ] **Reconfigure has no error handling around `-Verb RunAs`; declined UAC or non-admin account is a completely silent no-op** — `scripts/tray/tally-mcp-tray.ps1:511`
  - Why: the `Add_Click` handler wraps the `Start-Process -Verb RunAs` in no try/catch and passes no `-ErrorAction Stop`; the `Win32Exception` (ERROR_CANCELLED) thrown inside the WinForms handler is swallowed by PowerShell — no dialog, log, or toast (Restart at least attempts a MessageBox).
  - Fails when: a standard-user operator, or one who clicks No on UAC, selects Reconfigure → the prompt dismisses and *nothing* happens, no message about needing admin rights; they assume the item is broken and retry or give up.
  - Fix: wrap in try/catch with `-ErrorAction Stop` and detect the cancel case (1223) to show "Reconfigure requires administrator rights."

- [ ] **Elevated restart is fire-and-forget and `-WindowStyle Hidden` buries the child's errors; the tray reports success even when `Start-Service` failed** — `scripts/tray/tally-mcp-tray.ps1:379`
  - Why: the elevated child does `taskkill` → sleep → `Start-Service -ErrorAction Stop` → `Get-Service | Write-Host`, but runs `-WindowStyle Hidden` with no `-Wait` and no exit-code readback, so the diagnostic and any failure are invisible and the tray can't know if it worked.
  - Fails when: the service is Disabled or has a corrupt NSSM AppDirectory → `Start-Service` throws in the hidden window and the child exits; the tray shows no error, the operator believes the restart succeeded, the service stays down.
  - Fix: drop `-WindowStyle Hidden` or have the child write a result/exit code (temp file or `-Wait` + `$proc.ExitCode`) and surface success/failure via balloon/MessageBox.

---

## Low severity (14)

### GUI agent automation

- [ ] **Credentials flow through a world-readable command file and are captured in a screenshot left on a public path; password typed char-by-char globally with no focus atomicity** — `scripts/tally-gui-agent-v2.ps1:569`
  - Why: the password arrives in plaintext in `_mcp_gui_command.json` under `C:\Users\Public\TallyPrimeEditLog\data` (the code notes this file was "previously world-writable"); `Get-Screenshot` writes the live Tally window — possibly the credential screen — to `_mcp_screenshot.png` in that same public dir every step and never deletes it.
  - Fails when: an LLM-path login → a mid-typing focus loss splits the password across two windows, and the on-disk screenshot + lingering plaintext command file expose the credential to any local user of the Public folder.
  - Fix: never pass secrets through the plaintext IPC file (use DPAPI/named-pipe/ACL'd file, overwrite after read); write screenshots to a per-user ACL'd temp path and delete after each step; mask credential frames.

### External state

- [ ] **"Public URL: OK" only means an HTTP status 200-499 came back — it never validates the response is the real OAuth-metadata endpoint, so a broken endpoint reads healthy (green)** — `scripts/tray/tally-mcp-tray.ps1:210`
  - Why: `PublicUrlOk = (StatusCode >= 200 -and < 500)` treats 401/403/404 and any post-redirect 200 as OK and never inspects Content-Type/body; `Invoke-WebRequest` follows redirects, so a parked page, captive portal, or wrong vhost all classify OK and drive the green icon.
  - Fails when: Caddy is up but the MCP route returns 404 (or the domain points at a parked page returning 200) → the tray shows "Public URL: OK" and green while the endpoint is broken to clients.
  - Fix: treat only 2xx as reachable, don't auto-follow redirects, and validate the payload is JSON containing the `oauth-protected-resource` fields; show 3xx/4xx as a distinct "responding but not MCP metadata" state.

- [ ] **Probe ports 3000 (localhost MCP) and 9000 (Tally) are hardcoded and ignore the configurable `PORT`/`TALLY_PORT` — editing either documented knob makes the tray report false failures** — `scripts/tray/tally-mcp-tray.ps1:207`
  - Why: the tray probes `127.0.0.1:3000` and `127.0.0.1:9000` while the server reads `process.env.PORT` and Tally reads `TALLY_PORT`; `firstrun-config.ps1` writes `TALLY_PORT` as an editable line but the tray never reads either.
  - Fails when: operator sets `TALLY_PORT=9001` or `PORT=8080` → server/Tally run fine on the new ports but the tray keeps probing 9000/3000, so both probes fail and the icon is permanently yellow on a healthy install.
  - Fix: read `PORT` and `TALLY_PORT` from `.env` (defaults 3000/9000) and build the probe URLs from them.

- [ ] **`.env` parsing mishandles single-quoted values, inline `#` in values, and `export` prefixes; `MCP_DOMAIN` is written unquoted while paths are quoted (asymmetric)** — `scripts/tray/tally-mcp-tray.ps1:94`
  - Why: `Read-EnvValue` strips only surrounding double quotes (single-quoted paths keep their quotes), truncates unquoted values at the first `#` (but `MCP_DOMAIN` is written unquoted), doesn't handle `export KEY=`, passes no `-Encoding` (BOM-less UTF-8 → mojibake), and its backslash un-escaping diverges from `_envQuote`.
  - Fails when: an operator hand-edits `.env` (a workflow the tray invites) with `TALLY_DATA_PATH='C:\Users\Public\data'` or a trailing backslash → the registry path never resolves, so "Reload last company", "Manage Companies", and "Open registry file" all point at a nonexistent file, silently.
  - Fix: handle single-quoted values, strip optional leading `export `, pass `-Encoding UTF8`, and align quote/backslash unescaping with `_envQuote` (or share one parser).

- [ ] **"Reload last company" selection is culture-dependent and silently disabled on array-shaped registry JSON** — `scripts/tray/tally-mcp-tray.ps1:227`
  - Why: the sort casts `[datetime]$_.lastLoadedAt` using current culture (hand-edited `07/04/2026` parses differently per locale, or throws → MinValue), and the block assumes `$parsed.companies` exists — node's own loader defends against array-shaped registry JSON, for which `.companies` is `$null`.
  - Fails when: on a non-US machine an operator hand-edits `lastLoadedAt` to `04/07/2026` → interpreted as 7 April, so a stale company outranks the latest and the wrong one reloads; or an array-shaped registry leaves the menu permanently "(none yet)".
  - Fix: parse with `InvariantCulture` + `RoundtripKind` (or `ParseExact` on `'o'`), and tolerate both object- and array-shaped registry JSON.

- [ ] **The "Public URL: not configured" state is dead code — `PublicUrlOk` is never left `$null`, so localhost-only installs show "unreachable" and a permanent yellow icon** — `scripts/tray/tally-mcp-tray.ps1:206`
  - Why: `Invoke-StatusPoll` always assigns `PublicUrlOk` to a bool (falls back to probing localhost when `MCP_DOMAIN` is unset; catch sets `$false`), so the `$null` "not configured" branches in tooltip/menu/dashboard never render, and `Get-OverallStatus` folds `urlOk` into green.
  - Fails when: a localhost-only deployment (no `MCP_DOMAIN`, by design) with healthy service+agent → the hardcoded localhost probe doesn't get a <500 response, so the tray shows "Public URL: unreachable" and stays yellow forever with no "check doesn't apply" signal.
  - Fix: when `MCP_DOMAIN` is unset, leave `PublicUrlOk = $null` (skip/track separately) so "not configured" renders, and exclude the URL check from the green/yellow decision in localhost-only mode.

- [ ] **Loaded-company detection assumes the first `<NAME>` in Tally's List-of-Companies response is the active company** — `scripts/tray/tally-mcp-tray.ps1:246`
  - Why: the regex takes the first `<NAME>...</NAME>` match and labels it loaded, based on one verified Tally instance; the List of Companies returns all open (and sometimes on-disk) companies, and envelope/ordering vary across versions.
  - Fails when: two companies are open, or a version emits a header `<NAME>` before the list → the tooltip/dashboard shows "Tally: Running - <wrong-or-non-company>", misleading which company is loaded.
  - Fix: query the specifically-active company (`SVCurrentCompany`/current company) or parse the XML for the active element; degrade to "Running" with no name when uncertain.

### Elevation

- [ ] **Out-of-band elevated restart races the status poll: an operator-initiated restart fires false "service stopped unexpectedly" / "service down" alarm toasts** — `scripts/tray/tally-mcp-tray.ps1:803`
  - Why: the elevated restart holds the service down ~5s in a separate process while the tray's own 5s poll runs independently with no knowledge of it; during the down window the poll reads `Status != Running` while `ServiceWasRunning` is still true and fires the alarm toasts — there's no "restart in progress" suppression flag.
  - Fails when: operator clicks Restart service and approves UAC → mid-restart the poller pops "service stopped unexpectedly. Right-click tray > Restart service" during the very restart they triggered, training them to ignore the toasts.
  - Fix: set a script-scoped "restart in progress until <deadline>" flag on launch and suppress the service-stopped/degradation toasts until the poll sees the service Running or the deadline passes.

### WinForms lifecycle

- [ ] **No single-instance guard: a second launch spawns a duplicate tray icon, timer, and toast stream** — `scripts/tray/tally-mcp-tray.ps1:313`
  - Why: there's no `Mutex` or singleton check before creating the `NotifyIcon` and starting the timer, despite the per-user at-logon task design; nothing prevents a second concurrent copy.
  - Fails when: the logon task fires and the operator/support also runs the tray manually (or the trigger re-fires on fast-user-switching/RDP reconnect) → two identical icons, two 5s WMI+HTTP poll loops (double load), and every state-transition toast fires twice.
  - Fix: acquire a named `Mutex` (`Global\TallyMCPTray-<user SID>`) at startup; if not acquired, optionally re-show the existing instance and exit; release in cleanup.

- [ ] **Status icons are correctly allocated once (no per-poll GDI recreation) — but the tooltip `Substring` can cut mid-line** — `scripts/tray/tally-mcp-tray.ps1:847`
  - Why: (clarification) `New-StatusIcon`/`GetHicon` run only at startup and `Update-TrayUi` merely swaps `$tray.Icon` references, so there is no per-tick icon leak; the one cosmetic wrinkle is `Format-Tooltip` clamping a multi-line CRLF string with `Substring(0,63)`.
  - Fails when: long Service/Agent/Tally/URL status text → the 63-char clamp slices a line in half (e.g. cutting a company name), producing a garbled hover tip. Harmless but ugly.
  - Fix: no action needed for the icon lifecycle; truncate the tooltip on a line boundary or append an ellipsis (or build from a shortened single summary line).

### Silent failures

- [ ] **Timer tick handler has no top-level try/catch; a throw in poll/UI update surfaces as a recurring `ThreadException` or freezes the icon** — `scripts/tray/tally-mcp-tray.ps1:853`
  - Why: `Add_Tick` has no guarding try/catch; `Update-TrayUi`/`Update-DashboardUi` touch UI objects (icon assignment, `ShowBalloonTip`, label `.Text`) that can throw on a disposed/hidden `NotifyIcon` or during a shell-tray restart, becoming an `Application.ThreadException` every interval.
  - Fails when: after Explorer restarts, `ShowBalloonTip` throws inside a tick → with no handler the default .NET error dialog pops *every* `PollIntervalSec`, or (if swallowed) the icon silently stops updating and never recovers.
  - Fix: wrap the tick body in try/catch storing into `$State.LastError` and continuing; guard the `ShowBalloonTip` calls too.

- [ ] **Open logs / Open registry launch `explorer.exe` with no try/catch, unlike the file-not-found paths in the same handlers** — `scripts/tray/tally-mcp-tray.ps1:340`
  - Why: `miOpenLogs` and `miOpenRegistry` call `Start-Process explorer.exe` unguarded while the not-found branches in the same handlers show clean MessageBoxes — inconsistent handling within one handler.
  - Fails when: on a locked-down/shell-replaced box `explorer.exe` launch fails, or the `/select` quoting on an unusual path is rejected → `Start-Process` throws and the operator gets a raw .NET dialog or nothing instead of the graceful MessageBox.
  - Fix: wrap each `Start-Process explorer.exe` call in try/catch showing "Could not open folder: $_".

- [ ] **Dashboard logo load uses an unconditional empty catch that hides corrupt/locked-file errors** — `scripts/tray/tally-mcp-tray.ps1:582`
  - Why: `try { $pic.Image = Image::FromFile($logoPath) } catch {}` discards every exception; mostly cosmetic, but it also masks diagnosable conditions (locked/truncated asset) and `FromFile` holds a file lock on success.
  - Fails when: `jina-logo.png` exists but is corrupt or locked → the dashboard shows a blank logo area with no hint why, making a packaging/asset problem hard to diagnose from the field.
  - Fix: keep it best-effort but record the failure into `$State.LastError`/debug log instead of a bare `catch {}`, and load via a disposed stream to avoid the lock.

- [ ] **Quit handler disposes the tray and exits with no try/catch** — `scripts/tray/tally-mcp-tray.ps1:529`
  - Why: `miQuit` sets `$tray.Visible`, calls `$tray.Dispose()` and `Application.Exit()` with no guard; low likelihood of throwing, but noted for consistency with the other handlers that report errors.
  - Fails when: `$tray.Dispose()` throws during shutdown (already-disposed / shell-tray race) → the unhandled exception surfaces as a `ThreadException` instead of a clean exit, and the icon may linger.
  - Fix: wrap the quit body in try/catch (swallowing is defensible during teardown), or guard each disposal like `Dispose-StatusIcon` already does.

---

## Themes & recommended sequencing

The findings cluster into five structural themes, in rough order of how much they matter:

1. **Open-loop automation that reports "success" on bytes-sent, not results.** The deepest theme.
   `select-and-unlock` blasts keystrokes then unconditionally writes success (`:578`); the LLM path
   trusts a hallucinated `done` the same way (`:411`). Layered on top: focus is best-effort and
   never re-checked before typing the cleartext password (`:529`), keystrokes hit the global input
   queue, and `TypeString` is keyboard-layout-dependent (`TallyUI.cs:74`). The result — wrong
   company loaded, password typed into the wrong window, auth silently failing — all surface to the
   caller as success. Notably, `load-company` at `mcp.mts:1572` *does* re-verify via
   `listLoadedCompanies()`, proving the team knows the fix and just didn't apply it everywhere.

2. **Fire-and-forget elevation with buried errors.** Every admin action offloads to a separate
   elevated process and assumes it worked. Restart-service runs in a `-WindowStyle Hidden` window
   with no `-Wait` and no exit-code readback (`:379`); Reconfigure launches `-Verb RunAs` with no
   try/catch at all (`:511`) — a declined UAC is a silent no-op — while the twin Restart handler
   wraps the identical call in try/catch (`:382`). Same call, opposite handling, same file.

3. **WinForms lifecycle on the UI thread with no safety net.** The health poll runs blocking
   `Invoke-WebRequest` + WMI directly on the message-loop thread every tick (`:853`/`:209`), so a
   slow domain or a hung Tally port freezes the icon, menu, and dashboard. The
   `[hashtable]::Synchronized` wrapper (`:73`) makes it *look* threaded but there's no worker
   thread. No top-level tick try/catch, no `Application.ThreadException` handler before
   `Application.Run()` (`:866`), plus GDI/Font leaks per dashboard open (`:582`) and no
   single-instance guard.

4. **Installer input flows straight to disk with no validation or normalization.** `MCP_DOMAIN` is
   written un-normalized and unquoted (`:261`); Tally paths are never existence-checked (`iss:184`),
   the password has no confirm field (`iss:175`), domain accounts are rejected by a local-only
   `net user` check (`iss:303`), and `_envQuote` doesn't escape backslashes (`:236`). A wizard whose
   purpose is to spare non-technical operators accepts values that break at runtime with no line
   back to the setup step.

5. **Idempotency / path-with-spaces bugs on the default install.** Reconfigure passes
   `-File`/`-InstallDir` unquoted (`:518`), breaking on the default `C:\Program Files\TallyMCP` path
   — the *majority* install. And because `AGENT_TASK_USER` is never persisted (`firstrun:105`), a
   Reconfigure run by a different admin silently re-points the agent task and ACLs to the wrong user.
   Reconfigure also can't actually change most settings it claims to (`firstrun:11`).

### Highest-leverage fixes, in priority order

1. **Make the GUI agent verify ground truth before reporting success** (`:578` and `:411`). After the
   keystrokes / on `done`, query the Tally XML server for the loaded company (or read the window
   title) and only write success if it matches `companyId` — the same discipline `load-company`
   already uses at `mcp.mts:1579`. Pair it with a `GetForegroundWindow==hwnd` re-check before typing
   the password (`:529`) so credentials can't leak on a focus steal. This one change collapses
   theme #1's whole failure class into detectable, retryable errors. **[Applied on this branch]**

2. **Fix the Reconfigure quoting bug** (`:518`). One line — pre-quote `$script` and `$InstallDir`
   exactly as `firstrun-config.ps1:445` already does. The difference between Reconfigure working and
   being broken on the default install path. **[Applied on this branch]**

3. **Validate + normalize `MCP_DOMAIN`** at the wizard and defensively at `:261` (prepend `https://`
   if schemeless, strip trailing slash, parse with `[uri]`, then `_envQuote`). Without this, every
   public/domain deployment silently breaks OAuth discovery. **[Applied on this branch]**

4. **De-risk the tray's elevation and UI-thread patterns together:** move `Invoke-StatusPoll` onto a
   background runspace / `System.Threading.Timer` and keep the Forms.Timer only for repainting
   (`:853`); wrap the Reconfigure/Restart elevated launches in try/catch with visible feedback and
   have the elevated child write back a status/exit code (`:511`/`:382`); and install an
   `Application.ThreadException` handler before `Application.Run()`.

5. **Close the installer idempotency/validation gaps:** persist `AGENT_TASK_USER` into the
   `_Coalesce` chain (`firstrun:105`), and add existence/confirm/domain-account checks at the wizard
   (`iss:184`/`iss:175`/`iss:303`). Lower urgency than 1–4 because they bite on reconfigure and edge
   accounts rather than the first-run happy path.

> **Do this week:** fixes 1 and 2 — #1 removes the only *dangerous* fragility, #2 is a one-line fix
> to a bug that breaks the default install. Fix 3 unblocks all public deployments. All three are
> applied on `fix/gui-hardening`.
