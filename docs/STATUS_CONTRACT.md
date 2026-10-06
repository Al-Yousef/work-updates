# Status and current-pass presentation

Issue [#9](https://github.com/Al-Yousef/work-updates/issues/9) owns the shared status contract. Its first implementation protects local app-server tasks from delayed turn events. The remaining collector, native visual and device acceptance criteria stay open.

## Current pass identity

The source chat ID and the accepted Codex turn ID identify the current local pass. A successful start or reply records that turn ID even if `turn/started` has not arrived. Acceptance proves submission; it does not prove completion or finish the user's task.

During the RPC acceptance window, the controller temporarily holds turn-scoped start, completion and agent-message events. After the authoritative reply, it applies events for that accepted turn in their original order. Thus a pass that completes before its acceptance reply remains completed, and older events arriving in the same window cannot supply its answer or status. A failed or missing receipt discards those unconfirmed presentation events and preserves the existing delivery uncertainty handling.

This temporary buffer holds at most 200 events, with message text bounded to the queue's 16,000-character limit. Overflow preserves the accepted receipt and displays an explicit source-check error instead of reconstructing readiness from incomplete events. The gap is retained for that pass across restart, so a later terminal notification cannot declare its incomplete presentation ready. A later explicitly submitted and accepted pass clears the old gap. Overflow never resends the message.

Once the current turn is known, notifications carrying a different turn ID cannot replace its answer, change its status, clear its pending requests or emit a ready-to-review notification. Duplicate completion and a later start notification for the same completed pass do not reopen it. Completion bookkeeping is bounded to 200 recent source/turn pairs; the persisted current turn and notification version also protect the current pass after controller restart.

The modern app-server supplies `turnId` on agent-message events. Legacy unscoped messages outside the acceptance window retain their existing behavior; unscoped messages inside that window cannot be tied to its receipt and are not applied. Observed desktop-owned chats retain the collector path and are not adopted or resumed by this contract.

## Existing status vocabulary

| Stored state | Meaning |
| --- | --- |
| `queued` | A local task is stored and has not started. |
| `starting` | Hyphen is preparing or submitting a new task. |
| `working` | The accepted current pass is running. |
| `needs` | A pending human request or an explicit statement asks for the user's input. |
| `waiting` | The latest completed answer says it is waiting; known ownership is shown separately and unknown ownership stays unknown. |
| `blocked` | The pass failed, was interrupted, disconnected or cannot be reliably reconstructed. |
| `ready` | A completed pass has an update ready to review. |
| `done` | The user marked the overall task complete. |

The existing attention projection distinguishes waiting on the user, a known other party/system and an unclear owner. Reviewing an update and completing a task remain separate actions. Message-journal queueing, Codex acceptance and the pass's later outcome also remain separate; see [delivery confirmation](delivery-confirmation.md).

## Verification and remaining work

Controller regression fixtures cover acceptance before start, completion before acceptance with and without a start notification, delayed old answers and terminal events, current-request preservation, duplicate completion, late start, exact delta whitespace, missing receipts and buffer overflow. Existing queue and summary tests cover cached summary revision protection and unchanged-input inference deduplication.

Issue #9 still requires one shared fixture set across collector/native/device projections, fully documented deterministic ordering ties, stale/offline and summary fallback presentation, and native visual checks of every meaningful status. Backend fixtures do not establish those visual or physical-device outcomes.
