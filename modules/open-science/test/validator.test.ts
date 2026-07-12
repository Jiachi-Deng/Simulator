import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import type {
  ArtifactInventory, ArtifactRole, BuildBindings, InventoryFile, RuntimeBindings, RuntimePolicy, TrustDecision, ValidationOptions,
} from "../src/types.js"
import { parseInventory, validateArtifact } from "../src/validator.js"

const COMMIT = "109a1b94329fa4cdd82e984b5a40bfe8842b5e6f"
const REPOSITORY = "https://github.com/synthetic-sciences/openscience"
const REF = "refs/tags/v1.3.4"
const paths: Record<ArtifactRole, string> = {
  binary: "bin/openscience-darwin-arm64", license: "LICENSE", notice: "NOTICE",
  "third-party-notices": "THIRD_PARTY_NOTICES", sbom: "sbom.cdx.json", checksums: "checksums.txt",
  "runtime-policy": "runtime-policy.json", provenance: "provenance.json",
  "third-party-decisions": "third-party-decisions.json", "models-snapshot": "models-dev-api.json",
  "build-attestation": "build-attestation.json", "runtime-conformance": "runtime-conformance.json",
}
const legalDir = path.resolve("test/fixtures")
const policyDir = path.resolve("policy")

function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex") }
function clone<T>(value: T): T { return structuredClone(value) }
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }

function trustedDecision(subject: string, source: string, evidence: unknown): TrustDecision {
  return { trusted: true, subject, source, evidence: `sha256:${hash(Buffer.from(json(evidence)))}` }
}

const trustedFakeOptions: ValidationOptions = {
  provenanceVerifier: {
    verifierKind: "test-only-deterministic-fake-provenance",
    async verify(evidence: unknown, expected: BuildBindings) {
      const bindings = (evidence as { bindings?: unknown }).bindings
      assert.deepEqual(bindings, expected)
      return trustedDecision(`sha256:${expected.binarySha256}`, `${expected.sourceRepository}@${expected.sourceCommit}`, evidence)
    },
  },
  runtimeVerifier: {
    verifierKind: "test-only-deterministic-fake-runtime",
    async verify(evidence: unknown, expected: RuntimeBindings) {
      const bindings = (evidence as { bindings?: unknown }).bindings
      assert.deepEqual(bindings, expected)
      const runtimePolicy = await readFile(path.join(policyDir, "runtime-policy.json"))
      return trustedDecision(`sha256:${expected.binarySha256}`, `runtime-policy:sha256:${hash(runtimePolicy)}`, evidence)
    },
  },
}

async function write(root: string, relative: string, content: string | Buffer): Promise<void> {
  const absolute = path.join(root, relative)
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}

async function refresh(root: string, inventory: ArtifactInventory): Promise<void> {
  const checksumLines: string[] = []
  for (const [role, relative] of Object.entries(paths) as Array<[ArtifactRole, string]>) {
    if (role === "checksums") continue
    const bytes = await readFile(path.join(root, relative))
    checksumLines.push(`${hash(bytes)}  ${relative}`)
  }
  checksumLines.sort((a, b) => a.slice(66).localeCompare(b.slice(66)))
  await write(root, paths.checksums, `${checksumLines.join("\n")}\n`)
  for (const entry of inventory.files) {
    const bytes = await readFile(path.join(root, entry.path))
    entry.size = bytes.length; entry.sha256 = hash(bytes)
  }
}

