# Interaction responsiveness contract

The job is to select a chat, understand its current task and messages, and compose a reply without navigation waiting for background work. Retain the approved iPhone list, header, balloons and composer. This pass changes interaction behavior and data ownership, not the visual baseline.

Apple's [responsiveness guidance](https://developer.apple.com/documentation/xcode/improving-app-responsiveness) and [WWDC explanation of immediate feedback](https://developer.apple.com/videos/play/wwdc2023/10248/) distinguish immediate control feedback from slower request completion. Use a target below 100 ms for our local press/selection responses; report measured handler timings, not an invented end-to-end physical-device guarantee. Long requests need feedback while unrelated controls remain usable. The native Windows implementation is an adaptation of that behavior.

| System | Required behavior |
| --- | --- |
| Chat selection | Select and focus its draft immediately; latest selection wins; no global lock for reading details |
| Conversation loading | Independent cancellable read connection, bounded recent-chat cache, guarded stale responses, saved reading position; neutral preview until actual messages load |
| Typing and sending | Local drafts remain editable during background requests; draft and receipt identity stay source-bound; only acknowledged submissions clear matching drafts |
| Search/filter/menus | Work during loading/sending; no unnecessary focus steal or repeated whole-window renders for one click |
| Feedback | Delayed loading hint avoids flashing for fast requests; slow work and errors identify the owning chat; retry only a read, never automatically resend a message |
| Messages and images | Reuse measured text layouts; thumbnail decoding/scaling happens off the UI thread; bounded caches and explicit loading/error states |
| Motion and idle | Purposeful progress activity only while visible and busy; honor reduced motion and stop idle timers |
| Verification | Baseline and final own-window response timings; delayed detail/send/image fixtures; rapid switching and stale response checks; rerun messaging, keyboard, image, scale and adapter regressions; guarded local install |

UIZZE is unavailable from the earlier reference pass and the user had no catalogue links. The visual evidence remains the inspected iPhone originals documented in `IPHONE_COMPONENT_AUDIT.md`. Do not substitute generic dashboard components, fake message balloons, fake delivery receipts, Apple branding, or extra animations to conceal a slow data path.

Own-window timing measures software handlers and actual rendered state. Physical pointer-to-photon latency, arbitrary monitor hardware, native Mac/iPhone installation and full screen-reader testing are separate checks and are not implied.

## Implemented in 0.6.9

- Details have their own latest-only pipe worker. Switching chats cancels the previous overlapped read, and request generation, card ID, task key and source identity guard its response. Read responses cannot release the mutation worker. The subscription, read and mutation lanes wait on events while idle.
- Selection and draft focus update immediately. Recent detail data is bounded to 12 chats, keyed by card and task identity. Context revisions trigger refreshes without clearing readable data. Reading position and follow mode are restored for the same source. A changed source preserves the old source's draft rather than silently retargeting it.
- Typing, chat navigation, search, filters, paging, menus and scrolling remain available during reads, sends and imports. The existing single mutation lane still prevents duplicate submissions. Its feedback names the owning destination, and results/receipts are bound to that destination. Acknowledgements clear only matching submitted text and image IDs. Newer drafts survive, and late receipts cannot move a reader back to the bottom.
- A first load shows a neutral latest-update preview until actual history is available. The read hint waits 150 ms so fast requests do not flash it; asynchronous collector hydration has its own history-loading message. A failed read offers a 48 by 44 logical-pixel Retry target that performs only another read. Input errors remain visible while a submission is finishing.
- Message layouts are reused across measurement and drawing in a bounded 512-entry cache. A single background WIC worker decodes and scales images to at most 768 pixels per side; the UI only uploads the resulting bounded pixels. Pending and unavailable previews have different labels. In-flight previews are bounded to 32 and GPU previews to 32. Worker objects stay in their own COM apartment, and shutdown interrupts audit delays and pending pipe reads.
- A press and release now avoid redundant intermediate full-window paints while preserving press cancellation and source identity. Pinning an existing peek changes its interaction ownership without replaying the entrance or hiding its fields.
- Diagnostics include the latest paint duration, detail loading state, recent-chat count and pending thumbnail count, without recording message contents.

The new regression uses real owned Win32 controls with a synthetic authenticated backend, deliberately delayed 1.5-second reads/imports, 2-second sends and a 1.2-second thumbnail worker. The thumbnail is a real 4096 by 4096 PNG. The final fixture also includes a long conversation so the reading bookmark is nonzero. These are software interaction checks, not signed-in delivery or physical monitor latency.

## Verification and current release block

The 0.6.8 baseline used the same 1.5-second artificial read delay. Its click handler returned in 20.7 ms, but the composer and other chat rows were disabled until the read finished at approximately 1.55 seconds. Handler completion alone therefore hid the actual UX problem.

An earlier 0.6.9 candidate (`5EABF874D3A620BEC01DD5A99030144576B6639F878520A4C1FA443515A20CAD`) passed the complete delayed-interaction regression. Its measured chat handlers were 11.6–13.5 ms; navigation during a 2-second send was 33.9 ms; typing and Search during delayed large-image decoding were 2.5 and 3.3 ms. Read Retry preserved the draft and caused no second send, latest selection kept the correct content and focus, image imports stayed source-bound, and a nonzero long-history reading bookmark survived switching. A preceding development candidate also passed 296 existing native messaging assertions, including the owned file-picker cancel/reopen/import checks. These are earlier software checks, not guarantees or final-release results.

After further corrections for late-receipt reading position, explicit newer-draft receipts, collector hydration feedback and diagnostics, the final 0.6.9 binary is `C66D53484FB62E66DEB9CE6333FBEC340D401DC2994769AB37FE6AC77BC1CA90`. Its fresh build-time model, motion, input and 28 isolated detour checks passed, as did all eight targeted backend tests. Windows Smart App Control blocked this unsigned executable before the final GUI suite could start. Consequently the final messaging/interaction, four-scale and adapter GUI suites have not passed, and **0.6.9 is not installed**. Do not reuse earlier native GUI results as proof for this binary.

The Code Integrity log identifies `VerifiedAndReputableDesktop`, Event 3077, status `0xc0e90002`, and the exact final hash. Local user/machine certificate stores contained no code-signing certificate. Microsoft's [current signing guidance](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control) calls for a valid certificate from a trusted provider; its [Smart App Control FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions) documents the lack of individual-app exceptions. No security setting, policy, reputation marker or certificate trust store was changed.

The running 0.6.8 backend PID 84684 and native PID 68052 remain intact. The package comparison verified that the staged backend changes only its version; no backend logic or installed renderer files changed. All disposable fixtures from this pass exited through their own idle endpoint.

`../native/windows/scripts/release-audit.ps1` runs the native suites sequentially and writes `build/candidate/native-validation.json` only for that exact binary. The installer now refuses a missing, failing or hash-mismatched native GUI proof before closing any app or making a backup/install change. That rejection was tested against the blocked candidate and preserved the running app. Once a supported signing setup is available, rerun the final native validation, refresh the build's signature-aware binary hashes, then use the existing guarded installer.

Evidence: `../native/windows/build/artifacts/responsiveness-release-status.json`, `responsiveness-code-integrity.xml`, `responsiveness-build.log`, and `../artifacts/native-migration/responsiveness-backend-tests.log`. Earlier interaction metrics remain in `build/candidate/artifacts/responsiveness-final.json`; the current `responsiveness-final.log` records the blocked launch. The status manifest binds each stage to the correct candidate hash.
