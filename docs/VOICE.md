# Private desktop voice

Issue #30 adds an explicit, finite voice conversation on the local desktop.
Use the literal command /voice open, then configure a separately billed OpenAI
Realtime API key in the private window. /voice inspect reports retained session
and accepted response identities; /voice end stops this local connection.
The Codex plan is not an audio-provider entitlement. Provider configuration
does not establish account access; that is checked by the explicit connection.
Current provider reference:
https://developers.openai.com/api/docs/guides/voice-webrtc?voice-api=realtime

Each start requires microphone and separate API-billing consent plus a 15..300
second duration. A duration is not a price cap. Unknown actual cost remains
null; a response's reported usage is retained separately from the account bill.
The configured model is gpt-realtime-2.1. The secret stays in OS-encrypted local
storage, never in the renderer, ordinary journal, diagnostic text or URL.
Unavailable encryption is held; there is no plaintext fallback.

The isolated sandboxed window requests audio only, uses the system microphone,
shows its selected label, provides mute, end and typed steering, and displays
temporary captions when supplied by the provider. Opening the window starts
neither capture nor a provider call. Close, timeout, disconnect and global work
hold stop local tracks and the peer connection. No automatic reconnect, redial,
replacement call or replay is allowed. The browser peer closing is not proof of
remote termination or the final charge. Ending voice leaves other tasks running.

Connection acceptance, response acceptance and response completion are separate.
Only a previously accepted matching response may complete. Typed steering
cancels the exact active response and clears its audio before the new human text.
A late connection result after end is discarded. Restart marks live sessions and
responses unconfirmed and asks for new consent. External journal replacement and
unsupported data hold further activity without overwriting the file.

This provider has no task execution tools. By default it receives no source/task
history. It cannot dispatch work, approve actions, contact people, dial phone
numbers or claim a task outcome. No microphone recording or transcript is
persisted. The private journal keeps bounded session/response metadata and
usage, and the encrypted key remains until separately removed. Privacy inventory
and supported removal must make that retention visible when integrated.

Synthetic tests inject the transport and use disposable files. They consume no
account quota. Optional task sharing requires selecting exactly one owner/source,
previewing the bounded summary and excerpts, and checking separate context consent
at each start. The preview cannot grant task actions. It includes explicit missing
and truncated history; no memory, attachment contents, other conversations or
automatic context reads are added. Task status continues updating locally while
voice retains the call-start snapshot. Changed preview contents, unavailable or
ambiguous sources and work/privacy holds require a new preview. Context is checked
again before and after the provider handshake. Revocation stops local audio; it
cannot remove evidence already sent to the provider. Only source identity, revision,
digest, capture time and coverage metadata persist in the voice journal. Excerpts
remain in memory for this call and are never written there. Restart restores no
context payload or consent. Older journal readers do not reconnect sessions.

Synthetic context tests exercise actual work controls, shared budgets and the
production session/provider boundaries without paid requests. They do not prove
microphone/device behavior, authenticated API
access, bill amounts, phone parity or outbound telephony. Actual hardware/audio
and any paid provider check remain separate acceptance work for #30.

The production voice client reserves shared resource capacity before requesting the microphone. The human chooses an estimated token reservation; finite cost caps refuse unpriced calls. Reported tokens accumulate across accepted response identities, with missing responses/usage shown separately and actual cost left unknown. At the reservation or global token limit, local audio stops; unrelated tasks continue. A never-started call releases its local slot. Once a provider handshake was attempted, End/disconnection keeps an uncertain resource checkpoint because transport closure alone is not verified server termination or a final bill. These controls do not place outbound calls, run paid audits or enable a fallback provider.
