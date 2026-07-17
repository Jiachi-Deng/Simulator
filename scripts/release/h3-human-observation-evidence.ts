import { createHash } from "node:crypto"
import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import sharp from "sharp"
import {
  H3_SYSTEM_EXECUTABLES,
  runH3SystemCommand,
  type H3PostInstallEvidence,
} from "./h3-post-install-evidence"
import {
  systemH3AuthorityAuthenticator,
  verifyH3PostInstallAuthorityClosure,
  type H3AuthorityAuthenticator,
} from "./h3-post-install-authority"
import { SIGNED_CANDIDATE_NAME_PATTERN } from "./signed-host-candidate"

const SHA256 = /^[0-9a-f]{64}$/
const SOURCE_SHA = /^[0-9a-f]{40}$/
const POSITIVE_ID = /^[1-9][0-9]*$/
const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/
const CANONICAL_UTC = /^\d{4}-(?:0[1-9]|1[0-2])-(?:[0-2]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024
const MAX_SCREENSHOT_DIMENSION = 8_192
const MAX_SCREENSHOT_PIXELS = 16_777_216
const INSTALLED_APP = "/Applications/Simulator.app" as const

export const H3_HUMAN_OBSERVATION_IDS = Object.freeze([
  "CraftVisible",
  "OpenDesignModuleEntryVisible",
  "OpenDesignSecondLoginAbsent",
] as const)

export const H3_HUMAN_OBSERVATION_CLOSURE = Object.freeze([
  "SHA256SUMS",
  "human-observation.json",
  "screenshots/CraftVisible.png",
  "screenshots/OpenDesignModuleEntryVisible.png",
  "screenshots/OpenDesignSecondLoginAbsent.png",
] as const)

type ObservationId = typeof H3_HUMAN_OBSERVATION_IDS[number]
type RecordValue = Record<string, unknown>

export interface H3HumanObservationInputItem {
  id: ObservationId
  passed: true
  observedAt: string
  screenshotPath: string
}

export interface H3HumanObservationInput {
  schemaVersion: 1
  observations: H3HumanObservationInputItem[]
}

export interface H3HumanObservationEvidence {
  schemaVersion: 1
  kind: "simulator-h3-human-observation"
  authority: {
    sourceSha: string
    hostBuildRunId: string
    artifactName: string
    artifactId: string
    artifactDigest: string
    dmgBytes: number
    dmgSha256: string
    rawCandidateSha256: string
    postInstallAuthoritySha256: string
    postInstallSha256: string
  }
  createdAt: string
  observations: Array<{
    id: ObservationId
    passed: true
    observedAt: string
    screenshot: { path: string; bytes: number; sha256: string }
  }>
  recovery: {
    required: boolean
    status: "PASS" | "NOT NEEDED"
    installedPath: typeof INSTALLED_APP
    backupPath: string
    backupIdentitySha256: string
    restoredIdentitySha256: string
  }
}

export interface H3RecoveryInspector {
  exactTreeSha256(installedAppPath: typeof INSTALLED_APP): string
}

export interface H3HumanObservationDependencies {
  recoveryInspector: H3RecoveryInspector
  authenticator: H3AuthorityAuthenticator
  now: () => Date
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function exactKeys(value: RecordValue, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} keys differ`)
  }
}

function string(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

export function validateExpectedH3Stage1AuthoritySha256(value: unknown): string {
  return string(value, SHA256, "expected Stage-1 authority SHA-256")
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Invalid ${label}`)
  return value as number
}

function canonicalTimestamp(value: unknown, label: string): string {
  const timestamp = string(value, CANONICAL_UTC, label)
  if (new Date(timestamp).toISOString() !== timestamp) throw new Error(`${label} is not canonical UTC`)
  return timestamp
}

