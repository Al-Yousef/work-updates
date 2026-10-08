using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Parsers;
using Microsoft.Diagnostics.Tracing.Parsers.Kernel;
using Microsoft.Diagnostics.Tracing.Session;

// This tool never runs on the user's desktop. A unique non-restarting ETW
// session owns its file; only records descended from retained child handles
// reach the public report. Raw system traces remain in ignored CI storage.
if (Environment.GetEnvironmentVariable("CI") != "true" ||
    Environment.GetEnvironmentVariable("RUNNER_OS") != "Windows" ||
    !OperatingSystem.IsWindowsVersionAtLeast(10) || TraceEventSession.IsElevated() != true || args.Length != 4)
    throw new InvalidOperationException("Isolated elevated Windows CI is required; do not bypass local executable policy.");

var repo = Path.GetFullPath(args[0]);
var directory = Path.GetFullPath(args[1]);
if (!directory.StartsWith(Path.Combine(repo, "artifacts", "performance", "etw") + Path.DirectorySeparatorChar,
    StringComparison.OrdinalIgnoreCase) || !Directory.Exists(directory) ||
    !Path.IsPathFullyQualified(args[2]) || !Path.IsPathFullyQualified(args[3]))
    throw new InvalidOperationException("A new private CI output and exact tool paths are required.");
var traceFile = Path.Combine(directory, "owned.etl");
var reportFile = Path.Combine(directory, "verification.json");
var roots = new List<OwnedRoot>();
bool ownedSessionStopped = false;
int recordedLoss = -1;
try {
    using (var session = new TraceEventSession("Hyphen-owned-" + Guid.NewGuid(), traceFile,
        TraceEventSessionOptions.Create | TraceEventSessionOptions.NoRestartOnCreate)) {
        session.StopOnDispose = true;
        session.BufferSizeMB = 64;
        if (session.EnableKernelProvider(KernelTraceEventParser.Keywords.Process |
            KernelTraceEventParser.Keywords.Thread | KernelTraceEventParser.Keywords.ContextSwitch))
            throw new InvalidOperationException("An existing trace was encountered; no existing session may be adopted.");
        await RunOwned("short_lived_fixture", args[2], new[] {
            Path.Combine(repo,"scripts","owned-etw-burst.cjs"),Path.Combine(directory,"burst.json") });
        await RunOwned("native_pilot", args[3], new[] {
            "-NoProfile","-File",Path.Combine(repo,"scripts","native-performance-audit.ps1"),
            "-SecondsPerPhase","6","-ChatCounts","100","-OutputDirectory",Path.Combine(directory,"pilot") });
        await Task.Delay(1500); // Let the owned helper exits reach the file logger.
        recordedLoss = session.EventsLost;
        if (!session.Stop()) throw new InvalidOperationException("Owned ETW session stop was not confirmed.");
        ownedSessionStopped = true;
    }
    if (recordedLoss != 0 || !ownedSessionStopped) throw new InvalidOperationException("Trace loss or cleanup is unverified.");
    var facts = new List<Fact>();
    int fileLoss;
    using (var source = new ETWTraceEventSource(traceFile)) {
        void Add(bool start, ProcessTraceData data) {
            if (facts.Count >= 50000) throw new InvalidOperationException("Process trace exceeds its finite bound.");
            facts.Add(new Fact(start,data.ProcessID,data.ParentID,data.UniqueProcessKey,data.TimeStampRelativeMSec,
                data.TimeStamp.ToUniversalTime(),data.ExitStatus,facts.Count));
        }
        source.Kernel.ProcessStart += data => Add(true,data);
        source.Kernel.ProcessStop += data => Add(false,data);
        source.Process(); fileLoss=source.EventsLost;
    }
    if (fileLoss != 0) throw new InvalidOperationException("The saved trace reports lost events.");
    var active = new Dictionary<int,Instance>();
    var instances = new List<Instance>();
    foreach (var fact in facts.OrderBy(x=>x.AtMs).ThenBy(x=>x.Order)) {
        if (fact.Start) {
            if (active.ContainsKey(fact.Pid)) throw new InvalidOperationException("Overlapping process lifetimes cannot be resolved.");
            var instance=new Instance(fact);
            var root=roots.SingleOrDefault(r=>r.Process.Id==fact.Pid && fact.Parent==Environment.ProcessId);
            if (root != null) {
                if (Math.Abs((fact.At-root.StartedAt).TotalSeconds)>1 || fact.Key==0)
                    throw new InvalidOperationException("Original root creation identity was not confirmed.");
                instance.Group=root.Kind; root.IdentityMatches++;
            } else if (active.TryGetValue(fact.Parent,out var parent)) instance.Group=parent.Group;
            if(instance.Group != null && fact.Key==0) throw new InvalidOperationException("Owned kernel process key is unavailable.");
            active.Add(fact.Pid,instance); instances.Add(instance);
        } else if (active.TryGetValue(fact.Pid,out var instance)) {
            if(instance.Birth.Key!=fact.Key) throw new InvalidOperationException("Process stop belongs to a different kernel object.");
            instance.End=fact; active.Remove(fact.Pid);
        }
    }
    var owned=instances.Where(x=>x.Group!=null).ToArray();
    if(roots.Count!=2 || roots.Any(r=>r.IdentityMatches!=1 || r.Process.ExitCode!=0) ||
        owned.Length<12 || owned.Any(x=>x.End==null))
        throw new InvalidOperationException("Owned process starts, exits or original roots are incomplete.");
    var burst=JsonDocument.Parse(File.ReadAllText(Path.Combine(directory,"burst.json")));
    if(!burst.RootElement.GetProperty("normalExit").GetBoolean()) throw new InvalidOperationException("Owned burst did not exit normally.");
    var childPids=burst.RootElement.GetProperty("children").EnumerateArray().Select(x=>x.GetProperty("pid").GetInt32()).ToArray();
    if(childPids.Length!=8 || childPids.Distinct().Count()!=8 || childPids.Any(pid=>
        owned.Count(x=>x.Group=="short_lived_fixture" && x.Birth.Pid==pid && x.End?.ExitCode==0)!=1))
        throw new InvalidOperationException("The trace missed a known short-lived child or its matching normal exit.");
    var ownedByPid=owned.GroupBy(x=>x.Birth.Pid).ToDictionary(g=>g.Key,g=>g.ToArray());
    using(var source=new ETWTraceEventSource(traceFile)) {
        long switches=0;
        source.Kernel.ThreadCSwitch += data => {
            if(++switches>10000000) throw new InvalidOperationException("Scheduling trace exceeds its finite bound.");
            if(ownedByPid.TryGetValue(data.NewProcessID,out var candidates)) {
                var instance=candidates.SingleOrDefault(x=>x.Birth.AtMs<=data.TimeStampRelativeMSec && x.End!.AtMs>=data.TimeStampRelativeMSec);
                if(instance!=null) instance.ScheduledIn++;
            }
        };
        source.Process();
        if(source.EventsLost!=0) throw new InvalidOperationException("Scheduling trace reports lost events.");
    }
    if(owned.Where(x=>x.Group=="native_pilot").Sum(x=>x.ScheduledIn)<=0)
        throw new InvalidOperationException("Owned native scheduling events are missing.");
    var pilot=JsonDocument.Parse(File.ReadAllText(Path.Combine(directory,"pilot","verification.json")));
    if(!pilot.RootElement.GetProperty("passed").GetBoolean()) throw new InvalidOperationException("Native pilot did not pass its own checks.");
    var report=new { schema=1,passed=true,synthetic=true,accountsUsed=0,modelCalls=0,installedAppChanged=false,
        evidence="owned CI ETW lifecycle and scheduling events", provider="Microsoft.Diagnostics.Tracing.TraceEvent 3.2.8",
        recordedEventsLost=recordedLoss,savedEventsLost=fileLoss,ownedSessionStopped,
        knownShortLivedChildrenVerified=childPids.Length,originalRootsVerified=roots.Count,
        processStarts=owned.Length,processExits=owned.Count(x=>x.End!=null),
        processes=owned.Select(x=>new {group=x.Group,pid=x.Birth.Pid,parentPid=x.Birth.Parent,
            originalKernelKeyVerified=x.Birth.Key!=0,startedAt=x.Birth.At,exitedAt=x.End!.At,
            exitCode=x.End.ExitCode,scheduledIn=x.ScheduledIn}),
        rawTraceSha256=Hash(traceFile),rawTracePublished=false,
        limits="Bounded synthetic Windows CI trace only. Context switches are scheduling observations, not CPU hardware wakeups or energy. Not physical input, a before/after optimization comparison, permanent lifecycle coverage, or installed-app evidence." };
    File.WriteAllText(reportFile,JsonSerializer.Serialize(report,new JsonSerializerOptions{WriteIndented=true}));
    Console.WriteLine($"Owned ETW trace passed: {owned.Length} starts/exits, eight short-lived children, zero recorded loss.");
} catch(Exception error) {
    File.WriteAllText(reportFile,JsonSerializer.Serialize(new {schema=1,passed=false,
        ownedSessionStopped,recordedEventsLost=recordedLoss,ownedRoots=roots.Count,
        error=error.GetType().Name,reason=error.Message,accountsUsed=0,installedAppChanged=false}));
    throw;
} finally { foreach(var root in roots) root.Process.Dispose(); }

