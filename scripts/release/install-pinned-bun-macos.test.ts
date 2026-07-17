import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const installer = readFileSync(join(import.meta.dir, "install-pinned-bun-macos.sh"), "utf8")
const workflow = readFileSync(join(import.meta.dir, "../../.github/workflows/engineering-rc.yml"), "utf8")

describe("digest-pinned macOS Bun authority", () => {
  test("pins exact transport bytes and executable identity before use", () => {
    expect(installer).toContain("bun-v1.3.10/bun-darwin-aarch64.zip")
    expect(installer).toContain("82034e87c9d9b4398ea619aee2eed5d2a68c8157e9a6ae2d1052d84d533ccd8d")
    expect(installer).toContain('BUN_ASSET_BYTES="22289708"')
    expect(installer).toContain('BUN_BINARY_SHA256="14b0008f960ea480de5d25df5ea0ada0fefa086a15e360ef2d305f44cae8f904"')
    expect(installer).toContain('BUN_BINARY_BYTES="60953744"')
    expect(installer).toContain('BUN_REVISION="1.3.10+30e609e08"')
    expect(installer.indexOf("shasum -a 256 -c -")).toBeLessThan(installer.indexOf("ditto -x -k"))
    expect(installer.indexOf("ditto -x -k")).toBeLessThan(installer.indexOf('"$bun_binary" --revision'))
    expect(installer.indexOf('BUN_BINARY_SHA256" "$bun_binary"')).toBeLessThan(installer.indexOf('"$bun_binary" --revision'))
    expect(installer).toContain("--proto-redir '=https'")
    expect(installer).toContain("--max-filesize 30000000")
  })

  test("uses the same pinned installer in all four isolated jobs", () => {
    expect(workflow).not.toContain("oven-sh/setup-bun@")
    expect(workflow.match(/scripts\/release\/install-pinned-bun-macos\.sh/g)).toHaveLength(4)
    expect(workflow.match(/scripts\/release\/stage-pinned-macos-arm64-runtimes\.sh/g)).toHaveLength(2)
    expect(workflow).not.toContain("astral-sh/setup-uv@")
  })
})
