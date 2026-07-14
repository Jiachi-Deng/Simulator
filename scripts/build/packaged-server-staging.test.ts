import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { copyPiAgentServer, copySessionServer, type BuildConfig } from "./common"

const root = join(tmpdir(), `packaged-server-staging-${process.pid}`)
const electronDir = join(root, "apps", "electron")
const config: BuildConfig = {
  platform: "darwin",
  arch: "arm64",
  upload: false,
  uploadLatest: false,
  uploadScript: false,
  rootDir: root,
  electronDir,
}

function write(path: string, content: string): void {
  const fullPath = join(root, path)
  mkdirSync(join(fullPath, ".."), { recursive: true })
  writeFileSync(fullPath, content)
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("packaged server staging", () => {
  test("replaces stale session output with the current build", () => {
    write("packages/session-mcp-server/dist/index.js", "current-session")
    write("apps/electron/resources/session-mcp-server/stale.js", "stale")
    copySessionServer(config)

    const destination = join(electronDir, "resources", "session-mcp-server")
    expect(readFileSync(join(destination, "index.js"), "utf8")).toBe("current-session")
    expect(existsSync(join(destination, "stale.js"))).toBe(false)
  })

  test("stages the current Pi bundle and clears stale output", () => {
    write("packages/pi-agent-server/dist/index.js", "current-pi")
    write("apps/electron/resources/pi-agent-server/stale.js", "stale")
    copyPiAgentServer(config)

    const destination = join(electronDir, "resources", "pi-agent-server")
    expect(existsSync(join(destination, "stale.js"))).toBe(false)
    expect(readFileSync(join(destination, "index.js"), "utf8")).toBe("current-pi")
  })

  test("removes stale output before failing on missing build artifacts", () => {
    const destination = join(electronDir, "resources", "pi-agent-server")
    write("apps/electron/resources/pi-agent-server/index.js", "stale")
    expect(() => copyPiAgentServer(config)).toThrow("Pi agent server not found")
    expect(existsSync(destination)).toBe(false)
  })
})
