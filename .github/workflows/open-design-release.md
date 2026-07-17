# OpenDesign release workflow

The `open-design-release.yml` workflow separates public prerelease publication
from stable official-channel mutation. This repository does not contain or
generate the production signing key.

RC publication requires `OPEN_DESIGN_PRERELEASE_ENABLED=true` and the protected
`open-design-prerelease` Environment. Stable publication requires both
`OPEN_DESIGN_RELEASE_ENABLED=true` and
`OPEN_DESIGN_STABLE_CHANNEL_ENABLED=true`, the exact confirmation input, and
the protected `open-design-production` Environment already used by the 0.14.5
scheduled refresh. Stable still has separate acceptance, rollback, channel and
exact-confirmation gates; reusing the configured signing Environment avoids an
unprotected auto-created Environment with no secret. Scheduled refresh remains
stable-only in `open-design-production`; the one fixed RC may be refreshed only
by a manual dispatch through `open-design-prerelease`. An absent variable or
any value other than the exact lowercase string `true` leaves the corresponding
path skipped.

## Required environment configuration

Configure the following GitHub Environment secret and variables in each
Environment that is intentionally enabled:

- Secret `OPEN_DESIGN_RELEASE_PRIVATE_KEY`: an externally provisioned Ed25519
  PKCS#8 PEM. Each job injects it into exactly one signing/verification step
  through an environment variable. The initial job first derives the public
  verification key in that step, authenticates all predecessor release state,
  and only then signs the candidate. The secret is never used as an argument,
  written to an artifact, or printed.
- Variable `OPEN_DESIGN_RELEASE_KEY_ID`: the key ID embedded in the signed
  official-channel configuration.
- Variables `OPEN_DESIGN_RELEASE_KEY_ACTIVE_FROM` and
  `OPEN_DESIGN_RELEASE_KEY_ACTIVE_UNTIL`: canonical ISO-8601 key boundaries.
- Initial RC/stable publication fixes the signed Host compatibility range to
  `>=0.12.0`; it is not configurable through repository or Environment
  variables.

Protect every Environment according to the repository release policy. Required
reviewers must be configured for `open-design-prerelease`,
`open-design-production`, `open-design-m1-machine-evidence`,
`open-design-m1-visual-attestation`, `open-design-rc-acceptance`, and
`open-design-acceptance-rollback`; naming an Environment in YAML does not by
itself configure reviewer protection. The four acceptance workflows
additionally require their exact repository enable variables, so a missing
Environment cannot silently become an enabled gate. Those variables are
`OPEN_DESIGN_M1_MACHINE_EVIDENCE_ENABLED`,
`OPEN_DESIGN_M1_VISUAL_ATTESTATION_ENABLED`,
`OPEN_DESIGN_RC_ACCEPTANCE_ENABLED`, and
`OPEN_DESIGN_ACCEPTANCE_ROLLBACK_ENABLED`.

Activation order is fail-closed and mandatory: first land the workflow on
`main`; then create the named Environment, configure its required reviewer and
protected-branch policy; next read the Environment back through the GitHub API
and verify those settings; only then set the corresponding repository enable
variable to the exact lowercase string `true`. Set the variable last. Do not
dispatch a workflow against an auto-created or unverified Environment.

The fixed repository authority is `Jiachi-Deng/Simulator`. Initial publication
accepts only these version-consistent identities:

- prerelease: version `0.14.6-rc.1`, tag `open-design-v0.14.6-rc.1`;
- stable: version `0.14.6`, tag `open-design-v0.14.6`.

Stable publication additionally requires the exact confirmation
`PROMOTE_OPEN_DESIGN_0_14_6`. Manual inputs cannot redirect either identity.

## Production input workflow

`open-design-production-input.yml` is the non-signing producer for initial
publication. It runs after relevant changes reach `main`. It has only
`contents: read`, receives no production secret, and cannot create or mutate a
GitHub Release.

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
dispatch the release workflow from `main` with `operation=initial`, an explicit
`release_track`, its locked version/tag, and that producer `source_run_id`. The
successful initial input run must contain one artifact named
`open-design-production-input` with exactly:

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
draft Release. Failure removes the draft and tag.

Before either RC or stable signing, the transaction downloads the current
non-draft, non-prerelease 0.14.5 Release and requires its exact five-asset file
set. Inside the secret-bearing step it derives the Ed25519 public key and passes
that exact bundle through the production verifier. This authenticates the raw
Catalog, envelope signature, official-channel identity, release metadata,
archive hash, extracted-tree hash, and installer round trip. Missing, extra, or
tampered baseline assets fail before the candidate dry-run or signing operation.

