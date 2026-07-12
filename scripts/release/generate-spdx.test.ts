import { describe, expect, test } from "bun:test"
import { generateSpdx, packagesFromBunLock } from "./generate-spdx"

const lock = `{
  "packages": {
    "z": ["zeta@2.0.0", "", {}],
    "a": ["@scope/alpha@1.0.0", "", {}],
    "nested/z": ["zeta@2.0.0", "", {}],
  }
}`

describe("minimal SPDX generator", () => {
  test("deduplicates and sorts locked resolutions", () => {
    expect(packagesFromBunLock(lock)).toEqual([
      { name: "@scope/alpha", version: "1.0.0" },
      { name: "zeta", version: "2.0.0" },
    ])
  })

  test("is deterministic for identical inputs and records its limitation", () => {
    const args = [lock, "1.2.3-rc.1", "a".repeat(40), "2026-01-02T03:04:05Z"] as const
    const first = generateSpdx(...args) as { creationInfo: { comment: string } }
    expect(JSON.stringify(first)).toBe(JSON.stringify(generateSpdx(...args)))
    expect(first.creationInfo.comment).toContain("minimal SBOM")
  })
})
