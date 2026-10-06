# Hyphen UX reliability audit

The earlier iPhone component pass verified the main controls and visual mapping, but did not constitute a complete UX audit. This pass owns the remaining interaction checks rather than relying on the user to discover failures.

The iPhone evidence and adaptations remain in `IPHONE_COMPONENT_AUDIT.md`. Keep those visual components. Keyboard access, Win32 accessibility, reconnect behavior, scaling, error recovery, close/tray and weather gestures are Windows/Hyphen requirements, not invented Apple equivalents.

Acceptance matrix:

| Area | Required behavior |
| --- | --- |
| Navigation | Correct source identity, independent drafts, search and filter state, no focus retargeting after reorder/removal |
| Keyboard | Forward/reverse Tab cycle, Enter/Space only activate focused controls, composer Enter sends once, Shift+Enter inserts a line, IME Enter does not send, Ctrl+F finds chats |
| Messaging | Pending/disabled reasons, preserved uncertain-delivery drafts, default Queue for working chats, no suggestion overwrites text or image drafts |
| Readability | No empty update balloons, complete multiline status/error layout, singular/plural labels, visible latest-message affordance |
| Images | Picker cancel, valid import/preview, remove target at least 44 logical pixels, limit and invalid-image feedback, separate source drafts |
| Connection | Subscriber reconnect with bounded backoff and identical state recovery; cached transcript and editable saved drafts remain available offline; Send stays disabled |
| Accessibility | Native input names, named canvas controls with role/state/location/default action, visible focus, disabled explanation, native tooltips |
| Window | X/Escape/tray, interrupted/reversed transitions, Windows reduced-motion setting, display/DPI changes preserve pinned positioning and draft |
| Evidence | Fresh build and model checks, isolated native UI tests, actual native captures at multiple rendering scales, adapter tests without Explorer injection, guarded local install |

Own-window simulated input is not physical weather-tile proof. Rendering-scale captures are not arbitrary physical monitor tests. MSAA inspection is not a full Narrator session. Synthetic delivery is not a fresh signed-in Codex delivery. Record those boundaries explicitly in the final evidence.

## Changes in 0.6.8

- Keyboard focus now follows a control's identity when state updates reorder the list; disappearing controls lose focus. Panel Enter cannot submit an unfocused draft. Space activates a focused control. Tab and Shift+Tab follow the same cycle in opposite directions. Ctrl+F focuses Search, and opening a conversation focuses Message after details load.
- A dropped subscription reconnects with interruptible 250 ms to 5 s backoff. It does no connected-state polling and leaves the corner lease and command worker independent. Receiving an identical snapshot restores connection state. Cached conversations and editable local drafts remain available offline; sending and adding new images wait for a connection.
- Empty text no longer creates a balloon for automatic assistant updates. Feedback uses measured multiline space above the composer and image previews. Very long feedback is bounded to 144 logical pixels with full text exposed through accessibility. Chat count grammar and overlapping footer/list hit areas are corrected.
- Image removal has a 44 × 44 logical-pixel target with increased preview spacing. Suggestions preserve image-only drafts as well as text. Image cancellation, import, limits and failures retain the draft.
- Standard native inputs have meaningful accessible names. Canvas controls expose MSAA names, roles, disabled states, locations, focus and safe default actions with stable child IDs. Native tooltips explain icon and disabled controls. Menus/hide dismiss tooltips. This is an initial Windows accessibility implementation, not a claim of full screen-reader compatibility.
- Window transitions respect Windows client-area animation settings. Pinned windows keep their nearest monitor on display refresh; DPI changes relayout the renderer and native fields. Chat ages repaint once a minute only while visible.

