import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, ".tmp-app-inventory")
const script = join(import.meta.dir, "write-app-inventory.py")

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("app bundle inventory", () => {
  test("records files, directories, symlink targets, and security metadata", () => {
    const app = join(root, "Simulator.app")
    const executable = join(app, "Contents", "MacOS", "Simulator")
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true, mode: 0o755 })
    writeFileSync(executable, "binary")
    chmodSync(executable, 0o751)
    writeFileSync(join(app, "Contents", "Info.plist"), "plist")
    symlinkSync("MacOS/Simulator", join(app, "Contents", "Current"))

    const inventory = join(root, "app-inventory.jsonl")
    const checksums = join(root, "packaged-files.sha256")
    const result = Bun.spawnSync(["python3", script, app, inventory, "--spdx-files", checksums])
    expect(result.exitCode).toBe(0)

    const entries = readFileSync(inventory, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ".", type: "directory", mode: expect.stringMatching(/^[0-7]{4}$/), uid: expect.any(Number), gid: expect.any(Number), flags: expect.any(Number), xattrs: expect.any(Array) }),
      expect.objectContaining({ path: "Contents", type: "directory" }),
      expect.objectContaining({ path: "Contents/MacOS/Simulator", type: "file", mode: "0751", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ path: "Contents/Current", type: "symlink", target: "MacOS/Simulator" }),
    ]))
    expect(readFileSync(checksums, "utf8")).toContain("  Contents/MacOS/Simulator\n")
    expect(readFileSync(checksums, "utf8")).not.toContain("Contents/Current")
  })
})
