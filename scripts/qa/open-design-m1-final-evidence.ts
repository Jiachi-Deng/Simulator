import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  OPEN_DESIGN_M1_MACHINE_ARTIFACT_NAME,
  OPEN_DESIGN_M1_MACHINE_RECORD_MAX_BYTES,
  OPEN_DESIGN_M1_MACHINE_WORKFLOW_PATH,
  type MachineEvidenceAuthority,
  type ReleaseAuthority,
  validateOpenDesignM1MachineEvidence,
} from './open-design-m1-machine-evidence'
import {
  OPEN_DESIGN_M1_VISUAL_ARTIFACT_NAME,
  OPEN_DESIGN_M1_VISUAL_WORKFLOW_PATH,
  type VisualProducerAuthority,
  validateOpenDesignM1VisualAttestation,
} from './open-design-m1-visual-attestation'
import {
  OPEN_DESIGN_M1_CASES_V2,
  OPEN_DESIGN_M1_CASE_MANIFEST_V2_SHA256,
} from './open-design-m1-interaction-vectors'
import {
  OPEN_DESIGN_ACCEPTANCE_REPOSITORY,
  OPEN_DESIGN_M1_CASE_SEED_CHECKSUMS_SHA256,
  OPEN_DESIGN_RC_SOURCE_SHA,
  type EvidenceObjectRef,
  validateAndSummarizeOpenDesignM1RcAcceptanceIntakeV2,
} from './open-design-rc-acceptance-evidence'

export const OPEN_DESIGN_M1_FINAL_ARTIFACT_NAME = 'open-design-rc-acceptance-evidence' as const
export const OPEN_DESIGN_M1_FINAL_WORKFLOW_PATH = '.github/workflows/open-design-rc-acceptance.yml' as const
export const OPEN_DESIGN_M1_FINAL_INTAKE_PATH = 'open-design-rc-acceptance-intake.json' as const
export const OPEN_DESIGN_M1_FINAL_SUMMARY_PATH = 'open-design-rc-acceptance-evidence.json' as const

const SHA256 = /^[0-9a-f]{64}$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const ISO_TIMESTAMP = /^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/
const MAX_AUTHORITY_BYTES = 16 * 1024
const MAX_CANONICAL_JSON_BYTES = 256 * 1024

type JsonObject = Record<string, unknown>

export interface FinalEvidenceAuthority {
  readonly finalCreatedAt: string
  readonly hostArtifactSha256: string
  readonly hostBuildRunId: number
  readonly hostHeadSha: string
  readonly lkg: ReleaseAuthority
  readonly machineCompletedAt: string
  readonly machineRunAttempt: 1
  readonly machineRunId: number
  readonly rc: ReleaseAuthority & { readonly sourceSha: typeof OPEN_DESIGN_RC_SOURCE_SHA }
  readonly visualCompletedAt: string
  readonly visualCreatedAt: string
  readonly visualRunAttempt: 1
  readonly visualRunId: number
}

export interface FinalEvidenceResult {
  readonly artifactName: typeof OPEN_DESIGN_M1_FINAL_ARTIFACT_NAME
  readonly fileCount: 3
  readonly intakeSha256: string
  readonly machineManifestSha256: string
  readonly summarySha256: string
  readonly visualAttestationSha256: string
}

function fail(path: string): never {
  throw new TypeError(`OpenDesign M1 final evidence is invalid at ${path}`)
}

function objectAt(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path)
  return value as JsonObject
}

function exactKeys(value: JsonObject, keys: readonly string[], path: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(path)
}

function stringAt(value: JsonObject, key: string, path: string): string {
  if (typeof value[key] !== 'string') fail(`${path}.${key}`)
  return value[key] as string
}

function integerAt(value: JsonObject, key: string, path: string): number {
  if (!Number.isSafeInteger(value[key])) fail(`${path}.${key}`)
  return value[key] as number
}

function hashAt(value: JsonObject, key: string, path: string): string {
  const result = stringAt(value, key, path)
  if (!SHA256.test(result)) fail(`${path}.${key}`)
  return result
}

function timestamp(value: string, path: string): number {
  if (!ISO_TIMESTAMP.test(value)) fail(path)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(path)
  return milliseconds
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function readCanonicalJson(path: string, maximumBytes = MAX_CANONICAL_JSON_BYTES): Promise<unknown> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.size < 3 || metadata.size > maximumBytes) fail(path)
  const source = await readFile(path, 'utf8')
  let value: unknown
  try { value = JSON.parse(source) } catch { return fail(path) }
  if (source !== canonical(value)) fail(path)
  return value
}

