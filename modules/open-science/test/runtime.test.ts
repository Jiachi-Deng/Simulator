import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { startStagedBinary } from "../src/runtime.js"
import type { ArtifactInventory, ArtifactRole, BuildBindings, RuntimeBindings, ValidationOptions } from "../src/types.js"

const policyDir = path.resolve("policy")
const fixtureDir = path.resolve("test/fixtures")
const repository = "https://github.com/synthetic-sciences/openscience"
const ref = "refs/tags/v1.3.4"
const commit = "109a1b94329fa4cdd82e984b5a40bfe8842b5e6f"
const lockSha = "702eecf22d18e468484f40351ad5f0a7d40fc645784ff93b882c8a63588b4bb1"
const paths: Record<ArtifactRole, string> = {
  binary: "bin/openscience-darwin-arm64", license: "LICENSE", notice: "NOTICE", "third-party-notices": "THIRD_PARTY_NOTICES",
  sbom: "sbom.cdx.json", checksums: "checksums.txt", "runtime-policy": "runtime-policy.json", provenance: "provenance.json",
  "third-party-decisions": "third-party-decisions.json", "models-snapshot": "models-dev-api.json",
  "build-attestation": "build-attestation.json", "runtime-conformance": "runtime-conformance.json",
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

async function write(root: string, relative: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true })
  await writeFile(path.join(root, relative), bytes)
}

function trusted(expected: BuildBindings | RuntimeBindings, evidence: unknown, source: string) {
  const binarySha256 = expected.binarySha256
  return { trusted: true as const, subject: `sha256:${binarySha256}`, source, evidence: `sha256:${hash(json(evidence))}` }
}

