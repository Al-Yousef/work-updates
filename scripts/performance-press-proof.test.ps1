$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'performance-press-proof.ps1')
$taskBefore=[pscustomobject]@{lastPress=[pscustomobject]@{sequence=1}}
$taskHit=[pscustomobject]@{key='exact-target';sourceId='exact-source'}
$taskChecks=0
function Check-Press($Press,[string]$Source,[string]$Expected){
    $taskActual=Get-HyphenSelectionProof $taskBefore ([pscustomobject]@{lastPress=$Press;source=$Source}) $taskHit
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
Write-Output ('PASS '+$taskChecks+' native press proof gates; stale, unbound and changed-selection records are refused')