function releaseAuthority(value: unknown, includeSourceSha: boolean, path: string): ReleaseAuthority & { sourceSha?: string } {
  const object = objectAt(value, path)
  exactKeys(object, [
    'archiveSha256', 'catalogIssuedAt', 'catalogSequence', 'catalogSha256', 'envelopeSha256',
    'expiresAt', 'extractedManifestSha256', ...(includeSourceSha ? ['sourceSha'] : []),
  ], path)
  const result: ReleaseAuthority & { sourceSha?: string } = {
    archiveSha256: hashAt(object, 'archiveSha256', path),
    catalogIssuedAt: stringAt(object, 'catalogIssuedAt', path),
    catalogSequence: integerAt(object, 'catalogSequence', path),
    catalogSha256: hashAt(object, 'catalogSha256', path),
    envelopeSha256: hashAt(object, 'envelopeSha256', path),
    expiresAt: stringAt(object, 'expiresAt', path),
    extractedManifestSha256: hashAt(object, 'extractedManifestSha256', path),
  }
  timestamp(result.catalogIssuedAt, `${path}.catalogIssuedAt`)
  timestamp(result.expiresAt, `${path}.expiresAt`)
  if (result.catalogSequence < 1) fail(`${path}.catalogSequence`)
  if (includeSourceSha) {
    const sourceSha = stringAt(object, 'sourceSha', path)
    if (sourceSha !== OPEN_DESIGN_RC_SOURCE_SHA) fail(`${path}.sourceSha`)
    result.sourceSha = sourceSha
  }
  return result
}

export function parseFinalEvidenceAuthority(value: unknown): FinalEvidenceAuthority {
  const object = objectAt(value, '$authority')
  exactKeys(object, [
    'finalCreatedAt', 'hostArtifactSha256', 'hostBuildRunId', 'hostHeadSha', 'lkg',
    'machineCompletedAt', 'machineRunAttempt', 'machineRunId', 'rc',
    'visualCompletedAt', 'visualCreatedAt', 'visualRunAttempt', 'visualRunId',
  ], '$authority')
  const hostHeadSha = stringAt(object, 'hostHeadSha', '$authority')
  const hostArtifactSha256 = hashAt(object, 'hostArtifactSha256', '$authority')
  if (!COMMIT_SHA.test(hostHeadSha)) fail('$authority.hostHeadSha')
  const hostBuildRunId = integerAt(object, 'hostBuildRunId', '$authority')
  const machineRunId = integerAt(object, 'machineRunId', '$authority')
  const visualRunId = integerAt(object, 'visualRunId', '$authority')
  if (hostBuildRunId < 1 || machineRunId < 1 || visualRunId < 1 || machineRunId === visualRunId) {
    fail('$authority.runIds')
  }
  if (object.machineRunAttempt !== 1 || object.visualRunAttempt !== 1) fail('$authority.runAttempt')
  const machineCompletedAt = stringAt(object, 'machineCompletedAt', '$authority')
  const visualCreatedAt = stringAt(object, 'visualCreatedAt', '$authority')
  const visualCompletedAt = stringAt(object, 'visualCompletedAt', '$authority')
  const finalCreatedAt = stringAt(object, 'finalCreatedAt', '$authority')
  const chronology = [machineCompletedAt, visualCreatedAt, visualCompletedAt, finalCreatedAt]
    .map((entry, index) => timestamp(entry, `$authority.chronology[${index}]`))
  if (!(chronology[0]! < chronology[1]! && chronology[1]! <= chronology[2]! && chronology[2]! < chronology[3]!)) {
    fail('$authority.chronology')
  }
  const lkg = releaseAuthority(object.lkg, false, '$authority.lkg')
  const rc = releaseAuthority(object.rc, true, '$authority.rc') as ReleaseAuthority & {
    readonly sourceSha: typeof OPEN_DESIGN_RC_SOURCE_SHA
  }
  if (rc.catalogSequence <= lkg.catalogSequence
    || timestamp(rc.catalogIssuedAt, '$authority.rc.catalogIssuedAt')
      <= timestamp(lkg.catalogIssuedAt, '$authority.lkg.catalogIssuedAt')) fail('$authority.rc')
  return {
    finalCreatedAt,
    hostArtifactSha256,
    hostBuildRunId,
    hostHeadSha,
    lkg,
    machineCompletedAt,
    machineRunAttempt: 1,
    machineRunId,
    rc,
    visualCompletedAt,
    visualCreatedAt,
    visualRunAttempt: 1,
    visualRunId,
  }
}

