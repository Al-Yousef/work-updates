# Read-only counters use the original kernel handle, including after normal
# exit. Process.GetProcessById first checks the live-process list and can reject
# an exited process whose kernel object is still available to OpenProcess.
if(-not ('HyphenOwnedProcessHandle' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Threading;
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

// Discovery runs independently of the one-second counter/report cadence. Only
// exact roots and descendants of a retained original parent handle are opened.
public sealed class HyphenOwnedProcessObserver : IDisposable {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct ProcessEntry {
        public uint size, usage, pid;
        public UIntPtr heap;
        public uint module, threads, parent;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
    }
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
    private sealed class Original {
        public HyphenOwnedProcessHandle handle;
        public int pid, parent;
        public string name;
        public DateTime created;
    }
    private readonly object gate=new object();
    private readonly Dictionary<int,long> roots;
    private readonly Dictionary<int,Original> originals=new Dictionary<int,Original>();
    private readonly ManualResetEvent stop=new ManualResetEvent(false);
    private readonly Thread worker;
    private Exception failure;
    private bool disposed;
    private long captures;
    private DateTime lastCapture;
    private double maximumCaptureGapMs;
    public const int DiscoveryIntervalMs=10;
    public const int OriginalHandleLimit=256;

    private static Dictionary<int,ProcessEntry> Snapshot() {
        IntPtr snapshot=CreateToolhelp32Snapshot(2,0); // TH32CS_SNAPPROCESS only.
        if(snapshot==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var rows=new Dictionary<int,ProcessEntry>();
            ProcessEntry entry=new ProcessEntry(); entry.size=(uint)Marshal.SizeOf(typeof(ProcessEntry));
            if(!Process32FirstW(snapshot,ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());
            do { rows.Add(checked((int)entry.pid),entry); } while(Process32NextW(snapshot,ref entry));
            int error=Marshal.GetLastWin32Error();
            if(error!=18) throw new Win32Exception(error); // ERROR_NO_MORE_FILES.
            return rows;
        } finally { CloseHandle(snapshot); }
    }
    private Dictionary<int,ProcessEntry> Capture() {
        var rows=Snapshot();
        DateTime now=DateTime.UtcNow;
        if(lastCapture!=default(DateTime)) maximumCaptureGapMs=Math.Max(maximumCaptureGapMs,(now-lastCapture).TotalMilliseconds);
        lastCapture=now; captures++;
        bool added;
        do {
            added=false;
            foreach(var pair in rows) {
                int pid=pair.Key; var row=pair.Value;
                if(originals.ContainsKey(pid)) continue;
                Original parent;
                bool root=roots.ContainsKey(pid);
                bool descendant=originals.TryGetValue(checked((int)row.parent),out parent);
                if(!root&&!descendant) continue;
                if(originals.Count>=OriginalHandleLimit) throw new InvalidOperationException("Original process handle observer exceeds its finite bound");
                var handle=new HyphenOwnedProcessHandle(pid);
                try {
                    DateTime created=handle.StartTime;
                    if(root&&created.Ticks!=roots[pid]) throw new InvalidOperationException("Original root creation identity changed");
                    if(!root&&(created<parent.created||(parent.handle.HasExited&&created>parent.handle.ExitTime)))
                        throw new InvalidOperationException("Original descendant creation identity changed");
                    originals.Add(pid,new Original {handle=handle,pid=pid,parent=checked((int)row.parent),name=row.name,created=created});
                    added=true;
                } catch { handle.Dispose(); throw; }
            }
        } while(added);
        return rows;
    }
    public HyphenOwnedProcessObserver(Dictionary<int,long> exactRoots) {
        if(exactRoots==null||exactRoots.Count==0) throw new ArgumentException("Exact original roots are required");
        roots=new Dictionary<int,long>(exactRoots);
        try {
            Capture();
            foreach(int pid in roots.Keys) if(!originals.ContainsKey(pid)) throw new InvalidOperationException("Original root is absent from discovery");
            worker=new Thread(Run); worker.IsBackground=true; worker.Name="Hyphen owned process discovery"; worker.Start();
        } catch { foreach(var original in originals.Values) original.handle.Dispose(); stop.Dispose(); throw; }
    }
    private void Run() {
        try {
            while(!stop.WaitOne(DiscoveryIntervalMs)) lock(gate) { if(disposed) return; Capture(); }
        } catch(Exception error) { lock(gate) { failure=error; } }
    }
    private void Check() {
        if(disposed) throw new ObjectDisposedException("HyphenOwnedProcessObserver");
        if(failure!=null) throw new InvalidOperationException("Owned process discovery failed",failure);
    }
    public bool HasPinned(int pid) { lock(gate) { Check(); return originals.ContainsKey(pid); } }
    public int PinnedCount { get { lock(gate) { Check(); return originals.Count; } } }
    private static Dictionary<string,object> Identity(Original original) {
        return new Dictionary<string,object> {
            {"pid",original.pid},{"parentPid",original.parent},{"creationTicks",original.created.Ticks.ToString()},
            {"name",original.name},{"startedAt",original.created.ToString("o")},{"handlePinned",true}
        };
    }
    private static Dictionary<string,object> Exit(Original original) {
        if(!original.handle.HasExited) throw new InvalidOperationException("Original process has no confirmed exit");
        var row=Identity(original);
        row["lifecycle"]="exited"; row["cpuSeconds"]=original.handle.TotalProcessorTime.TotalSeconds;
        row["exitedAt"]=original.handle.ExitTime.ToString("o"); row["exitCode"]=original.handle.ExitCode;
        foreach(string key in new[]{"workingSetBytes","privateBytes","handles","threads"}) row[key]=null;
        return row;
    }
    public Dictionary<string,object> Read() {
        lock(gate) {
            Check(); DateTime at=DateTime.UtcNow; var snapshot=Capture();
            var samples=new List<Dictionary<string,object>>(); var exited=new List<int>();
            foreach(var original in originals.Values) {
                Dictionary<string,object> row;
                if(original.handle.HasExited) { row=Exit(original); exited.Add(original.pid); }
                else {
                    try {
                        ProcessEntry entry;
                        if(!snapshot.TryGetValue(original.pid,out entry)||entry.parent!=(uint)original.parent)
                            throw new InvalidOperationException("Original live process is absent or changed in discovery");
                        row=Identity(original); row["lifecycle"]="running";
                        row["cpuSeconds"]=original.handle.TotalProcessorTime.TotalSeconds;
                        var memory=original.handle.ReadMemory();
                        row["workingSetBytes"]=memory.WorkingSetSize.ToUInt64(); row["privateBytes"]=memory.PrivateUsage.ToUInt64();
                        row["handles"]=original.handle.HandleCount; row["threads"]=entry.threads;
                        // Exit during a read is accounted through the same handle.
                        if(original.handle.HasExited) { row=Exit(original); exited.Add(original.pid); }
                    } catch { if(!original.handle.HasExited) throw; row=Exit(original); exited.Add(original.pid); }
                }
                samples.Add(row);
            }
            foreach(int pid in exited) { originals[pid].handle.Dispose(); originals.Remove(pid); }
            return new Dictionary<string,object> {
                {"at",at.ToString("o")},{"completedAt",DateTime.UtcNow.ToString("o")},{"processes",samples},
                {"wakeups",null},{"wakeupsState","unavailable_without_ETW"},{"unavailableProcesses",0},
                {"discovery",new Dictionary<string,object> { {"method","Toolhelp32 original-handle observer"},{"intervalMs",DiscoveryIntervalMs},
                    {"captures",captures},{"maximumCaptureGapMs",maximumCaptureGapMs},{"handleLimit",OriginalHandleLimit},{"observerOutsideAppTree",true} }}
            };
        }
    }
    public void Dispose() {
        lock(gate) { if(disposed) return; }
        stop.Set();
        if(!worker.Join(5000)) throw new InvalidOperationException("Owned discovery thread did not stop");
        lock(gate) { if(disposed) return; disposed=true; foreach(var original in originals.Values) original.handle.Dispose(); originals.Clear(); stop.Dispose(); }
    }
}
'@
}
