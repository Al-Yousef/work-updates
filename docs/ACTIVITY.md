# Activity and source-access timeline

Source candidate for #24, temporarily based on notification PR #52 and research
PR #49. No installed app, existing account or model is changed by the fixtures.

`/activity` and `/activity list: JSON` inspect retained metadata. Filters support
type, exact source or responsibility, time bounds and synthetic evidence. The
page size is bounded; assistant rendering reduces the page size until the page
and its cursor fit together. Signed cursors bind filters and pin the highest
sequence so new events do not shift earlier pages. Retention moving beneath a
cursor is disclosed, including when no older page remains.

## Recorded evidence

Checking sessions, individual source-read attempts, retries, owned worker steps,
delegated runs, schedules, approval states, waiting states, findings,
notification decisions and notification receipts have separate event types.
Local source-message intents and receipts also appear separately, with their
saved task/message identity. Missing owner identity and provider-call times
remain unknown. Status transitions are events. They do not count as additional reads or runs.
Counts use distinct retained identities and disclose missing starts.

New scoped original-reader calls and owned responsibility dispatches save and
read back planned/start metadata before calling the existing provider. Their
actual timestamps delimit the local provider call. Remote task runtime is
separate. A returned reader envelope remains unvalidated until the research
store accepts it; a transport return alone is not a verified receipt or goal.
Failure messages, prompts, selected context and source text are never copied.
Interrupted calls become unknown after restart and are never replayed by the
timeline. An unverified journal prevents another newly instrumented call.

The existing local collector supplies content-free session and source-batch
start/return metadata. Catalogue access and actual context reads are distinct;
unchanged cache reuse creates no context-read attempt. Its producer timestamps
are labelled separately from Node instrumentation. At most 256 source batches
per session are retained, with a missing-history marker for additional reads.
Logical batches can contain multiple SQL/file queries. Remote collectors and
cache-only UI inspection remain outside this local instrumentation.

Existing stores provide bounded initial state and later observed transitions.
These are labelled retained projections or live observations. Unavailable
planned/actual times remain null. Historical runs are not reconstructed from
summaries. Messages without an owned responsibility link retain only their known message
and task identities; the timeline does not invent a historical owner. This is not an exhaustive account
access log. Source-owner identifiers name the existing execution namespace;
they do not establish an authenticated account or a person's assignment.

Task, step, schedule/run, parent/child, research/read, approval, original-record,
finding and notification identifiers link related evidence. Waiting reasons are
fixed codes; private reason prose is excluded. A cached child output reference
is evidence of a retained source excerpt, not proof it belongs to the matching
turn. Inbox-stored, OS-shown, user acknowledgement and goal verification keep
their existing meanings.

## Retention and export

The private journal defaults to 30 days and 2,048 events. Literal current human
configuration can choose 1..365 days and 32..4,096 events:

```text
/activity configure: {"retentionDays":30,"maxEvents":2048}
```

Dropped counts describe lost event rows, not an assumed total of source reads.
Stable per-entity projection fingerprints prevent unchanged polls from
recreating pruned history. The recording start and prior-history gap remain
visible. Independent deletion/changes, corrupt/future schemas and failed or
no-op writes preserve the remaining files and require recovery.

Export is opt-in with an exact accepted human command:

```text
/activity export: {"redacted":true,"filters":{"synthetic":true}}
```

The export uses new pseudonyms for all identifiers while preserving internal
correlations. It rounds timestamps to minutes and omits prompts, titles, source
bodies, credentials, account names, file paths and output text. The generated
file lives in the local private profile's activity-exports directory. Saved is
reported only after independent byte readback and a verified journal receipt.
Export does not upload, publish, send to another user or grant source access.

The clean-source audit uses owned original records and one owned worker, checks
timeline correlations and counts, exercises receipt recovery, and independently
reads a synthetic redacted export. Platform checks, a user-inspected synthetic
export and integrated main acceptance remain required. Audit metadata alone is
not evidence of installed behavior or a broader verified outcome.
