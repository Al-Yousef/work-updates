$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'owned-process-metrics.ps1')
$taskRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskDirectory=Join-Path $taskRepo ('artifacts/performance-metrics-test-'+[Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $taskDirectory | Out-Null
$taskScript=Join-Path $taskDirectory 'owned-child.cjs'
@'
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{windowsHide:true,stdio:'ignore'});
fs.writeFileSync(path.join(__dirname,'ready.json'),JSON.stringify({rootPid:process.pid,childPid:child.pid}));
setTimeout(()=>{child.kill();},15000);
'@|Set-Content -LiteralPath $taskScript -Encoding utf8
$taskChild=Start-Process (Get-Command node).Source -ArgumentList ('"'+$taskScript+'"') -WindowStyle Hidden -PassThru
try {
    for($taskTry=0;$taskTry -lt 100 -and -not(Test-Path -LiteralPath (Join-Path $taskDirectory 'ready.json'));$taskTry++){Start-Sleep -Milliseconds 50}
    $taskReady=Get-Content -LiteralPath (Join-Path $taskDirectory 'ready.json') -Raw|ConvertFrom-Json
    if($taskReady.rootPid -ne $taskChild.Id){throw 'Fixture ownership changed'}
    $taskRoot=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskChild.Id) -Property ProcessId,CreationDate
    $taskRoots=@{([string]$taskChild.Id)=$taskRoot.CreationDate.ToUniversalTime().Ticks};$taskSeen=@{}
    $taskSample=Get-OwnedProcessSample -Roots $taskRoots -Seen $taskSeen
    $taskIds=@($taskSample.processes|ForEach-Object {$_.pid})
    if($taskReady.childPid -notin $taskIds -or $taskReady.rootPid -notin $taskIds){throw ('Owned descendant tree was incomplete: '+(@{expectedRoot=$taskReady.rootPid;expectedChild=$taskReady.childPid;actualIds=$taskIds;trackedCount=$taskSeen.Count}|ConvertTo-Json -Compress))}
    foreach($taskMember in $taskSample.processes){if($taskMember.pid -ne $taskReady.rootPid -and $taskMember.parentPid -notin $taskIds){throw 'Unrelated process was included in the fixture tree'}}
    if(@($taskSample.processes|Where-Object {$_.unavailable}).Count){throw 'Owned process counters were unavailable'}
    if($null -ne $taskSample.wakeups){throw 'Unavailable wakeups became a fabricated value'}
    $taskWrongRoots=@{([string]$taskChild.Id)=($taskRoot.CreationDate.ToUniversalTime().Ticks+1)}
    $taskWrong=Get-OwnedProcessSample -Roots $taskWrongRoots -Seen @{}
    if(@($taskWrong.processes).Count){throw 'A reused or mismatched root identity admitted a process'}
    @{passed=$true;synthetic=$true;ownedProcessCount=$taskIds.Count;reusedIdentityRefused=$true;accountsUsed=0}|ConvertTo-Json -Compress
} finally {
    # The process object is the handle returned by this test's own launch.
    if(-not $taskChild.HasExited){$taskChild.Kill($true);if(-not $taskChild.WaitForExit(6000)){throw 'Owned metrics fixture did not exit'}}
}
