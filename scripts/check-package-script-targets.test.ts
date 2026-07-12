import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  directScriptTargets,
  findMissingScriptTargets,
} from "./check-package-script-targets"

const fixtureRoot = join(import.meta.dir, ".tmp-check-script-targets")

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content)
}

function manifest(path: string, value: object): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`)
}

afterEach(() => rmSync(fixtureRoot, { recursive: true, force: true }))

describe("package script target inventory", () => {
  test("extracts direct Bun, shell, and PowerShell file targets", () => {
    expect(
      directScriptTargets(
        "bun run scripts/a.ts && bash scripts/b.sh; powershell -ExecutionPolicy Bypass -File scripts/c.ps1",
      ),
    ).toEqual(["scripts/a.ts", "scripts/b.sh", "scripts/c.ps1"])
  })

  test("reports missing targets with package and script context", () => {
    manifest(join(fixtureRoot, "package.json"), {
      name: "root",
      version: "1.0.0",
      scripts: { valid: "bun scripts/valid.ts", broken: "bash scripts/missing.sh" },
    })
    write(join(fixtureRoot, "scripts", "valid.ts"), "export {}\n")
    mkdirSync(join(fixtureRoot, "apps"), { recursive: true })
    mkdirSync(join(fixtureRoot, "packages"), { recursive: true })

    expect(findMissingScriptTargets(fixtureRoot)).toEqual([
      {
        manifestPath: "package.json",
        packageName: "root",
        scriptName: "broken",
        target: "scripts/missing.sh",
      },
    ])
  })
})
