import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { validateSignEngineeringRcOptions } from "./sign-engineering-rc-macos-app"

const root = join(import.meta.dir, ".tmp-sign-engineering-app")
const app = join(root, "Simulator.app")
const keychain = join(root, "signing.keychain-db")
const entitlements = join(root, "entitlements.plist")

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("exact Engineering RC app Developer ID signing", () => {
  test("accepts only a real app, keychain, entitlements, and matching parameterized identity", () => {
    mkdirSync(app, { recursive: true })
    writeFileSync(keychain, "keychain")
    chmodSync(keychain, 0o600)
    writeFileSync(entitlements, "plist")
    expect(validateSignEngineeringRcOptions({
      app,
      identity: "Developer ID Application: Example Corporation (ABCDE12345)",
      teamId: "ABCDE12345",
      keychain,
      entitlements,
    }).teamId).toBe("ABCDE12345")
    expect(() => validateSignEngineeringRcOptions({
      app,
      identity: "Developer ID Application: Example Corporation (ZZZZZ99999)",
      teamId: "ABCDE12345",
      keychain,
      entitlements,
    })).toThrow("exact parameterized")
  })

  test("rejects caller-supplied symlink roots and a non-owner-only keychain", () => {
    mkdirSync(app, { recursive: true })
    writeFileSync(keychain, "keychain")
    writeFileSync(entitlements, "plist")
    chmodSync(keychain, 0o600)
    const appAlias = join(root, "Simulator-alias.app")
    symlinkSync(app, appAlias)
    const options = {
      app: appAlias,
      identity: "Developer ID Application: Example Corporation (ABCDE12345)",
      teamId: "ABCDE12345",
      keychain,
      entitlements,
    }
    expect(() => validateSignEngineeringRcOptions(options)).toThrow("real directory")
    rmSync(appAlias)
    chmodSync(keychain, 0o644)
    expect(() => validateSignEngineeringRcOptions({ ...options, app })).toThrow("owner-only")
  })

  test("disables osx-sign metadata automation and explicitly applies hardened runtime and reviewed entitlements", () => {
    const source = readFileSync(join(import.meta.dir, "sign-engineering-rc-macos-app.ts"), "utf8")
    expect(source).toContain("preAutoEntitlements: false")
    expect(source).toContain("preEmbedProvisioningProfile: false")
    expect(source).toContain("strictVerify: true")
    expect(source).toContain("optionsForFile: () =>")
    expect(source).toContain("hardenedRuntime: true")
    expect(source).toContain("entitlements: realpathSync")
  })

  test("pins osx-sign as a direct root devDependency instead of relying on transitive hoisting", () => {
    const packageJson = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"))
    const lock = readFileSync(join(import.meta.dir, "..", "..", "bun.lock"), "utf8")
    expect(packageJson.devDependencies["@electron/osx-sign"]).toBe("2.3.0")
    expect(lock).toContain('"@electron/osx-sign": "2.3.0"')
    expect(lock).toContain('"@electron/osx-sign": ["@electron/osx-sign@2.3.0"')
  })
})
