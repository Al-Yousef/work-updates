# Transactional portable updates

Every historical backend installer and package command routes to one update contract. `native/windows/install-preview.ps1` uses that same transaction for UI/launcher changes. Backend maintenance never replaces the resident `WorkUpdatesTaskbar-v2.dll`, attaches an adapter or restarts Explorer. Adapter installation belongs to its separate lifecycle workflow.

The unsigned development manifest binds the reviewed source revision and source hashes, candidate and baseline archive hashes, exact component roles/paths, program versions, descriptor/snapshot protocols and supported private-store versions. A version number alone is insufficient. Packaging requires a clean committed source tree, checks every backend/UI source against the archive, and refuses to overwrite existing output. Production packaging requires the built collector. The original archive must contain `src/update-compatibility.json`; older unreviewed archives are refused before maintenance. A historical version must have its source and store compatibility reviewed before it can become a rollback target.

```powershell
node scripts/package-transactional-update.cjs <absolute-reviewed-baseline-app.asar> <absolute-new-output-directory>
$env:HYPHEN_INSTALL_ROOT = '<absolute-portable-installation-directory>'
./scripts/install-transactional-update.ps1 -PackageDirectory <absolute-package-directory>
```

The portable installation has `desktop/Work Updates.exe`, `desktop/resources/app.asar`, `data/desktop/` and `native/` containing the matching native UI and launcher. The updater verifies exact process paths and explicit data/bridge arguments, fresh runtime identity and authenticated idle status before stopping anything. Existing processes for another profile cause a refusal. All helper launches use hidden windows.

An exclusive `.update-lease.json` prevents simultaneous installers; `.backend-lease.json` prevents concurrent backend writers. Dead process leases may be reclaimed by their unchanged token. Malformed ownership records are preserved for repair. Startup and command admission check maintenance ownership, queued sends pause, and idle quit closes command admission before shutdown. Only a new backend carrying the current transaction token may start while maintenance holds the profile.

The durable `update-journal.json` records prepared, staged, stopping, stopped, replacing, replaced, starting, healthy, launching and committed phases, with component identities and program backup locations. Each staged component is flushed, hash-checked and renamed atomically on the installation's volume. No replacement starts until the backend and native UI release ownership. A new backend must publish matching PID, transaction nonce, package/source hashes, protocols, store versions and fresh readiness; its launcher must claim that same backend. An exit, stale record, failed readiness or failed launcher triggers program rollback.

Rollback validates the current stores against the prior program, restores only unchanged candidate program components from verified program backups, and checks prior-package startup and launcher health. It never copies old receipts, messages, history, identity or drafts over current data. Independently changed program files, active work, corrupt backups or incompatible newer stores leave a `recovery-required` journal and an actionable error. Preserve that journal and its program backups, finish active work or repair a copy of invalid input, then retry:

```powershell
./scripts/install-transactional-update.ps1 -PackageDirectory <absolute-package-directory> -Recover
```

Queue v1, messages v1, assistant v1/v2, device legacy/v1 and drafts legacy/v1/v2/v3 are inspected before replacing program files. Queue/device startup no longer silently resets corrupt state. Valid legacy device migration retains its UUID; draft migration retains text, attachment references and message intent IDs. Unsupported versions and invalid fields preserve the whole original file. Native draft saving and backend JSON saving use unique temporary files, flush their contents, and replace the destination only after successful serialization/write. Interrupted temporary files are never promoted on startup.

Verification separates three kinds of evidence: backend/store tests, a nine-phase disposable fault audit with actual synthetic child processes, and a Windows CI packaged-backend audit with the actual native launcher. The latter uses demo data, disables automatic adapter attachment, and checks a healthy install and failed-launcher rollback with retained intent IDs. It does not use installed user data, a Codex account, a collector or a model. CI publishes sanitized verification reports only. These checks do not claim that an installed release was upgraded or that historical packages without a compatibility contract are safe rollback targets.
