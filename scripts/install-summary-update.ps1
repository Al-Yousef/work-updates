param([switch]$Start, [ValidateSet('0.4.2','0.4.3','0.4.4')][string]$Version='0.4.2', [ValidateSet('build/win-unpacked','followup-build/win-unpacked','catchup-build/win-unpacked')][string]$BuildSubdir='build/win-unpacked')
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'dev-paths.ps1')
$taskInstallRoot = (Get-HyphenInstallRoot)
$taskOutput = [IO.Path]::GetFullPath((Join-Path $taskRepo 'artifacts/ai-summary-install'))
$taskBuild = Join-Path $taskOutput $BuildSubdir
$taskDesktop = Join-Path $taskInstallRoot 'desktop'
$taskPrevious = Join-Path $taskInstallRoot ('desktop.before-' + $Version)
$taskFailed = Join-Path $taskInstallRoot ('desktop.failed-' + $Version)
$taskStateFile = Join-Path $taskInstallRoot 'data/desktop/state.json'
$taskAudit = if ($Version -eq '0.4.2') { 'desktop-audit.json' } else { 'desktop-audit-' + $Version + '.json' }
if (-not (Test-Path -LiteralPath (Join-Path $taskOutput $taskAudit))) { throw 'Packaged audit missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $taskBuild 'resources/app.asar'))) { throw 'Build missing.' }
foreach ($taskTarget in @($taskDesktop,$taskPrevious,$taskFailed,$taskStateFile)) {
  if (-not ([IO.Path]::GetFullPath($taskTarget)).StartsWith($taskInstallRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected install target.' }
}
$taskRunning = @(Get-Process -Name 'Work Updates' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $taskDesktop 'Work Updates.exe') })
if ($taskRunning.Count) { throw 'Quit the existing Work Updates app before installing. No process was stopped.' }
if (Test-Path -LiteralPath $taskPrevious) { throw 'Previous-install directory already exists. No files were replaced.' }
if (Test-Path -LiteralPath $taskFailed) { throw 'Failed-install directory already exists. No files were replaced.' }
$taskState = Get-Content -LiteralPath $taskStateFile -Raw | ConvertFrom-Json -AsHashtable
if (@($taskState.tasks | Where-Object { $_.status -in @('working','starting') }).Count) { throw 'An app-owned task is active.' }
$taskFinalState = Join-Path $taskOutput ('before-install/final-state-' + $Version + '.json')
Copy-Item -LiteralPath $taskStateFile -Destination $taskFinalState
$taskState.settings.aiSummaries = $true
$taskStateJSON = $taskState | ConvertTo-Json -Depth 100 -Compress
try {
  Move-Item -LiteralPath $taskDesktop -Destination $taskPrevious
  Copy-Item -LiteralPath $taskBuild -Destination $taskDesktop -Recurse
  [IO.File]::WriteAllText($taskStateFile + '.tmp', $taskStateJSON, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath ($taskStateFile + '.tmp') -Destination $taskStateFile -Force
} catch {
  # Preserve both programs; restore the previous one without deleting any state.
  if ((Test-Path -LiteralPath $taskDesktop) -and (Test-Path -LiteralPath $taskPrevious)) {
    Move-Item -LiteralPath $taskDesktop -Destination $taskFailed
  }
  if (Test-Path -LiteralPath $taskPrevious) { Move-Item -LiteralPath $taskPrevious -Destination $taskDesktop }
  Copy-Item -LiteralPath $taskFinalState -Destination $taskStateFile -Force
  throw
}
if ($Start) { Start-Process -FilePath (Join-Path $taskDesktop 'Work Updates.exe') -ArgumentList '--hidden' -WindowStyle Hidden }
[pscustomobject]@{InstalledVersion=$Version;AISummaries=$true;PreviousProgram=$taskPrevious;Tasks=$taskState.tasks.Count;Started=[bool]$Start} | ConvertTo-Json -Compress
