# Native migration

The first stage moves the Windows interface into C++ while keeping the existing queue backend. It uses the already-verified Windows weather-button adapter. No second collector or Codex writer is introduced.

## Stage 1

- Win32 tray and floating panel, Direct2D notification cards, DirectWrite text, DirectComposition entrance and dismissal.
- Portrait layout and clock retained from the accepted interface. Chat name, current task, summary, execution device, and backend status labels stay separate.
- Click a card for context. Open its selected source chat, snooze for one hour, review, or undo. Queued, reviewed/snoozed history, and finished tasks have separate views. Older chat updates require an explicit toggle.
- Authenticated named-pipe subscription pushes changes. Background workers handle pipe traffic; the UI thread performs no pipe reads or writes. Slow readers receive the latest state with bounded buffering.
- Queue identities and source IDs travel unchanged. Backend validation rejects stale task keys. Opening a chat does not create or adopt a writer.
- `--native-backend` creates no Electron BrowserWindow. The existing collector, AI cache, device pairing, persistence, and writer protections continue in this process.

This stage still uses Electron as a background runtime. Creating/grouping tasks, approval controls, pairing/settings screens, custom accessibility providers, and rotating working rings are not ported yet. These are the next migration stages; this is not a complete C++ replacement.

## Native replies

The reply editor is a standard Unicode Win32 multiline EDIT control above the DirectComposition surface. Enter sends, Shift+Enter inserts a line, and IME composition does not submit. Each source keeps its own in-memory draft. A pending send disables duplicate submission; a backend receipt containing its task ID clears only the exact submitted draft. Failures and uncertain delivery retain the draft without automatic retry. If adopting the observed source changes its card ID while sending, the selection follows that same source, preserving its draft.

Authenticated `send` uses the existing Controller and Devices routing. No second writer client is created. Its pipe deadline allows the backend's initialization/resume/start RPCs to report their own bounded outcomes. The request limit permits full 12,000-character Unicode drafts. Replies to desktop-held chats route through the discovered desktop owner when its supported channel is available. Writer rejection retains the draft; uncertain delivery never silently falls back to another writer.

The native view displays up to 500 backend-ranked current cards and 500 finished records, with truncation indicated in the interface. Full conversation context is fetched on selection and bounded to 16,000 characters per source. The original queue remains intact.

## Installation and rollback

The installed backend archive and launcher are backed up before replacement. Installation requires a fresh runtime record plus `quitIfIdle`; a running writer prevents the switch. A local `native-backend.enabled` marker makes portable restarts use the background mode. The C++ launcher starts that backend when needed and then opens the native panel. The adapter DLL is unchanged and is not overwritten while Explorer holds it.

For rollback, close the native interface, request `quitIfIdle` from the backend, restore the backed-up `app.asar` and portable `Work Updates.exe`, remove `data/desktop/native-backend.enabled`, and relaunch the restored portable launcher. Preserve the current queue data rather than replacing it with an older backup.

## Verification

The backend suite includes subscription authentication, original queue actions, stale-key rejection, review/new-update behavior, native replies, exact source identity, Unicode frames, acknowledgements, concurrent-send rejection, and original writer safeguards. The native model checks filtering, ordering, source selection, stale detail responses, failed draft retention, and adoption receipts. `native-queue-tests.exe DESCRIPTOR` runs actual C++ card actions against an isolated demo backend using simulated Win32 input. With `scripts/native-reply-fixture.cjs` it also checks the real editor, Enter, Send, duplicate submission, draft recovery, and exact-source follow-ups against the real controller with a deterministic Codex transport. It does not send to signed-in user chats. `native-adapter-tests.exe` checks the weather command behavior with simulated input; it does not establish physical pointer behavior. The weather adapter's previous real hover and click verification remains separate.

Rendered PNG exports show the actual Direct2D surface, not a mockup. Runtime records report actual Electron window/renderer counts. Memory and CPU must be measured across the complete process tree before claiming an overall performance improvement.
