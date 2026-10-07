# Work controls

Controls are literal current human messages in the Hyphen assistant. Quoted
commands, source records, model answers and questions do not create controls.
`/work` or `/work inspect` displays the scope of each operation, active holds,
and recent committed action checkpoints. Large result previews explicitly
leave additional checkpoints in the private journal.

| Command                                 | Scope and result                                                                                                                                                                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/work pause-main RESPONSIBILITY_UUID`  | Holds future dispatch for this responsibility and its descendants, associated schedules and scoped reads. Keeps existing queue identities and accepted actions.                                                                                                                           |
| `/work resume-main RESPONSIBILITY_UUID` | Requires unchanged instruction and source scope plus an exact queued, active or terminal checkpoint. Releases only this main hold; does not wake a sleeping responsibility, approve a human checkpoint or resend an accepted message.                                                     |
| `/work stop-child DELEGATION_UUID`      | Cancels this child's unsent intent. Requests an interrupt only for the exact active turn already owned by the local connection. Keeps its lease until a matching terminal event resolves accepted or uncertain work. Requires a new child instruction to start new work.                  |
| `/work disable-schedule SCHEDULE_UUID`  | Holds future runs, including an existing queued run. A later generic schedule `now` control cannot bypass this hold. Already accepted execution keeps its receipt.                                                                                                                        |
| `/work resume-schedule SCHEDULE_UUID`   | Releases only this schedule's hold; other main, child, executor and global holds still apply. No automatic approval or uncertain run replay.                                                                                                                                              |
| `/work revoke-executor OWNER_ID`        | Revokes the exact known `source_owner` namespace and its existing grants. Cancels its tracked unsent work and requests stops for matching owned turns. Blocks future read and send admission. This is a Hyphen policy namespace, not an OAuth disconnect or global Codex account setting. |
| `/work stop-all`                        | Persists a global hold on Hyphen-managed message dispatch, responsibilities, children, schedules and scoped reads, including later-created work. Cancels tracked unsent messages and children; pauses future schedules and requests stops for matching owned active turns.                |
| `/work resume-all`                      | Reconciles the saved checkpoints and releases only the global hold. Cancelled messages, stopped children, paused schedules and revoked accounts remain cancelled, paused or revoked. Human controls are needed for new work or separately resuming a schedule.                            |

Stop all does not kill unrelated processes or other applications, stop source
chats owned by another connection, undo already committed external actions,
alter installed data, or revoke third-party account permissions. A source
handoff remains visible when ownership, the exact turn, scope freshness or
receipts cannot be established. The existing source-card stop button requests
an interrupt for that owned source pass; standing holds use the distinct work
controls above.

## Receipt and restart behavior

`work-controls.json` is a versioned private journal with at most 256 holds,
256 control records, 512 checkpoints per control and 32 MiB. Every control
keeps its accepted human actor, message identity, literal command, scope and
timestamp. Responsibility checkpoints retain revision, payload hash, source,
owner, device, task, message and accepted turn identities. Original delivery
receipts remain in the message and authorization journals.

The hold is durably saved before cancellation, executor revocation or an
interrupt. Storage failure before that save makes no mutation. An exact turn
is saved as unknown before the interrupt RPC. An acknowledgement changes this
to `interrupt_requested`; only a fresh matching source terminal event can
show `terminal_interrupted`, `terminal_completed` or `terminal_failed`.
Completion before interruption remains completion of that pass, with its
already committed actions retained. It never verifies the broader parent goal.

Lost acknowledgements and partial storage failure keep the fence and unknown
or partial checkpoint. Restart preserves prepared controls and never retries
an interrupt or sends the recorded intent again. Reconciliation only reads
existing matching receipts. Resume requires an unchanged instruction, exact
scope and a known queued, active or terminal checkpoint; uncertain messages
and pending readers need reconciliation before releasing their hold.

The interrupt adapter checks task ownership, task key, active turn and loaded
source on the existing connection. It never resumes or adopts a foreign chat
to interrupt it. Timeout or disconnect of `turn/interrupt` is an uncertain
mutation, rather than evidence that nothing happened. The demo follows the
same receipt contract and removes its old completion timer when stopped.

Admission is rechecked immediately before source dispatch. Human sleeping or
approval holds also apply to already queued responsibility messages. Work
fences survive generic responsibility wake, schedule now and child resume
commands. Individual holds remain independent of a global release.

## Verification

The local tests use disposable profiles, production queue, responsibility,
schedule, delegation and permission contracts, and synthetic source receipts.
The clean-source audit launches one owned Node worker, stops it through the
exact-turn controller adapter, checks its exit, and independently reads its
nonce-bound terminal artifact. It distinguishes acknowledgement from terminal
proof, preserves parent verification, tests restart and resume without resend,
and cancels tracked unsent work under stop all. It uses no accounts or models.
CI runs the audit on Windows and both Mac architectures.

The original-record research adapter is integrated with the research candidate
before final acceptance: it checks the durable read hold before and after I/O,
discards an in-flight response after pause or revocation, and requires a reader
checkpoint before resume. Its implementation and separately scoped live-reader
audit belong to #19. A generic reader fixture alone does not establish that
integration. This candidate claims no real-account interrupt, physical input,
external side-effect rollback or production executor verification.
