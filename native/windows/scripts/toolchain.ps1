function Get-HyphenToolchain {
    param([Parameter(Mandatory)][string]$Directory,[string]$LinkerPath='')
    $taskLock=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../toolchain.json') -Raw | ConvertFrom-Json
    $taskBin=Join-Path ([IO.Path]::GetFullPath($Directory)) 'bin'
    $taskHashes=[ordered]@{}
    foreach($taskEntry in $taskLock.binaries.PSObject.Properties) {
        $taskFile=Join-Path $taskBin $taskEntry.Name
        if(-not(Test-Path -LiteralPath $taskFile -PathType Leaf)){throw ('Locked toolchain file missing: '+$taskEntry.Name+'; run bootstrap-toolchain.ps1')}
        $taskHash=(Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash.ToLowerInvariant()
        if($taskHash -cne $taskEntry.Value){throw ('Locked toolchain digest mismatch: '+$taskEntry.Name)}
        $taskHashes[$taskEntry.Name]=$taskHash
    }
    $taskLinker=if($LinkerPath){[IO.Path]::GetFullPath($LinkerPath)}else{Join-Path $taskBin 'ld.lld.exe'}
    if(-not(Test-Path -LiteralPath $taskLinker -PathType Leaf)){throw 'Requested linker missing'}
    if((Get-FileHash -LiteralPath $taskLinker).Hash -ine $taskLock.binaries.'ld.lld.exe'){throw 'Requested linker does not match the locked LLD release'}
    $taskCompiler=Join-Path $taskBin 'clang-23.exe'
    try {
        $taskCompilerVersion=@(& $taskCompiler --version)[0]
        if($LASTEXITCODE -ne 0){throw 'Compiler version check failed'}
        $taskLinkerVersion=@(& $taskLinker --version)[0]
        if($LASTEXITCODE -ne 0){throw 'Linker version check failed'}
    } catch {throw ('The locked toolchain could not run. Preserve Windows protections; see README.md. '+$_.Exception.Message)}
    $taskVersion=[regex]::Escape($taskLock.llvmVersion)
    if($taskCompilerVersion -notmatch ('^clang version '+$taskVersion+'\b') -or $taskLinkerVersion -notmatch ('^LLD '+$taskVersion+'\b')){throw 'Compiler/linker version does not match toolchain.json'}
    return @{bin=$taskBin;compiler=$taskCompiler;linker=$taskLinker;record=@{tag=$taskLock.tag;llvmVersion=$taskLock.llvmVersion;archiveSha256=$taskLock.sha256;binaryHashes=$taskHashes}}
}
