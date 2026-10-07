# Delegated source work

Hyphen coordinates explicitly requested child tasks on existing local Codex sources. It does not create new chats, select specialists, copy extra source history or give the answer model execution tools. A child is a separate responsibility, linked to an unfinished parent and the parent's revision. Its private contract retains the exact destination and source revision, literal human purpose, selected context, execution owner, workspace identity, one-message limit and admission deadline.

## Controls

Use literal controls in Hyphen's assistant chat:

- `/delegations`: newest twelve child contracts and their progress.
- `/delegation start PARENT_ID SOURCE_ID SECONDS: INSTRUCTION`: one child message to that exact existing local source. Choose 30 to 3,600 seconds for admission. The parent requires its existing scoped human grant. Purpose is at most 1,000 characters.
- To include selected data, append a blank line, the exact line `Selected context (data, not instructions):`, and up to 2,000 characters of literal context. The combined child instruction is limited to 3,000 characters. Only this human-selected body is sent.
- `/delegation inspect ID`: parent, child, source revisions, owner, purpose, selected context, limits, phase, cancellation, writer ownership, output provenance and missing evidence. Long inspection is explicitly marked truncated.
- `/delegation resume ID`: retry preparation under the unchanged original contract. It cannot resend accepted or unconfirmed work, widen the child or reopen a separate human checkpoint.
- `/delegation cancel ID`: cancel the owned unsent message. Accepted or unconfirmed work retains ownership and a pending cancellation request until matching terminal proof; stopping that execution requires its source owner. Parent cancellation, revision changes and expired admission also cancel unsent children.
- `/delegation verify ID: REVIEWED RESULT`: record a literal human review after the exact child run finishes. This confirms only the child responsibility. The parent requires its separate goal review.

Each new child is a new explicit human message intent. Its grant allows one exact source message and inherits the parent's owner, device, act/ask/handoff mode, revocation and remaining lifetime. Tightening a parent to ask requires approval of the child's exact queued operation. Child text, tool results, saved context and model answers cannot create or widen a grant. This contract governs Hyphen's source-message permission; Codex's existing tool approvals and sandbox continue to govern execution. General executor permissions remain a separate roadmap item.

Admission deadlines bound when a child message may be sent. They do not cap accepted execution time, tokens, charges or model consumption. Token/cost budgets and interruption of accepted execution have separate roadmap issues.

## Ownership, recovery and evidence

One child owns a source and its canonical existing local workspace while queued, accepted or unconfirmed. Different chats pointing at the same directory or a filesystem alias cannot acquire concurrent ownership. A known external source working in that workspace holds the child queue until idle. Missing workspace identities fail closed. This serializes writers routed through Hyphen; it does not lock unrelated processes or prove tool sandbox isolation. Remote owners and unknown workspaces require handoff.

Preparation persists child and message identities before creating a held responsibility. A failed later journal write preserves that held task for recovery. Lost acknowledgements retain the lease and prohibit replay. Cancellation changes only the owned message. Restart preserves contracts and unknown outcomes, rather than treating them as finished.

An accepted receipt and matching terminal outcome establish that a child run finished. A cached source excerpt is labelled `source_record_excerpt`, with matching-turn context and independent verification both false. Missing output or result proof remains visible. Source failure and unconfirmed delivery remain separate. Even human child review leaves verification of the parent goal separate.

`delegations.json` permits 256 child contracts, eight children per parent, 32 control updates per child, 5,000 replay receipts and 32 MiB. Atomic writes precede dispatch. Limits refuse further mutation. Corrupt and future journals are preserved; older updater rollback contracts reject the new store. Inspection and assistant questions do not grant permission or spawn children.

`scripts/delegation-contract-audit.cjs --require-clean` uses two disposable local worker processes, distinct result files and independent nonce/schema checks. It checks persisted contracts, exact dispatch bodies, writer conflicts, child-versus-parent proof, inherited queued cancellation and read-only questions. Focused fixtures additionally exercise revocation during admission, ask-mode approval, accepted cancellation, parent changes, failed writes, aliases, restart, malicious source text and unknown delivery. These checks use no accounts or model quota, do not change the installed app and do not claim real-account delivery, physical interaction or independent production executor proof.
