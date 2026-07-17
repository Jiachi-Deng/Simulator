import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import { createReadStream, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"
import { TextDecoder } from "node:util"

export type EngineeringRcBundlePhase = "pre" | "final"

const BASE_FILES = [
  "RELEASE_NOTES.md",
  "SHA256SUMS",
  "Simulator-arm64.dmg",
  "Simulator-arm64.zip",
  "app-inventory.jsonl",
  "bundle-metadata.json",
  "dmg-app-inventory.raw.jsonl",
  "dmg-signatures.json",
  "package-verification-code.txt",
  "packaged-files.sha256",
  "rc-validation.json",
  "sbom.spdx.json",
  "transport-normalization-policy.json",
  "verification-input.json",
  "zip-app-inventory.raw.jsonl",
  "zip-signatures.json",
] as const

const ATTESTATION_FILES = [
  "attestations/provenance.sigstore.json",
  "attestations/sbom.sigstore.json",
] as const

const ARTIFACT_FILES = ["Simulator-arm64.dmg", "Simulator-arm64.zip"] as const
const SHA256 = /^[0-9a-f]{64}$/
const SOURCE_SHA = /^[0-9a-f]{40}$/
const RC_LABEL = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.([1-9]\d*)$/
const MAXIMUM_TOTAL_BYTES = 3 * 1024 * 1024 * 1024

function compareUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

function readStrictUtf8(path: string, label: string): string {
  const content = readFileSync(path)
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content)
  } catch {
    throw new Error(`${label} must be valid UTF-8`)
  }
}

interface VerificationOptions {
  phase: EngineeringRcBundlePhase
  bundleDirectory: string
  rcLabel: string
  productVersion: string
  sourceSha: string
  inputArtifactId: string
  inputArtifactDigest: string
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function json(path: string, label: string): Record<string, unknown> {
  try {
    return object(JSON.parse(readFileSync(path, "utf8")), label)
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

function expectedFiles(phase: EngineeringRcBundlePhase): string[] {
  return [...BASE_FILES, ...(phase === "final" ? ATTESTATION_FILES : [])].sort()
}

function maximumBytes(path: string): number {
  if (ARTIFACT_FILES.includes(path as (typeof ARTIFACT_FILES)[number])) return 1280 * 1024 * 1024
  if (["app-inventory.jsonl", "dmg-app-inventory.raw.jsonl", "zip-app-inventory.raw.jsonl"].includes(path)) {
    return 256 * 1024 * 1024
  }
  if (path === "sbom.spdx.json") return 128 * 1024 * 1024
  if (path === "SHA256SUMS") return 64 * 1024
  return 32 * 1024 * 1024
}

function assertClosure(root: string, phase: EngineeringRcBundlePhase): void {
  const rootMetadata = lstatSync(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error("Engineering RC bundle root must be a real canonical directory")
  }

  const files: string[] = []
  const directories: string[] = []
  let totalBytes = 0
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relativePath = relative(root, path).split("\\").join("/")
      const metadata = lstatSync(path)
      if (metadata.isSymbolicLink()) throw new Error(`Bundle symlink is forbidden: ${relativePath}`)
      if (metadata.isDirectory()) {
        directories.push(`${relativePath}/`)
        visit(path)
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1) throw new Error(`Bundle hard link is forbidden: ${relativePath}`)
        if (metadata.size <= 0) throw new Error(`Bundle file must not be empty: ${relativePath}`)
        if (metadata.size > maximumBytes(relativePath)) {
          throw new Error(`Bundle file exceeds its size limit: ${relativePath}`)
        }
        totalBytes += metadata.size
        if (totalBytes > MAXIMUM_TOTAL_BYTES) throw new Error("Engineering RC bundle exceeds its total size limit")
        files.push(relativePath)
      } else {
        throw new Error(`Bundle entry must be a regular file or directory: ${relativePath}`)
      }
    }
  }
  visit(root)

  const expected = expectedFiles(phase)
  if (JSON.stringify(files.sort()) !== JSON.stringify(expected)) {
    throw new Error(`Engineering RC ${phase} bundle file closure mismatch`)
  }
  const expectedDirectories = phase === "final" ? ["attestations/"] : []
  if (JSON.stringify(directories.sort()) !== JSON.stringify(expectedDirectories)) {
    throw new Error(`Engineering RC ${phase} bundle directory closure mismatch`)
  }
}

