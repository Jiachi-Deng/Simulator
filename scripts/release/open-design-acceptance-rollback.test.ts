import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
const path = join(root, ".github/workflows/open-design-acceptance-rollback.yml")
const staticPath = join(root, ".github/workflows/release-static-validation.yml")
const source = readFileSync(path, "utf8")
const staticSource = readFileSync(staticPath, "utf8")
const workflow = Bun.YAML.parse(source) as Record<string, any>
const job = workflow.jobs["validate-rollback-request"]

describe("OpenDesign acceptance rollback gate", () => {
  test("is manual, read-only, fixed to RC and LKG, and protected by an Environment", () => {
    expect(workflow.on.workflow_dispatch).toBeDefined()
    expect(workflow.on.push).toBeUndefined()
    expect(workflow.on.schedule).toBeUndefined()
    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" })
    expect(job.environment.name).toBe("open-design-acceptance-rollback")
    expect(job.env.FROM_TAG).toBe("open-design-v0.14.6-rc.1")
    expect(job.env.TO_TAG).toBe("open-design-v0.14.5")
    expect(job.env.RC_SOURCE_SHA).toBe("6b39a9bcc0f158645897976e23f334c5cab771f4")
    expect(job.env.EXPECTED_ACCEPTANCE_WORKFLOW).toBe(".github/workflows/open-design-rc-acceptance.yml")
    expect(job.env.EXPECTED_HOST_HEAD_SHA).toBe("${{ github.sha }}")
    expect(job.if).toContain("github.run_attempt == 1")
    const checkout = job.steps.find((step: Record<string, any>) => step.name === "Checkout exact Host authority")
    expect(checkout.with["persist-credentials"]).toBe(false)
  })

  test("requires both debug and acceptance gates plus exact confirmation", () => {
    expect(job.if).toContain("vars.OPEN_DESIGN_ACCEPTANCE_ROLLBACK_ENABLED == 'true'")
    expect(job.if).toContain("inputs.debug_enabled == true")
    expect(job.if).toContain("inputs.acceptance_approved == true")
    const validation = job.steps.find((step: Record<string, any>) => step.name === "Validate double-gated rollback evidence").run
    expect(validation).toContain('test "$ROLLBACK_CONFIRMATION" = "ROLLBACK_OPEN_DESIGN_ACCEPTANCE_TO_0_14_5"')
    expect(validation).toContain('test "$GITHUB_RUN_ATTEMPT" = "1"')
    expect(validation).toContain(".conclusion")
    expect(validation).toContain(".head_branch")
    expect(validation).toContain(".head_sha")
    expect(validation).toContain(".repository.full_name")
    expect(validation).toContain(".path")
    expect(validation).toContain("workflow_dispatch")
    expect(validation).toContain('test "$(jq -r .run_attempt <<<"$run_json")" = "1"')
    expect(validation).toContain(".isPrerelease")
    expect(validation).toContain("expected_from")
    expect(validation).toContain("expected_to")
    expect(validation).toContain("open-design-rc-acceptance-evidence")
    expect(validation).toContain(".paidTurns == 40")
    expect(validation).toContain(".newStackConsecutivePassed == 20")
    expect(validation).toContain(".schemaVersion == 2")
    expect(validation).toContain(".hostHeadSha == $hostHeadSha")
    expect(validation).toContain(".rcSourceSha == $rcSourceSha")
    expect(validation).toContain('git rev-parse "refs/tags/$FROM_TAG^{commit}"')
    expect(validation).toContain('git merge-base --is-ancestor "$RC_SOURCE_SHA" "$EXPECTED_HOST_HEAD_SHA"')
    expect(validation).toContain('.targetCommitish <<<"$from_json")" = "$RC_SOURCE_SHA"')
    expect(validation).toContain(".github/workflows/engineering-rc.yml")
    expect(validation).toContain("rcArchiveSha256")
    expect(validation).toContain("rcCatalogSequence")
    expect(validation).toContain("rcCatalogIssuedAt")
    expect(validation).toContain("hostArtifactSha256")
    expect(validation).toContain("hostBuildRunId")
    expect(validation).toContain("open-design-rc-acceptance-intake.json")
    expect(validation).toContain("evidenceBundleSha256")
    expect(validation).toContain("machineEvidence")
    expect(validation).toContain("visualEvidence")
    expect(validation).toContain('test "$(wc -l < "$acceptance/SHA256SUMS" | tr -d \' \')" = 2')
    expect(validation).toContain('test "$(find "$acceptance" -maxdepth 1 -type f | wc -l | tr -d \' \')" = 3')
    const upload = job.steps.find((step: Record<string, any>) => step.name === "Upload immutable rollback gate evidence")
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")
    expect(upload.with.name).toBe("open-design-rollback-gate-evidence")
    expect(upload.with.overwrite).toBe(false)
  })

  test("binds rollback evidence to the accepted RC trust high-water mark", () => {
    const validation = job.steps.find((step: Record<string, any>) => step.name === "Validate double-gated rollback evidence").run
    expect(validation).toContain('.rcCatalogSequence | type == "number"')
    expect(validation).toContain('.rcCatalogIssuedAt | type == "string"')
    expect(validation).toContain('--argjson rcCatalogSequence "$rc_catalog_sequence"')
    expect(validation).toContain('--arg rcCatalogIssuedAt "$rc_catalog_issued_at"')
    expect(validation).toContain("rcCatalogSequence: $rcCatalogSequence")
    expect(validation).toContain("rcCatalogIssuedAt: $rcCatalogIssuedAt")
    expect(validation).toContain("hostHeadSha: $hostHeadSha")
    expect(validation).toContain("rcSourceSha: $rcSourceSha")
    expect(validation).toContain("evidenceBundleSha256: $evidenceBundleSha256")
    expect(validation).toContain("machineEvidence: $machineEvidence")
    expect(validation).toContain("visualEvidence: $visualEvidence")
  })

  test("cannot mutate releases, Catalogs, channels, or expose a user rollback UI", () => {
    expect(source).not.toMatch(/contents:\s*write/)
    expect(source).not.toMatch(/gh release (create|edit|delete|upload)/)
    expect(source).not.toContain("version selector")
    const handoff = job.steps.find((step: Record<string, any>) => step.name === "Record non-mutating Coordinator handoff").run
    expect(handoff).toContain("existing Module Coordinator rollback")
    expect(handoff).toContain("does not")
  })

  test("is included in pull-request YAML and focused release-test validation", () => {
    expect(staticSource).toContain(".github/workflows/open-design-acceptance-rollback.yml")
    expect(staticSource).toContain("scripts/release/*.test.ts")
    expect(staticSource).toContain("YAML.safe_load(File.read")
  })
})
