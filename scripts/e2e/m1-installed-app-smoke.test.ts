import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { descendantPids, parseProcessTable, terminateProcessTree, validateAppBundle, validateInput } from "./m1-installed-app-smoke"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("M1 installed app smoke safety", () => {
  test("validates arm64 and only accepts app or zip inputs", () => {
    const root = mkdtempSync("/tmp/m1-smoke-test-"); roots.push(root)
    mkdirSync(join(root, "Simulator.app"))
    writeFileSync(join(root, "bad.txt"), "x")
    expect(validateInput(join(root, "Simulator.app"), "darwin", "arm64")).toBe("app")
    expect(() => validateInput(join(root, "bad.txt"), "darwin", "arm64")).toThrow()
    expect(() => validateInput(join(root, "Simulator.app"), "darwin", "x64")).toThrow("macOS arm64")
    expect(() => validateInput(join(root, "Simulator.app"), "linux", "arm64")).toThrow("macOS arm64")
  })

  test("rejects an invalid app bundle before launch", () => {
    const root = mkdtempSync("/tmp/m1-smoke-bundle-test-"); roots.push(root)
    const app = join(root, "Broken.app")
    mkdirSync(app)
    expect(() => validateAppBundle(app)).toThrow("Info.plist")
  })

  test("parses process trees without matching process names", () => {
    const records = parseProcessTable(" 10 1 /app\n11 10 helper\n12 11 worker\n13 999 unrelated\n")
    expect(records).toHaveLength(4)
    expect(descendantPids(10, records)).toEqual([11, 12])
  })

  test("kills only the root PID and descendants, then reports timeout cleanup", async () => {
    let alive = new Set([10, 11, 12, 99])
    const sent: Array<[number, NodeJS.Signals]> = []
    const table = () => [...alive].map((pid) => ({ pid, ppid: pid === 10 ? 1 : pid === 11 ? 10 : pid === 12 ? 11 : 1, command: "opaque" }))
    const result = await terminateProcessTree(10, {
      timeoutMs: 20,
      pollMs: 1,
      psOutput: () => table(),
      isAlive: (pid) => alive.has(pid),
      kill: (pid, signal) => { sent.push([pid, signal]); if (signal === "SIGTERM") alive.delete(pid) },
    })
    expect(result).toBe(true)
    expect(new Set(sent.map(([pid]) => pid))).toEqual(new Set([10, 11, 12]))
    expect(alive.has(99)).toBe(true)
  })

  test("timeout escalates to PID-scoped SIGKILL without crossing the tree", async () => {
    let alive = new Set([20, 21])
    const signals: Array<[number, NodeJS.Signals]> = []
    const table = () => [...alive].map((pid) => ({ pid, ppid: pid === 20 ? 1 : 20, command: "opaque" }))
    const result = await terminateProcessTree(20, { timeoutMs: 5, pollMs: 1, psOutput: table, isAlive: (pid) => alive.has(pid), kill: (pid, signal) => { signals.push([pid, signal]); if (signal === "SIGKILL") alive.delete(pid) } })
    expect(result).toBe(true)
    expect(signals.some(([, signal]) => signal === "SIGKILL")).toBe(true)
    expect(signals.every(([pid]) => pid === 20 || pid === 21)).toBe(true)
  })
})
