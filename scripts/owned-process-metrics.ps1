function Close-OwnedProcessMeasurements([hashtable]$Tracked) {
    foreach($taskEntry in @($Tracked.Values)){$taskEntry.process.Dispose()}
    $Tracked.Clear()
}
function Get-OwnedProcessSample {
    param([Parameter(Mandatory)][hashtable]$Roots,[Parameter(Mandatory)][hashtable]$Seen,[Parameter(Mandatory)][hashtable]$Tracked)
    $taskAt=(Get-Date).ToUniversalTime().ToString('o')
    $taskRows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name)
    $taskOwned=@{}
    foreach($taskRow in $taskRows){
        $taskId=[string]$taskRow.ProcessId
        $taskCreated=$taskRow.CreationDate.ToUniversalTime().Ticks
        if(($Roots.ContainsKey($taskId) -and $Roots[$taskId] -eq $taskCreated) -or ($Seen.ContainsKey($taskId) -and $Seen[$taskId] -eq $taskCreated)){$taskOwned[$taskId]=$taskRow}
    }
    do {
        $taskAdded=$false
        foreach($taskRow in $taskRows){
            $taskId=[string]$taskRow.ProcessId
            $taskParent=[string]$taskRow.ParentProcessId
            if(-not $taskOwned.ContainsKey($taskId) -and $taskOwned.ContainsKey($taskParent) -and $taskRow.CreationDate -ge $taskOwned[$taskParent].CreationDate){$taskOwned[$taskId]=$taskRow;$taskAdded=$true}
        }
    } while($taskAdded)
    $taskSamples=@{};$taskLive=@{}
    function Get-OwnedExit($Entry) {
        if(-not $Entry.process.HasExited){throw 'Original process has no confirmed exit'}
        $taskExit=@{}+$Entry.identity
        $taskExit.lifecycle='exited';$taskExit.handlePinned=$true
        $taskExit.cpuSeconds=$Entry.process.TotalProcessorTime.TotalSeconds
        $taskExit.exitedAt=$Entry.process.ExitTime.ToUniversalTime().ToString('o')
        $taskExit.exitCode=$Entry.process.ExitCode
        foreach($taskMetric in @('workingSetBytes','privateBytes','handles','threads')){$taskExit[$taskMetric]=$null}
        return $taskExit
    }
    foreach($taskRow in $taskOwned.Values){
        $taskId=[string]$taskRow.ProcessId;$taskCreated=$taskRow.CreationDate.ToUniversalTime().Ticks
        $taskKey=$taskId+':'+$taskCreated
        $Seen[$taskId]=$taskCreated
        try {
            if(-not $Tracked.ContainsKey($taskKey)){
                if($Tracked.Count -ge 256){throw 'Original process handle observer exceeds its finite bound'}
                $taskProcess=Get-Process -Id $taskRow.ProcessId -ErrorAction Stop
                try {
                    [void]$taskProcess.Handle
                    if([Math]::Abs($taskProcess.StartTime.ToUniversalTime().Ticks-$taskCreated) -gt 10){throw 'Original process creation identity changed'}
                    $Tracked[$taskKey]=@{process=$taskProcess;identity=@{pid=[int]$taskRow.ProcessId;parentPid=[int]$taskRow.ParentProcessId;creationTicks=[string]$taskCreated;name=$taskRow.Name;startedAt=$taskProcess.StartTime.ToUniversalTime().ToString('o')}}
                } catch {$taskProcess.Dispose();throw}
            }
            $taskEntry=$Tracked[$taskKey];$taskProcess=$taskEntry.process;$taskProcess.Refresh()
            # CIM timestamps have microsecond precision; tolerate only its
            # sub-microsecond truncation, never a reused PID within one second.
            if($taskProcess.HasExited){$taskSamples[$taskKey]=Get-OwnedExit $taskEntry}
            else {
                $taskSample=@{}+$taskEntry.identity
                $taskSample.lifecycle='running';$taskSample.handlePinned=$true
                $taskSample.cpuSeconds=$taskProcess.TotalProcessorTime.TotalSeconds
                $taskSample.workingSetBytes=$taskProcess.WorkingSet64;$taskSample.privateBytes=$taskProcess.PrivateMemorySize64
                $taskSample.handles=$taskProcess.HandleCount;$taskSample.threads=$taskProcess.Threads.Count
                $taskSamples[$taskKey]=$taskSample;$taskLive[$taskKey]=$true
            }
        } catch {$taskSamples[$taskKey]=@{pid=[int]$taskRow.ProcessId;parentPid=[int]$taskRow.ParentProcessId;creationTicks=[string]$taskCreated;name=$taskRow.Name;unavailable=$true}}
    }
    foreach($taskKey in @($Tracked.Keys)){
        if($taskLive.ContainsKey($taskKey)){continue}
        $taskEntry=$Tracked[$taskKey]
        try {
            $taskSamples[$taskKey]=Get-OwnedExit $taskEntry
            $taskEntry.process.Dispose();$Tracked.Remove($taskKey)
        } catch {
            $taskSample=@{}+$taskEntry.identity;$taskSample.unavailable=$true;$taskSamples[$taskKey]=$taskSample
        }
    }
    $taskValues=@($taskSamples.Values)
    return @{at=$taskAt;completedAt=(Get-Date).ToUniversalTime().ToString('o');processes=$taskValues;wakeups=$null;wakeupsState='unavailable_without_ETW';unavailableProcesses=@($taskValues|Where-Object {$_.unavailable}).Count}
}
