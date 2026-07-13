import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { validateEngineeringRc, type RepositoryState } from "./engineering-rc"

const root = join(import.meta.dir, ".tmp-engineering-rc")
const version = "1.2.3-rc.4"
const sha = "a".repeat(40)

function write(path: string, content: string): void {
  const fullPath = join(root, path)
  mkdirSync(join(fullPath, ".."), { recursive: true })
  writeFileSync(fullPath, content)
}

function fixture(): void {
  write("package.json", JSON.stringify({ name: "root", version }))
  write("apps/electron/package.json", JSON.stringify({ name: "desktop", version }))
  write(`apps/electron/resources/release-notes/${version}.md`, `# Simulator ${version}\n\n- Shippable change.\n`)
  write("apps/electron/resources/release-notes/next.md", "# Pending Release Notes\n\nThis file accumulates release notes for the next unreleased version.\n\n## Features\n\n## Improvements\n\n## Bug Fixes\n\n## Breaking Changes\n")
}

function repository(overrides: Partial<RepositoryState> = {}): RepositoryState {
  return { dirty: false, sourceSha: sha, mainSha: sha, tags: [], ...overrides }
}

function validate(overrides: Partial<Parameters<typeof validateEngineeringRc>[0]> = {}) {
  return validateEngineeringRc({ rootDir: root, version, ref: sha, repository: repository(), ...overrides })
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
    expect(JSON.stringify(first)).toBe(JSON.stringify(validate()))
  })

  test("rejects dirty and non-main repository state through injection", () => {
    fixture()
    const result = validate({ repository: repository({ dirty: true, mainSha: "b".repeat(40) }) })
    expect(failedIds(result)).toContain("repository.clean")
    expect(failedIds(result)).toContain("repository.exact-main")
  })

  test("rejects an existing tag", () => {
    fixture()
    expect(failedIds(validate({ repository: repository({ tags: [`v${version}`] }) }))).toContain("repository.tag-available")
  })

  test("rejects empty versioned notes", () => {
    fixture()
    write(`apps/electron/resources/release-notes/${version}.md`, "# Release\n")
    expect(failedIds(validate())).toContain("release-note.versioned")
  })

  test("rejects a release note heading without the exact version", () => {
    fixture()
    write(`apps/electron/resources/release-notes/${version}.md`, "# Simulator 1.2.3-rc.40\n\n- Shippable change.\n")
    expect(failedIds(validate())).toContain("release-note.versioned")
  })

  test.each([
    `# Simulator ${version}\n\n---\n`,
    `# Simulator ${version}\n\n- ---\n`,
    `# Simulator ${version}\n\n- This file accumulates release notes for the next unreleased version.\n`,
  ])("rejects separators or template prose as release note content", (content) => {
    fixture()
    write(`apps/electron/resources/release-notes/${version}.md`, content)
    expect(failedIds(validate())).toContain("release-note.versioned")
  })

  test("rejects pending notes that were not archived", () => {
    fixture()
    write("apps/electron/resources/release-notes/next.md", "# Pending Release Notes\n\n## Features\n\n- Still pending.\n")
    expect(failedIds(validate())).toContain("release-note.next-archived")
  })

  test("rejects manifest mismatch", () => {
    fixture()
    write("packages/shared/package.json", JSON.stringify({ name: "shared", version: "1.2.2" }))
    expect(failedIds(validate())).toContain("manifests.version")
  })

  test.each(["1.2.3-rc", "1.2.3-rc.0", "1.2.3-rc.01", "v1.2.3-rc.1"])("rejects bad RC version %s", (badVersion) => {
    fixture()
    expect(failedIds(validate({ version: badVersion }))).toContain("version.rc-semver")
  })

  test("rejects a stable version", () => {
    fixture()
    expect(failedIds(validate({ version: "1.2.3" }))).toContain("version.rc-semver")
  })
})
