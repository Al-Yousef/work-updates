param([string]$ToolchainDirectory='')
$ErrorActionPreference='Stop'
$taskNative=Split-Path -Parent $PSScriptRoot
$taskOutput='build/gate-tests-'+[guid]::NewGuid().ToString('N')
$taskTarget=Join-Path $taskNative $taskOutput
New-Item -ItemType Directory -Path $taskTarget -Force | Out-Null
$taskChecks=0
function Test-RejectedBuild([hashtable]$Arguments,[string]$Expected) {
    Set-Content -LiteralPath (Join-Path $taskTarget 'build-verification.json') -Value '{"built":true}'
    Set-Content -LiteralPath (Join-Path $taskTarget 'native-validation.json') -Value '{"verified":true}'
    try { & (Join-Path $taskNative 'build.ps1') -OutputDirectory $taskOutput @Arguments; throw 'Expected build rejection' }
    catch {if($_.Exception.Message -notmatch $Expected){throw}}
    foreach($taskProof in @('build-verification.json','native-validation.json')){
        if(Test-Path -LiteralPath (Join-Path $taskTarget $taskProof)){throw 'Rejected build left stale proof'}
    }
    $script:taskChecks++
}
Test-RejectedBuild @{ToolchainDirectory=(Join-Path $taskTarget 'missing')} 'Locked toolchain file missing'
Test-RejectedBuild @{PreserveAdapter=$true} 'must compile the adapter'
if(-not $ToolchainDirectory){$ToolchainDirectory=Join-Path $taskNative ('.tools/'+(Get-Content -LiteralPath (Join-Path $taskNative 'toolchain.json') -Raw | ConvertFrom-Json).directory)}
$taskFake=Join-Path $taskTarget 'fake-linker.exe'
Set-Content -LiteralPath $taskFake -Value 'wrong linker; never execute this'
Test-RejectedBuild @{ToolchainDirectory=$ToolchainDirectory;LinkerPath=$taskFake} 'does not match the locked LLD'
$taskFakeBin=Join-Path $taskTarget 'fake-toolchain/bin'
New-Item -ItemType Directory -Path $taskFakeBin -Force | Out-Null
Set-Content -LiteralPath (Join-Path $taskFakeBin 'clang-23.exe') -Value 'wrong compiler; never execute this'
Test-RejectedBuild @{ToolchainDirectory=(Split-Path -Parent $taskFakeBin)} 'digest mismatch'
Write-Output ('PASS '+$taskChecks+' failed-build gates; stale build/desktop proof invalidated')
