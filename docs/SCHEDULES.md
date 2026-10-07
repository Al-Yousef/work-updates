# Persistent schedules and follow-ups

Schedules attach to an unfinished responsibility and retain its literal human instruction, source, task, owner, execution device and human revision. They do not introduce another model provider or executor. Scheduling adds explicit permission to repeat that instruction within the stated timing, end date and run limit. A changed instruction or execution scope cannot silently inherit the old schedule.

Use `/schedules` to inspect IDs, states, next planned wake and last actual source acceptance. Create a schedule with one of these forms, replacing the full responsibility ID and end timestamp:

```text
/schedule start RESPONSIBILITY_ID every 2h zone America/Toronto until 2026-11-01T23:00:00Z runs 10
/schedule start RESPONSIBILITY_ID daily 09:00 zone America/Toronto until 2026-11-01T23:00:00Z runs 10
/schedule start RESPONSIBILITY_ID weekly 1,3,5 09:00 zone America/Toronto until 2026-11-01T23:00:00Z runs 10
/schedule start RESPONSIBILITY_ID deadline 2026-10-20T18:00:00Z every 15m zone America/Toronto until 2026-10-21T18:00:00Z runs 4 checks 8
/schedule start RESPONSIBILITY_ID watch every 15m zone America/Toronto until 2026-11-01T23:00:00Z runs 4 checks 8
```

Weekly days run from Sunday `0` through Saturday `6`. Timestamps require `Z` or an explicit UTC offset; timezone names describe calendar timing and presentation. Questions and quoted commands remain read-only. The latest twelve schedules are listed; the assistant receives a bounded view for status questions.

Use `/schedule pause ID`, `/schedule resume ID`, `/schedule cancel ID` or `/schedule now ID` with the full schedule ID. `now` records a user-requested run within the existing grant; it cannot release a responsibility's approval wait. `/schedule reschedule ID` followed by the same timing syntax changes the timing and limits while retaining completed run history and the original action scope. Rescheduling cannot approve replay of an unknown run or replace the action with a different instruction.

## Timing and scope

The journal persists a named timezone, end date, next wake, planned timestamps, actual acceptance timestamps, durable run and child message IDs, source outcome, and authoritative human changes. Scheduled, deadline, event and user triggers are recorded separately. Queue admission is not an actual source run. Historical acceptance with an unavailable original timestamp is marked unavailable rather than using restart time as the execution time.

Calendar schedules use the installed runtime's named timezone rules. A nonexistent local minute is skipped. A repeated DST minute uses only its first occurrence, so one calendar day cannot produce two daily runs. Weekly schedules retain their chosen days across DST. Interval schedules retain their UTC anchor. After missed periods, one bounded catch-up opportunity replaces the backlog; no burst of every missed mutation is replayed.

Deadline checks begin at the explicit deadline, including one overdue catch-up. Event watches first establish a baseline and run only after changed source evidence. Unchanged deadline/event sources back off with a bounded delay and check limit. No run overlaps a queued, accepted or unconfirmed earlier run. A completed worker pass retains the responsibility's broader result-verification requirement.

Execution currently requires the local source owner. Paired owners whose expiry contract is unverified are refused. End dates and run limits bound future admission. Each queued message retains its expiry, schedule and run identity, and the actual delivery pipeline rechecks expiry and pause/cancellation immediately before mutation, including after writer preparation. Cancelling an unsent scheduled message preserves other queued messages and accepted writers. A paused queued message retains its identity until resumed. A run already accepted before expiry can finish; stop propagation is owned by #26.

## Persistence and recovery

`schedules.json` uses private-store validation and atomic writes. Unsupported or corrupt journals preserve their bytes and block startup; older rollback contracts cannot consume this new store. Run intent is committed before the responsibility or message queue is touched. An interrupted checkpoint becomes unconfirmed and cannot re-admit the worker. Matching durable run/message/source/owner/turn proof can recover that existing run. Storage failures admit no replacement dispatch.

There are at most 64 schedules, 64 runs and 64 human timing changes per schedule, 256 rechecks, and a 32 MiB journal limit. Exhaustion refuses new admission without evicting unfinished work.

The backend polls saved timing at most once a minute and reacts to source updates. It can recover missed timing after application restart, sleep or clock changes. It does not install an OS scheduler or claim to wake a powered-off computer or closed application. Planned and actual times show that distinction. Host availability and future device execution remain separate contracts.

## Evidence

Timing fixtures cover both DST transitions, nonexistent/repeated minutes, fractional offsets, midnight, weekdays, expiry and missed periods. State and integration fixtures cover overlap, authoritative human controls, scope changes, queues, restart, actual acceptance, backoff, cancellation, pause, incompatible rollback and preparation-time expiry.

`node scripts/schedule-contract-audit.cjs --require-clean` runs an actual timer, restarts a queued schedule, admits one owned disposable Node worker, checks the independently created result file, and verifies matching acceptance/completion and run-limit enforcement. It records a fresh source revision and report in `artifacts/schedule-audit/verification.json`. Windows and both macOS desktop CI jobs run it. This is synthetic transport and human verification; it uses no real account or model and changes no installed data. Real Codex delivery and physical desktop behavior retain their separately verified contracts.
