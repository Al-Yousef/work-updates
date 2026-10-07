# Responsibility notification rules

Source candidate for #23, temporarily based on #49. Integration must use merged
research contracts. No installed app, real account, phone/email provider or
release is changed by the source audits.

`/notice configure RESPONSIBILITY_UUID: JSON` enables a rule for one existing
responsibility and its original source, owner, device and task. There are no
rules by default. Configuration chooses a supported self-only local destination
(`inbox` or `system`), conditions, named-timezone quiet hours, routine changes,
finite expiry, minimum interval, maximum attempts and bounded reminder timing.
Explicit current human controls inspect, pause, resume or acknowledge a receipt.
Ordinary questions, worker answers and source commands cannot configure rules.

## Findings and decisions

Worker findings retain source revision, responsibility/step identity, collected
snapshot time, selected original-reader statements when already available,
coverage gaps, reported status, waiting ownership and manual urgency. This does
not read a new original source, run inference, grant tools or verify an outcome.
Generated summaries stay reported summaries. Missing original coverage remains
a gap. A worker's finished pass does not complete the human's broader goal.

Notification decisions separately record whether to notify or stay quiet, and
why: unchanged finding, condition disabled, quiet hours, opt-out, minimum
interval, paused work, offline/changed owner, expired scope, bounded attempts or
unknown receipt. Quiet-hour and preference changes can reconsider a finding
without inventing a new worker run. Conditions can overlap, so an urgent-only
rule also covers an urgent finding that needs human review.

Explicit urgent reminders require confirmed responsibility waiting on the user,
manual urgency, elapsed time and remaining limits. Unknown waiting ownership or
inferred urgency cannot escalate. Acknowledgement ends reminders for that
evidence and does not verify its task. Changing a rule or destination does not
erase previous attempts, unknown delivery or unchanged-finding deduplication.

## Destination evidence and recovery

Every intent is atomically saved and read back before calling its destination.
The local inbox adapter reads the actual saved assistant message and checks its
identity, exact payload and destination. An `inbox_stored` receipt proves local
storage acceptance; it does not mean the UI displayed it or the user read it.
System notifications need an actual Electron `show` event. Creation, timeout
and failed callbacks cannot prove display. A show event does not mean read.
Injected OS-event fixtures retain their synthetic label.

Interrupted prepared/sending intents become unknown after restart. The inbox
can recover the exact receipt from saved destination bytes. An absent inbox
message or unqueryable system receipt stays unknown and is never automatically
resent. Resuming a rule or reconfiguring its quiet hours does not clear that
fence. Inspect the destination and retained intent before any new decision.

Reversible holds before an attempt retain the prepared intent. A superseded
finding, changed binding, actor or expiry closes an unattempted intent. Eight
receipt probes and eight prepared delivery attempts bound each pass. While-open
timers are unreferenced and stop on shutdown/maintenance. Owned-work admission
also holds its notification work when that control service is available.

Configured source cards bypass older generic alert paths so these rules' quiet
decisions are respected. Direct user-requested delivery receipts stay visible.
System notifications additionally respect the existing attention setting and
foreground-window suppression. Local inbox destinations remain private to the
local assistant; remote devices and external audiences are unsupported here.

## Retained evidence

The private journal retains at most 32 rules, 256 findings, 512 decisions,
256 delivery identities, 512 human controls and 5,000 replay receipts. Dropped
finding/decision counts disclose bounded history. Delivery identities are not
pruned automatically; a full journal fails before another side effect.
Corrupt, future, independently changed or unverified journals are preserved.
`/notice inspect RULE_UUID` shows bounded findings, decisions, receipts and gaps.

The clean-source audit executes one owned Node worker, independently reads its
result artifact and actual inbox bytes, loses/reconstructs a receipt and checks
that configuration changes do not cause duplicate delivery. Source transport
is synthetic. Platform acceptance and final main integration remain required.
