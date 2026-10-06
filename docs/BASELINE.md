# Source baseline and installed-component ledger

The baseline branch imports the current local implementation into one repository. It does not install, restart or replace the running app. Historical verification documents retain their dates and scopes; they are not evidence for a newly compiled candidate.

## Imported source

- The remote starting point was 0.4.0 at `fab0f21`.
- Existing unpushed commits `dc263b1` (shared private TLS fixture) and `ce9b03c` (ordered peer snapshots and stale connection rejection) are preserved in the branch history.
- Current backend source identifies Hyphen 0.6.9. Native source now lives in `native/windows/`; the backend, candidate review UI, Apple candidate, tests and docs remain in their existing root paths.
- Repository path/configuration changes and the staged isolated-session TaskbarCreated guard are part of this source candidate. They are not labelled installed merely because the older app still runs.
- One-off personal multi-chat diagnostics, private data/evidence, research downloads, portable compiler archives and generated binaries are excluded. Reusable live audits require explicit disposable-test identity and opt-in flags.

## Installed reference checked during import

| Component | Installed reference SHA-256 | Evidence boundary |
| --- | --- | --- |
| C++ native UI | `c56291cb54893a375e90eb7b84103e893cf219cfa16072afd093727df73e9b46` | Existing composer-fixed executable, preserved during this import. |
| Backend ASAR 0.6.9 | `d33ad1489c7c96f54823524e61551234291b53d4709b65cde2df72781bfb6ac5` | Existing continuity update, preserved during this import. |

The backend and native source are independently versioned components of the installed app. A version string alone cannot establish source/binary identity. The baseline does not distribute these reference binaries or their private profiles.

## Release boundaries

The Windows interface is C++; the background backend still uses Electron/Node and Python collection. The entire app is not a C++ runtime replacement. Existing workflow packages the Electron compatibility desktop. Native clean CI and integrated packaging are issue #3; safe partial-update recovery is issue #5.

The macOS compatibility app and iPhone SwiftUI candidate remain in source. Current Apple candidate compilation, simulator checks, physical installation, native Mac shell parity and continuous phone background notification behavior are separate gates. There is no connected SMS/iMessage channel, phone calling, APNs credential setup or App Store publication in this baseline.

Installed-app scripts require an explicit `HYPHEN_INSTALL_ROOT`. The native launcher supports that root and `HYPHEN_NATIVE_ROOT`; direct native development can use `--bridge`. Legacy `Work Updates` internal executable/data/protocol identities remain for compatibility. A fresh checkout does not need the original machine's sibling project paths.