async function fixture(): Promise<{ root: string; inventory: ArtifactInventory }> {
  const root = await mkdtemp(path.join(tmpdir(), "openscience-artifact-"))
  const binary = Buffer.from("TEST-ONLY-NOT-A-REAL-BINARY\n")
  const models = {
    test: { id: "test", name: "Test Provider", models: { "test/model": { id: "test/model", name: "Test Model" } } },
  }
  const modelsBytes = Buffer.from(json(models))
  const components = [
    { id: "pkg:generic/openscience-embedded-web@1.3.4", name: "OpenScience embedded web", version: "1.3.4", license: "Apache-2.0" },
    { id: "pkg:generic/rdkit-wasm@2025.03.3", name: "RDKit WASM", version: "2025.03.3", license: "BSD-3-Clause" },
  ]
  const componentPolicyBytes = await readFile(path.join(policyDir, "trusted-component-profile.json"))
  const componentPolicy = JSON.parse(componentPolicyBytes.toString("utf8")) as { components: unknown[] }
  const buildBindings: BuildBindings = {
    binarySha256: hash(binary), sourceRepository: REPOSITORY, sourceRef: REF, sourceCommit: COMMIT,
    bunVersion: "1.3.5", modelsDevApiSha256: hash(modelsBytes), networkDisabled: true,
    componentPolicySha256: hash(componentPolicyBytes),
    componentSetSha256: hash(Buffer.from(JSON.stringify(componentPolicy.components))),
  }
  const runtimeBindings: RuntimeBindings = {
    binarySha256: hash(binary), dynamicLoopbackBind: true, hostValidation: true, originValidation: true,
    productionCredentialPersistenceDenied: true,
  }
  await write(root, paths.binary, binary)
  await write(root, paths.license, await readFile(path.join(legalDir, "LICENSE")))
  await write(root, paths.notice, await readFile(path.join(legalDir, "NOTICE")))
  await write(root, paths["models-snapshot"], modelsBytes)
  await write(root, paths["runtime-policy"], await readFile(path.join(policyDir, "runtime-policy.json")))
  await write(root, paths.provenance, json({
    schemaVersion: 1,
    source: { repository: REPOSITORY, ref: REF, commit: COMMIT },
    legal: {
      license: "Apache-2.0",
      licenseSha256: "d8ac5e917b2099e5cbe2999f297b56e2cc946e545f39aebc1e1aa91dd5cb0e9f",
      noticeSha256: "7632b32824f48bc3d5f0654cfa2370c1821fc0086349f1d331c9d27b8d66e960",
    },
    toolchain: { bunVersion: "1.3.5", target: "bun-darwin-arm64", modelsDevApiSha256: hash(modelsBytes), networkDisabled: true },
  }))
  await write(root, paths.sbom, json({
    bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
    metadata: { sourceCommit: COMMIT, materials: [
      { uri: `${REPOSITORY}@${COMMIT}`, digest: { algorithm: "gitCommit", value: COMMIT } },
      { uri: "https://models.dev/api.json", digest: { algorithm: "sha256", value: hash(modelsBytes) } },
    ] },
    components: components.map(({ id, name, version, license }) => ({ "bom-ref": id, name, version, license })),
  }))
  await write(root, paths["third-party-notices"], json({
    schemaVersion: 1, sourceCommit: COMMIT,
    components: components.map((component) => ({ ...component, notice: `${component.name} test notice` })),
  }))
  await write(root, paths["third-party-decisions"], await readFile(path.join(policyDir, "third-party-decisions.json")))
  await write(root, paths["build-attestation"], json({ schemaVersion: 1, predicateType: "https://slsa.dev/provenance/v1", bindings: buildBindings }))
  await write(root, paths["runtime-conformance"], json({ schemaVersion: 1, bindings: runtimeBindings }))
  await write(root, paths.checksums, "")
  const files = (Object.entries(paths) as Array<[ArtifactRole, string]>).map(([role, filePath]): InventoryFile => ({
    path: filePath, role, size: 0, sha256: "0".repeat(64),
  }))
  const inventory: ArtifactInventory = {
    schemaVersion: 1,
    source: { repository: REPOSITORY, ref: REF, commit: COMMIT },
    artifact: {
      name: "openscience", version: "1.3.4", platform: "darwin", arch: "arm64",
      format: "bun-compiled-binary", capabilities: ["embedded-web", "rdkit"],
    },
    files,
  }
  await refresh(root, inventory)
  return { root, inventory }
}

async function withFixture(run: (root: string, inventory: ArtifactInventory) => Promise<void>): Promise<void> {
  const value = await fixture()
  try { await run(value.root, value.inventory) } finally { await rm(value.root, { recursive: true, force: true }) }
}

