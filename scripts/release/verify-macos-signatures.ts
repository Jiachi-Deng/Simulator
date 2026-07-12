import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
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
}

export type Inspector = (path: string) => FileInspection

function command(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" })
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
}

const systemInspector: Inspector = (path) => ({
  description: command("file", ["-b", path]),
  architectures: command("lipo", ["-archs", path]),
  signature: command("codesign", ["-dvvv", path]),
})

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

export function verifyMacOsSignatures(appPath: string, inspect: Inspector = systemInspector): { machOCount: number; kinds: SignatureKind[] } {
  const appSignature = inspect(appPath).signature
  const kinds = [classifyAllowedSignature(appSignature)]
  let machOCount = 0
  for (const path of regularFiles(appPath)) {
    const result = inspect(path)
    if (!result.description.includes("Mach-O")) continue
    machOCount += 1
    if (result.architectures.trim() !== "arm64") throw new Error(`Mach-O is not arm64-only: ${path} (${result.architectures})`)
    try {
      kinds.push(classifyAllowedSignature(result.signature))
    } catch (error) {
      throw new Error(`Disallowed Mach-O signature: ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (machOCount === 0) throw new Error(`No Mach-O files found in ${appPath}`)
  return { machOCount, kinds }
}

if (import.meta.main) {
  const appPath = process.argv[2]
  if (!appPath) throw new Error("Usage: verify-macos-signatures.ts APP_PATH")
  const result = verifyMacOsSignatures(appPath)
  console.log(JSON.stringify({ ok: true, policy: "unsigned-or-strict-adhoc", ...result }, null, 2))
}
