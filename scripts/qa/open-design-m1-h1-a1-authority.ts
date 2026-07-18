#!/usr/bin/env bun

import { createHmac, randomBytes } from 'node:crypto'
import {
  chmod,
  mkdir,
  rm,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  COMMIT_SHA_PATTERN,
  SHA256_PATTERN,
  canonicalJson,
  canonicalTimestamp,
  evidenceFailure,
  exactKeys,
  inventoryOwnerOnlyFiles,
  objectAt,
  publishOwnerOnlyDirectory,
  readOwnerOnlyBoundedFile,
  readOwnerOnlyCanonicalJson,
  requireOwnerOnlyDirectory,
  sha256,
  stringAt,
  writeOwnerOnlyNewFile,
  type JsonObject,
} from './open-design-m1-local-evidence'

const KIND = 'OpenDesign M1 H1-A1 authority'
const AUTHORITY_KIND = 'open-design-m1-h1-a1-authority'
const CLAIM_KIND = 'open-design-m1-h1-a1-claim'
const CONNECTION_KIND = 'open-design-m1-h1-connection-evidence'
const PREFLIGHT_KIND = 'open-design-m1-h1-preflight-evidence'
const AUTHORITY_PATH = 'authority.json' as const
const AUTHORITY_ROOT_NAME = 'authority' as const
const PENDING_ROOT_NAME = 'pending' as const
const KEY_PATH = 'authority-key.bin' as const
const CHECKSUMS_PATH = 'SHA256SUMS' as const
const CLAIM_PATH = 'claim.json' as const
const CONNECTION_PATH = 'h1-connection.json' as const
const PREFLIGHT_PATH = 'h1-preflight.json' as const
const MAX_JSON_BYTES = 64 * 1024
const SERVICE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/

export interface H1A1ReleaseIdentity {
  readonly sourceSha: string
  readonly hostBuildRunId: number
  readonly hostArtifactId: number
  readonly hostArtifactName: string
  readonly hostArtifactDigest: string
}

export interface H1A1EvidenceIdentity {
  readonly preflightRootRealpath: string
  readonly preflightSha256: string
  readonly connectionRootRealpath: string
  readonly connectionSha256: string
}

export interface H1A1AcceptanceRoots {
  readonly homeRealpath: string
  readonly configRealpath: string
  readonly userDataRealpath: string
  readonly profileRealpath: string
}

export interface H1A1AuthoritySealInput {
  readonly pendingRoot: string
  readonly authorityRoot: string
  readonly release: H1A1ReleaseIdentity
  readonly evidence: H1A1EvidenceIdentity
  readonly acceptance: H1A1AcceptanceRoots
}

export interface H1A1AuthorityExpected {
  readonly sourceSha: string
  readonly hostBuildRunId: number
  readonly hostArtifactId: number
  readonly hostArtifactName: string
  readonly hostArtifactDigest: string
  readonly handoffSha256: string
  readonly connectionSha256: string
}

export interface H1A1ClaimInput extends H1A1AuthorityExpected {
  readonly authorityRoot: string
  readonly producerRunId: number
  readonly producerRunAttempt: number
  readonly now?: () => number
}

export interface H1A1ClaimExpected extends H1A1AuthorityExpected {
  readonly producerRunId: number
  readonly producerRunAttempt: number
  readonly now?: () => number
}

export interface H1A1AuthorityResult {
  readonly authorityRootRealpath: string
  readonly authorityObjectPath: typeof AUTHORITY_PATH
  readonly authoritySha256: string
  readonly authorityKeyRealpath: string
  readonly authorityHmacSha256: string
  readonly connectionSha256: string
  readonly acceptance: H1A1AcceptanceRoots
}

export interface H1A1ClaimResult extends H1A1AuthorityResult {
  readonly claimFileRealpath: string
  readonly producerRunId: number
  readonly producerRunAttempt: number
  readonly claimedAt: string
}

function positiveInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 1) evidenceFailure(KIND, path)
  return value
}

function validateRelease(value: H1A1ReleaseIdentity): void {
  if (!COMMIT_SHA_PATTERN.test(value.sourceSha)
    || !SERVICE_DIGEST_PATTERN.test(value.hostArtifactDigest)
    || !ARTIFACT_NAME_PATTERN.test(value.hostArtifactName)) {
    evidenceFailure(KIND, 'release')
  }
  positiveInteger(value.hostBuildRunId, 'release.hostBuildRunId')
  positiveInteger(value.hostArtifactId, 'release.hostArtifactId')
}

async function canonicalAcceptanceRoots(input: H1A1AcceptanceRoots): Promise<H1A1AcceptanceRoots> {
  const [homeRealpath, configRealpath, userDataRealpath, profileRealpath] = await Promise.all([
    requireOwnerOnlyDirectory(input.homeRealpath, KIND, 'acceptance.homeRealpath'),
    requireOwnerOnlyDirectory(input.configRealpath, KIND, 'acceptance.configRealpath'),
    requireOwnerOnlyDirectory(input.userDataRealpath, KIND, 'acceptance.userDataRealpath'),
    requireOwnerOnlyDirectory(input.profileRealpath, KIND, 'acceptance.profileRealpath'),
  ])
  if (homeRealpath === configRealpath || homeRealpath === userDataRealpath
    || homeRealpath === profileRealpath || configRealpath === userDataRealpath
    || configRealpath === profileRealpath) {
    evidenceFailure(KIND, 'acceptance roots', 'must isolate HOME and config from runtime data')
  }
  return Object.freeze({ homeRealpath, configRealpath, userDataRealpath, profileRealpath })
}

async function readExactKey(rootInput: string): Promise<{
  readonly root: string
  readonly bytes: Buffer
  readonly sha256: string
}> {
  const root = await inventoryOwnerOnlyFiles(rootInput, [CHECKSUMS_PATH, KEY_PATH], KIND)
  const bytes = await readOwnerOnlyBoundedFile(join(root, KEY_PATH), 32, KIND, KEY_PATH)
  if (bytes.byteLength !== 32) evidenceFailure(KIND, KEY_PATH, 'must contain exactly 32 bytes')
  const digest = sha256(bytes)
  const sums = await readOwnerOnlyBoundedFile(join(root, CHECKSUMS_PATH), 256, KIND, CHECKSUMS_PATH)
  if (sums.toString('utf8') !== `${digest}  ${KEY_PATH}\n`) evidenceFailure(KIND, CHECKSUMS_PATH)
  return Object.freeze({ root, bytes, sha256: digest })
}

async function readEvidenceObject(
  rootInput: string,
  objectPath: typeof PREFLIGHT_PATH | typeof CONNECTION_PATH,
  expectedSha256: string,
): Promise<{ readonly root: string; readonly proof: JsonObject; readonly sha256: string }> {
  if (!SHA256_PATTERN.test(expectedSha256)) evidenceFailure(KIND, `${objectPath}.expectedSha256`)
  const root = await inventoryOwnerOnlyFiles(rootInput, [CHECKSUMS_PATH, objectPath], KIND)
  const proof = objectAt(
    await readOwnerOnlyCanonicalJson(join(root, objectPath), MAX_JSON_BYTES, KIND, objectPath),
    `$${objectPath}`, KIND,
  )
  const source = canonicalJson(proof)
  const digest = sha256(source)
  if (digest !== expectedSha256) evidenceFailure(KIND, objectPath, 'does not match the expected public hash')
  const sums = await readOwnerOnlyBoundedFile(join(root, CHECKSUMS_PATH), 256, KIND, CHECKSUMS_PATH)
  if (sums.toString('utf8') !== `${digest}  ${objectPath}\n`) evidenceFailure(KIND, CHECKSUMS_PATH)
  return Object.freeze({ root, proof, sha256: digest })
}

