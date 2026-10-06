# Hyphen source ownership and protocols

| Area | Owner files | Responsibilities |
| --- | --- | --- |
| Composition root | `main.cjs`, `preload.cjs` | Service lifecycle, native/compatibility UI selection, command routing and idle-restart coordination. Changes here integrate module PRs. |
| Read-only collection | `bridge/collector.py`, `src/observer.cjs`, `src/read-only-observer.cjs` | Discover and hydrate local source context, freshness and health. Observation does not acquire a chat writer. |
| Queue and summaries | `src/queue.cjs`, `src/summaries.cjs`, `src/summary-*.cjs` | Task/update identity, reviewed/snoozed/done state, ordering and cached current-task summaries. |
| Delivery | `src/messages.cjs`, `src/controller.cjs`, `src/codex.cjs`, `src/codex-desktop.cjs`, `src/attachments.cjs` | Durable intents and receipts, exact-source validation, app-owned or desktop-owner routing, local images and uncertain-delivery barriers. |
| Assistant | `src/assistant*.cjs` | Durable local conversation, explicit notes, bounded retrieval, private inference and validated Send/Queue actions. Uses delivery services instead of claiming source writers. |
| Native Windows | `native/windows/src/`, `native/windows/taskbar-adapter/` | Win32 UI, input, rendering, worker IPC, tray/launcher and fingerprint-gated weather routing. `main.cpp` remains a shared integration file. |
| Connected devices | `src/devices.cjs`, `src/peer.cjs`, `ios/` | Private pairing, ordered owner-routed snapshots and commands. Apple candidate validation is independent of Windows tests. |
| Compatibility UI | `ui/`, `src/tray.cjs` | Earlier Electron interface and platform compatibility behavior. Native Windows parity is not inferred from these tests. |

## Native local control

The backend writes `native-control.info` in its private data directory: magic `work-updates-native-v1`, random named pipe, random authentication token, server PID. The descriptor is private and is never committed or printed in diagnostics. Keep the protocol and legacy pipe prefix stable during the branding change.

Each connection sends one UTF-8 newline-delimited JSON request containing its token. The server checks the token and bounds the request to 128 KiB. Methods include `status`, `claimCorner`, `subscribe`, `command` and `quitIfIdle`. Corner ownership lasts for the connection and is released on disconnect. Subscription snapshots carry `schema: 1`; unchanged state is not rebroadcast. Slow subscribers retain only the latest pending snapshot, and oversized frames above 2 MiB disconnect.

Commands are validated through the existing service methods. Source actions include card/task revision, exact source/device identity and, for delivery, durable message identity. Successful local queue storage, Codex acceptance, and later task completion are different states. Read-only details requests do not adopt a writer. See [delivery confirmation](delivery-confirmation.md) and [assistant contract](HYPHEN_ASSISTANT.md).

The native UI keeps separate workers for subscription/details and mutation operations. The UI thread does not perform pipe I/O. Persistent drafts are source-bound. Native tests use a synthetic backend with explicit descriptors and isolated/no-auto-attach flags.

The Explorer weather adapter is a separate profile-gated private Windows integration, not a documented weather API. It uses a fresh cookie/PID/window identity and verifies the exact module/function fingerprint. Unsupported profiles preserve original Windows behavior. See its [lifecycle contract](../native/windows/taskbar-adapter/README.md).

## Device protocol and storage

Peer protocol v3 orders state using a host-run identity and monotonic snapshot counter rather than wall-clock equality. Commands return to the source owner. Certificate-pinned private pairing and stored credentials are independent of the native local-control token.

Queue state, message intents/receipts, source drafts, assistant history, and pairing state are private local stores. Assistant retention and v1/v2 migration are described in its contract; delivery intents survive uncertain restarts without replay. Cross-store transactional recovery remains issue #5, and native/peer protocol parity remains issue #14. Avoid changing a protocol independently in multiple branches.