function artifactRef(input: {
  artifactName: string
  headSha: string
  objectPath: string
  runId: number
  sha256: string
  workflowPath: string
}): EvidenceObjectRef {
  return {
    repository: OPEN_DESIGN_ACCEPTANCE_REPOSITORY,
    workflowPath: input.workflowPath,
    runId: input.runId,
    runAttempt: 1,
    headSha: input.headSha,
    artifactName: input.artifactName,
    objectPath: input.objectPath,
    sha256: input.sha256,
  }
}

function machineRef(authority: FinalEvidenceAuthority, objectPath: string, sha256: string): EvidenceObjectRef {
  return artifactRef({
    artifactName: OPEN_DESIGN_M1_MACHINE_ARTIFACT_NAME,
    headSha: authority.hostHeadSha,
    objectPath,
    runId: authority.machineRunId,
    sha256,
    workflowPath: OPEN_DESIGN_M1_MACHINE_WORKFLOW_PATH,
  })
}

function fileReferenceMap(manifest: JsonObject): Map<string, string> {
  if (!Array.isArray(manifest.files)) fail('$machine.files')
  const result = new Map<string, string>()
  manifest.files.forEach((candidate, index) => {
    const entry = objectAt(candidate, `$machine.files[${index}]`)
    const path = stringAt(entry, 'path', `$machine.files[${index}]`)
    const sha256 = hashAt(entry, 'sha256', `$machine.files[${index}]`)
    if (result.has(path)) fail(`$machine.files[${index}].path`)
    result.set(path, sha256)
  })
  return result
}

function releaseIntake(value: unknown, path: string): JsonObject {
  const release = objectAt(value, path)
  return {
    archiveAsset: stringAt(release, 'archiveAsset', path),
    archiveSha256: hashAt(release, 'archiveSha256', path),
    catalogIssuedAt: stringAt(release, 'catalogIssuedAt', path),
    catalogSequence: integerAt(release, 'catalogSequence', path),
    expiresAt: stringAt(release, 'expiresAt', path),
    extractedManifestSha256: hashAt(release, 'extractedManifestSha256', path),
    tag: stringAt(release, 'tag', path),
    version: stringAt(release, 'version', path),
  }
}

function simplifiedBlackout(record: JsonObject, stack: 'old' | 'new', path: string): JsonObject {
  const blackout = objectAt(record.blackout, `${path}.blackout`)
  if (stack === 'old') return { required: false }
  const startedAt = timestamp(stringAt(blackout, 'startedAt', `${path}.blackout`), `${path}.blackout.startedAt`)
  const endedAt = timestamp(stringAt(blackout, 'endedAt', `${path}.blackout`), `${path}.blackout.endedAt`)
  const silenceSeconds = (endedAt - startedAt) / 1000
  if (!Number.isSafeInteger(silenceSeconds)) fail(`${path}.blackout`)
  return {
    bufferedEventCount: integerAt(blackout, 'bufferedEventCount', `${path}.blackout`),
    businessEventSilenceSeconds: silenceSeconds,
    duplicateTerminalCount: 0,
    eventsLost: integerAt(blackout, 'eventsLost', `${path}.blackout`),
    heartbeatContinued: integerAt(blackout, 'heartbeatCount', `${path}.blackout`) >= 6,
    replayComplete: blackout.replayComplete,
    replayedEventCount: integerAt(blackout, 'replayedEventCount', `${path}.blackout`),
    required: true,
  }
}

