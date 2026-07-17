import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"

export type SignatureKind = "unsigned" | "adhoc" | "developer-id"
export type SignaturePolicy = "unsigned-or-strictly-verified-adhoc" | "developer-id-strict"

type EntitlementValue = boolean | number | string | EntitlementValue[] | { [key: string]: EntitlementValue }
type Entitlements = Record<string, EntitlementValue>

export interface DeveloperIdPolicy {
  mode: "developer-id"
  expectedAuthority: string
  expectedTeamIdentifier: string
  expectedBundleIdentifier: string
  actualBundleIdentifier: string
  expectedEntitlements: Entitlements
}

export interface UnsignedPolicy {
  mode: "unsigned"
}

export type VerificationPolicy = UnsignedPolicy | DeveloperIdPolicy

export function classifyAllowedSignature(output: string): SignatureKind {
  if (/^Authority=/m.test(output)) throw new Error("certificate authority is not allowed")
  if (/code object is not signed at all/i.test(output)) return "unsigned"
  if (/^Signature=adhoc$/m.test(output) && /^TeamIdentifier=not set$/m.test(output)) return "adhoc"
  throw new Error("signature is neither absent nor strict ad hoc")
}

export interface FileInspection {
  description: string
  architectures: string
  signature: string
  verification: {
    exitCode: number
    output: string
  }
  entitlements?: string
}

export type Inspector = (path: string) => FileInspection

export interface SignatureObjectEvidence {
  path: string
  kind: SignatureKind
  architectures: string[]
  strictVerification: {
    required: boolean
    exitCode: number
  }
  developerId?: {
    authority: string
    teamIdentifier: string
    timestamped: true
    hardenedRuntime: true
    entitlements: string[]
  }
}

export interface MacOsSignatureVerification {
  machOCount: number
  kinds: SignatureKind[]
  objects: SignatureObjectEvidence[]
}

export interface MacOsSignatureVerificationEvidence extends MacOsSignatureVerification {
  readonly ok: true
  readonly policy: SignaturePolicy
  readonly requiredArm64MachOPath?: string
  readonly requiredArm64MachOFileType?: string
  readonly developerId?: {
    readonly authority: string
    readonly teamIdentifier: string
    readonly bundleIdentifier: string
    readonly entitlementsSha256: string
  }
}

export function requireArm64MachO(
  verification: MacOsSignatureVerification,
  relativePath: string,
  machOFileType: string,
): SignatureObjectEvidence {
  const matches = verification.objects.filter((object) => object.path === relativePath)
  if (
    matches.length !== 1
    || matches[0].architectures.length !== 1
    || matches[0].architectures[0] !== "arm64"
    || machOFileType !== "EXECUTE"
  ) {
    throw new Error(`Required arm64 Mach-O executable evidence is missing or ambiguous: ${relativePath}`)
  }
  return matches[0]
}

export function buildMacOsSignatureEvidence(
  verification: MacOsSignatureVerification,
  requiredMachOPath?: string,
  requiredMachOFileType?: string,
  policy: SignaturePolicy = "unsigned-or-strictly-verified-adhoc",
  developerId?: MacOsSignatureVerificationEvidence["developerId"],
): MacOsSignatureVerificationEvidence {
  if ((requiredMachOPath === undefined) !== (requiredMachOFileType === undefined)) {
    throw new Error("Required Mach-O path and filetype evidence must be provided together")
  }
  if (requiredMachOPath !== undefined && requiredMachOFileType !== undefined) {
    if (!requiredMachOPath || !requiredMachOFileType) {
      throw new Error("Required Mach-O path and filetype evidence must not be empty")
    }
    requireArm64MachO(verification, requiredMachOPath, requiredMachOFileType)
  }
  return {
    ok: true,
    policy,
    ...(requiredMachOPath ? { requiredArm64MachOPath: requiredMachOPath } : {}),
    ...(requiredMachOFileType ? { requiredArm64MachOFileType: requiredMachOFileType } : {}),
    ...(developerId ? { developerId } : {}),
    ...verification,
  }
}

