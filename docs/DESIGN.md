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
| Swipe left                 | Reveal Snooze and Reviewed       | —                                     |

Menus are accelerators, never the sole route to a feature. A visible **Details & chat** action gives keyboard and mouse users a discoverable alternative to holding.

New tasks have a title, prompt, and optional workspace. **Queue task** saves a draft without starting inference. **Start chat** creates one conversation for that task. Starting is idempotent; retry after failure resumes the same conversation. The default task workspace is a dedicated folder. Permission prompts and blockers stay visible until answered; the app never silently accepts them.

**Mark done** moves a task to Done, with Undo and Reopen. It does not archive or delete its Codex chat. Incoming commentary never clears Done or resurrects a reviewed update. A clearly different task in an existing chat can receive a new task identity.

## Lock Screen reference contract — October 1, 2026

The user's latest direction replaces the iCloud dashboard surface treatment. Use Apple Lock Screen notifications as the structural source. Three inspected Apple examples establish the following:

| Inspected evidence                                                                                                                                                                                 | Transfer to Work Updates                                                                                                                             | Product adaptation                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [Apple's published Lock Screen image](https://cdsassets.apple.com/live/7WUAS350/images/ios/ios-26-iphone-16-pro-lock-screen-notifications.png), linked from its September 14, 2026 support article | One continuous translucent rounded card; icon at left; content beside it; age at upper right; close spacing; queue toward the bottom under the clock | Original Work Updates icon and CSS wallpaper; task title and explicit waiting owner; desktop toolbar and queue filter |
| [Apple's notification options image](https://cdsassets.apple.com/live/7WUAS350/images/ios/ios-26-iphone-16-pro-manage-notifications.png)                                                           | Frosted floating menu, plain command rows and restrained separators; mute for one hour                                                               | Snooze 1h, Reviewed, Open chat and Mark done are this app's commands                                                  |
| [Apple's expanded notification anatomy](https://developer.apple.com/documentation/usernotificationsui/customizing-the-appearance-of-notifications)                                                 | Expand the selected notification over a blurred background; keep identity and full content together                                                  | Inline Codex conversation and reply; manual status, owner and priority behind Task settings                           |

The compact/options images are explicitly named iOS 26; the developer example is older. They establish visible structure, not pixel-exact iOS 27 rendering. Apple's [current iPhone notification guide](https://support.apple.com/guide/iphone/view-and-respond-to-notifications-iph6534c01bc/ios) verifies hold-to-expand and quick actions. No verified current iOS 27 hold screenshot was found. Do not claim these assets demonstrate it.

Keep click for quick actions, as requested earlier. Apple normally uses tap to open the source app: our mapping is an explicit desktop adaptation. Hold 650 ms expands the same card, with press feedback and origin-based expansion, full context, a reply and actions. Right click and Shift+F10 provide the same expanded view. Escape/outside click closes and returns focus. Dragging cancels the hold; releasing a successful hold never opens a second panel. Reduced motion removes press/expansion animations.

Remove the split slate header/black body, colored status pills, always-visible per-card X, decorative fake stacks and blue/green action blocks. Underlays mean actual grouped chats only. Use a continuous frosted material and monochrome command rows. Text remains readable against the original background. Windows uses Segoe UI fallback; CSS backdrop blur approximates the material and does not implement Apple's native Liquid Glass optics.

## Queue and responsive behavior

On Windows, the target is the user's existing taskbar weather/Widgets area, as shown in their screenshot, not an added W launcher. Keep Windows' weather pixels visible. A shadowless input window with a one-step alpha background covers the first 144 DIP inside the primary taskbar strip. This is an overlay workaround, not an Explorer tile rebind; [Microsoft's Widgets API](https://learn.microsoft.com/en-us/windows/apps/design/widgets/) describes providers inside the Widgets board. Only enable the region with Widgets on, centered icons and a visible bottom taskbar; otherwise remove it to avoid covering Start or application content. Read settings without changing them and refresh on display changes and every ten seconds. Turning the feature off restores native Widgets input. macOS retains its optional corner launcher.

The weather input surface must stay above the taskbar while the pointer is inside it, without taking focus or changing the weather pixels. Use Windows' pop-up-menu level and restore its position in the native window order on hover. A regression test must raise a competing native surface over the same region, then verify Windows' actual hit target returns to the weather input window. Renderer clicks and global hover detection do not establish click interception.

The target uses a 220 ms hover dwell to open a temporary peek without stealing focus. Leaving both target and queue for 400 ms closes the peek. Clicking either retains it; dragging its header retains it and remembers the new position. Clicking the target again hides it and suppresses another hover until the pointer leaves. Dock the peek above the taskbar, preserve the previous floating position during temporary peeks, and preserve explicit hide/keyboard/tray controls. These are product-specific desktop behaviors, not Apple's Lock Screen gestures.

With the weather shortcut enabled, launching or relaunching starts the background companion without pinning the queue open. An explicit Show queue action retains it; the X hides it and leaves the weather shortcut running. Verify X with actual Windows mouse input as well as renderer tests. A relaunch after hiding must not reveal or retain the queue. Test header dragging and weather clicks against the installed app, not just calls to its window controller.

Keep existing notification DOM, decoded icons and blur layers when visibility changes or an unchanged watcher heartbeat arrives. Only replace the queue when its visible content changes, and assemble changes before replacing it. Repeated hovers must each reveal the queue once without rebuilding unchanged cards.

Reveal the whole desktop surface from the left over 240 ms and reverse the same motion on dismissal. Use a transparent, shadowless native surface that stays painted after startup, with mouse input ignored while concealed; do not cycle native show/hide on hover. Concealed content is fully outside the viewport and transparent, including panels and notices. Preserve hover focus, click retention, saved drag positions and rapid direction reversal. Reduced motion reveals and conceals immediately. Verify rendered motion and transparent concealed pixels, rather than counting native show events as proof against flashing. This left-edge motion is the user's desktop requirement, not a claimed Apple gesture.

Use a 420×880 portrait notification queue, limited by the display's available height. This extends the weather preview upward while keeping its bottom anchor and gives the surface the tall, narrow silhouette of the inspected Apple Lock Screen reference. Keep the quiet Work Updates toolbar, date and clock above the notifications; give the clock 32px of top space and round the continuous outer surface to 36px. Do not add a fake notch, bezel, battery or signal indicators. A heading menu opens Updates, Queued and Done; the plus button opens the composer. At 390×590, reduce clock space and card padding while keeping titles readable and controls reachable. Expanded windows retain one readable queue column. Card titles wrap to two lines; full text is available by holding. Long waiting-owner text wraps. Panels retain the background queue's positions while open, and replies survive dismissal. Main command targets are at least 44px; keyboard focus remains visible; collapsed settings do not participate in the dialog's Tab cycle. Verify the taller preview fits above the taskbar and all quick-action and hold controls remain reachable.

Waiting on you always sorts first, then urgent items, then other actionable blockers and review items. Ordinary working items and external waits follow. Waiting cards must identify the owner. Extract only explicit names or roles from the latest recorded response; unknown owners are labeled as unclear. Details support a named waiting owner and Automatic/Urgent/Normal priority. Group cards surface their highest-attention source, keeping every source conversation attached. Ownership and urgency changes never alter completion fingerprints or replay reviewed history.

## Required states

Loading; empty queue; queued draft; starting; active; ready to review; waiting; blocked; approval required; failed launch with retry; sync paused with last successful data; snoozed; reviewed; done; restored; disconnected companion; connected companion. Each visible control must have a verified outcome.

## Acceptance

Exercise click, hold, right click, keyboard, drag cancellation, outside dismissal, and focus return. Verify Done/Undo/Reopen, queue/start/retry, conversation send, and approvals with actual state changes. Verify that background refresh does not move the selected card. Render compact and expanded windows, long titles, empty/error states, and reduced motion. Test native Windows and macOS packages separately. Showcase images must use synthetic tasks only.
