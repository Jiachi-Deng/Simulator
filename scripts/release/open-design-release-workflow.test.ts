import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
const producerPath = join(root, ".github/workflows/open-design-production-input.yml")
const workflowPath = join(root, ".github/workflows/open-design-release.yml")
const documentationPath = join(root, ".github/workflows/open-design-release.md")
const staticValidationPath = join(root, ".github/workflows/release-static-validation.yml")
const rollbackPath = join(root, ".github/workflows/open-design-acceptance-rollback.yml")
const producerSource = readFileSync(producerPath, "utf8")
const source = readFileSync(workflowPath, "utf8")
const documentation = readFileSync(documentationPath, "utf8")
const staticValidation = readFileSync(staticValidationPath, "utf8")
const rollbackSource = readFileSync(rollbackPath, "utf8")
const producer = Bun.YAML.parse(producerSource) as Record<string, any>
const workflow = Bun.YAML.parse(source) as Record<string, any>
const staticWorkflow = Bun.YAML.parse(staticValidation) as Record<string, any>
const rollbackWorkflow = Bun.YAML.parse(rollbackSource) as Record<string, any>

function step(jobName: "initial" | "refresh", name: string): Record<string, any> {
  const found = workflow.jobs[jobName].steps.find((candidate: Record<string, any>) => candidate.name === name)
  if (!found) throw new Error(`Missing ${jobName} step: ${name}`)
  return found
}

function staticStep(name: string): Record<string, any> {
  const found = staticWorkflow.jobs["release-static-validation"].steps.find((candidate: Record<string, any>) => candidate.name === name)
  if (!found) throw new Error(`Missing static validation step: ${name}`)
  return found
}

function deriveCatalogState(priors: Array<{ sequence: number; issuedAt: string }>, nowMs: number) {
  if (priors.length === 0) throw new TypeError("at least one authenticated prior state is required")
  const sequence = Math.max(...priors.map((prior) => prior.sequence)) + 1
  const priorIssuedAtMs = Math.max(...priors.map((prior) => Date.parse(prior.issuedAt)))
  const issuedAtMs = Math.max(nowMs, priorIssuedAtMs + 1000)
  return { sequence, issuedAt: new Date(issuedAtMs).toISOString() }
}

