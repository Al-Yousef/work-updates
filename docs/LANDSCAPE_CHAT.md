# Hyphen landscape conversation

The user explicitly replaced the earlier portrait preference with a landscape split view: conversations on the left, selected conversation on the right. This is a Windows implementation of that interaction, not an iPhone build or a pixel-identical Apple reproduction.

| Contract | Decision |
| --- | --- |
| Job and primary action | Read a chat and Send/Queue a reply while keeping other chat statuses visible |
| Hierarchy | Chat name, current task/status, conversation, attachment draft, primary Send/Queue |
| Navigation | Persistent left sidebar with Hyphen assistant, Updates/Queued/History/Done, four visible source rows and independent scrolling; clicking a row updates only the conversation pane |
| Surface | 960 by 620 logical pixels fitted to the monitor work area; white transcript, pale sidebar, one thin divider; text-sized blue user balloons and gray assistant balloons |
| Controls | Bottom composer in the conversation pane; Enter uses the primary action, Shift+Enter inserts a line; image previews stay beside the draft; X remains at the outer top right |
| Required states | Connecting, no chats, no selection, stale task, working/queued, image unavailable, rejected writer, uncertain receipt; retain separate drafts |
| Responsive input | Scale within available work area; pointer wheel scrolls the pane under it; keyboard focus remains visible; existing reduced-motion/slide behavior remains |
| Forbidden defaults | Large lock-screen clock in the chat layout, decorative blue/green background shapes, full-window navigation that hides the source list |
| Acceptance | Actual native rendering, visible sidebar during source and assistant conversations, chat switching and draft isolation, Send/Queue and image receipts, independent sidebar/conversation scroll, X; preserve adapter binary hashes |

## Evidence