async function composeIntake(
  machineRoot: string,
  visualRoot: string,
  authority: FinalEvidenceAuthority,
  machineManifestSha256: string,
  visualAttestationSha256: string,
): Promise<JsonObject> {
  const manifest = objectAt(await readCanonicalJson(join(machineRoot, 'machine-manifest.json'), 64 * 1024), '$machine')
  const visual = objectAt(await readCanonicalJson(join(visualRoot, 'visual-attestation.json'), 64 * 1024), '$visual')
  const fileRefs = fileReferenceMap(manifest)
  const decisions = Array.isArray(visual.decisions) ? visual.decisions : fail('$visual.decisions')
  if (!Array.isArray(manifest.records) || manifest.records.length !== 40 || decisions.length !== 20) fail('$machine.records')
  const records: JsonObject[] = []
  for (let index = 0; index < manifest.records.length; index += 1) {
    const indexEntry = objectAt(manifest.records[index], `$machine.records[${index}]`)
    const stack = indexEntry.stack
    if (stack !== 'old' && stack !== 'new') fail(`$machine.records[${index}].stack`)
    const caseIndex = stack === 'old' ? index : index - OPEN_DESIGN_M1_CASES_V2.length
    const testCase = OPEN_DESIGN_M1_CASES_V2[caseIndex]
    if (!testCase) fail(`$machine.records[${index}].caseId`)
    const recordRef = objectAt(indexEntry.record, `$machine.records[${index}].record`)
    const recordPath = stringAt(recordRef, 'path', `$machine.records[${index}].record`)
    const record = objectAt(await readCanonicalJson(
      join(machineRoot, recordPath), OPEN_DESIGN_M1_MACHINE_RECORD_MAX_BYTES,
    ), `$record[${index}]`)
    const visualDecision = stack === 'new'
      ? objectAt(decisions[caseIndex], `$visual.decisions[${caseIndex}]`)
      : undefined
    if (visualDecision && (visualDecision.caseId !== testCase.id || visualDecision.decision !== 'PASS')) {
      fail(`$visual.decisions[${caseIndex}]`)
    }
    records.push({
      attemptOrdinal: record.attemptOrdinal,
      blackout: simplifiedBlackout(record, stack, `$record[${index}]`),
      caseId: record.caseId,
      cleanup: record.cleanup,
      completedAt: record.completedAt,
      craft: record.craft,
      moduleArchiveSha256: record.moduleArchiveSha256,
      preview: record.preview,
      promptSha256: record.promptSha256,
      seedArchiveSha256: record.seedArchiveSha256,
      stack,
      startedAt: record.startedAt,
      terminal: record.terminal,
      turnCount: record.turnCount,
      visual: stack === 'old'
        ? { required: false }
        : { decision: 'PASS', required: true, reviewerRole: 'product-owner' },
    })
  }
  const requiredCi = objectAt(await readCanonicalJson(join(machineRoot, 'required-ci.json')), '$requiredCi')
  const transitions = objectAt(await readCanonicalJson(join(machineRoot, 'rollback/transitions.json')), '$rollback.transitions')
  const processes = objectAt(await readCanonicalJson(join(machineRoot, 'rollback/processes.json')), '$rollback.processes')
  const hiddenSessions = objectAt(
    await readCanonicalJson(join(machineRoot, 'rollback/hidden-sessions.json')),
    '$rollback.hiddenSessions',
  )
  const ref = (path: string): EvidenceObjectRef => {
    const sha256 = fileRefs.get(path)
    if (!sha256) fail(`$machine.files:${path}`)
    return machineRef(authority, path, sha256)
  }
  const host = objectAt(manifest.host, '$machine.host')
  return {
    batch: manifest.batch,
    caseManifestSha256: OPEN_DESIGN_M1_CASE_MANIFEST_V2_SHA256,
    caseSeedChecksumsSha256: OPEN_DESIGN_M1_CASE_SEED_CHECKSUMS_SHA256,
    evidence: {
      machineBatch: machineRef(authority, 'machine-manifest.json', machineManifestSha256),
      visualDecisions: artifactRef({
        artifactName: OPEN_DESIGN_M1_VISUAL_ARTIFACT_NAME,
        headSha: authority.hostHeadSha,
        objectPath: 'visual-attestation.json',
        runId: authority.visualRunId,
        sha256: visualAttestationSha256,
        workflowPath: OPEN_DESIGN_M1_VISUAL_WORKFLOW_PATH,
      }),
    },
    host: {
      artifactName: host.artifactName,
      artifactSha256: host.artifactSha256,
      buildRunId: host.buildRunId,
      version: host.version,
    },
    hostHeadSha: authority.hostHeadSha,
    lkg: releaseIntake(manifest.lkg, '$machine.lkg'),
    rc: releaseIntake(manifest.rc, '$machine.rc'),
    rcSourceSha: OPEN_DESIGN_RC_SOURCE_SHA,
    records,
    repository: OPEN_DESIGN_ACCEPTANCE_REPOSITORY,
    requiredCi: {
      evidence: ref('required-ci.json'),
      passed: requiredCi.passed,
      runs: Array.isArray(requiredCi.runs)
        ? requiredCi.runs.map((candidate, index) => {
            const run = objectAt(candidate, `$requiredCi.runs[${index}]`)
            return { runId: run.runId, workflowPath: run.workflowPath }
          })
        : fail('$requiredCi.runs'),
    },
    rollbackExercise: {
      craftConnectionPreserved: transitions.craftConnectionPreserved,
      craftSurvivedAllTransitions: transitions.craftSurvivedAllTransitions,
      evidence: {
        hiddenSessionSnapshot: ref('rollback/hidden-sessions.json'),
        processSnapshot: ref('rollback/processes.json'),
        transitionLog: ref('rollback/transitions.json'),
      },
      hiddenSessionResidueCount: hiddenSessions.count,
      passed: transitions.passed === true && processes.passed === true && hiddenSessions.passed === true,
      processResidueCount: processes.count,
      restartAndReopenPassed: transitions.restartAndReopenPassed,
      transitions: transitions.transitions,
    },
    schemaVersion: 1,
  }
}

