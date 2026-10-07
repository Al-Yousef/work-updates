param([Parameter(Mandatory)][string]$PackageDirectory,[switch]$Recover)
$ErrorActionPreference='Stop'
# UI/launcher updates share the backend transaction. The resident Explorer DLL
# is separately managed and is never replaced by this entry point.
$taskRepo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
& (Join-Path $taskRepo 'scripts/install-transactional-update.ps1') -PackageDirectory $PackageDirectory -Recover:$Recover
