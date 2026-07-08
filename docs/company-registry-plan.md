
## 1. What we want to build (in plain English)

Today, many chartered accountants store their Tally companies in numbered folders (`0001`, `0002`, etc.), and some of those companies are password-protected. Right now, to open one, the user has to:

1. Open Tally manually.
2. Find the right company in the list.
3. Type the password if the company is locked.

We want the user to be able to just say to Claude (or any LLM):

> *"Load my main company in Tally."*

…and the system should automatically launch Tally, pick the right company, type the password if needed, and confirm it's done. No clicking, no remembering folder numbers, no copy-pasting passwords.

To make this work, the user will tell the system *one time* during setup:

- *"My main company is folder `0001`, and the password is `xxx`."*
- *"My 2025 client is folder `0007`, no password."*
- *"My branch company is folder `0012`, username `admin`, password `yyy`."*

After that, the user just refers to companies by their friendly names ("main", "2025", "branch") and the system does the rest.

---

## 2. What we already have

The good news: most of the wiring is already there. Here's the pieces that exist:

```
┌─────────────────────┐   secure HTTPS    ┌──────────────────────┐
│  Claude / ChatGPT   │ ────────────────▶ │ TallyMCP service     │
│  (the LLM)          │                   │ (the brain)          │
└─────────────────────┘                   └──────────┬───────────┘
                                                     │ writes a small file
                                                     ▼
                                     ┌──────────────────────────────┐
                                     │ GUI agent script             │
                                     │ (the "hands" that type keys) │
                                     └──────────┬───────────────────┘
                                                │ keyboard keystrokes
                                                ▼
                                          Tally Prime
```

What's already built:

- **A way for the LLM to talk to our service** (secure HTTPS with a password).
- **A "GUI agent"** — a script that runs on the user's computer, in their desktop session, and can press keys inside Tally as if a human were typing them.
- **A deterministic "type the company ID + password" action** in the agent — it already accepts a company number, username, and password and types them all in. We just don't use it from the LLM today.
- **A simple JSON config file** (`.tally-mcp-companies.json`) that already stores hints about which companies need credentials — but it doesn't store the passwords themselves.
- **A "Launch Tally" button** in the tray icon that already starts Tally on the user's computer.
- **A tray icon + dashboard** that the user can right-click for status and actions.

What's missing is just the *glue*: a friendly name → folder mapping, password storage, an editor UI, and one new MCP tool that ties it all together.

---

## 3. What's missing today

1. **Friendly names.** Right now, you have to know the folder number (`0001`) or the exact company name as Tally shows it. There's no way to say "main" and have it figure out you mean `0001`.

2. **Stored passwords.** The existing config file only notes *that* a company needs a password — it doesn't keep the password. So every time, the user has to type the password into the prompt.

3. **An editor.** There's no UI to add, edit, or remove companies. You'd have to hand-edit a JSON file today, which a CA isn't going to do.

4. **A single "load by name" command** for the LLM to call. Today the LLM has to know the exact company name and call a more generic tool.

5. **An optional cheaper, more reliable path for configured companies.** Today the only way the LLM can drive Tally is via a *second* LLM call inside the agent (Claude or GPT looking at screenshots) to figure out where to click. That works — and it stays — but it costs money every time someone loads a company, and it can fail unpredictably. **We are not removing this path.** It is essential for ad-hoc cases (a company the user has never configured, or general Tally navigation beyond company-load). What we're adding is a *second, faster path* that activates only when the user has stored the company in the registry. For those companies, we already know the folder ID and password, so we can skip the screenshot loop and just type the keys directly. Unknown / un-configured companies continue to use the existing LLM-vision flow.

---

## 4. Do we need a database (like DuckDB) for this?

**No.** A plain JSON file on disk is the right choice, for three reasons:

- We're storing about 5–100 rows of company config per machine. Not millions.
- We read it at the start of a request and write to it only when the user edits the list. No analytical queries, no joins, no real "database work."
- The project already uses a JSON file for the related hints data. We just extend the same file.

DuckDB is already used in the project, but only for caching report data (numbers and tables that the LLM needs to query). That's a different problem. For configuration, JSON wins.

---