- [Apple Messages guide](https://support.apple.com/guide/messages/welcome/mac): its official screenshot description explicitly identifies conversations in the left sidebar and the active conversation at right. Transfer the navigation relationship, not Mac window chrome or Apple branding.
- [Apple Messages on iPhone](https://support.apple.com/guide/iphone/send-and-reply-to-messages-iph82fb73ba3/ios): keep conversation content and message entry together; this guide does not verify split view on every iPhone model.
- [Apple conversation organization](https://support.apple.com/guide/messages/ichtd3bb127f/mac): conversation selection and unread indication belong in the list. Hyphen retains its real task/status semantics rather than pretending its status colors are message-read receipts.
- [Raycast AI Chat](https://manual.raycast.com/ai/ai-chat): retain the already implemented Send/Queue behavior for a working AI chat.

UIZZE was unavailable in the earlier reference pass and the user could not supply links. Do not ask them to do design research again. Use repository behavior and the official sources above, with the missing catalogue evidence recorded here.

## Apple Messages visual pass contract

The user requested the entire design to feel as if Apple made it. The new visual pass follows the inspected official macOS Tahoe Messages screenshot, including the current Messages composer reference, rather than preserving the first landscape pass's large dark buttons.

| Detail | Concrete rule |
| --- | --- |
| Appearance | White transcript, pale neutral sidebar, thin separators, restrained shadow and 24-pixel outer corners |
| Typography | Native Windows system sans, 15-pixel message body, 13-pixel chat names, subdued secondary text; no bundled Apple fonts |
| Conversation list | Circular device avatars, inset selected row, preview and explicit waiting owner; status dots retain Hyphen's real task meaning |
| Header | Small device/avatar beside chat name and task; compact blue text actions, no oversized button tiles |
| Bubbles | Text-sized gray incoming and blue outgoing balloons with curved tails, symmetric width limits and tighter vertical spacing |
| Composer | Standalone circular plus button, outlined white pill, blue circular send/queue arrow inside; text and images remain draft-isolated |
| Controls | Preserve all existing action semantics, focus targets, Enter/Shift+Enter and reduced motion; no decorative inert search/call controls |
| Verification | Inspect actual native source/assistant/queue/image renders and run existing native Send/Queue/scroll/X and adapter checks before installation |

Reference: [Apple Messages on macOS Tahoe](https://support.apple.com/guide/messages/welcome/mac), [message entry and Add button](https://support.apple.com/guide/messages/icht35827/mac). The image references are recorded in `artifacts/design-references/`. Hyphen's task filters, status/ownership and Queue option are product adaptations, not features claimed to come from Apple.

The final blue is slightly deeper than Apple's default system blue to give normal-size white bubble text and blue text actions 4.73:1 contrast against white. Main text is 17.0:1 and secondary text 5.69:1 against white. The sidebar is opaque in this Windows native build; no Apple font, personal photo or branding is bundled.

## 0.6.3 verification history

Hyphen 0.6.3 is installed and running on Windows. Its native executable matches the verified candidate SHA-256 `F659ED4E8510883BA303813E96133ECE85937646B8D18734788AC886137A8982`. The installed backend archive SHA-256 is `85908ec003ef0c4349830c0552b1a893c6c1fdfc84d2b920e3fa4acd5a3527b0`. Runtime confirms native-backend mode, zero BrowserWindows and renderer processes, a current collector and native corner ownership. The taskbar adapter and controller binaries retain their earlier verified hashes.

- 117 checks passed against the actual native window and an isolated nine-chat backend. Coverage includes selection, separate drafts, Unicode/multiline Enter, Send/Queue receipts, duplicate prevention, writer-refusal draft retention, actual image picker and previews, assistant drafts, independent sidebar/transcript scrolling, paging and X.
- 42 actual-panel adapter checks passed for simulated hover, pin, leave, second-click hide, X, Escape and shutdown.
- Actual native renders with synthetic content were inspected: [source conversation](../native/windows/build/candidate/artifacts/landscape-source-chat.png), [working chat and Queue](../native/windows/build/candidate/artifacts/landscape-queue.png), [image draft](../native/windows/build/candidate/artifacts/landscape-chat-draft.png) and [image conversation](../native/windows/build/candidate/artifacts/landscape-chat.png).
- Replaying the previously authorized real image delivery test IDs after installation returned the original sent receipts for both Send and Queue. No new chat message or model inference was needed for that replay.

Native tests simulate Win32 input only on the audit's own window. Physical weather-pointer behavior, clipboard paste and Explorer drag/drop were not retested on 0.6.3. This release does not establish Mac/iPhone installation, pixel identity with iPhone Messages, or measured idle CPU/RAM savings. Build and install proofs remain in the private local artifacts directories.

## 0.6.4 installed verification

Hyphen 0.6.4 is installed and running. The installed native executable matches the verified final candidate SHA-256 `A74B1288E6D2B0861BFFA940C0E6B2A2A9C00077F15694523DD174348BD941B1`; the installed backend archive SHA-256 is `9082047a0e8f18b37d3414797ff1e4092b7fe9ae4cb802b2e84d43e2d1109533`. Runtime confirms native-backend mode, zero BrowserWindows/renderers, native corner ownership, no active or uncertain messages and no active assistant response. The installed native interface is connected to the real queue. No signed-in chat received a test message in this visual pass.

- The final build passed its motion, input, queue/assistant model and 28 isolated-detour adapter checks. Source verification now includes the shared style header.
- 117 interaction checks passed against the final compiled native window and a fresh nine-chat synthetic backend. The redesigned circular controls still pass actual picker, Enter, Send/Queue, duplicate prevention, draft retention, chat switching, pane scrolling and X checks.
- 42 actual-panel adapter checks passed after the layout/control changes. The subsequent blue-only contrast adjustment left layout and input code unchanged. The installed Explorer adapter and controller retain their previous verified hashes.
- Actual native [source chat](../native/windows/build/candidate/artifacts/apple-messages-source-chat.png), [working chat and Queue](../native/windows/build/candidate/artifacts/apple-messages-queue.png), [image draft](../native/windows/build/candidate/artifacts/apple-messages-chat-draft.png) and [image conversation](../native/windows/build/candidate/artifacts/apple-messages-chat.png) renders were inspected. These contain synthetic test chats, not mockup artwork.
- Native test logs are `build/artifacts/apple-messages-build.log`, `apple-messages-native-audit.log` and `apple-messages-adapter-audit.log`. Both isolated fixture backends were closed after their audits. Installed Hyphen remains running.

The input audit uses simulated Win32 messages on its own process. Physical weather pointing, clipboard paste/drop, other monitors, screen readers and Mac/iPhone builds were not exercised in this pass. No idle-performance improvement is inferred from the visual changes.
