param([switch]$Run,[switch]$NativeIntegration,[switch]$PreserveAdapter,[string]$LinkerPath,[string]$OutputDirectory='build',[string]$ToolchainDirectory='')
$ErrorActionPreference='Stop'
$taskRoot=$PSScriptRoot
if(-not $ToolchainDirectory){$ToolchainDirectory=Join-Path $taskRoot '.tools/llvm-mingw-20260922-ucrt-x86_64'}
$taskToolchain=Join-Path ([IO.Path]::GetFullPath($ToolchainDirectory)) 'bin'
$taskCompiler=Join-Path $taskToolchain 'clang-23.exe'
$taskCompilerFlags=@('--driver-mode=g++')
if($LinkerPath){if(-not(Test-Path -LiteralPath $LinkerPath)){throw 'Requested linker missing'};$taskCompilerFlags+=('--ld-path='+[IO.Path]::GetFullPath($LinkerPath))}
if(-not(Test-Path -LiteralPath $taskCompiler)) {throw 'Portable LLVM-MinGW compiler missing; see README.md.'}
$taskBuild=[IO.Path]::GetFullPath((Join-Path $taskRoot $OutputDirectory))
if(-not $taskBuild.StartsWith($taskRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Build output must stay in this project'}
New-Item -ItemType Directory -Path (Join-Path $taskBuild 'artifacts') -Force | Out-Null
# A failed build must never reuse a previous candidate as a verified release.
$taskManifest=Join-Path $taskBuild 'build-verification.json'
Remove-Item -LiteralPath $taskManifest -Force -ErrorAction SilentlyContinue
$taskSourceHashes=@{}
$taskSources=@('build.ps1','app.rc','app.manifest','toolchain.json','bootstrap-toolchain.ps1','THIRD_PARTY_NOTICES.txt')
$taskSources+=@(Get-ChildItem (Join-Path $taskRoot 'src'),(Join-Path $taskRoot 'tests'),(Join-Path $taskRoot 'taskbar-adapter'),(Join-Path $taskRoot 'vendor'),(Join-Path $taskRoot 'assets') -Recurse -File | ForEach-Object {[IO.Path]::GetRelativePath($taskRoot,$_.FullName).Replace('\','/')})
foreach($taskSource in $taskSources){$taskSourceHashes[$taskSource]=(Get-FileHash -LiteralPath (Join-Path $taskRoot $taskSource)).Hash}
Push-Location $taskRoot
try {
    & (Join-Path $taskToolchain 'llvm-rc.exe') /no-preprocess /FO (Join-Path $taskBuild 'app.res') app.rc
    if($LASTEXITCODE -ne 0) {throw 'Resource build failed'}
    & $taskCompiler @taskCompilerFlags src/main.cpp (Join-Path $taskBuild 'app.res') -std=c++20 -O2 -DNDEBUG -municode -mwindows -static -Wall -Wextra -o (Join-Path $taskBuild 'Native Hover.exe') -ldcomp -ld2d1 -ld3d11 -ldxgi -ldwrite -lshell32 -luser32 -lole32 -loleaut32 -loleacc -lcomctl32 -luuid -lgdi32 -lpsapi -ladvapi32 -lbcrypt -lwindowscodecs -lcomdlg32
    if($LASTEXITCODE -ne 0) {throw 'Native build failed'}
    & $taskCompiler @taskCompilerFlags src/launch.cpp (Join-Path $taskBuild 'app.res') -std=c++20 -O2 -municode -mwindows -static -Wall -Wextra -o (Join-Path $taskBuild 'Start Native Preview.exe') -luser32 -lshell32
    if($LASTEXITCODE -ne 0) {throw 'Native launcher build failed'}
    $taskObjects=@()
    foreach($taskSource in @('buffer','hook','trampoline','hde/hde64')) {
        $taskObject=Join-Path $taskBuild (($taskSource.Replace('/','-'))+'.o')
        & (Join-Path $taskToolchain 'clang-23.exe') ('taskbar-adapter/vendor/minhook/src/'+$taskSource+'.c') -O2 -DNDEBUG -c -o $taskObject
        if($LASTEXITCODE -ne 0){throw 'MinHook source build failed'}
        $taskObjects+=$taskObject
    }
    if($PreserveAdapter){foreach($taskBinary in @('WorkUpdatesTaskbar-v2.dll','Taskbar Adapter Control.exe')){
        $taskAdapterSource=Join-Path $taskRoot ('build/'+$taskBinary)
        $taskAdapterDestination=Join-Path $taskBuild $taskBinary
        if((Test-Path -LiteralPath $taskAdapterDestination) -and (Get-FileHash -LiteralPath $taskAdapterDestination).Hash -eq (Get-FileHash -LiteralPath $taskAdapterSource).Hash){continue}
        Copy-Item -LiteralPath $taskAdapterSource -Destination $taskAdapterDestination -Force
    }}else {
    & $taskCompiler @taskCompilerFlags taskbar-adapter/adapter.cpp @taskObjects -std=c++20 -O2 -DNDEBUG -shared -static -Wall -Wextra -o (Join-Path $taskBuild 'WorkUpdatesTaskbar-v2.dll') -lbcrypt -lruntimeobject -lole32 -luser32
    if($LASTEXITCODE -ne 0){throw 'Taskbar adapter build failed'}
    & $taskCompiler @taskCompilerFlags taskbar-adapter/control.cpp -std=c++20 -O2 -municode -static -Wall -Wextra -o (Join-Path $taskBuild 'Taskbar Adapter Control.exe') -lbcrypt -luser32
    if($LASTEXITCODE -ne 0){throw 'Taskbar controller build failed'}
    }
    & $taskCompiler @taskCompilerFlags tests/motion.cpp -std=c++20 -O2 -static -o (Join-Path $taskBuild 'motion-tests.exe')
    if($LASTEXITCODE -ne 0) {throw 'Motion test build failed'}
    & (Join-Path $taskBuild 'motion-tests.exe')
    if($LASTEXITCODE -ne 0) {throw 'Motion checks failed'}
    & $taskCompiler @taskCompilerFlags tests/input-policy.cpp -std=c++20 -O2 -static -o (Join-Path $taskBuild 'input-tests.exe')
    if($LASTEXITCODE -ne 0) {throw 'Input test build failed'}
    & (Join-Path $taskBuild 'input-tests.exe')
    if($LASTEXITCODE -ne 0) {throw 'Input checks failed'}
    & $taskCompiler @taskCompilerFlags tests/queue-model.cpp -std=c++20 -O2 -static -o (Join-Path $taskBuild 'queue-tests.exe')
    if($LASTEXITCODE -ne 0) {throw 'Queue model test build failed'}
    & (Join-Path $taskBuild 'queue-tests.exe')
    if($LASTEXITCODE -ne 0) {throw 'Queue model checks failed'}
    & $taskCompiler @taskCompilerFlags tests/taskbar-adapter.cpp @taskObjects -std=c++20 -O2 -static -Wall -Wextra -o (Join-Path $taskBuild 'adapter-tests.exe') -lbcrypt -lruntimeobject -lole32 -luser32
    if($LASTEXITCODE -ne 0){throw 'Adapter test build failed'}
    & (Join-Path $taskBuild 'adapter-tests.exe')
    if($LASTEXITCODE -ne 0){throw 'Adapter checks failed'}
    & $taskCompiler @taskCompilerFlags tests/native-adapter.cpp -std=c++20 -O2 -static -Wall -Wextra -o (Join-Path $taskBuild 'native-adapter-tests.exe') -lbcrypt -luser32
    if($LASTEXITCODE -ne 0){throw 'Native integration test build failed'}
    & $taskCompiler @taskCompilerFlags tests/native-queue.cpp -std=c++20 -O2 -municode -static -Wall -Wextra -o (Join-Path $taskBuild 'native-queue-tests.exe') -luser32
    if($LASTEXITCODE -ne 0){throw 'Native queue integration test build failed'}
    & $taskCompiler @taskCompilerFlags tests/native-ux.cpp -std=c++20 -O2 -municode -static -Wall -Wextra -o (Join-Path $taskBuild 'native-ux-tests.exe') -luser32 -lole32 -loleacc -loleaut32 -luuid
    if($LASTEXITCODE -ne 0){throw 'Native UX test build failed'}
    & $taskCompiler @taskCompilerFlags tests/native-responsiveness.cpp -std=c++20 -O2 -municode -static -Wall -Wextra -o (Join-Path $taskBuild 'native-responsiveness-tests.exe') -luser32
    if($LASTEXITCODE -ne 0){throw 'Native responsiveness test build failed'}
    if($NativeIntegration) {
        & (Join-Path $taskBuild 'native-adapter-tests.exe')
        if($LASTEXITCODE -ne 0){throw 'Native adapter integration failed'}
    } else {Write-Output 'Native desktop integration test built; run native-adapter-tests.exe on the real desktop.'}
} finally {Pop-Location}
foreach($taskSource in $taskSourceHashes.Keys){if((Get-FileHash -LiteralPath (Join-Path $taskRoot $taskSource)).Hash -ine $taskSourceHashes[$taskSource]){throw 'Source changed during build; candidate is unverified'}}
$taskBinaryHashes=@{}
foreach($taskBinary in @('Native Hover.exe','Start Native Preview.exe','WorkUpdatesTaskbar-v2.dll','Taskbar Adapter Control.exe')){$taskBinaryHashes[$taskBinary]=(Get-FileHash -LiteralPath (Join-Path $taskBuild $taskBinary)).Hash}
@{built=$true;modelTestsPassed=$true;sourceHashes=$taskSourceHashes;binaryHashes=$taskBinaryHashes}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $taskManifest -Encoding utf8
Get-Item (Join-Path $taskBuild 'Native Hover.exe') | Select-Object FullName,Length
if($Run) {Start-Process -FilePath (Join-Path $taskBuild 'Native Hover.exe') -WindowStyle Hidden}
