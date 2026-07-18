import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import {
  OPEN_DESIGN_M1_MACHINE_ARTIFACT_NAME,
  OPEN_DESIGN_M1_MACHINE_WORKFLOW_PATH,
  validateOpenDesignM1MachineEvidence,
  type MachineEvidenceAuthority,
  type ReleaseAuthority,
} from './open-design-m1-machine-evidence'
import { OPEN_DESIGN_M1_CASES } from './open-design-m1-cases'
import {
  OPEN_DESIGN_ACCEPTANCE_REPOSITORY,
  OPEN_DESIGN_RC_SOURCE_SHA,
} from './open-design-rc-acceptance-evidence'

export const OPEN_DESIGN_M1_VISUAL_WORKFLOW_PATH =
  '.github/workflows/open-design-m1-visual-attestation.yml' as const
export const OPEN_DESIGN_M1_VISUAL_ARTIFACT_NAME = 'open-design-m1-visual-attestation' as const
export const OPEN_DESIGN_M1_VISUAL_FILE_COUNT = 2 as const
export const OPEN_DESIGN_M1_VISUAL_MAX_BYTES = 128 * 1024
export const OPEN_DESIGN_M1_VISUAL_DECISIONS_MAX_BYTES = 8 * 1024

const SHA256 = /^[0-9a-f]{64}$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const ISO_TIMESTAMP = /^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/
const VISUAL_ATTESTATION_PATH = 'visual-attestation.json' as const
const CHECKSUMS_PATH = 'SHA256SUMS' as const

type JsonObject = Record<string, unknown>

export interface VisualProducerAuthority {
  readonly machineHeadSha: string
  readonly machineRunAttempt: 1
  readonly machineRunId: number
  readonly visualHeadSha: string
  readonly visualRunAttempt: 1
  readonly visualRunId: number
}

export interface VisualDecisionInput {
  readonly caseId: string
  readonly decision: 'PASS'
  readonly reviewedAt: string
}

export interface VisualAttestationValidationResult {
  readonly artifactName: typeof OPEN_DESIGN_M1_VISUAL_ARTIFACT_NAME
  readonly objectPath: typeof VISUAL_ATTESTATION_PATH
  readonly sha256: string
  readonly fileCount: typeof OPEN_DESIGN_M1_VISUAL_FILE_COUNT
  readonly machineManifestSha256: string
  readonly batchDigest: string
}

function fail(path: string, message = 'is invalid'): never {
  throw new TypeError(`OpenDesign M1 visual attestation ${message}: ${path}`)
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

function literal(value: unknown, expected: unknown, path: string): void {
  if (value !== expected) fail(path)
}

function hashAt(value: JsonObject, key: string, path: string): string {
  const valueAtKey = stringAt(value, key, path)
  if (!SHA256.test(valueAtKey)) fail(`${path}.${key}`)
  return valueAtKey
}

function timestampAt(value: JsonObject, key: string, path: string): number {
  const source = stringAt(value, key, path)
  if (!ISO_TIMESTAMP.test(source)) fail(`${path}.${key}`)
  const milliseconds = Date.parse(source)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== source) fail(`${path}.${key}`)
  return milliseconds
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function validateAuthority(authority: VisualProducerAuthority): void {
  if (!COMMIT_SHA.test(authority.machineHeadSha) || !COMMIT_SHA.test(authority.visualHeadSha)
    || authority.machineHeadSha !== authority.visualHeadSha
    || authority.machineRunId < 1 || authority.machineRunAttempt !== 1
    || authority.visualRunId < 1 || authority.visualRunAttempt !== 1) fail('authority')
}

async function inventoryRegularFiles(root: string): Promise<string[]> {
  const result: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const path = relative(root, absolute).split(sep).join('/')
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink()) fail(path, 'contains a symlink')
      if (metadata.isDirectory()) await visit(absolute)
      else if (metadata.isFile() && metadata.nlink === 1) result.push(path)
      else fail(path, 'contains a non-regular file')
    }
  }
  await visit(root)
  return result.sort()
}

async function readBoundedRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.size < 1 || metadata.size > maximumBytes) fail(path, 'violates file constraints')
  const bytes = await readFile(path)
  if (bytes.byteLength !== metadata.size) fail(path, 'changed while being read')
  return bytes
}

