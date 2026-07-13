import { createHash, randomUUID } from "node:crypto"
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { OPENSCIENCE_PIN } from "./pins.js"
import type { ArtifactInventory, ArtifactRole, InventoryFile, ValidationOptions } from "./types.js"
import { validateArtifact, validateModelsSnapshot } from "./validator.js"

const MODULE_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)))
const DEFAULT_MODELS_SNAPSHOT = path.join(MODULE_ROOT, "policy", "models-dev-api.json")
const MODELS_SNAPSHOT_DECISION = path.join(MODULE_ROOT, "policy", "models-dev-snapshot-decision.json")
const RUNTIME_POLICY = path.join(MODULE_ROOT, "policy", "runtime-policy.json")
const ROLE_PATHS: Record<ArtifactRole, string> = {
  binary: "bin/openscience-darwin-arm64", license: "LICENSE", notice: "NOTICE",
  "third-party-notices": "THIRD_PARTY_NOTICES", sbom: "sbom.cdx.json", checksums: "checksums.txt",
  "runtime-policy": "runtime-policy.json", provenance: "provenance.json",
  "third-party-decisions": "third-party-decisions.json", "models-snapshot": "models-dev-api.json",
  "build-attestation": "build-attestation.json", "runtime-conformance": "runtime-conformance.json",
}

export interface StageRequest {
  /** A nonexistent directory outside this module. It becomes one sealed release root atomically. */
  releaseRoot: string
  /** Defaults to the reviewed, committed models.dev snapshot. */
  modelsSnapshotPath?: string
  /** Independently reviewed legal inputs: legal-review.json, sbom.cdx.json, THIRD_PARTY_NOTICES, third-party-decisions.json. */
  legalEvidenceDirectory: string
  /** Externally produced provenance evidence; plain JSON remains untrusted until validation. */
  buildAttestationPath: string
  /** Externally produced runtime evidence bound to this exact binary digest. */
  runtimeConformancePath: string
  /** Must resolve to Bun 1.3.5. Defaults to bun on PATH. */
  bunExecutable?: string
  validation: Required<ValidationOptions>
}

export interface StageResult {
  releaseRoot: string
  artifactRoot: string
  inventoryPath: string
  archivePath: string
  archiveSha256: string
  binarySha256: string
}

export interface StageFailureRecord {
  schemaVersion: 1
  status: "failed"
  source: typeof OPENSCIENCE_PIN.repository
  commit: typeof OPENSCIENCE_PIN.commit
  error: string
}

