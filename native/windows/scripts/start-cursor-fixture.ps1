param([Parameter(Mandatory)][string]$Directory,[string]$Executable='')
$ErrorActionPreference='Stop'
$taskNative=Split-Path -Parent $PSScriptRoot
$taskRepo=[IO.Path]::GetFullPath((Join-Path $taskNative '../..'))
. (Join-Path $taskRepo 'scripts/dev-paths.ps1')
$taskNode=Get-HyphenNode
$taskDir=[IO.Path]::GetFullPath($Directory)
if(-not $taskDir.StartsWith($taskNative+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture must stay in the native project'}
if(Test-Path -LiteralPath $taskDir){throw 'Use a fresh fixture directory to preserve earlier evidence'}
if(-not $Executable){$Executable=Join-Path $taskNative 'build/Native Hover.exe'}
$taskExe=[IO.Path]::GetFullPath($Executable)
if(-not $taskExe.StartsWith($taskNative+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Test executable must stay in this project'}
New-Item -ItemType Directory -Path $taskDir -Force | Out-Null
$taskFixture=Join-Path $taskDir 'fixture'
New-Item -ItemType Directory -Path $taskFixture -Force | Out-Null
$taskArgs=@((Join-Path $taskRepo 'scripts/native-reply-fixture.cjs'),$taskFixture,'--many-chats','--ux-audit','--details-delay-ms','3000','--send-delay-ms','3000','--long-history')
$taskBackend=Start-Process -FilePath $taskNode -ArgumentList $taskArgs -WorkingDirectory $taskRepo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskFixture 'stdout.log') -RedirectStandardError (Join-Path $taskFixture 'stderr.log') -PassThru
for($taskAttempt=0;$taskAttempt -lt 60 -and -not(Test-Path -LiteralPath (Join-Path $taskFixture 'fixture-ready.json'));$taskAttempt++){Start-Sleep -Milliseconds 100}
if(-not(Test-Path -LiteralPath (Join-Path $taskFixture 'fixture-ready.json'))){throw 'Synthetic backend did not start'}
$taskBridge=Join-Path $taskFixture 'native-control.info'
$taskCapture=Join-Path $taskDir 'panel.png'
$taskNativeArgs='--isolated-session --no-auto-attach --show --audit-reduced-motion --audit-capture "'+$taskCapture+'" --bridge "'+$taskBridge+'"'
$taskPanel=Start-Process -FilePath $taskExe -ArgumentList $taskNativeArgs -WorkingDirectory $taskNative -WindowStyle Hidden -PassThru
$taskRecord=@{exe=$taskExe;exeSha256=(Get-FileHash -LiteralPath $taskExe).Hash;backendPid=$taskBackend.Id;panelPid=$taskPanel.Id;fixture=$taskFixture;detailsDelayMs=3000;sendDelayMs=3000}
$taskRecord | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskDir 'test-processes.json') -Encoding utf8
$taskRecord | ConvertTo-Json