function entry(inventory: ArtifactInventory, role: ArtifactRole): InventoryFile {
  return inventory.files.find((candidate) => candidate.role === role)!
}

async function mutateJson(root: string, inventory: ArtifactInventory, role: ArtifactRole, mutate: (value: any) => void): Promise<void> {
  const value = JSON.parse(await readFile(path.join(root, paths[role]), "utf8"))
  mutate(value); await write(root, paths[role], json(value)); await refresh(root, inventory)
}

test("accepts fixture only with explicitly injected trusted deterministic fakes", () =>
  withFixture((root, inventory) => validateArtifact(root, inventory, trustedFakeOptions)))

test("fails closed without trusted verifiers", () => withFixture(async (root, inventory) => {
  await assert.rejects(validateArtifact(root, inventory), /trusted provenance verifier required/)
}))

test("rejects unlisted auth.json by enumerating all leaves", () => withFixture(async (root, inventory) => {
  await write(root, "auth.json", "{}\n")
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /credential file forbidden|unlisted artifact leaf/)
}))

test("rejects missing inventory leaf", () => withFixture(async (root, inventory) => {
  await rm(path.join(root, paths.notice))
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /missing artifact leaf/)
}))

test("rejects intermediate symlink", () => withFixture(async (root, inventory) => {
  const external = await mkdtemp(path.join(tmpdir(), "openscience-external-"))
  try {
    await rm(path.join(root, "bin"), { recursive: true })
    await symlink(external, path.join(root, "bin"))
    await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /symlink forbidden/)
  } finally { await rm(external, { recursive: true, force: true }) }
}))

test("rejects leaf symlink", () => withFixture(async (root, inventory) => {
  const target = path.join(root, paths.notice)
  await rm(target); await symlink(path.join(legalDir, "NOTICE"), target)
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /symlink forbidden/)
}))

test("computes real hash instead of trusting inventory", () => withFixture(async (root, inventory) => {
  entry(inventory, "binary").sha256 = "0".repeat(64)
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /hash mismatch/)
}))

test("rejects wrong architecture and source pin", () => withFixture(async (_root, inventory) => {
  const arch = clone(inventory); arch.artifact.arch = "x64" as "arm64"
  assert.throws(() => parseInventory(arch), /artifact profile mismatch/)
  const source = clone(inventory); source.source.commit = "0".repeat(40) as typeof source.source.commit
  assert.throws(() => parseInventory(source), /source pin mismatch/)
}))

test("rejects oversized actual leaf before reading it", () => withFixture(async (root, inventory) => {
  await truncate(path.join(root, paths.binary), 256 * 1024 * 1024 + 1)
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /file exceeds size limit/)
}))

test("rejects fake binary attestation binding", () => withFixture(async (root, inventory) => {
  await mutateJson(root, inventory, "build-attestation", (value) => { value.bindings.binarySha256 = "0".repeat(64) })
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /build attestation binding mismatch/)
}))

test("rejects empty legal files", () => withFixture(async (root, inventory) => {
  await write(root, paths.notice, ""); await refresh(root, inventory)
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /pinned NOTICE content mismatch/)
}))

test("rejects missing NOTICE and SBOM roles", () => withFixture(async (_root, inventory) => {
  for (const role of ["notice", "sbom"] as const) {
    const candidate = clone(inventory)
    candidate.files = candidate.files.filter((file) => file.role !== role)
    assert.throws(() => parseInventory(candidate), /every required role exactly once/)
  }
}))

test("rejects missing models snapshot", () => withFixture(async (root, inventory) => {
  await rm(path.join(root, paths["models-snapshot"]))
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /missing artifact leaf/)
}))

test("rejects SBOM notices and decision non-closure", () => withFixture(async (root, inventory) => {
  await mutateJson(root, inventory, "sbom", (value) => { value.components.pop() })
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /component closure mismatch/)
}))

