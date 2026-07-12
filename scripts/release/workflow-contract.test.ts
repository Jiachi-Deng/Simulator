import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const workflow = readFileSync(join(import.meta.dir, "../../.github/workflows/engineering-rc.yml"), "utf8")

describe("engineering RC workflow contract", () => {
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
