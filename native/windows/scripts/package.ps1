param([string]$OutputDirectory='build/candidate')
$ErrorActionPreference='Stop'
$taskNative=Split-Path -Parent $PSScriptRoot
$taskRepo=[IO.Path]::GetFullPath((Join-Path $taskNative '../..'))
$taskCandidate=[IO.Path]::GetFullPath((Join-Path $taskNative $OutputDirectory))
if(-not $taskCandidate.StartsWith($taskNative+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Candidate must stay inside native/windows'}
$taskVersion=(Get-Content -LiteralPath (Join-Path $taskRepo 'package.json') -Raw | ConvertFrom-Json).version
$taskDist=Join-Path $taskRepo 'dist'
New-Item -ItemType Directory -Path $taskDist -Force | Out-Null
$taskZip=Join-Path $taskDist ('Hyphen-'+$taskVersion+'-Windows-x64-Native.zip')
$taskChecksum=$taskZip+'.sha256'
Remove-Item -LiteralPath $taskZip,$taskChecksum -Force -ErrorAction SilentlyContinue
& node (Join-Path $taskRepo 'scripts/audit-release.cjs') --include-untracked
if($LASTEXITCODE -ne 0){throw 'Source privacy audit failed'}
& node (Join-Path $taskRepo 'scripts/native-build-audit.cjs') $taskCandidate
if($LASTEXITCODE -ne 0){throw 'Native build identity audit failed'}
foreach($taskBinary in @('Native Hover.exe','Start Native Preview.exe')) {
    $taskResource=(Get-Item -LiteralPath (Join-Path $taskCandidate $taskBinary)).VersionInfo
    if($taskResource.FileVersion -ne $taskVersion -or $taskResource.ProductName -ne 'Hyphen'){throw ('Native PE resources do not match the app: '+$taskBinary)}
}
$taskPackage=Join-Path $taskNative ('build/package-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskPackage | Out-Null
foreach($taskFile in @('Native Hover.exe','Start Native Preview.exe','WorkUpdatesTaskbar-v2.dll','Taskbar Adapter Control.exe','build-verification.json')){
    Copy-Item -LiteralPath (Join-Path $taskCandidate $taskFile) -Destination (Join-Path $taskPackage $taskFile)
}
@"
Hyphen $taskVersion native Windows development candidate

This unsigned package contains the C++ shell, launcher and weather adapter only.
It requires the matching $taskVersion backend, native descriptor work-updates-native-v1,
and snapshot schema 1. It does not install or update an existing app.
Set HYPHEN_INSTALL_ROOT to an existing portable root containing desktop/Work Updates.exe
and data/desktop/. Then run Start Native Preview.exe. This can attach the supported weather
adapter; isolated development must use --bridge, --isolated-session and --no-auto-attach.
Preserve Windows executable protections. A blocked executable is a failed check.
Model and isolated runner checks do not prove physical weather gestures or real chat delivery.
"@ | Set-Content -LiteralPath (Join-Path $taskPackage 'README.txt') -Encoding utf8NoBOM
& node (Join-Path $taskRepo 'scripts/native-build-audit.cjs') $taskCandidate $taskPackage
if($LASTEXITCODE -ne 0){throw 'Native package audit failed'}
Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $taskPackage -File | ForEach-Object {$_.FullName}) -DestinationPath ($taskZip+'.partial.zip') -Force
# Audit the actual archive, rather than assuming the staged files were packaged.
$taskArchive=[IO.Compression.ZipFile]::OpenRead($taskZip+'.partial.zip')
try {
    $taskExpected=@(Get-ChildItem -LiteralPath $taskPackage -File | ForEach-Object {$_.Name} | Sort-Object)
    $taskActual=@($taskArchive.Entries | ForEach-Object {$_.FullName} | Sort-Object)
    if(Compare-Object $taskExpected $taskActual){throw 'Unexpected native ZIP contents'}
    foreach($taskEntry in $taskArchive.Entries){
        $taskStream=$taskEntry.Open()
        try {$taskHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($taskStream))}
        finally {$taskStream.Dispose()}
        if($taskHash -ine (Get-FileHash -LiteralPath (Join-Path $taskPackage $taskEntry.FullName)).Hash){throw 'Native ZIP resource hash mismatch'}
    }
} finally {$taskArchive.Dispose()}
Move-Item -LiteralPath ($taskZip+'.partial.zip') -Destination $taskZip
((Get-FileHash -LiteralPath $taskZip).Hash.ToLowerInvariant()+'  '+(Split-Path -Leaf $taskZip)) | Set-Content -LiteralPath $taskChecksum -Encoding utf8NoBOM
Write-Output ('Native development package verified: '+(Split-Path -Leaf $taskZip))
