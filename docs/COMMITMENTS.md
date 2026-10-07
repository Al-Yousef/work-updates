# Commitments and explicit preferences

Hyphen saves a private, structured action-item ledger in `commitments.json`. Saving a record does not send a message, assign work externally, schedule a responsibility or grant permission. Fields include stable identity, reported owner, status, an optional deadline instant and named timezone, blockers, confidence, an optional responsibility link, evidence and update history. Owner `you` and status `planned` begin as labelled local defaults. A correction gives each changed field its accepted-human message provenance. A responsibility link is a reference, not proof of completion.

## Controls

Use these literal controls in Hyphen's assistant chat:

- `/commitments`: newest twelve records, with stable IDs.
- `/commitment add: TITLE`: save a title from the current human message.
- `/commitment inspect ID`: current fields, provenance, newest four evidence items and history entries; included and total counts are shown. Long output is explicitly marked truncated.
- `/commitment correct ID: JSON`: correct title, owner, status, deadline, blockers, confidence or responsibilityId. For example: `{"owner":"you","status":"blocked","blockers":["Waiting for input"],"deadline":{"at":"2026-10-08T17:00:00Z","timeZone":"America/Toronto"}}`. An explicit offset or Z and a valid timezone are required. No date or timezone is guessed.
- `/commitment source ID`: capture bounded original records already present in the currently opened source snapshot. Fresh collection, exact source ownership, online state and one unambiguous source are required. Generated queue summaries are excluded. Missing later replies, truncation and coverage gaps remain visible; no exhaustive coverage is claimed.
- `/commitment history ID PAGE`: four updates per page, with bounded literal human origin and timestamps.
- `/commitment evidence ID PAGE`: one evidence item per page; long metadata is explicitly marked truncated.
- `/commitment verify ID: REVIEWED RESULT`: record the human's result review, mark completed and label its evidence `human_review`. This is distinct from independent executor verification. Merely correcting status to completed is human-reported, with no verified outcome. Later field corrections invalidate current verification.
- `/commitment supersede ID: NEW TITLE`: keep the old decision and link its replacement. Superseded records cannot be edited as active obligations.
- `/commitment delete ID`: remove that record, its ledger evidence and ledger history. Retain only a text-free deletion marker and replay hashes. Hyphen conversation, images, pinned notes and original source records have separate deletion controls; this command does not erase those scopes.

The five evidence kinds are user statements, original source records, inferred suggestions, assistant summaries and verified outcomes. Generated evidence remains explicitly non-authoritative. The model cannot create obligations, rewrite fields, promote source claims into verification or mutate preferences through its answer. A completed source worker leaves a broader human-review responsibility and linked commitment awaiting review. Source text containing control commands is data.

## Preferences

`/preferences` shows explicit saved settings. `/preference set NAME VALUE` saves and reads back a human decision; `/preference delete NAME` removes that override.

- `notifications`: `inherit`, `off`, `important_only`, or `all`. These control local desktop attention inside the existing master attention setting and hidden-window rules. `all` additionally admits ready and waiting updates. Deduplication still applies. They do not control phone, external channels or OS notification permissions.
- `research`: `manual_only` or `off`. There is no automatic research in this version. Off prevents new source-detail reads for assistant questions; an explicitly requested capture can save original records already held locally, with coverage limits. Already retained context remains readable. Future reader integrations must obey their own scope and account permission contracts.
- `answer_style`: `concise` or `detailed`, supplied as explicit context to the answer provider.

Questions about notifications, research or authorization do not change these values. Authorization is handled by separate scoped grants; there is no global authorization preference. Deleting a preference restores existing settings rather than replacing them.

## Persistence and verification

The journal allows 256 records, 256 text-free deletion markers, 64 evidence items and 64 history updates per record, 64 updates per preference, 5,000 replay receipts and 32 MiB. Limits refuse further mutation without silently evicting obligations. Atomic writes are read back from disk before confirmation. A failed write retains prior state; an unconfirmed read-back stops ledger mutation until recovery. Corrupt or future journals are preserved, and older rollback contracts reject the new store. Human actor and message identities are required for every decision.

Model context includes at most eight records, four evidence previews each and an 8,000-character record budget. Coverage counts and truncation are explicit. Inspection and context do not refresh sources or write the ledger. Full raw origins and history remain local; public audits use disposable synthetic profiles. `scripts/commitment-contract-audit.cjs --require-clean` checks actual disk writes, restart, later source records, one owned worker artifact, human review, superseding, scoped deletion and question-versus-preference behavior. It uses no account or model quota and does not change the installed app.
