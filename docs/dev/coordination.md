# Coordination files (server ↔ tray ↔ GUI agent)

Every AI app window starts its own server process, a Windows service may run one more, and all of
them share one Tally. These files are how they, the tray and the GUI agent agree on what is
happening. The server side lives in `src/coordination.mts`; the tray side in
`scripts/tray/tally-mcp-tray.ps1`; the agent side in `scripts/tally-gui-agent-v2.ps1`.
Change a format only in all three places at once.

## Where

All files live in the **coordination folder**: `TALLY_DATA_PATH` from the install's `.env`
(default `C:\Users\Public\TallyPrimeEditLog\data`).

Not `%LOCALAPPDATA%`: a packaged (MSIX) client such as Claude Desktop has its AppData writes
redirected into a private package folder, so two apps would each see their own lock and the
tray would see neither. The Tally data folder is outside that virtualisation and is the same
path for the service and every stdio process.

All JSON is UTF-8, written to a temp file and renamed into place. Readers must tolerate a
leading BOM and a missing or half-written file (treat as absent). On Windows the rename fails
while a reader holds the target open without `FILE_SHARE_DELETE` (`File.ReadAllText` does), so the
server retries it briefly and removes its temp file if it still fails; readers should keep files
open as briefly as they can.

## 1. Activity signal (#22)

`_mcp_activity\<pid>.json`, one per server process:

```json
{ "schemaVersion": 1, "kind": "posting", "tool": "create-voucher", "at": "2026-11-23T10:00:00.000Z", "pid": 1234, "hideForScreenshot": true }
```

- `kind`: `posting` (an XML write), `controlling` (a screen action), `loading` (a company
  load / Tally restart).
- `at` is refreshed every second while the action runs, and once more when it ends.
- **Fresh** means `now - at <= 4 s`. The tray shows the frame while any record is fresh and
  fades it after the last one goes stale. Several fresh records: `loading` beats
  `controlling` beats `posting` (stronger warning wins).
- `hideForScreenshot: true` means a screenshot is being captured right now: hide the frame
  immediately so it never appears in what the model sees. It is refreshed every second for the
  whole capture (the agent may first wait up to `userIdleWaitSec` for a person to stop typing), so
  the usual freshness rule applies to it.
- One file per process, but one process can run several actions at once (an MCP client may call
  tools in parallel; the service serves several clients). The record is the merge of everything
  that process is doing: the strongest `kind`, and `hideForScreenshot` while any screenshot runs.
- Banner text:
  - posting: `Your AI assistant is posting to Tally`
  - controlling: `Your AI assistant is controlling Tally - please don't use the keyboard or mouse`
  - loading: `Your AI assistant is reopening Tally`
- Files whose pid is no longer running may be deleted by the tray.

## 2. Machine-wide lock (#26)

`_mcp_tally.lock`, created with exclusive create:

```json
{ "pid": 1234, "tool": "gui-send-keys", "kind": "gui", "startedAt": "...", "host": "TALLY-PC", "token": "...", "refreshedAt": "...", "probe": true }
```

- `kind`: `gui` (one screen action) or `load` (a company load or switch, which XML writes
  also wait out).
- `refreshedAt` (optional): the holder rewrites it every 5 s while it runs, only while the file
  still carries its `token`. A holder that has it is judged by it instead of by `startedAt`.
- `probe: true` (optional): a passive agent probe (`ping` / `idle-status`) holding the lock for one
  IPC round-trip (see section 4). Other takers wait it out (up to 10 s) instead of answering BUSY.
  The tray should not show "AI is busy" for it.
