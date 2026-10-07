# Retained data and explicit privacy controls

Hyphen uses local app data on each desktop. Its paired phone has separate protected files and Keychain credentials. Original Codex conversations and remote provider state stay with that provider. No cloud deletion, account export, credential upload, automatic sharing or reversal of external actions is implied by these controls.

`/privacy inventory` describes every supported private store and the additional cache, attachment, diagnostics, exported-file, pairing, phone and provider classes. `src/privacy-inventory.cjs` is the versioned source inventory. The underlying component's bounds and configured expiry still apply; a size bound is not a promise of age-based deletion. Replay guards, revoked grants and accepted-action checkpoints remain so restart cannot repeat an action.

| Class | Retention and execution | Access, export and removal |
| --- | --- | --- |
| Assistant conversation and alerts | Local desktop; 500 conversation exchanges and 40 alerts | Exact local conversation preview removes selected exchanges and old memory inspections; controls, replay guards and pinned notes remain |
| Pinned notes | Local desktop; 32 explicit notes, up to 1000 characters each | Exact note preview; conversation and source extracts remain |
| Source catalogue, feed and cached conversations | Local collector; bounded original reads; old disconnected cache records remain | Disconnect excludes the source from future SQL results and rollout reads. Exact source-cache preview removes that source from cache, feed and pending detail IDs after verified writer shutdown |
| AI presentation summaries | Local `summary-cache.json`, up to 2000 summaries; attempted keys, local rate limits and resource holds persist | Opt-in ephemeral model sees bounded redacted excerpts. Disable stops future inference; disconnect cancels the local summary connection. Prior presentation text and attempted-key receipts remain separate from source-cache removal. Explicit retry is a new reviewed inference attempt; no blanket cache reset reenables old attempts |
| Research extracts | Local desktop; 64 retained statements and 32 scans per scope; finite read grants | Exact disconnected-source `source-extracts` preview removes original retained statement bodies. Active reads and retained reflection statements hold removal. Grants, cursor/seen and scan/replay evidence remain; other derivatives require separate controls |
| Reflection context, findings and suggestions | Local desktop; configured 1..365-day retention for old checkpoints and finite review limits | `source-reflections` previews current-owner checkpoints, carried leads and decisions for one disconnected source. Review scopes, finite counters and replay receipts remain; source extracts, other owners, conversation, pinned notes and commitments are separate |
| Task status, drafts, human instructions, action items, schedules, access grants, workers and stop/resume | Local desktop; individual component bounds, finite grants and persisted action/replay checkpoints | Private redacted exports and original cancel/revoke/stop controls. Cancellation and disconnect do not erase instructions or already accepted action receipts |
| Outcome checks and resource/executor records when supported | Local desktop; finite freshness/budget windows and preserved uncertain/revoked checkpoints | Original component controls; no blanket deletion that silently reenables an action |
| Activity | Local desktop; default 30 days and 2048 content-free events; explicit retention configuration | Existing paginated inspection and opt-in redacted export. Missing events are not proof that no action occurred |
| Diagnostics | Local desktop; each logger capped at 512 KiB with up to two backups; event fields allowlisted and sensitive text omitted | Existing previewed redacted diagnostic export. `diagnostic-backups` removes exact `app.log.1`/`.2` after hash preview; current/future diagnostics and other loggers remain |
| Attachments | Local desktop; content-addressed images, at most 20 MiB each; no automatic expiry | `orphan-attachments` removes only unused files. Every supported private journal, live assistant/message state and this session's imported/read images are checked for references. Referenced images and external copies remain |
| Voice provider key | OS-encrypted local file; until explicitly removed | `voice-configuration` preview exposes file metadata only. Current voice must end before removal; the secret cannot be exported. Voice session/usage and remote account data remain |
| Private document copies | Local `document-library/`; explicitly imported text copies | `document-copies` previews exact names/titles and retained file bytes. Active schedules/writes or unconfirmed writes hold removal. Original imports, retained draft/replacement text, identities and receipts remain |
| Saved browser logins | OS-encrypted origin-bound cookies in local `browser-vault/` | `browser-logins` previews current-owner file metadata and exact origins; cookie values are omitted. Live private browsers hold removal. Other owners and provider-side sessions remain |
| Export copies | Private `exports/` on this desktop; no automatic expiry or upload | Owner reviews free text before sharing. Deleting original records does not erase previous export copies |
| Pairing credentials | OS-encrypted desktop files; until pairing forgotten/revoked | Existing pairing controls. Credential files cannot be exported through privacy text controls; forgetting a peer does not erase that peer's copies |
| Phone draft journal and Keychain | Protected phone storage; 128 drafts, 512 receipts; credentials until forgotten | Phone Devices → Saved phone drafts previews one computer's draft count, text bytes, uncertain sends and retained receipts. Ten-minute confirmation removes only those drafts; changed or uncertain sends hold removal. Receipts, other computers and Keychain remain. Forget pairing separately; desktop deletion does not erase phone storage |
| Original Codex chats, provider history and remote artifacts | Original provider; its retention rules | Original provider controls and separately authorized access; local removal does not delete external chats or reverse sends, edits, purchases or other actions |

