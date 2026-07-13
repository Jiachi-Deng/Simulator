import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const root = join(import.meta.dir, "..")

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8")
}

function localMarkdownLinks(relativePath: string): string[] {
  return [...read(relativePath).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1]!.split("#", 1)[0]!)
    .filter((target) => target.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(target))
    .map((target) => resolve(root, dirname(relativePath), target))
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
    const operations = read("docs/RELEASE_OPERATIONS.md")
    const rcValidator = read("scripts/release/engineering-rc.ts")

    expect(policy).toContain("根目录 `package.json` 的 `version` 是 Host App 构建的版本事实源")
    expect(policy).toContain("当前 Engineering RC 不接受 release branch")
    expect(policy).toContain("同一版本/tag/artifact 名称不得覆盖或重新上传不同 bytes")
    expect(policy).toContain("通过 catalog 分发和安装的 Module artifact 拥有独立 SemVer")
    expect(policy).toContain("`packages/module-*` 实现 package")
    expect(policy).toContain("production updater disabled")
    expect(rcValidator).toContain("origin/main tip")
    expect(rcValidator).toContain("-rc\\.([1-9]\\d*)")
    expect(operations).toContain("必须从受保护的 `origin/main` tip 构建")
    expect(operations).toContain("禁止从 release branch")
    expect(read("README.md")).toContain("docs/VERSIONING.md")
    expect(read("CONTRIBUTING.md")).toContain("docs/adr/README.md")
    expect(read("SUPPORT.md")).toContain("docs/VERSIONING.md")
    expect(read("SUPPORT.md")).toContain("docs/adr/README.md")
    expect(operations).toContain("VERSIONING.md")
  })

  test("keeps every new local governance link resolvable", () => {
    for (const source of ["README.md", "CONTRIBUTING.md", "SUPPORT.md", "docs/VERSIONING.md", "docs/RELEASE_OPERATIONS.md", "docs/adr/README.md"]) {
      for (const target of localMarkdownLinks(source)) {
        expect(existsSync(target), `${source} links to missing ${target}`).toBeTrue()
      }
    }
  })
})