interface CommandResult { stdout: string; stderr: string }

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function hashFile(filePath: string): Promise<string> {
  return hash(await readFile(filePath))
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${label} has Symbol keys`)
  const actual = Object.keys(value).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) throw new Error(`${label} fields mismatch`)
}

async function run(executable: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""; let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) { resolve({ stdout, stderr }); return }
      reject(new Error(`${path.basename(executable)} exited ${code}: ${stderr.trim().slice(0, 1000)}`))
    })
  })
}

async function regularInput(filePath: string, label: string): Promise<void> {
  const details = await lstat(filePath)
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
}

async function copyRegular(source: string, destination: string, label: string): Promise<void> {
  await regularInput(source, label)
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  await cp(source, destination, { dereference: false, force: false, errorOnExist: true })
}

export async function assertPinnedModelsSnapshot(snapshotPath = DEFAULT_MODELS_SNAPSHOT): Promise<void> {
  const decision = requirePlainRecord(JSON.parse(await readFile(MODELS_SNAPSHOT_DECISION, "utf8")), "models.dev snapshot decision")
  exactKeys(decision, ["schemaVersion", "source", "sha256", "disposition", "rationale", "refresh"], "models.dev snapshot decision")
  if (decision.schemaVersion !== 1 || decision.source !== "https://models.dev/api.json" || decision.sha256 !== OPENSCIENCE_PIN.modelsDevApiSha256 ||
      decision.disposition !== "included-offline-only" || typeof decision.rationale !== "string" || typeof decision.refresh !== "string") {
    throw new Error("models.dev snapshot decision is not an approved immutable offline pin")
  }
  await regularInput(snapshotPath, "models.dev snapshot")
  const bytes = await readFile(snapshotPath)
  if (hash(bytes) !== OPENSCIENCE_PIN.modelsDevApiSha256) throw new Error("models.dev snapshot digest does not match reviewed decision")
  validateModelsSnapshot(JSON.parse(bytes.toString("utf8")))
}

export function assertExactBunVersion(stdout: string): void {
  if (stdout.trim() !== OPENSCIENCE_PIN.bun) throw new Error(`Bun ${OPENSCIENCE_PIN.bun} required`)
}

export async function assertDarwinArm64BunBinary(binaryPath: string): Promise<void> {
  const details = await stat(binaryPath)
  if (!details.isFile() || (details.mode & 0o111) === 0) throw new Error("compiled OpenScience output is not executable")
  const handle = await open(binaryPath, "r")
  try {
    const header = Buffer.alloc(8)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead !== header.length || header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== 0x0100000c) {
      throw new Error("compiled OpenScience output is not a thin darwin-arm64 Mach-O binary")
    }
  } finally {
    await handle.close()
  }
}

async function checkoutExactSource(checkout: string): Promise<void> {
  await mkdir(checkout, { recursive: true, mode: 0o700 })
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }
  await run("git", ["init", "--quiet"], checkout, gitEnv)
  await run("git", ["config", "core.autocrlf", "false"], checkout, gitEnv)
  await run("git", ["config", "core.fileMode", "true"], checkout, gitEnv)
  await run("git", ["remote", "add", "origin", OPENSCIENCE_PIN.repository], checkout, gitEnv)
  await run("git", ["fetch", "--quiet", "--depth=1", "origin", OPENSCIENCE_PIN.commit], checkout, gitEnv)
  const fetched = (await run("git", ["rev-parse", "FETCH_HEAD"], checkout, gitEnv)).stdout.trim()
  if (fetched !== OPENSCIENCE_PIN.commit) throw new Error("upstream fetch did not resolve the exact source commit")
  await run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], checkout, gitEnv)
  const head = (await run("git", ["rev-parse", "HEAD"], checkout, gitEnv)).stdout.trim()
  if (head !== OPENSCIENCE_PIN.commit) throw new Error("private checkout commit mismatch")
  if ((await run("git", ["status", "--porcelain"], checkout, gitEnv)).stdout !== "") throw new Error("private checkout is not clean")
  if (await hashFile(path.join(checkout, "bun.lock")) !== OPENSCIENCE_PIN.bunLockSha256) throw new Error("private checkout bun.lock digest mismatch")
}

async function assertOnlyGeneratedSourceChanged(checkout: string): Promise<void> {
  const changed = (await run("git", ["diff", "--name-only"], checkout)).stdout.trim().split("\n").filter(Boolean)
  const allowed = new Set(["backend/cli/src/provider/models-snapshot.ts"])
  if (changed.some((file) => !allowed.has(file))) throw new Error("source build changed pinned source outside the generated models snapshot")
  if (await hashFile(path.join(checkout, "bun.lock")) !== OPENSCIENCE_PIN.bunLockSha256) throw new Error("source build changed pinned bun.lock")
}

async function runNetworkDisabledBuild(checkout: string, bunExecutable: string, snapshotPath: string): Promise<string> {
  assertExactBunVersion((await run(bunExecutable, ["--version"], checkout)).stdout)
  const env = {
    ...process.env,
    MODELS_DEV_API_JSON: snapshotPath,
    NO_PROXY: "*",
    no_proxy: "*",
    BUN_INSTALL_DISABLE_GIT: "1",
  }
  const profile = "(version 1) (deny network*) (allow default)"
  const sandbox = async (args: string[]) => await run("sandbox-exec", ["-p", profile, bunExecutable, ...args], checkout, env)
  await sandbox(["install", "--frozen-lockfile", "--offline"])
  await sandbox(["run", "--cwd", "backend/cli", "build", "--", "--single", "--skip-install"])
  await assertOnlyGeneratedSourceChanged(checkout)
  const packageJson = requirePlainRecord(JSON.parse(await readFile(path.join(checkout, "backend/cli/package.json"), "utf8")), "backend/cli package.json")
  if (typeof packageJson.name !== "string" || packageJson.name.length === 0) throw new Error("backend/cli package name missing")
  return path.join(checkout, "backend/cli", "dist", `${packageJson.name}-darwin-arm64`, "bin", "openscience")
}

async function copyLegalEvidence(source: string, artifact: string): Promise<void> {
  const reviewPath = path.join(source, "legal-review.json")
  await regularInput(reviewPath, "legal review")
  const review = requirePlainRecord(JSON.parse(await readFile(reviewPath, "utf8")), "legal review")
  exactKeys(review, ["schemaVersion", "source", "reviewedAt"], "legal review")
  const pinnedSource = requirePlainRecord(review.source, "legal review source")
  exactKeys(pinnedSource, ["repository", "ref", "commit", "bunLockSha256"], "legal review source")
  if (review.schemaVersion !== 1 || typeof review.reviewedAt !== "string" || pinnedSource.repository !== OPENSCIENCE_PIN.repository ||
      pinnedSource.ref !== OPENSCIENCE_PIN.ref || pinnedSource.commit !== OPENSCIENCE_PIN.commit ||
      pinnedSource.bunLockSha256 !== OPENSCIENCE_PIN.bunLockSha256) throw new Error("legal review does not bind the exact source and lock")
  await copyRegular(path.join(source, "THIRD_PARTY_NOTICES"), path.join(artifact, ROLE_PATHS["third-party-notices"]), "THIRD_PARTY_NOTICES")
  await copyRegular(path.join(source, "sbom.cdx.json"), path.join(artifact, ROLE_PATHS.sbom), "CycloneDX SBOM")
  await copyRegular(path.join(source, "third-party-decisions.json"), path.join(artifact, ROLE_PATHS["third-party-decisions"]), "third-party decisions")
}

async function writeChecksums(artifact: string): Promise<void> {
  const files: string[] = []
  async function walk(directory: string, relative = ""): Promise<void> {
    for (const name of await readdir(directory)) {
      const next = relative ? `${relative}/${name}` : name
      const absolute = path.join(directory, name)
      const details = await lstat(absolute)
      if (details.isDirectory()) await walk(absolute, next)
      else if (details.isFile() && next !== ROLE_PATHS.checksums) files.push(next)
      else throw new Error(`unexpected staged artifact entry: ${next}`)
    }
  }
  await walk(artifact)
  files.sort((left, right) => left.localeCompare(right, "en"))
  const entries = await Promise.all(files.map(async (file) => `${await hashFile(path.join(artifact, file))}  ${file}`))
  await writeFile(path.join(artifact, ROLE_PATHS.checksums), `${entries.join("\n")}\n`, { mode: 0o600, flag: "wx" })
}

async function createInventory(artifact: string): Promise<ArtifactInventory> {
  const files = await Promise.all((Object.entries(ROLE_PATHS) as Array<[ArtifactRole, string]>).map(async ([role, relative]): Promise<InventoryFile> => {
    const absolute = path.join(artifact, relative)
    const details = await stat(absolute)
    return { role, path: relative, size: details.size, sha256: await hashFile(absolute) }
  }))
  return {
    schemaVersion: 1,
    source: { repository: OPENSCIENCE_PIN.repository, ref: OPENSCIENCE_PIN.ref, commit: OPENSCIENCE_PIN.commit },
    artifact: { name: "openscience", version: "1.3.4", platform: "darwin", arch: "arm64", format: "bun-compiled-binary", capabilities: ["embedded-web", "rdkit"] },
    files,
  }
}

async function sealTree(root: string): Promise<void> {
  async function seal(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const absolute = path.join(directory, name)
      const details = await lstat(absolute)
      if (details.isDirectory()) { await seal(absolute); await chmod(absolute, 0o500) }
      else if (details.isFile()) await chmod(absolute, absolute.endsWith("bin/openscience-darwin-arm64") ? 0o500 : 0o400)
      else throw new Error(`cannot seal non-regular release entry: ${absolute}`)
    }
  }
  await seal(root)
  await chmod(root, 0o500)
}

async function writeFailure(releaseRoot: string, error: unknown): Promise<void> {
  const destination = `${releaseRoot}.failure.json`
  try {
    await lstat(destination)
    return
  } catch { /* destination does not exist */ }
  const record: StageFailureRecord = {
    schemaVersion: 1, status: "failed", source: OPENSCIENCE_PIN.repository, commit: OPENSCIENCE_PIN.commit,
    error: error instanceof Error ? error.message : "OpenScience staging failed closed",
  }
  const temporary = `${destination}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" })
  await rename(temporary, destination)
}

