$ErrorActionPreference='Stop'
if($env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This trace runs only on the isolated Windows CI runner. No local policy workaround is supported.'
}
$taskRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'dev-paths.ps1')
$taskNode=Get-HyphenNode
$taskPwsh=(Get-Command pwsh -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$taskCandidate=Join-Path $taskRepo 'native/windows/build/candidate'
& $taskNode -e 'require("./scripts/native-build-audit.cjs").verifyCandidate(process.argv[1])' $taskCandidate
if($LASTEXITCODE -ne 0) {throw 'The trace needs the exact current verified native candidate'}
$taskOutput=Join-Path $taskRepo ('artifacts/performance/etw/'+[Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $taskOutput | Out-Null
$taskTool=Join-Path $taskOutput 'tool'
$taskIntermediate=(Join-Path $taskOutput 'tool-obj')+'/'
& dotnet build (Join-Path $PSScriptRoot 'performance-etw/PerformanceEtw.csproj') --configuration Release --output $taskTool "-p:BaseIntermediateOutputPath=$taskIntermediate" "-p:MSBuildProjectExtensionsPath=$taskIntermediate"
if($LASTEXITCODE -ne 0) {throw 'Pinned TraceEvent audit did not compile'}
$taskToolHashes=@{}
Get-ChildItem -LiteralPath $taskTool -File | ForEach-Object {
    $taskToolHashes[$_.Name]=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
@{schema=1;sourceRevision=(& git -C $taskRepo rev-parse HEAD);dotnetVersion=(& dotnet --version);
    traceEventVersion='3.2.8';toolHashes=$taskToolHashes;nativeCandidateHashes=(Get-Content -LiteralPath (Join-Path $taskCandidate 'build-verification.json') -Raw|ConvertFrom-Json).binaryHashes;
    synthetic=$true;accountsUsed=0;installedAppChanged=$false;rawTracePublished=$false} |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskOutput 'metadata.json') -Encoding utf8
& dotnet (Join-Path $taskTool 'PerformanceEtw.dll') $taskRepo $taskOutput $taskNode $taskPwsh
if($LASTEXITCODE -ne 0) {throw 'Owned ETW trace remains unverified; inspect its bounded report'}