function preflightRelease(proof: JsonObject, expected: H1A1ReleaseIdentity): void {
  exactKeys(proof, ['authority', 'kind', 'launch', 'observation', 'schemaVersion', 'staging'], '$preflight', KIND)
  if (proof.schemaVersion !== 2 || proof.kind !== PREFLIGHT_KIND) evidenceFailure(KIND, '$preflight')
  const authority = objectAt(proof.authority, '$preflight.authority', KIND)
  if (authority.sourceSha !== expected.sourceSha
    || authority.hostBuildRunId !== expected.hostBuildRunId
    || authority.hostArtifactId !== expected.hostArtifactId
    || authority.hostArtifactName !== expected.hostArtifactName
    || authority.hostArtifactDigest !== expected.hostArtifactDigest) {
    evidenceFailure(KIND, '$preflight.authority', 'does not match the requested release')
  }
  const observation = objectAt(proof.observation, '$preflight.observation', KIND)
  if (observation.verifierDidNotSendTurn !== true) evidenceFailure(KIND, '$preflight.observation')
}

function connectionBinding(
  proof: JsonObject,
  preflightRoot: string,
  preflightSha256: string,
  authorityKey: Uint8Array,
): string {
  exactKeys(proof, ['connectionAuthority', 'kind', 'observation', 'preflight', 'schemaVersion'], '$connection', KIND)
  if (proof.schemaVersion !== 3 || proof.kind !== CONNECTION_KIND) evidenceFailure(KIND, '$connection')
  const preflight = objectAt(proof.preflight, '$connection.preflight', KIND)
  exactKeys(preflight, ['objectPath', 'rootRealpath', 'sha256'], '$connection.preflight', KIND)
  if (preflight.rootRealpath !== preflightRoot || preflight.objectPath !== PREFLIGHT_PATH
    || preflight.sha256 !== preflightSha256) {
    evidenceFailure(KIND, '$connection.preflight', 'does not bind the exact preflight')
  }
  const authority = objectAt(proof.connectionAuthority, '$connection.connectionAuthority', KIND)
  exactKeys(authority, [
    'authenticated', 'authorityHmacSha256', 'authorityKeyCommitmentSha256', 'schemaVersion',
  ], '$connection.connectionAuthority', KIND)
  const hmac = stringAt(authority, 'authorityHmacSha256', '$connection.connectionAuthority', KIND)
  const commitment = stringAt(
    authority, 'authorityKeyCommitmentSha256', '$connection.connectionAuthority', KIND,
  )
  const expectedCommitment = createHmac('sha256', authorityKey)
    .update('open-design-m1-h1-a1-authority-v1\0', 'utf8')
    .update(hmac, 'utf8')
    .digest('hex')
  if (authority.schemaVersion !== 1 || authority.authenticated !== true || !SHA256_PATTERN.test(hmac)) {
    evidenceFailure(KIND, '$connection.connectionAuthority')
  }
  if (!SHA256_PATTERN.test(commitment) || commitment !== expectedCommitment) {
    evidenceFailure(KIND, '$connection.connectionAuthority', 'does not prove possession of the pending authority key')
  }
  const observation = objectAt(proof.observation, '$connection.observation', KIND)
  exactKeys(observation, ['observedAt', 'verifierDidNotSendTurn'], '$connection.observation', KIND)
  canonicalTimestamp(stringAt(observation, 'observedAt', '$connection.observation', KIND), '$connection.observation.observedAt', KIND)
  if (observation.verifierDidNotSendTurn !== true) evidenceFailure(KIND, '$connection.observation')
  return hmac
}

function authorityManifest(
  release: H1A1ReleaseIdentity,
  evidence: H1A1EvidenceIdentity,
  acceptance: H1A1AcceptanceRoots,
  authorityHmacSha256: string,
  keySha256: string,
): JsonObject {
  return {
    schemaVersion: 1,
    kind: AUTHORITY_KIND,
    release,
    evidence,
    acceptance,
    connectionAuthority: {
      schemaVersion: 1,
      authenticated: true,
      authorityHmacSha256,
    },
    key: {
      objectPath: KEY_PATH,
      bytes: 32,
      sha256: keySha256,
    },
  }
}

