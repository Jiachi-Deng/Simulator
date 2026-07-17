import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPEN_DESIGN_M1_CASES } from './open-design-m1-cases'
import {
  OPEN_DESIGN_M1_FIRST_FAILURE_ARTIFACT_NAME,
  OPEN_DESIGN_M1_FIRST_FAILURE_CASE_IDS,
  OPEN_DESIGN_M1_FIRST_FAILURE_MAX_BYTES,
  createOpenDesignM1BatchProgress,
  preserveOpenDesignM1FirstFailure,
  runTrackedOpenDesignM1Case,
  validateOpenDesignM1FirstFailure,
  writeOpenDesignM1FirstFailure,
  type OpenDesignM1FirstFailureAuthority,
} from './open-design-m1-machine-first-failure'
import { runFixedFailStopBatch } from './run-open-design-m1-machine-evidence'

const roots: string[] = []
const authority: OpenDesignM1FirstFailureAuthority = Object.freeze({
  hostHeadSha: '1234567890abcdef1234567890abcdef12345678',
  producerRunId: 9001,
  producerRunAttempt: 1,
  hostBuildRunId: 8001,
  hostArtifactSha256: 'a'.repeat(64),
})

const cleanupEvidence = Object.freeze({
  moduleStop: 'completed' as const,
  runtimeSnapshotObserved: true,
  runtimeClean: true,
  activeRuns: 0,
  moduleSessions: 0,
  hiddenSessions: 0,
  transientSessions: 0,
  quarantinedSessions: 0,
  appExit: 'completed' as const,
  descendantProcessesRemaining: 0,
  ownedModuleProcessesRemaining: 0,
})