async function assertChecksums(root: string, phase: EngineeringRcBundlePhase): Promise<Map<string, string>> {
  const path = join(root, "SHA256SUMS")
  const content = readFileSync(path, "utf8")
  if (!content.endsWith("\n") || content.includes("\r")) {
    throw new Error("SHA256SUMS must be canonical LF-terminated text")
  }
  const expected = phase === "final"
    ? expectedFiles(phase).filter((name) => name !== "SHA256SUMS")
    : [...ARTIFACT_FILES]
  const lines = content.slice(0, -1).split("\n")
  if (lines.length !== expected.length) throw new Error("SHA256SUMS entry count is invalid")

  const digests = new Map<string, string>()
  for (let index = 0; index < expected.length; index += 1) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(lines[index] ?? "")
    if (!match || match[2] !== expected[index]) throw new Error("SHA256SUMS order or path is invalid")
    const actual = await sha256(join(root, match[2]))
    if (actual !== match[1]) throw new Error(`SHA256SUMS digest mismatch: ${match[2]}`)
    digests.set(match[2], actual)
  }
  return digests
}

async function assertVerificationInput(root: string): Promise<void> {
  const evidence = json(join(root, "verification-input.json"), "verification-input.json")
  if (!exactKeys(evidence, ["schemaVersion", "files"]) || evidence.schemaVersion !== 1 || !Array.isArray(evidence.files)) {
    throw new Error("verification-input.json has an invalid schema")
  }
  const files = evidence.files.map((entry, index) => object(entry, `verification input file ${index}`))
  if (files.length !== ARTIFACT_FILES.length) throw new Error("verification-input.json must contain exactly two artifacts")
  for (let index = 0; index < ARTIFACT_FILES.length; index += 1) {
    const expectedName = ARTIFACT_FILES[index]
    const entry = files[index]
    if (!exactKeys(entry, ["name", "size", "sha256"])
      || entry.name !== expectedName
      || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size <= 0
      || typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
      throw new Error(`verification-input.json artifact is invalid: ${expectedName}`)
    }
    const path = join(root, expectedName)
    if (statSync(path).size !== entry.size || await sha256(path) !== entry.sha256) {
      throw new Error(`verification-input.json artifact changed: ${expectedName}`)
    }
  }
}

function assertMetadata(root: string, options: VerificationOptions): void {
  const metadata = json(join(root, "bundle-metadata.json"), "bundle-metadata.json")
  if (!exactKeys(metadata, [
    "schemaVersion", "rcLabel", "productVersion", "sourceSha", "inputArtifactId",
    "inputArtifactDigest", "signed", "channel",
  ])
    || metadata.schemaVersion !== 1
    || metadata.rcLabel !== options.rcLabel
    || metadata.productVersion !== options.productVersion
    || metadata.sourceSha !== options.sourceSha
    || metadata.inputArtifactId !== options.inputArtifactId
    || metadata.inputArtifactDigest !== options.inputArtifactDigest
    || metadata.signed !== false
    || metadata.channel !== "engineering-rc") {
    throw new Error("bundle-metadata.json does not match the requested Engineering RC")
  }

  const validation = json(join(root, "rc-validation.json"), "rc-validation.json")
  if (validation.schemaVersion !== 1 || validation.ok !== true
    || validation.rcLabel !== options.rcLabel || validation.productVersion !== options.productVersion
    || validation.ref !== options.sourceSha || validation.sourceSha !== options.sourceSha
    || validation.mainSha !== options.sourceSha || !Array.isArray(validation.checks)
    || validation.checks.length === 0
    || !validation.checks.every((check) => object(check, "RC validation check").ok === true)) {
    throw new Error("rc-validation.json does not prove an exact successful main build")
  }
}

