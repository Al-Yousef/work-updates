# Read-only counters use the original kernel handle, including after normal
# exit. Process.GetProcessById first checks the live-process list and can reject
# an exited process whose kernel object is still available to OpenProcess.
if(-not ('HyphenOwnedProcessHandle' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class HyphenOwnedProcessHandle : IDisposable {
    private readonly SafeProcessHandle handle;
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetProcessTimes(SafeProcessHandle process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetExitCodeProcess(SafeProcessHandle process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetProcessHandleCount(SafeProcessHandle process, out uint count);
    [StructLayout(LayoutKind.Sequential)]
    public struct MemoryCounters {
        public uint cb, PageFaultCount;
        public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage,
            QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage;
    }
    [DllImport("psapi.dll", SetLastError=true)]
    private static extern bool GetProcessMemoryInfo(SafeProcessHandle process, ref MemoryCounters counters, uint size);
    private static void Check(bool success) { if(!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public HyphenOwnedProcessHandle(int pid) {
        // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ.
        // No termination, mutation, inherited handle or privilege adjustment.
        handle=OpenProcess(0x00101010, false, pid);
        if(handle.IsInvalid) { int error=Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
    }
    private long[] Times() {
        long creation, exit, kernel, user;
        Check(GetProcessTimes(handle, out creation, out exit, out kernel, out user));
        return new long[] {creation, exit, kernel, user};
    }
    public DateTime StartTime { get { return DateTime.FromFileTimeUtc(Times()[0]); } }
    public TimeSpan TotalProcessorTime { get { long[] times=Times(); return TimeSpan.FromTicks(checked(times[2]+times[3])); } }
    public bool HasExited {
        get { uint result=WaitForSingleObject(handle, 0); if(result==0) return true; if(result==258) return false; throw new Win32Exception(Marshal.GetLastWin32Error()); }
    }
    public DateTime ExitTime { get { if(!HasExited) throw new InvalidOperationException("Original process has not exited"); return DateTime.FromFileTimeUtc(Times()[1]); } }
    public int ExitCode { get { if(!HasExited) throw new InvalidOperationException("Original process has not exited"); uint code; Check(GetExitCodeProcess(handle, out code)); return unchecked((int)code); } }
    public MemoryCounters ReadMemory() {
        MemoryCounters counters=new MemoryCounters(); counters.cb=(uint)Marshal.SizeOf(typeof(MemoryCounters));
        Check(GetProcessMemoryInfo(handle, ref counters, counters.cb)); return counters;
    }
    public uint HandleCount { get { uint count; Check(GetProcessHandleCount(handle, out count)); return count; } }
    public void Dispose() { handle.Dispose(); }
}
'@
}
