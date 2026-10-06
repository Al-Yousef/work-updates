# iPhone interaction pass · Hyphen 0.6.6

Keep the approved 880 by 660 native Messages-style layout. This pass transfers interaction rules from Apple's current iPhone Messages guide and Human Interface Guidelines rather than adding another visual theme.

| Field | Contract |
| --- | --- |
| Screen job | Find a chat, read it without interruption, and send or queue the intended draft |
| Primary action | Enter and the arrow use the selected chat's existing Send/Queue behavior |
| Hierarchy | Chat identity, current task, transcript, composer; existing waiting owner and device labels remain visible |
| Search | A trailing Clear control erases only Search, retains keyboard focus and preserves the selected conversation/draft |
| Buttons | Pointer hover and press have visible feedback. A release alone, drag away, or lost capture cannot activate another action. Keep 44 logical-pixel targets for circular controls |
| Destination | A contextual press binds to its source identity. Changing the selected chat while Send is held cancels the release |
| Menus | Actions apply to the current context. Escape/outside-click dismissal restores the previous native editor focus and selection. A click used to dismiss cannot send or change the background chat |
| Messages | Right-click a visible text balloon for Copy, equivalent to iPhone's contextual text-copy action. No unsupported Tapbacks, message edits or remote deletion controls |
| Reading | Incoming assistant updates preserve a reader's scroll position; Latest resumes following. Sending one's own message follows its response |
| States | Empty/no-results Search, disabled Send, pending receipt, writer refusal, queued receipt, interrupted pointer press, unavailable clipboard, menu-open and older-message reading |
| Feedback | Pending storage says Queueing; send says Sending. Receipt confirmation remains the condition for clearing a submitted draft |
| Geometry and motion | Existing pane proportions and weather animation remain; pointer feedback repaints only on interaction transitions, with no new polling or idle timers |
| Acceptance | Actual native input/clipboard/focus assertions, synthetic messaging/queue/image regression, current-scale visual captures, preserved adapter checks and matching installed binary |

Evidence: [iPhone Messages](https://support.apple.com/guide/iphone/send-and-reply-to-messages-iph82fb73ba3/ios), [Search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields), [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons), [Menus](https://developer.apple.com/design/human-interface-guidelines/menus). The live HIG content was read through Apple's official `/tutorials/data/design/human-interface-guidelines/*.json` endpoint because its HTML requires JavaScript. UIZZE was unavailable in previous passes and the user had no catalogue links; official Apple evidence is used directly. Right-click and focus restoration are Windows adaptations of those interaction rules. No current iPhone landscape screenshot or UIKit implementation is claimed.

## Verification

The final native binary passed 271 UI/queue integration checks using synthetic chats and simulated own-window input, plus 42 isolated adapter checks and 28 real-detour checks confined to the test process. Checks include release-without-press, drag cancellation, capture loss, switching chats with Send held, both destinations' preserved drafts, actual Search clear/focus, menu Escape/outside dismissal with restored native selection, exact-source Send, duplicate Enter suppression, durable Queue/Clear queue, writer refusal, images, independent scrolling, Latest and X. A visual review caught a stale sidebar focus outline; native text-field focus now clears it.

An earlier 277-check run verified actual clipboard Copy and restored every captured clipboard format. The final run found unsupported clipboard handle formats and preserved them while checking the Copy menu. The Copy implementation was unchanged between those runs. The untouched original clipboard is not replaced to satisfy a test.

The model suite passed earlier in this pass. After the final focus-only change, Windows Application Control blocked the repeated `queue-tests.exe` launch (Code Integrity events 3033/3077, enterprise signing policy). The model and model-test sources were unchanged since 21:12 local time, before the earlier passing run. That valid result is reused and explicitly recorded with source hashes and the blocked repeat in `../native/windows/build/candidate/build-verification.json`; Windows security policy was not altered. The normal install guard still verifies source and binary hashes and idle backend ownership.

Search, pressed Add, multiline composer and Copy-menu screenshots were inspected at the current Windows display scale. Native tests do not establish physical weather gestures, arbitrary DPI/monitor combinations, iPhone hardware behavior or complete screen-reader support. A synthetic-mouse repaint-count assertion was discarded because Windows leave tracking uses the real pointer; no physical pointer cost is claimed. No new idle polling/timer was introduced by the feedback code.

Installed locally on October 5, 2026 at 21:35 Toronto time through the normal idle/hash guard, with a queue backup. The live runtime reports 0.6.6, native-backend mode, zero BrowserWindows/renderers and a connected 65-card queue. The installed native hash matches the candidate, and the preserved weather adapter reports ready without a covering overlay. The synthetic fixture was closed. See the native project's `build/artifacts/iphone-ux-installed-verification.json` for the recorded result and model-check reuse provenance.
