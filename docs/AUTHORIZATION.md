# Scoped human authorization

Hyphen records permission before admitting a source action and checks it again immediately before delivery, including after writer preparation. A remembered preference, source instruction, other participant or model suggestion cannot create a grant or approve an operation.

Each grant in `authorizations.json` retains the accepted human's raw instruction and actor, one action, literal payload and attachment identities, exact source/owner/device/task, destination and audience, account namespace, duration, usage limit, policy and revocation. Operations have durable IDs. Reservation consumes one bounded use; repeated checks of the same intent do not consume another. Accepted, cancelled and unknown operations cannot be replayed. Atomic-write failure grants no new permission. Unsupported or corrupt journals preserve their bytes, and older programs cannot roll back over an unsupported store.

## Current actions and scope

Read, draft, send, edit, execute and share are separate permission types. A draft grant cannot authorize a send. The current backend integrates send permission with its existing queue and responsibility pipeline. Read/draft permission evaluation is available to adapters; edit, execute, share, external accounts and unverified remote executors require their owning adapter or human handoff. A source-message grant authorizes that literal message to its chat; it does not approve the destination assistant's tools, commands, file changes, payments or account permissions. Existing Codex approval controls remain separate human checkpoints.

The supported `source_owner` account namespace identifies the verified local source execution owner. It is not a verified OAuth login or permission to use another connected account. External account adapters must establish their own account, audience, action and checkpoint evidence; app access alone supplies no such grant.

A current explicit send obtains one grant with a conservative 24-hour queue lifetime. A responsibility obtains one child pass per literal human instruction, with a lifetime ending when that responsibility finishes or is cancelled. A schedule adds its separately persisted human repetition grant, end date and total run limit. Human rescheduling can update future timing and limits without extending an existing queued message's original expiry. A revoked grant cannot inherit renewed timing. Changed instructions, ownership, destination or audience require a new authoritative scope.

## Inspect and control

```text
/authorizations
/authorization inspect GRANT_ID
/authorization mode GRANT_ID act
/authorization mode GRANT_ID ask
/authorization mode GRANT_ID handoff
/authorization approve OPERATION_ID
/authorization revoke GRANT_ID
/authorization revoke-account source_owner OWNER_ID
/authorization restore-account source_owner OWNER_ID
```

The list shows the latest twelve grants, their action, destination, account namespace, lifetime and reserved-use count, plus pending operation IDs. Inspect shows exact scope, attachments and a bounded literal instruction preview; a longer instruction requires reviewing the full draft in its source queue. Controls are literal human commands. Ordinary questions, quoted commands and source text never apply them. `act` permits only the exact established action. `ask` waits for an explicit human approval of the existing operation. `handoff` preserves the responsibility for its owning human or executor. A generic approval cannot override an adapter-owned human checkpoint.

Approvals survive restart but must still match the same action, payload, account, audience and current available source. Expired, revoked or changed scope refuses approval. Revocation prevents unsent delivery and leaves unrelated queue identities intact. An already accepted writer retains its receipt; stopping it is the separate stop-propagation contract in #26.

Account revocation invalidates every existing grant in that namespace. Restoration requires a fresh available local owner and a new human instruction. It restores access for future grants and retains old grants' revocation. It does not revive queued actions, scheduled grants or approvals.

There are at most 256 grants, 2,048 operations, 256 account records and 64 control changes per record, within a 32 MiB journal. Exhaustion refuses additional admission rather than deleting unresolved work. Grants are private local data and are not included in diagnostic exports.

## Evidence

Policy fixtures exercise human/participant boundaries, malicious source instructions, action separation, changed accounts/audiences/devices, revocation, expiry, unknown receipts and interrupted approvals. Integrated fixtures use the actual Assistant, Responsibilities, Schedules, Messages and Controller, including two scheduled passes, rescheduling, image-only delivery and revocation during preparation.

`node scripts/authorization-contract-audit.cjs --require-clean` persists a human grant, holds its queued intent for approval, rejects a source-authored approval, restarts the authorization journal and accepts the exact human-approved operation. An owned disposable Node worker writes a result file that the audit independently checks before its synthetic human verification. The report records source revision and clean state in `artifacts/authorization-audit/verification.json`; all three desktop CI jobs run it. It uses no account or model, changes no installed data, and provides no physical-input or external-account approval evidence.
