import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { assertDarwinArm64BunBinary, assertExactBunVersion, assertPinnedModelsSnapshot, stageOpenScience } from "../src/staging.js"

test("accepts the committed reviewed models.dev snapshot and exact Bun pin", async () => {
  await assertPinnedModelsSnapshot()
  assert.doesNotThrow(() => assertExactBunVersion("1.3.5\n"))
  assert.throws(() => assertExactBunVersion("1.3.10\n"), /Bun 1\.3\.5 required/)
})

test("rejects an executable script masquerading as a compiled darwin-arm64 Bun binary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "openscience-mach-o-"))
  const binary = path.join(directory, "openscience")
  try {
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    await chmod(binary, 0o700)
    await assert.rejects(assertDarwinArm64BunBinary(binary), /thin darwin-arm64 Mach-O/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("fails closed before checkout when the required Bun toolchain is unavailable and leaves only a failure record", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "openscience-stage-failure-"))
  const releaseRoot = path.join(directory, "release")
  const validation = {
    provenanceVerifier: { verifierKind: "test", async verify() { return { trusted: true as const, subject: "x", source: "x", evidence: "x" } } },
    runtimeVerifier: { verifierKind: "test", async verify() { return { trusted: true as const, subject: "x", source: "x", evidence: "x" } } },
  }
  try {
    await assert.rejects(stageOpenScience({
      releaseRoot,
      legalEvidenceDirectory: directory,
      buildAttestationPath: path.join(directory, "missing-build-attestation.json"),
      runtimeConformancePath: path.join(directory, "missing-runtime-conformance.json"),
      bunExecutable: process.execPath,
      validation,
    }), /Bun 1\.3\.5 required/)
    await assert.rejects(readFile(releaseRoot))
    const failure = JSON.parse(await readFile(`${releaseRoot}.failure.json`, "utf8")) as { status: string; error: string }
    assert.equal(failure.status, "failed")
    assert.match(failure.error, /Bun 1\.3\.5 required/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
