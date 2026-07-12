import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import type { ArtifactInventory, InventoryFile, RuntimePolicy } from "../src/types.js"
import { parseInventory, validateArtifact } from "../src/validator.js"

const policyPath = path.resolve("policy/runtime-policy.json")
const roles: Array<[string, InventoryFile["role"]]> = [
  ["bin/openscience-darwin-arm64", "binary"],
  ["LICENSE", "license"],
  ["NOTICE", "notice"],
  ["THIRD_PARTY_NOTICES", "third-party-notices"],
  ["sbom.cdx.json", "sbom"],
  ["checksums.txt", "checksums"],
  ["runtime-policy.json", "runtime-policy"],
]

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

async function fixture(): Promise<{ root: string; inventory: ArtifactInventory }> {
  const root = await mkdtemp(path.join(tmpdir(), "openscience-artifact-"))
  const files: InventoryFile[] = []
  for (const [filePath, role] of roles) {
    const absolute = path.join(root, filePath)
    await mkdir(path.dirname(absolute), { recursive: true })
    const bytes = role === "runtime-policy" ? await readFile(policyPath) : Buffer.from(`${role}\n`)
    await writeFile(absolute, bytes)
    files.push({ path: filePath, role, size: bytes.length, sha256: hash(bytes) })
  }
  return {
    root,
    inventory: {
      schemaVersion: 1,
      source: {
        repository: "https://github.com/synthetic-sciences/openscience",
        tag: "v1.3.4",
        commit: "109a1b94329fa4cdd82e984b5a40bfe8842b5e6f",
        sourceDate: "2026-07-11T07:22:21Z",
      },
      artifact: {
        name: "openscience", version: "1.3.4", platform: "darwin", arch: "arm64",
        format: "bun-compiled-binary", capabilities: ["embedded-web", "rdkit"],
      },
      files,
    },
  }
}

async function withFixture(run: (root: string, inventory: ArtifactInventory) => Promise<void>): Promise<void> {
  const value = await fixture()
  try { await run(value.root, value.inventory) } finally { await rm(value.root, { recursive: true, force: true }) }
}

function file(inventory: ArtifactInventory, role: InventoryFile["role"]): InventoryFile {
  return inventory.files.find((entry) => entry.role === role)!
}

test("accepts the exact offline baseline", () => withFixture(validateArtifact))

test("rejects wrong architecture", () => withFixture(async (root, inventory) => {
  inventory.artifact.arch = "x64" as "arm64"
  await assert.rejects(validateArtifact(root, inventory), /artifact profile mismatch/)
}))

test("rejects wrong hash", () => withFixture(async (root, inventory) => {
  file(inventory, "binary").sha256 = "0".repeat(64)
  await assert.rejects(validateArtifact(root, inventory), /hash mismatch/)
}))

for (const role of ["notice", "sbom"] as const) {
  test(`rejects missing ${role}`, () => withFixture(async (root, inventory) => {
    inventory.files = inventory.files.filter((entry) => entry.role !== role)
    await assert.rejects(validateArtifact(root, inventory), new RegExp(`missing required role: ${role}`))
  }))
}

test("rejects non-loopback policy", () => withFixture(async (root, inventory) => {
  const entry = file(inventory, "runtime-policy")
  const policy = JSON.parse(await readFile(path.join(root, entry.path), "utf8")) as RuntimePolicy
  policy.network.listen = "dynamic-loopback-only"
  ;(policy.network as unknown as { allowedHosts: string[] }).allowedHosts = ["0.0.0.0"]
  const bytes = Buffer.from(JSON.stringify(policy))
  await writeFile(path.join(root, entry.path), bytes)
  entry.size = bytes.length; entry.sha256 = hash(bytes)
  await assert.rejects(validateArtifact(root, inventory), /non-loopback network policy/)
}))

test("rejects shared or unscoped XDG data root", () => withFixture(async (root, inventory) => {
  const entry = file(inventory, "runtime-policy")
  const policy = JSON.parse(await readFile(path.join(root, entry.path), "utf8")) as RuntimePolicy
  policy.isolation.xdgDataHome = policy.isolation.xdgConfigHome
  const bytes = Buffer.from(JSON.stringify(policy))
  await writeFile(path.join(root, entry.path), bytes)
  entry.size = bytes.length; entry.sha256 = hash(bytes)
  await assert.rejects(validateArtifact(root, inventory), /shared or unscoped XDG root/)
}))

for (const forbidden of ["auth.json", "mcp-auth.json", "production-credentials.json"]) {
  test(`rejects credential file ${forbidden}`, () => withFixture(async (root, inventory) => {
    const original = file(inventory, "checksums")
    const target = path.join(root, forbidden)
    await writeFile(target, "checksums\n")
    original.path = forbidden
    await assert.rejects(validateArtifact(root, inventory), /credential file forbidden/)
  }))
}

test("rejects source mismatch", () => withFixture(async (root, inventory) => {
  inventory.source.commit = "0".repeat(40) as typeof inventory.source.commit
  await assert.rejects(validateArtifact(root, inventory), /source pin mismatch/)
}))

test("rejects Unicode normalization and case path collisions", () => withFixture(async (root, inventory) => {
  const notice = file(inventory, "notice")
  const thirdParty = file(inventory, "third-party-notices")
  notice.path = "legal/Caf\u00e9"
  thirdParty.path = "LEGAL/Cafe\u0301"
  await assert.rejects(validateArtifact(root, inventory), /Unicode\/case path collision/)
}))

test("rejects unknown schema fields", () => withFixture(async (_root, inventory) => {
  const raw = clone(inventory) as unknown as Record<string, unknown>
  raw.extra = true
  assert.throws(() => parseInventory(raw), /unknown fields: extra/)
}))

test("rejects oversized file declarations", () => withFixture(async (root, inventory) => {
  file(inventory, "binary").size = 256 * 1024 * 1024 + 1
  await assert.rejects(validateArtifact(root, inventory), /invalid size or hash/)
}))

test("rejects source checkout, dev dependencies, and other architectures", () => withFixture(async (root, inventory) => {
  for (const forbidden of ["src/index.ts", "node_modules/pkg/index.js", "bin/openscience-linux-arm64"]) {
    const candidate = clone(inventory)
    file(candidate, "binary").path = forbidden
    await assert.rejects(validateArtifact(root, candidate), /source checkout|other architecture/)
  }
}))
