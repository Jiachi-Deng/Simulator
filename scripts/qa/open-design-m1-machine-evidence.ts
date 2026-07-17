import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  type OpenDesignM1Case,
} from './open-design-m1-cases'
import {
  OPEN_DESIGN_M1_CASES_V2,
  OPEN_DESIGN_M1_CASE_MANIFEST_V2_SHA256,
  OPEN_DESIGN_M1_CASE_V2_HASHES,
  OPEN_DESIGN_M1_INTERACTION_VECTORS,
  OPEN_DESIGN_M1_INTERACTION_VECTORS_CANONICAL_SHA256,
  type OpenDesignM1CaseV2,
} from './open-design-m1-interaction-vectors'
import {
  createDeterministicOpenDesignM1InteractionEvidenceFixture,
  validateOpenDesignM1InteractionEvidence,
} from './open-design-m1-preview-interactions'
import {
  OPEN_DESIGN_ACCEPTANCE_REPOSITORY,
  OPEN_DESIGN_HOST_ARTIFACT_NAME,
  OPEN_DESIGN_HOST_VERSION,
  OPEN_DESIGN_LKG_ARCHIVE_ASSET,
  OPEN_DESIGN_LKG_TAG,
  OPEN_DESIGN_LKG_VERSION,
  OPEN_DESIGN_M1_CASE_SEED_CHECKSUMS_SHA256,
  OPEN_DESIGN_RC_ARCHIVE_ASSET,
  OPEN_DESIGN_RC_SOURCE_SHA,
  OPEN_DESIGN_RC_TAG,
  OPEN_DESIGN_RC_VERSION,
  OPEN_DESIGN_REQUIRED_CI_WORKFLOW_PATHS,
} from './open-design-rc-acceptance-evidence'

export const OPEN_DESIGN_M1_MACHINE_WORKFLOW_PATH =
  '.github/workflows/open-design-m1-machine-evidence.yml' as const
export const OPEN_DESIGN_M1_MACHINE_ARTIFACT_NAME = 'open-design-m1-machine-evidence' as const
export const OPEN_DESIGN_M1_MACHINE_FILE_COUNT = 150 as const
export const OPEN_DESIGN_M1_MACHINE_MAX_BYTES = 96 * 1024 * 1024
export const OPEN_DESIGN_M1_MACHINE_RECORD_MAX_BYTES = 384 * 1024

const SHA256 = /^[0-9a-f]{64}$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ISO_TIMESTAMP = /^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const FILE_LIMITS = Object.freeze({
  manifest: 64 * 1024,
  requiredCi: 64 * 1024,
  record: OPEN_DESIGN_M1_MACHINE_RECORD_MAX_BYTES,
  events: 256 * 1024,
  workspace: 64 * 1024,
  preview: 4 * 1024 * 1024,
  rollback: 256 * 1024,
  trust: 256 * 1024,
  sums: 64 * 1024,
})

type JsonObject = Record<string, unknown>
export type OpenDesignM1Stack = 'old' | 'new'

export interface MachineEvidenceAuthority {
  readonly hostHeadSha: string
  readonly producerRunId: number
  readonly producerRunAttempt: 1
  readonly hostBuildRunId: number
  readonly hostArtifactSha256: string
  readonly lkg: ReleaseAuthority
  readonly rc: ReleaseAuthority & { readonly sourceSha: string }
}

export interface ReleaseAuthority {
  readonly archiveSha256: string
  readonly catalogIssuedAt: string
  readonly catalogSequence: number
  readonly catalogSha256: string
  readonly envelopeSha256: string
  readonly expiresAt: string
  readonly extractedManifestSha256: string
}

export interface MachineEvidenceValidationResult {
  readonly artifactName: typeof OPEN_DESIGN_M1_MACHINE_ARTIFACT_NAME
  readonly objectPath: 'machine-manifest.json'
  readonly sha256: string
  readonly fileCount: typeof OPEN_DESIGN_M1_MACHINE_FILE_COUNT
  readonly totalBytes: number
  readonly batchDigest: string
}

function fail(path: string, message = 'invalid'): never {
  throw new TypeError(`OpenDesign M1 machine evidence ${message}: ${path}`)
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

function booleanAt(value: JsonObject, key: string, path: string): boolean {
  if (typeof value[key] !== 'boolean') fail(`${path}.${key}`)
  return value[key] as boolean
}

function literal(value: unknown, expected: unknown, path: string): void {
  if (value !== expected) fail(path)
}

function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashAt(value: JsonObject, key: string, path: string): string {
  const result = stringAt(value, key, path)
  if (!SHA256.test(result)) fail(`${path}.${key}`)
  return result
}

function timestampAt(value: JsonObject, key: string, path: string): number {
  const source = stringAt(value, key, path)
  if (!ISO_TIMESTAMP.test(source)) fail(`${path}.${key}`)
  const milliseconds = Date.parse(source)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== source) fail(`${path}.${key}`)
  return milliseconds
}

function relativeObjectPath(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
    || value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.includes('//')
    || value.includes('\0') || value.split('/').some((part) => part === '' || part === '.' || part === '..')
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) fail(path)
  return value
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function fileLimit(path: string): number {
  if (path === 'machine-manifest.json') return FILE_LIMITS.manifest
  if (path === 'required-ci.json') return FILE_LIMITS.requiredCi
  if (path === 'SHA256SUMS') return FILE_LIMITS.sums
  if (path.startsWith('records/')) return FILE_LIMITS.record
  if (path.startsWith('events/')) return FILE_LIMITS.events
  if (path.startsWith('workspace/')) return FILE_LIMITS.workspace
  if (path.startsWith('previews/')) return FILE_LIMITS.preview
  if (path.startsWith('rollback/')) return FILE_LIMITS.rollback
  if (path.startsWith('trust/')) return FILE_LIMITS.trust
  return fail(path, 'has unexpected path')
}

export function expectedMachineEvidencePaths(): readonly string[] {
  const paths = [
    'machine-manifest.json',
    'required-ci.json',
    ...OPEN_DESIGN_M1_CASES_V2.flatMap((testCase) => [
      `records/old/${testCase.id}.json`,
      `events/old/${testCase.id}.jsonl`,
      `workspace/old/${testCase.id}.json`,
      `records/new/${testCase.id}.json`,
      `events/new/${testCase.id}.jsonl`,
      `workspace/new/${testCase.id}.json`,
      `previews/new/${testCase.id}.png`,
    ]),
    'rollback/transitions.json',
    'rollback/processes.json',
    'rollback/hidden-sessions.json',
    'trust/lkg-catalog.json',
    'trust/lkg-envelope.json',
    'trust/rc-catalog.json',
    'trust/rc-envelope.json',
    'SHA256SUMS',
  ].sort()
  if (paths.length !== OPEN_DESIGN_M1_MACHINE_FILE_COUNT || new Set(paths).size !== paths.length) {
    throw new Error('Internal machine evidence path inventory is invalid')
  }
  return Object.freeze(paths)
}

async function inventoryRegularFiles(root: string): Promise<string[]> {
  const result: string[] = []
  const directories: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const path = relative(root, absolute).split(sep).join('/')
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink()) fail(path, 'contains a symlink')
      if (metadata.isDirectory()) {
        directories.push(path)
        await visit(absolute)
      }
      else if (metadata.isFile() && metadata.nlink === 1) result.push(path)
      else fail(path, 'contains a non-regular file')
    }
  }
  await visit(root)
  const expectedDirectories = new Set<string>()
  for (const path of expectedMachineEvidencePaths()) {
    let current = dirname(path).split(sep).join('/')
    while (current !== '.') {
      expectedDirectories.add(current)
      current = dirname(current).split(sep).join('/')
    }
  }
  if (directories.sort().join('\n') !== [...expectedDirectories].sort().join('\n')) {
    fail('artifact directory inventory')
  }
  return result.sort()
}

