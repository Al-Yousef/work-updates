param([int[]]$Scales=@(96,120,144,192),[switch]$HighContrast)
$ErrorActionPreference='Stop'
$taskNative=Split-Path -Parent $PSScriptRoot
$taskRepo=[IO.Path]::GetFullPath((Join-Path $taskNative '../..'))
. (Join-Path $taskRepo 'scripts/dev-paths.ps1')
$taskNode=Get-HyphenNode
$taskRunId=Get-Date -Format 'yyyyMMdd-HHmmss'
$taskResults=@()
New-Item -ItemType Directory -Path (Join-Path $taskNative 'build/artifacts') -Force | Out-Null
foreach($taskScale in $Scales){
    $taskFixture=Join-Path $taskRepo ('artifacts/ux-audit-'+$taskRunId+'-'+$taskScale)
    New-Item -ItemType Directory -Path $taskFixture -Force | Out-Null
    $taskChild=Start-Process -FilePath $taskNode -ArgumentList @((Join-Path $taskRepo 'scripts/native-reply-fixture.cjs'),$taskFixture,'--many-chats','--ux-audit') -WorkingDirectory $taskRepo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskFixture 'stdout.log') -RedirectStandardError (Join-Path $taskFixture 'stderr.log') -PassThru
    try {
        $taskReady=Join-Path $taskFixture 'fixture-ready.json'
        for($taskAttempt=0;$taskAttempt -lt 50 -and -not(Test-Path -LiteralPath $taskReady);$taskAttempt++){Start-Sleep -Milliseconds 100}
        if(-not(Test-Path -LiteralPath $taskReady)){throw 'Synthetic fixture did not start'}
        $taskPython=if($env:WORK_UPDATES_PYTHON){(Get-Command $env:WORK_UPDATES_PYTHON -CommandType Application -ErrorAction Stop).Source}else{(Get-Command python -CommandType Application -ErrorAction Stop).Source}
        & $taskPython -c 'import pathlib,sys
from PIL import Image
for index in range(4):
    Image.new("RGB",(32,32),(40+40*index,80+20*index,120+10*index)).save(pathlib.Path(sys.argv[1])/("text-image-"+str(index)+".png"))' $taskFixture
        if($LASTEXITCODE -ne 0){throw 'Owned text-scale image fixtures were not created'}
        $taskLog=Join-Path $taskNative ('build/artifacts/ux-audit-'+$taskRunId+'-'+$taskScale+'.log')
        $taskArguments=@((Join-Path $taskFixture 'native-control.info'),$taskScale)
        if($HighContrast){$taskArguments+='--high-contrast'}
        & (Join-Path $taskNative 'build/candidate/native-ux-tests.exe') @taskArguments *> $taskLog
        $taskExit=$LASTEXITCODE
        Get-Content -LiteralPath $taskLog -Tail 3
        $taskResults+=@{scale=$taskScale;highContrast=[bool]$HighContrast;exit=$taskExit;log=$taskLog;fixture=$taskFixture}
        if($taskExit -ne 0){throw ('Native UX audit failed at '+$taskScale)}
    } finally {
        if(Test-Path -LiteralPath (Join-Path $taskFixture 'native-control.info')){& $taskNode (Join-Path $taskRepo 'scripts/native-control.cjs') (Join-Path $taskFixture 'native-control.info') quitIfIdle | Out-Null}
        if(-not $taskChild.WaitForExit(4000)){throw 'Disposable fixture did not exit after its idle shutdown'}
        $taskResults | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskNative ('build/artifacts/ux-audit-'+$taskRunId+'.json')) -Encoding utf8
    }
}
