param([Parameter(Mandatory)][string]$PackageDirectory,[switch]$Recover)
$ErrorActionPreference='Stop'
# Historical entry point. All maintenance now uses the same manifest, journal,
# ownership checks, readiness verification and program-only rollback.
& (Join-Path $PSScriptRoot 'install-transactional-update.ps1') -PackageDirectory $PackageDirectory -Recover:$Recover
