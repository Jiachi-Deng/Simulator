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
    expect(
      directScriptTargets(
        'node scripts/node.js && ./scripts/direct.sh && bash "scripts/quoted.sh" && vite --config scripts/vite.config.ts',
      ),
    ).toEqual([
      "./scripts/direct.sh",
      "scripts/node.js",
      "scripts/quoted.sh",
      "scripts/vite.config.ts",
    ])
  })

  test("skips runner options before script targets", () => {
    expect(
      directScriptTargets(
        "bash -e scripts/missing.sh && node --enable-source-maps scripts/missing.js",
      ),
    ).toEqual(["scripts/missing.js", "scripts/missing.sh"])
  })

  test("recursively extracts sh -c commands without treating the command as a file", () => {
    expect(
      directScriptTargets(
        "bash -c 'node --enable-source-maps scripts/nested.js' && sh -c 'bash -e scripts/nested.sh'",
      ),
    ).toEqual(["scripts/nested.js", "scripts/nested.sh"])
  })

  test("does not accept a directory in place of a script file", () => {
    manifest(join(fixtureRoot, "package.json"), {
      name: "root",
      version: "1.0.0",
      scripts: { broken: "bash scripts/not-a-file.sh" },
    })
    mkdirSync(join(fixtureRoot, "scripts", "not-a-file.sh"), { recursive: true })
    mkdirSync(join(fixtureRoot, "apps"), { recursive: true })
    mkdirSync(join(fixtureRoot, "packages"), { recursive: true })

    expect(findMissingScriptTargets(fixtureRoot)).toHaveLength(1)
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

  test("reports missing targets behind runner options and shell -c", () => {
    manifest(join(fixtureRoot, "package.json"), {
      name: "root",
      version: "1.0.0",
      scripts: {
        shell: "bash -e scripts/missing.sh",
        node: "node --enable-source-maps scripts/missing.js",
        nested: "bash -c 'node scripts/nested-missing.js'",
      },
    })
    mkdirSync(join(fixtureRoot, "apps"), { recursive: true })
    mkdirSync(join(fixtureRoot, "packages"), { recursive: true })

    expect(findMissingScriptTargets(fixtureRoot).map(({ scriptName, target }) => ({
      scriptName,
      target,
    }))).toEqual([
      { scriptName: "nested", target: "scripts/nested-missing.js" },
      { scriptName: "node", target: "scripts/missing.js" },
      { scriptName: "shell", target: "scripts/missing.sh" },
    ])
  })
})