describe("OpenDesign official release workflow", () => {
  test("has fixed authority, protected writes, and serialized initial/refresh entrypoints", () => {
    expect(workflow.permissions).toEqual({ actions: "read", contents: "write" })
    expect(workflow.concurrency).toEqual({
      group: "open-design-release-transaction",
      "cancel-in-progress": false,
    })
    expect(workflow.env.RELEASE_OWNER).toBe("Jiachi-Deng")
    expect(workflow.env.RELEASE_REPOSITORY).toBe("Simulator")
    expect(workflow.env.RELEASE_TAG).toBeUndefined()
    expect(workflow.env.MODULE_VERSION).toBeUndefined()
    expect(workflow.on.schedule).toEqual([{ cron: "23 */12 * * *" }])
    expect(workflow.on.workflow_dispatch.inputs.operation.options).toEqual(["refresh", "initial"])
    expect(workflow.on.workflow_dispatch.inputs.release_track.options).toEqual(["prerelease", "stable"])
    expect(workflow.jobs.initial.environment.name).toContain("open-design-production-stable")
    expect(workflow.jobs.initial.environment.name).toContain("open-design-prerelease")
    expect(workflow.jobs.refresh.environment.name).toContain("open-design-prerelease")
    expect(workflow.jobs.refresh.environment.name).toContain("open-design-production")
    expect(workflow.jobs.initial.if).toContain("github.repository == 'Jiachi-Deng/Simulator'")
    expect(workflow.jobs.refresh.if).toContain("github.repository == 'Jiachi-Deng/Simulator'")
    expect(workflow.jobs.initial.if).toContain("vars.OPEN_DESIGN_PRERELEASE_ENABLED == 'true'")
    expect(workflow.jobs.initial.if).toContain("vars.OPEN_DESIGN_STABLE_CHANNEL_ENABLED == 'true'")
    expect(workflow.jobs.refresh.if).toContain("vars.OPEN_DESIGN_RELEASE_ENABLED == 'true'")
    expect(workflow.jobs.refresh.if).toContain("vars.OPEN_DESIGN_PRERELEASE_ENABLED == 'true'")
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
    expect(producerSource).toContain('"$RUNNER_TEMP/open-design-production-input/package/open-design-production-input/staging"')
    expect(producerSource).toContain('chmod -R u+rwX "$sealed_tree"')
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

  test("exposes the private key only to one signing or verification step per job", () => {
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

  test("installs both locked workspace and standalone publisher dependency closures", () => {
    for (const jobName of ["initial", "refresh"] as const) {
      expect(step(jobName, "Setup Bun").uses).toBe("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6")
      const install = step(jobName, "Install exact publisher dependencies").run
      expect(install).toContain("bun install --frozen-lockfile --ignore-scripts")
      expect(install).toContain("npm ci --ignore-scripts --prefix modules/open-design")
      expect(install.indexOf("bun install")).toBeLessThan(install.indexOf("npm ci"))
    }

    const imported = spawnSync("node", [
      "--input-type=module",
      "--eval",
      "import('./modules/open-design/package/production-package.mjs')",
    ], { cwd: root, encoding: "utf8" })
    expect(imported.status, imported.stderr).toBe(0)
  })

  test("restores owner write permission before deleting sealed runner trees", () => {
    for (const [jobName, stepName, directory] of [
      ["initial", "Remove transient verification material", "open-design-initial"],
      ["refresh", "Remove transient signing and release material", "open-design-refresh"],
    ] as const) {
      const cleanup = step(jobName, stepName).run
      expect(cleanup).toContain(`chmod -R u+rwX "$RUNNER_TEMP/${directory}"`)
      expect(cleanup.indexOf("chmod -R u+rwX")).toBeLessThan(cleanup.indexOf("rm -rf"))

      const fixture = mkdtempSync(join(tmpdir(), `simulator-${directory}-cleanup-`))
      const runnerTemp = join(fixture, "runner")
      const sealed = join(runnerTemp, directory, "sealed", "nested")
      const payload = join(sealed, "payload.txt")
      try {
        mkdirSync(sealed, { recursive: true, mode: 0o700 })
        writeFileSync(payload, "sealed\n", { mode: 0o600 })
        chmodSync(payload, 0o444)
        chmodSync(sealed, 0o555)
        chmodSync(join(sealed, ".."), 0o555)
        chmodSync(join(runnerTemp, directory), 0o555)
        const removed = spawnSync("bash", ["-e", "-o", "pipefail", "-c", cleanup], {
          env: { ...process.env, RUNNER_TEMP: runnerTemp },
          encoding: "utf8",
        })
        expect(removed.status, `${removed.stdout}\n${removed.stderr}`).toBe(0)
        expect(existsSync(join(runnerTemp, directory))).toBe(false)
      } finally {
        spawnSync("chmod", ["-R", "u+rwX", fixture])
        rmSync(fixture, { recursive: true, force: true })
      }
    }
  })

  test("validates before initial draft publication and removes a failed draft/tag", () => {
    const initial = source.slice(source.indexOf("  initial:"), source.indexOf("  refresh:"))
    const authenticatedBuild = step("initial", "Authenticate prior state, dry-run, and build signed initial assets").run
    expect(authenticatedBuild.indexOf("--dry-run")).toBeLessThan(authenticatedBuild.indexOf("--private-key-env OPEN_DESIGN_RELEASE_PRIVATE_KEY"))
    expect(initial.indexOf("Authenticate prior state, dry-run, and build signed initial assets")).toBeLessThan(initial.indexOf("Verify initial bundle before publication"))
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

  test("authenticates the exact nonzero 0.14.5 high-water mark before deriving RC state", () => {
    const download = step("initial", "Download exact current 0.14.5 trust baseline").run
    expect(download).toContain('test "$(jq -r .isDraft <<<"$baseline_state")" = false')
    expect(download).toContain('test "$(jq -r .isPrerelease <<<"$baseline_state")" = false')
    expect(download).toContain('test "$(find "$baseline" -maxdepth 1 -type f | wc -l | tr -d \' \')" = 5')
    for (const variable of [
      "LKG_ARCHIVE_ASSET",
      "LKG_CATALOG_ASSET",
      "LKG_ENVELOPE_ASSET",
      "CONFIG_ASSET",
      "LKG_METADATA_ASSET",
    ]) {
      expect(download).toContain(`"$${variable}"`)
      expect(download).toContain('test -f "$baseline/$asset"')
    }

    const build = step("initial", "Authenticate prior state, dry-run, and build signed initial assets").run
    const baselineVerify = build.indexOf('> "$state_root/baseline-verify.json"')
    expect(baselineVerify).toBeGreaterThan(0)
    expect(baselineVerify).toBeLessThan(build.indexOf("--dry-run"))
    expect(build).toContain('--bundle-root "$BASELINE_BUNDLE"')
    expect(build).toContain('--module-version "$LKG_MODULE_VERSION"')
    expect(build).toContain('.catalogState.highestSequence == $sequence')
    expect(build).toContain('.catalogState.latestIssuedAt == $issuedAt')
    expect(build).toContain("const priorSequence = Math.max(...sequences);")
    expect(build).toContain("const sequence = priorSequence + 1;")
    expect(build.match(/--previous-sequence "\$PRIOR_SEQUENCE"/g)).toHaveLength(2)
    expect(build.match(/--previous-issued-at "\$PRIOR_ISSUED_AT"/g)).toHaveLength(2)
    const verify = step("initial", "Verify initial bundle before publication").run
    expect(verify).toContain('--previous-sequence "$PRIOR_SEQUENCE"')
    expect(verify).toContain('--previous-issued-at "$PRIOR_ISSUED_AT"')

    const state = deriveCatalogState([{ sequence: 41, issuedAt: "2026-07-16T10:00:00.000Z" }], Date.parse("2026-07-16T09:00:00.000Z"))
    expect(state).toEqual({ sequence: 42, issuedAt: "2026-07-16T10:00:01.000Z" })
    const stableState = deriveCatalogState([
      { sequence: 44, issuedAt: "2026-07-16T10:00:00.000Z" },
      { sequence: 42, issuedAt: "2026-07-16T12:00:00.000Z" },
    ], Date.parse("2026-07-16T11:00:00.000Z"))
    expect(stableState).toEqual({ sequence: 45, issuedAt: "2026-07-16T12:00:01.000Z" })
    const wallClockState = deriveCatalogState([
      { sequence: 45, issuedAt: "2026-07-16T12:00:00.000Z" },
    ], Date.parse("2026-07-16T13:00:00.000Z"))
    expect(wallClockState).toEqual({ sequence: 46, issuedAt: "2026-07-16T13:00:00.000Z" })
  })

  test("fails closed on missing or tampered baseline and RC release assets", () => {
    const baseline = step("initial", "Download exact current 0.14.5 trust baseline").run
    expect(baseline).toContain('test "$actual" = "$expected"')
    expect(baseline).toContain('test -f "$baseline/$asset"')
    expect(baseline).not.toContain("|| true")

    const stable = step("initial", "Validate stable acceptance, rollback, and RC closure").run
    expect(stable).toContain('test "$actual_rc" = "$expected_rc"')
    expect(stable).toContain('test "$(find "$rc" -maxdepth 1 -type f | wc -l | tr -d \' \')" = 4')
    expect(stable).toContain('test -f "$rc/$asset"')
    expect(stable).not.toContain("|| true")

    const authenticatedBuild = step("initial", "Authenticate prior state, dry-run, and build signed initial assets").run
    expect(authenticatedBuild).toContain('--bundle-root "$BASELINE_BUNDLE"')
    expect(authenticatedBuild).toContain('--bundle-root "$rc_verify"')
    expect(authenticatedBuild).toContain('import { encodeCanonicalCatalog } from "@simulator/module-release-trust";')
    expect(authenticatedBuild).toContain('flag: "wx"')
    expect(authenticatedBuild.indexOf('baseline-verify.json')).toBeLessThan(authenticatedBuild.indexOf("--dry-run"))
    expect(authenticatedBuild.indexOf('rc-verify.json')).toBeLessThan(authenticatedBuild.indexOf("--dry-run"))
  })

  test("refreshes stable on schedule or the exact RC manually without publishing an official config", () => {
    const refresh = source.slice(source.indexOf("  refresh:"))
    const resolve = step("refresh", "Resolve exact refresh target").run
    expect(resolve).toContain('candidate_versions=("0.14.6" "0.14.5")')
    expect(resolve).toContain('test -z "$DISPATCH_RELEASE_TRACK"')
    expect(resolve).toContain('selected_version="0.14.6-rc.1"')
    expect(resolve).toContain('release_track="prerelease"')
    expect(resolve).toContain('expected_prerelease="true"')
    expect(resolve).toContain('config_required="false"')
    expect(resolve).toContain('expected_host_version_range=">=0.12.0"')
    expect(resolve).toContain('test "$(jq -r .isDraft <<<"$release_state")" = false')
    expect(resolve).toContain('test "$(jq -r .isPrerelease <<<"$release_state")" = "$expected_prerelease"')
    expect(resolve).toContain('test "$actual" = "$expected"')

    const authority = step("refresh", "Validate fixed refresh authority").run
    expect(authority).toContain('test "$MODULE_VERSION" = "0.14.6-rc.1"')
    expect(authority).toContain('test "$RELEASE_TAG" = "open-design-v0.14.6-rc.1"')
    expect(authority).toContain('test "$PUBLIC_ASSET_COUNT" = 4')
    expect(authority).toContain('test "$STABLE_CHANNEL_CONFIRMATION" = "REFRESH_OPEN_DESIGN_0_14_6_RC_1"')

    const download = step("refresh", "Download exact fixed-tag public bundle").run
    expect(download).toContain('expected_assets=("$ARCHIVE_ASSET" "$CATALOG_ASSET" "$ENVELOPE_ASSET" "$METADATA_ASSET")')
    expect(download).toContain('[[ "$CONFIG_REQUIRED" = false ]] || expected_assets+=("$CONFIG_ASSET")')
    expect(download).toContain('test ! -e "$source/$CONFIG_ASSET"')
    expect(download).toContain('refresh_input="$work/private-input"')

    const state = step("refresh", "Derive monotonic refresh state and bounded window").run
    expect(state).toContain("SOURCE_VERIFICATION_TIME_MS=${previousIssuedAtMs + 1000}")
    expect(state).toContain("CATALOG_SEQUENCE=${catalog.sequence + 1}")
    expect(state).toContain("issuedAtMs + 20 * 60 * 60 * 1000")

    const signedRefresh = step("refresh", "Authenticate source, dry-run, and create signed refresh assets").run
    expect(signedRefresh).toContain("verifyModuleReleaseCatalog")
    expect(signedRefresh).toContain('metadata.module.version !== process.env.MODULE_VERSION')
    expect(signedRefresh).toContain('metadata.githubRelease.tag !== process.env.RELEASE_TAG')
    expect(signedRefresh).toContain('metadata.hostVersionRange !== release.hostVersionRange')
    expect(signedRefresh).toContain('metadata.catalogRefreshPolicy.replaceReleaseAssets')
    expect(signedRefresh).toContain('writeFileSync(join(process.env.REFRESH_INPUT, process.env.CONFIG_ASSET)')
    expect(signedRefresh.indexOf("verifyModuleReleaseCatalog")).toBeLessThan(signedRefresh.indexOf("writeFileSync(join(process.env.REFRESH_INPUT"))
    expect(signedRefresh).toContain('--verification-time "$SOURCE_VERIFICATION_TIME_MS"')
    expect(signedRefresh).toContain('--verification-time "$VERIFICATION_TIME_MS"')
    expect(signedRefresh.indexOf("--verify")).toBeLessThan(signedRefresh.indexOf("--dry-run"))
    expect(signedRefresh.indexOf("--dry-run")).toBeLessThan(signedRefresh.indexOf("--private-key-env OPEN_DESIGN_RELEASE_PRIVATE_KEY"))
    expect(signedRefresh).toContain('.mode == "refresh-dry-run" and .writes == []')
    expect(signedRefresh).toContain('.previousCatalog.sequence == $previousSequence')
    expect(signedRefresh).toContain('.plannedFiles == [$catalog, $envelope, $metadata]')
    expect(signedRefresh).toContain('.immutableArchiveVerified == true and .verifiedWithModuleInstaller == true')

    expect(refresh.indexOf("Reconstruct and verify complete refreshed bundle")).toBeLessThan(refresh.indexOf("Replace only refresh assets"))
    expect(refresh).toContain('canonical=("$CATALOG_ASSET" "$ENVELOPE_ASSET" "$METADATA_ASSET")')
    expect(refresh).toContain('public_assets=("$ARCHIVE_ASSET" "$CATALOG_ASSET" "$ENVELOPE_ASSET" "$METADATA_ASSET")')
    expect(refresh).toContain("rollback()")
    expect(refresh).toContain("transaction_verified=0")
    expect(refresh).toContain("--draft=true")
    expect(refresh).toContain("--draft=false")
    expect(refresh).toContain('cmp "$SOURCE_BUNDLE/$ARCHIVE_ASSET" "$remote/$ARCHIVE_ASSET"')
    expect(refresh).toContain('cmp "$SOURCE_BUNDLE/$CONFIG_ASSET" "$remote/$CONFIG_ASSET"')
    expect(refresh).toContain('test ! -e "$remote/$CONFIG_ASSET"')
    expect(refresh).toContain('cp "$REFRESH_INPUT/$CONFIG_ASSET" "$remote/$CONFIG_ASSET"')
    expect(refresh.indexOf('gh release edit "$RELEASE_TAG" --repo "$RELEASE_OWNER/$RELEASE_REPOSITORY" --draft=true')).toBeLessThan(refresh.indexOf('gh release upload "$RELEASE_TAG"'))
    expect(refresh).toContain('cmp "$SOURCE_BUNDLE/$asset" "$preflight/$asset"')
    expect(refresh.indexOf('cmp "$SOURCE_BUNDLE/$asset" "$preflight/$asset"')).toBeLessThan(refresh.indexOf('gh release upload "$RELEASE_TAG"'))
    expect(refresh).not.toContain('cp "$REFRESH_OUTPUT/$ARCHIVE_ASSET"')
    expect(refresh).not.toContain('cp "$REFRESH_OUTPUT/$CONFIG_ASSET"')
    expect(refresh).not.toContain('gh release upload "$RELEASE_TAG" "$REFRESH_INPUT/$CONFIG_ASSET"')
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
    expect(prose).toContain("current 0.14.5 sequence + 1")
    expect(prose).toContain("max(current 0.14.5 sequence, accepted RC sequence) + 1")
    expect(prose).toContain("all four public RC assets")
    expect(documentation).not.toContain("BEGIN PRIVATE KEY")
  })

  test("is parsed and contract-tested by pull-request static validation", () => {
    expect(staticStep("Setup Node").uses).toBe("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e")
    expect(staticStep("Setup Node").with["node-version"]).toBe("24.18.0")
    expect(staticValidation).toContain("Install exact OpenDesign publisher dependencies")
    expect(staticValidation).toContain("bun install --frozen-lockfile --ignore-scripts")
    expect(staticValidation).toContain("npm ci --ignore-scripts --prefix modules/open-design")
    expect(staticValidation.indexOf("Setup Node")).toBeLessThan(staticValidation.indexOf("Install exact OpenDesign publisher dependencies"))
    expect(staticValidation.indexOf("Install exact OpenDesign publisher dependencies")).toBeLessThan(staticValidation.indexOf("Run release unit tests"))
    expect(staticValidation).toContain(".github/workflows/open-design-release.yml")
    expect(staticValidation).toContain(".github/workflows/open-design-acceptance-rollback.yml")
    expect(staticValidation).toContain(".github/workflows/open-design-production-input.yml")
    expect(staticValidation).toContain(".github/workflows/open-design-release.md")
    expect(staticValidation).toContain("scripts/release/*.test.ts")
    expect(staticValidation).toContain("YAML.safe_load(File.read")
    expect(staticStep("Validate embedded release workflow Bash").run).toContain('Open3.capture3("bash", "-n"')
  })

  test("keeps every embedded release bash block and Node heredoc syntactically valid", () => {
    for (const [workflowName, parsed] of [
      ["release", workflow],
      ["rollback", rollbackWorkflow],
    ] as const) {
      for (const [jobName, job] of Object.entries(parsed.jobs as Record<string, any>)) {
        for (const candidate of job.steps as Array<Record<string, any>>) {
          if (candidate.shell !== "bash" || typeof candidate.run !== "string") continue
          const bash = spawnSync("bash", ["-n"], { input: candidate.run, encoding: "utf8" })
          expect(bash.status, `${workflowName}/${jobName}/${candidate.name}: ${bash.stderr}`).toBe(0)
          for (const match of candidate.run.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE(?:\n|$)/g)) {
            const node = spawnSync("node", ["--check", "--input-type=module", "-"], {
              input: match[1],
              encoding: "utf8",
            })
            expect(node.status, `${workflowName}/${jobName}/${candidate.name}: ${node.stderr}`).toBe(0)
          }
        }
      }
    }
  })
})
