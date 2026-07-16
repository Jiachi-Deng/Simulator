import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { productVersionFromRcLabel, validateEngineeringRc, type RepositoryState } from "./engineering-rc"

const root = join(import.meta.dir, ".tmp-engineering-rc")
const rcLabel = "1.2.3-rc.4"
const productVersion = "1.2.3"
const sha = "a".repeat(40)

function write(path: string, content: string): void {
  const fullPath = join(root, path)
  mkdirSync(join(fullPath, ".."), { recursive: true })
  writeFileSync(fullPath, content)
}

function fixture(): void {
  write("package.json", JSON.stringify({ name: "root", version: productVersion }))
  write("apps/electron/package.json", JSON.stringify({ name: "desktop", version: productVersion }))
  write(`apps/electron/resources/release-notes/${productVersion}.md`, `# Simulator ${productVersion}\n\n- Shippable change.\n`)
  write("apps/electron/resources/release-notes/next.md", "# Pending Release Notes\n\nThis file accumulates release notes for the next unreleased version.\n\n## Features\n\n## Improvements\n\n## Bug Fixes\n\n## Breaking Changes\n")
}

function repository(overrides: Partial<RepositoryState> = {}): RepositoryState {
  return { dirty: false, sourceSha: sha, mainSha: sha, tags: [], ...overrides }
}

function validate(overrides: Partial<Parameters<typeof validateEngineeringRc>[0]> = {}) {
  return validateEngineeringRc({ rootDir: root, rcLabel, ref: sha, repository: repository(), ...overrides })
}

function failedIds(result: ReturnType<typeof validate>): string[] {
  return result.checks.filter((check) => !check.ok).map((check) => check.id)
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("engineering RC contract", () => {
  test("accepts a deterministic valid snapshot", () => {
    fixture()
    const first = validate()
    expect(first.ok).toBe(true)
    expect(first.rcLabel).toBe(rcLabel)
    expect(first.productVersion).toBe(productVersion)
    expect(JSON.stringify(first)).toBe(JSON.stringify(validate()))
  })

  test("derives the Host product version from an RC bundle label", () => {
    expect(productVersionFromRcLabel(rcLabel)).toBe(productVersion)
    expect(productVersionFromRcLabel(productVersion)).toBeNull()
  })

  test("rejects dirty and non-main repository state through injection", () => {
    fixture()
    const result = validate({ repository: repository({ dirty: true, mainSha: "b".repeat(40) }) })
    expect(failedIds(result)).toContain("repository.clean")
    expect(failedIds(result)).toContain("repository.exact-main")
  })

  test("rejects an existing tag", () => {
    fixture()
    expect(failedIds(validate({ repository: repository({ tags: [`v${rcLabel}`] }) }))).toContain("repository.tag-available")
  })

  test("rejects empty versioned notes", () => {
    fixture()
    write(`apps/electron/resources/release-notes/${productVersion}.md`, "# Release\n")
    expect(failedIds(validate())).toContain("release-note.product-versioned")
  })

  test("rejects a release note heading without the exact product version", () => {
    fixture()
    write(`apps/electron/resources/release-notes/${productVersion}.md`, `# Simulator ${rcLabel}\n\n- Shippable change.\n`)
    expect(failedIds(validate())).toContain("release-note.product-versioned")
  })

  test.each([
    `# Simulator ${productVersion}\n\n---\n`,
    `# Simulator ${productVersion}\n\n- ---\n`,
    `# Simulator ${productVersion}\n\n- This file accumulates release notes for the next unreleased version.\n`,
  ])("rejects separators or template prose as release note content", (content) => {
    fixture()
    write(`apps/electron/resources/release-notes/${productVersion}.md`, content)
    expect(failedIds(validate())).toContain("release-note.product-versioned")
  })

  test("rejects pending notes that were not archived", () => {
    fixture()
    write("apps/electron/resources/release-notes/next.md", "# Pending Release Notes\n\n## Features\n\n- Still pending.\n")
    expect(failedIds(validate())).toContain("release-note.next-archived")
  })

  test("rejects manifest mismatch", () => {
    fixture()
    write("packages/shared/package.json", JSON.stringify({ name: "shared", version: "1.2.2" }))
    expect(failedIds(validate())).toContain("manifests.product-version")
  })

  test("rejects putting the engineering RC label into Host manifests", () => {
    fixture()
    write("package.json", JSON.stringify({ name: "root", version: rcLabel }))
    write("apps/electron/package.json", JSON.stringify({ name: "desktop", version: rcLabel }))
    expect(failedIds(validate())).toContain("manifests.product-version")
  })

  test.each(["1.2.3-rc", "1.2.3-rc.0", "1.2.3-rc.01", "v1.2.3-rc.1"])("rejects bad RC label %s", (badLabel) => {
    fixture()
    expect(failedIds(validate({ rcLabel: badLabel }))).toContain("label.rc-semver")
  })

  test("rejects a stable version as an RC label", () => {
    fixture()
    expect(failedIds(validate({ rcLabel: "1.2.3" }))).toContain("label.rc-semver")
  })
})
