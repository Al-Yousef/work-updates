# Interaction contract

Work Updates is a desktop queue for deciding what needs attention across many Codex chats. The notification stack is the product's main view, not a general dashboard.

## Hierarchy

A card shows the task title, status, and age. Chat names and message text live in details. A completed agent pass is **Ready to review**; only the user can mark the actual task **Done**. **Reviewed** acknowledges an update without closing its task. **Snooze 1h** postpones the notification.

## Controls

| Input                      | Card                             | New-task button                       |
| -------------------------- | -------------------------------- | ------------------------------------- |
| Left click / Enter / Space | Focused action panel             | Task composer                         |
| Hold 650 ms                | Details and compact conversation | Composer with project options         |
| Right click / Shift+F10    | Same details and conversation    | Same composer with project options    |
| Escape / outside click     | Return to the queue              | Cancel composer; preserve typed draft |

Menus are accelerators, never the sole route to a feature. A visible **Details & chat** action gives keyboard and mouse users a discoverable alternative to holding.

New tasks have a title, prompt, and optional workspace. **Queue task** saves a draft without starting inference. **Start chat** creates one conversation for that task. Starting is idempotent; retry after failure resumes the same conversation. The default task workspace is a dedicated folder. Permission prompts and blockers stay visible until answered; the app never silently accepts them.

**Mark done** moves a task to Done, with Undo and Reopen. It does not archive or delete its Codex chat. Incoming commentary never clears Done or resurrects a reviewed update. A clearly different task in an existing chat can receive a new task identity.

## Visual language

Use the approved dark lock-screen composition: blue-gray wash, large clock, 23px rounded notifications, muted green identity icon, and restrained status colors. Use 8px spacing increments, 44px main targets, a visible keyboard focus ring, text contrast, and reduced-motion support. Card text wraps to two lines; full text is always available in details. Panels have a consistent width and retain the background queue's positions while open. Success uses a short undo notice, not an interrupting dialog.

## Required states

Loading; empty queue; queued draft; starting; active; ready to review; waiting; blocked; approval required; failed launch with retry; sync paused with last successful data; snoozed; reviewed; done; restored; disconnected companion; connected companion. Each visible control must have a verified outcome.

## Reference evidence

- [Apple context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus): relevant, short contextual commands; every command is also discoverable in the main interface. Use hold and right click consistently. Do not borrow branding or hide essential commands behind gestures.
- [Microsoft contextual commands](https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/collection-commanding): support keyboard, mouse, and touch routes to the same operations; Shift+F10 must work.
- [Apple notification guidance](https://developer.apple.com/design/human-interface-guidelines/managing-notifications): classify urgency honestly. Stream ordinary progress quietly; alert on meaningful required input or failure.
- [Todoist Create and edit flow on UIZZE](https://uizze.com/apps/c8004cbe4eadde8718053446031ff836?journey=ecc1f7fc981eca1b05df868acfd63eb8&platform=ios), step 1, iOS screen 285: task context and a comment control share one sheet. Transfer the compact conversation next to its task, with a quiet source-chat label. Do not copy branding, artwork, or exact positioning.
- Same inspected flow, step 2, iOS screen 89: one focused task composer with a short title and an explicit save/cancel route. Transfer deliberate queueing and retained drafts because starting an agent should be a clear action. Do not copy Todoist's navigation or proprietary text.
- Same inspected flow, step 3, iOS screen 28: title and description remain separate while editing. Transfer a short card title and a fuller prompt in the composer, with reachable actions. Do not copy the keyboard, red palette, or exact layout.

## Acceptance

Exercise click, hold, right click, keyboard, drag cancellation, outside dismissal, and focus return. Verify Done/Undo/Reopen, queue/start/retry, conversation send, and approvals with actual state changes. Verify that background refresh does not move the selected card. Render compact and expanded windows, long titles, empty/error states, and reduced motion. Test native Windows and macOS packages separately. Showcase images must use synthetic tasks only.
