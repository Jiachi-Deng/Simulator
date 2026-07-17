import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const workflow = readFileSync(join(import.meta.dir, "../../.github/workflows/engineering-rc.yml"), "utf8")
const attestationVerifier = readFileSync(join(import.meta.dir, "verify-engineering-rc-attestations.sh"), "utf8")
const parsed = Bun.YAML.parse(workflow) as Record<string, any>
const build = parsed.jobs["build-unsigned-arm64"] as Record<string, any>
const verify = parsed.jobs["verify-unsigned-arm64"] as Record<string, any>
const derive = parsed.jobs["derive-zip-sbom"] as Record<string, any>
const attest = parsed.jobs["attest-and-publish"] as Record<string, any>
const buildSource = workflow.slice(
  workflow.indexOf("  build-unsigned-arm64:"),
  workflow.indexOf("  verify-unsigned-arm64:"),
)
const verifySource = workflow.slice(
  workflow.indexOf("  verify-unsigned-arm64:"),
  workflow.indexOf("  derive-zip-sbom:"),
)
const deriveSource = workflow.slice(
  workflow.indexOf("  derive-zip-sbom:"),
  workflow.indexOf("  attest-and-publish:"),
)
const attestSource = workflow.slice(workflow.indexOf("  attest-and-publish:"))

function namedStep(job: Record<string, any>, name: string): Record<string, any> {
  const step = job.steps.find((candidate: Record<string, any>) => candidate.name === name)
  if (!step) throw new Error(`Missing workflow step: ${name}`)
  return step
}

