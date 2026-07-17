import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function fixture() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "macos-container-root-")))
  const dmg = join(root, "dmg")
  const zip = join(root, "zip")
  const expected = join(root, "expected")
  mkdirSync(join(dmg, "Simulator.app"), { recursive: true })
  mkdirSync(join(zip, "Simulator.app"), { recursive: true })
  mkdirSync(expected)
  writeFileSync(join(dmg, ".DS_Store"), "finder")
  writeFileSync(join(dmg, ".background.tiff"), "background")
  writeFileSync(join(dmg, ".VolumeIcon.icns"), "icon")
  writeFileSync(join(expected, "background.tiff"), "background")
  writeFileSync(join(expected, "icon.icns"), "icon")
  symlinkSync("/Applications", join(dmg, "Applications"))
  return { dmg, zip, expected }
}

function verify(mode: "dmg" | "zip", paths: string[]) {
  return spawnSync("python3", [join(import.meta.dir, "verify-macos-container-root.py"), mode, ...paths], {
    encoding: "utf8",
  })
}

describe("macOS package root closure", () => {
  test("accepts exact DMG presentation bytes and exact Simulator.app ZIP root", () => {
    const { dmg, zip, expected } = fixture()
    expect(verify("dmg", [dmg, join(expected, "background.tiff"), join(expected, "icon.icns")]).status).toBe(0)
    expect(verify("zip", [zip]).status).toBe(0)
  })

  test.each(["extra.command", "Anything.app"])("rejects extra or renamed DMG root payload %s", (name) => {
    const { dmg, expected } = fixture()
    writeFileSync(join(dmg, name), "payload", { mode: 0o755 })
    const result = verify("dmg", [dmg, join(expected, "background.tiff"), join(expected, "icon.icns")])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("exact Finder presentation closure")
  })

  test("rejects wrong presentation bytes and Applications target", () => {
    const { dmg, expected } = fixture()
    writeFileSync(join(dmg, ".background.tiff"), "changed")
    let result = verify("dmg", [dmg, join(expected, "background.tiff"), join(expected, "icon.icns")])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("exact source bytes")
    rmSync(join(dmg, ".background.tiff"))
    writeFileSync(join(dmg, ".background.tiff"), "background")
    rmSync(join(dmg, "Applications"))
    symlinkSync("/tmp", join(dmg, "Applications"))
    result = verify("dmg", [dmg, join(expected, "background.tiff"), join(expected, "icon.icns")])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("exact /Applications symlink")
  })

  test("rejects a renamed ZIP app or extra root file", () => {
    const { zip } = fixture()
    rmSync(join(zip, "Simulator.app"), { recursive: true })
    mkdirSync(join(zip, "Anything.app"))
    let result = verify("zip", [zip])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("exactly Simulator.app")
    rmSync(join(zip, "Anything.app"), { recursive: true })
    mkdirSync(join(zip, "Simulator.app"))
    writeFileSync(join(zip, "extra.command"), "payload")
    result = verify("zip", [zip])
    expect(result.status).toBe(1)
  })
})
