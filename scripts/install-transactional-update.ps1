param([Parameter(Mandatory)][string]$PackageDirectory,[switch]$Recover)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dev-paths.ps1')
$taskInstall=Get-HyphenInstallRoot
$taskData=Join-Path $taskInstall 'data/desktop'
$taskPackage=[IO.Path]::GetFullPath($PackageDirectory)
$taskRepo=Split-Path -Parent $PSScriptRoot
$taskArguments=@((Join-Path $PSScriptRoot 'update-cli.cjs'),'--install-root',$taskInstall,'--data-dir',$taskData,'--package-dir',$taskPackage,'--source-root',$taskRepo)
if($Recover){$taskArguments+='--recover'}
& (Get-HyphenNode) @taskArguments
if($LASTEXITCODE -ne 0){throw 'Transactional update did not commit. Read the recovery message; private stores and program backups are preserved.'}
