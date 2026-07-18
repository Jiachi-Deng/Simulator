import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const workflowPath = join(root, '.github/workflows/open-design-m1-visual-attestation.yml')
const source = readFileSync(workflowPath, 'utf8')
const workflow = Bun.YAML.parse(source) as Record<string, any>
const job = workflow.jobs['attest-previews']

function step(name: string): Record<string, any> {
  const found = job.steps.find((candidate: Record<string, any>) => candidate.name === name)
  if (!found) throw new Error(`Missing visual attestation workflow step: ${name}`)
  return found
}

describe('OpenDesign M1 visual attestation producer workflow', () => {
  test('is a protected main-only, read-only, non-cancelling manual producer', () => {
    expect(workflow.on.workflow_dispatch).toBeDefined()
    expect(workflow.on.push).toBeUndefined()
    expect(workflow.on.pull_request).toBeUndefined()
    expect(workflow.on.schedule).toBeUndefined()
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' })
    expect(workflow.concurrency).toEqual({
      group: 'open-design-m1-visual-attestation',
      'cancel-in-progress': false,
    })
    expect(job['runs-on']).toBe('ubuntu-latest')
    expect(job.environment.name).toBe('open-design-m1-visual-attestation')
    expect(job.if).toContain("github.repository == 'Jiachi-Deng/Simulator'")
    expect(job.if).toContain("github.ref == 'refs/heads/main'")
    expect(job.if).toContain("vars.OPEN_DESIGN_M1_VISUAL_ATTESTATION_ENABLED == 'true'")
  })

  test('accepts only a machine run ID, the bounded decision array, its digest, and fixed confirmation', () => {
    const inputs = workflow.on.workflow_dispatch.inputs
    expect(Object.keys(inputs).sort()).toEqual([
      'confirmation',
      'decisions_base64',
      'decisions_sha256',
      'machine_run_id',
    ])
    expect(inputs.machine_run_id.type).toBe('string')
    expect(inputs.decisions_base64.type).toBe('string')
    expect(inputs.decisions_sha256.type).toBe('string')
    expect(inputs.confirmation.description).toContain('ATTEST_OPEN_DESIGN_M1_20_PREVIEWS')
    expect(inputs).not.toHaveProperty('headSha')
    expect(inputs).not.toHaveProperty('hostArtifactSha256')
    expect(inputs).not.toHaveProperty('rcArchiveSha256')
    expect(inputs).not.toHaveProperty('machineManifestSha256')
  })

  test('derives producer authority from Actions and authenticates one exact machine artifact', () => {
    const checkout = step('Checkout exact visual producer authority')
    expect(checkout.with.ref).toBe('${{ github.sha }}')
    expect(checkout.with['persist-credentials']).toBe(false)

    const authenticate = step('Authenticate exact machine producer run and artifact').run
    expect(authenticate).toContain('test "$GITHUB_RUN_ATTEMPT" = "1"')
    expect(authenticate).toContain('ATTEST_OPEN_DESIGN_M1_20_PREVIEWS')
    expect(authenticate).toContain('actions/runs/$MACHINE_RUN_ID')
    expect(authenticate).toContain('.conclusion')
    expect(authenticate).toContain('.head_branch')
    expect(authenticate).toContain('.head_sha')
    expect(authenticate).toContain('.repository.full_name')
    expect(authenticate).toContain('.path')
    expect(authenticate).toContain('.run_attempt')
    expect(authenticate).toContain('workflow_dispatch')
    expect(authenticate).toContain('actions/runs/$GITHUB_RUN_ID')
    expect(authenticate).toContain('machineCompleted >= visualCreated')
    expect(authenticate).toContain('.updated_at <<<"$machine_run"')
    expect(authenticate).toContain('.created_at <<<"$visual_run"')
    expect(authenticate).toContain('attempts/1/jobs')
    for (const label of ['self-hosted', 'macOS', 'ARM64', 'simulator-open-design-m1']) {
      expect(authenticate).toContain(label)
    }
    expect(authenticate).toContain('jq -r .total_count')
    expect(authenticate).toContain('[.artifacts[] | select(.expired == false)] | length')
    expect(job.env.MACHINE_ARTIFACT_NAME).toBe('open-design-m1-machine-evidence')
    expect(authenticate).toContain('actions/artifacts/$artifact_id/zip')
    expect(authenticate).not.toContain('gh run download')
  })

  test('extracts machine evidence fail-closed and bounds canonical decisions to 8 KiB', () => {
    const authenticate = step('Authenticate exact machine producer run and artifact').run
    expect(authenticate).toContain('files != 150')
    expect(authenticate).toContain('96 * 1024 * 1024')
    expect(authenticate).toContain('if path.startswith("records/"): return 384 * 1024')
    expect(authenticate).toContain('maximum_members = 182')
    expect(authenticate).toContain('maximum_directories = 32')
    expect(authenticate).toContain('maximum_path_bytes = 512')
    expect(authenticate).toContain('maximum_path_depth = 8')
    expect(authenticate).toContain('len(raw_path.encode("utf-8")) > maximum_path_bytes')
    expect(authenticate).toContain('len(raw_parts) > maximum_path_depth')
    expect(authenticate).toContain('raw_path in seen')
    expect(authenticate).toContain('artifact contains too many members')
    expect(authenticate).toContain('artifact contains too many directories')
    expect(authenticate).toContain('stat.S_ISLNK')
    expect(authenticate).toContain('encrypted artifact member')
    expect(authenticate).toContain('unsupported artifact compression')
    expect(authenticate).toContain('unexpected artifact path')
    expect(authenticate).toContain('open(destination, "xb")')

    const decode = step('Decode exact product-owner Preview decisions').run
    expect(decode).toContain('${#DECISIONS_BASE64}" -le 10924')
    expect(decode).toContain('" -le 8192')
    expect(decode).toContain('base64 --decode')
    expect(decode).toContain('base64 -w 0')
    expect(decode).toContain('sha256sum "$decisions"')
    expect(decode).not.toContain('cat "$decisions"')
  })

  test('cross-binds immutable run context and uploads only the exact two-file artifact', () => {
    const seal = step('Cross-bind and seal exact visual attestation').run
    expect(seal).toContain('open-design-m1-visual-attestation.ts produce')
    expect(seal).toContain('--machine-run-id "$MACHINE_RUN_ID"')
    expect(seal).toContain('--machine-head-sha "$MACHINE_HEAD_SHA"')
    expect(seal).toContain('--visual-run-id "$GITHUB_RUN_ID"')
    expect(seal).toContain('--visual-run-attempt "$GITHUB_RUN_ATTEMPT"')
    expect(seal).toContain('--visual-head-sha "$GITHUB_SHA"')
    expect(seal).toContain('open-design-m1-visual-attestation.ts validate')
    expect(seal).toContain('= 2')

    const upload = step('Upload immutable visual attestation')
    expect(upload.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a')
    expect(upload.with.name).toBe('open-design-m1-visual-attestation')
    expect(upload.with.path).toBe('${{ env.VISUAL_OUTPUT }}')
    expect(upload.with.overwrite).toBe(false)
    expect(upload.with['include-hidden-files']).toBe(false)
    expect(upload.if).toBeUndefined()
    expect(source).not.toContain('if: always()')
  })

  test('pins every action and contains no provider credential or model execution surface', () => {
    const actionReferences = [...source.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1])
    expect(actionReferences.length).toBeGreaterThan(0)
    expect(actionReferences.every((reference) => /@[0-9a-f]{40}$/.test(reference))).toBe(true)
    for (const forbidden of [
      'SIMULATOR_HOST_AGENT_TOKEN',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPEN_DESIGN_RELEASE_PRIVATE_KEY',
      'claude-agent',
      'paid_turns_approved',
    ]) expect(source).not.toContain(forbidden)
  })

  test('keeps embedded Bash and Python syntax valid', () => {
    for (const candidate of job.steps as Array<Record<string, any>>) {
      if (candidate.shell !== 'bash' || typeof candidate.run !== 'string') continue
      const bash = spawnSync('bash', ['-n'], { input: candidate.run, encoding: 'utf8' })
      expect(bash.status, `${candidate.name}: ${bash.stderr}`).toBe(0)
      for (const match of candidate.run.matchAll(/python3 [^\n]* <<'PY'\n([\s\S]*?)\nPY(?:\n|$)/g)) {
        const python = spawnSync('python3', ['-c', "import sys; compile(sys.stdin.read(), '<heredoc>', 'exec')"], {
          input: match[1],
          encoding: 'utf8',
        })
        expect(python.status, `${candidate.name}: ${python.stderr}`).toBe(0)
      }
    }
  })
})
