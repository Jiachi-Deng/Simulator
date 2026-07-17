import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDeterministicMachineEvidenceFixture,
  type MachineEvidenceAuthority,
} from './open-design-m1-machine-evidence'
import {
  createOpenDesignM1VisualAttestation,
  visualAttestationTestOnly,
} from './open-design-m1-visual-attestation'
import {
  OPEN_DESIGN_M1_FINAL_ARTIFACT_NAME,
  createOpenDesignM1FinalEvidence,
  parseFinalEvidenceAuthority,
  type FinalEvidenceAuthority,
} from './open-design-m1-final-evidence'
import { OPEN_DESIGN_M1_CASES } from './open-design-m1-cases'
import { OPEN_DESIGN_ACCEPTANCE_REPOSITORY, OPEN_DESIGN_RC_SOURCE_SHA } from './open-design-rc-acceptance-evidence'

const roots: string[] = []
const canonical = (value: unknown): string => `${JSON.stringify(value)}\n`
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const lkgCatalog = { fixture: 'lkg-catalog' }
const lkgEnvelope = { fixture: 'lkg-envelope' }
const rcCatalog = { fixture: 'rc-catalog' }
const rcEnvelope = { fixture: 'rc-envelope' }
const machineAuthority: MachineEvidenceAuthority = {
  hostHeadSha: '1234567890abcdef1234567890abcdef12345678',
  producerRunId: 9001,
  producerRunAttempt: 1,
  hostBuildRunId: 8001,
  hostArtifactSha256: 'a'.repeat(64),
  lkg: {
    archiveSha256: 'b'.repeat(64),
    catalogIssuedAt: '2026-07-16T22:00:00.000Z',
    catalogSequence: 2,
    catalogSha256: digest(JSON.stringify(lkgCatalog)),
    envelopeSha256: digest(JSON.stringify(lkgEnvelope)),
    expiresAt: '2026-07-19T22:00:00.000Z',
    extractedManifestSha256: 'c'.repeat(64),
  },
  rc: {
    archiveSha256: 'd'.repeat(64),
    catalogIssuedAt: '2026-07-17T00:00:00.000Z',
    catalogSequence: 3,
    catalogSha256: digest(JSON.stringify(rcCatalog)),
    envelopeSha256: digest(JSON.stringify(rcEnvelope)),
    expiresAt: '2026-07-19T22:00:00.000Z',
    extractedManifestSha256: 'e'.repeat(64),
    sourceSha: OPEN_DESIGN_RC_SOURCE_SHA,
  },
}

