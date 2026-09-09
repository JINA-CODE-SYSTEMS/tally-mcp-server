<#
.SYNOPSIS
    Checks every .ps1 in scripts/ for the two ways this repo has actually shipped broken
    PowerShell to customers.

.DESCRIPTION
    Customers run Windows PowerShell 5.1. It is what powers on with the OS, what the NSSM
    service and the scheduled tasks invoke, and what the Inno Setup installer shells out to.
    CI, however, had only ever parsed these scripts with pwsh 7, which is a different parser
    reading files with a different default encoding. Two failure classes slipped through:

      1. ENCODING. Windows PowerShell 5.1 reads a file with no UTF-8 BOM as ANSI (the legacy
         code page), not UTF-8. A single non-ASCII character - an em dash in a comment or a
         double-quoted string - is a multi-byte UTF-8 sequence that 5.1 renders as mojibake.
         That has already made scripts/deploy.ps1 unparseable on main while pwsh 7 read it
         perfectly. pwsh 7 defaults to UTF-8 and cannot see this bug at all.

      2. SYNTAX. 5.1 rejects constructs pwsh 7 accepts: ?? and ??=, the ternary ? :, && and ||
         between commands, and the ?. null-conditional operators.

    The remedy for an encoding failure is to keep the file ASCII-only (preferred - it is
    unambiguous under every code page) or to save it UTF-8 *with* a BOM.

.PARAMETER Path
    Directory to scan. Defaults to the scripts/ directory this file lives in.

.PARAMETER ParseOnly
    Skip the encoding check and only parse. Use this for the pwsh 7 pass, where the encoding
    question is meaningless - 7 reads UTF-8 regardless of BOM.

.EXAMPLE
    powershell.exe -NoProfile -File scripts\check-powershell-compat.ps1
    Runs the full check the way CI does, under Windows PowerShell 5.1.
#>
[CmdletBinding()]
param(
    [string]$Path,
    [switch]$ParseOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if (-not $Path) { $Path = $PSScriptRoot }
if (-not (Test-Path -LiteralPath $Path)) { throw "Path not found: $Path" }

$edition = $PSVersionTable.PSVersion.ToString()
Write-Host "Checking $Path with PowerShell $edition"

$files = @(Get-ChildItem -LiteralPath $Path -Recurse -Filter *.ps1 -File | Sort-Object FullName)
if ($files.Count -eq 0) { throw "No .ps1 files found under $Path - wrong path?" }

$encodingFailures = @()
$parseFailures    = @()

foreach ($file in $files) {
    $rel = $file.FullName

    # --- 1. Encoding -----------------------------------------------------------------
    # Read as bytes, not as text: reading as text is exactly the step that hides the bug.
    if (-not $ParseOnly) {
        $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
        $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
        if (-not $hasBom) {
            $offset = -1
            for ($i = 0; $i -lt $bytes.Length; $i++) {
                if ($bytes[$i] -gt 0x7F) { $offset = $i; break }
            }
            if ($offset -ge 0) {
                # Report a line number, not a byte offset - the author needs to find it.
                $prefix = [System.Text.Encoding]::ASCII.GetString($bytes, 0, $offset)
                $line   = ($prefix -split "`n").Count
                $encodingFailures += $rel
                Write-Host "::error file=$rel,line=$line::Non-ASCII byte 0x$('{0:X2}' -f $bytes[$offset]) in a file with no UTF-8 BOM. Windows PowerShell 5.1 will read this as ANSI and mangle it. Replace the character with ASCII, or save the file as UTF-8 with BOM."
            }
        }
    }

    # --- 2. Parse --------------------------------------------------------------------
    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) {
        $parseFailures += $rel
        foreach ($e in $errors) {
            $ln = $e.Extent.StartLineNumber
            Write-Host "::error file=$rel,line=$ln::$($e.Message)"
        }
    }
}

Write-Host ''
Write-Host "Scanned $($files.Count) PowerShell script(s)."

$failed = $false
if ($encodingFailures.Count -gt 0) {
    Write-Host "Encoding failures ($($encodingFailures.Count)):"
    $encodingFailures | ForEach-Object { Write-Host "  $_" }
    $failed = $true
}
if ($parseFailures.Count -gt 0) {
    Write-Host "Parse failures ($($parseFailures.Count)):"
    $parseFailures | ForEach-Object { Write-Host "  $_" }
    $failed = $true
}

if ($failed) { throw 'PowerShell compatibility check failed - see the errors above.' }

if ($ParseOnly) {
    Write-Host "All scripts parse cleanly under PowerShell $edition."
} else {
    Write-Host "All scripts are ASCII-safe and parse cleanly under PowerShell $edition."
}
