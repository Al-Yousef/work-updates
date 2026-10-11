# Replying to Hyphen messages

Each completed Hyphen answer and automatic source update has a small Reply action.
It attaches that exact message to the composer without copying it into the text
or submitting anything. A preview above Message identifies the selected answer;
× cancels the reply while keeping typed text and images. Copy and Quote remain
available on conversational answers.

The reply target is saved with the draft, independently of source-chat drafts,
and survives switching chats, reconnecting and restarting. Send includes only
its stable ID; the backend resolves the original retained message, stores the
reply relationship and provides its text to the answer provider. The outgoing
message displays a short parent preview. Unavailable targets refuse submission
and keep the draft. A changed reply target creates a new send identity, so an old
receipt cannot clear a newer draft.

Selected assistant/source text is context, not a new instruction or permission
to send elsewhere. Related source focus requires the same owner, source and
revision. An explicit reply overrides unrelated newer destination clarifications
and queued-message references. Forgetting a retained parent also removes its
copied reply context from remaining exchanges.

Draft v3 and assistant v2 gain optional bounded metadata. Existing stores are
read without a version migration; old no-reply receipt hashes are unchanged.
Downgrading can discard the optional draft reply target when the older shell
saves, while preserving draft text and images. Backend validation checks the
optional fields before startup or transactional updates.

Validation uses synthetic provider/transport fixtures, native model assertions
and actual isolated Windows GUI checks across DPI, text scaling and contrast
settings. These checks do not claim signed-in model delivery or physical
weather-tile input.
