import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

export const OPEN_DESIGN_M1_FIRST_FAILURE_ARTIFACT_NAME =
  'open-design-m1-machine-first-failure' as const
export const OPEN_DESIGN_M1_FIRST_FAILURE_FILE_COUNT = 2 as const
export const OPEN_DESIGN_M1_FIRST_FAILURE_MAX_BYTES = 32 * 1024
export const OPEN_DESIGN_M1_FIRST_FAILURE_CASE_IDS = Object.freeze([
  'D01', 'D02', 'D03', 'D04',
  'L01', 'L02', 'L03', 'L04',
  'E01', 'E02', 'E03', 'E04',
  'S01', 'S02', 'S03', 'S04',
  'F01', 'F02', 'F03', 'F04',
] as const)

const REPOSITORY = 'Jiachi-Deng/Simulator'
const WORKFLOW_PATH = '.github/workflows/open-design-m1-machine-evidence.yml'
const MANIFEST_PATH = 'first-failure.json'
const SUMS_PATH = 'SHA256SUMS'
const MANIFEST_MAX_BYTES = 16 * 1024
const SUMS_MAX_BYTES = 256
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const ISO_TIMESTAMP = /^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/

export const OPEN_DESIGN_M1_CASE_FAILURE_PHASES = Object.freeze([
  'case.start',
  'project.create',
  'project.locate',
  'seed.verify',
  'seed.extract',
  'blackout.arm',
  'run.start',
  'run.await-terminal',
  'runtime.cleanup',
  'events.read',
  'blackout.collect',
  'events.seal',
  'preview.verify',
  'workspace.verify',
  'preview.capture',
  'craft.verify',
  'shim.reap',
  'record.seal',
] as const)

export const OPEN_DESIGN_M1_LIFECYCLE_FAILURE_PHASES = Object.freeze([
  'transition.to-rc',
  'rc-batch.preflight',
  'rollback.exercise',
  'view.lifecycle',
  'restart.prepare',
  'restart.verify',
  'catalog.freeze-verify',
  'artifact.seal',
  'artifact.validate',
  'artifact.publish',
] as const)

export type OpenDesignM1CaseFailurePhase = typeof OPEN_DESIGN_M1_CASE_FAILURE_PHASES[number]
export type OpenDesignM1LifecycleFailurePhase = typeof OPEN_DESIGN_M1_LIFECYCLE_FAILURE_PHASES[number]
export type OpenDesignM1FailureStack = 'old' | 'new'

export interface OpenDesignM1FirstFailureAuthority {
  readonly hostHeadSha: string
  readonly producerRunId: number
  readonly producerRunAttempt: 1
  readonly hostBuildRunId: number
  readonly hostArtifactSha256: string
}

export interface OpenDesignM1FirstFailureCase {
  readonly stack: OpenDesignM1FailureStack
  readonly caseId: string
  readonly turnOrdinal: number
  readonly caseAttemptOrdinal: number
  readonly phase: OpenDesignM1CaseFailurePhase
}

export interface OpenDesignM1BatchProgress {
  completedCaseCount: number
  current?: OpenDesignM1FirstFailureCase
}

export interface OpenDesignM1FailureCleanupEvidence {
  readonly moduleStop: 'not-attempted' | 'completed' | 'failed'
  readonly runtimeSnapshotObserved: boolean
  readonly runtimeClean: boolean
  readonly activeRuns: number | null
  readonly moduleSessions: number | null
  readonly hiddenSessions: number | null
  readonly transientSessions: number | null
  readonly quarantinedSessions: number | null
  readonly appExit: 'completed' | 'failed'
  readonly descendantProcessesRemaining: number | null
  readonly ownedModuleProcessesRemaining: number | null
}

