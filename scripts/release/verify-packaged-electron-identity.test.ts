import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyPackagedElectronIdentity } from "./verify-packaged-electron-identity"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(overrides: Record<string, unknown> = {}): { app: string; packageRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "simulator-packaged-identity-"))
  roots.push(root)
  const app = join(root, "Simulator.app")
  const packageRoot = join(app, "Contents", "Resources", "app")
  mkdirSync(join(packageRoot, "dist"), { recursive: true })
  writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({
    name: "@craft-agent/electron",
    version: "0.12.0",
    main: "dist/main.cjs",
    ...overrides,
  })}\n`)
  writeFileSync(join(packageRoot, "dist", "main.cjs"), "module.exports = {}\n")
  return { app, packageRoot }
}

describe("packaged Electron identity", () => {
  test("binds the packaged manifest and main entry to the Host version", () => {
    const { app } = fixture()
    expect(verifyPackagedElectronIdentity(app, "0.12.0")).toMatchObject({
      name: "@craft-agent/electron",
      version: "0.12.0",
      main: "dist/main.cjs",
    })
  })

  test.each([
    [{ version: "0.11.1" }, "version mismatch"],
    [{ name: "unexpected-app" }, "name mismatch"],
    [{ main: "../outside.cjs" }, "main mismatch"],
    [{ main: "/tmp/outside.cjs" }, "main mismatch"],
  ] as const)("rejects manifest identity drift %#", (overrides, message) => {
    const { app } = fixture(overrides)
    expect(() => verifyPackagedElectronIdentity(app, "0.12.0")).toThrow(message)
  })

  test("rejects malformed manifests", () => {
    const { app, packageRoot } = fixture()
    writeFileSync(join(packageRoot, "package.json"), "not-json\n")
    expect(() => verifyPackagedElectronIdentity(app, "0.12.0")).toThrow("valid JSON")
  })

  test("rejects a symlinked manifest", () => {
    const { app, packageRoot } = fixture()
    const manifest = join(packageRoot, "package.json")
    const replacement = join(packageRoot, "replacement.json")
    writeFileSync(replacement, '{"name":"@craft-agent/electron","version":"0.12.0","main":"dist/main.cjs"}\n')
    rmSync(manifest)
    symlinkSync(replacement, manifest)
    expect(() => verifyPackagedElectronIdentity(app, "0.12.0")).toThrow("real regular file")
  })

  test("rejects a missing or symlinked packaged main", () => {
    const missing = fixture()
    rmSync(join(missing.packageRoot, "dist", "main.cjs"))
    expect(() => verifyPackagedElectronIdentity(missing.app, "0.12.0")).toThrow()

    const linked = fixture()
    const main = join(linked.packageRoot, "dist", "main.cjs")
    const replacement = join(linked.packageRoot, "dist", "replacement.cjs")
    writeFileSync(replacement, "module.exports = {}\n")
    rmSync(main)
    symlinkSync(replacement, main)
    expect(() => verifyPackagedElectronIdentity(linked.app, "0.12.0")).toThrow("real regular file")
  })

  test("rejects an empty packaged main", () => {
    const { app, packageRoot } = fixture()
    writeFileSync(join(packageRoot, "dist", "main.cjs"), "")
    expect(() => verifyPackagedElectronIdentity(app, "0.12.0")).toThrow("must not be empty")
  })

  test("rejects a symlinked app root", () => {
    const { app } = fixture()
    const alias = `${app}-alias`
    symlinkSync(app, alias)
    expect(() => verifyPackagedElectronIdentity(alias, "0.12.0")).toThrow("real directory")
  })
})
