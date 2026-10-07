# Channel adapters and audience ownership

Assessed 2026-10-07 against the primary API references below. This is the bounded supported-API assessment for #29. None of these external adapters is installed or enabled by Hyphen. No app registration, account authorization, hosted endpoint, phone number, paid service or external message was created.

## Current desktop and iPhone boundary

Desktop assistant history stays in the local private assistant store. The current phone contract supports authenticated source-task controls and ordered state, durable source drafts and accepted delivery receipts; it advertises `assistant: false` and `attachments: false`. A phone draft or projected assistant profile does not establish assistant conversation continuity.

The current peer transport pins the exact desktop TLS certificate and checks one host-level bearer credential. That authenticates possession of the pairing code; it does not distinguish individual phone actors or authorize a new assistant audience. Existing paired recipients must not acquire private assistant history or assistant commands merely because they can reach the task endpoint. Assistant continuity needs a separately granted per-client credential, exact assistant/channel identity, recipient ownership, explicit audience consent, per-channel retained history and destination receipts. Queue pairing and assistant pairing remain separate permissions.

## Supported API candidates

| Candidate | Supported API route | Hyphen status | Identity and receipt boundary |
| --- | --- | --- | --- |
| Slack | Installed app with Events API over authenticated HTTP or Socket Mode; Web API message posting | Unsupported; assessed only | Exact app/workspace/user/channel/thread; `event_id` for inbound deduplication and returned channel/message timestamp for accepted outbound posting |
| Microsoft Teams | Installed Teams app/agent using Microsoft identity authentication and supported conversation APIs | Unsupported; assessed only | Exact app/tenant/user/conversation reference; returned activity ID for accepted outbound posting |
| SMS through Twilio | Programmable Messaging API with signed incoming/status webhooks | Unsupported; assessed only | Explicit provider account/sender/recipient binding; exact Message SID and authenticated status callback |
| Telephone audio | Separate telephony/media adapter, provider authentication and audio/session controls | Unsupported; no implementation selected | A phone number or transcript alone cannot establish human ownership or permission to direct an assistant |

### Slack

[Events API](https://docs.slack.dev/apis/events-api/) supplies events within the installed app's granted scopes, with workspace/app/event identities and event authorization context. HTTP requests must use [Slack request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/): validate the signature over the original raw body and timestamp with the app signing secret, enforce the documented freshness window and use constant-time comparison. Socket Mode uses a separate authenticated transport; it is not a reason to skip event ownership checks.

[chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/) posts to an explicit supported destination under the token's permissions. Its returned channel and timestamp identify an accepted message; they do not prove that a person read it or completed the requested task. Reply threads and shared/external channels are distinct audiences. An installed bot, valid signature or mention in a channel is not a Hyphen owner grant. An adapter must bind the verified Slack user to the human-granted assistant channel before accepting a private instruction, deduplicate retries by event identity, and hold changed membership or revoked scopes. No public-channel expansion or impersonated posting is implied.

### Microsoft Teams

Teams supports [app/agent authentication with Microsoft identity](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/authentication/add-authentication). A future adapter must use the supported platform authentication implementation and verify app, tenant, sender and conversation identity; it must not treat a pasted activity, display name or service URL as verified ownership.

[Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages) requires the appropriate app installation and retained destination information such as tenant and conversation references. User identities are scoped to the app, and email alone is not a proactive destination. Returned message/activity IDs establish accepted posting, with later result verification separate. Personal, group and channel conversations need separate audience grants. Hyphen will not register/install an app, request Graph installation permissions, or send a proactive message as a consequence of this assessment. Missing installation, tenant consent, participant identity or supported receipt remains a hold.

### SMS and telephone

Twilio [secure webhook guidance](https://www.twilio.com/docs/usage/webhooks/webhooks-security) requires signature validation using the exact externally configured URL and all received form parameters, or the raw JSON body with the provider's JSON-specific validation method. Proxy URL reconstruction, redirects, replay handling and account/SID binding require explicit treatment; a valid provider signature alone does not authorize the sender as the private assistant owner.

[Outbound message status](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status) distinguishes message creation/sending from carrier delivery and later channel-specific read events. An API acceptance or `sent` callback is not a human read receipt. Hyphen must retain the original Message SID, exact provider account/sender/recipient and payload digest, handle duplicate or reordered callbacks, and preserve uncertainty after a lost acceptance. A number may be shared or reassigned; possession/source text does not establish the continuing human grant. Buying a number, enabling infrastructure, consent handling and sending messages require separately authorized implementation decisions. The existing finite local voice window is not an SMS or telephone channel.

## Admission contract for a future adapter

Provider transport authentication establishes where an event came from. Hyphen authority comes from a separate current human grant binding the verified provider actor, assistant identity, exact channel/destination and permitted audience. Other participants' messages remain untrusted source material. Events cannot create or widen their own grant, copy private desktop memory, restore revoked access or direct consequential actions merely by containing instructions.

Each channel needs its own ordered conversation revisions, retained human/assistant exchanges, receipt ledger and restart-safe message identities. A transport receipt, assistant answer and destination-result verification are separate records. Duplicates must not reinfer or repost; uncertain dispatch requires inspection rather than replay. A membership/audience change holds ongoing work until the relevant human authorizes the exact transition. Sharing selected context across audiences needs explicit consent and provenance; it must not silently include local pinned notes, other channel history, source chats, attachments or credentials.

Provider credentials belong in the OS/provider credential store. History, diagnostics, capability reports and exported evidence exclude tokens, signatures, cookie values and private pairing codes. Revocation must immediately block future reads/instructions/sends and terminate only the adapter's own local connections; it must not claim deletion of provider-held history or termination of already accepted remote work. All inference, reads and output operations participate in the existing shared resource budgets. Provider throttling and failed/uncertain operations retain their backoff and uncertainty across restart.

## Required implementation evidence

First finish desktop/iPhone ownership and per-channel history on disposable TLS/client fixtures. Verify wrong actors, destinations and audiences; ordered state; accepted/duplicate/uncertain receipts; changed membership; restart; revocation; unsupported client negotiation; and protected local storage. Physical client checks remain distinct from simulator/transport evidence. Then implement each external provider in its own bounded subchange using an installed supported SDK/API and authorized app configuration. Real-account, paid-service and outbound delivery checks require their own specific authorization and cannot be substituted with fabricated provider receipts.

This assessment satisfies only the API-assessment portion of #29. Shared assistant phone history, individually authenticated channel clients, audience transition controls and physical-client acceptance remain open implementation work.
