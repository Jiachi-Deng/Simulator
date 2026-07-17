import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const workflow = readFileSync(join(import.meta.dir, "../../.github/workflows/release-static-validation.yml"), "utf8")

describe("release static validation workflow", () => {
  test("runs on pull requests that can affect RC, updater, or build-policy behavior", () => {
    expect(workflow).toContain("pull_request:")
    expect(workflow).toContain(".github/workflows/engineering-rc.yml")
    expect(workflow).toContain(".github/workflows/open-design-production-input.yml")
    expect(workflow).toContain(".github/workflows/open-design-m1-machine-evidence.yml")
    expect(workflow).toContain(".github/workflows/open-design-m1-visual-attestation.yml")
    expect(workflow).toContain(".github/workflows/open-design-rc-acceptance.yml")
    expect(workflow).toContain(".github/workflows/open-design-acceptance-rollback.yml")
    expect(workflow).toContain("scripts/release/**")
    expect(workflow).toContain("scripts/qa/open-design-rc-acceptance-evidence.test.ts")
    expect(workflow).toContain("scripts/qa/open-design-m1-machine-evidence.test.ts")
    expect(workflow).toContain("scripts/qa/open-design-m1-visual-attestation.test.ts")
    expect(workflow).toContain("scripts/qa/open-design-m1-final-evidence.test.ts")
    expect(workflow).toContain("scripts/build-policy.ts")
    expect(workflow).toContain("apps/electron/scripts/build-dmg.sh")
    expect(workflow).toContain("apps/electron/package.json")
    expect(workflow).toContain("apps/electron/src/main/auto-update.ts")
    expect(workflow).toContain("apps/electron/src/main/update-policy.ts")
  })

  test("only runs static tests, YAML, shell, and diff checks", () => {
    expect(workflow).toContain("bun test scripts/release/*.test.ts")
    expect(workflow).toContain("YAML.safe_load(File.read")
    expect(workflow).toContain("Validate embedded release workflow Bash")
    expect(workflow).toContain('Open3.capture3("bash", "-n"')
    expect(workflow).toContain("bash -n")
    expect(workflow).toContain("git diff --check")
    expect(workflow).not.toContain("electron:dist")
    expect(workflow).not.toContain("actions/attest")
    expect(workflow).not.toContain("actions/upload-artifact")
  })

  test("checks out read-only authority without persisting the Actions token", () => {
    const parsed = Bun.YAML.parse(workflow) as Record<string, any>
    const checkout = parsed.jobs["release-static-validation"].steps.find(
      (candidate: Record<string, any>) => candidate.name === "Checkout",
    )
    expect(checkout.with["fetch-depth"]).toBe(0)
    expect(checkout.with["persist-credentials"]).toBe(false)
  })

  test("can be dispatched on the final main SHA used by acceptance", () => {
    const parsed = Bun.YAML.parse(workflow) as Record<string, any>
    expect(parsed.on.workflow_dispatch).toBeNull()
    const diff = parsed.jobs["release-static-validation"].steps.find(
      (candidate: Record<string, any>) => candidate.name === "Check whitespace diff",
    ).run
    expect(diff).toContain('GITHUB_EVENT_NAME" = pull_request')
    expect(diff).toContain('GITHUB_EVENT_NAME" = workflow_dispatch')
    expect(diff).toContain("git diff --check HEAD^ HEAD")
  })
})
