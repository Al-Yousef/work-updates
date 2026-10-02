param(
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [Parameter(Mandatory=$true)][long]$Handle
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ControlHitInspection {
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
}
'@
# WM_NCHITTEST is a read-only query; do not inject input or activate the window.
$taskPoint = [IntPtr](($Y -shl 16) -bor ($X -band 0xffff))
Write-Output ([ControlHitInspection]::SendMessage([IntPtr]$Handle, 0x84, [IntPtr]::Zero, $taskPoint).ToInt64())
