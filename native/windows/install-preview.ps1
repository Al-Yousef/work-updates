param([string]$CandidateDirectory='build/candidate')
$ErrorActionPreference='Stop'
$taskRoot=$PSScriptRoot
$taskBuild=Join-Path $taskRoot 'build'
$taskCandidate=[IO.Path]::GetFullPath((Join-Path $taskRoot $CandidateDirectory))
if(-not $taskCandidate.StartsWith($taskRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Candidate must stay inside this project'}
$taskFiles=@('Native Hover.exe','Start Native Preview.exe','WorkUpdatesTaskbar-v2.dll','Taskbar Adapter Control.exe')
foreach($taskFile in $taskFiles){if(-not(Test-Path -LiteralPath (Join-Path $taskCandidate $taskFile))){throw "Candidate missing $taskFile"}}
# Validate before closing the installed UI. A build alone is not interaction proof.
$taskBuildProof=Get-Content -LiteralPath (Join-Path $taskCandidate 'build-verification.json') -Raw | ConvertFrom-Json
$taskGuiProof=Get-Content -LiteralPath (Join-Path $taskCandidate 'native-validation.json') -Raw | ConvertFrom-Json
if(-not $taskBuildProof.built -or -not $taskBuildProof.modelTestsPassed -or -not $taskGuiProof.verified -or $taskGuiProof.nativeSha256 -ine (Get-FileHash -LiteralPath (Join-Path $taskCandidate 'Native Hover.exe')).Hash){throw 'This candidate has not passed its native interaction checks; the running app was not changed'}
foreach($taskProperty in $taskBuildProof.sourceHashes.PSObject.Properties){if((Get-FileHash -LiteralPath (Join-Path $taskRoot $taskProperty.Name)).Hash -ine $taskProperty.Value){throw 'Native source changed after building; the running app was not changed'}}
foreach($taskProperty in $taskBuildProof.binaryHashes.PSObject.Properties){if((Get-FileHash -LiteralPath (Join-Path $taskCandidate $taskProperty.Name)).Hash -ine $taskProperty.Value){throw 'Native candidate changed after validation; the running app was not changed'}}
$taskNativePath=Join-Path $taskBuild 'Native Hover.exe'
$taskRunning=@(Get-Process -Name 'Native Hover' -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $taskNativePath})
if($taskRunning.Count -gt 1){throw 'More than one native prototype is running'}
$taskBackup=Join-Path $taskBuild ('artifacts/taskbar-adapter-install/before-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $taskBackup -Force | Out-Null
foreach($taskFile in $taskFiles){$taskExisting=Join-Path $taskBuild $taskFile; if(Test-Path -LiteralPath $taskExisting){Copy-Item -LiteralPath $taskExisting -Destination (Join-Path $taskBackup $taskFile)}}
if($taskRunning.Count){
    Start-Process -FilePath (Join-Path $taskBuild 'Start Native Preview.exe') -ArgumentList '--exit' -WindowStyle Hidden -Wait
    if(-not $taskRunning[0].WaitForExit(5000)){throw 'Existing native preview did not close; install stopped'}
}
foreach($taskFile in $taskFiles){
    $taskSource=Join-Path $taskCandidate $taskFile; $taskDestination=Join-Path $taskBuild $taskFile
    $taskSourceHash=(Get-FileHash -LiteralPath $taskSource).Hash
    if((Test-Path -LiteralPath $taskDestination) -and (Get-FileHash -LiteralPath $taskDestination).Hash -eq $taskSourceHash){continue}
    # Explorer keeps a disabled DLL resident. A changed DLL cannot be overwritten
    # while loaded. Stop with the backup intact instead of restarting Explorer.
    Copy-Item -LiteralPath $taskSource -Destination $taskDestination -Force
    if((Get-FileHash -LiteralPath $taskDestination).Hash -ne $taskSourceHash){throw 'Installed binary hash differs'}
}
Copy-Item -LiteralPath (Join-Path $taskRoot 'THIRD_PARTY_NOTICES.txt') -Destination (Join-Path $taskBuild 'THIRD_PARTY_NOTICES.txt') -Force
$taskNew=Start-Process -FilePath $taskNativePath -WindowStyle Hidden -PassThru
$taskDescriptor=Join-Path $taskBuild 'artifacts/taskbar-adapter.info'
$taskFresh=$false
for($taskTry=0;$taskTry -lt 80;$taskTry++){
    if(Test-Path -LiteralPath $taskDescriptor){
        $taskData=[IO.File]::ReadAllBytes($taskDescriptor)
        # A file from a prior test/run is not readiness. Match the new process.
        if($taskData.Length -eq 32 -and [BitConverter]::ToUInt32($taskData,24) -eq $taskNew.Id){$taskFresh=$true;break}
    }
    if($taskNew.HasExited){throw 'New preview exited before publishing its session'}
    Start-Sleep -Milliseconds 50
}
if(-not $taskFresh){throw 'Fresh native session did not become ready'}
$taskAttached=$false
for($taskTry=0;$taskTry -lt 60;$taskTry++){
    $taskStatusText=& (Join-Path $taskBuild 'Taskbar Adapter Control.exe') --status
    if($LASTEXITCODE -ne 0){throw 'Adapter status check failed'}
    $taskStatus=$taskStatusText | ConvertFrom-Json
    if($taskStatus.state -eq 2){$taskAttached=$true;break}
    if($taskStatus.state -ne 0 -and $taskStatus.state -ne 1){throw 'Adapter refused the new session'}
    if($taskNew.HasExited){throw 'Native preview exited during attachment'}
    Start-Sleep -Milliseconds 50
}
if(-not $taskAttached){throw 'Adapter did not finish attaching'}
Write-Output $taskStatusText
[pscustomobject]@{PreviewPid=$taskNew.Id;Backup=$taskBackup}
