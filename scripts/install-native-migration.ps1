$ErrorActionPreference='Stop'
$taskRepo=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'dev-paths.ps1')
$taskInstall=(Get-HyphenInstallRoot)
$taskNative=[IO.Path]::GetFullPath((Join-Path $taskRepo 'native/windows'))
$taskData=Join-Path $taskInstall 'data/desktop'
$taskExe=Join-Path $taskInstall 'desktop/Work Updates.exe'
$taskArchive=Join-Path $taskInstall 'desktop/resources/app.asar'
$taskStage=Join-Path $taskRepo 'artifacts/native-migration/app.asar'
$taskPackage=Get-Content -LiteralPath (Join-Path $taskRepo 'artifacts/native-migration/package.json') -Raw | ConvertFrom-Json
if((Get-FileHash -LiteralPath $taskStage).Hash -ine $taskPackage.sha256){throw 'Candidate archive changed'}
$taskBuildProof=Get-Content -LiteralPath (Join-Path $taskNative 'build/candidate/build-verification.json') -Raw | ConvertFrom-Json
if(-not $taskBuildProof.built -or -not $taskBuildProof.modelTestsPassed){throw 'Native build is not verified'}
$taskGuiProofPath=Join-Path $taskNative 'build/candidate/native-validation.json'
if(-not(Test-Path -LiteralPath $taskGuiProofPath)){throw 'Native interaction validation is missing; run scripts/release-audit.ps1 before installing'}
$taskGuiProof=Get-Content -LiteralPath $taskGuiProofPath -Raw | ConvertFrom-Json
if(-not $taskGuiProof.verified -or $taskGuiProof.nativeSha256 -ine (Get-FileHash -LiteralPath (Join-Path $taskNative 'build/candidate/Native Hover.exe')).Hash){throw 'This native binary has not passed its GUI validation; the running app was not changed'}
foreach($taskProperty in $taskBuildProof.sourceHashes.PSObject.Properties){if((Get-FileHash -LiteralPath (Join-Path $taskNative $taskProperty.Name)).Hash -ine $taskProperty.Value){throw 'Native source changed after building'}}
foreach($taskProperty in $taskBuildProof.binaryHashes.PSObject.Properties){if((Get-FileHash -LiteralPath (Join-Path $taskNative ('build/candidate/'+$taskProperty.Name))).Hash -ine $taskProperty.Value){throw 'Native binary changed after building'}}
$taskCollectorStage=Join-Path $taskRepo 'artifacts/native-migration/collector.py'
$taskCollectorInstalled=Join-Path $taskInstall 'desktop/resources/helper/collector.py'
if((Get-FileHash -LiteralPath $taskCollectorStage).Hash -ine $taskPackage.collectorSha256){throw 'Collector candidate changed'}
foreach($taskFile in @('Native Hover.exe','Start Native Preview.exe','WorkUpdatesTaskbar-v2.dll','Taskbar Adapter Control.exe')) {
    if(-not(Test-Path -LiteralPath (Join-Path $taskNative "build/candidate/$taskFile"))){throw 'Native candidate missing'}
}
foreach($taskFile in @('WorkUpdatesTaskbar-v2.dll','Taskbar Adapter Control.exe')) {
    if((Get-FileHash -LiteralPath (Join-Path $taskNative "build/candidate/$taskFile")).Hash -ne (Get-FileHash -LiteralPath (Join-Path $taskNative "build/$taskFile")).Hash){throw 'Adapter binary differs; migration must preserve the verified adapter'}
}
$taskRuntime=Get-Content -LiteralPath (Join-Path $taskData 'runtime.json') -Raw | ConvertFrom-Json
if([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-$taskRuntime.updatedAt -gt 12){throw 'Backend status is stale'}
if($taskRuntime.codex.active -ne 0 -or $taskRuntime.codex.pending -ne 0 -or $taskRuntime.messages.active -gt 0 -or $taskRuntime.assistant.active){throw 'Backend has active work; no restart performed'}
# Loaded idle sessions are saved chats, not running work. quitIfIdle checks the
# live writer/busy count again before releasing only this app's own helpers.
$taskMain=Get-Process -Id $taskRuntime.appPid
if($taskMain.Path -ine $taskExe){throw 'Backend process identity changed'}
$taskBackup=Join-Path $taskRepo ('artifacts/native-migration/before-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $taskBackup -Force | Out-Null
Copy-Item -LiteralPath $taskArchive -Destination (Join-Path $taskBackup 'app.asar')
Copy-Item -LiteralPath $taskCollectorInstalled -Destination (Join-Path $taskBackup 'collector.py')
Copy-Item -LiteralPath (Join-Path $taskInstall 'Work Updates.exe') -Destination (Join-Path $taskBackup 'Work Updates.exe')
Copy-Item -LiteralPath (Join-Path $taskData 'state.json') -Destination (Join-Path $taskBackup 'state.json')
$taskNode=Get-HyphenNode
& $taskNode (Join-Path $PSScriptRoot 'native-control.cjs') (Join-Path $taskData 'native-control.info') quitIfIdle
if($LASTEXITCODE -ne 0){throw 'Backend refused idle restart'}
if(-not $taskMain.WaitForExit(5000)){throw 'Backend did not exit; no archive was replaced'}
$taskOldNative=@(Get-Process -Name 'Native Hover' -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq (Join-Path $taskNative 'build/Native Hover.exe')})
foreach($taskProcess in $taskOldNative){if(-not $taskProcess.WaitForExit(5000)){throw 'Old native interface did not release the corner'}}
$taskMarker=Join-Path $taskData 'native-backend.enabled'
try {
    Copy-Item -LiteralPath $taskStage -Destination $taskArchive -Force
    Copy-Item -LiteralPath $taskCollectorStage -Destination $taskCollectorInstalled -Force
    if((Get-FileHash -LiteralPath $taskArchive).Hash -ine $taskPackage.sha256){throw 'Installed archive hash differs'}
    [IO.File]::WriteAllText($taskMarker,'Native migration stage 1')
    Copy-Item -LiteralPath (Join-Path $taskNative 'build/candidate/Start Native Preview.exe') -Destination (Join-Path $taskInstall 'Work Updates.exe') -Force
    Copy-Item -LiteralPath (Join-Path $taskNative 'build/candidate/Start Native Preview.exe') -Destination (Join-Path $taskInstall 'Hyphen.exe') -Force
    $taskNew=Start-Process -FilePath $taskExe -ArgumentList '--native-backend --hidden' -WindowStyle Hidden -PassThru
    $taskReady=$false
    for($taskTry=0;$taskTry -lt 100;$taskTry++){
        if($taskNew.HasExited){throw 'New backend exited'}
        if(Test-Path -LiteralPath (Join-Path $taskData 'runtime.json')){
            try {$taskState=Get-Content -LiteralPath (Join-Path $taskData 'runtime.json') -Raw | ConvertFrom-Json} catch {$taskState=$null}
            if($taskState.appPid -eq $taskNew.Id -and $taskState.mode -eq 'native-backend' -and $taskState.windowCount -eq 0 -and $taskState.rendererCount -eq 0){$taskReady=$true;break}
        }
        Start-Sleep -Milliseconds 100
    }
    if(-not $taskReady){throw 'New backend did not become ready without a renderer'}
    & (Join-Path $taskNative 'install-preview.ps1')
    if(-not $?){throw 'Native install failed'}
    $taskResult=@{installed=$true;backendPid=$taskNew.Id;mode=$taskState.mode;windowCount=$taskState.windowCount;rendererCount=$taskState.rendererCount;backup=$taskBackup;archiveSha256=$taskPackage.sha256}
    $taskResult | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRepo 'artifacts/native-migration/install.json')
    $taskResult | ConvertTo-Json -Compress
} catch {
    $taskFailure=$_
    if($taskNew -and -not $taskNew.HasExited){
        & $taskNode (Join-Path $PSScriptRoot 'native-control.cjs') (Join-Path $taskData 'native-control.info') quitIfIdle
        if($LASTEXITCODE -ne 0 -or -not $taskNew.WaitForExit(5000)){throw 'Rollback requires the new backend to finish its writer first; backup is preserved'}
    }
    Copy-Item -LiteralPath (Join-Path $taskBackup 'app.asar') -Destination $taskArchive -Force
    Copy-Item -LiteralPath (Join-Path $taskBackup 'collector.py') -Destination $taskCollectorInstalled -Force
    Copy-Item -LiteralPath (Join-Path $taskBackup 'Work Updates.exe') -Destination (Join-Path $taskInstall 'Work Updates.exe') -Force
    if(Test-Path -LiteralPath $taskMarker){Remove-Item -LiteralPath $taskMarker}
    Start-Process -FilePath $taskExe -ArgumentList '--hidden' -WindowStyle Hidden
    throw $taskFailure
}
