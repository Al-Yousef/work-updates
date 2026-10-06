# Dot to inbox candidate

## Assistant conversation follow-up

| Field              | Decision                                                                                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen job         | Ask what needs Yousef and open the exact recorded source conversation.                                                                                                                                                                                      |
| Primary action     | Read a current local briefing, then open a source to review or draft a reply.                                                                                                                                                                               |
| Content hierarchy  | Question; current answer; sender/chat name; current task; waiting owner; source computer and provenance.                                                                                                                                                    |
| Navigation         | Assistant is a named view and a pinned inbox conversation. Back from a source returns to Assistant. Close preserves the assistant question/draft and source drafts independently.                                                                           |
| Visual language    | Reuse existing message bubbles, translucent surfaces, composer, Back, typography and 44 px controls. No new branding or simulated Apple status bar.                                                                                                         |
| States             | Loading, unavailable, empty, partial/offline, unsupported question, unsaved draft and changed source. No outgoing messages or mutations from the assistant.                                                                                                 |
| Responsive         | Same flexible conversation scroll and fixed composer at desktop, 390×844, 390×500 and 320×568.                                                                                                                                                              |
| Evidence           | Re-inspected Apple Invites Manage messages screens 120, 58 and 84 on 2026-10-03: identity and response stay together, input remains reachable, one primary action. Jarvis's bound action identity and duplicate prevention remain architectural references. |
| Forbidden defaults | Guessing status from a title; presenting samples as connected DMs; storing incoming content in recovery; generic AI claims; sending a command because it appeared in an assistant question.                                                                 |
| Acceptance         | Local question classification, strict owner/card/task/source/context binding, current answer after updates, separate recoverable drafts, no external request or new owner command, keyboard and mobile reachability.                                        |

The first assistant is a deterministic local queue briefing, not a configured
language model. Only the user's latest question and unsent assistant draft are
saved; answers and source content are generated from the current snapshot.
Unsupported requests explain the supported questions. Messaging-service
selection/authentication, real DM ingestion, remote access and phone delivery
remain integration gates, rather than fixture-backed success claims.

This is a local review candidate, separate from the installed desktop app. The
current queue, task identity, source conversations and owning computers remain
the data model. Email and DM content is unmistakably synthetic. No provider or
real chat sender is connected.

| Field                   | Decision                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Screen job              | Find what needs a reply, understand its source and respond in the same conversation.                                                                                                                                                                                                 |
| Primary user and action | Yousef opens the dot, selects a conversation and replies or reviews its update.                                                                                                                                                                                                      |
| Content hierarchy       | Waiting on you first; sender/chat name; current task and short update; source and owning computer; conversation and reply.                                                                                                                                                           |
| Navigation and controls | Quiet dot toggles a narrow inbox. Inbox, Queue and Relationships are named views. A conversation has a visible Back button, source selection, Reviewed and Snooze 1h. Close/Escape returns to the dot without losing drafts or navigation.                                           |
| Visual language         | Reuse Work Updates' type stack, dark wallpaper, translucent notification cards, device/status indicators, message bubbles and rounded composer. No dashboard tiles, avatar animation or new branding. Motion only for opening/closing and working status, respecting reduced motion. |
| Required states         | Loading, empty, read-only live data, disconnected/partial data, stale task/source, fixture send acceptance, uncertain acceptance, snoozed and reviewed.                                                                                                                              |
| Responsive behavior     | 420 px desktop panel; full available width below 480 px. One conversation replaces the list on every size. 44 px controls, no hover dependency, native textarea keyboard, Enter sends and Shift+Enter inserts a newline.                                                             |
| Evidence used           | Existing ui/style.css and ui/app.js; Apple Invites reply screens below; Jarvis API source below.                                                                                                                                                                                     |
| Forbidden defaults      | Inferring a device from the viewer; using a title as identity; pretending synthetic integrations are live; two Done/Reviewed ticks; an always pulsing dot; automatic retry after uncertain sends; dropping queue/group/source data.                                                  |
| Acceptance criteria     | Render desktop and phone sizes; verify source-bound navigation/drafts; duplicate raw IDs on two computers; stale/removed selection; offline/reconnect; Reviewed/Snooze cancels queued escalation; no production writes or external deliveries.                                       |

## Interface evidence inspected before implementation

