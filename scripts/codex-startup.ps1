param([switch] $Remove)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$companion = Join-Path $project 'dist\Map Live Companion.exe'
$startup = [Environment]::GetFolderPath('Startup')
if (-not $startup) { throw 'Windows did not return a per-user Startup folder.' }
$shortcutPath = Join-Path $startup 'Map Live for Codex.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ((Test-Path -LiteralPath $shortcutPath) -and $shortcut.TargetPath -ne $companion) {
    throw 'A different shortcut already uses the name Map Live for Codex.'
}

if ($Remove) {
    if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath }
    Get-Process -Name 'Map Live Companion' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $companion } |
        Stop-Process
    return
}

if (-not (Test-Path -LiteralPath $companion)) { throw 'Run npm run build to create the Windows companion.' }
$shortcut.TargetPath = $companion
$shortcut.WorkingDirectory = $project
$shortcut.Description = 'Open Map Live with Codex and enable Ctrl+Tab in Codex.'
$shortcut.Save()
Start-Process -FilePath $companion -WorkingDirectory $project -WindowStyle Hidden
Write-Output $shortcutPath