function assertSpdx(root: string, options: VerificationOptions): void {
  const document = json(join(root, "sbom.spdx.json"), "sbom.spdx.json")
  if (document.spdxVersion !== "SPDX-2.3" || document.name !== `Simulator-${options.productVersion}`
    || !Array.isArray(document.packages) || !Array.isArray(document.files)
    || !Array.isArray(document.relationships)) throw new Error("SPDX document identity is invalid")
  const simulatorPackages = document.packages
    .map((entry, index) => object(entry, `SPDX package ${index}`))
    .filter((entry) => entry.SPDXID === "SPDXRef-Package-Simulator")
  if (simulatorPackages.length !== 1) throw new Error("SPDX Simulator package must be unique")
  const simulator = simulatorPackages[0]
  const verificationCode = readFileSync(join(root, "package-verification-code.txt"), "utf8").trim()
  const packageCode = object(simulator.packageVerificationCode, "SPDX package verification code")
  if (!/^[0-9a-f]{40}$/.test(verificationCode)
    || simulator.name !== "Simulator" || simulator.versionInfo !== options.productVersion
    || simulator.downloadLocation !== `git+https://github.com/Jiachi-Deng/Simulator.git@${options.sourceSha}`
    || simulator.filesAnalyzed !== true
    || packageCode.packageVerificationCodeValue !== verificationCode) {
    throw new Error("SPDX Simulator package authority is invalid")
  }

  const checksumsContent = readStrictUtf8(join(root, "packaged-files.sha256"), "packaged-files.sha256")
  if (!checksumsContent.endsWith("\n") || checksumsContent.includes("\r")) {
    throw new Error("packaged-files.sha256 must be canonical LF-terminated text")
  }
  const packagedFiles = checksumsContent.slice(0, -1).split("\n").map((line) => {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line)
    if (!match || match[2].startsWith("/") || match[2].includes("\\")
      || /[\u0000-\u001f\u007f]/u.test(match[2])
      || match[2].split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("packaged-files.sha256 contains an unsafe entry")
    }
    return { sha256: match[1], path: match[2] }
  })
  const packagedPaths = packagedFiles.map((entry) => entry.path)
  if (packagedFiles.length === 0
    || packagedPaths.some((path) => Buffer.from(path, "utf8").toString("utf8") !== path)
    || packagedPaths.slice(1).some((path, index) => compareUtf8Bytes(packagedPaths[index], path) >= 0)) {
    throw new Error("packaged-files.sha256 must contain unique entries in canonical UTF-8 byte order")
  }

  const spdxFiles = document.files.map((entry, index) => object(entry, `SPDX file ${index}`))
  const expectedIds = packagedFiles.map((_, index) => `SPDXRef-File-${index + 1}`)
  if (spdxFiles.length !== packagedFiles.length
    || !spdxFiles.every((entry, index) => {
      const checksums = Array.isArray(entry.checksums)
        ? entry.checksums.map((checksum) => object(checksum, `SPDX file ${index} checksum`))
        : []
      return entry.fileName === `./app/${packagedFiles[index].path}`
        && entry.SPDXID === expectedIds[index]
        && checksums.length === 1
        && checksums[0].algorithm === "SHA256"
        && checksums[0].checksumValue === packagedFiles[index].sha256
    })) {
    throw new Error("SPDX files do not exactly match packaged-files.sha256")
  }
  if (!Array.isArray(simulator.hasFiles) || JSON.stringify(simulator.hasFiles) !== JSON.stringify(expectedIds)) {
    throw new Error("SPDX Simulator hasFiles does not match the packaged inventory")
  }
  const contains = document.relationships
    .map((entry, index) => object(entry, `SPDX relationship ${index}`))
    .filter((entry) => entry.spdxElementId === "SPDXRef-Package-Simulator" && entry.relationshipType === "CONTAINS")
    .map((entry) => entry.relatedSpdxElement)
  if (JSON.stringify(contains) !== JSON.stringify(expectedIds)) {
    throw new Error("SPDX CONTAINS relationships do not match the packaged inventory")
  }
}

