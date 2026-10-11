# Assistant messages on Windows

Assistant replies keep Hyphen's existing conversation layout. The native projection renders short paragraphs, bold emphasis, bullet and numbered lists, and inline or fenced code. Formatting is display-only: saved history and related-chat drafts retain their original text. HTML remains literal text. Older native shells still receive readable plain text when they ignore the optional style spans.

Completed replies expose **Copy** and **Quote** beneath their balloon. Copy transfers the displayed text and confirms success or clipboard failure. Quote adds the selected reply to the assistant draft, keeps existing text and images, focuses the composer, and never sends. Long replies become a clearly marked excerpt so the user has space for a question within the assistant input limit. A full draft is preserved when there is no room. Related **Use draft** and **Open update** controls retain their existing destination checks.

Controls use the current message ID, native keyboard focus, screen-reader names and descriptions, and the existing stale-press protection. Thinking, failed and removed replies cannot supply completed-answer actions.

Verification combines presentation/projection tests, draft and message identity model checks, and isolated native GUI tests for clipboard content, quote behavior, accessibility, DPI, larger text and high contrast. Synthetic screenshots are development evidence; installation and physical PC behavior require separate verification. These checks do not read real chats or use model quota.
