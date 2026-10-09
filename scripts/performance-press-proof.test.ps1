$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'performance-press-proof.ps1')
$taskBefore=[pscustomobject]@{lastPress=[pscustomobject]@{sequence=1}}
$taskHit=[pscustomobject]@{key='exact-target';sourceId='exact-source'}
$taskChecks=0
function Check-Press($Press,[string]$Source,[string]$Expected,$Down=$null){
    $taskActual=Get-HyphenSelectionProof $taskBefore ([pscustomobject]@{lastPress=$Press;source=$Source}) $taskHit $Down
    if($taskActual -ne $Expected){throw ('Expected '+$Expected+' press proof; received '+$taskActual)}
    $script:taskChecks++
}
$taskAccepted=[pscustomobject]@{sequence=2;expectedKey='exact-target';actualKey='exact-target';disposition='accepted'}
Check-Press $taskAccepted 'exact-source' 'accepted'
Check-Press $taskAccepted 'different-source' 'invalid'
$taskCancelled=[pscustomobject]@{sequence=2;expectedKey='exact-target';disposition='cancelled';selectedAtDecision='old-selection';sourceAtDecision='old-source';selectedAfterDecision='old-selection';sourceAfterDecision='old-source'}
Check-Press $taskCancelled '' 'cancelled'
$taskCancelled.sequence=1;Check-Press $taskCancelled '' 'invalid';$taskCancelled.sequence=2
$taskCancelled.sourceAfterDecision='different-source';Check-Press $taskCancelled '' 'invalid';$taskCancelled.sourceAfterDecision='old-source'
$taskCancelled.expectedKey='different-target';Check-Press $taskCancelled '' 'invalid'
Check-Press ([pscustomobject]@{sequence=2;expectedKey='exact-target';disposition='cancelled'}) '' 'invalid'
$taskDown=[pscustomobject]@{lastPress=[pscustomobject]@{sequence=2;expectedKey='moved-row';disposition='down'}}
$taskCancelled.expectedKey='moved-row'
Check-Press $taskCancelled '' 'stale_snapshot_cancelled' $taskDown
$taskCancelled.disposition='accepted';$taskCancelled | Add-Member actualKey 'moved-row'
Check-Press $taskCancelled 'different-source' 'invalid' $taskDown
$taskCancelled.disposition='cancelled';$taskCancelled.sequence=3
Check-Press $taskCancelled '' 'invalid' $taskDown
$taskCancelled.sequence=2;$taskCancelled.sourceAfterDecision='different-source'
Check-Press $taskCancelled '' 'invalid' $taskDown
$taskCancelled.sourceAfterDecision='old-source';$taskDown.lastPress.sequence=1
Check-Press $taskCancelled '' 'invalid' $taskDown
$taskFocusChecks=0
function Focus-Case([string]$Expected,$Change){
    $taskBeforeFocus=[pscustomobject]@{pid=42;selected='task-a';source='source-a';canDraft=$true;lastPress=[pscustomobject]@{sequence=4}}
    $taskDownFocus=[pscustomobject]@{pid=42;selected='task-a';source='source-a';lastPress=[pscustomobject]@{sequence=5;disposition='down';expectedKey='';selectedBefore='task-a';sourceBefore='source-a'}}
    $taskAfterFocus=[pscustomobject]@{pid=42;selected='task-a';source='source-a';composerFocused=$true;lastPress=[pscustomobject]@{sequence=5;disposition='cancelled';expectedKey='';actualKey='';selectedAtDecision='task-a';sourceAtDecision='source-a';selectedAfterDecision='task-a';sourceAfterDecision='source-a'}}
    & $Change $taskBeforeFocus $taskDownFocus $taskAfterFocus
    $taskActual=Get-HyphenComposerFocusProof $taskBeforeFocus $taskDownFocus $taskAfterFocus
    if($taskActual -ne $Expected){throw ('Expected '+$Expected+' focus proof; received '+$taskActual)}
    $script:taskFocusChecks++
}
Focus-Case 'accepted' {}
Focus-Case 'invalid' {param($b,$d,$a) $a.composerFocused=$false}
Focus-Case 'invalid' {param($b,$d,$a) $a.pid=43}
Focus-Case 'invalid' {param($b,$d,$a) $a.lastPress.sequence=6}
Focus-Case 'invalid' {param($b,$d,$a) $d.lastPress.sequence=4;$a.lastPress.sequence=4}
Focus-Case 'invalid' {param($b,$d,$a) $a.lastPress.PSObject.Properties.Remove('sourceAtDecision')}
Focus-Case 'invalid' {param($b,$d,$a) $a.source='different-source'}
Focus-Case 'invalid' {param($b,$d,$a) $a.lastPress.sourceAfterDecision='different-source'}
Focus-Case 'cancelled' {param($b,$d,$a) $a.source='';$a.selected='';$a.lastPress.sourceAtDecision='';$a.lastPress.sourceAfterDecision='';$a.lastPress.selectedAtDecision='';$a.lastPress.selectedAfterDecision=''}
Focus-Case 'stale_snapshot_cancelled' {param($b,$d,$a) $d.source='';$d.selected='';$d.lastPress.sourceBefore='';$d.lastPress.selectedBefore='';$a.source='';$a.selected='';$a.lastPress.sourceAtDecision='';$a.lastPress.sourceAfterDecision='';$a.lastPress.selectedAtDecision='';$a.lastPress.selectedAfterDecision=''}
Focus-Case 'stale_snapshot_cancelled' {param($b,$d,$a) $d.lastPress.expectedKey='moved-control';$a.lastPress.expectedKey='moved-control';$a.lastPress.PSObject.Properties.Remove('actualKey')}
Write-Output ('PASS '+$taskChecks+' selection and '+$taskFocusChecks+' composer focus proof gates; unchanged-target focus failure, stale identity and unbound records are refused')
