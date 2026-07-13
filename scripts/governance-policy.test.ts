import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8")
}

describe("governance documentation contract", () => {
  test("keeps an ADR lifecycle and a copyable template", () => {
    const guide = read("docs/adr/README.md")
    const template = read("docs/adr/0000-template.md")

    for (const status of ["Proposed", "Accepted", "Rejected", "Superseded"]) {
      expect(guide).toContain(`\`${status}\``)
    }
    expect(guide).toContain("只有合并到 `main` 且状态为 `Accepted` 的 ADR 才具有约束力")
    for (const heading of ["## Context", "## Decision", "## Alternatives Considered", "## Consequences", "## Security, Privacy, and Licensing", "## Rollout and Rollback", "## Verification"]) {
      expect(template).toContain(heading)
    }
  })

  test("binds versions, immutable RCs, modules, and release evidence", () => {
    const policy = read("docs/VERSIONING.md")

    expect(policy).toContain("根目录 `package.json` 的 `version` 是 Host App 构建的版本事实源")
    expect(policy).toContain("同一版本/tag/artifact 名称不得覆盖或重新上传不同 bytes")
    expect(policy).toContain("可下载 Module 拥有独立 SemVer")
    expect(policy).toContain("production updater disabled")
    expect(read("README.md")).toContain("docs/VERSIONING.md")
    expect(read("CONTRIBUTING.md")).toContain("docs/adr/README.md")
    expect(read("docs/RELEASE_OPERATIONS.md")).toContain("VERSIONING.md")
  })
})