export async function initializeOpenDesignM1H1A1Authority(
  pendingRootInput: string,
  randomKey: () => Uint8Array = () => randomBytes(32),
): Promise<{ readonly pendingRootRealpath: string; readonly authorityKeyRealpath: string }> {
  if (basename(resolve(pendingRootInput)) !== PENDING_ROOT_NAME) {
    evidenceFailure(KIND, 'pending root', `must use the fixed ${PENDING_ROOT_NAME} path`)
  }
  const key = Buffer.from(randomKey())
  if (key.byteLength !== 32) evidenceFailure(KIND, 'generated authority key', 'must contain exactly 32 bytes')
  const digest = sha256(key)
  await publishOwnerOnlyDirectory(pendingRootInput, KIND, async (temporaryRoot) => {
    await writeOwnerOnlyNewFile(join(temporaryRoot, KEY_PATH), key)
    await writeOwnerOnlyNewFile(join(temporaryRoot, CHECKSUMS_PATH), `${digest}  ${KEY_PATH}\n`)
    await readExactKey(temporaryRoot)
  })
  const root = await requireOwnerOnlyDirectory(pendingRootInput, KIND, 'pending root')
  return Object.freeze({ pendingRootRealpath: root, authorityKeyRealpath: join(root, KEY_PATH) })
}

