# Weather lifecycle verification

The supported adapter fingerprint and function entry checks remain in `native/windows/taskbar-adapter/profile.h`. The adapter filename and protocol version are unchanged. The worker checks the panel once per second with a 200 ms acknowledgement deadline; callbacks use a cached two-second lease and never wait for that acknowledgement. A failed probe clears admission before recording diagnostics. Original Widgets handlers resume on stale health, process exit, wrong window ownership, an unsupported profile or failed attachment. The native queue remains available from its tray after adapter failure.

Endpoint publication flushes a unique temporary file before replacement. Reading uses a bounded regular-file handle and validates the complete protocol before changing current identity. Restart publishes a different cookie; the old cookie cannot reveal the replacement panel. Explicit isolation and disabled attachment remain guards on startup and TaskbarCreated. TaskbarCreated can recreate the tray without enabling adapter attachment.

## Automated evidence

`adapter-tests.exe` exercises real detours only inside its own test executable. It includes a responsive and hung hidden window, cookie and PID mismatch, expired/future health, failed endpoint replacement, partial/oversized/future descriptors, sender filtering and restored originals. It never loads an adapter into Explorer.

`native-adapter-tests.exe` exercises two owned native children with simulated commands. It checks isolated startup and TaskbarCreated, tray fallback after adapter failure, fresh replacement identity, obsolete-cookie rejection and normal shutdown. Windows CI runs this test and packages a source-hashed native candidate. Local compilation and these simulated commands do not establish physical taskbar behavior.

## Physical desktop matrix

The following rows remain pending until observed on the source-matched candidate. Record Windows build and supported module hash, candidate revision and binary hashes, monitor layout, DPI, input method, attachment/refusal evidence and a redacted capture for each run. Attachment counters and physical outcomes are separate fields. Unsupported versions must preserve ordinary Widgets behavior; changing Windows security is not an accepted test step.

| Gesture or fault | Primary monitor | Secondary monitor / mixed DPI | Required observation |
| --- | --- | --- | --- |
| Weather hover and pointer transfer | Pending | Pending | Reveal and retain the panel without covering the tile |
| Leave and rapid direction reversal | Pending | Pending | Correct dismissal and continuous motion |
| Pin and second click hide | Pending | Pending | One toggle per physical gesture |
| X and Escape | Pending | Pending | Dismiss while preserving drafts and next activation |
| Keyboard activation | Pending | Pending | Weather activation reaches the same intended behavior |
| Live panel hang and panel exit | Pending | Pending | Normal Widgets resumes within the bounded lease |
| Adapter stop | Pending | Pending | Original handlers restored; tray queue remains usable |
| Explorer restart | Pending | Pending | Fresh guarded attachment, or useful refusal with normal Widgets |
| Unsupported/conflicting profile | Pending | Pending | Refusal without intercepting unrelated controls |

Keep issue #6 open until this matrix and merged-code checks are complete. No Explorer restart, attachment or physical observation is claimed by the isolated CI lane.
