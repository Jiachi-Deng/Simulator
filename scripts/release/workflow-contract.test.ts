import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const workflow = readFileSync(join(import.meta.dir, "../../.github/workflows/engineering-rc.yml"), "utf8")

describe("engineering RC workflow contract", () => {
  test("keeps the RC bundle label out of the Host product version", () => {
    expect(workflow).toContain("rc_label:")
    expect(workflow).toContain('RC_LABEL: ${{ inputs.rc_label }}')
    expect(workflow).toContain('engineering-rc.ts --label "$RC_LABEL"')
    expect(workflow).toContain(".productVersion")
    expect(workflow).toContain("PRODUCT_VERSION=%s")
    expect(workflow).toContain('verify-and-bundle-macos.sh "$PRODUCT_VERSION"')
    expect(workflow).not.toContain('verify-and-bundle-macos.sh "$RC_LABEL"')
    expect(workflow).not.toContain("RC_VERSION")
    expect(workflow).not.toContain("inputs.version")
  })

  test("verifies only exact artifacts staged in a clean owner-only input", () => {
    expect(workflow).toContain('mktemp -d "$RUNNER_TEMP/engineering-rc-input.XXXXXX"')
    expect(workflow).toContain('chmod 700 "$CLEAN_INPUT"')
    expect(workflow).toContain(
      'stage-engineering-rc-input.ts apps/electron/release "$CLEAN_INPUT" > engineering-rc-input.json',
    )
    expect(workflow).toContain('ENGINEERING_RC_INPUT=%s')
    expect(workflow).toContain(
      'verify-and-bundle-macos.sh "$PRODUCT_VERSION" "$ENGINEERING_RC_INPUT" engineering-rc-bundle',
    )
    expect(workflow).not.toContain(
      'verify-and-bundle-macos.sh "$PRODUCT_VERSION" apps/electron/release engineering-rc-bundle',
    )
    expect(workflow).toContain("verification-input.json")
  })

  test("records both product version and RC label as separate bundle evidence", () => {
    expect(workflow).toContain('--arg rcLabel "$RC_LABEL"')
    expect(workflow).toContain('--arg productVersion "$PRODUCT_VERSION"')
    expect(workflow).toContain("rcLabel: $rcLabel")
    expect(workflow).toContain("productVersion: $productVersion")
    expect(workflow).toContain('release-notes/$PRODUCT_VERSION.md')
    expect(workflow).toContain('sbom.spdx.json "$PRODUCT_VERSION" "$SOURCE_SHA"')
    expect(workflow).not.toContain('sbom.spdx.json "$RC_LABEL" "$SOURCE_SHA"')
  })

  test("requires updates-disabled mode before packaging and propagates the marker", () => {
    expect(workflow).toContain('SIMULATOR_DISABLE_UPDATES: "1"')
    expect(workflow).not.toContain("SIMULATOR_UPDATES_DISABLED")
    expect(workflow.indexOf("bun scripts/release/updates-disabled.ts")).toBeLessThan(
      workflow.indexOf("bun run electron:dist:unsigned:mac:arm64"),
    )
  })

  test("binds the SBOM only to DMG and ZIP subjects", () => {
    const sbomStep = workflow.slice(
      workflow.indexOf("- name: Attest DMG and ZIP with SPDX SBOM"),
      workflow.indexOf("- name: Attest DMG and ZIP build provenance"),
    )
    expect(sbomStep).toContain("sbom-path: engineering-rc-bundle/sbom.spdx.json")
    expect(sbomStep).toContain("engineering-rc-bundle/Simulator-arm64.dmg")
    expect(sbomStep).toContain("engineering-rc-bundle/Simulator-arm64.zip")
    expect(sbomStep).not.toContain("subject-path: engineering-rc-bundle/*")
  })

  test("saves both immutable-action attestation bundles in the uploaded artifact", () => {
    expect(workflow).toContain("artifact-metadata: write")
    expect(workflow.match(/actions\/attest@[0-9a-f]{40}/g)).toHaveLength(2)
    expect(workflow).toContain("steps.attest_sbom.outputs.bundle-path")
    expect(workflow).toContain("steps.attest_provenance.outputs.bundle-path")
    expect(workflow).toContain("attestations/sbom.sigstore.json")
    expect(workflow).toContain("attestations/provenance.sigstore.json")
    expect(workflow.indexOf("Save attestation bundles and finalize checksums")).toBeLessThan(
      workflow.indexOf("Upload engineering RC bundle"),
    )
  })
})
