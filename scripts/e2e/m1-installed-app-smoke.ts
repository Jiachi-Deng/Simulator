import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

export type ProcessRecord = { pid: number; ppid: number; command: string }

export type SmokeOptions = {
  timeoutMs: number
  pollMs: number
  root?: string
  platform?: string
  arch?: string
  psOutput?: () => ProcessRecord[]
  isAlive?: (pid: number) => boolean
  kill?: (pid: number, signal: NodeJS.Signals) => void
}

export type SmokeEvidence = {
  ok: boolean
  input: string
  app: string
  root: string
  log: string
  launches: Array<{ attempt: number; pid: number; descendants: number[]; terminated: boolean }>
  humanVerification: string[]
  error?: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_POLL_MS = 250

export function parseProcessTable(output: string): ProcessRecord[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) return []
    return [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }]
  })
}

export function descendantPids(rootPid: number, records: ProcessRecord[]): number[] {
  const children = new Map<number, number[]>()
  for (const record of records) children.set(record.ppid, [...(children.get(record.ppid) ?? []), record.pid])
  const result: number[] = []
  const queue = [...(children.get(rootPid) ?? [])]
  while (queue.length) {
    const pid = queue.shift()!
    result.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return result
}

function processTable(): ProcessRecord[] {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`ps failed: ${result.stderr.trim()}`)
  return parseProcessTable(result.stdout)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function validateAppBundle(app: string): string {
  const plist = join(app, "Contents", "Info.plist")
  if (!existsSync(plist)) throw new Error(`missing Info.plist: ${plist}`)
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`cannot read CFBundleExecutable: ${result.stderr.trim()}`)
  const name = result.stdout.trim()
  if (!name || name.includes("/") || name === "." || name === "..") throw new Error(`invalid CFBundleExecutable: ${name}`)
  const executable = join(app, "Contents", "MacOS", name)
  const stat = lstatSync(executable)
  if (!stat.isFile() || !existsSync(executable)) throw new Error(`app executable is not a regular file: ${executable}`)
  const architecture = spawnSync("file", ["-b", executable], { encoding: "utf8" })
  if (architecture.status !== 0 || !/arm64\b/.test(architecture.stdout)) throw new Error(`app executable is not arm64: ${architecture.stdout.trim()}`)
  return executable
}

export function validateInput(input: string, platform = process.platform, arch = process.arch): "app" | "zip" {
  if (platform !== "darwin" || arch !== "arm64") throw new Error(`M1 smoke requires macOS arm64 (got ${platform}/${arch})`)
  const stat = lstatSync(input)
  if (stat.isSymbolicLink()) throw new Error("input must not be a symbolic link")
  if (stat.isDirectory() && input.endsWith(".app")) return "app"
  if (stat.isFile() && input.endsWith(".zip")) return "zip"
  throw new Error("input must be an existing .app directory or .zip file")
}

function findApps(root: string): string[] {
  const found: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory() && entry.name.endsWith(".app")) found.push(path)
      else if (entry.isDirectory()) visit(path)
    }
  }
  visit(root)
  return found
}

function copyOrExtract(input: string, kind: "app" | "zip", root: string): string {
  const staging = join(root, "staging")
  mkdirSync(staging, { recursive: true })
  if (kind === "zip") {
    const result = spawnSync("ditto", ["-x", "-k", input, staging], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(`ditto extraction failed: ${result.stderr.trim()}`)
  } else {
    const result = spawnSync("ditto", [input, join(staging, basename(input))], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(`ditto copy failed: ${result.stderr.trim()}`)
  }
  const apps = findApps(staging)
  if (apps.length !== 1) throw new Error(`expected exactly one app bundle, found ${apps.length}`)
  return apps[0]
}

function launch(app: string, root: string, logPath: string): ChildProcess {
  const executable = validateAppBundle(app)
  const log = openSync(logPath, "a")
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(home, "Library", "Application Support"),
    XDG_DATA_HOME: join(home, "Library", "Application Support"),
    XDG_CACHE_HOME: join(home, "Library", "Caches"),
    CRAFT_HOME: undefined,
    CRAFT_DEBUG: "1",
  }
  mkdirSync(env.TMPDIR, { recursive: true })
  return spawn(executable, [], { env, stdio: ["ignore", log, log] })
}

async function waitForReadiness(child: ChildProcess, executable: string, timeoutMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`app exited before readiness (code ${child.exitCode})`)
    if (existsSync(executable) && isAlive(child.pid!)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs))
  }
  throw new Error(`app readiness timed out after ${timeoutMs}ms`)
}

