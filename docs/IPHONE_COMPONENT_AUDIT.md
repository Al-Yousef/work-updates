# iPhone component audit · Hyphen 0.6.7

This replaces the Mac screenshot as Hyphen's visual baseline. References were opened and their actual pixels inspected before editing. Apple currently serves the iOS 27 iPhone guide. The landscape reference is a published June 2026 iOS 27 beta capture, not a capture of a final release on this user's phone. No pixel-identical or UIKit/Liquid Glass implementation is claimed.

## Evidence

1. [Apple's current iPhone conversation](https://support.apple.com/guide/iphone/send-and-reply-to-messages-iph82fb73ba3/27/ios/27): actual text balloons, grouped-message tails, Add beside a bordered composer, and contact details. Saved original: `artifacts/design-references/iphone/apple-iphone-conversation.png`.
2. [Apple's current iPhone conversation list and filter menu](https://support.apple.com/guide/iphone/screen-and-filter-texts-iph203ab0be4/ios): circular pins, avatar/name/preview rows, inset separators, bottom Search, contextual filter selection. Saved original: `artifacts/design-references/iphone/apple-iphone-filters.png`.
3. [Apple's current Search guide](https://support.apple.com/guide/iphone/search-iph17c111fb6/27/ios/27): the actual saved screenshot `artifacts/design-references/iphone/apple-iphone-search-current.png` shows the bottom Search capsule, leading magnifier and trailing Clear. The separate [illustrated Search article](https://support.apple.com/en-us/111116) image explicitly depicts iOS 26 and remains supplemental evidence, not the baseline.
4. [Actual iPhone landscape capture](https://www.macrumors.com/2026/06/12/ios-27-landscape-mode-apps/): edge-aligned sidebar, avatar and name on one horizontal header, white transcript, standalone circular Add and bordered composer. Saved original: `artifacts/design-references/iphone/ios27-messages-landscape.jpeg`. The capture shows the collapsed sidebar; expanded task rows are transferred from Apple's conversation-list image.

UIZZE was unavailable in prior passes, and the user did not have catalogue links. No UIZZE evidence is asserted. These are directly inspected iPhone references; the prior macOS screenshot is historical only.

## Contract and component mapping

| Component | iPhone evidence | Hyphen decision and adaptation |
| --- | --- | --- |
| Screen job | Messages list plus selected conversation | Find a current task, read the correct chat, send or durably queue its draft |
| Window proportions | Landscape list/transcript split | Retain the user's approved 880 × 660 desktop size and a 296-pixel expanded list so chat and task names remain readable. These measurements are desktop adaptations |
| Sidebar surface | Landscape edge-aligned pane | Remove the inset Mac sidebar card; join the sidebar to the window edge with one straight divider |
| Sidebar title | iPhone's primary conversation-list heading | Hyphen remains the product name; a stronger heading replaces the tiny Mac toolbar title |
| Pins | Circular conversation pins in Apple's list | Hyphen stays a circular pin; selected state is a circular ring, removing the filled rectangular Mac selection tile |
| Chat rows | Avatar, bold name, gray preview, trailing time, inset separator | Keep chat name above current-task title. Preserve explicit waiting owner on a third line. Device and status are real Hyphen data, not Apple contact portraits |
| Search | Current guide and bottom capsule in list image | Move the actual native Search input and its Clear target to the bottom; filtering does not navigate or discard drafts |
| Filters | Apple's selected-filter menu | Circular filter control, blue when a non-default filter is active; selected checkmark moves to the leading position. Updates/Queued/History/Done are Hyphen categories |
| Contact header | Actual landscape avatar/name row | Replace vertically stacked avatar and pill with one inline avatar/name/chevron target. Current-task line remains below as a Hyphen extension |
| Text balloons | Apple's conversation and landscape image | Increase message readability, preserve left/right role alignment, use close spacing within a role group and one tail on the terminal balloon |
| Add/composer/Send | Apple's actual bottom row | Standalone circular Add, fine-bordered input capsule, arrow only when sendable. No fake dictation/video control |
| Images | Rounded photo in Apple's conversation | Keep real image previews, full-image opening, removable durable attachments; increase clipping radius to match the balloon language |
| Copy/menu | Apple's documented contextual actions and shown filter surface | Right-click Copy on Windows; rounded contextual surface with grouped 44-pixel rows. Existing click access remains primary |
| Waiting/Queue/receipts | No iPhone equivalent for Codex writers | Explicit Hyphen extension: waiting owner, queued receipt, writer refusal and pending labels. Do not imply read/delivered status without evidence |
| Typography/colors | Apple's type hierarchy, white/gray/blue roles | Segoe UI is the Windows font adaptation; stronger blue retains normal-text contrast. No Apple font assets are installed |
| X/tray/weather/drag | No iPhone equivalent | Windows behavior remains a named adaptation; preserve the verified adapter and hover/click state machine |
| List paging/footer | iPhone normally scrolls the list | Wheel remains primary; accessible Previous/Next controls and connection/filter text are desktop adaptations |
| Focus/motion | Existing verified native interaction rules | Preserve keyboard focus, cancel-on-drag, held-source identity, reduced-motion support and menu restoration; no added idle polling |

Required states: connecting, caught up, empty filtered view, no search results, selected source, assistant, working/default Queue, failed delivery, native writer refusal, pending receipt, saved image draft, older-message reading, menus, disabled controls, capture loss and hidden window.

Acceptance: inspect actual native renders against the saved iPhone originals; verify bottom Search's real child bounds, filter state, header hit identity, group geometry, multiline editor bounds, per-source draft preservation, Send/Queue/image regressions and both close/weather integration paths. Simulated native tests are not physical iPhone or arbitrary-monitor proof. Every unmatched product/platform choice must remain identified in this table.

## Verification and installation

The rebuilt candidate passed 288 native UI/queue integration checks with a fresh synthetic backend and simulated own-window input. New checks inspect the actual native child Search bounds, confirm the inline header receives client clicks rather than caption dragging, and verify four rendered messages in two role groups produce two terminal tails. The existing checks cover Unicode/multiline input, writer refusal and preserved drafts, held-Send source identity, Enter duplicate suppression, durable Queue and Clear queue, assistant/source isolation, real image picker/import, scrolling, menu focus/selection, Search filtering and X.

The full build also ran the model, motion and input suites successfully, plus 28 real-detour checks confined to an isolated process. All 42 native adapter integration checks passed against the rebuilt binary with simulated commands and no Explorer injection. Unlike the previous 0.6.6 pass, no model result was reused.

Source chat, filter menu, bottom Search, no results, pressed Add/multiline draft, image draft and contextual Copy renders were inspected at this machine's current display scale. Original images and actual captures are compared in `artifacts/design-references/iphone/review.html`; `references.json` records reference URLs and image hashes. The clipboard contained unsupported handle formats, so the suite preserved it and verified the Copy menu without replacing clipboard contents. No new real-chat send, physical weather gesture, arbitrary DPI/monitor, iPhone hardware or full screen-reader check is claimed.

Installed locally on October 5, 2026 at 21:56 Toronto time through the normal fresh-idle/source-hash/binary-hash guard. Live verification at 21:57 reports version 0.6.7, native-backend mode, zero BrowserWindows/renderers, a connected 67-card queue, adapter ready and no covering overlay. Candidate/installed native and backend archive hashes match. The disposable fixture is closed. Queue/archive backup: `artifacts/native-migration/before-20261005-215630`. Evidence: `../native/windows/build/artifacts/iphone-components-installed-verification.json`. Physical weather interaction was not repeated during this pass.