## 5. The plan — five steps

### Step 1: Extend the existing config file

The file `.tally-mcp-companies.json` (already used today for storing hints) will get a richer shape:

```json
{
  "schemaVersion": 1,
  "companies": [
    {
      "alias": "main",
      "extraAliases": ["main co", "primary", "abc"],
      "folderId": "0001",
      "displayName": "ABC Traders Pvt Ltd",
      "username": "admin",
      "passwordEnc": "<encrypted password>",
      "notes": "FY 2024-25 active"
    }
  ]
}
```

Each company has:
- **One main alias** (what the user calls it, e.g. "main") plus optional extra aliases.
- **The folder ID** (what Tally actually uses internally).
- **The display name** (for showing in messages back to the user).
- **Username and encrypted password** (optional — only filled in for locked companies).
- **Notes** (free-form, for the user's own benefit).

### Step 2: Encrypt the password using Windows DPAPI

We will not store passwords as plain text. We'll use Windows DPAPI (Data Protection API) — this is the same encryption Windows itself uses for things like saved Wi-Fi passwords. It's built into Windows, so we don't add any new library or dependency.

The encrypted password is just a long base64 string in the JSON file. To anyone looking at the file, it's gibberish; only this machine can decrypt it.

We'll also lock down the file with Windows permissions so that only Administrators and the system account can read it. Regular users on the same computer can't peek at it.

(Technical note for the developer: we'll use the `LocalMachine` scope, not `CurrentUser`, because the MCP service runs as `LocalSystem` and the tray runs as the logged-in user — they need to share the same encryption key. Both can decrypt `LocalMachine` blobs; neither can share a `CurrentUser` blob. NTFS ACLs are the real access control.)

### Step 3: Add a new MCP tool — `load-company-by-alias`

This is a new command the LLM will call **for companies the user has configured**. It does the whole flow in one shot, using the cheap deterministic keystroke path:

1. Look up the alias in the JSON file.
2. If Tally isn't running yet, launch it.
3. Decrypt the password (if there is one).
4. Send a single command to the GUI agent: "type this folder ID, username, password, hit Enter."
5. Wait for the agent to report success or failure.
6. Tell the LLM the result.

We'll also add a small companion tool — `list-configured-companies` — so the LLM can tell the user *"here are your configured shortcuts: main, branch, 2025"* before asking which one to load. The list won't expose passwords, just the names.

**The existing `open-company` tool keeps working unchanged.** It remains the right choice for:

- Loading a company the user has *not* configured in the registry.
- General-purpose Tally automation where we can't pre-script the keystrokes.
- Any future flow that needs the LLM's vision to decide what to do.

So the LLM has two tools to pick from:
- *Configured company, fast and free?* → `load-company-by-alias`.
- *Ad-hoc / unknown company, need vision?* → existing `open-company`.

The two paths coexist. The new one is a cost-reduction optimization for the common case, not a replacement.

### Step 4: Build a "Manage Companies" screen in the tray dashboard

The tray icon's dashboard window already has buttons for "Restart service", "Launch Tally", "Open logs", etc. We'll add a new button: **Manage Companies**.

Clicking it opens a simple table where the user can:
- Add a new company (alias, folder ID, display name, username, password, notes).
- Edit an existing one.
- Delete one.
- Test it (the system tries to resolve the alias and confirms it points to a real folder, without actually typing anything into Tally).
- Save.

When the user saves, the system encrypts any passwords using DPAPI and writes the updated JSON to disk. The MCP service picks up the change automatically on the next request.

This is the only piece of new UI we need. No standalone editor app, no installer wizard page — it lives inside the tray dashboard we already ship.

### Step 5: A small reminder in the installer

The installer wizard will get one extra line on its final page:

> *"To configure your Tally companies, right-click the tray icon after install and click 'Manage Companies'."*

That's it. No code change, just a hint so users know where to look.

---

## 6. Why we're adding a new tool instead of changing the existing `open-company` tool

The existing tool already does some of this (resolves folder IDs, launches Tally, drives the agent via the LLM-vision flow). A reasonable question is: why not just upgrade it?

Four reasons:

- **Different intent.** `open-company` means *"I know the exact name or folder, load it (using whatever it takes, including LLM-vision)."* The new tool means *"the user said 'main co' — figure out what they mean, then load it using the stored credentials and keystroke shortcut."* The LLM-facing description is different in kind. Two clear, single-purpose tools are easier for the LLM to use correctly than one overloaded tool.
- **Credentials change the strategy.** `open-company` has fast paths that work without typing anything (it just asks Tally over its data port). Those paths can't type a password. Once a company is locked, we have to go straight to the keystroke path. The new tool always uses the keystroke path because it has the password to type.
- **The LLM-vision path is still needed.** For companies the user has not configured, or for general Tally automation, we need the existing flexible (but expensive) approach. We are keeping it — not replacing it. Two tools makes that coexistence explicit.
- **Nothing breaks for existing users.** Old prompts and scripts that use `open-company` keep working unchanged. The new tool is purely additive.

---

## 7. End-to-end flow once shipped

Let's walk through a realistic example.

**One-time setup (5 minutes):**

1. The user installs `TallyMCP-Setup.exe` and finishes the wizard.
2. The tray icon appears in the bottom-right of their screen.
3. The user double-clicks the tray → Dashboard → **Manage Companies**.
4. They add three rows:
   - `main` → folder `0001`, no password
   - `branch` → folder `0007`, username `admin`, password `Welcome@2025`
   - `client-xyz` → folder `0012`, no credentials
5. Click Save. The encrypted JSON file is written.
6. The user connects their LLM client (Claude Desktop, for example) to the TallyMCP server by entering the URL and the OAuth password set during install.

**Everyday usage:**

1. The user types to Claude: *"Load my main company."*
2. Claude calls `load-company-by-alias("main")`.
3. The MCP service reads the JSON → finds folder `0001`, no password.
4. Tally isn't running yet → service tells the GUI agent to launch it.
5. Once Tally's window appears, the service tells the agent to type `0001`, Enter, Enter.
6. Tally loads ABC Traders Pvt Ltd.
7. Claude replies: *"Done — your main company is loaded."*

Later:

1. User: *"Now switch to my branch."*
2. Claude calls `load-company-by-alias("branch")`.
3. Service reads JSON → folder `0007`, username `admin`, encrypted password.
4. Tally is already running → service skips the launch step.
5. Service decrypts the password and tells the agent: type `0007`, Enter, Enter, then username `admin`, Tab, then the password, Enter.
6. Tally unlocks and loads the branch company.
7. Claude replies: *"Branch company loaded."*

The user never has to remember a folder number or type a password into a chat window.

---

## 8. Running across two machines

A natural setup is:

- **Machine A** — the office desktop where Tally Prime lives. TallyMCP is installed here.
- **Machine B** — the user's laptop, where they actually use Claude / ChatGPT / Copilot.

This works as-is. The TallyMCP service is just a web server (HTTPS), and it already listens on all network interfaces (`BIND_HOST=0.0.0.0`, set by the installer). From Machine B, the LLM client connects to Machine A's URL.

Three deployment options, in order of complexity:

| Setup | When to use | What you need |
|---|---|---|
| **Same local network** | Both machines on the same office Wi-Fi or LAN | Open TCP port 3000 in Machine A's firewall. Point the LLM client at `http://<Machine-A-IP>:3000`. |
| **Public domain with reverse proxy** | You want to use Claude from home, on the road, anywhere | Point a subdomain (e.g. `tally.yourdomain.com`) at Machine A. Run Caddy or IIS as a reverse proxy on Machine A to handle HTTPS. Set `MCP_DOMAIN` in the installer wizard. |
| **Cloudflare Tunnel or similar** | Same as above but Machine A is behind a NAT you can't open | Install `cloudflared` on Machine A. It gives you a public HTTPS URL with no router config. **Now implemented in the Windows installer** — supply a tunnel token in the wizard; see [cloudflare-tunnel-provisioning.md](cloudflare-tunnel-provisioning.md). |

**Important constraints when running across two machines:**

1. **Machine A must be on and logged in.** The GUI agent is an at-logon scheduled task — if no one is logged into Machine A, the agent isn't running, and Tally can't render its window anyway. If the office PC is locked overnight, prompts from home will fail until someone logs in (or you set up auto-logon).
2. **The keystrokes happen on Machine A's screen.** If a colleague is at that desk, they'll see Tally suddenly switch companies. Not a bug — just a fact of how GUI automation works.
3. **The OAuth password is the only authentication.** Anyone with the URL + password can drive Tally on Machine A. Treat it like SSH access. Rotate it after demos or staff changes.
4. **One Tally at a time.** Tally Prime doesn't support multiple instances on one box. If a human at Machine A is using Tally, the LLM's keystrokes go to their session.

---

## 9. Why this is the right approach

1. **It builds on what already works.** We're not introducing new processes, new daemons, new languages, or new networking. The IPC pipe between the service and the agent already exists. The keystroke action already exists. The tray already exists. We're connecting them with one new tool and a config file.

2. **Cost-reduction option for the common case.** Today's GUI path calls Claude/GPT inside the agent on every company load — it costs tokens and adds 10–30 seconds. We're not removing that path; it's still essential for ad-hoc and general-purpose Tally automation. But for *configured* companies (the ones the user opens every day), we offer a second path that's pure keystrokes — under 2 seconds, zero LLM cost. For a CA who switches between the same handful of clients dozens of times a day, this is the high-volume path and the savings are significant. Less-frequent or unknown companies continue through the LLM-vision flow.

3. **Right-sized storage.** JSON file is perfectly adequate for ~100 rows of config. No database to set up, back up, migrate, or debug. Easy to hand-fix if something goes wrong.

4. **Standard Windows crypto.** DPAPI is built into Windows, audited by Microsoft, and used for things like saved Wi-Fi passwords. We don't have to evaluate a third-party crypto library.

5. **The CA never has to edit a config file.** They click a button, fill in a table, save. The technical complexity is hidden inside the dashboard.

6. **Nothing breaks for existing users.** The new feature is purely additive. Users who don't configure any aliases see no difference. The old `open-company` tool stays put.

7. **Future-proof.** If we ever need cloud-stored config, role-based access, or a remote web UI, the JSON file can be the source of truth that those features sync against. We're not painting into a corner.

---

## 10. Decisions to lock down before we start coding

Four small questions to settle:

1. **Encryption scope** — `LocalMachine` (recommended, simpler) or `CurrentUser` (slightly stronger but more architectural work)?
2. **Alias matching** — exact only, or fuzzy (so "main co" matches "main")?
3. **Unknown alias behavior** — if the user types an alias we don't have, do we error with the list of valid aliases, or try to match against folder ID and display name first before giving up?
4. **Editor scope for v1** — full table with add/edit/delete/test, or minimal "open the JSON in Notepad with a save-hook that encrypts the password"?

---

## 11. What's not in this version (out of scope)

- **Multi-user accounts.** The registry is per-installation. Everyone with the OAuth password sees the same company list. Multi-tenant access control is a separate, bigger design.
- **Cloud-stored registry.** Local JSON file only. If we want a synced registry across multiple Tally machines later, that's a future project.
- **Auto-populating the registry.** The user adds entries manually. We do not auto-import every Tally folder we find — leaving the user in control of which ones get aliases.
- **Password rotation policy.** Whatever the user types is stored until they edit it. No expiry, no rotation reminders.

---

## 12. How we'll know it works (testing plan)

Before shipping, we'll verify:

- **Save and reload.** Add a company in the dashboard, restart the service, confirm the company is still there and the password still decrypts correctly.
- **Permissions.** Confirm a non-admin user on the same machine cannot read the JSON file.
- **Unlock flow.** Add a company with a real password, prompt the LLM to load it, confirm Tally unlocks correctly without any human typing.
- **Tally not running.** Stop Tally, prompt the LLM, confirm the system launches Tally first, waits for the window, then types the credentials.
- **Across the network.** Set up Claude Desktop on a second machine, point it at the MCP server, run the same flow from there.
- **Unknown alias.** Prompt "load company foobar" (which we never configured), confirm the error message lists the valid aliases instead of failing silently.
- **No regression.** Confirm the existing `open-company` tool still works for users who never set up any aliases.
