<#
.SYNOPSIS
    Show (and copy) what any MCP client needs to connect to this Tally MCP install.

.DESCRIPTION
    connect-client.ps1 edits the config file of the clients we know. This is for everything else: a
    custom agent, an agent framework, an AI app with no entry in the client table. It prints the
    stdio launch block and, when the install serves HTTP, the URL - and puts the same text on the
    clipboard so it can be pasted wherever that client keeps its MCP servers.

    Read-only. It writes no file and changes no client; it runs the engine's `show` command
    (src/client-config.mts -> dist/client-config.mjs), which only reads the install's .env.

    Runs as the ordinary user, like connect-client.ps1: nothing here needs elevation.

.PARAMETER InstallDir
    The install to describe. Defaults to the one this script lives in.

.PARAMETER Json
    Emit the engine's JSON instead of the text, and do not touch the clipboard.

.PARAMETER NoClipboard
    Print only.
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [switch]$Json,
    [switch]$NoClipboard
)

$ErrorActionPreference = 'Stop'

if (-not $InstallDir -or -not $InstallDir.Trim()) {
    $InstallDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
}
$InstallDir = $InstallDir.TrimEnd('\')

$cli = Join-Path $InstallDir 'dist\client-config.mjs'
if (-not (Test-Path -LiteralPath $cli)) {
    throw "client-config.mjs not found at $cli. Is InstallDir correct, and was the project built?"
}

# The bundled runtime, for the same reason as connect-client.ps1: the command we print is the one
# the client will run for the life of the install, so it must not depend on a system Node.
$bundledNode = Join-Path $InstallDir 'node-portable\node.exe'
if (-not (Test-Path -LiteralPath $bundledNode)) {
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if (-not $onPath) {
        throw "No Node runtime found: expected the bundled $bundledNode, and 'node' is not on PATH either."
    }
    $bundledNode = $onPath.Source
    Write-Host "[warn] bundled Node not found; falling back to $bundledNode (expected on a from-source install)"
}

$cliArgs = @($cli, 'show', '--install-root', $InstallDir, '--node', $bundledNode)
if ($Json) { $cliArgs += '--json' }

$raw = & $bundledNode @cliArgs 2>&1
$exit = $LASTEXITCODE
$text = ($raw | Out-String).TrimEnd()

if ($exit -ne 0) {
    Write-Host $text
    Write-Host "[STOP] Could not work out the connection details (exit $exit)." -ForegroundColor Yellow
    exit $exit
}

if ($Json) { Write-Output $text; exit 0 }

Write-Host ""
Write-Host $text
Write-Host ""

if (-not $NoClipboard) {
    try {
        Set-Clipboard -Value $text
        Write-Host "[OK] Copied to the clipboard. Paste it into your AI app's or agent's MCP server settings." -ForegroundColor Green
    } catch {
        Write-Host "[warn] Could not copy to the clipboard ($_). Select the text above and copy it by hand." -ForegroundColor Yellow
    }
}
exit 0
