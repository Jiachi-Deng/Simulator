import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

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

export function workspaceManifestPaths(rootDir: string): string[] {
  const paths = [join(rootDir, "package.json")]

  for (const directory of ["apps", "packages"] as const) {
    const parent = join(rootDir, directory)
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

  return workspaceManifestPaths(rootDir)
    .filter((path) => path !== rootPath)
    .map((path) => ({ path, manifest: readManifest(path) }))
    .filter(({ manifest }) => manifest.version !== expected)
    .map(({ path, manifest }) => ({
      path,
      name: manifest.name ?? "<unnamed>",
      expected,
      actual: manifest.version ?? "<missing>",
    }))
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
