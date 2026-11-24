<#
.SYNOPSIS
    Switch on TallyPrime's XML (HTTP) server by editing tally.ini (issue #33).

.DESCRIPTION
    Two ways in:
      - dot-sourced by tally-mcp-tray.ps1, which then calls Get-TallyIniXmlSettings /
        Set-TallyIniXmlServer in-process (the common case: tally.ini is writable by the user);
      - run on its own with -TallyIniEditPath, ELEVATED, by the tray when tally.ini sits in a
        folder the user cannot write (Program Files). Exit code 0 = done (or nothing to change),
        1 = failed. The tray re-reads the file afterwards to confirm, so no other output is needed.

    The parameter names are deliberately long and unusual: dot-sourcing a script that has a
    param() block creates those variables in the caller's scope, and they must not collide with
    anything in the tray.

    Only ever edits the file while Tally is CLOSED (the tray enforces that, and
    Set-TallyIniXmlServer checks again right before it reads and writes): Tally rewrites
    tally.ini itself on exit, so an edit made while it runs can be silently thrown away.

    ######################################################################################
    ##  VERIFY BEFORE RELEASE: the key names and values below come from TallyPrime's     ##
    ##  F1 > Settings > Connectivity > Client/Server Configuration screen as it is saved  ##
    ##  to tally.ini ("TallyPrime acts as" -> "Client Server", "Port" -> "Port"). They    ##
    ##  have NOT been checked against every supported TallyPrime release. Before this     ##
    ##  ships, save that screen on each supported version and diff tally.ini to confirm  ##
    ##  the exact key spelling, the accepted values (None / Client / Server / Both) and   ##
    ##  that the keys live under [Tally]. If a version differs, fix $TallyIniKeyPattern*  ##
    ##  below - nothing else in the tray hard-codes them.                                 ##
    ######################################################################################

    What is changed, and nothing else:
      Client Server : None (or missing) -> Server ; Client -> Both ; Server / Both left as they are.
                      This adds the server role without taking away a client role someone set up.
                      'Server' matches what the README and the tray's own help text tell users
                      to pick by hand ("TallyPrime acts as = Server").
      Port          : set to the requested port (TALLY_PORT, default 9000) if missing or different.
      ODBC Server   : left alone (separate setting).
    Every other line, the line endings and the file's encoding (ANSI / UTF-8 with or without BOM /
    UTF-16) are preserved. A key that exists is replaced in place (its own spelling and spacing
    kept); a missing key is added at the end of the [Tally] section. A backup copy
    tally.ini.bak-<yyyyMMdd-HHmmss> is written first; no backup, no edit.

    UAC virtualisation note: a 32-bit Tally without a manifest would read a per-user copy under
    %LOCALAPPDATA%\VirtualStore instead. TallyPrime is 64-bit, so that does not arise and is not
    handled here.

.NOTES
    Windows PowerShell 5.1 compatible; ASCII only.
#>
param(
    [string]$TallyIniEditPath,
    [int]$TallyIniEditPort = 9000,
    [string]$TallyIniEditBackupStamp
)

# Patterns for the two keys, matched against a whole line. Group 1 = everything up to and including
# '=' (kept verbatim so the file's own spelling and spacing survive), group 2 = the value.
# (?i): case-insensitive everywhere. PowerShell's -match already ignores case but [regex]::Match does
# not, and the scan and the rewrite must agree, or a 'client server=' line would be found by one and
# then lose its key name in the other.
$TallyIniKeyPatternClientServer = '(?i)^(\s*Client\s*Server\s*=\s*)(.*?)\s*$'
$TallyIniKeyPatternPort         = '(?i)^(\s*Port\s*=\s*)(.*?)\s*$'

