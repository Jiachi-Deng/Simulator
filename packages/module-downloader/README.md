# @simulator/module-downloader

Verified HTTPS catalog and artifact download boundary for optional Simulator modules.

The package accepts injected fetch, clock, and transactional cache adapters. It verifies signed catalog envelope bytes through `@simulator/module-release-trust`, persists catalog bytes and trust state atomically, and publishes artifacts only after streaming size and SHA-256 verification.

It intentionally does not install or extract artifacts and has no Electron, daemon, process, UI, or domain-module integration.

See [`docs/module-architecture.md`](../../docs/module-architecture.md#第四切片verified-catalog--artifact-downloader) for the trust, redirect, cache recovery, resume, retry, cancellation, and concurrency policies.
