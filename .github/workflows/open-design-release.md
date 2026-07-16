# OpenDesign official release workflow

The `open-design-release.yml` workflow is intentionally inert until the
`open-design-production` GitHub Environment is configured. This repository does
not contain or generate the production signing key.

It is also gated by the repository variable
`OPEN_DESIGN_RELEASE_ENABLED=true`. An absent variable or any value other than
the exact lowercase string `true` leaves both manual publication and scheduled
refresh jobs skipped. Set it only after the Environment and initial input have
been independently reviewed.

## Required environment configuration

Configure the following GitHub Environment secret and variables:

- Secret `OPEN_DESIGN_RELEASE_PRIVATE_KEY`: an externally provisioned Ed25519
  PKCS#8 PEM. The workflow injects it only into the signing step through an
  environment variable. It is never used as an argument, written to an
  artifact, or printed.
- Variable `OPEN_DESIGN_RELEASE_KEY_ID`: the key ID embedded in the signed
  official-channel configuration.
- Variables `OPEN_DESIGN_RELEASE_KEY_ACTIVE_FROM` and
  `OPEN_DESIGN_RELEASE_KEY_ACTIVE_UNTIL`: canonical ISO-8601 key boundaries.
- Variable `OPEN_DESIGN_HOST_VERSION_RANGE`: required only by the one-time
  initial publication.

Protect the environment according to the repository release policy. The fixed
authority is `Jiachi-Deng/Simulator`, tag `open-design-v0.14.4`; neither manual
inputs nor repository variables can redirect it.

## Production input workflow

`open-design-production-input.yml` is the non-signing producer for initial
publication. It runs after relevant changes reach `main`, and it may also be
manually dispatched from `main`. It has only `contents: read`, receives no
production secret, and cannot create or mutate a GitHub Release.

On a macOS arm64 runner it binds itself to the exact Simulator SHA, clones the
fixed upstream tag and commit, and downloads the fixed Node 24.18.0 and pnpm
10.33.2 distributions. The archive, executable, lockfile, repository, tag,
commit, ABI and architecture values must all match `provenance.json` and the
workflow's fixed constants. It then executes the production staging dry-run and
the real public staging path. The latter includes native validation, the rights
gate, sealed-tree verification and runtime smoke.

Only after those gates pass does the producer upload the artifact
`open-design-production-input`. It contains exactly a checksum and one tarball;
the tarball contains only the sealed `staging/` tree, exact
`node/bin/node`, and Node `LICENSE`, with filesystem modes preserved. GitHub
binds the artifact to the producer run; the release consumer independently
requires the run to be successful, from the current `main` SHA, from this
repository, and from the fixed producer workflow path.

## Manual initial publication

First complete the production-input workflow on the current `main` SHA. Then
dispatch the release workflow from `main` with `operation=initial` and that
producer `source_run_id`. The successful producer run must contain one artifact
named `open-design-production-input` with exactly:

```text
open-design-production-input.tar.gz
SHA256SUMS
```

The tar archive preserves the sealed modes that GitHub artifact ZIP transport
would otherwise discard. It must contain
`open-design-production-input/staging/`, the pinned executable at
`open-design-production-input/node/bin/node`, and its license at
`open-design-production-input/node/LICENSE`. The release workflow verifies the
run identity, checksum, archive paths, absence of links, public-rights gate,
dry-run, signing, and an independent installation round trip before creating a
draft Release. The draft is published only after all five downloaded remote
assets match; failure removes the draft and tag.

The publisher runs with Node 24.18.0 and installs two independent locked
dependency closures before loading the production CLI: the root Bun workspace
lock provides the internal Module packages and their exact runtime dependencies,
while `modules/open-design/package-lock.json` provides the standalone artifact
policy dependencies. Lifecycle scripts are disabled for both installs. Cleanup
is restricted to the job's private `RUNNER_TEMP` subtree; because the input and
output trees are intentionally sealed read-only, the workflow restores owner
write permission only inside that subtree immediately before deleting it.

## Scheduled and manual refresh

The refresh job runs every 12 hours on Linux and may also be manually
dispatched. It downloads the five fixed-tag assets, advances the signed Catalog
state, runs refresh dry-run, signs through the Environment secret, reconstructs
the full bundle, and verifies it before any GitHub mutation.

Only the raw Catalog, envelope, and release metadata are replaceable. New
assets are uploaded under temporary names first. The Release is then made draft
while those three assets are renamed as a transaction. The immutable archive
and official-channel configuration are downloaded again and compared before
the Release is republished. A pre-verification failure rolls the old assets back
before republishing; a failure after the new transaction is verified leaves the
Release draft for manual recovery rather than exposing a partial public state.

No real publication should be attempted until the production key, Environment,
repository enable variable, public redistribution evidence, and a successful
current-SHA production-input run have been configured and independently
reviewed.