Windows adaptations use [WM_GETOBJECT](https://learn.microsoft.com/en-us/windows/win32/winauto/wm-getobject), [standard accessibility support](https://learn.microsoft.com/en-us/windows/win32/winauto/types-of-iaccessible-support), [native tooltip controls](https://learn.microsoft.com/en-us/windows/win32/controls/tooltip-controls) and [SystemParametersInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-systemparametersinfow). Their interaction choices are platform adaptations; the visual evidence remains the actual iPhone references in `IPHONE_COMPONENT_AUDIT.md`.

## Verification

The final 0.6.8 build passed 244 native UX assertions at each of 96, 120, 144 and 192 rendering DPI, with fresh disposable backends. Those assertions include inspection through the real MSAA interface, correct focus after actual state reordering/removal, Enter/Space/Tab/Shift+Tab/Ctrl+F, real native Shift+Enter and IME composition handling, automatic-update balloon count, multiline error geometry, cached offline transcript, reconnect with identical state, image-only draft protection, durable image import/removal, invalid image and five-image feedback, reduced-motion X, display refresh and an actual app restart restoring the Unicode multiline draft. The image-drop test constructs process-local HDROP data in the audit child and exercises its normal drop handler. It is simulated own-window input, not an OS drag gesture from another application. Test-only chords/drop injection are available only with an explicit audit-capture session.

Actual native composition captures of updates, errors, offline source conversations, removable images and menus were inspected at the tested scales. Files are under `../native/windows/build/candidate/artifacts/ux-*.png`; automated run records and logs are under `../native/windows/build/artifacts/ux-audit-*`. The seven targeted backend tests passed. The build ran fresh model, motion, input and 28 isolated detour checks successfully. Earlier failing development runs are retained; use the final passing run and verified binary hashes for release evidence.

One intermediate executable was blocked by Windows Application Control during development. After correcting the accessibility COM implementation, the normal rebuilt executable ran successfully with security settings unchanged. No policy bypass or signing-policy changes were made.

Not covered by this pass: a fresh signed-in chat delivery, actual mouse gestures on the Windows weather tile, physical mixed-DPI/multi-monitor hardware, a complete Narrator session, or an iPhone installation. The test matrix and evidence are intended to make those limits explicit, rather than call a check count proof of all possible UX.

## Final release evidence

The final messaging/queue suite passed 296 assertions, including cancellation and reopening of the real owned Win32 image picker. The final adapter suite passed all 42 simulated own-window checks with no Explorer injection. Clipboard contents had unsupported handle formats, so the Copy menu was checked while preserving the clipboard; actual clipboard replacement is not claimed for this pass.

Installed locally through the fresh-idle/source-hash/binary-hash guard on October 5, 2026 at 22:38 Toronto time. Live verification at 22:39 shows version 0.6.8, backend PID 84684, native PID 68052, a connected 68-card queue, native-backend mode, zero BrowserWindows/renderers, adapter ready and no covering overlay. Native and backend archive hashes match their verified candidates. Packaging comparison confirms that the backend changes only its release version; its logic and installed renderer files are preserved. All disposable fixtures created in this pass were shut down through their own idle endpoint.

Installed evidence: `../native/windows/build/artifacts/ux-reliability-installed-verification.json`. Queue/archive backup: `artifacts/native-migration/before-20261005-223848`. Final four-scale run: `../native/windows/build/artifacts/ux-audit-20261005-223450.json`. Final messaging and adapter logs: `ux-reliability-picker-final.log` and `ux-reliability-final-adapter.log` in the same artifacts folder. Source changes are local; this request did not publish or push them.

## Separate-cursor E2E on October 6, 2026

The requested cursor pass **does not pass pending-operation responsiveness** on installed 0.6.8. The earlier assertion counts above do not establish that rapid interaction during delayed loading or sending works.

The pass used the persistent separate-cursor worker (`private_input_v2`) for every click, move, typed character and key. Read-only native control text/style, the app's action map and UI trace, actual screenshots and synthetic backend records verified the response independently. There are 146 recorded cursor commands and 27 original screen captures. Two measured live chat selections applied details 30 ms and 23 ms after the native `ui-click` event. These are local click-to-details samples, not percentiles or physical-input latency measurements; cursor CLI duration includes travel/startup/polling and is not app latency.

The exact installed executable, SHA-256 `A596ABDF7D4CEDC6FB29B6B3FD9A2CB22B5EB782A8F7E1A78CD8B1580BD0EC4D`, also ran in an isolated session with the real queue/controller/messages layer, deterministic Codex transport, three-second details and Send delays, and nine synthetic chats. No test messages reached working chats.

| Interaction | Observed result |
| --- | --- |
| Live chat switching, contact/filter menus, Escape and X | Passed; X hides the panel after its transition. |
| Unicode typing after load | Passed, including accented text and emoji. |
| Ctrl+F and search | Shortcut moved private focus to Search; filtering worked, including during loading. The cursor requires moving/clicking the field before typing after a shortcut changes focus. |
| Switching while details load | Failed: the second chat click was ignored until the first request finished. |
| Typing while details load | Failed: the composer was read-only; acknowledged cursor characters did not appear in the field. |
| Enter-to-send | Passed: one synthetic delivery to the intended source; the draft cleared after success. |
| Typing and switching during Send | Failed: new typing and the attempted chat change were ignored while the submission was pending. |
| Queue and refusal recovery | Passed: two distinct follow-ups persisted as queued for the correct sources, with automatic delivery disabled in the fixture. |
| Active-writer refusal | Passed: explicit failure feedback retained the complete draft and did not claim delivery. |
| Per-chat drafts | Passed: switching restored the refused Desktop draft and preserved Interface's separate draft. |
| Search focus after delayed details finish | Failed: private focus changed from Search HWND 44307288 to composer HWND 656218 while the cursor remained over Search. An earlier Escape therefore navigated to the synthetic Hyphen assistant instead of clearing Search. The refusal test was repeated after checking the actual composer identity. |
| Sidebar paging | Passed: offset 0 → 5 → 0. |
| Conversation arrow scrolling | Passed: the counter moved 140 → 139 → 140. A later source check confirms each unit is a 32-logical-pixel transcript step, not one pixel. The initial report misinterpreted this counter. |
| Offline drafting and reconnect | Passed: offline editing remained available, Send was disabled, and the identical edited draft survived reconnect. |
| Shift+Enter through the cursor | Cursor compatibility gap: no newline was inserted. Its private key adapter sends key messages without translated character messages. This does not invalidate or prove physical-key behavior. |
| Image picker through the cursor | Cursor compatibility gap: the real dialog opened, the synchronous click timed out, and Cancel was rejected because the adapter supports only one root window per app process. Image import is unverified by this pass. |

The image dialog was closed only during cleanup with an identity-checked `WM_CLOSE` to that disposable dialog; that is **not** an E2E Cancel pass. Both disposable processes then exited gracefully. Live backend PID 84684, native PID 68052, cursor worker PID 36552 and renderer PID 40012 remained running. Held input was released and the separate cursor returned to its starting position. The installed executable hash stayed unchanged.

Evidence index and verdict: `../native/windows/build/artifacts/cursor-e2e-20261006/summary.json`. That folder includes individual step receipts, independent state snapshots, `focus-proof.json`, backend delivery/queue records and `screenshots/`. Reusable capture/summary scripts are `../native/windows/scripts/cursor-e2e.py` and `summarize-cursor-e2e.py`. Cleanup is explicitly separate from cursor input in `close-e2e-dialog.py`.

The first `live-chat-visible.json` snapshot predates a correction to the observer's read-only check and is excluded from read-only conclusions. All later snapshots read the actual `ES_READONLY` style. The early `writer-refusal.json` scenario reached only the synthetic assistant after the focus/escape problem; use `writer-refusal-confirmed.json` for the source-checked refusal evidence.

Not covered: signed-in Codex message delivery, wheel/drag/drop/right-click, IME, physical mixed-DPI/multi-monitor behavior, Mac, iPhone, or a new weather-tile gesture test. Candidate 0.6.9 remains blocked by Windows Application Control and was neither tested nor installed in this cursor pass. Its prior development checks cannot substitute for these installed-build findings.

## Cursor fixes and release check on October 6, 2026

The cursor compatibility fixes are installed and verified; Hyphen itself remains
0.6.8. The new cursor guard acknowledges a mouse release before entering a modal
app handler, confines dialogs to the selected root's owner chain on the same UI
thread, and supplies the missing native EDIT characters for Shift+Enter and
Backspace. Cursor motion across a background gap stops private input while the
display cursor completes its movement. Keyboard input additionally checks that
private focus belongs to the root currently under the separate cursor.

Twenty-six focused cursor checks passed. The fresh persistent-cursor run recorded
77 commands and 11 actual captures. Independent control text verifies newline and
Backspace. The real image picker was opened, cancelled by a cursor click, reopened,
and used to import the fixture PNG. Its durable attachment hash matches the original.
A nested missing-file dialog was dismissed after direct movement across the desktop
gap, and Cancel retained the exact multiline draft. Enter delivered one harmless
synthetic reply to source `10000000-0000-4000-8000-000000000001`, with no duplicate.
X hid the panel, held input was released, and both disposable processes were closed
through their own normal shutdown paths. The installed cursor worker was reloaded
and rerun. No working chats received test messages.

All observed before/after real-pointer and foreground values match. This is not a
new transient-focus monitoring pass. The first import attempt used forward slashes
in a Windows filename field and received validation feedback; the corrected native
Windows path imported successfully. The source scroll counter is in 32-logical-pixel
steps; the initial one-pixel interpretation above is corrected.

Hyphen's unchanged 0.6.9 candidate source hashes match its build manifest, and its
queue model, input ownership and motion checks passed again. The final GUI check
still cannot launch the candidate. Windows Code Integrity event 3077 at
2026-10-06 08:17:54 Toronto time explicitly identifies
`build/candidate/Native Hover.exe` as rejected by the signing policy. Candidate SHA-256
remains `C66D53484FB62E66DEB9CE6333FBEC340D401DC2994769AB37FE6AC77BC1CA90`.
The installed executable remains
`A596ABDF7D4CEDC6FB29B6B3FD9A2CB22B5EB782A8F7E1A78CD8B1580BD0EC4D`.
Loading/send/navigation/Search-focus fixes are staged; they are not an installed GUI
fix. The signing requirement remains the release blocker, with Windows policy unchanged.

Evidence: `../native/windows/build/artifacts/cursor-fixes-20261006-1/summary.json`
and its step records, `build/candidate/native-validation.json`, and
[installed cursor proof](<local-evidence>

## Composer repair on October 6, 2026

The installed 0.6.9 native executable is now SHA-256
`C56291CB54893A375E90EB7B84103E893CF219CFA16072AFD093727DF73E9B46`.
It includes the staged loading, send, navigation and Search-focus repairs described
above, plus the composer repair. The earlier C66 candidate's signing rejection
remains historical evidence; it does not describe this executable. No Windows
policy or file-trust settings were changed.

The old editor reached into Send's click target, used a different width from the
renderer measurement, and ignored clicks on composer padding. The new shared
geometry reserves ten logical pixels before Send's target. Native font metrics and
`EM_GETLINECOUNT` determine height, including soft wraps; margins remain explicit
after DPI/font changes. Padding focuses immediately on mouse-down and lets the
native editor place its caret. Ctrl+A works in both Message and Search. Redundant
foreground activation and unchanged editor resizing are avoided.

Actual screenshots caught another issue that control-text reads alone missed:
the native EDIT text did not appear under the composition-only parent. Both native
inputs now have their own layered child redirection surfaces, with the required
Windows compatibility manifest. Live glyphs, selection and caret belong to the
native control; the scene renderer draws text only for exported scenes or a hidden
native control. This follows Microsoft's [DirectComposition child layering](https://learn.microsoft.com/en-us/windows/win32/directcomp/bitmap-surfaces)
and [layered child manifest guidance](https://learn.microsoft.com/en-us/windows/win32/winmsg/using-windows).

The installed composer release passed the native queue, UX, responsiveness and
adapter checks before installation. The final cursor pass then recorded nineteen
commands against that exact executable with a disposable synthetic backend:
Search lost focus when composer padding was clicked, typing worked without another
click, Ctrl+A selected the complete draft, Backspace cleared the selection, long
text soft-wrapped, Shift+Enter added a newline, and Backspace removed one character.
Native observations showed one, two and three lines with heights 40, 60 and 80 at
96 DPI. The field's right edge was 802; Send's target began at 812. The inspected
screen capture shows the real text and caret clear of the blue Send button.
There were no production messages. Native UX checks passed at rendering DPI
96, 120, 144 and 192; these are not physical mixed-monitor tests.

Evidence is in `../native/windows/build/artifacts/composer-render-release-20261006/`:
`composer.json`, `summary.json`, `ux-state.json`, `actual-panel.png`,
`actual-composer.png` and `installed-state.json`. The persistent separate cursor's
typing guard requires its tip over the focused native child. After the padding
click, the cursor moved into that child without a second click before typing.
The snapshots independently prove that the padding click already gave focus.

### Weather adapter recovery and test isolation

Explorer restarted during the test session. Its Application event records
`Windows.UI.Xaml.dll` and exception `0xc000027b`; that does not establish a cause.
A test app's TaskbarCreated handler ignored its no-auto-attach isolation option and
attached the candidate-folder adapter to Explorer. Explorer pins that DLL, and the
adapter verifies its panel and session relative to the DLL's original directory.
The installed DLL has identical bytes but a different path. Consequently the
weather shortcut is currently unavailable, while the installed Hyphen composer
and backend remain running and connected. Restoring the canonical installed
adapter requires a Windows Explorer restart; user approval is pending.

The source safeguard now ignores TaskbarCreated entirely in standalone, isolated
or no-auto-attach sessions and also guards the attachment method. Its new regression
passed 45 native adapter checks with the actual candidate panel and simulated
commands, without Explorer injection. The test uses bounded message dispatch,
reads only its own PID's trace, and cleans up only its created process. An initial
development assertion exposed duplicate tray registration; that disposable child
was identity-checked and closed. The corrected handler returns before tray work.

This safeguard is staged, not installed. The subsequent full build stopped because
Windows Code Integrity event 3077 rejected `build/candidate/motion-tests.exe`
under its signing policy. A fresh build-verification manifest was not emitted,
so the installer cannot treat that partial build as a verified release. The
installed composer executable and backend were preserved. No new physical
weather-tile gesture is claimed by this pass.
