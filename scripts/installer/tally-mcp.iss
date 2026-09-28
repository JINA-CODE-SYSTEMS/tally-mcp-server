; ===========================================================================
; Claudally (Tally MCP Server) - Inno Setup installer (issue #18)
;
; Builds a single Claudally-Setup.exe that takes a Windows box from "nothing
; installed" to "service running" with a short wizard. Bundles:
;   - the prebuilt dist/ output (no client-side TS compile)
;   - scripts/ (deploy.ps1, tally-gui-agent-v2.ps1, TallyUI.dll, this installer's helpers)
;   - portable Node.js (installer-staging/node-portable/)
;   - NSSM (installer-staging/nssm.exe)
;   - cloudflared (installer-staging/cloudflared.exe)
;
; Build prerequisites (see build-installer.ps1 for the orchestrated flow):
;   - Inno Setup 6+ (CI uses the pinned build from install-innosetup.ps1)
;   - npm install + npm run build run on the source tree
;   - installer-staging/ populated by build-installer.ps1, which checks Node, NSSM and
;     cloudflared against SHA-256 pins committed in that script. Compiling this .iss
;     directly skips those checks - don't ship an installer built that way.
;
; This .iss is intentionally Inno-Setup-only — no WiX, no MSI. v1 ships an .exe
; for direct download. SCCM/GPO support can be added later if a client needs it.
; ===========================================================================

; Product name is "Claudally" (Claude + Tally). The internal service/task names (MyServiceName,
; MyAgentTaskName, MyTrayTaskName) and the install directory stay "TallyMCP" on purpose so existing
; installs upgrade in place — only the user-facing brand changes. AppId is unchanged for the same reason.
#define MyAppName        "Claudally"
; Version is supplied by the build (ISCC /DMyAppVersion=...), which takes it from the git tag so
; the release, the installer filename and package.json cannot drift apart. The fallback below is
; used only for an ad-hoc local compile and is deliberately obviously-not-a-release.
#ifndef MyAppVersion
  #define MyAppVersion   "0.0.0-dev"
#endif
#define MyAppPublisher   "JINA CODE SYSTEMS LLP"
#define MyAppURL         "https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server"
#define MyServiceName    "TallyMCP"
#define MyAgentTaskName  "TallyMCPAgent"
#define MyTrayTaskName   "TallyMCPTray"
; Second NSSM-managed service, registered only when the wizard's optional Cloudflare Tunnel token
; is supplied. Runs cloudflared so a NAT'd box gets a stable public HTTPS URL with no router config.
; See docs/cloudflare-tunnel-provisioning.md.
#define MyTunnelServiceName "TallyMCPTunnel"

; Source root: the installer is built from <repo>/scripts/installer/, so SourceDir
; climbs two levels to reach the repo root. SourcePath itself is provided by Inno.
; Both roots are overridable from the command line (ISCC /DRepoRoot=...). The release build
; leaves them alone; CI points them at a tree of stub files so the Pascal Script and the
; [Setup]/[Files]/[Run] sections are compiled on every PR without first downloading a
; portable Node, NSSM and cloudflared. See scripts/installer/check-iss.ps1.
#ifndef RepoRoot
  #define RepoRoot       "..\\.."
#endif
#ifndef StagingRoot
  #define StagingRoot    "..\\..\\installer-staging"
#endif

[Setup]
AppId={{F8E2A7C9-3B4D-4A6E-9F0E-2C5D1E7B8A4F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={autopf}\TallyMCP
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
LicenseFile={#RepoRoot}\LICENSE
OutputDir={#RepoRoot}\dist-installer
OutputBaseFilename=Claudally-Setup-{#MyAppVersion}
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
UninstallDisplayIcon={app}\assets\tally-mcp.ico
; Jina Code Systems brand icon for the installer .exe itself (generated from scripts/tray/assets/jina-logo.png).
SetupIconFile=assets\tally-mcp.ico
ChangesEnvironment=yes
; JINA CODE SYSTEMS LLP branding. Comma-separated lists let Inno pick the closest size
; to the user's display scaling — the standard BMP renders on 100% DPI, the @2x
; variant covers 150-200% scaling without upscale blur.
WizardImageFile=assets\wizard-sidebar.bmp,assets\wizard-sidebar@2x.bmp
WizardSmallImageFile=assets\wizard-small.bmp,assets\wizard-small@2x.bmp

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; --- The built MCP server (dist/) and runtime metadata. We REQUIRE the build to be done
; before invoking ISCC; client-side TypeScript compile would mean shipping ~150 MB of
; @types and tsc and is brittle on locked-down boxes. ---
Source: "{#RepoRoot}\dist\*";          DestDir: "{app}\dist";    Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#RepoRoot}\package.json";    DestDir: "{app}";          Flags: ignoreversion
; Extracted to {tmp} so PrepareToInstall can run it before any file is copied. On a fresh install
; {app}\scripts does not exist yet, and on an upgrade the on-disk copy is the version being replaced.
Source: "{#RepoRoot}\scripts\installer\stop-install-processes.ps1"; Flags: dontcopy
; Same reason: an unattended upgrade runs THIS version's firstrun-config.ps1 -Upgrade -PreflightOnly
; from PrepareToInstall, so an upgrade that could not keep the existing settings is refused before
; anything is stopped or copied (#177).
Source: "{#RepoRoot}\scripts\installer\firstrun-config.ps1"; Flags: dontcopy
Source: "{#RepoRoot}\package-lock.json"; DestDir: "{app}";        Flags: ignoreversion
Source: "{#RepoRoot}\node_modules\*";  DestDir: "{app}\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs

; --- Runtime config directories. tally.mts loads pull/config.json + push/config.json plus
; per-report XML templates from these paths at startup. Without them the server crashes on
; first import with ENOENT before app.listen() is even reached. ---
Source: "{#RepoRoot}\pull\*";          DestDir: "{app}\pull";     Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#RepoRoot}\push\*";          DestDir: "{app}\push";     Flags: ignoreversion recursesubdirs createallsubdirs

; --- Scripts (deploy + GUI agent + Win32 interop DLL). The DLL is prebuilt on the build
; box rather than at install time so we don't depend on csc.exe on the client. ---
Source: "{#RepoRoot}\scripts\tally-gui-agent-v2.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#RepoRoot}\scripts\TallyUI.dll";            DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#RepoRoot}\scripts\TallyUI.cs";             DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#RepoRoot}\scripts\deploy.ps1";             DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#RepoRoot}\scripts\setup-windows.ps1";      DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#RepoRoot}\scripts\installer\firstrun-config.ps1";    DestDir: "{app}\scripts\installer"; Flags: ignoreversion
Source: "{#RepoRoot}\scripts\installer\stop-install-processes.ps1"; DestDir: "{app}\scripts\installer"; Flags: ignoreversion
Source: "{#RepoRoot}\scripts\installer\connect-client.ps1";        DestDir: "{app}\scripts\installer"; Flags: ignoreversion
Source: "{#RepoRoot}\scripts\installer\uninstall-cleanup.ps1";  DestDir: "{app}\scripts\installer"; Flags: ignoreversion

; --- Tray status app (issue #20). Polls service/agent/Tally health and surfaces a
; coloured tray icon + right-click action menu. Registered as a per-user at-logon
; scheduled task by firstrun-config.ps1. Double-clicking the tray opens a dashboard
; window that reads the bundled logo (assets/) and LICENSE file shipped below. ---
Source: "{#RepoRoot}\scripts\tray\tally-mcp-tray.ps1"; DestDir: "{app}\scripts\tray"; Flags: ignoreversion
Source: "{#RepoRoot}\scripts\tray\assets\*";           DestDir: "{app}\scripts\tray\assets"; Flags: ignoreversion recursesubdirs createallsubdirs

; --- Brand icon (Jina Code logo) for the Start Menu / desktop shortcuts and the uninstall entry.
; Shipped to {app}\assets so the shortcut IconFilename points at a file present on the target. ---
Source: "{#RepoRoot}\scripts\installer\assets\tally-mcp.ico"; DestDir: "{app}\assets"; Flags: ignoreversion

; --- LICENSE at the install root so the tray dashboard can read it post-install.
; (LicenseFile= above only feeds the wizard's accept-license page; that copy is not
; placed on disk.) ---
Source: "{#RepoRoot}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

; --- OAuth password prompt page served by the /authorize endpoint. Without this file,
; OAuth flow crashes with ENOENT when a client (Claude Desktop / VS Code Copilot / etc.)
; redirects to the authorize URL. Was missing from the installer for the entire 1.x line. ---
Source: "{#RepoRoot}\authorize.html"; DestDir: "{app}"; Flags: ignoreversion

; --- DPAPI helper for company registry password encryption. Called by both the MCP service
; (via Node spawn) and the Manage Companies tray dialog. ---
Source: "{#RepoRoot}\scripts\dpapi-helper.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion

; --- Manage Companies dialog, dot-sourced by tally-mcp-tray.ps1 at startup. ---
Source: "{#RepoRoot}\scripts\tray\manage-companies-dialog.ps1"; DestDir: "{app}\scripts\tray"; Flags: ignoreversion

; --- Bundled portable Node.js. Avoids version conflicts with anything else on the box.
; The build script populates installer-staging/node-portable/ from the official Node zip. ---
Source: "{#StagingRoot}\node-portable\*"; DestDir: "{app}\node-portable"; Flags: ignoreversion recursesubdirs createallsubdirs

; --- NSSM (service manager). Wrapped here so we don't need network access at install time. ---
Source: "{#StagingRoot}\nssm.exe"; DestDir: "{app}\bin"; Flags: ignoreversion

; --- cloudflared (Cloudflare Tunnel client). Only run when the wizard's Cloudflare Tunnel token
; field is filled in; harmless to ship unconditionally otherwise. Staged by build-installer.ps1. ---
Source: "{#StagingRoot}\cloudflared.exe"; DestDir: "{app}\bin"; Flags: ignoreversion

; --- Logs / data directories created at install time (empty on disk; AfterInstall ensures perms). ---

[Dirs]
Name: "{app}\logs"; Permissions: users-modify
Name: "{app}\data"; Permissions: users-modify

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut to open the Tally MCP dashboard"; GroupDescription: "Additional shortcuts:"

[Icons]
; Primary entry point: opens the status dashboard. The tray script's single-instance guard means this
; surfaces the already-running tray's dashboard (or starts the tray if it isn't running) rather than
; launching a duplicate. -WindowStyle Hidden keeps the launcher windowless (brief console flash only).
Name: "{group}\Open {#MyAppName} Dashboard"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File ""{app}\scripts\tray\tally-mcp-tray.ps1"" -InstallDir ""{app}"" -ShowDashboard"; WorkingDir: "{app}"; IconFilename: "{app}\assets\tally-mcp.ico"; Comment: "Open the Tally MCP status dashboard"
Name: "{autodesktop}\{#MyAppName}";          Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File ""{app}\scripts\tray\tally-mcp-tray.ps1"" -InstallDir ""{app}"" -ShowDashboard"; WorkingDir: "{app}"; Tasks: desktopicon; IconFilename: "{app}\assets\tally-mcp.ico"; Comment: "Open the Tally MCP status dashboard"
Name: "{group}\{#MyAppName} Logs";       Filename: "{app}\logs"
Name: "{group}\Reconfigure {#MyAppName}"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -NoProfile -File ""{app}\scripts\installer\firstrun-config.ps1"" -InstallDir ""{app}"""; WorkingDir: "{app}"
Name: "{group}\Connect Claude to Tally"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -NoProfile -File ""{app}\scripts\installer\connect-client.ps1"" -InstallDir ""{app}"""; WorkingDir: "{app}"; Comment: "Point Claude Desktop at this Tally server (run as the person who uses Claude)"
Name: "{group}\Uninstall {#MyAppName}";  Filename: "{uninstallexe}"

; No [Run] section. The first-run configuration (firstrun-config.ps1: writes .env, locks it, the
; company vault and the IPC directory down, registers the service and the tasks) used to be a [Run]
; entry, and [Run] discards the exit code - so a configuration that failed, including a .env
; lockdown that could not be applied (#230) or a tunnel that could not be registered (#229), still
; ended in "Setup has finished" and exit code 0. It runs from CurStepChanged(ssPostInstall) now, for
; an unattended upgrade (-Upgrade) and for every other run alike, and a failure is shown to the
; person installing and returned as Setup exit code 10 (see GetCustomSetupExitCode and
; docs/installer.md, "Unattended upgrade").

[UninstallRun]
; --- Cleanup BEFORE Inno deletes files: stop service, remove NSSM entry, remove scheduled task ---
; The vault answer is NOT on this line. [UninstallRun] parameters are expanded at INSTALL time and
; stored in unins000.dat, so the {code:GetRemoveVaultFlag} that used to end it was evaluated before
; anyone had been asked and always came out empty: the vault was never removed, whatever the
; operator answered. InitializeUninstall now hands the answer over in the uninstaller's environment
; (CLAUDALLY_UNINSTALL_REMOVE_VAULT), which this child inherits - and which also reaches the older
; copies of this entry that upgraded installs still carry in unins000.dat (RunOnceId runs one).
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -File ""{app}\scripts\installer\uninstall-cleanup.ps1"" -InstallDir ""{app}"" -ServiceName ""{#MyServiceName}"" -AgentTaskName ""{#MyAgentTaskName}"" -TrayTaskName ""{#MyTrayTaskName}"" -TunnelServiceName ""{#MyTunnelServiceName}"""; \
  RunOnceId: "TallyMcpUninstallCleanup"; \
  Flags: runhidden waituntilterminated

[UninstallDelete]
; .env holds the OAuth password and other secrets. uninstall-cleanup.ps1 overwrites and
; deletes it before this step; this entry is a fallback for the case where that script did
; not run (e.g. it was removed), so a password-bearing file is never left behind.
Type: files; Name: "{app}\.env"
; Same fallback for the Cloudflare Tunnel token file (#193), a bearer credential that
; uninstall-cleanup.ps1 also overwrites and deletes first.
Type: files; Name: "{app}\.tunnel-token"
; The unattended-upgrade preflight's lockdown probe (#177). Holds no secret and is shredded as soon as
; it is written; listed only so a preflight killed mid-probe cannot leave it behind.
Type: files; Name: "{app}\.tunnel-token.preflight"
; Same for the .env lockdown probe (#230). Its twin in the Tally data folder is outside {app}; it too
; holds nothing, and the preflight shreds it straight away.
Type: files; Name: "{app}\.tally-mcp-acl.preflight"
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\dist"
Type: filesandordirs; Name: "{app}\node-portable"
Type: filesandordirs; Name: "{app}\bin"

; ===========================================================================
; [Code] - first-run wizard pages
;
; Inno Setup's TInputQueryWizardPage gives us multi-field prompts without a
; standalone GUI. Defaults are auto-detected at NextButtonClick time so the
; user usually just clicks Next.
; ===========================================================================
[Code]
var
  ConfigPage: TInputQueryWizardPage;
  RemotePage: TInputQueryWizardPage;
  EditionPage: TInputOptionWizardPage;
  EntryOrderPage: TInputOptionWizardPage;
  GuiControlOptIn: TNewCheckBox;
  BrandLabel: TNewStaticText;
  // Unattended upgrade (#177). Decided once, in PrepareToInstall, and then only read.
  UpgradeDecided: Boolean;
  UpgradeRunCached: Boolean;
  // firstrun-config.ps1's outcome (#229, #230): see CurStepChanged and GetCustomSetupExitCode.
  ConfigExitCode: Integer;
  ConfigFailed: Boolean;
  ConfigError: String;

// ---------------------------------------------------------------------------------------------
// UNATTENDED UPGRADE (#177)
//
// The daily TallyMCPUpdate task (docs/dev/update-manifest.md) runs this installer as SYSTEM with
// /VERYSILENT /SUPPRESSMSGBOXES. Nobody answers the wizard, so its pages hold only what
// InitializeWizard put there: AUTO-DETECTED DEFAULTS, not this install's values - default Tally
// paths, edition Silver, and GetUserNameString() for the agent user, which under SYSTEM is
// "SYSTEM". Before this mode, those defaults went to firstrun-config.ps1 as explicit parameters,
// and explicit parameters win over .env. (Under SYSTEM it never got that far: `net user SYSTEM`
// fails, and NextButtonClick's plain MsgBox - which /SUPPRESSMSGBOXES does not suppress - waited
// on an invisible desktop for a click that could never come.)
//
// So: a silent run over an existing install, or any run with /UPDATE, is an upgrade. It skips the
// settings pages, passes no settings at all, and runs firstrun-config.ps1 -Upgrade, which takes
// everything from .env and the registrations that already exist. A silent run with NO existing
// install is a new install with nobody to ask whose desktop Tally is on, so it requires
// /AGENTUSER=<user> and refuses otherwise.
// ---------------------------------------------------------------------------------------------
function HasCmdLineSwitch(const Name: string): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), Name) = 0 then
    begin
      Result := True;
      exit;
    end;
end;

// "Existing install" means a configured one: .env is what firstrun-config.ps1 writes and what an
// upgrade preserves. Program files with no .env (a first run that failed) have nothing to keep.
function IsExistingInstall(): Boolean;
begin
  Result := FileExists(AddBackslash(WizardDirValue) + '.env');
end;

function IsUpgradeRun(): Boolean;
begin
  if UpgradeDecided then
    Result := UpgradeRunCached
  else
    Result := IsExistingInstall() and (WizardSilent or HasCmdLineSwitch('/UPDATE'));
end;

// The GUI agent drives the Tally window on a person's desktop; a service or computer account has
// no such desktop. Mirrors _AgentUserProblem in firstrun-config.ps1, which checks again by SID.
function IsServiceAccountName(User: string): Boolean;
var
  Leaf: string;
  P: Integer;
begin
  Leaf := Uppercase(Trim(User));
  P := Pos('\', Leaf);
  while P > 0 do
  begin
    Leaf := Copy(Leaf, P + 1, Length(Leaf));
    P := Pos('\', Leaf);
  end;
  Result := (Leaf = 'SYSTEM') or (Leaf = 'LOCALSYSTEM') or (Leaf = 'LOCAL SERVICE') or
            (Leaf = 'LOCALSERVICE') or (Leaf = 'NETWORK SERVICE') or (Leaf = 'NETWORKSERVICE');
  if (not Result) and (Length(Leaf) > 0) then
    Result := Copy(Leaf, Length(Leaf), 1) = '$';
end;

function GetPreviousDataIndex(Stored: string): Integer;
begin
  // Unknown or absent -> "ask me later". An upgrade of an install that predates this key therefore
  // keeps being asked rather than silently inheriting a layout nobody chose.
  if Stored = 'credit-first' then Result := 1
  else if Stored = 'debit-first' then Result := 2
  else Result := 0;
end;

// '' means "write no ENTRY_ORDER key", which is what makes the server ask the user later.
function GetWizardEntryOrder(Param: string): string;
begin
  if EntryOrderPage.SelectedValueIndex = 1 then Result := 'credit-first'
  else if EntryOrderPage.SelectedValueIndex = 2 then Result := 'debit-first'
  else Result := '';
end;

procedure InitializeWizard;
var
  DefaultExePath, DefaultDataPath, DefaultIniPath, DefaultDomain, DefaultUser: string;
begin
  // REMOTE ACCESS IS HIDDEN FOR NOW (#192). The mode page and the remote
  // page are both suppressed rather than deleted: the machinery underneath them is finished and
  // tested, and the remote path still WORKS - it is the provisioning story around it (no
  // Cloudflare zone, manual per-client setup, a trust claim that does not survive scrutiny) that
  // is not ready to put in front of customers. Offering a choice we cannot yet support well is
  // worse than offering one good option.
  //
  // Restoring it is deliberately small: re-create ModePage here, re-parent ConfigPage to it, and
  // make IsLocalMode() read the page again instead of returning True.
  ConfigPage := CreateInputQueryPage(wpSelectDir,
    'Tally MCP Configuration',
    'Tell us where Tally Prime lives and how to talk to it.',
    'These values become the .env file. You can change any of them later from the "Reconfigure" Start Menu shortcut.');

  ConfigPage.Add('Tally executable path:', False);
  ConfigPage.Add('Tally data folder:', False);
  ConfigPage.Add('tally.ini path:', False);
  ConfigPage.Add('Windows user the GUI agent runs as (default: current user):', False);

  // Auto-detect defaults from the box. These are the conventional Tally Prime Edit Log paths;
  // operators on stock Tally Prime will need to override.
  if FileExists('C:\Program Files\TallyPrimeEditLog\tally.exe') then
    DefaultExePath := 'C:\Program Files\TallyPrimeEditLog\tally.exe'
  else
    DefaultExePath := 'C:\Program Files\TallyPrime\tally.exe';

  if DirExists('C:\Users\Public\TallyPrimeEditLog\data') then
    DefaultDataPath := 'C:\Users\Public\TallyPrimeEditLog\data'
  else
    DefaultDataPath := 'C:\Users\Public\TallyPrime\data';

  if FileExists('C:\Program Files\TallyPrimeEditLog\tally.ini') then
    DefaultIniPath := 'C:\Program Files\TallyPrimeEditLog\tally.ini'
  else
    DefaultIniPath := 'C:\Program Files\TallyPrime\tally.ini';

  DefaultDomain := '';
  // /AGENTUSER=<user> names the person who uses Tally. A silent NEW install requires it (see
  // CheckSilentFreshInstall); on an interactive one it just pre-fills the field.
  DefaultUser := Trim(ExpandConstant('{param:AGENTUSER|}'));
  if DefaultUser = '' then
    DefaultUser := GetUserNameString();

  // Reindexed when the password moved to RemotePage. Pascal Script has no bounds checking, so a
  // half-done reindex writes the wrong value into the wrong key with no error anywhere.
  ConfigPage.Values[0] := DefaultExePath;
  ConfigPage.Values[1] := DefaultDataPath;
  ConfigPage.Values[2] := DefaultIniPath;
  ConfigPage.Values[3] := DefaultUser;  // Windows user the GUI agent runs as (current logon, editable)

  // The agent-user field is pre-filled with the current Windows user and left EDITABLE. (We dropped the
  // earlier lock + "advanced" unlock checkbox from issue #79: the checkbox sat below the last field and
  // clipped off the bottom of the wizard page, which doesn't scroll. NextButtonClick still validates the
  // entered user actually exists via `net user`, so a stray keystroke can't silently register a bad
  // account — it's caught with a clear error instead of failing silently.)

  // --- Page 2: Remote access (optional). Both fields are optional and only needed for the browser
  // claude.ai connector; kept on their own page so the main page never overflows. ---
  RemotePage := CreateInputQueryPage(ConfigPage.ID,
    'Remote Access (optional)',
    'Only needed for the browser-based claude.ai connector. Leave both blank for localhost-only (Claude Desktop needs nothing here).',
    'No public domain or static IP? Use Cloudflare Tunnel: a Jina admin provisions a token + hostname per client. Paste the hostname and token below and the installer runs cloudflared so this box gets a stable public HTTPS URL with no router config.');
  // The password lives here, not on the Tally-paths page, because it exists only to gate a
  // listener. On the local path this page is skipped entirely and no password is ever collected,
  // created or written - which is the property #172 sells.
  RemotePage.Add('OAuth password (required, min 12 chars):', True);
  RemotePage.Add('Public domain / Cloudflare Tunnel hostname (e.g. https://client.tally.jinacode.systems):', False);
  RemotePage.Add('Cloudflare Tunnel token (optional; leave blank if you do not use Cloudflare Tunnel):', False);
  RemotePage.Values[0] := '';
  RemotePage.Values[1] := DefaultDomain;
  RemotePage.Values[2] := '';

  EditionPage := CreateInputOptionPage(RemotePage.ID,
    'Tally Edition',
    'Which Tally Prime edition is installed?',
    'Silver allows only one company resident at a time; Gold allows multiple. The MCP server adapts load-company behavior based on this. Choose Silver if unsure — it is the safer default.',
    True, False);
  EditionPage.Add('Silver (single company resident; load-company always swaps)');
  EditionPage.Add('Gold (multiple companies; load-company is additive unless replace=true)');
  EditionPage.SelectedValueIndex := 0;

  // Which side leads inside a voucher. DISPLAY ONLY - Tally records debit-vs-credit in
  // ISDEEMEDPOSITIVE and the sign of AMOUNT, never in line position - so this changes what an
  // accountant sees when they open the voucher, and nothing about the posting.
  //
  // The DEFAULT is "ask me later", which writes no .env key at all. That is deliberate: a wizard
  // anyone can click Next through is not really asking, and this decides how every voucher in the
  // customer's books will read. Leaving the key absent makes the server refuse the first voucher
  // write and put the question to the user in their own words, in context, once.
  EntryOrderPage := CreateInputOptionPage(EditionPage.ID,
    'Voucher Layout',
    'Which line should come first in a voucher?',
    'Only affects how a voucher READS when you open it in Tally - the accounting is identical either way, and no figure changes. Purchases, sales, receipts and payments already use the order Tally itself prompts for, with the party line first; any other kind is asked about the first time it is used. You can change any of them later just by saying so.',
    True, False);
  EntryOrderPage.Add('Use the usual order for each kind of voucher (recommended)');
  EntryOrderPage.Add('Credit line first, for every kind');
  EntryOrderPage.Add('Debit line first, for every kind');
  EntryOrderPage.SelectedValueIndex := GetPreviousDataIndex(GetPreviousData('EntryOrder', ''));

  // Claude-driven GUI control (issue #81). ON by default (opt-OUT): it is Claudally's core capability —
  // it lets Claude log in, select/switch companies and unlock protected companies by driving the Tally
  // window (screenshots + keystrokes). Unchecking disables it (ENABLE_GUI_CONTROL=false in .env, written
  // by firstrun-config.ps1) for locked-down boxes that only want the read/write XML tools. Placed on the
  // roomy Edition page; reserve the bottom strip for the checkbox and shrink the option list to fit above.
  EditionPage.CheckListBox.Height := EditionPage.Surface.Height - ScaleY(52);
  GuiControlOptIn := TNewCheckBox.Create(EditionPage);
  GuiControlOptIn.Parent := EditionPage.Surface;
  GuiControlOptIn.Left := EditionPage.CheckListBox.Left;
  GuiControlOptIn.Top := EditionPage.Surface.Height - ScaleY(38);
  GuiControlOptIn.Width := EditionPage.SurfaceWidth;
  GuiControlOptIn.Height := ScaleY(32);
  GuiControlOptIn.Caption := 'Let Claude see and drive the Tally window (screenshots + keystrokes). On by default — untick to disable, or change it any time from the tray icon.';
  // ON by default: driving the Tally GUI is the product’s core capability, and every
  // company-loading tool already works without this flag, so the practical cost of shipping it
  // off is that Tally’s GUI state becomes unrecoverable from the server — an ungated tool can
  // still leave a modal dialog on screen that nothing is then able to see or clear.
  //
  // The value is restored from the previous install, so the choice is preserved in BOTH
  // directions: an upgrade neither removes it from someone who wants it nor re-enables it for
  // someone who deliberately turned it off.
  GuiControlOptIn.Checked := GetPreviousData('EnableGuiControl', 'true') = 'true';

  // Persistent publisher credit, bottom-left of the wizard chrome (shows on every page, alongside the
  // JINA logo carried by the sidebar image). Keeps "by JINA CODE SYSTEMS LLP" visible after the rebrand
  // to Claudally. Vertically centred against the Cancel button so it sits in the empty bottom-left strip.
  BrandLabel := TNewStaticText.Create(WizardForm);
  BrandLabel.Parent := WizardForm;
  BrandLabel.Caption := 'Claudally — by JINA CODE SYSTEMS LLP';
  BrandLabel.Font.Color := clGray;
  BrandLabel.Left := ScaleX(16);
  BrandLabel.Top := WizardForm.CancelButton.Top + (WizardForm.CancelButton.Height - BrandLabel.Height) div 2;
end;

// A silent install onto a machine with nothing installed has nobody to ask which Windows user uses
// Tally, and the only guess available - the account running Setup - is wrong in exactly the cases
// that run silently: SYSTEM under a deployment tool or the update task, or an IT admin who will
// never open Tally. So it is told, with /AGENTUSER, or it refuses. Returns '' to proceed.
function CheckSilentFreshInstall(): String;
var
  User: string;
  Code: Integer;
begin
  Result := '';
  User := Trim(ExpandConstant('{param:AGENTUSER|}'));
  if User = '' then
  begin
    Result := 'This is a new installation running silently, so there is nobody to ask which Windows user uses Tally, ' +
              'and Setup will not guess. Run it again with /AGENTUSER=<Windows logon name of the person who uses Tally>, ' +
              'or run it interactively. Nothing was installed.';
    exit;
  end;
  if Pos('"', User) > 0 then
  begin
    Result := '/AGENTUSER contains a double quote, which no Windows account name can. Nothing was installed.';
    exit;
  end;
  if IsServiceAccountName(User) then
  begin
    Result := '/AGENTUSER=' + User + ' is a service or computer account. The GUI agent drives the Tally window on a ' +
              'person''s desktop, so it must be that person''s account. Nothing was installed.';
    exit;
  end;
  // `net user` only knows local accounts. A DOMAIN\user name is left to firstrun-config.ps1, which
  // resolves it by SID and refuses a service account however it is spelled.
  if Pos('\', User) = 0 then
  begin
    if not Exec(ExpandConstant('{cmd}'), '/C net user "' + User + '" >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, Code) then
      Code := -1;
    if Code <> 0 then
    begin
      Result := 'Windows user "' + User + '" (from /AGENTUSER) does not exist on this computer. Nothing was installed.';
      exit;
    end;
  end;
  ConfigPage.Values[3] := User;
end;

// Runs THIS version's firstrun-config.ps1 -Upgrade -PreflightOnly against the existing install
// before anything is stopped or copied. It changes nothing; it only answers "can an unattended
// upgrade keep every setting?" - and when it cannot (no recorded agent user, .env and the agent task
// disagree, the recorded user is SYSTEM, a .env / vault / token-file lockdown that would fail, ...)
// Setup stops here, leaving the running version exactly
// as it was, with the reason in the Setup log. Returns '' to proceed.
function RunUpgradePreflight(): String;
var
  Report: string;
  Loaded: AnsiString;
  Code: Integer;
begin
  Result := '';
  ExtractTemporaryFile('firstrun-config.ps1');
  Report := ExpandConstant('{tmp}\upgrade-preflight.txt');
  if not Exec('powershell.exe',
              '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\firstrun-config.ps1') + '"' +
              ' -InstallDir "' + ExpandConstant('{app}') + '" -AgentTaskName "{#MyAgentTaskName}" -TrayTaskName "{#MyTrayTaskName}"' +
              ' -Upgrade -PreflightOnly -ReportFile "' + Report + '"',
              '', SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    Result := 'Setup could not start PowerShell to check that this upgrade can keep the existing settings, so it changed nothing.';
    exit;
  end;
  if Code <> 0 then
  begin
    if LoadStringFromFile(Report, Loaded) then
      Result := String(Loaded)
    else
      Result := 'The upgrade check failed (exit code ' + IntToStr(Code) + ') and left no details. Nothing was changed.';
    exit;
  end;
  if LoadStringFromFile(Report, Loaded) then
    Log(String(Loaded));
end;

// Runs after the wizard and before any file copying. Stops the running TallyMCP service
// and agent/tray scheduled tasks so the installer can overwrite locked DLLs like
// node_modules\@duckdb\node-bindings-win32-x64\duckdb.dll without hitting
// "DeleteFile failed; code 5. Access is denied" on existing-install upgrades.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  resultCode: Integer;
  installDir: string;
begin
  Result := '';
  NeedsRestart := False;
  installDir := ExpandConstant('{app}');

  // 0. Decide, once, whether this is an unattended upgrade, and refuse what cannot be done safely -
  //    BEFORE anything below stops a service or a task. A string returned here ends Setup with exit
  //    code 7 and the reason in the log (/LOG=...).
  UpgradeRunCached := IsUpgradeRun();
  UpgradeDecided := True;
  if HasCmdLineSwitch('/UPDATE') and (not IsExistingInstall()) then
  begin
    Result := 'No existing Claudally installation was found in ' + installDir + ' (it has no .env). ' +
              '/UPDATE only updates an existing installation; it never creates one. Nothing was changed.';
    Log(Result);
    exit;
  end;
  if UpgradeRunCached then
  begin
    Log('Unattended upgrade of ' + installDir + ': every existing setting is kept (firstrun-config.ps1 -Upgrade).');
    Result := RunUpgradePreflight();
  end
  else if WizardSilent then
    Result := CheckSilentFreshInstall();
  if Result <> '' then
  begin
    Log(Result);
    exit;
  end;

  // 1. Stop and disable the NSSM service so SCM doesn't auto-restart it while we're
  //    copying files over locked DLLs. Disable is reverted by firstrun-config.ps1's
  //    `nssm set ... Start SERVICE_AUTO_START` later in the install.
  Exec(ExpandConstant('{cmd}'), '/C sc stop TallyMCP', '', SW_HIDE, ewWaitUntilTerminated, resultCode);
  Exec(ExpandConstant('{cmd}'), '/C sc config TallyMCP start= disabled', '', SW_HIDE, ewWaitUntilTerminated, resultCode);
  // Also stop the optional Cloudflare Tunnel service + cloudflared.exe so bin\cloudflared.exe isn't
  // locked when the file-copy phase overwrites it on an upgrade. No-ops when no tunnel was configured.
  Exec(ExpandConstant('{cmd}'), '/C sc stop TallyMCPTunnel', '', SW_HIDE, ewWaitUntilTerminated, resultCode);
  Exec(ExpandConstant('{cmd}'), '/C taskkill /F /IM cloudflared.exe', '', SW_HIDE, ewWaitUntilTerminated, resultCode);

  // 2. End the at-logon scheduled tasks. /F = force, even if currently running. schtasks
  //    tolerates missing tasks on fresh installs (non-zero exit, ignored).
  Exec(ExpandConstant('{cmd}'), '/C schtasks /End /TN TallyMCPAgent /F', '', SW_HIDE, ewWaitUntilTerminated, resultCode);
  Exec(ExpandConstant('{cmd}'), '/C schtasks /End /TN TallyMCPTray /F',  '', SW_HIDE, ewWaitUntilTerminated, resultCode);

  // 3. Stop processes belonging to THIS install so the copy phase can replace their files.
  //
  //    This used three `wmic process where ... delete` calls. wmic is a Feature-on-Demand that is
  //    ABSENT BY DEFAULT on Windows 11 24H2 and Server 2025, so on a current machine all three
  //    were silent no-ops and the upgrade failed later with a DeleteFile error naming no process.
  //    Two of them also matched any powershell.exe whose command line merely contained TallyMCP
  //    anywhere on the box, while the node.exe filter matched only server.mjs - the REMOTE
  //    entrypoint - so a local-mode server (dist\index.mjs, #172) survived and held the lock.
  //
  //    The helper decides ownership by install path, and deliberately spares anything under
  //    {app}\update: #177 s updater orchestrator runs from there and must outlive the install
  //    it is driving, because it is what performs the rollback if the new build fails to start.
  ExtractTemporaryFile('stop-install-processes.ps1');
  Exec('powershell.exe',
       '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\stop-install-processes.ps1') + '" -InstallDir "' + ExpandConstant('{app}') + '"',
       '', SW_HIDE, ewWaitUntilTerminated, resultCode);

  // 4. Wait for the process tear-down to actually release handles. SCM marks STOPPED before
  //    NSSM's child node.exe exits; duckdb in-memory cleanup adds a couple of seconds.
  Sleep(5000);

  // 5. On existing installs, grant full control to the install dir so the file copy phase
  //    can overwrite read-only or restrictive-ACL files (e.g. tray assets that ended up
  //    owned by SYSTEM after a previous install). Skipped silently on fresh installs.
  //    Security: grant Administrators + SYSTEM only (SIDs S-1-5-32-544 / S-1-5-18), NOT Everyone.
  //    The installer runs elevated so Administrators already suffices to overwrite the files;
  //    granting Everyone:F /T made the whole tree (node.exe, server.mjs, nssm.exe, .env — later
  //    executed by the SYSTEM service) world-writable and was never revoked, a local
  //    privilege-escalation-to-SYSTEM vector.
  if DirExists(installDir) then
  begin
    Exec(ExpandConstant('{cmd}'), '/C icacls "' + installDir + '" /grant *S-1-5-32-544:(OI)(CI)F *S-1-5-18:(OI)(CI)F /T /C >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, resultCode);

    // 6. Pre-delete the files that have historically caused "DeleteFile failed; code 5" on
    //    upgrade. duckdb.dll is held by the native loader until node.exe is gone; jina-logo.png
    //    is sometimes locked by Explorer thumbnail cache. Both are safe to remove — the new
    //    installer copies them back.
    Exec(ExpandConstant('{cmd}'), '/C del /F /Q "' + installDir + '\scripts\tray\assets\jina-logo.png" >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, resultCode);
    Exec(ExpandConstant('{cmd}'), '/C del /F /Q "' + installDir + '\node_modules\@duckdb\node-bindings-win32-x64\duckdb.dll" >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, resultCode);
  end;
end;

// The single source of truth for which mode was chosen. Everything else - the skipped page, the
// credentials file, the value handed to firstrun-config.ps1 - reads this rather than re-deriving
// it, so there is no way for the wizard to act on one answer and record another.
// While remote is hidden, every install this wizard performs is a local one. Kept as a function
// rather than inlined so restoring the mode page is a one-line change here.
function IsLocalMode(): Boolean;
begin
  Result := True;
end;

// DELIBERATELY EMPTY, and this is the load-bearing part of hiding remote.
//
// Passing "local" here would CONVERT every existing remote install to local on upgrade - tearing
// out the service and the listener of a working deployment because we changed our installer's
// UI. Passing nothing lets firstrun-config.ps1 apply its own precedence, which already answers
// correctly for all three cases: a fresh install has no .env and defaults to local; an install
// carrying DEPLOYMENT_MODE keeps whatever it says; and an install predating the key falls back to
// remote, so it is a strict no-op. The same reasoning is why the hidden RemotePage no longer
// supplies MCP_DOMAIN or TUNNEL_TOKEN - blank preserves the existing values rather than clearing
// them.
function GetWizardMode(Param: string): string;
begin
  Result := '';
end;

// Local mode has no listener, so the whole remote page is meaningless there. Skipping it is not
// only cosmetic: NextButtonClick never fires for a skipped page, which is what keeps the
// "password must be 12 chars" validation from blocking a local install that has no password.
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if (PageID = RemotePage.ID) and IsLocalMode() then Result := True;
  // An unattended upgrade asks nothing: every setting comes from the existing install. Skipping
  // these pages also keeps NextButtonClick's validation away from their default values.
  if IsUpgradeRun() and ((PageID = ConfigPage.ID) or (PageID = RemotePage.ID) or
                         (PageID = EditionPage.ID) or (PageID = EntryOrderPage.ID)) then
    Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  agentUserValue: string;
  errCode: Integer;
begin
  Result := True;
  // Silent: nobody can answer a MsgBox (and /SUPPRESSMSGBOXES does not suppress MsgBox, only
  // SuppressibleMsgBox), so a failed check here would hang Setup on an invisible dialog. A silent
  // new install's agent user is checked in PrepareToInstall (CheckSilentFreshInstall) instead.
  if WizardSilent then exit;
  if CurPageID = ConfigPage.ID then
  begin
    // Validate the GUI agent user actually exists on this box. Catches typos / paste accidents
    // BEFORE the installer tries to register the scheduled task with a bogus account, which fails
    // with "No mapping between account names and security IDs was done."
    agentUserValue := Trim(ConfigPage.Values[3]);
    if Length(agentUserValue) = 0 then
    begin
      // Blank (e.g. cleared while overriding) — restore the current-user default rather than block.
      // The field is locked to the current user unless the "advanced" checkbox is ticked (issue #79),
      // so an empty value here is a mistake we can safely auto-correct.
      ConfigPage.Values[3] := GetUserNameString();
      agentUserValue := Trim(ConfigPage.Values[3]);
    end;
    // ShellExec runs `net user "<name>"` quietly; exit code 0 = user exists.
    if not ShellExec('open', 'cmd.exe', '/c net user "' + agentUserValue + '" >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, errCode) then
    begin
      // ShellExec itself failed to launch — fall through and let the install proceed; the
      // post-install task registration will surface the real error.
      Result := True;
    end
    else if errCode <> 0 then
    begin
      MsgBox('Windows user "' + agentUserValue + '" does not exist on this box.' + #13#10 +
             'Use the actual logon name (e.g. ' + GetUserNameString() + ').' + #13#10#13#10 +
             'If you continue with this value, the GUI agent task will not register and load-company will not work.',
             mbError, MB_OK);
      Result := False;
      exit;
    end;
  end
  else if CurPageID = RemotePage.ID then
  begin
    // Only reachable in remote mode: ShouldSkipPage skips this page on the local path, and
    // NextButtonClick never fires for a skipped page - which is what stops this password rule
    // blocking a local install that correctly has no password.
    if Length(RemotePage.Values[0]) < 12 then
    begin
      MsgBox('OAuth password must be at least 12 characters.', mbError, MB_OK);
      Result := False;
      exit;
    end;

    // A Cloudflare Tunnel token needs the public hostname (field above it) so the MCP server
    // advertises the correct OAuth URL. Block rather than silently produce a connector that
    // points at localhost.
    // Indices moved when the password became RemotePage field 0: token is now [2], hostname [1].
    if (Length(Trim(RemotePage.Values[2])) > 0) and (Length(Trim(RemotePage.Values[1])) = 0) then
    begin
      MsgBox('You entered a Cloudflare Tunnel token but left the "Public domain / Cloudflare Tunnel hostname" field blank.' + #13#10 +
             'Enter the tunnel hostname (e.g. https://client123.tally.jinacode.systems) so the connector URL is correct.', mbError, MB_OK);
      Result := False;
      exit;
    end;
  end;
end;

// Path to the temporary credentials file the installer writes before invoking firstrun-config.ps1.
// Lives in {tmp} (the installer's per-user temp folder, ACL'd to the installing user). The PowerShell
// script reads it and immediately deletes it, so the password never appears on a process command line
// where Get-CimInstance Win32_Process / wmic could observe it during the install window.
//
// EMPTY IN LOCAL MODE, where no file is written (CurStepChanged). Handing firstrun-config.ps1 the
// path of a file that does not exist made it throw "Credentials file not found" whenever the
// install it was upgrading turned out to be REMOTE - which, with the mode passed as '' (#192), is
// every remote install - before .env was read, and with the service already disabled by
// PrepareToInstall. Passing nothing lets it keep the PASSWORD already in .env.
function GetCredentialsFilePath(Param: string): string;
begin
  if IsLocalMode() then
    Result := ''
  else
    Result := ExpandConstant('{tmp}\tally-mcp-firstrun-creds.json');
end;

// Hook: called by Inno Setup as the install transitions through phases. We write the credentials
// JSON just before the [Run] section fires (ssInstall = "files have been copied; now running [Run]
// entries"). Inno auto-cleans {tmp} at end-of-install, but firstrun-config.ps1 also deletes the
// file as soon as it has read the password.
// The Finished page has to say what actually happened, because the two modes end in genuinely
// different places and the default "Setup has finished installing" is true of both and useful for
// neither. In local mode the ONLY visible evidence of success is Tally tools appearing in Claude,
// and that requires a full quit-and-reopen: a user who merely closes the window sees nothing and
// reasonably concludes the install failed.
// Asked once, before anything is removed (#172 E1). The stored Tally company passwords live
// OUTSIDE the install directory, so uninstalling has always left them on disk - protected only
// by an NTFS ACL that nothing maintains afterwards, and decryptable by any local account that
// can read the file (DPAPI is machine-scoped). Removing them is the safer default; keeping them
// is what someone reinstalling would want. Only the operator can choose, so ask.
var
  UninstRemoveVault: Boolean;

// How the answer reaches uninstall-cleanup.ps1 - see the note on [UninstallRun] for why it cannot
// be a {code:} parameter. The uninstaller's own environment is inherited by the [UninstallRun] child.
function SetEnvironmentVariable(lpName: string; lpValue: string): BOOL;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

//
// A SILENT uninstall is never asked. A plain MsgBox is not suppressed by /SUPPRESSMSGBOXES (only
// SuppressibleMsgBox is), and without that switch nothing is suppressed at all, so under SYSTEM - a
// deployment tool, or anything run from session 0 - the question would wait on a desktop nobody can
// see, and the uninstall would hang for good. Silent takes the recommended answer, delete, unless
// the caller passes /KEEPVAULT (e.g. to uninstall and reinstall unattended).
function InitializeUninstall(): Boolean;
var
  Flag: string;
begin
  Result := True;
  if UninstallSilent() then
    UninstRemoveVault := not HasCmdLineSwitch('/KEEPVAULT')
  else
    UninstRemoveVault :=
      MsgBox('Remove saved Tally company passwords?' + #13#10#13#10 +
             'Claudally can store the password for each password-protected company so Claude can open ' +
             'them for you. They are encrypted and tied to this computer.' + #13#10#13#10 +
             'Yes  - delete them now (recommended)' + #13#10 +
             'No   - keep them, so a future reinstall picks them up',
             mbConfirmation, MB_YESNO or MB_DEFBUTTON1) = IDYES;
  // Always set, to 1 or 0, so a value inherited from whoever launched the uninstaller cannot decide
  // for the operator.
  if UninstRemoveVault then Flag := '1' else Flag := '0';
  if not SetEnvironmentVariable('CLAUDALLY_UNINSTALL_REMOVE_VAULT', Flag) then
    Log('Could not pass the vault answer to uninstall-cleanup.ps1; the saved passwords will be kept.');
  Log('Remove saved Tally company passwords: ' + Flag);
end;
procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
  begin
    // Never "installed and running" over a configuration that failed (#229, #230).
    if ConfigFailed then
      WizardForm.FinishedLabel.Caption :=
        'Claudally''s files were installed, but configuring it FAILED, so it is not set up yet.' + #13#10 + #13#10 +
        ConfigError + #13#10 + #13#10 +
        'Details are in the logs folder of the install directory (firstrun-config.log). Fix the ' +
        'cause, then run "Reconfigure {#MyAppName}" from the Start Menu as administrator.'
    else if IsLocalMode() then
      WizardForm.FinishedLabel.Caption :=
        'Claudally is installed on this computer. Two things left, both one-time:' + #13#10 + #13#10 +
        '1. TURN ON TALLY''S DATA CONNECTION. Tally comes with it switched off, and Claude cannot ' +
        'read anything until it is on. In Tally Prime: press F1, then Settings > Connectivity > ' +
        'Client/Server Configuration. Set "TallyPrime acts as" to Server and Port to 9000, then ' +
        'press Ctrl+A. Leave Tally open whenever you want to use this.' + #13#10 + #13#10 +
        '2. RESTART CLAUDE DESKTOP COMPLETELY - closing the window is not enough. Use File > Exit, ' +
        'or right-click its icon near the clock and choose Quit. Tally tools appear once it ' +
        'reopens. If you have not installed Claude Desktop yet, install it and then run ' +
        '"Connect Claude to Tally" from the Start Menu.' + #13#10 + #13#10 +
        'The tray icon near the clock tells you if either step is still outstanding. Nothing is ' +
        'listening on the network and no password was created.' + #13#10 + #13#10 +
        'Once a day the tray asks GitHub whether a newer version exists, and tells you if so. It ' +
        'downloads nothing - installing is always your decision. Turn it off by setting ' +
        'UPDATE_CHECK=false in the .env file in the install folder.'
    else
      WizardForm.FinishedLabel.Caption :=
        'Claudally is installed and running as a Windows service. One thing left:' + #13#10 + #13#10 +
        'TURN ON TALLY''S DATA CONNECTION - it ships switched off. In Tally Prime: press F1, then ' +
        'Settings > Connectivity > Client/Server Configuration. Set "TallyPrime acts as" to Server ' +
        'and Port to 9000, then press Ctrl+A.' + #13#10 + #13#10 +
        'Then point your MCP client at the public address you entered. The tray icon near the clock ' +
        'shows whether the service and tunnel are healthy.';
  end;
end;

function GetWizardExePath(Param: string): string;
begin
  Result := ConfigPage.Values[0];
end;

function GetWizardDataPath(Param: string): string;
begin
  Result := ConfigPage.Values[1];
end;

function GetWizardIniPath(Param: string): string;
begin
  Result := ConfigPage.Values[2];
end;

function GetWizardDomain(Param: string): string;
begin
  Result := RemotePage.Values[1];
end;

function GetWizardTunnelToken(Param: string): string;
begin
  Result := RemotePage.Values[2];
end;

function GetWizardAgentUser(Param: string): string;
begin
  Result := ConfigPage.Values[3];
end;

// Persist the GUI-control choice into the install's own record so the next upgrade restores it
// rather than re-applying the (now off) default. Without this, flipping the default silently
// removes the capability from every install that had deliberately enabled it.
procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  if GuiControlOptIn.Checked then
    SetPreviousData(PreviousDataKey, 'EnableGuiControl', 'true')
  else
    SetPreviousData(PreviousDataKey, 'EnableGuiControl', 'false');
  SetPreviousData(PreviousDataKey, 'EntryOrder', GetWizardEntryOrder(''));
end;
function GetWizardGuiControl(Param: string): string;
begin
  if GuiControlOptIn.Checked then
    Result := 'true'
  else
    Result := 'false';
end;

// 10 = the files were installed but firstrun-config.ps1 failed, so the install is not configured and
// services and tasks may be stopped. Set by an unattended upgrade (the updater's cue to roll back)
// and, since #229/#230, by any other run too - a new install or an interactive one - so a deployment
// tool sees the failure instead of a clean exit. Inno's own codes (1-8) cover everything else,
// including 7 for an upgrade or silent install refused in PrepareToInstall before anything changed.
function GetCustomSetupExitCode(): Integer;
begin
  Result := ConfigExitCode;
end;

function GetWizardEdition(Param: string): string;
begin
  if EditionPage.SelectedValueIndex = 1 then
    Result := 'gold'
  else
    Result := 'silver';
end;

// Keeps the last "ERROR: ..." line firstrun-config.ps1 prints (its catch block writes exactly one),
// so a failure can be shown to the person installing, not only buried in the log.
procedure FirstrunOutputLine(const S: String; const Error, FirstLine: Boolean);
begin
  if Pos('ERROR: ', S) = 1 then
    ConfigError := Copy(S, 8, Length(S) - 7);
end;

// Runs the installed firstrun-config.ps1 and returns its exit code (-1 if it could not be started).
// ExecAndLogOutput copies the script's output into the Setup log, so one /LOG file tells support the
// whole story. Not from [Run]: [Run] discards the exit code, and before #229/#230 that is how a
// failed configuration - a .env left readable, a tunnel left down - still ended in "Setup has
// finished" and exit code 0.
function RunFirstrunConfig(const Params: String): Integer;
var
  Code: Integer;
begin
  ConfigError := '';
  try
    if not ExecAndLogOutput('powershell.exe',
                '-ExecutionPolicy Bypass -NoProfile -NonInteractive -File "' + ExpandConstant('{app}\scripts\installer\firstrun-config.ps1') + '"' +
                ' -InstallDir "' + ExpandConstant('{app}') + '" -ServiceName "{#MyServiceName}" -AgentTaskName "{#MyAgentTaskName}"' +
                ' -TrayTaskName "{#MyTrayTaskName}" -TunnelServiceName "{#MyTunnelServiceName}" ' + Params,
                ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code, @FirstrunOutputLine) then
      Code := -1;
  except
    Log('Could not run firstrun-config.ps1: ' + GetExceptionMessage);
    Code := -1;
  end;
  Result := Code;
end;

// The wizard's answers, as firstrun-config.ps1 parameters. What the [Run] entry used to pass.
function WizardConfigParams(): String;
begin
  Result := '-CredentialsFile "' + GetCredentialsFilePath('') + '"' +
            ' -TallyEdition "' + GetWizardEdition('') + '"' +
            ' -TallyExePath "' + GetWizardExePath('') + '"' +
            ' -TallyDataPath "' + GetWizardDataPath('') + '"' +
            ' -TallyIniPath "' + GetWizardIniPath('') + '"' +
            ' -McpDomain "' + GetWizardDomain('') + '"' +
            ' -TunnelToken "' + GetWizardTunnelToken('') + '"' +
            ' -AgentTaskUser "' + GetWizardAgentUser('') + '"' +
            ' -EnableGuiControl "' + GetWizardGuiControl('') + '"' +
            ' -EntryOrder "' + GetWizardEntryOrder('') + '"' +
            ' -DeploymentMode "' + GetWizardMode('') + '"' +
            ' -Unattended';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  CredsPath, Json, Password, Escaped, Msg: string;
  Code: Integer;
begin
  // Configure the install, once the files are in place. An unattended upgrade reconfigures from the
  // existing install, not from the wizard (-Upgrade: every setting comes from .env); every other run
  // passes the wizard's answers. Either way a non-zero exit is a failed configuration: Setup exits 10
  // (see GetCustomSetupExitCode), which for an upgrade is the update task's cue to roll back, and a
  // person installing is told - with the script's own error - rather than shown "finished".
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := 'Configuring service and writing .env...';
    if IsUpgradeRun() then
      Code := RunFirstrunConfig('-Upgrade -Unattended')
    else
      Code := RunFirstrunConfig(WizardConfigParams());
    if Code <> 0 then
    begin
      ConfigExitCode := 10;
      ConfigFailed := True;
      Log('firstrun-config.ps1 failed (exit code ' + IntToStr(Code) + '); see ' +
          ExpandConstant('{app}\logs\firstrun-config.log') + '. Setup will exit with code 10.');
      if not IsUpgradeRun() then
      begin
        Msg := 'Claudally''s files were installed, but configuring it failed, so it is not set up.';
        if ConfigError <> '' then
          Msg := Msg + #13#10#13#10 + ConfigError;
        Msg := Msg + #13#10#13#10 + 'Details are in ' + ExpandConstant('{app}\logs\firstrun-config.log') +
               '. Fix the cause, then run "Reconfigure {#MyAppName}" from the Start Menu as administrator.';
        SuppressibleMsgBox(Msg, mbError, MB_OK, IDOK);
      end;
    end
    else if IsUpgradeRun() then
      Log('firstrun-config.ps1 -Upgrade completed; existing settings kept.')
    else
      Log('firstrun-config.ps1 completed.');
  end;

  // Local mode never writes a credentials file. firstrun-config.ps1 shreds one if it finds it,
  // but the stronger guarantee is that no password is ever produced to be shredded. Nor does an
  // upgrade, which keeps whatever password .env already holds.
  if (CurStep = ssInstall) and (not IsLocalMode()) and (not IsUpgradeRun()) then
  begin
    CredsPath := GetCredentialsFilePath('');
    Password := RemotePage.Values[0];
    // Minimal JSON-string escaping: backslash and double-quote only.
    // Pascal Script's StringChange is a procedure that mutates a var argument in place
    // (it does NOT return a string), so we copy first and then mutate the copy.
    Escaped := Password;
    StringChange(Escaped, '\', '\\');
    StringChange(Escaped, '"', '\"');
    Json := '{"password":"' + Escaped + '"}';
    if not SaveStringToFile(CredsPath, Json, False) then
    begin
      // Suppressible: this is reachable in a silent run (remote mode, once #192 restores it).
      Log('Failed to write installer credentials file at ' + CredsPath + '.');
      SuppressibleMsgBox('Failed to write installer credentials file at ' + CredsPath + '. Install cannot continue.', mbError, MB_OK, IDOK);
      Abort;
    end;
  end;
end;
