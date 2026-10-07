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

`physical` and `codex` currently report unsupported and return failure. `all` never runs an account audit or converts missing lanes into success. These lanes will be implemented against the merged weather/composer contracts and the separate-cursor bridge. Account work still needs its own explicit authorization and one disposable chat; old unrelated chats are not fixtures.

Every invocation gets a private ignored UUID directory under `artifacts/native-qa`. The report distinguishes evidence types, current source revision, app version, actual start/end times, durations, exit status, output hashes and candidate binary hashes. Raw stdout/stderr stay private; reports do not embed them. Case execution is finite, output is bounded, and failures stop later cases in that lane. There is no automatic retry or input replay. The report remains failed while any requested lane is blocked, interrupted, unsupported or unverified.

Interruption or timeout can terminate only the process tree launched by that case; forced cleanup always fails verification. A normal subprocess exit is distinct from an independent whole-desktop cleanup audit. Existing native test programs and fixture scripts check their own child shutdown, but this first harness does not independently prove no global hook, clipboard change or orphan exists after every failure. That remains an explicit #8 acceptance gate.

The owned native picker check submits its opening action once, then observes only windows belonging to that exact child for at most ten seconds. It retains elapsed time and bounded window-state diagnostics for a cold or failed opening. It never retries the opening action, adopts another application's dialog or changes the app's input behavior. This handles a longer observation window; it does not establish the underlying cause of the earlier three-second failures.

Harness contracts deliberately inject a failing child, stale/dirty candidate, missing executable, output overflow, interruption and timeout. Passing mocked matrix results are report-policy evidence; actual owned Node child checks are subprocess evidence. Neither is physical native input or real Codex delivery.

A controlled log-storage failure preserves only a bounded error code and fails the case after stopping its owned child. It does not suppress persistence errors or diagnose the earlier inbox replacement failure. The existing desktop transport fixture now uses a finite one-second receipt wait instead of 40 ms, so a malformed receipt is tested independently of that tight parallel-run timer race; owner validation, uncertainty, exact request counts and production timeouts remain intact. Failed earlier run evidence is retained.
