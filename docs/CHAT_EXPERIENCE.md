# Hyphen chat and image pass

This document records the 0.6.2 image release. The 0.6.3 landscape layout and 0.6.4 Messages appearance supersede its portrait dimensions; see [landscape design and verification](LANDSCAPE_CHAT.md). Image delivery and draft ownership remain the same.

## References and decisions

| Reference | Transfer to Hyphen | Scope |
| --- | --- | --- |
| [Raycast AI Chat](https://manual.raycast.com/ai/ai-chat) | Dedicated floating conversation, bottom composer, attachment context, clear Send/Queue state | Preserve Hyphen's own chat names and task status; no model-picker clutter |
| [ChatGPT companion window](https://help.openai.com/en/articles/9982051-using-the-chatgpt-windows-app) | Compact entry that supports images and continues a conversation | Keep the native weather trigger and tray ownership |
| [Claude Quick Entry](https://support.claude.com/en/articles/12626668-use-quick-entry-with-claude-desktop-on-mac) | Visual context belongs beside the message draft | No microphone or screen-capture control until it actually works |
| [Codex app-server input](https://learn.chatgpt.com/docs/app-server) | Send images as localImage inputs, never pretend a filename is an image | Preserve message identity, queue receipts and writer ownership |

UIZZE's public catalogue and the desktop browser runtime did not expose usable catalogue screens. The user had no catalogue links. This pass uses the official product workflows above; it does not claim a pixel comparison against inaccessible catalogue screens.

## Design contract

- Job: talk to Hyphen or a selected Codex chat and understand exactly where a message goes.
- Hierarchy: destination/chat name, current task and activity, conversation with images, draft with removable previews, Send/Queue.
- Native panel: 480 by 840 logical pixels, fitted within the monitor's work area. Keep the existing corner motion and pin/hide behavior.
- Composer: Enter uses the primary Send/Queue action, Shift+Enter inserts a line. Pick, paste or drop images; show previews before submission. A draft and its images stay together per destination.
- Conversation: readable text, user/assistant distinction, scrollable images; updates remain one click away.
- Attachment lifecycle: import into private durable local storage before accepting the draft. Validate type/size/count; queued messages and uncertain receipts retain the same bytes. No image data or filenames in diagnostic logs.
- Submission: real localImage input reaches the existing desktop owner or app-server. Identity includes images so a changed attachment cannot reuse an old receipt.
- Required states: empty, processing attachment, thinking/working, queued, unavailable image, explicit rejection, uncertain delivery, offline/stale context.
- Acceptance: backend attachment durability and duplicate-delivery checks, actual native rendering, picker/paste/drop routing, source-chat and Hyphen image input, old text-only drafts/receipts remain compatible.

## Verified installed release

Hyphen 0.6.2 is installed on Windows. The installed archive and native executable match the verified candidate hashes. Runtime reports native-backend mode, zero BrowserWindows, zero Electron renderer processes, a current collector and native corner ownership. The existing Explorer adapter reports ready and was preserved byte-for-byte.

- 239 backend checks passed. After the final history repair, the 29 affected queue/attachment/native-projection checks passed again, along with 17 Python collector checks.
- 112 interaction checks passed against the actual native window and isolated backend, using simulated input only on the audit's own child. These cover the real picker, draft thumbnail, Enter, Send/Queue receipts, Unicode, navigation, writer-refusal draft preservation and X. Rendered draft (private local evidence: `../native/windows/build/candidate/artifacts/chat-image-draft.png`) and conversation (private local evidence: `../native/windows/build/candidate/artifacts/chat-image.png`) evidence was inspected.
- The human-authorized **Hyphen delivery test** chat received a synthetic image through installed Send and Queue. Official chat reads confirmed localImage input in both turns and correct red-left/blue-right answers. Replaying both IDs produced the same receipts. After restarting Hyphen, both previews and answers remained, with no image protocol markup displayed. Receipts and restart evidence are in `artifacts/chat-image-delivery/`.
- A separate ephemeral assistant test verified actual image understanding and a visual follow-up on gpt-6-sol. The weaker initial Luna audit is explicitly recorded as failed.

Physical clipboard paste and Explorer drag/drop are implemented but were not driven by this audit. Local output images are supported through absolute file references; unavailable references show an unavailable preview. Cross-device image transfer, remote images, PDFs, audio and image generation remain outside this release. This verification does not establish Mac/iPhone installation or a physical weather-hover test on the new build.

The collector reads conversation detail only for requested/recently opened chats. Native thumbnails decode only when visible, with bounded dimensions and a bounded bitmap cache. This is a native Windows interface with the existing headless Electron/Node backend; it is not a full C++ rewrite or a claim of measured idle CPU savings.
