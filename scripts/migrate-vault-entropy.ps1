<#
.SYNOPSIS
    Re-encrypt pre-#50 null-entropy company-vault blobs with the entropy the helper expects.

.DESCRIPTION
    Issue #50 introduced a DPAPI entropy value but only applied it to passwords set AFTER that
    change. dpapi-helper.ps1's comment claims legacy blobs "get re-encrypted with entropy on the
    next save"; they are not — manage-companies-dialog.ps1 preserves passwordEnc verbatim unless
    the operator ticks "Change password". So installs predating #50 still hold blobs any local
    process can Unprotect with null entropy.

    WHAT THIS BUYS, HONESTLY: entropy is a second Unprotect input, not a key, and the literal is
    public (this repo) and world-readable in Program Files. It stops a blind credential sweeper
    that tries null entropy across every DPAPI blob it finds. It does NOT stop anyone who reads
    the repo or the installed script. The scope is still LocalMachine, so any local principal can
    still decrypt. The real fix is CurrentUser scope, which needs the multi-identity work.

    Never prints plaintext. Verifies a full round-trip before replacing anything, and backs up.
#>
[CmdletBinding()]
param(
    [string]$RegistryPath = "$env:PUBLIC\TallyPrimeEditLog\data\.tally-mcp-companies.json",
    [switch]$WhatIfOnly
)

Add-Type -AssemblyName System.Security
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $RegistryPath)) { Write-Host "[skip] no vault at $RegistryPath"; exit 0 }

$entropy = [System.Text.Encoding]::UTF8.GetBytes('TallyMCP.CompanyRegistry.DPAPI.v1')
$scope   = [System.Security.Cryptography.DataProtectionScope]::LocalMachine
$raw     = Get-Content -LiteralPath $RegistryPath -Raw
$reg     = $raw | ConvertFrom-Json

$migrated = 0; $already = 0; $failed = 0
foreach ($c in $reg.companies) {
    if (-not $c.passwordEnc) { continue }
    $blob = [Convert]::FromBase64String($c.passwordEnc)

    try { [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, $scope) | Out-Null; $already++; continue } catch { }

    $plain = $null
    try { $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, $scope) }
    catch { Write-Host ("[warn] '{0}': decrypts with neither entropy nor null - left untouched" -f $c.alias); $failed++; continue }

    $reblob = [System.Security.Cryptography.ProtectedData]::Protect($plain, $entropy, $scope)

    # Round-trip before accepting: decrypt the new blob and compare bytes to the original plaintext.
    $check = [System.Security.Cryptography.ProtectedData]::Unprotect($reblob, $entropy, $scope)
    $same = ($check.Length -eq $plain.Length)
    if ($same) { for ($i = 0; $i -lt $plain.Length; $i++) { if ($check[$i] -ne $plain[$i]) { $same = $false; break } } }
    [Array]::Clear($plain, 0, $plain.Length); [Array]::Clear($check, 0, $check.Length)
    if (-not $same) { Write-Host ("[fail] '{0}': round-trip mismatch - left untouched" -f $c.alias); $failed++; continue }

    $c.passwordEnc = [Convert]::ToBase64String($reblob)
    $migrated++
    Write-Host ("[ok]   '{0}': re-encrypted with entropy" -f $c.alias)
}

Write-Host ("summary: {0} migrated, {1} already protected, {2} failed" -f $migrated, $already, $failed)
if ($WhatIfOnly) { Write-Host '[what-if] no file written'; exit 0 }
if ($migrated -eq 0) { Write-Host 'nothing to write'; exit 0 }

# Capture the vault's ACL BEFORE replacing it. firstrun-config.ps1 hardens this file with
# `icacls /inheritance:r /grant:r SYSTEM:F Administrators:F <agent user>:F`, and a tmp-plus-rename
# silently discards that: the replacement is a NEW file, so it inherits from the parent directory
# instead of carrying the file's own explicit, inheritance-blocked ACL.
#
# On a correctly installed box the effective principals end up the same, because the parent is
# itself inheritance-blocked and grants the same three. But this ACL is the ENTIRE boundary for
# these passwords (DPAPI LocalMachine scope means any local principal who can READ the file can
# decrypt it), so dropping the file's own protection and depending on the parent is a real loss of
# defence in depth - and it makes the vault silently follow any later change to the parent.
# Learned by shipping it: the first run of this script did exactly that, and verify-deployment.ps1
# caught it.
$origAcl = Get-Acl -LiteralPath $RegistryPath

$backup = "$RegistryPath.pre-entropy-backup"
Copy-Item -LiteralPath $RegistryPath -Destination $backup -Force
# The backup holds the OLD null-entropy blobs - the exact weakness being removed - so it must not be
# left more readable than the vault it came from.
Set-Acl -LiteralPath $backup -AclObject $origAcl

$tmp = "$RegistryPath.tmp"
($reg | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $tmp -Encoding UTF8
Set-Acl -LiteralPath $tmp -AclObject $origAcl
Move-Item -LiteralPath $tmp -Destination $RegistryPath -Force

$newAcl = Get-Acl -LiteralPath $RegistryPath
if (-not $newAcl.AreAccessRulesProtected -and $origAcl.AreAccessRulesProtected) {
    Write-Host '[warn] the replaced vault is no longer inheritance-blocked; re-applying'
    Set-Acl -LiteralPath $RegistryPath -AclObject $origAcl
}

Write-Host ("written. backup at {0}" -f $backup)
Write-Host ("vault ACL: inheritance-blocked={0}" -f (Get-Acl -LiteralPath $RegistryPath).AreAccessRulesProtected)
Write-Host 'Delete the backup once you have confirmed a company still loads - it holds the old blobs.'
