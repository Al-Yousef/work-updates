param([ValidateSet('baseline','final')][string]$Mode='final')
$ErrorActionPreference='Stop'
$taskNative=Split-Path -Parent $PSScriptRoot
$taskRepo=[IO.Path]::GetFullPath((Join-Path $taskNative '../..'))
. (Join-Path $taskRepo 'scripts/dev-paths.ps1')
$taskNode=Get-HyphenNode
$taskFixture=Join-Path $taskRepo ('artifacts/responsiveness-'+$Mode+'-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $taskFixture -Force | Out-Null
& python -c "from PIL import Image; import sys; Image.new('RGBA',(4096,4096),(40,100,200,255)).save(sys.argv[1])" (Join-Path $taskFixture 'large-preview.png')
if($LASTEXITCODE -ne 0){throw 'Large thumbnail fixture could not be created'}
$taskArguments=@((Join-Path $taskRepo 'scripts/native-reply-fixture.cjs'),$taskFixture,'--many-chats','--ux-audit','--details-delay-ms','1500','--send-delay-ms','2000','--attach-delay-ms','1500')
if($Mode -eq 'final'){$taskArguments+='--long-history'}
$taskChild=Start-Process -FilePath $taskNode -ArgumentList $taskArguments -WorkingDirectory $taskRepo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskFixture 'stdout.log') -RedirectStandardError (Join-Path $taskFixture 'stderr.log') -PassThru
try {
    for($taskAttempt=0;$taskAttempt -lt 50 -and -not(Test-Path -LiteralPath (Join-Path $taskFixture 'fixture-ready.json'));$taskAttempt++){Start-Sleep -Milliseconds 100}
    if(-not(Test-Path -LiteralPath (Join-Path $taskFixture 'fixture-ready.json'))){throw 'Synthetic fixture did not start'}
    & (Join-Path $taskNative 'build/candidate/native-responsiveness-tests.exe') (Join-Path $taskFixture 'native-control.info') $Mode
    if($LASTEXITCODE -ne 0){throw 'Responsiveness test failed'}
} finally {
    for($taskAttempt=0;$taskAttempt -lt 30 -and -not $taskChild.HasExited;$taskAttempt++){
        if(Test-Path -LiteralPath (Join-Path $taskFixture 'native-control.info')){& $taskNode (Join-Path $taskRepo 'scripts/native-control.cjs') (Join-Path $taskFixture 'native-control.info') quitIfIdle | Out-Null}
        if(-not $taskChild.WaitForExit(100)){Start-Sleep -Milliseconds 100}
    }
    if(-not $taskChild.WaitForExit(6000)){throw 'Disposable fixture did not exit after its idle shutdown'}
}