The RC Catalog starts from that authenticated high-water mark: its sequence is
exactly `current 0.14.5 sequence + 1`, and its `issuedAt` is the later of the
current clock and `0.14.5 issuedAt + 1 second`. The authenticated predecessor
sequence and issuance time are supplied to the initial dry-run, build, and
post-build verifier; an initial sequence of `1` is no longer permitted once an
installed channel history exists.

For `release_track=prerelease`, the workflow publishes the RC with GitHub's
prerelease flag and exactly four public assets: archive, Catalog, envelope, and
release metadata. It deliberately does not upload
`open-design-official-channel.json`, does not refresh the 0.14.5 Release, and
does not mutate the stable Catalog/channel. For `release_track=stable`, the
fifth official-channel configuration asset is included only after the stable
Environment approval and exact confirmation have both passed. Stable also
requires successful `acceptance_run_id` and `rollback_gate_run_id` values from
the exact Host `main` SHA being promoted. The already-published RC keeps its
separate immutable source authority at
`6b39a9bcc0f158645897976e23f334c5cab771f4`: every acceptance, rollback, and
stable consumer peels the public RC tag to that commit, requires the GitHub
Release target to match it, and proves it is an ancestor of the Host SHA. The
tag is never moved to make the two authorities appear equal. The fixed
acceptance evidence is composed only from the authenticated machine and visual
producer artifacts. It must prove 20 old-stack tasks, a 20-task new-stack
consecutive pass, 20 blackout/Preview checks, exactly 40 paid Turns, Required
CI, and the update/rollback exercise. The rollback gate downloads and binds
that immutable final evidence to the RC archive SHA-256 and the authenticated
RC Catalog `sequence` and canonical `issuedAt`. It also binds the exact Host
DMG SHA-256 and its successful engineering build run.

For stable promotion, all four public RC assets are required exactly. Because
the prerelease deliberately omits `open-design-official-channel.json`, the
publisher reconstructs that file only in a private temporary verification tree
from the fixed tag and the public key derived in the secret-bearing step. The
normal production verifier then checks the complete RC Catalog/archive/metadata
closure. Its authenticated Catalog state must exactly equal the sequence and
issuance time recorded by both acceptance and rollback evidence. The stable
Catalog sequence is `max(current 0.14.5 sequence, accepted RC sequence) + 1`;
its `issuedAt` is the later of the current clock and one second after the later
authenticated predecessor issuance time.

Stable is rebuilt only from the sealed production input for the Host SHA. The
OpenDesign archive is version-independent; after rebuilding 0.14.6 the workflow
requires its SHA-256 to equal the accepted 0.14.6-rc.1 archive byte-for-byte.
Only the separately signed Catalog, release metadata, filenames, and stable
channel configuration may change. This byte equality closes the two-authority
chain: Host-only commits may advance after the RC source, but a different
Module runtime closure cannot be promoted.

The publisher runs with Node 24.18.0 and installs two independent locked
dependency closures before loading the production CLI: the root Bun workspace
lock provides the internal Module packages and their exact runtime dependencies,
while `modules/open-design/package-lock.json` provides the standalone artifact
policy dependencies. Lifecycle scripts are disabled for both installs. Cleanup
is restricted to the job's private `RUNNER_TEMP` subtree; because the input and
output trees are intentionally sealed read-only, the workflow restores owner
write permission only inside that subtree immediately before deleting it.

## Scheduled and manual refresh

The Linux refresh job runs every 12 hours. A scheduled event is accepted only
when `OPEN_DESIGN_RELEASE_ENABLED=true`; it has no dispatch inputs and always
uses the stable path in `open-design-production`. A fixed newest-first stable
support matrix contains `0.14.6` followed by the `0.14.5` rollback baseline.
The job selects the first tag that already exists as a non-draft,
non-prerelease Release with exactly its five version-bound assets. It therefore
refreshes `0.14.5` before stable promotion and automatically begins refreshing
`0.14.6` after promotion. A present-but-draft, prerelease, duplicate,
asset-incomplete, or otherwise malformed candidate fails closed; only an
actually absent `0.14.6` may fall back to `0.14.5`.

