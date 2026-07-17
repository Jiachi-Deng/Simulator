# OpenDesign production release assets

`production-cli.mjs` prepares and verifies release assets; it never creates a
GitHub Release, generates a signing key, or prints private-key material.

## Initial build

Use an externally provisioned Ed25519 private key through exactly one of
`--private-key-file /absolute/owner-only/key.pem` or
`--private-key-env CI_SECRET_VARIABLE_NAME`. Do not pass PEM bytes on the
command line. The sealed staging input must carry the exact public distribution
marker and pass the repository's complete redistribution-rights validator.

Run `--dry-run` first without `--output` or any private-key option. A successful
build writes one deterministic `.tar.gz`, a canonical Catalog v2, its signed
wire envelope, `open-design-official-channel.json`, and release metadata into a
private verification bundle. Public upload is track-specific; do not use a
mutable `latest/download` URL:

- prerelease `0.14.6-rc.1` uploads exactly the archive, Catalog, envelope, and
  metadata to its exact tag. Its generated official-channel config remains an
  owner-only verification input, is never published, and is never copied into
  the Host application;
- stable `0.14.5` or separately approved `0.14.6` uploads the five-file public
  closure. Only a stable publication may promote its official-channel config
  into a newly built Host application.

Build and verify require `--module-version`. The only accepted identities are
`0.14.5`, `0.14.6-rc.1`, and `0.14.6`; each must use the exact tag
`open-design-v<module-version>`. The `0.14.6-rc.1` and `0.14.6` catalogs must
use `--host-version-range '>=0.12.0'`. Refresh defaults to the frozen `0.14.5`
identity for compatibility, but automation should pass `--module-version`
explicitly so filenames and verification cannot drift across releases.

For an explicitly approved stable publication, the generated Host
configuration is a build input, not user data. Copy:

```text
<publisher-output>/open-design-official-channel.json
  -> apps/electron/resources/open-design-official-channel.json
  -> Contents/Resources/app/dist/resources/open-design-official-channel.json
```

The second step is performed by `apps/electron/scripts/copy-assets.ts`. The
publisher intentionally does not modify `apps/**`. Never perform this copy for
a prerelease config; prerelease verification uses its private one-run copy only.

## Catalog refresh requirement

Catalog verification keeps the hard 24-hour TTL. CI must refresh the signed
catalog at least every 12 hours, using:

- the same exact GitHub Release tag;
- the same immutable archive asset, SHA-256, size, and extracted-tree SHA-256;
- a strictly increasing Catalog `sequence`;
- a strictly increasing canonical `issuedAt` and a new `expiresAt` no more than
  24 hours later;
- the explicit previous trust state (`highestSequence` and `latestIssuedAt`);
- the externally supplied Ed25519 key, or an intentionally rotated key already
  embedded in a newly shipped official-channel configuration.

Use refresh mode so the 12-hour CI job does not rebuild OpenDesign on macOS:

```text
pnpm --filter @simulator/open-design-artifact-policy package:production -- \
  --refresh \
  --bundle-root /absolute/path/to/verified-production-bundle \
  --output /absolute/path/to/new-refresh-assets \
  --module-version 0.14.5 \
  --release-tag open-design-v0.14.5 \
  --catalog-sequence <next-sequence> \
  --catalog-issued-at <canonical-ISO-time> \
  --catalog-expires-at <canonical-ISO-time-within-24h> \
  --previous-sequence <current-sequence> \
  --previous-issued-at <current-issuedAt> \
  --key-id <official-key-id> \
  --key-active-from <canonical-ISO-time> \
  --key-active-until <canonical-ISO-time> \
  --private-key-env OPEN_DESIGN_RELEASE_PRIVATE_KEY
```

Add `--dry-run` and omit `--output`/`--private-key-env` for the CI preflight.
Refresh accepts a just-expired source only after verifying its canonical signed
bytes at the signed `issuedAt`, key window, explicit previous trust state,
official-channel trust root/tag, actual immutable archive hash/size, metadata,
and a real `ModuleInstaller` tree-hash round trip. It then preserves the complete
signed release record byte-for-byte and changes only sequence and timestamps.

The refresh output is a new owner-only directory containing exactly the raw
Catalog, envelope, and release metadata. It never copies or modifies the archive
or `open-design-official-channel.json`. Replace those three assets on the same
tag. During GitHub asset replacement, clients must fail closed and retry; never
extend the TTL or reset the sequence to hide a missed refresh.

The expected GitHub Actions job runs at least every 12 hours. The stable track
downloads the five public assets from the fixed tag and advances from the
authenticated Catalog on its selected stable tag. A prerelease deliberately
publishes only four assets and omits `open-design-official-channel.json`; its
refresh job authenticates the shipped stable authority and the signed RC
metadata, takes the highest authenticated `sequence` and `issuedAt` across the
current RC and stable `0.14.5` Catalogs, constructs an owner-only one-run
verification config, and deletes it without publishing it. Both tracks run
refresh dry-run and refresh, run `--verify` against a reconstructed five-file
private verification bundle, and only then replace the three refresh assets.
The job must compare the archive SHA-256 before and after and must never expose
the private key in arguments, logs, artifacts, or step outputs. The stable
`open-design-official-channel.json` and both immutable archives remain unchanged
unless a new signed application build intentionally changes the trust root or
module version.

As of 2026-07-17, stable `0.14.5` is at Catalog sequence `3`, while public
prerelease `0.14.6-rc.1` is at sequence `4`. The RC archive remains fixed at
SHA-256 `1dd67f6ac536b61009410014ceab562bcba24e0d2694e353914915338d0ef0a3`;
the prerelease refresh does not authorize stable `0.14.6` publication or an
official-channel switch.

## Independent verification

Use `production-cli.mjs --verify` with an independently supplied Ed25519 public
key file, key ID/window, release tag, prior trust state, and verification time.
Verification checks the canonical envelope/signature, Catalog v2, exact-tag
URLs, archive hash/size, extracted-tree hash, official-channel metadata, exact
output file set, and a real `ModuleInstaller` install round trip.
