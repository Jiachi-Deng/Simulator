import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { spawnSync } from "node:child_process"

export type SignatureKind = "unsigned" | "adhoc"

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
}

export interface MacOsSignatureVerification {
  machOCount: number
  kinds: SignatureKind[]
  objects: SignatureObjectEvidence[]
}

export interface MacOsSignatureVerificationEvidence extends MacOsSignatureVerification {
  readonly ok: true
  readonly policy: "unsigned-or-strictly-verified-adhoc"
  readonly requiredArm64MachOPath?: string
  readonly requiredArm64MachOFileType?: string
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
    policy: "unsigned-or-strictly-verified-adhoc",
    ...(requiredMachOPath ? { requiredArm64MachOPath: requiredMachOPath } : {}),
    ...(requiredMachOFileType ? { requiredArm64MachOFileType: requiredMachOFileType } : {}),
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
  const app = realpathSync(resolve(appPath))
  const candidate = join(app, ...parts)
  const metadata = lstatSync(candidate)
  if (!metadata.isFile() || metadata.isSymbolicLink() || realpathSync(candidate) !== candidate) {
    throw new Error(`Required Mach-O path must be a real regular file: ${relativePath}`)
  }
  return candidate
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
  }
}

function requireStrictVerification(path: string, kind: SignatureKind, verification: FileInspection["verification"]): void {
  if (kind === "unsigned") return
  if (verification.exitCode === 0) return
  throw new Error(`Strict ad hoc signature verification failed: ${path}: ${verification.output || `exit ${verification.exitCode}`}`)
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
): SignatureObjectEvidence {
  return {
    path: evidencePath(appPath, path),
    kind,
    architectures: architectures.trim() ? architectures.trim().split(/\s+/) : [],
    strictVerification: {
      required: kind === "adhoc",
      exitCode: verification.exitCode,
    },
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

export function verifyMacOsSignatures(appPath: string, inspect: Inspector = systemInspector): MacOsSignatureVerification {
  const appInspection = inspect(appPath)
  const appKind = classifyAllowedSignature(appInspection.signature)
  requireStrictVerification(appPath, appKind, appInspection.verification)
  const kinds = [appKind]
  const objects = [signatureObject(appPath, appPath, appKind, "", appInspection.verification)]
  let machOCount = 0
  for (const path of regularFiles(appPath)) {
    const result = inspect(path)
    if (!result.description.includes("Mach-O")) continue
    machOCount += 1
    if (result.architectures.trim() !== "arm64") throw new Error(`Mach-O is not arm64-only: ${path} (${result.architectures})`)
    try {
      const kind = classifyAllowedSignature(result.signature)
      requireStrictVerification(path, kind, result.verification)
      kinds.push(kind)
      objects.push(signatureObject(appPath, path, kind, result.architectures, result.verification))
    } catch (error) {
      throw new Error(`Disallowed Mach-O signature: ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (machOCount === 0) throw new Error(`No Mach-O files found in ${appPath}`)
  if (new Set(objects.map((object) => object.path)).size !== objects.length) {
    throw new Error(`Duplicate code-object evidence path in ${appPath}`)
  }
  return { machOCount, kinds, objects }
}

if (import.meta.main) {
  const [appPath, requiredMachOPath] = process.argv.slice(2)
  if (!appPath) throw new Error("Usage: verify-macos-signatures.ts APP_PATH [REQUIRED_ARM64_MACHO_PATH]")
  const result = verifyMacOsSignatures(appPath)
  let requiredMachOFileType: string | undefined
  if (requiredMachOPath) {
    const requiredPath = resolveRequiredMachO(appPath, requiredMachOPath)
    const inspection = command("otool", ["-hv", requiredPath])
    if (inspection.exitCode !== 0) throw new Error(`otool failed for required Mach-O: ${inspection.output}`)
    requiredMachOFileType = parseMachOFileType(inspection.output)
  }
  console.log(JSON.stringify(buildMacOsSignatureEvidence(result, requiredMachOPath, requiredMachOFileType), null, 2))
}
