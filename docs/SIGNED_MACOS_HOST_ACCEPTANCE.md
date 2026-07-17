# Signed macOS Host acceptance architecture

Status: **dormant / fail closed**. This path is an M1 acceptance producer, not a public stable-channel publisher.

## Trust and execution boundary

The workflow is manually dispatched from the exact current `main` commit. It cannot run unless all of these independent gates agree:

- the dispatch ref and requested source SHA are the current remote `main` SHA;
- `github.run_attempt` is exactly `1`;
- repository variable `SIMULATOR_SIGNED_HOST_ACCEPTANCE_ENABLED` is exactly `true`;
- the OpenDesign acceptance freeze `OPEN_DESIGN_RC_ACCEPTANCE_ENABLED` remains exactly `true`, and the workflow shares the `open-design-release-transaction` lane with Catalog release/refresh;
- the `signed-host-acceptance` protected Environment admits the job;
- an exact successful first-attempt `open-design-rc-acceptance.yml` run and its non-expired final Artifact are supplied and authenticated;
- all Apple credential secret names are present;
- expected Developer ID Application subject, Team ID, Bundle ID, and the unsigned baseline DMG SHA-256 are supplied explicitly.

The final OpenDesign acceptance Artifact is downloaded as a raw digest-bound ZIP, safely extracted as an exact three-file closure, and its summary is regenerated from the complete intake. That regenerated evidence must prove 40 paid Turns, 20 consecutive new-stack passes, 20 human Preview passes, Required CI and rollback; its Host build run ID, Host SHA, and DMG SHA-256 must match the same exact Engineering RC selected for signing. The second OIDC job independently repeats this authentication and cross-binding before attestation.

The repository does not define the production certificate subject or Team ID. Although the exact artifact already carries a Bundle ID from `electron-builder.yml`, this workflow neither hard-codes nor infers which Bundle ID is finally approved: the expected certificate subject, Team ID, and Bundle ID are dispatch parameters, the supplied Bundle ID must equal the exact artifact's actual Bundle ID, and all three values become non-secret provenance. Apple credentials are not exposed to any step until the Engineering RC and final OpenDesign acceptance evidence have both been authenticated and cross-bound. They are then written only to an owner-only temporary keychain/key file and are never printed. The signing job destroys them before it invokes `upload-artifact`; a second idempotent `always()` cleanup is only the failure fallback.

The protected signing/notarization job has read-only repository permissions and no OIDC permission. It hands off an exact secret-free pre-attestation closure to a second job. The second job has no protected Environment and no Apple secret references; it authenticates the current workflow run and exact Artifact ID/name/API digest, downloads the raw Artifact ZIP, verifies the raw SHA-256, and safely extracts an exact closure. Before invoking `actions/attest`, that second job also independently downloads and verifies the exact Engineering RC, mounts the Candidate DMG, extracts the Candidate ZIP, directly reruns signature, Gatekeeper, stapler, pinned-runtime, privacy and updater checks, and recomputes both payload-equivalence reports against the Engineering RC. Producer-generated JSON is therefore evidence to compare, not the finalizer's trust root.

## Build and notarization order