export type OpenDesignM1FirstFailureProgress =
  | (OpenDesignM1BatchProgress & {
      readonly current: OpenDesignM1FirstFailureCase
      readonly lifecyclePhase?: never
    })
  | {
      readonly completedCaseCount: number
      readonly current?: never
      readonly lifecyclePhase: OpenDesignM1LifecycleFailurePhase
    }

export interface OpenDesignM1FirstFailureInput {
  readonly authority: OpenDesignM1FirstFailureAuthority
  readonly batchStartedAt: number
  readonly failedAt: number
  readonly progress: OpenDesignM1FirstFailureProgress
  readonly cleanup: OpenDesignM1FailureCleanupEvidence
}

export interface OpenDesignM1FirstFailureValidationResult {
  readonly artifactName: typeof OPEN_DESIGN_M1_FIRST_FAILURE_ARTIFACT_NAME
  readonly fileCount: typeof OPEN_DESIGN_M1_FIRST_FAILURE_FILE_COUNT
  readonly objectPath: typeof MANIFEST_PATH
  readonly sha256: string
  readonly totalBytes: number
}

type JsonObject = Record<string, unknown>

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function exactKeys(value: JsonObject, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`OpenDesign M1 first-failure evidence has invalid keys: ${path}`)
  }
}

function objectAt(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`OpenDesign M1 first-failure evidence is invalid: ${path}`)
  }
  return value as JsonObject
}

function stringAt(value: JsonObject, key: string, path: string): string {
  if (typeof value[key] !== 'string') {
    throw new TypeError(`OpenDesign M1 first-failure evidence is invalid: ${path}.${key}`)
  }
  return value[key] as string
}

function integerAt(value: JsonObject, key: string, path: string): number {
  if (!Number.isSafeInteger(value[key])) {
    throw new TypeError(`OpenDesign M1 first-failure evidence is invalid: ${path}.${key}`)
  }
  return value[key] as number
}

function timestampAt(value: JsonObject, key: string, path: string): number {
  const source = stringAt(value, key, path)
  const milliseconds = Date.parse(source)
  if (!ISO_TIMESTAMP.test(source) || !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== source) {
    throw new TypeError(`OpenDesign M1 first-failure evidence is invalid: ${path}.${key}`)
  }
  return milliseconds
}

function assertAuthority(authority: OpenDesignM1FirstFailureAuthority): void {
  if (!COMMIT_SHA.test(authority.hostHeadSha)
    || !Number.isSafeInteger(authority.producerRunId) || authority.producerRunId < 1
    || authority.producerRunAttempt !== 1
    || !Number.isSafeInteger(authority.hostBuildRunId) || authority.hostBuildRunId < 1
    || !SHA256.test(authority.hostArtifactSha256)) {
    throw new TypeError('OpenDesign M1 first-failure authority is invalid')
  }
}

function expectedOrdinal(stack: OpenDesignM1FailureStack, caseId: string): { turnOrdinal: number; caseAttemptOrdinal: number } {
  const caseIndex = OPEN_DESIGN_M1_FIRST_FAILURE_CASE_IDS.findIndex((candidate) => candidate === caseId)
  if (caseIndex < 0) throw new TypeError('OpenDesign M1 first-failure case is invalid')
  const turnOrdinal = caseIndex + 1
  return {
    turnOrdinal,
    caseAttemptOrdinal: stack === 'old' ? turnOrdinal : OPEN_DESIGN_M1_FIRST_FAILURE_CASE_IDS.length + turnOrdinal,
  }
}

function nullableCount(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
}

