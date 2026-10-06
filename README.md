# Hyphen

Hyphen brings work across local Codex chats into a desktop queue and conversation. The current Windows interface is a C++ Win32 app with a tray, a floating Messages-style chat panel, and a guarded adapter for the existing weather tile. Its background services still run in Electron/Node; collection uses Python. This repository contains those components together.

Current source identifies backend version **0.6.9**. This baseline is not a new installed release. See the [installed-component ledger](docs/BASELINE.md), [development roadmap](https://github.com/Al-Yousef/work-updates/issues/1), and [contribution workflow](CONTRIBUTING.md).

## Current Windows experience

- Hover the supported weather tile to reveal; move into the panel to retain the peek. Click to pin and click again to hide. X/Escape hide; tray Exit closes. Unsupported adapter profiles preserve Windows behavior.
- Chat name, current-task title, summary, status, waiting ownership, and execution device have distinct roles. Reviewed acknowledges an update; Done concerns the task. Waiting on you takes priority.
- Enter uses Send or Queue for the selected chat; Shift+Enter inserts a newline. Text/image drafts stay destination-bound. Failures retain drafts and uncertain delivery is never silently retried.
- Local PNG, JPEG, WebP and GIF attachments are supported. Cross-device attachment transfer, PDFs and audio are not connected.
- The pinned Hyphen conversation uses retained dialogue, explicit notes and bounded source context. Clear instructions can send or queue through the existing validated pipeline. See [assistant behavior and cost](docs/HYPHEN_ASSISTANT.md).
- Local observation does not acquire writers. Replies use the desktop owner when available or the app's eligible session. Pass completion and writer availability differ. See [ownership](docs/WRITER_OWNERSHIP.md) and [delivery outcomes](docs/delivery-confirmation.md).

The interface adapts inspected Apple Messages references with Windows typography/rendering and Hyphen task controls. The [component audit](docs/IPHONE_COMPONENT_AUDIT.md) records the references. Historical screenshots in `assets/` depict the earlier Electron notification interface.

## Repository and checks

| Path | Component |
| --- | --- |
| `main.cjs`, `src/`, `bridge/` | Background services, assistant, collection, queue and delivery |
| `native/windows/` | C++ shell, launcher, adapter, tests and locked compiler bootstrap |
| `ui/` | Earlier Electron compatibility interface |
| `ios/` | SwiftUI iPhone candidate and protocol/client tests |
| `candidate/dot-inbox/` | Isolated review-only concept with synthetic fixtures |
| `tests/`, `scripts/`, `docs/` | Checks, audits, workflow and verification records |

Use Node 24 and Python 3.12 on PATH:

```powershell
npm ci
$env:WORK_UPDATES_PYTHON = (python -c 'import sys; print(sys.executable)')
npm test
python -m unittest discover -s tests -p 'test_*.py'
npm run audit:release
```

`npm run demo` opens the compatibility UI with synthetic data. For C++:

```powershell
./native/windows/bootstrap-toolchain.ps1
./native/windows/build.ps1 -OutputDirectory build/candidate
```

Bootstrap verifies the pinned official LLVM-MinGW archive digest. Follow [native instructions](native/windows/README.md) for model, GUI and physical-input checks. Native CI/integrated packaging remains [issue #3](https://github.com/Al-Yousef/work-updates/issues/3); current CI builds compatibility Electron packages and runs separate Apple candidate checks.

## Installation and devices

[Existing releases](https://github.com/Al-Yousef/work-updates/releases) are historical compatibility packages. The current local native Windows app was installed through guarded private migration scripts. This baseline does not publish a new package or replace the running app. Installed-app updater/audit scripts require an explicit absolute `HYPHEN_INSTALL_ROOT`.

The macOS Electron compatibility app and iPhone SwiftUI candidate are retained. Current Apple compilation and physical-device behavior need separate verification; a native Mac parity claim is not established. See [devices](docs/DEVICES.md) and [iPhone installation](ios/README.md). Private pairing requires awake reachable computers; remote use needs an already configured private overlay network. Continuous APNs push, SMS/iMessage, phone calls and App Store publication are not connected.

Legacy `Work Updates` executable/data/protocol/app-ID names remain internal compatibility identities. Product wording is Hyphen. Whole-app performance requires complete native/backend/helper process measurements; zero Electron renderers alone does not establish it.

## Diagnostics and licensing

Diagnostics and runtime records stay local. Bounded event metadata excludes chat bodies but may contain private paths/identifiers. Exclude private app data, pairing descriptors, real conversations and logs from commits. Redacted diagnostic export is [issue #12](https://github.com/Al-Yousef/work-updates/issues/12).

MIT license; native dependencies have [third-party notices](native/windows/THIRD_PARTY_NOTICES.txt).