async function runtimeFixture(): Promise<{ root: string; cleanupRoot: string; inventoryPath: string; validation: Required<ValidationOptions> }> {
  const cleanupRoot = await mkdtemp(path.join(tmpdir(), "openscience-runtime-artifact-"))
  const root = path.join(cleanupRoot, "artifact")
  await mkdir(root)
  const binary = Buffer.from(`#!/usr/bin/env node
const http = require("node:http")
const port = Number(process.argv[2])
const expected = "127.0.0.1:" + port
const server = http.createServer((request, response) => {
  if (request.headers.host !== expected) { response.statusCode = 400; response.end("bad host"); return }
  if (request.headers.origin) { response.statusCode = 403; response.end("bad origin"); return }
  response.end("ok")
})
server.listen(port, "127.0.0.1")
process.on("SIGTERM", () => server.close(() => process.exit(0)))
`)
  const models = Buffer.from(JSON.stringify({ test: { id: "test", name: "Test", models: { "test/model": { id: "test/model", name: "Test model" } } } }))
  const componentPolicyBytes = await readFile(path.join(policyDir, "trusted-component-profile.json"))
  const runtimePolicyBytes = await readFile(path.join(policyDir, "runtime-policy.json"))
  const componentPolicy = JSON.parse(componentPolicyBytes.toString("utf8")) as { components: unknown[] }
  const components = [
    { id: "pkg:generic/openscience-embedded-web@1.3.4", name: "OpenScience embedded web", version: "1.3.4", license: "Apache-2.0" },
    { id: "pkg:generic/rdkit-wasm@2025.03.3", name: "RDKit WASM", version: "2025.03.3", license: "BSD-3-Clause" },
  ]
  const bindings: BuildBindings = {
    binarySha256: hash(binary), sourceRepository: repository, sourceRef: ref, sourceCommit: commit, sourceLockSha256: lockSha,
    bunVersion: "1.3.5", modelsDevApiSha256: hash(models), networkDisabled: true,
    componentPolicySha256: hash(componentPolicyBytes), componentSetSha256: hash(Buffer.from(JSON.stringify(componentPolicy.components))),
  }
  const runtimeBindings: RuntimeBindings = {
    binarySha256: hash(binary), dynamicLoopbackBind: true, hostValidation: true, originValidation: true,
    productionCredentialPersistenceDenied: true,
  }
  await write(root, paths.binary, binary)
  await chmod(path.join(root, paths.binary), 0o700)
  await write(root, paths.license, await readFile(path.join(fixtureDir, "LICENSE")))
  await write(root, paths.notice, await readFile(path.join(fixtureDir, "NOTICE")))
  await write(root, paths["models-snapshot"], models)
  await write(root, paths["runtime-policy"], runtimePolicyBytes)
  await write(root, paths.provenance, json({
    schemaVersion: 1, source: { repository, ref, commit },
    legal: { license: "Apache-2.0", licenseSha256: "d8ac5e917b2099e5cbe2999f297b56e2cc946e545f39aebc1e1aa91dd5cb0e9f", noticeSha256: "7632b32824f48bc3d5f0654cfa2370c1821fc0086349f1d331c9d27b8d66e960" },
    toolchain: { bunVersion: "1.3.5", target: "bun-darwin-arm64", sourceLockSha256: lockSha, modelsDevApiSha256: hash(models), networkDisabled: true },
  }))
  await write(root, paths.sbom, json({
    bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
    metadata: { sourceCommit: commit, materials: [
      { uri: `${repository}@${commit}`, digest: { algorithm: "gitCommit", value: commit } },
      { uri: "https://models.dev/api.json", digest: { algorithm: "sha256", value: hash(models) } },
      { uri: `${repository}/bun.lock@${commit}`, digest: { algorithm: "sha256", value: lockSha } },
    ] },
    components: components.map(({ id, name, version, license }) => ({ "bom-ref": id, name, version, license })),
  }))
  await write(root, paths["third-party-notices"], json({ schemaVersion: 1, sourceCommit: commit, components: components.map((component) => ({ ...component, notice: `${component.name} notice` })) }))
  await write(root, paths["third-party-decisions"], await readFile(path.join(policyDir, "third-party-decisions.json")))
  const buildEvidence = { schemaVersion: 1, predicateType: "https://slsa.dev/provenance/v1", bindings }
  const runtimeEvidence = { schemaVersion: 1, bindings: runtimeBindings }
  await write(root, paths["build-attestation"], json(buildEvidence))
  await write(root, paths["runtime-conformance"], json(runtimeEvidence))
  const checksumLines: string[] = []
  for (const [role, relative] of Object.entries(paths) as Array<[ArtifactRole, string]>) {
    if (role !== "checksums") checksumLines.push(`${hash(await readFile(path.join(root, relative)))}  ${relative}`)
  }
  await write(root, paths.checksums, Buffer.from(`${checksumLines.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n")}\n`))
  const files = await Promise.all((Object.entries(paths) as Array<[ArtifactRole, string]>).map(async ([role, relative]) => {
    const bytes = await readFile(path.join(root, relative))
    return { role, path: relative, size: bytes.length, sha256: hash(bytes) }
  }))
  const inventory: ArtifactInventory = {
    schemaVersion: 1, source: { repository, ref, commit },
    artifact: { name: "openscience", version: "1.3.4", platform: "darwin", arch: "arm64", format: "bun-compiled-binary", capabilities: ["embedded-web", "rdkit"] },
    files,
  }
  const inventoryPath = path.join(cleanupRoot, "inventory.json")
  await writeFile(inventoryPath, json(inventory))
  return {
    root, cleanupRoot, inventoryPath,
    validation: {
      provenanceVerifier: { verifierKind: "test", async verify(evidence, expected) { return trusted(expected, evidence, `${expected.sourceRepository}@${expected.sourceCommit}`) } },
      runtimeVerifier: { verifierKind: "test", async verify(evidence, expected) { return trusted(expected, evidence, `runtime-policy:sha256:${hash(runtimePolicyBytes)}`) } },
    },
  }
}

test("starts a validated staged binary on a host-assigned loopback port, rejects Host and Origin, and removes state on stop", async () => {
  const fixture = await runtimeFixture()
  const stateParent = await mkdtemp(path.join(tmpdir(), "openscience-runtime-state-"))
  try {
    const runtime = await startStagedBinary({
      artifactRoot: fixture.root, inventoryPath: fixture.inventoryPath, validation: fixture.validation,
      argumentsForPort: (port) => [String(port)], stateRootParent: stateParent,
    })
    assert.match(runtime.address, /^http:\/\/127\.0\.0\.1:\d+$/)
    const record = await runtime.stop()
    assert.equal(record.hostRejectionStatus, 400)
    assert.equal(record.originRejectionStatus, 403)
    assert.equal(record.binarySha256, runtime.binarySha256)
    assert.deepEqual(await readdir(stateParent), [])
    await assert.rejects(fetch(runtime.address), /fetch failed/)
  } finally {
    await rm(fixture.cleanupRoot, { recursive: true, force: true })
    await rm(stateParent, { recursive: true, force: true })
  }
})