function assertCleanupEvidence(cleanup: OpenDesignM1FailureCleanupEvidence): void {
  if (!['not-attempted', 'completed', 'failed'].includes(cleanup.moduleStop)
    || typeof cleanup.runtimeSnapshotObserved !== 'boolean'
    || typeof cleanup.runtimeClean !== 'boolean'
    || !['completed', 'failed'].includes(cleanup.appExit)
    || !nullableCount(cleanup.activeRuns)
    || !nullableCount(cleanup.moduleSessions)
    || !nullableCount(cleanup.hiddenSessions)
    || !nullableCount(cleanup.transientSessions)
    || !nullableCount(cleanup.quarantinedSessions)
    || !nullableCount(cleanup.descendantProcessesRemaining)
    || !nullableCount(cleanup.ownedModuleProcessesRemaining)) {
    throw new TypeError('OpenDesign M1 first-failure cleanup evidence is invalid')
  }
  const runtimeCounts = [
    cleanup.activeRuns,
    cleanup.moduleSessions,
    cleanup.hiddenSessions,
    cleanup.transientSessions,
    cleanup.quarantinedSessions,
  ]
  const allRuntimeCountsAreZero = runtimeCounts.every((count) => count === 0)
  if (cleanup.runtimeSnapshotObserved !== runtimeCounts.every((count) => count !== null)
    || (cleanup.runtimeSnapshotObserved && cleanup.runtimeClean !== allRuntimeCountsAreZero)
    || (!cleanup.runtimeSnapshotObserved && cleanup.runtimeClean)) {
    throw new TypeError('OpenDesign M1 first-failure runtime cleanup evidence is invalid')
  }
}

function assertFailureInput(input: OpenDesignM1FirstFailureInput): void {
  assertAuthority(input.authority)
  assertCleanupEvidence(input.cleanup)
  if (!Number.isSafeInteger(input.batchStartedAt) || !Number.isSafeInteger(input.failedAt)
    || input.batchStartedAt < 0 || input.failedAt < input.batchStartedAt) {
    throw new TypeError('OpenDesign M1 first-failure timestamps are invalid')
  }
  const failure = input.progress.current
  if (failure) {
    if (!['old', 'new'].includes(failure.stack)
      || !OPEN_DESIGN_M1_CASE_FAILURE_PHASES.includes(failure.phase)
      || !Number.isSafeInteger(input.progress.completedCaseCount)) {
      throw new TypeError('OpenDesign M1 first-failure progress is invalid')
    }
    const expected = expectedOrdinal(failure.stack, failure.caseId)
    if (failure.turnOrdinal !== expected.turnOrdinal
      || failure.caseAttemptOrdinal !== expected.caseAttemptOrdinal
      || input.progress.completedCaseCount !== failure.caseAttemptOrdinal - 1) {
      throw new TypeError('OpenDesign M1 first-failure ordering is invalid')
    }
  } else if (!OPEN_DESIGN_M1_LIFECYCLE_FAILURE_PHASES.includes(input.progress.lifecyclePhase)
    || !Number.isSafeInteger(input.progress.completedCaseCount)
    || input.progress.completedCaseCount < 1
    || input.progress.completedCaseCount > 40) {
    throw new TypeError('OpenDesign M1 lifecycle failure progress is invalid')
  }
}

export function createOpenDesignM1BatchProgress(): OpenDesignM1BatchProgress {
  return { completedCaseCount: 0 }
}

export async function runTrackedOpenDesignM1Case<T extends { readonly id: string }>(
  progress: OpenDesignM1BatchProgress,
  stack: OpenDesignM1FailureStack,
  testCase: T,
  index: number,
  execute: (markPhase: (phase: OpenDesignM1CaseFailurePhase) => void) => Promise<void>,
): Promise<void> {
  const turnOrdinal = index + 1
  const caseAttemptOrdinal = stack === 'old'
    ? turnOrdinal
    : OPEN_DESIGN_M1_FIRST_FAILURE_CASE_IDS.length + turnOrdinal
  if (progress.completedCaseCount !== caseAttemptOrdinal - 1
    || OPEN_DESIGN_M1_FIRST_FAILURE_CASE_IDS[index] !== testCase.id) {
    throw new Error('OpenDesign M1 tracked case order is invalid')
  }
  progress.current = {
    stack,
    caseId: testCase.id,
    turnOrdinal,
    caseAttemptOrdinal,
    phase: 'case.start',
  }
  await execute((phase) => {
    if (!progress.current || !OPEN_DESIGN_M1_CASE_FAILURE_PHASES.includes(phase)) {
      throw new Error('OpenDesign M1 tracked case phase is invalid')
    }
    progress.current = { ...progress.current, phase }
  })
  progress.completedCaseCount = caseAttemptOrdinal
  progress.current = undefined
}

