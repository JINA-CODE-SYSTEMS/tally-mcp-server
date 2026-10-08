<#
.SYNOPSIS
    NTFS lockdown helpers shared by firstrun-config.ps1 and setup-windows.ps1 (#193, #230).

.DESCRIPTION
    Dot-sourced, never run on its own. Defines functions only (and two SID constants); it changes
    nothing when loaded.

    Every lockdown here names its principals by SID, never by name. 'Administrators' is localised
    (Administratoren, Administrateurs, ...), and on a Windows whose language is not English
    `icacls ... 'Administrators:F'` fails with "No mapping between account names and security IDs"
    and changes NOTHING - which is how .env and the company vault kept their inherited ACL, readable
    by BUILTIN\Users, behind a yellow warning (#230). Every lockdown is also PROVEN with Get-Acl
    afterwards rather than trusted on an exit code.

    It also owns the one place our files shared with the agent user live: the Claudally agent
    folder, %ProgramData%\Claudally\agent (see _EnsureAgentDir). Tally's own data folder is not
    ours, and nothing here writes to it or changes its permissions - except _RestoreTallyDataFolder,
    which undoes what earlier versions of the installer did to it.

.NOTES
    Windows PowerShell 5.1 compatible; ASCII only.
#>

$Script:SidSystem = 'S-1-5-18'
$Script:SidAdmins = 'S-1-5-32-544'

# Zero the bytes, then unlink: a best-effort shred, so a removed secret is not trivially recoverable
# from free space. Returns $true when the file is gone afterwards.
function _ShredFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    try {
        $len = (Get-Item -LiteralPath $Path -Force).Length
        if ($len -gt 0) { [System.IO.File]::WriteAllBytes($Path, (New-Object byte[] $len)) }
    } catch {
        # Best effort: a file that cannot be zeroed is still unlinked below, and the return value
        # reports whether it is gone. Nothing to add here, so record that it was considered.
        $null = $_
    }
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return (-not (Test-Path -LiteralPath $Path))
}

# The SID of a Windows account, or a throw that says which account could not be resolved.
function _AccountSid([string]$Account) {
    try {
        return ([System.Security.Principal.NTAccount]$Account).Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        $e = $_.Exception
        if ($e.InnerException) { $e = $e.InnerException }
        throw "the Windows account '$Account' does not resolve to a security identifier on this machine, so nothing can be granted to it ($($e.Message))"
    }
}

# A SID as "NAME (SID)" when it translates, else the SID alone. For messages only.
function _SidDisplay([string]$Sid) {
    try { return "$(([System.Security.Principal.SecurityIdentifier]$Sid).Translate([System.Security.Principal.NTAccount]).Value) ($Sid)" } catch { return $Sid }
}

# Runs icacls and returns its exit code, plus its output when it failed. With ErrorActionPreference
# 'Continue' (local to this function): under 'Stop', Windows PowerShell 5.1 turns a native command's
# stderr into a terminating error, so a failure would surface as a bare "No mapping between account
# names..." record rather than a message saying which path and why.
function _Icacls {
    $ErrorActionPreference = 'Continue'
    $out = @(& icacls @args 2>&1)
    $code = $LASTEXITCODE
    $text = ''
    if ($code -ne 0) { $text = (($out | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) -join ' ') }
    return [pscustomobject]@{ Code = $code; Text = $text }
}

# Restricts $Path to exactly SYSTEM, Administrators and $ExtraSids, then PROVES it with Get-Acl, or
# throws. Never trusts an exit code alone: the whole of #230 was a lockdown whose failure was only
# ever a return value. -Container adds (OI)(CI) so files created inside later inherit the same list;
# -OwnerAdministrators also makes Administrators the owner (an owner can always rewrite the DACL).
#
# /grant:r only replaces entries for the principals it names, so an explicit entry for anyone else
# would survive it and leave the "locked" path readable or writable by that account. Such entries
# are removed, by SID. Returns the display names of what was removed, for the caller to report.
function _LockDown {
    param([string]$Path, [string[]]$ExtraSids = @(), [switch]$Container, [switch]$OwnerAdministrators)
    $sids = @(@($Script:SidSystem, $Script:SidAdmins) + @($ExtraSids | Where-Object { $_ }) | Select-Object -Unique)
    $flags = ''
    if ($Container) { $flags = '(OI)(CI)' }
    $grants = @($sids | ForEach-Object { "*${_}:${flags}F" })
    $r = _Icacls $Path /inheritance:r /grant:r @grants
    if ($r.Code -ne 0) { throw "icacls exit $($r.Code) while setting the ACL on ${Path}: $($r.Text)" }
    if ($OwnerAdministrators) {
        $r = _Icacls $Path /setowner "*$Script:SidAdmins"
        if ($r.Code -ne 0) { throw "icacls exit $($r.Code) while setting the owner of ${Path}: $($r.Text)" }
    }

    $sidType = [System.Security.Principal.SecurityIdentifier]
    $removed = @()
    $foreign = @((Get-Acl -LiteralPath $Path).GetAccessRules($true, $true, $sidType) |
                 Where-Object { -not $_.IsInherited -and $sids -notcontains $_.IdentityReference.Value } |
                 ForEach-Object { $_.IdentityReference.Value } | Select-Object -Unique)
    foreach ($f in $foreign) {
        $r = _Icacls $Path /remove "*$f"
        if ($r.Code -ne 0) { throw "icacls exit $($r.Code) while removing the entry for $f from ${Path}: $($r.Text)" }
        $removed += (_SidDisplay $f)
    }

    # Prove it. Deny entries are ignored: they can only narrow access.
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) { throw "inheritance is still enabled on $Path" }
    $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
    $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $allows = @($acl.GetAccessRules($true, $true, $sidType) |
                Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow })
    foreach ($rule in $allows) {
        if ($sids -notcontains $rule.IdentityReference.Value) { throw "$Path still grants access to $($rule.IdentityReference.Value)" }
    }
    foreach ($sid in $sids) {
        $ok = @($allows | Where-Object {
            $_.IdentityReference.Value -eq $sid -and
            (($_.FileSystemRights -band $fullControl) -eq $fullControl) -and
            ((-not $Container) -or (($_.InheritanceFlags -band $inherit) -eq $inherit))
        })
        if ($ok.Count -eq 0) { throw "the grant to $sid did not take effect on $Path" }
    }
    if ($OwnerAdministrators) {
        $ownerSid = $acl.GetOwner($sidType).Value
        if (@($Script:SidSystem, $Script:SidAdmins) -notcontains $ownerSid) { throw "the owner of $Path is $ownerSid, not Administrators" }
    }
    return , $removed
}

