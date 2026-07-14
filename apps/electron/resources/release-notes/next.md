# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **OpenDesign now uses the Craft Host Runtime** — OpenDesign modules can run Agent turns through a launch-scoped, loopback-only Host gateway backed by the active Craft connection, with isolated sessions, bounded project-file tools, streaming and cancellation, grant rotation on restart, and cleanup on stop or quit. Simulator mode removes the OpenDesign Cloud/AMR sign-in path and fails closed instead of falling back to Vela, OpenCode, a private CLI, or the system `PATH`. Issue #110; commits `8c55d1e6`, `28551b3c`.

## Improvements

## Bug Fixes

## Breaking Changes
