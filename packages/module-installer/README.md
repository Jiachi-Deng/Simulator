# @simulator/module-installer

Crash-safe filesystem installer for verified Simulator Module artifacts.

The package accepts only a trusted descriptor plus a local `tar.gz` path. It verifies compressed and extracted hashes, extracts under a unique same-filesystem staging directory, atomically publishes immutable versions, tracks active/LKG state, and recovers journaled transactions after a crash.

Security and archive format details are documented in [`docs/module-architecture.md`](../../docs/module-architecture.md#第二切片filesystem-module-installer).

Host startup must call `recoverAll()` before starting new mutations. A pending or recovering journal causes install, rollback, and uninstall to return `BUSY`. `recoverInterrupted()` may be used only after the host confirms that the previous recovery owner has stopped.