Three screens from the public [Apple Invites Manage messages flow](https://uizze.com/apps/69ae33390004c2829fae?journey=5a7a763c4d623018ec57b3912d06820b&platform=ios)
were visually inspected on 2026-10-03. The catalogue does not establish their iOS
release date; this candidate does not claim an exact iOS 26 reproduction.

| Screen                           | Structural decision transferred                                                        | Fit and excluded material                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| iOS screen 120 / first flow step | A compact reply surface keeps identity, context and one primary reply action together. | Our source/owner context stays above the composer. No invitation branding, RSVP labels or imagery copied.                    |
| iOS screen 58 / second step      | The reply field stays in the same focused surface when the keyboard opens.             | A flexible conversation body leaves room for the composer. No simulated iOS keyboard or status bar.                          |
| iOS screen 84 / third step       | Typed text remains visible with the selected response and recipient.                   | Drafts belong to an exact owner/task/source and persist through Back, collapse and reconnect. No exact screen layout copied. |

Apple/iCloud appearance continues to come from the existing approved app. These
screens supply workflow evidence, not a claim that Apple has this dot product.

## Jarvis patterns studied

[nolanmak/Jarvis src/apiV1.ts](https://github.com/nolanmak/Jarvis/blob/main/src/apiV1.ts):
the actions API carries individual action identities, publishes status changes to
other surfaces through SSE, and uses an atomic pending-status check before
resolving an action. Transfer: a current, explicitly bound item, shared status,
and no successful second resolution. We reuse our already tested Queue, Devices
and NotificationSession instead of copying its implementation.

[FatihMakes/Mark-LV](https://github.com/FatihMakes/Mark-LV) and its
[main.py](https://github.com/FatihMakes/Mark-LV/blob/main/main.py): interface state
communicates listening/thinking/sleeping, with retained session context on
reconnect. Transfer: a quiet resting dot and meaningful attention states, with
navigation/drafts independent of transport health. The creator links
@fatihmakes, but remains an unconfirmed match for the remembered Instagram demo.
No third-party code or licensed assets were copied or executed.

## Permission and delivery boundary

- The candidate listens on 127.0.0.1 only, blocks foreign origins and unexpected
  Host headers, serves a narrow local file allowlist, and loads no remote assets.
- Optional installed-app data is read from existing state/feed files into a
  separate in-memory Queue. No writes, details requests, Codex process, IPC
  command, task starts or paired live commands are used.
- Live cards are read-only, including Reviewed and Snooze. Drafts are kept in
  local browser storage as user-authored draft text and minimal routing/context
  metadata. Incoming live source logs are never persisted. Reload and isolated
  candidate restart retain drafts; action recovery never automatically resends.
- Only synthetic cards can act. Their routes still pass through real Devices
  and NotificationSession with exact owner/task/source/revision checks. The
  configured sender is a fixture identity, not an authenticated external sender.
- Provider acceptance, owner-app acceptance and uncertain acceptance are
  displayed separately. A future provider adapter must authenticate envelopes,
  confirm account permissions and handle uncertain delivery without blind retry.
- No email/DM ingestion, push delivery, phone calls or mobile installation is
  integrated. Installation framework and delivery-channel choices remain open.

## Durable recovery acceptance

Drafts use owning computer + card/chat + task + selected source + context revision.
Current source/ownership must validate after every recovery before actions enable.
Earlier, removed and forgotten-owner drafts remain safe and editable. Action intent
is persisted before dispatch; accepted and uncertain receipts survive process
restart. A missing/interrupted receipt cannot cause an automatic or blind manual
resend. Storage failure is explicit, pauses actions and preserves the last
successful save; corrupt recovery records are not overwritten. Revalidate with
normal typing, source/owner switching, reload, isolated server restart, offline,
late acceptance, lost receipt and recovered Reviewed/Snooze/Done cancellation.

## Windows desktop review host

The review host reuses the existing Electron runtime and notification styling,
with its own app identity, preload channels, stable origin, profile, synthetic
peers and recovery directory. Draft writes are synchronous, validated and flushed
to disk. Fixed IPC methods reject foreign senders and subframes. Protocol routes
serve only the candidate assets and fixture APIs; no production controller is
created. X collapses; quitting requires its own tray command.

Startup, refresh, restart and a second launch do not request focus. Only explicit
open intent may focus. Dot/header drag regions and bounded persisted placement
are implemented; source/model/IPC checks and hidden renderer captures do not
prove physical Windows click, Enter, drag or focus behavior. Those checks are
deferred while shared desktop input belongs to other Studio sessions. The hidden
audit forbids showing/focusing the window and uses no mouse/keyboard injection.

The host follows Electron's [protocol](https://www.electronjs.org/docs/latest/api/protocol)
and [BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)
interfaces. No Mac/iPhone runtime, provider connection, external delivery,
installed-app migration or production installation is included.

## Isolated connected-protocol variant

The separate protocol review option retains this interface contract and replaces
the direct fake peers with two actual loopback HostPeer/RemotePeer endpoints.
Existing pinned TLS, host identity verification, ordered state revisions and
Devices owner routing are preserved. Each endpoint has a fresh fixture identity,
certificate and pairing record, and can execute only synthetic fixture commands.
The raw chat IDs deliberately overlap; owner/card/task/source/raw-context/viewer-
context binding and current connection generation must all validate. Incoming
message history comes from the paired state snapshot, not direct fixture access.

A queued card without source context remains read-only. It cannot inherit a
conversation destination or expose a reply/action control. Its saved reference
restores the same task/owner and returning to a conversation restores its own
draft. Unknown acceptance retains the exact draft and prevents blind resend;
forgotten/replaced sessions cannot restore old ownership. Reviewed, Snooze and
Done cancel obsolete queued escalation through normal command routing.

The variant has a separate portable identity/profile and does not migrate the
original five drafts/seven receipts. Its 14 transport cases passed within the
157-test suite. Browser controls and screenshots verify local UI fixtures; the
actual local transport is captured separately. The packaged Windows audit was
blocked by Device Guard before startup and passed no checks. No policy bypass
or native input was attempted. Real Mac/iPhone/network/background/provider
acceptance remains pending. See `artifacts/dot-inbox/PROTOCOL-REVIEW.md`.
