# Explicit document requests and verified local outputs

The supported document provider is `local-private-text`: an explicitly imported UTF-8 Markdown/plain-text copy in this desktop's private `document-library/`. Editing this copy never changes the original import file or a remote document. Remote Pages/Docs, mentions and comments to other people are reported unsupported; no private Dot interface or implicit connector access is used.

```
/document inspect
/document import {"file":"ABSOLUTE_FILE_PATH.md","title":"Chosen title"}
/document request DOCUMENT_UUID: {"mode":"reply","revision":"CURRENT_SHA256","start":1,"end":3}
/document request DOCUMENT_UUID: {"mode":"draft","revision":"CURRENT_SHA256","start":2,"end":2,"replacement":"Reviewed replacement text"}
/document apply DRAFT_UUID
/document schedule DOCUMENT_UUID: {"revision":"CURRENT_SHA256","everySeconds":3600,"until":FINITE_UTC_MILLISECONDS,"maxRuns":3,"append":"\nExplicit scheduled output"}
/document cancel SCHEDULE_UUID
```

Import requires one exact selected `.md` or `.txt` regular file, bounded at 512 KiB. Connected identity, location, current byte revision and line count are inspectable. Reply returns a bounded requested range as data. Draft records the exact revision/range and inspectable before/after. Apply requires the current human's exact draft confirmation and checks that revision again immediately before atomic output. A stale edit is held and preserves existing contents. Requests for comments/mentions are refused rather than sent to an audience or treated as assistant instructions. Text in a document, including a proposed cadence, never establishes a schedule or access grant.

Recurring output needs the literal schedule command, exact initial revision, finite UTC end time within 30 days, interval 60 seconds..1 day, at most 64 runs and explicit append text. The first actual output is separate from saved setup. Each run records its request identity before writing and readback revision after output; future runs follow that verified revision. A changed file, unknown write, changed human owner, expired grant or global stop fence holds/stops future changes. Imports, applied edits and scheduled outputs reserve shared global operation/concurrency capacity before output; exhausted limits hold writes, and ambiguous output retains its reservation across restart. Verified local output uses no model tokens or provider billing. Startup does not repeat an applying/unconfirmed request; delayed polling performs one due output and does not replay every missed interval. Cancelling retains output and receipt history.

The journal retains up to 128 documents, 128 drafts, 32 schedules and 1000 replay receipts. Bound exhaustion holds new actions. Library redirects/symlinks and incompatible/external journal replacement are held. Output copies and edit receipts are independent from assistant conversation deletion; private export never implies sharing permission. `/privacy preview document-copies` previews owned output copies and active dependencies before a separate exact confirmation; imports, edit text, schedules and replay receipts remain. External-provider identity/revision/audience adapters remain separate provider scope.

Production-path synthetic tests use actual owned local files, including revision conflicts, exact range changes, scheduled output/readback, cancellation/restart, ambiguous writes, future formats and redirected-directory refusal. They do not use an account, model, existing document, provider upload or installed app. The initial local provider is integrated in main. Separately authorized external provider and client evidence remain distinct from this local-file proof.
