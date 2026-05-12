# Company Registry — Step-by-Step Implementation Plan

Companion to [company-registry-plan.md](company-registry-plan.md). That doc explains *what* we're building and *why*. This one explains *where* in the codebase the work goes and *in what order*.

---

## The shape of the work

Five workstreams, four codebases, in this order. Each step ships independently — you can stop at any point and what's there still works.

```
Step 1: Config schema + DPAPI helpers      → TypeScript (src/) + PowerShell helper
Step 2: New MCP tool: load-company-by-alias → TypeScript (src/mcp.mts)
Step 3: GUI agent password-typing action   → PowerShell (scripts/tally-gui-agent-v2.ps1)
Step 4: "Manage Companies" dashboard UI    → PowerShell WinForms (scripts/tray/)
Step 5: Installer hint                     → Inno Setup (scripts/installer/)
```

---

## Step 1 — Extend config + add DPAPI encryption (Day 1–2)

### Where
- [src/mcp.mts:174-200](../src/mcp.mts#L174-L200) — existing `CompaniesConfig` type + `loadCompaniesConfig()`
- new file: `scripts/dpapi-helper.ps1`
- [scripts/installer/firstrun-config.ps1](../scripts/installer/firstrun-config.ps1) — NTFS ACL lockdown

### What changes

**1a. Extend `CompaniesConfig` type in [src/mcp.mts](../src/mcp.mts)**

Today the type is a flat `{ [folderId]: { requiresCredentials?, knownUsername?, notes? } }` keyed by folder ID. Replace with the richer shape from the plan doc:

```ts
type CompaniesConfig = {
  schemaVersion: 1;
  companies: Array<{
    alias: string;
    extraAliases?: string[];
    folderId: string;
    displayName?: string;
    username?: string;
    passwordEnc?: string;   // DPAPI base64 blob, never plaintext
    notes?: string;
  }>;
};
```

Add a **migration step** in `loadCompaniesConfig()` — if the file has the old flat shape (no `schemaVersion`), wrap it into the new shape with empty `companies: []` and write the upgraded version back. Existing installs keep working.

**1b. Add DPAPI helpers in a new file `scripts/dpapi-helper.ps1`**

Two one-liners using built-in Windows APIs (no third-party crypto):

```powershell
# Encrypt: plaintext → base64 blob
function Protect-PasswordDpapi([string]$Plain) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Plain)
  $blob  = [System.Security.Cryptography.ProtectedData]::Protect(
             $bytes, $null, 'LocalMachine')
  [Convert]::ToBase64String($blob)
}

# Decrypt: base64 blob → plaintext
function Unprotect-PasswordDpapi([string]$Blob) {
  $bytes = [Convert]::FromBase64String($Blob)
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
             $bytes, $null, 'LocalMachine')
  [System.Text.Encoding]::UTF8.GetString($plain)
}
```

**1c. Bridge from Node to DPAPI**

The MCP service is Node/TypeScript, DPAPI is Windows-only and easiest from PowerShell. Two options:
- **Recommended:** spawn `powershell.exe -File dpapi-helper.ps1 -Action encrypt -In <stdin>` from Node when saving, and the same with `-Action decrypt` when loading. ~50ms overhead, zero new npm dependencies.
- **Alternative:** use a Node native binding like `win-dpapi` if you want it in-process. Adds a native dep — pick this only if the spawn latency hurts in practice.

**1d. Lock down NTFS permissions**

In [scripts/installer/firstrun-config.ps1](../scripts/installer/firstrun-config.ps1), after the JSON file is created, set ACL:

```powershell
icacls "<path>" /inheritance:r /grant:r "SYSTEM:F" "Administrators:F"
```

This is the real access control. DPAPI is just defense-in-depth.

### Verification
- Add an old-shape JSON file, start the service, confirm it migrates to new shape.
- Encrypt a password, restart service, confirm decrypt round-trips.
- Copy the JSON to a second machine, confirm the blob fails to decrypt there.

---

## Step 2 — Add `load-company-by-alias` MCP tool (Day 3)

### Where
- [src/mcp.mts](../src/mcp.mts) near line ~1250 (end of tool registrations)
- Follow the pattern of existing `open-company` at [src/mcp.mts:614-893](../src/mcp.mts#L614-L893)

### What it does (the flow from §7 of the plan doc)

```
1. Validate alias against loaded config (exact + case-insensitive match)
2. If not found, return error listing valid aliases
3. Decrypt passwordEnc (if present) via PowerShell helper
4. Check if Tally is running; if not, dispatch "start-tally" GUI action
5. Dispatch "select-company-with-creds" action (NEW) to GUI agent over IPC
6. Wait for result JSON, return success/failure to LLM
7. auditLog() — never log the password
```

### Reuse what's there
- IPC mechanism: same `_mcp_gui_command.json` / `_mcp_gui_result.json` files as [src/mcp.mts:743-806](../src/mcp.mts#L743-L806).
- `createGuiAgentCommandId()`, `pingGuiAgent()`, `isMatchingGuiAgentCommand()` — call as-is.
- `auditLog()` — call with `{ alias, success, durationMs }` only. Never the password, never the folder ID alone (low value).

### Add a small companion tool `list-configured-companies`
Returns `[{ alias, displayName, hasPassword: boolean }, ...]`. Used by the LLM when the user says "load my company" without specifying which.

### Tool description matters for LLM routing
Write the description so the LLM picks the right tool:
- `load-company-by-alias`: *"Fast deterministic load using stored credentials. Use this when the user refers to a company by a short name you've seen via `list-configured-companies`."*
- existing `open-company`: leave as-is — it'll still get picked for unknown / ad-hoc cases.

---

## Step 3 — GUI agent: add password-typing action (Day 4)

### Where
- [scripts/tally-gui-agent-v2.ps1](../scripts/tally-gui-agent-v2.ps1)
- Existing keystroke primitives are in [scripts/TallyUI.cs](../scripts/TallyUI.cs) (`TallyUI2.TypeString`, `PressKey`, `PressCombo`)

### What changes

The existing agent already has `select-company` and the `TallyUI2.TypeString()` keystroke primitive. Add a new action `select-company-with-creds` that accepts `{ folderId, username, password }` in the IPC command and does:

```
1. Make sure Tally window is foreground (existing helper)
2. Send Alt+F3 → C (or whatever opens "Select Company" in your Tally version)
3. TypeString(folderId), PressKey(Enter), PressKey(Enter)
4. If username provided: TypeString(username), PressKey(Tab)
5. If password provided: TypeString(password), PressKey(Enter)
6. Wait briefly, screenshot the result region, OCR/check for the company name OR an "invalid password" dialog
7. Write result JSON: { ok: true } or { ok: false, reason: "wrong-password" | "company-not-found" | "timeout" }
```

The password arrives in plaintext over the local IPC file. That file is in a directory locked down by Step 1d's ACLs. The agent should **delete the command file immediately after reading it** (the existing pattern already does this — verify) so the plaintext doesn't linger on disk.

### Why a new action, not extending `select-company`
The existing `select-company` uses the LLM-vision loop. The new one is pure-keystroke. Two clean handlers in the agent's switch statement are easier to maintain and audit than one branchy handler.

---

## Step 4 — "Manage Companies" dashboard UI (Day 5–7)

### Where
- [scripts/tray/tally-mcp-tray.ps1](../scripts/tray/tally-mcp-tray.ps1)

This is the biggest single piece of new code. WinForms in PowerShell — same framework as the rest of the tray app.

### What to build

**4a. New menu item** in the tray context menu: *"Manage Companies…"*

**4b. New WinForms window** with:
- A `DataGridView` showing existing companies (columns: Alias, Folder ID, Display Name, Has Password)
- Buttons: **Add**, **Edit**, **Delete**, **Test**, **Save**, **Cancel**
- An edit dialog with the form: alias / folder ID / display name / username / "Change password" checkbox + password field / notes

**4c. Save logic**
- For any row where the user ticked "Change password" and typed a value: shell out to `dpapi-helper.ps1` to encrypt.
- Write the whole JSON atomically: write to `.tmp`, then `Move-Item -Force`.
- Send a `reload-config` signal to the MCP service so it picks up the changes without restart. (If no such signal exists today, simplest: have the service watch the file's mtime on every request — cheap, no IPC needed.)

**4d. Test button**
- Calls `load-company-by-alias` against the local MCP server with the alias being edited.
- Shows green ✅ / red ❌ inline with the message from the tool response.
- This is the wrong-password recovery loop from the editor design.

### Suggested order within Step 4
1. Read-only grid first (just lists existing companies).
2. Add company flow.
3. Edit company flow (with the "Change password" checkbox).
4. Delete.
5. Test button.

Each is independently shippable.

### Edit form behavior — wrong-password recovery

When the user clicks **Edit**, the password field is empty with a "Change password" checkbox unticked. Three states:

| User action | Effect on stored password |
|---|---|
| Doesn't tick "Change password" | Old encrypted password stays — untouched on save |
| Ticks the box, types a new value | New password is DPAPI-encrypted, old blob is overwritten |
| Ticks the box, leaves field empty | Password is cleared (company becomes no-password) |

This handles every realistic edit case:
- *"I want to fix a typo in the alias"* → don't tick the box. Password stays.
- *"Wrong password during setup, want to fix it"* → tick the box, type the correct one.
- *"This company no longer has a password"* → tick the box, leave it empty, save.

### Where the user discovers a wrong password

If they skip the Test button and save with a wrong password, they discover it the next time they say *"Load my main company"* to Claude. The MCP service's response back to Claude should be specific:

> *"I tried to load 'main' but Tally rejected the password. You can fix it by right-clicking the tray icon → Manage Companies → Edit 'main' → tick 'Change password'."*

Turns a frustrating dead-end into a 30-second fix.

---

## Step 5 — Installer hint (Day 7, 10 minutes of work)

### Where
- [scripts/installer/tally-mcp.iss](../scripts/installer/tally-mcp.iss) — final page

Add one line to the FinishedLabel or a custom info page:

> *"To configure your Tally companies, right-click the tray icon and click 'Manage Companies'."*

Bump version to `1.2.0`. Rebuild installer via [scripts/installer/build-installer.ps1](../scripts/installer/build-installer.ps1). Done.

---

## Suggested commit / PR structure

| PR | Title | Files |
|---|---|---|
| 1 | Extend companies config schema + DPAPI helpers | `src/mcp.mts`, `scripts/dpapi-helper.ps1`, `scripts/installer/firstrun-config.ps1` |
| 2 | Add `load-company-by-alias` + `list-configured-companies` MCP tools | `src/mcp.mts`, tests |
| 3 | GUI agent: deterministic credentialed-load action | `scripts/tally-gui-agent-v2.ps1` |
| 4 | Tray dashboard: Manage Companies editor | `scripts/tray/tally-mcp-tray.ps1` |
| 5 | Installer hint + version bump | `scripts/installer/tally-mcp.iss` |

Each PR is reviewable in <30 minutes. None of them break existing functionality — the old `open-company` tool and existing config keep working throughout.

---

## Decisions to lock down before coding starts

Restated from §10 of the plan doc, with recommendations:

1. **DPAPI scope:** `LocalMachine`. The MCP service runs as `LocalSystem` and the tray runs as the logged-in user — they need to share the key. NTFS ACLs do the real access control.
2. **Alias matching:** exact + case-insensitive. Fuzzy matching ("main co" → "main") adds ambiguity for marginal benefit. Skip for v1.
3. **Unknown alias behavior:** error with the list of valid aliases inline. Don't try to fall through to folder ID — the LLM has a separate tool for that case.
4. **Editor scope for v1:** full table editor (4a–4d above). The "open in Notepad" alternative isn't credible — a CA won't do it.

Get sign-off on #1 and #2 specifically before coding starts to avoid redoing work after review.

---

## Codebase reference — where the existing pieces live

For anyone picking this up cold, here's the lay of the land:

| Piece | File | Notes |
|---|---|---|
| MCP tool registrations | [src/mcp.mts](../src/mcp.mts) | ~2227 lines. New tools go at the end of the registrations. |
| Existing `open-company` tool | [src/mcp.mts:614-893](../src/mcp.mts#L614-L893) | Three-strategy fallback. We're adding a fourth tool, not replacing this. |
| Companies config loader | [src/mcp.mts:174-200](../src/mcp.mts#L174-L200) | Old flat shape. Extend here. |
| GUI agent (PowerShell) | [scripts/tally-gui-agent-v2.ps1](../scripts/tally-gui-agent-v2.ps1) | File-IPC loop. Add new action in the switch. |
| Keystroke primitives | [scripts/TallyUI.cs](../scripts/TallyUI.cs) / `TallyUI.dll` | `TypeString`, `PressKey`, `PressCombo`. Reuse as-is. |
| Tray + dashboard | [scripts/tray/tally-mcp-tray.ps1](../scripts/tray/tally-mcp-tray.ps1) | WinForms in PowerShell. New menu item + dialog goes here. |
| Installer | [scripts/installer/tally-mcp.iss](../scripts/installer/tally-mcp.iss) | Inno Setup. |
| Installer post-install | [scripts/installer/firstrun-config.ps1](../scripts/installer/firstrun-config.ps1) | Adds NTFS ACL lockdown for the JSON file here. |
| DuckDB cache layer | [src/database.mts](../src/database.mts) | Used for report data only, **not** for config. Don't confuse the two. |
| DPAPI usage | _none yet_ | New requirement — added as `scripts/dpapi-helper.ps1` in Step 1b. |

**Stack summary:** Node.js 20+ (TypeScript) for the MCP service, DuckDB for report caching, Express 5 for HTTP/OAuth, PowerShell for desktop automation, Inno Setup for the Windows installer.
