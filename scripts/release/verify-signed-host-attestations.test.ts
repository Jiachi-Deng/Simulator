import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const script = readFileSync(join(import.meta.dir, "verify-signed-host-attestations.sh"), "utf8")

describe("signed Host Candidate OIDC attestation verification", () => {
  test("verifies both exact final subjects against main and the signed workflow", () => {
    expect(script).toContain("for artifact in Simulator-arm64.dmg Simulator-arm64.zip")
    expect(script).toContain("--bundle \"$CANDIDATE_DIR/attestations/provenance.sigstore.json\"")
    expect(script).toContain("--signer-workflow Jiachi-Deng/Simulator/.github/workflows/signed-macos-host-acceptance.yml")
    expect(script).toContain("--source-ref refs/heads/main")
    expect(script).toContain('--source-digest "$SOURCE_SHA"')
    expect(script).toContain('--signer-digest "$SOURCE_SHA"')
    expect(script).toContain("--deny-self-hosted-runners")
    expect(script).toContain("https://slsa.dev/provenance/v1")
  })
})
