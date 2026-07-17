import { createHash } from 'node:crypto'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'

export const OPEN_DESIGN_ACCEPTANCE_REPOSITORY = 'Jiachi-Deng/Simulator'
export const OPEN_DESIGN_HOST_VERSION = '0.12.0'
export const OPEN_DESIGN_HOST_ARTIFACT_NAME = 'Simulator-arm64.dmg'
export const OPEN_DESIGN_LKG_VERSION = '0.14.5'
export const OPEN_DESIGN_LKG_TAG = 'open-design-v0.14.5'
export const OPEN_DESIGN_LKG_ARCHIVE_ASSET = 'org.simulator.open-design-0.14.5-darwin-arm64.tar.gz'
export const OPEN_DESIGN_RC_VERSION = '0.14.6-rc.1'
export const OPEN_DESIGN_RC_TAG = 'open-design-v0.14.6-rc.1'
export const OPEN_DESIGN_RC_ARCHIVE_ASSET = 'org.simulator.open-design-0.14.6-rc.1-darwin-arm64.tar.gz'
export const OPEN_DESIGN_RC_SOURCE_SHA = '6b39a9bcc0f158645897976e23f334c5cab771f4'
export const OPEN_DESIGN_M1_CASE_MANIFEST_SHA256 = 'a45cbb0c4508863681531bcc2456df67fe9c91089bd219f766d3f86a526281d7'
export const OPEN_DESIGN_M1_CASE_SEED_CHECKSUMS_SHA256 = '9f992797e2702b04161671601caaba1a5740168163a4b7b1c86b836b48d801e4'

export const OPEN_DESIGN_REQUIRED_CI_WORKFLOW_PATHS = Object.freeze([
  '.github/workflows/validate.yml',
  '.github/workflows/module-coordinator.yml',
  '.github/workflows/module-daemon.yml',
  '.github/workflows/package-macos.yml',
  '.github/workflows/release-static-validation.yml',
  '.github/workflows/open-design-artifact-policy.yml',
  '.github/workflows/open-design-production-input.yml',
] as const)

