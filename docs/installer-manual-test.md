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
- [ ] `verify-deployment.ps1` reports no FAIL

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

## 7. Uninstall

Set up first: a second Windows profile that has also connected Claude, and a **fork** of the repo
at some other path with its own `claude_desktop_config.json` entry pointing at
`D:\my-fork\dist\index.mjs`.

- [ ] Uninstall prompts about saved company passwords (the DPAPI vault) rather than silently
      shredding or silently keeping them
- [ ] Answering "no" leaves the vault file in place
- [ ] Answering "yes" removes it
- [ ] The `tally` entry is removed from **both** profiles' `claude_desktop_config.json`
- [ ] The fork's entry at `D:\my-fork\...` is **left alone** - the ownership gate compares the full
      install root, not just the `dist\index.mjs` tail
- [ ] Other MCP servers in those files are untouched
- [ ] `.env` is gone
- [ ] No `node.exe` belonging to another application was killed

> **Not yet verified end to end:** the drop-to-user trampoline on the *uninstall* path. The
> install-time path is verified; the uninstall-time one has only been reasoned about. Until
> someone runs case 7 on a VM with two profiles, treat the multi-profile cleanup as unproven.

## 8. Regression: one-shot agent while the watcher is running

CI covers this (`windows-sources` job), but if you are already on a VM with Tally open it is worth
confirming for real: with the `TallyMCPAgent` task running, ask Claude to take a screenshot. A
mutex regression here returns `null` in a way that looks exactly like a timeout.