Manual stable refresh keeps the same support matrix, exact existing
version/tag, confirmation
`REFRESH_OPEN_DESIGN_<current version with underscores>`, enable variable, and
`open-design-production` Environment. Manual prerelease refresh is a separate,
narrow path: it accepts only version `0.14.6-rc.1`, tag
`open-design-v0.14.6-rc.1`, and confirmation
`REFRESH_OPEN_DESIGN_0_14_6_RC_1`; it additionally requires
`OPEN_DESIGN_PRERELEASE_ENABLED=true` and approval of the protected
`open-design-prerelease` Environment. It cannot select another prerelease or
modify the stable official-channel configuration.

The resolver obtains one complete GitHub Release listing and uses that same
snapshot to select the exact target. For an RC refresh it rejects any
`open-design-v0.14.6` Release, including a draft or malformed one, validates the
fixed RC Release target against source SHA
`6b39a9bcc0f158645897976e23f334c5cab771f4`, and validates the exact non-draft,
non-prerelease 0.14.5 LKG and its five assets. The RC tag must peel to that same
fixed source SHA and remain an ancestor of the executing Host `main` SHA.

The public RC Release must contain exactly four assets: archive, raw Catalog,
envelope, and release metadata. It must not contain
`open-design-official-channel.json`. The refresh downloads all four RC assets
and all five LKG assets, requires the LKG config to equal the checked-in source
authority, derives the public key from that authority, and authenticates the
LKG before using its Catalog state. At the beginning of the sole secret-bearing
step, the public key derived from the private signing key must equal that
anchored public key. The workflow then authenticates the RC envelope signature
at the signed Catalog's historical issuance time and fails closed unless the
signed Catalog, release metadata, track/version/tag/prerelease flag, key and
validity window, manifest, archive hash and size, extracted-tree metadata, Host
range, URLs, refresh policy, and four-asset set all match exactly. Only after
that authentication does it reconstruct `open-design-official-channel.json`
once inside an owner-only temporary directory for this run's production-CLI
verification. That private file is never uploaded or copied into a public
Release.

Historical verification lets a valid RC whose original 20-hour Catalog window
has already expired be authenticated without weakening current-time install
rules. The RC refresh chooses a sequence strictly greater than both the current
RC and authenticated LKG sequences and an `issuedAt` strictly later than both
issuance times. Final local and remote verification use that cross-track
high-water state, not either predecessor in isolation. The workflow creates a
new 20-hour window, runs the production refresh dry-run, signs the replacement,
and verifies the complete temporary bundle. Initial and refresh jobs share one
non-cancelling concurrency group, so their authenticated snapshots cannot race
one another.

Before starting the 40-Turn acceptance batch, run this exact operational
sequence: refresh stable 0.14.5; refresh RC 0.14.6-rc.1; verify the public RC
Catalog is strictly later than the LKG; create and verify the protected
`open-design-rc-acceptance` Environment; then set
`OPEN_DESIGN_RC_ACCEPTANCE_ENABLED=true` last. Enabling that gate freezes all
scheduled and manual Catalog refreshes, so the evidence batch sees immutable
Catalog state. Complete the batch inside the refreshed 20-hour Catalog window.
After the batch and downstream evidence have finished, disable the acceptance
gate before restoring normal refresh operation. Never refresh either track
during an active batch.

For both tracks, only the raw Catalog, envelope, and release metadata are
replaceable. The archive bytes and SHA-256 must remain unchanged. Before any
temporary candidate is uploaded, the workflow validates the exact public asset
set and changes the Release to draft. While hidden, it downloads that set again
and requires every byte to match the authenticated source snapshot, preventing
a stale refresh from overwriting a concurrent external change. It then uploads
and verifies temporary copies, atomically renames only those three assets,
downloads the exact resulting four-asset RC or five-asset stable set,
reconstructs the private RC config only for local verification, and republishes
only after production verification.
Consequently every publicly visible RC state has exactly four assets. A
pre-verification failure restores the old assets before republishing; a failure
after the new transaction is verified leaves the Release draft for manual
recovery rather than exposing an invalid or partial public state. If a draft or
republish API response is lost, the exit trap re-reads the authoritative remote
draft flag, prerelease flag, and exact asset set. It republishes only an unchanged
exact snapshot; an ambiguous or mismatched state remains hidden and produces an
explicit manual-recovery warning.

## M1 acceptance evidence pipeline

M1 acceptance is split into three non-substitutable evidence producers before
the rollback authorization gate. Each stage authenticates the exact successful
upstream workflow run and artifact instead of accepting caller-supplied hashes
or local file paths:

1. `open-design-m1-machine-evidence.yml` runs on the protected Apple Silicon
   self-hosted runner. It installs the exact unsigned Engineering RC artifact,
   proves that the packaged RC can attach to the external acceptance proxy
   before any paid Turn, then runs the fixed 20 LKG and 20 RC tasks. The batch
   stops at the first failure. Each new-stack task must contain a real 65-second
   business-event blackout with heartbeat continuity and at least one daemon
   event buffered and replayed afterward; it must also prove file mutation,
   the actual Preview URL and HTTP 200 result, one terminal state, primary Host PID
   survival, global hidden/transient/quarantined Session cleanup, and descendant
   process cleanup. Its artifact is an exact 150-file closure named
   `open-design-m1-machine-evidence`.
   If a case fails, the successful closure is never created. The failed run may
   instead upload the separately validated two-file
   `open-design-m1-machine-first-failure` capsule. It contains only fixed
   run/Host identity, stack, case, phase, ordered counters and hashes; it never
   contains prompts, account data, environment values, raw logs, transcripts or
   arbitrary exception text. This diagnostic capsule cannot satisfy any
   downstream acceptance input, and the workflow remains failed after upload.
2. `open-design-m1-visual-attestation.yml` has no provider credential or model
   execution surface. After the product owner has inspected the 20 captured
   Preview images, it authenticates the exact machine artifact and accepts only
   20 ordered PASS decisions bound to those cases and images. Its artifact is
   the exact two-file closure `open-design-m1-visual-attestation`.
3. `open-design-rc-acceptance.yml` authenticates both producer runs, the exact
   Host Engineering RC artifact, current-Host Required CI, RC source/tag/assets,
   LKG, and signed Catalog high-water state. It revalidates both sealed inputs
   and emits only the exact three-file artifact
   `open-design-rc-acceptance-evidence`. It does not run a model, infer a visual
   decision, or accept raw evidence uploaded by the dispatcher.

Activate the stages in that order. Create and API-verify every protected
Environment first. Refresh stable 0.14.5 and then RC 0.14.6-rc.1 before enabling
the machine gate. Set only `OPEN_DESIGN_M1_MACHINE_EVIDENCE_ENABLED=true`, run
and preserve the successful machine run, then set it back to `false`. Enable
the visual gate only while sealing the already-reviewed decisions; disable it
after the artifact is created. Finally enable the RC acceptance gate only while
composing the final evidence, then disable it before Catalog refresh resumes.
Never enable multiple producer stages merely to shorten the sequence, never
refresh either Catalog during the paid batch, and never retry within a failed
40-Turn batch. A repaired new path starts its 20-consecutive-pass count again.

## Debug and acceptance rollback gate

`open-design-acceptance-rollback.yml` is a manual, read-only authorization and
evidence seam. It runs only when both `debug_enabled` and
`acceptance_approved` are true, the exact rollback confirmation is supplied,
the repository variable `OPEN_DESIGN_ACCEPTANCE_ROLLBACK_ENABLED` is exactly
`true`, and the protected `open-design-acceptance-rollback` Environment is
approved.
It verifies the successful acceptance run, the four-asset 0.14.6 RC
prerelease, and the 0.14.5 non-prerelease LKG.

The evidence run must come from the fixed workflow path
`.github/workflows/open-design-rc-acceptance.yml`, use `workflow_dispatch`, and
match the gate's exact final Host `main` SHA. The protected
`open-design-rc-acceptance` Environment and the explicit
`OPEN_DESIGN_RC_ACCEPTANCE_ENABLED=true` repository gate are both required;
an absent or unconfigured Environment must never be treated as approval. The
public RC tag is independently peeled to its immutable source SHA, which must
be an ancestor of that Host SHA.

After validation the rollback gate uploads a checksum-protected, non-mutating
evidence artifact containing the final acceptance run ID, Host artifact
identity, machine/visual producer references, RC source SHA, RC archive hash,
RC Catalog sequence/issuedAt, and LKG/RC tags. The final acceptance artifact is
the exact three-file closure containing the cross-bound summary, producer
references, and checksum manifest. The stable publisher independently downloads
both evidence artifacts and all four public RC assets; it does not trust a
manual hash or trust-state input.

The workflow intentionally cannot edit Releases, Catalogs, channels, or expose
a normal-user version selector. The actual installed-app update and rollback
exercise occurs upstream in the machine evidence producer through the existing
Module Coordinator transaction. This gate independently authenticates that
sealed evidence and authorizes the stable publisher; it does not itself mutate
the installed app and must not be described as a second rollback execution.

No real publication should be attempted until the production key, Environment,
repository enable variable, public redistribution evidence, and a successful
current-SHA production-input run have been configured and independently
reviewed.