test("rejects artifact-controlled empty component closure against trusted profile", () => withFixture(async (root, inventory) => {
  await mutateJson(root, inventory, "sbom", (value) => { value.components = [] })
  await mutateJson(root, inventory, "third-party-notices", (value) => { value.components = [] })
  await mutateJson(root, inventory, "third-party-decisions", (value) => { value.decisions = [] })
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /required trusted component missing/)
}))

test("rejects malformed and identity-unbound verifier decisions at both library boundaries", () =>
  withFixture(async (root, inventory) => {
    const malformed: unknown[] = [
      { trusted: "false", subject: "x", source: "x", evidence: "x" },
      { trusted: true, subject: "x", source: "x", evidence: "x", extra: true },
      Object.defineProperty({ subject: "x", source: "x", evidence: "x" }, "trusted", { get: () => true, enumerable: true }),
      new Proxy({ trusted: true, subject: "x", source: "x", evidence: "x" }, {}),
    ]
    for (const decision of malformed) {
      const badProvenance: ValidationOptions = {
        ...trustedFakeOptions,
        provenanceVerifier: { verifierKind: "malicious", async verify() { return decision as TrustDecision } },
      }
      await assert.rejects(validateArtifact(root, inventory, badProvenance), /build provenance decision/)
      const badRuntime: ValidationOptions = {
        ...trustedFakeOptions,
        runtimeVerifier: { verifierKind: "malicious", async verify() { return decision as TrustDecision } },
      }
      await assert.rejects(validateArtifact(root, inventory, badRuntime), /runtime conformance decision/)
    }
  }))

test("rejects XDG traversal", () => withFixture(async (root, inventory) => {
  await mutateJson(root, inventory, "runtime-policy", (value: RuntimePolicy) => {
    value.isolation.xdgDataHome = "${SIMULATOR_OPENSCIENCE_ROOT}/../../data"
  })
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /shared or unscoped XDG root|traversal/)
}))

test("rejects non-loopback policy and shared XDG roots", () => withFixture(async (root, inventory) => {
  await mutateJson(root, inventory, "runtime-policy", (value) => { value.network.allowedHosts = ["0.0.0.0"] })
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /non-loopback network policy/)
  await mutateJson(root, inventory, "runtime-policy", (value) => {
    value.network.allowedHosts = ["127.0.0.1", "[::1]"]
    value.isolation.xdgDataHome = value.isolation.xdgConfigHome
  })
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /shared or unscoped XDG root/)
}))

test("rejects runtime evidence binary mismatch", () => withFixture(async (root, inventory) => {
  await mutateJson(root, inventory, "runtime-conformance", (value) => { value.bindings.binarySha256 = "0".repeat(64) })
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /runtime evidence binding mismatch/)
}))

test("rejects unknown provenance fields", () => withFixture(async (root, inventory) => {
  await mutateJson(root, inventory, "provenance", (value) => { value.unknown = true })
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /provenance has unknown fields/)
}))

test("rejects checksum omissions", () => withFixture(async (root, inventory) => {
  const checksumPath = path.join(root, paths.checksums)
  const lines = (await readFile(checksumPath, "utf8")).trimEnd().split("\n")
  await writeFile(checksumPath, `${lines.slice(1).join("\n")}\n`)
  const bytes = await readFile(checksumPath); const checksumEntry = entry(inventory, "checksums")
  checksumEntry.size = bytes.length; checksumEntry.sha256 = hash(bytes)
  await assert.rejects(validateArtifact(root, inventory, trustedFakeOptions), /checksums leaf closure mismatch/)
}))

test("rejects inventory Unicode/case collisions and unknown fields", () => withFixture(async (_root, inventory) => {
  const collision = clone(inventory)
  entry(collision, "notice").path = "legal/Caf\u00e9"
  entry(collision, "license").path = "LEGAL/Cafe\u0301"
  assert.throws(() => parseInventory(collision), /Unicode\/case path collision/)
  const unknown = clone(inventory) as unknown as Record<string, unknown>; unknown.extra = true
  assert.throws(() => parseInventory(unknown), /unknown fields/)
}))