# Creates $Path EMPTY and locks it down before anything is written to it, or throws having written
# nothing (and leaves no file behind). Until the lockdown it carries its folder's inherited ACL, so
# it must hold nothing worth reading during that window. Starts from a fresh file: an old one could
# carry entries of its own. Overwriting it afterwards keeps the DACL.
function _NewLockedFile {
    param([string]$Path, [string[]]$ExtraSids = @(), [switch]$OwnerAdministrators)
    if (-not (_ShredFile $Path)) { throw "could not remove the existing $Path" }
    [System.IO.File]::WriteAllBytes($Path, (New-Object byte[] 0))
    try {
        $null = _LockDown -Path $Path -ExtraSids $ExtraSids -OwnerAdministrators:$OwnerAdministrators
    } catch {
        $null = _ShredFile $Path
        throw
    }
}

# Moves a secret file (the company vault) without ever leaving a readable copy. The destination is
# created empty and locked, and the lock verified, BEFORE a byte goes into it; the bytes are then
# written and read back; only when they match is the source shredded. If anything fails before the
# shred, the destination is shredded again and the source is left exactly as it was. The file is
# copied byte for byte, so DPAPI blobs inside it are untouched (the vault's DPAPI entropy is a fixed
# string, not the path - see dpapi-helper.ps1 - so they decrypt the same from the new place).
function _MoveSecretFileLocked {
    param([string]$Source, [string]$Destination, [string[]]$ExtraSids = @())
    $bytes = [System.IO.File]::ReadAllBytes($Source)
    _NewLockedFile -Path $Destination -ExtraSids $ExtraSids
    try {
        [System.IO.File]::WriteAllBytes($Destination, $bytes)
        $back = [System.IO.File]::ReadAllBytes($Destination)
        if (-not [System.Linq.Enumerable]::SequenceEqual([byte[]]$bytes, [byte[]]$back)) {
            throw "the copy written to $Destination does not match $Source"
        }
    } catch {
        $null = _ShredFile $Destination
        throw
    }
    if (-not (_ShredFile $Source)) {
        throw "$Source was copied to $Destination (locked and verified) but could not be removed afterwards; shred it by hand"
    }
}

