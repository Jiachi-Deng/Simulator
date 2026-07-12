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

function isScriptTarget(token: string | undefined): token is string {
  return token !== undefined && SCRIPT_EXTENSION.test(token)
}

function addRunnerTarget(runner: string, args: string[], targets: Set<string>): void {
  let index = 0

  if (runner === "bun" && args[index] === "run") index += 1

  // Runner CLI flags evolve frequently. Conservatively require every script-like
  // argument to exist instead of maintaining an incomplete option allowlist.
  while (index < args.length) {
    const argument = args[index]!

    if (runner === "bash" || runner === "sh") {
      if (argument === "-c" || (/^-[^-]+$/.test(argument) && argument.includes("c"))) {
        const command = args[index + 1]
        if (command) {
          for (const target of directScriptTargets(command)) targets.add(target)
        }
        return
      }
    }

    if (isScriptTarget(argument)) targets.add(argument)
    index += 1
  }
}

function addCommandTargets(tokens: string[], targets: Set<string>): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if ((token.startsWith("./") || token.startsWith("../")) && isScriptTarget(token)) {
      targets.add(token)
      continue
    }

    if (token === "--config" || token.toLowerCase() === "-file") {
      const target = tokens[index + 1]
      if (isScriptTarget(target)) targets.add(target)
      continue
    }

    if (SCRIPT_RUNNERS.has(token)) {
      addRunnerTarget(token, tokens.slice(index + 1), targets)
    }
  }
}

export function directScriptTargets(command: string): string[] {
  const targets = new Set<string>()
  let commandTokens: string[] = []

  for (const token of parse(command, () => "")) {
    if (typeof token === "string") {
      commandTokens.push(token)
    } else {
      addCommandTargets(commandTokens, targets)
      commandTokens = []
    }
  }
  addCommandTargets(commandTokens, targets)

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
