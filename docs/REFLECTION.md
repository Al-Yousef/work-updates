# Reflection and resumable checkpoints

Source candidate for #22, temporarily based on the original-record research
candidate in #49. The composition root wires scoped controls, bounded retained
context and the optional while-open timer. Main integration and platform
acceptance remain pending the prerequisite merge; installed data and real
accounts are outside this source audit.

## Controls and limits

A literal current human `/reflection enable RESEARCH_UUID: JSON` binds one
existing research scope and its source, owner, device and store identity. It
records an explicit timezone, manual/daily/weekly cadence, UTC end, maximum
review count, record/character/commitment budgets and temporary retention days.
The default is manual. No reflection reads new source details, runs model
inference, sends a notification or grants execution authority.

The reader's existing finite scope remains authoritative. Background checks
are quiet when unchanged, respect research off/manual-only preferences, and
stop under revoked, expired, paused or unavailable scope. A later control cannot
silently widen the source or revive a revoked grant. While the app is open,
a bounded timer can checkpoint one missed calendar review, without replaying
all missed dates. Calendar timing reuses the reviewed timezone and DST rules.

`/reflection inspect`, `checkpoint`, `pause`, `resume`, `decline` and `prune`
provide controlled review. Behavior questions, model answers, quoted commands
and original-source records cannot change configuration or preferences.

## Checkpoint contents

Each verified checkpoint retains:

- The exact research scope, cursor and original-reader scan identity, coverage,
  record limits, truncation, failed scans and offline gaps.
- Changes since the preceding checkpoint, using stable original record IDs and
  commitment revisions rather than treating every scan as new work.
- Bounded literal reported findings, with later replies visible and separate
  from inferred interpretations or independently verified outcomes.
- Questions reported in checked records, labelled as reported questions whose
  resolution is unknown unless supported by later evidence.
- A next useful lead, grounded in an original record or unresolved commitment,
  with the reason and source identity carried forward for later review.
- Proposed priority or preference corrections, supporting evidence references,
  confidence limits and the explicit need for human confirmation.

A successful reader scan records the source actually checked. Failed, skipped,
revoked or absent scans must remain gaps. Reusing a previously read local cache
must be labelled as retained context, with no claim that a new source was
checked. The journal is written atomically and read back before saying saved.
A changed, corrupt, future or unverified journal is preserved for recovery.

## Suggestions and declines

An overdue human-reported commitment can suggest reviewing its priority,
without proving assignment or completion. A user-role original statement about
preferred answer style can suggest reviewing an explicit preference; it cannot
write that preference itself. Later contradictory replies remain visible and
prevent presenting an interpretation as settled fact.

Declining one proposal saves a literal current human reason linked to that
proposal and review. It does not create a permanent preference, suppress a
changed future obligation, or grant authority. Acceptance uses the existing
explicit commitment/preference controls; the reflection journal cannot mutate
those ledgers. Unchanged proposals and previously declined identical evidence
remain distinct from newly changed evidence.

## Retention and recovery

Configurable retention applies only to temporary reflection checkpoints.
Before removing eligible old checkpoints, useful unresolved leads are saved in
a bounded durable lead list and that write is read back. Only then can a second
verified write prune the old checkpoint text. A crash between those writes
keeps the original checkpoint and carried lead; deduplication makes a later
retry safe. A full lead list fails closed, preserving the checkpoint.

Retention does not delete original research records, source account history,
Hyphen conversations, commitments, preferences, authorizations or other local
stores. The newest checkpoint for each scope remains available as the change
baseline. Revocation stops source reads and new checkpoint interpretations.
Configured retention can still carry forward existing local leads and prune
older temporary checkpoint text. Pausing the reflection scope also pauses its
automatic retention work. Neither control deletes every retained copy.

## Required evidence

Synthetic evaluations must check exact write/read-back, failed writes,
restart/cursors, topic and later-reply coverage, explicit preference suggestions,
declined-work boundaries, unchanged deduplication, timezone/DST cadence, finite
context and review budgets, revocation, and carry-forward before pruning.
They must assert no new original reads, model calls, source sends, assignment
or preference writes. Source integration and final platform acceptance remain
required after #49 merges. No separately authorized live reader audit is reused
as reflection or model-evaluation permission.
