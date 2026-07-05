# DPAPI encrypt/decrypt helper for TallyMCP company-registry passwords.
#
# Reads plaintext (encrypt) or base64 blob (decrypt) from STDIN — never from command-line args,
# so secrets don't show up in process listings (Task Manager, Get-WmiObject Win32_Process, etc.).
#
# RUN (from Node):
#   echo "my-password" | powershell -NoProfile -ExecutionPolicy Bypass -File dpapi-helper.ps1 -Action encrypt
#   echo "<base64-blob>" | powershell -NoProfile -ExecutionPolicy Bypass -File dpapi-helper.ps1 -Action decrypt
#
# Uses DataProtectionScope.LocalMachine so the MCP service (LocalSystem) and the tray (logged-in
# user) share the same key. NTFS ACLs on the JSON file are the real access boundary.

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('encrypt', 'decrypt')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Security

$inputText = [Console]::In.ReadToEnd().TrimEnd("`r", "`n")
if ([string]::IsNullOrEmpty($inputText)) {
    [Console]::Error.WriteLine("dpapi-helper: empty input on stdin")
    exit 2
}

$scope = [System.Security.Cryptography.DataProtectionScope]::LocalMachine

# Application-specific entropy namespaces the protection: an arbitrary unrelated
# process on the box can no longer ProtectedData.Unprotect a stolen blob without
# also supplying this value. It is NOT a secret key — it only has to match between
# Protect and Unprotect — but it removes the "any process can decrypt" weakness of
# a null entropy under LocalMachine scope. NTFS ACLs remain the primary boundary.
$entropy = [System.Text.Encoding]::UTF8.GetBytes('TallyMCP.CompanyRegistry.DPAPI.v1')

try {
    switch ($Action) {
        'encrypt' {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($inputText)
            $blob = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
            [Console]::Out.Write([Convert]::ToBase64String($blob))
        }
        'decrypt' {
            $blob = [Convert]::FromBase64String($inputText)
            try {
                $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, $scope)
            }
            catch {
                # Backward compatibility: blobs written before entropy was introduced
                # used null entropy. Decrypt them so existing stored passwords keep
                # working; they get re-encrypted with entropy on the next save.
                $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, $scope)
            }
            [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))
        }
    }
}
catch {
    [Console]::Error.WriteLine("dpapi-helper: $($_.Exception.Message)")
    exit 1
}