function assertAdhocSignatures(root: string): void {
  let firstPaths: unknown[] | undefined
  for (const name of ["dmg-signatures.json", "zip-signatures.json"]) {
    const evidence = json(join(root, name), name)
    const objects = Array.isArray(evidence.objects)
      ? evidence.objects.map((entry) => object(entry, `${name} object`))
      : []
    const paths = objects.map((entry) => entry.path)
    const requiredPath = "Contents/MacOS/Simulator"
    const requiredObjects = objects.filter((entry) => entry.path === requiredPath)
    if (!exactKeys(evidence, [
      "ok", "policy", "requiredArm64MachOPath", "requiredArm64MachOFileType",
      "machOCount", "kinds", "objects",
    ])
      || evidence.ok !== true
      || evidence.policy !== "unsigned-or-strictly-verified-adhoc"
      || evidence.requiredArm64MachOPath !== requiredPath
      || evidence.requiredArm64MachOFileType !== "EXECUTE"
      || evidence.machOCount !== 20
      || objects.length !== evidence.machOCount + 1
      || new Set(paths).size !== paths.length
      || objects[0]?.path !== "."
      || objects.filter((entry) => entry.path === ".").length !== 1
      || requiredObjects.length !== 1
      || !Array.isArray(requiredObjects[0].architectures)
      || JSON.stringify(requiredObjects[0].architectures) !== JSON.stringify(["arm64"])
      || !Array.isArray(evidence.kinds)
      || JSON.stringify(evidence.kinds) !== JSON.stringify(objects.map((entry) => entry.kind))
      || !objects.every((entry) => {
        const strict = object(entry.strictVerification, `${name} strict verification`)
        const path = entry.path
        return exactKeys(entry, ["path", "kind", "architectures", "strictVerification"])
          && typeof path === "string"
          && (path === "." || (!path.startsWith("/") && !path.includes("\\")
            && !/[\u0000-\u001f\u007f]/u.test(path)
            && !path.split("/").some((part) => !part || part === "." || part === "..")))
          && exactKeys(strict, ["required", "exitCode"])
          && entry.kind === "adhoc"
          && (entry.path === "."
            ? JSON.stringify(entry.architectures) === JSON.stringify([])
            : JSON.stringify(entry.architectures) === JSON.stringify(["arm64"]))
          && strict.required === true && strict.exitCode === 0
      })) {
      throw new Error(`${name} does not prove the exact strict ad-hoc arm64 policy`)
    }
    if (firstPaths === undefined) firstPaths = paths
    else if (JSON.stringify(paths) !== JSON.stringify(firstPaths)) {
      throw new Error("DMG and ZIP signature object paths differ")
    }
  }
}

export async function verifyEngineeringRcBundle(options: VerificationOptions): Promise<void> {
  if (!RC_LABEL.test(options.rcLabel)) throw new Error("RC label is invalid")
  if (options.rcLabel.slice(0, options.rcLabel.indexOf("-rc.")) !== options.productVersion) {
    throw new Error("Product version does not match the RC label")
  }
  if (!SOURCE_SHA.test(options.sourceSha)) throw new Error("Source SHA is invalid")
  if (!/^[1-9]\d*$/.test(options.inputArtifactId)) throw new Error("Input artifact ID is invalid")
  if (!SHA256.test(options.inputArtifactDigest)) throw new Error("Input artifact digest is invalid")
  const root = resolve(options.bundleDirectory)
  assertClosure(root, options.phase)
  await assertChecksums(root, options.phase)
  assertMetadata(root, options)
  await assertVerificationInput(root)
  assertSpdx(root, options)
  assertAdhocSignatures(root)
}

if (import.meta.main) {
  const [
    phase, bundleDirectory, rcLabel, productVersion, sourceSha,
    inputArtifactId, inputArtifactDigest, ...extra
  ] = process.argv.slice(2)
  if ((phase !== "pre" && phase !== "final") || !bundleDirectory || !rcLabel || !productVersion
    || !sourceSha || !inputArtifactId || !inputArtifactDigest || extra.length > 0) {
    throw new Error(`Usage: ${basename(process.argv[1])} pre|final BUNDLE_DIR RC_LABEL PRODUCT_VERSION SOURCE_SHA INPUT_ARTIFACT_ID INPUT_ARTIFACT_DIGEST`)
  }
  await verifyEngineeringRcBundle({
    phase, bundleDirectory, rcLabel, productVersion, sourceSha, inputArtifactId, inputArtifactDigest,
  })
  console.log(JSON.stringify({ ok: true, phase, rcLabel, productVersion, sourceSha }))
}
