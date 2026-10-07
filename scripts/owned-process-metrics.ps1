function Get-OwnedProcessSample {
    param([Parameter(Mandatory)][hashtable]$Roots,[Parameter(Mandatory)][hashtable]$Seen)
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
    $taskSamples=@()
    foreach($taskRow in $taskOwned.Values){
        $taskId=[string]$taskRow.ProcessId;$taskCreated=$taskRow.CreationDate.ToUniversalTime().Ticks
        $Seen[$taskId]=$taskCreated
        try {
            $taskProcess=Get-Process -Id $taskRow.ProcessId -ErrorAction Stop
            # CIM timestamps have microsecond precision; tolerate only its
            # sub-microsecond truncation, never a reused PID within one second.
            if([Math]::Abs($taskProcess.StartTime.ToUniversalTime().Ticks-$taskCreated) -gt 10){continue}
            $taskSamples+=@{pid=[int]$taskRow.ProcessId;parentPid=[int]$taskRow.ParentProcessId;creationTicks=[string]$taskCreated;name=$taskRow.Name;cpuSeconds=$taskProcess.TotalProcessorTime.TotalSeconds;workingSetBytes=$taskProcess.WorkingSet64;privateBytes=$taskProcess.PrivateMemorySize64;handles=$taskProcess.HandleCount;threads=$taskProcess.Threads.Count}
        } catch { $taskSamples+=@{pid=[int]$taskRow.ProcessId;parentPid=[int]$taskRow.ParentProcessId;creationTicks=[string]$taskCreated;name=$taskRow.Name;unavailable=$true} }
    }
    return @{at=(Get-Date).ToUniversalTime().ToString('o');processes=$taskSamples;wakeups=$null;wakeupsState='unavailable_without_ETW';unavailableProcesses=@($taskSamples|Where-Object {$_.unavailable}).Count}
}