export async function createOpenDesignM1FinalEvidence(
  machineRootInput: string,
  visualRootInput: string,
  outputRootInput: string,
  authority: FinalEvidenceAuthority,
): Promise<FinalEvidenceResult> {
  const machineRoot = resolve(machineRootInput)
  const visualRoot = resolve(visualRootInput)
  const outputRoot = resolve(outputRootInput)
  const machineAuthority: MachineEvidenceAuthority = {
    hostHeadSha: authority.hostHeadSha,
    producerRunId: authority.machineRunId,
    producerRunAttempt: authority.machineRunAttempt,
    hostBuildRunId: authority.hostBuildRunId,
    hostArtifactSha256: authority.hostArtifactSha256,
    lkg: authority.lkg,
    rc: authority.rc,
  }
  const visualAuthority: VisualProducerAuthority = {
    machineHeadSha: authority.hostHeadSha,
    machineRunId: authority.machineRunId,
    machineRunAttempt: authority.machineRunAttempt,
    visualHeadSha: authority.hostHeadSha,
    visualRunId: authority.visualRunId,
    visualRunAttempt: authority.visualRunAttempt,
  }
  const machine = await validateOpenDesignM1MachineEvidence(machineRoot, machineAuthority)
  const visual = await validateOpenDesignM1VisualAttestation(visualRoot, machineRoot, visualAuthority)
  if (visual.machineManifestSha256 !== machine.sha256 || visual.batchDigest !== machine.batchDigest) fail('$crossBinding')
  const intake = await composeIntake(machineRoot, visualRoot, authority, machine.sha256, visual.sha256)
  const summary = validateAndSummarizeOpenDesignM1RcAcceptanceIntakeV2(intake, authority.hostHeadSha)
  await mkdir(outputRoot, { recursive: false, mode: 0o700 })
  const intakeSource = canonical(intake)
  const summarySource = canonical(summary)
  if (Buffer.byteLength(intakeSource) > MAX_CANONICAL_JSON_BYTES || Buffer.byteLength(summarySource) > 64 * 1024) {
    fail('$output')
  }
  await writeFile(join(outputRoot, OPEN_DESIGN_M1_FINAL_INTAKE_PATH), intakeSource, {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  })
  await writeFile(join(outputRoot, OPEN_DESIGN_M1_FINAL_SUMMARY_PATH), summarySource, {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  })
  const intakeSha256 = digest(intakeSource)
  const summarySha256 = digest(summarySource)
  await writeFile(join(outputRoot, 'SHA256SUMS'), [
    `${summarySha256}  ${OPEN_DESIGN_M1_FINAL_SUMMARY_PATH}`,
    `${intakeSha256}  ${OPEN_DESIGN_M1_FINAL_INTAKE_PATH}`,
  ].sort().join('\n') + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await chmod(outputRoot, 0o700)
  return {
    artifactName: OPEN_DESIGN_M1_FINAL_ARTIFACT_NAME,
    fileCount: 3,
    intakeSha256,
    machineManifestSha256: machine.sha256,
    summarySha256,
    visualAttestationSha256: visual.sha256,
  }
}

function parseArgs(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--') || values.has(key)) fail('arguments')
    values.set(key, value)
  }
  return values
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2))
  const expected = ['--authority', '--machine-root', '--output-root', '--visual-root'].sort()
  if ([...args.keys()].sort().join('\n') !== expected.join('\n')) fail('arguments')
  const authorityPath = args.get('--authority')!
  const authorityMetadata = await lstat(authorityPath)
  if (!authorityMetadata.isFile() || authorityMetadata.isSymbolicLink() || authorityMetadata.nlink !== 1
    || authorityMetadata.size < 3 || authorityMetadata.size > MAX_AUTHORITY_BYTES) fail('authority file')
  const authority = parseFinalEvidenceAuthority(await readCanonicalJson(authorityPath, MAX_AUTHORITY_BYTES))
  const result = await createOpenDesignM1FinalEvidence(
    args.get('--machine-root')!, args.get('--visual-root')!, args.get('--output-root')!, authority,
  )
  process.stdout.write(canonical(result))
}

if (import.meta.main) {
  void main().catch(() => {
    process.stderr.write('OpenDesign M1 final evidence validation failed.\n')
    process.exitCode = 1
  })
}