export const OPEN_DESIGN_M1_CASE_HASHES = Object.freeze([
  { id: 'D01', promptSha256: 'e47684c317ed7ba2a7eebf8079fe07806e6f295077b66c635f37ace5ca8d0160', seedArchiveSha256: 'a04bbe467f345e60700355b0821e583f40c856bb5cbc84e8bf77f15b817246e1' },
  { id: 'D02', promptSha256: '8db0675cc2b4a27c69aa4098e87be52d299a2a5abe11ee0b54a336a683fa5f17', seedArchiveSha256: '52b1b0b886b78ee0de2b17ba0cb8b6862e0199945d39a0ecf1cd1b97afd5a334' },
  { id: 'D03', promptSha256: '3a266c9548a84597b4d1db4312dafb2db9414aa61346f7667b1dabe5bca4a682', seedArchiveSha256: '0bf121649167315fd1350a65ca430ea384047a3578e3966993b89817e8b0fdeb' },
  { id: 'D04', promptSha256: '75c4cdf407be15af8a9c1210debff68d778526ac6f59621e679ba63b6719fda8', seedArchiveSha256: 'f8759b992a36645dd285d2e0152a1e32e01f5d019c8204644327b4b4efccc5a2' },
  { id: 'L01', promptSha256: '63d989f892b4840a82c20cb5bacaeb265d6f3795606a2c1d61fbb02b5c0f44c3', seedArchiveSha256: '144cd72d6338a2375ba6f51d48382a276a71912924181897f96b46df03e24f97' },
  { id: 'L02', promptSha256: '708a9be9f76e64e5d7f00d964a3c20cfe19a61ac130d3a52291105599c5a93b9', seedArchiveSha256: '7d91a8e44f2e2d7c910942979d26f57085c5bc1b3d59d36c8b48e8435271f75b' },
  { id: 'L03', promptSha256: '82285608314c0d52e5cf5fa6ca98e2d900881072fc6afa9ee4de095e8fb1c957', seedArchiveSha256: '76216f0065842ba634c19aa61e459f327c93225f0bbfb601cc4793ded634a4d6' },
  { id: 'L04', promptSha256: '052e5a35f75cc562cf76cca2def742cb6640587ef2d26c1b53a322a864baaaf4', seedArchiveSha256: '842874ae8432fcf05b62e416bdaf920d0c28a1bbe3a9859524123a659a180a94' },
  { id: 'E01', promptSha256: 'c1ee407fa82fc83785de3f0ea5036002452b300566a505ed7fd037791a454b15', seedArchiveSha256: 'bdf63052199ebe1dcb3d7d84c0c2250aa4997f8211eba47ed3faa6f75b759c3e' },
  { id: 'E02', promptSha256: '658fd7126095c27c53422f440c3fbc07f5242eb3a8e5d38300e457af2ddb641f', seedArchiveSha256: '76bf77374d181d6b0c625e95265017a32431f479c955a2a14ed8081b5e1f2ccd' },
  { id: 'E03', promptSha256: '6e165ca86a6b091b7ff7fddfbd5a6eed66dbd15e3ec098766d56ad48df833e7d', seedArchiveSha256: 'f684487050d0afb8cab660885a634057f523fa2044d8f5d2cf0d1e25fa31bc6f' },
  { id: 'E04', promptSha256: 'b8a9c6ecb3feed8328cbeb2534e6c55c5c07a3d4080dd0486b4e42fd045aca63', seedArchiveSha256: '9b957e380dc099be9c472bc159061a7409c668cd5d735cb510e651448237e8a1' },
  { id: 'S01', promptSha256: '9203154ef7bdbf8543ca986596b195d75b01c3ed3c3557ca3ea175ab14274d20', seedArchiveSha256: '450fb3755c87584e9620a165e22d0bc522079bc2965f7acba7af2aa825c3b67d' },
  { id: 'S02', promptSha256: 'b9df697b5d9e2f2384dce719528c952e275cb8263e4ae2ea0832342092394101', seedArchiveSha256: '62a2ec8c20f99f460e38098c33d16afafe28299ce397ccd80aad01ec48533481' },
  { id: 'S03', promptSha256: '515de94800b7835095343078c1b470e0bf61cd25882f9511775cc54e88d030cc', seedArchiveSha256: 'fbfc64f9117c81152ecd30d891aa766d7364f1cc96b43654202697f0af774716' },
  { id: 'S04', promptSha256: 'ca660d3ca96d5c30f79d802a3ca8b55bd44ec788e195ad672c48ffdc7948dff6', seedArchiveSha256: '6ee7e4fce27701037152bc046e866cea927025fc803c62e3663e148b87855d73' },
  { id: 'F01', promptSha256: '04bc7939e1a9237809f14e55f486a564ee3c91943d7c8a4472d8be1e3f9b016d', seedArchiveSha256: 'c5b785d3239df208e4a9810aaed7179d61b9fa9b7c1768db029803b727d28168' },
  { id: 'F02', promptSha256: '75995cbdacab960191eacd9d85f499e1dd594001e590ed26be21b2314859b85f', seedArchiveSha256: 'f40b37bb7140585f991dc8f398803efae33e2db5b36425ae91ec6fbd62dfab22' },
  { id: 'F03', promptSha256: '9786519af0c941402a0c705b9a75c95983dc52e67022989da07407248674af66', seedArchiveSha256: '44612832d76ed3de8ac28242ab4a82aa09caa2c0fd4989dd6ed2429bc1849537' },
  { id: 'F04', promptSha256: '990f9c40a05b9c522aceccbe007cf8baeb26cdda0e73ca46cce9fe9bc0b8b087', seedArchiveSha256: 'ab70621984238f22ceaa12271ac445364099cc8eb997bfe5e793851bb0ade651' },
] as const)

const SHA256 = /^[0-9a-f]{64}$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const ISO_TIMESTAMP = /^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
// 45,000 decoded bytes remain below the workflow_dispatch limit after base64 encoding.
export const OPEN_DESIGN_ACCEPTANCE_MAX_INPUT_BYTES = 45_000

