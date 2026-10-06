# Status and current-pass presentation

Issue [#9](https://github.com/Al-Yousef/work-updates/issues/9) owns the presentation contract shared by the queue, paired desktops and native Windows view. Collection stays read-only. A chat name, its current task, the recorded update, submission acceptance and task completion are distinct facts.

## Current pass identity

The source chat ID and accepted Codex turn ID identify the current local pass. Successful start or reply records the turn ID before `turn/started` is required. Acceptance proves submission, not completion.

During RPC acceptance, the controller holds turn-scoped start, completion and agent-message events. After the authoritative receipt, it applies matching events in order. A pass completing before the receipt therefore remains completed. Older answers and events cannot overwrite that pass, clear its requests or issue a ready notification. Missing receipts discard unconfirmed presentation events without resending. Duplicate completion and a late start for a completed pass do not reopen it.

This buffer holds at most 200 events, with message text bounded to 16,000 characters. Overflow retains acceptance and a durable source-check error across restart. Later events cannot declare the incomplete presentation ready; a later explicitly submitted and accepted pass clears the gap. Completion bookkeeping retains 200 recent source/turn pairs. Persisted current-turn and notification identities protect the current pass after restart.

Modern app-server agent events carry `turnId`. Legacy unscoped messages retain their behavior outside the acceptance window; those inside it cannot be tied to a receipt and are discarded. Desktop-owned chats retain the read-only collector path and are never adopted by presentation.

## Status and evidence

| State | Meaning and text |
| --- | --- |
| `queued` | A local task is stored and has not started: Queued. |
| `starting` | A local writer is preparing or submitting a task: Starting chat. |
| `working` | The accepted current pass is running: Working. |
| `needs` | A pending request or explicit statement needs human input: Waiting on you. |
| `waiting` | The recorded answer names a wait. A known reviewer, person or system is shown; missing ownership says Waiting, owner unclear. |
| `blocked` | Failure, interruption, disconnect or incomplete reconstruction: Blocked, optionally with a recorded waiting owner. |
| `ready` | The completed pass has an update: Ready to review. |
| `done` | The user explicitly completed the overall task: Done. |
| `unknown` | Current activity is unverified: Check status, or the labelled last known state below. |

`waitingOn` comes from pending human requests and explicit statements in the latest recorded response. A named wait is evidence of that statement, not an independent check that the other party is acting. Negative statements such as "no longer waiting" do not establish a wait. Urgency is likewise explicit recorded language.

`availability` records freshness, provenance and whether evidence is cached. An offline execution owner takes precedence. An actual local writer can supply fresh activity independently of the collector. Otherwise failed collection or a zero/invalid timestamp, more than 30 seconds old or over five seconds in the future, is stale. Legacy clients without a timestamp retain `unknown` provenance rather than claiming a freshness measurement.

Stale or offline running/starting cards become `unknown`, with activity stopped and their original `sourceStatus` retained. Labels explicitly say "Offline, last known" or "Stale, last known". Other recorded terminal/waiting states keep their meaning with the same evidence prefix. Reprojection preserves the original source label so prefixes do not accumulate. Execution-device icons retain the source PC/Mac/Linux identity; offline devices remain labelled offline rather than becoming the viewer's device.

## Ordering and summaries

Waiting on you sorts first, then explicit urgency, unknown-owner blockers, reviewable updates, locally queued work, starting/working work, and known external waits. Within each priority, newer finite timestamps sort first. Invalid timestamps sort as zero. Equal timestamps use a case-sensitive ordinal comparison of owner identity, card identity and task revision. Reversing feed/peer arrival order cannot change those ties.

The chat name is independent of the current task title and short update. Summaries are keyed by source ID, turn ID, fingerprint and bounded input, and require loaded completed context. An older cached result cannot present as the current revision. Unchanged eligible input is deduplicated by the existing summary pipeline.

| Summary state | Detail fallback notice |
| --- | --- |
| Cached | Saved summary |
| Pending | Summary pending, recorded update shown |
| Failed | Summary unavailable, recorded update shown |
| Disabled | Recorded update, summaries off |
| Rate limited | Summary paused, recorded update shown |
| No eligible summary | Recorded update |

Fallback bodies use recorded excerpts. The native source menu and accessible card names expose the notice. No fallback invents an answer or triggers another inference merely because the view opens.

## User actions

Reading or opening a chat does not acknowledge an update or complete its task. Reviewed acknowledges the current notification. Mark task done separately completes the overall task; Reopen task reverses that choice. A pass completion does not undo a user's Done choice. Native source actions use the existing queue's revision checks and undo journal. Message-journal queueing, Codex acceptance and later pass outcome remain separate; see [delivery confirmation](delivery-confirmation.md).

## Verification

Shared synthetic fixtures cover 15 states: waiting on you/reviewer/CI/unknown owner, running, blocked, completed, local queued, offline, stale, and five summary states. Backend tests run each through the real queue, paired-device namespacing and native projection. The C++ queue model consumes the same generated fixtures, including a local queue with no source ID. Ordering, freshness, read/review/Done separation, stale-summary revisions and unchanged-input inference have independent regression coverage.

`native/windows/scripts/status-audit.ps1` runs the actual isolated native window against those fixtures at 96 and 144 DPI, checks accessible labels and source selection, and saves 30 rendered screenshots with hashes. Input uses simulated messages to only its own window. It does not prove physical cursor input, an Explorer attachment, real Codex delivery or an installation. No accounts or model calls are used. Normal shutdown is required; a timeout or forced termination fails the audit.

Windows CI runs this gate and includes the synthetic screenshots and sanitized report in its unsigned candidate artifact. Local Application Control blocking is a failed local visual gate; it does not justify changing security settings. Physical Windows input and installed Apple-device checks remain separate roadmap requirements.
