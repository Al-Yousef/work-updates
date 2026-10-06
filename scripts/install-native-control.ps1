param([switch]$AllowLegacyRestart)
$ErrorActionPreference='Stop'
$taskRepo=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'dev-paths.ps1')
$taskInstall=(Get-HyphenInstallRoot)
$taskExe=Join-Path $taskInstall 'desktop/Work Updates.exe'
$taskArchive=Join-Path $taskInstall 'desktop/resources/app.asar'
$taskStage=Join-Path $taskRepo 'artifacts/native-control-install/app.asar'
$taskAudit=Join-Path $taskRepo 'artifacts/native-control-install/package.json'
$taskRuntimeFile=Join-Path $taskInstall 'data/desktop/runtime.json'
$taskRuntime=Get-Content -LiteralPath $taskRuntimeFile -Raw | ConvertFrom-Json
if(-not(Test-Path -LiteralPath $taskStage) -or -not(Test-Path -LiteralPath $taskAudit)){throw 'Verified bridge package missing'}
$taskPackage=Get-Content -LiteralPath $taskAudit -Raw | ConvertFrom-Json
if((Get-FileHash -LiteralPath $taskStage -Algorithm SHA256).Hash -ine $taskPackage.sha256){throw 'Bridge package changed after validation'}
if($null -eq $taskRuntime.codex.active -or $taskRuntime.codex.active -ne 0 -or $taskRuntime.codex.loaded -ne 0){throw 'The app still owns a chat; no restart was performed'}
if([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-$taskRuntime.updatedAt -gt 12){throw 'Runtime status is stale'}
$taskMain=Get-Process -Id $taskRuntime.appPid
if($taskMain.Path -ine $taskExe){throw 'Runtime does not belong to this installed app'}
$taskDescriptor=Join-Path $taskInstall 'data/desktop/native-control.info'
$taskNode=Get-HyphenNode
$taskBackup=Join-Path $taskRepo ('artifacts/native-control-install/before-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $taskBackup | Out-Null
Copy-Item -LiteralPath $taskArchive -Destination (Join-Path $taskBackup 'app.asar')
Copy-Item -LiteralPath (Join-Path $taskInstall 'data/desktop/state.json') -Destination (Join-Path $taskBackup 'state.json')
if(Test-Path -LiteralPath $taskDescriptor){
    & $taskNode (Join-Path $PSScriptRoot 'native-control.cjs') $taskDescriptor quitIfIdle
    if($LASTEXITCODE -ne 0){throw 'Graceful app quit was refused'}
    $taskMain.WaitForExit(5000) | Out-Null
}else{
    if(-not $AllowLegacyRestart){throw 'Legacy app has no quit API; explicit idle restart required'}
    $taskChildren=@(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $taskMain.Id))
    # This one-time bootstrap is restricted to the verified idle app and its own children.
    Stop-Process -Id $taskMain.Id
    foreach($taskChild in $taskChildren){
        $taskStillChild=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $taskChild.ProcessId) -ErrorAction SilentlyContinue
        if($taskStillChild -and $taskStillChild.ParentProcessId -eq $taskMain.Id){Stop-Process -Id $taskChild.ProcessId -ErrorAction SilentlyContinue}
    }
    $taskMain.WaitForExit(5000) | Out-Null
}
if(-not $taskMain.HasExited){throw 'App did not exit; no archive was replaced'}
try{
    Copy-Item -LiteralPath $taskStage -Destination $taskArchive -Force
    if((Get-FileHash -LiteralPath $taskArchive -Algorithm SHA256).Hash -ine $taskPackage.sha256){throw 'Installed archive hash mismatch'}
}catch{
    Copy-Item -LiteralPath (Join-Path $taskBackup 'app.asar') -Destination $taskArchive -Force
    Start-Process -FilePath $taskExe -ArgumentList '--hidden' -WindowStyle Hidden
    throw
}
Start-Process -FilePath $taskExe -ArgumentList '--hidden' -WindowStyle Hidden
[pscustomobject]@{Installed=$true;Backup=$taskBackup;StatePreserved=$true} | ConvertTo-Json -Compress