function manifestFor(input: OpenDesignM1FirstFailureInput): JsonObject {
  assertFailureInput(input)
  const failure = input.progress.current
  const paidTurnUpperBound = failure?.caseAttemptOrdinal ?? input.progress.completedCaseCount
  return {
    schemaVersion: 2,
    kind: 'open-design-m1-machine-first-failure',
    repository: REPOSITORY,
    workflowPath: WORKFLOW_PATH,
    producer: {
      headSha: input.authority.hostHeadSha,
      runId: input.authority.producerRunId,
      runAttempt: input.authority.producerRunAttempt,
    },
    host: {
      artifactSha256: input.authority.hostArtifactSha256,
      buildRunId: input.authority.hostBuildRunId,
    },
    batch: {
      batchId: `m1-${input.authority.producerRunId}`,
      startedAt: new Date(input.batchStartedAt).toISOString(),
      failedAt: new Date(input.failedAt).toISOString(),
      status: 'failed',
      stopOnFailure: true,
      paidTurnBudget: 40,
      paidTurnUpperBound,
      caseAttemptsCompleted: input.progress.completedCaseCount,
    },
    firstFailure: failure
      ? {
          code: 'CASE_EXECUTION_FAILED',
          stack: failure.stack,
          caseId: failure.caseId,
          turnOrdinal: failure.turnOrdinal,
          caseAttemptOrdinal: failure.caseAttemptOrdinal,
          phase: failure.phase,
        }
      : {
          code: 'LIFECYCLE_VERIFICATION_FAILED',
          phase: input.progress.lifecyclePhase,
        },
    cleanup: input.cleanup,
  }
}

async function requireOwnerOnlyRegularFile(path: string, maximumBytes: number): Promise<number> {
  const metadata = await lstat(path)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (uid !== undefined && metadata.uid !== uid)
    || (metadata.mode & 0o777) !== 0o600
    || metadata.size < 1 || metadata.size > maximumBytes) {
    throw new TypeError('OpenDesign M1 first-failure evidence file is unsafe')
  }
  return metadata.size
}

