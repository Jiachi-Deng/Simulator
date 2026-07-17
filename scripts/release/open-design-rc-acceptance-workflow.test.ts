import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
const workflowPath = join(root, ".github/workflows/open-design-rc-acceptance.yml")
const staticPath = join(root, ".github/workflows/release-static-validation.yml")
const source = readFileSync(workflowPath, "utf8")
const staticSource = readFileSync(staticPath, "utf8")
const workflow = Bun.YAML.parse(source) as Record<string, any>
const job = workflow.jobs["notarize-acceptance-evidence"]

function step(name: string): Record<string, any> {
  const found = job.steps.find((candidate: Record<string, any>) => candidate.name === name)
  if (!found) throw new Error(`Missing acceptance workflow step: ${name}`)
  return found
}

describe("OpenDesign RC acceptance evidence workflow", () => {
  test("is manual, main-only, read-only, protected, and does not accept authority SHAs as inputs", () => {
    expect(workflow.on.workflow_dispatch).toBeDefined()
    expect(workflow.on.push).toBeUndefined()
    expect(workflow.on.pull_request).toBeUndefined()
    expect(workflow.on.schedule).toBeUndefined()
    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" })
    expect(workflow.concurrency).toEqual({
      group: "open-design-rc-acceptance-evidence",
      "cancel-in-progress": false,
    })
    expect(job.if).toContain("github.repository == 'Jiachi-Deng/Simulator'")
    expect(job.if).toContain("github.ref == 'refs/heads/main'")
    expect(job.if).toContain("vars.OPEN_DESIGN_RC_ACCEPTANCE_ENABLED == 'true'")
    expect(job.if).toContain("inputs.acceptance_approved == true")
    expect(job.environment.name).toBe("open-design-rc-acceptance")

    const inputs = workflow.on.workflow_dispatch.inputs
    expect(Object.keys(inputs).sort()).toEqual([
      "acceptance_approved",
      "acceptance_confirmation",
      "evidence_bundle_base64",
      "evidence_bundle_sha256",
    ])
    expect(inputs.acceptance_approved.default).toBe(false)
    expect(inputs.evidence_bundle_base64.required).toBe(true)
    expect(inputs.evidence_bundle_sha256.required).toBe(true)
    expect(inputs).not.toHaveProperty("hostHeadSha")
    expect(inputs).not.toHaveProperty("rcSourceSha")
    expect(job.env.HOST_HEAD_SHA).toBe("${{ github.sha }}")
    expect(job.env.RC_SOURCE_SHA).toBe("6b39a9bcc0f158645897976e23f334c5cab771f4")
  })

  test("binds the immutable RC source separately from the final Host authority", () => {
    const authority = step("Validate fixed dual-source authority").run
    expect(authority).toContain('git rev-parse "refs/tags/$RC_TAG^{commit}"')
    expect(authority).toContain('git merge-base --is-ancestor "$RC_SOURCE_SHA" "$HOST_HEAD_SHA"')
    expect(authority).toContain('git show "$RC_SOURCE_SHA:$authority_path"')
    expect(authority).toContain("scripts/qa/open-design-m1-cases.ts")
    expect(authority).toContain("scripts/qa/generate-open-design-m1-case-artifacts.ts")
    expect(authority).toContain('.targetCommitish <<<"$rc_state")" = "$RC_SOURCE_SHA"')
    expect(authority).toContain('test "$(git rev-parse HEAD)" = "$HOST_HEAD_SHA"')
    expect(authority).toContain("ATTEST_OPEN_DESIGN_M1_40_TURNS_AND_PREVIEWS")
    expect(step("Checkout exact Host authority").with["fetch-depth"]).toBe(0)
    expect(step("Checkout exact Host authority").with["persist-credentials"]).toBe(false)
  })

  test("limits, authenticates, and validates only sanitized canonical intake", () => {
    const decode = step("Decode and validate sanitized offline evidence").run
    expect(decode).toContain('test "${#EVIDENCE_BUNDLE_BASE64}" -le 60000')
    expect(decode).toContain('test "$(wc -c < "$intake"')
    expect(decode).toContain(" -le 45000")
    expect(decode).toContain("base64 --decode")
    expect(decode).toContain('test "$(base64 -w 0 "$intake")" = "$EVIDENCE_BUNDLE_BASE64"')
    expect(decode).toContain('shasum -a 256 "$intake"')
    expect(decode).toContain("scripts/qa/open-design-rc-acceptance-evidence.ts")
    expect(decode).toContain('--host-head-sha "$HOST_HEAD_SHA"')
    expect(decode).toContain("open-design-rc-acceptance-intake.json")
    expect(decode).toContain(".evidenceBundleSha256")
    expect(decode).toContain(".machineEvidence == $intake[0].evidence.machineBatch")
    expect(decode).toContain(".visualEvidence == $intake[0].evidence.visualDecisions")
    expect(decode).not.toContain('cat "$intake"')
  })

  test("revalidates Required CI and the exact Host engineering artifact online", () => {
    const online = step("Authenticate Required CI and exact Host artifact").run
    expect(online).toContain(".requiredCi.runs[]")
    expect(online).toContain(".conclusion")
    expect(online).toContain(".head_branch")
    expect(online).toContain(".head_sha")
    expect(online).toContain(".repository.full_name")
    expect(online).toContain(".path")
    expect(online).toContain("push|workflow_dispatch")
    expect(online).toContain(".github/workflows/engineering-rc.yml")
    expect(online).toContain("macos-arm64-unsigned")
    expect(online).toContain('shasum -a 256 "${dmgs[0]}"')
    expect(online).toContain(".hostArtifactSha256")
    expect(online).toContain("completed_before_batch")
  })

  test("authenticates the exact LKG and RC assets through the production verifier", () => {
    const release = step("Authenticate RC, LKG, and signed Catalog closure").run
    expect(release).toContain('test "$(find "$lkg"')
    expect(release).toContain("= 5")
    expect(release).toContain('test "$(find "$rc"')
    expect(release).toContain("= 4")
    expect(release).toContain("open-design-official-channel.json")
    expect(release).toContain('cmp "$SOURCE_AUTHORITY_CONFIG" "$lkg/$LKG_CONFIG_ASSET"')
    expect(release).toContain("createPublicKey")
    expect(release).toContain("encodeCanonicalCatalog")
    expect(release.match(/production-cli\.mjs/g)).toHaveLength(2)
    expect(release).toContain(".rcCatalogSequence")
    expect(release).toContain(".rcCatalogIssuedAt")
    expect(release).toContain(".rcArchiveSha256")
    expect(release).toContain(".rcExtractedManifestSha256")
    expect(release).toContain(".lkg.catalogSequence")
    expect(release).toContain(".lkg.archiveSha256")
    expect(release).toContain('--previous-sequence "$(jq -r .sequence <<<"$lkg_catalog")"')
    expect(release).toContain('--previous-issued-at "$(jq -r .issuedAt <<<"$lkg_catalog")"')
  })

  test("uploads only the exact three-file downstream artifact after all validation", () => {
    const sealIndex = job.steps.findIndex((candidate: Record<string, any>) => candidate.name === "Seal exact downstream evidence")
    const uploadIndex = job.steps.findIndex((candidate: Record<string, any>) => candidate.name === "Upload immutable acceptance evidence")
    expect(sealIndex).toBeGreaterThan(0)
    expect(uploadIndex).toBeGreaterThan(sealIndex)
    const seal = step("Seal exact downstream evidence").run
    expect(seal).toContain("open-design-rc-acceptance-evidence.json")
    expect(seal).toContain("open-design-rc-acceptance-intake.json")
    expect(seal).toContain("SHA256SUMS")
    expect(seal).toContain('test "$(wc -l < SHA256SUMS | tr -d \' \')" = 2')
    expect(seal).toContain('test "$(find "$ACCEPTANCE_OUTPUT" -maxdepth 1 -type f | wc -l | tr -d \' \')" = 3')
    const upload = step("Upload immutable acceptance evidence")
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")
    expect(upload.with.name).toBe("open-design-rc-acceptance-evidence")
    expect(upload.with.overwrite).toBe(false)
    expect(upload.if).toBeUndefined()
    expect(source).not.toContain("if: always()")
  })

  test("pins actions, stays free of provider execution, and is covered by static validation", () => {
    const actionReferences = [...source.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1])
    expect(actionReferences.length).toBeGreaterThan(0)
    expect(actionReferences.every((reference) => /@[0-9a-f]{40}$/.test(reference))).toBe(true)
    expect(source).not.toContain("SIMULATOR_HOST_AGENT_TOKEN")
    expect(source).not.toContain("OPENAI_API_KEY")
    expect(source).not.toContain("ANTHROPIC_API_KEY")
    expect(source).not.toContain("claude-agent")
    expect(staticSource).toContain(".github/workflows/open-design-rc-acceptance.yml")
    expect(staticSource).toContain("scripts/qa/open-design-rc-acceptance-evidence.test.ts")
  })

  test("keeps every embedded Bash and Node heredoc syntactically valid", () => {
    for (const candidate of job.steps as Array<Record<string, any>>) {
      if (candidate.shell !== "bash" || typeof candidate.run !== "string") continue
      const bash = spawnSync("bash", ["-n"], { input: candidate.run, encoding: "utf8" })
      expect(bash.status, `${candidate.name}: ${bash.stderr}`).toBe(0)
      for (const match of candidate.run.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE(?:\n|$)/g)) {
        const node = spawnSync("node", ["--check", "--input-type=module", "-"], {
          input: match[1],
          encoding: "utf8",
        })
        expect(node.status, `${candidate.name}: ${node.stderr}`).toBe(0)
      }
    }
  })
})
