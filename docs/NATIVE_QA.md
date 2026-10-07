# Native regression matrix preparation

Issue #8 allows harness preparation before weather #6 and composer #7 merge. This candidate adds one entry point for the existing local contract and simulated native suites. It does not finish #8: the integrated candidate, physical scenario driver, authorized disposable Codex lane and independent desktop cleanup evidence remain required.

Run from a clean checkout with Node 24, Python 3.12 and restored dependencies:

```powershell
node scripts/native-qa.cjs --lane=isolated
python -m pip install -r requirements-qa.txt
node scripts/native-qa.cjs --lane=simulated
node scripts/native-qa.cjs --lane=all
```

The isolated lane runs backend contracts, owned original-record fixtures and the tracked-source privacy audit. The simulated lane requires the exact current clean native build in `native/windows/build/candidate`, independently verifies source/toolchain/binary hashes, and runs the isolated adapter, queue, composer at four scales, responsiveness and rendered status suites. It cannot use an installed or stale candidate. Build with the pinned documented toolchain first. A security-blocked compiler or executable fails verification; do not retry it under another identity or alter protection.

`physical` now has a finite separate-cursor composer driver. Set `HYPHEN_PHYSICAL_INPUT=separate-cursor`, the current `CODEX_THREAD_ID`, `HYPHEN_CURSOR_CLI` to the existing absolute `agent_cli.py` path, and `WORK_UPDATES_PYTHON` to its Python runtime. It requires an already running idle API 4 worker owned by that chat and a fresh clean native candidate. It never starts or reloads a worker, compiles a fallback executable, weakens application-control policy, or uses foreground/shared OS input. Missing configuration blocks before candidate execution. A protected route refusal or uncertain receipt stops the scenario without replay.

The fixed scenario selects one synthetic source, verifies an empty composer, reads back a Unicode draft, navigates away and back to verify preservation, sends it exactly once to that source, hides the owned panel, and releases input. Only the newly launched isolated native process and synthetic backend are used. Candidate hashes and original process ownership are retained; normal owned-child shutdown is required. The driver reads only its own window and profile and does not copy the shared native log. A separate Python observer samples the real pointer and foreground window every 5 ms during actions; any observed change or gap over 50 ms fails. Sampling cannot exclude changes between samples. No physical mixed-DPI, weather/Explorer, screen-reader or audio-hardware qualification follows from this composer lane.

`codex` still reports unsupported and returns failure until its separately authorized account driver is run. `all` never starts an account audit or converts a missing lane into success. Account work needs its own explicit authorization and one disposable chat; old unrelated chats are not fixtures. Preparing this driver is source validation; a passing mocked test is not proof that native input ran on this machine.

Every invocation gets a private ignored UUID directory under `artifacts/native-qa`. The report distinguishes evidence types, current source revision, app version, actual start/end times, durations, exit status, output hashes and candidate binary hashes. Raw stdout/stderr stay private; reports do not embed them. Case execution is finite, output is bounded, and failures stop later cases in that lane. There is no automatic retry or input replay. The report remains failed while any requested lane is blocked, interrupted, unsupported or unverified.

Interruption or timeout can terminate only the process tree launched by that case; forced cleanup always fails verification. A normal subprocess exit is distinct from an independent whole-desktop cleanup audit. Existing native test programs and fixture scripts check their own child shutdown, but this first harness does not independently prove no global hook, clipboard change or orphan exists after every failure. That remains an explicit #8 acceptance gate.

The owned native picker check submits its opening action once, then observes only windows belonging to that exact child for at most ten seconds. It retains elapsed time and bounded window-state diagnostics for a cold or failed opening. It never retries the opening action, adopts another application's dialog or changes the app's input behavior. This handles a longer observation window; it does not establish the underlying cause of the earlier three-second failures.

Harness contracts deliberately inject a failing child, stale/dirty candidate, missing executable, output overflow, interruption and timeout. Passing mocked matrix results are report-policy evidence; actual owned Node child checks are subprocess evidence. Neither is physical native input or real Codex delivery.

A controlled log-storage failure preserves only a bounded error code and fails the case after stopping its owned child. It does not suppress persistence errors or diagnose the earlier inbox replacement failure. The existing desktop transport fixture now uses a finite one-second receipt wait instead of 40 ms, so a malformed receipt is tested independently of that tight parallel-run timer race; owner validation, uncertainty, exact request counts and production timeouts remain intact. Failed earlier run evidence is retained.

Log opening is also a verification gate before any child starts. If either exclusive log open fails, the runner closes every descriptor already opened by that invocation, preserves any pre-existing file, and records `storage_failed`, `log_open_failed`, no child PID and a bounded storage code. It never hashes a pre-existing file as output from the refused case. No process exit is claimed for a child that never started, and later lanes remain blocked. Actual filesystem-collision tests verify the original descriptor is closed, original bytes survive, and the child marker is absent.
