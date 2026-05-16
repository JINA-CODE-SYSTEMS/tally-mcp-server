# Manage Companies dialog - standalone WinForms editor for .tally-mcp-companies.json's
# `companies` array. Dot-sourced by tally-mcp-tray.ps1 and invoked from its menu.
#
# Schema mirrors the TypeScript CompanyRegistry / CompanyEntry types in src/mcp.mts.
# Plaintext passwords never touch disk: they are encrypted via scripts/dpapi-helper.ps1
# at save time and stored only as DPAPI base64 blobs in the `passwordEnc` field.

# ---------------------------------------------------------------------------
# Registry I/O
# ---------------------------------------------------------------------------

# Reads the registry file. Returns a hashtable mirroring CompanyRegistry, normalising
# old-shape (flat hints) files into the new shape. Read-only - does not write back.
function Read-CompanyRegistry {
    param([string]$Path)
    $empty = @{ schemaVersion = 1; companies = @() }
    if (-not (Test-Path -LiteralPath $Path)) { return $empty }
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        if (-not $raw) { return $empty }
        $raw = $raw -replace '^﻿', ''
        $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
    } catch { return $empty }
    if (-not $parsed) { return $empty }
    $companies = @()
    if ($parsed.schemaVersion -eq 1 -and $parsed.companies) {
        foreach ($c in $parsed.companies) {
            $companies += @{
                alias        = [string]$c.alias
                extraAliases = @($c.extraAliases | Where-Object { $_ })
                folderId     = [string]$c.folderId
                displayName  = [string]$c.displayName
                username     = [string]$c.username
                passwordEnc  = [string]$c.passwordEnc
                notes        = [string]$c.notes
            }
        }
        $out = @{ schemaVersion = 1; companies = $companies }
        if ($parsed.legacyHints) { $out.legacyHints = $parsed.legacyHints }
        return $out
    }
    return @{ schemaVersion = 1; companies = @(); legacyHints = $parsed }
}

# Atomic write of the registry. Creates the parent dir if missing (defensive for dev mode
# where TALLY_DATA_PATH may not yet exist on disk).
function Write-CompanyRegistry {
    # Atomic write: write .tmp, then Move-Item -Force replaces the destination.
    # -ErrorAction Stop is critical: without it, Move-Item's non-terminating "access
    # denied" failures silently leave an orphan .tmp and the real .json untouched,
    # so the dialog reports "Saved" while nothing actually persisted. Pre-deleting
    # any stale .tmp prevents an old failed-write from polluting the next attempt.
    param([string]$Path, [hashtable]$Registry)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $json = $Registry | ConvertTo-Json -Depth 8
    $tmp = "$Path.tmp"
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8 -ErrorAction Stop
    Move-Item -LiteralPath $tmp -Destination $Path -Force -ErrorAction Stop
}

# ---------------------------------------------------------------------------
# DPAPI bridge
# ---------------------------------------------------------------------------

