# Hyphen native Windows interface

The C++ shell uses Win32, Direct2D/DirectWrite, DirectComposition, native editable controls, tray integration and authenticated worker IPC. The backend owns collection, summaries, assistant inference, device sync, persistence and delivery. See [architecture](../../docs/ARCHITECTURE.md) and [baseline ledger](../../docs/BASELINE.md).

The accepted window is 880 by 660 logical pixels, fitted to the work area. Sidebar, conversation and growing composer have separate state/scroll behavior. Drafts stay source-bound; confirmed receipts clear only submitted input. Locally queued and Codex-accepted are distinct. The composer reserves width before Send and uses a manifest-enabled layered EDIT control. See [reference](../../docs/MESSAGES_REFERENCE_REBUILD.md) and [composer verification](../../docs/UX_RELIABILITY_AUDIT.md).

## Build

From the repository root:

```powershell
./native/windows/bootstrap-toolchain.ps1
./native/windows/build.ps1 -OutputDirectory build/candidate
```

`toolchain.json` pins LLVM-MinGW 20260922/LLVM 23.1.2, the official archive digest and compiler/linker/support-file hashes. Bootstrap accepts `-ArchivePath` for a matching existing archive and verifies before extraction. Build accepts `-ToolchainDirectory` and an explicit `-LinkerPath` only when they match the same lock. A blocked compiler/test fails verification; do not change Windows protections or reuse older proof.

Ignored output contains the shell, launcher, adapter DLL/controller and test targets. Successful model checks write source/binary/toolchain hashes and checkout identity to `build-verification.json`. Every attempted build invalidates older proof before toolchain checks. `-NativeIntegration` is an opt-in desktop lane; simulated commands do not prove physical pointer behavior. [Native CI and development packaging](../../docs/NATIVE_CI.md) run isolated checks and resource/identity audits on every PR. Transactional installation remains issue #5.

## Development and installed paths

Run `node scripts/native-reply-fixture.cjs DIRECTORY` from the repository root for a synthetic backend, then launch the native app with its `--bridge PATH --isolated-session --no-auto-attach --show` flags. Isolation must prevent Explorer attachment even after TaskbarCreated. `--standalone` skips coordination/attachment and does not prove a connected queue.

Native `scripts/queue-audit.ps1`, `ux-audit.ps1`, `responsiveness-audit.ps1` and `release-audit.ps1` exercise owned controls with disposable backends. Node comes from PATH or `HYPHEN_NODE`; image/responsiveness fixtures need Python/Pillow. Optional cursor audits need `HYPHEN_CURSOR_CLI` pointing to the separately installed `agent_cli.py`. Dated evidence summarizers are not release gates.

Installed tooling needs absolute `HYPHEN_INSTALL_ROOT` containing `desktop/` and `data/desktop/`; direct native development can use `--bridge`. The launcher finds its sibling native executable or `HYPHEN_NATIVE_ROOT/build`. The old sibling `native-hover/build` and `Work Updates` portable layout remain compatibility fallbacks for existing installations. Fresh fixtures do not depend on that layout.

`Start Native Preview.exe` reveals an existing verified process or starts the backend/native app. `--hidden` starts concealed; `--exit` requests exit. A source build adds no service/startup registration.

## Weather and evidence

Default mode redirects private Explorer weather invocations while Windows renders the tile and owns hover timing. It does not use a covering hotspot/global hook. Hover reveals, pointer transfer retains, click pins and the next click hides. X/Escape hide; tray Exit closes. The covering-trigger experiment requires explicit `--legacy-trigger` and is not an automatic fallback.

Only the exact module fingerprint and weather sender are supported. Mismatches preserve original handlers. A bounded worker heartbeat restores original handlers for hung, stale or exited panels. Wider physical coverage remains issue #6. Read the [adapter contract](taskbar-adapter/README.md) before changing it.

Model tests cover state/motion/detours in isolation. GUI checks use simulated input on owned windows. Physical cursor gestures, mixed DPI/monitors, Explorer restart and real Codex delivery need independent proof. An attached adapter, screenshot or mocked receipt alone does not establish those outcomes.

The visual baseline is inspected Apple Messages, adapted with Segoe UI, opaque Windows surfaces and Hyphen task/device/status controls. This is not UIKit or a pixel-identical hardware capture. Traces stay bounded and local. Measure all backend/helpers before claiming resource savings.

[Third-party notices](THIRD_PARTY_NOTICES.txt). [Pinned official compiler release](https://github.com/mstorsjo/llvm-mingw/releases/tag/20260922).

Accessibility identity retention is limited to 2,048 entries across all indexes.
Current controls are pinned and retain their IDs while older invisible controls
are evicted. IDs are never reused during one COM object's lifetime. An evicted
client reference becomes unavailable and cannot activate another control. The
locked CI build exercises 10,000 changing identities, current-ID stability,
retired-ID refusal, full-capacity and duplicate/oversized projections. Actual
owned native MSAA checks also verify the registry is present and bounded. This
is source/bounds evidence, not a physical screen-reader interaction or a RAM
savings claim. Local executable-policy restrictions remain unchanged.
