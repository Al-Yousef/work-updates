# Ongoing responsibilities

Open the intended source chat in Hyphen, then tell the assistant `Keep working in this chat: INSTRUCTION` or `/responsibility start INSTRUCTION`. Hyphen saves the literal human instruction and a child message identity before using its existing Queue pipeline. It names the source chat and returns the responsibility ID. No separate assistant model call is needed to interpret these explicit controls.

The journal records the original human message, current instruction and revision, exact source and owner, execution device, current and past steps, wake reason and completion criteria. Ordinary questions use the configured assistant provider with a bounded view of this journal. They do not cancel, resume or add steps. Source text and model output cannot authorize a responsibility mutation.

## Controls

Use the full ID returned by Hyphen:

| Request                                                                    | Effect                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/responsibilities`                                                        | Show the latest twelve responsibilities, their IDs and states.                                                                                                                                                 |
| `/responsibility steer ID: INSTRUCTION`                                    | Retain a new literal human instruction on that responsibility. Update an unsent step, or create a fresh step after the current source pass. Preserve its original source, owner, device and any explicit wait. |
| `/responsibility wait ID user\|approval\|external\|sleep\|blocked: REASON` | Persist an explicit wait and reason. It does not interrupt an accepted source writer.                                                                                                                          |
| `/responsibility wake ID`                                                  | Resume the retained step or monitoring. Never replay queued, accepted or unconfirmed delivery.                                                                                                                 |
| `/responsibility approve ID`                                               | Explicitly release that responsibility's approval wait. This does not grant permissions to tools or external services.                                                                                         |
| `/responsibility cancel ID`                                                | Cancel an unsent step or one confirmed queued message. Accepted or unconfirmed work must be managed in the source chat. Other work is preserved.                                                               |
| `/responsibility verify ID`                                                | Mark the broader goal complete after the latest instruction's exact source pass completed and the human reviewed the requested result.                                                                         |
| `/responsibility start-pass INSTRUCTION`                                   | Explicitly choose matching source-turn completion as the whole goal's completion criterion.                                                                                                                    |

Running, waiting for user, approval or external work, sleeping, blocked, completed and cancelled are separate states. New human steering during an accepted pass waits for that pass's matching terminal receipt. An explicit wait survives both progress and restart. If the source, device or capacity prevents advancing, Hyphen saves the old pass's terminal proof and blocks further delivery while retaining the new instruction.

## Delivery and recovery

Admission requires a fresh source snapshot, unique original source and owner, exact task revision and execution device. The journal is written atomically before any send or cancellation. It uses the existing durable message ID, receipts and delivery transport, including paired devices. No new executor, connector or model provider is introduced.

A locally queued message, accepted source turn and completed source turn are different facts. Only matching source/owner/message receipts and the accepted turn's terminal outcome update progress. A finished source pass leaves an ordinary responsibility waiting for human verification of the broader requested result. If a newer instruction is still pending, verification of the older pass cannot finish the goal.

Restart keeps ready, queued and accepted steps. Interrupted dispatch or cancellation becomes unconfirmed, with no automatic retry. Source changes block admission; journal errors preserve the original bytes. Progress storage failures leave the previous durable state intact, emit a typed diagnostic without private text, and can recover on a later source snapshot. Unsupported or corrupt journals require explicit recovery rather than reset. Older program rollback contracts refuse a profile containing the new journal if they cannot read it.

Capacity is explicit: 128 responsibilities, 64 steering messages and 64 past steps per responsibility, 5,000 creation identities, and a 32 MiB journal limit. Exhaustion refuses admission without dispatch or silent eviction.

## Verification and limits

`node --test tests/responsibilities.test.cjs tests/responsibility-command.test.cjs tests/assistant-responsibility.test.cjs` covers journal recovery, unknown acceptance, queued cancellation, steering, source/device ambiguity, maintenance, explicit waits, changed sources and storage failure.

`node scripts/responsibility-contract-audit.cjs --require-clean` exercises the actual assistant, journal and message queue with one owned disposable Node worker and one generated result artifact. It restarts the responsibility before delivery, rejects an obsolete turn, checks the result's exact schema and nonce independently, and only then supplies a synthetic human verification. The source revision and fresh report are recorded in `artifacts/responsibility-audit/verification.json`. Desktop CI runs it on Windows and both macOS architectures.

This audit uses synthetic transport, no real account, no model calls and no installed data. It does not prove real Codex delivery, assistant model quality or physical input. Real delivery uses the merged coordination contract. Continuous scheduling, inferred follow-up planning, delegated workers, external actions, stop propagation and independently automated outcome checks remain separately owned by #18, #20, #25, #26 and #35. This coordinator advances only literal human steering; it cannot invent additional work or approval.