export async function validateOpenDesignM1FirstFailure(
  root: string,
  authority: OpenDesignM1FirstFailureAuthority,
): Promise<OpenDesignM1FirstFailureValidationResult> {
  assertAuthority(authority)
  const rootMetadata = await lstat(root)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
    || (uid !== undefined && rootMetadata.uid !== uid)
    || (rootMetadata.mode & 0o777) !== 0o700) {
    throw new TypeError('OpenDesign M1 first-failure evidence root is unsafe')
  }
  const entries = await readdir(root, { withFileTypes: true })
  const expectedNames = [MANIFEST_PATH, SUMS_PATH].sort()
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  if (entries.length !== OPEN_DESIGN_M1_FIRST_FAILURE_FILE_COUNT
    || entries.some((entry, index) => !entry.isFile() || entry.isSymbolicLink()
      || entry.name !== expectedNames[index])) {
    throw new TypeError('OpenDesign M1 first-failure evidence inventory is invalid')
  }
  const manifestSize = await requireOwnerOnlyRegularFile(join(root, MANIFEST_PATH), MANIFEST_MAX_BYTES)
  const sumsSize = await requireOwnerOnlyRegularFile(join(root, SUMS_PATH), SUMS_MAX_BYTES)
  const totalBytes = manifestSize + sumsSize
  if (totalBytes > OPEN_DESIGN_M1_FIRST_FAILURE_MAX_BYTES) {
    throw new TypeError('OpenDesign M1 first-failure evidence exceeds its total limit')
  }

  const manifestSource = await readFile(join(root, MANIFEST_PATH), 'utf8')
  let manifestValue: unknown
  try { manifestValue = JSON.parse(manifestSource) } catch {
    throw new TypeError('OpenDesign M1 first-failure manifest is invalid JSON')
  }
  if (manifestSource !== canonical(manifestValue)) {
    throw new TypeError('OpenDesign M1 first-failure manifest is not canonical')
  }
  const manifest = objectAt(manifestValue, '$')
  exactKeys(manifest, [
    'schemaVersion', 'kind', 'repository', 'workflowPath', 'producer', 'host', 'batch', 'firstFailure', 'cleanup',
  ], '$')
  if (manifest.schemaVersion !== 2 || manifest.kind !== 'open-design-m1-machine-first-failure'
    || manifest.repository !== REPOSITORY || manifest.workflowPath !== WORKFLOW_PATH) {
    throw new TypeError('OpenDesign M1 first-failure manifest identity is invalid')
  }
  const producer = objectAt(manifest.producer, '$.producer')
  exactKeys(producer, ['headSha', 'runId', 'runAttempt'], '$.producer')
  if (producer.headSha !== authority.hostHeadSha || producer.runId !== authority.producerRunId
    || producer.runAttempt !== authority.producerRunAttempt) {
    throw new TypeError('OpenDesign M1 first-failure producer authority is invalid')
  }
  const host = objectAt(manifest.host, '$.host')
  exactKeys(host, ['artifactSha256', 'buildRunId'], '$.host')
  if (host.artifactSha256 !== authority.hostArtifactSha256 || host.buildRunId !== authority.hostBuildRunId) {
    throw new TypeError('OpenDesign M1 first-failure Host authority is invalid')
  }
  const batch = objectAt(manifest.batch, '$.batch')
  exactKeys(batch, [
    'batchId', 'startedAt', 'failedAt', 'status', 'stopOnFailure', 'paidTurnBudget',
    'paidTurnUpperBound', 'caseAttemptsCompleted',
  ], '$.batch')
  if (batch.batchId !== `m1-${authority.producerRunId}` || batch.status !== 'failed'
    || batch.stopOnFailure !== true || batch.paidTurnBudget !== 40) {
    throw new TypeError('OpenDesign M1 first-failure batch identity is invalid')
  }
  const startedAt = timestampAt(batch, 'startedAt', '$.batch')
  const failedAt = timestampAt(batch, 'failedAt', '$.batch')
  const paidTurnUpperBound = integerAt(batch, 'paidTurnUpperBound', '$.batch')
  const caseAttemptsCompleted = integerAt(batch, 'caseAttemptsCompleted', '$.batch')
  if (failedAt < startedAt) throw new TypeError('OpenDesign M1 first-failure timeline is invalid')

  const cleanup = objectAt(manifest.cleanup, '$.cleanup')
  exactKeys(cleanup, [
    'moduleStop', 'runtimeSnapshotObserved', 'runtimeClean', 'activeRuns', 'moduleSessions',
    'hiddenSessions', 'transientSessions', 'quarantinedSessions', 'appExit',
    'descendantProcessesRemaining', 'ownedModuleProcessesRemaining',
  ], '$.cleanup')
  assertCleanupEvidence(cleanup as unknown as OpenDesignM1FailureCleanupEvidence)

  const firstFailure = objectAt(manifest.firstFailure, '$.firstFailure')
  if (firstFailure.code === 'CASE_EXECUTION_FAILED') {
    exactKeys(firstFailure, ['code', 'stack', 'caseId', 'turnOrdinal', 'caseAttemptOrdinal', 'phase'], '$.firstFailure')
    const stack = stringAt(firstFailure, 'stack', '$.firstFailure')
    const caseId = stringAt(firstFailure, 'caseId', '$.firstFailure')
    const phase = stringAt(firstFailure, 'phase', '$.firstFailure')
    if (!['old', 'new'].includes(stack)
      || !OPEN_DESIGN_M1_CASE_FAILURE_PHASES.includes(phase as OpenDesignM1CaseFailurePhase)) {
      throw new TypeError('OpenDesign M1 first-failure case identity is invalid')
    }
    const expected = expectedOrdinal(stack as OpenDesignM1FailureStack, caseId)
    if (integerAt(firstFailure, 'turnOrdinal', '$.firstFailure') !== expected.turnOrdinal
      || integerAt(firstFailure, 'caseAttemptOrdinal', '$.firstFailure') !== expected.caseAttemptOrdinal
      || paidTurnUpperBound !== expected.caseAttemptOrdinal
      || caseAttemptsCompleted !== expected.caseAttemptOrdinal - 1) {
      throw new TypeError('OpenDesign M1 first-failure case ordering is invalid')
    }
  } else {
    exactKeys(firstFailure, ['code', 'phase'], '$.firstFailure')
    const phase = stringAt(firstFailure, 'phase', '$.firstFailure')
    if (firstFailure.code !== 'LIFECYCLE_VERIFICATION_FAILED'
      || !OPEN_DESIGN_M1_LIFECYCLE_FAILURE_PHASES.includes(phase as OpenDesignM1LifecycleFailurePhase)
      || caseAttemptsCompleted < 1 || caseAttemptsCompleted > 40
      || paidTurnUpperBound !== caseAttemptsCompleted) {
      throw new TypeError('OpenDesign M1 lifecycle failure identity is invalid')
    }
  }

  const manifestSha = sha256(manifestSource)
  const expectedSums = `${manifestSha}  ${MANIFEST_PATH}\n`
  if (await readFile(join(root, SUMS_PATH), 'utf8') !== expectedSums) {
    throw new TypeError('OpenDesign M1 first-failure SHA256SUMS is invalid')
  }
  return {
    artifactName: OPEN_DESIGN_M1_FIRST_FAILURE_ARTIFACT_NAME,
    fileCount: OPEN_DESIGN_M1_FIRST_FAILURE_FILE_COUNT,
    objectPath: MANIFEST_PATH,
    sha256: manifestSha,
    totalBytes,
  }
}