async function readCanonicalJson(path: string, maximumBytes: number): Promise<unknown> {
  const bytes = await readBoundedRegularFile(path, maximumBytes)
  const source = bytes.toString('utf8')
  let value: unknown
  try { value = JSON.parse(source) } catch { return fail(path, 'is not JSON') }
  if (source !== canonicalJson(value)) fail(path, 'is not canonical compact JSON')
  return value
}

function releaseAuthority(value: unknown, includeSourceSha: boolean, path: string): ReleaseAuthority & { sourceSha?: string } {
  const object = objectAt(value, path)
  const result: ReleaseAuthority & { sourceSha?: string } = {
    archiveSha256: hashAt(object, 'archiveSha256', path),
    catalogIssuedAt: stringAt(object, 'catalogIssuedAt', path),
    catalogSequence: integerAt(object, 'catalogSequence', path),
    catalogSha256: hashAt(object, 'catalogSha256', path),
    envelopeSha256: hashAt(object, 'envelopeSha256', path),
    expiresAt: stringAt(object, 'expiresAt', path),
    extractedManifestSha256: hashAt(object, 'extractedManifestSha256', path),
  }
  if (includeSourceSha) result.sourceSha = stringAt(object, 'sourceSha', path)
  return result
}

async function readMachineView(
  machineRootInput: string,
  authority: VisualProducerAuthority,
): Promise<{
  manifest: JsonObject
  machineValidation: Awaited<ReturnType<typeof validateOpenDesignM1MachineEvidence>>
}> {
  const machineRoot = resolve(machineRootInput)
  const manifest = objectAt(
    await readCanonicalJson(join(machineRoot, 'machine-manifest.json'), 64 * 1024),
    '$machine',
  )
  const host = objectAt(manifest.host, '$machine.host')
  const h1Authority = objectAt(manifest.h1Authority, '$machine.h1Authority')
  const machineAuthority: MachineEvidenceAuthority = {
    hostHeadSha: authority.machineHeadSha,
    producerRunId: authority.machineRunId,
    producerRunAttempt: authority.machineRunAttempt,
    hostBuildRunId: integerAt(host, 'buildRunId', '$machine.host'),
    hostArtifactSha256: hashAt(host, 'artifactSha256', '$machine.host'),
    h1: {
      connectionEvidenceSha256: hashAt(h1Authority, 'connectionEvidenceSha256', '$machine.h1Authority'),
      handoffSha256: hashAt(h1Authority, 'handoffSha256', '$machine.h1Authority'),
    },
    lkg: releaseAuthority(manifest.lkg, false, '$machine.lkg'),
    rc: releaseAuthority(manifest.rc, true, '$machine.rc') as ReleaseAuthority & { readonly sourceSha: string },
  }
  const machineValidation = await validateOpenDesignM1MachineEvidence(machineRoot, machineAuthority)
  return { manifest, machineValidation }
}

export async function readOpenDesignM1VisualDecisions(path: string): Promise<readonly VisualDecisionInput[]> {
  const value = await readCanonicalJson(path, OPEN_DESIGN_M1_VISUAL_DECISIONS_MAX_BYTES)
  if (!Array.isArray(value) || value.length !== OPEN_DESIGN_M1_CASES.length) fail('$decisions')
  return Object.freeze(value.map((candidate, index) => {
    const decision = objectAt(candidate, `$decisions[${index}]`)
    exactKeys(decision, ['caseId', 'decision', 'reviewedAt'], `$decisions[${index}]`)
    literal(decision.caseId, OPEN_DESIGN_M1_CASES[index].id, `$decisions[${index}].caseId`)
    literal(decision.decision, 'PASS', `$decisions[${index}].decision`)
    timestampAt(decision, 'reviewedAt', `$decisions[${index}]`)
    return Object.freeze({
      caseId: decision.caseId as string,
      decision: 'PASS' as const,
      reviewedAt: decision.reviewedAt as string,
    })
  }))
}

function machineRecordRefs(manifest: JsonObject): Map<string, { recordSha256: string; previewPath: string; previewSha256: string }> {
  if (!Array.isArray(manifest.records)) fail('$machine.records')
  const result = new Map<string, { recordSha256: string; previewPath: string; previewSha256: string }>()
  for (const [index, candidate] of manifest.records.entries()) {
    const entry = objectAt(candidate, `$machine.records[${index}]`)
    if (entry.stack !== 'new') continue
    const caseId = stringAt(entry, 'caseId', `$machine.records[${index}]`)
    const record = objectAt(entry.record, `$machine.records[${index}].record`)
    const preview = objectAt(entry.preview, `$machine.records[${index}].preview`)
    result.set(caseId, {
      recordSha256: hashAt(record, 'sha256', `$machine.records[${index}].record`),
      previewPath: stringAt(preview, 'path', `$machine.records[${index}].preview`),
      previewSha256: hashAt(preview, 'sha256', `$machine.records[${index}].preview`),
    })
  }
  if (result.size !== OPEN_DESIGN_M1_CASES.length) fail('$machine.records')
  return result
}

