# Connected-device contract

Peer capability negotiation is version 2, with a reviewed legacy version 1
command subset. It is distinct from the existing native bridge and ordered
snapshot protocol version 3. Pairing codes retain their existing `wu1:` format.

Hosts advertise a bounded command allowlist, ordered snapshots and source-bound
message receipt version 1. Unsupported, future or contradictory capabilities
fail closed. They do not imply assistant, attachment or channel support. Legacy
hosts can expose only the historical command subset; queued-message controls and
receipt-backed iPhone sending require a current host. Existing legacy clients
retain their historical behavior and should be updated for verified receipts.

Negotiated mutations carry the host epoch; a restarted host refuses an old
session before dispatch. Message commands also bind exact card, task, source and
message identities. Supplied context revisions must match. The host routes to its
local queue, preserves the execution owner, and never silently moves a task to a
different device. Local maintenance blocks paired mutations as well as local
ones. Offline cached state is labelled; forgetting or revoking the pairing stops
future access. None of these operations erases retained remote work.

The iPhone model retains source revisions, active turns, queued metadata and
delivery outcomes. Sending clears the draft only after an exact source/message
receipt with an actual accepted turn. A response from a replaced connection is
unconfirmed. An in-sheet retry of an unchanged draft reuses its message identity;
it does not automatically resend after reconnect. Durable phone draft/receipt
recovery across application termination remains part of the channel continuity
work. The full source transport still rejects replayed message identities with
different content.

| Client | Implemented surface | Validation limits |
| --- | --- | --- |
| Windows native | Local assistant, source selection, Send/Queue, cancellation, local image attachments and source receipts | CI native/synthetic checks; physical input and installed-candidate matrix remain separate |
| Windows/macOS compatibility app | Local assistant, paired queues, exact source routing, task actions, Send/Queue and cancellation | Windows and both Apple architectures build in CI; physical Mac install remains unverified |
| iPhone candidate | Pinned pairing, ordered queues, task actions, exact source reply and receipt validation | Apple Core, TLS and simulator checks are required; physical install/background behavior remains unverified |
| iPhone Core transport | Negotiated queue/cancel command support and typed receipts | Queue/cancel UI, local assistant and attachments are not implemented by this change |
| Slack/Teams/phone text | No connected provider | Unsupported; separate adapter decisions in #29 |

The synthetic iPhone TLS fixture uses the production `Messages` journal and
controller rather than returning an invented acceptance receipt. Node fixtures
exercise actual private TLS, certificate mismatch, old host epochs, capability
denial, ordered snapshots, forgotten owners and uncertain delivery. Swift
fixtures test mirrored capability bounds and exact message/source/turn receipts.
The Apple workflow must compile the changed client and pass its simulator suite
before this source is integrated. Windows-only local checks do not prove Swift
compilation or physical-device behavior.

Pairing authenticates possession of the private code and pinned host
certificate. It is an owner-device connection, not a multi-person account or an
audience-sharing grant. Source text from another participant cannot become a new
authorization through capability negotiation. Do not share pairing codes with
other audiences. Per-channel authorization is separate work in #29.

See [iPhone setup](../ios/README.md) for the current Xcode/signing workflow. The
phone needs a reachable paired computer on a private LAN or an explicitly
configured private overlay. The computer must stay awake. The iPhone suspends
its connection when the app becomes inactive and reconnects when it returns.
No relay, background push, public HTTPS endpoint, SMS/iMessage integration,
paid service or App Store release is provisioned here. Issue #14 remains open
until the remaining physical and full parity acceptance has been verified.