export async function writeOpenDesignM1FirstFailure(
  root: string,
  input: OpenDesignM1FirstFailureInput,
): Promise<OpenDesignM1FirstFailureValidationResult> {
  const manifest = manifestFor(input)
  await mkdir(root, { mode: 0o700 })
  await chmod(root, 0o700)
  const manifestSource = canonical(manifest)
  await writeFile(join(root, MANIFEST_PATH), manifestSource, { mode: 0o600, flag: 'wx' })
  await writeFile(join(root, SUMS_PATH), `${sha256(manifestSource)}  ${MANIFEST_PATH}\n`, {
    mode: 0o600,
    flag: 'wx',
  })
  return validateOpenDesignM1FirstFailure(root, input.authority)
}

export async function preserveOpenDesignM1FirstFailure(
  stagingRoot: string,
  failureArtifactRoot: string,
  failureOutputRoot: string,
  input: OpenDesignM1FirstFailureInput,
): Promise<OpenDesignM1FirstFailureValidationResult> {
  const staging = resolve(stagingRoot)
  const artifact = resolve(failureArtifactRoot)
  const output = resolve(failureOutputRoot)
  if (dirname(artifact) !== staging || output === staging || output.startsWith(`${staging}${sep}`)) {
    throw new TypeError('OpenDesign M1 first-failure staging paths are invalid')
  }
  await writeOpenDesignM1FirstFailure(artifact, input)
  await rename(artifact, output)
  const result = await validateOpenDesignM1FirstFailure(output, input.authority)
  await rm(staging, { recursive: true, force: true })
  return result
}
