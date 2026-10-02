param(
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [Parameter(Mandatory=$true)][long]$ExpectedHandle
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WeatherHitInspection {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
}
'@
$taskPoint = New-Object WeatherHitInspection+Point
$taskPoint.X = $X
$taskPoint.Y = $Y
# Read the native hit target without activating a window or injecting input.
$taskWindow = [WeatherHitInspection]::WindowFromPoint($taskPoint)
$taskHit = [WeatherHitInspection]::GetAncestor($taskWindow, 2).ToInt64()
Write-Output ($taskHit -eq $ExpectedHandle).ToString().ToLowerInvariant()
