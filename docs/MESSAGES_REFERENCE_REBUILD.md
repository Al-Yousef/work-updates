# Messages reference rebuild

The user rejected 0.6.4 because it followed colors and bubbles while retaining a different header, sidebar and toolbar. The visual baseline for this correction is the exact official Apple screenshot shown in the chat, saved at `artifacts/design-references/apple-messages-wide.png`, from [Messages on macOS Tahoe](https://support.apple.com/guide/messages/welcome/14.0/mac/26). Apple's [iPhone conversation guide](https://support.apple.com/guide/iphone/send-and-reply-to-messages-iph82fb73ba3/ios) also supports the contact-details header and bottom Add/composer relationship; it does not provide a current landscape split-view screenshot. Do not label the Mac screenshot as iPhone evidence.

| Field | Concrete contract |
| --- | --- |
| Job and action | Read and reply to a Codex chat, keeping other chat statuses visible |
| Geometry | 880 by 660 logical canvas, with an inset rounded sidebar occupying about one third; align all controls and native editors to shared geometry |
| Sidebar | Small brand label, real search field, circular pinned Hyphen entry, compact conversation rows; filters, older chats and Undo move to the filter menu |
| Header | Center the device/avatar and a small name pill with a chevron; its real details menu contains current task, explicit waiting owner, Open chat, Reviewed/Clear queue and Snooze |
| Conversation | Begin below the compact contact header; text-sized blue/gray balloons, smaller type and spacing, rounded image previews; no toolbar row between header and transcript |
| Composer | Small bottom Add circle beside a narrow pill; send arrow stays inside, native editor grows for multiline drafts; working chats name the Queue behavior explicitly |
| Navigation | Search filters the source list locally without changing or dispatching the selected chat's draft; all menus dismiss on outside click/Escape and remain keyboard operable |
| Required states | Connecting, empty/search no results, no selection, working/queued, rejected writer, uncertain receipt, unavailable image; source identity and separate drafts remain unchanged |
| Evidence boundary | Recreate the inspected structure and proportions. Use Hyphen data and installed Windows typography. Do not add fake Apple contacts, inert call buttons, traffic lights, emoji photos or unverified Apple materials |
| Finish gate | Compare the actual native render against the saved reference; check header/list/composer proportions, all changed menu actions, search and multiline input, then existing messaging/image/scroll/X and adapter checks |

UIZZE did not expose usable catalogue screens in the earlier reference passes, and the user could not provide links. The official screenshots above are the available visual evidence; do not ask the user to do reference research again.

## 0.6.5 verification

The candidate build passed the motion, input ownership, queue/assistant model and 28 isolated real-detour checks. The actual native window then passed 191 integration checks against a private synthetic backend, including contact/filter/Add menu actions, Escape dismissal, real native Search, no-results draft retention, multiline editor growth, display-change layout, exact-source Send, duplicate Enter suppression, durable Queue/Clear queue, writer refusal, per-source/assistant drafts, image picker/import/history, independent scrolling and X. Search Return cannot dispatch a chat draft. The actual multiline control bounds are checked rather than relying on a stale diagnostic snapshot.

The separate adapter integration passed 42 checks for the actual panel's hover, pin, hide, rapid reversals and shutdown. Window input and adapter commands were simulated; these checks do not claim a new physical weather-tile test or a real signed-in chat delivery. The installed taskbar adapter binaries remain unchanged.

Actual candidate captures are in `../native/windows/build/candidate/artifacts/messages-reference-{source-chat,queue,details,chat-draft,chat}.png`. The side-by-side review pairs the untouched official Apple screenshot with the native source conversation capture. Header, sidebar, bubbles, composer and image states were visually inspected before installation. Windows font rendering and opaque materials remain adaptations; no pixel-identical Apple or iPhone claim is made.

Installed locally on October 5, 2026 after the idle check and queue backup. Runtime reports 0.6.5 in native-backend mode with zero BrowserWindows and renderer processes; the native window connected to 60 real local cards. The installed native SHA-256 matches the tested candidate (`B580F86E48E4E334CCC2439DB28564B0DABE52858DB688789690CCF6A9463120`), and the preserved Explorer adapter reports ready. The synthetic fixture was closed after verification. A concise record is saved in the native project's `build/artifacts/messages-reference-installed-verification.json`.