## Literal controls

These controls run without model inference. Only the exact accepted human command authorizes a removal; copied source text, generated suggestions and foreign actors do not.

```
/privacy inventory
/privacy inspect
/privacy disconnect SOURCE_UUID
/privacy preview notes
/privacy preview conversation
/privacy preview source-cache SOURCE_UUID
/privacy preview source-extracts SOURCE_UUID
/privacy preview source-reflections SOURCE_UUID
/privacy preview orphan-attachments
/privacy preview diagnostic-backups
/privacy preview voice-configuration
/privacy preview document-copies
/privacy preview browser-logins
/privacy delete PREVIEW_UUID
/privacy export notes
/privacy export conversation
/privacy export source-cache SOURCE_UUID
/privacy export source-extracts SOURCE_UUID
/privacy export source-reflections SOURCE_UUID
/privacy export SUPPORTED_PRIVATE_STORE.json
```

A source-cache operation requires the exact source to be owned by this computer and already disconnected. A grouped card containing a disconnected source is withheld as a whole from published connected snapshots. Other owners and original chats are untouched. Reconnection requires a future explicit reviewed workflow; the app never silently removes a disconnect after restart.

Preview records the selected class/source, content hash, byte count, dependencies and a 30-minute expiry. Confirmation recomputes the selection and holds if it changed or an answer/read still depends on it. Source removal stops the owned collector and awaits its actual exit before editing its cache; no stopped/unknown writer is assumed safe. Readback must show the exact selected records gone. Multiple files are separately atomic; a partial failure is reported as unconfirmed and never retried automatically. The original deletion identity stays inspectable after restart. Fresh incompatible, externally replaced or failed journals hold further removals and preserve original bytes.

The new retained-data operations use privacy journal version 3. Existing version 1/2 disconnects, previews and replay receipts migrate in memory without writing on inspection; the next explicit control saves version 3. Transactional rollback refuses a prior program that cannot read the saved version. Source-reflections removal keeps review configuration, identities, finite review counts and replay hashes. Old checkpoint identities cannot recreate removed text; source-extracts removal remains a separate preview after retained reflection dependencies are cleared.

Export copies omit recognized credential fields and text patterns, reject encrypted pairing/external-provider classes, and refuse a redirected exports directory. They remain private and contain personal free text; pattern redaction cannot guarantee that arbitrary prose contains no sensitive information. Export is not sharing authorization.

## Verification and remaining acceptance

Synthetic production-path tests cover literal Assistant controls, distinct notes/conversation, stale previews, expired confirmations, foreign actors, busy dependencies, concurrent deletion, replay/restart, preserved future formats, writer-shutdown failure, source boundaries, private export and redirected-directory refusal. The collector tests use only an owned temporary SQLite database and rollout files. Observer checks confirm configuration preservation and actual owned Python-child exit.

Retained-data production-path tests remove actual owned temporary files and exact Research statement records; restart retains disconnects and replay receipts. They cover active reads/reflection derivatives/voice, new live image references, preserved draft/history references, redirected attachment folders, changed backup files, ongoing redacted diagnostics, secret export refusal and foreign actors. Newly imported/read images stay protected for the whole app session because a renderer can still hold an unsaved reference. A fresh session may preview truly unused files.

No existing account/chat, physical phone, installed Hyphen data or model is used. Phone deletion previews are local and expire across app restart; forgetting a computer leaves its drafts available for a separate preview. Saved delivery hashes and receipts remain, so removal never claims an accepted send was reversed. Three Swift tests exercise scoped draft removal, restart, preserved receipts, changed/expired/uncertain previews, redirected files and independently replaced journals. Actual phone and broader cross-channel inspection remain acceptance work. Removing a document copy does not erase retained edit drafts or original import files; deleting saved login keys does not log out provider-side sessions or another owner. The pending reader account audit stays separate and is not retried by this feature.
