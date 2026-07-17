import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const workflowPath = join(root, '.github/workflows/open-design-rc-acceptance.yml')
const staticPath = join(root, '.github/workflows/release-static-validation.yml')
const source = readFileSync(workflowPath, 'utf8')
const staticSource = readFileSync(staticPath, 'utf8')
const workflow = Bun.YAML.parse(source) as Record<string, any>
const job = workflow.jobs['notarize-acceptance-evidence']

function step(name: string): Record<string, any> {
  const found = job.steps.find((candidate: Record<string, any>) => candidate.name === name)
  if (!found) throw new Error(`Missing acceptance workflow step: ${name}`)
  return found
}

describe('OpenDesign RC acceptance evidence workflow', () => {
  test('is protected, main-only, read-only, and accepts only producer run IDs plus fixed approval', () => {
    expect(workflow.on.workflow_dispatch).toBeDefined()
    expect(workflow.on.push).toBeUndefined()
    expect(workflow.on.pull_request).toBeUndefined()
    expect(workflow.on.schedule).toBeUndefined()
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(workflow.concurrency).toEqual({
      group: 'open-design-rc-acceptance-evidence',
      'cancel-in-progress': false,
    })
    expect(job.if).toContain("github.repository == 'Jiachi-Deng/Simulator'")
    expect(job.if).toContain("github.ref == 'refs/heads/main'")
    expect(job.if).toContain("vars.OPEN_DESIGN_RC_ACCEPTANCE_ENABLED == 'true'")
    expect(job.if).toContain('inputs.acceptance_approved == true')
    expect(job.environment.name).toBe('open-design-rc-acceptance')
    const inputs = workflow.on.workflow_dispatch.inputs
    expect(Object.keys(inputs).sort()).toEqual([
      'acceptance_approved', 'acceptance_confirmation', 'machine_run_id', 'visual_run_id',
    ])
    expect(inputs.acceptance_approved.default).toBe(false)
    expect(inputs.machine_run_id.required).toBe(true)
    expect(inputs.visual_run_id.required).toBe(true)
    expect(inputs).not.toHaveProperty('evidence_bundle_base64')
    expect(inputs).not.toHaveProperty('evidence_bundle_sha256')
    expect(inputs).not.toHaveProperty('hostHeadSha')
    expect(inputs).not.toHaveProperty('rcSourceSha')
  })

  test('binds immutable RC source, current Host authority, and a checkout without persisted credentials', () => {
    const authority = step('Validate fixed dual-source authority').run
    expect(authority).toContain('git rev-parse "refs/tags/$RC_TAG^{commit}"')
    expect(authority).toContain('git merge-base --is-ancestor "$RC_SOURCE_SHA" "$HOST_HEAD_SHA"')
    expect(authority).toContain('git show "$RC_SOURCE_SHA:$authority_path"')
    expect(authority).toContain('scripts/qa/open-design-m1-cases.ts')
    expect(authority).toContain('scripts/qa/generate-open-design-m1-case-artifacts.ts')
    expect(authority).toContain('.targetCommitish <<<"$rc_state")" = "$RC_SOURCE_SHA"')
    expect(authority).toContain('NOTARIZE_OPEN_DESIGN_M1_MACHINE_AND_VISUAL_RUNS')
    expect(job.env.HOST_HEAD_SHA).toBe('${{ github.sha }}')
    expect(job.env.RC_SOURCE_SHA).toBe('6b39a9bcc0f158645897976e23f334c5cab771f4')
    expect(step('Checkout exact Host authority').with['fetch-depth']).toBe(0)
    expect(step('Checkout exact Host authority').with['persist-credentials']).toBe(false)
  })

  test('authenticates exact producer runs, self-hosted labels, chronology, and safely bounded artifacts', () => {
    const authenticate = step('Authenticate exact producer runs and safely extract artifacts').run
    for (const value of [
      'actions/runs/$MACHINE_RUN_ID', 'actions/runs/$VISUAL_RUN_ID', 'actions/runs/$GITHUB_RUN_ID',
      '.conclusion', '.head_branch', '.head_sha', '.repository.full_name', '.path', '.run_attempt',
      'workflow_dispatch', 'values[0] < values[1]',
    ]) expect(authenticate).toContain(value)
    for (const label of ['self-hosted', 'macOS', 'ARM64', 'simulator-open-design-m1']) {
      expect(authenticate).toContain(label)
    }
    expect(authenticate).toContain('actions/artifacts/$artifact_id/zip')
    expect(authenticate).toContain('select(.expired == false)')
    expect(authenticate).toContain('expected_files')
    expect(authenticate).toContain('96 * 1024 * 1024')
    expect(authenticate).toContain('128 * 1024')
    expect(authenticate).toContain('maximum_members, maximum_directories')
    expect(authenticate).toContain('maximum_path_bytes = 512')
    expect(authenticate).toContain('maximum_path_depth = 8')
    expect(authenticate).toContain('len(raw.encode("utf-8")) > maximum_path_bytes')
    expect(authenticate).toContain('len(parts) > maximum_path_depth')
    expect(authenticate).toContain('raw in seen')
    expect(authenticate).toContain('artifact contains too many members')
    expect(authenticate).toContain('artifact contains too many directories')
    expect(authenticate).toContain('extract(machine_zip, machine_root, 150, 96 * 1024 * 1024, machine_limit, 182, 32)')
    expect(authenticate).toContain('extract(visual_zip, visual_root, 2, 128 * 1024, visual_limit, 6, 4)')
    expect(authenticate).toContain('stat.S_ISLNK')
    expect(authenticate).toContain('encrypted artifact member')
    expect(authenticate).toContain('unsupported artifact compression')
    expect(authenticate).toContain('open(destination, "xb")')
    expect(authenticate).not.toContain('evidence_bundle_base64')
  })

  test('revalidates every Required CI descriptor and the exact Host engineering artifact online', () => {
    const online = step('Authenticate Required CI and exact Host artifact').run
    expect(online).toContain("jq -ce '.runs[]' \"$required_ci\"")
    expect(online).toContain('.conclusion')
    expect(online).toContain('.head_branch')
    expect(online).toContain('.head_sha')
    expect(online).toContain('.repository.full_name')
    expect(online).toContain('.path')
    expect(online).toContain('.run_attempt')
    expect(online).toContain('push|workflow_dispatch')
    expect(online).toContain('.github/workflows/engineering-rc.yml')
    expect(online).toContain('macos-arm64-unsigned')
    expect(online).toContain('actions/artifacts/$artifact_id/zip')
    expect(online).not.toContain('gh run download')
    expect(online).toContain('expected_files = {')
    expect(online).toContain('maximum_members = 19')
    expect(online).toContain('maximum_directories = 1')
    expect(online).toContain('len(raw.encode("utf-8")) > maximum_path_bytes')
    expect(online).toContain('raw in seen')
    expect(online).toContain('exact 18-file Engineering RC closure')
    expect(online).toContain('len(lines) != 17')
    expect(online).toContain('Host artifact checksum mismatch')
    expect(online).toContain('shasum -a 256 "$host_download/$HOST_ARTIFACT_NAME"')
    expect(online).toContain('completed_before_batch')
    for (const expected of [
      'Simulator-arm64.dmg', 'Simulator-arm64.zip', 'app-inventory.jsonl',
      'attestations/provenance.sigstore.json', 'attestations/sbom.sigstore.json',
      'bundle-metadata.json', 'dmg-app-inventory.raw.jsonl', 'dmg-signatures.json',
      'package-verification-code.txt', 'packaged-files.sha256', 'rc-validation.json',
      'sbom.spdx.json', 'transport-normalization-policy.json', 'verification-input.json',
      'zip-app-inventory.raw.jsonl', 'zip-signatures.json', 'RELEASE_NOTES.md', 'SHA256SUMS',
    ]) expect(online).toContain(`"${expected}"`)
  })

  test('authenticates exact LKG and RC bytes, signed Catalog high-water, and machine trust closure', () => {
    const release = step('Authenticate RC, LKG, and signed Catalog closure').run
    expect(release).toContain('expected_lkg')
    expect(release).toContain('expected_rc')
    expect(release).toContain('open-design-official-channel.json')
    expect(release).toContain('cmp "$SOURCE_AUTHORITY_CONFIG" "$lkg/$LKG_CONFIG_ASSET"')
    expect(release).toContain('cmp "$rc/$RC_CATALOG_ASSET" "$MACHINE_ROOT/trust/rc-catalog.json"')
    expect(release).toContain('createPublicKey')
    expect(release).toContain('encodeCanonicalCatalog')
    expect(release.match(/production-cli\.mjs/g)).toHaveLength(2)
    expect(release).toContain('.lkg.catalogSequence "$manifest"')
    expect(release).toContain('.rc.catalogSequence "$manifest"')
    expect(release).toContain('--previous-sequence')
    expect(release).toContain('--previous-issued-at')
    expect(release).toContain('final-authority.json')
    expect(release).toContain('machineRunAttempt: 1')
    expect(release).toContain('visualRunAttempt: 1')
  })

  test('cross-binds both producer artifacts and uploads only the exact three-file final artifact', () => {
    const sealName = 'Cross-bind producers and seal exact downstream evidence'
    const sealIndex = job.steps.findIndex((candidate: Record<string, any>) => candidate.name === sealName)
    const uploadIndex = job.steps.findIndex((candidate: Record<string, any>) => candidate.name === 'Upload immutable acceptance evidence')
    expect(sealIndex).toBeGreaterThan(0)
    expect(uploadIndex).toBeGreaterThan(sealIndex)
    const seal = step(sealName).run
    expect(seal).toContain('open-design-m1-final-evidence.ts')
    expect(seal).toContain('--machine-root "$MACHINE_ROOT"')
    expect(seal).toContain('--visual-root "$VISUAL_ROOT"')
    expect(seal).toContain('.machineEvidence.runId')
    expect(seal).toContain('.visualEvidence.runId')
    expect(seal).toContain('open-design-rc-acceptance-intake.json')
    expect(seal).toContain('open-design-rc-acceptance-evidence.json')
    expect(seal).toContain('= 3')
    const upload = step('Upload immutable acceptance evidence')
    expect(upload.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a')
    expect(upload.with.name).toBe('open-design-rc-acceptance-evidence')
    expect(upload.with.overwrite).toBe(false)
  })

  test('pins actions, stays provider-free, and is included in static validation', () => {
    const actionReferences = [...source.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1])
    expect(actionReferences.length).toBeGreaterThan(0)
    expect(actionReferences.every((reference) => /@[0-9a-f]{40}$/.test(reference))).toBe(true)
    expect(source).not.toContain('OPEN_DESIGN_RELEASE_PRIVATE_KEY')
    expect(source).not.toContain('ANTHROPIC_API_KEY')
    expect(source).not.toContain('OPENAI_API_KEY')
    expect(staticSource).toContain('.github/workflows/open-design-rc-acceptance.yml')
    expect(staticSource).toContain('scripts/release/*.test.ts')
    expect(step('Record attestation boundary').run)
      .toContain('authenticated machine and visual producer artifact references')
    expect(step('Record attestation boundary').run).not.toContain('offline evidence authority references')
  })

  test('keeps every embedded Bash, Node, and Python heredoc syntactically valid', () => {
    for (const candidate of job.steps as Array<Record<string, any>>) {
      if (candidate.shell !== 'bash' || typeof candidate.run !== 'string') continue
      const bash = spawnSync('bash', ['-n'], { input: candidate.run, encoding: 'utf8' })
      expect(bash.status, `${candidate.name}: ${bash.stderr}`).toBe(0)
      for (const match of candidate.run.matchAll(/node(?: --input-type=module)? <<'NODE'\n([\s\S]*?)\nNODE(?:\n|$)/g)) {
        const node = spawnSync('node', ['--check', '--input-type=module'], { input: match[1], encoding: 'utf8' })
        expect(node.status, `${candidate.name}: ${node.stderr}`).toBe(0)
      }
      for (const match of candidate.run.matchAll(/python3 [^\n]* <<'PY'\n([\s\S]*?)\nPY(?:\n|$)/g)) {
        const python = spawnSync('python3', ['-c', "import sys; compile(sys.stdin.read(), '<heredoc>', 'exec')"], {
          input: match[1], encoding: 'utf8',
        })
        expect(python.status, `${candidate.name}: ${python.stderr}`).toBe(0)
      }
    }
  })
})
