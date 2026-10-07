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
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", SetLastError=true)]
  private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("kernel32.dll")] private static extern void SetLastError(uint error);
  public static ulong Query(IntPtr window, IntPtr point) {
    UIntPtr result; SetLastError(0);
    // Abort a hung target or destroyed window; never manufacture HTCLIENT.
    if (SendMessageTimeout(window, 0x84, IntPtr.Zero, point, 0x22, 5000, out result) == IntPtr.Zero)
      throw new InvalidOperationException("Owned window hit-test failed or timed out; Win32 error " + Marshal.GetLastWin32Error());
    return result.ToUInt64();
  }
}
'@
# WM_NCHITTEST is a read-only query; do not inject input or activate the window.
$taskPoint = [IntPtr](($Y -shl 16) -bor ($X -band 0xffff))
Write-Output ([ControlHitInspection]::Query([IntPtr]$Handle, $taskPoint))
