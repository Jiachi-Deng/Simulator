import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
const path = join(root, ".github/workflows/open-design-release.yml")
const source = readFileSync(path, "utf8")
const workflow = Bun.YAML.parse(source) as Record<string, any>
const productionReleaseGuide = readFileSync(join(root, "modules/open-design/package/PRODUCTION_RELEASE.md"), "utf8")
const operatorReleaseGuide = readFileSync(join(root, ".github/workflows/open-design-release.md"), "utf8")

function step(jobName: string, name: string): Record<string, any> {
  const found = workflow.jobs[jobName].steps.find((candidate: Record<string, any>) => candidate.name === name)
  if (!found) throw new Error(`Missing ${jobName} step: ${name}`)
  return found
}

describe("OpenDesign release-track safety", () => {
  test("locks the public RC and stable identities to version-consistent tags", () => {
    const inputs = workflow.on.workflow_dispatch.inputs
    expect(inputs.release_track.options).toEqual(["prerelease", "stable"])
    expect(inputs.release_track.default).toBe("prerelease")
    expect(inputs.module_version.default).toBe("0.14.6-rc.1")
    expect(inputs.release_tag.default).toBe("open-design-v0.14.6-rc.1")
    expect(workflow.jobs.initial.if).toContain("vars.OPEN_DESIGN_RC_ACCEPTANCE_ENABLED != 'true'")

    const authority = step("initial", "Validate fixed release authority").run
    expect(authority).toContain('test "$RELEASE_TAG" = "open-design-v$MODULE_VERSION"')
    expect(authority).toContain('test "$MODULE_VERSION" = "0.14.6-rc.1"')
    expect(authority).toContain('test "$RELEASE_TAG" = "open-design-v0.14.6-rc.1"')
    expect(authority).toContain('test "$GITHUB_SHA" = "$RC_SOURCE_SHA"')
    expect(authority).toContain('test "$MODULE_VERSION" = "0.14.6"')
    expect(authority).toContain('test "$RELEASE_TAG" = "open-design-v0.14.6"')
  })

  test("publishes RC as a GitHub prerelease without its stable-channel configuration", () => {
    const publish = step("initial", "Publish fixed-tag release through a draft transaction").run
    const prereleaseBranch = publish.slice(
      publish.indexOf('if [[ "$RELEASE_TRACK" = prerelease ]]'),
      publish.indexOf("else", publish.indexOf('if [[ "$RELEASE_TRACK" = prerelease ]]')),
    )
    const stableBranch = publish.slice(
      publish.indexOf("else", publish.indexOf('if [[ "$RELEASE_TRACK" = prerelease ]]')),
      publish.indexOf("fi", publish.indexOf('if [[ "$RELEASE_TRACK" = prerelease ]]')),
    )
    expect(prereleaseBranch).toContain("release_flags+=(--prerelease)")
    expect(prereleaseBranch).not.toContain('publish_assets+=("$INITIAL_OUTPUT/$CONFIG_ASSET")')
    expect(stableBranch).toContain('publish_assets+=("$INITIAL_OUTPUT/$CONFIG_ASSET")')
    expect(publish).toContain('[[ "$RELEASE_TRACK" = prerelease ]] || expected_assets+=("$CONFIG_ASSET")')
    expect(publish).toContain('"${release_flags[@]}"')
    expect(publish).toContain('"${publish_assets[@]}"')
    expect(publish).toContain("--json tagName,isDraft,isPrerelease,assets")
    expect(publish).toContain('test "$(jq -r .isPrerelease <<<"$release_state")" = true')
    expect(publish).toContain('test "$(jq -r .isPrerelease <<<"$release_state")" = false')
    expect(publish).not.toContain("gh release upload")
    expect(publish).not.toContain("open-design-v0.14.5")
    expect(productionReleaseGuide).toContain("prerelease `0.14.6-rc.1` uploads exactly the archive, Catalog, envelope, and")
    expect(productionReleaseGuide).toContain("is never published, and is never copied into")
    expect(productionReleaseGuide).toContain("Only a stable publication may promote its official-channel config")
  })

  test("requires stable enablement, an exact confirmation, and the protected stable environment", () => {
    const initial = workflow.jobs.initial
    expect(initial.env.HOST_VERSION_RANGE).toBe(">=0.12.0")
    expect(initial.if).toContain("inputs.release_track == 'stable'")
    expect(initial.if).toContain("vars.OPEN_DESIGN_RELEASE_ENABLED == 'true'")
    expect(initial.if).toContain("vars.OPEN_DESIGN_STABLE_CHANNEL_ENABLED == 'true'")
    expect(initial.environment.name).toBe("${{ inputs.release_track == 'stable' && 'open-design-production' || 'open-design-prerelease' }}")
    const authority = step("initial", "Validate fixed release authority").run
    expect(authority).toContain('test "$HOST_VERSION_RANGE" = ">=0.12.0"')
    expect(authority).toContain('test "$STABLE_CHANNEL_CONFIRMATION" = "PROMOTE_OPEN_DESIGN_0_14_6"')
    expect(authority).toContain('test -z "$STABLE_CHANNEL_CONFIRMATION"')
  })

  test("binds stable publication to the accepted RC bytes and rollback evidence", () => {
    const inputs = workflow.on.workflow_dispatch.inputs
    expect(inputs.acceptance_run_id.required).toBe(false)
    expect(inputs.rollback_gate_run_id.required).toBe(false)
    const authority = step("initial", "Validate fixed release authority").run
    expect(authority).toContain('[[ "$ACCEPTANCE_RUN_ID" =~ ^[1-9][0-9]*$ ]]')
    expect(authority).toContain('[[ "$ROLLBACK_GATE_RUN_ID" =~ ^[1-9][0-9]*$ ]]')
    expect(authority).toContain('test -z "$ACCEPTANCE_RUN_ID"')
    expect(authority).toContain('test -z "$ROLLBACK_GATE_RUN_ID"')

    const evidence = step("initial", "Validate stable acceptance, rollback, and RC closure")
    expect(evidence.if).toBe("${{ env.RELEASE_TRACK == 'stable' }}")
    expect(evidence.run).toContain(".github/workflows/open-design-rc-acceptance.yml")
    expect(evidence.run).toContain(".github/workflows/open-design-acceptance-rollback.yml")
    expect(evidence.run).toContain("open-design-rc-acceptance-evidence")
    expect(evidence.run).toContain("open-design-rollback-gate-evidence")
    expect(evidence.run).toContain(".oldStackTasksPassed == 20")
    expect(evidence.run).toContain(".newStackConsecutivePassed == 20")
    expect(evidence.run).toContain(".paidTurns == 40")
    expect(evidence.run).toContain(".previewHumanPasses == 20")
    expect(evidence.run).toContain(".schemaVersion == 2")
    expect(evidence.run).toContain(".hostHeadSha == $hostHeadSha")
    expect(evidence.run).toContain(".rcSourceSha == $rcSourceSha")
    expect(evidence.run).toContain("hostArtifactSha256")
    expect(evidence.run).toContain("hostBuildRunId")
    expect(evidence.run).toContain("open-design-rc-acceptance-intake.json")
    expect(evidence.run).toContain("evidenceBundleSha256")
    expect(evidence.run).toContain("machineEvidence")
    expect(evidence.run).toContain("visualEvidence")
    expect(evidence.run).toContain('test "$(wc -l < "$acceptance/SHA256SUMS" | tr -d \' \')" = 2')
    expect(evidence.run).toContain('test "$(find "$acceptance" -maxdepth 1 -type f | wc -l | tr -d \' \')" = 3')
    expect(evidence.run).toContain("requiredCiPassed == true")
    expect(evidence.run).toContain("ACCEPTED_RC_ARCHIVE_SHA256")
    expect(evidence.run).toContain("rcCatalogSequence")
    expect(evidence.run).toContain("rcCatalogIssuedAt")
    expect(evidence.run).toContain("ACCEPTED_RC_CATALOG_SEQUENCE")
    expect(evidence.run).toContain("ACCEPTED_RC_CATALOG_ISSUED_AT")
    expect(evidence.run).toContain('test "$actual_rc" = "$expected_rc"')
    expect(evidence.run).toContain('git rev-parse "refs/tags/$RC_RELEASE_TAG^{commit}"')
    expect(evidence.run).toContain('git merge-base --is-ancestor "$RC_SOURCE_SHA" "$GITHUB_SHA"')
    expect(evidence.run).toContain('.targetCommitish <<<"$rc_state")" = "$RC_SOURCE_SHA"')
    const verify = step("initial", "Verify initial bundle before publication").run
    expect(verify).toContain('shasum -a 256 "$INITIAL_OUTPUT/$ARCHIVE_ASSET"')
    expect(verify).toContain('= "$ACCEPTED_RC_ARCHIVE_SHA256"')
  })

  test("derives RC and stable Catalog state strictly above authenticated predecessors", () => {
    const initial = workflow.jobs.initial
    expect(initial.env.LKG_RELEASE_TAG).toBe("open-design-v0.14.5")
    expect(initial.env.RC_RELEASE_TAG).toBe("open-design-v0.14.6-rc.1")
    const build = step("initial", "Authenticate prior state, dry-run, and build signed initial assets").run
    expect(build).toContain("const priorSequence = Math.max(...sequences);")
    expect(build).toContain("const priorIssuedAtMs = Math.max(...issuedAtValues);")
    expect(build).toContain("const sequence = priorSequence + 1;")
    expect(build).toContain("const issuedAtMs = Math.max(Date.now(), priorIssuedAtMs + 1000);")
    expect(build).toContain('if (process.env.RELEASE_TRACK === "stable")')
    expect(build).toContain("sequences.push(parseSequence(process.env.RC_SEQUENCE, \"RC sequence\"));")
    expect(build).toContain("issuedAtValues.push(parseTimestamp(process.env.RC_ISSUED_AT, \"RC issuedAt\"));")
    expect(build.match(/--previous-sequence "\$PRIOR_SEQUENCE"/g)).toHaveLength(2)
    expect(build.match(/--previous-issued-at "\$PRIOR_ISSUED_AT"/g)).toHaveLength(2)
    const verify = step("initial", "Verify initial bundle before publication").run
    expect(verify).toContain('--previous-sequence "$PRIOR_SEQUENCE"')
    expect(verify).toContain('--previous-issued-at "$PRIOR_ISSUED_AT"')
  })

  test("refreshes stable or the fixed prerelease with track-appropriate monotonic authority", () => {
    expect(workflow.env.RELEASE_TAG).toBeUndefined()
    expect(workflow.env.MODULE_VERSION).toBeUndefined()
    expect(workflow.jobs.refresh.environment.name).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.release_track == 'prerelease' && 'open-design-prerelease' || 'open-design-production' }}",
    )
    expect(workflow.jobs.refresh.if).toContain("github.event_name == 'schedule'")
    expect(workflow.jobs.refresh.if).toContain("inputs.operation == 'refresh'")
    expect(workflow.jobs.refresh.if).toContain("inputs.release_track == 'stable'")
    expect(workflow.jobs.refresh.if).toContain("inputs.release_track == 'prerelease'")
    expect(workflow.jobs.refresh.if).toContain("vars.OPEN_DESIGN_RELEASE_ENABLED == 'true'")
    expect(workflow.jobs.refresh.if).toContain("vars.OPEN_DESIGN_PRERELEASE_ENABLED == 'true'")
    expect(workflow.jobs.refresh.if).toContain("vars.OPEN_DESIGN_RC_ACCEPTANCE_ENABLED != 'true'")
    const resolver = step("refresh", "Resolve exact refresh target").run
    expect(resolver).toContain("release_pages=$(gh api --paginate --slurp")
    expect(resolver.match(/releases\?per_page=100/g)).toHaveLength(1)
    expect(resolver).not.toContain("if gh ")
    expect(resolver).toContain("stable_matching_count=$(jq")
    expect(resolver).toContain('select(.tag_name == "open-design-v0.14.6")')
    expect(resolver).toContain('test "$stable_matching_count" = 0')
    expect(resolver).toContain('lkg_matching_count=$(jq')
    expect(resolver).toContain('test "$lkg_matching_count" = 1')
    expect(resolver).toContain('selected_version="0.14.6-rc.1"')
    expect(resolver).toContain('test "$(jq -r .targetCommitish <<<"$release_state")" = "$RC_SOURCE_SHA"')
    expect(resolver).toContain("RELEASE_TARGET_COMMITISH=%s")
    expect(resolver).toContain('candidate_versions=("0.14.6" "0.14.5")')
    expect(resolver.indexOf('"0.14.6"')).toBeLessThan(resolver.indexOf('"0.14.5"'))
    expect(resolver).toContain('test -z "$DISPATCH_RELEASE_TRACK"')
    expect(resolver).toContain('selected_version="0.14.6-rc.1"')
    expect(resolver).toContain('release_track="prerelease"')
    expect(resolver).toContain('config_required="false"')
    expect(resolver).toContain('test "$(jq -r .isDraft <<<"$release_state")" = false')
    expect(resolver).toContain('test "$(jq -r .isPrerelease <<<"$release_state")" = "$expected_prerelease"')
    expect(resolver).toContain('test "$actual" = "$expected"')
    expect(resolver).toContain('test -n "$selected_version"')
    const authority = step("refresh", "Validate fixed refresh authority").run
    expect(authority).toContain('test "$DISPATCH_MODULE_VERSION" = "$MODULE_VERSION"')
    expect(authority).toContain('test "$DISPATCH_RELEASE_TAG" = "$RELEASE_TAG"')
    expect(authority).toContain('git rev-parse "refs/tags/$RELEASE_TAG^{commit}"')
    expect(authority).toContain('test "$STABLE_CHANNEL_CONFIRMATION" = "$expected_confirmation"')
    expect(authority).toContain('test "$RELEASE_TARGET_COMMITISH" = "$RC_SOURCE_SHA"')
    expect(authority).toContain('test "$STABLE_CHANNEL_CONFIRMATION" = "REFRESH_OPEN_DESIGN_0_14_6_RC_1"')
    expect(authority).toContain('test "$PUBLIC_ASSET_COUNT" = 4')
    expect(authority).toContain('test "$PUBLIC_ASSET_COUNT" = 5')
    const derive = step("refresh", "Derive monotonic refresh state and bounded window").run
    expect(derive).toContain('highWaterSequence = Math.max(highWaterSequence, baselineSequence)')
    expect(derive).toContain('highWaterIssuedAtMs = Math.max(highWaterIssuedAtMs, baselineIssuedAtMs)')
    expect(derive).toContain('VERIFY_PREVIOUS_SEQUENCE=${highWaterSequence}')
    expect(derive).toContain('VERIFY_PREVIOUS_ISSUED_AT=${new Date(highWaterIssuedAtMs).toISOString()}')
    expect(derive).toContain('CATALOG_SEQUENCE=${highWaterSequence + 1}')
    expect(productionReleaseGuide).toContain("advances from the\nauthenticated Catalog on its selected stable tag")
    expect(productionReleaseGuide).toContain("takes the highest authenticated `sequence` and `issuedAt` across the\ncurrent RC and stable `0.14.5` Catalogs")
    expect(productionReleaseGuide).not.toContain("Both tracks obtain the highest authenticated cross-track")
    expect(productionReleaseGuide).toContain("refresh stable first and prerelease second")
    expect(productionReleaseGuide).toContain("compare both public Catalogs again under that freeze")
    expect(productionReleaseGuide).toContain("Equality or reversed\nordering is a pre-Turn stop condition")
    expect(operatorReleaseGuide).toContain("First set `OPEN_DESIGN_RC_ACCEPTANCE_ENABLED=true` as the\nCatalog refresh freeze")
    expect(operatorReleaseGuide).toContain("keep it true through machine, visual, final acceptance,\nand rollback evidence")
    expect(operatorReleaseGuide).toContain("finally disable `OPEN_DESIGN_RC_ACCEPTANCE_ENABLED` before\nCatalog refresh resumes")
    expect(operatorReleaseGuide).not.toContain("Finally enable the RC acceptance gate only while")
  })

  test("anchors the signing key before source verification and keeps the RC config private", () => {
    const signedRefresh = step("refresh", "Authenticate source, dry-run, and create signed refresh assets").run
    expect(signedRefresh).toContain("verifyModuleReleaseCatalog")
    expect(signedRefresh).toContain('metadata.trustedKey.publicKey !== publicKeyBase64')
    expect(signedRefresh).toContain('writeFileSync(join(process.env.REFRESH_INPUT, process.env.CONFIG_ASSET)')
    expect(signedRefresh.match(/PRIVATE_DERIVED_PUBLIC=/g)).toHaveLength(1)
    const keyComparison = signedRefresh.indexOf('cmp "$PUBLIC_KEY_FILE" "$REFRESH_WORK/private-derived-public.pem"')
    expect(keyComparison).toBeGreaterThan(0)
    expect(keyComparison).toBeLessThan(signedRefresh.indexOf("verifyModuleReleaseCatalog"))
    expect(keyComparison).toBeLessThan(signedRefresh.indexOf("--dry-run"))
    expect(keyComparison).toBeLessThan(signedRefresh.indexOf("--private-key-env OPEN_DESIGN_RELEASE_PRIVATE_KEY"))

    const transaction = step("refresh", "Replace only refresh assets through a draft rollback transaction").run
    expect(transaction).toContain('public_assets=("$ARCHIVE_ASSET" "$CATALOG_ASSET" "$ENVELOPE_ASSET" "$METADATA_ASSET")')
    expect(transaction).toContain('[[ "$CONFIG_REQUIRED" = false ]] || public_assets+=("$CONFIG_ASSET")')
    expect(transaction).toContain('test "$(find "$remote" -maxdepth 1 -type f | wc -l | tr -d \' \')" = "$PUBLIC_ASSET_COUNT"')
    expect(transaction).toContain('test ! -e "$remote/$CONFIG_ASSET"')
    expect(transaction).toContain('cp "$REFRESH_INPUT/$CONFIG_ASSET" "$remote/$CONFIG_ASSET"')
    expect(transaction.indexOf('--draft=true')).toBeLessThan(transaction.indexOf('gh release upload "$RELEASE_TAG"'))
    expect(transaction).toContain('hide_requested=1')
    expect(transaction).toContain('Draft transition response was lost')
    expect(transaction).toContain('Republish response was lost')
    expect(transaction).toContain('--json isDraft,isPrerelease,assets')
    expect(transaction).toContain('cmp "$SOURCE_BUNDLE/$asset" "$preflight/$asset"')
    expect(transaction.indexOf('cmp "$SOURCE_BUNDLE/$asset" "$preflight/$asset"')).toBeLessThan(transaction.indexOf('gh release upload "$RELEASE_TAG"'))
    expect(transaction).not.toContain('gh release upload "$RELEASE_TAG" "$REFRESH_INPUT/$CONFIG_ASSET"')
    expect(transaction).toContain('cmp "$SOURCE_BUNDLE/$ARCHIVE_ASSET" "$remote/$ARCHIVE_ASSET"')
  })
})
