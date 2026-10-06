# Existing weather button adapter

This prototype uses the same general Explorer-side hook mechanism found in hobbyist taskbar customizations. It redirects private taskbar methods rather than adding a window over the tile. It is not a documented Microsoft weather-button API.

The only supported profile currently is `Taskbar.View.dll` version `2608.26001.200.0`, SHA-256 `CF7E002533DEF6628BA121481A703A06FC30ACCAA5E5CADD1A412F65F2D8BA77`, verified on Windows build `26300.9550`. Both the complete file hash and loaded function entry bytes must match before hooks are installed. A different version or another hook modifying these entries is refused. Offsets are module-relative and valid only with this exact fingerprint.

The candidate RVAs came from Microsoft's public symbol server. The served stripped PDB has matching GUID `24534974-E00E-46A5-8F69-F60D0CEB9BD9` but reports Age 2 while the DLL CodeView record reports Age 1. This is not strict PDB GUID-and-Age validation. Runtime safety gates use the exact DLL hash and function bytes, not an assumption that the PDB age matched.

`AugmentedEntryPointButton::OnHoverInvoke` redirects the dedicated weather hover invocation. `TaskbarResources::OnAugmentedEntryPointButtonClick` handles the weather tile's dedicated click command; the generic ExperienceToggleButton click handlers are not patched. The sender's runtime class is checked through the standard IInspectable ABI. Only `Taskbar.AugmentedEntryPointButton` is redirected. Failure to inspect, an unrelated sender, a missing panel process, or a failed message post invokes the original handler. `ExperienceToggleButton::OnPointerExited` always invokes its original handler and reports a dismissal only following our weather invoke. This shared observer does not consume leave events or inspect implementation object offsets.

The panel publishes a fresh random session cookie, control HWND, and PID beside its executable. The adapter verifies the HWND's PID, the process's exact sibling `Native Hover.exe` path, and a responsive cookie handshake before enabling hooks. Window messages carry only commands, with no chat content. The panel's control window stays hidden and is not layered. Explorer's UI thread does no file I/O or blocking IPC in the detours.

The adapter worker blocks on its stop event and the panel's process handle. Panel termination or an explicit stop disables the hooks and restores the original method entries. Trampolines and the DLL deliberately stay resident until Explorer exits to avoid freeing code that a suspended thread might still use. The resident, disabled adapter can attach to a later panel session. There is no idle polling or automatic background injector service. UI hangs are not currently detected by a heartbeat.

The controller accepts only the current desktop's verified Windows Explorer process. It has no arbitrary PID injection command. `--verify` checks the profile and reads all three function entries, `--attach` loads/starts this project's sibling `WorkUpdatesTaskbar-v2.dll`, `--status` returns adapter state and modulo-256 event counters, and `--detach` stops it. States: 0 stopped, 1 starting, 2 active, 4 refused/failed. Detach also asks the native panel to exit, releasing its existing Work Updates corner lease. Native startup attaches automatically; its tray Exit stops the panel and restores the original handlers. A TaskbarCreated notification attempts attachment again after Explorer restarts. The earlier disabled v1 DLL can remain resident until Explorer exits; it does not retain hooks or polling.

Validation supplied:

- `adapter-tests.exe`: real MinHook detours in an isolated executable, sender filtering, originals retained on disconnect or invalid endpoints, and restored entry behavior after disable.
- `native-adapter-tests.exe`: fresh cookie, invalid cookie rejected, hidden control window, reveal/pin/hide, X and Escape message handling, successful exit, and descriptor removal in the actual C++ panel. These are simulated commands, not physical pointer clicks.
- `motion-tests.exe`: continuity, reversals, bounds, and settling.

Physical taskbar behavior, input cancellation, keyboard activation, multiple monitors, DPI changes, and Explorer restart still require native desktop observation. A successful attach alone proves neither smoothness nor exclusive Widgets behavior.

Sources: [Windhawk Start button replacer](https://github.com/ramensoftware/windhawk-mods/blob/main/mods/start-button-replacer.wh.cpp), [TaskbarWidgets architecture](https://github.com/pfcdev/TaskbarWidgets/blob/main/docs/architecture.md), [MinHook](https://github.com/TsudaKageyu/minhook), [IInspectable runtime class name](https://learn.microsoft.com/en-us/windows/win32/api/inspectable/nf-inspectable-iinspectable-getruntimeclassname).
