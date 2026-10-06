param([string]$ArchivePath='')
$ErrorActionPreference='Stop'
$taskManifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'toolchain.json') -Raw | ConvertFrom-Json
$taskTools=Join-Path $PSScriptRoot '.tools'
New-Item -ItemType Directory -Path $taskTools -Force | Out-Null
if(-not $ArchivePath){
    $ArchivePath=Join-Path $taskTools ($taskManifest.directory+'.zip')
    if(-not (Test-Path -LiteralPath $ArchivePath)){
        $taskDownload=$ArchivePath+'.partial'
        Invoke-WebRequest -Uri $taskManifest.url -OutFile $taskDownload
        if((Get-FileHash -LiteralPath $taskDownload).Hash -ine $taskManifest.sha256){throw 'Compiler download digest does not match the locked release'}
        Move-Item -LiteralPath $taskDownload -Destination $ArchivePath
    }
}
if((Get-FileHash -LiteralPath $ArchivePath).Hash -ine $taskManifest.sha256){throw 'Compiler archive digest does not match the locked release'}
$taskDestination=Join-Path $taskTools $taskManifest.directory
if(Test-Path -LiteralPath $taskDestination){throw 'Toolchain directory already exists; inspect it before replacing it'}
Expand-Archive -LiteralPath $ArchivePath -DestinationPath $taskTools
if(-not (Test-Path -LiteralPath (Join-Path $taskDestination 'bin/clang-23.exe'))){throw 'The verified compiler archive did not extract as expected'}
Write-Output ('Verified toolchain ready: '+$taskManifest.tag)