# Reads tally.ini as text, remembering how to write it back byte-for-byte compatible.
function Read-TallyIniText {
    param([string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $skip = 0
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $enc = New-Object System.Text.UTF8Encoding($true); $skip = 3
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
        $enc = New-Object System.Text.UnicodeEncoding($false, $true); $skip = 2
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
        $enc = New-Object System.Text.UnicodeEncoding($true, $true); $skip = 2
    } else {
        # No BOM: Tally writes this file in the ANSI code page. Decoding and re-encoding with the same
        # code page gives back the same bytes for every line we do not touch.
        $enc = [System.Text.Encoding]::Default
    }
    $text = $enc.GetString($bytes, $skip, $bytes.Length - $skip)
    $eol = "`n"
    if ($text.Contains("`r`n")) { $eol = "`r`n" }
    return @{ Text = $text; Encoding = $enc; Eol = $eol; HasBom = ($skip -gt 0) }
}

# True when an error (or anything it wraps) is Windows refusing access. PowerShell wraps exceptions
# from .NET method calls in MethodInvocationException, so walk the chain instead of relying on a
# typed catch.
function Test-TallyIniAccessDenied {
    param($ErrorRecord)
    $e = $null
    try { $e = $ErrorRecord.Exception } catch { }
    while ($e) {
        if ($e -is [System.UnauthorizedAccessException] -or $e -is [System.Security.SecurityException]) { return $true }
        $e = $e.InnerException
    }
    return $false
}

# Current XML-server settings, without changing anything.
# Returns @{ Ok; HasTallySection; ClientServer; Port; ServerOn; Error }.
#   ServerOn = $true when 'Client Server' is Server or Both.
function Get-TallyIniXmlSettings {
    param([string]$Path)
    $r = @{ Ok = $false; HasTallySection = $false; ClientServer = ''; Port = ''; ServerOn = $false; Error = '' }
    try {
        if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { $r.Error = "tally.ini not found at $Path"; return $r }
        $ini = Read-TallyIniText -Path $Path
        $section = ''
        foreach ($line in ($ini.Text -split "`r?`n")) {
            $t = $line.Trim()
            if ($t -match '^\[(.+)\]$') { $section = $Matches[1].Trim(); if ($section -ieq 'Tally') { $r.HasTallySection = $true }; continue }
            if ($section -ine 'Tally') { continue }
            if ($t.StartsWith(';')) { continue }
            if ($line -match $TallyIniKeyPatternClientServer) { $r.ClientServer = $Matches[2].Trim() }
            elseif ($line -match $TallyIniKeyPatternPort) { $r.Port = $Matches[2].Trim() }
        }
        $r.ServerOn = ($r.ClientServer -ieq 'Server' -or $r.ClientServer -ieq 'Both')
        $r.Ok = $true
    } catch {
        $r.Error = $_.Exception.Message
    }
    return $r
}

# Switch the XML server on. Returns @{ Ok; Changed; Backup; Summary; AccessDenied; Error }.
function Set-TallyIniXmlServer {
    param([string]$Path, [int]$Port = 9000, [string]$BackupStamp)
    $r = @{ Ok = $false; Changed = $false; Backup = ''; Summary = ''; AccessDenied = $false; Error = '' }
    try {
        if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { $r.Error = "tally.ini not found at $Path"; return $r }
        if ($Port -lt 1 -or $Port -gt 65535) { $r.Error = "Port $Port is not a valid port number"; return $r }
        # Tally rewrites tally.ini when it exits, so an edit made while it runs can be thrown away.
        # Checked here too (not only in the tray) so the elevated helper is covered.
        $running = 0
        try { $running = @(Get-Process -Name 'tally' -ErrorAction SilentlyContinue).Count } catch { $running = 0 }
        if ($running -gt 0) {
            $r.Error = "Tally is running, so tally.ini was not changed. Close Tally and try again."
            return $r
        }
        $ini = Read-TallyIniText -Path $Path
        $lines = New-Object System.Collections.ArrayList
        foreach ($l in ($ini.Text -split "`r?`n")) { [void]$lines.Add($l) }

        $section = ''
        $tallyHeader = -1
        $lastContent = -1
        $csIdx = @()
        $portIdx = @()
        $csValue = ''
        $portValue = ''
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $line = [string]$lines[$i]
            $t = $line.Trim()
            if ($t -match '^\[(.+)\]$') {
                $section = $Matches[1].Trim()
                if ($section -ieq 'Tally' -and $tallyHeader -lt 0) { $tallyHeader = $i; $lastContent = $i }
                continue
            }
            if ($section -ine 'Tally') { continue }
            if ($t) { $lastContent = $i }
            if ($t.StartsWith(';')) { continue }
            if ($line -match $TallyIniKeyPatternClientServer) { $csIdx += $i; $csValue = $Matches[2].Trim() }
            elseif ($line -match $TallyIniKeyPatternPort) { $portIdx += $i; $portValue = $Matches[2].Trim() }
        }
        if ($tallyHeader -lt 0) {
            # Not a file we recognise. Refuse rather than guess where Tally looks for these keys.
            $r.Error = "tally.ini has no [Tally] section, so Claudally did not change it ($Path)"
            return $r
        }

        $newCs = $csValue
        if ($csValue -ieq 'Server' -or $csValue -ieq 'Both') { $newCs = $csValue }
        elseif ($csValue -ieq 'Client') { $newCs = 'Both' }
        else { $newCs = 'Server' }
        $portText = [string]$Port

        $changes = @()
        if ($newCs -ne $csValue -or $csIdx.Count -eq 0) {
            $from = $csValue; if (-not $from) { $from = '(not set)' }
            $changes += "Client Server: $from -> $newCs"
        }
        if ($portValue -ne $portText -or $portIdx.Count -eq 0) {
            $from = $portValue; if (-not $from) { $from = '(not set)' }
            $changes += "Port: $from -> $portText"
        }
        if ($changes.Count -eq 0) {
            $r.Ok = $true
            $r.Summary = "Already switched on (Client Server = $csValue, Port = $portValue). Nothing changed."
            return $r
        }

        # Replace in place. Every occurrence, so a duplicated key cannot leave the old value winning.
        # Safety net: if a line found by the scan does not give back its 'Key =' prefix here, refuse
        # (before the backup and the write) rather than overwrite the line with a bare value.
        foreach ($i in $csIdx) {
            $m = [regex]::Match([string]$lines[$i], $TallyIniKeyPatternClientServer)
            if (-not $m.Success -or -not $m.Groups[1].Value) {
                $r.Error = "Could not safely rewrite line $($i + 1) of tally.ini ('$([string]$lines[$i])'), so Claudally did not change it ($Path)"
                return $r
            }
            $lines[$i] = $m.Groups[1].Value + $newCs
        }
        foreach ($i in $portIdx) {
            $m = [regex]::Match([string]$lines[$i], $TallyIniKeyPatternPort)
            if (-not $m.Success -or -not $m.Groups[1].Value) {
                $r.Error = "Could not safely rewrite line $($i + 1) of tally.ini ('$([string]$lines[$i])'), so Claudally did not change it ($Path)"
                return $r
            }
            $lines[$i] = $m.Groups[1].Value + $portText
        }
        # Add what is missing at the end of the [Tally] section (after its last non-blank line), in
        # Tally's own "Key=Value" style.
        $insertAt = $lastContent + 1
        $toInsert = @()
        if ($csIdx.Count -eq 0) { $toInsert += "Client Server=$newCs" }
        if ($portIdx.Count -eq 0) { $toInsert += "Port=$portText" }
        foreach ($newLine in $toInsert) {
            $lines.Insert($insertAt, $newLine)
            $insertAt++
        }

        # Backup first. No backup, no edit.
        if (-not $BackupStamp) { $BackupStamp = (Get-Date).ToString('yyyyMMdd-HHmmss') }
        $backup = "$Path.bak-$BackupStamp"
        try {
            [System.IO.File]::Copy($Path, $backup, $true)
        } catch {
            $r.AccessDenied = (Test-TallyIniAccessDenied $_)
            $r.Error = "Could not save a backup copy next to tally.ini ($backup): $($_.Exception.Message)"
            return $r
        }
        $r.Backup = $backup

        $newText = [string]::Join($ini.Eol, [string[]]$lines.ToArray())
        $body = $ini.Encoding.GetBytes($newText)
        $pre = [byte[]]@()
        if ($ini.HasBom) { $pre = $ini.Encoding.GetPreamble() }
        $ms = New-Object System.IO.MemoryStream
        try {
            if ($pre.Length -gt 0) { $ms.Write($pre, 0, $pre.Length) }
            $ms.Write($body, 0, $body.Length)
            $all = $ms.ToArray()
        } finally { $ms.Dispose() }
        try {
            # In place rather than temp + rename: the Tally folder may let us change this file but not
            # create new ones, and an in-place write keeps the file's own permissions.
            [System.IO.File]::WriteAllBytes($Path, $all)
        } catch {
            $r.AccessDenied = (Test-TallyIniAccessDenied $_)
            $r.Error = "Could not change ${Path}: $($_.Exception.Message)"
            return $r
        }
        $r.Ok = $true
        $r.Changed = $true
        $r.Summary = ($changes -join '; ')
    } catch {
        $r.Error = $_.Exception.Message
    }
    return $r
}

# Standalone (elevated) mode. When dot-sourced the invocation name is '.', and nothing below runs.
if ($MyInvocation.InvocationName -ne '.' -and $TallyIniEditPath) {
    $res = Set-TallyIniXmlServer -Path $TallyIniEditPath -Port $TallyIniEditPort -BackupStamp $TallyIniEditBackupStamp
    if ($res.Ok) { exit 0 }
    exit 1
}
