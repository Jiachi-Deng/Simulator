# @simulator/module-installer

Crash-safe filesystem installer for verified Simulator Module artifacts.

The package accepts only a trusted descriptor plus a local `tar.gz` path. It verifies compressed and extracted hashes, extracts under a unique same-filesystem staging directory, atomically publishes immutable versions, tracks active/LKG state, and recovers journaled transactions after a crash.

Security and archive format details are documented in [`docs/module-architecture.md`](../../docs/module-architecture.md#第二切片filesystem-module-installer).

Host startup must call `recoverAll()` before starting new mutations and after stopping every other installer owner for that root. A pending or recovering journal causes install, rollback, and uninstall to return `BUSY`. `recoverInterrupted()` may be used only after the host confirms that the previous journal publisher or recovery owner has stopped.

Every staging directory receives a durable, strict `ownership.json` before archive work begins. `recoverAll()` runs as an exclusive maintenance operation and removes only UUID staging directories with a valid matching marker older than `DEFAULT_STALE_STAGING_AGE_MS` (24 hours) and no journal, recovery journal, or journal claim. Fresh, future-dated, malformed, and unrecognized entries remain quarantined. This bounded-age cleanup is a startup policy, not cross-process locking; the host must not run it concurrently with another installer process.

`uninstall()` is fail-closed unless `ModuleInstallerOptions.usageGuard` is supplied. The daemon integration must implement `runExclusive()` as an authoritative transaction: it must serialize runtime reference acquisition for the module, and keep that exclusion held while the installer checks usage and renames the version into trash.

The v1 archive path contract intentionally accepts only safe ASCII segments matching the Module entrypoint grammar. Unicode archive paths are rejected rather than relying on platform-dependent Unicode case folding.
