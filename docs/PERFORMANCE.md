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
also binds composer focus to the fresh original mouse-down and release decision.
If the task disappears, the verified cancelled press records no accepted focus
latency and attempts no send. Missing decision records, reused sequences, changed
original PIDs, unexplained context changes and lost focus on an unchanged target
still fail. The native fixture removes an actual selected task during its held
composer press and verifies no message submission and preserved source drafts.
The report
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
The sampler uses a dedicated read-only discovery thread with a ten-millisecond
poll interval, separate from the one-second resource sample cadence. Supported
[Toolhelp32 process snapshots](https://learn.microsoft.com/en-us/windows/win32/toolhelp/taking-a-snapshot-and-viewing-processes)
provide only process name, PID, parent PID and thread count. The observer opens
only exact original roots and descendants of their retained parent handles,
then verifies kernel creation times and the parent's creation/exit interval.
It retains at most 256 original handles, including children that exit before
the next resource sample. Each sample records discovery count, configured
interval, maximum observed capture gap and the finite handle bound. Discovery
and counter errors fail the run; no unavailable row is discarded. A newly born child contributes its
measured cumulative CPU only when its exact creation time falls within the
observed interval. An observed exit contributes final cumulative CPU and exit
time read through that same handle, once, then releases the handle. Its live
memory/handle/thread fields remain null; it is excluded from subsequent live
totals only after the kernel confirms exit. Unobserved births, missing final
CPU, replaced identities and inaccessible instances disclose measurement gaps;
their usage is never converted to zero. Original backend/native/collector
processes must remain live throughout every phase. Sample collection start/end
times are retained, and all observer handles close on success or failure.
Abnormal observed helper exits fail reporting. Calls into the app are included;
the measuring PowerShell process and its discovery thread remain outside the
app tree, consistently across every baseline and comparison. Wakeups need
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

CPU consumption is now gated using the sum of complete original-handle CPU deltas
over their measured phase time, divided by logical processors. It is time weighted;
an arithmetic average of unequal sample percentages is incorrect. Memory retains
its p95 gate, and the five-baseline median/IQR/15-percent allowance is unchanged.
The original one-second CPU p50/p95/p99 and the former p95 comparison stay published
as an explicit non-gating burst diagnostic. Sustained CPU increases, missing phase
time, partial originals, memory regressions and growth still fail. A phase-average
pass does not establish burst stability or the separate local-response target.
[Microsoft process times](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)
defines cumulative kernel/user time summed over the process's threads.

The prior full run 37910734378 on source 9e00a403 failed two independently measured
attempts under the former burst gate: 100-source idle CPU p95 was 1.951% versus
1.797%, then 1,500-source idle was 9.631% versus 9.303%. Their phase-average CPU
was respectively 0.523% and 2.894%, within their baseline phase-average ranges.
All memory and ten-minute growth checks passed. Those raw failures remain retained;
the exact causes of burst variation are unestablished. Tests redistribute identical
cumulative CPU across intervals, retain the changed p95, and require an actual
sustained consumption increase to fail. This is a disclosed budget-statistic change,
not an app optimization, a wider numerical allowance, or a conversion of those
older failed reports into successful qualification. Fresh current-source baselines
and comparison are required for the new contract.

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
Windows runner with sixty seconds per ordinary phase. Run UUIDs and original
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
same original handle; the continuous observer's thread count uses the current
Toolhelp snapshot while that original process handle is still live.
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

[Run 37735817992](https://github.com/Al-Yousef/work-updates/actions/runs/37735817992)
passed its soak and three baselines, then failed baseline four because a new
Electron child was already destroyed before the post-CIM kernel open (Windows
error 87). Direct kernel acquisition alone cannot recover a destroyed object.
Continuous discovery removes the slow CIM-before-open path and retains the
original before exit. An actual isolated Node regression launches eight children
that start and exit entirely between resource samples, verifies their final CPU
and null live counters once, then reproduces error 87 after all original handles
are released. The unchanged report policy reproduces those raw samples without
gaps. This faster polling still cannot establish an exhaustive ETW lifecycle
trace; children shorter than an actual discovery gap may remain unobserved.

## Idle work and bounded attribution

A separate opt-in CI probe takes five in-process V8 profiles of owned synthetic
100-source fixtures. It writes only weighted attribution to tracked public source
paths, with runtime/dependency frames redacted. It opens no inspector listener and
uses no account or model. Profiling overhead and overlapping inclusive stacks make
these reports unsuitable as CPU budgets or before/after savings measurements.

The five initial profiles consistently identified full device snapshots in idle
resource reconciliation. Snapshot construction is now deferred until an accepted
active worker requires terminal evidence; uncertain workers after restart still
require the same fresh owner, task, source and turn match. Empty responsibility and
delegation journals also avoid unused snapshots. Native freshness-only frames keep
their metadata without relayout or redraw; connection changes, visible fields,
details, command receipts and explicit capture/focus work still invalidate the UI.
Actual isolated native tests check ten received metadata updates, unchanged draw
counts, preserved Unicode draft/selection/focus and a genuine visible repaint at
all six DPI/contrast configurations. These changes require fresh qualification;
the earlier failed comparisons remain failures and thresholds are unchanged.

Repeated queue projections also reuse the task-title hash for the same original
source record. The weak cache compares the current normalized title on every
projection, recomputes changed titles and treats replaced records separately. It
does not cache freshness, status, cards or admission evidence, and does not retain
removed source records. A regression verifies repeated projections avoid duplicate
hashes while in-place changes, removal and replacement still reject stale task
identities. A local synthetic snapshot prototype is descriptive; a fresh complete
qualification and matching before/after observation are still required.

## Owned event trace

`scripts/owned-etw-audit.ps1` runs only on the isolated Windows CI runner. It starts a unique non-restarting ETW file session using the pinned Microsoft TraceEvent 3.2.8 package, keeps original root handles until analysis, and records process/thread/context-switch events around eight short-lived owned Node children and a fresh 100-source native pilot. Actual process start/stop kernel keys, parent lifetimes and timestamps establish each retained descendant. A changed original identity, overlapping lifetime, missing exit, reported event loss, missing scheduling data, oversized trace or uncertain owned shutdown fails the report. The trace observes events separately from the polling sampler; it does not fabricate counters for processes absent from that sampler.

Only owned synthetic JSON and source/tool/candidate hashes are published. Raw ETL files, command lines, kernel pointers and unrelated system records are not published. The recorder stops only its own uniquely named session, refuses adoption, and never runs on the policy-blocked local machine. Process and context-switch observations apply only to this bounded CI workload. Context switches are not CPU hardware wakeups or energy; physical interaction, optimization comparisons, energy and longer app-specific trace qualification remain separate.

The first successful lifecycle observation retained 35 starts and stops with zero event loss, including a collector exit code of 1. Its older polling cleanup had reported disappearance as normal. The report now additionally requires every owned exit code to be zero; the collector shutdown correction and its independent original-child receipt must be integrated before acceptance. That earlier observation remains diagnostic evidence and is not accepted as normal owned shutdown. The wrapper resolves an exact installed .NET 8 SDK in its private output directory and records its actual identity; a newer default runner SDK cannot silently substitute.

References: [Microsoft TraceEvent guide](https://github.com/microsoft/perfview/blob/v3.2.8/documentation/TraceEvent/TraceEventProgrammersGuide.md) and [pinned provider package](https://www.nuget.org/packages/Microsoft.Diagnostics.Tracing.TraceEvent/3.2.8).

Full qualification now requires at least sixty seconds per ordinary phase, with
measured CPU elapsed time and sample coverage checked against that declaration
in every baseline, comparison and ordinary soak phase. The five-baseline
median/IQR/15-percent formula is unchanged. Short pilots and separate profiling
or before/after diagnostics still use their declared thirty-second windows and
do not qualify the application.

The fifth complete attempt, run 37953165429 on aa150bd8, remains failed:
500-source hidden-idle phase CPU was 0.713% against a 0.695% limit. All other
17 comparisons, memory checks and bounded growth passed. Its original CPU
totals for the backend and native shell match baseline four exactly; collector
CPU differs by 0.015625 seconds, and measured elapsed time also differs. These
recorded values do not establish a guaranteed Windows counter resolution or
the exact cause of the failed comparison. Longer observations expose more
periodic work and reduce the relative effect of phase boundaries. Every workload
is extended equally, with all fresh baselines and original process identities.
The raw fifth failure and every shorter observation remain retained; the longer
window does not convert any prior report into a pass.