type JsonObject = Record<string, unknown>

export interface EvidenceObjectRef {
  readonly artifactName: string
  readonly objectPath: string
  readonly sha256: string
}

export interface OpenDesignRcAcceptanceSummaryV2 {
  readonly blackoutTasksPassed: 20
  readonly evidenceBundleSha256: string
  readonly hostArtifactName: typeof OPEN_DESIGN_HOST_ARTIFACT_NAME
  readonly hostArtifactSha256: string
  readonly hostBuildRunId: number
  readonly hostHeadSha: string
  readonly hostVersion: typeof OPEN_DESIGN_HOST_VERSION
  readonly machineEvidence: EvidenceObjectRef
  readonly newStackConsecutivePassed: 20
  readonly oldStackTasksPassed: 20
  readonly paidTurns: 40
  readonly previewHumanPasses: 20
  readonly rcArchiveAsset: typeof OPEN_DESIGN_RC_ARCHIVE_ASSET
  readonly rcArchiveSha256: string
  readonly rcCatalogIssuedAt: string
  readonly rcCatalogSequence: number
  readonly rcExtractedManifestSha256: string
  readonly rcSourceSha: typeof OPEN_DESIGN_RC_SOURCE_SHA
  readonly rcTag: typeof OPEN_DESIGN_RC_TAG
  readonly rcVersion: typeof OPEN_DESIGN_RC_VERSION
  readonly repository: typeof OPEN_DESIGN_ACCEPTANCE_REPOSITORY
  readonly requiredCiPassed: true
  readonly rollbackExercisePassed: true
  readonly schemaVersion: 2
  readonly visualEvidence: EvidenceObjectRef
}

function fail(path: string): never {
  throw new TypeError(`Invalid OpenDesign acceptance intake at ${path}`)
}

function objectAt(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path)
  return value as JsonObject
}

function exactKeys(object: JsonObject, keys: readonly string[], path: string): void {
  const actual = Object.keys(object).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(path)
}

function stringAt(object: JsonObject, key: string, path: string): string {
  const value = object[key]
  if (typeof value !== 'string') fail(`${path}.${key}`)
  return value
}

