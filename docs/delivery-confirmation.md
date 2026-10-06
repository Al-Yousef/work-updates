# Delivery confirmation

Hyphen confirms a reply only after Codex accepts `turn/start` or `turn/steer`, or the desktop owner's matching receipt arrives. That receipt means accepted by Codex; turn completion is a later event.

## October 4, 2026 failure

Intent `080A1FF1-DD17-4CF0-B1DD-C344D86175B9` attempted to reopen a chat at 15:20:28 UTC. The helper logged invalid protocol lines of 143,953,945 and 48,119,512 bytes, then `thread/resume` timed out after 60 seconds. There was no `turn/start` or `turn/steer` for that attempt. The message had not been submitted, but Hyphen incorrectly classified every Codex timeout as uncertain. The user subsequently cleared this intent; the update does not resend or rewrite it.

Version 0.6.1 resumes with `excludeTurns: true`. The installed Codex CLI 0.160.0 generated schema explicitly supports this flag. Hyphen already retrieves its display context through the collector, so loading the full historical turns into this transport is unnecessary. This does not remove chat history or change the context Codex uses for its next turn.

## Failure boundaries

| Failure | Delivery state | Behavior |
| --- | --- | --- |
| Connection, owner discovery or resume fails before submitting a draft | Not sent | Preserve draft; allow an explicit new attempt |
| Codex explicitly rejects a mutation | Not sent | Preserve draft and show the rejection |
| A submitted start/steer loses its acknowledgement | Unconfirmed | Preserve draft; block later replies until delivery is checked |
| Accepted receipt saved but native panel loses its response | Sent | Reconcile the same message ID from storage without resending |
| App restarts during dispatch | Unconfirmed | Never replay automatically |

A timed-out resume retires only Hyphen's own helper when it has no loaded chats, active turns, or other pending requests. A send timeout does not retire the helper. A resume timeout while another chat is loaded or active leaves that helper intact.

Diagnostics store message ID, source chat, RPC method, failure phase, delivery state, elapsed time and response byte count. Conversation contents, prompts and response bodies are not logged. Existing uncertain messages are not automatically relabeled because they may have been accepted.

## Sources

- [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
- [Codex report: oversized image-heavy resume payloads](https://github.com/openai/codex/issues/26352)
- [T3 Code report: full-history resume wedges the backend](https://github.com/pingdotgg/t3code/issues/6399)

The two community reports describe the same class of history inflation and recommend metadata-only resume. They support the fix direction; Hyphen's own log sequence establishes that this particular draft was not dispatched.
