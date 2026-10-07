param([ValidateRange(6,120)][int]$SecondsPerPhase=30,[ValidateRange(500,5000)][int]$SampleIntervalMs=1000,
    [ValidateSet(100,500,1500)][int[]]$ChatCounts=@(100,500,1500),
    [ValidateRange(0,3600)][int]$SoakSeconds=0,[string]$OutputDirectory='')
$ErrorActionPreference='Stop'
if($env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows'){throw 'This isolated native pilot runs only on the Windows CI runner. Do not work around a local executable-policy block.'}
$taskRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'owned-process-metrics.ps1')
. (Join-Path $PSScriptRoot 'dev-paths.ps1')
. (Join-Path $PSScriptRoot 'performance-press-proof.ps1')
$taskNode=Get-HyphenNode
$taskElectron=Join-Path $taskRepo 'node_modules/electron/dist/electron.exe'
$taskCandidate=Join-Path $taskRepo 'native/windows/build/candidate'
$taskNative=Join-Path $taskCandidate 'Native Hover.exe'
& $taskNode -e "require('./scripts/native-build-audit.cjs').verifyCandidate(process.argv[1])" $taskCandidate
if($LASTEXITCODE -ne 0){throw 'A current verified native candidate is required'}
$taskAllowedOutput=[IO.Path]::GetFullPath((Join-Path $taskRepo 'artifacts/performance'))+[IO.Path]::DirectorySeparatorChar
$taskOutput=if($OutputDirectory){[IO.Path]::GetFullPath($OutputDirectory)}else{Join-Path $taskAllowedOutput ([Guid]::NewGuid().ToString())}
if(-not $taskOutput.StartsWith($taskAllowedOutput,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $taskOutput)){throw 'Performance output must be a new directory inside this checkout artifacts/performance'}
if($SoakSeconds -gt 0 -and $SoakSeconds -lt 300){throw 'A growth check requires at least five minutes'}
if(@($ChatCounts|Select-Object -Unique).Count -ne $ChatCounts.Count){throw 'Repeated workload counts are not independent runs'}
New-Item -ItemType Directory -Path $taskOutput | Out-Null
$taskHardware=Get-CimInstance Win32_ComputerSystem -Property Manufacturer,Model,NumberOfLogicalProcessors,TotalPhysicalMemory
$taskWindows=Get-CimInstance Win32_OperatingSystem -Property Caption,Version,BuildNumber
@{schema=1;runId=[Guid]::NewGuid().ToString();startedAt=(Get-Date).ToUniversalTime().ToString('o');counts=@($ChatCounts);soakSeconds=$SoakSeconds;synthetic=$true;accountsUsed=0;modelCalls=0;installedAppChanged=$false;revision=(& git -C $taskRepo rev-parse HEAD);hardware=@{manufacturer=$taskHardware.Manufacturer;model=$taskHardware.Model;logicalCores=$taskHardware.NumberOfLogicalProcessors;physicalMemoryBytes=$taskHardware.TotalPhysicalMemory};windows=@{caption=$taskWindows.Caption;version=$taskWindows.Version;build=$taskWindows.BuildNumber};sampleIntervalMs=$SampleIntervalMs;secondsPerPhase=$SecondsPerPhase;input='simulated Win32 messages to owned isolated windows';wakeups='unavailable without ETW'} | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $taskOutput 'metadata.json') -Encoding utf8
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class HyphenPerfWindows {
 public delegate bool Callback(IntPtr window,IntPtr data);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb,IntPtr data);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr w,StringBuilder n,int c);
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr w,int id);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr w,int show);
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int x; public int y; }
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr w,ref Point p);
 [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr w,uint m,IntPtr a,IntPtr b,uint flags,uint timeout,out UIntPtr result);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] public static extern IntPtr SendText(IntPtr w,uint m,IntPtr a,string b,uint flags,uint timeout,out UIntPtr result);
}
'@
function Send-PerfMessage([IntPtr]$Window,[uint32]$Message,[IntPtr]$W=[IntPtr]::Zero,[IntPtr]$L=[IntPtr]::Zero){
    $taskResult=[UIntPtr]::Zero
    if([HyphenPerfWindows]::SendMessageTimeout($Window,$Message,$W,$L,2,2000,[ref]$taskResult) -eq [IntPtr]::Zero){throw 'Owned native message did not return within two seconds'}
}
function Get-PerfState([IntPtr]$Panel,[string]$Run){Send-PerfMessage $Panel (0x8000+215);return Get-Content -LiteralPath (Join-Path $Run 'ux-state.json') -Raw | ConvertFrom-Json}
function Click-PerfHit([IntPtr]$Panel,$Hit,[string]$Run=''){
    $taskScale=$script:taskDpi/96.0
    $taskX=[int](($Hit.box[0]+$Hit.box[2])*$taskScale/2);$taskY=[int](($Hit.box[1]+$Hit.box[3])*$taskScale/2)
    $taskPoint=[IntPtr](($taskY -shl 16) -bor ($taskX -band 65535))
    $taskWatch=[Diagnostics.Stopwatch]::StartNew();Send-PerfMessage $Panel 0x201 ([IntPtr]1) $taskPoint
    if($Run){
        $taskDown=Get-PerfState $Panel $Run
        if($taskDown.lastPress.disposition -ne 'down' -or $taskDown.lastPress.expectedKey -ne $Hit.key){Send-PerfMessage $Panel 0x1F}
    }
    Send-PerfMessage $Panel 0x202 ([IntPtr]::Zero) $taskPoint;$taskWatch.Stop()
    if($Run){return @{ms=$taskWatch.Elapsed.TotalMilliseconds;down=$taskDown}}
    return $taskWatch.Elapsed.TotalMilliseconds
}
foreach($taskCount in $ChatCounts){
    $taskRun=Join-Path $taskOutput ([string]$taskCount);New-Item -ItemType Directory -Path $taskRun | Out-Null
    & python (Join-Path $PSScriptRoot 'performance-source-fixture.py') (Join-Path $taskRun 'source') $taskCount
    if($LASTEXITCODE -ne 0){throw 'Synthetic source creation failed'}
    & python -c 'from PIL import Image; import sys; Image.new("RGB",(4096,4096),(40,100,200)).save(sys.argv[1])' (Join-Path $taskRun 'large-preview.png')
    if($LASTEXITCODE -ne 0){throw 'Synthetic image creation failed'}
    $env:HYPHEN_PERFORMANCE_RUN=$taskRun
    $env:WORK_UPDATES_PYTHON=(Get-Command python).Source
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $taskProfile=Join-Path $taskRun 'profile'
    $taskBackend=$null;$taskShell=$null;$taskCollector=$null;$taskPanel=[IntPtr]::Zero;$taskTrigger=[IntPtr]::Zero
    try {
        $taskBackendArgs=@('-r',('"'+(Join-Path $PSScriptRoot 'performance-preload.cjs')+'"'),('"'+$taskRepo+'"'),'--demo','--native-backend','--hidden','--data-dir',('"'+$taskProfile+'"'))
        $taskBackend=Start-Process $taskElectron -ArgumentList $taskBackendArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRun 'backend.stdout.txt') -RedirectStandardError (Join-Path $taskRun 'backend.stderr.txt')
        $taskDescriptor=Join-Path $taskProfile 'native-control.info'
        $taskReady=Join-Path $taskRun 'performance-ready.json'
        for($taskTry=0;$taskTry -lt 300;$taskTry++){
            if($taskBackend.HasExited){throw 'Owned performance backend exited before readiness'}
            try{$taskRead=Get-Content -LiteralPath $taskReady -Raw | ConvertFrom-Json;if($taskRead.chatCount -eq $taskCount -and $taskRead.collectorPid -and (Test-Path -LiteralPath $taskDescriptor)){break}}catch{}
            Start-Sleep -Milliseconds 100
        }
        if($taskRead.chatCount -ne $taskCount -or -not $taskRead.collectorPid){throw 'Collector did not load the exact synthetic source count'}
        $taskCollector=Get-Process -Id $taskRead.collectorPid
        $taskNativeArgs=@('--isolated-session','--no-auto-attach','--show','--audit-reduced-motion','--audit-capture',('"'+(Join-Path $taskRun 'native.png')+'"'),'--bridge',('"'+$taskDescriptor+'"'))
        $taskShell=Start-Process $taskNative -ArgumentList $taskNativeArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRun 'native.stdout.txt') -RedirectStandardError (Join-Path $taskRun 'native.stderr.txt')
        $taskHandles=@{}
        $taskFinder=[HyphenPerfWindows+Callback]{param($window,$data);[uint32]$taskOwner=0;[void][HyphenPerfWindows]::GetWindowThreadProcessId($window,[ref]$taskOwner);if($taskOwner -eq $taskShell.Id){$taskName=[Text.StringBuilder]::new(80);[void][HyphenPerfWindows]::GetClassName($window,$taskName,80);$taskHandles[$taskName.ToString()]=$window};return $true}
        for($taskTry=0;$taskTry -lt 200;$taskTry++){[void][HyphenPerfWindows]::EnumWindows($taskFinder,[IntPtr]::Zero);if($taskHandles.ContainsKey('NativeHoverPanel') -and $taskHandles.ContainsKey('NativeHoverTrigger')){break};Start-Sleep -Milliseconds 100}
        $taskPanel=$taskHandles['NativeHoverPanel'];$taskTrigger=$taskHandles['NativeHoverTrigger'];if(-not $taskPanel -or -not $taskTrigger){throw 'Owned native windows were not created'}
        for($taskTry=0;$taskTry -lt 100;$taskTry++){$taskState=Get-PerfState $taskPanel $taskRun;if($taskState.connected -and @($taskState.hits|Where-Object {$_.action -eq 'card'}).Count -ge 2){break};Start-Sleep -Milliseconds 100}
        if(-not $taskState.connected){throw 'Isolated native bridge did not connect'}
        $script:taskDpi=$taskState.dpi
        $taskRoots=@{};$taskSeen=@{}
        foreach($taskProcess in @($taskBackend,$taskShell)){$taskCim=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskProcess.Id) -Property ProcessId,CreationDate;$taskRoots[[string]$taskProcess.Id]=$taskCim.CreationDate.ToUniversalTime().Ticks}
        Start-Sleep -Seconds 2
        $taskPhases=@('warm_idle','hidden_idle','active_stream','chat_switching','image_decode','messaging')
        if($SoakSeconds){$taskPhases+='navigation_reconnect_soak'}
        foreach($taskPhase in $taskPhases){
            $taskRequest=[Guid]::NewGuid().ToString();@{id=$taskRequest;phase=$taskPhase}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $taskRun 'performance-command.json') -Encoding utf8
            for($taskTry=0;$taskTry -lt 50;$taskTry++){try{$taskAck=Get-Content -LiteralPath (Join-Path $taskRun 'performance-result.json') -Raw|ConvertFrom-Json;if($taskAck.id -eq $taskRequest){break}}catch{};Start-Sleep -Milliseconds 100}
            if($taskAck.id -ne $taskRequest){throw 'Performance phase was not acknowledged'}
            [void][HyphenPerfWindows]::ShowWindow($taskPanel, $(if($taskPhase -eq 'hidden_idle'){0}else{5}))
            if($taskPhase -eq 'image_decode'){$taskState=Get-PerfState $taskPanel $taskRun;$taskHit=$taskState.hits|Where-Object {$_.action -eq 'assistant'}|Select-Object -First 1;if(-not $taskHit){throw 'Assistant image surface absent'};[void](Click-PerfHit $taskPanel $taskHit)}
            $taskSamples=@();$taskLatencies=@();$taskNativeSamples=@();$taskSelectedSources=@{};$taskWatch=[Diagnostics.Stopwatch]::StartNew();$taskIteration=0
            $taskPhaseSeconds=if($taskPhase -eq 'navigation_reconnect_soak'){$SoakSeconds}else{$SecondsPerPhase}
            while($taskWatch.Elapsed.TotalSeconds -lt $taskPhaseSeconds){
                $taskLoop=[Diagnostics.Stopwatch]::StartNew()
                if($taskPhase -in @('chat_switching','messaging','navigation_reconnect_soak')){
                    if($taskPhase -eq 'navigation_reconnect_soak'){
                        $taskPoint=[HyphenPerfWindows+Point]::new();$taskPoint.x=20;$taskPoint.y=200
                        if(-not [HyphenPerfWindows]::ClientToScreen($taskPanel,[ref]$taskPoint)){throw 'Owned panel position is unavailable'}
                        $taskWheel=if([int][Math]::Floor($taskIteration/40)%2 -eq 0){-120}else{120}
                        Send-PerfMessage $taskPanel 0x20A ([IntPtr]($taskWheel -shl 16)) ([IntPtr](($taskPoint.y -shl 16) -bor ($taskPoint.x -band 65535)))
                    }
                    $taskState=Get-PerfState $taskPanel $taskRun;$taskCards=@($taskState.hits|Where-Object {$_.action -eq 'card'});if($taskCards.Count -lt 2){throw 'Two visible source cards are required'}
                    # Exercise different original sources throughout the soak, not only two cached chats.
                    $taskHit=$taskCards[$taskIteration%$taskCards.Count];$taskClick=Click-PerfHit $taskPanel $taskHit $taskRun;$taskLatency=$taskClick.ms
                    $taskLive=Get-PerfState $taskPanel $taskRun
                    $taskProof=Get-HyphenSelectionProof $taskState $taskLive $taskHit $taskClick.down
                    $taskSelectionAccepted=$taskProof -eq 'accepted'
                    if(-not $taskSelectionAccepted){
                        $taskPress=$taskLive.lastPress
                        if($taskProof -in @('cancelled','stale_snapshot_cancelled')){
                            # A row changing between press and release is deliberately cancelled by
                            # the real input guard. Its fresh exact press record proves the guard
                            # preserved selection at the decision, independently of later feed updates.
                            # It is not an accepted selection or send sample.
                            $taskLatencies+=@{operation='cancelled_selection_press';ms=$taskLatency;reason=$(if($taskProof -eq 'stale_snapshot_cancelled'){'target_changed_before_press'}else{'target_changed_before_release'});selectionAccepted=$false}
                        }else{
                            @{count=$taskCount;phase=$taskPhase;iteration=$taskIteration;expected=$taskHit;before=$taskState;down=$taskClick.down;after=$taskLive}|ConvertTo-Json -Depth 12|Set-Content -LiteralPath (Join-Path $taskRun 'selection-failure.json') -Encoding utf8
                            throw 'Source changed during the benchmark click without a verified cancelled press'
                        }
                    }else{$taskSelectedSources[[string]$taskLive.source]=$true;$taskLatencies+=@{operation='chat_selection_handler';ms=$taskLatency;detailPending=$taskLive.detailPending;selectionAccepted=$true}}
                    if($taskSelectionAccepted -and $taskPhase -eq 'messaging' -and -not $taskLive.pending){
                        if($taskLive.canDraft){
                            $taskScale=$script:taskDpi/96.0
                            $taskComposerHit=@{box=@($taskLive.composerBoundsPx|ForEach-Object {$_/$taskScale})}
                            $taskFocusLatency=Click-PerfHit $taskPanel $taskComposerHit
                            $taskFocusState=Get-PerfState $taskPanel $taskRun
                            if(-not $taskFocusState.composerFocused -or $taskFocusState.source -ne $taskLive.source -or $taskFocusState.selected -ne $taskLive.selected){
                                throw 'Owned composer focus was not confirmed on the selected source'
                            }
                            $taskLatencies+=@{operation='composer_focus_handler';ms=$taskFocusLatency;sourceSelectionVerified=$true;provider='local owned-window focus; network/model latency excluded'}
                        }
                        $taskEditor=[HyphenPerfWindows]::GetDlgItem($taskPanel,201);$taskTextResult=[UIntPtr]::Zero
                        if([HyphenPerfWindows]::SendText($taskEditor,0xC,[IntPtr]::Zero,'Synthetic benchmark follow-up',2,2000,[ref]$taskTextResult) -eq [IntPtr]::Zero){throw 'Owned composer did not accept the fixture text'}
                        $taskLive=Get-PerfState $taskPanel $taskRun;$taskSend=$taskLive.hits|Where-Object {$_.action -eq 'send' -and $_.enabled}|Select-Object -First 1
                        if($taskSend){$taskLatencies+=@{operation='send_handler';ms=(Click-PerfHit $taskPanel $taskSend);provider='synthetic transport; network/model latency excluded'}}
                    }
                }
                $taskSample=Get-OwnedProcessSample -Roots $taskRoots -Seen $taskSeen
                $taskSamples+=,$taskSample;$taskIteration++
                if($taskPhase -eq 'navigation_reconnect_soak'){
                    $taskState=Get-PerfState $taskPanel $taskRun
                    $taskNativeSamples+=@{at=$taskSample.at;connected=$taskState.connected;cachedChats=$taskState.cachedChats;bubbleLayouts=$taskState.bubbleLayouts;imageBitmaps=$taskState.imageBitmaps;loadingImages=$taskState.loadingImages}
                }
                $taskWait=$SampleIntervalMs-[int]$taskLoop.Elapsed.TotalMilliseconds;if($taskWait -gt 0){Start-Sleep -Milliseconds $taskWait}
            }
            $taskSamples|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $taskRun ($taskPhase+'.samples.json')) -Encoding utf8
            if($taskPhase -in @('chat_switching','messaging','navigation_reconnect_soak') -and @($taskLatencies|Where-Object {$_.operation -eq 'chat_selection_handler'}).Count -eq 0){throw 'Performance phase had no accepted source selections'}
            $taskState=Get-PerfState $taskPanel $taskRun
            $taskFixtureState=if(Test-Path -LiteralPath (Join-Path $taskRun 'performance-soak.json')){Get-Content -LiteralPath (Join-Path $taskRun 'performance-soak.json') -Raw|ConvertFrom-Json}else{$null}
            @{count=$taskCount;phase=$taskPhase;latencies=$taskLatencies;distinctSelectedSources=$taskSelectedSources.Count;nativeSamples=$taskNativeSamples;fixture=$taskFixtureState;native=@{paintMs=$taskState.paintMs;cachedChats=$taskState.cachedChats;bubbleLayouts=$taskState.bubbleLayouts;imageBitmaps=$taskState.imageBitmaps;loadingImages=$taskState.loadingImages};measurementOverheadIncluded=$true}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $taskRun ($taskPhase+'.workload.json')) -Encoding utf8
        }
    } finally {
        $taskCleanupErrors=@()
        try{if($taskTrigger -ne [IntPtr]::Zero){Send-PerfMessage $taskTrigger 0x10}}catch{$taskCleanupErrors+='Native close was unconfirmed'}
        if($taskShell -and -not $taskShell.WaitForExit(6000)){$taskCleanupErrors+='Owned native shell did not exit normally';$taskShell.Kill($true);[void]$taskShell.WaitForExit(6000)}
        try{if($taskBackend -and -not $taskBackend.HasExited -and (Test-Path -LiteralPath $taskDescriptor)){& $taskNode (Join-Path $PSScriptRoot 'native-control.cjs') $taskDescriptor quitIfIdle | Out-Null;if($LASTEXITCODE -ne 0){$taskCleanupErrors+='Backend idle quit was refused'}}}catch{$taskCleanupErrors+='Backend close was unconfirmed'}
        if($taskBackend -and -not $taskBackend.WaitForExit(10000)){$taskCleanupErrors+='Owned backend did not exit normally';$taskBackend.Kill($true);[void]$taskBackend.WaitForExit(6000)}
        if($taskCollector -and -not $taskCollector.WaitForExit(6000)){$taskCleanupErrors+='Owned collector remained after backend shutdown';$taskCollector.Kill();[void]$taskCollector.WaitForExit(6000)}
        @{normalExit=($taskCleanupErrors.Count -eq 0);errors=$taskCleanupErrors;backendPid=$taskBackend.Id;nativePid=$taskShell.Id;collectorPid=$taskCollector.Id}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $taskRun 'cleanup.json') -Encoding utf8
        if($taskCleanupErrors.Count){throw ($taskCleanupErrors -join '; ')}
    }
}
& $taskNode (Join-Path $PSScriptRoot 'performance-report.cjs') $taskOutput
if($LASTEXITCODE -ne 0){throw 'Whole-process pilot report failed'}
Write-Output ('Synthetic whole-process pilot report: '+$taskOutput)
