$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'owned-process-metrics.ps1')
$taskRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskDirectory=Join-Path $taskRepo ('artifacts/performance-metrics-test-'+[Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $taskDirectory | Out-Null
$taskScript=Join-Path $taskDirectory 'owned-child.cjs'
@'
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const stop=path.join(__dirname,'stop-child');
const code='const fs=require("node:fs");setInterval(()=>{if(fs.existsSync(process.argv[1])){const until=Date.now()+80;while(Date.now()<until){}process.exit(0)}},20);setTimeout(()=>process.exit(0),15000)';
const child=spawn(process.execPath,['-e',code,stop],{windowsHide:true,stdio:'ignore'});
child.on('exit',code=>fs.writeFileSync(path.join(__dirname,'child-exited.json'),JSON.stringify({code})));
fs.writeFileSync(path.join(__dirname,'ready.json'),JSON.stringify({rootPid:process.pid,childPid:child.pid}));
setTimeout(()=>{child.kill();},15000);
'@|Set-Content -LiteralPath $taskScript -Encoding utf8
$taskChild=Start-Process (Get-Command node -CommandType Application | Select-Object -First 1).Source -ArgumentList ('"'+$taskScript+'"') -WindowStyle Hidden -PassThru
$taskTracked=@{}
try {
    for($taskTry=0;$taskTry -lt 100 -and -not(Test-Path -LiteralPath (Join-Path $taskDirectory 'ready.json'));$taskTry++){Start-Sleep -Milliseconds 50}
    $taskReady=Get-Content -LiteralPath (Join-Path $taskDirectory 'ready.json') -Raw|ConvertFrom-Json
    if($taskReady.rootPid -ne $taskChild.Id){throw 'Fixture ownership changed'}
    $taskRoot=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskChild.Id) -Property ProcessId,CreationDate
    $taskRoots=@{([string]$taskChild.Id)=$taskRoot.CreationDate.ToUniversalTime().Ticks};$taskSeen=@{}
    $taskSample=Get-OwnedProcessSample -Roots $taskRoots -Seen $taskSeen -Tracked $taskTracked
    $taskIds=@($taskSample.processes|ForEach-Object {$_.pid})
    if($taskReady.childPid -notin $taskIds -or $taskReady.rootPid -notin $taskIds){throw ('Owned descendant tree was incomplete: '+(@{expectedRoot=$taskReady.rootPid;expectedChild=$taskReady.childPid;actualIds=$taskIds;trackedCount=$taskSeen.Count}|ConvertTo-Json -Compress))}
    foreach($taskMember in $taskSample.processes){if($taskMember.pid -ne $taskReady.rootPid -and $taskMember.parentPid -notin $taskIds){throw 'Unrelated process was included in the fixture tree'}}
    if(@($taskSample.processes|Where-Object {$_.unavailable}).Count){throw 'Owned process counters were unavailable'}
    if($null -ne $taskSample.wakeups){throw 'Unavailable wakeups became a fabricated value'}
    $taskWrongRoots=@{([string]$taskChild.Id)=($taskRoot.CreationDate.ToUniversalTime().Ticks+1)}
    $taskWrong=Get-OwnedProcessSample -Roots $taskWrongRoots -Seen @{} -Tracked @{}
    if(@($taskWrong.processes).Count){throw 'A reused or mismatched root identity admitted a process'}
    $taskOriginal=@($taskSample.processes|Where-Object {$_.pid -eq $taskReady.childPid})[0]
    $taskAfter=Get-OwnedProcessSample -Roots $taskRoots -Seen $taskSeen -Tracked $taskTracked -HandlesPinned {
        $taskKey=([string]$taskReady.childPid)+':'+$taskOriginal.creationTicks
        if(-not $taskTracked.ContainsKey($taskKey)){throw 'Original child handle was not pinned before counter reads'}
        Set-Content -LiteralPath (Join-Path $taskDirectory 'stop-child') -Value 'Owned fixture: normal child exit before live counter reads'
        for($taskTry=0;$taskTry -lt 100 -and -not(Test-Path -LiteralPath (Join-Path $taskDirectory 'child-exited.json'));$taskTry++){Start-Sleep -Milliseconds 50}
        if(-not(Test-Path -LiteralPath (Join-Path $taskDirectory 'child-exited.json'))){throw 'Owned child did not exit before counter reads'}
    }
    $taskExit=Get-Content -LiteralPath (Join-Path $taskDirectory 'child-exited.json') -Raw|ConvertFrom-Json
    if($taskExit.code -ne 0){throw 'Owned metrics child did not exit normally'}
    $taskFinal=@($taskAfter.processes|Where-Object {$_.pid -eq $taskReady.childPid})[0]
    if($taskFinal.lifecycle -ne 'exited' -or -not $taskFinal.handlePinned -or $taskFinal.unavailable -or $taskFinal.creationTicks -ne $taskOriginal.creationTicks -or $taskFinal.cpuSeconds -lt $taskOriginal.cpuSeconds -or $taskFinal.exitCode -ne 0 -or -not $taskFinal.exitedAt){throw 'Original exited child CPU was not retained through its kernel handle'}
    foreach($taskMetric in @('workingSetBytes','privateBytes','handles','threads')){if($null -ne $taskFinal[$taskMetric]){throw 'Exited child gained fabricated live counters'}}
    $taskAgain=Get-OwnedProcessSample -Roots $taskRoots -Seen $taskSeen -Tracked $taskTracked
    if(@($taskAgain.processes|Where-Object {$_.pid -eq $taskReady.childPid}).Count){throw 'Final exit record was duplicated'}
    $taskKey=([string]$taskReady.childPid)+':'+$taskOriginal.creationTicks
    if($taskTracked.ContainsKey($taskKey)){throw 'Original exited handle was retained after final accounting'}
    @{passed=$true;synthetic=$true;ownedProcessCount=$taskIds.Count;reusedIdentityRefused=$true;finalCpuFromOriginalHandle=$true;exitBetweenPinningAndCounters=$true;finalExitRecordedOnce=$true;exitedHandleReleased=$true;accountsUsed=0}|ConvertTo-Json -Compress
} finally {
    # The process object is the handle returned by this test's own launch.
    try {if(-not $taskChild.HasExited){$taskChild.Kill($true);if(-not $taskChild.WaitForExit(6000)){throw 'Owned metrics fixture did not exit'}}}
    finally {Close-OwnedProcessMeasurements $taskTracked}
}