# Dry run of a file lockdown in $Dir, on a scratch file holding no secret, through the same function
# the real step uses; shredded again whatever happens. For the -Upgrade preflight. Returns '' on
# success or why it failed.
function _ProbeLockDown([string]$Dir, [string]$AgentSid) {
    $probe = Join-Path $Dir '.tally-mcp-acl.preflight'
    $why = ''
    try {
        _NewLockedFile -Path $probe -ExtraSids @($AgentSid)
    } catch {
        $why = $_.Exception.Message
    }
    if (-not (_ShredFile $probe)) { $why = ("$why could not remove the probe file $probe afterwards.").Trim() }
    return $why
}

# --- The Claudally agent folder -------------------------------------------------------------------
# %ProgramData%\Claudally\agent holds the files the SYSTEM service and the agent user's session
# share: the GUI agent's IPC files (_mcp_gui_command.json, _mcp_gui_result.json, _mcp_screenshot.png)
# and the company password vault (.tally-mcp-companies.json).
#
# Why here, and not in Tally's data folder where they used to live: that folder is Tally's, and on a
# PC several Windows accounts share it is how each of them reaches the books. Locking it to
# SYSTEM + Administrators + one agent user - which every version up to #230 did - locked the other
# accounts out of Tally. A folder we own can be locked as tightly as the files need without touching
# anyone's access to their accounts.
#
# Why %ProgramData%: it is per-machine (the service runs as SYSTEM, the agent as a person - both
# resolve %ProgramData% to the same C:\ProgramData, unlike %APPDATA%), it is not under Program Files
# (which an upgrade replaces), and it is where the updater's state already goes (%ProgramData%\
# Claudally\update, docs/dev/update-manifest.md). Its catch: BUILTIN\Users may CREATE folders in
# C:\ProgramData and then own what they create. So a user could plant Claudally or Claudally\agent
# before we get there - as a junction pointing somewhere we would then re-permission, or as a folder
# they own and could reopen later. _EnsureAgentDir handles that; see there.
function _ClaudallyDir { return (Join-Path $env:ProgramData 'Claudally') }
function _AgentDir { return (Join-Path (_ClaudallyDir) 'agent') }

# Why a folder that already exists cannot be trusted as ours, or '' if it can (or does not exist).
# Trusted: a real folder (not a junction or symbolic link), owned by SYSTEM, Administrators or the
# agent user. Those are the only accounts that can have made it legitimately: an elevated install
# (owner Administrators), a SYSTEM update, or the agent user's own tray on a from-source dev box -
# and the agent user is already granted full control of the folder by design, so trusting what they
# made gives them nothing new. A non-admin cannot set any owner but themselves, so a folder planted
# by anyone else fails the owner test however they set its permissions.
function _UntrustedFolderReason {
    param([string]$Path, [string[]]$TrustedOwnerSids)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        return "$Path is a junction or symbolic link, not a folder. Something other than this installer created it; locking it down would re-permission whatever it points at"
    }
    if (-not $item.PSIsContainer) { return "$Path exists but is a file, not a folder" }
    $owner = (Get-Acl -LiteralPath $Path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($TrustedOwnerSids -notcontains $owner) {
        return "$Path already exists and is owned by $(_SidDisplay $owner), not by SYSTEM, Administrators or the agent user. It may have been created to read or tamper with the company vault and the GUI agent's commands"
    }
    return ''
}

