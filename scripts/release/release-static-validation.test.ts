import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const workflow = readFileSync(join(import.meta.dir, "../../.github/workflows/release-static-validation.yml"), "utf8")

describe("release static validation workflow", () => {
  test("runs on pull requests that can affect RC, updater, or build-policy behavior", () => {
    expect(workflow).toContain("pull_request:")
    expect(workflow).toContain(".github/workflows/engineering-rc.yml")
    expect(workflow).toContain(".github/workflows/open-design-production-input.yml")
    expect(workflow).toContain(".github/workflows/open-design-acceptance-rollback.yml")
    expect(workflow).toContain("scripts/release/**")
    expect(workflow).toContain("scripts/build-policy.ts")
    expect(workflow).toContain("apps/electron/scripts/build-dmg.sh")
    expect(workflow).toContain("apps/electron/package.json")
    expect(workflow).toContain("apps/electron/src/main/auto-update.ts")
    expect(workflow).toContain("apps/electron/src/main/update-policy.ts")
  })

  test("only runs static tests, YAML, shell, and diff checks", () => {
    expect(workflow).toContain("bun test scripts/release/*.test.ts")
    expect(workflow).toContain("YAML.safe_load(File.read")
    expect(workflow).toContain("bash -n")
    expect(workflow).toContain("git diff --check")
    expect(workflow).not.toContain("electron:dist")
    expect(workflow).not.toContain("actions/attest")
    expect(workflow).not.toContain("actions/upload-artifact")
  })
})
