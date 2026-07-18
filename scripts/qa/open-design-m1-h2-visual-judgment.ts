#!/usr/bin/env bun

import { join } from 'node:path'
import {
  OPEN_DESIGN_M1_MACHINE_ARTIFACT_NAME,
  OPEN_DESIGN_M1_MACHINE_WORKFLOW_PATH,
  validateOpenDesignM1MachineEvidence,
  type MachineEvidenceAuthority,
  type ReleaseAuthority,
} from './open-design-m1-machine-evidence'
import { OPEN_DESIGN_M1_CASES } from './open-design-m1-cases'
import {
  COMMIT_SHA_PATTERN,
  SHA256_PATTERN,
  canonicalJson,
  canonicalTimestamp,
  commitAt,
  evidenceFailure,
  exactKeys,
  hashAt,
  integerAt,
  inventoryOwnerOnlyFiles,
  objectAt,
  positiveIntegerAt,
  publishOwnerOnlyDirectory,
  readOwnerOnlyBoundedFile,
  readOwnerOnlyCanonicalJson,
  requireOwnerOnlyDirectory,
  sha256,
  stringAt,
  writeOwnerOnlyNewFile,
  type JsonObject,
} from './open-design-m1-local-evidence'

const KIND = 'OpenDesign M1 H2 visual judgment evidence'
const JUDGMENT_PATH = 'h2-visual-judgment.json' as const
const WORKFLOW_INPUT_PATH = 'visual-attestation-workflow-input.json' as const
const CHECKSUMS_PATH = 'SHA256SUMS' as const
const WORKFLOW_CONFIRMATION = 'ATTEST_OPEN_DESIGN_M1_20_PREVIEWS' as const
const MAX_JUDGMENT_INPUT_BYTES = 64 * 1024
const MAX_JUDGMENT_PROOF_BYTES = 96 * 1024
const MAX_WORKFLOW_INPUT_BYTES = 16 * 1024
const MAX_REASON_BYTES = 1_024

export type H2VisualDecision = 'PASS' | 'FAIL'

export interface H2MachineAuthority {
  readonly sourceSha: string
  readonly machineRunId: number
  readonly machineManifestSha256: string
  readonly hostBuildRunId: number
  readonly hostArtifactSha256: string
}

export interface H2VisualJudgmentInput {
  readonly caseId: string
  readonly decision: H2VisualDecision
  readonly previewSha256: string
  readonly reason: string
  readonly reviewedAt: string
}

export interface H2VisualJudgmentResult {
  readonly objectPath: typeof JUDGMENT_PATH
  readonly sha256: string
  readonly result: 'passed' | 'failed'
  readonly workflowReady: boolean
  readonly workflowInputObjectPath: typeof WORKFLOW_INPUT_PATH | null
  readonly workflowInputSha256: string | null
}

interface MachineView {
  readonly manifestSha256: string
  readonly batchDigest: string
  readonly batchCompletedAt: number
  readonly previews: ReadonlyMap<string, string>
}

function validateAuthority(authority: H2MachineAuthority): void {
  if (!COMMIT_SHA_PATTERN.test(authority.sourceSha)
    || !SHA256_PATTERN.test(authority.machineManifestSha256)
    || !SHA256_PATTERN.test(authority.hostArtifactSha256)
    || !Number.isSafeInteger(authority.machineRunId) || authority.machineRunId < 1
    || !Number.isSafeInteger(authority.hostBuildRunId) || authority.hostBuildRunId < 1) {
    evidenceFailure(KIND, 'authority')
  }
}

