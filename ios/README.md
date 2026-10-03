# Work Updates for iPhone

A SwiftUI app connected privately to the Windows and Mac queues. It uses the same chat/task distinction, waiting ownership, status colors, review and task completion rules as desktop. Native sheets expose context, mini-chat, Reviewed, Snooze 1h, approvals and task settings. Return in the reply field sends; submissions are locked while pending. New tasks choose their executing computer and a workspace already approved on that computer.

On a Mac, install Xcode, then run `bash setup-mac.command`. Choose your Apple account's Personal Team under Signing & Capabilities, select your connected iPhone and Run. Your password and signing identity stay in Xcode. A regular-account install expires after seven days; see [Apple's account guidance](https://developer.apple.com/help/account/basics/about-your-developer-account).

Pair each computer in the app's Your devices sheet. For remote access, put the phone and computers on the same private overlay network, then use the computers' private overlay addresses in their desktop pairing codes. The app works as an installed iPhone app and opens no browser tab for its queue. Computers must be awake with Work Updates running.

Pairing codes are validated as private IPv4 endpoints, with a SHA-256 certificate pin and bearer token. They are stored in the iPhone Keychain, available only while unlocked and not migrated to another device. No API keys or Codex login are put on the phone. The client refuses redirects and does not automatically repeat POST commands after uncertain delivery. It reconnects read-only streams while the app is active and cancels connections in the background. Continuous background APNs push is not configured in this build.

Core tests run with `cd Core && swift test`. XcodeGen's shared scheme builds the app and its UI tests. The `--demo` preview is synthetic and disables task mutation; never use personal conversations for public screenshots. The DEBUG-only integration launch uses a temporary synthetic pairing fixture in CI; no real credentials or chats enter the build artifacts.
