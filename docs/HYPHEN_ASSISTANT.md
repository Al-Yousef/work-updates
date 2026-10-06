# Hyphen conversation

The native header's Chat button opens a conversation with Hyphen. Updates returns to the notification queue. Enter submits a message; Shift+Enter adds a line. The assistant's draft is separate from every source-chat draft and survives navigation and restart.

## Current capabilities

- Natural questions, planning and follow-ups using recent conversation, relevant older exchanges, saved notes and a bounded search of the local chat catalogue. Ordinary conversation is retained across app restarts without needing a Remember command. Automatic alerts have separate retention limits and do not consume the conversation window.
- PNG, JPEG, WebP and GIF attachments with removable draft previews, durable local copies and images in conversation history. Visual follow-ups can reuse the latest attached image. See [chat verification](CHAT_EXPERIENCE.md).
- Waiting on you is prioritized before urgency. Reviewed, snoozed, done and historical cards are identified separately. Current collector health, collection time and device availability accompany the context.
- Asking about a chat loads relevant source context through the existing read-only collector, including chats not previously opened. Up to three sources are requested, with an event-driven six-second bound. Unavailable, historical and offline context stays labelled.
- Opening a source records its exact device and source identity for subsequent “this chat” questions. Named destinations and explicit conversation references take precedence. Ambiguous names require clarification; an assistant's earlier guessed name is not a user-confirmed destination.
- A clear instruction such as “Tell this chat to review the checklist” can deliver one message through the existing Send/Queue pipeline. Working sources use Queue. The service validates the human request, exact destination, current task revision and availability before dispatch. A durable intent is written before dispatch; replay or restart never automatically sends it again. Only a real receipt is labelled Sent or Queued. Unknown delivery remains unconfirmed.
- Questions and draft requests do not authorize sending. Replies can still include related updates and proposed source-chat messages. Open update or Use draft opens the exact source in Hyphen. Existing source drafts are preserved, and changed context invalidates an old shortcut.
- “Remember that …” or `/remember …` pins an explicit local note. `/memory` lists pinned notes and explains conversation recall; `/forget N` removes a numbered pinned note and `/forget all` removes all pinned notes. “What do you remember about me?” uses conversation context rather than reporting that no pinned notes exist. Ordinary conversation is not silently converted into inferred permanent facts.
- New actionable queue changes appear in the conversation using existing summaries. This uses no additional inference. The initial snapshot establishes a baseline so launching does not flood the conversation with old updates.

Phone messaging, calls, email access, scheduled reminders and arbitrary autonomous execution are not connected by this version. Existing Codex chats can perform the work the user explicitly asks Hyphen to message them about. Its transport and service remain separate from source-chat writers, allowing a later phone channel to use the same durable conversation service.

## Cost and ownership

Only a user question starts inference. The provider uses the already signed-in Codex CLI and selects the available small Luna model for text. Visual questions prefer the Sol workhorse model: the strict live color-recognition audit failed on Luna and passed on Sol. A visual follow-up reuses the latest image when the question refers to it; ordinary text follow-ups retain the text model. Each request creates a private ephemeral read-only session and disables shell, hooks, web, apps, plugins, MCP servers and subagents. The private assistant never resumes or claims a user's desktop chat. Its own process closes after each answer; no AI process is kept alive while idle. An in-progress answer participates in the app's idle-restart guard.

Each question includes up to 36 ranked cards within an 18,000-character context budget, up to three bounded source excerpts/transcripts, up to ten recent conversation exchanges within 12,000 characters, four relevant older exchanges and up to 32 pinned notes. A coverage count accompanies this selection. Retrieval searches retained local conversation and the available chat catalogue; this is not an unrestricted full-text index of every historical Codex transcript. No embedding service or new background inference was added.

## Storage and recovery

`data/desktop/assistant.json` version 2 is private app data retaining up to 500 conversation exchanges and 40 automatic alerts, explicit notes, receipt hashes, last-opened source identity and observed update fingerprints. Version 1 migrates without discarding retained dialogue or receipts. Earlier dialogue already evicted by the old combined 100-message limit cannot be reconstructed from this file. The visible projection keeps up to 27 conversational turns and three alerts.

The file is local JSON, not encrypted storage, and is excluded from peer broadcasts and diagnostic logs. A receipt is written before acknowledgement. Replaying the same message ID returns its receipt without another AI invocation. A restarted in-flight answer becomes a visible failure and is never automatically resubmitted. An interrupted chat dispatch is labelled unconfirmed. Corrupt history is preserved and blocks new submissions rather than being overwritten.

Native drafts remain in the existing `drafts.json`, under a reserved assistant key distinct from every source ID. Diagnostic logs record accepted/completed/failed events, elapsed time, IDs and model metadata, never prompts, answers, notes or drafts. The native trace records assistant navigation and counts without content.

## Verification

Run `node --test tests/assistant.test.cjs` for persistence, exact-device source references, stale context, no-action generation, memory, automatic update messages and provider restrictions. `scripts/assistant-live-audit.cjs` performs a real two-question private model check against synthetic queue data without touching a desktop chat. The isolated native reply fixture also checks real Win32 editors, Enter/Send, memory, related-update navigation, draft isolation and X, using simulated input only on its own child window.

The October 6 continuity release passed 251 backend tests and a final 37 targeted checks after tightening uncertain-history handling. Twelve new continuity tests cover alert flooding, restart recall, older decisions, migration, event-driven context reads, offline/timeout cleanup, exact-source dispatch, ambiguity, ordinary-question action rejection, changed revisions and interrupted-delivery recovery.

The real private Luna audit recalled an ordinary detail after a restart and fourteen unrelated exchanges, grounded a release answer in its source transcript, and produced one simulated chat message. The final ASAR ran directly in a disposable native-backend demo profile through `Assistant -> Devices -> Messages -> Controller -> DemoCodex`, delivered exactly one synthetic message, and retained the receipt after restart. Installed Hyphen then recalled the user's actual retained conversation, distinguished its earlier chat-name guess from user confirmation, and left source messages unchanged.

Evidence: `artifacts/assistant-continuity-20261006/` contains package/source hashes, `backend-audit.json`, `install.json`, `installed-audit.json` and the private live fixture. The backend-only update preserves 803 unrelated installed files and the native executable SHA-256 `C56291CB54893A375E90EB7B84103E893CF219CFA16072AFD093727DF73E9B46`. No C++ rebuild or Explorer restart was performed. The installed adapter reports ready; that is attachment/status evidence, not a new physical weather-gesture test.

The reference is OpenAI's [Dot tasks and memory documentation](https://learn.chatgpt.com/docs/dots/tasks-and-memory): conversation context, durable continuity and authorized coordination. Hyphen implements the local Codex subset described above; it does not inherit Dot's cloud computer, connectors or scheduling.
