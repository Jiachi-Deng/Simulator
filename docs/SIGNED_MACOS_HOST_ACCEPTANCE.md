# Signed macOS Host acceptance architecture

Status: **dormant / fail closed**. This path is an M1 acceptance producer, not a public stable-channel publisher.

## Trust and execution boundary

The workflow is manually dispatched from the exact current `main` commit. It cannot run unless all of these independent gates agree:

- the dispatch ref and requested source SHA are the current remote `main` SHA;
- `github.run_attempt` is exactly `1`;
- repository variable `SIMULATOR_SIGNED_HOST_ACCEPTANCE_ENABLED` is exactly `true`;
- the `signed-host-acceptance` protected Environment admits the job;
- all Apple credential secret names are present;
- expected Developer ID Application subject, Team ID, Bundle ID, and the unsigned baseline DMG SHA-256 are supplied explicitly.

The repository does not define the production certificate subject or Team ID. Although the exact artifact already carries a Bundle ID from `electron-builder.yml`, this workflow neither hard-codes nor infers which Bundle ID is finally approved: the expected certificate subject, Team ID, and Bundle ID are dispatch parameters, the supplied Bundle ID must equal the exact artifact's actual Bundle ID, and all three values become non-secret provenance. Apple credentials are written only to an owner-only temporary keychain/key file and are never printed. The signing job destroys them before it invokes `upload-artifact`; a second idempotent `always()` cleanup is only the failure fallback.

The protected signing/notarization job has read-only repository permissions and no OIDC permission. It hands off an exact secret-free pre-attestation closure to a second job. The second job has no protected Environment and no Apple secret references; it authenticates the current workflow run and exact Artifact ID/name/API digest, downloads the raw Artifact ZIP, verifies the raw SHA-256, safely extracts an exact closure, and only then receives `id-token: write` / `attestations: write` to create provenance.

## Build and notarization order

```text
exact main source + authenticated Engineering RC App bytes
  -> re-sign that exact App with Developer ID (no payload rebuild)
  -> verify every nested Mach-O + entitlements + pinned runtimes
  -> notarize App archive -> staple and validate App
  -> package the stapled App into new ZIP and DMG
  -> notarize DMG -> staple and validate DMG
  -> extract both final containers and independently reverify App
  -> Gatekeeper assess App and DMG
  -> signed-only manifest + combined DMG/ZIP equivalence report
  -> destroy Apple credentials -> raw digest-bound Artifact handoff
  -> separate secret-free OIDC job -> checksums and attestation
```

The app ticket is stapled before the final containers are produced. The DMG is submitted and stapled separately. The authenticated unsigned Engineering RC is downloaded as the immutable payload baseline, but it is never promoted as the signed Candidate. Its DMG/ZIP SHA-256 values also remain negative trust inputs: both final signed transports must have different digests.

## Verification modes

The existing macOS verifiers retain `unsigned` as their default mode for Engineering RCs. The new explicit `developer-id` mode additionally requires:

- an exact leaf certificate subject and Team ID on the app and every nested Mach-O;
- secure timestamp and hardened-runtime flags on every signed code object;
- exact expected Bundle ID on the app;
- app entitlements equal the reviewed plist, while nested code may have reduced/no entitlements but can only use the reviewed keys and Apple-injected team/application identifiers;
- pinned Bun and uv raw bytes reconstructed under fixed SHA-256/size anchors, independently ad-hoc signed under the reviewed entitlements, and compared to the Developer ID object through deterministic terminal `LC_CODE_SIGNATURE`/signature-dependent `__LINKEDIT` normalization. Developer ID CDHash or a second secure timestamp is never used as a reproducibility oracle.

No verifier infers or accepts an Apple identity from ambient Keychain state.

## Evidence boundary

The final Artifact contains signed-only checksums, a strict manifest, a local provenance record, signature reports, notarization result summaries, a combined report that independently binds both the DMG-extracted and ZIP-extracted App to the same Engineering RC payload, and an OIDC attestation bundle. All transport digests are calculated after app and DMG stapling.

H3 post-install evidence is a separate owner-only JSON record generated on the clean installation environment. Its schema contains only product identity, Artifact lineage, OS version, installed path, machine-derived verification decisions, and backup/restore state. It rejects unknown fields, non-canonical timestamps, non-absolute paths, non-SHA-256 digests, negative verification results, and secret-shaped keys.

The H3 generator does not accept caller-reported signature, Gatekeeper, notarization, stapling, product identity, DMG hash, or backup hash results. Its inputs are:

- the raw ZIP returned by GitHub Actions for the final signed Candidate Artifact;
- the exact DMG used for Finder installation;
- an owner-only authority JSON containing exactly `artifactName`, `artifactId`, `artifactDigest`, and `runId`;
- an owner-only human-input JSON containing only `environmentKind`, `existingAppBeforeInstall`, `backupPath`, and `restoreStatus`.

Before creating evidence, the operator/AI must authenticate the authority JSON against the GitHub Actions Artifact API. `artifactDigest` is the service-reported digest and cannot be inferred from an already extracted directory. The generator independently streams the raw ZIP SHA-256 and requires it to equal that authenticated digest, safely extracts the exact `signed-host-final` closure, verifies its manifest/checksums, and requires the separately retained DMG to match the closure's DMG bytes and hash. It then runs DMG preflight/verification, stapler and Gatekeeper checks; mounts the DMG read-only; compares its App to `/Applications/Simulator.app` using exact-tree and normalized payload inventories; and directly runs strict deep `codesign`, Gatekeeper, stapler, Developer ID, Bundle ID, Team ID, and version checks. A supplied backup path is also inspected and hashed locally.

```text
bun scripts/release/h3-post-install-evidence.ts generate \
  RAW_CANDIDATE_ARTIFACT.zip Simulator-arm64.dmg \
  artifact-authority.json human-input.json post-install-evidence.json
```

The `validate` operation checks canonical storage and schema only; it is not a substitute for the system verification performed by `generate`.
