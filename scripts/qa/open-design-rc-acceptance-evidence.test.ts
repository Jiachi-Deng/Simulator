import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OPEN_DESIGN_ACCEPTANCE_REPOSITORY,
  OPEN_DESIGN_HOST_ARTIFACT_NAME,
  OPEN_DESIGN_HOST_VERSION,
  OPEN_DESIGN_LKG_ARCHIVE_ASSET,
  OPEN_DESIGN_LKG_TAG,
  OPEN_DESIGN_LKG_VERSION,
  OPEN_DESIGN_M1_CASE_HASHES,
  OPEN_DESIGN_M1_CASE_MANIFEST_SHA256,
  OPEN_DESIGN_M1_CASE_SEED_CHECKSUMS_SHA256,
  OPEN_DESIGN_ACCEPTANCE_MAX_INPUT_BYTES,
  OPEN_DESIGN_RC_ARCHIVE_ASSET,
  OPEN_DESIGN_RC_SOURCE_SHA,
  OPEN_DESIGN_RC_TAG,
  OPEN_DESIGN_RC_VERSION,
  OPEN_DESIGN_REQUIRED_CI_WORKFLOW_PATHS,
  validateAndSummarizeOpenDesignRcAcceptanceIntake,
} from './open-design-rc-acceptance-evidence'
import { OPEN_DESIGN_M1_CASES, renderOpenDesignM1CaseManifest } from './open-design-m1-cases'

const HOST_HEAD_SHA = '1234567890abcdef1234567890abcdef12345678'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const BASE_TIME = Date.parse('2026-07-17T00:00:00.000Z')
const roots: string[] = []

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function evidence(objectPath: string) {
  return {
    artifactName: 'open-design-acceptance-intake',
    objectPath,
    sha256: HASH_A,
  }
}

function buildRecord(stack: 'old' | 'new', caseIndex: number, ordinal: number) {
  const testCase = OPEN_DESIGN_M1_CASE_HASHES[caseIndex]!
  const prefix = `records/${stack}/${testCase.id}`
  return {
    attemptOrdinal: 1,
    blackout: stack === 'old'
      ? { required: false }
      : {
          businessEventSilenceSeconds: 65,
          duplicateTerminalCount: 0,
          eventsLost: 0,
          heartbeatContinued: true,
          replayComplete: true,
          required: true,
        },
    caseId: testCase.id,
    cleanup: {
      activeRuns: 0,
      hiddenSessions: 0,
      moduleSessions: 0,
      processTreeReapedWithinSeconds: 10,
      residualProcesses: 0,
      runStateSettledWithinSeconds: 5,
    },
    completedAt: new Date(BASE_TIME + ordinal * 120_000 + 90_000).toISOString(),
    craft: {
      mainPidSurvived: true,
      stateSplitCount: 0,
      usableAfterTurn: true,
    },
    moduleArchiveSha256: stack === 'old' ? HASH_B : HASH_C,
    preview: {
      httpStatus: 200,
      requiredContentVerified: true,
      requiredFilesVerified: true,
      route: '/',
    },
    promptSha256: testCase.promptSha256,
    seedArchiveSha256: testCase.seedArchiveSha256,
    stack,
    startedAt: new Date(BASE_TIME + ordinal * 120_000).toISOString(),
    terminal: {
      status: 'completed',
      terminalEventCount: 1,
    },
    turnCount: 1,
    visual: stack === 'old'
      ? { required: false }
      : {
          decision: 'PASS',
          required: true,
          reviewerRole: 'product-owner',
        },
  }
}