- Stale when the pid is not running (same host only; another host's holder is judged by age),
  or:
  - with `refreshedAt`: it is older than 30 s, or `startedAt` is older than
    `MACHINE_LOCK_MAX_HOLD_SEC` (default 900, never less than `MACHINE_LOCK_STALE_SEC`; a hard
    ceiling so a hung holder whose refresh timer still runs expires);
  - without it: `startedAt` is older than `MACHINE_LOCK_STALE_SEC` (default 300).
- Takeover goes through a short-lived `_mcp_tally.lock.takeover` guard file holding the taker's
  token. A stale lock is never deleted by path: it is renamed to `_mcp_tally.lock.stale-<token>`,
  checked to be the holder that was judged stale, and put back (`link`, never overwriting) if it
  turns out to be a fresh lock created meanwhile. Release does the same with its own token, and a
  guard older than 10 s (a crashed takeover) is cleared the same way.
- A holder whose lock was taken over (it stopped refreshing, or passed the hard ceiling) stops:
  its next screen step answers BUSY instead of running alongside the new holder.
- A caller that cannot get it returns `BUSY` with `retryable: true` and `retryAfterSec`.
- The tray may read it to say "AI is busy: <tool>". It must never create, rewrite or delete it.

## 3. Restart countdown (#25)

Before `load-company` (and any path that restarts Tally) kills Tally, the server writes
`_mcp_restart_request.json`:

```json
{ "schemaVersion": 1, "requestId": "1234-...", "tool": "load-company", "company": "Ross Industries", "pid": 1234, "requestedAt": "...", "deadline": "..." }
```

The tray shows a topmost countdown until `deadline`:
"Your AI assistant will restart Tally in 10s to load Ross Industries. Anyone entering data
in Tally will lose unsaved work." with **Cancel** and **Restart now** buttons, and answers by
writing `_mcp_restart_response.json`:

```json
{ "schemaVersion": 1, "requestId": "1234-...", "decision": "cancel", "at": "..." }
```

`decision` is `cancel` or `proceed`. No answer by the deadline means proceed. The server
removes the request when it is done; the tray closes its countdown when the request file is
gone or its `requestId` changes. `RESTART_COUNTDOWN_SEC` (default 10, 0 = off) sets the length.

Timing at the deadline: the server keeps reading the response until **deadline + 0.5 s**, with
its last read at or after that point, so an answer written up to then is honoured. The tray must
therefore stop accepting answers no later than that. The tray does it with a margin: it
disables Cancel and Restart now **1 s before** the deadline (then shows "Restarting Tally to load
X..."), re-reads the request file before writing an answer, and writes nothing if the request is
gone, has another `requestId`, or the cutoff has passed ("Too late to cancel"). It reports
"Tally restart cancelled" only when the request disappeared before the deadline after its Cancel
was written; otherwise "Cancel came too late" or "Cancel not confirmed".

When nobody answers (no tray, the countdown off, or the request could not be written; the
server never restarts early because of a failed write, it waits the full period), the server
asks the agent's `idle-status` again just before closing Tally and refuses with `USER_ACTIVE` if
a person has started using the PC meanwhile. After **Restart now** it does not re-check: that
click is the person at the PC saying go.

## 4. GUI agent result codes (#24, #35)

The agent's result JSON may carry `errorCode`, which the server maps to a typed tool error:

| `errorCode` | Meaning |
| --- | --- |
| `USER_ACTIVE` | Keyboard/mouse input within the idle threshold; nothing was sent. |
| `SESSION_LOCKED` | The workstation is locked (no input desktop / LogonUI in front). |
| `SESSION_DISCONNECTED` | The agent's Windows session is disconnected. |
| `WRONG_USER` | Another Windows user has the active console session. |

Commands may carry `userIdleSec` (seconds of no human input required before acting; default
5 from `GUI_USER_IDLE_SEC`) and `userIdleWaitSec` (how long to wait for the person to stop;
default 10). The agent's own injected keystrokes do not count as human input, and they do not
hide it either: a person's input that the agent's later keys pushed out of `GetLastInputInfo`
still counts (see the tick files below).

The agent checks before every screen action (`screenshot`, `sendkeys`, `press-key`,
`type-text`, `bring-foreground`, `select-and-unlock-company`, `switch-company`,
`show-voucher`; not `start-tally`, `ping`, `idle-status`), and again without waiting between
the steps of `sendkeys`, `select-and-unlock-company`, `switch-company` and `show-voucher`.
`userIdleSec: 0` turns the idle check off. A refusal is a normal error result with extra
fields; nothing was sent unless `stepsDone` says otherwise:

```json
{ "status": "error", "errorCode": "USER_ACTIVE", "retryable": true, "idleMs": 1200, "message": "Someone is using the keyboard or mouse on the Tally PC. Ask them to stop for a moment, then try again." }
{ "status": "error", "errorCode": "SESSION_LOCKED", "retryable": true, "session": { "state": "locked", "user": "DOMAIN\\name", "sessionId": 1 }, "message": "..." }
```

- `idleMs` only with `USER_ACTIVE`, and there it is the time since the person's input (agent
  1.10.0+; earlier agents sent the time since any input); `session` only with the three session
  codes (`WRONG_USER` adds `session.consoleUser` when it can be read).
- Between-step refusals add `stepsDone` and the message says "Stopped after N of M step(s)".
- Agent-private tick files in the coordination folder (nothing else reads or writes them), one
  pair per Windows session, `<s>` being the session id:
  - `_mcp_agent_input_tick.s<s>.txt`: the tick of the agent's own last keystroke, so
    consecutive one-shot runs do not mistake the previous step's keys for a person.
  - `_mcp_human_input_tick.s<s>.txt`: the tick of the last input that was a person's, saved
    just before every injection, because the agent's keys are about to replace it as the
    newest input. Best effort: a key pressed while an injection is in flight can still be lost.

  Each holds `<tick> <writeTick>` (GetTickCount values). A file whose `writeTick` does not
  match its own last-write time to within 5 s is from before the current boot (the tick count
  restarts at boot) and is ignored. Agents before 1.10.0 wrote `_mcp_agent_input_tick.txt`
  (the tick alone); it is no longer read.

The `idle-status` action reports, without touching the screen:

```json
{ "status": "success", "idleMs": 3120, "humanIdleMs": 81234, "lastInputWasAgent": true, "userActive": false, "session": { "state": "active", "user": "DOMAIN\\name", "sessionId": 1 } }
```

`session.state` is `active`, `locked`, `disconnected` or `wrong-user`.

- `idleMs`: time since the last keyboard/mouse input of any kind, the agent's own keystrokes
  included (`null` if unavailable).
- `lastInputWasAgent`: that input was the agent's own.
- `humanIdleMs` (agent 1.10.0+): time since the last input by a **person**. Equal to `idleMs`
  when `lastInputWasAgent` is false; otherwise the age of the recorded human tick; `null` when
  unknown (no probe, or the agent's keys are the newest input and no earlier input by a person
  is on record). It is never the age of the agent's own keystroke.
- `userActive`: whether a screen action would be refused as `USER_ACTIVE` right now, judged on
  `humanIdleMs` against the command's `userIdleSec` (unknown does not count as active).

**Restart gate (#25).** Anything that judges whether a person is at the PC, such as the
`load-company` restart gate, must use `humanIdleMs` (or `userActive` with its own threshold sent
as `userIdleSec`), never `idleMs`: the agent's own keys reset `idleMs`, so `idleMs` alone makes
the AI's own typing look like a person. `null` means unknown, not idle and not active. With an
agent older than 1.10.0 (no `humanIdleMs`), use `idleMs` only when `lastInputWasAgent` is false;
when it is true, the human idle time is unknown, and the message must not say a person used the
keyboard.

The restart gate (section 3) sends `userIdleSec` = `RESTART_USER_IDLE_SEC` (default 60) and
refuses on `userActive: true`, so the agent's own keystrokes from a recent screen action never
count as a person. With an agent that does not report `userActive` it falls back to `idleMs`,
ignored when `lastInputWasAgent` is true.

### IPC files (`_mcp_gui_command.json`, `_mcp_gui_result.json`)

Under the IPC transport (the service) every call shares one command file and one result file,
and the agent runs one command at a time. So:

- Every IPC exchange, passive `ping` / `idle-status` included, runs under the machine lock
  (section 2). A passive probe holds it with `probe: true`; when a screen action holds it, the
  probe sends nothing and reports the agent busy (alive, not "not responding").
- The server never deletes a result carrying another `commandId`, and does not clear the result
  file before sending: it only removes its own result once read, and its own command file when
  it stops waiting. The agent overwrites the result file with each new result.
- The in-session transport (stdio) runs a private one-shot agent per call and shares nothing,
  so its probes take no lock.

### `show-voucher` (#23)

`show-voucher` command fields: `masterId` (digits), `voucherType`, `voucherNumber`, `date`
(`YYYY-MM-DD`), optional `banner` (echoed back; the tray owns banners), optional
`dryKeys: true` (return the plan, send nothing), plus `userIdleSec` / `userIdleWaitSec`.
It opens the read-only Day Book (Alt+G, paste "Day Book", Enter; then F2, paste the date as
DD-MM-YYYY, Enter when `date` is given).

The report is read-only; the keys are not. TallyPrime draws its Yes/No prompts ("Accept?" at the
end of a voucher, "Quit?" at the Gateway) inside its own window, where neither the idle gate nor
the foreground check can see them, and Enter answers them **Yes**. Sent blind, the first Enter
would save a voucher a person left at "Accept?", or close Tally. So the agent (1.10.0+) never
sends an Enter or F2 on an unconfirmed screen: before each checked step it samples Tally's window
until it holds still, and after the step it waits up to 2.5 s for the change that step should
cause (Alt+G opens the Go To box, the paste filters its list, Enter brings up the Day Book, F2
opens the date box). No such change means it stops and sends nothing more; an open Yes/No prompt
ignores Alt+G, so the sequence ends there, before any Enter. The checks compare a sampled grid of
pixels: a fail-closed guard, not proof that the right box opened. Their thresholds are first
estimates, and the keys still need checking on each supported TallyPrime release, so
`show-voucher` should stay opt-in. The server treats any error as "skip silently".

```json
{ "status": "success", "shown": "day-book", "steps": 6, "screenChecks": [ { "step": "Alt+G", "changed": 0.183, "needed": 0.01, "ok": true } ], "masterId": "123", "voucherType": "Sales", "voucherNumber": "42", "date": "2026-04-15", "banner": "" }
{ "status": "success", "shown": "none", "dryRun": true, "keys": [ { "action": "combo", "value": "alt+g", "label": "Alt+G", "waitMs": 700, "check": "box", "expect": "the Go To box" } ] }
{ "status": "error", "shown": "none", "stepsDone": 1, "screenChecks": [ { "step": "Alt+G", "changed": 0.0004, "needed": 0.01, "ok": false } ], "message": "Tally's screen did not change as expected after Alt+G ..." }
{ "status": "error", "shown": "none", "stepsDone": 2, "screenChecks": [ ... ], "message": "Tally is not the foreground window, ..." }
```

- `screenChecks`: one entry per checked step that was sent: `changed` is the fraction of the
  sampled window that changed, `needed` the threshold. Use them to tune the thresholds on a
  real PC.
- On an error, `shown` says what is on screen: `day-book` when the Day Book's own check passed
  and a later step (the date) stopped, else `none`.
- Bad `masterId` / `date` gives `status: "error"`, `shown: "none"` with nothing sent. A gate
  refusal is the error shown at the top of this section (no `shown` field).
