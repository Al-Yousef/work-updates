# Dot inbox candidate

A separate local review surface for a quiet dot that opens a conversation inbox.
It reuses Work Updates' notification appearance, Queue, Devices routing and
notification policy core. It does not change the installed desktop app.

## Run

```sh
npm run demo:inbox
```

The command uses the stable loopback origin `http://127.0.0.1:51845` and starts
with synthetic conversations only. Keep that origin and browser profile for
draft recovery. Action outcomes and fixture state survive candidate restart in
ignored `artifacts/dot-inbox/recovery/recovery.json`; `--recovery-root` can select
an isolated candidate data directory. Never point it at installed app data.
Optional local app data can be inspected without enabling any real actions:

```sh
npm run demo:inbox -- --live-root "../Work Updates/data/desktop" --port 51845
```

Use **Local preview controls** to choose fixtures, local Codex read-only data or
both. The same controls expose quiet, active, offline, reconnect, changed/removed
task, long text, loading, empty, connection error, uncertain reply acceptance and
older-duplicate scenarios. **Preview 10 minutes unanswered** advances only the
synthetic escalation clock. Ctrl+C stops this separate preview.

To review an isolated collector reading local Codex directly, without writing
feeds, caches, or requests to either Codex or installed app data:

```sh
node scripts/dot-inbox-preview.cjs --live-root "../Work Updates/data/desktop" --collect-local "$CODEX_HOME" --privacy-review --port 51853 --recovery-root artifacts/dot-inbox/freshness-review/recovery
```

Pass the actual Codex home path in place of `$CODEX_HOME` when it is not set.
This is a local review server, not an installed repair. Its source-scoped owner,
collector session and sequence reject late/foreign/duplicate pipe data. A
successful read renews its heartbeat even if no chat changed; a stopped or
silent helper reconnects automatically. Stop/reconnect controls affect only
this separate collector. Private titles, bodies, paths and waiting-person names
are withheld before browser rendering in privacy review mode; status and
heartbeat are real. No model, provider, Codex turn or outgoing action is used.
Evidence and the remaining installed-app gate are in
`artifacts/dot-inbox/freshness-review/REVIEW.md`.

## Separate Windows desktop candidate

```sh
npm run demo:inbox:desktop -- --seed-from artifacts/dot-inbox/preserved-browser
npm run build:inbox:desktop
```

The desktop host is **Work Updates Review**, with the separate app identity
`io.workupdates.desktop.review`. It starts as a quiet 76px transparent window;
clicking the 52px dot opens the existing inbox. The header and the small grip
above the dot are drag regions. X collapses; Quit in its own tray menu exits the
review app. Background recovery, polling and a second launch do not request focus.
An explicit dot open may focus the app for replying.

Source runs store their profile, drafts, synthetic receipts and placement under
ignored `artifacts/dot-inbox/desktop-review/personal`. The portable build uses
`review-data/personal` beside **its own** executable. `--review-dir` is restricted
to a subdirectory of that host's private review root, including junction checks.
There is no weather hook, startup installation, production controller or live
Codex action connection in this candidate.

The renderer uses the stable `work-updates-review://app` origin, an isolated
preload bridge and synchronous validated recovery writes flushed to disk before
dispatch. A preserved seed is copied once and cannot overwrite existing review
records. Neither browser records nor installed app data are migrated or removed.
All peers/actions remain synthetic. Source data and recovery references are
separate; saved drafts contain only user text and minimal routing/action metadata.

```sh
npm run test:inbox:desktop
npm run test:inbox:desktop -- --packaged
```

These audits keep the actual Electron window hidden and suppress focus and tray
creation. They inspect real IPC, native bounds, profile separation, reload,
isolated process restart and late acceptance. Model-driven captures are renderer
evidence. They are **not** physical click, keyboard, native drag or foreground
proof. Those tests are deferred while shared Windows input belongs to Studio
sessions. The Windows candidate does not claim Mac/iPhone runtime support.

## Connected protocol review option

```sh
node scripts/dot-inbox-preview.cjs --protocol-fixtures
node scripts/build-dot-review.cjs --protocol-fixtures
```