export async function stageOpenScience(request: StageRequest): Promise<StageResult> {
  const releaseRoot = path.resolve(request.releaseRoot)
  const parent = path.dirname(releaseRoot)
  let temporary = ""
  try {
    if (inside(MODULE_ROOT, releaseRoot)) throw new Error("release output must remain outside modules/open-science; binaries are never committed")
    await mkdir(parent, { recursive: true, mode: 0o700 })
    try {
      await lstat(releaseRoot)
      throw new Error("release root already exists")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") throw error
    }
    assertExactBunVersion((await run(request.bunExecutable ?? "bun", ["--version"], parent)).stdout)
    const snapshotPath = path.resolve(request.modelsSnapshotPath ?? DEFAULT_MODELS_SNAPSHOT)
    await assertPinnedModelsSnapshot(snapshotPath)
    temporary = await mkdtemp(path.join(parent, ".openscience-stage-"))
    await chmod(temporary, 0o700)
    const checkout = path.join(temporary, "private-checkout")
    const artifact = path.join(temporary, "artifact")
    await checkoutExactSource(checkout)
    const binary = await runNetworkDisabledBuild(checkout, request.bunExecutable ?? "bun", snapshotPath)
    await assertDarwinArm64BunBinary(binary)
    await mkdir(path.join(artifact, "bin"), { recursive: true, mode: 0o700 })
    await copyRegular(binary, path.join(artifact, ROLE_PATHS.binary), "compiled OpenScience binary")
    await copyRegular(path.join(checkout, "LICENSE"), path.join(artifact, ROLE_PATHS.license), "upstream LICENSE")
    await copyRegular(path.join(checkout, "NOTICE"), path.join(artifact, ROLE_PATHS.notice), "upstream NOTICE")
    if (await hashFile(path.join(artifact, "LICENSE")) !== OPENSCIENCE_PIN.licenseSha256 ||
        await hashFile(path.join(artifact, "NOTICE")) !== OPENSCIENCE_PIN.noticeSha256) throw new Error("upstream legal files do not match pinned content")
    await copyLegalEvidence(path.resolve(request.legalEvidenceDirectory), artifact)
    await copyRegular(snapshotPath, path.join(artifact, ROLE_PATHS["models-snapshot"]), "models.dev snapshot")
    await copyRegular(RUNTIME_POLICY, path.join(artifact, ROLE_PATHS["runtime-policy"]), "runtime policy")
    await copyRegular(path.resolve(request.buildAttestationPath), path.join(artifact, ROLE_PATHS["build-attestation"]), "build attestation")
    await copyRegular(path.resolve(request.runtimeConformancePath), path.join(artifact, ROLE_PATHS["runtime-conformance"]), "runtime conformance")
    await writeFile(path.join(artifact, ROLE_PATHS.provenance), `${JSON.stringify({
      schemaVersion: 1,
      source: { repository: OPENSCIENCE_PIN.repository, ref: OPENSCIENCE_PIN.ref, commit: OPENSCIENCE_PIN.commit },
      legal: { license: "Apache-2.0", licenseSha256: OPENSCIENCE_PIN.licenseSha256, noticeSha256: OPENSCIENCE_PIN.noticeSha256 },
      toolchain: { bunVersion: OPENSCIENCE_PIN.bun, target: OPENSCIENCE_PIN.target, sourceLockSha256: OPENSCIENCE_PIN.bunLockSha256, modelsDevApiSha256: OPENSCIENCE_PIN.modelsDevApiSha256, networkDisabled: true },
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    await writeChecksums(artifact)
    const inventory = await createInventory(artifact)
    const inventoryPath = path.join(temporary, "inventory.json")
    await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600, flag: "wx" })
    await validateArtifact(artifact, inventory, request.validation)
    await rm(checkout, { recursive: true, force: true })
    const archivePath = path.join(temporary, "openscience-v1.3.4-darwin-arm64.tar.gz")
    await run("tar", ["-czf", archivePath, "-C", artifact, "."], temporary)
    const archiveSha256 = await hashFile(archivePath)
    await writeFile(path.join(temporary, "openscience-v1.3.4-darwin-arm64.tar.gz.sha256"), `${archiveSha256}  ${path.basename(archivePath)}\n`, { mode: 0o600, flag: "wx" })
    await sealTree(temporary)
    await rename(temporary, releaseRoot)
    temporary = ""
    return {
      releaseRoot, artifactRoot: path.join(releaseRoot, "artifact"), inventoryPath: path.join(releaseRoot, "inventory.json"),
      archivePath: path.join(releaseRoot, path.basename(archivePath)), archiveSha256,
      binarySha256: inventory.files.find((file) => file.role === "binary")!.sha256,
    }
  } catch (error) {
    if (temporary) await rm(temporary, { recursive: true, force: true })
    if (!inside(MODULE_ROOT, releaseRoot)) await writeFailure(releaseRoot, error)
    throw error
  }
}