function expectedAttestation(
  manifest: JsonObject,
  machineValidation: Awaited<ReturnType<typeof validateOpenDesignM1MachineEvidence>>,
  decisions: readonly VisualDecisionInput[],
  authority: VisualProducerAuthority,
  completedAt: string,
): JsonObject {
  const machineBatch = objectAt(manifest.batch, '$machine.batch')
  const batchCompletedAt = timestampAt(machineBatch, 'completedAt', '$machine.batch')
  const completedAtMilliseconds = Date.parse(completedAt)
  if (!ISO_TIMESTAMP.test(completedAt) || !Number.isFinite(completedAtMilliseconds)
    || new Date(completedAtMilliseconds).toISOString() !== completedAt) fail('completedAt')
  let previousReviewedAt = batchCompletedAt
  for (const [index, decision] of decisions.entries()) {
    const reviewedAt = Date.parse(decision.reviewedAt)
    if (reviewedAt <= batchCompletedAt || reviewedAt < previousReviewedAt || reviewedAt > completedAtMilliseconds) {
      fail(`$decisions[${index}].reviewedAt`)
    }
    previousReviewedAt = reviewedAt
  }
  const host = objectAt(manifest.host, '$machine.host')
  const rc = objectAt(manifest.rc, '$machine.rc')
  const refs = machineRecordRefs(manifest)
  return {
    schemaVersion: 1,
    kind: 'open-design-m1-visual-attestation',
    repository: OPEN_DESIGN_ACCEPTANCE_REPOSITORY,
    workflowPath: OPEN_DESIGN_M1_VISUAL_WORKFLOW_PATH,
    producer: {
      headSha: authority.visualHeadSha,
      runAttempt: authority.visualRunAttempt,
      runId: authority.visualRunId,
    },
    machineAuthority: {
      artifactName: OPEN_DESIGN_M1_MACHINE_ARTIFACT_NAME,
      batchDigest: machineValidation.batchDigest,
      headSha: authority.machineHeadSha,
      hostArtifactSha256: hashAt(host, 'artifactSha256', '$machine.host'),
      machineManifestSha256: machineValidation.sha256,
      rcArchiveSha256: hashAt(rc, 'archiveSha256', '$machine.rc'),
      rcCatalogIssuedAt: stringAt(rc, 'catalogIssuedAt', '$machine.rc'),
      rcCatalogSequence: integerAt(rc, 'catalogSequence', '$machine.rc'),
      rcSourceSha: OPEN_DESIGN_RC_SOURCE_SHA,
      runAttempt: authority.machineRunAttempt,
      runId: authority.machineRunId,
      workflowPath: OPEN_DESIGN_M1_MACHINE_WORKFLOW_PATH,
    },
    decisions: OPEN_DESIGN_M1_CASES.map((testCase, index) => {
      const ref = refs.get(testCase.id)
      if (!ref) return fail(`$machine.records:${testCase.id}`)
      return {
        caseId: testCase.id,
        decision: decisions[index].decision,
        machineRecordSha256: ref.recordSha256,
        previewObjectPath: ref.previewPath,
        previewSha256: ref.previewSha256,
        reviewedAt: decisions[index].reviewedAt,
        visualAssertionSha256: digest(testCase.visualAssertion),
      }
    }),
    review: {
      completedAt,
      decisionCount: OPEN_DESIGN_M1_CASES.length,
      result: 'passed',
      reviewerRole: 'product-owner',
    },
  }
}