async function validateAuthorityDirectory(
  authorityRootInput: string,
  expected?: H1A1AuthorityExpected,
  allowPublicationTemporaryRoot = false,
): Promise<H1A1AuthorityResult> {
  const root = await inventoryOwnerOnlyFiles(
    authorityRootInput, [AUTHORITY_PATH, CHECKSUMS_PATH, KEY_PATH], KIND,
  )
  if (!allowPublicationTemporaryRoot && basename(root) !== AUTHORITY_ROOT_NAME) {
    evidenceFailure(KIND, 'authority root', `must use the fixed ${AUTHORITY_ROOT_NAME} path`)
  }
  const manifest = objectAt(
    await readOwnerOnlyCanonicalJson(join(root, AUTHORITY_PATH), MAX_JSON_BYTES, KIND, AUTHORITY_PATH),
    '$authority', KIND,
  )
  exactKeys(manifest, [
    'acceptance', 'connectionAuthority', 'evidence', 'key', 'kind', 'release', 'schemaVersion',
  ], '$authority', KIND)
  if (manifest.schemaVersion !== 1 || manifest.kind !== AUTHORITY_KIND) evidenceFailure(KIND, '$authority')
  const release = objectAt(manifest.release, '$authority.release', KIND)
  exactKeys(release, [
    'hostArtifactDigest', 'hostArtifactId', 'hostArtifactName', 'hostBuildRunId', 'sourceSha',
  ], '$authority.release', KIND)
  const typedRelease = release as unknown as H1A1ReleaseIdentity
  validateRelease(typedRelease)
  const evidence = objectAt(manifest.evidence, '$authority.evidence', KIND)
  exactKeys(evidence, [
    'connectionRootRealpath', 'connectionSha256', 'preflightRootRealpath', 'preflightSha256',
  ], '$authority.evidence', KIND)
  for (const key of ['connectionSha256', 'preflightSha256'] as const) {
    if (!SHA256_PATTERN.test(stringAt(evidence, key, '$authority.evidence', KIND))) {
      evidenceFailure(KIND, `$authority.evidence.${key}`)
    }
  }
  const preflightRootRealpath = stringAt(
    evidence, 'preflightRootRealpath', '$authority.evidence', KIND,
  )
  const connectionRootRealpath = stringAt(
    evidence, 'connectionRootRealpath', '$authority.evidence', KIND,
  )
  const acceptanceObject = objectAt(manifest.acceptance, '$authority.acceptance', KIND)
  exactKeys(acceptanceObject, [
    'configRealpath', 'homeRealpath', 'profileRealpath', 'userDataRealpath',
  ], '$authority.acceptance', KIND)
  const acceptance = await canonicalAcceptanceRoots(acceptanceObject as unknown as H1A1AcceptanceRoots)
  const connectionAuthority = objectAt(manifest.connectionAuthority, '$authority.connectionAuthority', KIND)
  exactKeys(connectionAuthority, [
    'authenticated', 'authorityHmacSha256', 'schemaVersion',
  ], '$authority.connectionAuthority', KIND)
  const authorityHmacSha256 = stringAt(
    connectionAuthority, 'authorityHmacSha256', '$authority.connectionAuthority', KIND,
  )
  if (connectionAuthority.schemaVersion !== 1 || connectionAuthority.authenticated !== true
    || !SHA256_PATTERN.test(authorityHmacSha256)) evidenceFailure(KIND, '$authority.connectionAuthority')
  const keyObject = objectAt(manifest.key, '$authority.key', KIND)
  exactKeys(keyObject, ['bytes', 'objectPath', 'sha256'], '$authority.key', KIND)
  const keyBytes = await readOwnerOnlyBoundedFile(join(root, KEY_PATH), 32, KIND, KEY_PATH)
  if (keyObject.objectPath !== KEY_PATH || keyObject.bytes !== 32 || keyBytes.byteLength !== 32
    || keyObject.sha256 !== sha256(keyBytes)) evidenceFailure(KIND, '$authority.key')
  const source = canonicalJson(manifest)
  const authoritySha256 = sha256(source)
  const sums = await readOwnerOnlyBoundedFile(join(root, CHECKSUMS_PATH), 512, KIND, CHECKSUMS_PATH)
  if (sums.toString('utf8') !== `${sha256(keyBytes)}  ${KEY_PATH}\n${authoritySha256}  ${AUTHORITY_PATH}\n`) {
    evidenceFailure(KIND, CHECKSUMS_PATH)
  }
  const preflight = await readEvidenceObject(
    preflightRootRealpath, PREFLIGHT_PATH, evidence.preflightSha256 as string,
  )
  preflightRelease(preflight.proof, typedRelease)
  const launch = objectAt(preflight.proof.launch, '$preflight.launch', KIND)
  if (launch.configRealpath !== acceptance.configRealpath
    || launch.profileRealpath !== acceptance.profileRealpath
    || acceptance.userDataRealpath !== acceptance.profileRealpath) {
    evidenceFailure(KIND, '$preflight.launch', 'does not bind the canonical acceptance roots')
  }
  const connection = await readEvidenceObject(
    connectionRootRealpath, CONNECTION_PATH, evidence.connectionSha256 as string,
  )
  if (connectionBinding(connection.proof, preflight.root, preflight.sha256, keyBytes)
    !== authorityHmacSha256) {
    evidenceFailure(KIND, '$authority.connectionAuthority', 'does not match the H1 evidence')
  }
  if (expected && (typedRelease.sourceSha !== expected.sourceSha
    || typedRelease.hostBuildRunId !== expected.hostBuildRunId
    || typedRelease.hostArtifactId !== expected.hostArtifactId
    || typedRelease.hostArtifactName !== expected.hostArtifactName
    || typedRelease.hostArtifactDigest !== expected.hostArtifactDigest
    || authoritySha256 !== expected.handoffSha256
    || evidence.connectionSha256 !== expected.connectionSha256)) {
    evidenceFailure(KIND, '$authority', 'does not match the expected handoff authority')
  }
  return Object.freeze({
    authorityRootRealpath: root,
    authorityObjectPath: AUTHORITY_PATH,
    authoritySha256,
    authorityKeyRealpath: join(root, KEY_PATH),
    authorityHmacSha256,
    connectionSha256: evidence.connectionSha256 as string,
    acceptance,
  })
}

