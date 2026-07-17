import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { ENGINEERING_RC_NAME_PATTERN, SIGNED_CANDIDATE_CLOSURE, SIGNED_CANDIDATE_NAME_PATTERN } from "./signed-host-candidate"

const path = ".github/workflows/signed-macos-host-acceptance.yml"
const source = readFileSync(path, "utf8")
const workflow = parse(source) as Record<string, any>
const staticValidation = readFileSync(".github/workflows/release-static-validation.yml", "utf8")
const dispatch = workflow.on.workflow_dispatch
const buildJob = workflow.jobs["build-signed-candidate"]
const finalizerJob = workflow.jobs["finalize-signed-candidate"]

function step(job: Record<string, any>, name: string): Record<string, any> {
  const value = job.steps.find((candidate: Record<string, any>) => candidate.name === name)
  if (!value) throw new Error(`Missing signed Host workflow step: ${name}`)
  return value
}

const buildStep = (name: string) => step(buildJob, name)
const finalizerStep = (name: string) => step(finalizerJob, name)

describe("dormant signed macOS Host acceptance workflow", () => {
  test("is manual, exact-main-only, first-attempt-only, protected, and dormant by repository variable", () => {
    expect(workflow.on.workflow_dispatch).toBeDefined()
    expect(workflow.on.push).toBeUndefined()
    expect(workflow.on.pull_request).toBeUndefined()
    expect(workflow.on.schedule).toBeUndefined()
    expect(buildJob.if).toContain("github.ref == 'refs/heads/main'")
    expect(buildJob.if).toContain("github.run_attempt == 1")
    expect(buildJob.if).toContain("inputs.acceptance_approved == true")
    expect(buildJob.if).toContain("vars.SIMULATOR_SIGNED_HOST_ACCEPTANCE_ENABLED == 'true'")
    expect(buildJob.environment.name).toBe("signed-host-acceptance")
    expect(buildJob["runs-on"]).toBe("macos-15")
    expect(finalizerJob.needs).toBe("build-signed-candidate")
    expect(finalizerJob.if).toContain("needs.build-signed-candidate.result == 'success'")
    expect(finalizerJob.environment).toBeUndefined()
    expect(workflow.concurrency).toEqual({ group: "signed-macos-host-acceptance", "cancel-in-progress": false })
  })

  test("parameterizes authority values and requires every Apple secret without setting a formal identity in source", () => {
    const inputs = dispatch.inputs
    for (const name of ["expected_developer_id_application", "expected_team_id", "expected_bundle_id"]) {
      expect(inputs[name].required).toBe(true)
      expect(inputs[name].default).toBeUndefined()
    }
    const secretGate = buildStep("Require all Apple credential secrets without displaying values")
    for (const name of [
      "APPLE_DEVELOPER_ID_P12_BASE64", "APPLE_DEVELOPER_ID_P12_PASSWORD", "APPLE_NOTARY_API_KEY_BASE64",
      "APPLE_NOTARY_KEY_ID", "APPLE_NOTARY_ISSUER_ID",
    ]) {
      expect(secretGate.env[name]).toBe(`\${{ secrets.${name} }}`)
      expect(secretGate.run).toContain(name)
    }
    expect(source).not.toContain("Example Corporation")
    expect(source).not.toMatch(/Developer ID Application: [^"'$\n]+ \([A-Z0-9]{10}\)/)
    expect(JSON.stringify(finalizerJob)).not.toContain("secrets.")
  })

  test("binds source SHA to current remote main and authenticates the exact successful Engineering RC run and Artifact", () => {
    const authority = buildStep("Revalidate exact source, inputs, and dormant gate").run
    expect(authority).toContain('test "$GITHUB_SHA" = "$SOURCE_SHA"')
    expect(authority).toContain("git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main")
    expect(authority).toContain('test "$(git rev-parse refs/remotes/origin/main)" = "$SOURCE_SHA"')
    const baseline = buildStep("Authenticate exact successful Engineering RC run and Artifact").run
    for (const value of [
      ".github/workflows/engineering-rc.yml", ".head_sha", ".head_branch", ".run_attempt", ".conclusion",
      ".workflow_run.id", ".workflow_run.head_sha", ".digest", ".expired",
    ]) expect(baseline).toContain(value)
    expect(Object.keys(dispatch.inputs)).toHaveLength(8)
    expect(dispatch.inputs.engineering_rc_authority.required).toBe(true)
    expect(authority).toContain('keys == ["artifactDigest","artifactId","dmgSha256","rcLabel","runId","zipSha256"]')
    const download = buildStep("Download exact authenticated Engineering RC Artifact")
    expect(download.with["artifact-ids"]).toBe("${{ steps.authority.outputs.artifact_id }}")
    expect(download.with["run-id"]).toBe("${{ steps.authority.outputs.run_id }}")
    expect(download.with["github-token"]).toBe("${{ github.token }}")
    const reverify = buildStep("Reverify Engineering RC closure, provenance, and exact baseline bytes").run
    expect(reverify).toContain("verify-engineering-rc-attestations.sh")
    const baselinePreflight = reverify.indexOf('preflight-macos-release-artifact.py zip "$root/Simulator-arm64.zip"')
    const baselineExtraction = reverify.indexOf('ditto -x -k "$root/Simulator-arm64.zip"')
    expect(baselinePreflight).toBeGreaterThanOrEqual(0)
    expect(baselinePreflight).toBeLessThan(baselineExtraction)
  })

  test("notarizes and staples the App before transport packaging, then separately notarizes and staples the final DMG", () => {
    const appNotary = buildJob.steps.indexOf(buildStep("Explicitly notarize, staple, and validate the app"))
    const packaging = buildJob.steps.indexOf(buildStep("Package the already stapled app into final transports"))
    const dmgNotary = buildJob.steps.indexOf(buildStep("Explicitly notarize, staple, validate, and Gatekeeper-assess the final DMG"))
    expect(appNotary).toBeLessThan(packaging)
    expect(packaging).toBeLessThan(dmgNotary)
    for (const name of [
      "Explicitly notarize, staple, and validate the app",
      "Explicitly notarize, staple, validate, and Gatekeeper-assess the final DMG",
    ]) {
      const run = buildStep(name).run
      expect(run).toContain("xcrun notarytool submit")
      expect(run).toContain("--wait --output-format json")
      expect(run).toContain("xcrun stapler staple")
      expect(run).toContain("xcrun stapler validate")
    }
    expect(buildStep("Explicitly notarize, staple, and validate the app").run).toContain("spctl --assess --type execute")
    expect(buildStep("Explicitly notarize, staple, validate, and Gatekeeper-assess the final DMG").run).toContain("spctl --assess --type open --context context:primary-signature")
  })

  test("installs locked tooling before credentials and re-signs the exact authenticated Engineering RC app instead of rebuilding payload", () => {
    const tooling = buildJob.steps.indexOf(buildStep("Install locked signing tooling and stage pinned runtime references before exposing Apple credentials"))
    const credentials = buildJob.steps.indexOf(buildStep("Import Developer ID certificate and App Store Connect key into owner-only runner state"))
    const signing = buildStep("Re-sign the exact authenticated Engineering RC app with Developer ID")
    expect(tooling).toBeLessThan(credentials)
    expect(credentials).toBeLessThan(buildJob.steps.indexOf(signing))
    expect(signing.run).toContain('ditto "$BASELINE_APP" "$signed_root/Simulator.app"')
    expect(signing.run).toContain("sign-engineering-rc-macos-app.ts")
    expect(signing.run).not.toContain("build-dmg.sh")
    expect(source).not.toContain("electron:dist")
  })

  test("proves payload equivalence for both final containers and retains pinned runtime checks", () => {
    const equivalence = buildStep("Prove final DMG and ZIP app payloads equal the authenticated Engineering RC").run
    const finalDmgPreflight = equivalence.indexOf('preflight-macos-release-artifact.py dmg "$final/Simulator-arm64.dmg"')
    const finalDmgAttach = equivalence.indexOf('hdiutil attach "$final/Simulator-arm64.dmg"')
    const finalZipPreflight = equivalence.indexOf('preflight-macos-release-artifact.py zip "$final/Simulator-arm64.zip"')
    const finalZipExtraction = equivalence.indexOf('ditto -x -k "$final/Simulator-arm64.zip"')
    expect(finalDmgPreflight).toBeGreaterThanOrEqual(0)
    expect(finalDmgPreflight).toBeLessThan(finalDmgAttach)
    expect(finalZipPreflight).toBeGreaterThanOrEqual(0)
    expect(finalZipPreflight).toBeLessThan(finalZipExtraction)
    expect(equivalence.match(/compare-macos-app-payloads\.py/g)).toHaveLength(2)
    expect(equivalence.match(/verify-macos-signatures\.ts/g)).toHaveLength(1)
    expect(equivalence).toContain("--mode developer-id")
    expect(equivalence).toContain("verify-packaged-macos-runtimes.sh")
    expect(equivalence).toContain("verify-public-build-privacy.ts")
    expect(equivalence).toContain("updates-disabled.ts")
    expect(equivalence).toContain("stapler validate")
    expect(equivalence).toContain("spctl --assess")
    expect(equivalence).toContain("macos-dual-container-app-payload-equivalence-v1")
    expect(equivalence).toContain("containers:{dmg:$dmg[0],zip:$zip[0]}")
  })

  test("hands off one exact secret-free pre-closure before a separate least-privilege OIDC finalizer", () => {
    expect(buildJob.permissions).toEqual({ actions: "read", contents: "read" })
    expect(buildJob.permissions["id-token"]).toBeUndefined()
    expect(buildJob.permissions.attestations).toBeUndefined()
    expect(finalizerJob.permissions).toEqual({ actions: "read", attestations: "write", contents: "read", "id-token": "write" })
    expect(JSON.stringify(buildJob)).not.toContain("actions/attest@")
    expect(JSON.stringify(finalizerJob)).toContain("actions/attest@")

    const validatePre = buildStep("Validate exact secret-free pre-attestation Candidate closure")
    const cleanup = buildStep("Remove Apple credentials before any Artifact handoff")
    const uploadPre = buildStep("Upload isolated pre-attestation Candidate closure")
    expect(validatePre.run).toContain("signed-host-candidate.ts validate-pre")
    expect(buildStep("Seal signed-only Candidate manifest and local provenance").run).not.toContain('"$candidate/attestations"')
    expect(buildJob.steps.indexOf(cleanup)).toBeLessThan(buildJob.steps.indexOf(uploadPre))
    expect(cleanup.run).toContain("security delete-keychain")
    expect(cleanup.run).toContain('test ! -e "$credential_root"')
    expect(uploadPre.with.name).toBe("${{ steps.authority.outputs.pre_artifact_name }}")
    expect(uploadPre.with["retention-days"]).toBe(1)

    const download = finalizerStep("Download exact raw pre-attestation Candidate Artifact")
    expect(download.with["artifact-ids"]).toBe("${{ needs.build-signed-candidate.outputs.pre_artifact_id }}")
    expect(download.with["skip-decompress"]).toBe(true)
    expect(download.with["digest-mismatch"]).toBe("error")
    expect(download.with["run-id"]).toBe("${{ github.run_id }}")
    const authority = finalizerStep("Revalidate finalizer authority and exact pre-attestation Artifact API identity").run
    expect(authority).toContain('actions/artifacts/$PRE_ARTIFACT_ID')
    expect(authority).toContain('"sha256:${PRE_ARTIFACT_DIGEST}"')
    expect(authority).toContain('.github/workflows/signed-macos-host-acceptance.yml')
    expect(authority).toContain("git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main")
    expect(authority).toContain('test "$(git rev-parse refs/remotes/origin/main)" = "$SOURCE_SHA"')
    const extraction = finalizerStep("Bind, safely extract, and revalidate the exact pre-attestation closure").run
    expect(extraction).toContain('shasum -a 256 "$archive"')
    expect(extraction).toContain("signed-host-pre")
    expect(extraction).toContain("signed-host-candidate.ts validate-pre")
    expect(extraction).toContain(".engineeringRc == $expectedRc")
    expect(extraction).toContain(".identity ==")
  })

  test("uploads the exact signed Candidate name/closure with strict manifest and OIDC provenance", () => {
    expect(SIGNED_CANDIDATE_NAME_PATTERN.test(`simulator-host-0.12.0-macos-arm64-developer-id-candidate-${"a".repeat(40)}`)).toBe(true)
    expect(ENGINEERING_RC_NAME_PATTERN.test("simulator-0.12.0-rc.3-macos-arm64-unsigned")).toBe(true)
    const seal = buildStep("Seal signed-only Candidate manifest and local provenance").run
    for (const path of SIGNED_CANDIDATE_CLOSURE.filter((item) => item !== "SHA256SUMS" && item !== "attestations/provenance.sigstore.json")) {
      expect(seal).toContain(path)
    }
    expect(seal).toContain("signed-host-candidate.ts generate")
    const final = finalizerStep("Save attestation, finalize exact closure, and independently validate").run
    expect(final).toContain('test ! -e "$candidate/attestations"')
    expect(final).toContain('mkdir -m 700 "$candidate/attestations"')
    expect(final).toContain("signed-host-candidate.ts validate")
    expect(final).toContain("verify-signed-host-attestations.sh")
    expect(final).toContain('!= "$engineering_rc_dmg_sha"')
    expect(final).toContain('!= "$engineering_rc_zip_sha"')
    const upload = finalizerStep("Upload exact signed Host Candidate closure")
    expect(upload.with.name).toBe("${{ needs.build-signed-candidate.outputs.candidate_name }}")
    expect(upload.with.path).toBe("signed-host-candidate/")
    expect(upload.with["if-no-files-found"]).toBe("error")
  })

  test("retains an idempotent always-run credential cleanup fallback", () => {
    const fallback = buildStep("Remove ephemeral Apple credential material on failure fallback")
    expect(fallback.if).toBe("always()")
    expect(fallback.run).toContain("security delete-keychain")
    expect(fallback.run).toContain('rm -rf "$credential_root"')
    expect(buildJob.steps.indexOf(fallback)).toBeGreaterThan(buildJob.steps.indexOf(buildStep("Upload isolated pre-attestation Candidate closure")))
  })

  test("is parsed, actionlint-checked, and embedded-Bash-checked by Required release static validation", () => {
    expect(staticValidation.match(/\.github\/workflows\/signed-macos-host-acceptance\.yml/g)?.length).toBeGreaterThanOrEqual(4)
    expect(staticValidation).toContain("bun test scripts/release/*.test.ts")
  })
})