export async function createOpenDesignM1VisualAttestation(
  machineRoot: string,
  decisionsPath: string,
  outputRootInput: string,
  authority: VisualProducerAuthority,
  completedAt: string,
): Promise<VisualAttestationValidationResult> {
  validateAuthority(authority)
  const outputRoot = resolve(outputRootInput)
  await mkdir(outputRoot, { recursive: false, mode: 0o700 })
  const decisions = await readOpenDesignM1VisualDecisions(decisionsPath)
  const { manifest, machineValidation } = await readMachineView(machineRoot, authority)
  const attestation = expectedAttestation(manifest, machineValidation, decisions, authority, completedAt)
  const attestationSource = canonicalJson(attestation)
  await writeFile(join(outputRoot, VISUAL_ATTESTATION_PATH), attestationSource, { mode: 0o600, flag: 'wx' })
  await writeFile(
    join(outputRoot, CHECKSUMS_PATH),
    `${digest(attestationSource)}  ${VISUAL_ATTESTATION_PATH}\n`,
    { mode: 0o600, flag: 'wx' },
  )
  await chmod(outputRoot, 0o700)
  return validateOpenDesignM1VisualAttestation(outputRoot, machineRoot, authority)
}

export async function validateOpenDesignM1VisualAttestation(
  visualRootInput: string,
  machineRoot: string,
  authority: VisualProducerAuthority,
): Promise<VisualAttestationValidationResult> {
  validateAuthority(authority)
  const root = resolve(visualRootInput)
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail('artifact root')
  const expectedPaths = [CHECKSUMS_PATH, VISUAL_ATTESTATION_PATH].sort()
  const actualPaths = await inventoryRegularFiles(root)
  if (actualPaths.join('\n') !== expectedPaths.join('\n')) fail('artifact inventory')
  const attestationBytes = await readBoundedRegularFile(join(root, VISUAL_ATTESTATION_PATH), 64 * 1024)
  const sumsBytes = await readBoundedRegularFile(join(root, CHECKSUMS_PATH), 256)
  if (attestationBytes.byteLength + sumsBytes.byteLength > OPEN_DESIGN_M1_VISUAL_MAX_BYTES) fail('artifact size')
  const attestationSha256 = digest(attestationBytes)
  if (sumsBytes.toString('utf8') !== `${attestationSha256}  ${VISUAL_ATTESTATION_PATH}\n`) fail(CHECKSUMS_PATH)
  const attestation = objectAt(
    await readCanonicalJson(join(root, VISUAL_ATTESTATION_PATH), 64 * 1024),
    '$',
  )
  exactKeys(attestation, [
    'decisions', 'kind', 'machineAuthority', 'producer', 'repository', 'review', 'schemaVersion', 'workflowPath',
  ], '$')
  literal(attestation.schemaVersion, 1, '$.schemaVersion')
  literal(attestation.kind, 'open-design-m1-visual-attestation', '$.kind')
  literal(attestation.repository, OPEN_DESIGN_ACCEPTANCE_REPOSITORY, '$.repository')
  literal(attestation.workflowPath, OPEN_DESIGN_M1_VISUAL_WORKFLOW_PATH, '$.workflowPath')
  const producer = objectAt(attestation.producer, '$.producer')
  exactKeys(producer, ['headSha', 'runAttempt', 'runId'], '$.producer')
  literal(producer.headSha, authority.visualHeadSha, '$.producer.headSha')
  literal(producer.runAttempt, authority.visualRunAttempt, '$.producer.runAttempt')
  literal(producer.runId, authority.visualRunId, '$.producer.runId')

  const review = objectAt(attestation.review, '$.review')
  exactKeys(review, ['completedAt', 'decisionCount', 'result', 'reviewerRole'], '$.review')
  literal(review.decisionCount, OPEN_DESIGN_M1_CASES.length, '$.review.decisionCount')
  literal(review.result, 'passed', '$.review.result')
  literal(review.reviewerRole, 'product-owner', '$.review.reviewerRole')
  timestampAt(review, 'completedAt', '$.review')

  if (!Array.isArray(attestation.decisions) || attestation.decisions.length !== OPEN_DESIGN_M1_CASES.length) {
    fail('$.decisions')
  }
  const sourceDecisions: VisualDecisionInput[] = attestation.decisions.map((candidate, index) => {
    const decision = objectAt(candidate, `$.decisions[${index}]`)
    exactKeys(decision, [
      'caseId', 'decision', 'machineRecordSha256', 'previewObjectPath', 'previewSha256',
      'reviewedAt', 'visualAssertionSha256',
    ], `$.decisions[${index}]`)
    literal(decision.caseId, OPEN_DESIGN_M1_CASES[index].id, `$.decisions[${index}].caseId`)
    literal(decision.decision, 'PASS', `$.decisions[${index}].decision`)
    hashAt(decision, 'machineRecordSha256', `$.decisions[${index}]`)
    hashAt(decision, 'previewSha256', `$.decisions[${index}]`)
    hashAt(decision, 'visualAssertionSha256', `$.decisions[${index}]`)
    timestampAt(decision, 'reviewedAt', `$.decisions[${index}]`)
    const previewObjectPath = stringAt(decision, 'previewObjectPath', `$.decisions[${index}]`)
    literal(previewObjectPath, `previews/new/${OPEN_DESIGN_M1_CASES[index].id}.png`, `$.decisions[${index}].previewObjectPath`)
    return {
      caseId: decision.caseId as string,
      decision: 'PASS',
      reviewedAt: decision.reviewedAt as string,
    }
  })
  const { manifest, machineValidation } = await readMachineView(machineRoot, authority)
  const expected = expectedAttestation(
    manifest,
    machineValidation,
    sourceDecisions,
    authority,
    stringAt(review, 'completedAt', '$.review'),
  )
  if (canonicalJson(attestation) !== canonicalJson(expected)) fail('$', 'does not match machine authority')
  const machineAuthority = objectAt(attestation.machineAuthority, '$.machineAuthority')
  return {
    artifactName: OPEN_DESIGN_M1_VISUAL_ARTIFACT_NAME,
    objectPath: VISUAL_ATTESTATION_PATH,
    sha256: attestationSha256,
    fileCount: OPEN_DESIGN_M1_VISUAL_FILE_COUNT,
    machineManifestSha256: hashAt(machineAuthority, 'machineManifestSha256', '$.machineAuthority'),
    batchDigest: hashAt(machineAuthority, 'batchDigest', '$.machineAuthority'),
  }
}