function validIntake(): any {
  return {
    batch: {
      batchId: 'm1-acceptance-2026-07-17',
      completedAt: new Date(BASE_TIME + 40 * 120_000).toISOString(),
      paidTurnBudget: 40,
      paidTurns: 40,
      startedAt: new Date(BASE_TIME).toISOString(),
      status: 'passed',
      stopOnFailure: true,
    },
    caseManifestSha256: OPEN_DESIGN_M1_CASE_MANIFEST_SHA256,
    caseSeedChecksumsSha256: OPEN_DESIGN_M1_CASE_SEED_CHECKSUMS_SHA256,
    evidence: {
      machineBatch: evidence('authority/machine-batch.json'),
      visualDecisions: { ...evidence('authority/visual-decisions.json'), sha256: HASH_B },
    },
    host: {
      artifactName: OPEN_DESIGN_HOST_ARTIFACT_NAME,
      artifactSha256: HASH_B,
      buildRunId: 9001,
      version: OPEN_DESIGN_HOST_VERSION,
    },
    hostHeadSha: HOST_HEAD_SHA,
    lkg: {
      archiveAsset: OPEN_DESIGN_LKG_ARCHIVE_ASSET,
      archiveSha256: HASH_B,
      catalogIssuedAt: '2026-07-16T20:00:00.000Z',
      catalogSequence: 2,
      expiresAt: '2026-07-18T20:00:00.000Z',
      extractedManifestSha256: HASH_B,
      tag: OPEN_DESIGN_LKG_TAG,
      version: OPEN_DESIGN_LKG_VERSION,
    },
    rc: {
      archiveAsset: OPEN_DESIGN_RC_ARCHIVE_ASSET,
      archiveSha256: HASH_C,
      catalogIssuedAt: '2026-07-16T21:35:33.862Z',
      catalogSequence: 3,
      expiresAt: '2026-07-18T21:35:33.862Z',
      extractedManifestSha256: HASH_A,
      tag: OPEN_DESIGN_RC_TAG,
      version: OPEN_DESIGN_RC_VERSION,
    },
    rcSourceSha: OPEN_DESIGN_RC_SOURCE_SHA,
    records: [
      ...OPEN_DESIGN_M1_CASE_HASHES.map((_, index) => buildRecord('old', index, index)),
      ...OPEN_DESIGN_M1_CASE_HASHES.map((_, index) => buildRecord('new', index, index + 20)),
    ],
    repository: OPEN_DESIGN_ACCEPTANCE_REPOSITORY,
    requiredCi: {
      evidence: evidence('required-ci/checks.json'),
      passed: true,
      runs: OPEN_DESIGN_REQUIRED_CI_WORKFLOW_PATHS.map((workflowPath, index) => ({
        runId: 10_001 + index,
        workflowPath,
      })),
    },
    rollbackExercise: {
      craftConnectionPreserved: true,
      craftSurvivedAllTransitions: true,
      evidence: {
        hiddenSessionSnapshot: evidence('rollback/hidden-sessions.json'),
        processSnapshot: evidence('rollback/processes.json'),
        transitionLog: evidence('rollback/transitions.json'),
      },
      hiddenSessionResidueCount: 0,
      passed: true,
      processResidueCount: 0,
      restartAndReopenPassed: true,
      transitions: ['0.14.5', OPEN_DESIGN_RC_VERSION, '0.14.5', OPEN_DESIGN_RC_VERSION],
    },
    schemaVersion: 1,
  }
}

function expectRejected(mutate: (intake: any) => void): void {
  const intake = structuredClone(validIntake())
  mutate(intake)
  expect(() => validateAndSummarizeOpenDesignRcAcceptanceIntake(intake, HOST_HEAD_SHA)).toThrow(
    'Invalid OpenDesign acceptance intake',
  )
}