export async function validateOpenDesignM1H1A1Authority(
  authorityRootInput: string,
  expected?: H1A1AuthorityExpected,
): Promise<H1A1AuthorityResult> {
  return validateAuthorityDirectory(authorityRootInput, expected)
}

export async function sealOpenDesignM1H1A1Authority(
  input: H1A1AuthoritySealInput,
): Promise<H1A1AuthorityResult> {
  validateRelease(input.release)
  const key = await readExactKey(input.pendingRoot)
  if (basename(key.root) !== PENDING_ROOT_NAME
    || resolve(input.authorityRoot) !== join(dirname(key.root), AUTHORITY_ROOT_NAME)) {
    evidenceFailure(KIND, 'authority root', 'must be the fixed sibling of the pending capsule')
  }
  const acceptance = await canonicalAcceptanceRoots(input.acceptance)
  const preflight = await readEvidenceObject(
    input.evidence.preflightRootRealpath, PREFLIGHT_PATH, input.evidence.preflightSha256,
  )
  preflightRelease(preflight.proof, input.release)
  const launch = objectAt(preflight.proof.launch, '$preflight.launch', KIND)
  if (launch.configRealpath !== acceptance.configRealpath
    || launch.profileRealpath !== acceptance.profileRealpath
    || acceptance.userDataRealpath !== acceptance.profileRealpath) {
    evidenceFailure(KIND, '$preflight.launch', 'does not bind the canonical acceptance roots')
  }
  const connection = await readEvidenceObject(
    input.evidence.connectionRootRealpath, CONNECTION_PATH, input.evidence.connectionSha256,
  )
  const authorityHmacSha256 = connectionBinding(
    connection.proof, preflight.root, preflight.sha256, key.bytes,
  )
  const evidence = Object.freeze({
    preflightRootRealpath: preflight.root,
    preflightSha256: preflight.sha256,
    connectionRootRealpath: connection.root,
    connectionSha256: connection.sha256,
  })
  const source = canonicalJson(authorityManifest(
    input.release, evidence, acceptance, authorityHmacSha256, key.sha256,
  ))
  const authoritySha256 = sha256(source)
  await publishOwnerOnlyDirectory(input.authorityRoot, KIND, async (temporaryRoot) => {
    await writeOwnerOnlyNewFile(join(temporaryRoot, AUTHORITY_PATH), source)
    await writeOwnerOnlyNewFile(join(temporaryRoot, KEY_PATH), key.bytes)
    await writeOwnerOnlyNewFile(
      join(temporaryRoot, CHECKSUMS_PATH),
      `${key.sha256}  ${KEY_PATH}\n${authoritySha256}  ${AUTHORITY_PATH}\n`,
    )
    await validateAuthorityDirectory(temporaryRoot, undefined, true)
  })
  const result = await validateAuthorityDirectory(input.authorityRoot, {
    ...input.release,
    handoffSha256: authoritySha256,
    connectionSha256: connection.sha256,
  })
  const pendingAgain = await readExactKey(key.root)
  if (pendingAgain.sha256 !== key.sha256) evidenceFailure(KIND, 'pending authority key', 'changed before retirement')
  await rm(key.root, { recursive: true, force: false })
  return result
}

