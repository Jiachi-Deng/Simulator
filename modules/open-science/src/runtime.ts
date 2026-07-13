import { createHash } from "node:crypto"
import { once } from "node:events"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import type { ArtifactInventory, RuntimeBindings, ValidationOptions } from "./types.js"
import { validateArtifact } from "./validator.js"

const CREDENTIAL_NAME = /credential|secret|token|password|cookie|auth/i
const CREDENTIAL_CONTENT = /(api[_-]?key|authorization|bearer\s+[a-z0-9._-]+|client[_-]?secret|refresh[_-]?token)\s*[:=]/i

export interface RuntimeStartRequest {
  artifactRoot: string
  inventoryPath: string
  validation: Required<ValidationOptions>
  /** The binary receives the host-selected loopback port through this callback. */
  argumentsForPort: (port: number) => string[]
  readyPath?: string
  startupTimeoutMs?: number
  stateRootParent?: string
  /** Non-secret environment overrides only. Credential-shaped names are rejected. */
  environment?: Record<string, string>
}

export interface RuntimeProbeRecord {
  schemaVersion: 1
  binarySha256: string
  address: string
  hostRejectionStatus: number
  originRejectionStatus: number
  bindings: RuntimeBindings
}

export interface StagedRuntime {
  readonly address: string
  readonly binarySha256: string
  stop(): Promise<RuntimeProbeRecord>
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function statusMustReject(status: number, label: string): void {
  if (status !== 400 && status !== 403) throw new Error(`${label} was not rejected by staged binary`)
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer()
  server.listen({ host: "127.0.0.1", port: 0 })
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string" || address.address !== "127.0.0.1" || address.port <= 0) throw new Error("host could not allocate loopback port")
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function requestStatus(port: number, requestPath: string, headers: http.OutgoingHttpHeaders): Promise<number> {
  return await new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: requestPath, method: "GET", headers, timeout: 1_000 }, (response) => {
      response.resume()
      response.on("end", () => resolve(response.statusCode ?? 0))
    })
    request.on("error", reject)
    request.on("timeout", () => request.destroy(new Error("runtime probe timed out")))
    request.end()
  })
}

async function waitForReady(child: ChildProcess, port: number, requestPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let exitCode: number | null = null
  child.once("exit", (code) => { exitCode = code })
  while (Date.now() < deadline) {
    if (exitCode !== null) throw new Error(`staged binary exited before readiness (${exitCode})`)
    try {
      const status = await requestStatus(port, requestPath, { Host: `127.0.0.1:${port}` })
      if (status >= 200 && status < 400) return
    } catch { /* the process has not bound the assigned loopback port yet */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("staged binary did not become ready on the host-assigned loopback port")
}

function isolatedEnvironment(root: string, extras: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {}
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[name] !== undefined) safe[name] = process.env[name]
  }
  for (const [name, value] of Object.entries(extras ?? {})) {
    if (CREDENTIAL_NAME.test(name)) throw new Error(`runtime environment may not contain credential-shaped name: ${name}`)
    safe[name] = value
  }
  safe.SIMULATOR_OPENSCIENCE_ROOT = root
  safe.XDG_DATA_HOME = path.join(root, "data")
  safe.XDG_CONFIG_HOME = path.join(root, "config")
  safe.XDG_CACHE_HOME = path.join(root, "cache")
  safe.XDG_STATE_HOME = path.join(root, "state")
  return safe
}

async function makeIsolatedRoot(parent: string | undefined): Promise<string> {
  const base = parent ?? path.join(process.cwd(), ".openscience-runtime")
  await mkdir(base, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(path.join(base, "runtime-"))
  for (const leaf of ["data", "config", "cache", "state"]) await mkdir(path.join(root, leaf), { recursive: true, mode: 0o700 })
  return root
}

async function assertNoCredentialPersistence(root: string): Promise<void> {
  async function walk(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const candidate = path.join(directory, name)
      const details = await lstat(candidate)
      if (details.isSymbolicLink()) throw new Error("runtime isolation root contains a symlink")
      if (CREDENTIAL_NAME.test(name)) throw new Error(`runtime persisted credential-shaped path: ${name}`)
      if (details.isDirectory()) { await walk(candidate); continue }
      if (!details.isFile()) throw new Error("runtime isolation root contains a non-regular entry")
      if (details.size > 1024 * 1024) continue
      if (CREDENTIAL_CONTENT.test((await readFile(candidate)).toString("utf8"))) throw new Error(`runtime persisted credential-like content: ${name}`)
    }
  }
  await walk(root)
}

async function stopProcessGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  const pid = child.pid
  if (!pid) throw new Error("staged binary did not provide a process id")
  const terminated = once(child, "exit").then(() => undefined)
  try { process.kill(-pid, "SIGTERM") } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2_000))
  await Promise.race([terminated, timeout])
  if (child.exitCode !== null) return
  try { process.kill(-pid, "SIGKILL") } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
  await once(child, "exit")
}

export async function startStagedBinary(request: RuntimeStartRequest): Promise<StagedRuntime> {
  const artifactRoot = path.resolve(request.artifactRoot)
  const inventory = JSON.parse(await readFile(path.resolve(request.inventoryPath), "utf8")) as ArtifactInventory
  await validateArtifact(artifactRoot, inventory, request.validation)
  const binary = path.join(artifactRoot, "bin", "openscience-darwin-arm64")
  const binarySha256 = digest(await readFile(binary))
  const port = await reserveLoopbackPort()
  const root = await makeIsolatedRoot(request.stateRootParent)
  const args = request.argumentsForPort(port)
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) throw new Error("runtime arguments must be a string array")
  const child = spawn(binary, args, { cwd: root, detached: true, env: isolatedEnvironment(root, request.environment), stdio: "ignore" })
  const requestPath = request.readyPath ?? "/"
  let stopped = false
  try {
    await waitForReady(child, port, requestPath, request.startupTimeoutMs ?? 10_000)
    const hostRejectionStatus = await requestStatus(port, requestPath, { Host: "attacker.invalid" })
    const originRejectionStatus = await requestStatus(port, requestPath, {
      Host: `127.0.0.1:${port}`, Origin: "https://attacker.invalid",
    })
    statusMustReject(hostRejectionStatus, "Host")
    statusMustReject(originRejectionStatus, "Origin")
    const bindings: RuntimeBindings = {
      binarySha256, dynamicLoopbackBind: true, hostValidation: true, originValidation: true,
      productionCredentialPersistenceDenied: true,
    }
    const address = `http://127.0.0.1:${port}`
    return {
      address,
      binarySha256,
      async stop(): Promise<RuntimeProbeRecord> {
        if (stopped) throw new Error("staged runtime was already stopped")
        stopped = true
        try {
          await stopProcessGroup(child)
          await assertNoCredentialPersistence(root)
          return { schemaVersion: 1, binarySha256, address, hostRejectionStatus, originRejectionStatus, bindings }
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    try { await stopProcessGroup(child) } finally { await rm(root, { recursive: true, force: true }) }
    throw error
  }
}
