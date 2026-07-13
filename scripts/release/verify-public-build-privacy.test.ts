import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { verifyPublicBuildPrivacy } from "./verify-public-build-privacy"

const root = join(import.meta.dir, ".tmp-public-build-privacy")
const sentinel = "SIMULATOR_PUBLIC_BUILD_MUST_STRIP_CRASH_INGEST_2026"

function fixture(updatesDisabled = true): string {
  const app = join(root, "Simulator.app")
  mkdirSync(join(app, "Contents", "Resources", "app", "dist", "resources"), { recursive: true })
  writeFileSync(
    join(app, "Contents", "Resources", "app", "dist", "resources", "build-policy.json"),
    `${JSON.stringify({ schemaVersion: 1, updatesDisabled })}\n`,
  )
  writeFileSync(join(app, "Contents", "Resources", "app", "dist", "main.cjs"), "clean bundle")
  return app
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("public build privacy verification", () => {
  test("accepts an updates-disabled app without the build sentinel", () => {
    const result = verifyPublicBuildPrivacy(fixture(), [sentinel])
    expect(result.updatesDisabled).toBe(true)
    expect(result.forbiddenMatches).toEqual([])
    expect(result.scannedFiles).toBe(2)
  })

  test("rejects a sentinel embedded in a packaged resource", () => {
    const app = fixture()
    writeFileSync(join(app, "Contents", "Resources", "app", "dist", "main.cjs"), `dsn=${sentinel}`)
    expect(() => verifyPublicBuildPrivacy(app, [sentinel])).toThrow(
      "Public build contains forbidden embedded values",
    )
  })

  test("rejects an app whose updater policy is not disabled", () => {
    expect(() => verifyPublicBuildPrivacy(fixture(false), [sentinel])).toThrow(
      "Public build must carry an updates-disabled build policy",
    )
  })

  test("scans the build policy bytes before parsing its schema", () => {
    const app = fixture()
    writeFileSync(
      join(app, "Contents", "Resources", "app", "dist", "resources", "build-policy.json"),
      JSON.stringify({ schemaVersion: 1, updatesDisabled: true, ingest: sentinel }),
    )
    expect(() => verifyPublicBuildPrivacy(app, [sentinel])).toThrow(
      "Public build contains forbidden embedded values",
    )
  })

  test("fails closed on symlinks in packaged dist", () => {
    const app = fixture()
    const outside = join(root, "outside")
    writeFileSync(outside, sentinel)
    symlinkSync(outside, join(app, "Contents", "Resources", "app", "dist", "outside-link"))
    expect(() => verifyPublicBuildPrivacy(app, [sentinel])).toThrow(
      "Packaged dist must not contain symlinks",
    )
  })
})