async function claimsRoot(authorityRoot: string): Promise<string> {
  const parent = await requireOwnerOnlyDirectory(dirname(authorityRoot), KIND, 'authority parent')
  const root = join(parent, 'claims')
  try {
    await mkdir(root, { mode: 0o700 })
    await chmod(root, 0o700)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return requireOwnerOnlyDirectory(root, KIND, 'claims root')
}

export async function claimOpenDesignM1H1A1Authority(input: H1A1ClaimInput): Promise<H1A1ClaimResult> {
  positiveInteger(input.producerRunId, 'producerRunId')
  positiveInteger(input.producerRunAttempt, 'producerRunAttempt')
  const authority = await validateAuthorityDirectory(input.authorityRoot, input)
  const root = await claimsRoot(authority.authorityRootRealpath)
  const claimRoot = join(root, authority.authoritySha256)
  try {
    await mkdir(claimRoot, { mode: 0o700 })
    await chmod(claimRoot, 0o700)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      evidenceFailure(KIND, 'claim', 'was already attempted and cannot be reused')
    }
    throw error
  }
  const claimedAt = new Date((input.now ?? (() => Date.now()))()).toISOString()
  canonicalTimestamp(claimedAt, '$claim.claimedAt', KIND)
  const claim = {
    schemaVersion: 1,
    kind: CLAIM_KIND,
    authorityRootRealpath: authority.authorityRootRealpath,
    authoritySha256: authority.authoritySha256,
    authorityKeyRealpath: authority.authorityKeyRealpath,
    authorityHmacSha256: authority.authorityHmacSha256,
    connectionSha256: authority.connectionSha256,
    acceptance: authority.acceptance,
    producerRunId: input.producerRunId,
    producerRunAttempt: input.producerRunAttempt,
    claimedAt,
  }
  const claimFileRealpath = join(claimRoot, CLAIM_PATH)
  await writeOwnerOnlyNewFile(claimFileRealpath, canonicalJson(claim))
  return validateOpenDesignM1H1A1Claim(claimFileRealpath, input)
}