function parseArgs(args: readonly string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--') || result.has(key)) fail('arguments')
    result.set(key, value)
  }
  return result
}

function requiredArg(args: Map<string, string>, key: string): string {
  const value = args.get(key)
  if (!value) fail(`arguments.${key}`)
  return value
}

function positiveIntegerArg(args: Map<string, string>, key: string): number {
  const value = requiredArg(args, key)
  if (!/^[1-9][0-9]*$/.test(value)) fail(`arguments.${key}`)
  const result = Number(value)
  if (!Number.isSafeInteger(result)) fail(`arguments.${key}`)
  return result
}

async function main(): Promise<void> {
  const [command, ...rest] = Bun.argv.slice(2)
  if (command !== 'produce' && command !== 'validate') fail('arguments.command')
  const args = parseArgs(rest)
  const expectedKeys = [
    '--machine-root', '--machine-run-id', '--machine-run-attempt', '--machine-head-sha',
    '--visual-root', '--visual-run-id', '--visual-run-attempt', '--visual-head-sha',
    ...(command === 'produce' ? ['--decisions', '--completed-at'] : []),
  ].sort()
  if ([...args.keys()].sort().join('\n') !== expectedKeys.join('\n')) fail('arguments')
  const authority: VisualProducerAuthority = {
    machineHeadSha: requiredArg(args, '--machine-head-sha'),
    machineRunId: positiveIntegerArg(args, '--machine-run-id'),
    machineRunAttempt: positiveIntegerArg(args, '--machine-run-attempt') as 1,
    visualHeadSha: requiredArg(args, '--visual-head-sha'),
    visualRunId: positiveIntegerArg(args, '--visual-run-id'),
    visualRunAttempt: positiveIntegerArg(args, '--visual-run-attempt') as 1,
  }
  const result = command === 'produce'
    ? await createOpenDesignM1VisualAttestation(
      requiredArg(args, '--machine-root'),
      requiredArg(args, '--decisions'),
      requiredArg(args, '--visual-root'),
      authority,
      requiredArg(args, '--completed-at'),
    )
    : await validateOpenDesignM1VisualAttestation(
      requiredArg(args, '--visual-root'),
      requiredArg(args, '--machine-root'),
      authority,
    )
  process.stdout.write(canonicalJson(result))
}

if (import.meta.main) {
  await main()
}

export const visualAttestationTestOnly = Object.freeze({
  async replaceCanonicalJson(root: string, mutate: (value: JsonObject) => void): Promise<void> {
    const path = join(root, VISUAL_ATTESTATION_PATH)
    const value = objectAt(JSON.parse(await readFile(path, 'utf8')), '$')
    mutate(value)
    const source = canonicalJson(value)
    await writeFile(path, source, { mode: 0o600 })
    await writeFile(join(root, CHECKSUMS_PATH), `${digest(source)}  ${VISUAL_ATTESTATION_PATH}\n`, { mode: 0o600 })
  },
})
