# Local native control

The Windows app exposes a local named pipe for the native hover component. This is separate from renderer IPC and the TLS device-pairing API. The descriptor at `data/desktop/native-control.info` contains a protocol version, a random pipe name, an authentication token and the server PID. Do not share that file.

Send one JSON request followed by a newline. Commands require the descriptor's token:

- `status`: reports corner ownership, whether the Electron launcher exists, the saved launcher preference, window mode and active writer count. It contains no chat content.
- `claimCorner`: keeps the connection open and gives its client exclusive ownership. The old weather shortcut and its polling timer are removed before acknowledgement. The saved preference is untouched.
- `quitIfIdle`: quits the app only when its writer count is zero.

The server restores the configured Electron shortcut when the owner disconnects or crashes. No heartbeat or idle polling is required. The C++ client verifies the server PID and waits for acknowledgement before creating its trigger. It also waits on an overlapped pipe read alongside Windows messages; loss of the connection closes the preview so two launchers cannot keep running independently.

Run `node scripts/native-control.cjs [descriptor] [status|quitIfIdle]` for local diagnostics. The CLI never prints the token.

Validation: `tests/native-control.test.cjs` exercises real pipe authentication, exclusive ownership, release and safe quit. `scripts/native-bridge-audit.cjs` launches the actual C++ executable against an isolated server and checks its handshake, server-loss exit and crash release. These checks establish control coordination, not animation smoothness or end-to-end pointer interaction.

Implementation references: [Node IPC support](https://nodejs.org/api/net.html#ipc-support), [Windows named pipe access rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights).
