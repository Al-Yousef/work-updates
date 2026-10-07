# Resource admission and usage accounting

Related: #32. This source candidate uses the merged responsibility, schedule,
research and delegation contracts. Whole-app performance acceptance remains in
#13; this change does not measure native/Electron memory or CPU.

`/budget inspect` works without inference. It shows global and configured
responsibility limits, consumed reservations, unresolved runs, recent reported
usage, duration, connector delays and expired configuration. Literal current
human controls can configure the global scope or an existing responsibility:

```text
/budget global: {"until":"2026-10-08T12:00:00Z","limits":{"runs":100,"tokens":150000,"costMicros":null,"concurrency":2,"readsPerHour":20}}
/budget RESPONSIBILITY_UUID: {"until":"2026-10-08T12:00:00Z","limits":{"runs":10,"tokens":40000,"costMicros":null,"concurrency":1,"readsPerHour":4}}
```

Choose a future expiry within thirty days. Zero limits stop new admissions.
Default global admission limits are 256 operations and 300,000 reserved tokens
per UTC day, four unresolved concurrent operations and 64 local connector reads
per rolling hour. These are configurable application defaults, not measured
performance thresholds, provider quotas or subscription entitlements. A finite
cost limit refuses unpriced inference. No credits or infrastructure are bought.
Budget configuration never grants source access or dispatch authorization.

Before assistant inference, connector reads or source worker dispatch, the
single profile owner atomically saves a reservation and verifies its read-back.
All admitted operations consume global limits. Worker messages also consume
their exact responsibility and delegated parent's configured limits. Reads
consume configured budgets of responsibilities bound to the same source.
Connector callbacks cannot bypass the budget wrapper. Unchanged record batches
double the delay, bounded at one day; provider throttling preserves a bounded
retry delay across restart. Existing read-grant expiry and limits still apply.

Model input estimates use UTF-8 bytes divided by three plus a 6,000-token output
reservation. Images are not accurately token-estimated here. Source workers
reserve 10,000 tokens; this is an accounting estimate, not a bound on source
execution. The larger of reserved and reported usage is charged. Completed
inference can report its actual input, cached input, cache write, output and
reasoning counts. Unreported pricing or usage remains null. Local original
record reads perform no model inference and have zero provider token/cost use.

The installed Codex 0.160.1 app-server schema was generated offline for this
change. Its `thread/tokenUsage/updated` notification binds `threadId`, `turnId`
and `tokenUsage.last`. Only the exact accepted turn's report is recorded; foreign
threads/turns and invalid counts cannot supply usage evidence. See the
[official app-server protocol](https://learn.chatgpt.com/docs/app-server).
Model-list entries are catalog candidates. A completed inference establishes
only that request's access; Hyphen does not copy plan entitlements or Dot prices.

These limits govern admission. The current Codex transport supplies no hard
per-turn token or price ceiling, and source executors can keep running after
acceptance. Reported actuals may exceed a reservation. The ledger blocks later
admissions when that happens; it cannot guarantee a hard spend cap. Duration is
elapsed client time, including unresolved periods, not measured CPU time.

Accepted worker capacity stays held until a fresh local-owner snapshot supplies
the exact matching turn's terminal outcome. Offline owners, a changed task,
wrong turns and receipt loss cannot release it. On restart, pending reservations
become unknown and are never automatically replayed. Unknown model calls remain
held for review because closing a transport alone does not prove server exit.
Budget controls remain available without a model call.

The private `budgets.json` version-1 journal is bounded to 2,048 reservations,
129 policies and 128 connector delays. At capacity it stops new work and
preserves the ledger. It does not silently prune uncertainty or reset prior
spend when limits are edited. Corrupt, future, externally changed or unconfirmed
stores fail closed; rollback must support the new store version. This candidate
does not delete prior evidence, change the installed app, access accounts,
purchase services or provision an executor.

Tests exercise production provider and message paths with synthetic transport,
actual-versus-estimated counts, parent/child limits, missing prices, concurrency,
restart uncertainty, connector throttling, unchanged backoff, exhausted dispatch
and write failure. A live model/account audit has not been authorized for this
candidate. Whole-app metrics and integrated acceptance remain required.