```text
exact main + authenticated Engineering RC + regenerated 40-Turn/H2 acceptance evidence
  -> prove acceptance Host run/DMG/source equals the Engineering RC
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

The final Artifact contains signed-only checksums, a strict manifest, a local provenance record, the exact final OpenDesign acceptance run/Artifact/summary reference, signature reports, notarization result summaries, a combined report that independently binds both the DMG-extracted and ZIP-extracted App to the same Engineering RC payload, and an OIDC attestation bundle. All transport digests are calculated after app and DMG stapling.

H3 uses a two-stage, owner-only evidence handoff on the clean installation environment. Stage 1 emits an exact three-file closure (`SHA256SUMS`, `post-install-authority.json`, `post-install.json`); Stage 2 seals the three human observations only after independently reopening that closure and re-authenticating its GitHub authority. The contracts contain only product identity, Artifact lineage, OS version, installed path, machine-derived verification decisions, backup/restore state, and screenshot hashes. They reject unknown fields, non-canonical timestamps, non-absolute paths, non-SHA-256 digests, negative verification results, and secret-shaped keys.

The Stage-1 H3 generator does not accept caller-reported GitHub IDs/digests, signature, Gatekeeper, notarization, stapling, product identity, DMG hash, or backup hash results. Its inputs are:

- the raw ZIP returned by GitHub Actions for the final signed Candidate Artifact;
- the exact DMG used for Finder installation;
- an owner-only human-input JSON containing only `environmentKind`, `existingAppBeforeInstall`, `backupPath`, and `restoreStatus`.

The production generator invokes the fixed `/opt/homebrew/bin/gh` executable on macOS arm64. Every `gh api` call explicitly supplies `--hostname github.com`, uses a fixed minimal child environment and timeout, redacts bounded failure diagnostics, and requires the executable realpath/version/byte hash to remain identical before and after the call. It derives the Candidate run from the safely extracted signed manifest, then re-queries the GitHub workflow-run and Artifact APIs and requires the exact repository, `main` source SHA, workflow path/name, run attempt, successful conclusion, Artifact ID/name/service digest, and non-expired state. It independently streams the raw ZIP SHA-256 and requires it to equal the service digest, safely extracts the exact `signed-host-final` closure, verifies its manifest/checksums and Candidate DMG, and requires the separately retained DMG to match the closure's DMG bytes and hash. It then runs DMG preflight/verification, stapler and Gatekeeper checks; mounts the DMG read-only; compares its App to `/Applications/Simulator.app` using exact-tree and normalized payload inventories; and directly runs strict deep `codesign`, Gatekeeper, stapler, Developer ID, Bundle ID, Team ID, and version checks. A supplied backup path is also inspected and hashed locally.

All non-GitHub H3 child processes use a separate fixed macOS boundary: `/usr/bin/shasum`, `/usr/bin/python3`, `/usr/bin/hdiutil`, `/usr/bin/xcrun`, `/usr/sbin/spctl`, `/usr/bin/codesign`, `/usr/bin/sw_vers`, and `/usr/libexec/PlistBuddy`. They run without a shell from `/`, with a fixed system `PATH` and locale and without inherited token, proxy, custom-CA, debug, Python-path, Developer-directory, codesign-tool, or dynamic-loader controls. The shared invocation layer unconditionally inserts Python's `-S` flag before every Python call while keeping the script path next, and also fixes `PYTHONNOUSERSITE=1`, so a real user `HOME` cannot activate user-site `.pth` files or `sitecustomize`. Light commands are bounded to 30 seconds and 1 MiB per output stream; archive, filesystem, trust, mount, and comparison commands are bounded to 300 seconds and 64 MiB. Failures expose only bounded, redacted diagnostics. DMG detach and restored-App exact-tree verification use the same boundary; production Inspectors do not accept a child-process runner override.

```text
bun scripts/release/h3-post-install-authority.ts generate \
  RAW_CANDIDATE_ARTIFACT.zip Simulator-arm64.dmg \
  post-install-human-input.json EMPTY_POST_INSTALL_AUTHORITY_DIR
```

After the three human observations, but before the Candidate is moved or a previous App is restored, production must reopen the exact Stage-1 three-file closure and run the non-injectable live gate. This command always uses `systemH3PostInstallInspector`; it re-authenticates the raw GitHub Artifact, re-inspects the retained DMG and `/Applications/Simulator.app`, and compares the complete regenerated `post-install.json` value to the sealed record. Its reported `authoritySha256` is frozen as `EXPECTED_STAGE1_AUTHORITY_SHA256`:

```text
bun scripts/release/h3-post-install-authority.ts pre-restore-verify \
  POST_INSTALL_AUTHORITY_DIR RAW_CANDIDATE_ARTIFACT.zip \
  Simulator-arm64.dmg post-install-human-input.json
```

Stage 2 accepts the Stage-1 directory, the same raw Artifact archive, and that explicit expected Stage-1 authority SHA-256. Both its producer and final verifier independently re-query GitHub, revalidate the raw Candidate plus exact Stage-1 closure, and reject any authority-hash mismatch before accepting the post-install claims. It deliberately does not inspect the Candidate App after the product owner has restored the pre-existing App; recovery is instead proven by the separate exact-tree backup identity check. Screenshots must be owner-only, single-page non-animated PNGs within fixed byte/dimension/pixel bounds. Before copying them into evidence, the producer fully decodes their pixels with pinned `sharp` 0.34.5 and re-encodes a metadata-free PNG; it then decodes the result again and requires pixel equality.

```text
bun scripts/release/h3-human-observation-evidence.ts generate \
  POST_INSTALL_AUTHORITY_DIR RAW_CANDIDATE_ARTIFACT.zip \
  EXPECTED_STAGE1_AUTHORITY_SHA256 \
  human-observation-input.json EMPTY_HUMAN_EVIDENCE_DIR

bun scripts/release/h3-human-observation-evidence.ts validate \
  HUMAN_EVIDENCE_DIR POST_INSTALL_AUTHORITY_DIR \
  RAW_CANDIDATE_ARTIFACT.zip EXPECTED_STAGE1_AUTHORITY_SHA256
```

The exact Stage-1 closure is three files:

```text
SHA256SUMS
post-install-authority.json
post-install.json
```

The exact Stage-2 human closure is five files:

```text
SHA256SUMS
human-observation.json
screenshots/CraftVisible.png
screenshots/OpenDesignModuleEntryVisible.png
screenshots/OpenDesignSecondLoginAbsent.png
```
