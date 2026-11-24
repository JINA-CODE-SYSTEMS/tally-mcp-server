# Installer manual test checklist

CI now compiles `tally-mcp.iss` and parses every PowerShell script under Windows PowerShell 5.1
on every PR ([ci.yml](../.github/workflows/ci.yml), `windows-sources` job). That covers syntax,
encoding and the Pascal Script. It cannot cover any of the following, and every item below is
here because it actually broke at least once:

- **Pascal Script has no bounds checking on `Values[]`.** Reindexing a wizard page compiles
  perfectly and then reads the wrong field at runtime. When the password moved from `ConfigPage`
  to `RemotePage`, the tunnel validation kept reading the old indices and would have rejected a
  valid hostname for a blank password. No compiler will ever tell you this.
- **Interactivity.** A `Read-Host` on a path the installer reaches makes the install hang with no
  visible window, because `[Run]` uses `runhidden`.
- **Privilege boundaries.** The installer is elevated; the person who uses the AI assistant is not. Anything
  that has to land in a user's `%APPDATA%` goes through the scheduled-task trampoline, which no
  unit test exercises.
- **Upgrade paths.** Preserved state (deployment mode, GUI-control choice, password) is only real
  if you upgrade over a *previous* install.
- **SYSTEM.** The update task runs Setup as SYSTEM, on a desktop nobody can see. CI runs
  `firstrun-config.ps1 -Upgrade` against fake installs
  ([test-firstrun-config.ps1](../scripts/installer/test-firstrun-config.ps1)), but only a real
  install run as SYSTEM proves the whole chain - section 9.

Run this on a throwaway VM, never on a box with a production `TallyMCP` service.

## Before you start

```powershell
# From a clean checkout, on the VM:
npm ci; npm run build
pwsh scripts\installer\build-installer.ps1        # produces dist-installer\Claudally-Setup-<ver>.exe
```

Take a VM snapshot now. Several cases below need you to roll back to "nothing installed".

## 1. Index audit (do this at review time, not on the VM)

For each `CreateInputQueryPage` / `CreateInputOptionPage` in `tally-mcp.iss`, list the `.Add()`
calls in order and confirm every `Values[n]` read and write elsewhere in the file matches that
order. Today:

