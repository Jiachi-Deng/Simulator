import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { gte, minVersion } from "semver"

const root = join(import.meta.dir, "..")
const beautifulMermaidPatchedVersion = "0.1.3"

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, relativePath), "utf8")) as Record<string, unknown>
}

function dependencyVersion(relativePath: string, dependency: string): string | undefined {
  const manifest = readJson(relativePath)
  const dependencies = manifest.dependencies as Record<string, string> | undefined
  return dependencies?.[dependency]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

describe("dependency policy", () => {
  test("pins beautiful-mermaid consistently across workspace manifests", () => {
    const rootRange = dependencyVersion("package.json", "beautiful-mermaid")

    expect(rootRange).toBeDefined()
    expect(rootRange).not.toBe("*")
    expect(minVersion(rootRange!)).not.toBeNull()
    expect(gte(minVersion(rootRange!)!, beautifulMermaidPatchedVersion)).toBeTrue()

    for (const manifest of [
      "packages/session-tools-core/package.json",
      "packages/ui/package.json",
    ]) {
      expect(dependencyVersion(manifest, "beautiful-mermaid"), manifest).toBe(rootRange)
    }
  })

  test("records the explicit workspace ranges in the root Bun lockfile", () => {
    const rootRange = dependencyVersion("package.json", "beautiful-mermaid")!
    const lockfile = readFileSync(join(root, "bun.lock"), "utf8")
    const declarations = lockfile.match(new RegExp(`"beautiful-mermaid": "${escapeRegExp(rootRange)}"`, "g")) ?? []
    const resolution = lockfile.match(/"beautiful-mermaid": \["beautiful-mermaid@([^"\]]+)"/)

    expect(declarations.length).toBe(3)
    expect(resolution).not.toBeNull()
    expect(gte(resolution![1]!, beautifulMermaidPatchedVersion)).toBeTrue()
  })
})
