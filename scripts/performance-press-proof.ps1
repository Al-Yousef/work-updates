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
function Get-HyphenComposerFocusProof($Before,$Down,$After) {
    if(-not $Before -or -not $Down -or -not $After -or -not $Before.source -or -not $Before.selected -or -not $Before.canDraft){return 'invalid'}
    if(-not $Before.pid -or $Down.pid -ne $Before.pid -or $After.pid -ne $Before.pid){return 'invalid'}
    $taskStarted=$Down.lastPress;$taskPress=$After.lastPress
    if(-not $taskStarted -or -not $taskPress -or $taskStarted.sequence -le [long]$Before.lastPress.sequence -or $taskPress.sequence -ne $taskStarted.sequence -or $taskStarted.disposition -ne 'down'){return 'invalid'}
    foreach($taskField in @('expectedKey','selectedBefore','sourceBefore')){
        if($taskStarted.PSObject.Properties.Name -notcontains $taskField -or $taskStarted.$taskField -isnot [string]){return 'invalid'}
    }
    foreach($taskField in @('expectedKey','selectedAtDecision','sourceAtDecision','selectedAfterDecision','sourceAfterDecision')){
        if($taskPress.PSObject.Properties.Name -notcontains $taskField -or $taskPress.$taskField -isnot [string]){return 'invalid'}
    }
    if($taskPress.expectedKey -ne $taskStarted.expectedKey -or $taskPress.disposition -ne 'cancelled'){return 'invalid'}
    if($taskPress.selectedAtDecision -ne $taskPress.selectedAfterDecision -or $taskPress.sourceAtDecision -ne $taskPress.sourceAfterDecision -or $After.selected -ne $taskPress.selectedAfterDecision -or $After.source -ne $taskPress.sourceAfterDecision){return 'invalid'}
    $taskSameDown=$taskStarted.expectedKey -eq '' -and $taskStarted.selectedBefore -eq $Before.selected -and $taskStarted.sourceBefore -eq $Before.source -and $Down.selected -eq $Before.selected -and $Down.source -eq $Before.source
    $taskSameDecision=$taskPress.selectedAtDecision -eq $Before.selected -and $taskPress.sourceAtDecision -eq $Before.source
    # Native composer presses have no painted hit key. Their existing press
    # record says cancelled even on a successful caret focus; require the actual
    # focused editor and exact original selection at down, decision and readback.
    if($taskSameDown -and $taskSameDecision -and $taskPress.actualKey -is [string] -and $taskPress.actualKey -eq '' -and $After.composerFocused){return 'accepted'}
    if(-not $taskSameDown -or -not $taskSameDecision){return $(if(-not $taskSameDown){'stale_snapshot_cancelled'}else{'cancelled'})}
    return 'invalid'
}