async function readBounded(root: string, path: string): Promise<Buffer> {
  const absolute = resolve(root, path)
  if (relative(root, absolute).startsWith('..')) fail(path, 'escapes artifact root')
  const metadata = await lstat(absolute)
  const limit = fileLimit(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.size < 1 || metadata.size > limit) fail(path, 'violates file constraints')
  const bytes = await readFile(absolute)
  if (bytes.byteLength !== metadata.size) fail(path, 'changed while being read')
  return bytes
}

async function readCanonicalJson(root: string, path: string): Promise<unknown> {
  const bytes = await readBounded(root, path)
  const source = bytes.toString('utf8')
  let value: unknown
  try { value = JSON.parse(source) } catch { return fail(path, 'is not JSON') }
  if (source !== canonicalJson(value)) fail(path, 'is not canonical compact JSON')
  return value
}

function validateProducer(value: unknown, authority: MachineEvidenceAuthority, path: string): void {
  const object = objectAt(value, path)
  exactKeys(object, ['headSha', 'runAttempt', 'runId'], path)
  literal(object.headSha, authority.hostHeadSha, `${path}.headSha`)
  literal(object.runAttempt, 1, `${path}.runAttempt`)
  literal(object.runId, authority.producerRunId, `${path}.runId`)
}

function validateHost(value: unknown, authority: MachineEvidenceAuthority, path: string): void {
  const object = objectAt(value, path)
  exactKeys(object, ['artifactName', 'artifactSha256', 'buildRunId', 'version'], path)
  literal(object.version, OPEN_DESIGN_HOST_VERSION, `${path}.version`)
  literal(object.artifactName, OPEN_DESIGN_HOST_ARTIFACT_NAME, `${path}.artifactName`)
  literal(object.artifactSha256, authority.hostArtifactSha256, `${path}.artifactSha256`)
  literal(object.buildRunId, authority.hostBuildRunId, `${path}.buildRunId`)
}

function validateRelease(
  value: unknown,
  authority: ReleaseAuthority,
  stack: OpenDesignM1Stack,
  path: string,
): { issuedAt: number; expiresAt: number } {
  const object = objectAt(value, path)
  const isRc = stack === 'new'
  exactKeys(object, [
    'archiveAsset', 'archiveSha256', 'catalogIssuedAt', 'catalogSequence', 'catalogSha256',
    'envelopeSha256', 'expiresAt', 'extractedManifestSha256',
    ...(isRc ? ['sourceSha'] : []), 'tag', 'version',
  ], path)
  literal(object.version, isRc ? OPEN_DESIGN_RC_VERSION : OPEN_DESIGN_LKG_VERSION, `${path}.version`)
  literal(object.tag, isRc ? OPEN_DESIGN_RC_TAG : OPEN_DESIGN_LKG_TAG, `${path}.tag`)
  literal(object.archiveAsset, isRc ? OPEN_DESIGN_RC_ARCHIVE_ASSET : OPEN_DESIGN_LKG_ARCHIVE_ASSET, `${path}.archiveAsset`)
  for (const key of ['archiveSha256', 'catalogSha256', 'envelopeSha256', 'extractedManifestSha256'] as const) {
    literal(object[key], authority[key], `${path}.${key}`)
  }
  literal(object.catalogSequence, authority.catalogSequence, `${path}.catalogSequence`)
  literal(object.catalogIssuedAt, authority.catalogIssuedAt, `${path}.catalogIssuedAt`)
  literal(object.expiresAt, authority.expiresAt, `${path}.expiresAt`)
  if (isRc) literal(object.sourceSha, (authority as ReleaseAuthority & { sourceSha: string }).sourceSha, `${path}.sourceSha`)
  const issuedAt = timestampAt(object, 'catalogIssuedAt', path)
  const expiresAt = timestampAt(object, 'expiresAt', path)
  if (expiresAt <= issuedAt) fail(`${path}.expiresAt`)
  return { issuedAt, expiresAt }
}

function validateBatch(value: unknown, path: string): { startedAt: number; completedAt: number } {
  const object = objectAt(value, path)
  exactKeys(object, ['batchId', 'completedAt', 'paidTurnBudget', 'paidTurns', 'startedAt', 'status', 'stopOnFailure'], path)
  if (!SAFE_ID.test(stringAt(object, 'batchId', path))) fail(`${path}.batchId`)
  literal(object.paidTurnBudget, 40, `${path}.paidTurnBudget`)
  literal(object.paidTurns, 40, `${path}.paidTurns`)
  literal(object.stopOnFailure, true, `${path}.stopOnFailure`)
  literal(object.status, 'passed', `${path}.status`)
  const startedAt = timestampAt(object, 'startedAt', path)
  const completedAt = timestampAt(object, 'completedAt', path)
  if (completedAt <= startedAt) fail(`${path}.completedAt`)
  return { startedAt, completedAt }
}

function validateCaseAuthority(value: unknown, path: string): void {
  const object = objectAt(value, path)
  exactKeys(object, ['authorityVersion', 'caseManifestSha256', 'caseSeedChecksumsSha256', 'interactionVectorsSha256', 'rcSourceSha'], path)
  literal(object.authorityVersion, 2, `${path}.authorityVersion`)
  literal(object.caseManifestSha256, OPEN_DESIGN_M1_CASE_MANIFEST_V2_SHA256, `${path}.caseManifestSha256`)
  literal(object.caseSeedChecksumsSha256, OPEN_DESIGN_M1_CASE_SEED_CHECKSUMS_SHA256, `${path}.caseSeedChecksumsSha256`)
  literal(object.interactionVectorsSha256, OPEN_DESIGN_M1_INTERACTION_VECTORS_CANONICAL_SHA256, `${path}.interactionVectorsSha256`)
  literal(object.rcSourceSha, OPEN_DESIGN_RC_SOURCE_SHA, `${path}.rcSourceSha`)
}

interface FileEntry { readonly path: string; readonly sha256: string; readonly bytes: number }

function validateFileEntries(value: unknown, path: string): Map<string, FileEntry> {
  if (!Array.isArray(value) || value.length !== OPEN_DESIGN_M1_MACHINE_FILE_COUNT - 2) fail(path)
  const result = new Map<string, FileEntry>()
  for (let index = 0; index < value.length; index += 1) {
    const entryPath = `${path}[${index}]`
    const object = objectAt(value[index], entryPath)
    exactKeys(object, ['bytes', 'path', 'sha256'], entryPath)
    const objectPath = relativeObjectPath(object.path, `${entryPath}.path`)
    if (objectPath === 'machine-manifest.json' || objectPath === 'SHA256SUMS' || result.has(objectPath)) fail(`${entryPath}.path`)
    const sha256 = hashAt(object, 'sha256', entryPath)
    const bytes = integerAt(object, 'bytes', entryPath)
    if (bytes < 1 || bytes > fileLimit(objectPath)) fail(`${entryPath}.bytes`)
    result.set(objectPath, { path: objectPath, sha256, bytes })
  }
  const expected = expectedMachineEvidencePaths().filter((item) => item !== 'machine-manifest.json' && item !== 'SHA256SUMS')
  if ([...result.keys()].join('\n') !== expected.join('\n')) fail(path)
  return result
}