function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function assertNoSecretShapedFields(value: unknown): void {
  const encoded = JSON.stringify(value)
  if (/-----BEGIN [^-]*PRIVATE KEY-----|\b(?:gh[opsu]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b|app-specific-password|(?:api|access|auth)[_-]?token/i.test(encoded)) {
    throw new Error("H3 human observation contains secret-shaped fields")
  }
}

function assertOwnerOnlyDirectory(path: string, empty = false): string {
  const absolute = resolve(path)
  const metadata = lstatSync(absolute)
  if (path !== absolute || !metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(absolute) !== absolute
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    || (metadata.mode & 0o777) !== 0o700 || (empty && readdirSync(absolute).length !== 0)) {
    throw new Error("H3 human observation directory must be real, owner-only, canonical, and empty when required")
  }
  return absolute
}

function ownerOnlyFile(path: string, label: string, maximumBytes: number): { path: string; bytes: Buffer } {
  const absolute = resolve(path)
  const metadata = lstatSync(absolute)
  if (path !== absolute || !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || realpathSync(absolute) !== absolute
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    || (metadata.mode & 0o777) !== 0o600 || metadata.size < 1 || metadata.size > maximumBytes) {
    throw new Error(`${label} must be one owner-only canonical regular file`)
  }
  return { path: absolute, bytes: readFileSync(absolute) }
}

function writeOwnerOnlyFile(path: string, bytes: string | Buffer): void {
  const descriptor = openSync(path, "wx", 0o600)
  try {
    fchmodSync(descriptor, 0o600)
    writeFileSync(descriptor, bytes)
  } finally {
    closeSync(descriptor)
  }
}

export function canonicalH3HumanObservationInput(input: H3HumanObservationInput): string {
  return `${stable(input)}\n`
}

export function canonicalH3HumanObservationEvidence(evidence: H3HumanObservationEvidence): string {
  return `${stable(evidence)}\n`
}

export function validateH3HumanObservationInput(value: unknown): H3HumanObservationInput {
  const input = record(value, "H3 human observation input")
  exactKeys(input, ["observations", "schemaVersion"], "H3 human observation input")
  if (input.schemaVersion !== 1 || !Array.isArray(input.observations)
    || input.observations.length !== H3_HUMAN_OBSERVATION_IDS.length) {
    throw new Error("H3 human observation input must contain exactly three observations")
  }
  const observations = input.observations.map((candidate, index) => {
    const item = record(candidate, `observations[${index}]`)
    exactKeys(item, ["id", "observedAt", "passed", "screenshotPath"], `observations[${index}]`)
    const expectedId = H3_HUMAN_OBSERVATION_IDS[index]!
    if (item.id !== expectedId || item.passed !== true) {
      throw new Error(`H3 observation ${expectedId} must be an explicit PASS in canonical order`)
    }
    const screenshotPath = string(item.screenshotPath, /^\/[^\n\r]+\.png$/, `${expectedId}.screenshotPath`)
    if (!isAbsolute(screenshotPath)) throw new Error(`${expectedId} screenshot path must be absolute`)
    return {
      id: expectedId,
      passed: true as const,
      observedAt: canonicalTimestamp(item.observedAt, `${expectedId}.observedAt`),
      screenshotPath,
    }
  })
  for (let index = 1; index < observations.length; index += 1) {
    if (Date.parse(observations[index]!.observedAt) < Date.parse(observations[index - 1]!.observedAt)) {
      throw new Error("H3 observation timestamps must be nondecreasing in canonical order")
    }
  }
  const result = { schemaVersion: 1 as const, observations }
  assertNoSecretShapedFields(result)
  return result
}

export function validateH3HumanObservationEvidence(value: unknown): H3HumanObservationEvidence {
  const evidence = record(value, "H3 human observation evidence")
  exactKeys(evidence, ["authority", "createdAt", "kind", "observations", "recovery", "schemaVersion"], "H3 human observation evidence")
  if (evidence.schemaVersion !== 1 || evidence.kind !== "simulator-h3-human-observation") {
    throw new Error("H3 human observation evidence identity differs")
  }
  const authority = record(evidence.authority, "authority")
  exactKeys(authority, [
    "artifactDigest", "artifactId", "artifactName", "dmgBytes", "dmgSha256", "hostBuildRunId",
    "postInstallAuthoritySha256", "postInstallSha256", "rawCandidateSha256", "sourceSha",
  ], "authority")
  string(authority.hostBuildRunId, POSITIVE_ID, "authority.hostBuildRunId")
  const sourceSha = string(authority.sourceSha, SOURCE_SHA, "authority.sourceSha")
  const artifactName = string(authority.artifactName, SIGNED_CANDIDATE_NAME_PATTERN, "authority.artifactName")
  if (!artifactName.endsWith(`-${sourceSha}`)) throw new Error("H3 Candidate Artifact name differs from source SHA")
  string(authority.artifactId, POSITIVE_ID, "authority.artifactId")
  string(authority.artifactDigest, ARTIFACT_DIGEST, "authority.artifactDigest")
  positiveInteger(authority.dmgBytes, "authority.dmgBytes")
  string(authority.dmgSha256, SHA256, "authority.dmgSha256")
  string(authority.rawCandidateSha256, SHA256, "authority.rawCandidateSha256")
  string(authority.postInstallAuthoritySha256, SHA256, "authority.postInstallAuthoritySha256")
  string(authority.postInstallSha256, SHA256, "authority.postInstallSha256")
  const createdAt = canonicalTimestamp(evidence.createdAt, "createdAt")
  if (!Array.isArray(evidence.observations) || evidence.observations.length !== H3_HUMAN_OBSERVATION_IDS.length) {
    throw new Error("H3 evidence must contain exactly three observations")
  }
  let priorObservedAt = Number.NEGATIVE_INFINITY
  for (const [index, candidate] of evidence.observations.entries()) {
    const item = record(candidate, `observations[${index}]`)
    exactKeys(item, ["id", "observedAt", "passed", "screenshot"], `observations[${index}]`)
    const expectedId = H3_HUMAN_OBSERVATION_IDS[index]!
    if (item.id !== expectedId || item.passed !== true) throw new Error(`${expectedId} evidence must be PASS`)
    const observedAt = canonicalTimestamp(item.observedAt, `${expectedId}.observedAt`)
    if (Date.parse(observedAt) < priorObservedAt) throw new Error("H3 evidence observation timestamps are not nondecreasing")
    priorObservedAt = Date.parse(observedAt)
    if (Date.parse(observedAt) > Date.parse(createdAt)) throw new Error(`${expectedId} observation is later than evidence creation`)
    const screenshot = record(item.screenshot, `${expectedId}.screenshot`)
    exactKeys(screenshot, ["bytes", "path", "sha256"], `${expectedId}.screenshot`)
    if (screenshot.path !== `screenshots/${expectedId}.png`) throw new Error(`${expectedId} screenshot path differs`)
    positiveInteger(screenshot.bytes, `${expectedId}.screenshot.bytes`)
    string(screenshot.sha256, SHA256, `${expectedId}.screenshot.sha256`)
  }
  const recovery = record(evidence.recovery, "recovery")
  exactKeys(recovery, [
    "backupIdentitySha256", "backupPath", "installedPath", "required", "restoredIdentitySha256", "status",
  ], "recovery")
  if (recovery.installedPath !== INSTALLED_APP || typeof recovery.required !== "boolean") {
    throw new Error("H3 recovery identity differs")
  }
  if (recovery.required) {
    if (recovery.status !== "PASS" || typeof recovery.backupPath !== "string" || !isAbsolute(recovery.backupPath)) {
      throw new Error("Required H3 recovery did not pass")
    }
    const backup = string(recovery.backupIdentitySha256, SHA256, "recovery.backupIdentitySha256")
    const restored = string(recovery.restoredIdentitySha256, SHA256, "recovery.restoredIdentitySha256")
    if (backup !== restored) throw new Error("Restored App identity differs from backup")
  } else if (recovery.status !== "NOT NEEDED" || recovery.backupPath !== "N/A"
    || recovery.backupIdentitySha256 !== "N/A" || recovery.restoredIdentitySha256 !== "N/A") {
    throw new Error("No-backup H3 recovery must be NOT NEEDED")
  }
  assertNoSecretShapedFields(evidence)
  return evidence as unknown as H3HumanObservationEvidence
}

function readCanonicalHumanInput(path: string): H3HumanObservationInput {
  const file = ownerOnlyFile(path, "H3 human input", 64 * 1024)
  const input = validateH3HumanObservationInput(JSON.parse(file.bytes.toString("utf8")))
  if (!file.bytes.equals(Buffer.from(canonicalH3HumanObservationInput(input)))) {
    throw new Error("H3 human observation input is not canonical")
  }
  return input
}

let crcTable: Uint32Array | undefined

function pngCrc32(bytes: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      crcTable[index] = value >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function validatePngContainer(bytes: Buffer, label: string): { width: number; height: number; chunks: string[] } {
  if (bytes.length <= PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${label} is not a PNG file`)
  }
  let offset = PNG_SIGNATURE.length
  let index = 0
  let width = 0
  let height = 0
  let hasIdat = false
  let hasIend = false
  const chunks: string[] = []
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw new Error(`${label} has a truncated PNG chunk`)
    const length = bytes.readUInt32BE(offset)
    const typeStart = offset + 4
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const crcEnd = dataEnd + 4
    if (length > MAX_SCREENSHOT_BYTES || crcEnd > bytes.length) throw new Error(`${label} has a truncated PNG chunk`)
    const type = bytes.subarray(typeStart, dataStart).toString("ascii")
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error(`${label} has an invalid PNG chunk type`)
    chunks.push(type)
    const storedCrc = bytes.readUInt32BE(dataEnd)
    const actualCrc = pngCrc32(bytes.subarray(typeStart, dataEnd))
    if (storedCrc !== actualCrc) throw new Error(`${label} has a bad PNG CRC`)
    if (index === 0) {
      if (type !== "IHDR" || length !== 13) throw new Error(`${label} lacks a canonical PNG IHDR`)
      width = bytes.readUInt32BE(dataStart)
      height = bytes.readUInt32BE(dataStart + 4)
      if (width < 1 || height < 1 || width > MAX_SCREENSHOT_DIMENSION || height > MAX_SCREENSHOT_DIMENSION
        || width * height > MAX_SCREENSHOT_PIXELS) {
        throw new Error(`${label} exceeds the decoded PNG dimension or pixel bound`)
      }
    } else if (type === "IHDR") {
      throw new Error(`${label} contains multiple PNG IHDR chunks`)
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT") throw new Error(`${label} must not be an animated PNG`)
    if (type === "IDAT") hasIdat = true
    if (type === "IEND") {
      if (length !== 0 || hasIend) throw new Error(`${label} has an invalid PNG IEND`)
      hasIend = true
      offset = crcEnd
      if (offset !== bytes.length) throw new Error(`${label} contains trailing bytes after PNG IEND`)
      break
    }
    offset = crcEnd
    index += 1
  }
  if (!hasIdat || !hasIend) throw new Error(`${label} is missing PNG image data or IEND`)
  return { width, height, chunks }
}

function stripPngAncillaryChunks(bytes: Buffer, label: string): Buffer {
  validatePngContainer(bytes, label)
  const retained = [bytes.subarray(0, PNG_SIGNATURE.length)]
  let offset = PNG_SIGNATURE.length
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii")
    // PNG defines a lowercase first type byte as ancillary.  The raw-pixel
    // re-encode needs no source or generated metadata, so retain only critical
    // image structure and validate the stripped container again below.
    if (/^[A-Z]/.test(type)) retained.push(bytes.subarray(offset, end))
    offset = end
  }
  const result = Buffer.concat(retained)
  const container = validatePngContainer(result, `${label} stripped`)
  if (container.chunks.some((type) => !["IHDR", "PLTE", "IDAT", "IEND"].includes(type))) {
    throw new Error(`${label} contains an unexpected critical PNG chunk`)
  }
  return result
}

async function readPng(path: string, label: string): Promise<Buffer> {
  const file = ownerOnlyFile(path, label, MAX_SCREENSHOT_BYTES)
  const container = validatePngContainer(file.bytes, label)
  if (sharp.versions.sharp !== "0.34.5") throw new Error(`${label} requires pinned sharp 0.34.5`)
  let metadata: sharp.Metadata
  let decoded: { data: Buffer; info: sharp.OutputInfo }
  try {
    const image = sharp(file.bytes, { animated: true, failOn: "error", limitInputPixels: MAX_SCREENSHOT_PIXELS })
    metadata = await image.metadata()
    decoded = await image.raw().toBuffer({ resolveWithObject: true })
  } catch (error) {
    throw new Error(`${label} failed full PNG decode: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (metadata.format !== "png" || metadata.width !== container.width || metadata.height !== container.height
    || (metadata.pages ?? 1) !== 1 || (metadata.pageHeight !== undefined && metadata.pageHeight !== metadata.height)
    || decoded.info.width !== container.width || decoded.info.height !== container.height
    || decoded.data.length < container.width * container.height) {
    throw new Error(`${label} decoded PNG metadata differs or is animated`)
  }
  let normalized: Buffer
  try {
    const encoded = await sharp(decoded.data, {
      raw: {
        width: decoded.info.width,
        height: decoded.info.height,
        channels: decoded.info.channels,
      },
    }).png({
      adaptiveFiltering: false,
      compressionLevel: 9,
      palette: false,
      progressive: false,
    }).toBuffer()
    normalized = stripPngAncillaryChunks(encoded, `${label} normalized PNG`)
  } catch (error) {
    throw new Error(`${label} failed metadata-free PNG normalization: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (normalized.length < 1 || normalized.length > MAX_SCREENSHOT_BYTES) {
    throw new Error(`${label} normalized PNG exceeds the byte bound`)
  }
  const normalizedContainer = validatePngContainer(normalized, `${label} normalized PNG`)
  if (normalizedContainer.chunks.some((type) => !["IHDR", "PLTE", "IDAT", "IEND"].includes(type))) {
    throw new Error(`${label} normalized PNG retained metadata or an unexpected chunk`)
  }
  const normalizedDecoded = await sharp(normalized, {
    animated: false,
    failOn: "error",
    limitInputPixels: MAX_SCREENSHOT_PIXELS,
  }).raw().toBuffer({ resolveWithObject: true })
  if (normalizedDecoded.info.width !== decoded.info.width
    || normalizedDecoded.info.height !== decoded.info.height
    || normalizedDecoded.info.channels !== decoded.info.channels
    || !normalizedDecoded.data.equals(decoded.data)) {
    throw new Error(`${label} pixel values changed during metadata-free PNG normalization`)
  }
  return normalized
}

export const systemH3RecoveryInspector: H3RecoveryInspector = {
  exactTreeSha256(installedAppPath) {
    const app = resolve(installedAppPath)
    if (app !== INSTALLED_APP) throw new Error(`Recovery App must be ${INSTALLED_APP}`)
    const metadata = lstatSync(app)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(app) !== app) {
      throw new Error("Restored App must be one real canonical directory")
    }
    const result = runH3SystemCommand(
      H3_SYSTEM_EXECUTABLES.python3,
      [join(import.meta.dir, "compare-macos-app-payloads.py"), "exact-tree", app],
      "Restored App exact-tree inspection",
      "heavy",
    )
    const report = record(JSON.parse(result.stdout), "Restored App exact-tree report")
    exactKeys(report, ["inventorySha256", "pathCount", "policy", "schemaVersion"], "Restored App exact-tree report")
    if (report.schemaVersion !== 1 || report.policy !== "exact-tree-path-type-mode-symlink-content-v1") {
      throw new Error("Restored App exact-tree policy differs")
    }
    positiveInteger(report.pathCount, "Restored App exact-tree pathCount")
    return string(report.inventorySha256, SHA256, "Restored App exact-tree SHA-256")
  },
}

function recoveryEvidence(postInstall: H3PostInstallEvidence, inspector: H3RecoveryInspector): H3HumanObservationEvidence["recovery"] {
  if (!postInstall.existingAppBeforeInstall) {
    if (postInstall.restoreStatus !== "NOT NEEDED") throw new Error("No-backup post-install evidence must use NOT NEEDED")
    return {
      required: false,
      status: "NOT NEEDED",
      installedPath: INSTALLED_APP,
      backupPath: "N/A",
      backupIdentitySha256: "N/A",
      restoredIdentitySha256: "N/A",
    }
  }
  if (postInstall.restoreStatus !== "PENDING") {
    throw new Error("Existing-App post-install evidence must remain PENDING until objective recovery verification")
  }
  const restoredIdentitySha256 = inspector.exactTreeSha256(INSTALLED_APP)
  if (restoredIdentitySha256 !== postInstall.backupIdentitySha256) {
    throw new Error("Restored /Applications/Simulator.app exact-tree identity differs from the backup")
  }
  return {
    required: true,
    status: "PASS",
    installedPath: INSTALLED_APP,
    backupPath: postInstall.backupPath,
    backupIdentitySha256: postInstall.backupIdentitySha256,
    restoredIdentitySha256,
  }
}

export async function writeH3HumanObservationEvidence(
  postInstallAuthorityRoot: string,
  rawArtifactArchivePath: string,
  expectedStage1AuthoritySha256Value: string,
  humanInputPath: string,
  outputRootPath: string,
  dependencies: H3HumanObservationDependencies = {
    recoveryInspector: systemH3RecoveryInspector,
    authenticator: systemH3AuthorityAuthenticator,
    now: () => new Date(),
  },
): Promise<{ root: string; sha256: string; evidence: H3HumanObservationEvidence }> {
  const expectedStage1AuthoritySha256 = validateExpectedH3Stage1AuthoritySha256(expectedStage1AuthoritySha256Value)
  const authorityClosure = verifyH3PostInstallAuthorityClosure(
    postInstallAuthorityRoot,
    rawArtifactArchivePath,
    dependencies.authenticator,
  )
  if (authorityClosure.authoritySha256 !== expectedStage1AuthoritySha256) {
    throw new Error("H3 Stage-1 authority SHA-256 differs from the pre-restore frozen value")
  }
  const postInstall = {
    path: authorityClosure.postInstallPath,
    sha256: authorityClosure.postInstallSha256,
    evidence: JSON.parse(readFileSync(authorityClosure.postInstallPath, "utf8")) as H3PostInstallEvidence,
  }
  const human = readCanonicalHumanInput(humanInputPath)
  const outputRoot = assertOwnerOnlyDirectory(outputRootPath, true)
  const createdAt = dependencies.now().toISOString()
  canonicalTimestamp(createdAt, "createdAt")
  const installedAt = Date.parse(postInstall.evidence.installedAt)
  const createdAtMs = Date.parse(createdAt)
  if (createdAtMs < installedAt) throw new Error("H3 evidence creation predates installation")
  const screenshotsRoot = join(outputRoot, "screenshots")
  try {
    mkdirSync(screenshotsRoot, { mode: 0o700 })
    chmodSync(screenshotsRoot, 0o700)
    const observations = [] as H3HumanObservationEvidence["observations"]
    for (const observation of human.observations) {
      const observedAtMs = Date.parse(observation.observedAt)
      if (observedAtMs < installedAt || observedAtMs > createdAtMs) {
        throw new Error(`${observation.id} timestamp falls outside the post-install observation window`)
      }
      const bytes = await readPng(observation.screenshotPath, `${observation.id} screenshot`)
      const relativePath = `screenshots/${observation.id}.png`
      writeOwnerOnlyFile(join(outputRoot, relativePath), bytes)
      observations.push({
        id: observation.id,
        passed: true as const,
        observedAt: observation.observedAt,
        screenshot: { path: relativePath, bytes: bytes.length, sha256: digest(bytes) },
      })
    }
    const evidence = validateH3HumanObservationEvidence({
      schemaVersion: 1,
      kind: "simulator-h3-human-observation",
      authority: {
        sourceSha: postInstall.evidence.sourceSha,
        hostBuildRunId: postInstall.evidence.hostBuildRunId,
        artifactName: postInstall.evidence.artifactName,
        artifactId: postInstall.evidence.artifactId,
        artifactDigest: postInstall.evidence.artifactDigest,
        dmgBytes: postInstall.evidence.dmgBytes,
        dmgSha256: postInstall.evidence.dmgSha256,
        rawCandidateSha256: authorityClosure.authority.rawCandidate.sha256,
        postInstallAuthoritySha256: authorityClosure.authoritySha256,
        postInstallSha256: postInstall.sha256,
      },
      createdAt,
      observations,
      recovery: recoveryEvidence(postInstall.evidence, dependencies.recoveryInspector),
    })
    const evidenceBytes = canonicalH3HumanObservationEvidence(evidence)
    writeOwnerOnlyFile(join(outputRoot, "human-observation.json"), evidenceBytes)
    const sumPaths = H3_HUMAN_OBSERVATION_CLOSURE.filter((path) => path !== "SHA256SUMS")
    const sums = `${sumPaths.map((path) => `${digest(readFileSync(join(outputRoot, path)))}  ${path}`).join("\n")}\n`
    writeOwnerOnlyFile(join(outputRoot, "SHA256SUMS"), sums)
    const verified = await verifyH3HumanObservationEvidence(
      outputRoot,
      postInstallAuthorityRoot,
      rawArtifactArchivePath,
      expectedStage1AuthoritySha256,
      dependencies,
    )
    return { root: outputRoot, sha256: verified.sha256, evidence: verified.evidence }
  } catch (error) {
    for (const relative of H3_HUMAN_OBSERVATION_CLOSURE) rmSync(join(outputRoot, relative), { force: true })
    rmSync(screenshotsRoot, { recursive: true, force: true })
    throw error
  }
}

export async function verifyH3HumanObservationEvidence(
  rootPath: string,
  postInstallAuthorityRoot: string,
  rawArtifactArchivePath: string,
  expectedStage1AuthoritySha256Value: string,
  dependencies: Omit<H3HumanObservationDependencies, "now"> & { now?: () => Date } = {
    recoveryInspector: systemH3RecoveryInspector,
    authenticator: systemH3AuthorityAuthenticator,
  },
): Promise<{
  root: string
  sha256: string
  evidence: H3HumanObservationEvidence
}> {
  const expectedStage1AuthoritySha256 = validateExpectedH3Stage1AuthoritySha256(expectedStage1AuthoritySha256Value)
  const root = assertOwnerOnlyDirectory(rootPath)
  const rootEntries = readdirSync(root, { withFileTypes: true })
  const expectedRoot = ["SHA256SUMS", "human-observation.json", "screenshots"]
  const actualRoot = rootEntries.map((entry) => entry.name).sort()
  if (actualRoot.length !== expectedRoot.length || actualRoot.some((name, index) => name !== expectedRoot[index])) {
    throw new Error("H3 human observation root closure differs")
  }
  const screenshotsRoot = assertOwnerOnlyDirectory(join(root, "screenshots"))
  const expectedScreenshots = H3_HUMAN_OBSERVATION_IDS.map((id) => `${id}.png`).sort()
  const actualScreenshots = readdirSync(screenshotsRoot).sort()
  if (actualScreenshots.length !== expectedScreenshots.length
    || actualScreenshots.some((name, index) => name !== expectedScreenshots[index])) {
    throw new Error("H3 screenshot closure differs")
  }
  const evidenceFile = ownerOnlyFile(join(root, "human-observation.json"), "H3 human observation evidence", 128 * 1024)
  const evidence = validateH3HumanObservationEvidence(JSON.parse(evidenceFile.bytes.toString("utf8")))
  if (!evidenceFile.bytes.equals(Buffer.from(canonicalH3HumanObservationEvidence(evidence)))) {
    throw new Error("H3 human observation evidence is not canonical")
  }
  const authorityClosure = verifyH3PostInstallAuthorityClosure(
    postInstallAuthorityRoot,
    rawArtifactArchivePath,
    dependencies.authenticator,
  )
  if (authorityClosure.authoritySha256 !== expectedStage1AuthoritySha256) {
    throw new Error("H3 Stage-1 authority SHA-256 differs from the pre-restore frozen value")
  }
  const postInstall = {
    sha256: authorityClosure.postInstallSha256,
    evidence: JSON.parse(readFileSync(authorityClosure.postInstallPath, "utf8")) as H3PostInstallEvidence,
  }
  const expectedAuthority: H3HumanObservationEvidence["authority"] = {
    sourceSha: postInstall.evidence.sourceSha,
    hostBuildRunId: postInstall.evidence.hostBuildRunId,
    artifactName: postInstall.evidence.artifactName,
    artifactId: postInstall.evidence.artifactId,
    artifactDigest: postInstall.evidence.artifactDigest,
    dmgBytes: postInstall.evidence.dmgBytes,
    dmgSha256: postInstall.evidence.dmgSha256,
    rawCandidateSha256: authorityClosure.authority.rawCandidate.sha256,
    postInstallAuthoritySha256: authorityClosure.authoritySha256,
    postInstallSha256: postInstall.sha256,
  }
  if (stable(evidence.authority) !== stable(expectedAuthority)) {
    throw new Error("H3 human observation authority differs from authenticated post-install evidence")
  }
  const installedAt = Date.parse(postInstall.evidence.installedAt)
  const createdAt = Date.parse(evidence.createdAt)
  let previous = installedAt
  for (const observation of evidence.observations) {
    const observedAt = Date.parse(observation.observedAt)
    if (observedAt < previous || observedAt > createdAt) {
      throw new Error("H3 observation timestamps fall outside the authenticated post-install window")
    }
    previous = observedAt
  }
  const expectedRecovery = recoveryEvidence(postInstall.evidence, dependencies.recoveryInspector)
  if (stable(evidence.recovery) !== stable(expectedRecovery)) {
    throw new Error("H3 recovery evidence differs from authenticated post-install state")
  }
  for (const observation of evidence.observations) {
    const screenshot = ownerOnlyFile(join(root, observation.screenshot.path), `${observation.id} sealed screenshot`, MAX_SCREENSHOT_BYTES)
    const normalized = await readPng(screenshot.path, `${observation.id} sealed screenshot`)
    if (screenshot.bytes.length !== observation.screenshot.bytes
      || digest(screenshot.bytes) !== observation.screenshot.sha256
      || !normalized.equals(screenshot.bytes)) {
      throw new Error(`${observation.id} sealed screenshot differs from evidence`)
    }
  }
  const sumsFile = ownerOnlyFile(join(root, "SHA256SUMS"), "H3 SHA256SUMS", 4096)
  const sumPaths = H3_HUMAN_OBSERVATION_CLOSURE.filter((path) => path !== "SHA256SUMS")
  const expectedSums = `${sumPaths.map((path) => `${digest(readFileSync(join(root, path)))}  ${path}`).join("\n")}\n`
  if (sumsFile.bytes.toString("utf8") !== expectedSums) throw new Error("H3 SHA256SUMS differs from exact closure")
  return { root, sha256: digest(evidenceFile.bytes), evidence }
}

if (import.meta.main) {
  process.umask(0o077)
  const [operation, first, second, third, fourth, fifth, sixth] = process.argv.slice(2)
  if (operation === "generate" && first && second && third && fourth && fifth && !sixth) {
    const result = await writeH3HumanObservationEvidence(first, second, third, fourth, fifth)
    console.log(JSON.stringify({ ok: true, root: result.root, sha256: result.sha256 }))
  } else if (operation === "validate" && first && second && third && fourth && !fifth) {
    const result = await verifyH3HumanObservationEvidence(first, second, third, fourth)
    console.log(JSON.stringify({ ok: true, root: result.root, sha256: result.sha256 }))
  } else {
    throw new Error(
      "Usage: h3-human-observation-evidence.ts generate POST_INSTALL_AUTHORITY_DIR RAW_CANDIDATE_ZIP EXPECTED_STAGE1_AUTHORITY_SHA256 HUMAN_INPUT_JSON EMPTY_OUTPUT_DIR"
      + " | validate OUTPUT_DIR POST_INSTALL_AUTHORITY_DIR RAW_CANDIDATE_ZIP EXPECTED_STAGE1_AUTHORITY_SHA256",
    )
  }
}