export async function terminateProcessTree(rootPid: number, options: Pick<SmokeOptions, "timeoutMs" | "pollMs" | "psOutput" | "isAlive" | "kill">): Promise<boolean> {
  const getTable = options.psOutput ?? (() => processTable())
  const send = options.kill ?? ((pid, signal) => process.kill(pid, signal))
  const deadline = Date.now() + options.timeoutMs
  const observed = new Set<number>([rootPid])
  const alive = options.isAlive ?? isAlive
  const allGone = (): boolean => [...observed].every((pid) => !alive(pid))
  const signalTree = (signal: NodeJS.Signals): void => {
    const descendants = descendantPids(rootPid, getTable())
    for (const pid of descendants) observed.add(pid)
    for (const pid of [...new Set([...observed].reverse())]) {
      try { send(pid, signal) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
  }
  signalTree("SIGTERM")
  while (Date.now() < deadline) {
    signalTree("SIGTERM")
    if (allGone()) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, options.pollMs))
  }
  signalTree("SIGKILL")
  return allGone()
}

function numberOption(value: string | undefined, fallback: number): number {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error(`invalid positive number: ${value}`)
  return number
}

export async function runSmoke(input: string, options: Partial<SmokeOptions> = {}): Promise<SmokeEvidence> {
  const kind = validateInput(input, options.platform, options.arch)
  const root = options.root ?? mkdtempSync(join(tmpdir(), "simulator-m1-installed-smoke-"))
  const logPath = join(root, "app.log")
  mkdirSync(root, { recursive: true })
  const app = copyOrExtract(input, kind, root)
  const executable = validateAppBundle(app)
  const launches: SmokeEvidence["launches"] = []
  const evidence: SmokeEvidence = { ok: false, input, app, root, log: logPath, launches, humanVerification: ["OAuth/UI conversation not run by this script", "signed/notarized/Gatekeeper acceptance remains manual"] }
  let activePid: number | undefined
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const child = launch(app, root, logPath)
      activePid = child.pid!
      const descendants = descendantPids(child.pid!, options.psOutput ? options.psOutput() : processTable())
      const terminated = await (async () => {
        await waitForReadiness(child, executable, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.pollMs ?? DEFAULT_POLL_MS)
        return terminateProcessTree(child.pid!, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, pollMs: options.pollMs ?? DEFAULT_POLL_MS, psOutput: options.psOutput, kill: options.kill })
      })()
      launches.push({ attempt, pid: child.pid!, descendants, terminated })
      if (!terminated) throw new Error(`process tree remained after attempt ${attempt}`)
      activePid = undefined
    }
    evidence.ok = true
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error)
    if (activePid !== undefined) {
      await terminateProcessTree(activePid, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, pollMs: options.pollMs ?? DEFAULT_POLL_MS, psOutput: options.psOutput, isAlive: undefined, kill: options.kill }).catch(() => undefined)
    }
    throw error
  } finally {
    writeFileSync(join(root, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`)
  }
  return evidence
}

function usage(): void {
  console.error("Usage: bun scripts/e2e/m1-installed-app-smoke.ts APP_OR_ZIP [--timeout-ms N] [--poll-ms N]")
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const input = args.find((arg) => !arg.startsWith("--"))
  if (!input) { usage(); process.exit(2) }
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag)
    return index < 0 ? undefined : args[index + 1]
  }
  try {
    const evidence = await runSmoke(resolve(input), { timeoutMs: numberOption(value("--timeout-ms"), DEFAULT_TIMEOUT_MS), pollMs: numberOption(value("--poll-ms"), DEFAULT_POLL_MS) })
    console.log(JSON.stringify(evidence, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
    process.exit(1)
  }
}
