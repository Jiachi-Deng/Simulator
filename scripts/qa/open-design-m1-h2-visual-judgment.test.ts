import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDeterministicMachineEvidenceFixture,
  validateOpenDesignM1MachineEvidence,
  type MachineEvidenceAuthority,
} from './open-design-m1-machine-evidence'
import { OPEN_DESIGN_M1_CASES } from './open-design-m1-cases'
import { OPEN_DESIGN_RC_SOURCE_SHA } from './open-design-rc-acceptance-evidence'
import {
  createOpenDesignM1H2VisualJudgment,
  validateOpenDesignM1H2VisualJudgment,
  type H2MachineAuthority,
  type H2VisualJudgmentInput,
} from './open-design-m1-h2-visual-judgment'
import { canonicalJson, sha256 } from './open-design-m1-local-evidence'

const roots: string[] = []
const sourceAuthority: MachineEvidenceAuthority = Object.freeze({
  hostHeadSha: '1234567890abcdef1234567890abcdef12345678',
  producerRunId: 9_001,
  producerRunAttempt: 1,
  hostBuildRunId: 8_001,
  hostArtifactSha256: 'a'.repeat(64),
  h1: {
    connectionEvidenceSha256: 'f'.repeat(64),
    handoffSha256: '9'.repeat(64),
  },
  lkg: {
    archiveSha256: 'b'.repeat(64),
    catalogIssuedAt: '2026-07-16T22:00:00.000Z',
    catalogSequence: 2,
    catalogSha256: sha256(JSON.stringify({ fixture: 'lkg-catalog' })),
    envelopeSha256: sha256(JSON.stringify({ fixture: 'lkg-envelope' })),
    expiresAt: '2026-07-19T22:00:00.000Z',
    extractedManifestSha256: 'c'.repeat(64),
  },
  rc: {
    archiveSha256: 'd'.repeat(64),
    catalogIssuedAt: '2026-07-17T00:00:00.000Z',
    catalogSequence: 3,
    catalogSha256: sha256(JSON.stringify({ fixture: 'rc-catalog' })),
    envelopeSha256: sha256(JSON.stringify({ fixture: 'rc-envelope' })),
    expiresAt: '2026-07-19T22:00:00.000Z',
    extractedManifestSha256: 'e'.repeat(64),
    sourceSha: OPEN_DESIGN_RC_SOURCE_SHA,
  },
})

interface Fixture {
  readonly parent: string
  readonly machineRoot: string
  readonly judgmentsPath: string
  readonly outputRoot: string
  readonly completedAt: string
  readonly authority: H2MachineAuthority
  readonly judgments: H2VisualJudgmentInput[]
}

async function fixture(): Promise<Fixture> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'open-design-m1-h2-test-')))
  roots.push(parent)
  await chmod(parent, 0o700)
  const machineRoot = join(parent, 'machine')
  await createDeterministicMachineEvidenceFixture(machineRoot, sourceAuthority)
  const validation = await validateOpenDesignM1MachineEvidence(machineRoot, sourceAuthority)
  const manifest = JSON.parse(await readFile(join(machineRoot, 'machine-manifest.json'), 'utf8'))
  const batchCompletedAt = Date.parse(manifest.batch.completedAt)
  const previews = new Map<string, string>()
  for (const record of manifest.records) {
    if (record.stack === 'new') previews.set(record.caseId, record.preview.sha256)
  }
  const judgments = OPEN_DESIGN_M1_CASES.map((testCase, index) => ({
    caseId: testCase.id,
    decision: 'PASS' as const,
    previewSha256: previews.get(testCase.id)!,
    reason: `人工确认 ${testCase.id} 满足固定 visual assertion`,
    reviewedAt: new Date(batchCompletedAt + (index + 1) * 1_000).toISOString(),
  }))
  const completedAt = new Date(batchCompletedAt + 30_000).toISOString()
  const judgmentsPath = join(parent, 'private-judgments.json')
  await writeFile(judgmentsPath, canonicalJson(judgments), { mode: 0o600 })
  await chmod(judgmentsPath, 0o600)
  return {
    parent,
    machineRoot,
    judgmentsPath,
    outputRoot: join(parent, 'h2-evidence'),
    completedAt,
    authority: {
      sourceSha: sourceAuthority.hostHeadSha,
      machineRunId: sourceAuthority.producerRunId,
      machineManifestSha256: validation.sha256,
      hostBuildRunId: sourceAuthority.hostBuildRunId,
      hostArtifactSha256: sourceAuthority.hostArtifactSha256,
    },
    judgments,
  }
}

async function writeJudgments(value: Fixture, judgments: unknown): Promise<void> {
  await writeFile(value.judgmentsPath, canonicalJson(judgments), { mode: 0o600 })
  await chmod(value.judgmentsPath, 0o600)
}

