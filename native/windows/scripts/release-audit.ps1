$ErrorActionPreference='Stop'
$taskNative=Split-Path -Parent $PSScriptRoot
$taskCandidate=Join-Path $taskNative 'build/candidate'
$taskProof=Join-Path $taskCandidate 'native-validation.json'
$taskHash=(Get-FileHash -LiteralPath (Join-Path $taskCandidate 'Native Hover.exe')).Hash
$taskRecord=@{verified=$false;nativeSha256=$taskHash;startedAt=[DateTimeOffset]::Now.ToString('o');scope='Owned Win32 controls with synthetic backends; no signed-in messages or Explorer injection'}
Remove-Item -LiteralPath $taskProof -ErrorAction SilentlyContinue
Push-Location $taskNative
try {
    & ./scripts/responsiveness-audit.ps1 -Mode final *> build/artifacts/responsiveness-final.log
    & ./scripts/queue-audit.ps1 *> build/artifacts/responsiveness-queue-final.log
    & ./scripts/ux-audit.ps1 *> build/artifacts/responsiveness-scales-final.log
    & ./build/candidate/native-adapter-tests.exe *> build/artifacts/responsiveness-adapter-final.log
    if($LASTEXITCODE -ne 0){throw 'Native adapter regression failed'}
    if((Get-FileHash -LiteralPath (Join-Path $taskCandidate 'Native Hover.exe')).Hash -ine $taskHash){throw 'Native candidate changed during validation'}
    $taskRecord.verified=$true
    $taskRecord.renderScales=@(96,120,144,192)
    $taskRecord.interactions=Get-Content -LiteralPath (Join-Path $taskCandidate 'artifacts/responsiveness-final.json') -Raw | ConvertFrom-Json
} catch {
    $taskRecord.error=$_.Exception.Message
    throw
} finally {
    Pop-Location
    $taskRecord.completedAt=[DateTimeOffset]::Now.ToString('o')
    $taskRecord | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $taskProof -Encoding utf8
}