describe("engineering RC workflow contract", () => {
  test("uses four isolated jobs with OIDC only in the attest-only authority", () => {
    expect(Object.keys(parsed.jobs)).toEqual([
      "build-unsigned-arm64",
      "verify-unsigned-arm64",
      "derive-zip-sbom",
      "attest-and-publish",
    ])
    expect(parsed.permissions).toEqual({})
    expect(build.permissions).toEqual({})
    expect(verify.permissions).toEqual({})
    expect(derive.permissions).toEqual({})
    expect(verify.needs).toBe("build-unsigned-arm64")
    expect(derive.needs).toBe("build-unsigned-arm64")
    expect(attest.needs).toEqual(["build-unsigned-arm64", "verify-unsigned-arm64", "derive-zip-sbom"])
    expect(attest.permissions).toEqual({
      actions: "read",
      contents: "read",
      "id-token": "write",
      attestations: "write",
    })
    expect(buildSource).not.toContain("id-token: write")
    expect(verifySource).not.toContain("id-token: write")
    expect(deriveSource).not.toContain("id-token: write")
    expect(buildSource).not.toContain("actions/attest@")
    expect(verifySource).not.toContain("actions/attest@")
    expect(deriveSource).not.toContain("actions/attest@")
    expect(attestSource.match(/actions\/attest@[0-9a-f]{40}/g)).toHaveLength(2)
    expect(workflow.match(/id-token: write/g)).toHaveLength(1)
  })

  test("keeps repository credentials out of dependency build and native artifact verification", () => {
    for (const [job, source] of [[build, buildSource], [verify, verifySource], [derive, deriveSource]] as const) {
      expect(job.env).not.toHaveProperty("GITHUB_TOKEN")
      expect(job.env).not.toHaveProperty("GH_TOKEN")
      expect(job.steps.some((step: Record<string, any>) => String(step.uses ?? "").startsWith("actions/checkout@"))).toBe(false)
      expect(source).not.toContain("actions/checkout@")
      expect(source).not.toContain("github.token")
      expect(source).not.toContain("secrets.")
      expect(source).not.toContain("GH_TOKEN")
      expect(source).not.toContain("GITHUB_TOKEN")
    }
    expect(namedStep(build, "Install digest-pinned Bun").run).toBe("scripts/release/install-pinned-bun-macos.sh")
    expect(namedStep(build, "Stage digest-pinned packaged runtime references").run)
      .toBe("scripts/release/stage-pinned-macos-arm64-runtimes.sh")
    expect(namedStep(verify, "Install digest-pinned Bun for isolated verification").run)
      .toBe("scripts/release/install-pinned-bun-macos.sh")
    expect(namedStep(verify, "Stage digest-pinned packaged runtime references for isolated verification").run)
      .toBe("scripts/release/stage-pinned-macos-arm64-runtimes.sh")
    expect(namedStep(derive, "Install digest-pinned Bun for independent SBOM derivation").run)
      .toBe("scripts/release/install-pinned-bun-macos.sh")
    expect(workflow).not.toContain("astral-sh/setup-uv@")
  })

  test("lets only no-permission jobs parse native DMG or original inner ZIP contents", () => {
    expect(verifySource).toContain("verify-and-bundle-macos.sh")
    expect(deriveSource).toContain("verify-zip-spdx-evidence.py derive")
    expect(attestSource).not.toContain("verify-and-bundle-macos.sh")
    expect(attestSource).not.toContain("hdiutil")
    expect(attestSource).not.toContain("ditto -x")
    expect(attestSource).not.toContain("verify-zip-spdx-evidence.py")
    expect(attestSource).not.toContain("preflight-macos-release-artifact.py")
    expect(attestSource).not.toContain("bun install")
    expect(attestSource).not.toContain("electron:build")
    expect(attestSource).not.toContain("electron:dist")
    expect(namedStep(attest, "Checkout exact attestation authority").with["persist-credentials"]).toBe(false)
  })

  test("binds all three jobs to the same exact public main SHA and free RC label", () => {
    const buildCheckout = String(namedStep(build, "Checkout exact public main without a token").run)
    const verifyCheckout = String(namedStep(verify, "Checkout exact public verification source without a token").run)
    const deriveCheckout = String(namedStep(derive, "Checkout exact public SBOM source without a token").run)
    const attestCheckout = String(namedStep(attest, "Revalidate exact attestation authority").run)
    for (const source of [buildCheckout, verifyCheckout, deriveCheckout, attestCheckout]) {
      expect(source).toContain('test "$GITHUB_REPOSITORY" = "Jiachi-Deng/Simulator"')
      expect(source).toContain('test "$GITHUB_REF" = "refs/heads/main"')
      expect(source).toContain('test "$GITHUB_SHA" = "$SOURCE_SHA"')
      expect(source).toContain('test "$(git rev-parse refs/remotes/origin/main)" = "$SOURCE_SHA"')
    }
    for (const source of [verifyCheckout, deriveCheckout, attestCheckout]) {
      expect(source).toContain('! git show-ref --verify --quiet "refs/tags/$RC_LABEL"')
      expect(source).toContain('! git show-ref --verify --quiet "refs/tags/v$RC_LABEL"')
    }
    expect(workflow).toContain("engineering-rc.ts --label")
    expect(namedStep(attest, "Install digest-pinned Bun attestation authority").run)
      .toBe("scripts/release/install-pinned-bun-macos.sh")
  })

  test("hands build input to verification by immutable artifact ID and raw digest", () => {
    expect(build.outputs).toEqual({
      input_artifact_id: "${{ steps.upload_input.outputs.artifact-id }}",
      input_artifact_digest: "${{ steps.upload_input.outputs.artifact-digest }}",
      input_dmg_sha256: "${{ steps.stage_input.outputs.dmg_sha256 }}",
      input_zip_sha256: "${{ steps.stage_input.outputs.zip_sha256 }}",
      input_dmg_bytes: "${{ steps.stage_input.outputs.dmg_bytes }}",
      input_zip_bytes: "${{ steps.stage_input.outputs.zip_bytes }}",
    })
    expect(namedStep(build, "Stage clean owner-only verification input").id).toBe("stage_input")
    const upload = namedStep(build, "Upload isolated Engineering RC input")
    expect(upload.id).toBe("upload_input")
    expect(upload.with.path).toBe("${{ runner.temp }}/engineering-rc-input/")
    expect(upload.with["compression-level"]).toBe(0)
    expect(upload.with["retention-days"]).toBe(1)

    const download = namedStep(verify, "Download exact raw Engineering RC build input")
    expect(download.uses).toBe("actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c")
    expect(download.with["artifact-ids"]).toBe("${{ needs.build-unsigned-arm64.outputs.input_artifact_id }}")
    expect(download.with["skip-decompress"]).toBe(true)
    expect(download.with["digest-mismatch"]).toBe("error")
    const extraction = String(namedStep(verify, "Bind and safely extract Engineering RC build input").run)
    expect(extraction).toContain('[[ "$EXPECTED_ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]]')
    expect(extraction).toContain('test "$(stat -f %l "$archive")" = 1')
    expect(extraction).toContain('chmod 600 "$archive"')
    expect(extraction).toContain("extract-engineering-rc-artifact.py")
    expect(extraction).toContain('input "$archive" "$input_root"')
  })

  test("derives ZIP SBOM evidence in a separate no-permission job", () => {
    expect(derive.outputs).toEqual({
      zip_sbom_artifact_id: "${{ steps.upload_zip_sbom.outputs.artifact-id }}",
      zip_sbom_artifact_digest: "${{ steps.upload_zip_sbom.outputs.artifact-digest }}",
    })
    const download = namedStep(derive, "Download exact raw Engineering RC input for independent SBOM derivation")
    expect(download.with["artifact-ids"]).toBe("${{ needs.build-unsigned-arm64.outputs.input_artifact_id }}")
    expect(download.with["skip-decompress"]).toBe(true)
    expect(download.with["digest-mismatch"]).toBe("error")
    const extraction = String(namedStep(derive, "Bind and safely extract independent SBOM input").run)
    expect(extraction).toContain('input "$archive" "$input_root"')
    expect(extraction).toContain('"$INPUT_ZIP_SHA256"')
    expect(namedStep(derive, "Derive exact ZIP SBOM evidence without native DMG parsing").run)
      .toContain("verify-zip-spdx-evidence.py derive")
    const upload = namedStep(derive, "Upload isolated independent ZIP SBOM closure")
    expect(upload.id).toBe("upload_zip_sbom")
    expect(upload.with.path).toBe("engineering-rc-zip-sbom/")
    expect(upload.with["compression-level"]).toBe(0)
    expect(upload.with["retention-days"]).toBe(1)
  })

  test("cross-binds the verified closure to exact original and independent evidence inside the OIDC job", () => {
    expect(verify.outputs).toEqual({
      verified_artifact_id: "${{ steps.upload_verified.outputs.artifact-id }}",
      verified_artifact_digest: "${{ steps.upload_verified.outputs.artifact-digest }}",
    })
    const upload = namedStep(verify, "Upload isolated verified pre-attestation bundle")
    expect(upload.id).toBe("upload_verified")
    expect(upload.with.path).toBe("engineering-rc-bundle/")
    expect(upload.with["compression-level"]).toBe(0)
    expect(upload.with["retention-days"]).toBe(1)
    const originalDownload = namedStep(attest, "Download exact raw original Engineering RC input")
    expect(originalDownload.with["artifact-ids"])
      .toBe("${{ needs.build-unsigned-arm64.outputs.input_artifact_id }}")
    expect(originalDownload.with["skip-decompress"]).toBe(true)
    expect(originalDownload.with["digest-mismatch"]).toBe("error")
    const originalExtraction = String(namedStep(attest, "Bind and safely extract original Engineering RC input").run)
    expect(originalExtraction).toContain('input "$archive" "$original_root"')
    const download = namedStep(attest, "Download exact raw verified pre-attestation bundle")
    expect(download.with["artifact-ids"]).toBe("${{ needs.verify-unsigned-arm64.outputs.verified_artifact_id }}")
    expect(download.with["skip-decompress"]).toBe(true)
    expect(download.with["digest-mismatch"]).toBe("error")
    const extraction = String(namedStep(attest, "Bind and safely extract verified pre-attestation bundle").run)
    expect(extraction).toContain("extract-engineering-rc-artifact.py")
    expect(extraction).toContain('pre "$archive" "$bundle_root"')
    const sbomDownload = namedStep(attest, "Download exact raw independent ZIP SBOM closure")
    expect(sbomDownload.with["artifact-ids"])
      .toBe("${{ needs.derive-zip-sbom.outputs.zip_sbom_artifact_id }}")
    expect(sbomDownload.with["skip-decompress"]).toBe(true)
    expect(sbomDownload.with["digest-mismatch"]).toBe("error")
    const sbomExtraction = String(namedStep(attest, "Bind and safely extract independent ZIP SBOM closure").run)
    expect(sbomExtraction).toContain('zip-sbom "$archive" "$sbom_root"')
    const binding = String(namedStep(attest, "Bind verified subjects byte-for-byte to original build output").run)
    expect(binding).toContain("cmp -s")
    expect(binding).toContain("engineering-rc-original-input/Simulator-arm64.dmg")
    expect(binding).toContain("engineering-rc-original-input/Simulator-arm64.zip")
    expect(binding).toContain("INPUT_DMG_SHA256")
    expect(attest.env.INPUT_ARTIFACT_ID).toBe("${{ needs.build-unsigned-arm64.outputs.input_artifact_id }}")
    expect(attest.env.INPUT_ARTIFACT_DIGEST).toBe("${{ needs.build-unsigned-arm64.outputs.input_artifact_digest }}")
    expect(attestSource).toContain('"$INPUT_ARTIFACT_ID" "$INPUT_ARTIFACT_DIGEST"')
  })

  test("reconstructs and validates trusted evidence before the verifier uploads it", () => {
    const download = workflow.indexOf("Download exact raw Engineering RC build input")
    const extraction = workflow.indexOf("Bind and safely extract Engineering RC build input")
    const trusted = workflow.indexOf("Independently verify artifacts and build trusted evidence")
    const pre = workflow.indexOf("Revalidate pre-attestation bundle closure")
    const upload = workflow.indexOf("Upload isolated verified pre-attestation bundle")
    expect(download).toBeLessThan(extraction)
    expect(extraction).toBeLessThan(trusted)
    expect(trusted).toBeLessThan(pre)
    expect(pre).toBeLessThan(upload)
    expect(verifySource).toContain("generate-spdx.ts")
    expect(verifySource).toContain("verify-bundle-policy.ts")
    expect(verifySource).toContain('"$PRODUCT_VERSION" "$input_root" engineering-rc-bundle')
  })

  test("validates the pre closure again before invoking attestation", () => {
    const extraction = workflow.indexOf("Bind and safely extract verified pre-attestation bundle")
    const pre = workflow.indexOf("Revalidate verified pre-attestation bundle closure")
    const deriveBinding = workflow.indexOf("Bind ZIP SBOM to independent derivation and exact source lock")
    const sbom = workflow.indexOf("Attest ZIP with independently derived SPDX SBOM")
    expect(extraction).toBeLessThan(pre)
    expect(pre).toBeLessThan(deriveBinding)
    expect(deriveBinding).toBeLessThan(sbom)
    expect(attestSource).toContain("verify-engineering-rc-bundle.ts pre")
    expect(attestSource).toContain('"$TRUSTED_BUN" scripts/release/verify-engineering-rc-bundle.ts pre')
    expect(attestSource.match(/generate-spdx\.ts/g)).toHaveLength(1)
  })

  test("reconstructs the transferred ZIP SBOM from exact source without parsing the inner ZIP under OIDC", () => {
    const step = namedStep(attest, "Bind ZIP SBOM to independent derivation and exact source lock")
    const source = String(step.run)
    expect(source).not.toContain("verify-zip-spdx-evidence.py")
    expect(source).not.toContain("Simulator-arm64.zip")
    expect(source).toContain("zip-sbom-lineage.json")
    expect(source).toContain('cmp -s "$authority/packaged-files.sha256"')
    expect(source).toContain('"$TRUSTED_BUN" scripts/release/generate-spdx.ts')
    expect(source).toContain("bun.lock")
    expect(source).toContain('cmp -s "$reconstructed" "$authority/sbom.spdx.json"')
  })

  test("scopes the GitHub token to one cryptographic verification step", () => {
    expect(workflow).not.toContain("GITHUB_TOKEN")
    expect(workflow).not.toContain("secrets.")
    expect(workflow.match(/GH_TOKEN/g)).toHaveLength(1)
    expect(workflow.match(/github\.token/g)).toHaveLength(1)
    const step = namedStep(attest, "Verify saved attestation bundles cryptographically")
    expect(step.env).toEqual({ GH_TOKEN: "${{ github.token }}" })
    expect(step.run).toContain("verify-engineering-rc-attestations.sh")
    expect(attestationVerifier.match(/verify_attestation \\\n/g)).toHaveLength(3)
    expect(attestationVerifier.match(/https:\/\/slsa\.dev\/provenance\/v1/g)).toHaveLength(2)
    expect(attestationVerifier.match(/https:\/\/spdx\.dev\/Document\/v2\.3/g)).toHaveLength(1)
    expect(attestationVerifier).toContain('--source-digest "$SOURCE_SHA"')
    expect(attestationVerifier).toContain('--signer-digest "$SOURCE_SHA"')
    expect(attestationVerifier).toContain("--deny-self-hosted-runners")
    expect(attestationVerifier).toContain("statement.predicate == $expected[0]")
  })

  test("creates checksums only after saved-bundle verification and validates final closure before upload", () => {
    const save = workflow.indexOf("Save attestation bundles")
    const crypto = workflow.indexOf("Verify saved attestation bundles cryptographically")
    const sums = workflow.indexOf("Finalize checksums after attestation verification")
    const final = workflow.indexOf("Validate final bundle closure")
    const upload = workflow.indexOf("Upload engineering RC bundle")
    expect(save).toBeLessThan(crypto)
    expect(crypto).toBeLessThan(sums)
    expect(sums).toBeLessThan(final)
    expect(final).toBeLessThan(upload)
    expect(attestSource).toContain("verify-engineering-rc-bundle.ts final")
  })

  test("pins the anonymous ripgrep postinstall asset before dependencies", () => {
    expect(workflow.indexOf("Stage pinned ripgrep postinstall asset")).toBeLessThan(workflow.indexOf("Install dependencies"))
    expect(buildSource).toContain('RIPGREP_PACKAGE_VERSION: "1.17.1"')
    expect(buildSource).toContain('RIPGREP_ASSET_SHA256: "2fa16464fd8638588a67c7fc172d3c4b57fbdc65dff366e10b0b0e90734628a6"')
    expect(buildSource).toContain('test "$(tar -tzf "$download_path")" = "rg"')
    expect(workflow).not.toContain("api.github.com")
  })

  test("keeps RC label, product version, and updates-disabled build policy separate", () => {
    expect(workflow).toContain('RC_LABEL: ${{ inputs.rc_label }}')
    expect(workflow).toContain("PRODUCT_VERSION=${RC_LABEL%-rc.*}")
    expect(workflow).toContain('release-notes/$PRODUCT_VERSION.md')
    expect(workflow).toContain('sbom.spdx.json "$PRODUCT_VERSION" "$SOURCE_SHA"')
    expect(workflow).not.toContain('sbom.spdx.json "$RC_LABEL" "$SOURCE_SHA"')
    expect(workflow).not.toContain('verify-and-bundle-macos.sh "$RC_LABEL"')
    expect(build.env.SIMULATOR_DISABLE_UPDATES).toBe("1")
    expect(verify.env.SIMULATOR_DISABLE_UPDATES).toBe("1")
    expect(derive.env).not.toHaveProperty("SIMULATOR_DISABLE_UPDATES")
    expect(attest.env).not.toHaveProperty("SIMULATOR_DISABLE_UPDATES")
    expect(workflow.indexOf("bun scripts/release/updates-disabled.ts")).toBeLessThan(
      workflow.indexOf("bun run electron:dist:unsigned:mac:arm64"),
    )
  })

  test("binds independently derived SBOM only to the ZIP subject", () => {
    const sbomStep = workflow.slice(
      workflow.indexOf("- name: Attest ZIP with independently derived SPDX SBOM"),
      workflow.indexOf("- name: Attest DMG and ZIP build provenance"),
    )
    expect(sbomStep).toContain("sbom-path: engineering-rc-bundle/sbom.spdx.json")
    expect(sbomStep).toContain("engineering-rc-bundle/Simulator-arm64.zip")
    expect(sbomStep).not.toContain("engineering-rc-bundle/Simulator-arm64.dmg")
    expect(sbomStep).not.toContain("subject-path: engineering-rc-bundle/*")
  })
})