string Hash(string file) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).ToLowerInvariant();
async Task RunOwned(string kind,string executable,IEnumerable<string> arguments) {
    var info=new ProcessStartInfo(executable){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=repo};
    foreach(var argument in arguments) info.ArgumentList.Add(argument);
    var process=Process.Start(info) ?? throw new InvalidOperationException("Owned fixture did not start.");
    _=process.Handle; // Pin the original object until the saved trace is checked.
    roots.Add(new OwnedRoot(kind,process,process.StartTime.ToUniversalTime()));
    var watch=Stopwatch.StartNew();
    try {
        while(!process.HasExited) {
            if(watch.Elapsed.TotalSeconds>180 || (File.Exists(traceFile)&&new FileInfo(traceFile).Length>256L*1024*1024))
                throw new InvalidOperationException("Owned fixture or trace exceeded its bounded observation.");
            await Task.Delay(100);
        }
        await process.WaitForExitAsync();
        if(process.ExitCode!=0) throw new InvalidOperationException("Owned fixture exited without a passing result.");
    } finally {
        if(!process.HasExited) { process.Kill(entireProcessTree:true); await process.WaitForExitAsync(); }
    }
}
record Fact(bool Start,int Pid,int Parent,ulong Key,double AtMs,DateTime At,int ExitCode,int Order);
sealed class Instance(Fact birth) { public Fact Birth=birth; public Fact? End; public string? Group; public long ScheduledIn; }
sealed class OwnedRoot(string kind,Process process,DateTime startedAt) {
    public string Kind=kind; public Process Process=process; public DateTime StartedAt=startedAt; public int IdentityMatches;
}
