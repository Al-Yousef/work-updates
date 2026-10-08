# Whole-process performance evidence

Related: #13. The native Windows UI still uses an Electron backend, utility
helpers and a Python collector. A hidden renderer count of zero is useful but
does not describe whole-app memory or CPU. This candidate adds measurement;
it does not claim a runtime migration or measured savings.

The Windows CI pilot builds the verified current native candidate, creates
100, 500 and 1,500 synthetic original source records, and launches the actual
native shell, hidden Electron composition root and production Python observer.
Only its exact disposable source/profile and its own process handles are used.
The preloader substitutes fixture model answers and synthetic work transport;
it is absent from the production startup path. Explorer attachment is disabled.
The local native executable-policy block is preserved. The native pilot runs
only on Windows CI, not through a renamed or moved local binary.

Each workload measures warm idle, hidden idle, synthetic active stream,
identity-checked chat switching, actual 4,096-pixel image decode and synthetic
source messaging. Native Win32 handlers are timed separately from detail,
network or model completion. The messaging phase also clicks the actual owned
composer, verifies its focus and unchanged source/selection, and records focus
handler timing separately. A snapshot whose row moved before mouse-down is
cancelled before release and cannot count as an accepted selection. The report
gives sample counts, p50/p95/p99 handler
latency and measured exceptions to the 100 ms local-response goal. These are
simulated owned-window inputs; physical input remains a separate gate.

The sampler starts with the two process handles created by the benchmark,
pins their creation identity, recursively includes descendants and retains
previously observed child identities. Reused PIDs and descendants older than
their claimed parent are refused. Raw samples retain timestamp, instance
identity, process name, cumulative CPU, working/private bytes, handles and
threads. Commands, account identifiers and environment variables are omitted.
CPU differences divide by actual elapsed sample time and logical processors.
The sampler pins every discovered original kernel handle before reading live
counters, handling newly born processes first. Thread enumeration on one process
cannot delay pinning a short-lived sibling. Failure records identify the stage
and exception type without exposing commands or environment variables. A newly born child contributes its
measured cumulative CPU only when its exact creation time falls within the
observed interval. An observed exit contributes final cumulative CPU and exit
time read through that same handle, once, then releases the handle. Its live
memory/handle/thread fields remain null; it is excluded from subsequent live
totals only after the kernel confirms exit. Unobserved births, missing final
CPU, replaced identities and inaccessible instances disclose measurement gaps;
their usage is never converted to zero. Original backend/native/collector
processes must remain live throughout every phase. Sample collection start/end
times are retained, and all observer handles close on success or failure.
Abnormal observed helper exits fail reporting. Sampling overhead is included. Wakeups need
ETW evidence and remain null here.

CI uses six seconds per phase as an initial pilot. The script's default is
thirty seconds, with an explicit sample interval. Metadata includes source
revision, Windows build, hardware, logical CPUs and physical memory. Reports
also retain the exposed processor model, core topology and maximum clock. The
hardware fingerprint canonicalizes nested object fields so PowerShell JSON
field ordering cannot turn the same runner into an incomparable machine. Reports
must show the backend, native shell and collector, exercise every required
phase and respect native cache bounds: twelve recent chats, 512 text layouts
and 32 decoded images. Normal process exit is required. Forced cleanup is
recorded as a failed run and cannot produce successful verification.

The comparison contract requires at least five independent runs on matching
hardware, OS and workload, and rejects partial measurements. Its proposed
threshold is the baseline median plus the larger of three baseline IQRs or a
15% allowance. The allowance is explicit policy, not measured savings. No
threshold is enforced from a single pilot. Repeated comparable baselines,
long-run growth checks, wakeups, before/after optimization comparisons and
physical interaction remain required before #13 closes.

The QA runner now records stop-to-observed-exit duration separately from total
startup/run time. Cleanup tests check the actual exit precedes the child's
self-cleanup guard, observes exit, and meets the enforced cleanup deadline.
They retain failed and unverified cleanup as failures. This removes an
unrelated three-second total-time assertion that failed during heavy Windows
test concurrency while the owned child had correctly stopped.

Source validation covers CPU normalization, complete process sums, missing
metrics/PID reuse, noisy/incomparable baselines, the actual owned two-process
sampler, and the existing actual-child interruption/timeout/storage-failure
cases. Live account/model/installed data checks are not part of this pilot.