function releaseAuthorityAt(value: unknown, path: string, includeSourceSha: boolean): ReleaseAuthority & { sourceSha?: string } {
  const object = objectAt(value, path, KIND)
  const release: ReleaseAuthority & { sourceSha?: string } = {
    archiveSha256: hashAt(object, 'archiveSha256', path, KIND),
    catalogIssuedAt: stringAt(object, 'catalogIssuedAt', path, KIND),
    catalogSequence: integerAt(object, 'catalogSequence', path, KIND),
    catalogSha256: hashAt(object, 'catalogSha256', path, KIND),
    envelopeSha256: hashAt(object, 'envelopeSha256', path, KIND),
    expiresAt: stringAt(object, 'expiresAt', path, KIND),
    extractedManifestSha256: hashAt(object, 'extractedManifestSha256', path, KIND),
  }
  if (includeSourceSha) release.sourceSha = commitAt(object, 'sourceSha', path, KIND)
  return release
}

async function authenticatedMachineView(
  machineRootInput: string,
  expected: H2MachineAuthority,
): Promise<MachineView> {
  validateAuthority(expected)
  const machineRoot = await requireOwnerOnlyDirectory(machineRootInput, KIND, 'machine root')
  const manifest = objectAt(
    await readOwnerOnlyCanonicalJson(
      join(machineRoot, 'machine-manifest.json'),
      64 * 1024,
      KIND,
      'machine-manifest.json',
    ),
    '$machine',
    KIND,
  )
  const producer = objectAt(manifest.producer, '$machine.producer', KIND)
  const host = objectAt(manifest.host, '$machine.host', KIND)
  const sourceSha = commitAt(producer, 'headSha', '$machine.producer', KIND)
  const machineRunId = positiveIntegerAt(producer, 'runId', '$machine.producer', KIND)
  const runAttempt = positiveIntegerAt(producer, 'runAttempt', '$machine.producer', KIND)
  const hostBuildRunId = positiveIntegerAt(host, 'buildRunId', '$machine.host', KIND)
  const hostArtifactSha256 = hashAt(host, 'artifactSha256', '$machine.host', KIND)
  if (sourceSha !== expected.sourceSha || machineRunId !== expected.machineRunId || runAttempt !== 1
    || hostBuildRunId !== expected.hostBuildRunId || hostArtifactSha256 !== expected.hostArtifactSha256) {
    evidenceFailure(KIND, 'machine authority', 'does not match the expected source, run, build, and artifact')
  }
  const lkg = releaseAuthorityAt(manifest.lkg, '$machine.lkg', false)
  const rc = releaseAuthorityAt(manifest.rc, '$machine.rc', true)
  const h1Authority = objectAt(manifest.h1Authority, '$machine.h1Authority', KIND)
  if (!rc.sourceSha) evidenceFailure(KIND, '$machine.rc.sourceSha')
  const validation = await validateOpenDesignM1MachineEvidence(machineRoot, {
    hostHeadSha: sourceSha,
    producerRunId: machineRunId,
    producerRunAttempt: 1,
    hostBuildRunId,
    hostArtifactSha256,
    h1: {
      connectionEvidenceSha256: hashAt(
        h1Authority,
        'connectionEvidenceSha256',
        '$machine.h1Authority',
        KIND,
      ),
      handoffSha256: hashAt(h1Authority, 'handoffSha256', '$machine.h1Authority', KIND),
    },
    lkg,
    rc: rc as ReleaseAuthority & { readonly sourceSha: string },
  } satisfies MachineEvidenceAuthority)
  if (validation.sha256 !== expected.machineManifestSha256) {
    evidenceFailure(KIND, 'machine-manifest.json', 'does not match the expected hash')
  }
  const batch = objectAt(manifest.batch, '$machine.batch', KIND)
  const batchCompletedAt = canonicalTimestamp(
    stringAt(batch, 'completedAt', '$machine.batch', KIND),
    '$machine.batch.completedAt',
    KIND,
  )
  if (!Array.isArray(manifest.records)) evidenceFailure(KIND, '$machine.records')
  const previews = new Map<string, string>()
  for (const [index, candidate] of manifest.records.entries()) {
    const record = objectAt(candidate, `$machine.records[${index}]`, KIND)
    if (record.stack !== 'new') continue
    const caseId = stringAt(record, 'caseId', `$machine.records[${index}]`, KIND)
    const preview = objectAt(record.preview, `$machine.records[${index}].preview`, KIND)
    const previewPath = stringAt(preview, 'path', `$machine.records[${index}].preview`, KIND)
    if (previewPath !== `previews/new/${caseId}.png` || previews.has(caseId)) {
      evidenceFailure(KIND, `$machine.records[${index}].preview`)
    }
    previews.set(caseId, hashAt(preview, 'sha256', `$machine.records[${index}].preview`, KIND))
  }
  if (previews.size !== OPEN_DESIGN_M1_CASES.length) evidenceFailure(KIND, '$machine.records')
  return {
    manifestSha256: validation.sha256,
    batchDigest: validation.batchDigest,
    batchCompletedAt,
    previews,
  }
}

