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

Sessions use an in-memory partition with Node disabled, context isolation, normal sandbox/security, denied web permissions, denied popups and denied downloads. Automated navigation/redirects stay within explicit origins; there is no site-block fallback. The first implementation provides bounded page text and navigation. Arbitrary clicks, uploads, credential entry, browser tasks in model tool calls, remote takeover and consequential site actions require their own reviewed adapter and scoped authorization.

Human login state initially exists only in the ephemeral session. Save-login explicitly stores that destination's bounded cookie state using OS encryption in `browser-vault/UUID.enc`. No plaintext fallback, default browser profile import or automatic save is supported. Reuse-login separately confirms the current human session, origin and vault identity. Cookie application is not proof that the website authenticated. Password capture/fill is unsupported. Active cookie use and saved credentials remain distinct. Clearing or forgetting a saved login, privacy inspection and physical cross-device acceptance need a follow-up; #28 stays open.

Official implementation contracts: [Electron session partitions](https://www.electronjs.org/docs/latest/api/session) and [webContents navigation](https://www.electronjs.org/docs/latest/api/web-contents). Unit transport fixtures cover ownership races, changed executor/site, delayed reads, explicit encrypted save/reuse and restart/future formats. The isolated CI runtime exercises actual Electron page isolation, temporary session, original-window handoff and stale-lease denial against a local synthetic HTTP server. It uses no account, model, existing profile or installed data. This is simulated local evidence, not physical input or actual signed-in site acceptance.
