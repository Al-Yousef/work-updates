# Personal messages and urgent calls

Local implementation candidate. No provider is connected, no messages or calls have been sent, and the installed desktop app has not been restarted or changed. SMS versus Telegram and native versus installed web app remain open choices. This module does not choose a mobile framework or require publishing a phone app.

## Run the local proof

Run `npm run demo:notifications` from the source checkout. The replay writes `artifacts/notifications/PREVIEW.md` and `dry-run.json`, using synthetic PC/Mac queues, the existing Queue and Devices classes, and in-memory paired-device events. It creates no socket, Codex client or provider connection. Its temporary synthetic state is removed after the replay. `npm run test:notifications` runs the deterministic checks. Tests use temporary fixture directories; in restricted environments set TEMP and TMP to a writable project artifact directory.

The generated conversation contains a batched routine update, Reviewed on its selected Mac task, Snooze 1h on its PC task, a reply routed to that source chat, a queued urgent call cancelled by Reviewed, and an uncertain synthetic call which is never redialled. “Accepted” task results in this replay are synthetic handlers, not evidence that a real Codex chat accepted a remote message.

## Notification contract

Every message reference records the executing owner, current task key, queue card, exact source chat and update revision. Chat name and current task are separate. An ordinary blocked task, a task waiting on someone else or a working text delta does not become an urgent call. The initial session snapshot is a quiet baseline. New waiting-on-you items get individual messages; eligible routine updates coalesce into one digest with the latest task revisions. A digest reply must identify the exact task and computer. There is no “last active chat” fallback.

The opt-in NotificationSession subscribes to Devices changes and optionally local Queue changes, after the existing per-computer state-order validation. Its aggregate snapshots have their own epoch and counter. Replayed or older snapshots are ignored. Reconnects do not change a task revision; forgetting and pairing again creates a different owner binding. A replaced connection cannot confirm an old command result. The source main.cjs does not start this session automatically.

Settings are required explicitly: routine batching interval, whether calls are enabled, manual versus manual-or-inferred urgency, unanswered duration, minimum interval between call attempts, a per-task cap, a rolling 24-hour cap, a bounded number of snooze reminders, and quiet hours or an explicit no-quiet-hours choice. Quiet hours name their timezone and whether they apply to calls or all deliveries. Policy changes cancel newly ineligible queued calls. The example timings in the replay are review settings, not adopted user preferences.

Calls require a current, online, unreviewed and unsnoozed task waiting on the user, allowed urgency, an accepted message for that exact revision, and no authenticated user acknowledgment. The unanswered timer starts when the transport accepts the message. Transport acceptance does not prove delivery to the handset or reading. A failed delivery receipt cancels a queued escalation. Queued calls are revalidated immediately before dispatch; Reviewed, Snooze, completion, task replacement, resolved waiting state, offline ownership or disabled calls cancels them. A call already handed to a provider may require that provider's cancellation API; this local proof does not claim it can recall an in-flight real call.

Call attempts consume their limits before dispatch, including uncertain results. The checkpoint must synchronously and durably save the journal before a transport receives a dispatch. A checkpoint failure stops dispatch. After a restart, in-flight outbound or inbound records become uncertain and are never automatically replayed. A cancelled message which never left the queue can be queued again when its computer reconnects. A message with uncertain delivery cannot. Production integration must supply encrypted private storage; the default in-memory checkpoint is for local fixtures only.

## Replies and pending questions

The trusted recipient's channel and sender identity are configured before accepting actions. A real transport adapter must authenticate the incoming provider envelope or poll the provider's authenticated API, then map its unique event identity and reply-to message identity into this journal. The core cannot authenticate an SMS webhook or Telegram sender by itself. A guessed or unrecognized message identity, wrong sender, ambiguous task, changed revision or forgotten/offline owner cannot dispatch a command.

Reviewed and Snooze use the existing owner-bound task actions. An ordinary reply uses the bound source chat and task key. A plain “yes” does not approve or answer a pending request. A question answer must include the exact current request identity and all question identities, bound to the same sender, owner and task revision. Permission and command/file approval decisions are not implemented through this conversational core; use the existing approval UI.

Delivery states (queued, inFlight, accepted, delivered, failed, uncertain, cancelled) are separate from incoming task-command states (inFlight, accepted, rejected, uncertain). Duplicate incoming provider events return the saved result without resending. A trusted user response acknowledges the alert immediately, while Codex acceptance remains unconfirmed until the bound command returns. An uncertain reply blocks automatic retries and requires checking the source chat. Transport acknowledgment alone never records Codex acceptance.

## Acceptance ledger

| Case                                                | Local verification                                          |
| --------------------------------------------------- | ----------------------------------------------------------- |
| Duplicate, older and restarted snapshots            | Ordered replay; no duplicate message                        |
| Changed current task revision                       | Old reply refused; unanswered timer needs a new message     |
| Routine updates and working deltas                  | Latest routine revisions batch; working deltas stay quiet   |
| Reviewed, Snooze, completion or offline owner       | Queued escalation cancelled before dispatch                 |
| Two computers with identical raw chat/task IDs      | Distinct references; actions reach the selected owner       |
| Forget/re-pair and late reconnect acknowledgment    | Old binding refused; acceptance stays unconfirmed           |
| Quiet hours, DST boundary and call caps             | Explicit timezone; strict rolling and per-task limits       |
| Slow provider acceptance                            | Timer begins at acceptance rather than dispatch start       |
| Uncertain outbound, reply or interrupted checkpoint | Durable identity retained; no silent resend                 |
| Pending question or approval                        | Plain text cannot approve; exact question identity required |

## What the delivery choice changes

SMS needs a provider account, an appropriate number and usage billing. Incoming replies need an authenticated receiving path and exact task selection when several updates are in the same text thread. Telegram needs a bot, one allowed private recipient and authenticated polling or verified webhooks; reply-to messages and buttons can carry the bound task reference. Phone calls need a voice provider, a configured destination, delivery receipts and cancellation handling. Conversational live voice is a separate feature; this proof previews a short spoken alert only.

Provider setup, recipient verification, incoming authentication, encrypted storage, cost limits, actual delivery receipts and real-phone testing are not implemented or verified here. No personal phone number or secrets were collected. Existing desktop packages, the earlier race fixes and the personal-install/cross-platform requirements remain preserved.