function validReason(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.trim() !== value
    || Buffer.byteLength(value, 'utf8') > MAX_REASON_BYTES || /[\u0000-\u001f\u007f]/.test(value)) {
    evidenceFailure(KIND, path, 'must be a non-empty bounded single-line reason')
  }
  return value
}

function normalizedJudgments(
  value: unknown,
  machine: MachineView,
  completedAt: string,
): readonly H2VisualJudgmentInput[] {
  if (!Array.isArray(value) || value.length !== OPEN_DESIGN_M1_CASES.length) {
    evidenceFailure(KIND, '$judgments')
  }
  const completedAtMs = canonicalTimestamp(completedAt, '$review.completedAt', KIND)
  if (completedAtMs <= machine.batchCompletedAt) evidenceFailure(KIND, '$review.completedAt')
  let previousReviewedAt = machine.batchCompletedAt
  const seen = new Set<string>()
  return Object.freeze(value.map((candidate, index) => {
    const path = `$judgments[${index}]`
    const judgment = objectAt(candidate, path, KIND)
    exactKeys(judgment, ['caseId', 'decision', 'previewSha256', 'reason', 'reviewedAt'], path, KIND)
    const caseId = stringAt(judgment, 'caseId', path, KIND)
    if (caseId !== OPEN_DESIGN_M1_CASES[index]!.id || seen.has(caseId)) {
      evidenceFailure(KIND, `${path}.caseId`, 'is unknown, duplicate, missing, or out of order')
    }
    seen.add(caseId)
    const decision = judgment.decision
    if (decision !== 'PASS' && decision !== 'FAIL') evidenceFailure(KIND, `${path}.decision`)
    const previewSha256 = hashAt(judgment, 'previewSha256', path, KIND)
    if (previewSha256 !== machine.previews.get(caseId)) {
      evidenceFailure(KIND, `${path}.previewSha256`, 'does not match the authenticated machine Preview')
    }
    const reason = validReason(judgment.reason, `${path}.reason`)
    const reviewedAt = stringAt(judgment, 'reviewedAt', path, KIND)
    const reviewedAtMs = canonicalTimestamp(reviewedAt, `${path}.reviewedAt`, KIND)
    if (reviewedAtMs <= machine.batchCompletedAt || reviewedAtMs < previousReviewedAt
      || reviewedAtMs > completedAtMs) {
      evidenceFailure(KIND, `${path}.reviewedAt`)
    }
    previousReviewedAt = reviewedAtMs
    return Object.freeze({ caseId, decision, previewSha256, reason, reviewedAt })
  }))
}

async function readJudgmentInput(
  path: string,
  machine: MachineView,
  completedAt: string,
): Promise<readonly H2VisualJudgmentInput[]> {
  return normalizedJudgments(
    await readOwnerOnlyCanonicalJson(path, MAX_JUDGMENT_INPUT_BYTES, KIND, 'judgment input'),
    machine,
    completedAt,
  )
}

