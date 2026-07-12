import { existsSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { workspaceManifestPaths } from "./check-version"

interface PackageManifest {
  name?: string
  scripts?: Record<string, string>
}

export interface MissingScriptTarget {
  manifestPath: string
  packageName: string
  scriptName: string
  target: string
}

const DIRECT_SCRIPT_PATTERNS = [
  /\b(?:bun(?:\s+run)?|bash|sh)\s+([\w./-]+\.(?:ts|js|mjs|cjs|sh))\b/g,
  /\bpowershell\b[^;&|]*?\s-File\s+([\w./-]+\.ps1)\b/g,
]

export function directScriptTargets(command: string): string[] {
  const targets = new Set<string>()
  for (const pattern of DIRECT_SCRIPT_PATTERNS) {
    for (const match of command.matchAll(pattern)) {
      if (match[1]) targets.add(match[1])
    }
  }
  return [...targets].sort()
}

export function findMissingScriptTargets(rootDir: string): MissingScriptTarget[] {
  const missing: MissingScriptTarget[] = []

  for (const manifestPath of workspaceManifestPaths(rootDir)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest
    for (const [scriptName, command] of Object.entries(manifest.scripts ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const commandDirectories = [...command.matchAll(/(?:^|[;&|]\s*)cd\s+([\w./-]+)/g)].map(
        (match) => resolve(dirname(manifestPath), match[1]!),
      )
      for (const target of directScriptTargets(command)) {
        const candidateDirectories = [dirname(manifestPath), rootDir, ...commandDirectories]
        if (!candidateDirectories.some((directory) => existsSync(resolve(directory, target)))) {
          missing.push({
            manifestPath: relative(rootDir, manifestPath),
            packageName: manifest.name ?? "<unnamed>",
            scriptName,
            target,
          })
        }
      }
    }
  }

  return missing
}

if (import.meta.main) {
  const rootDir = resolve(import.meta.dir, "..")
  const missing = findMissingScriptTargets(rootDir)
  if (missing.length > 0) {
    console.error("Package scripts reference missing files:")
    for (const item of missing) {
      console.error(
        `- ${item.packageName}#${item.scriptName}: ${item.target} (${item.manifestPath})`,
      )
    }
    process.exit(1)
  }
  console.log("All direct package script file targets exist.")
}