This separate mode uses the existing pairing, pinned HTTPS, SSE revisions and
Devices command protocol over two actual 127.0.0.1 peers. Both are labelled
**Local protocol fixture A/B**, with fresh synthetic identities and shared raw
source IDs. Commands execute only in a synthetic owner; no production Codex
controller, external sender, account or provider is connected. Message history
and bound acceptance receipts travel through TLS snapshots/responses.

Its browser origin is `http://127.0.0.1:51847`, recovery is
`artifacts/dot-inbox/protocol-recovery`, and build output is
`artifacts/dot-inbox/desktop-protocol-build/win-unpacked`. The portable app has
the identity `io.workupdates.desktop.review.protocol`, title **Work Updates
Protocol Review**, and its own `review-data/protocol` profile. Original browser
and desktop records are preserved. Legacy recovery seeds are refused in this
mode rather than rebinding their drafts to fresh owners.

Queued tasks without a source open read-only task context with no composer or
action destination. Disconnect/reconnect, older/late snapshots, forgotten or
replaced pairings, accepted-but-lost responses and cancellation are exercised
through the actual local transport. Recovery never redelivers automatically.

The new Windows portable executable was built, but **Device Guard blocked its
hidden audit before startup**. Its six planned packaged checks remain unverified;
the earlier original-candidate audit does not validate this variant. No security
policy was changed or bypassed. Physical Windows input remains deferred while
Studio owns the shared desktop. Neither loopback transport nor browser rendering
proves Mac/iPhone hardware or away-from-home operation. The local acceptance
ledger is `artifacts/dot-inbox/PROTOCOL-REVIEW.md`.

The current-source mobile follow-up exercised normal rendered controls over
actual TLS fixtures at 390×844, 390×500 and 320×568, recording 34 states with no
observed horizontal overflow or offscreen Back/close/reply/send/dot controls.
It corrected grouped-source speaker labels, cached offline status labels and
misleading uncertain-receipt availability text. Exact drafts survived queued
task reload, disconnect/reconnect, context changes and pairing replacement.
Captures and the scoped acceptance ledger are in
`artifacts/dot-inbox/PROTOCOL-MOBILE-REVIEW.md`. This is browser viewport/key-event
evidence, not physical mobile input or native installation. The blocked Windows
bundle was preserved and does not contain these later source UI corrections.

## Inbox interactions

- Assistant is a pinned inbox conversation and a named view. Ask what needs you,
  what is urgent, what you are waiting on, or all current updates. It builds a
  local briefing from recorded statuses with no model/provider calls. Open a
  result through its exact owner/card/task/source/context reference; Back returns
  to Assistant. Questions do not dispatch commands, create reminders or send messages.
- The latest assistant question and its unsent draft recover independently of
  source drafts. Answers and incoming conversation content are not saved in
  recovery. Repeating a question clears the visible input, Enter asks and
  Shift+Enter adds a line. Urgent attention pulses twice on entry and respects
  reduced motion. Status notices remain within the narrow viewport.
- Assistant evidence is in `artifacts/dot-inbox/assistant-review/REVIEW.md`.
  The review read 56 installed Codex queue items, but the collector feed was stale;
  it displayed the cached-data warning and withheld a fresh live briefing.
  Real DMs, external sends, phone notifications/calls and native installation
  are not connected by this follow-up.

- Click the dot to open or collapse. Waiting on you appears first, with urgent
  items first within that group. Sender/chat, current task, short update, source
  and owning computer are distinct fields.
- Click an item for its source conversation, a reply field, Reviewed and Snooze
  1h. Enter sends a synthetic reply; Shift+Enter adds a line. Back returns to the
  previous named view. Escape goes Back, then collapses.
- Drafts belong to owner + task + source. Switching source, computer or view,
  collapsing, reload, candidate restart and reconnect preserve them locally.
  Draft identity also includes the exact card and context revision. Browser
  storage keeps draft text and minimal routing metadata, never incoming source
  logs. Saved drafts for earlier/unavailable context remain accessible for
  editing but cannot act until current context is explicitly inspected.
- A changed or removed task retains the earlier context and draft but disables
  stale actions. Adopting the latest task is explicit. Different current tasks
  do not inherit the earlier draft.
- Reviewed and Snooze update the same item without completing its task, and
  cancel obsolete queued escalation previews. Queue retains reviewed/snoozed
  items. Relationships retains project → task → source links.