async function fixture(): Promise<{
  authority: FinalEvidenceAuthority
  machineRoot: string
  outputRoot: string
  visualRoot: string
}> {
  const root = join(tmpdir(), `open-design-m1-final-${randomUUID()}`)
  roots.push(root)
  await mkdir(root, { mode: 0o700 })
  const machineRoot = join(root, 'machine')
  const visualRoot = join(root, 'visual')
  const outputRoot = join(root, 'final')
  await createDeterministicMachineEvidenceFixture(machineRoot, machineAuthority)
  const manifest = JSON.parse(await readFile(join(machineRoot, 'machine-manifest.json'), 'utf8'))
  const batchCompleted = Date.parse(manifest.batch.completedAt)
  const decisionsPath = join(root, 'decisions.json')
  const decisions = OPEN_DESIGN_M1_CASES.map((testCase, index) => ({
    caseId: testCase.id,
    decision: 'PASS',
    reviewedAt: new Date(batchCompleted + (index + 1) * 1_000).toISOString(),
  }))
  await writeFile(decisionsPath, canonical(decisions), { mode: 0o600 })
  const visualCompleted = batchCompleted + 30_000
  await createOpenDesignM1VisualAttestation(
    machineRoot,
    decisionsPath,
    visualRoot,
    {
      machineHeadSha: machineAuthority.hostHeadSha,
      machineRunAttempt: 1,
      machineRunId: machineAuthority.producerRunId,
      visualHeadSha: machineAuthority.hostHeadSha,
      visualRunAttempt: 1,
      visualRunId: 9002,
    },
    new Date(visualCompleted).toISOString(),
  )
  const machineCompleted = batchCompleted + 500
  const visualCreated = batchCompleted + 1_000
  const authority: FinalEvidenceAuthority = {
    finalCreatedAt: new Date(visualCompleted + 1_000).toISOString(),
    hostArtifactSha256: machineAuthority.hostArtifactSha256,
    hostBuildRunId: machineAuthority.hostBuildRunId,
    hostHeadSha: machineAuthority.hostHeadSha,
    lkg: machineAuthority.lkg,
    machineCompletedAt: new Date(machineCompleted).toISOString(),
    machineRunAttempt: 1,
    machineRunId: machineAuthority.producerRunId,
    rc: machineAuthority.rc,
    visualCompletedAt: new Date(visualCompleted).toISOString(),
    visualCreatedAt: new Date(visualCreated).toISOString(),
    visualRunAttempt: 1,
    visualRunId: 9002,
  }
  return { authority, machineRoot, outputRoot, visualRoot }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenDesign M1 final evidence composer', () => {
  test('validates both producer artifacts and seals the exact three-file downstream closure', async () => {
    const value = await fixture()
    const result = await createOpenDesignM1FinalEvidence(
      value.machineRoot, value.visualRoot, value.outputRoot, value.authority,
    )
    expect(result.artifactName).toBe(OPEN_DESIGN_M1_FINAL_ARTIFACT_NAME)
    expect(result.fileCount).toBe(3)
    expect((await readdir(value.outputRoot)).sort()).toEqual([
      'SHA256SUMS',
      'open-design-rc-acceptance-evidence.json',
      'open-design-rc-acceptance-intake.json',
    ])
    const intake = JSON.parse(await readFile(join(value.outputRoot, 'open-design-rc-acceptance-intake.json'), 'utf8'))
    const summary = JSON.parse(await readFile(join(value.outputRoot, 'open-design-rc-acceptance-evidence.json'), 'utf8'))
    expect(intake.repository).toBe(OPEN_DESIGN_ACCEPTANCE_REPOSITORY)
    expect(intake.records).toHaveLength(40)
    expect(intake.evidence.machineBatch).toMatchObject({
      repository: OPEN_DESIGN_ACCEPTANCE_REPOSITORY,
      workflowPath: '.github/workflows/open-design-m1-machine-evidence.yml',
      runId: 9001,
      runAttempt: 1,
      headSha: machineAuthority.hostHeadSha,
      artifactName: 'open-design-m1-machine-evidence',
      objectPath: 'machine-manifest.json',
    })
    expect(intake.evidence.visualDecisions).toMatchObject({
      workflowPath: '.github/workflows/open-design-m1-visual-attestation.yml',
      runId: 9002,
      artifactName: 'open-design-m1-visual-attestation',
      objectPath: 'visual-attestation.json',
    })
    expect(summary).toMatchObject({
      paidTurns: 40,
      oldStackTasksPassed: 20,
      newStackConsecutivePassed: 20,
      blackoutTasksPassed: 20,
      previewHumanPasses: 20,
      requiredCiPassed: true,
      rollbackExercisePassed: true,
    })
    expect((await stat(join(value.outputRoot, 'open-design-rc-acceptance-evidence.json'))).mode & 0o777).toBe(0o600)
  })

  test('rejects visual substitution even when the two-file visual artifact is resealed', async () => {
    const value = await fixture()
    await visualAttestationTestOnly.replaceCanonicalJson(value.visualRoot, (attestation) => {
      const decisions = attestation.decisions as Array<Record<string, unknown>>
      decisions[0]!.machineRecordSha256 = 'f'.repeat(64)
    })
    await expect(createOpenDesignM1FinalEvidence(
      value.machineRoot, value.visualRoot, value.outputRoot, value.authority,
    )).rejects.toThrow()
  })

  test('rejects unknown authority fields, run-attempt laundering, and invalid producer chronology', async () => {
    const value = await fixture()
    expect(() => parseFinalEvidenceAuthority({ ...value.authority, unknown: true })).toThrow()
    expect(() => parseFinalEvidenceAuthority({ ...value.authority, machineRunAttempt: 2 })).toThrow()
    expect(() => parseFinalEvidenceAuthority({
      ...value.authority,
      visualCreatedAt: value.authority.machineCompletedAt,
    })).toThrow()
  })

  test('CLI accepts only a canonical bounded authority and never echoes invalid input', async () => {
    const value = await fixture()
    const root = join(tmpdir(), `open-design-m1-final-cli-${randomUUID()}`)
    roots.push(root)
    await mkdir(root, { mode: 0o700 })
    const authorityPath = join(root, 'authority.json')
    const outputRoot = join(root, 'output')
    await writeFile(authorityPath, canonical(value.authority), { mode: 0o600 })
    const executable = join(import.meta.dir, 'open-design-m1-final-evidence.ts')
    const child = Bun.spawn([
      process.execPath, executable,
      '--authority', authorityPath,
      '--machine-root', value.machineRoot,
      '--visual-root', value.visualRoot,
      '--output-root', outputRoot,
    ], { stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).toBe(0)
    expect(JSON.parse(await new Response(child.stdout).text()).fileCount).toBe(3)
    expect(await new Response(child.stderr).text()).toBe('')

    const invalidAuthority = join(root, 'invalid.json')
    await writeFile(invalidAuthority, `${JSON.stringify({ ...value.authority, secret: 'NEVER-ECHO' }, null, 2)}\n`, { mode: 0o600 })
    const failed = Bun.spawn([
      process.execPath, executable,
      '--authority', invalidAuthority,
      '--machine-root', value.machineRoot,
      '--visual-root', value.visualRoot,
      '--output-root', join(root, 'failed-output'),
    ], { stdout: 'pipe', stderr: 'pipe' })
    expect(await failed.exited).toBe(1)
    expect(await new Response(failed.stdout).text()).toBe('')
    const stderr = await new Response(failed.stderr).text()
    expect(stderr).toBe('OpenDesign M1 final evidence validation failed.\n')
    expect(stderr).not.toContain('NEVER-ECHO')
  })
})
