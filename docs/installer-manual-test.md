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
- **Privilege boundaries.** The installer is elevated; the person who uses Claude is not. Anything
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

1. Run the setup `.exe` as an admin who is **not** the person who uses Claude, if you can.
2. Expected wizard pages: License, Destination, Tally configuration (4 fields), Tally edition
   (+ the "Let Claude see and drive the Tally window" checkbox, ticked), Ready, Install, Finished.
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

Then, **as the user who runs Claude**:

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

The #229 follow-ups, on the same install:

- [ ] `nssm set TallyMCPTunnel AppEnvironment TUNNEL_TOKEN=x HTTPS_PROXY=y`, then Reconfigure:
      `AppEnvironment` keeps `HTTPS_PROXY=y` and has no `TUNNEL_TOKEN`
- [ ] `[Environment]::SetEnvironmentVariable('TUNNEL_TOKEN', 'x', 'Machine')`, then Reconfigure: a
      red `SECURITY: a machine-wide TUNNEL_TOKEN` warning, the variable is still there afterwards,
      and `verify-deployment.ps1` FAILs *Tunnel token kept out of the service registry* until it is
      removed. Remove it again when done.
- [ ] Rename `bin\cloudflared.exe`, then Reconfigure: the window stops on an error and the script
      exits non-zero (it used to print a WARN, say "Configuration complete." and exit 0). Put it back.

## 6b. Non-English Windows (#230)

On a Windows installed in another language - German or French, where `Administrators` is
`Administratoren` / `Administrateurs` - with the UI language set to it. (The CI harness simulates
this by making every account *name* fail in its icacls stand-in; this is the real thing.)

- [ ] A fresh install completes, and `icacls` on `.env`, on `%ProgramData%\Claudally\agent` and on
      the vault in it shows no `(I)` entries on `.env` and the folder, only SYSTEM, Administrators and
      the agent user under their localised names; `icacls %ProgramData%\Claudally` shows SYSTEM and
      Administrators only
- [ ] `verify-deployment.ps1` (elevated) reports *Configuration file ACL*, *Agent folder ACL* and
      *Company vault ACL* as PASS
- [ ] An install made on that machine by a build **before** #230 reports *Configuration file ACL* as
      FAIL (inheritance enabled); an unattended upgrade to this build then turns it PASS
- [ ] Make the lockdown fail - e.g. deny Administrators write on `%ProgramData%\Claudally` - and run
      Setup: it shows the error, its last page says configuring FAILED, and it exits 10. For an
      unattended upgrade over such an install, the preflight refuses first (exit 7) and nothing is
      stopped.

## 6c. A Tally PC shared by several Windows accounts (#230 follow-up)

The case the move out of Tally's data folder is for. Two local accounts, **alice** (the accountant the
GUI agent runs as) and **bob** (a second person who also uses Tally on this PC), both able to open the
same Tally company from `C:\Users\Public\TallyPrimeEditLog\data` before anything of ours is installed.

Upgrade from a build before this change:

- [ ] Install the **old** build with alice as the agent user. Confirm the problem first: signed in as
      bob, Tally can no longer open the company (`icacls <data folder>` shows `SYSTEM`,
      `Administrators` and `alice` only, no `(I)` entries).
- [ ] Save a company password in Manage Companies (as alice). Note the vault file's SHA-256.
- [ ] Upgrade to this build (interactive, then repeat with the unattended `/UPDATE` path).
- [ ] `icacls <data folder>` shows inherited `(I)` entries again, plus alice's explicit entry; the
      SYSTEM and Administrators explicit entries are gone. The Setup log / `firstrun-config.log`
      lists each restored item.
- [ ] Signed in as **bob**, Tally opens the company again. Company sub-folders show `(I)` entries too.
- [ ] `%ProgramData%\Claudally\agent\.tally-mcp-companies.json` exists with the same SHA-256 as
      noted; the data folder has no `.tally-mcp-companies.json` and no `_mcp_*` files.
- [ ] As alice, *Reload last company* / load-company with the stored password works (the password
      still decrypts from the new location).
- [ ] As bob, `Get-Content C:\ProgramData\Claudally\agent\.tally-mcp-companies.json` and
      `Get-ChildItem C:\ProgramData\Claudally\agent` are denied, and bob cannot create a file there.
- [ ] `verify-deployment.ps1` (elevated) reports *Tally's data folder left to Tally* and *Agent
      folder ACL* as PASS.

Fresh install, and hand-made permissions:

- [ ] On a PC where the data folder was never touched by us, install: `icacls <data folder>` output is
      identical before and after, and the log says "already inherits its permissions; nothing to
      restore".
- [ ] Before an upgrade from the old build, add bob explicitly to the data folder
      (`icacls <data> /grant bob:(OI)(CI)M`). After the upgrade that entry is still there.
- [ ] Disable inheritance on the data folder in some other shape (e.g. copy entries, then remove
      Administrators). Reconfigure warns that it was "not in the shape" it left it and changes
      nothing; `verify-deployment.ps1` shows a WARN with `icacls ... /inheritance:e`.

Planted folder:

- [ ] As bob (not an administrator), before installing: `mkdir C:\ProgramData\Claudally\agent`. Run
      Setup: it stops with an error naming bob as the owner, writes nothing into that folder, and exits
      10 (an unattended upgrade refuses in the preflight with exit 7). Delete the folder as an
      administrator and run Setup again: it succeeds.
- [ ] Same with a junction: `mklink /J C:\ProgramData\Claudally\agent C:\Users\bob\Desktop\x`. Setup
      refuses; `icacls C:\Users\bob\Desktop\x` is unchanged.

## 7. Uninstall

Set up first: a second Windows profile that has also connected Claude, and a **fork** of the repo
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
confirming for real: with the `TallyMCPAgent` task running, ask Claude to take a screenshot. A
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
