import { describe, expect, test } from "bun:test"
import { generateSpdx, packageVerificationCodeFromContent, packagedFilesFromChecksums, packagesFromBunLock } from "./generate-spdx"

const lock = `{
  "packages": {
    "z": ["zeta@2.0.0", "", {}],
    "a": ["@scope/alpha@1.0.0", "", {}],
    "nested/z": ["zeta@2.0.0", "", {}],
  }
}`
const inventory = `${"a".repeat(64)}  Contents/MacOS/Simulator\n${"b".repeat(64)}  Contents/Info.plist\n`
const packageVerificationCode = `${"c".repeat(40)}\n`

function assertSpdx23ArtifactPackageSchema(value: unknown): void {
  const artifactPackage = value as {
    SPDXID?: unknown
    filesAnalyzed?: unknown
    hasFiles?: unknown
    packageVerificationCode?: { packageVerificationCodeValue?: unknown }
  }
  if (artifactPackage.SPDXID !== "SPDXRef-Package-Simulator") throw new Error("SPDXID must identify the Simulator package")
  if (artifactPackage.filesAnalyzed !== true) throw new Error("filesAnalyzed must be true when the package contains files")
  if (!Array.isArray(artifactPackage.hasFiles) || artifactPackage.hasFiles.length === 0 || !artifactPackage.hasFiles.every((id) => /^SPDXRef-File-\d+$/.test(id))) {
    throw new Error("hasFiles must contain SPDX file IDs")
  }
  if (!/^[0-9a-f]{40}$/.test(String(artifactPackage.packageVerificationCode?.packageVerificationCodeValue))) {
    throw new Error("packageVerificationCode must be a SHA-1 value")
  }
}

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
    expect(packageVerificationCodeFromContent(packageVerificationCode)).toBe("c".repeat(40))
    expect(() => packageVerificationCodeFromContent("not-a-sha1")).toThrow()
  })

  test("matches the SPDX 2.3 artifact package schema and separates source-lock build inputs", () => {
    const args = [lock, inventory, packageVerificationCode, "1.2.3-rc.1", "a".repeat(40), "2026-01-02T03:04:05Z"] as const
    const first = generateSpdx(...args) as {
      creationInfo: { comment: string }
      files: Array<{ SPDXID: string; checksums: unknown[] }>
      packages: Array<{ SPDXID: string; filesAnalyzed?: boolean; hasFiles?: string[]; packageVerificationCode?: { packageVerificationCodeValue: string } }>
      relationships: Array<{ spdxElementId: string; relationshipType: string; relatedSpdxElement: string }>
    }
    expect(JSON.stringify(first)).toBe(JSON.stringify(generateSpdx(...args)))
    expect(first.files).toHaveLength(2)
    expect(first.files.every((file) => file.checksums.length === 1)).toBe(true)
    expect(first.relationships.some((item) => item.relationshipType === "CONTAINS")).toBe(true)
    expect(first.relationships.some((item) => item.relationshipType === "BUILD_DEPENDENCY_OF")).toBe(true)
    expect(first.relationships.some((item) => item.relationshipType === "DEPENDS_ON")).toBe(false)
    expect(first.creationInfo.comment).toContain("app-inventory.jsonl parity check")
    expect(first.creationInfo.comment).toContain("transport-stable")
    expect(first.creationInfo.comment).toContain("allowlist of macOS code-signing validation-cache")
    expect(first.creationInfo.comment).toContain("not claimed runtime dependencies")

    const artifactPackage = first.packages.find((item) => item.SPDXID === "SPDXRef-Package-Simulator")
    expect(() => assertSpdx23ArtifactPackageSchema(artifactPackage)).not.toThrow()
    expect(artifactPackage?.packageVerificationCode?.packageVerificationCodeValue).toBe("c".repeat(40))
  })

  test("keeps SPDX files, hasFiles, and CONTAINS relationships as one set", () => {
    const document = generateSpdx(lock, inventory, packageVerificationCode, "1.2.3-rc.1", "a".repeat(40), "2026-01-02T03:04:05Z") as {
      files: Array<{ SPDXID: string }>
      packages: Array<{ SPDXID: string; hasFiles?: string[] }>
      relationships: Array<{ spdxElementId: string; relationshipType: string; relatedSpdxElement: string }>
    }
    const artifactPackage = document.packages.find((item) => item.SPDXID === "SPDXRef-Package-Simulator")
    const fileIds = new Set(document.files.map((file) => file.SPDXID))
    const hasFiles = new Set(artifactPackage?.hasFiles)
    const contains = new Set(document.relationships
      .filter((item) => item.spdxElementId === "SPDXRef-Package-Simulator" && item.relationshipType === "CONTAINS")
      .map((item) => item.relatedSpdxElement))

    expect(hasFiles).toEqual(fileIds)
    expect(contains).toEqual(fileIds)
  })
})
