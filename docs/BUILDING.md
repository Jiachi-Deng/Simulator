# Building Simulator from source

## Prerequisites

- macOS on Apple silicon for the current desktop packaging baseline
- Bun `1.3.10`
- Node.js and `npm` for cross-architecture runtime package fallback
- Xcode command-line tools

Install the frozen dependency graph and verify that every distributable workspace uses the same version:

```bash
bun install --frozen-lockfile
bun run check-version
```

## Development build

Build every public product target without packaging:

```bash
bun run build
```

Run the Electron app from source:

```bash
bun run electron:start
```

## Unsigned macOS arm64 artifact

Create a local DMG without Apple signing or notarization credentials:

```bash
bun run electron:dist:unsigned:mac:arm64
```

The command repeats the frozen install, downloads pinned Bun and Claude Agent runtime artifacts, verifies their recorded integrity, stages only the matching architecture, and writes the DMG under `apps/electron/release/`. Public unsigned builds ignore local `.env` values for credentials embedded by private development builds.

An unsigned artifact is intended for local engineering verification. macOS may quarantine or warn about it, and it must not be presented as a production release. Public releases require a separately reviewed signing, notarization, checksum, SBOM, and provenance workflow.

## Release boundary

The public repository intentionally does not expose the former private upload command. Publishing and update-feed activation remain disabled until Simulator owns the release destination, signing identity, and rollback policy.
