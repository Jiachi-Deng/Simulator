import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"

interface PackageManifest {
  name?: string
  version?: string
}

export interface VersionMismatch {
  path: string
  name: string
  expected: string
  actual: string
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest
}

interface BunLockWorkspace {
  name?: string
  version?: string
}

interface BunLock {
  workspaces?: Record<string, BunLockWorkspace>
}

function lockWorkspaceKey(rootDir: string, manifestPath: string): string {
  return relative(rootDir, dirname(manifestPath)).split(sep).join("/")
}

export function workspaceManifestPaths(rootDir: string): string[] {
  const paths = [join(rootDir, "package.json")]

  for (const directory of ["apps", "packages"] as const) {
    const parent = join(rootDir, directory)
    if (!existsSync(parent)) continue
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || (directory === "apps" && entry.name === "online-docs")) {
        continue
      }
      const manifestPath = join(parent, entry.name, "package.json")
      if (existsSync(manifestPath)) {
        paths.push(manifestPath)
      }
    }
  }

  return paths.sort()
}

export function findVersionMismatches(rootDir: string): VersionMismatch[] {
  const rootPath = join(rootDir, "package.json")
  const expected = readManifest(rootPath).version
  if (!expected) {
    throw new Error(`Root package is missing a version: ${rootPath}`)
  }

  const manifestPaths = workspaceManifestPaths(rootDir)
  const manifestMismatches = manifestPaths
    .filter((path) => path !== rootPath)
    .map((path) => ({ path, manifest: readManifest(path) }))
    .filter(({ manifest }) => manifest.version !== expected)
    .map(({ path, manifest }) => ({
      path,
      name: manifest.name ?? "<unnamed>",
      expected,
      actual: manifest.version ?? "<missing>",
    }))

  const lockPath = join(rootDir, "bun.lock")
  if (!existsSync(lockPath)) {
    return [
      ...manifestMismatches,
      { path: lockPath, name: "bun.lock", expected, actual: "<missing>" },
    ]
  }
  const lock = Bun.JSONC.parse(readFileSync(lockPath, "utf8")) as BunLock
  if (!lock.workspaces || typeof lock.workspaces !== "object") {
    throw new Error(`bun.lock is missing its workspaces table: ${lockPath}`)
  }
  const lockMismatches = manifestPaths
    .filter((path) => path !== rootPath)
    .map((path) => {
      const key = lockWorkspaceKey(rootDir, path)
      const workspace = lock.workspaces?.[key]
      return {
        path: `${lockPath}#workspaces/${key}`,
        name: workspace?.name ?? readManifest(path).name ?? key,
        expected,
        actual: workspace?.version ?? "<missing>",
      }
    })
    .filter((entry) => entry.actual !== expected)

  return [...manifestMismatches, ...lockMismatches]
}

if (import.meta.main) {
  const rootDir = join(import.meta.dir, "..")
  const mismatches = findVersionMismatches(rootDir)

  if (mismatches.length > 0) {
    console.error("Workspace package versions must match the root package version:")
    for (const mismatch of mismatches) {
      console.error(
        `- ${mismatch.name}: expected ${mismatch.expected}, found ${mismatch.actual} (${mismatch.path})`,
      )
    }
    process.exit(1)
  }

  const version = readManifest(join(rootDir, "package.json")).version
  console.log(`All distributable workspaces use version ${version}.`)
}
