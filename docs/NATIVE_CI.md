# Native Windows verification gates

Issue #3 adds the stable PR check **Native Windows build and isolated checks**, alongside the desktop Windows/Mac and iPhone checks. Repository administrators can select those check names in branch rules; this workflow does not claim to have configured branch protection. Every PR runs the native lane, including backend-only changes, because the native/backend contract crosses both source trees.

The Windows 2025 runner restores locked Node dependencies and the official LLVM-MinGW 20260922 archive. Bootstrap verifies its SHA-256 before extracting it. The build checks compiler, linker, resource compiler, DLL and driver-configuration hashes from `toolchain.json`, plus compiler/linker version 23.1.2. An explicit toolchain directory or linker path must match that same lock. There is no alternate compiler or linker fallback. Updating the lock requires reviewing a new official archive and its extracted binary hashes.

`build.ps1` invalidates previous build and desktop-validation markers before toolchain checks. It builds the shell, launcher, adapter DLL/controller and all eight native test targets. Motion, input, queue-model and real detour checks run during the build. The schema-1 manifest records the checkout revision, whether tracked source was dirty, app version, protocol contract, toolchain identity, all native source hashes and every binary hash. Source changes during compilation fail the build. `PreserveAdapter` cannot create verified proof.

The separate failed-build test covers a missing compiler, changed compiler, wrong linker and attempted adapter reuse. Each must remove old proof. Model tests, synthetic manifest tests and actual runner compilation provide different evidence; synthetic test bytes are never native binaries.

The isolated adapter test loads the DLL only into its own test process and starts a panel with `--isolated-session`. It checks simulated panel commands, the TaskbarCreated guard and runtime traces for disabled automatic attachment/global hooks/covering trigger. The queue test uses an authenticated pipe and disposable backend, exercising actual C++ controls against deterministic transport. The hidden demo backend must have no collector, writers, model calls, windows or renderers. None of these tests attach to Explorer or send to a signed-in chat.

The native package gate verifies current version, full source/toolchain/binary identity, native descriptor/snapshot compatibility, PE product/version resources and an exact package allowlist. It emits the four native production files, proof and installation requirements, with a ZIP checksum. The backend package audit separately rejects stale package metadata or runtime source. These are unsigned development artifacts, not an installer, automatic update, or publication to the running app. Native artifacts are retained for 14 days and are not added to the compatibility release workflow.

## Local commands

```powershell
./native/windows/bootstrap-toolchain.ps1
./native/windows/scripts/build-gates.test.ps1
./native/windows/build.ps1 -OutputDirectory build/candidate
./native/windows/build/candidate/native-adapter-tests.exe
./native/windows/scripts/queue-audit.ps1
node scripts/baseline-runtime-audit.cjs
./native/windows/scripts/package.ps1
```

## Windows executable policy and physical coverage

The package gate inspects all four distributed PE files, including the weather
adapter DLL and its controller. Each must retain the exact original binary hash,
Hyphen product name, matching file/product version and an explicit unsigned
development status. The separate `native-pe-resources.json` records these fields
without paths or credentials. Missing resources, foreign versions, changed hashes
and uncertain or unexpected signature results fail packaging. This evidence does
not establish a signing service, trusted installation or physical input.

An OS policy refusal is a failed gate. Retain the error/code and source/binary hashes; use an authorized signing or administrator-managed allow policy for those exact artifacts, then rerun the checks. Never disable Smart App Control, Defender, application-control policy or tamper protection. These workflows do not hold signing credentials or assert that unsigned downloads are trusted distribution builds. A release signing service/certificate and transactional installation are separate work.

Physical weather gestures, Explorer restart, mixed-monitor/DPI behavior and real disposable Codex Send/Queue delivery still require their separate desktop evidence. Automated check success does not replace those gates.

Sources: [official LLVM-MinGW release](https://github.com/mstorsjo/llvm-mingw/releases/tag/20260922), [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [Microsoft App Control for Business](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/).