| Page | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| `ConfigPage` | Tally exe path | Tally data folder | `tally.ini` path | agent Windows user |
| `RemotePage` *(suppressed, [#192](https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/issues/192))* | OAuth password | public domain / tunnel hostname | tunnel token |  |

Check the `{code:GetWizard*}` accessors and `NextButtonClick`'s validation against that table.

## 2. Fresh local install

1. Run the setup `.exe` as an admin who is **not** the person who uses the AI assistant, if you can.
2. Expected wizard pages: License, Destination, Tally configuration (4 fields), Tally edition
   (+ the "Let your AI assistant see and drive the Tally window" checkbox, ticked), Ready, Install, Finished.
   **There must be no mode page and no password/domain/tunnel page.**
3. The install must not hang. If it does, something on the local path is prompting.

Then verify:

```powershell
Get-Content 'C:\Program Files\TallyMCP\.env'
```

- [ ] `DEPLOYMENT_MODE=local`
- [ ] No `PASSWORD`, `BIND_HOST`, `MCP_DOMAIN` or `TUNNEL_TOKEN` line at all
- [ ] `ENABLE_GUI_CONTROL=true`

```powershell
Get-Service TallyMCP -ErrorAction SilentlyContinue   # must return nothing
Get-ScheduledTask TallyMCPAgent, TallyMCPTray | Select-Object TaskName, State
pwsh scripts\verify-deployment.ps1
```

- [ ] No `TallyMCP` service exists
- [ ] Nothing is listening on the MCP port
- [ ] Both scheduled tasks exist and are Ready/Running
- [ ] `verify-deployment.ps1`, run from an **elevated** prompt, ends `VERDICT: PASS` and exits 0 -
      no FAIL and no UNKNOWN. (Unelevated, UNKNOWN on the deployment-mode and vault checks is
      expected, because the installer locks `.env` and the vault away from other accounts; that is
      exit 3, not a failure, but it is also not the verification this step asks for.)

Then, **as the user who runs the AI assistant**:

- [ ] `%APPDATA%\Claude\claude_desktop_config.json` contains a `tally` server entry pointing at
      `C:\Program Files\TallyMCP\dist\index.mjs`
- [ ] Any pre-existing MCP servers in that file are still there (the installer merges, it does not
      replace) - put a dummy entry in before installing to prove it
- [ ] `%LOCALAPPDATA%\Claudally\last-connect-result.json` says it succeeded
- [ ] Restart Claude Desktop; the `tally` tools appear and `tally_ping` answers

## 3. Tray, in local mode

- [ ] The tray icon is not red because a service is missing - local mode has no service
- [ ] The dashboard shows the version from `package.json`, not a hardcoded one
- [ ] Rows/captions describe a local install (no service row, no public URL)

## 4. Reconfigure

Start Menu -> **Reconfigure Claudally**, as a *non-elevated* user.

- [ ] It prompts for elevation rather than failing silently or writing nothing
- [ ] Cancelling the UAC prompt leaves `.env` untouched
- [ ] Completing it preserves `DEPLOYMENT_MODE=local`

## 5. GUI-control choice survives an upgrade, in both directions

1. Fresh install with the checkbox **unticked**. Confirm `ENABLE_GUI_CONTROL=false`.
2. Install again over the top. The checkbox must come up **unticked**, and the value must stay
   `false` - an upgrade must not re-enable it for someone who deliberately turned it off.
3. Roll back, install with it ticked, upgrade, confirm it stays `true`.

## 6. Upgrade over an existing *remote* install

This is the case [#192](https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server/issues/192) has to
not break. Build an installer from a commit before the remote pages were suppressed, install it
with a password and domain, then upgrade with the current build.

- [ ] `DEPLOYMENT_MODE` is still `remote`
- [ ] `PASSWORD`, `MCP_DOMAIN` and `TUNNEL_TOKEN` are unchanged
- [ ] The `TallyMCP` service still exists and is running
- [ ] The wizard still shows no mode or password page (it passes no mode; firstrun preserves)
- [ ] `logs\firstrun-config.log` has no "Credentials file not found". (Before #177's fix the
      installer always passed a credentials-file path it never wrote, so this upgrade threw
      before reading `.env` and left the service disabled.)

If that install had a Cloudflare Tunnel token (#193 - older builds put it in the service registry):

- [ ] `(Get-Item HKLM:\SYSTEM\CurrentControlSet\Services\TallyMCPTunnel\Parameters).GetValue('AppEnvironmentExtra')`
      has no `TUNNEL_TOKEN=` entry, and neither does the same value under `TallyMCP`; any other
      entry that was there before is still there
- [ ] `nssm get TallyMCPTunnel AppParameters` is `tunnel run --token-file .tunnel-token`
- [ ] `icacls "C:\Program Files\TallyMCP\.tunnel-token"` shows only `NT AUTHORITY\SYSTEM:(F)` and
      `BUILTIN\Administrators:(F)`, no `(I)` entries; `(Get-Acl ...).Owner` is `BUILTIN\Administrators`
- [ ] `TallyMCPTunnel` is running and `logs\tunnel.log` shows `Registered tunnel connection`
- [ ] `verify-deployment.ps1` (elevated) reports *Tunnel token kept out of the service registry* as PASS
- [ ] Reconfigure with the token blanked removes `.tunnel-token`

If that install had a Cloudflare Tunnel token (#193 - older builds put it in the service registry):

- [ ] `(Get-Item HKLM:\SYSTEM\CurrentControlSet\Services\TallyMCPTunnel\Parameters).GetValue('AppEnvironmentExtra')`
      has no `TUNNEL_TOKEN=` entry, and neither does the same value under `TallyMCP`; any other
      entry that was there before is still there
- [ ] `nssm get TallyMCPTunnel AppParameters` is `tunnel run --token-file .tunnel-token`
- [ ] `icacls "C:\Program Files\TallyMCP\.tunnel-token"` shows only `NT AUTHORITY\SYSTEM:(F)` and
      `BUILTIN\Administrators:(F)`, no `(I)` entries; `(Get-Acl ...).Owner` is `BUILTIN\Administrators`
- [ ] `TallyMCPTunnel` is running and `logs\tunnel.log` shows `Registered tunnel connection`
- [ ] `verify-deployment.ps1` (elevated) reports *Tunnel token kept out of the service registry* as PASS
- [ ] Reconfigure with the token blanked removes `.tunnel-token`

## 7. Uninstall

Set up first: a second Windows profile that has also connected the AI assistant, and a **fork** of the repo
at some other path with its own `claude_desktop_config.json` entry pointing at
`D:\my-fork\dist\index.mjs`.

- [ ] Uninstall prompts about saved company passwords (the DPAPI vault) rather than silently
      shredding or silently keeping them
- [ ] Answering "no" leaves the vault file in place
- [ ] Answering "yes" removes it. (Before #177's fix this never happened: the answer was passed as
      an `[UninstallRun]` parameter, which Inno expands at install time.)
- [ ] As SYSTEM, `unins000.exe /VERYSILENT` finishes without hanging and removes the vault;
      with `/KEEPVAULT` added it keeps it
- [ ] The `tally` entry is removed from **both** profiles' `claude_desktop_config.json`
- [ ] The fork's entry at `D:\my-fork\...` is **left alone** - the ownership gate compares the full
      install root, not just the `dist\index.mjs` tail
- [ ] Other MCP servers in those files are untouched
- [ ] `.env` is gone
- [ ] `.tunnel-token` is gone (when a tunnel was configured)
- [ ] No `node.exe` belonging to another application was killed

> **Not yet verified end to end:** the drop-to-user trampoline on the *uninstall* path. The
> install-time path is verified; the uninstall-time one has only been reasoned about. Until
> someone runs case 7 on a VM with two profiles, treat the multi-profile cleanup as unproven.

## 8. Regression: one-shot agent while the watcher is running

CI covers this (`windows-sources` job), but if you are already on a VM with Tally open it is worth
confirming for real: with the `TallyMCPAgent` task running, ask the AI assistant to take a screenshot. A
mutex regression here returns `null` in a way that looks exactly like a timeout.

## 9. Unattended upgrade, run as SYSTEM

What the daily update task will do ([installer.md, "Unattended upgrade"](installer.md#unattended-upgrade-and-silent-installs)).
Needs an elevated prompt on the VM, and a way to run a command as SYSTEM - Sysinternals
`psexec -s -i 0 cmd.exe` is simplest; a one-shot scheduled task with `-User SYSTEM` is closest to
the real thing. Never on a production box.

Set up: install the *previous* release interactively, as an admin who is **not** the accountant,
choosing the accountant as the agent user, then make every setting non-default: point the Tally
paths somewhere else, choose Gold, untick GUI control **from the tray** (not the wizard), and add a
line such as `READONLY_MODE=true` to `.env` by hand. Snapshot. Then record:

```powershell
$app = 'C:\Program Files\TallyMCP'
Get-FileHash "$app\.env"
Get-ScheduledTask TallyMCPAgent, TallyMCPTray | ForEach-Object { "$($_.TaskName) $($_.Principal.UserId)" }
Get-FileHash "C:\Users\<accountant>\AppData\Roaming\Claude\claude_desktop_config.json"
```

**a. Local-mode upgrade.** As SYSTEM:

```
Claudally-Setup-<new>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /UPDATE /LOG=C:\Windows\Temp\claudally-upgrade.log
echo %ERRORLEVEL%
```

- [ ] It returns (no hang) with exit code 0
- [ ] `.env` has the **same hash** as before
- [ ] Both tasks still run as the accountant - not SYSTEM, not the admin
- [ ] `claude_desktop_config.json` has the same hash
- [ ] The agent and tray are running again in the accountant's session (if they are logged on)
- [ ] The Setup log contains "Unattended upgrade of ..." and "OK: the upgrade can preserve this
      install", and `logs\firstrun-config.log` says ".env left exactly as it was"

**b. Remote-mode upgrade.** Repeat (a) over a remote install from section 6, tunnel configured,
installed with a build from **before #193** so its token is in the service registry. This is the
path every such install will take to receive that migration.

- [ ] Exit code 0, `.env` hash unchanged
- [ ] `TallyMCP` and `TallyMCPTunnel` exist, are Running and set to Automatic
- [ ] `https://<host>/.well-known/oauth-protected-resource` answers
- [ ] Every #193 check in section 6 holds: no `TUNNEL_TOKEN=` in either service's
      `AppEnvironmentExtra` (other entries kept), `nssm get TallyMCPTunnel AppParameters` is
      `tunnel run --token-file .tunnel-token`, `.tunnel-token` locked to SYSTEM + Administrators
- [ ] The Setup log (`/LOG`) and `logs\firstrun-config.log` do not contain the token
- [ ] No `.tunnel-token.preflight` is left in the install folder

**c. Refused upgrade changes nothing.** Delete the `AGENT_TASK_USER` line from `.env` and run
`Unregister-ScheduledTask TallyMCPAgent`, then run (a) again as SYSTEM.

- [ ] Exit code 7, promptly
- [ ] The Setup log says `REFUSED:` and why
- [ ] Nothing was stopped: in remote mode `TallyMCP` is still Running; files in `dist\` still have
      the old version's timestamps

**d. Silent new install.** Roll back to "nothing installed". As SYSTEM:

- [ ] `/VERYSILENT /SUPPRESSMSGBOXES` with no `/AGENTUSER` exits 7 and installs nothing
- [ ] `/AGENTUSER=SYSTEM` exits 7
- [ ] `/AGENTUSER=<accountant>` installs; both tasks run as the accountant

**e. Interactive runs are unchanged.** Run the new installer by double-clicking over an existing
install: the wizard appears as before. (It still pre-fills defaults rather than this install's
values - see the note in [installer.md](installer.md#unattended-upgrade-and-silent-installs).)

## 10. People working in Tally, several AI windows, bulk entry (0.11.0, epic #44)

None of this can run in CI: it needs Windows, Tally and a person at the keyboard. Install the build,
open Tally with a test company, and connect two AI apps (or two windows of one) to Claudally.

**a. AI-activity frame (#22).**

- [ ] Posting a voucher shows the orange frame around Tally with "Your AI assistant is posting to
      Tally"; it disappears a few seconds after the last write
- [ ] A `gui-send-keys` shows "…controlling Tally - please don't use the keyboard or mouse"
- [ ] `load-company` shows "…reopening Tally" for the whole restart
- [ ] The frame follows a moved and a maximised Tally window, never takes focus, and clicks go
      through it to Tally
- [ ] No frame in `gui-screenshot` output (take several in a row)
- [ ] Tally minimised: no frame, no error. The agent draws no second frame

**b. No typing over a person (#24, #35).**

- [ ] Keep moving the mouse; `gui-send-keys` returns `USER_ACTIVE` and nothing is typed
- [ ] Stop moving within 10 s: the action then goes ahead
- [ ] Two `gui-send-keys` calls a few seconds apart, hands off: the second is NOT refused (the
      agent's own keystrokes do not count as a person)
- [ ] Lock the PC (Win+L): a GUI action returns `SESSION_LOCKED` within a few seconds; posting a
      voucher still works; `status` shows `guiAvailable: false` with the reason
- [ ] Disconnect an RDP session: `SESSION_DISCONNECTED`. Sign in as another user: `WRONG_USER`

**c. Restart confirmation and countdown (#25).**

- [ ] `load-company` without `confirmRestart` returns `RESTART_NEEDS_CONFIRMATION`; Tally untouched
- [ ] With `confirmRestart: true` while you are typing in Tally: `USER_ACTIVE`, Tally untouched
- [ ] Hands off for a minute, `confirmRestart: true`: the tray countdown appears; **Cancel**
      returns `RESTART_CANCELLED_BY_USER` and Tally is untouched; **Restart now** proceeds at once
- [ ] The countdown never takes focus: typing in Tally while it is up does not answer it
- [ ] A company that is already loaded: no restart at all

**d. Several AI windows (#26, #27).**

- [ ] Two windows call `gui-screenshot` at the same moment: one succeeds, the other gets `BUSY`
      with `retryAfterSec` promptly (no 20 s timeout)
- [ ] While window A runs `load-company`, window B posts a voucher: B waits, then gets `BUSY`;
      nothing is written into the restarting Tally
- [ ] Kill a server process mid-`load-company`: within `MACHINE_LOCK_STALE_SEC` other windows work again
- [ ] Both windows post with idempotency keys at once: every key replays afterwards

**e. Wrong books (#29).**

- [ ] `status` shows `machine`, `companyId` (GUID) and `companyNumber` for the loaded company. If
      `companyId` is null, the TDL fields `$Guid` / `$CompanyNumber` need adjusting for this build
- [ ] A write with a wrong `expectedCompanyId` is refused with `COMPANY_MISMATCH`; with the right
      GUID or the company number it goes through

**f. Duplicate numbers, batches, import (#28, #31, #32).**

- [ ] On a manually numbered voucher type, posting an existing number is refused with
      `DUPLICATE_NUMBER` and lists the existing voucher. If it is not refused, check the
      `NUMBERINGMETHOD` field name for this build (the check fails open)
- [ ] A batch where row 3 fails (a ledger that does not exist): the result has a `batchId`; fix the
      ledger and resend with `resumeBatchId` - rows 1-2 are not posted twice
- [ ] `undo-batch` previews exactly that batch; alter one of its vouchers in Tally, and undo refuses
      it with `VOUCHER_CHANGED` while deleting the rest after `confirm: true`. On Edit Log builds the
      rows come back `requires_gui`
- [ ] Post a voucher with reference "INV/55", then a batch row for the same type and party with
      "INV 55": Tally alters the first, and `undo-batch` lists it as existed-before, never as a
      voucher to delete. If it shows as needs-confirmation instead, the `voucher-by-remoteid` report
      (`$RemoteID` filter) does not work on this build
- [ ] `import-vouchers` on a 500-row CSV and on an .xlsx saved by Excel: the dry run shows totals and
      row-numbered errors; the real run posts in chunks of 50; resume after killing it part-way

**g. Show after posting (#23).** Keep it off until this passes on each supported TallyPrime version.

- [ ] Tray > "Show each posted voucher in Tally" on, restart the AI app, post a voucher: the Day Book
      for that date opens. Nothing is altered
- [ ] With a voucher entry screen open, and with a popup open: confirm the key sequence does nothing
      harmful. If Alt+G does not open Go To on this build, the step must stay off for it

**h. Tray tools (#33, #34, #37, #38, #39).**

- [ ] Tally closed: tray says "Tally is closed"; Start Tally starts it and reports "Tally is ready"
- [ ] XML server off in Tally: tray says so; with Tally closed, "Switch on Tally's XML server" backs
      up `tally.ini` (`tally.ini.bak-*`) and sets the keys. **Verify the key names `Client Server`
      and `Port` and their values on this TallyPrime version**, then that `status` turns healthy
- [ ] Two Tally copies open: the copies dialog lists both (path, version, start time); closing one
      asks first; loading works again afterwards
- [ ] Dashboard "AI apps" lists Claude Desktop, Cursor, Windsurf, LM Studio with the right state;
      Fix / Connect work
- [ ] Install Cursor (or Windsurf / LM Studio) after Claudally: within a few minutes the tray offers
      to connect it, once
- [ ] "Tally is on another computer…" with a Tally server on a second PC: posting and reports work;
      `load-company` and GUI tools return `NOT_AVAILABLE_REMOTE_TALLY`; no frame, no copy warnings

**i. Claude Desktop extension (#40).** On classic and packaged Claude Desktop, and on a Team-plan
account: open `claudally-<version>.mcpb`; Claude Desktop installs it with no file edits and Tally's
tools appear. With Claudally not installed it says to install Claudally first.

**j. Windsurf and LM Studio (#39).** Fresh install with each present: its config gets the
`tally-prime` entry and the app lists Tally's tools; uninstall removes the entry.
