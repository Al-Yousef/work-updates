# Expected outcomes and proof

Hyphen can require a specific result before a responsibility is completed. A
finished source turn or child worker remains a completed pass. It does not prove
that a file was saved, a change merged, a deployment succeeded, or a recipient
received anything. Explicit local checks and an exact public GitHub PR adapter
provide bounded proof; other external destinations remain unsupported.

The current human configures one unfinished responsibility with a literal command:

```text
/outcome require RESPONSIBILITY_ID: {"kind":"artifact","stage":"saved","description":"Expected reviewed JSON result","target":"requested-result.json","targetRevision":"reviewed-result-v1","maxAgeSeconds":300,"until":UTC_MILLISECONDS,"root":"ABSOLUTE_SELECTED_DIRECTORY","file":"requested-result.json","fields":{"schema":1,"verified":true,"revision":"reviewed-result-v1"}}
/outcome check RESPONSIBILITY_ID
/outcome inspect RESPONSIBILITY_ID
/responsibility verify RESPONSIBILITY_ID
```

Replace the placeholders and use a numeric expiration within the next day. An
optional `sha256` requires the exact expected file bytes. A check saves its actual
receipt. Completion checks the destination again, so replacing a previously
verified file with a different result holds completion. Questions, source text,
quoted commands and model output cannot configure proof requirements or grant
file access.

| Kind          | Independent evidence available                                                               | Stages allowed                                                                  |
| ------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `artifact`    | Current regular JSON file, bounded scalar fields, actual SHA-256, size and modification time | `prepared`, `saved`                                                             |
| `source_pass` | Exact tracked message acceptance and, where required, its matching successful terminal turn  | `accepted`, `completed`                                                         |
| `github_pr`   | Fresh public GitHub API response matching the exact PR, expected head and target branch, with confirmed merged state and actual merge SHA | `merged` |
| `manual`      | Explicit current human attestation, labelled `human_reviewed`                                | `prepared`, `saved`, `accepted`, `completed`, `merged`, `deployed`, `delivered` |

Manual attestation is not independent verification. A source receipt cannot prove
merge, deployment or delivery, and an artifact cannot prove those stages either.
`targetRevision` identifies the human's requested target; artifact fields or a
digest establish the matching result. A source-pass receipt separately records
the actual source revision and turn identity. It does not prove a repository
commit or external recipient revision.

Checks require the same responsibility instruction, revision, step, source,
owner, device and task revision that received the requirement. Changed steering,
unavailable or stale sources, offline executors, expired scope, work holds and
maintenance prevent checking or completion. Missing, inaccessible, malformed,
oversized, stale and nonmatching artifacts have distinct statuses. Inspection
and answer context report bounded retained coverage; they do not read files or
refresh source data. No check infers a verified negative result from absence.

Work-control admission requires the explicit `allow` decision. `wait`, `deny`,
legacy `hold`, unknown decisions and admission/recovery errors block both proof
reads and completion. A pause arriving during a destination read discards its
response and keeps the shared reservation uncertain; resume does not replay it.

Artifact access is limited to one explicit selected directory and one relative
JSON file, at most 1 MiB and 16 scalar expectations. Traversal and linked files or
directories are refused. Reads bind the opened file identity, size and canonical
path before and after access. Raw file content and paths do not enter answer
context. Reports retain hashes and typed metadata, never substitute prose
summaries for the actual artifact. The owner can revoke further execution with
the existing work controls.

`outcomes.json` version 2 uses a private journal. Version 1 migrates in memory
without inspection writes; the next explicit control saves version 2, and a
program that supports only version 1 cannot roll back across new saved evidence.
Each operation verifies the
previous journal, writes atomically and reads the result back before reporting a
saved receipt. Unexpected or corrupt bytes are preserved, and unconfirmed writes
hold further operations. Rollback to a program without the outcome schema is
refused. Restart retains requirements and prior receipts without rerunning checks
or completing work.

## Evidence and remaining scope

`node scripts/outcome-contract-audit.cjs --require-clean` starts one disposable
owned Node worker with synthetic source transport. It proves that missing output
holds the responsibility, an actual matching JSON artifact is checked, restart
retains its digest, a replacement blocks completion, and explicit review of the
restored result permits completion. It uses no account or model and changes no
installed app. Focused tests cover altered instructions, source-turn identity,
freshness, offline/held executors, invalid file scope and journal failure.

Issue #35 remains open until its full integrated acceptance is established.
Local/public PR checks do not establish broad research coverage, independent
deployment/delivery checks, or account and physical-device evidence. The reader
account audit remains separately pending; it is not part of this contract audit.

## Exact public GitHub merge proof

```text
/outcome require RESPONSIBILITY_ID: {"kind":"github_pr","stage":"merged","description":"Merge this reviewed head into main","target":"https://github.com/OWNER/REPO/pull/NUMBER","targetRevision":"EXPECTED_40_CHARACTER_HEAD_SHA","baseRef":"main","maxAgeSeconds":300,"until":UTC_MILLISECONDS}
```

This adapter performs a single GET to the corresponding `api.github.com` PR
endpoint, without account credentials, cookies or redirects. No repository is
listed and no PR is created, merged, deployed or sent by a check. Private
repositories and unavailable responses remain inaccessible/partial. A 404
does not establish absence or a verified negative. An original public response
for the exact PR with `merged: false` is a typed `not_satisfied` observation.
A verified merge requires the expected head, branch, closed/merged state, merge
timestamp and actual merge commit. Pre-merge test commits never prove a merge.
The [official GitHub PR API](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)
documents these different commit meanings.

Responses are bounded to 1 MiB and 15 seconds. HTTP date/cache age and the finite
human scope constrain freshness. Saved proof includes typed identities and a
response hash; source titles, bodies and instructions are not retained or
executed. Shared global/responsibility read and concurrency budgets apply before
I/O. Unchanged results increase the delay up to one day; provider throttling
persists in the shared budget journal and cannot be bypassed by changing a
requirement. No check retries automatically on restart. A failed/aborted read
retains uncertainty. Inspection reports the next allowed check without reading.

Completion awaits a fresh destination check. Corrected instructions, changed
requirements, offline owners, stop/privacy holds, altered journals or closing
during that read prevent completion and discard obsolete responses. A successful
check alone leaves the responsibility awaiting the human's verification command.
Loopback HTTP fixtures exercise the production Assistant, responsibility,
destination adapter, budget and journal paths with synthetic public records;
they do not call GitHub, use an account or consume model quota.
