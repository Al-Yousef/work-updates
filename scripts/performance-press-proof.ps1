function Get-HyphenSelectionProof($Before,$After,$Hit,$Down=$null) {
    $taskPress=$After.lastPress
    $taskStaleSnapshot=$false
    if($Down){
        $taskStarted=$Down.lastPress
        if(-not $taskStarted -or $taskStarted.sequence -le [long]$Before.lastPress.sequence -or $taskStarted.disposition -ne 'down' -or $taskStarted.expectedKey -isnot [string] -or -not $taskPress -or $taskPress.sequence -ne $taskStarted.sequence){return 'invalid'}
        $taskStaleSnapshot=$taskStarted.expectedKey -ne $Hit.key
        if($taskStaleSnapshot){
            # The harness cancels before release when the row moved after its
            # snapshot. This proves cancellation of the actual press; it can
            # never be counted as acceptance of the originally planned row.
            if($taskPress.expectedKey -ne $taskStarted.expectedKey -or $taskPress.disposition -ne 'cancelled'){return 'invalid'}
        }
    }
    if(-not $taskPress -or $taskPress.sequence -le [long]$Before.lastPress.sequence -or (-not $taskStaleSnapshot -and $taskPress.expectedKey -ne $Hit.key)){return 'invalid'}
    if($taskPress.disposition -eq 'accepted' -and $taskPress.actualKey -eq $Hit.key -and $After.source -eq $Hit.sourceId){return 'accepted'}
    if($taskPress.disposition -eq 'cancelled'){
        foreach($taskField in @('selectedAtDecision','sourceAtDecision','selectedAfterDecision','sourceAfterDecision')){
            if($taskPress.PSObject.Properties.Name -notcontains $taskField -or $taskPress.$taskField -isnot [string]){return 'invalid'}
        }
        if($taskPress.selectedAtDecision -eq $taskPress.selectedAfterDecision -and $taskPress.sourceAtDecision -eq $taskPress.sourceAfterDecision){return $(if($taskStaleSnapshot){'stale_snapshot_cancelled'}else{'cancelled'})}
    }
    return 'invalid'
}