function minimalWorkflowDecisions(judgments: readonly H2VisualJudgmentInput[]): readonly JsonObject[] {
  return Object.freeze(judgments.map((judgment) => Object.freeze({
    caseId: judgment.caseId,
    decision: 'PASS',
    reviewedAt: judgment.reviewedAt,
  })))
}

function workflowInputSource(machineRunId: number, judgments: readonly H2VisualJudgmentInput[]): string {
  const decisionsSource = canonicalJson(minimalWorkflowDecisions(judgments))
  return canonicalJson({
    machine_run_id: String(machineRunId),
    decisions_base64: Buffer.from(decisionsSource, 'utf8').toString('base64'),
    decisions_sha256: sha256(decisionsSource),
    confirmation: WORKFLOW_CONFIRMATION,
  })
}

function expectedProof(
  authority: H2MachineAuthority,
  machine: MachineView,
  judgments: readonly H2VisualJudgmentInput[],
  completedAt: string,
  workflowInputSha256: string | null,
): JsonObject {
  const failedCaseIds = judgments.filter((judgment) => judgment.decision === 'FAIL').map((judgment) => judgment.caseId)
  const workflowReady = failedCaseIds.length === 0
  return {
    schemaVersion: 1,
    kind: 'open-design-m1-h2-visual-judgment',
    authority: {
      sourceSha: authority.sourceSha,
      machineWorkflowPath: OPEN_DESIGN_M1_MACHINE_WORKFLOW_PATH,
      machineArtifactName: OPEN_DESIGN_M1_MACHINE_ARTIFACT_NAME,
      machineRunId: authority.machineRunId,
      machineRunAttempt: 1,
      machineManifestSha256: machine.manifestSha256,
      batchDigest: machine.batchDigest,
      hostBuildRunId: authority.hostBuildRunId,
      hostArtifactSha256: authority.hostArtifactSha256,
    },
    judgments,
    review: {
      completedAt,
      decisionCount: judgments.length,
      failedCaseIds,
      result: workflowReady ? 'passed' : 'failed',
    },
    workflowDispatch: {
      eligible: workflowReady,
      inputObjectPath: workflowReady ? WORKFLOW_INPUT_PATH : null,
      inputSha256: workflowReady ? workflowInputSha256 : null,
      privateReasonsExcluded: true,
      privateSourceJudgmentExcluded: true,
    },
  }
}

function expectedPaths(workflowReady: boolean): readonly string[] {
  return workflowReady
    ? [CHECKSUMS_PATH, JUDGMENT_PATH, WORKFLOW_INPUT_PATH]
    : [CHECKSUMS_PATH, JUDGMENT_PATH]
}

async function validateWorkflowInput(
  root: string,
  authority: H2MachineAuthority,
  judgments: readonly H2VisualJudgmentInput[],
): Promise<string> {
  const bytes = await readOwnerOnlyBoundedFile(
    join(root, WORKFLOW_INPUT_PATH),
    MAX_WORKFLOW_INPUT_BYTES,
    KIND,
    WORKFLOW_INPUT_PATH,
  )
  const expected = workflowInputSource(authority.machineRunId, judgments)
  if (bytes.toString('utf8') !== expected) evidenceFailure(KIND, WORKFLOW_INPUT_PATH, 'is not the minimal workflow input')
  const value = objectAt(JSON.parse(expected), '$workflowInput', KIND)
  exactKeys(value, ['confirmation', 'decisions_base64', 'decisions_sha256', 'machine_run_id'], '$workflowInput', KIND)
  const decisionsSource = Buffer.from(stringAt(value, 'decisions_base64', '$workflowInput', KIND), 'base64').toString('utf8')
  if (Buffer.from(decisionsSource, 'utf8').toString('base64') !== value.decisions_base64
    || sha256(decisionsSource) !== hashAt(value, 'decisions_sha256', '$workflowInput', KIND)
    || decisionsSource.includes('reason') || decisionsSource.includes('previewSha256')) {
    evidenceFailure(KIND, WORKFLOW_INPUT_PATH, 'contains invalid or private decision content')
  }
  return sha256(bytes)
}