interface RecordIndex {
  readonly caseId: string
  readonly stack: OpenDesignM1Stack
  readonly record: FileRef
  readonly events: FileRef
  readonly workspace: FileRef
  readonly preview?: FileRef
}
interface FileRef { readonly path: string; readonly sha256: string }

function parseFileRef(value: unknown, expectedPath: string, path: string): FileRef {
  const object = objectAt(value, path)
  exactKeys(object, ['path', 'sha256'], path)
  literal(object.path, expectedPath, `${path}.path`)
  return { path: expectedPath, sha256: hashAt(object, 'sha256', path) }
}

function validateRecordIndex(value: unknown, path: string): RecordIndex[] {
  if (!Array.isArray(value) || value.length !== 40) fail(path)
  const expected = [
    ...OPEN_DESIGN_M1_CASES_V2.map((testCase) => ({ stack: 'old' as const, testCase })),
    ...OPEN_DESIGN_M1_CASES_V2.map((testCase) => ({ stack: 'new' as const, testCase })),
  ]
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`
    const object = objectAt(entry, entryPath)
    const { stack, testCase } = expected[index]!
    exactKeys(object, ['caseId', 'events', ...(stack === 'new' ? ['preview'] : []), 'record', 'stack', 'workspace'], entryPath)
    literal(object.stack, stack, `${entryPath}.stack`)
    literal(object.caseId, testCase.id, `${entryPath}.caseId`)
    return {
      stack,
      caseId: testCase.id,
      record: parseFileRef(object.record, `records/${stack}/${testCase.id}.json`, `${entryPath}.record`),
      events: parseFileRef(object.events, `events/${stack}/${testCase.id}.jsonl`, `${entryPath}.events`),
      workspace: parseFileRef(object.workspace, `workspace/${stack}/${testCase.id}.json`, `${entryPath}.workspace`),
      ...(stack === 'new' ? {
        preview: parseFileRef(object.preview, `previews/new/${testCase.id}.png`, `${entryPath}.preview`),
      } : {}),
    }
  })
}

function validateRequiredCiRef(value: unknown, path: string): FileRef {
  return parseFileRef(value, 'required-ci.json', path)
}

function validateFunctionalComparisons(
  value: unknown,
  outcomes: ReadonlyMap<string, string>,
  path: string,
): void {
  if (!Array.isArray(value) || value.length !== OPEN_DESIGN_M1_CASES_V2.length) fail(path)
  value.forEach((entry, index) => {
    const testCase = OPEN_DESIGN_M1_CASES_V2[index]!
    const entryPath = `${path}[${index}]`
    const object = objectAt(entry, entryPath)
    exactKeys(object, [
      'caseId', 'equivalent', 'newNormalizedOutcomeDigest', 'oldNormalizedOutcomeDigest', 'vectorSha256',
    ], entryPath)
    literal(object.caseId, testCase.id, `${entryPath}.caseId`)
    literal(object.vectorSha256, testCase.interactionVectorSha256, `${entryPath}.vectorSha256`)
    literal(object.equivalent, true, `${entryPath}.equivalent`)
    const oldDigest = hashAt(object, 'oldNormalizedOutcomeDigest', entryPath)
    const newDigest = hashAt(object, 'newNormalizedOutcomeDigest', entryPath)
    literal(oldDigest, outcomes.get(`old:${testCase.id}`), `${entryPath}.oldNormalizedOutcomeDigest`)
    literal(newDigest, outcomes.get(`new:${testCase.id}`), `${entryPath}.newNormalizedOutcomeDigest`)
    if (oldDigest !== newDigest) fail(entryPath, 'records a functional mismatch')
  })
}

function validateRollbackRef(value: unknown, path: string): Record<string, FileRef> {
  const object = objectAt(value, path)
  exactKeys(object, ['hiddenSessions', 'processes', 'transitions'], path)
  return {
    transitions: parseFileRef(object.transitions, 'rollback/transitions.json', `${path}.transitions`),
    processes: parseFileRef(object.processes, 'rollback/processes.json', `${path}.processes`),
    hiddenSessions: parseFileRef(object.hiddenSessions, 'rollback/hidden-sessions.json', `${path}.hiddenSessions`),
  }
}

function validateRequiredCi(value: unknown, authority: MachineEvidenceAuthority, path: string): void {
  const object = objectAt(value, path)
  exactKeys(object, ['headSha', 'passed', 'runs', 'schemaVersion'], path)
  literal(object.schemaVersion, 1, `${path}.schemaVersion`)
  literal(object.headSha, authority.hostHeadSha, `${path}.headSha`)
  literal(object.passed, true, `${path}.passed`)
  if (!Array.isArray(object.runs) || object.runs.length !== OPEN_DESIGN_REQUIRED_CI_WORKFLOW_PATHS.length) fail(`${path}.runs`)
  const ids = new Set<number>()
  object.runs.forEach((value, index) => {
    const runPath = `${path}.runs[${index}]`
    const run = objectAt(value, runPath)
    exactKeys(run, ['conclusion', 'headSha', 'runId', 'runAttempt', 'workflowPath'], runPath)
    literal(run.workflowPath, OPEN_DESIGN_REQUIRED_CI_WORKFLOW_PATHS[index], `${runPath}.workflowPath`)
    literal(run.headSha, authority.hostHeadSha, `${runPath}.headSha`)
    literal(run.conclusion, 'success', `${runPath}.conclusion`)
    const runId = integerAt(run, 'runId', runPath)
    const runAttempt = integerAt(run, 'runAttempt', runPath)
    if (runId < 1 || runAttempt < 1 || ids.has(runId)) fail(runPath)
    ids.add(runId)
  })
}

interface LedgerEvent {
  readonly at: number
  readonly business: boolean
  readonly payloadSha256: string
  readonly sequence: number
  readonly source: 'daemon' | 'host-health' | 'harness'
  readonly type: string
}

function parseEventLedger(source: string, path: string): LedgerEvent[] {
  if (!source.endsWith('\n') || source.length === 0) fail(path)
  const lines = source.slice(0, -1).split('\n')
  if (lines.length < 2) fail(path)
  const events = lines.map((line, index) => {
    let value: unknown
    try { value = JSON.parse(line) } catch { return fail(`${path}:${index + 1}`) }
    if (line !== JSON.stringify(value)) fail(`${path}:${index + 1}`, 'is not canonical JSONL')
    const object = objectAt(value, `${path}:${index + 1}`)
    exactKeys(object, ['at', 'business', 'payloadSha256', 'sequence', 'source', 'type'], `${path}:${index + 1}`)
    const at = timestampAt(object, 'at', `${path}:${index + 1}`)
    const sequence = integerAt(object, 'sequence', `${path}:${index + 1}`)
    literal(sequence, index + 1, `${path}:${index + 1}.sequence`)
    const sourceName = stringAt(object, 'source', `${path}:${index + 1}`)
    if (!['daemon', 'host-health', 'harness'].includes(sourceName)) fail(`${path}:${index + 1}.source`)
    const type = stringAt(object, 'type', `${path}:${index + 1}`)
    if (!SAFE_ID.test(type)) fail(`${path}:${index + 1}.type`)
    return {
      at,
      business: booleanAt(object, 'business', `${path}:${index + 1}`),
      payloadSha256: hashAt(object, 'payloadSha256', `${path}:${index + 1}`),
      sequence,
      source: sourceName as LedgerEvent['source'],
      type,
    }
  })
  if (events.some((event, index) => index > 0 && event.at < events[index - 1]!.at)) {
    fail(path, 'timestamps are not monotonic')
  }
  return events
}

function validateWorkspaceManifest(value: unknown, stack: OpenDesignM1Stack, testCase: OpenDesignM1Case, path: string): void {
  const object = objectAt(value, path)
  exactKeys(object, ['caseId', 'files', 'rootDigest', 'schemaVersion', 'stack'], path)
  literal(object.schemaVersion, 1, `${path}.schemaVersion`)
  literal(object.stack, stack, `${path}.stack`)
  literal(object.caseId, testCase.id, `${path}.caseId`)
  if (!Array.isArray(object.files) || object.files.length < testCase.requiredFiles.length) fail(`${path}.files`)
  const files = object.files.map((value, index) => {
    const filePath = `${path}.files[${index}]`
    const file = objectAt(value, filePath)
    exactKeys(file, ['bytes', 'path', 'sha256'], filePath)
    const relativePath = relativeObjectPath(file.path, `${filePath}.path`)
    const bytes = integerAt(file, 'bytes', filePath)
    if (bytes < 1 || bytes > 4 * 1024 * 1024) fail(`${filePath}.bytes`)
    return { path: relativePath, sha256: hashAt(file, 'sha256', filePath), bytes }
  })
  if (files.some((item, index) => index > 0 && files[index - 1]!.path >= item.path)) fail(`${path}.files`)
  for (const required of testCase.requiredFiles) {
    if (!files.some((item) => item.path === required)) fail(`${path}.files`, `omits ${required}`)
  }
  const expectedRootDigest = digest(files.map((item) => `${item.sha256}  ${item.bytes}  ${item.path}\n`).join(''))
  literal(object.rootDigest, expectedRootDigest, `${path}.rootDigest`)
}

function validateRecord(
  value: unknown,
  stack: OpenDesignM1Stack,
  testCase: OpenDesignM1CaseV2,
  expectedHash: (typeof OPEN_DESIGN_M1_CASE_V2_HASHES)[number],
  release: ReleaseAuthority,
  batch: { startedAt: number; completedAt: number },
  previousCompletedAt: number,
  ledger: LedgerEvent[],
  workspacePath: string,
  workspaceSha256: string,
  path: string,
): { completedAt: number; normalizedOutcomeDigest: string } {
  const object = objectAt(value, path)
  exactKeys(object, [
    'attemptOrdinal', 'blackout', 'caseId', 'cleanup', 'completedAt', 'craft',
    'interaction', 'moduleArchiveSha256', 'preview', 'promptSha256', 'seedArchiveSha256', 'stack',
    'startedAt', 'terminal', 'turnCount', 'workspaceManifestPath', 'workspaceManifestSha256',
  ], path)
  literal(object.stack, stack, `${path}.stack`)
  literal(object.caseId, testCase.id, `${path}.caseId`)
  literal(object.attemptOrdinal, 1, `${path}.attemptOrdinal`)
  literal(object.turnCount, 1, `${path}.turnCount`)
  literal(object.promptSha256, expectedHash.promptSha256, `${path}.promptSha256`)
  literal(object.seedArchiveSha256, expectedHash.seedArchiveSha256, `${path}.seedArchiveSha256`)
  literal(object.moduleArchiveSha256, release.archiveSha256, `${path}.moduleArchiveSha256`)
  literal(object.workspaceManifestPath, workspacePath, `${path}.workspaceManifestPath`)
  literal(object.workspaceManifestSha256, workspaceSha256, `${path}.workspaceManifestSha256`)
  const interactionVector = OPEN_DESIGN_M1_INTERACTION_VECTORS.find((candidate) => candidate.caseId === testCase.id)
  if (!interactionVector || testCase.interactionVectorSha256 !== expectedHash.interactionVectorSha256) {
    fail(`${path}.interaction`, 'does not match fixed-cases/v2 authority')
  }
  const interaction = validateOpenDesignM1InteractionEvidence(interactionVector, object.interaction)
  const startedAt = timestampAt(object, 'startedAt', path)
  const completedAt = timestampAt(object, 'completedAt', path)
  if (startedAt < batch.startedAt || startedAt < previousCompletedAt || completedAt <= startedAt
    || completedAt > batch.completedAt || startedAt < Date.parse(release.catalogIssuedAt)
    || completedAt > Date.parse(release.expiresAt)) fail(`${path}.completedAt`)

  const terminal = objectAt(object.terminal, `${path}.terminal`)
  exactKeys(terminal, ['status', 'terminalEventCount'], `${path}.terminal`)
  literal(terminal.status, 'completed', `${path}.terminal.status`)
  literal(terminal.terminalEventCount, 1, `${path}.terminal.terminalEventCount`)
  if (ledger.filter((event) => event.type === 'turn.completed').length !== 1
    || ledger.some((event) => event.type === 'turn.failed' || event.type === 'turn.interrupted')
    || (stack === 'new' && ledger.filter((event) => event.type === 'run.closed').length !== 1)) {
    fail(`${path}.terminal`)
  }

  const preview = objectAt(object.preview, `${path}.preview`)
  exactKeys(preview, ['httpStatus', 'requiredContentVerified', 'requiredFilesVerified', 'route'], `${path}.preview`)
  literal(preview.httpStatus, 200, `${path}.preview.httpStatus`)
  literal(preview.route, '/', `${path}.preview.route`)
  literal(preview.requiredFilesVerified, true, `${path}.preview.requiredFilesVerified`)
  literal(preview.requiredContentVerified, true, `${path}.preview.requiredContentVerified`)

  const craft = objectAt(object.craft, `${path}.craft`)
  exactKeys(craft, ['mainPidSurvived', 'stateSplitCount', 'usableAfterTurn'], `${path}.craft`)
  literal(craft.mainPidSurvived, true, `${path}.craft.mainPidSurvived`)
  literal(craft.usableAfterTurn, true, `${path}.craft.usableAfterTurn`)
  literal(craft.stateSplitCount, 0, `${path}.craft.stateSplitCount`)

  const cleanup = objectAt(object.cleanup, `${path}.cleanup`)
  exactKeys(cleanup, [
    'activeRuns', 'hiddenSessions', 'moduleSessions', 'processTreeReapedWithinSeconds',
    'quarantinedSessions', 'residualProcesses', 'runStateSettledWithinSeconds', 'transientSessions',
  ], `${path}.cleanup`)
  for (const key of [
    'activeRuns', 'hiddenSessions', 'moduleSessions', 'quarantinedSessions', 'residualProcesses', 'transientSessions',
  ] as const) {
    literal(cleanup[key], 0, `${path}.cleanup.${key}`)
  }
  const settled = integerAt(cleanup, 'runStateSettledWithinSeconds', `${path}.cleanup`)
  const reaped = integerAt(cleanup, 'processTreeReapedWithinSeconds', `${path}.cleanup`)
  if (settled < 0 || settled > 5 || reaped < 0 || reaped > 10) fail(`${path}.cleanup`)

  const blackout = objectAt(object.blackout, `${path}.blackout`)
  exactKeys(blackout, [
    'bufferedEventCount', 'endedAt', 'eventSequenceAfter', 'eventSequenceBefore', 'eventsLost', 'heartbeatCount',
    'heartbeatMaxGapMs', 'replayedEventCount', 'replayComplete', 'replaySequenceStart', 'required', 'startedAt',
  ], `${path}.blackout`)
  literal(blackout.required, stack === 'new', `${path}.blackout.required`)
  if (stack === 'old') {
    for (const key of [
      'bufferedEventCount', 'endedAt', 'eventSequenceAfter', 'eventSequenceBefore', 'heartbeatCount',
      'heartbeatMaxGapMs', 'replayedEventCount', 'replaySequenceStart', 'startedAt',
    ] as const) {
      literal(blackout[key], null, `${path}.blackout.${key}`)
    }
    literal(blackout.eventsLost, 0, `${path}.blackout.eventsLost`)
    literal(blackout.replayComplete, true, `${path}.blackout.replayComplete`)
    return { completedAt, normalizedOutcomeDigest: interaction.normalizedOutcomeDigest }
  }

  const blackoutStartedAt = timestampAt(blackout, 'startedAt', `${path}.blackout`)
  const blackoutEndedAt = timestampAt(blackout, 'endedAt', `${path}.blackout`)
  if (blackoutStartedAt < startedAt || blackoutEndedAt > completedAt || blackoutEndedAt - blackoutStartedAt < 65_000) {
    fail(`${path}.blackout`)
  }
  const before = integerAt(blackout, 'eventSequenceBefore', `${path}.blackout`)
  const after = integerAt(blackout, 'eventSequenceAfter', `${path}.blackout`)
  const bufferedEventCount = integerAt(blackout, 'bufferedEventCount', `${path}.blackout`)
  const replayedEventCount = integerAt(blackout, 'replayedEventCount', `${path}.blackout`)
  const replaySequenceStart = integerAt(blackout, 'replaySequenceStart', `${path}.blackout`)
  if (before < 1 || after <= before || after > ledger.length) fail(`${path}.blackout.eventSequenceAfter`)
  if (bufferedEventCount < 1 || replayedEventCount !== bufferedEventCount
    || replaySequenceStart !== after + 1 || replaySequenceStart + replayedEventCount - 1 > ledger.length) {
    fail(`${path}.blackout.replayedEventCount`)
  }
  const startBoundary = ledger[before - 1]
  const endBoundary = ledger[after - 1]
  if (startBoundary?.type !== 'blackout.started' || startBoundary.source !== 'harness'
    || startBoundary.business || startBoundary.at !== blackoutStartedAt
    || endBoundary?.type !== 'blackout.ended' || endBoundary.source !== 'harness'
    || endBoundary.business || endBoundary.at !== blackoutEndedAt) {
    fail(`${path}.blackout.eventSequenceAfter`, 'does not identify exact blackout boundaries')
  }
  literal(blackout.eventsLost, 0, `${path}.blackout.eventsLost`)
  literal(blackout.replayComplete, true, `${path}.blackout.replayComplete`)
  const intervalEvents = ledger.filter((event) => event.at >= blackoutStartedAt && event.at <= blackoutEndedAt)
  if (intervalEvents.some((event) => event.business)) fail(`${path}.blackout`, 'contains a business event')
  const heartbeatEvents = intervalEvents.filter((event) => event.type === 'heartbeat' && event.source === 'host-health')
  const replayedEvents = ledger.slice(replaySequenceStart - 1, replaySequenceStart - 1 + replayedEventCount)
  if (replayedEvents.length !== replayedEventCount
    || replayedEvents.some((event) => event.source !== 'daemon' || !event.business || event.at <= blackoutEndedAt)) {
    fail(`${path}.blackout.replaySequenceStart`)
  }
  const heartbeatCount = integerAt(blackout, 'heartbeatCount', `${path}.blackout`)
  const heartbeatMaxGapMs = integerAt(blackout, 'heartbeatMaxGapMs', `${path}.blackout`)
  if (heartbeatCount !== heartbeatEvents.length || heartbeatCount < 6) fail(`${path}.blackout.heartbeatCount`)
  let actualMaxGap = 0
  for (let index = 1; index < heartbeatEvents.length; index += 1) {
    actualMaxGap = Math.max(actualMaxGap, heartbeatEvents[index]!.at - heartbeatEvents[index - 1]!.at)
  }
  if (heartbeatMaxGapMs !== actualMaxGap || heartbeatMaxGapMs > 12_000) fail(`${path}.blackout.heartbeatMaxGapMs`)
  return { completedAt, normalizedOutcomeDigest: interaction.normalizedOutcomeDigest }
}

function validateRollback(value: unknown, kind: 'transitions' | 'processes' | 'hidden-sessions', path: string): void {
  const object = objectAt(value, path)
  if (kind === 'transitions') {
    exactKeys(object, ['craftConnectionPreserved', 'craftSurvivedAllTransitions', 'passed', 'restartAndReopenPassed', 'schemaVersion', 'transitions'], path)
    literal(object.schemaVersion, 1, `${path}.schemaVersion`)
    literal(object.passed, true, `${path}.passed`)
    literal(object.craftConnectionPreserved, true, `${path}.craftConnectionPreserved`)
    literal(object.craftSurvivedAllTransitions, true, `${path}.craftSurvivedAllTransitions`)
    literal(object.restartAndReopenPassed, true, `${path}.restartAndReopenPassed`)
    const transitions = [OPEN_DESIGN_LKG_VERSION, OPEN_DESIGN_RC_VERSION, OPEN_DESIGN_LKG_VERSION, OPEN_DESIGN_RC_VERSION]
    if (!Array.isArray(object.transitions) || JSON.stringify(object.transitions) !== JSON.stringify(transitions)) fail(`${path}.transitions`)
    return
  }
  exactKeys(object, ['count', 'observedAt', 'passed', 'schemaVersion'], path)
  literal(object.schemaVersion, 1, `${path}.schemaVersion`)
  literal(object.passed, true, `${path}.passed`)
  literal(object.count, 0, `${path}.count`)
  timestampAt(object, 'observedAt', path)
}

async function validateTrust(root: string, expectedSha256: string, path: string): Promise<void> {
  const bytes = await readBounded(root, path)
  if (digest(bytes) !== expectedSha256) fail(path, 'does not match release authority')
  const source = bytes.toString('utf8')
  let value: unknown
  try { value = JSON.parse(source) } catch { return fail(path, 'is not JSON') }
  if (source !== JSON.stringify(value)) fail(path, 'is not exact canonical release JSON')
  objectAt(value, path)
}

async function verifySha256Sums(root: string, expectedPaths: readonly string[]): Promise<Map<string, string>> {
  const source = (await readBounded(root, 'SHA256SUMS')).toString('utf8')
  if (!source.endsWith('\n')) fail('SHA256SUMS')
  const lines = source.slice(0, -1).split('\n')
  const expected = expectedPaths.filter((path) => path !== 'SHA256SUMS')
  if (lines.length !== expected.length) fail('SHA256SUMS')
  const result = new Map<string, string>()
  lines.forEach((line, index) => {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(line)
    if (!match || match[2] !== expected[index] || result.has(match[2])) fail(`SHA256SUMS:${index + 1}`)
    result.set(match[2], match[1])
  })
  for (const path of expected) {
    const bytes = await readBounded(root, path)
    if (digest(bytes) !== result.get(path)) fail(path, 'does not match SHA256SUMS')
  }
  return result
}

export async function validateOpenDesignM1MachineEvidence(
  rootInput: string,
  authority: MachineEvidenceAuthority,
): Promise<MachineEvidenceValidationResult> {
  if (!COMMIT_SHA.test(authority.hostHeadSha) || !SHA256.test(authority.hostArtifactSha256)
    || authority.producerRunId < 1 || authority.producerRunAttempt !== 1
    || authority.hostBuildRunId < 1 || authority.rc.sourceSha !== OPEN_DESIGN_RC_SOURCE_SHA) fail('authority')
  const root = resolve(rootInput)
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail('artifact root')
  const expectedPaths = expectedMachineEvidencePaths()
  const actualPaths = await inventoryRegularFiles(root)
  if (actualPaths.join('\n') !== expectedPaths.join('\n')) fail('artifact inventory')
  let totalBytes = 0
  for (const path of actualPaths) totalBytes += (await lstat(join(root, path))).size
  if (totalBytes > OPEN_DESIGN_M1_MACHINE_MAX_BYTES) fail('artifact size')
  const sums = await verifySha256Sums(root, expectedPaths)
  const manifest = objectAt(await readCanonicalJson(root, 'machine-manifest.json'), '$')
  exactKeys(manifest, [
    'batch', 'batchDigest', 'caseAuthority', 'files', 'functionalComparisons', 'host', 'kind', 'lkg', 'producer',
    'rc', 'records', 'repository', 'requiredCi', 'rollback', 'schemaVersion', 'workflowPath',
  ], '$')
  literal(manifest.schemaVersion, 2, '$.schemaVersion')
  literal(manifest.kind, 'open-design-m1-machine-evidence', '$.kind')
  literal(manifest.repository, OPEN_DESIGN_ACCEPTANCE_REPOSITORY, '$.repository')
  literal(manifest.workflowPath, OPEN_DESIGN_M1_MACHINE_WORKFLOW_PATH, '$.workflowPath')
  validateProducer(manifest.producer, authority, '$.producer')
  validateHost(manifest.host, authority, '$.host')
  validateCaseAuthority(manifest.caseAuthority, '$.caseAuthority')
  const lkgWindow = validateRelease(manifest.lkg, authority.lkg, 'old', '$.lkg')
  const rcWindow = validateRelease(manifest.rc, authority.rc, 'new', '$.rc')
  if (authority.rc.catalogSequence <= authority.lkg.catalogSequence || rcWindow.issuedAt <= lkgWindow.issuedAt) fail('$.rc')
  const batch = validateBatch(manifest.batch, '$.batch')
  if (batch.startedAt < rcWindow.issuedAt || batch.completedAt > rcWindow.expiresAt) fail('$.batch')
  const fileEntries = validateFileEntries(manifest.files, '$.files')
  for (const [path, entry] of fileEntries) {
    const bytes = await readBounded(root, path)
    if (entry.sha256 !== digest(bytes) || entry.bytes !== bytes.byteLength || entry.sha256 !== sums.get(path)) fail(`$.files:${path}`)
  }
  const requiredCiRef = validateRequiredCiRef(manifest.requiredCi, '$.requiredCi')
  const rollbackRefs = validateRollbackRef(manifest.rollback, '$.rollback')
  const recordIndex = validateRecordIndex(manifest.records, '$.records')
  for (const ref of [requiredCiRef, ...Object.values(rollbackRefs), ...recordIndex.flatMap((entry) => [
    entry.record, entry.events, entry.workspace, ...(entry.preview ? [entry.preview] : []),
  ])]) {
    if (ref.sha256 !== sums.get(ref.path)) fail(ref.path, 'reference hash mismatch')
  }
  validateRequiredCi(await readCanonicalJson(root, requiredCiRef.path), authority, requiredCiRef.path)
  validateRollback(await readCanonicalJson(root, rollbackRefs.transitions.path), 'transitions', rollbackRefs.transitions.path)
  validateRollback(await readCanonicalJson(root, rollbackRefs.processes.path), 'processes', rollbackRefs.processes.path)
  validateRollback(await readCanonicalJson(root, rollbackRefs.hiddenSessions.path), 'hidden-sessions', rollbackRefs.hiddenSessions.path)
  await validateTrust(root, authority.lkg.catalogSha256, 'trust/lkg-catalog.json')
  await validateTrust(root, authority.lkg.envelopeSha256, 'trust/lkg-envelope.json')
  await validateTrust(root, authority.rc.catalogSha256, 'trust/rc-catalog.json')
  await validateTrust(root, authority.rc.envelopeSha256, 'trust/rc-envelope.json')

  let previousCompletedAt = batch.startedAt
  const functionalOutcomes = new Map<string, string>()
  for (const entry of recordIndex) {
    const testCase = OPEN_DESIGN_M1_CASES_V2.find((candidate) => candidate.id === entry.caseId)!
    const expectedHash = OPEN_DESIGN_M1_CASE_V2_HASHES.find((candidate) => candidate.id === entry.caseId)!
    const ledger = parseEventLedger((await readBounded(root, entry.events.path)).toString('utf8'), entry.events.path)
    const workspace = await readCanonicalJson(root, entry.workspace.path)
    validateWorkspaceManifest(workspace, entry.stack, testCase, entry.workspace.path)
    const recordResult = validateRecord(
      await readCanonicalJson(root, entry.record.path),
      entry.stack,
      testCase,
      expectedHash,
      entry.stack === 'old' ? authority.lkg : authority.rc,
      batch,
      previousCompletedAt,
      ledger,
      entry.workspace.path,
      entry.workspace.sha256,
      entry.record.path,
    )
    previousCompletedAt = recordResult.completedAt
    functionalOutcomes.set(`${entry.stack}:${entry.caseId}`, recordResult.normalizedOutcomeDigest)
    if (entry.preview) {
      const png = await readBounded(root, entry.preview.path)
      if (png.byteLength < PNG_SIGNATURE.byteLength || !png.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
        fail(entry.preview.path, 'is not a PNG')
      }
    }
  }
  validateFunctionalComparisons(manifest.functionalComparisons, functionalOutcomes, '$.functionalComparisons')
  const batchDigest = digest(recordIndex.map((entry) => [
    entry.stack, entry.caseId, entry.record.sha256, entry.events.sha256, entry.workspace.sha256,
    entry.preview?.sha256 ?? '-',
  ].join(':')).join('\n') + '\n')
  literal(manifest.batchDigest, batchDigest, '$.batchDigest')
  const manifestSha256 = sums.get('machine-manifest.json')!
  return {
    artifactName: OPEN_DESIGN_M1_MACHINE_ARTIFACT_NAME,
    objectPath: 'machine-manifest.json',
    sha256: manifestSha256,
    fileCount: OPEN_DESIGN_M1_MACHINE_FILE_COUNT,
    totalBytes,
    batchDigest,
  }
}

async function writeCanonical(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, canonicalJson(value), { mode: 0o600, flag: 'wx' })
}

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

/** Test-only fixture builder. Production workflow never invokes or imports it. */
export async function createDeterministicMachineEvidenceFixture(
  rootInput: string,
  authority: MachineEvidenceAuthority,
): Promise<void> {
  const root = resolve(rootInput)
  await mkdir(root, { recursive: false, mode: 0o700 })
  const batchStart = Math.max(Date.parse(authority.rc.catalogIssuedAt) + 1_000, Date.parse('2026-07-17T01:00:00.000Z'))
  let cursor = batchStart
  const records: JsonObject[] = []
  for (const stack of ['old', 'new'] as const) {
    for (const testCase of OPEN_DESIGN_M1_CASES_V2) {
      const caseHash = OPEN_DESIGN_M1_CASE_V2_HASHES.find((item) => item.id === testCase.id)!
      const interactionVector = OPEN_DESIGN_M1_INTERACTION_VECTORS.find((item) => item.caseId === testCase.id)!
      const startedAt = cursor
      const ledger: JsonObject[] = []
      const appendEvent = (at: number, source: LedgerEvent['source'], type: string, business: boolean): void => {
        ledger.push({
          at: new Date(at).toISOString(), business, payloadSha256: digest(`${stack}:${testCase.id}:${type}:${at}`),
          sequence: ledger.length + 1, source, type,
        })
      }
      appendEvent(startedAt, 'daemon', 'turn.started', true)
      let blackout: JsonObject
      if (stack === 'new') {
        const blackoutStart = startedAt + 1_000
        appendEvent(blackoutStart, 'harness', 'blackout.started', false)
        for (let offset = 5_000; offset <= 65_000; offset += 10_000) appendEvent(blackoutStart + offset, 'host-health', 'heartbeat', false)
        const blackoutEnd = blackoutStart + 65_000
        appendEvent(blackoutEnd, 'harness', 'blackout.ended', false)
        const eventSequenceAfter = ledger.length
        const replaySequenceStart = ledger.length + 1
        appendEvent(blackoutEnd + 1, 'daemon', 'activity', true)
        blackout = {
          endedAt: new Date(blackoutEnd).toISOString(), eventSequenceAfter,
          eventSequenceBefore: 2, eventsLost: 0, heartbeatCount: 7, heartbeatMaxGapMs: 10_000,
          bufferedEventCount: 1, replayedEventCount: 1, replayComplete: true, replaySequenceStart,
          required: true, startedAt: new Date(blackoutStart).toISOString(),
        }
        cursor = blackoutEnd + 2_000
      } else {
        blackout = {
          bufferedEventCount: null, endedAt: null, eventSequenceAfter: null, eventSequenceBefore: null, eventsLost: 0,
          heartbeatCount: null, heartbeatMaxGapMs: null, replayedEventCount: null, replayComplete: true,
          replaySequenceStart: null, required: false, startedAt: null,
        }
        cursor += 2_000
      }
      appendEvent(cursor - 1_000, 'daemon', 'message.delta', true)
      appendEvent(cursor, 'daemon', 'turn.completed', true)
      if (stack === 'new') {
        cursor += 1
        appendEvent(cursor, 'daemon', 'run.closed', true)
      }
      const eventsPath = `events/${stack}/${testCase.id}.jsonl`
      await mkdir(dirname(join(root, eventsPath)), { recursive: true, mode: 0o700 })
      await writeFile(join(root, eventsPath), ledger.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 })

      const files = testCase.requiredFiles.map((path, index) => ({
        path,
        bytes: 32 + index,
        sha256: digest(`${stack}:${testCase.id}:${path}`),
      })).sort((left, right) => left.path.localeCompare(right.path))
      const workspace = {
        schemaVersion: 1, stack, caseId: testCase.id, files,
        rootDigest: digest(files.map((item) => `${item.sha256}  ${item.bytes}  ${item.path}\n`).join('')),
      }
      const workspacePath = `workspace/${stack}/${testCase.id}.json`
      await writeCanonical(join(root, workspacePath), workspace)
      const record = {
        attemptOrdinal: 1,
        blackout,
        caseId: testCase.id,
        cleanup: {
          activeRuns: 0, hiddenSessions: 0, moduleSessions: 0, processTreeReapedWithinSeconds: 1,
          quarantinedSessions: 0, residualProcesses: 0, runStateSettledWithinSeconds: 1, transientSessions: 0,
        },
        completedAt: new Date(cursor).toISOString(),
        craft: { mainPidSurvived: true, stateSplitCount: 0, usableAfterTurn: true },
        interaction: createDeterministicOpenDesignM1InteractionEvidenceFixture(interactionVector),
        moduleArchiveSha256: (stack === 'old' ? authority.lkg : authority.rc).archiveSha256,
        preview: { httpStatus: 200, requiredContentVerified: true, requiredFilesVerified: true, route: '/' },
        promptSha256: caseHash.promptSha256,
        seedArchiveSha256: caseHash.seedArchiveSha256,
        stack,
        startedAt: new Date(startedAt).toISOString(),
        terminal: { status: 'completed', terminalEventCount: 1 },
        turnCount: 1,
        workspaceManifestPath: workspacePath,
        workspaceManifestSha256: '',
      }
      const workspaceBytes = await readFile(join(root, workspacePath))
      record.workspaceManifestSha256 = digest(workspaceBytes)
      const recordPath = `records/${stack}/${testCase.id}.json`
      await writeCanonical(join(root, recordPath), record)
      if (stack === 'new') {
        const previewPath = `previews/new/${testCase.id}.png`
        await mkdir(dirname(join(root, previewPath)), { recursive: true, mode: 0o700 })
        await writeFile(join(root, previewPath), ONE_PIXEL_PNG, { mode: 0o600 })
      }
      cursor += 1_000
    }
  }

  await writeCanonical(join(root, 'required-ci.json'), {
    schemaVersion: 1,
    headSha: authority.hostHeadSha,
    passed: true,
    runs: OPEN_DESIGN_REQUIRED_CI_WORKFLOW_PATHS.map((workflowPath, index) => ({
      workflowPath, runId: 1000 + index, runAttempt: 1, headSha: authority.hostHeadSha, conclusion: 'success',
    })),
  })
  await writeCanonical(join(root, 'rollback/transitions.json'), {
    schemaVersion: 1, passed: true, craftConnectionPreserved: true, craftSurvivedAllTransitions: true,
    restartAndReopenPassed: true,
    transitions: [OPEN_DESIGN_LKG_VERSION, OPEN_DESIGN_RC_VERSION, OPEN_DESIGN_LKG_VERSION, OPEN_DESIGN_RC_VERSION],
  })
  for (const name of ['processes', 'hidden-sessions']) {
    await writeCanonical(join(root, `rollback/${name}.json`), {
      schemaVersion: 1, passed: true, count: 0, observedAt: new Date(cursor).toISOString(),
    })
  }
  const trustObjects = {
    'trust/lkg-catalog.json': { fixture: 'lkg-catalog' },
    'trust/lkg-envelope.json': { fixture: 'lkg-envelope' },
    'trust/rc-catalog.json': { fixture: 'rc-catalog' },
    'trust/rc-envelope.json': { fixture: 'rc-envelope' },
  }
  for (const [path, value] of Object.entries(trustObjects)) {
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 })
    await writeFile(join(root, path), JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  }

  const payloadPaths = expectedMachineEvidencePaths().filter((path) => path !== 'machine-manifest.json' && path !== 'SHA256SUMS')
  const fileEntries: FileEntry[] = []
  for (const path of payloadPaths) {
    const bytes = await readFile(join(root, path))
    fileEntries.push({ path, sha256: digest(bytes), bytes: bytes.byteLength })
  }
  const index = [...records]
  for (const stack of ['old', 'new'] as const) {
    for (const testCase of OPEN_DESIGN_M1_CASES_V2) {
      const lookup = (path: string): FileRef => ({ path, sha256: fileEntries.find((entry) => entry.path === path)!.sha256 })
      index.push({
        stack,
        caseId: testCase.id,
        record: lookup(`records/${stack}/${testCase.id}.json`),
        events: lookup(`events/${stack}/${testCase.id}.jsonl`),
        workspace: lookup(`workspace/${stack}/${testCase.id}.json`),
        ...(stack === 'new' ? { preview: lookup(`previews/new/${testCase.id}.png`) } : {}),
      })
    }
  }
  const batchDigest = digest(index.map((entry) => {
    const typed = entry as JsonObject
    return [typed.stack, typed.caseId, (typed.record as FileRef).sha256, (typed.events as FileRef).sha256,
      (typed.workspace as FileRef).sha256, (typed.preview as FileRef | undefined)?.sha256 ?? '-'].join(':')
  }).join('\n') + '\n')
  const ref = (path: string): FileRef => ({ path, sha256: fileEntries.find((entry) => entry.path === path)!.sha256 })
  const release = (stack: OpenDesignM1Stack): JsonObject => {
    const authorityRelease = stack === 'old' ? authority.lkg : authority.rc
    return {
      archiveAsset: stack === 'old' ? OPEN_DESIGN_LKG_ARCHIVE_ASSET : OPEN_DESIGN_RC_ARCHIVE_ASSET,
      archiveSha256: authorityRelease.archiveSha256,
      catalogIssuedAt: authorityRelease.catalogIssuedAt,
      catalogSequence: authorityRelease.catalogSequence,
      catalogSha256: authorityRelease.catalogSha256,
      envelopeSha256: authorityRelease.envelopeSha256,
      expiresAt: authorityRelease.expiresAt,
      extractedManifestSha256: authorityRelease.extractedManifestSha256,
      ...(stack === 'new' ? { sourceSha: OPEN_DESIGN_RC_SOURCE_SHA } : {}),
      tag: stack === 'old' ? OPEN_DESIGN_LKG_TAG : OPEN_DESIGN_RC_TAG,
      version: stack === 'old' ? OPEN_DESIGN_LKG_VERSION : OPEN_DESIGN_RC_VERSION,
    }
  }
  const functionalComparisons = OPEN_DESIGN_M1_CASES_V2.map((testCase) => {
    const vector = OPEN_DESIGN_M1_INTERACTION_VECTORS.find((item) => item.caseId === testCase.id)!
    const outcome = createDeterministicOpenDesignM1InteractionEvidenceFixture(vector).normalizedOutcomeDigest
    return {
      caseId: testCase.id,
      vectorSha256: testCase.interactionVectorSha256,
      oldNormalizedOutcomeDigest: outcome,
      newNormalizedOutcomeDigest: outcome,
      equivalent: true,
    }
  })
  await writeCanonical(join(root, 'machine-manifest.json'), {
    schemaVersion: 2,
    kind: 'open-design-m1-machine-evidence',
    repository: OPEN_DESIGN_ACCEPTANCE_REPOSITORY,
    workflowPath: OPEN_DESIGN_M1_MACHINE_WORKFLOW_PATH,
    producer: { headSha: authority.hostHeadSha, runAttempt: 1, runId: authority.producerRunId },
    host: {
      artifactName: OPEN_DESIGN_HOST_ARTIFACT_NAME, artifactSha256: authority.hostArtifactSha256,
      buildRunId: authority.hostBuildRunId, version: OPEN_DESIGN_HOST_VERSION,
    },
    lkg: release('old'),
    rc: release('new'),
    caseAuthority: {
      authorityVersion: 2,
      caseManifestSha256: OPEN_DESIGN_M1_CASE_MANIFEST_V2_SHA256,
      caseSeedChecksumsSha256: OPEN_DESIGN_M1_CASE_SEED_CHECKSUMS_SHA256,
      interactionVectorsSha256: OPEN_DESIGN_M1_INTERACTION_VECTORS_CANONICAL_SHA256,
      rcSourceSha: OPEN_DESIGN_RC_SOURCE_SHA,
    },
    batch: {
      batchId: `fixture-${authority.producerRunId}`, startedAt: new Date(batchStart).toISOString(),
      completedAt: new Date(cursor).toISOString(), paidTurnBudget: 40, paidTurns: 40,
      status: 'passed', stopOnFailure: true,
    },
    requiredCi: ref('required-ci.json'),
    rollback: {
      transitions: ref('rollback/transitions.json'),
      processes: ref('rollback/processes.json'),
      hiddenSessions: ref('rollback/hidden-sessions.json'),
    },
    records: index,
    functionalComparisons,
    files: fileEntries,
    batchDigest,
  })
  const sumsPaths = expectedMachineEvidencePaths().filter((path) => path !== 'SHA256SUMS')
  const lines: string[] = []
  for (const path of sumsPaths) lines.push(`${digest(await readFile(join(root, path)))}  ${path}`)
  await writeFile(join(root, 'SHA256SUMS'), `${lines.join('\n')}\n`, { mode: 0o600 })
  await chmod(root, 0o700)
}

export const machineEvidenceTestOnly = Object.freeze({
  async replaceCanonicalJson(root: string, path: string, mutate: (value: JsonObject) => void): Promise<void> {
    const absolute = join(root, path)
    const value = objectAt(JSON.parse(await readFile(absolute, 'utf8')), path)
    mutate(value)
    await writeFile(absolute, canonicalJson(value), { mode: 0o600 })
  },
  async refreshSums(root: string): Promise<void> {
    const paths = expectedMachineEvidencePaths().filter((path) => path !== 'SHA256SUMS')
    const lines: string[] = []
    for (const path of paths) lines.push(`${digest(await readFile(join(root, path)))}  ${path}`)
    await writeFile(join(root, 'SHA256SUMS'), `${lines.join('\n')}\n`, { mode: 0o600 })
  },
  async reseal(root: string): Promise<void> {
    const manifestPath = join(root, 'machine-manifest.json')
    const manifest = objectAt(JSON.parse(await readFile(manifestPath, 'utf8')), '$')
    for (const stack of ['old', 'new'] as const) {
      for (const testCase of OPEN_DESIGN_M1_CASES_V2) {
        const workspacePath = `workspace/${stack}/${testCase.id}.json`
        const recordPath = `records/${stack}/${testCase.id}.json`
        const record = objectAt(JSON.parse(await readFile(join(root, recordPath), 'utf8')), recordPath)
        record.workspaceManifestSha256 = digest(await readFile(join(root, workspacePath)))
        await writeFile(join(root, recordPath), canonicalJson(record), { mode: 0o600 })
      }
    }
    const payloadPaths = expectedMachineEvidencePaths()
      .filter((path) => path !== 'machine-manifest.json' && path !== 'SHA256SUMS')
    const files: FileEntry[] = []
    for (const path of payloadPaths) {
      const bytes = await readFile(join(root, path))
      files.push({ path, sha256: digest(bytes), bytes: bytes.byteLength })
    }
    const lookup = (path: string): FileRef => ({ path, sha256: files.find((entry) => entry.path === path)!.sha256 })
    const index: JsonObject[] = []
    for (const stack of ['old', 'new'] as const) {
      for (const testCase of OPEN_DESIGN_M1_CASES_V2) {
        index.push({
          stack,
          caseId: testCase.id,
          record: lookup(`records/${stack}/${testCase.id}.json`),
          events: lookup(`events/${stack}/${testCase.id}.jsonl`),
          workspace: lookup(`workspace/${stack}/${testCase.id}.json`),
          ...(stack === 'new' ? { preview: lookup(`previews/new/${testCase.id}.png`) } : {}),
        })
      }
    }
    manifest.files = files
    manifest.records = index
    manifest.requiredCi = lookup('required-ci.json')
    manifest.rollback = {
      transitions: lookup('rollback/transitions.json'),
      processes: lookup('rollback/processes.json'),
      hiddenSessions: lookup('rollback/hidden-sessions.json'),
    }
    manifest.batchDigest = digest(index.map((entry) => [
      entry.stack, entry.caseId, (entry.record as FileRef).sha256, (entry.events as FileRef).sha256,
      (entry.workspace as FileRef).sha256, (entry.preview as FileRef | undefined)?.sha256 ?? '-',
    ].join(':')).join('\n') + '\n')
    await writeFile(manifestPath, canonicalJson(manifest), { mode: 0o600 })
    const paths = expectedMachineEvidencePaths().filter((path) => path !== 'SHA256SUMS')
    const lines: string[] = []
    for (const path of paths) lines.push(`${digest(await readFile(join(root, path)))}  ${path}`)
    await writeFile(join(root, 'SHA256SUMS'), `${lines.join('\n')}\n`, { mode: 0o600 })
  },
  symlink,
  rm,
  stat,
})