async function produce(): Promise<Fixture> {
  const value = await fixture()
  await createOpenDesignM1H2VisualJudgment(
    value.outputRoot,
    value.machineRoot,
    value.judgmentsPath,
    value.authority,
    value.completedAt,
  )
  return value
}

async function reseal(root: string): Promise<void> {
  const paths = (await readdir(root)).filter((path) => path !== 'SHA256SUMS').sort()
  const sums: string[] = []
  for (const path of paths) sums.push(`${sha256(await readFile(join(root, path)))}  ${path}`)
  await writeFile(join(root, 'SHA256SUMS'), `${sums.join('\n')}\n`, { mode: 0o600 })
  await chmod(join(root, 'SHA256SUMS'), 0o600)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenDesign M1 H2 local visual judgment sealer', () => {
  it('cross-binds 20 PASS judgments and emits only minimal non-sensitive workflow input', async () => {
    const value = await produce()
    const result = await validateOpenDesignM1H2VisualJudgment(value.outputRoot, value.machineRoot, value.authority)
    expect(result).toEqual({
      objectPath: 'h2-visual-judgment.json',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      result: 'passed',
      workflowReady: true,
      workflowInputObjectPath: 'visual-attestation-workflow-input.json',
      workflowInputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect((await readdir(value.outputRoot)).sort()).toEqual([
      'SHA256SUMS', 'h2-visual-judgment.json', 'visual-attestation-workflow-input.json',
    ])
    for (const path of await readdir(value.outputRoot)) {
      expect((await lstat(join(value.outputRoot, path))).mode & 0o777).toBe(0o600)
    }
    const proof = JSON.parse(await readFile(join(value.outputRoot, 'h2-visual-judgment.json'), 'utf8'))
    expect(proof.authority).toEqual(expect.objectContaining({
      sourceSha: value.authority.sourceSha,
      machineRunId: value.authority.machineRunId,
      machineManifestSha256: value.authority.machineManifestSha256,
      hostBuildRunId: value.authority.hostBuildRunId,
      hostArtifactSha256: value.authority.hostArtifactSha256,
    }))
    expect(proof.judgments).toHaveLength(20)
    expect(proof.judgments[0].reason).toContain('人工确认')

    const workflow = JSON.parse(await readFile(
      join(value.outputRoot, 'visual-attestation-workflow-input.json'),
      'utf8',
    ))
    expect(Object.keys(workflow).sort()).toEqual([
      'confirmation', 'decisions_base64', 'decisions_sha256', 'machine_run_id',
    ])
    const publicDecisions = Buffer.from(workflow.decisions_base64, 'base64').toString('utf8')
    expect(publicDecisions).not.toContain('reason')
    expect(publicDecisions).not.toContain('previewSha256')
    expect(publicDecisions).not.toContain('人工确认')
    expect(JSON.parse(publicDecisions)[0]).toEqual({
      caseId: 'D01', decision: 'PASS', reviewedAt: value.judgments[0]!.reviewedAt,
    })
  })

  it('seals FAIL decisions locally but emits no dispatchable workflow input', async () => {
    const value = await fixture()
    value.judgments[4] = {
      ...value.judgments[4]!,
      decision: 'FAIL',
      reason: '窄屏布局出现水平溢出，不能通过。',
    }
    await writeJudgments(value, value.judgments)
    const result = await createOpenDesignM1H2VisualJudgment(
      value.outputRoot,
      value.machineRoot,
      value.judgmentsPath,
      value.authority,
      value.completedAt,
    )
    expect(result).toEqual(expect.objectContaining({
      result: 'failed',
      workflowReady: false,
      workflowInputObjectPath: null,
      workflowInputSha256: null,
    }))
    expect((await readdir(value.outputRoot)).sort()).toEqual(['SHA256SUMS', 'h2-visual-judgment.json'])
    const proof = JSON.parse(await readFile(join(value.outputRoot, 'h2-visual-judgment.json'), 'utf8'))
    expect(proof.review.failedCaseIds).toEqual([value.judgments[4]!.caseId])
    expect(proof.review.result).toBe('failed')
  })

  it('rejects unknown, duplicate, missing, reordered, and malformed judgment fields without output', async () => {
    const mutations: Array<(judgments: Array<Record<string, unknown>>) => unknown> = [
      (judgments) => { judgments[0]!.unknown = true; return judgments },
      (judgments) => { judgments[1]!.caseId = judgments[0]!.caseId; return judgments },
      (judgments) => { delete judgments[0]!.reason; return judgments },
      (judgments) => { [judgments[0], judgments[1]] = [judgments[1]!, judgments[0]!]; return judgments },
      (judgments) => { judgments[0]!.reason = '   '; return judgments },
      (judgments) => judgments.slice(0, 19),
    ]
    for (const mutate of mutations) {
      const value = await fixture()
      const judgments = value.judgments.map((judgment) => ({ ...judgment }))
      await writeJudgments(value, mutate(judgments))
      await expect(createOpenDesignM1H2VisualJudgment(
        value.outputRoot,
        value.machineRoot,
        value.judgmentsPath,
        value.authority,
        value.completedAt,
      )).rejects.toThrow()
      expect(await readdir(value.parent)).not.toContain('h2-evidence')
      expect((await readdir(value.parent)).some((name) => name.includes('.tmp-'))).toBe(false)
    }
  })

  it('rejects preview hash substitutions, stale timestamps, and non-canonical private input', async () => {
    const wrongHash = await fixture()
    wrongHash.judgments[0] = { ...wrongHash.judgments[0]!, previewSha256: 'f'.repeat(64) }
    await writeJudgments(wrongHash, wrongHash.judgments)
    await expect(createOpenDesignM1H2VisualJudgment(
      wrongHash.outputRoot, wrongHash.machineRoot, wrongHash.judgmentsPath, wrongHash.authority, wrongHash.completedAt,
    )).rejects.toThrow('authenticated machine Preview')

    const stale = await fixture()
    stale.judgments[0] = { ...stale.judgments[0]!, reviewedAt: '2026-07-17T00:00:00.000Z' }
    await writeJudgments(stale, stale.judgments)
    await expect(createOpenDesignM1H2VisualJudgment(
      stale.outputRoot, stale.machineRoot, stale.judgmentsPath, stale.authority, stale.completedAt,
    )).rejects.toThrow('reviewedAt')

    const nonCanonical = await fixture()
    await writeFile(nonCanonical.judgmentsPath, `${canonicalJson(nonCanonical.judgments)} `, { mode: 0o600 })
    await expect(createOpenDesignM1H2VisualJudgment(
      nonCanonical.outputRoot,
      nonCanonical.machineRoot,
      nonCanonical.judgmentsPath,
      nonCanonical.authority,
      nonCanonical.completedAt,
    )).rejects.toThrow('canonical compact JSON')
  })

  it('rejects wrong source, run, manifest, build, and Host artifact authorities', async () => {
    const value = await produce()
    const attempts: H2MachineAuthority[] = [
      { ...value.authority, sourceSha: '9'.repeat(40) },
      { ...value.authority, machineRunId: value.authority.machineRunId + 1 },
      { ...value.authority, machineManifestSha256: 'b'.repeat(64) },
      { ...value.authority, hostBuildRunId: value.authority.hostBuildRunId + 1 },
      { ...value.authority, hostArtifactSha256: 'c'.repeat(64) },
    ]
    for (const authority of attempts) {
      await expect(validateOpenDesignM1H2VisualJudgment(value.outputRoot, value.machineRoot, authority))
        .rejects.toThrow()
    }
  })

  it('rejects symlinks, widened permissions, partial writes, checksum tamper, and private workflow leakage', async () => {
    const linked = await produce()
    await unlink(join(linked.outputRoot, 'SHA256SUMS'))
    await symlink('h2-visual-judgment.json', join(linked.outputRoot, 'SHA256SUMS'))
    await expect(validateOpenDesignM1H2VisualJudgment(linked.outputRoot, linked.machineRoot, linked.authority))
      .rejects.toThrow('owner-only regular file')

    const permissive = await produce()
    await chmod(join(permissive.outputRoot, 'h2-visual-judgment.json'), 0o644)
    await expect(validateOpenDesignM1H2VisualJudgment(permissive.outputRoot, permissive.machineRoot, permissive.authority))
      .rejects.toThrow('canonical regular file')

    const partial = await produce()
    await writeFile(join(partial.outputRoot, 'h2-visual-judgment.json'), '{"schemaVersion":1', { mode: 0o600 })
    await expect(validateOpenDesignM1H2VisualJudgment(partial.outputRoot, partial.machineRoot, partial.authority))
      .rejects.toThrow('is not JSON')

    const checksum = await produce()
    await writeFile(join(checksum.outputRoot, 'SHA256SUMS'), `${'0'.repeat(64)}  h2-visual-judgment.json\n`, { mode: 0o600 })
    await expect(validateOpenDesignM1H2VisualJudgment(checksum.outputRoot, checksum.machineRoot, checksum.authority))
      .rejects.toThrow('SHA256SUMS')

    const leaked = await produce()
    const workflowPath = join(leaked.outputRoot, 'visual-attestation-workflow-input.json')
    const workflow = JSON.parse(await readFile(workflowPath, 'utf8'))
    workflow.private_reason = 'must never upload'
    await writeFile(workflowPath, canonicalJson(workflow), { mode: 0o600 })
    await reseal(leaked.outputRoot)
    await expect(validateOpenDesignM1H2VisualJudgment(leaked.outputRoot, leaked.machineRoot, leaked.authority))
      .rejects.toThrow('minimal workflow input')
  })
})