export async function validateOpenDesignM1H1A1Claim(
  claimFileInput: string,
  expected: H1A1ClaimExpected,
): Promise<H1A1ClaimResult> {
  positiveInteger(expected.producerRunId, 'producerRunId')
  positiveInteger(expected.producerRunAttempt, 'producerRunAttempt')
  const claimFile = resolve(claimFileInput)
  if (basename(claimFile) !== CLAIM_PATH) evidenceFailure(KIND, 'claim file')
  const claimRoot = await inventoryOwnerOnlyFiles(dirname(claimFile), [CLAIM_PATH], KIND)
  const canonicalClaimsRoot = await requireOwnerOnlyDirectory(dirname(claimRoot), KIND, 'claims root')
  const claim = objectAt(
    await readOwnerOnlyCanonicalJson(claimFile, MAX_JSON_BYTES, KIND, CLAIM_PATH), '$claim', KIND,
  )
  exactKeys(claim, [
    'acceptance', 'authorityHmacSha256', 'authorityKeyRealpath', 'authorityRootRealpath',
    'authoritySha256', 'claimedAt', 'connectionSha256', 'kind', 'producerRunAttempt',
    'producerRunId', 'schemaVersion',
  ], '$claim', KIND)
  const authorityRootRealpath = stringAt(claim, 'authorityRootRealpath', '$claim', KIND)
  const authoritySha256 = stringAt(claim, 'authoritySha256', '$claim', KIND)
  const claimedAt = stringAt(claim, 'claimedAt', '$claim', KIND)
  const claimedAtMs = canonicalTimestamp(claimedAt, '$claim.claimedAt', KIND)
  if (claim.schemaVersion !== 1 || claim.kind !== CLAIM_KIND
    || !SHA256_PATTERN.test(authoritySha256)
    || authoritySha256 !== expected.handoffSha256
    || basename(claimRoot) !== authoritySha256
    || canonicalClaimsRoot !== join(dirname(authorityRootRealpath), 'claims')
    || claim.producerRunId !== expected.producerRunId
    || claim.producerRunAttempt !== expected.producerRunAttempt
    || claimedAtMs > (expected.now ?? (() => Date.now()))()) {
    evidenceFailure(KIND, '$claim', 'does not match the one-time producer claim')
  }
  const authority = await validateAuthorityDirectory(authorityRootRealpath, expected)
  if (claim.authorityKeyRealpath !== authority.authorityKeyRealpath
    || claim.authorityHmacSha256 !== authority.authorityHmacSha256
    || claim.connectionSha256 !== authority.connectionSha256
    || canonicalJson(claim.acceptance) !== canonicalJson(authority.acceptance)) {
    evidenceFailure(KIND, '$claim', 'does not match the sealed authority')
  }
  return Object.freeze({
    ...authority,
    claimFileRealpath: claimFile,
    producerRunId: expected.producerRunId,
    producerRunAttempt: expected.producerRunAttempt,
    claimedAt,
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

function required(args: Map<string, string>, key: string): string {
  const value = args.get(key)
  if (!value) evidenceFailure(KIND, `arguments.${key}`)
  return value
}

function integerArg(args: Map<string, string>, key: string): number {
  const source = required(args, key)
  if (!/^[1-9][0-9]*$/.test(source)) evidenceFailure(KIND, `arguments.${key}`)
  return positiveInteger(Number(source), `arguments.${key}`)
}

function exactArgs(args: Map<string, string>, expected: readonly string[]): void {
  if ([...args.keys()].sort().join('\n') !== [...expected].sort().join('\n')) evidenceFailure(KIND, 'arguments')
}

function releaseArgs(args: Map<string, string>): H1A1ReleaseIdentity {
  return {
    sourceSha: required(args, '--source-sha'),
    hostBuildRunId: integerArg(args, '--host-build-run-id'),
    hostArtifactId: integerArg(args, '--host-artifact-id'),
    hostArtifactName: required(args, '--host-artifact-name'),
    hostArtifactDigest: required(args, '--host-artifact-digest'),
  }
}

const RELEASE_KEYS = Object.freeze([
  '--source-sha', '--host-build-run-id', '--host-artifact-id', '--host-artifact-name', '--host-artifact-digest',
])

async function main(): Promise<void> {
  const [command, ...rest] = Bun.argv.slice(2)
  const args = parseArgs(rest)
  if (command === 'init') {
    exactArgs(args, ['--pending-root'])
    process.stdout.write(canonicalJson(await initializeOpenDesignM1H1A1Authority(required(args, '--pending-root'))))
    return
  }
  if (command === 'seal') {
    exactArgs(args, [
      ...RELEASE_KEYS, '--acceptance-home', '--authority-root', '--config', '--connection-root',
      '--connection-sha256', '--pending-root', '--preflight-root', '--preflight-sha256', '--profile', '--user-data',
    ])
    process.stdout.write(canonicalJson(await sealOpenDesignM1H1A1Authority({
      pendingRoot: required(args, '--pending-root'),
      authorityRoot: required(args, '--authority-root'),
      release: releaseArgs(args),
      evidence: {
        preflightRootRealpath: required(args, '--preflight-root'),
        preflightSha256: required(args, '--preflight-sha256'),
        connectionRootRealpath: required(args, '--connection-root'),
        connectionSha256: required(args, '--connection-sha256'),
      },
      acceptance: {
        homeRealpath: required(args, '--acceptance-home'),
        configRealpath: required(args, '--config'),
        userDataRealpath: required(args, '--user-data'),
        profileRealpath: required(args, '--profile'),
      },
    })))
    return
  }
  if (command === 'claim') {
    exactArgs(args, [
      ...RELEASE_KEYS, '--authority-root', '--connection-sha256', '--handoff-sha256',
      '--producer-run-attempt', '--producer-run-id',
    ])
    process.stdout.write(canonicalJson(await claimOpenDesignM1H1A1Authority({
      authorityRoot: required(args, '--authority-root'),
      ...releaseArgs(args),
      handoffSha256: required(args, '--handoff-sha256'),
      connectionSha256: required(args, '--connection-sha256'),
      producerRunId: integerArg(args, '--producer-run-id'),
      producerRunAttempt: integerArg(args, '--producer-run-attempt'),
    })))
    return
  }
  evidenceFailure(KIND, 'arguments.command')
}

if (import.meta.main) await main()
