# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **OpenDesign now reuses the Craft Agent Runtime through a standard CLI contract** — OpenDesign `0.14.6` launches the Host-owned `simulator-host-agent` as an ordinary `json-event-stream` Runtime, with one transient Craft Session per Turn, no OpenDesign Cloud/AMR login, no external CLI setup, and no provider/model selector inside the Module. v1 compatibility for OpenDesign `0.14.5` remains available for rollback. Issue #129.

## Improvements

- **Module failures are contained away from the primary Craft UI** — v1 and v2 Broker state now runs in separate Electron Utility Processes with independent tokens, epochs, limits and circuit breakers. Worker, Shim, protocol, traffic and update failures fail the affected Module Turn without requesting Craft to exit; Craft still owns the shared SessionManager/provider runtime, so this is an explicit process/protocol containment boundary rather than a claim of absolute physical isolation.
- **Module Agent cleanup is strict and bounded** — visible Craft Turns preempt Module work, file tools require a canonical authorized boundary, Broker disconnects never replay writes, and terminal cleanup waits for provider, Session and child-process reap before a Run is closed.

## Bug Fixes

- **OpenDesign production requests stay usable** — Simulator Host mode no longer sends the standalone `od-default` plugin ID when that plugin is not installed, and a visible OpenDesign workspace now renews its daemon lease so it cannot disappear after five minutes of active use.
- **Lost create responses no longer duplicate Module work** — the v2 Broker retains unclaimed Run ownership long enough for the Shim to recover with the same idempotency key, then cancels and strictly closes abandoned Runs without inventing a successful terminal event.

## Breaking Changes