function numberAt(object: JsonObject, key: string, path: string): number {
  const value = object[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(`${path}.${key}`)
  return value
}

function literal(value: unknown, expected: string | number | boolean, path: string): void {
  if (value !== expected) fail(path)
}

function hash(value: string, path: string): string {
  if (!SHA256.test(value)) fail(path)
  return value
}

function commit(value: string, path: string): string {
  if (!COMMIT_SHA.test(value)) fail(path)
  return value
}

function timestamp(value: string, path: string): number {
  if (!ISO_TIMESTAMP.test(value)) fail(path)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(path)
  return milliseconds
}

function evidenceRef(value: unknown, path: string): EvidenceObjectRef {
  const object = objectAt(value, path)
  exactKeys(object, ['artifactName', 'objectPath', 'sha256'], path)
  const artifactName = stringAt(object, 'artifactName', path)
  const objectPath = stringAt(object, 'objectPath', path)
  const sha256 = hash(stringAt(object, 'sha256', path), `${path}.sha256`)
  if (!SAFE_NAME.test(artifactName)) fail(`${path}.artifactName`)
  if (
    objectPath.length < 1 || objectPath.length > 512 || objectPath.startsWith('/') || objectPath.endsWith('/') ||
    objectPath.includes('\\') || objectPath.includes('//') || objectPath.includes('\0') ||
    objectPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(objectPath)
  ) fail(`${path}.objectPath`)
  return { artifactName, objectPath, sha256 }
}

function validateHost(value: unknown, path: string): {
  artifactSha256: string
  buildRunId: number
} {
  const object = objectAt(value, path)
  exactKeys(object, ['artifactName', 'artifactSha256', 'buildRunId', 'version'], path)
  literal(object.version, OPEN_DESIGN_HOST_VERSION, `${path}.version`)
  literal(object.artifactName, OPEN_DESIGN_HOST_ARTIFACT_NAME, `${path}.artifactName`)
  const artifactSha256 = hash(stringAt(object, 'artifactSha256', path), `${path}.artifactSha256`)
  const buildRunId = numberAt(object, 'buildRunId', path)
  if (buildRunId < 1) fail(`${path}.buildRunId`)
  return { artifactSha256, buildRunId }
}

function validateRc(value: unknown, path: string): {
  archiveSha256: string
  catalogIssuedAt: string
  catalogSequence: number
  expiresAt: number
  extractedManifestSha256: string
  issuedAt: number
} {
  const object = objectAt(value, path)
  exactKeys(object, [
    'archiveAsset', 'archiveSha256', 'catalogIssuedAt', 'catalogSequence',
    'expiresAt', 'extractedManifestSha256', 'tag', 'version',
  ], path)
  literal(object.version, OPEN_DESIGN_RC_VERSION, `${path}.version`)
  literal(object.tag, OPEN_DESIGN_RC_TAG, `${path}.tag`)
  literal(object.archiveAsset, OPEN_DESIGN_RC_ARCHIVE_ASSET, `${path}.archiveAsset`)
  const archiveSha256 = hash(stringAt(object, 'archiveSha256', path), `${path}.archiveSha256`)
  const catalogIssuedAt = stringAt(object, 'catalogIssuedAt', path)
  const issuedAt = timestamp(catalogIssuedAt, `${path}.catalogIssuedAt`)
  const expiresAt = timestamp(stringAt(object, 'expiresAt', path), `${path}.expiresAt`)
  if (expiresAt <= issuedAt) fail(`${path}.expiresAt`)
  const catalogSequence = numberAt(object, 'catalogSequence', path)
  if (catalogSequence < 1) fail(`${path}.catalogSequence`)
  const extractedManifestSha256 = hash(
    stringAt(object, 'extractedManifestSha256', path),
    `${path}.extractedManifestSha256`,
  )
  return { archiveSha256, catalogIssuedAt, catalogSequence, expiresAt, extractedManifestSha256, issuedAt }
}

function validateLkg(value: unknown, path: string): {
  archiveSha256: string
  catalogSequence: number
  expiresAt: number
  issuedAt: number
} {
  const object = objectAt(value, path)
  exactKeys(object, [
    'archiveAsset', 'archiveSha256', 'catalogIssuedAt', 'catalogSequence',
    'expiresAt', 'extractedManifestSha256', 'tag', 'version',
  ], path)
  literal(object.version, OPEN_DESIGN_LKG_VERSION, `${path}.version`)
  literal(object.tag, OPEN_DESIGN_LKG_TAG, `${path}.tag`)
  literal(object.archiveAsset, OPEN_DESIGN_LKG_ARCHIVE_ASSET, `${path}.archiveAsset`)
  const archiveSha256 = hash(stringAt(object, 'archiveSha256', path), `${path}.archiveSha256`)
  hash(stringAt(object, 'extractedManifestSha256', path), `${path}.extractedManifestSha256`)
  const catalogSequence = numberAt(object, 'catalogSequence', path)
  if (catalogSequence < 1) fail(`${path}.catalogSequence`)
  const issuedAt = timestamp(stringAt(object, 'catalogIssuedAt', path), `${path}.catalogIssuedAt`)
  const expiresAt = timestamp(stringAt(object, 'expiresAt', path), `${path}.expiresAt`)
  if (expiresAt <= issuedAt) fail(`${path}.expiresAt`)
  return { archiveSha256, catalogSequence, expiresAt, issuedAt }
}

function validateBatch(value: unknown, path: string): { startedAt: number; completedAt: number } {
  const object = objectAt(value, path)
  exactKeys(object, [
    'batchId', 'completedAt', 'paidTurnBudget', 'paidTurns', 'startedAt', 'status', 'stopOnFailure',
  ], path)
  if (!SAFE_NAME.test(stringAt(object, 'batchId', path))) fail(`${path}.batchId`)
  literal(object.stopOnFailure, true, `${path}.stopOnFailure`)
  literal(object.paidTurnBudget, 40, `${path}.paidTurnBudget`)
  literal(object.paidTurns, 40, `${path}.paidTurns`)
  literal(object.status, 'passed', `${path}.status`)
  const startedAt = timestamp(stringAt(object, 'startedAt', path), `${path}.startedAt`)
  const completedAt = timestamp(stringAt(object, 'completedAt', path), `${path}.completedAt`)
  if (completedAt <= startedAt) fail(`${path}.completedAt`)
  return { startedAt, completedAt }
}

function validateTerminal(value: unknown, path: string): void {
  const object = objectAt(value, path)
  exactKeys(object, ['status', 'terminalEventCount'], path)
  literal(object.status, 'completed', `${path}.status`)
  literal(object.terminalEventCount, 1, `${path}.terminalEventCount`)
}

function validatePreview(value: unknown, path: string): void {
  const object = objectAt(value, path)
  exactKeys(object, ['httpStatus', 'requiredContentVerified', 'requiredFilesVerified', 'route'], path)
  literal(object.httpStatus, 200, `${path}.httpStatus`)
  literal(object.route, '/', `${path}.route`)
  literal(object.requiredFilesVerified, true, `${path}.requiredFilesVerified`)
  literal(object.requiredContentVerified, true, `${path}.requiredContentVerified`)
}

function validateVisual(value: unknown, stack: 'old' | 'new', path: string): void {
  const object = objectAt(value, path)
  if (stack === 'old') {
    exactKeys(object, ['required'], path)
    literal(object.required, false, `${path}.required`)
    return
  }
  exactKeys(object, ['decision', 'required', 'reviewerRole'], path)
  literal(object.required, true, `${path}.required`)
  literal(object.decision, 'PASS', `${path}.decision`)
  literal(object.reviewerRole, 'product-owner', `${path}.reviewerRole`)
}

function validateCraft(value: unknown, path: string): void {
  const object = objectAt(value, path)
  exactKeys(object, ['mainPidSurvived', 'stateSplitCount', 'usableAfterTurn'], path)
  literal(object.mainPidSurvived, true, `${path}.mainPidSurvived`)
  literal(object.usableAfterTurn, true, `${path}.usableAfterTurn`)
  literal(object.stateSplitCount, 0, `${path}.stateSplitCount`)
}

function validateBlackout(value: unknown, stack: 'old' | 'new', path: string): number {
  const object = objectAt(value, path)
  if (stack === 'old') {
    exactKeys(object, ['required'], path)
    literal(object.required, false, `${path}.required`)
    return 0
  }
  exactKeys(object, [
    'businessEventSilenceSeconds', 'duplicateTerminalCount', 'eventsLost', 'heartbeatContinued',
    'replayComplete', 'required',
  ], path)
  literal(object.required, true, `${path}.required`)
  const silence = numberAt(object, 'businessEventSilenceSeconds', path)
  if (silence < 65 || silence > 1800) fail(`${path}.businessEventSilenceSeconds`)
  literal(object.heartbeatContinued, true, `${path}.heartbeatContinued`)
  literal(object.replayComplete, true, `${path}.replayComplete`)
  literal(object.eventsLost, 0, `${path}.eventsLost`)
  literal(object.duplicateTerminalCount, 0, `${path}.duplicateTerminalCount`)
  return silence
}

function validateCleanup(value: unknown, path: string): void {
  const object = objectAt(value, path)
  exactKeys(object, [
    'activeRuns', 'hiddenSessions', 'moduleSessions', 'processTreeReapedWithinSeconds',
    'residualProcesses', 'runStateSettledWithinSeconds',
  ], path)
  literal(object.activeRuns, 0, `${path}.activeRuns`)
  literal(object.moduleSessions, 0, `${path}.moduleSessions`)
  literal(object.hiddenSessions, 0, `${path}.hiddenSessions`)
  literal(object.residualProcesses, 0, `${path}.residualProcesses`)
  const stateSeconds = numberAt(object, 'runStateSettledWithinSeconds', path)
  const processSeconds = numberAt(object, 'processTreeReapedWithinSeconds', path)
  if (stateSeconds < 0 || stateSeconds > 5) fail(`${path}.runStateSettledWithinSeconds`)
  if (processSeconds < 0 || processSeconds > 10) fail(`${path}.processTreeReapedWithinSeconds`)
}

function validateRecords(
  value: unknown,
  batch: { startedAt: number; completedAt: number },
  releases: {
    lkg: { archiveSha256: string; expiresAt: number; issuedAt: number }
    rc: { archiveSha256: string; expiresAt: number; issuedAt: number }
  },
  path: string,
): void {
  if (!Array.isArray(value) || value.length !== 40) fail(path)
  const expected = [
    ...OPEN_DESIGN_M1_CASE_HASHES.map((testCase) => ({ stack: 'old' as const, testCase })),
    ...OPEN_DESIGN_M1_CASE_HASHES.map((testCase) => ({ stack: 'new' as const, testCase })),
  ]
  let previousCompletedAt = batch.startedAt
  value.forEach((entry, index) => {
    const recordPath = `${path}[${index}]`
    const object = objectAt(entry, recordPath)
    exactKeys(object, [
      'attemptOrdinal', 'blackout', 'caseId', 'cleanup', 'completedAt', 'craft', 'preview',
      'moduleArchiveSha256', 'promptSha256', 'seedArchiveSha256', 'stack',
      'startedAt', 'terminal', 'turnCount', 'visual',
    ], recordPath)
    const expectation = expected[index]!
    literal(object.stack, expectation.stack, `${recordPath}.stack`)
    literal(object.caseId, expectation.testCase.id, `${recordPath}.caseId`)
    literal(object.seedArchiveSha256, expectation.testCase.seedArchiveSha256, `${recordPath}.seedArchiveSha256`)
    literal(object.promptSha256, expectation.testCase.promptSha256, `${recordPath}.promptSha256`)
    const release = expectation.stack === 'old' ? releases.lkg : releases.rc
    literal(object.moduleArchiveSha256, release.archiveSha256, `${recordPath}.moduleArchiveSha256`)
    literal(object.attemptOrdinal, 1, `${recordPath}.attemptOrdinal`)
    literal(object.turnCount, 1, `${recordPath}.turnCount`)
    const startedAt = timestamp(stringAt(object, 'startedAt', recordPath), `${recordPath}.startedAt`)
    const completedAt = timestamp(stringAt(object, 'completedAt', recordPath), `${recordPath}.completedAt`)
    if (
      startedAt < batch.startedAt || startedAt < previousCompletedAt ||
      completedAt <= startedAt || completedAt > batch.completedAt
    ) fail(`${recordPath}.completedAt`)
    if (startedAt < release.issuedAt || completedAt > release.expiresAt) fail(`${recordPath}.completedAt`)
    previousCompletedAt = completedAt
    validateTerminal(object.terminal, `${recordPath}.terminal`)
    validatePreview(object.preview, `${recordPath}.preview`)
    validateVisual(object.visual, expectation.stack, `${recordPath}.visual`)
    validateCraft(object.craft, `${recordPath}.craft`)
    const blackoutSilenceSeconds = validateBlackout(
      object.blackout,
      expectation.stack,
      `${recordPath}.blackout`,
    )
    if (completedAt - startedAt < blackoutSilenceSeconds * 1000) {
      fail(`${recordPath}.blackout.businessEventSilenceSeconds`)
    }
    validateCleanup(object.cleanup, `${recordPath}.cleanup`)
  })
}

function validateRequiredCi(value: unknown, path: string): void {
  const object = objectAt(value, path)
  exactKeys(object, ['evidence', 'passed', 'runs'], path)
  literal(object.passed, true, `${path}.passed`)
  evidenceRef(object.evidence, `${path}.evidence`)
  if (!Array.isArray(object.runs) || object.runs.length !== OPEN_DESIGN_REQUIRED_CI_WORKFLOW_PATHS.length) {
    fail(`${path}.runs`)
  }
  object.runs.forEach((entry, index) => {
    const runPath = `${path}.runs[${index}]`
    const run = objectAt(entry, runPath)
    exactKeys(run, ['runId', 'workflowPath'], runPath)
    const runId = numberAt(run, 'runId', runPath)
    if (runId < 1) fail(`${runPath}.runId`)
    literal(run.workflowPath, OPEN_DESIGN_REQUIRED_CI_WORKFLOW_PATHS[index]!, `${runPath}.workflowPath`)
  })
  if (new Set(object.runs.map((entry) => (entry as JsonObject).runId)).size !== object.runs.length) {
    fail(`${path}.runs`)
  }
}

function validateAuthorityEvidence(value: unknown, path: string): {
  machineBatch: EvidenceObjectRef
  visualDecisions: EvidenceObjectRef
} {
  // One sealed machine batch and one independent human decision object avoid repeating private evidence per record.
  const object = objectAt(value, path)
  exactKeys(object, ['machineBatch', 'visualDecisions'], path)
  const machine = evidenceRef(object.machineBatch, `${path}.machineBatch`)
  const visual = evidenceRef(object.visualDecisions, `${path}.visualDecisions`)
  if (
    machine.artifactName === visual.artifactName &&
    machine.objectPath === visual.objectPath &&
    machine.sha256 === visual.sha256
  ) fail(path)
  return { machineBatch: machine, visualDecisions: visual }
}

function validateRollbackExercise(value: unknown, path: string): void {
  const object = objectAt(value, path)
  exactKeys(object, [
    'craftConnectionPreserved', 'craftSurvivedAllTransitions', 'evidence', 'hiddenSessionResidueCount',
    'passed', 'processResidueCount', 'restartAndReopenPassed', 'transitions',
  ], path)
  literal(object.passed, true, `${path}.passed`)
  literal(object.craftConnectionPreserved, true, `${path}.craftConnectionPreserved`)
  literal(object.craftSurvivedAllTransitions, true, `${path}.craftSurvivedAllTransitions`)
  literal(object.restartAndReopenPassed, true, `${path}.restartAndReopenPassed`)
  literal(object.processResidueCount, 0, `${path}.processResidueCount`)
  literal(object.hiddenSessionResidueCount, 0, `${path}.hiddenSessionResidueCount`)
  if (
    !Array.isArray(object.transitions) || object.transitions.length !== 4 ||
    object.transitions.some((transition, index) => transition !== [
      '0.14.5', OPEN_DESIGN_RC_VERSION, '0.14.5', OPEN_DESIGN_RC_VERSION,
    ][index])
  ) fail(`${path}.transitions`)
  const evidence = objectAt(object.evidence, `${path}.evidence`)
  exactKeys(evidence, ['hiddenSessionSnapshot', 'processSnapshot', 'transitionLog'], `${path}.evidence`)
  evidenceRef(evidence.transitionLog, `${path}.evidence.transitionLog`)
  evidenceRef(evidence.processSnapshot, `${path}.evidence.processSnapshot`)
  evidenceRef(evidence.hiddenSessionSnapshot, `${path}.evidence.hiddenSessionSnapshot`)
}

export function validateAndSummarizeOpenDesignRcAcceptanceIntake(
  value: unknown,
  expectedHostHeadSha: string,
): OpenDesignRcAcceptanceSummaryV2 {
  commit(expectedHostHeadSha, 'expectedHostHeadSha')
  const object = objectAt(value, '$')
  exactKeys(object, [
    'batch', 'caseManifestSha256', 'caseSeedChecksumsSha256', 'evidence', 'host', 'hostHeadSha',
    'lkg', 'rc', 'rcSourceSha', 'records', 'repository', 'requiredCi', 'rollbackExercise', 'schemaVersion',
  ], '$')
  literal(object.schemaVersion, 1, '$.schemaVersion')
  literal(object.repository, OPEN_DESIGN_ACCEPTANCE_REPOSITORY, '$.repository')
  literal(object.hostHeadSha, expectedHostHeadSha, '$.hostHeadSha')
  literal(object.rcSourceSha, OPEN_DESIGN_RC_SOURCE_SHA, '$.rcSourceSha')
  literal(object.caseManifestSha256, OPEN_DESIGN_M1_CASE_MANIFEST_SHA256, '$.caseManifestSha256')
  literal(
    object.caseSeedChecksumsSha256,
    OPEN_DESIGN_M1_CASE_SEED_CHECKSUMS_SHA256,
    '$.caseSeedChecksumsSha256',
  )
  const host = validateHost(object.host, '$.host')
  const authorityEvidence = validateAuthorityEvidence(object.evidence, '$.evidence')
  const lkg = validateLkg(object.lkg, '$.lkg')
  const rc = validateRc(object.rc, '$.rc')
  if (rc.catalogSequence <= lkg.catalogSequence || rc.issuedAt <= lkg.issuedAt) fail('$.rc')
  const batch = validateBatch(object.batch, '$.batch')
  if (rc.issuedAt > batch.startedAt || batch.completedAt > rc.expiresAt) fail('$.batch')
  validateRecords(object.records, batch, { lkg, rc }, '$.records')
  validateRequiredCi(object.requiredCi, '$.requiredCi')
  validateRollbackExercise(object.rollbackExercise, '$.rollbackExercise')

  return {
    blackoutTasksPassed: 20,
    evidenceBundleSha256: createHash('sha256')
      .update(`${JSON.stringify(value)}\n`)
      .digest('hex'),
    hostArtifactName: OPEN_DESIGN_HOST_ARTIFACT_NAME,
    hostArtifactSha256: host.artifactSha256,
    hostBuildRunId: host.buildRunId,
    hostHeadSha: expectedHostHeadSha,
    hostVersion: OPEN_DESIGN_HOST_VERSION,
    machineEvidence: authorityEvidence.machineBatch,
    newStackConsecutivePassed: 20,
    oldStackTasksPassed: 20,
    paidTurns: 40,
    previewHumanPasses: 20,
    rcArchiveAsset: OPEN_DESIGN_RC_ARCHIVE_ASSET,
    rcArchiveSha256: rc.archiveSha256,
    rcCatalogIssuedAt: rc.catalogIssuedAt,
    rcCatalogSequence: rc.catalogSequence,
    rcExtractedManifestSha256: rc.extractedManifestSha256,
    rcSourceSha: OPEN_DESIGN_RC_SOURCE_SHA,
    rcTag: OPEN_DESIGN_RC_TAG,
    rcVersion: OPEN_DESIGN_RC_VERSION,
    repository: OPEN_DESIGN_ACCEPTANCE_REPOSITORY,
    requiredCiPassed: true,
    rollbackExercisePassed: true,
    schemaVersion: 2,
    visualEvidence: authorityEvidence.visualDecisions,
  }
}

function parseCliArguments(arguments_: readonly string[]): {
  input: string
  hostHeadSha: string
  output: string
} {
  if (arguments_.length !== 6) fail('CLI arguments')
  const values = new Map<string, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (!key || !value || !['--input', '--host-head-sha', '--output'].includes(key) || values.has(key)) {
      fail('CLI arguments')
    }
    values.set(key, value)
  }
  const input = values.get('--input')
  const hostHeadSha = values.get('--host-head-sha')
  const output = values.get('--output')
  if (!input || !hostHeadSha || !output || input === output) fail('CLI arguments')
  return { input, hostHeadSha, output }
}

async function main(): Promise<void> {
  const { input, hostHeadSha, output } = parseCliArguments(process.argv.slice(2))
  const metadata = await stat(input)
  if (
    !metadata.isFile() || metadata.size < 3 ||
    metadata.size > OPEN_DESIGN_ACCEPTANCE_MAX_INPUT_BYTES
  ) fail('input file')
  const source = await readFile(input, 'utf8')
  const parsed: unknown = JSON.parse(source)
  if (source !== `${JSON.stringify(parsed)}\n`) fail('input canonical JSON')
  const summary = validateAndSummarizeOpenDesignRcAcceptanceIntake(parsed, hostHeadSha)
  await writeFile(output, `${JSON.stringify(summary)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await chmod(output, 0o600)
}

if (import.meta.main) {
  void main().catch(() => {
    process.stderr.write('OpenDesign acceptance evidence validation failed.\n')
    process.exitCode = 1
  })
}
