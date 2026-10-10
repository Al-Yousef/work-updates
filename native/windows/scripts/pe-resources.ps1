function Get-HyphenPeResources {
    param([Parameter(Mandatory)][string]$Candidate)
    $taskRows=@()
    foreach($taskName in @('Native Hover.exe','Start Native Preview.exe','WorkUpdatesTaskbar-v2.dll','Taskbar Adapter Control.exe')) {
        $taskPath=Join-Path $Candidate $taskName
        $taskFile=Get-Item -LiteralPath $taskPath -ErrorAction Stop
        if($taskFile.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Native metadata may not follow a reparse point'}
        $taskBefore=(Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $taskResource=[Diagnostics.FileVersionInfo]::GetVersionInfo($taskFile.FullName)
        $taskSignature=Get-AuthenticodeSignature -LiteralPath $taskPath -ErrorAction Stop
        $taskRows+=@{name=$taskName;sha256=$taskBefore;bytes=$taskFile.Length;
            productName=$taskResource.ProductName;fileVersion=$taskResource.FileVersion;
            productVersion=$taskResource.ProductVersion;signatureStatus=[string]$taskSignature.Status;
            hasSignerCertificate=($null -ne $taskSignature.SignerCertificate)}
        if((Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $taskBefore){throw 'Native file changed during metadata inspection'}
    }
    return $taskRows
}
