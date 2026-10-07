# Exact local browser sessions and ownership

The implemented provider is a new Hyphen-owned private Electron browser on the exact bound local executor. Existing Chrome/Edge profiles and cloud browsers are unsupported. A denied, unavailable or changed account/workspace/version never creates another browser or moves the task. Current executor handshake and grant checks precede every automated operation. Page content is untrusted data and cannot establish grants, change control or send a message.

```
/browser inspect
/browser open {"taskId":"EXACT_TASK_ID","grantId":"EXECUTOR_GRANT_UUID","url":"https://example.test","origins":["https://example.test"]}
/browser return SESSION_UUID
/browser read SESSION_UUID
/browser navigate SESSION_UUID https://example.test/other
/browser takeover SESSION_UUID
/browser save-login SESSION_UUID
/browser reuse-login SESSION_UUID VAULT_UUID
/browser close SESSION_UUID
```

Open starts with human control. Return explicitly grants one automation epoch and hides the owned window so human input cannot overlap automated navigation. Takeover invalidates that epoch before stopping navigation, awaits the actual in-flight operation, and shows/focuses the same window only after settlement. An unknown stop remains held. Closing/restarting invalidates the original lease; no replacement window, background login or worker is restored. The journal records metadata and exact identities, never page text, URL queries or credential values.

Sessions use an in-memory partition with Node disabled, context isolation, normal sandbox/security, denied web permissions, denied popups and denied downloads. Automated navigation/redirects stay within explicit origins; there is no site-block fallback. The implementation provides bounded page text and navigation. Arbitrary clicks, uploads, credential entry, remote takeover and consequential site actions require their own reviewed adapter and scoped authorization.

## Owned worker tools

New owned local tasks on the verified Codex app-server `0.160.1` register three experimental dynamic tools at `thread/start`: `hyphen_browser_sessions`, `hyphen_browser_read` and `hyphen_browser_navigate`. The current initialized transport already opts into experimental APIs. Other server versions advertise no browser tools. A model cannot create a session, save/reuse a login, return control or widen origins through these tools. Session inspection exposes only metadata for the exact task and executor grant. The human must explicitly open a session and return control before any page operation.

The executor binding records the accepted tool registration as optional version-one metadata; older clients cannot route these calls and continue rejecting them. Existing threads receive no retrofit or replacement. Resumed threads retain a previously recorded registration, but a fresh verified executor handshake and an exact accepted current turn are still required. Browser restart always leaves the old session held with no lease or replacement window. Capability support is registration at a pinned server version, not a promise of account, website or remote-device support.

Each tool call is tied to the original helper connection, owned task, grant, current accepted turn, call ID and browser ownership epoch. Paused/disconnected sources, changed account/workspace/version, revoked or replaced journals, another task's session, stale turns and human takeover refuse the call. Delayed results cannot be written to a replacement helper. Duplicate call IDs reuse the same receipt only while its original scope and epoch remain current; changed arguments never repeat navigation. A deterministic budget operation identity also prevents a lost tool receipt from replaying an admitted read/navigation. Confirmed operations settle with zero model tokens; interrupted or discarded operations preserve uncertain capacity. Page text is bounded untrusted tool output and cannot authorize an action; it is absent from Hyphen's browser and budget journals. It may appear in the owned worker's original Codex conversation as tool output.

The [official app-server dynamic tool contract](https://learn.chatgpt.com/docs/app-server) and [pinned 0.160.1 thread-start schema source](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) define registration and `item/tool/call`. The locally generated experimental schema also verifies the exact request/response fields. Production Codex/Controller transport fixtures use a real owned loopback HTTP page and cover accepted-turn routing, admission, duplicate/replaced calls, takeover, connection replacement, restart and unsupported runtimes without model calls or existing accounts.

Human login state initially exists only in the ephemeral session. Save-login explicitly stores that destination's bounded cookie state using OS encryption in `browser-vault/UUID.enc`. No plaintext fallback, default browser profile import or automatic save is supported. Reuse-login separately confirms the current human session, origin and vault identity. Cookie application is not proof that the website authenticated. Password capture/fill is unsupported. Active cookie use and saved credentials remain distinct. Clearing or forgetting a saved login, privacy inspection and physical cross-device acceptance need a follow-up; #28 stays open.

Official implementation contracts: [Electron session partitions](https://www.electronjs.org/docs/latest/api/session) and [webContents navigation](https://www.electronjs.org/docs/latest/api/web-contents). Unit transport fixtures cover ownership races, changed executor/site, delayed reads, explicit encrypted save/reuse and restart/future formats. The isolated CI runtime exercises actual Electron page isolation, temporary session, original-window handoff and stale-lease denial against a local synthetic HTTP server. It uses no account, model, existing profile or installed data. This is simulated local evidence, not physical input or actual signed-in site acceptance.
