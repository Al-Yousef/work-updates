if (-not ('HyphenUpdate.Paths' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
namespace HyphenUpdate {
  public static class Paths {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint GetLongPathName(string path, StringBuilder output, uint length);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint GetShortPathName(string path, StringBuilder output, uint length);
  }
}
'@
}
function Get-UpdateCanonicalPath([string]$Path) {
  $taskAbsolute=[IO.Path]::GetFullPath($Path)
  $taskBuffer=[Text.StringBuilder]::new(32768)
  $taskLength=[HyphenUpdate.Paths]::GetLongPathName($taskAbsolute,$taskBuffer,$taskBuffer.Capacity)
  if (-not $taskLength -or $taskLength -ge $taskBuffer.Capacity) { throw 'The update path cannot be resolved to an existing long Windows path' }
  return $taskBuffer.ToString()
}
