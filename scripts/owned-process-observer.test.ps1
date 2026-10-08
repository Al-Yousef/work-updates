$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'owned-process-metrics.ps1')
$taskRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskDirectory=Join-Path $taskRepo ('artifacts/performance-observer-test-'+[Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $taskDirectory | Out-Null
$taskScript=Join-Path $taskDirectory 'owned-burst.cjs'
@'
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const rows=[];
const poll=setInterval(()=>{
  if(!fs.existsSync(path.join(__dirname,'start-burst')))return;
  clearInterval(poll);
  for(let i=0;i<8;i++)setTimeout(()=>{
    const child=spawn(process.execPath,['-e','const until=Date.now()+90;while(Date.now()<until){}'],{windowsHide:true,stdio:'ignore'});
    const row={pid:child.pid};rows.push(row);
    child.on('error',()=>{row.error=true});
    child.on('exit',code=>{row.code=code;if(rows.length===8&&rows.every(r=>r.code!==undefined))fs.writeFileSync(path.join(__dirname,'exited.json'),JSON.stringify(rows))});
  },i*60);
},10);
fs.writeFileSync(path.join(__dirname,'ready.json'),JSON.stringify({pid:process.pid}));
const keep=setInterval(()=>{if(fs.existsSync(path.join(__dirname,'stop-root'))){clearInterval(keep);process.exit(0)}},20);
setTimeout(()=>process.exit(0),15000);
'@|Set-Content -LiteralPath $taskScript -Encoding utf8
$taskChild=Start-Process (Get-Command node -CommandType Application | Select-Object -First 1).Source -ArgumentList ('"'+$taskScript+'"') -WindowStyle Hidden -PassThru
$taskObserver=$null
try {
    for($taskTry=0;$taskTry -lt 100 -and -not(Test-Path -LiteralPath (Join-Path $taskDirectory 'ready.json'));$taskTry++){Start-Sleep -Milliseconds 20}
    $taskReady=Get-Content -LiteralPath (Join-Path $taskDirectory 'ready.json') -Raw|ConvertFrom-Json
    if($taskReady.pid -ne $taskChild.Id){throw 'Owned fixture root changed'}
    $taskRoots=@{([string]$taskChild.Id)=$taskChild.StartTime.ToUniversalTime().Ticks}
    $taskWrongRoots=@{([string]$taskChild.Id)=($taskChild.StartTime.ToUniversalTime().Ticks+1)}
    $taskWrongRefused=$false
    try {$taskWrong=Start-OwnedProcessObserver $taskWrongRoots;$taskWrong.Dispose()} catch {$taskWrongRefused=$true}
    if(-not $taskWrongRefused){throw 'Observer admitted a mismatched original root'}
    $taskObserver=Start-OwnedProcessObserver $taskRoots
    $taskFirst=$taskObserver.Read()
    Set-Content -LiteralPath (Join-Path $taskDirectory 'start-burst') -Value 'Owned short-lived descendants between samples'
    for($taskTry=0;$taskTry -lt 250 -and -not(Test-Path -LiteralPath (Join-Path $taskDirectory 'exited.json'));$taskTry++){Start-Sleep -Milliseconds 20}
    $taskExits=@(Get-Content -LiteralPath (Join-Path $taskDirectory 'exited.json') -Raw|ConvertFrom-Json)
    if($taskExits.Count -ne 8 -or @($taskExits|Where-Object {$_.code -ne 0 -or $_.error}).Count){throw 'Owned short-lived fixture did not exit normally'}
    # No counter sample, external process handle, or CIM query runs during the
    # burst. The observer must retain each original independently of PowerShell.
    Start-Sleep -Milliseconds 100
    $taskPinnedBefore=@($taskExits|Where-Object {$taskObserver.HasPinned($_.pid)})
    if($taskPinnedBefore.Count -ne 8){throw 'Continuous discovery missed a short-lived original'}
    $taskSecond=$taskObserver.Read()
    $taskFinal=@($taskSecond.processes|Where-Object {$_.pid -in $taskExits.pid})
    if($taskFinal.Count -ne 8){throw 'Between-sample final CPU accounting was incomplete'}
    foreach($taskRow in $taskFinal){
        if($taskRow.lifecycle -ne 'exited' -or -not $taskRow.handlePinned -or $taskRow.exitCode -ne 0 -or $taskRow.cpuSeconds -le 0 -or [DateTime]$taskRow.startedAt -lt [DateTime]$taskFirst.at -or [DateTime]$taskRow.exitedAt -gt [DateTime]$taskSecond.completedAt){throw 'Short-lived original lost identity, interval, final CPU or confirmed exit'}
        foreach($taskMetric in @('workingSetBytes','privateBytes','handles','threads')){if($null -ne $taskRow[$taskMetric]){throw 'Short-lived original gained fabricated live counters'}}
        if($taskObserver.HasPinned($taskRow.pid)){throw 'Final accounted handle was not released'}
    }
    $taskThird=$taskObserver.Read()
    if(@($taskThird.processes|Where-Object {$_.pid -in $taskExits.pid}).Count){throw 'Between-sample exit was reported twice'}
    if(@($taskSecond.processes|Where-Object {$_.pid -eq $PID}).Count){throw 'Observer included its own PowerShell process'}
    # Once the observer and Node parent release the original, direct late open
    # must reproduce the destroyed-kernel-object failure retained from CI.
    $taskDestroyed=0
    foreach($taskExit in $taskExits){
        try {$taskLate=[HyphenOwnedProcessHandle]::new($taskExit.pid);$taskLate.Dispose()} catch {if($_.Exception.GetBaseException() -is [ComponentModel.Win32Exception] -and $_.Exception.GetBaseException().NativeErrorCode -eq 87){$taskDestroyed++}else{throw}}
    }
    if($taskDestroyed -ne 8){throw 'Destroyed-object regression fixture was not established'}
    $taskSamples=@($taskFirst,$taskSecond,$taskThird)
    $taskSamples|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $taskDirectory 'samples.json') -Encoding utf8
    & node -e 'const fs=require("node:fs"),s=require("./src/performance-report.cjs").summary(JSON.parse(fs.readFileSync(process.argv[1],"utf8").replace(/^\uFEFF/,"")),1);if(s.partial||s.measurementGaps||s.confirmedProcessStarts<8||s.confirmedProcessExits<8)throw Error("Actual between-sample lifecycle report was incomplete");console.log(JSON.stringify({wholeProcessReportReproduced:true,starts:s.confirmedProcessStarts,exits:s.confirmedProcessExits,gaps:s.measurementGaps}))' (Join-Path $taskDirectory 'samples.json')
    if($LASTEXITCODE -ne 0){throw 'Actual observer samples failed the unchanged report policy'}
    Set-Content -LiteralPath (Join-Path $taskDirectory 'stop-root') -Value 'Owned normal fixture shutdown'
    if(-not $taskChild.WaitForExit(5000) -or $taskChild.ExitCode -ne 0){throw 'Owned observer fixture did not exit normally'}
    @{passed=$true;synthetic=$true;betweenSampleExitedChildren=8;destroyedKernelObjectsVerified=$taskDestroyed;discoveryIntervalMs=10;maximumCaptureGapMs=$taskSecond.discovery.maximumCaptureGapMs;originalHandleLimit=256;finalCpuFromOriginalHandle=$true;nullExitedLiveCounters=$true;finalExitRecordedOnce=$true;exitedHandlesReleased=$true;reusedRootIdentityRefused=$true;wholeProcessReportReproduced=$true;accountsUsed=0}|ConvertTo-Json -Compress
} finally {
    try {if(-not $taskChild.HasExited){$taskChild.Kill($true);[void]$taskChild.WaitForExit(6000)}}
    finally {if($taskObserver){$taskObserver.Dispose()};$taskChild.Dispose()}
}
