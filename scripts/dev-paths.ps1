function Get-HyphenInstallRoot {
    if (-not $env:HYPHEN_INSTALL_ROOT -or -not [IO.Path]::IsPathFullyQualified($env:HYPHEN_INSTALL_ROOT)) {
        throw 'Set HYPHEN_INSTALL_ROOT to the absolute portable installation directory before using an installed-app audit or updater.'
    }
    [IO.Path]::GetFullPath($env:HYPHEN_INSTALL_ROOT)
}
function Get-HyphenNode {
    if ($env:HYPHEN_NODE) { return (Get-Command $env:HYPHEN_NODE -CommandType Application -ErrorAction Stop).Source }
    (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
