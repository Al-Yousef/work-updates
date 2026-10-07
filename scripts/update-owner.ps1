param([Parameter(Mandatory)][string]$InstallRoot,[Parameter(Mandatory)][string]$DataDirectory,[int]$ExpectedPid=0)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'update-paths.ps1')
$taskExe=Get-UpdateCanonicalPath (Join-Path $InstallRoot 'desktop/Work Updates.exe')
$taskNative=Get-UpdateCanonicalPath (Join-Path $InstallRoot 'native/Native Hover.exe')
$taskCandidates=@(Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('Work Updates.exe','Native Hover.exe') -or ($ExpectedPid -and $_.ProcessId -eq $ExpectedPid)})
$taskProcesses=@($taskCandidates | Where-Object {$_.ExecutablePath -and (Get-UpdateCanonicalPath $_.ExecutablePath) -iin @($taskExe,$taskNative)})
$taskPrimaries=@($taskProcesses | Where-Object {(Get-UpdateCanonicalPath $_.ExecutablePath) -ieq $taskExe -and $_.CommandLine -notmatch '--type='})
foreach($taskProcess in $taskProcesses){
  $taskFlag=if((Get-UpdateCanonicalPath $taskProcess.ExecutablePath) -ieq $taskExe){'--data-dir'}else{'--bridge'}
  $taskMatch=[regex]::Match($taskProcess.CommandLine,([regex]::Escape($taskFlag)+'(?:=|\s+)(?:"([^"]+)"|([^\s]+))'))
  if($taskMatch.Success){
    $taskArgument=if($taskMatch.Groups[1].Success){$taskMatch.Groups[1].Value}else{$taskMatch.Groups[2].Value}
    $taskExpected=if($taskFlag -eq '--data-dir'){$DataDirectory}else{Join-Path $DataDirectory 'native-control.info'}
    if((Get-UpdateCanonicalPath $taskArgument) -ine (Get-UpdateCanonicalPath $taskExpected)){throw 'An installed process owns another data folder; maintenance was refused'}
  }
}
if($taskPrimaries.Count -gt 1){throw 'More than one backend owns the installation'}
if($ExpectedPid -and ($taskPrimaries.Count -ne 1 -or $taskPrimaries[0].ProcessId -ne $ExpectedPid)){
  $taskExpected=$taskCandidates | Where-Object {$_.ProcessId -eq $ExpectedPid} | Select-Object -First 1
  $taskEvidence=[ordered]@{expectedProcessPresent=[bool]$taskExpected;executablePathAvailable=[bool]$taskExpected.ExecutablePath;matchingProcesses=$taskProcesses.Count;matchingPrimaries=$taskPrimaries.Count;expectedIsHelper=[bool]($taskExpected.CommandLine -match '--type=')}
  throw ('The update backend process identity does not match: '+($taskEvidence|ConvertTo-Json -Compress))
}
$taskResult=[ordered]@{pid=if($taskPrimaries.Count){[int]$taskPrimaries[0].ProcessId}else{0};processes=@($taskProcesses | ForEach-Object {[int]$_.ProcessId});native=@($taskProcesses | Where-Object {(Get-UpdateCanonicalPath $_.ExecutablePath) -ieq $taskNative} | ForEach-Object {[int]$_.ProcessId})}
$taskResult | ConvertTo-Json -Compress
