$ErrorActionPreference='Stop'
$taskRepo=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'dev-paths.ps1')
$taskPackageRoot=Join-Path $taskRepo 'artifacts/assistant-continuity-20261006'
$taskPackage=Get-Content -LiteralPath (Join-Path $taskPackageRoot 'package.json') -Raw | ConvertFrom-Json
$taskAudit=Get-Content -LiteralPath (Join-Path $taskPackageRoot 'backend-audit.json') -Raw | ConvertFrom-Json
$taskInstall=(Get-HyphenInstallRoot)
$taskArchive=Join-Path $taskInstall 'desktop/resources/app.asar'
$taskCandidate=Join-Path $taskPackageRoot 'app.asar'
$taskExe=Join-Path $taskInstall 'desktop/Work Updates.exe'
$taskData=Join-Path $taskInstall 'data/desktop'
$taskNative=[IO.Path]::GetFullPath((Join-Path $taskRepo 'native/windows/build/Native Hover.exe'))
$taskNativeHash=(Get-FileHash -LiteralPath $taskNative).Hash
$taskNode=Get-HyphenNode
if(-not $taskPackage.built -or -not $taskAudit.passed -or $taskAudit.archiveSha256 -ine $taskPackage.sha256 -or (Get-FileHash -LiteralPath $taskCandidate).Hash -ine $taskPackage.sha256){throw 'The assistant package has not passed its integration audit'}
if((Get-FileHash -LiteralPath $taskArchive).Hash -ine $taskPackage.baselineSha256){throw 'The installed backend changed; it was not replaced'}
foreach($taskSource in $taskPackage.sourceHashes.PSObject.Properties){if((Get-FileHash -LiteralPath (Join-Path $taskRepo $taskSource.Name)).Hash -ine $taskSource.Value){throw 'Assistant source changed after packaging'}}
$taskProcesses=@(Get-CimInstance Win32_Process -Filter "Name='Work Updates.exe'" | Where-Object {$_.ExecutablePath -ieq $taskExe})
$taskMain=$null
if($taskProcesses.Count){
    $taskRuntime=Get-Content -LiteralPath (Join-Path $taskData 'runtime.json') -Raw | ConvertFrom-Json
    $taskPrimaries=@($taskProcesses | Where-Object {$_.CommandLine -notmatch '--type='})
    if($taskPrimaries.Count -ne 1 -or $taskPrimaries[0].ProcessId -ne $taskRuntime.appPid -or [DateTimeOffset]::Now.ToUnixTimeSeconds()-$taskRuntime.updatedAt -gt 12){throw 'The installed process identity or runtime is not ready for maintenance'}
    if($taskRuntime.codex.active -ne 0 -or $taskRuntime.codex.pending -ne 0 -or $taskRuntime.messages.active -ne 0 -or $taskRuntime.assistant.active){throw 'Hyphen is handling work; the update was not installed'}
    $taskMain=Get-Process -Id $taskRuntime.appPid
}
$taskBackup=Join-Path $taskPackageRoot ('before-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $taskBackup | Out-Null
Copy-Item -LiteralPath $taskArchive -Destination (Join-Path $taskBackup 'app.asar')
foreach($taskFile in @('assistant.json','state.json','messages.json','drafts.json')){if(Test-Path -LiteralPath (Join-Path $taskData $taskFile)){Copy-Item -LiteralPath (Join-Path $taskData $taskFile) -Destination (Join-Path $taskBackup $taskFile)}}
if($taskMain){
    & $taskNode (Join-Path $PSScriptRoot 'native-control.cjs') (Join-Path $taskData 'native-control.info') quitIfIdle
    if($LASTEXITCODE -ne 0 -or -not $taskMain.WaitForExit(5000)){throw 'Hyphen refused the idle restart; no backend was replaced'}
    $taskOldUi=@(Get-Process -Name 'Native Hover' -ErrorAction SilentlyContinue | Where-Object {$_.Path -ieq $taskNative})
    foreach($taskUi in $taskOldUi){if(-not $taskUi.WaitForExit(5000)){throw 'The native UI did not release its old connection; no backend was replaced'}}
}
Copy-Item -LiteralPath $taskCandidate -Destination $taskArchive -Force
if((Get-FileHash -LiteralPath $taskArchive).Hash -ine $taskPackage.sha256){Copy-Item -LiteralPath (Join-Path $taskBackup 'app.asar') -Destination $taskArchive -Force;throw 'Installed backend hash mismatch; the original backend was restored'}
$taskNew=Start-Process -FilePath $taskExe -ArgumentList '--native-backend --hidden' -WindowStyle Hidden -PassThru
$taskReady=$false
for($taskTry=0;$taskTry -lt 120;$taskTry++){
    if($taskNew.HasExited){throw 'The new backend exited; its original archive and data are preserved in the backup'}
    try{$taskRuntime=Get-Content -LiteralPath (Join-Path $taskData 'runtime.json') -Raw | ConvertFrom-Json}catch{$taskRuntime=$null}
    if($taskRuntime.appPid -eq $taskNew.Id -and $taskRuntime.version -eq $taskPackage.version -and $taskRuntime.mode -eq 'native-backend' -and $taskRuntime.windowCount -eq 0 -and $taskRuntime.rendererCount -eq 0 -and $taskRuntime.health.ok -and -not $taskRuntime.assistant.error){$taskReady=$true;break}
    Start-Sleep -Milliseconds 100
}
if(-not $taskReady){throw 'The new backend did not become ready; its original archive and data are preserved in the backup'}
if((Get-FileHash -LiteralPath $taskNative).Hash -ine $taskNativeHash){throw 'The native UI changed independently during installation'}
$taskLauncher=Start-Process -FilePath ([IO.Path]::GetFullPath((Join-Path $taskRepo 'native/windows/build/Start Native Preview.exe'))) -WindowStyle Hidden -PassThru
if(-not $taskLauncher.WaitForExit(5000) -or $taskLauncher.ExitCode -ne 0){throw 'The native launcher did not complete successfully'}
$taskResult=[ordered]@{installed=$true;at=[DateTimeOffset]::Now.ToString('o');version=$taskRuntime.version;backendPid=$taskNew.Id;archiveSha256=$taskPackage.sha256;nativeUiSha256=$taskNativeHash;nativeUiReplaced=$false;windowCount=$taskRuntime.windowCount;rendererCount=$taskRuntime.rendererCount;backup=$taskBackup}
$taskResult | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskPackageRoot 'install.json') -Encoding utf8
$taskResult | ConvertTo-Json -Compress
