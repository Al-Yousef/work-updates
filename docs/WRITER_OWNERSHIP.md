# Reply ownership and verification

Hyphen observes local chats read-only. A finished pass may still have a live desktop writer; completion and writer availability are different facts.

Current source first discovers the desktop owner through the versioned same-user coordination channel in `src/codex-desktop.cjs` and routes supported start/steer input to that owner. It validates the handling client and receipt. If no desktop owner is available, the controller can use its eligible app-server session; a conflicting writer is preserved. Unknown mutation delivery does not trigger fallback or replay. This desktop channel is an internal compatibility integration, separate from the documented app-server API.

Do not stop the desktop, steal ownership, fork a source, or silently resend to hide a writer error. Queue storage, Codex acceptance and pass completion are distinct. See [delivery states](delivery-confirmation.md). Issue #4 adds integrated ownership/restart/receipt verification.

## Historical evidence

The 0.4.4 installed app was checked with a disposable chat on October 3. Nine real checks covered same-chat follow-up, duplicate prevention, conflicting writer rejection, resume after the original owner closed and persisted replies. Those checks predate desktop-owner routing and do not establish current native physical input or every ownership route.

`scripts/writer-live-audit.cjs --confirm` is an explicit opt-in account check. Reusable native delivery audits additionally require an explicitly supplied authorized disposable chat; personal one-off multi-chat targets are excluded from this repository. Synthetic transport tests and real signed-in model/delivery checks are reported separately.

Reference: [official app-server thread lifecycle](https://learn.chatgpt.com/docs/app-server#threads). The observed ownership conflict is local test/log evidence, not a claim that the private desktop channel is a public API.
