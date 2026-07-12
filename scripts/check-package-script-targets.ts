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

interface ScriptInvocation {
  cwd: string
  target: string
}

const SCRIPT_EXTENSION = /\.(?:ts|js|mjs|cjs|sh|ps1)$/
const SCRIPT_RUNNERS = new Set(["bun", "bash", "sh", "node"])

function isScriptTarget(token: string | undefined): token is string {
  return token !== undefined && SCRIPT_EXTENSION.test(token)
}

function addInvocation(
  invocations: ScriptInvocation[],
  cwd: string,
  target: string | undefined,
): void {
  if (isScriptTarget(target)) invocations.push({ cwd, target })
}

function addRunnerInvocations(
  runner: string,
  args: string[],
  cwd: string,
  invocations: ScriptInvocation[],
): void {
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
          invocations.push(...scriptInvocations(command, cwd))
        }
        return
      }
    }

    addInvocation(invocations, cwd, argument)
    index += 1
  }
}

function addCommandInvocations(
  tokens: string[],
  cwd: string,
  invocations: ScriptInvocation[],
): { cwd: string; changedDirectory: boolean } {
  if (tokens[0] === "cd" && tokens[1] && !tokens[1].startsWith("-")) {
    return { cwd: resolve(cwd, tokens[1]), changedDirectory: true }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if ((token.startsWith("./") || token.startsWith("../")) && isScriptTarget(token)) {
      addInvocation(invocations, cwd, token)
      continue
    }

    if (token === "--config" || token.toLowerCase() === "-file") {
      addInvocation(invocations, cwd, tokens[index + 1])
      continue
    }

    if (SCRIPT_RUNNERS.has(token)) {
      addRunnerInvocations(token, tokens.slice(index + 1), cwd, invocations)
    }
  }

  return { cwd, changedDirectory: false }
}

function scriptInvocations(command: string, initialCwd: string): ScriptInvocation[] {
  const invocations: ScriptInvocation[] = []
  let cwd = initialCwd
  let commandTokens: string[] = []
  const cwdStack: string[] = []
  let previousOperator: string | undefined

  const flush = (operator?: string) => {
    const conditionalCdIsChained =
      previousOperator === "&&" && (operator === "&&" || operator === undefined)
    if (
      commandTokens[0] === "cd" &&
      previousOperator !== undefined &&
      previousOperator !== ";" &&
      previousOperator !== "(" &&
      !conditionalCdIsChained
    ) {
      throw new Error(`Ambiguous conditional package-script cd after: ${previousOperator}`)
    }
    const result = addCommandInvocations(commandTokens, cwd, invocations)
    if (
      result.changedDirectory &&
      (operator === undefined || operator === "&&" || operator === ";")
    ) {
      cwd = result.cwd
    }
    commandTokens = []
    previousOperator = operator
  }

  for (const token of parse(command, () => "")) {
    if (typeof token === "string") commandTokens.push(token)
    else {
      if (token.op === "(") {
        flush(token.op)
        cwdStack.push(cwd)
        previousOperator = undefined
        continue
      }
      if (token.op === ")") {
        flush(token.op)
        const parentCwd = cwdStack.pop()
        if (parentCwd === undefined) throw new Error("Unbalanced package-script subshell")
        cwd = parentCwd
        previousOperator = ")"
        continue
      }
      flush(token.op)
    }
  }
  flush()
  if (cwdStack.length > 0) throw new Error("Unbalanced package-script subshell")

  return invocations
}

export function directScriptTargets(command: string): string[] {
  return [...new Set(scriptInvocations(command, ".").map(({ target }) => target))].sort()
}

export function findMissingScriptTargets(rootDir: string): MissingScriptTarget[] {
  const missing: MissingScriptTarget[] = []

  for (const manifestPath of workspaceManifestPaths(rootDir)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest
    for (const [scriptName, command] of Object.entries(manifest.scripts ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      for (const { cwd, target } of scriptInvocations(command, dirname(manifestPath))) {
        const candidate = resolve(cwd, target)
        if (!existsSync(candidate) || !statSync(candidate).isFile()) {
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