The separate `Repeated whole-process performance qualification` workflow now
launches five independent complete baselines, a sixth comparison, and a ten-minute
1,500-source navigation/reconnect observation. All run sequentially on the same
Windows runner with thirty seconds per ordinary phase. Run UUIDs and original
backend/native/collector creation identities prevent copied runs from counting as
independent. Missing process measurements, changed hardware/workloads, short raw
measurements, missing accepted interactions, cache overflows, uncertain shutdown
and regression thresholds fail qualification. The reconnect fixture destroys only
its own authenticated queue subscription sockets; the native corner ownership
lease stays alive. Losing that lease correctly exits the shell and releases the
corner, so it is a separate lifecycle check. Qualification requires observed
fresh subscriptions after at least ten disruptions, with the same original
native process and its unchanged ownership lease.

The growth gate compares five equal sample windows using final versus first median
private/working memory, handle and thread totals. Its explicit allowance is the
largest of three first-window IQRs, ten percent, or a per-metric floor of 16 MiB
private memory, 32 MiB working memory, 64 handles or eight threads. Those floors are
measurement policy, not savings. Native cache bounds are checked at every soak
sample, and navigation must visit more than the twelve-chat cache capacity. A
passing ten-minute observation cannot prove indefinite leak freedom. The report
retains all local handler exceptions to the 100 ms goal and separates Electron
backend/helpers from native shell and collector metrics. JSON-only CI artifacts
allow reviewing evidence without downloading a native executable or package.

This exit accounting uses read-only [OpenProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess)
and [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)
on the original kernel handle. An exited process object can still be opened while
another original handle retains it; `Process.GetProcessById` first checks the
live-process list and rejects that object. The actual owned Node-child test
reproduces this rejection and verifies direct kernel acquisition after exit
between metadata discovery and pinning. It separately verifies exit between
pinning and live counter reads, unchanged creation identity, final CPU, null live
counters and immediate handle release. Live memory and handle counts use the
same original handle; thread count uses the exact-identity CIM discovery snapshot.
Counter reads are limited to proven owned descendants; no process mutations or
privilege adjustments are used.
Unknown
departures and forged/revived exits remain failed report-policy tests. The
qualification artifact also retains its synthetic startup count/owner record
and reconnect counters.

The workflow establishes candidate resource thresholds from five observed runs;
it does not compare two different implementations or establish ETW wakeups/energy,
physical interaction, installed-app behavior or real-account delivery. Each future
optimization needs its own matching before/after comparison and appropriate
physical scheduling/rendering checks before performance improvements are claimed.

The first complete qualification on the handle-pinning implementation retained
all 115 cases with no process-measurement gaps and a passing ten-minute growth
observation, but failed two CPU p95 thresholds at 500 sources. Hidden idle measured
4.697 percent against a 4.488 percent limit; chat switching measured 12.136 percent
against an 11.997 percent limit. The raw failed report is retained in
[run 37721292132](https://github.com/Al-Yousef/work-updates/actions/runs/37721292132).
This is an observed failure on the same implementation, not evidence of an
optimization regression or an established explanation for the variability.
Repeating qualification keeps the workload and thresholds unchanged. Artifact
names include the run attempt so retry evidence can coexist instead of colliding
with an immutable prior artifact. A later passing observation does not erase the
failed measurements or establish that these empirical limits never fluctuate.

Subsequent source inspection found that the old hidden-idle fixture hid the HWND
directly while leaving the application in its pinned mode. It therefore kept
rendering incoming updates and did not exercise production hidden idle. The
corrected fixture sends the normal close/hide command and reopens through the
normal tray pin action. Every process sample retains the original native PID,
application mode, actual window visibility and surface draw counter. Hidden idle
must remain hidden and produce no surface draws for the entire observation;
visible phases must remain pinned and visible. Reports without this evidence are
rejected. The earlier hidden-idle result is retained as historical evidence of
that incorrect workload, and the separate chat-switching CPU variation remains
unexplained. Workload durations and regression thresholds are unchanged.

The corrected-mode [run 37727957985](https://github.com/Al-Yousef/work-updates/actions/runs/37727957985)
completed its soak and all five baselines, then rejected one short-lived Electron
helper during the final comparison at handle acquisition. Its failed raw samples
remain retained. Direct kernel acquisition addresses the demonstrated live-list
race without treating an unavailable process as zero or discarding its sample.
A destroyed kernel object, changed creation identity or missing counter still
fails qualification. Polling does not establish a complete process-lifecycle
trace for helpers born and exited entirely between observations; ETW remains
outside this measurement contract.
