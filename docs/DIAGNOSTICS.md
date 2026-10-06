# Local diagnostics and recovery

Issue [#12](https://github.com/Al-Yousef/work-updates/issues/12) adds a bounded metadata timeline and opt-in local diagnostic report. Logs and reports do not contain prompts, answers, drafts, image pixels, pairing credentials or private paths. No report is uploaded automatically.

## Correlation

Each backend run has a new session ID. The local log retains exact opaque source, device, owner, task-revision, message-intent and accepted-turn identities. Native connections have separate session IDs. The controller binds a validated destination before dispatch, and its context flows through preparation and transport RPCs. Each pending RPC captures its originating context, so out-of-order replies cannot inherit the first connection's intent. Assistant message actions link their parent assistant intent to the child delivery intent. Message-journal recovery records the same durable intent in the new backend session without dispatching it again.

The native pipe records authenticated command start, outcome, duration, response size and bounded state-frame sizes. App-server and desktop transports record methods, phases, request identities, timing, response sizes and categorized failures. Message logs include queue depth and delivery transitions. Version, descriptor protocol, snapshot protocol and the SHA-256 of the backend entry script identify the report's backend; that entry-script hash is not a hash of the entire installed package.

Identifiers in an exported report become bundle-scoped HMAC aliases. Equal original identities retain equal aliases across fields and backend restarts in that report. New reports use a new random key, which is never included. Report metadata accepts only version, backend entry-script hash and protocol fields.

## Independent health

`connectionHealth` is shared with the native projection and included in a user-requested report. It separates collector freshness, app-server helper connectivity, desktop coordination connectivity, native-pipe listening/client count, and execution-device online status. An idle helper has not necessarily failed: an observed chat can have a desktop writer. A stale collector never becomes a writer failure merely because its read is old. Device names, addresses and filesystem endpoints are excluded from the health projection.

Collector freshness requires a valid positive timestamp within 30 seconds, with at most five seconds of future clock skew. A collector's explicit error stays distinguishable from cached/stale evidence.

## Failure guidance

| Failure evidence | Recovery |
| --- | --- |
| Preparation timeout, definitely not sent | Reopen the chat; the saved request can be retried. |
| Desktop ownership discovery timeout | Open the source to identify its writer; the message was not sent. |
| Known writer rejection | Open the exact source in Codex to check the writer; preserve the draft. |
| Unknown acceptance or lost receipt | Check the source before sending again. Never suggest an automatic resend. |
| Broken transport with a definite unsent boundary | Open Codex and reconnect. |
| Broken transport without that boundary | Preserve uncertainty and check the source. |

The native and compatibility command replies carry phase-specific guidance. It supplements delivery journaling; it never creates another writer, changes ownership, retries a mutation or interprets acceptance as task completion.

## Bounds and export consent

Local logs accept a fixed metadata schema. Arbitrary objects, unknown fields, free-form errors, stderr text and paths are omitted; only error categories and metadata remain. Each record is at most 8 KiB and fits its configured file limit. Each file is at most 512 KiB, with at most two rotated backups. Log write failure cannot interrupt a chat.

The tray and native menu offer **Export diagnostic report**. The first dialog previews included log basenames and record counts and describes included/excluded data. Cancel is the default. A second dialog asks the user to choose a destination. Only the exact prepared, sanitized snapshot is written; new log events cannot expand it after preview. It expires after ten minutes, permits one export and cannot overwrite Hyphen private storage, including through a directory alias. Concurrent export dialogs are rejected.

Input is limited to regular, size-bounded log files; linked files are rejected. Malformed lines are counted and omitted. Legacy lines pass the same metadata filters before export. The report is capped at 8 MiB and is atomically saved with a SHA-256 receipt. The [machine-readable schema](DIAGNOSTICS_SCHEMA.json) describes report version 1.

## Validation

`node scripts/diagnostic-bundle-audit.cjs` seeds failures through the real queue, controller and message journal in a disposable profile, reconstructs an interrupted delivery, previews and exports a sanitized report. It makes zero Codex dispatches, account accesses or model calls. It checks preparation, writer-lock and uncertain-receipt categories and correlation across restart. The generated bundle and verification report stay under ignored `artifacts/diagnostic-audit/`; CI publishes only those sanitized files.

Independent tests cover free-text and credential exclusion, huge records, rotation, legacy records, linked/oversized inputs, expiry, private-store protection, cancellation consent, out-of-order actual RPC replies, authenticated native command correlation and independent health states. The local Windows environment cannot create a file symlink for that specific fixture; that branch is checked on supported CI hosts. Physical cursor input, real Codex delivery and installation are separate evidence.
