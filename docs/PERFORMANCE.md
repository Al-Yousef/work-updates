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
network or model completion. The report gives sample counts, p50/p95/p99 handler
latency and measured exceptions to the 100 ms local-response goal. These are
simulated owned-window inputs; physical input remains a separate gate.

The sampler starts with the two process handles created by the benchmark,
pins their creation identity, recursively includes descendants and retains
previously observed child identities. Reused PIDs and descendants older than
their claimed parent are refused. Raw samples retain timestamp, instance
identity, process name, cumulative CPU, working/private bytes, handles and
threads. Commands, account identifiers and environment variables are omitted.
CPU differences divide by actual elapsed sample time and logical processors.
Departed, replaced or inaccessible instances disclose measurement gaps; their
usage is never converted to zero. Sampling overhead is included. Wakeups need
ETW evidence and remain null here.

CI uses six seconds per phase as an initial pilot. The script's default is
thirty seconds, with an explicit sample interval. Metadata includes source
revision, Windows build, hardware, logical CPUs and physical memory. Reports
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