describe('OpenDesign RC acceptance evidence validator', () => {
  test('derives only the exact dual-authority schema v2 summary', () => {
    const intake = validIntake()
    const canonicalFixtureBytes = Buffer.byteLength(`${JSON.stringify(intake)}\n`)
    expect(canonicalFixtureBytes).toBe(40_899)
    expect(canonicalFixtureBytes).toBeLessThanOrEqual(OPEN_DESIGN_ACCEPTANCE_MAX_INPUT_BYTES)
    expect(Math.ceil(canonicalFixtureBytes / 3) * 4).toBe(54_532)
    expect(Math.ceil(canonicalFixtureBytes / 3) * 4).toBeLessThanOrEqual(60_000)
    const summary = validateAndSummarizeOpenDesignRcAcceptanceIntake(intake, HOST_HEAD_SHA)
    expect(summary).toEqual({
      blackoutTasksPassed: 20,
      evidenceBundleSha256: sha256(`${JSON.stringify(intake)}\n`),
      hostArtifactName: OPEN_DESIGN_HOST_ARTIFACT_NAME,
      hostArtifactSha256: HASH_B,
      hostBuildRunId: 9001,
      hostHeadSha: HOST_HEAD_SHA,
      hostVersion: OPEN_DESIGN_HOST_VERSION,
      machineEvidence: intake.evidence.machineBatch,
      newStackConsecutivePassed: 20,
      oldStackTasksPassed: 20,
      paidTurns: 40,
      previewHumanPasses: 20,
      rcArchiveAsset: OPEN_DESIGN_RC_ARCHIVE_ASSET,
      rcArchiveSha256: HASH_C,
      rcCatalogIssuedAt: '2026-07-16T21:35:33.862Z',
      rcCatalogSequence: 3,
      rcExtractedManifestSha256: HASH_A,
      rcSourceSha: OPEN_DESIGN_RC_SOURCE_SHA,
      rcTag: OPEN_DESIGN_RC_TAG,
      rcVersion: OPEN_DESIGN_RC_VERSION,
      repository: OPEN_DESIGN_ACCEPTANCE_REPOSITORY,
      requiredCiPassed: true,
      rollbackExercisePassed: true,
      schemaVersion: 2,
      visualEvidence: intake.evidence.visualDecisions,
    })
    expect(Object.keys(summary).sort()).toEqual([
      'blackoutTasksPassed', 'evidenceBundleSha256', 'hostArtifactName', 'hostArtifactSha256',
      'hostBuildRunId', 'hostHeadSha', 'hostVersion', 'machineEvidence', 'newStackConsecutivePassed',
      'oldStackTasksPassed', 'paidTurns', 'previewHumanPasses',
      'rcArchiveAsset', 'rcArchiveSha256', 'rcCatalogIssuedAt', 'rcCatalogSequence',
      'rcExtractedManifestSha256', 'rcSourceSha', 'rcTag', 'rcVersion', 'repository',
      'requiredCiPassed', 'rollbackExercisePassed', 'schemaVersion', 'visualEvidence',
    ].sort())
  })

  test('pins all immutable authorities instead of accepting intake-selected identities', () => {
    expect(OPEN_DESIGN_RC_SOURCE_SHA).toBe('6b39a9bcc0f158645897976e23f334c5cab771f4')
    expect(OPEN_DESIGN_M1_CASE_MANIFEST_SHA256).toBe('a45cbb0c4508863681531bcc2456df67fe9c91089bd219f766d3f86a526281d7')
    expect(OPEN_DESIGN_M1_CASE_SEED_CHECKSUMS_SHA256).toBe('9f992797e2702b04161671601caaba1a5740168163a4b7b1c86b836b48d801e4')
    expectRejected((intake) => { intake.rcSourceSha = 'f'.repeat(40) })
    expectRejected((intake) => { intake.caseManifestSha256 = HASH_B })
    expectRejected((intake) => { intake.caseSeedChecksumsSha256 = HASH_B })
    expectRejected((intake) => { intake.hostHeadSha = 'f'.repeat(40) })
    expect(() => validateAndSummarizeOpenDesignRcAcceptanceIntake(validIntake(), 'f'.repeat(40))).toThrow()
  })

  test('derives every case authority from the fixed source manifest', () => {
    const seedChecksums = Object.fromEntries(
      OPEN_DESIGN_M1_CASES.map((testCase) => [testCase.id, testCase.seedArchiveSha256]),
    )
    expect(sha256(renderOpenDesignM1CaseManifest())).toBe(OPEN_DESIGN_M1_CASE_MANIFEST_SHA256)
    expect(sha256(`${JSON.stringify(seedChecksums, null, 2)}\n`)).toBe(
      OPEN_DESIGN_M1_CASE_SEED_CHECKSUMS_SHA256,
    )
    expect(JSON.stringify(OPEN_DESIGN_M1_CASE_HASHES)).toBe(JSON.stringify(
      OPEN_DESIGN_M1_CASES.map((testCase) => ({
        id: testCase.id,
        promptSha256: sha256(testCase.prompt),
        seedArchiveSha256: testCase.seedArchiveSha256,
      })),
    ))
  })

  test('rejects unknown keys at every authority boundary', () => {
    expectRejected((intake) => { intake.unexpected = true })
    expectRejected((intake) => { intake.host.unexpected = true })
    expectRejected((intake) => { intake.rc.unexpected = true })
    expectRejected((intake) => { intake.batch.unexpected = true })
    expectRejected((intake) => { intake.records[0].unexpected = true })
    expectRejected((intake) => { intake.records[0].terminal.unexpected = true })
    expectRejected((intake) => { intake.requiredCi.unexpected = true })
    expectRejected((intake) => { intake.rollbackExercise.evidence.unexpected = true })
  })

  test('requires exactly one ordered old/new attempt for every fixed case', () => {
    expectRejected((intake) => { intake.records.pop() })
    expectRejected((intake) => { [intake.records[0], intake.records[1]] = [intake.records[1], intake.records[0]] })
    expectRejected((intake) => { intake.records[20].stack = 'old' })
    expectRejected((intake) => { intake.records[20].attemptOrdinal = 2 })
    expectRejected((intake) => { intake.records[20].turnCount = 2 })
    expectRejected((intake) => { intake.records[20].seedArchiveSha256 = HASH_B })
    expectRejected((intake) => { intake.records[20].promptSha256 = HASH_B })
    expectRejected((intake) => { intake.records[0].moduleArchiveSha256 = HASH_C })
    expectRejected((intake) => { intake.records[20].moduleArchiveSha256 = HASH_B })
    expectRejected((intake) => { intake.records[1].startedAt = intake.records[0].startedAt })
  })

  test('requires terminal, file, Preview, Craft, cleanup, blackout, and human visual proof', () => {
    expectRejected((intake) => { intake.records[0].terminal.status = 'failed' })
    expectRejected((intake) => { intake.records[0].terminal.terminalEventCount = 2 })
    expectRejected((intake) => { intake.records[0].preview.httpStatus = 404 })
    expectRejected((intake) => { intake.records[0].preview.requiredFilesVerified = false })
    expectRejected((intake) => { intake.records[0].craft.mainPidSurvived = false })
    expectRejected((intake) => { intake.records[0].craft.stateSplitCount = 1 })
    expectRejected((intake) => { intake.records[0].cleanup.hiddenSessions = 1 })
    expectRejected((intake) => { intake.records[0].cleanup.processTreeReapedWithinSeconds = 11 })
    expectRejected((intake) => { intake.records[0].visual = { required: true } })
    expectRejected((intake) => { intake.records[20].visual.decision = 'FAIL' })
    expectRejected((intake) => { intake.records[20].blackout.businessEventSilenceSeconds = 64.999 })
    expectRejected((intake) => { intake.records[20].blackout.eventsLost = 1 })
    expectRejected((intake) => { intake.records[20].blackout.duplicateTerminalCount = 1 })
    expectRejected((intake) => {
      const startedAt = Date.parse(intake.records[20].startedAt)
      intake.records[20].completedAt = new Date(startedAt + 1).toISOString()
    })
    expectRejected((intake) => {
      const startedAt = Date.parse(intake.records[20].startedAt)
      intake.records[20].completedAt = new Date(startedAt + 64_999).toISOString()
    })
    const exactBoundary = validIntake()
    const startedAt = Date.parse(exactBoundary.records[20].startedAt)
    exactBoundary.records[20].completedAt = new Date(startedAt + 65_000).toISOString()
    expect(() => validateAndSummarizeOpenDesignRcAcceptanceIntake(exactBoundary, HOST_HEAD_SHA)).not.toThrow()
  })

  test('allows only safe relative evidence object references', () => {
    expectRejected((intake) => { intake.evidence.machineBatch.objectPath = '/private/evidence.json' })
    expectRejected((intake) => { intake.evidence.machineBatch.objectPath = '../evidence.json' })
    expectRejected((intake) => { intake.evidence.machineBatch.objectPath = 'records/../evidence.json' })
    expectRejected((intake) => { intake.evidence.machineBatch.objectPath = 'records\\evidence.json' })
    expectRejected((intake) => { intake.evidence.machineBatch.artifactName = '../artifact' })
    expectRejected((intake) => { intake.evidence.machineBatch.sha256 = 'secret' })
    expectRejected((intake) => { intake.evidence.visualDecisions = intake.evidence.machineBatch })
  })

  test('locks the paid batch and prevents retry or chronology laundering', () => {
    expectRejected((intake) => { intake.batch.paidTurnBudget = 41 })
    expectRejected((intake) => { intake.batch.paidTurns = 39 })
    expectRejected((intake) => { intake.batch.stopOnFailure = false })
    expectRejected((intake) => { intake.batch.status = 'partial' })
    expectRejected((intake) => { intake.batch.completedAt = intake.batch.startedAt })
    expectRejected((intake) => { intake.rc.catalogIssuedAt = '2026-07-17T00:00:00.001Z' })
    expectRejected((intake) => { intake.rc.expiresAt = '2026-07-17T01:00:00.000Z' })
    expectRejected((intake) => { intake.lkg.catalogIssuedAt = '2026-07-17T00:00:00.001Z' })
    expectRejected((intake) => { intake.lkg.expiresAt = '2026-07-17T00:30:00.000Z' })
    expectRejected((intake) => { intake.records[39].completedAt = '2026-07-18T00:00:00.000Z' })
    expectRejected((intake) => { intake.records[0].startedAt = '2026-02-30T00:00:00.000Z' })
    expectRejected((intake) => { intake.rc.catalogSequence = intake.lkg.catalogSequence })
    expectRejected((intake) => { intake.rc.catalogIssuedAt = intake.lkg.catalogIssuedAt })
  })

  test('requires every exact Required CI path once and the complete local rollback sequence', () => {
    expectRejected((intake) => { intake.requiredCi.passed = false })
    expectRejected((intake) => { intake.requiredCi.runs.pop() })
    expectRejected((intake) => { intake.requiredCi.runs[0].workflowPath = '.github/workflows/fake.yml' })
    expectRejected((intake) => { intake.requiredCi.runs[1].runId = intake.requiredCi.runs[0].runId })
    expectRejected((intake) => { intake.rollbackExercise.transitions[2] = OPEN_DESIGN_RC_VERSION })
    expectRejected((intake) => { intake.rollbackExercise.craftConnectionPreserved = false })
    expectRejected((intake) => { intake.rollbackExercise.craftSurvivedAllTransitions = false })
    expectRejected((intake) => { intake.rollbackExercise.restartAndReopenPassed = false })
    expectRejected((intake) => { intake.rollbackExercise.processResidueCount = 1 })
    expectRejected((intake) => { intake.rollbackExercise.hiddenSessionResidueCount = 1 })
  })
})

