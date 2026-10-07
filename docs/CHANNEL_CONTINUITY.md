# Paired source drafts on iPhone

This first #29 subchange uses the merged #14 owner protocol. It retains source-chat drafts on the iPhone; it does not enable a shared assistant channel or widen the existing private-network audience.

Every draft belongs to a paired computer ID, authenticated host ID, source ID, task key and context revision. Changing sources saves the original draft before loading the destination. An offline draft can be edited. Restart restores its text. The phone never copies one source's draft into another source or a newly paired owner.

Before a send, the phone writes the submitted text revision and message UUID to its own journal, then persists the attempted state before posting. Restart treats interrupted attempts as unconfirmed. A lost acknowledgement retains the draft and holds another submission for that source, including after its context changes. Checking delivery reconnects the authenticated ordered state stream; it never repeats the POST. Only an exact source/message receipt with an accepted turn clears the submitted revision. Newer edits survive. Cancellation retains the text. An authenticated source outcome can recover an original receipt after restart.

The journal is bounded to 128 drafts, 512 receipts and 2 MiB. Writes are atomic and read back; external changes, redirected storage or a write failure hold sending. Unsupported/corrupt originals are preserved. iOS uses complete file protection and excludes the journal from device backup. In Devices → Saved phone drafts, a local human can preview one computer's retained draft count, text bytes, uncertain sends and receipt count, then confirm within ten minutes. Changed/uncertain sends hold removal; delivery receipts, other computers, original chats and pairing credentials remain. Forgetting a pairing leaves its drafts available for separate removal. Restart drops the ephemeral preview and requires a fresh one. Full audience/channel acceptance remains part of #31.

Validation uses disposable Swift journals, the actual WorkStore transport seam, core TLS fixtures and the simulator. Physical phone restart, locked-device behavior, private-network reconnection and two-client audience checks remain release gates. No account or model audit is part of these fixtures.

## Remaining channel work

The current negotiated protocol advertises `assistant: false` and `attachments: false`. Source-chat delivery does not establish desktop/iPhone assistant-history continuity. That needs independently authenticated channel actors, authorized audience transitions and per-destination assistant receipts before exposing assistant commands.

Slack, Teams, SMS and phone adapters remain unsupported. Each needs a separate supported-API assessment and scoped implementation with its own account permissions and recipient contract. Source text from another participant is evidence, never authority over the private assistant.
