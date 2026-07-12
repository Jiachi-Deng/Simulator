import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import type { ArtifactInventory, InventoryFile, RuntimePolicy } from "./types.js"

const MAX_FILE_SIZE = 256 * 1024 * 1024
const MAX_TOTAL_SIZE = 384 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/
const ROOT_KEYS = ["schemaVersion", "source", "artifact", "files"] as const
const SOURCE_KEYS = ["repository", "tag", "commit", "sourceDate"] as const
const ARTIFACT_KEYS = ["name", "version", "platform", "arch", "format", "capabilities"] as const
const FILE_KEYS = ["path", "sha256", "size", "role"] as const
const REQUIRED_ROLES = new Set<InventoryFile["role"]>([
  "binary", "license", "notice", "third-party-notices", "sbom", "checksums", "runtime-policy",
])
const FORBIDDEN_NAMES = new Set(["auth.json", "mcp-auth.json", ".env", ".npmrc"])
const ROLE_PATHS: Record<InventoryFile["role"], string> = {
  binary: "bin/openscience-darwin-arm64",
  license: "LICENSE",
  notice: "NOTICE",
  "third-party-notices": "THIRD_PARTY_NOTICES",
  sbom: "sbom.cdx.json",
  checksums: "checksums.txt",
  "runtime-policy": "runtime-policy.json",
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`)
  const missing = allowed.filter((key) => !(key in value))
  if (missing.length) throw new Error(`${label} missing fields: ${missing.join(", ")}`)
}

export function parseInventory(input: unknown): ArtifactInventory {
  const root = object(input, "inventory")
  exactKeys(root, ROOT_KEYS, "inventory")
  const source = object(root.source, "source")
  const artifact = object(root.artifact, "artifact")
  exactKeys(source, SOURCE_KEYS, "source")
  exactKeys(artifact, ARTIFACT_KEYS, "artifact")
  if (root.schemaVersion !== 1) throw new Error("unsupported schemaVersion")
  if (source.repository !== "https://github.com/synthetic-sciences/openscience" || source.tag !== "v1.3.4" ||
      source.commit !== "109a1b94329fa4cdd82e984b5a40bfe8842b5e6f" || source.sourceDate !== "2026-07-11T07:22:21Z") {
    throw new Error("source pin mismatch")
  }
  if (artifact.name !== "openscience" || artifact.version !== "1.3.4" || artifact.platform !== "darwin" ||
      artifact.arch !== "arm64" || artifact.format !== "bun-compiled-binary" ||
      JSON.stringify(artifact.capabilities) !== JSON.stringify(["embedded-web", "rdkit"])) {
    throw new Error("artifact profile mismatch")
  }
  if (!Array.isArray(root.files) || root.files.length === 0) throw new Error("files must be a non-empty array")
  for (const [index, entry] of root.files.entries()) {
    const file = object(entry, `files[${index}]`)
    exactKeys(file, FILE_KEYS, `files[${index}]`)
    if (typeof file.path !== "string" || typeof file.sha256 !== "string" || typeof file.size !== "number" ||
        !REQUIRED_ROLES.has(file.role as InventoryFile["role"])) throw new Error(`invalid files[${index}]`)
  }
  return root as unknown as ArtifactInventory
}

export function validateRuntimePolicy(input: unknown): RuntimePolicy {
  const policy = object(input, "runtime policy")
  exactKeys(policy, ["schemaVersion", "network", "isolation", "nativeControls", "credentials"], "runtime policy")
  const network = object(policy.network, "network")
  const isolation = object(policy.isolation, "isolation")
  const controls = object(policy.nativeControls, "nativeControls")
  const credentials = object(policy.credentials, "credentials")
  exactKeys(network, ["listen", "allowedHosts", "requireHostValidation", "requireOriginValidation"], "network")
  exactKeys(isolation, ["xdgDataHome", "xdgConfigHome", "xdgCacheHome", "xdgStateHome"], "isolation")
  exactKeys(controls, ["agent", "mcp", "permissions"], "nativeControls")
  exactKeys(credentials, ["productionPersistence", "futurePersistence"], "credentials")
  if (policy.schemaVersion !== 1 || network.listen !== "dynamic-loopback-only" ||
      JSON.stringify(network.allowedHosts) !== JSON.stringify(["127.0.0.1", "[::1]"]) ||
      network.requireHostValidation !== true || network.requireOriginValidation !== true) throw new Error("non-loopback network policy")
  const roots = Object.values(isolation)
  if (roots.some((root) => typeof root !== "string" || !root.startsWith("${SIMULATOR_OPENSCIENCE_ROOT}/")) ||
      new Set(roots).size !== 4) throw new Error("shared or unscoped XDG root")
  if (Object.values(controls).some((value) => value !== "preserve")) throw new Error("native controls must be preserved")
  if (credentials.productionPersistence !== "forbidden" || credentials.futurePersistence !== "host-bridge-required") {
    throw new Error("credential persistence policy mismatch")
  }
  return policy as unknown as RuntimePolicy
}

function safeRelative(filePath: string): boolean {
  return filePath.length > 0 && filePath.length <= 240 && !path.isAbsolute(filePath) &&
    filePath.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== "..")
}

export async function validateArtifact(root: string, rawInventory: unknown): Promise<void> {
  const inventory = parseInventory(rawInventory)
  const collisions = new Set<string>()
  const roles = new Set<InventoryFile["role"]>()
  let total = 0
  for (const file of inventory.files) {
    if (!safeRelative(file.path)) throw new Error(`unsafe path: ${file.path}`)
    const collisionKey = file.path.normalize("NFKC").toLocaleLowerCase("en-US")
    if (collisions.has(collisionKey)) throw new Error(`Unicode/case path collision: ${file.path}`)
    collisions.add(collisionKey)
  }
  for (const file of inventory.files) {
    if (FORBIDDEN_NAMES.has(path.basename(file.path).toLowerCase()) || /credential|secret|token/i.test(file.path)) {
      throw new Error(`credential file forbidden: ${file.path}`)
    }
    if (file.path.startsWith("src/") || file.path.includes("node_modules/") || file.path.startsWith(".git/")) {
      throw new Error(`source checkout or dev dependency forbidden: ${file.path}`)
    }
    if (/darwin-x64|linux|win32|windows/i.test(file.path)) throw new Error(`other architecture forbidden: ${file.path}`)
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_SIZE || !SHA256.test(file.sha256)) {
      throw new Error(`invalid size or hash: ${file.path}`)
    }
    if (file.path !== ROLE_PATHS[file.role]) throw new Error(`role/path binding mismatch: ${file.role}`)
    total += file.size
    if (total > MAX_TOTAL_SIZE) throw new Error("artifact exceeds total size limit")
    roles.add(file.role)
  }
  for (const role of REQUIRED_ROLES) if (!roles.has(role)) throw new Error(`missing required role: ${role}`)
  if (roles.size !== inventory.files.length) throw new Error("duplicate artifact role")

  const canonicalRoot = await realpath(root)
  for (const file of inventory.files) {
    const absolute = path.resolve(canonicalRoot, file.path)
    if (!absolute.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error(`path escapes root: ${file.path}`)
    const stat = await lstat(absolute)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`not a regular file: ${file.path}`)
    if (stat.size !== file.size) throw new Error(`size mismatch: ${file.path}`)
    const bytes = await readFile(absolute)
    const digest = createHash("sha256").update(bytes).digest("hex")
    if (digest !== file.sha256) throw new Error(`hash mismatch: ${file.path}`)
    if (file.role === "runtime-policy") validateRuntimePolicy(JSON.parse(bytes.toString("utf8")))
  }
}
