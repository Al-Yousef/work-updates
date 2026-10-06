# Working on Hyphen

The [roadmap](https://github.com/Al-Yousef/work-updates/issues/1) defines issue scope and merge prerequisites. Start one issue branch from updated `main` after its prerequisites merge; use a separate checkout. Keep a PR focused on that issue and link it with `Closes #N` only when all acceptance criteria are verified.

The backend lives at the repository root; the native Windows shell, launcher and weather adapter live in `native/windows/`. The iPhone candidate lives in `ios/`. See [architecture](docs/ARCHITECTURE.md) and [baseline status](docs/BASELINE.md).

## Restore and check

Use PowerShell 7, Node 24 and Python 3.12 on PATH. `npm ci` restores the locked Node dependencies and Electron runtime.

```powershell
npm ci
$env:WORK_UPDATES_PYTHON = (python -c 'import sys; print(sys.executable)')
npm test
python -m unittest discover -s tests -p 'test_*.py'
npm run audit:release
```

Before committing local-only files, also run `node scripts/audit-release.cjs --include-untracked`. The audit permits reviewed source roots, exact candidate files and a digest-verified vendor header. App data, packages, private identities and personal paths are rejected. Generated files, downloaded toolchains, private logs and screenshots stay ignored.

For a clean native build:

```powershell
./native/windows/bootstrap-toolchain.ps1
./native/windows/build.ps1 -OutputDirectory build/candidate
```

Bootstrap verifies the pinned official archive digest. `-ArchivePath` accepts a previously downloaded matching archive; `-ToolchainDirectory` selects an existing compiler directory explicitly. A blocked compiler or test is a failed verification gate, not permission to weaken Windows security. [Native documentation](native/windows/README.md) separates model checks, native GUI checks and physical input proof.

`npm run demo` launches the Electron compatibility UI using synthetic data. Real-account audits are opt-in and need separate human authorization. Do not use existing personal chats as fixtures. Native isolated fixtures require explicit bridge paths and disable automatic adapter attachment.

With a desktop display available, `npm run test:shutdown` checks periodic-work cleanup while a synthetic quit is delayed. `npm run test:ui` and `npm run test:devices` exercise disposable compatibility apps and separately require normal clean shutdown. Forced audit termination fails the gate; it is not accepted as a successful quit.

## Integration and release

Coordinate shared changes to `main.cjs`, queue/protocol schemas, lockfiles and the native window controller. In particular, weather lifecycle and composer branches merge sequentially while they share `main.cpp`. Record any temporary stacked-PR base; retarget and revalidate after the prerequisite merges.

Review relevant tests, data compatibility, failure recovery and source/package hashes. Keep physical input, simulated input, synthetic transport and actual Codex delivery evidence separate. Squash merge issue PRs into `main`, then refresh remaining branches. A release tag publishes compatibility packages. [Native CI](docs/NATIVE_CI.md) builds and audits separate unsigned development artifacts on every PR; those are not an installation or release.

Installed-app updater/audit scripts require `HYPHEN_INSTALL_ROOT` set to an absolute portable installation directory. `HYPHEN_NODE` can select Node explicitly, and `HYPHEN_CURSOR_CLI` selects the separately installed cursor bridge. Existing `Work Updates` executable/data/protocol identities are retained for compatibility; public product wording is Hyphen.
