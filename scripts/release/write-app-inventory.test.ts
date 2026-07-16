import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
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
    const verificationCode = join(root, "package-verification-code.txt")
    const result = Bun.spawnSync(["python3", script, app, inventory, "--transport-canonicalization-policy", "macos-dmg-zip-v1", "--spdx-files", checksums, "--spdx-package-verification-code", verificationCode])
    expect(result.exitCode).toBe(0)

    const entries = readFileSync(inventory, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ".", type: "directory", mode: expect.stringMatching(/^[0-7]{4}$/), uid: expect.any(Number), gid: expect.any(Number), flags: expect.any(Number), xattrs: expect.any(Array) }),
      expect.objectContaining({ path: "Contents", type: "directory" }),
      expect.objectContaining({ path: "Contents/MacOS/Simulator", type: "file", mode: "0751", sha1: expect.stringMatching(/^[0-9a-f]{40}$/), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ path: "Contents/Current", type: "symlink", target: "MacOS/Simulator", mode: "0777" }),
    ]))
    expect(readFileSync(checksums, "utf8")).toContain("  Contents/MacOS/Simulator\n")
    expect(readFileSync(checksums, "utf8")).not.toContain("Contents/Current")
    const fileSha1s = entries.filter((entry) => entry.type === "file").map((entry) => entry.sha1).sort()
    const expectedVerificationCode = createHash("sha1").update(fileSha1s.join("")).digest("hex")
    expect(readFileSync(verificationCode, "utf8")).toBe(`${expectedVerificationCode}\n`)
  })

  test("ignores macOS code-signing cache xattrs while retaining semantic xattrs", () => {
    if (process.platform !== "darwin") return

    const app = join(root, "Simulator.app")
    const resource = join(app, "Contents", "Resources", "data.bin")
    const executable = join(app, "Contents", "MacOS", "Simulator")
    mkdirSync(join(app, "Contents", "Resources"), { recursive: true, mode: 0o755 })
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true, mode: 0o755 })
    writeFileSync(resource, "resource")
    writeFileSync(executable, "binary")
    chmodSync(executable, 0o755)
    expect(Bun.spawnSync(["xattr", "-w", "com.apple.cs.CodeDirectory", "validation-cache", resource]).exitCode).toBe(0)
    expect(Bun.spawnSync(["xattr", "-w", "com.simulator.semantic", "retain-me", resource]).exitCode).toBe(0)
    expect(Bun.spawnSync(["xattr", "-w", "com.apple.cs.CodeDirectory", "must-remain-exact", executable]).exitCode).toBe(0)

    const inventory = join(root, "app-inventory.jsonl")
    const rawInventory = join(root, "app-inventory.raw.jsonl")
    const result = Bun.spawnSync([
      "python3", script, app, inventory, "--transport-canonicalization-policy", "macos-dmg-zip-v1", "--raw-inventory", rawInventory, "--spdx-files", join(root, "checksums.sha256"),
      "--spdx-package-verification-code", join(root, "verification-code.txt"),
    ])
    expect(result.exitCode).toBe(0)

    const entries = readFileSync(inventory, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    const file = entries.find((entry) => entry.path === "Contents/Resources/data.bin")
    const names = file.xattrs.map((attribute: { name: string }) => attribute.name)
    expect(names).toContain("com.simulator.semantic")
    expect(names.some((name: string) => name.startsWith("com.apple.cs."))).toBe(false)
    const executableEntry = entries.find((entry) => entry.path === "Contents/MacOS/Simulator")
    expect(executableEntry.xattrs.map((attribute: { name: string }) => attribute.name)).toContain("com.apple.cs.CodeDirectory")

    const rawEntries = readFileSync(rawInventory, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    const rawFile = rawEntries.find((entry) => entry.path === "Contents/Resources/data.bin")
    const rawNames = rawFile.xattrs.map((attribute: { name: string }) => attribute.name)
    expect(rawNames).toContain("com.apple.cs.CodeDirectory")
    expect(rawNames).toContain("com.simulator.semantic")
  })

  test("rejects a symlinked app root without following it", () => {
    const target = join(root, "real.app")
    const app = join(root, "Simulator.app")
    mkdirSync(target, { recursive: true })
    symlinkSync(target, app)

    const result = Bun.spawnSync([
      "python3", script, app, join(root, "inventory.jsonl"), "--transport-canonicalization-policy", "macos-dmg-zip-v1", "--spdx-files", join(root, "checksums.sha256"),
      "--spdx-package-verification-code", join(root, "verification-code.txt"),
    ])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("Symbolic links are not allowed for app bundle roots")
  })

  test("requires an explicit transport canonicalization policy", () => {
    const app = join(root, "Simulator.app")
    mkdirSync(app, { recursive: true })
    const result = Bun.spawnSync([
      "python3", script, app, join(root, "inventory.jsonl"), "--spdx-files", join(root, "checksums.sha256"),
      "--spdx-package-verification-code", join(root, "verification-code.txt"),
    ])
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain("--transport-canonicalization-policy")
  })
})