# Shells out to scripts/dpapi-helper.ps1. Input crosses via stdin so the secret never
# appears on the command line. Returns stdout. Throws on non-zero exit.
function Invoke-DpapiHelper {
    # NOTE: do NOT name the third parameter $Input. `$input` is a PowerShell automatic variable
    # (pipeline enumerator) that exists in every function scope. Declaring a parameter named
    # $Input does not reliably override it - the parameter value gets lost and $Input reads
    # back as the empty enumerator. Use $Payload instead.
    param([string]$HelperPath, [ValidateSet('encrypt', 'decrypt')] [string]$Action, [string]$Payload)
    if ([string]::IsNullOrEmpty($Payload)) { throw "Invoke-DpapiHelper: payload is empty" }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$HelperPath`" -Action $Action"
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.StandardInput.Write($Payload)
    $proc.StandardInput.Close()
    $out = $proc.StandardOutput.ReadToEnd()
    $err = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    if ($proc.ExitCode -ne 0) { throw "dpapi-helper $Action failed (exit $($proc.ExitCode)): $err" }
    return $out
}

function Protect-PasswordViaHelper {
    param([string]$HelperPath, [string]$Plaintext)
    if ([string]::IsNullOrEmpty($Plaintext)) { return $null }
    Invoke-DpapiHelper -HelperPath $HelperPath -Action encrypt -Payload $Plaintext
}
function Unprotect-PasswordViaHelper {
    param([string]$HelperPath, [string]$Blob)
    if ([string]::IsNullOrEmpty($Blob)) { return '' }
    Invoke-DpapiHelper -HelperPath $HelperPath -Action decrypt -Payload $Blob
}

# ---------------------------------------------------------------------------
# GUI agent IPC for the Test button
# ---------------------------------------------------------------------------

function Invoke-LoadCompanyViaAgent {
    param(
        [string]$RegistryPath,
        [string]$FolderId,
        [string]$Username,
        [string]$Password,
        [int]$TimeoutSec = 30
    )
    $dataDir = Split-Path -Parent $RegistryPath
    $cmdFile = Join-Path $dataDir '_mcp_gui_command.json'
    $resFile = Join-Path $dataDir '_mcp_gui_result.json'
    $commandId = "tray-test-$(Get-Date -Format 'HHmmssfff')"

    if (Test-Path $resFile) { Remove-Item $resFile -Force -ErrorAction SilentlyContinue }

    $cmd = @{
        commandId = $commandId
        action    = 'select-and-unlock-company'
        companyId = $FolderId
        userName  = $Username
        password  = $Password
    } | ConvertTo-Json -Compress
    Set-Content -LiteralPath $cmdFile -Value $cmd -Encoding UTF8

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if (-not (Test-Path $resFile)) { continue }
        try {
            $raw = (Get-Content -LiteralPath $resFile -Raw -Encoding UTF8) -replace '^﻿', ''
            $resp = $raw | ConvertFrom-Json -ErrorAction Stop
            if ($resp.commandId -ne $commandId) { continue }
            Remove-Item $resFile -Force -ErrorAction SilentlyContinue
            return @{ ok = ($resp.status -eq 'success'); message = [string]$resp.message }
        } catch { continue }
    }
    return @{ ok = $false; message = "GUI agent did not respond within ${TimeoutSec}s. Is the agent running? Is Tally open?" }
}

# ---------------------------------------------------------------------------
# CSV import
# ---------------------------------------------------------------------------

# Reads a CSV file and returns parsed rows + validation errors. Does not encrypt
# passwords or touch the registry. Header row required; recognised columns are
# alias, folderId, displayName, username, password, extraAliases, notes.
function Read-CompaniesFromCsv {
    param([string]$CsvPath)
    $result = @{ rows = @(); errors = @() }
    try {
        $rows = Import-Csv -LiteralPath $CsvPath -Encoding UTF8
    } catch {
        $result.errors += "Could not parse CSV: $_"
        return $result
    }
    if (-not $rows -or @($rows).Count -eq 0) {
        $result.errors += "CSV has no data rows."
        return $result
    }
    $required = @('alias', 'folderId')
    $known    = @('alias','folderId','displayName','username','password','extraAliases','notes')
    $headers  = @($rows[0].PSObject.Properties.Name)
    foreach ($col in $required) {
        if ($headers -notcontains $col) { $result.errors += "Missing required column: '$col'" }
    }
    $unknown = $headers | Where-Object { $known -notcontains $_ }
    foreach ($u in $unknown) { $result.errors += "Unknown column ignored: '$u'" }

    $seenAliases = @{}
    $lineNum = 1
    foreach ($row in $rows) {
        $lineNum++
        $alias = ("$($row.alias)").Trim()
        $folderId = ("$($row.folderId)").Trim()
        if (-not $alias)    { $result.errors += "Row ${lineNum}: alias is empty"; continue }
        if (-not $folderId) { $result.errors += "Row ${lineNum}: folderId is empty"; continue }
        $aliasKey = $alias.ToLower()
        if ($seenAliases.ContainsKey($aliasKey)) {
            $result.errors += "Row ${lineNum}: duplicate alias '$alias' (also on row $($seenAliases[$aliasKey]))"
            continue
        }
        $seenAliases[$aliasKey] = $lineNum
        $extras = @()
        if ($row.PSObject.Properties.Name -contains 'extraAliases' -and $row.extraAliases) {
            $extras = @($row.extraAliases.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        }
        $result.rows += @{
            alias        = $alias
            folderId     = $folderId
            displayName  = ("$($row.displayName)").Trim()
            username     = ("$($row.username)").Trim()
            password     = "$($row.password)"
            extraAliases = $extras
            notes        = ("$($row.notes)").Trim()
            _lineNum     = $lineNum
        }
    }
    return $result
}

# Modal preview grid for CSV import. Shows each parsed row with a Status column
# (New / Conflict) and asks the user how to resolve conflicts. Returns the
# chosen mode ('overwrite' or 'skip') or $null on Cancel.
function Show-CsvImportPreviewDialog {
    param(
        [array]$ParsedRows,
        [array]$ExistingAliases,
        [array]$ValidationErrors
    )
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Import Companies from CSV - Preview'
    $form.Size = New-Object System.Drawing.Size(820, 560)
    $form.StartPosition = 'CenterParent'
    $form.FormBorderStyle = 'Sizable'
    $form.MinimumSize = New-Object System.Drawing.Size(600, 400)
    $form.BackColor = [System.Drawing.Color]::White
    $form.Font = New-Object System.Drawing.Font 'Segoe UI', 9

    $lblSummary = New-Object System.Windows.Forms.Label
    $existingLower = @($ExistingAliases | ForEach-Object { $_.ToLower() })
    $newCount      = @($ParsedRows | Where-Object { $existingLower -notcontains $_.alias.ToLower() }).Count
    $conflictCount = @($ParsedRows | Where-Object { $existingLower -contains  $_.alias.ToLower() }).Count
    $lblSummary.Text = "$($ParsedRows.Count) rows parsed - $newCount new, $conflictCount conflict with existing aliases."
    $lblSummary.Location = New-Object System.Drawing.Point(15, 12)
    $lblSummary.Size = New-Object System.Drawing.Size(780, 22)
    $lblSummary.Anchor = 'Top,Left,Right'
    $lblSummary.Font = New-Object System.Drawing.Font 'Segoe UI Semibold', 10
    $form.Controls.Add($lblSummary)

    if ($ValidationErrors -and $ValidationErrors.Count -gt 0) {
        $lblErrors = New-Object System.Windows.Forms.Label
        $errPreview = ($ValidationErrors | Select-Object -First 3) -join '   |   '
        $lblErrors.Text = "Warnings: $errPreview" + $(if ($ValidationErrors.Count -gt 3) { " (+$($ValidationErrors.Count - 3) more)" } else { '' })
        $lblErrors.Location = New-Object System.Drawing.Point(15, 36)
        $lblErrors.Size = New-Object System.Drawing.Size(780, 18)
        $lblErrors.Anchor = 'Top,Left,Right'
        $lblErrors.ForeColor = [System.Drawing.Color]::FromArgb(180, 90, 0)
        $form.Controls.Add($lblErrors)
    }

    $grid = New-Object System.Windows.Forms.DataGridView
    $grid.Location = New-Object System.Drawing.Point(15, 60)
    $grid.Size = New-Object System.Drawing.Size(780, 360)
    $grid.Anchor = 'Top,Left,Right,Bottom'
    $grid.AllowUserToAddRows = $false
    $grid.AllowUserToDeleteRows = $false
    $grid.AllowUserToResizeRows = $false
    $grid.ReadOnly = $true
    $grid.RowHeadersVisible = $false
    $grid.SelectionMode = 'FullRowSelect'
    $grid.BackgroundColor = [System.Drawing.Color]::White
    $grid.AlternatingRowsDefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(248, 250, 252)
    $grid.AutoSizeColumnsMode = 'Fill'
    [void]$grid.Columns.Add('status', 'Status')
    [void]$grid.Columns.Add('alias', 'Alias')
    [void]$grid.Columns.Add('folderId', 'Folder ID')
    [void]$grid.Columns.Add('displayName', 'Display Name')
    [void]$grid.Columns.Add('hasPassword', 'Password')
    [void]$grid.Columns.Add('notes', 'Notes')
    $grid.Columns['status'].FillWeight = 12
    $grid.Columns['alias'].FillWeight = 13
    $grid.Columns['folderId'].FillWeight = 10
    $grid.Columns['displayName'].FillWeight = 25
    $grid.Columns['hasPassword'].FillWeight = 10
    $grid.Columns['notes'].FillWeight = 30
    foreach ($r in $ParsedRows) {
        $status = if ($existingLower -contains $r.alias.ToLower()) { 'Conflict' } else { 'New' }
        $hasPw  = if ($r.password) { 'Yes' } else { 'No' }
        [void]$grid.Rows.Add($status, $r.alias, $r.folderId, $r.displayName, $hasPw, $r.notes)
    }
    foreach ($row in $grid.Rows) {
        if ($row.Cells['status'].Value -eq 'Conflict') {
            $row.DefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(255, 245, 220)
        }
    }
    $form.Controls.Add($grid)

    $gbConflict = New-Object System.Windows.Forms.GroupBox
    $gbConflict.Text = ' On conflict with existing alias '
    $gbConflict.Location = New-Object System.Drawing.Point(15, 430)
    $gbConflict.Size = New-Object System.Drawing.Size(440, 56)
    $gbConflict.Anchor = 'Bottom,Left'
    $form.Controls.Add($gbConflict)

    $rbOverwrite = New-Object System.Windows.Forms.RadioButton
    $rbOverwrite.Text = 'Overwrite existing entry'
    $rbOverwrite.Location = New-Object System.Drawing.Point(15, 22)
    $rbOverwrite.Size = New-Object System.Drawing.Size(210, 22)
    $rbOverwrite.Checked = $true
    $gbConflict.Controls.Add($rbOverwrite)

    $rbSkip = New-Object System.Windows.Forms.RadioButton
    $rbSkip.Text = 'Skip (keep existing)'
    $rbSkip.Location = New-Object System.Drawing.Point(230, 22)
    $rbSkip.Size = New-Object System.Drawing.Size(180, 22)
    $gbConflict.Controls.Add($rbSkip)

    $btnImport = New-Object System.Windows.Forms.Button
    $btnImport.Text = 'Import'
    $btnImport.Location = New-Object System.Drawing.Point(595, 442)
    $btnImport.Size = New-Object System.Drawing.Size(95, 32)
    $btnImport.Anchor = 'Bottom,Right'
    $btnImport.BackColor = [System.Drawing.Color]::FromArgb(0, 120, 215)
    $btnImport.ForeColor = [System.Drawing.Color]::White
    $btnImport.UseVisualStyleBackColor = $false
    $form.Controls.Add($btnImport)

    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = 'Cancel'
    $btnCancel.Location = New-Object System.Drawing.Point(700, 442)
    $btnCancel.Size = New-Object System.Drawing.Size(95, 32)
    $btnCancel.Anchor = 'Bottom,Right'
    $btnCancel.DialogResult = 'Cancel'
    $form.Controls.Add($btnCancel)
    $form.CancelButton = $btnCancel

    $state = @{ Mode = $null }
    $btnImport.Add_Click({
        $state.Mode = if ($rbOverwrite.Checked) { 'overwrite' } else { 'skip' }
        $form.DialogResult = 'OK'
        $form.Close()
    }.GetNewClosure())

    [void]$form.ShowDialog()
    return $state.Mode
}

# ---------------------------------------------------------------------------
# UI helpers for the edit dialog
# ---------------------------------------------------------------------------

# Creates a labelled field with a hint line underneath. Returns the textbox.
# Layout is two columns: label/hint on left (140px), input on right (300px).
# $Y is the top of the label; the function reserves ~50px of vertical space.
function New-DialogField {
    param(
        [System.Windows.Forms.Control]$Parent,
        [int]$Y,
        [string]$Label,
        [string]$Hint = '',
        [string]$Initial = '',
        [bool]$Required = $false,
        [bool]$Password = $false,
        [bool]$Multiline = $false
    )
    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = if ($Required) { "$Label *" } else { $Label }
    $lbl.Location = New-Object System.Drawing.Point(15, $Y)
    $lbl.Size = New-Object System.Drawing.Size(135, 20)
    $lbl.Font = New-Object System.Drawing.Font 'Segoe UI Semibold', 9
    $Parent.Controls.Add($lbl)

    $tb = New-Object System.Windows.Forms.TextBox
    $tb.Location = New-Object System.Drawing.Point(155, ($Y - 2))
    $tb.Size = New-Object System.Drawing.Size(305, 22)
    $tb.Font = New-Object System.Drawing.Font 'Segoe UI', 9
    if ($Multiline) {
        $tb.Multiline = $true
        $tb.Size = New-Object System.Drawing.Size(305, 55)
        $tb.ScrollBars = 'Vertical'
    }
    if ($Password) { $tb.UseSystemPasswordChar = $true }
    $tb.Text = $Initial
    $Parent.Controls.Add($tb)

    if ($Hint) {
        $hintLbl = New-Object System.Windows.Forms.Label
        $hintLbl.Text = $Hint
        $hintOffset = if ($Multiline) { 58 } else { 22 }
        $hintLbl.Location = New-Object System.Drawing.Point(155, ($Y + $hintOffset))
        $hintLbl.Size = New-Object System.Drawing.Size(305, 18)
        $hintLbl.Font = New-Object System.Drawing.Font 'Segoe UI', 8
        $hintLbl.ForeColor = [System.Drawing.Color]::FromArgb(110, 110, 110)
        $Parent.Controls.Add($hintLbl)
    }
    return $tb
}

# ---------------------------------------------------------------------------
# Edit dialog - returns $null on Cancel, or a hashtable on OK.
# ---------------------------------------------------------------------------
function Show-CompanyEditDialog {
    param(
        [string]$Title = 'Add Company',
        [hashtable]$Existing = $null
    )
    $isEdit = $null -ne $Existing

    $form = New-Object System.Windows.Forms.Form
    $form.Text = $Title
    $form.Size = New-Object System.Drawing.Size(540, 620)
    $form.StartPosition = 'CenterParent'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.BackColor = [System.Drawing.Color]::White
    $form.Font = New-Object System.Drawing.Font 'Segoe UI', 9

    # --- Section: Identity -------------------------------------------------
    $grpIdentity = New-Object System.Windows.Forms.GroupBox
    $grpIdentity.Text = ' Identity '
    $grpIdentity.Location = New-Object System.Drawing.Point(15, 10)
    $grpIdentity.Size = New-Object System.Drawing.Size(495, 235)
    $grpIdentity.Font = New-Object System.Drawing.Font 'Segoe UI Semibold', 9
    $form.Controls.Add($grpIdentity)

    $tbAlias = New-DialogField -Parent $grpIdentity -Y 25 -Label 'Alias' -Required $true `
        -Hint 'Short name you will say to Claude (e.g. "main", "branch")' `
        -Initial ([string]$Existing.alias)

    $tbFolderId = New-DialogField -Parent $grpIdentity -Y 80 -Label 'Folder ID' -Required $true `
        -Hint 'Tally folder number (e.g. "0001"). What Tally types into Select Company.' `
        -Initial ([string]$Existing.folderId)

    $tbDisplayName = New-DialogField -Parent $grpIdentity -Y 135 -Label 'Display name' `
        -Hint 'Human-readable name shown in confirmations (e.g. "ABC Traders Pvt Ltd")' `
        -Initial ([string]$Existing.displayName)

    $tbExtraAliases = New-DialogField -Parent $grpIdentity -Y 190 -Label 'Extra aliases' `
        -Hint 'Optional comma-separated alternatives ("primary, abc")' `
        -Initial (($Existing.extraAliases -join ', '))

    # --- Section: Credentials ----------------------------------------------
    $grpCreds = New-Object System.Windows.Forms.GroupBox
    $grpCreds.Text = ' Credentials  (only if the company is password-protected) '
    $grpCreds.Location = New-Object System.Drawing.Point(15, 255)
    $grpCreds.Size = New-Object System.Drawing.Size(495, 165)
    $grpCreds.Font = New-Object System.Drawing.Font 'Segoe UI Semibold', 9
    $form.Controls.Add($grpCreds)

    $tbUsername = New-DialogField -Parent $grpCreds -Y 25 -Label 'Username' `
        -Hint 'Tally Edit Log username if security enabled. Leave empty otherwise.' `
        -Initial ([string]$Existing.username)

    # Password row - in edit mode, gated by "Change password" checkbox so we don't
    # accidentally wipe the stored blob when the user just edits a typo elsewhere.
    $cbChangePassword = New-Object System.Windows.Forms.CheckBox
    $cbChangePassword.Text = if ($isEdit) { 'Change password (leave field empty to clear)' } else { 'Set a password (leave field empty for no password)' }
    $cbChangePassword.Location = New-Object System.Drawing.Point(155, 80)
    $cbChangePassword.Size = New-Object System.Drawing.Size(325, 22)
    $cbChangePassword.Font = New-Object System.Drawing.Font 'Segoe UI', 8
    $cbChangePassword.ForeColor = [System.Drawing.Color]::FromArgb(110, 110, 110)
    # In Add: default UNCHECKED. User must explicitly opt in to set a password. This
    # matches the user mental model (no password by default) and avoids the bug where
    # an empty plaintext got fed to DPAPI on save.
    $cbChangePassword.Checked = $false
    $grpCreds.Controls.Add($cbChangePassword)

    $lblPassword = New-Object System.Windows.Forms.Label
    $lblPassword.Text = 'Password'
    $lblPassword.Location = New-Object System.Drawing.Point(15, 110)
    $lblPassword.Size = New-Object System.Drawing.Size(135, 20)
    $lblPassword.Font = New-Object System.Drawing.Font 'Segoe UI Semibold', 9
    $grpCreds.Controls.Add($lblPassword)

    $tbPassword = New-Object System.Windows.Forms.TextBox
    $tbPassword.Location = New-Object System.Drawing.Point(155, 108)
    $tbPassword.Size = New-Object System.Drawing.Size(305, 22)
    $tbPassword.Font = New-Object System.Drawing.Font 'Segoe UI', 9
    $tbPassword.UseSystemPasswordChar = $true
    $tbPassword.Enabled = $cbChangePassword.Checked
    $grpCreds.Controls.Add($tbPassword)

    $cbChangePassword.Add_CheckedChanged({
        $tbPassword.Enabled = $cbChangePassword.Checked
        if (-not $cbChangePassword.Checked) { $tbPassword.Text = '' }
    })

    if ($isEdit -and $Existing.passwordEnc) {
        $lblPwHint = New-Object System.Windows.Forms.Label
        $lblPwHint.Text = 'A password is already stored (encrypted). Tick the box above to replace or clear it.'
        $lblPwHint.Location = New-Object System.Drawing.Point(155, 133)
        $lblPwHint.Size = New-Object System.Drawing.Size(325, 18)
        $lblPwHint.Font = New-Object System.Drawing.Font 'Segoe UI', 8
        $lblPwHint.ForeColor = [System.Drawing.Color]::FromArgb(110, 110, 110)
        $grpCreds.Controls.Add($lblPwHint)
    }

    # --- Section: Notes ----------------------------------------------------
    $grpNotes = New-Object System.Windows.Forms.GroupBox
    $grpNotes.Text = ' Notes '
    $grpNotes.Location = New-Object System.Drawing.Point(15, 430)
    $grpNotes.Size = New-Object System.Drawing.Size(495, 90)
    $grpNotes.Font = New-Object System.Drawing.Font 'Segoe UI Semibold', 9
    $form.Controls.Add($grpNotes)

    $tbNotes = New-Object System.Windows.Forms.TextBox
    $tbNotes.Multiline = $true
    $tbNotes.ScrollBars = 'Vertical'
    $tbNotes.Location = New-Object System.Drawing.Point(15, 25)
    $tbNotes.Size = New-Object System.Drawing.Size(465, 55)
    $tbNotes.Font = New-Object System.Drawing.Font 'Segoe UI', 9
    $tbNotes.Text = [string]$Existing.notes
    $grpNotes.Controls.Add($tbNotes)

    # --- OK / Cancel -------------------------------------------------------
    $btnOk = New-Object System.Windows.Forms.Button
    $btnOk.Text = 'OK'
    $btnOk.Location = New-Object System.Drawing.Point(320, 535)
    $btnOk.Size = New-Object System.Drawing.Size(90, 30)
    $form.Controls.Add($btnOk)

    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = 'Cancel'
    $btnCancel.Location = New-Object System.Drawing.Point(420, 535)
    $btnCancel.Size = New-Object System.Drawing.Size(90, 30)
    $btnCancel.DialogResult = 'Cancel'
    $form.Controls.Add($btnCancel)

    $form.CancelButton = $btnCancel
    $form.AcceptButton = $btnOk

    # State container shared with the OK click handler. Using a hashtable (reference type)
    # + .GetNewClosure() instead of $script:result because PowerShell's $script: scope
    # doesn't behave reliably for dot-sourced functions invoked from WinForms event handlers.
    $state = @{ Result = $null }

    $okHandler = {
        $alias = $tbAlias.Text.Trim()
        $folder = $tbFolderId.Text.Trim()
        if (-not $alias) {
            [System.Windows.Forms.MessageBox]::Show('Alias is required.', 'Validation', 'OK', 'Warning') | Out-Null
            $tbAlias.Focus()
            return
        }
        if (-not $folder) {
            [System.Windows.Forms.MessageBox]::Show('Folder ID is required. Use the Tally folder number (e.g. "0001").', 'Validation', 'OK', 'Warning') | Out-Null
            $tbFolderId.Focus()
            return
        }
        $extras = @($tbExtraAliases.Text.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })

        $state.Result = @{
            alias        = $alias
            extraAliases = $extras
            folderId     = $folder
            displayName  = $tbDisplayName.Text.Trim()
            username     = $tbUsername.Text.Trim()
            notes        = $tbNotes.Text.Trim()
            # Password handling — three states:
            #   1. checkbox unchecked    -> preserve existing passwordEnc (Edit) or no password (Add)
            #   2. checkbox checked + empty field -> clear password (passwordEnc = $null)
            #   3. checkbox checked + non-empty   -> save loop encrypts via DPAPI helper
            _passwordChanged   = $cbChangePassword.Checked
            _plaintextPassword = $tbPassword.Text
        }
        if ($isEdit -and $Existing.passwordEnc -and -not $cbChangePassword.Checked) {
            $state.Result.passwordEnc = $Existing.passwordEnc
        }
        $form.DialogResult = 'OK'
        $form.Close()
    }.GetNewClosure()
    $btnOk.Add_Click($okHandler)

    [void]$form.ShowDialog()
    return $state.Result
}

# ---------------------------------------------------------------------------
# Main dialog
# ---------------------------------------------------------------------------
function Show-ManageCompaniesDialog {
    param(
        [Parameter(Mandatory)] [string]$RegistryPath,
        [Parameter(Mandatory)] [string]$DpapiHelperPath
    )

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    # NOTE: this dialog deliberately does NOT keep an in-memory $registry across
    # button clicks. Every Add/Edit/Delete reads the file, mutates the result,
    # writes it back. Sidesteps a class of PowerShell 5.1 + WinForms event
    # handler bugs where in-memory state set by one handler isn't visible to
    # another (works fine in PS7, fails in PS5.1).
    #
    # ALSO: .GetNewClosure() creates a dynamic-module scope that can't see
    # functions defined in the parent script - even functions defined in this
    # SAME file. To work around that, capture each helper's scriptblock into
    # a local variable here, and invoke via `& $fnRead` etc. inside handlers.
    # The variables ARE captured by .GetNewClosure(), so the function bodies
    # are reachable from within the module scope.
    $fnRead         = ${function:Read-CompanyRegistry}
    $fnWrite        = ${function:Write-CompanyRegistry}
    $fnProtect      = ${function:Protect-PasswordViaHelper}
    $fnUnprotect    = ${function:Unprotect-PasswordViaHelper}
    $fnAgent        = ${function:Invoke-LoadCompanyViaAgent}
    $fnEditDialog   = ${function:Show-CompanyEditDialog}
    $fnReadCsv      = ${function:Read-CompaniesFromCsv}
    $fnPreviewCsv   = ${function:Show-CsvImportPreviewDialog}

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Manage Companies - TallyMCP'
    $form.Size = New-Object System.Drawing.Size(920, 600)
    $form.StartPosition = 'CenterScreen'
    $form.MinimumSize = New-Object System.Drawing.Size(760, 440)
    $form.BackColor = [System.Drawing.Color]::White
    $form.Font = New-Object System.Drawing.Font 'Segoe UI', 9

    # Header band: subtle tinted strip behind the title for visual anchor
    $headerPanel = New-Object System.Windows.Forms.Panel
    $headerPanel.Location = New-Object System.Drawing.Point(0, 0)
    $headerPanel.Size = New-Object System.Drawing.Size(920, 78)
    $headerPanel.BackColor = [System.Drawing.Color]::FromArgb(245, 247, 250)
    $headerPanel.Anchor = 'Top,Left,Right'
    $form.Controls.Add($headerPanel)

    $lblTitle = New-Object System.Windows.Forms.Label
    $lblTitle.Text = 'Manage Companies'
    $lblTitle.Location = New-Object System.Drawing.Point(20, 14)
    $lblTitle.Size = New-Object System.Drawing.Size(600, 28)
    $lblTitle.Font = New-Object System.Drawing.Font 'Segoe UI Semibold', 14
    $lblTitle.ForeColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
    $headerPanel.Controls.Add($lblTitle)

    $lblSub = New-Object System.Windows.Forms.Label
    $lblSub.Text = 'Register a short alias for each Tally company. Then ask Claude to "load <alias>" - no screenshot loop, no manual lookup.'
    $lblSub.Location = New-Object System.Drawing.Point(20, 44)
    $lblSub.Size = New-Object System.Drawing.Size(870, 18)
    $lblSub.Font = New-Object System.Drawing.Font 'Segoe UI', 9
    $lblSub.ForeColor = [System.Drawing.Color]::FromArgb(95, 95, 95)
    $lblSub.Anchor = 'Top,Left,Right'
    $headerPanel.Controls.Add($lblSub)

    $lblCount = New-Object System.Windows.Forms.Label
    $lblCount.Text = ''
    $lblCount.Location = New-Object System.Drawing.Point(20, 90)
    $lblCount.Size = New-Object System.Drawing.Size(400, 18)
    $lblCount.Font = New-Object System.Drawing.Font 'Segoe UI Semibold', 9
    $lblCount.ForeColor = [System.Drawing.Color]::FromArgb(60, 60, 60)
    $form.Controls.Add($lblCount)

    $lblPath = New-Object System.Windows.Forms.Label
    $lblPath.Text = "Registry: $RegistryPath"
    $lblPath.Location = New-Object System.Drawing.Point(440, 90)
    $lblPath.Size = New-Object System.Drawing.Size(460, 18)
    $lblPath.Font = New-Object System.Drawing.Font 'Segoe UI', 8
    $lblPath.ForeColor = [System.Drawing.Color]::FromArgb(140, 140, 140)
    $lblPath.TextAlign = 'TopRight'
    $lblPath.Anchor = 'Top,Right'
    $form.Controls.Add($lblPath)

    # Grid
    $grid = New-Object System.Windows.Forms.DataGridView
    $grid.Location = New-Object System.Drawing.Point(20, 115)
    $grid.Size = New-Object System.Drawing.Size(880, 395)
    $grid.Anchor = 'Top,Left,Right,Bottom'
    $grid.AllowUserToAddRows = $false
    $grid.AllowUserToDeleteRows = $false
    $grid.AllowUserToResizeRows = $false
    $grid.ReadOnly = $true
    $grid.SelectionMode = 'FullRowSelect'
    $grid.MultiSelect = $false
    $grid.RowHeadersVisible = $false
    $grid.BackgroundColor = [System.Drawing.Color]::White
    $grid.BorderStyle = 'FixedSingle'
    $grid.GridColor = [System.Drawing.Color]::FromArgb(225, 225, 225)
    $grid.AlternatingRowsDefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(248, 250, 252)
    $grid.ColumnHeadersDefaultCellStyle.Font = New-Object System.Drawing.Font 'Segoe UI Semibold', 9
    $grid.ColumnHeadersDefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(240, 242, 247)
    $grid.ColumnHeadersDefaultCellStyle.Padding = New-Object System.Windows.Forms.Padding 6, 0, 0, 0
    $grid.EnableHeadersVisualStyles = $false
    $grid.ColumnHeadersHeight = 32
    $grid.RowTemplate.Height = 28
    $grid.DefaultCellStyle.Padding = New-Object System.Windows.Forms.Padding 6, 0, 0, 0
    [void]$grid.Columns.Add('alias', 'Alias')
    [void]$grid.Columns.Add('folderId', 'Folder ID')
    [void]$grid.Columns.Add('displayName', 'Display Name')
    [void]$grid.Columns.Add('hasPassword', 'Password')
    [void]$grid.Columns.Add('notes', 'Notes')
    $grid.Columns['alias'].FillWeight = 15
    $grid.Columns['folderId'].FillWeight = 10
    $grid.Columns['displayName'].FillWeight = 30
    $grid.Columns['hasPassword'].FillWeight = 10
    $grid.Columns['notes'].FillWeight = 35
    $grid.AutoSizeColumnsMode = 'Fill'
    $form.Controls.Add($grid)

    # The grid renders directly from the file every time. We never carry per-entry mutable
    # state across handler invocations - each Add/Edit/Delete does its own
    # read-from-disk, mutate, write-to-disk cycle. This sidesteps the PS5.1
    # WinForms event-handler closure quirks where in-memory state set by one
    # handler isn't visible to another.
    $refreshGrid = {
        $selectedAlias = if ($grid.SelectedRows.Count -gt 0) { $grid.SelectedRows[0].Cells['alias'].Value } else { $null }
        $grid.Rows.Clear()
        $live = & $fnRead -Path $RegistryPath
        foreach ($c in $live.companies) {
            $hasPw = if ($c.passwordEnc) { 'Yes' } else { 'No' }
            [void]$grid.Rows.Add($c.alias, $c.folderId, $c.displayName, $hasPw, $c.notes)
        }
        if ($selectedAlias) {
            for ($i = 0; $i -lt $grid.Rows.Count; $i++) {
                if ($grid.Rows[$i].Cells['alias'].Value -eq $selectedAlias) {
                    $grid.Rows[$i].Selected = $true
                    break
                }
            }
        }
        $n = $live.companies.Count
        $lblCount.Text = if ($n -eq 0) { 'No companies configured yet.' } elseif ($n -eq 1) { '1 company configured' } else { "$n companies configured" }
    }.GetNewClosure()
    & $refreshGrid

    # Thin divider between grid and buttons
    $divider = New-Object System.Windows.Forms.Panel
    $divider.Location = New-Object System.Drawing.Point(20, 520)
    $divider.Size = New-Object System.Drawing.Size(880, 1)
    $divider.BackColor = [System.Drawing.Color]::FromArgb(230, 232, 236)
    $divider.Anchor = 'Bottom,Left,Right'
    $form.Controls.Add($divider)

    # Buttons. Row ops grouped left (Add/Edit/Delete/Test), bulk ops in the
    # middle (Import/Sample), Close right-anchored.
    $btnY = 535
    function _MakeButton {
        param([string]$Text, [int]$X, [int]$W = 95, [string]$Anchor = 'Bottom,Left', [System.Drawing.Color]$Back = ([System.Drawing.Color]::Empty), [System.Drawing.Color]$Fore = ([System.Drawing.Color]::Empty))
        $b = New-Object System.Windows.Forms.Button
        $b.Text = $Text
        $b.Location = New-Object System.Drawing.Point($X, $btnY)
        $b.Size = New-Object System.Drawing.Size($W, 34)
        $b.Anchor = $Anchor
        $b.Font = New-Object System.Drawing.Font 'Segoe UI', 9
        $b.FlatStyle = 'System'
        if (-not $Back.IsEmpty) { $b.BackColor = $Back; $b.UseVisualStyleBackColor = $false }
        if (-not $Fore.IsEmpty) { $b.ForeColor = $Fore }
        $form.Controls.Add($b)
        return $b
    }
    $btnAdd       = _MakeButton -Text 'Add'        -X  20 -W 90
    $btnEdit      = _MakeButton -Text 'Edit'       -X 115 -W 90
    $btnDelete    = _MakeButton -Text 'Delete'     -X 210 -W 90
    $btnTest      = _MakeButton -Text 'Test'       -X 305 -W 90
    $btnImportCsv = _MakeButton -Text 'Import CSV' -X 425 -W 110
    $btnSampleCsv = _MakeButton -Text 'Sample CSV' -X 540 -W 110
    $btnClose     = _MakeButton -Text 'Close'      -X 805 -W 95 -Anchor 'Bottom,Right' `
                      -Back ([System.Drawing.Color]::FromArgb(0, 120, 215)) -Fore ([System.Drawing.Color]::White)

    # Translate an edit-dialog entry's transient password fields (_passwordChanged /
    # _plaintextPassword) into a clean entry suitable for persistence, encrypting on the fly.
    # `$ExistingPasswordEnc` is the blob we preserve when the user didn't tick "Change password".
    $finalizeEntry = {
        param($entry, $ExistingPasswordEnc)
        $changed = ($entry.ContainsKey('_passwordChanged') -and $entry._passwordChanged -eq $true)
        if ($changed) {
            $plain = if ($entry.ContainsKey('_plaintextPassword') -and $null -ne $entry._plaintextPassword) { [string]$entry._plaintextPassword } else { '' }
            $enc = & $fnProtect -HelperPath $DpapiHelperPath -Plaintext $plain
            if ($enc) { $entry.passwordEnc = $enc }
            elseif ($entry.ContainsKey('passwordEnc')) { $entry.Remove('passwordEnc') | Out-Null }
        } elseif ($ExistingPasswordEnc) {
            $entry.passwordEnc = $ExistingPasswordEnc
        }
        if ($entry.ContainsKey('_passwordChanged'))   { $entry.Remove('_passwordChanged')   | Out-Null }
        if ($entry.ContainsKey('_plaintextPassword')) { $entry.Remove('_plaintextPassword') | Out-Null }
        if ($entry.ContainsKey('passwordEnc') -and [string]::IsNullOrEmpty($entry.passwordEnc)) {
            $entry.Remove('passwordEnc') | Out-Null
        }
        return $entry
    }.GetNewClosure()

    # --- Add ---------------------------------------------------------------
    # Read-modify-write: read live registry, append the new entry, write back.
    $btnAdd.Add_Click({
        $entry = & $fnEditDialog -Title 'Add Company'
        if (-not $entry) { return }
        try {
            $live = & $fnRead -Path $RegistryPath
            $existing = $live.companies | Where-Object { $_.alias.ToLower() -eq $entry.alias.ToLower() }
            if ($existing) {
                [System.Windows.Forms.MessageBox]::Show("Alias '$($entry.alias)' is already in use.", 'Duplicate alias', 'OK', 'Warning') | Out-Null
                return
            }
            $finalEntry = & $finalizeEntry $entry $null
            $live.companies = @($live.companies) + @($finalEntry)
            & $fnWrite -Path $RegistryPath -Registry $live
            & $refreshGrid
            [System.Windows.Forms.MessageBox]::Show("Added '$($finalEntry.alias)' (folder $($finalEntry.folderId)).", 'Added', 'OK', 'Information') | Out-Null
        } catch {
            [System.Windows.Forms.MessageBox]::Show("Add failed: $_", 'Error', 'OK', 'Error') | Out-Null
        }
    }.GetNewClosure())

    # --- Edit --------------------------------------------------------------
    $btnEdit.Add_Click({
        if ($grid.SelectedRows.Count -eq 0) {
            [System.Windows.Forms.MessageBox]::Show('Select a row first.', 'No selection', 'OK', 'Information') | Out-Null
            return
        }
        $aliasToEdit = [string]$grid.SelectedRows[0].Cells['alias'].Value
        try {
            $live = & $fnRead -Path $RegistryPath
            $idx = -1
            for ($i = 0; $i -lt $live.companies.Count; $i++) {
                if ($live.companies[$i].alias -eq $aliasToEdit) { $idx = $i; break }
            }
            if ($idx -lt 0) {
                [System.Windows.Forms.MessageBox]::Show("Entry '$aliasToEdit' is no longer in the registry. Refreshing.", 'Not found', 'OK', 'Warning') | Out-Null
                & $refreshGrid
                return
            }
            $existingPwd = [string]$live.companies[$idx].passwordEnc
            $entry = & $fnEditDialog -Title "Edit Company: $aliasToEdit" -Existing $live.companies[$idx]
            if (-not $entry) { return }
            $finalEntry = & $finalizeEntry $entry $existingPwd
            $live.companies[$idx] = $finalEntry
            & $fnWrite -Path $RegistryPath -Registry $live
            & $refreshGrid
        } catch {
            [System.Windows.Forms.MessageBox]::Show("Edit failed: $_", 'Error', 'OK', 'Error') | Out-Null
        }
    }.GetNewClosure())

    # --- Delete ------------------------------------------------------------
    $btnDelete.Add_Click({
        if ($grid.SelectedRows.Count -eq 0) {
            [System.Windows.Forms.MessageBox]::Show('Select a row first.', 'No selection', 'OK', 'Information') | Out-Null
            return
        }
        $aliasToDelete = [string]$grid.SelectedRows[0].Cells['alias'].Value
        $confirm = [System.Windows.Forms.MessageBox]::Show("Delete '$aliasToDelete'?", 'Confirm delete', 'YesNo', 'Question')
        if ($confirm -ne 'Yes') { return }
        try {
            $live = & $fnRead -Path $RegistryPath
            $live.companies = @($live.companies | Where-Object { $_.alias -ne $aliasToDelete })
            & $fnWrite -Path $RegistryPath -Registry $live
            & $refreshGrid
        } catch {
            [System.Windows.Forms.MessageBox]::Show("Delete failed: $_", 'Error', 'OK', 'Error') | Out-Null
        }
    }.GetNewClosure())

    # --- Test --------------------------------------------------------------
    $btnTest.Add_Click({
        if ($grid.SelectedRows.Count -eq 0) {
            [System.Windows.Forms.MessageBox]::Show('Select a row first.', 'No selection', 'OK', 'Information') | Out-Null
            return
        }
        $aliasToTest = [string]$grid.SelectedRows[0].Cells['alias'].Value
        $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
        $btnTest.Enabled = $false
        try {
            $live = & $fnRead -Path $RegistryPath
            $entry = $live.companies | Where-Object { $_.alias -eq $aliasToTest } | Select-Object -First 1
            if (-not $entry) {
                [System.Windows.Forms.MessageBox]::Show("Entry '$aliasToTest' is no longer in the registry.", 'Not found', 'OK', 'Warning') | Out-Null
                return
            }
            $plain = ''
            if ($entry.passwordEnc) {
                try { $plain = & $fnUnprotect -HelperPath $DpapiHelperPath -Blob $entry.passwordEnc }
                catch {
                    [System.Windows.Forms.MessageBox]::Show("Could not decrypt the stored password: $_`n`nFix via Edit > tick 'Change password'.", 'Decrypt failed', 'OK', 'Error') | Out-Null
                    return
                }
            }
            $result = & $fnAgent -RegistryPath $RegistryPath -FolderId $entry.folderId -Username $entry.username -Password $plain
            if ($result.ok) {
                [System.Windows.Forms.MessageBox]::Show("OK - $($result.message)", "Test passed: $aliasToTest", 'OK', 'Information') | Out-Null
            } else {
                [System.Windows.Forms.MessageBox]::Show("FAILED - $($result.message)", "Test failed: $aliasToTest", 'OK', 'Warning') | Out-Null
            }
        } finally {
            $form.Cursor = [System.Windows.Forms.Cursors]::Default
            $btnTest.Enabled = $true
        }
    }.GetNewClosure())

    # --- Import CSV --------------------------------------------------------
    # File picker -> parse -> preview -> bulk write. Plaintext passwords in the
    # CSV are encrypted per-row via the DPAPI helper before persistence.
    $btnImportCsv.Add_Click({
        $ofd = New-Object System.Windows.Forms.OpenFileDialog
        $ofd.Filter = 'CSV files (*.csv)|*.csv|All files (*.*)|*.*'
        $ofd.Title  = 'Select companies CSV'
        if ($ofd.ShowDialog() -ne 'OK') { return }
        $csvPath = $ofd.FileName

        $parsed = & $fnReadCsv -CsvPath $csvPath
        $blockingErrors = @($parsed.errors | Where-Object {
            $_ -like 'Missing required column:*' -or $_ -like 'Could not parse CSV:*' -or $_ -eq 'CSV has no data rows.'
        })
        if ($blockingErrors.Count -gt 0) {
            [System.Windows.Forms.MessageBox]::Show(($blockingErrors -join "`n"), 'CSV invalid', 'OK', 'Error') | Out-Null
            return
        }
        if ($parsed.rows.Count -eq 0) {
            [System.Windows.Forms.MessageBox]::Show('No valid rows in the CSV.', 'Nothing to import', 'OK', 'Information') | Out-Null
            return
        }

        $live = & $fnRead -Path $RegistryPath
        $existingAliases = @($live.companies | ForEach-Object { $_.alias })
        $mode = & $fnPreviewCsv -ParsedRows $parsed.rows -ExistingAliases $existingAliases -ValidationErrors $parsed.errors
        if (-not $mode) { return }

        $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
        $btnImportCsv.Enabled = $false
        try {
            $existingLower = @{}
            for ($i = 0; $i -lt $live.companies.Count; $i++) {
                $existingLower[$live.companies[$i].alias.ToLower()] = $i
            }
            $added = 0; $updated = 0; $skipped = 0
            foreach ($row in $parsed.rows) {
                $key = $row.alias.ToLower()
                $entry = @{
                    alias        = $row.alias
                    folderId     = $row.folderId
                    displayName  = $row.displayName
                    username     = $row.username
                    extraAliases = $row.extraAliases
                    notes        = $row.notes
                }
                if ($row.password) {
                    $entry.passwordEnc = & $fnProtect -HelperPath $DpapiHelperPath -Plaintext $row.password
                }
                if ($existingLower.ContainsKey($key)) {
                    if ($mode -eq 'skip') { $skipped++; continue }
                    $existingEntry = $live.companies[$existingLower[$key]]
                    if (-not $entry.passwordEnc -and $existingEntry.passwordEnc) {
                        $entry.passwordEnc = $existingEntry.passwordEnc
                    }
                    $live.companies[$existingLower[$key]] = $entry
                    $updated++
                } else {
                    $live.companies = @($live.companies) + @($entry)
                    $existingLower[$key] = $live.companies.Count - 1
                    $added++
                }
            }
            & $fnWrite -Path $RegistryPath -Registry $live
            & $refreshGrid

            $msg = "Import complete:`n  Added:    $added`n  Updated:  $updated`n  Skipped:  $skipped"
            if ($parsed.rows | Where-Object { $_.password }) {
                $msg += "`n`nThe CSV contains plaintext passwords. Delete the file now if you no longer need it:`n  $csvPath"
            }
            [System.Windows.Forms.MessageBox]::Show($msg, 'CSV imported', 'OK', 'Information') | Out-Null
        } catch {
            [System.Windows.Forms.MessageBox]::Show("Import failed: $_", 'Error', 'OK', 'Error') | Out-Null
        } finally {
            $form.Cursor = [System.Windows.Forms.Cursors]::Default
            $btnImportCsv.Enabled = $true
        }
    }.GetNewClosure())

    # --- Sample CSV --------------------------------------------------------
    # Writes a template CSV with the headers we accept and two example rows.
    # Lets the user fill in their own data and upload via Import CSV.
    $btnSampleCsv.Add_Click({
        $sfd = New-Object System.Windows.Forms.SaveFileDialog
        $sfd.Filter   = 'CSV files (*.csv)|*.csv'
        $sfd.Title    = 'Save sample CSV'
        $sfd.FileName = 'tally-companies-sample.csv'
        if ($sfd.ShowDialog() -ne 'OK') { return }
        try {
            $sample = 'alias,folderId,displayName,username,password,extraAliases,notes'
            Set-Content -LiteralPath $sfd.FileName -Value $sample -Encoding UTF8
            $msg = "Sample CSV saved to:`n  $($sfd.FileName)`n`nEdit it with the companies you want to register, then use Import CSV to load them.`n`nRequired columns: alias, folderId`nOptional columns: displayName, username, password, extraAliases, notes"
            [System.Windows.Forms.MessageBox]::Show($msg, 'Sample saved', 'OK', 'Information') | Out-Null
        } catch {
            [System.Windows.Forms.MessageBox]::Show("Could not save sample: $_", 'Error', 'OK', 'Error') | Out-Null
        }
    }.GetNewClosure())

    # --- Close -------------------------------------------------------------
    # No unsaved-changes prompt: every operation persists to disk immediately, so close is
    # always safe.
    $btnClose.Add_Click({ $form.Close() }.GetNewClosure())

    [void]$form.ShowDialog()
}
