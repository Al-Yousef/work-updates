# Assistant memory quality candidate

This branch addresses issue #10 on the local retained-data model. It adds no embedding service, background inference, connector access or source writer.

The provider receives selected human statements separately from generated answers and queue summaries. Retrieved exchanges retain their roles, order and truncation metadata. Later explicit human corrections take precedence in the prompt. Retrieval weights the user's own words more heavily than earlier generated guesses. The selected human evidence remains contextual evidence, not automatically pinned facts.

Source context records whether it is available, unavailable, cached or offline, whether the card is historical, which excerpts/dialogue were included, and whether clipping/budget limits removed content. Collection timestamps more than five seconds in the future cannot claim freshness. A generated related link can help explain an answer, but cannot by itself confirm the destination for a later “that chat” instruction. Duplicate names, multiple named destinations and rejected guesses remain ambiguous. Exact human-opened focus and explicitly named current destinations retain their existing routing checks.

## Inspection, correction and deletion

- `/memory` inspects pinned notes. `/correct N replacement` changes exactly one pinned note. `/forget N` and `/forget all` remove pinned notes only.
- `/memory history` lists the latest 20 retained conversational exchanges. The numbered selection is saved by message identity, so arriving messages do not silently change what the number selects. `/forget history N` removes that selected exchange and saved memory-inspection reports, preventing copied excerpts from re-entering recall. `/forget history all` removes earlier retained conversation and leaves its confirmation visible.
- `/memory sources` describes read-only connected-source coverage. Removing a Hyphen exchange or note does not delete original source records or the reader's cache. Source records remain managed in their owning chat.

Conversation deletion retains pinned notes, automatic update alerts, copied image files and message replay protection. It is not full account/data erasure; that remains issue #31. Message receipt hashes are kept so deletion cannot authorize a duplicate submission. Corrupt storage and invalid inspection metadata are preserved and block writes. Assistant history/inspection selection remain in the existing private local file and are not added to peer state or content diagnostics.

## Budgets and verification

Retention stays at 500 conversation entries, 40 alerts and 32 pinned notes of at most 1,000 characters. The recent exchange projection is limited to 12,000 characters, recalled exchanges to 8,000, selected human evidence to 4,000 and selected card/source projections to 18,000. Each source excerpt projection stays within 4,200 characters. Count/coverage metadata reports the selected characters; these are not token estimates or actual provider billing.

`node scripts/evaluate-assistant-retrieval.cjs` scores 13 synthetic conformance cases: older decisions, corrected facts, generated guesses, alert flooding, ambiguous/rejected destinations, topic changes, offline and future-dated context, truncation and long-context budgets. This evaluates retrieval/provenance selection, not model answer quality. Existing continuity tests cover restart, source chats never opened, read-only hydration and dispatch receipts. New tests cover correction persistence, selected deletion, inspection-copy cleanup, scoped clearing and corrupt metadata.

Before closing #10, run a small explicitly authorized private model audit using synthetic inputs and record the model, duration, coverage and usage availability. Passing deterministic retrieval does not establish that a model follows the provenance/correction instructions. The opt-in live audit is a separate gate; no real private model call is claimed by this branch's deterministic results.
