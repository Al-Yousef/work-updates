# Local task executor bindings

This first #27 subchange binds Hyphen-created local Codex tasks and explicitly started existing local tasks. Each grant records the local device, canonical workspace, task/chat identity, app-server version, local profile fingerprint, account fingerprint, human owner and three supported task capabilities. Task identity is separate from the assistant conversation. The local journal is versioned, bounded, atomic and checked before each use.

The runtime is established through supported `initialize`, `account/read`, `thread/read`, `thread/start` and `thread/resume` responses. The installed 0.160.1 generated schema was used to verify these fields. The account response is held in memory; email and Codex home are stored only as private keyed fingerprints. Diagnostics record RPC metadata rather than account response bodies. `account/read` uses `refreshToken: false`; this feature does not log in, provision a cloud computer or purchase API access.

A task's first explicit start establishes its grant before thread/inference creation. An existing chat is read to confirm its exact ID and workspace. Resume and subsequent turn admission recheck the original account, workspace and version. Mismatch, unavailable storage, revoked access or an unsupported account response holds work on the original task. Nothing silently moves to another device, workspace, account or cloud executor. An app-server upgrade therefore holds affected tasks until a separate reviewed reauthorization flow is implemented.

`/executor inspect` shows the newest eight task grants with their supported capability list and last verification time. `/executor revoke GRANT_UUID` denies future use. Inspection does not turn a stale handshake into an online claim. Disconnecting transport is different from revoking access. Reconnecting the same supported owner can continue an active grant; a revoked grant remains revoked. Stopping an accepted turn is a separate exact-turn control.

## Coverage and remaining acceptance

| Execution route | Binding coverage | Remaining proof |
| --- | --- | --- |
| Hyphen local Codex task creation/continuation | Versioned local grant with workspace/profile/account/task checks | Separately authorized actual account/device check |
| Already observed Codex desktop chat | Existing exact source-owner delivery contract; no new full executor claim | Supported desktop runtime/account capability discovery |
| Paired desktop | Existing authenticated device protocol; no silent local fallback | Independent executor handshake and unavailable/revoked-device conformance |
| Assistant inference and reader | Existing separate provider and source-read contracts | Unified provider/executor accounting |
| API-key or Bedrock task executor | Held: supported account response supplies no stable identity here | Explicit account identity adapter |
| Cloud provisioning | Unsupported, no provisioning or paid-service calls | Separate opt-in provider, cost and access implementation |

The synthetic protocol tests exercise the actual Codex client and durable registry. They prove admission and checkpoint behavior; they do not establish physical-device or real-provider conformance. #27 stays open for those remaining routes and gates.
