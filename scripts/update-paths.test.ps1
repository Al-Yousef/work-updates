$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'update-paths.ps1')
$taskFixtureParent=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../artifacts'))
New-Item -ItemType Directory -Path $taskFixtureParent -Force | Out-Null
$taskRoot=Join-Path $taskFixtureParent ('Hyphen long path ownership '+[Guid]::NewGuid())
New-Item -ItemType Directory -Path $taskRoot | Out-Null
try {
  $taskBuffer=[Text.StringBuilder]::new(32768)
  $taskLength=[HyphenUpdate.Paths]::GetShortPathName($taskRoot,$taskBuffer,$taskBuffer.Capacity)
  if (-not $taskLength -or $taskLength -ge $taskBuffer.Capacity) { throw 'Short path fixture could not be resolved' }
  if ((Get-UpdateCanonicalPath $taskRoot) -ine (Get-UpdateCanonicalPath $taskBuffer.ToString())) { throw 'Short and long paths do not identify the same installation' }
  $taskOther=Join-Path $taskRoot 'other-profile';New-Item -ItemType Directory -Path $taskOther | Out-Null
  if ((Get-UpdateCanonicalPath $taskRoot) -ieq (Get-UpdateCanonicalPath $taskOther)) { throw 'Distinct profiles were conflated' }
  Write-Output 'Windows short and long ownership paths agree; different profiles remain distinct.'
} finally {
  $taskResolved=[IO.Path]::GetFullPath($taskRoot)
  if ([IO.Path]::GetDirectoryName($taskResolved) -ine $taskFixtureParent) { throw 'Cleanup target is outside the temporary fixture root' }
  Remove-Item -LiteralPath $taskResolved -Recurse -Force
}