export async function validateOpenDesignM1H2VisualJudgment(
  rootInput: string,
  machineRoot: string,
  expectedAuthority: H2MachineAuthority,
): Promise<H2VisualJudgmentResult> {
  const machine = await authenticatedMachineView(machineRoot, expectedAuthority)
  const root = await requireOwnerOnlyDirectory(rootInput, KIND, 'artifact root')
  const proof = objectAt(
    await readOwnerOnlyCanonicalJson(join(root, JUDGMENT_PATH), MAX_JUDGMENT_PROOF_BYTES, KIND, JUDGMENT_PATH),
    '$',
    KIND,
  )
  exactKeys(proof, ['authority', 'judgments', 'kind', 'review', 'schemaVersion', 'workflowDispatch'], '$', KIND)
  if (proof.schemaVersion !== 1 || proof.kind !== 'open-design-m1-h2-visual-judgment') evidenceFailure(KIND, '$')
  const review = objectAt(proof.review, '$.review', KIND)
  exactKeys(review, ['completedAt', 'decisionCount', 'failedCaseIds', 'result'], '$.review', KIND)
  const completedAt = stringAt(review, 'completedAt', '$.review', KIND)
  const judgments = normalizedJudgments(proof.judgments, machine, completedAt)
  const failedCaseIds = judgments.filter((judgment) => judgment.decision === 'FAIL').map((judgment) => judgment.caseId)
  const workflowReady = failedCaseIds.length === 0
  if (integerAt(review, 'decisionCount', '$.review', KIND) !== OPEN_DESIGN_M1_CASES.length
    || JSON.stringify(review.failedCaseIds) !== JSON.stringify(failedCaseIds)
    || review.result !== (workflowReady ? 'passed' : 'failed')) {
    evidenceFailure(KIND, '$.review')
  }
  await inventoryOwnerOnlyFiles(root, expectedPaths(workflowReady), KIND)
  const workflowInputSha256 = workflowReady
    ? await validateWorkflowInput(root, expectedAuthority, judgments)
    : null
  const expected = expectedProof(expectedAuthority, machine, judgments, completedAt, workflowInputSha256)
  if (canonicalJson(proof) !== canonicalJson(expected)) {
    evidenceFailure(KIND, '$', 'does not match the authenticated machine authority and judgments')
  }
  const proofBytes = await readOwnerOnlyBoundedFile(join(root, JUDGMENT_PATH), MAX_JUDGMENT_PROOF_BYTES, KIND, JUDGMENT_PATH)
  const proofSha256 = sha256(proofBytes)
  const checksummed = [
    { path: JUDGMENT_PATH, sha256: proofSha256 },
    ...(workflowReady ? [{ path: WORKFLOW_INPUT_PATH, sha256: workflowInputSha256! }] : []),
  ].sort((left, right) => left.path.localeCompare(right.path))
  const expectedSums = checksummed.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n'
  const sums = await readOwnerOnlyBoundedFile(join(root, CHECKSUMS_PATH), 512, KIND, CHECKSUMS_PATH)
  if (sums.toString('utf8') !== expectedSums) evidenceFailure(KIND, CHECKSUMS_PATH)
  return {
    objectPath: JUDGMENT_PATH,
    sha256: proofSha256,
    result: workflowReady ? 'passed' : 'failed',
    workflowReady,
    workflowInputObjectPath: workflowReady ? WORKFLOW_INPUT_PATH : null,
    workflowInputSha256,
  }
}

