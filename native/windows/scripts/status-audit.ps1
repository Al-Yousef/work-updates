$ErrorActionPreference='Stop'
$taskNative=Split-Path -Parent $PSScriptRoot
$taskRepo=[IO.Path]::GetFullPath((Join-Path $taskNative '../..'))
. (Join-Path $taskRepo 'scripts/dev-paths.ps1')
$taskNode=Get-HyphenNode
$taskBuild=Join-Path $taskNative 'build/candidate'
$taskImages=Join-Path $taskBuild 'artifacts'
$taskResults=@()
$taskTest=$null
& $taskNode (Join-Path $taskRepo 'scripts/status-contract-fixtures.cjs')
if($LASTEXITCODE -ne 0){throw 'Shared status fixtures did not generate'}
$taskFixture=Join-Path $taskRepo ('artifacts/status-render-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $taskFixture -Force | Out-Null
$taskChild=Start-Process -FilePath $taskNode -ArgumentList @((Join-Path $taskRepo 'scripts/native-reply-fixture.cjs'),$taskFixture,'--ux-audit','--status-audit') -WorkingDirectory $taskRepo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskFixture 'stdout.log') -RedirectStandardError (Join-Path $taskFixture 'stderr.log') -PassThru
try {
    for($taskAttempt=0;$taskAttempt -lt 50 -and -not(Test-Path -LiteralPath (Join-Path $taskFixture 'fixture-ready.json'));$taskAttempt++){Start-Sleep -Milliseconds 100}
    if(-not(Test-Path -LiteralPath (Join-Path $taskFixture 'fixture-ready.json'))){throw 'Isolated status fixture did not start'}
    foreach($taskDpi in @(96,144)){
        $taskArguments=@(('"'+(Join-Path $taskFixture 'native-control.info')+'"'),$taskDpi,('"'+(Join-Path $taskRepo 'artifacts/status-contract/fixtures.json')+'"'))
        $taskTest=Start-Process -FilePath (Join-Path $taskBuild 'native-ux-tests.exe') -ArgumentList $taskArguments -WorkingDirectory $taskRepo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskFixture "status-$taskDpi.stdout.txt") -RedirectStandardError (Join-Path $taskFixture "status-$taskDpi.stderr.txt") -PassThru
        if(-not $taskTest.WaitForExit(60000)){throw "Native status checks timed out at $taskDpi DPI"}
        Get-Content -LiteralPath (Join-Path $taskFixture "status-$taskDpi.stdout.txt")
        if($taskTest.ExitCode -ne 0){Get-Content -LiteralPath (Join-Path $taskFixture "status-$taskDpi.stderr.txt");throw "Native status checks failed at $taskDpi DPI"}
        $taskCases=(Get-Content -Raw -LiteralPath (Join-Path $taskRepo 'artifacts/status-contract/fixtures.json') | ConvertFrom-Json).cases
        foreach($taskCase in $taskCases){
            $taskImage=Join-Path $taskImages ("status-"+$taskCase.id+"-$taskDpi.png")
            if(-not(Test-Path -LiteralPath $taskImage)){throw 'Native status screenshot is missing'}
            $taskResults+=@{case=$taskCase.id;dpi=$taskDpi;file=[IO.Path]::GetFileName($taskImage);sha256=(Get-FileHash -LiteralPath $taskImage -Algorithm SHA256).Hash.ToLowerInvariant()}
        }
        $taskTest=$null
    }
    @{schema=1;synthetic=$true;actualNativeRendering=$true;input='simulated own-window messages';accountsUsed=0;modelCalls=0;adapterAttached=$false;cases=$taskResults} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $taskImages 'status-verification.json') -Encoding utf8
} finally {
    if($taskTest -and -not $taskTest.HasExited){
        # A timeout fails verification. Stop only this audit and its verified child.
        $taskExpected=[IO.Path]::GetFullPath((Join-Path $taskBuild 'Native Hover.exe'))
        Get-CimInstance Win32_Process -Filter ("ParentProcessId="+$taskTest.Id) | Where-Object {
            $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $taskExpected -and
            $_.CommandLine -match '--isolated-session' -and $_.CommandLine -match '--no-auto-attach'
        } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
        Stop-Process -Id $taskTest.Id -ErrorAction SilentlyContinue
    }
    if(Test-Path -LiteralPath (Join-Path $taskFixture 'native-control.info')){& $taskNode (Join-Path $taskRepo 'scripts/native-control.cjs') (Join-Path $taskFixture 'native-control.info') quitIfIdle | Out-Null}
    if(-not $taskChild.WaitForExit(4000)){throw 'Status fixture did not exit normally'}
}
