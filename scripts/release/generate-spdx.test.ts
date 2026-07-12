import { describe, expect, test } from "bun:test"
import { generateSpdx, packagedFilesFromChecksums, packagesFromBunLock } from "./generate-spdx"

const lock = `{
  "packages": {
    "z": ["zeta@2.0.0", "", {}],
    "a": ["@scope/alpha@1.0.0", "", {}],
    "nested/z": ["zeta@2.0.0", "", {}],
  }
}`
const inventory = `${"a".repeat(64)}  Contents/MacOS/Simulator\n${"b".repeat(64)}  Contents/Info.plist\n`

describe("minimal SPDX generator", () => {
  test("deduplicates and sorts locked resolutions", () => {
    expect(packagesFromBunLock(lock)).toEqual([
      { name: "@scope/alpha", version: "1.0.0" },
      { name: "zeta", version: "2.0.0" },
    ])
  })

  test("parses deterministic packaged file checksums", () => {
    expect(packagedFilesFromChecksums(inventory)).toEqual([
      { path: "Contents/Info.plist", sha256: "b".repeat(64) },
      { path: "Contents/MacOS/Simulator", sha256: "a".repeat(64) },
    ])
    expect(() => packagedFilesFromChecksums(`${"a".repeat(64)}  ../escape\n`)).toThrow()
  })

  test("separates artifact files from source-lock build inputs", () => {
    const args = [lock, inventory, "1.2.3-rc.1", "a".repeat(40), "2026-01-02T03:04:05Z"] as const
    const first = generateSpdx(...args) as {
      creationInfo: { comment: string }
      files: Array<{ checksums: unknown[] }>
      relationships: Array<{ relationshipType: string }>
    }
    expect(JSON.stringify(first)).toBe(JSON.stringify(generateSpdx(...args)))
    expect(first.files).toHaveLength(2)
    expect(first.files.every((file) => file.checksums.length === 1)).toBe(true)
    expect(first.relationships.some((item) => item.relationshipType === "CONTAINS")).toBe(true)
    expect(first.relationships.some((item) => item.relationshipType === "BUILD_DEPENDENCY_OF")).toBe(true)
    expect(first.relationships.some((item) => item.relationshipType === "DEPENDS_ON")).toBe(false)
    expect(first.creationInfo.comment).toContain("not claimed runtime dependencies")
  })
})
