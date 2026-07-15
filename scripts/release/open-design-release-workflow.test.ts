import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
const producerPath = join(root, ".github/workflows/open-design-production-input.yml")
const workflowPath = join(root, ".github/workflows/open-design-release.yml")
const documentationPath = join(root, ".github/workflows/open-design-release.md")
const staticValidationPath = join(root, ".github/workflows/release-static-validation.yml")
const producerSource = readFileSync(producerPath, "utf8")
const source = readFileSync(workflowPath, "utf8")
const documentation = readFileSync(documentationPath, "utf8")
const staticValidation = readFileSync(staticValidationPath, "utf8")
const producer = Bun.YAML.parse(producerSource) as Record<string, any>
const workflow = Bun.YAML.parse(source) as Record<string, any>

describe("OpenDesign official release workflow", () => {
  test("has fixed authority, protected writes, and serialized initial/refresh entrypoints", () => {
    expect(workflow.permissions).toEqual({ actions: "read", contents: "write" })
    expect(workflow.concurrency).toEqual({
      group: "open-design-official-release-v0.14.1",
      "cancel-in-progress": false,
    })
    expect(workflow.env.RELEASE_OWNER).toBe("Jiachi-Deng")
    expect(workflow.env.RELEASE_REPOSITORY).toBe("Simulator")
    expect(workflow.env.RELEASE_TAG).toBe("open-design-v0.14.1")
    expect(workflow.on.schedule).toEqual([{ cron: "23 */12 * * *" }])
    expect(workflow.on.workflow_dispatch.inputs.operation.options).toEqual(["refresh", "initial"])
    expect(workflow.jobs.initial.environment.name).toBe("open-design-production")
    expect(workflow.jobs.refresh.environment.name).toBe("open-design-production")
    expect(workflow.jobs.initial.if).toContain("github.repository == 'Jiachi-Deng/Simulator'")
    expect(workflow.jobs.refresh.if).toContain("github.repository == 'Jiachi-Deng/Simulator'")
    expect(workflow.jobs.initial.if).toContain("vars.OPEN_DESIGN_RELEASE_ENABLED == 'true'")
    expect(workflow.jobs.refresh.if).toContain("vars.OPEN_DESIGN_RELEASE_ENABLED == 'true'")
    expect(workflow.jobs.initial.if).toContain("inputs.operation == 'initial'")
    expect(workflow.jobs.refresh.if).toContain("github.event_name == 'schedule'")
    const actionReferences = [...source.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1])
    expect(actionReferences.length).toBeGreaterThan(0)
    expect(actionReferences.every((reference) => /@[0-9a-f]{40}$/.test(reference))).toBe(true)
  })

  test("builds the sealed initial input on fixed macOS arm64 authority without release credentials", () => {
    expect(producer.permissions).toEqual({ contents: "read" })
    expect(producer.on.push.branches).toEqual(["main"])
    expect(producer.on.workflow_dispatch).toBeNull()
    expect(producer.jobs.produce.if).toContain("github.repository == 'Jiachi-Deng/Simulator'")
    expect(producer.jobs.produce.if).toContain("github.ref == 'refs/heads/main'")
    expect(producer.jobs.produce["runs-on"]).toBe("macos-15")
    expect(producer.env.UPSTREAM_REPOSITORY).toBe("https://github.com/nexu-io/open-design")
    expect(producer.env.UPSTREAM_TAG).toBe("open-design-v0.14.1")
    expect(producer.env.UPSTREAM_COMMIT).toBe("2225647726d5387bb24e9539fdb577958b6d88c6")
    expect(producer.env.NODE_VERSION).toBe("24.18.0")
    expect(producer.env.PNPM_VERSION).toBe("10.33.2")
    expect(producer.env.NODE_DISTRIBUTION_SHA256).toBe("e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1")
    expect(producer.env.NODE_EXECUTABLE_SHA256).toBe("ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a")
    expect(producer.env.PNPM_EXECUTABLE_SHA256).toBe("b276da51dc8ca5b0d3ee3371695b50fc8b3244b281b091c63a3f082a88dadeb9")
    expect(producerSource).toContain("--dry-run")
    expect(producerSource).toContain("Build and pass public rights and runtime smoke gates")
    expect(producerSource).toContain(".rightsErrors == 0 and .smoke == true")
    expect(producerSource).toContain("build_work_parent=$(mktemp -d /tmp/od-build.XXXXXX)")
    expect(producerSource.match(/--work-parent \"\$BUILD_WORK_PARENT\"/g)).toHaveLength(2)
    expect(producerSource).not.toContain('--work-parent "$PRODUCTION_WORK/')
    expect(producerSource).toContain('test "$(stat -f \'%Lp\' "$build_work_parent")" = "700"')
    expect(producerSource).toContain('rm -rf "$BUILD_WORK_PARENT"')
    expect(producerSource).not.toContain("--development-local-only")
    expect(producerSource).toContain("open-design-production-input.tar.gz")
    expect(producerSource).toContain("name: open-design-production-input")
    expect(producerSource).toContain("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")
    expect(producerSource).not.toContain("contents: write")
    expect(producerSource).not.toContain("OPEN_DESIGN_RELEASE_PRIVATE_KEY")
    expect(producerSource).not.toContain("gh release")
    const actionReferences = [...producerSource.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1])
    expect(actionReferences.length).toBeGreaterThan(0)
    expect(actionReferences.every((reference) => /@[0-9a-f]{40}$/.test(reference))).toBe(true)
  })

  test("exposes the private key only as a signing-step environment secret", () => {
    const secretExpression = "${{ secrets.OPEN_DESIGN_RELEASE_PRIVATE_KEY }}"
    expect(source.match(/\$\{\{ secrets\.OPEN_DESIGN_RELEASE_PRIVATE_KEY \}\}/g)).toHaveLength(2)
    expect(source).not.toContain("--private-key-file")
    expect(source).not.toContain("actions/upload-artifact")
    expect(source).not.toContain("printenv")
    expect(source).not.toContain("set -x")

    for (const jobName of ["initial", "refresh"]) {
      const job = workflow.jobs[jobName]
      expect(job.env.OPEN_DESIGN_RELEASE_PRIVATE_KEY).toBeUndefined()
      const exposed = job.steps.filter((step: any) => step.env?.OPEN_DESIGN_RELEASE_PRIVATE_KEY !== undefined)
      expect(exposed).toHaveLength(1)
      expect(exposed[0].env.OPEN_DESIGN_RELEASE_PRIVATE_KEY).toBe(secretExpression)
      expect(exposed[0].run).toContain("--private-key-env OPEN_DESIGN_RELEASE_PRIVATE_KEY")
      expect(exposed[0].run).not.toContain(secretExpression)
    }
  })

  test("validates before initial draft publication and removes a failed draft/tag", () => {
    const initial = source.slice(source.indexOf("  initial:"), source.indexOf("  refresh:"))
    expect(initial.indexOf("Dry-run initial production package")).toBeLessThan(initial.indexOf("Build signed initial assets"))
    expect(initial.indexOf("Verify initial bundle before publication")).toBeLessThan(initial.indexOf("Publish fixed-tag release"))
    expect(initial).toContain(".head_branch")
    expect(initial).toContain(".head_sha")
    expect(initial).toContain(".github/workflows/open-design-production-input.yml")
    expect(initial).toContain("open-design-production-input.tar.gz")
    expect(initial).toContain("--draft")
    expect(initial).toContain("--cleanup-tag --yes")
    expect(initial).toContain("cmp \"$INITIAL_OUTPUT/$asset\" \"$remote/$asset\"")
    expect(initial).toContain("--draft=false")
  })

  test("refreshes only three assets behind a draft rollback transaction", () => {
    const refresh = source.slice(source.indexOf("  refresh:"))
    expect(refresh.indexOf("Dry-run catalog refresh")).toBeLessThan(refresh.indexOf("Create signed refresh assets"))
    expect(refresh.indexOf("Reconstruct and verify complete refreshed bundle")).toBeLessThan(refresh.indexOf("Replace only refresh assets"))
    expect(refresh).toContain('canonical=("$CATALOG_ASSET" "$ENVELOPE_ASSET" "$METADATA_ASSET")')
    expect(refresh).toContain("rollback()")
    expect(refresh).toContain("transaction_verified=0")
    expect(refresh).toContain("--draft=true")
    expect(refresh).toContain("--draft=false")
    expect(refresh).toContain('cmp "$SOURCE_BUNDLE/$ARCHIVE_ASSET" "$remote/$ARCHIVE_ASSET"')
    expect(refresh).toContain('cmp "$SOURCE_BUNDLE/$CONFIG_ASSET" "$remote/$CONFIG_ASSET"')
    expect(refresh).not.toContain('cp "$REFRESH_OUTPUT/$ARCHIVE_ASSET"')
    expect(refresh).not.toContain('cp "$REFRESH_OUTPUT/$CONFIG_ASSET"')
    expect(refresh).not.toContain("--clobber")
  })

  test("documents the intentionally unconfigured production authority and recovery boundary", () => {
    const prose = documentation.replace(/\s+/g, " ")
    expect(prose).toContain("does not contain or generate the production signing key")
    expect(prose).toContain("OPEN_DESIGN_RELEASE_PRIVATE_KEY")
    expect(prose).toContain("OPEN_DESIGN_RELEASE_ENABLED=true")
    expect(prose).toContain("open-design-production-input.yml")
    expect(prose).toContain("initial input")
    expect(prose).toContain("Release draft for manual recovery")
    expect(prose).toContain("No real publication should be attempted")
    expect(documentation).not.toContain("BEGIN PRIVATE KEY")
  })

  test("is parsed and contract-tested by pull-request static validation", () => {
    expect(staticValidation).toContain(".github/workflows/open-design-release.yml")
    expect(staticValidation).toContain(".github/workflows/open-design-production-input.yml")
    expect(staticValidation).toContain(".github/workflows/open-design-release.md")
    expect(staticValidation).toContain("scripts/release/*.test.ts")
    expect(staticValidation).toContain("YAML.safe_load(File.read")
  })
})
