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
wire envelope, `open-design-official-channel.json`, and release metadata. Upload
those files to the exact tag named in the command; do not use a mutable
`latest/download` URL.

The generated Host configuration is a build input, not user data. Copy:

```text
<publisher-output>/open-design-official-channel.json
  -> apps/electron/resources/open-design-official-channel.json
  -> Contents/Resources/app/dist/resources/open-design-official-channel.json
```

The second step is performed by `apps/electron/scripts/copy-assets.ts`. The
publisher intentionally does not modify `apps/**`.

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
  --release-tag open-design-v0.14.1 \
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

The expected GitHub Actions job runs at least every 12 hours, downloads the five
assets from the fixed tag into a private workspace, obtains the last accepted
`sequence` and `issuedAt` from trusted CI state, runs refresh dry-run and refresh,
runs `--verify` against a reconstructed five-file bundle, and only then replaces
the three refresh assets. The job must compare the archive SHA-256 before and
after and must never expose the private key in arguments, logs, artifacts, or
step outputs. `open-design-official-channel.json` and the archive remain
unchanged unless a new signed application build intentionally changes the trust
root or module version.

## Independent verification

Use `production-cli.mjs --verify` with an independently supplied Ed25519 public
key file, key ID/window, release tag, prior trust state, and verification time.
Verification checks the canonical envelope/signature, Catalog v2, exact-tag
URLs, archive hash/size, extracted-tree hash, official-channel metadata, exact
output file set, and a real `ModuleInstaller` install round trip.
