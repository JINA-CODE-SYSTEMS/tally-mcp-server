; ===========================================================================
; Tally MCP Server - Inno Setup installer (issue #18)
;
; Builds a single TallyMCP-Setup.exe that takes a Windows box from "nothing
; installed" to "service running" with a short wizard. Bundles:
;   - the prebuilt dist/ output (no client-side TS compile)
;   - scripts/ (deploy.ps1, tally-gui-agent-v2.ps1, TallyUI.dll, this installer's helpers)
;   - portable Node.js (drop into installer-staging/node-portable/ before compile)
;   - NSSM (drop nssm.exe into installer-staging/ before compile)
;
; Build prerequisites (see build-installer.ps1 for the orchestrated flow):
;   - Inno Setup 6+ (ISCC.exe on PATH)
;   - npm install + npm run build run on the source tree
;   - installer-staging/ populated with portable Node + NSSM
;
; This .iss is intentionally Inno-Setup-only — no WiX, no MSI. v1 ships an .exe
; for direct download. SCCM/GPO support can be added later if a client needs it.
; ===========================================================================

#define MyAppName        "Tally MCP Server"
#define MyAppVersion     "1.1.0"
#define MyAppPublisher   "Jinacode Systems"
#define MyAppURL         "https://github.com/JINA-CODE-SYSTEMS/tally-mcp-server"
#define MyServiceName    "TallyMCP"
#define MyAgentTaskName  "TallyMCPAgent"

; Source root: the installer is built from <repo>/scripts/installer/, so SourceDir
; climbs two levels to reach the repo root. SourcePath itself is provided by Inno.
#define RepoRoot         "..\\.."
#define StagingRoot      "..\\..\\installer-staging"

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
OutputBaseFilename=TallyMCP-Setup-{#MyAppVersion}
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
UninstallDisplayIcon={app}\dist\server.mjs
ChangesEnvironment=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; --- The built MCP server (dist/) and runtime metadata. We REQUIRE the build to be done
; before invoking ISCC; client-side TypeScript compile would mean shipping ~150 MB of
; @types and tsc and is brittle on locked-down boxes. ---
Source: "{#RepoRoot}\dist\*";          DestDir: "{app}\dist";    Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#RepoRoot}\package.json";    DestDir: "{app}";          Flags: ignoreversion
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
Source: "{#RepoRoot}\scripts\installer\uninstall-cleanup.ps1";  DestDir: "{app}\scripts\installer"; Flags: ignoreversion

; --- Bundled portable Node.js. Avoids version conflicts with anything else on the box.
; The build script populates installer-staging/node-portable/ from the official Node zip. ---
Source: "{#StagingRoot}\node-portable\*"; DestDir: "{app}\node-portable"; Flags: ignoreversion recursesubdirs createallsubdirs

; --- NSSM (service manager). Wrapped here so we don't need network access at install time. ---
Source: "{#StagingRoot}\nssm.exe"; DestDir: "{app}\bin"; Flags: ignoreversion

; --- Logs / data directories created at install time (empty on disk; AfterInstall ensures perms). ---

[Dirs]
Name: "{app}\logs"; Permissions: users-modify
Name: "{app}\data"; Permissions: users-modify

[Icons]
Name: "{group}\{#MyAppName} Logs";       Filename: "{app}\logs"
Name: "{group}\Reconfigure {#MyAppName}"; Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -NoProfile -File ""{app}\scripts\installer\firstrun-config.ps1"" -InstallDir ""{app}"""; WorkingDir: "{app}"
Name: "{group}\Uninstall {#MyAppName}";  Filename: "{uninstallexe}"

[Run]
; --- 1. First-run wizard: writes .env from collected wizard inputs and registers the NSSM service ---
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -File ""{app}\scripts\installer\firstrun-config.ps1"" -InstallDir ""{app}"" -ServiceName ""{#MyServiceName}"" -AgentTaskName ""{#MyAgentTaskName}"" -CredentialsFile ""{code:GetCredentialsFilePath}"" -TallyEdition ""{code:GetWizardEdition}"" -TallyExePath ""{code:GetWizardExePath}"" -TallyDataPath ""{code:GetWizardDataPath}"" -TallyIniPath ""{code:GetWizardIniPath}"" -McpDomain ""{code:GetWizardDomain}"" -AgentTaskUser ""{code:GetWizardAgentUser}"""; \
  WorkingDir: "{app}"; \
  StatusMsg: "Configuring service and writing .env..."; \
  Flags: runhidden waituntilterminated

[UninstallRun]
; --- Cleanup BEFORE Inno deletes files: stop service, remove NSSM entry, remove scheduled task ---
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -NoProfile -File ""{app}\scripts\installer\uninstall-cleanup.ps1"" -InstallDir ""{app}"" -ServiceName ""{#MyServiceName}"" -AgentTaskName ""{#MyAgentTaskName}"""; \
  RunOnceId: "TallyMcpUninstallCleanup"; \
  Flags: runhidden waituntilterminated

[UninstallDelete]
; .env is intentionally left behind on uninstall — it contains the OAuth password and other secrets
; the operator may have rotated. Delete manually if a clean wipe is desired.
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
  EditionPage: TInputOptionWizardPage;

procedure InitializeWizard;
var
  DefaultExePath, DefaultDataPath, DefaultIniPath, DefaultDomain, DefaultUser: string;
begin
  ConfigPage := CreateInputQueryPage(wpSelectDir,
    'Tally MCP Configuration',
    'Tell us where Tally Prime lives and how to talk to it.',
    'These values become the .env file. You can edit them later via the "Reconfigure" Start Menu shortcut. The OAuth password below is required and protects access to all MCP tools.');

  ConfigPage.Add('OAuth password (required, min 12 chars):', True);
  ConfigPage.Add('Tally executable path:', False);
  ConfigPage.Add('Tally data folder:', False);
  ConfigPage.Add('tally.ini path:', False);
  ConfigPage.Add('Public domain (leave blank for localhost-only):', False);
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
  DefaultUser := GetUserNameString();

  ConfigPage.Values[0] := '';
  ConfigPage.Values[1] := DefaultExePath;
  ConfigPage.Values[2] := DefaultDataPath;
  ConfigPage.Values[3] := DefaultIniPath;
  ConfigPage.Values[4] := DefaultDomain;
  ConfigPage.Values[5] := DefaultUser;

  EditionPage := CreateInputOptionPage(ConfigPage.ID,
    'Tally Edition',
    'Which Tally Prime edition is installed?',
    'Silver allows only one company resident at a time; Gold allows multiple. The MCP server adapts load-company behavior based on this. Choose Silver if unsure — it is the safer default.',
    True, False);
  EditionPage.Add('Silver (single company resident; load-company always swaps)');
  EditionPage.Add('Gold (multiple companies; load-company is additive unless replace=true)');
  EditionPage.SelectedValueIndex := 0;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  agentUserValue: string;
  errCode: Integer;
begin
  Result := True;
  if CurPageID = ConfigPage.ID then
  begin
    if Length(ConfigPage.Values[0]) < 12 then
    begin
      MsgBox('OAuth password must be at least 12 characters.', mbError, MB_OK);
      Result := False;
      exit;
    end;

    // Validate the GUI agent user actually exists on this box. Catches typos / paste accidents
    // (e.g. accidentally fragmenting the public-domain string into the user field) BEFORE the
    // installer tries to register the scheduled task with a bogus account, which fails with
    // "No mapping between account names and security IDs was done."
    agentUserValue := Trim(ConfigPage.Values[5]);
    if Length(agentUserValue) = 0 then
    begin
      MsgBox('Windows user (last field) cannot be empty.', mbError, MB_OK);
      Result := False;
      exit;
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
  end;
end;

// Path to the temporary credentials file the installer writes before invoking firstrun-config.ps1.
// Lives in {tmp} (the installer's per-user temp folder, ACL'd to the installing user). The PowerShell
// script reads it and immediately deletes it, so the password never appears on a process command line
// where Get-CimInstance Win32_Process / wmic could observe it during the install window.
function GetCredentialsFilePath(Param: string): string;
begin
  Result := ExpandConstant('{tmp}\tally-mcp-firstrun-creds.json');
end;

// Hook: called by Inno Setup as the install transitions through phases. We write the credentials
// JSON just before the [Run] section fires (ssInstall = "files have been copied; now running [Run]
// entries"). Inno auto-cleans {tmp} at end-of-install, but firstrun-config.ps1 also deletes the
// file as soon as it has read the password.
procedure CurStepChanged(CurStep: TSetupStep);
var
  CredsPath, Json, Password, Escaped: string;
begin
  if CurStep = ssInstall then
  begin
    CredsPath := GetCredentialsFilePath('');
    Password := ConfigPage.Values[0];
    // Minimal JSON-string escaping: backslash and double-quote only.
    // Pascal Script's StringChange is a procedure that mutates a var argument in place
    // (it does NOT return a string), so we copy first and then mutate the copy.
    Escaped := Password;
    StringChange(Escaped, '\', '\\');
    StringChange(Escaped, '"', '\"');
    Json := '{"password":"' + Escaped + '"}';
    if not SaveStringToFile(CredsPath, Json, False) then
    begin
      MsgBox('Failed to write installer credentials file at ' + CredsPath + '. Install cannot continue.', mbError, MB_OK);
      Abort;
    end;
  end;
end;

function GetWizardExePath(Param: string): string;
begin
  Result := ConfigPage.Values[1];
end;

function GetWizardDataPath(Param: string): string;
begin
  Result := ConfigPage.Values[2];
end;

function GetWizardIniPath(Param: string): string;
begin
  Result := ConfigPage.Values[3];
end;

function GetWizardDomain(Param: string): string;
begin
  Result := ConfigPage.Values[4];
end;

function GetWizardAgentUser(Param: string): string;
begin
  Result := ConfigPage.Values[5];
end;

function GetWizardEdition(Param: string): string;
begin
  if EditionPage.SelectedValueIndex = 1 then
    Result := 'gold'
  else
    Result := 'silver';
end;
