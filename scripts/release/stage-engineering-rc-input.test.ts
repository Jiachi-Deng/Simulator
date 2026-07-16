import { afterEach, describe, expect, test } from "bun:test"
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stageEngineeringRcInput } from "./stage-engineering-rc-input"

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "simulator-engineering-rc-input-"))
  temporaryRoots.push(root)
  return root
}

function fixture(): { release: string; destination: string; root: string } {
  const root = temporaryRoot()
  const release = join(root, "release")
  const destination = join(root, "clean-input")
  mkdirSync(join(release, "nested"), { recursive: true })
  mkdirSync(destination, { mode: 0o755 })
  writeFileSync(join(release, "Simulator-arm64.dmg"), "dmg payload")
  writeFileSync(join(release, "Simulator-arm64.zip"), "zip payload")
  writeFileSync(join(release, "latest-mac.yml"), "must not be staged")
  writeFileSync(join(release, "Simulator-arm64.dmg.blockmap"), "must not be staged")
  writeFileSync(join(release, "nested/latest-mac.yaml"), "must not be staged")
  return { root, release, destination }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("engineering RC clean verification input", () => {
  test("copies only the exact DMG and ZIP into an owner-only directory", async () => {
    const { release, destination } = fixture()
    const evidence = await stageEngineeringRcInput(release, destination)

    expect(readdirSync(destination).sort()).toEqual(["Simulator-arm64.dmg", "Simulator-arm64.zip"])
    expect(lstatSync(destination).mode & 0o777).toBe(0o700)
    for (const file of evidence.files) {
      expect(lstatSync(join(destination, file.name)).mode & 0o777).toBe(0o600)
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(file.size).toBeGreaterThan(0)
    }
    expect(JSON.stringify(evidence)).not.toContain("latest-mac")
    expect(JSON.stringify(evidence)).not.toContain("blockmap")
  })

  test("emits deterministic evidence independent of temporary destination paths", async () => {
    const first = fixture()
    const second = fixture()
    const firstEvidence = await stageEngineeringRcInput(first.release, first.destination)
    const secondEvidence = await stageEngineeringRcInput(second.release, second.destination)
    expect(secondEvidence).toEqual(firstEvidence)
  })

  test("rejects a non-empty destination instead of mixing verification inputs", async () => {
    const { release, destination } = fixture()
    writeFileSync(join(destination, "latest-mac.yml"), "stale updater metadata")
    await expect(stageEngineeringRcInput(release, destination)).rejects.toThrow("must start empty")
  })

  test("rejects a symlink in place of an exact artifact", async () => {
    const { release, destination } = fixture()
    const target = join(release, "real.dmg")
    writeFileSync(target, "real payload")
    rmSync(join(release, "Simulator-arm64.dmg"))
    symlinkSync(target, join(release, "Simulator-arm64.dmg"))
    await expect(stageEngineeringRcInput(release, destination)).rejects.toThrow("must be a regular file, not a symlink")
  })
})
