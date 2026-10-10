# Packaged runtime notices

The compatibility backend bundles a PyInstaller collector. `build-helper.py` preserves the original CPython license from the Python installation actually used for that build, preferring its root `LICENSE.txt` and otherwise the standard library's `LICENSE.txt`. It also preserves the installed PyInstaller distribution's original `COPYING.txt`, including its executable-bundling exception. PyInstaller's exception does not require an acknowledgement; this copy records the actual builder's terms rather than relabelling the collector as GPL.

The helper's `runtime-notices.json` records the actual Python/PyInstaller versions, original notice bytes and SHA-256 hashes, and the exact collector binary/source hashes. Missing or empty original documents fail the build. Packaging verifies the notice set, bytes, component versions, platform and original collector identity. CI publishes separate original notice text and packaged-verification JSON for each desktop platform. No extra network requests, account access or runtime work are added to the app.

The native archive keeps its existing eight entries. `THIRD_PARTY_NOTICES.txt` retains the earlier MinHook/HDE and nlohmann notices and appends the following complete original documents from the pinned llvm-mingw 20260922 archive, SHA-256 `e3ad77d117a4bea19a7a3b333341824d79a5a371004a10e25b8504e7b3047666`:

| Original archive path | SHA-256 |
| --- | --- |
| `LICENSE.TXT` | `8d85c1057d742e597985c7d4e6320b015a9139385cff4cbae06ffc0ebe89afee` |
| `x86_64-w64-mingw32/share/mingw32/COPYING.MinGW-w64-runtime.txt` | `1db8da07b436c68833c0673ffee3d9fcb2526047f3820b81661865dfedc79a1f` |
| `x86_64-w64-mingw32/share/mingw32/COPYING.winpthreads.txt` | `63263614cdd29f2f93cba85e992f041b31f9fc7b4033692f31269489a8a1b177` |

The source privacy audit permits upstream copyright contact text only in that exact digest-verified notice bundle. A changed bundle requires source review; unrelated emails and credentials remain rejected. The packaged notice hash remains part of the existing native archive verification. Original upstream trailing whitespace is deliberately preserved with the original license bytes; source-code whitespace checks exclude this notice file.

Original notices and hashes establish preservation, not a complete embedded-component SBOM, legal review, signing-provider eligibility, a trusted signature or physical-device acceptance. Existing upstream binary signatures must be preserved when our own components are eventually signed.
