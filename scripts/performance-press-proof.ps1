function Get-HyphenSelectionProof($Before,$After,$Hit) {
    $taskPress=$After.lastPress
    if(-not $taskPress -or $taskPress.sequence -le [long]$Before.lastPress.sequence -or $taskPress.expectedKey -ne $Hit.key){return 'invalid'}
    if($taskPress.disposition -eq 'accepted' -and $taskPress.actualKey -eq $Hit.key -and $After.source -eq $Hit.sourceId){return 'accepted'}
    if($taskPress.disposition -eq 'cancelled'){
        foreach($taskField in @('selectedAtDecision','sourceAtDecision','selectedAfterDecision','sourceAfterDecision')){
            if($taskPress.PSObject.Properties.Name -notcontains $taskField -or $taskPress.$taskField -isnot [string]){return 'invalid'}
        }
        if($taskPress.selectedAtDecision -eq $taskPress.selectedAfterDecision -and $taskPress.sourceAtDecision -eq $taskPress.sourceAfterDecision){return 'cancelled'}
    }
    return 'invalid'
}
