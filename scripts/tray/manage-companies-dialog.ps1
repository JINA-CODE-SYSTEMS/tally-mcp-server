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
    param([string]$Path, [hashtable]$Registry)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $json = $Registry | ConvertTo-Json -Depth 8
    $tmp = "$Path.tmp"
    Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $Path -Force
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

    # Reset the script-scoped result every time so a previous OK from this session can't
    # leak into a Cancel on the next dialog.
    $script:result = $null

    $btnOk.Add_Click({
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

        $script:result = @{
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
            $script:result.passwordEnc = $Existing.passwordEnc
        }
        $form.DialogResult = 'OK'
        $form.Close()
    })

    [void]$form.ShowDialog()
    return $script:result
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

    $registry = Read-CompanyRegistry -Path $RegistryPath
    $script:dirty = $false

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Manage Companies - TallyMCP'
    $form.Size = New-Object System.Drawing.Size(880, 560)
    $form.StartPosition = 'CenterScreen'
    $form.MinimumSize = New-Object System.Drawing.Size(700, 400)
    $form.BackColor = [System.Drawing.Color]::White
    $form.Font = New-Object System.Drawing.Font 'Segoe UI', 9

    # Header
    $lblTitle = New-Object System.Windows.Forms.Label
    $lblTitle.Text = 'Companies you have configured for Claude'
    $lblTitle.Location = New-Object System.Drawing.Point(15, 12)
    $lblTitle.Size = New-Object System.Drawing.Size(820, 24)
    $lblTitle.Font = New-Object System.Drawing.Font 'Segoe UI Semibold', 11
    $lblTitle.Anchor = 'Top,Left,Right'
    $form.Controls.Add($lblTitle)

    $lblSub = New-Object System.Windows.Forms.Label
    $lblSub.Text = "Add an alias (e.g. ""main"") for each Tally company you load often. Then tell Claude ""load main"" and it skips the screenshot loop."
    $lblSub.Location = New-Object System.Drawing.Point(15, 38)
    $lblSub.Size = New-Object System.Drawing.Size(820, 18)
    $lblSub.Font = New-Object System.Drawing.Font 'Segoe UI', 9
    $lblSub.ForeColor = [System.Drawing.Color]::FromArgb(95, 95, 95)
    $lblSub.Anchor = 'Top,Left,Right'
    $form.Controls.Add($lblSub)

    $lblPath = New-Object System.Windows.Forms.Label
    $lblPath.Text = "Registry file:  $RegistryPath"
    $lblPath.Location = New-Object System.Drawing.Point(15, 60)
    $lblPath.Size = New-Object System.Drawing.Size(820, 18)
    $lblPath.Font = New-Object System.Drawing.Font 'Segoe UI', 8
    $lblPath.ForeColor = [System.Drawing.Color]::FromArgb(130, 130, 130)
    $lblPath.Anchor = 'Top,Left,Right'
    $form.Controls.Add($lblPath)

    # Grid
    $grid = New-Object System.Windows.Forms.DataGridView
    $grid.Location = New-Object System.Drawing.Point(15, 90)
    $grid.Size = New-Object System.Drawing.Size(840, 365)
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

    $refreshGrid = {
        $selectedAlias = if ($grid.SelectedRows.Count -gt 0) { $grid.SelectedRows[0].Cells['alias'].Value } else { $null }
        $grid.Rows.Clear()
        foreach ($c in $registry.companies) {
            $hasPw = if ($c.passwordEnc) { 'Yes' } else { 'No' }
            [void]$grid.Rows.Add($c.alias, $c.folderId, $c.displayName, $hasPw, $c.notes)
        }
        # Re-select what was selected (Edit/Test should preserve focus).
        if ($selectedAlias) {
            for ($i = 0; $i -lt $grid.Rows.Count; $i++) {
                if ($grid.Rows[$i].Cells['alias'].Value -eq $selectedAlias) {
                    $grid.Rows[$i].Selected = $true
                    break
                }
            }
        }
    }
    & $refreshGrid

    # Dirty indicator (top-right)
    $lblDirty = New-Object System.Windows.Forms.Label
    $lblDirty.Text = ''
    $lblDirty.Location = New-Object System.Drawing.Point(700, 60)
    $lblDirty.Size = New-Object System.Drawing.Size(155, 18)
    $lblDirty.TextAlign = 'MiddleRight'
    $lblDirty.Font = New-Object System.Drawing.Font 'Segoe UI Italic', 8
    $lblDirty.ForeColor = [System.Drawing.Color]::FromArgb(180, 80, 25)
    $lblDirty.Anchor = 'Top,Right'
    $form.Controls.Add($lblDirty)
    $markDirty = { $script:dirty = $true; $lblDirty.Text = '* unsaved changes' }
    $markClean = { $script:dirty = $false; $lblDirty.Text = '' }

    # Buttons
    $btnY = 470
    function _MakeButton {
        param([string]$Text, [int]$X, [int]$W = 100, [string]$Anchor = 'Bottom,Left', [System.Drawing.Color]$Back = ([System.Drawing.Color]::Empty), [System.Drawing.Color]$Fore = ([System.Drawing.Color]::Empty))
        $b = New-Object System.Windows.Forms.Button
        $b.Text = $Text
        $b.Location = New-Object System.Drawing.Point($X, $btnY)
        $b.Size = New-Object System.Drawing.Size($W, 32)
        $b.Anchor = $Anchor
        $b.Font = New-Object System.Drawing.Font 'Segoe UI', 9
        $b.FlatStyle = 'System'
        if (-not $Back.IsEmpty) { $b.BackColor = $Back; $b.UseVisualStyleBackColor = $false }
        if (-not $Fore.IsEmpty) { $b.ForeColor = $Fore }
        $form.Controls.Add($b)
        return $b
    }
    $btnAdd    = _MakeButton -Text 'Add'    -X  15 -W 90
    $btnEdit   = _MakeButton -Text 'Edit'   -X 110 -W 90
    $btnDelete = _MakeButton -Text 'Delete' -X 205 -W 90
    $btnTest   = _MakeButton -Text 'Test'   -X 300 -W 90
    $btnSave   = _MakeButton -Text 'Save'   -X 655 -W 95 -Anchor 'Bottom,Right' `
                  -Back ([System.Drawing.Color]::FromArgb(0, 120, 215)) -Fore ([System.Drawing.Color]::White)
    $btnClose  = _MakeButton -Text 'Close'  -X 760 -W 95 -Anchor 'Bottom,Right'

    # Selected entry helper
    $getSelected = {
        if ($grid.SelectedRows.Count -eq 0) { return $null }
        $idx = $grid.SelectedRows[0].Index
        if ($idx -lt 0 -or $idx -ge $registry.companies.Count) { return $null }
        return @{ Index = $idx; Entry = $registry.companies[$idx] }
    }

    # --- Add ---------------------------------------------------------------
    $btnAdd.Add_Click({
        $entry = Show-CompanyEditDialog -Title 'Add Company'
        if (-not $entry) { return }
        $existing = $registry.companies | Where-Object { $_.alias.ToLower() -eq $entry.alias.ToLower() }
        if ($existing) {
            [System.Windows.Forms.MessageBox]::Show("Alias '$($entry.alias)' is already in use.", 'Duplicate alias', 'OK', 'Warning') | Out-Null
            return
        }
        $registry.companies = @($registry.companies) + @($entry)
        & $markDirty
        & $refreshGrid
    })

    # --- Edit --------------------------------------------------------------
    $btnEdit.Add_Click({
        $sel = & $getSelected
        if (-not $sel) {
            [System.Windows.Forms.MessageBox]::Show('Select a row first.', 'No selection', 'OK', 'Information') | Out-Null
            return
        }
        $entry = Show-CompanyEditDialog -Title "Edit Company: $($sel.Entry.alias)" -Existing $sel.Entry
        if (-not $entry) { return }
        $registry.companies[$sel.Index] = $entry
        & $markDirty
        & $refreshGrid
    })

    # --- Delete ------------------------------------------------------------
    $btnDelete.Add_Click({
        $sel = & $getSelected
        if (-not $sel) {
            [System.Windows.Forms.MessageBox]::Show('Select a row first.', 'No selection', 'OK', 'Information') | Out-Null
            return
        }
        $alias = $sel.Entry.alias
        $confirm = [System.Windows.Forms.MessageBox]::Show("Delete '$alias'?", 'Confirm delete', 'YesNo', 'Question')
        if ($confirm -ne 'Yes') { return }
        $registry.companies = @($registry.companies | Where-Object { $_.alias -ne $alias })
        & $markDirty
        & $refreshGrid
    })

    # --- Test --------------------------------------------------------------
    $btnTest.Add_Click({
        $sel = & $getSelected
        if (-not $sel) {
            [System.Windows.Forms.MessageBox]::Show('Select a row first.', 'No selection', 'OK', 'Information') | Out-Null
            return
        }
        if ($script:dirty) {
            $confirm = [System.Windows.Forms.MessageBox]::Show('You have unsaved changes. Save before testing?', 'Save first?', 'YesNo', 'Question')
            if ($confirm -ne 'Yes') { return }
            $btnSave.PerformClick()
            if ($script:dirty) { return }
        }
        $entry = $registry.companies[$sel.Index]
        $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
        $btnTest.Enabled = $false
        try {
            $plain = ''
            if ($entry.passwordEnc) {
                try { $plain = Unprotect-PasswordViaHelper -HelperPath $DpapiHelperPath -Blob $entry.passwordEnc }
                catch {
                    [System.Windows.Forms.MessageBox]::Show("Could not decrypt the stored password: $_`n`nFix via Edit > tick 'Change password'.", 'Decrypt failed', 'OK', 'Error') | Out-Null
                    return
                }
            }
            $result = Invoke-LoadCompanyViaAgent -RegistryPath $RegistryPath -FolderId $entry.folderId -Username $entry.username -Password $plain
            if ($result.ok) {
                [System.Windows.Forms.MessageBox]::Show("OK - $($result.message)", "Test passed: $($entry.alias)", 'OK', 'Information') | Out-Null
            } else {
                [System.Windows.Forms.MessageBox]::Show("FAILED - $($result.message)", "Test failed: $($entry.alias)", 'OK', 'Warning') | Out-Null
            }
        } finally {
            $form.Cursor = [System.Windows.Forms.Cursors]::Default
            $btnTest.Enabled = $true
        }
    })

    # --- Save --------------------------------------------------------------
    # Bulletproof password handling: only call DPAPI Protect when we actually have non-empty
    # plaintext. Using explicit string-length check rather than truthy coercion to avoid the
    # subtle hashtable-value oddities that bit the previous version.
    $btnSave.Add_Click({
        try {
            foreach ($c in $registry.companies) {
                # Resolve plaintext password (if user is replacing/setting it). Use defensive
                # type coercion so a missing/null value reads as empty string, never $null.
                $plain = ''
                if ($c.ContainsKey('_plaintextPassword') -and $null -ne $c._plaintextPassword) {
                    $plain = [string]$c._plaintextPassword
                }
                $changed = ($c.ContainsKey('_passwordChanged') -and $c._passwordChanged -eq $true)

                if ($changed) {
                    # Protect returns $null on empty input (no-op) so we never call the helper
                    # with empty plaintext. If we get a real blob, store it; otherwise drop any
                    # existing passwordEnc (the user cleared the password).
                    $enc = Protect-PasswordViaHelper -HelperPath $DpapiHelperPath -Plaintext $plain
                    if ($enc) {
                        $c.passwordEnc = $enc
                    } elseif ($c.ContainsKey('passwordEnc')) {
                        $c.Remove('passwordEnc') | Out-Null
                    }
                }
                # Always strip transient fields, even on entries we didn't touch.
                if ($c.ContainsKey('_passwordChanged'))   { $c.Remove('_passwordChanged')   | Out-Null }
                if ($c.ContainsKey('_plaintextPassword')) { $c.Remove('_plaintextPassword') | Out-Null }
                # Drop empty passwordEnc fields entirely - keeps the JSON clean and avoids
                # later passing `""` to DPAPI as a blob.
                if ($c.ContainsKey('passwordEnc') -and [string]::IsNullOrEmpty($c.passwordEnc)) {
                    $c.Remove('passwordEnc') | Out-Null
                }
            }
            Write-CompanyRegistry -Path $RegistryPath -Registry $registry
            & $markClean
            $word = if ($registry.companies.Count -eq 1) { 'company' } else { 'companies' }
            [System.Windows.Forms.MessageBox]::Show("Saved $($registry.companies.Count) $word.", 'Saved', 'OK', 'Information') | Out-Null
            & $refreshGrid
        } catch {
            [System.Windows.Forms.MessageBox]::Show("Save failed: $_", 'Error', 'OK', 'Error') | Out-Null
        }
    })

    # --- Close (with unsaved-change confirmation) --------------------------
    $btnClose.Add_Click({
        if ($script:dirty) {
            $confirm = [System.Windows.Forms.MessageBox]::Show('You have unsaved changes. Close anyway?', 'Unsaved changes', 'YesNo', 'Warning')
            if ($confirm -ne 'Yes') { return }
        }
        $form.Close()
    })
    $form.Add_FormClosing({
        param($s, $e)
        if ($script:dirty -and $e.CloseReason -eq 'UserClosing') {
            $confirm = [System.Windows.Forms.MessageBox]::Show('You have unsaved changes. Close anyway?', 'Unsaved changes', 'YesNo', 'Warning')
            if ($confirm -ne 'Yes') { $e.Cancel = $true }
        }
    })

    [void]$form.ShowDialog()
}
