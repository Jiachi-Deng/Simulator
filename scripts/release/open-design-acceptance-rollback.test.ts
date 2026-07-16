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
    expect(job.env.EXPECTED_ACCEPTANCE_WORKFLOW).toBe(".github/workflows/open-design-rc-acceptance.yml")
  })

  test("requires both debug and acceptance gates plus exact confirmation", () => {
    expect(job.if).toContain("inputs.debug_enabled == true")
    expect(job.if).toContain("inputs.acceptance_approved == true")
    const validation = job.steps.find((step: Record<string, any>) => step.name === "Validate double-gated rollback evidence").run
    expect(validation).toContain('test "$ROLLBACK_CONFIRMATION" = "ROLLBACK_OPEN_DESIGN_ACCEPTANCE_TO_0_14_5"')
    expect(validation).toContain(".conclusion")
    expect(validation).toContain(".head_branch")
    expect(validation).toContain(".head_sha")
    expect(validation).toContain(".repository.full_name")
    expect(validation).toContain(".path")
    expect(validation).toContain("workflow_dispatch")
    expect(validation).toContain(".isPrerelease")
    expect(validation).toContain("expected_from")
    expect(validation).toContain("expected_to")
    expect(validation).toContain("open-design-rc-acceptance-evidence")
    expect(validation).toContain(".paidTurns == 40")
    expect(validation).toContain(".newStackConsecutivePassed == 20")
    expect(validation).toContain("rcArchiveSha256")
    expect(validation).toContain("rcCatalogSequence")
    expect(validation).toContain("rcCatalogIssuedAt")
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
