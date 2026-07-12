import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { parse } from "shell-quote"
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

const SCRIPT_EXTENSION = /\.(?:ts|js|mjs|cjs|sh|ps1)$/
const SCRIPT_RUNNERS = new Set(["bun", "bash", "sh", "node"])

export function directScriptTargets(command: string): string[] {
  const targets = new Set<string>()
  const tokens = parse(command, () => "").filter((token): token is string => typeof token === "string")

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if ((token.startsWith("./") || token.startsWith("../")) && SCRIPT_EXTENSION.test(token)) {
      targets.add(token)
      continue
    }

    if (token === "--config" || token === "-c" || token.toLowerCase() === "-file") {
      const target = tokens[index + 1]
      if (target && SCRIPT_EXTENSION.test(target)) targets.add(target)
      continue
    }

    if (SCRIPT_RUNNERS.has(token)) {
      let targetIndex = index + 1
      if (token === "bun" && tokens[targetIndex] === "run") targetIndex += 1
      const target = tokens[targetIndex]
      if (target && SCRIPT_EXTENSION.test(target)) targets.add(target)
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
        if (
          !candidateDirectories.some((directory) => {
            const candidate = resolve(directory, target)
            return existsSync(candidate) && statSync(candidate).isFile()
          })
        ) {
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
