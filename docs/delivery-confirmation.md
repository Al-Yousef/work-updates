# Delivery confirmation

Hyphen confirms a reply only after Codex accepts `turn/start` or `turn/steer`, or the desktop owner's matching receipt arrives. That receipt means accepted by Codex; turn completion is a later event.

## Current state contract

| State | Durable meaning | Next step |
| --- | --- | --- |
| Draft | Local composer text and attachments; no submitted intent | Explicit Send or Queue |
| Queued (`queued`) | Intent saved locally; Codex has not accepted it | Wait for that exact source to become eligible |
| Dispatching (`sending`) | Intent saved before transport submission | Await the current request's receipt |
| Accepted (`sent`) | A current acceptance receipt is saved | Show acceptance; completion arrives separately |
| Not sent (`failed`) | Preparation failed or Codex explicitly rejected the mutation | Preserve the draft; an explicit new intent may retry |
| Unconfirmed (`uncertain`) | Acceptance is unknown, or its receipt could not be committed | Preserve the draft and pause this source's queue |
| Cancelled (`cancelled`) | Local cancellation committed | A new draft needs a new message identity |

The same message ID and text/attachment digest identify the intent across restart and panel requests. App-server start and steer requests include `clientUserMessageId`; this is correlation metadata, not a promise of server-side deduplication. Hyphen's durable journal prevents its own automatic replay. An old task turn ID cannot substitute for the current RPC response.

If acceptance arrives but saving its receipt fails, the draft remains unconfirmed and retains its text and attachments. When fallback storage successfully records the matching acceptance proof, an explicit request with the same message ID, source and draft digest can commit that proof without sending again. Missing, foreign or mismatched proof cannot reconcile. A failed cancellation or reconciliation commit preserves the previous draft and state.

Queued intents retain their source ID when that chat's displayed title or task changes. FIFO dispatch requires a current feed and that same source to be eligible; missing, archived, offline or busy destinations never redirect to a different chat. Assistant-triggered delivery rechecks finite collection freshness immediately before dispatch; future-dated snapshots outside the five-second clock tolerance are unavailable. A restart during dispatch leaves the intent unconfirmed. Late transport responses after a timeout do not currently upgrade that state; open the source chat and check it before using the existing manual clear/retry controls.

The deterministic suite covers receipt loss, storage failure, duplicate identities, restart, source changes, writer refusal and image-bearing drafts. These synthetic results do not replace issue #4's separately authorized disposable real-chat audit or native/device integration proof.

## Disposable audit

`node scripts/delivery-contract-audit.cjs --synthetic` verifies the harness with a disposable local transport and no account calls. After separate human authorization, `--allow-disposable-chat` creates one new read-only test chat using the existing small-model quota. It submits four synthetic turns: Send, a busy pass, its queued follow-up, and an accepted reply with an injected receipt-storage failure. It drops one panel acknowledgement, restarts its own helper/journal, checks duplicate identities, and reads only the newly created chat to verify each intent occurred once. A successful run archives that chat. A failed run preserves its private audit identity for review and never resends automatically.

Shell tools, connectors, plugins, background agents and memory are disabled in that test chat. No existing chats or installed Hyphen data are fixtures. Reports separate synthetic transport from actual app-server acceptance and explicitly exclude native GUI, desktop-owner, device and physical input proof. Actual billed token/cost metadata is unavailable from this transport.

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
