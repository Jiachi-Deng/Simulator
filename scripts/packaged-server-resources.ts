import { builtinModules } from "node:module"
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
} from "node:fs"
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path"

export type PackagedPlatform = "darwin" | "linux" | "win32"
export type PackagedArch = "arm64" | "x64"

interface PackageManifest {
  main?: string
  module?: string
  type?: string
  version?: string
  exports?: unknown
}

const BUN_RUNTIME_MODULES = new Set(["node-fetch", "undici", "ws"])
const NODE_RUNTIME_MODULES = new Set(
  builtinModules.flatMap((name) => [name, name.startsWith("node:") ? name.slice(5) : `node:${name}`]),
)

export function currentPackagedPlatform(): PackagedPlatform {
  if (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32") {
    return process.platform
  }
  throw new Error(`Unsupported packaged server platform: ${process.platform}`)
}

export function currentPackagedArch(): PackagedArch {
  if (process.arch === "arm64" || process.arch === "x64") return process.arch
  throw new Error(`Unsupported packaged server architecture: ${process.arch}`)
}

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/")
  return specifier.split("/", 1)[0]
}

function packageSubpath(specifier: string): string {
  const name = packageName(specifier)
  return specifier.slice(name.length).replace(/^\//, "")
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function requireReadableFile(path: string, label: string, failures: string[]): boolean {
  try {
    const stats = lstatSync(path)
    if (!stats.isFile()) {
      failures.push(`${label} is not a regular file: ${path}`)
      return false
    }
    if (stats.size === 0) {
      failures.push(`${label} is empty: ${path}`)
      return false
    }
    accessSync(path, constants.R_OK)
    return true
  } catch (error) {
    failures.push(`${label} is missing or unreadable: ${path} (${error instanceof Error ? error.message : String(error)})`)
    return false
  }
}

function readManifest(path: string, failures: string[]): PackageManifest | undefined {
  if (!requireReadableFile(path, "package manifest", failures)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageManifest
  } catch (error) {
    failures.push(`package manifest is invalid JSON: ${path} (${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
}

function conditionalExport(value: unknown, kind: string): string | undefined {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const conditions = kind === "require-call"
    ? ["require", "node", "bun", "default"]
    : ["import", "bun", "node", "default", "require"]
  for (const condition of conditions) {
    const resolved = conditionalExport(record[condition], kind)
    if (resolved) return resolved
  }
  return undefined
}

function resolveAsFile(path: string): string | undefined {
  const candidates = extname(path)
    ? [path]
    : [path, `${path}.js`, `${path}.mjs`, `${path}.cjs`, join(path, "index.js"), join(path, "index.mjs"), join(path, "index.cjs")]
  for (const candidate of candidates) {
    try {
      if (lstatSync(candidate).isFile()) return candidate
    } catch {
      // Continue through candidates without consulting parent node_modules.
    }
  }
  return undefined
}

function resolveStrictPackageImport(
  serverRoot: string,
  specifier: string,
  kind: string,
  failures: string[],
): string | undefined {
  const name = packageName(specifier)
  const packageRoot = join(serverRoot, "node_modules", name)
  const manifestPath = join(packageRoot, "package.json")
  const manifest = readManifest(manifestPath, failures)
  if (!manifest) {
    failures.push(`dependency ${specifier} must be staged under ${join(serverRoot, "node_modules")}`)
    return undefined
  }

  const subpath = packageSubpath(specifier)
  let exportValue: unknown = manifest.exports
  if (exportValue && typeof exportValue === "object" && !Array.isArray(exportValue)) {
    const record = exportValue as Record<string, unknown>
    if (Object.keys(record).some((key) => key.startsWith("."))) {
      exportValue = record[subpath ? `./${subpath}` : "."]
    }
  }
  const exported = conditionalExport(exportValue, kind)
  const target = subpath
    ? exported ?? subpath
    : exported ?? (kind === "require-call" ? manifest.main : manifest.module ?? manifest.main) ?? "index.js"
  const resolved = resolveAsFile(resolve(packageRoot, target))
  if (!resolved || !isInside(packageRoot, resolved)) {
    failures.push(`dependency ${specifier} has no staged entrypoint inside ${packageRoot}`)
    return undefined
  }
  return resolved
}

function scanDependencyClosure(serverRoot: string, entrypoint: string, failures: string[]): Set<string> {
  const visited = new Set<string>()
  const packages = new Set<string>()
  const pending = [entrypoint]

  while (pending.length > 0) {
    const path = pending.pop()!
    if (visited.has(path) || !requireReadableFile(path, "JavaScript dependency", failures)) continue
    visited.add(path)

    let imports: ReturnType<Bun.Transpiler["scanImports"]>
    try {
      const source = readFileSync(path, "utf8").replace(/^#![^\n]*(?:\n|$)/, "")
      imports = new Bun.Transpiler({ loader: "js" }).scanImports(source)
    } catch (error) {
      failures.push(`JavaScript dependency cannot be parsed: ${path} (${error instanceof Error ? error.message : String(error)})`)
      continue
    }

    for (const dependency of imports) {
      const specifier = dependency.path
      if (NODE_RUNTIME_MODULES.has(specifier) || BUN_RUNTIME_MODULES.has(specifier)) continue

      if (specifier.startsWith(".") || isAbsolute(specifier)) {
        const resolved = resolveAsFile(resolve(dirname(path), specifier))
        if (!resolved || !isInside(serverRoot, resolved)) {
          failures.push(`dependency ${specifier} from ${path} is missing from the staged server closure`)
        } else {
          pending.push(resolved)
        }
        continue
      }

      packages.add(packageName(specifier))
      const resolved = resolveStrictPackageImport(serverRoot, specifier, dependency.kind, failures)
      if (resolved) pending.push(resolved)
    }
  }

  return packages
}

export function validatePackagedServerResources(resourcesRoot: string): { entrypoints: string[]; packages: string[] } {
  const targets = [
    { name: "session-mcp-server", entrypoint: join(resourcesRoot, "session-mcp-server", "index.js") },
    { name: "pi-agent-server", entrypoint: join(resourcesRoot, "pi-agent-server", "index.js") },
  ]
  const failures: string[] = []
  const allPackages = new Set<string>()

  for (const target of targets) {
    const serverRoot = join(resourcesRoot, target.name)
    if (!requireReadableFile(target.entrypoint, `${target.name} entrypoint`, failures)) continue
    const packages = scanDependencyClosure(serverRoot, target.entrypoint, failures)
    for (const name of packages) allPackages.add(name)
  }

  if (failures.length > 0) {
    throw new Error(`Packaged server resource validation failed:\n- ${failures.join("\n- ")}`)
  }
  return { entrypoints: targets.map((target) => target.entrypoint), packages: [...allPackages].sort() }
}

function parseCli(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--app" || !args[1]) {
    throw new Error("Usage: packaged-server-resources.ts --app /path/to/Simulator.app")
  }
  return join(resolve(args[1]), "Contents", "Resources", "app", "resources")
}

if (import.meta.main) {
  try {
    const result = validatePackagedServerResources(parseCli(process.argv.slice(2)))
    console.log(JSON.stringify({ ok: true, ...result }, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
