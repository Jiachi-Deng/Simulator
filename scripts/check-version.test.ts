import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { findVersionMismatches, workspaceManifestPaths } from "./check-version"

const fixtureRoot = join(import.meta.dir, ".tmp-check-version")

function writeManifest(path: string, manifest: object): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe("workspace version validation", () => {
  test("returns manifests in deterministic order and ignores online docs", () => {
    writeManifest(join(fixtureRoot, "package.json"), { name: "root", version: "1.2.3" })
    writeManifest(join(fixtureRoot, "apps", "desktop", "package.json"), {
      name: "desktop",
      version: "1.2.3",
    })
    writeManifest(join(fixtureRoot, "apps", "online-docs", "package.json"), {
      name: "docs",
      version: "9.9.9",
    })
    writeManifest(join(fixtureRoot, "packages", "shared", "package.json"), {
      name: "shared",
      version: "1.2.3",
    })

    expect(workspaceManifestPaths(fixtureRoot)).toEqual([
      join(fixtureRoot, "apps", "desktop", "package.json"),
      join(fixtureRoot, "package.json"),
      join(fixtureRoot, "packages", "shared", "package.json"),
    ])
    expect(findVersionMismatches(fixtureRoot)).toEqual([])
  })

  test("reports every mismatch without changing manifests", () => {
    writeManifest(join(fixtureRoot, "package.json"), { name: "root", version: "1.2.3" })
    writeManifest(join(fixtureRoot, "apps", "desktop", "package.json"), {
      name: "desktop",
      version: "1.2.2",
    })
    writeManifest(join(fixtureRoot, "packages", "shared", "package.json"), {
      name: "shared",
    })

    expect(findVersionMismatches(fixtureRoot)).toEqual([
      {
        path: join(fixtureRoot, "apps", "desktop", "package.json"),
        name: "desktop",
        expected: "1.2.3",
        actual: "1.2.2",
      },
      {
        path: join(fixtureRoot, "packages", "shared", "package.json"),
        name: "shared",
        expected: "1.2.3",
        actual: "<missing>",
      },
    ])
  })
})