async function artifactRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'open-design-m1-first-failure-'))
  roots.push(parent)
  return join(parent, 'artifact')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OpenDesign M1 first-failure capsule', () => {
  it('pins the credential-free verifier case IDs to the fixed M1 task set', () => {
    expect(OPEN_DESIGN_M1_CASES.map((testCase) => testCase.id)).toEqual(
      [...OPEN_DESIGN_M1_FIRST_FAILURE_CASE_IDS],
    )
  })

  it('seals and validates a true pre-first-paid lifecycle failure with zero completed cases', async () => {
    const root = await artifactRoot()
    const result = await writeOpenDesignM1FirstFailure(root, {
      authority,
      batchStartedAt: Date.parse('2026-07-17T01:00:00.000Z'),
      failedAt: Date.parse('2026-07-17T01:00:01.000Z'),
      progress: { completedCaseCount: 0, lifecyclePhase: 'lkg-batch.preflight' },
      cleanup: {
        ...cleanupEvidence,
        moduleStop: 'not-attempted',
        runtimeSnapshotObserved: false,
        runtimeClean: false,
        activeRuns: null,
        moduleSessions: null,
        hiddenSessions: null,
        transientSessions: null,
        quarantinedSessions: null,
      },
    })
    await expect(validateOpenDesignM1FirstFailure(root, authority)).resolves.toEqual(result)
    const manifest = JSON.parse(await readFile(join(root, 'first-failure.json'), 'utf8'))
    expect(manifest.batch).toMatchObject({
      caseAttemptsCompleted: 0,
      paidTurnUpperBound: 0,
    })
    expect(manifest.firstFailure).toEqual({
      code: 'LIFECYCLE_VERIFICATION_FAILED',
      phase: 'lkg-batch.preflight',
    })
  })

  it('rehearses a zero-paid first failure, stops later cases, and excludes arbitrary error content', async () => {
    const progress = createOpenDesignM1BatchProgress()
    const invoked: string[] = []
    let paidProviderCalls = 0
    const arbitraryErrorContent = 'SECRET_SHOULD_NOT_APPEAR prompt=private environment=private log=private'

    await expect(runFixedFailStopBatch(OPEN_DESIGN_M1_CASES.slice(0, 3), async (testCase, index) => {
      invoked.push(testCase.id)
      await runTrackedOpenDesignM1Case(progress, 'old', testCase, index, async (markPhase) => {
        if (index === 1) {
          markPhase('preview.verify')
          throw new Error(arbitraryErrorContent)
        }
        // The fixture never calls a provider. It only exercises ordering and sealing.
        paidProviderCalls += 0
      })
    })).rejects.toThrow(arbitraryErrorContent)

    expect(invoked).toEqual(['D01', 'D02'])
    expect(paidProviderCalls).toBe(0)
    expect(progress.current).toEqual({
      stack: 'old', caseId: 'D02', turnOrdinal: 2, caseAttemptOrdinal: 2, phase: 'preview.verify',
    })
    const root = await artifactRoot()
    const result = await writeOpenDesignM1FirstFailure(root, {
      authority,
      batchStartedAt: Date.parse('2026-07-17T01:00:00.000Z'),
      failedAt: Date.parse('2026-07-17T01:01:00.000Z'),
      progress: { completedCaseCount: progress.completedCaseCount, current: progress.current! },
      cleanup: cleanupEvidence,
    })
    expect(result.artifactName).toBe(OPEN_DESIGN_M1_FIRST_FAILURE_ARTIFACT_NAME)
    expect(result.fileCount).toBe(2)
    expect(result.totalBytes).toBeLessThanOrEqual(OPEN_DESIGN_M1_FIRST_FAILURE_MAX_BYTES)
    await expect(validateOpenDesignM1FirstFailure(root, authority)).resolves.toEqual(result)

    const rootMetadata = await lstat(root)
    const manifestMetadata = await lstat(join(root, 'first-failure.json'))
    const sumsMetadata = await lstat(join(root, 'SHA256SUMS'))
    expect(rootMetadata.mode & 0o777).toBe(0o700)
    expect(manifestMetadata.mode & 0o777).toBe(0o600)
    expect(sumsMetadata.mode & 0o777).toBe(0o600)
    const allEvidence = `${await readFile(join(root, 'first-failure.json'), 'utf8')}${await readFile(join(root, 'SHA256SUMS'), 'utf8')}`
    expect(allEvidence).not.toContain(arbitraryErrorContent)
    expect(allEvidence).not.toContain('prompt=')
    expect(allEvidence).not.toContain('environment=')
    expect(allEvidence).not.toContain('log=')
    expect(allEvidence).not.toMatch(/prompt|error|environment|secret/i)
  })

  it('locates the first RC failure after exactly 20 completed LKG fixtures', async () => {
    const progress = createOpenDesignM1BatchProgress()
    for (const [index, testCase] of OPEN_DESIGN_M1_CASES.entries()) {
      await runTrackedOpenDesignM1Case(progress, 'old', testCase, index, async () => {})
    }
    await expect(runTrackedOpenDesignM1Case(
      progress,
      'new',
      OPEN_DESIGN_M1_CASES[0]!,
      0,
      async (markPhase) => {
        markPhase('run.await-terminal')
        throw new Error('fixture failure')
      },
    )).rejects.toThrow('fixture failure')

    const root = await artifactRoot()
    await writeOpenDesignM1FirstFailure(root, {
      authority,
      batchStartedAt: Date.parse('2026-07-17T01:00:00.000Z'),
      failedAt: Date.parse('2026-07-17T01:20:00.000Z'),
      progress: { completedCaseCount: progress.completedCaseCount, current: progress.current! },
      cleanup: cleanupEvidence,
    })
    const manifest = JSON.parse(await readFile(join(root, 'first-failure.json'), 'utf8'))
    expect(manifest.batch.caseAttemptsCompleted).toBe(20)
    expect(manifest.batch.paidTurnUpperBound).toBe(21)
    expect(manifest.firstFailure).toEqual({
      code: 'CASE_EXECUTION_FAILED',
      stack: 'new',
      caseId: 'D01',
      turnOrdinal: 1,
      caseAttemptOrdinal: 21,
      phase: 'run.await-terminal',
    })
  })

  it('preserves a bounded lifecycle failure after all 40 cases without arbitrary failure content', async () => {
    const root = await artifactRoot()
    const arbitraryFailure = 'SECRET post-batch error prompt=private env=private'
    await writeOpenDesignM1FirstFailure(root, {
      authority,
      batchStartedAt: Date.parse('2026-07-17T01:00:00.000Z'),
      failedAt: Date.parse('2026-07-17T02:00:00.000Z'),
      progress: { completedCaseCount: 40, lifecyclePhase: 'catalog.freeze-verify' },
      cleanup: {
        moduleStop: 'failed',
        runtimeSnapshotObserved: true,
        runtimeClean: false,
        activeRuns: 1,
        moduleSessions: 1,
        hiddenSessions: 1,
        transientSessions: 1,
        quarantinedSessions: 0,
        appExit: 'completed',
        descendantProcessesRemaining: 0,
        ownedModuleProcessesRemaining: 0,
      },
    })
    const source = await readFile(join(root, 'first-failure.json'), 'utf8')
    const manifest = JSON.parse(source)
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.batch).toMatchObject({ caseAttemptsCompleted: 40, paidTurnUpperBound: 40 })
    expect(manifest.firstFailure).toEqual({
      code: 'LIFECYCLE_VERIFICATION_FAILED',
      phase: 'catalog.freeze-verify',
    })
    expect(manifest.cleanup).toMatchObject({
      runtimeClean: false,
      activeRuns: 1,
      hiddenSessions: 1,
    })
    expect(source).not.toContain(arbitraryFailure)
    expect(source).not.toMatch(/prompt|error|environment|secret/i)
    await expect(validateOpenDesignM1FirstFailure(root, authority)).resolves.toMatchObject({ fileCount: 2 })
  })

  it('revalidates the capsule through the credential-free workflow CLI', async () => {
    const progress = createOpenDesignM1BatchProgress()
    await expect(runTrackedOpenDesignM1Case(
      progress,
      'old',
      OPEN_DESIGN_M1_CASES[0]!,
      0,
      async (markPhase) => {
        markPhase('seed.verify')
        throw new Error('fixture failure')
      },
    )).rejects.toThrow('fixture failure')
    const root = await artifactRoot()
    await writeOpenDesignM1FirstFailure(root, {
      authority,
      batchStartedAt: Date.parse('2026-07-17T01:00:00.000Z'),
      failedAt: Date.parse('2026-07-17T01:00:01.000Z'),
      progress: { completedCaseCount: progress.completedCaseCount, current: progress.current! },
      cleanup: cleanupEvidence,
    })
    const child = Bun.spawn([
      process.execPath,
      join(process.cwd(), 'scripts/qa/verify-open-design-m1-machine-first-failure.ts'),
      root,
    ], {
      env: {
        GITHUB_SHA: authority.hostHeadSha,
        GITHUB_RUN_ID: String(authority.producerRunId),
        GITHUB_RUN_ATTEMPT: '1',
        HOST_BUILD_RUN_ID: String(authority.hostBuildRunId),
        HOST_ARTIFACT_SHA256: authority.hostArtifactSha256,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode, stderr).toBe(0)
    expect(stderr).toBe('')
    const result = JSON.parse(stdout)
    expect(result.status).toBe('failed')
    expect(result.artifactName).toBe(OPEN_DESIGN_M1_FIRST_FAILURE_ARTIFACT_NAME)
    expect(result.fileCount).toBe(2)
  })

  it('atomically preserves the capsule outside staging and removes every partial case file', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'open-design-m1-first-failure-staging-'))
    roots.push(parent)
    const staging = join(parent, 'staging')
    const artifact = join(staging, 'first-failure')
    const output = join(parent, 'output')
    await mkdir(staging, { mode: 0o700 })
    await writeFile(join(staging, 'partial-case-data'), 'must be removed\n', { mode: 0o600 })
    const progress = createOpenDesignM1BatchProgress()
    await expect(runTrackedOpenDesignM1Case(
      progress,
      'old',
      OPEN_DESIGN_M1_CASES[0]!,
      0,
      async (markPhase) => {
        markPhase('events.read')
        throw new Error('fixture failure')
      },
    )).rejects.toThrow('fixture failure')
    await preserveOpenDesignM1FirstFailure(staging, artifact, output, {
      authority,
      batchStartedAt: Date.parse('2026-07-17T01:00:00.000Z'),
      failedAt: Date.parse('2026-07-17T01:00:01.000Z'),
      progress: { completedCaseCount: progress.completedCaseCount, current: progress.current! },
      cleanup: cleanupEvidence,
    })
    await expect(lstat(staging)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(validateOpenDesignM1FirstFailure(output, authority)).resolves.toMatchObject({ fileCount: 2 })
  })

  it('rejects unknown fields, unsafe modes, links, and oversized members', async () => {
    const progress = createOpenDesignM1BatchProgress()
    await expect(runTrackedOpenDesignM1Case(
      progress,
      'old',
      OPEN_DESIGN_M1_CASES[0]!,
      0,
      async () => { throw new Error('fixture failure') },
    )).rejects.toThrow('fixture failure')
    const input = {
      authority,
      batchStartedAt: Date.parse('2026-07-17T01:00:00.000Z'),
      failedAt: Date.parse('2026-07-17T01:00:01.000Z'),
      progress: { completedCaseCount: progress.completedCaseCount, current: progress.current! },
      cleanup: cleanupEvidence,
    }

    const unknownRoot = await artifactRoot()
    await writeOpenDesignM1FirstFailure(unknownRoot, input)
    const unknownManifest = JSON.parse(await readFile(join(unknownRoot, 'first-failure.json'), 'utf8'))
    unknownManifest.message = 'must never be accepted'
    await writeFile(join(unknownRoot, 'first-failure.json'), `${JSON.stringify(unknownManifest)}\n`, { mode: 0o600 })
    await expect(validateOpenDesignM1FirstFailure(unknownRoot, authority)).rejects.toThrow('invalid keys')

    const cleanupFieldRoot = await artifactRoot()
    await writeOpenDesignM1FirstFailure(cleanupFieldRoot, input)
    const cleanupFieldManifest = JSON.parse(await readFile(join(cleanupFieldRoot, 'first-failure.json'), 'utf8'))
    cleanupFieldManifest.cleanup.error = 'SECRET prompt and environment content must not be admitted'
    await writeFile(
      join(cleanupFieldRoot, 'first-failure.json'),
      `${JSON.stringify(cleanupFieldManifest)}\n`,
      { mode: 0o600 },
    )
    await expect(validateOpenDesignM1FirstFailure(cleanupFieldRoot, authority)).rejects.toThrow('invalid keys')

    const modeRoot = await artifactRoot()
    await writeOpenDesignM1FirstFailure(modeRoot, input)
    await chmod(join(modeRoot, 'first-failure.json'), 0o644)
    await expect(validateOpenDesignM1FirstFailure(modeRoot, authority)).rejects.toThrow('file is unsafe')

    const symlinkRoot = await artifactRoot()
    await writeOpenDesignM1FirstFailure(symlinkRoot, input)
    await rm(join(symlinkRoot, 'SHA256SUMS'))
    await symlink('first-failure.json', join(symlinkRoot, 'SHA256SUMS'))
    await expect(validateOpenDesignM1FirstFailure(symlinkRoot, authority)).rejects.toThrow('inventory')

    const hardlinkRoot = await artifactRoot()
    await writeOpenDesignM1FirstFailure(hardlinkRoot, input)
    await rm(join(hardlinkRoot, 'SHA256SUMS'))
    await link(join(hardlinkRoot, 'first-failure.json'), join(hardlinkRoot, 'SHA256SUMS'))
    await expect(validateOpenDesignM1FirstFailure(hardlinkRoot, authority)).rejects.toThrow('file is unsafe')

    const largeRoot = await artifactRoot()
    await writeOpenDesignM1FirstFailure(largeRoot, input)
    await writeFile(join(largeRoot, 'first-failure.json'), Buffer.alloc(16 * 1024 + 1, 0x20), { mode: 0o600 })
    await expect(validateOpenDesignM1FirstFailure(largeRoot, authority)).rejects.toThrow('file is unsafe')
  })
})