function resolveRequiredMachO(appPath: string, relativePath: string): string {
  const parts = relativePath.split("/")
  if (
    relativePath.startsWith("/")
    || relativePath.includes("\\")
    || parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Required Mach-O path must be a safe relative path: ${relativePath}`)
  }
  const app = realDirectory(resolve(appPath), "App root")
  const candidate = join(app, ...parts)
  const metadata = lstatSync(candidate)
  if (!metadata.isFile() || metadata.isSymbolicLink() || realpathSync(candidate) !== candidate) {
    throw new Error(`Required Mach-O path must be a real regular file: ${relativePath}`)
  }
  return candidate
}

function realDirectory(path: string, label: string): string {
  const absolute = resolve(path)
  const metadata = lstatSync(absolute)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(absolute) !== absolute) {
    throw new Error(`${label} must be one real directory without aliases or symlinks`)
  }
  return absolute
}

function realRegularFile(path: string, label: string): string {
  const absolute = resolve(path)
  const metadata = lstatSync(absolute)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || realpathSync(absolute) !== absolute) {
    throw new Error(`${label} must be one real regular file without aliases, symlinks, or hard links`)
  }
  return absolute
}

export function parseMachOFileType(output: string): string {
  const lines = output.split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => line.trim().split(/\s+/).includes("filetype"))
  if (headerIndex < 0) throw new Error("otool output is missing the Mach-O filetype header")
  const headers = lines[headerIndex].trim().split(/\s+/)
  const valuesLine = lines.slice(headerIndex + 1).find((line) => line.trim().length > 0)
  if (!valuesLine) throw new Error("otool output is missing the Mach-O header values")
  const values = valuesLine.trim().split(/\s+/)
  const value = values[headers.indexOf("filetype")]
  if (!value) throw new Error("otool output is missing the Mach-O filetype value")
  return value
}

function command(command: string, args: string[]): { exitCode: number; output: string } {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.error) throw result.error
  return {
    exitCode: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  }
}

const systemInspector: Inspector = (path) => {
  const description = command("file", ["-b", path]).output
  const inspectCodeSignature = path.endsWith(".app") || description.includes("Mach-O")
  if (!inspectCodeSignature) {
    return {
      description,
      architectures: "",
      signature: "",
      verification: { exitCode: -1, output: "not a code object" },
    }
  }
  const verificationArguments = ["--verify", "--strict", "--verbose=4"]
  if (path.endsWith(".app")) verificationArguments.push("--deep")
  verificationArguments.push(path)
  return {
    description,
    architectures: command("lipo", ["-archs", path]).output,
    signature: command("codesign", ["-dvvv", path]).output,
    verification: command("codesign", verificationArguments),
    entitlements: command("codesign", ["-d", "--entitlements", ":-", path]).output,
  }
}

function requireStrictVerification(path: string, kind: SignatureKind, verification: FileInspection["verification"]): void {
  if (kind === "unsigned") return
  if (verification.exitCode === 0) return
  const label = kind === "adhoc" ? "ad hoc" : kind
  throw new Error(`Strict ${label} signature verification failed: ${path}: ${verification.output || `exit ${verification.exitCode}`}`)
}

function evidencePath(appPath: string, path: string): string {
  if (path === appPath) return "."
  return relative(appPath, path).split(sep).join("/")
}

function signatureObject(
  appPath: string,
  path: string,
  kind: SignatureKind,
  architectures: string,
  verification: FileInspection["verification"],
  developerId?: SignatureObjectEvidence["developerId"],
): SignatureObjectEvidence {
  return {
    path: evidencePath(appPath, path),
    kind,
    architectures: architectures.trim() ? architectures.trim().split(/\s+/) : [],
    strictVerification: {
      required: kind !== "unsigned",
      exitCode: verification.exitCode,
    },
    ...(developerId ? { developerId } : {}),
  }
}

function exactObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (exactObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function parseEntitlements(output: string): Entitlements {
  const trimmed = output.trim()
  if (!trimmed || /does not have an entitlements blob/i.test(trimmed)) return {}
  if (trimmed.startsWith("{")) {
    const value: unknown = JSON.parse(trimmed)
    if (!exactObject(value)) throw new Error("Entitlements must be a dictionary")
    return value as Entitlements
  }
  const plistStart = trimmed.indexOf("<plist")
  if (plistStart < 0) throw new Error("codesign entitlements output has no plist")
  const plist = trimmed.slice(plistStart)
  const parsed = spawnSync("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
    encoding: "utf8",
    input: plist,
  })
  if (parsed.error) throw parsed.error
  if (parsed.status !== 0) throw new Error(`Unable to parse entitlements plist: ${parsed.stderr || `exit ${parsed.status}`}`)
  const value: unknown = JSON.parse(parsed.stdout)
  if (!exactObject(value)) throw new Error("Entitlements must be a dictionary")
  return value as Entitlements
}

function validateDeveloperIdEntitlements(
  actual: Entitlements,
  expected: Entitlements,
  teamIdentifier: string,
  expectedBundleIdentifier: string,
  requireReviewedEntitlements: boolean,
): string[] {
  const injected = new Set(["com.apple.application-identifier", "com.apple.developer.team-identifier"])
  for (const key of Object.keys(actual)) {
    if (!(key in expected) && !injected.has(key)) throw new Error(`Unreviewed entitlement: ${key}`)
  }
  if (requireReviewedEntitlements) {
    for (const [key, value] of Object.entries(expected)) {
      if (!(key in actual) || stableJson(actual[key]) !== stableJson(value)) {
        throw new Error(`Reviewed entitlement is missing or differs: ${key}`)
      }
    }
  }
  const injectedTeam = actual["com.apple.developer.team-identifier"]
  if (injectedTeam !== undefined && injectedTeam !== teamIdentifier) {
    throw new Error("Injected developer team entitlement differs")
  }
  const applicationIdentifier = actual["com.apple.application-identifier"]
  const expectedApplicationIdentifier = `${teamIdentifier}.${expectedBundleIdentifier}`
  const nestedApplicationIdentifierSuffix = typeof applicationIdentifier === "string"
    && applicationIdentifier.startsWith(`${expectedApplicationIdentifier}.`)
    ? applicationIdentifier.slice(expectedApplicationIdentifier.length + 1)
    : ""
  const expectedNestedApplicationIdentifier = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/.test(nestedApplicationIdentifierSuffix)
  if (applicationIdentifier !== undefined && (
    typeof applicationIdentifier !== "string"
    || (applicationIdentifier !== expectedApplicationIdentifier
      && (requireReviewedEntitlements || !expectedNestedApplicationIdentifier))
  )) {
    throw new Error("Injected application identifier entitlement differs")
  }
  return Object.keys(actual).sort()
}

export function inspectDeveloperIdSignature(
  output: string,
  expectedAuthority: string,
  expectedTeamIdentifier: string,
): Omit<NonNullable<SignatureObjectEvidence["developerId"]>, "entitlements"> {
  if (!expectedAuthority.startsWith("Developer ID Application: ")) {
    throw new Error("Expected authority must be an exact Developer ID Application subject")
  }
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim())
  if (authorities[0] !== expectedAuthority) throw new Error("Developer ID leaf authority differs")
  const teams = [...output.matchAll(/^TeamIdentifier=(.+)$/gm)].map((match) => match[1].trim())
  if (teams.length !== 1 || teams[0] !== expectedTeamIdentifier) throw new Error("Developer ID TeamIdentifier differs")
  if (!/^Timestamp=.+$/m.test(output)) throw new Error("Developer ID signature has no secure timestamp")
  const codeDirectories = output.split(/\r?\n/).filter((line) => line.startsWith("CodeDirectory "))
  if (codeDirectories.length !== 1) throw new Error("Developer ID signature has ambiguous CodeDirectory metadata")
  const flags = codeDirectories[0].match(/\bflags=0x[0-9a-fA-F]+\(([^)]*)\)(?:\s|$)/)
  const flagNames = flags?.[1].split(",").map((flag) => flag.trim()).filter(Boolean) ?? []
  if (!flagNames.includes("runtime")) {
    throw new Error("Developer ID signature does not enable hardened runtime")
  }
  if (flagNames.includes("adhoc") || /^Signature=adhoc$/m.test(output)) throw new Error("Developer ID signature is ad hoc")
  return {
    authority: expectedAuthority,
    teamIdentifier: expectedTeamIdentifier,
    timestamped: true,
    hardenedRuntime: true,
  }
}

function regularFiles(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && statSync(path).isFile()) files.push(path)
    }
  }
  visit(root)
  return files
}

export function verifyMacOsSignatures(
  appPath: string,
  inspect: Inspector = systemInspector,
  policy: VerificationPolicy = { mode: "unsigned" },
): MacOsSignatureVerification {
  const appRoot = realDirectory(appPath, "App root")
  if (policy.mode === "developer-id" && policy.actualBundleIdentifier !== policy.expectedBundleIdentifier) {
    throw new Error(`App Bundle ID differs: ${policy.actualBundleIdentifier}`)
  }
  const appInspection = inspect(appRoot)
  const appKind = policy.mode === "developer-id" ? "developer-id" : classifyAllowedSignature(appInspection.signature)
  requireStrictVerification(appRoot, appKind, appInspection.verification)
  const appDeveloperId = policy.mode === "developer-id"
    ? {
        ...inspectDeveloperIdSignature(appInspection.signature, policy.expectedAuthority, policy.expectedTeamIdentifier),
        entitlements: validateDeveloperIdEntitlements(
          parseEntitlements(appInspection.entitlements ?? ""),
          policy.expectedEntitlements,
          policy.expectedTeamIdentifier,
          policy.expectedBundleIdentifier,
          true,
        ),
      }
    : undefined
  const kinds = [appKind]
  const objects = [signatureObject(appRoot, appRoot, appKind, "", appInspection.verification, appDeveloperId)]
  let machOCount = 0
  for (const path of regularFiles(appRoot)) {
    const result = inspect(path)
    if (!result.description.includes("Mach-O")) continue
    machOCount += 1
    if (result.architectures.trim() !== "arm64") throw new Error(`Mach-O is not arm64-only: ${path} (${result.architectures})`)
    try {
      const kind = policy.mode === "developer-id" ? "developer-id" : classifyAllowedSignature(result.signature)
      requireStrictVerification(path, kind, result.verification)
      const developerId = policy.mode === "developer-id"
        ? {
            ...inspectDeveloperIdSignature(result.signature, policy.expectedAuthority, policy.expectedTeamIdentifier),
            entitlements: validateDeveloperIdEntitlements(
              parseEntitlements(result.entitlements ?? ""),
              policy.expectedEntitlements,
              policy.expectedTeamIdentifier,
              policy.expectedBundleIdentifier,
              false,
            ),
          }
        : undefined
      kinds.push(kind)
      objects.push(signatureObject(appRoot, path, kind, result.architectures, result.verification, developerId))
    } catch (error) {
      throw new Error(`Disallowed Mach-O signature: ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (machOCount === 0) throw new Error(`No Mach-O files found in ${appRoot}`)
  if (new Set(objects.map((object) => object.path)).size !== objects.length) {
    throw new Error(`Duplicate code-object evidence path in ${appRoot}`)
  }
  return { machOCount, kinds, objects }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const appPath = args.shift()
  if (!appPath) throw new Error("Usage: verify-macos-signatures.ts APP_PATH [REQUIRED_ARM64_MACHO_PATH] [--mode unsigned|developer-id ...]")
  const canonicalAppPath = realDirectory(appPath, "App root")
  const requiredMachOPath = args[0] && !args[0].startsWith("--") ? args.shift() : undefined
  const options = new Map<string, string>()
  while (args.length > 0) {
    const key = args.shift()
    const value = args.shift()
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--") || options.has(key)) {
      throw new Error("Invalid or duplicate signature verifier option")
    }
    options.set(key, value)
  }
  const mode = options.get("--mode") ?? "unsigned"
  let verificationPolicy: VerificationPolicy = { mode: "unsigned" }
  let developerIdEvidence: MacOsSignatureVerificationEvidence["developerId"] | undefined
  if (mode === "developer-id") {
    const expectedAuthority = options.get("--authority")
    const expectedTeamIdentifier = options.get("--team-id")
    const expectedBundleIdentifier = options.get("--bundle-id")
    const entitlementsPath = options.get("--entitlements")
    if (!expectedAuthority || !expectedTeamIdentifier || !expectedBundleIdentifier || !entitlementsPath) {
      throw new Error("developer-id mode requires --authority, --team-id, --bundle-id, and --entitlements")
    }
    if (!/^[A-Z0-9]{10}$/.test(expectedTeamIdentifier)) throw new Error("Expected Team ID must be 10 uppercase letters or digits")
    const canonicalEntitlementsPath = realRegularFile(entitlementsPath, "Expected entitlements")
    const plist = command("plutil", ["-convert", "json", "-o", "-", "--", canonicalEntitlementsPath])
    if (plist.exitCode !== 0) throw new Error(`Unable to parse expected entitlements: ${plist.output}`)
    const expectedEntitlements: unknown = JSON.parse(plist.output)
    if (!exactObject(expectedEntitlements)) throw new Error("Expected entitlements must be a dictionary")
    const bundle = command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(canonicalAppPath, "Contents", "Info.plist")])
    if (bundle.exitCode !== 0) throw new Error(`Unable to read app Bundle ID: ${bundle.output}`)
    verificationPolicy = {
      mode,
      expectedAuthority,
      expectedTeamIdentifier,
      expectedBundleIdentifier,
      actualBundleIdentifier: bundle.output,
      expectedEntitlements: expectedEntitlements as Entitlements,
    }
    developerIdEvidence = {
      authority: expectedAuthority,
      teamIdentifier: expectedTeamIdentifier,
      bundleIdentifier: expectedBundleIdentifier,
      entitlementsSha256: createHash("sha256").update(readFileSync(canonicalEntitlementsPath)).digest("hex"),
    }
  } else if (mode !== "unsigned") {
    throw new Error(`Unsupported signature verification mode: ${mode}`)
  }
  const allowedOptions = mode === "developer-id"
    ? new Set(["--mode", "--authority", "--team-id", "--bundle-id", "--entitlements"])
    : new Set(["--mode"])
  for (const key of options.keys()) if (!allowedOptions.has(key)) throw new Error(`Unsupported signature verifier option: ${key}`)
  const result = verifyMacOsSignatures(canonicalAppPath, systemInspector, verificationPolicy)
  let requiredMachOFileType: string | undefined
  if (requiredMachOPath) {
    const requiredPath = resolveRequiredMachO(canonicalAppPath, requiredMachOPath)
    const inspection = command("otool", ["-hv", requiredPath])
    if (inspection.exitCode !== 0) throw new Error(`otool failed for required Mach-O: ${inspection.output}`)
    requiredMachOFileType = parseMachOFileType(inspection.output)
  }
  const evidencePolicy = mode === "developer-id" ? "developer-id-strict" : "unsigned-or-strictly-verified-adhoc"
  console.log(JSON.stringify(buildMacOsSignatureEvidence(result, requiredMachOPath, requiredMachOFileType, evidencePolicy, developerIdEvidence), null, 2))
}
