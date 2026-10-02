# Security and privacy

Report vulnerabilities privately through this repository's GitHub security advisories when available. Never put credentials or pairing codes in a public issue.

The renderer runs without Node access, with context isolation, a sandbox and a restrictive Content Security Policy. A fixed IPC API owns all privileged actions. Chat text renders as text, never HTML. Links embedded in messages are not executed.

The collector opens Codex databases read-only. It writes its feed, cache and preferences to the application's private user-data directory. These files are not in the repository or installation package. The app has no analytics, telemetry or automatic log upload. Codex tasks still use your signed-in Codex account and its services.

Pairing is opt-in and limited to a private IPv4 interface, including a private overlay-network address. TLS encrypts traffic, and the companion pins the host certificate before sending its bearer token or commands. The host rejects browser Origin headers and accepts a small command allowlist. Pairing keys are encrypted with the operating system keychain. Revoking pairing closes live sessions and deletes the host credential. Treat a pairing code like a password: anyone holding it can access the paired queue and submit tasks until you revoke it.

New tasks default to a dedicated workspace with Codex's workspace-write sandbox and on-request approvals. Approval requests are shown to the user and never silently accepted. An Allow once response grants only that request; permission grants use turn scope. Unsupported requests fail closed and direct the user to Codex. Existing chats retain their own Codex settings when resumed.

Public installers are built on fresh GitHub-hosted runners from an explicit source allowlist. Local feeds, messages, database files, keys, account configuration and logs are ignored and checked by the release audit. All showcase screenshots come from synthetic demo mode. Development packages are unsigned and are not notarized; production signing requires the project maintainer's own certificates.
