import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { validatePackagedServerResources } from "./packaged-server-resources"

const root = join(tmpdir(), `packaged-server-resources-${process.pid}`)

function write(path: string, content: string): void {
  const fullPath = join(root, path)
  mkdirSync(join(fullPath, ".."), { recursive: true })
  writeFileSync(fullPath, content)
}

function fixture(): string {
  const resources = join(root, "app", "resources")
  write("app/resources/session-mcp-server/index.js", "require('node:fs')\n")
  write("app/resources/pi-agent-server/index.js", "import dependency from 'fixture-dependency'\nvoid dependency\n")
  write("app/resources/pi-agent-server/node_modules/fixture-dependency/package.json", JSON.stringify({
    name: "fixture-dependency",
    type: "module",
    exports: { ".": { import: "./index.js", require: "./index.cjs" } },
  }))
  write("app/resources/pi-agent-server/node_modules/fixture-dependency/index.js", "import 'node:fs'\nexport default {}\n")
  return resources
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("packaged server resource validation", () => {
  test("accepts readable entrypoints with a complete staged dependency closure", () => {
    const result = validatePackagedServerResources(fixture())
    expect(result.packages).toEqual(["fixture-dependency"])
  })

  test("fails closed when either server entrypoint is missing", () => {
    const resources = fixture()
    rmSync(join(resources, "session-mcp-server", "index.js"))
    expect(() => validatePackagedServerResources(resources))
      .toThrow("session-mcp-server entrypoint")
  })

  test("rejects an incomplete staged dependency closure", () => {
    const resources = fixture()
    rmSync(join(resources, "pi-agent-server", "node_modules", "fixture-dependency", "index.js"))
    expect(() => validatePackagedServerResources(resources)).toThrow("has no staged entrypoint")
  })

  test("does not resolve dependencies from an ancestor development node_modules", () => {
    const resources = fixture()
    const stagedModules = join(resources, "pi-agent-server", "node_modules")
    rmSync(stagedModules, { recursive: true })
    write("node_modules/fixture-dependency/package.json", JSON.stringify({ name: "fixture-dependency", main: "index.js" }))
    write("node_modules/fixture-dependency/index.js", "export default {}\n")

    expect(() => validatePackagedServerResources(resources))
      .toThrow(`dependency fixture-dependency must be staged under ${stagedModules}`)
  })

  test("rejects JavaScript that cannot be parsed", () => {
    const resources = fixture()
    writeFileSync(join(resources, "session-mcp-server", "index.js"), "const = broken")
    expect(() => validatePackagedServerResources(resources))
      .toThrow("cannot be parsed")
  })
})