# Creates (or takes back) %ProgramData%\Claudally and its agent folder, locked by SID and verified,
# BEFORE anything is written inside. Throws on a folder it cannot trust. Returns the display names of
# any extra permission entries it removed.
#
#   Claudally        SYSTEM + Administrators, (OI)(CI), owner Administrators. This is what shuts the
#                    planting door: once it is ours, BUILTIN\Users can no longer create anything in
#                    it. (The agent user reaches the agent folder below without rights on this one:
#                    "Bypass traverse checking" is granted to Everyone.)
#   Claudally\agent  SYSTEM + Administrators + the agent user, (OI)(CI) so the IPC files the service
#                    creates inherit the agent-user grant, owner Administrators.
#
# A folder that already exists is TAKEN BACK - owner reset to Administrators, the ACL replaced and any
# other account's entry removed - when it is trusted (see _UntrustedFolderReason); that is simply a
# re-run over our own folder, or a dev box where the agent user's tray made it first. Anything else is
# REFUSED rather than taken over, and the run stops: a junction would make the lockdown re-permission
# its target (granting the agent user full control over wherever it points), and a folder planted by
# another account may already hold files of theirs - a prepared command file the agent would run, or
# a vault of their choosing - that no ACL reset afterwards can make trustworthy. Deleting it for them
# would destroy evidence and could delete through a link. So a human looks at it; the message says
# what to remove.
function _EnsureAgentDir {
    param([string]$AgentSid)
    $parent = _ClaudallyDir
    $dir = _AgentDir
    $trusted = @($Script:SidSystem, $Script:SidAdmins, $AgentSid)
    foreach ($p in @($parent, $dir)) {
        $why = _UntrustedFolderReason -Path $p -TrustedOwnerSids $trusted
        if ($why) { throw "$why. Nothing was written into it. Check what it is, delete it (Remove-Item -LiteralPath '$p' -Recurse, from an elevated prompt), and run the installer or Reconfigure again." }
    }
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    $fromParent = _LockDown -Path $parent -Container -OwnerAdministrators
    # Again, now that nobody else can create anything in the parent: the agent folder may have
    # appeared between the first look and the parent's lockdown.
    $why = _UntrustedFolderReason -Path $dir -TrustedOwnerSids $trusted
    if ($why) { throw "$why. Nothing was written into it. Check what it is, delete it, and run the installer or Reconfigure again." }
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $fromDir = _LockDown -Path $dir -ExtraSids @($AgentSid) -Container -OwnerAdministrators
    $removed = @(@($fromParent) + @($fromDir) | Where-Object { $_ })
    if ((Get-Item -LiteralPath $dir -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "$dir turned into a junction or symbolic link while it was being set up; refusing to use it"
    }
    return , $removed
}

# --- Tally's data folder: undo what earlier installers did to it ----------------------------------
# Every version up to #230 ran, on TALLY_DATA_PATH,
#   icacls <data> /inheritance:r /grant:r SYSTEM:(OI)(CI)F Administrators:(OI)(CI)F <agent user>:(OI)(CI)F
# which stripped every inherited entry from Tally's own data folder - and, by propagation, from each
# company folder under it - so on a PC shared by several Windows accounts the others lost access to
# the books. This re-enables inheritance and removes what that command added, and nothing else:
#
#   - Only when inheritance is OFF and the folder carries that command's fingerprint: exactly one
#     explicit Full Control (OI)(CI) allow entry each for SYSTEM and for Administrators. A folder
#     protected in any other shape was set up by someone else, on purpose; it is reported, not changed.
#     A folder whose inheritance is on is left alone: that is the state we are restoring to.
#   - Inheritance is re-enabled first, so nobody's access dips while the rest happens.
#   - The explicit SYSTEM and Administrators entries are then removed only if inheritance now gives
#     that same account Full Control anyway - so removing them changes nobody's effective access.
#   - The agent user's explicit entry is KEPT. /grant:r replaced whatever explicit entry that account
#     had before with ours, so there is no telling whether it needs one to reach its own books; keeping
#     Full Control for the accountant over their own Tally data cannot lock anyone out.
#   - Deny entries and every other account's entries are never touched.
#
# Never throws: it is repair, not setup. Returns one line per thing it did, found or could not do;
# lines starting "WARN:" are problems the caller should show as warnings.
function _RestoreTallyDataFolder {
    param([string]$Dir, [string]$AgentSid)
    $log = @()
    try {
        if (-not $Dir -or -not (Test-Path -LiteralPath $Dir -PathType Container)) {
            return @("Tally data folder '$Dir' does not exist; nothing to restore")
        }
        if ((Get-Item -LiteralPath $Dir -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            return @("WARN: Tally data folder $Dir is a junction or symbolic link; its permissions were left alone")
        }
        $sidType = [System.Security.Principal.SecurityIdentifier]
        $allow = [System.Security.AccessControl.AccessControlType]::Allow
        $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
        $oici = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        $acl = Get-Acl -LiteralPath $Dir
        if (-not $acl.AreAccessRulesProtected) {
            return @("Tally data folder $Dir already inherits its permissions; nothing to restore")
        }
        $explicit = @($acl.GetAccessRules($true, $false, $sidType) | Where-Object { $_.AccessControlType -eq $allow })
        $isOurs = {
            param([string]$Sid)
            $mine = @($explicit | Where-Object { $_.IdentityReference.Value -eq $Sid })
            return ($mine.Count -eq 1 -and
                    ($mine[0].FileSystemRights -band $fullControl) -eq $fullControl -and
                    $mine[0].InheritanceFlags -eq $oici)
        }
        if (-not ((& $isOurs $Script:SidSystem) -and (& $isOurs $Script:SidAdmins))) {
            return @("WARN: inheritance is disabled on Tally data folder $Dir, but not in the shape an earlier version of this installer left it, so it was left alone. If other Windows accounts on this PC cannot open Tally companies, re-enable it: icacls `"$Dir`" /inheritance:e")
        }
        $r = _Icacls $Dir /inheritance:e
        if ($r.Code -ne 0) {
            return @("WARN: could not re-enable inheritance on Tally data folder ${Dir} (icacls exit $($r.Code): $($r.Text)). Other Windows accounts may still be locked out of Tally; run icacls `"$Dir`" /inheritance:e from an elevated prompt")
        }
        $log += "Re-enabled permission inheritance on Tally data folder $Dir (an earlier version of this installer had disabled it)"
        $inherited = @((Get-Acl -LiteralPath $Dir).GetAccessRules($false, $true, $sidType) | Where-Object { $_.AccessControlType -eq $allow })
        foreach ($sid in @($Script:SidSystem, $Script:SidAdmins)) {
            $covered = @($inherited | Where-Object { $_.IdentityReference.Value -eq $sid -and ($_.FileSystemRights -band $fullControl) -eq $fullControl })
            if ($covered.Count -eq 0) {
                $log += "Kept the explicit Full Control entry for $(_SidDisplay $sid) on $Dir (inheritance does not grant it the same)"
                continue
            }
            $r = _Icacls $Dir /remove:g "*$sid"
            if ($r.Code -ne 0) { $log += "WARN: could not remove the explicit entry for $(_SidDisplay $sid) from ${Dir}: $($r.Text)"; continue }
            $log += "Removed the explicit Full Control entry for $(_SidDisplay $sid) that an earlier installer added to $Dir (inheritance grants the same)"
        }
        if ($AgentSid -and (& $isOurs $AgentSid)) {
            $log += "Kept the explicit Full Control entry for $(_SidDisplay $AgentSid) (the agent user) on $Dir"
        }
        if ((Get-Acl -LiteralPath $Dir).AreAccessRulesProtected) {
            $log += "WARN: inheritance still reads as disabled on $Dir after re-enabling it"
        }
    } catch {
        $log += "WARN: could not restore the permissions of Tally data folder ${Dir}: $($_.Exception.Message)"
    }
    return $log
}
