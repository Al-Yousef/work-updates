param([Parameter(Mandatory)][string]$InstallRoot,[Parameter(Mandatory)][string]$DataDirectory,[int]$ExpectedPid=0)
$ErrorActionPreference='Stop'
$taskExe=[IO.Path]::GetFullPath((Join-Path $InstallRoot 'desktop/Work Updates.exe'))
$taskNative=[IO.Path]::GetFullPath((Join-Path $InstallRoot 'native/Native Hover.exe'))
$taskProcesses=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -ieq $taskExe -or $_.ExecutablePath -ieq $taskNative})
$taskPrimaries=@($taskProcesses | Where-Object {$_.ExecutablePath -ieq $taskExe -and $_.CommandLine -notmatch '--type='})
foreach($taskProcess in $taskProcesses){
  $taskFlag=if($taskProcess.ExecutablePath -ieq $taskExe){'--data-dir'}else{'--bridge'}
  $taskMatch=[regex]::Match($taskProcess.CommandLine,([regex]::Escape($taskFlag)+'(?:=|\s+)(?:"([^"]+)"|([^\s]+))'))
  if($taskMatch.Success){
    $taskArgument=if($taskMatch.Groups[1].Success){$taskMatch.Groups[1].Value}else{$taskMatch.Groups[2].Value}
    $taskExpected=if($taskFlag -eq '--data-dir'){$DataDirectory}else{Join-Path $DataDirectory 'native-control.info'}
    if([IO.Path]::GetFullPath($taskArgument) -ine [IO.Path]::GetFullPath($taskExpected)){throw 'An installed process owns another data folder; maintenance was refused'}
  }
}
if($taskPrimaries.Count -gt 1){throw 'More than one backend owns the installation'}
if($ExpectedPid -and ($taskPrimaries.Count -ne 1 -or $taskPrimaries[0].ProcessId -ne $ExpectedPid)){throw 'The update backend process identity does not match'}
$taskResult=[ordered]@{pid=if($taskPrimaries.Count){[int]$taskPrimaries[0].ProcessId}else{0};processes=@($taskProcesses | ForEach-Object {[int]$_.ProcessId});native=@($taskProcesses | Where-Object {$_.ExecutablePath -ieq $taskNative} | ForEach-Object {[int]$_.ProcessId})}
$taskResult | ConvertTo-Json -Compress
