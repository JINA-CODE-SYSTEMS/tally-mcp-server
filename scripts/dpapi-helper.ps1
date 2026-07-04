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

try {
    switch ($Action) {
        'encrypt' {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($inputText)
            $blob = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
            [Console]::Out.Write([Convert]::ToBase64String($blob))
        }
        'decrypt' {
            $blob = [Convert]::FromBase64String($inputText)
            $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, $scope)
            [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))
        }
    }
}
catch {
    [Console]::Error.WriteLine("dpapi-helper: $($_.Exception.Message)")
    exit 1
}