describe('OpenDesign RC acceptance evidence CLI', () => {
  test('accepts canonical input once and writes compact mode-0600 summary', async () => {
    const root = join(tmpdir(), `open-design-acceptance-${randomUUID()}`)
    roots.push(root)
    await mkdir(root, { mode: 0o700 })
    const input = join(root, 'intake.json')
    const output = join(root, 'summary.json')
    await writeFile(input, `${JSON.stringify(validIntake())}\n`, { mode: 0o600 })
    const executable = join(import.meta.dir, 'open-design-rc-acceptance-evidence.ts')
    const child = Bun.spawn([
      process.execPath, executable,
      '--input', input,
      '--host-head-sha', HOST_HEAD_SHA,
      '--output', output,
    ], { stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe('')
    expect(await new Response(child.stderr).text()).toBe('')
    const outputSource = await readFile(output, 'utf8')
    expect(outputSource).toBe(`${JSON.stringify(JSON.parse(outputSource))}\n`)
    expect(JSON.parse(outputSource).schemaVersion).toBe(2)
    expect((await stat(output)).mode & 0o777).toBe(0o600)

    const second = Bun.spawn([
      process.execPath, executable,
      '--input', input,
      '--host-head-sha', HOST_HEAD_SHA,
      '--output', output,
    ], { stdout: 'pipe', stderr: 'pipe' })
    expect(await second.exited).toBe(1)
    expect(await new Response(second.stderr).text()).toBe('OpenDesign acceptance evidence validation failed.\n')
  })

  test('rejects non-canonical or secret-bearing input without echoing values', async () => {
    const root = join(tmpdir(), `open-design-acceptance-${randomUUID()}`)
    roots.push(root)
    await mkdir(root, { mode: 0o700 })
    const input = join(root, 'intake.json')
    const output = join(root, 'summary.json')
    const intake = validIntake()
    intake.secret = 'NEVER-ECHO-THIS'
    await writeFile(input, `${JSON.stringify(intake, null, 2)}\n`, { mode: 0o600 })
    const executable = join(import.meta.dir, 'open-design-rc-acceptance-evidence.ts')
    const child = Bun.spawn([
      process.execPath, executable,
      '--input', input,
      '--host-head-sha', HOST_HEAD_SHA,
      '--output', output,
    ], { stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stdout).text()).toBe('')
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toBe('OpenDesign acceptance evidence validation failed.\n')
    expect(stderr).not.toContain('NEVER-ECHO-THIS')
    await expect(stat(output)).rejects.toThrow()
  })

  test('rejects canonical input above the shared 45,000-byte boundary', async () => {
    const root = join(tmpdir(), `open-design-acceptance-${randomUUID()}`)
    roots.push(root)
    await mkdir(root, { mode: 0o700 })
    const input = join(root, 'oversized.json')
    const output = join(root, 'summary.json')
    const source = `${JSON.stringify('x'.repeat(OPEN_DESIGN_ACCEPTANCE_MAX_INPUT_BYTES))}\n`
    expect(Buffer.byteLength(source)).toBeGreaterThan(OPEN_DESIGN_ACCEPTANCE_MAX_INPUT_BYTES)
    await writeFile(input, source, { mode: 0o600 })
    const executable = join(import.meta.dir, 'open-design-rc-acceptance-evidence.ts')
    const child = Bun.spawn([
      process.execPath, executable,
      '--input', input,
      '--host-head-sha', HOST_HEAD_SHA,
      '--output', output,
    ], { stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stdout).text()).toBe('')
    expect(await new Response(child.stderr).text()).toBe('OpenDesign acceptance evidence validation failed.\n')
    await expect(stat(output)).rejects.toThrow()
  })
})