- Provider receipt and owner acceptance are separate. An uncertain reply keeps
  its draft and blocks resending, while review/snooze remain available. No blind
  retry or provider cancellation is simulated as successful delivery.
- Every action intent is saved before dispatch. The local fixture journal saves
  its exact binding and outcome; duplicate event IDs cannot change targets or
  dispatch again. Accepted/uncertain outcomes survive process restart. Recovery
  only reads receipts, and never reposts an action. A late acceptance clears only
  the exact sent text, preserving edits made afterward and another selected source.
- Storage failure keeps edits in memory, labels them as unsaved and pauses actions.
  Retry saves retained edits when storage works again. Reload during a write
  failure restores the last successful save, not unsaved memory. Corrupt records
  are preserved and fail closed. Clearing browser data removes local draft recovery.
- Phone sizes use the same surface. In a short conversation viewport, Back gives
  access to navigation and the footer condenses to leave room for messages.

## Integration ledger

| Capability                                                       | Current candidate                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing notification styling                                    | Reused from the desktop app's `ui/style.css`                                                                                                 |
| Tasks, sources, groups, status                                   | Real Queue schema and presentation logic                                                                                                     |
| Local Codex context                                              | Optional read-only files or isolated live collector; heartbeat/reconnect verified against 1,521 local chats; every live action disabled |
| Installed collector recovery                                    | Reviewable source fix for heartbeat expiry, automatic restart and memory-only SQLite query intermediates; installed app unchanged |
| Two-computer routing                                             | Real Devices with fake peers and duplicate raw chat IDs                                                                                      |
| Reply/review/snooze commands                                     | Real bound command path, synthetic owner execution only                                                                                      |
| Notification policy                                              | Real NotificationSession/NotificationFlow; primary source receipts use the flow, grouped secondary source replies use exact Devices commands |
| Escalation                                                       | Queued/cancelled previews only; no calls or provider client                                                                                  |
| Email and DMs                                                    | Unmistakably synthetic sender/channel fixtures                                                                                               |
| Delivery acknowledgement                                         | Synthetic provider/owner acceptance and lost-acknowledgement cases                                                                           |
| Mobile app installation                                          | Not included; responsive browser render is a review surface                                                                                  |
| Real channel ingestion, authentication and away-from-home access | Not connected                                                                                                                                |

This table describes the default fixture mode. The optional protocol mode uses
two real local TLS clients with synthetic owners, as described above. No real
Codex controller, production credentials, external messaging SDK or production
paired client is instantiated. The candidate is outside the desktop package file allowlist. Its
session data and screenshots live in ignored `artifacts/dot-inbox/`.

## Validation

Before the collector follow-up, the full Node suite passed 165 tests, including 8 assistant, 15 inbox, 13 recovery, 8 desktop isolation and 14 local protocol checks for strict routing,
separate drafts, stale context, late replies, delivery uncertainty, cancellation,
foreign origins and read-only live input integrity. Browser checks exercised the
rendered controls at 1280×720, 390×844, 390×500 and 320×568, including keyboard
reply/Back/close, offline/reconnect and long text. These are browser viewport
checks, not a physical iPhone keyboard, background delivery or native installation
test. Local evidence is in `artifacts/dot-inbox/`.

The collector follow-up validated 45 focused Node checks and 15 Python collector
checks, plus 18 redacted browser states and an actual local-source process-exit
recovery. It did not rerun the unchanged full suite or launch a native bundle.

Installation framework, delivery channel, authenticated sender/recipient,
urgent-call opt-in and quiet-hours policy remain choices for real integration.
The 10-minute call delay is a test fixture policy, not a saved user preference.

The collector follow-up resolved the source-level freshness issue identified in
the assistant review. The installed app still has the historical stale feed;
packaging, normal restart and installed-runtime verification remain a separate
gate. The blocked protocol executable and original recovery records were
preserved. No Device Guard policy change or alternate launch was attempted.
Explicit fixture scenario resets can restore a forgotten sample peer; ordinary
reconnect and process restart cannot silently restore a forgotten owner.
References, design contract and boundaries are in [CONTRACT.md](CONTRACT.md).
