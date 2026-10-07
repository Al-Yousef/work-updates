# Chat coordination

Current human instructions can send or queue one exact message to an existing source chat. Questions, quotations, source-chat text and assistant suggestions cannot authorize delivery. The proposed message must match the current human instruction; the original human text is dispatched. A model cannot add work or change a requested Queue into Send.

Hyphen resolves source ID, execution owner and device, current card and task revision. If “that chat” has no unambiguous destination, it keeps the proposed text and asks which chat should receive it. An exact human choice can finish that pending request. An opened source can retain its identity when accepting a turn moves it to another queue card; a new instruction still validates its current task revision and device.

Intent is saved before dispatch. Each message uses the existing durable message journal and replay protection. A restarted, interrupted dispatch remains unconfirmed and is never automatically replayed. A matching receipt includes message, source and owner identity; acceptance also requires a nonempty turn ID.

The conversation distinguishes locally queued, accepted by Codex, unconfirmed, not sent and later completed or failed. Completion requires a terminal record for the exact accepted turn on the exact source. Source events update the conversation without running another model and without repeating unchanged progress. A send receipt never proves completion.

“Cancel that queued message” cancels the immediately preceding queued coordination. “Cancel the queued message for CHAT NAME” selects a unique queued coordination with that exact name. Cancellation requires a fresh, online source and a matching still-queued message. It preserves other messages, unrelated drafts and active writers. Accepted or uncertain delivery cannot be cancelled as a local queue entry. Related source links open the exact original chat and supply an empty draft so existing composers keep their own text.

## Evidence

`node --test tests/assistant-coordination.test.cjs` covers receipt-backed queue acceptance and terminal completion, wrong-turn rejection, deduplicated progress, targeted cancellation and its acceptance race, retained clarification, instruction expansion, receipt identity mismatches, execution-device changes, restart and failed storage.

`node scripts/coordination-contract-audit.cjs --synthetic --output=artifacts/coordination-check` exercises the actual Assistant, Controller and Messages together with a synthetic transport. It covers adoption into another card, three exact deliveries, queue cancellation, replay after restart and read-only drafts.

The real-chat variant needs separate human authorization under CONTRIBUTING.md. With `--allow-disposable-chat`, it creates one disposable chat, uses existing quota for three synthetic source turns and archives it after verifying the original messages. Tools, connectors, hooks, memories and external work are disabled. The structured assistant-answer provider is deterministic in both variants: this audit proves coordination and actual source receipts, not model interpretation quality, desktop ownership, native GUI or physical input. No existing chat or installed app data is used as a fixture.