export async function createOpenDesignM1H2VisualJudgment(
  rootInput: string,
  machineRoot: string,
  judgmentInputPath: string,
  authority: H2MachineAuthority,
  completedAt: string,
): Promise<H2VisualJudgmentResult> {
  const machine = await authenticatedMachineView(machineRoot, authority)
  const judgments = await readJudgmentInput(judgmentInputPath, machine, completedAt)
  const workflowReady = judgments.every((judgment) => judgment.decision === 'PASS')
  const workflowSource = workflowReady ? workflowInputSource(authority.machineRunId, judgments) : null
  const workflowInputSha256 = workflowSource ? sha256(workflowSource) : null
  const proofSource = canonicalJson(expectedProof(
    authority,
    machine,
    judgments,
    completedAt,
    workflowInputSha256,
  ))
  return publishOwnerOnlyDirectory(rootInput, KIND, async (temporaryRoot) => {
    await writeOwnerOnlyNewFile(join(temporaryRoot, JUDGMENT_PATH), proofSource)
    if (workflowSource) await writeOwnerOnlyNewFile(join(temporaryRoot, WORKFLOW_INPUT_PATH), workflowSource)
    const sums = [
      { path: JUDGMENT_PATH, sha256: sha256(proofSource) },
      ...(workflowSource ? [{ path: WORKFLOW_INPUT_PATH, sha256: sha256(workflowSource) }] : []),
    ].sort((left, right) => left.path.localeCompare(right.path))
    await writeOwnerOnlyNewFile(
      join(temporaryRoot, CHECKSUMS_PATH),
      sums.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n',
    )
    return validateOpenDesignM1H2VisualJudgment(temporaryRoot, machineRoot, authority)
  })
}

function parseArgs(args: readonly string[]): Map<string, string> {
  const result = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--') || result.has(key)) {
      evidenceFailure(KIND, 'arguments')
    }
    result.set(key, value)
  }
  return result
}

function requiredArg(args: Map<string, string>, key: string): string {
  const value = args.get(key)
  if (!value) evidenceFailure(KIND, `arguments.${key}`)
  return value
}

function positiveIntegerArg(args: Map<string, string>, key: string): number {
  const value = requiredArg(args, key)
  if (!/^[1-9][0-9]*$/.test(value)) evidenceFailure(KIND, `arguments.${key}`)
  const result = Number(value)
  if (!Number.isSafeInteger(result)) evidenceFailure(KIND, `arguments.${key}`)
  return result
}

async function main(): Promise<void> {
  const [command, ...rest] = Bun.argv.slice(2)
  if (command !== 'produce' && command !== 'validate') evidenceFailure(KIND, 'arguments.command')
  const args = parseArgs(rest)
  const expectedKeys = [
    '--host-artifact-sha256', '--host-build-run-id', '--machine-manifest-sha256', '--machine-root',
    '--machine-run-id', '--output-root', '--source-sha',
    ...(command === 'produce' ? ['--completed-at', '--judgments'] : []),
  ].sort()
  if ([...args.keys()].sort().join('\n') !== expectedKeys.join('\n')) evidenceFailure(KIND, 'arguments')
  const authority: H2MachineAuthority = {
    sourceSha: requiredArg(args, '--source-sha'),
    machineRunId: positiveIntegerArg(args, '--machine-run-id'),
    machineManifestSha256: requiredArg(args, '--machine-manifest-sha256'),
    hostBuildRunId: positiveIntegerArg(args, '--host-build-run-id'),
    hostArtifactSha256: requiredArg(args, '--host-artifact-sha256'),
  }
  const result = command === 'produce'
    ? await createOpenDesignM1H2VisualJudgment(
      requiredArg(args, '--output-root'),
      requiredArg(args, '--machine-root'),
      requiredArg(args, '--judgments'),
      authority,
      requiredArg(args, '--completed-at'),
    )
    : await validateOpenDesignM1H2VisualJudgment(
      requiredArg(args, '--output-root'),
      requiredArg(args, '--machine-root'),
      authority,
    )
  process.stdout.write(canonicalJson(result))
}

if (import.meta.main) await main()
