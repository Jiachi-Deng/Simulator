import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const root = join(import.meta.dir, ".tmp-app-equivalence")
const script = join(import.meta.dir, "compare-macos-app-payloads.py")

function machO(payload: string, signature: string): Buffer {
  const payloadBytes = Buffer.from(payload)
  const signatureBytes = Buffer.from(signature)
  const headerBytes = 32
  const segmentCommandBytes = 72
  const signatureCommandBytes = 16
  const commandBytes = segmentCommandBytes + signatureCommandBytes
  const dataOffset = headerBytes + commandBytes + payloadBytes.length
  const buffer = Buffer.alloc(dataOffset + signatureBytes.length)
  buffer.writeUInt32LE(0xfeedfacf, 0)
  buffer.writeUInt32LE(0x0100000c, 4)
  buffer.writeUInt32LE(0, 8)
  buffer.writeUInt32LE(2, 12)
  buffer.writeUInt32LE(2, 16)
  buffer.writeUInt32LE(commandBytes, 20)
  buffer.writeUInt32LE(0, 24)
  buffer.writeUInt32LE(0, 28)
  buffer.writeUInt32LE(0x19, 32)
  buffer.writeUInt32LE(segmentCommandBytes, 36)
  buffer.write("__LINKEDIT", 40, "ascii")
  buffer.writeBigUInt64LE(BigInt(headerBytes + commandBytes), 56)
  buffer.writeBigUInt64LE(BigInt(payloadBytes.length + signatureBytes.length), 64)
  buffer.writeBigUInt64LE(BigInt(headerBytes + commandBytes), 72)
  buffer.writeBigUInt64LE(BigInt(payloadBytes.length + signatureBytes.length), 80)
  const signatureCommand = headerBytes + segmentCommandBytes
  buffer.writeUInt32LE(0x1d, signatureCommand)
  buffer.writeUInt32LE(signatureCommandBytes, signatureCommand + 4)
  buffer.writeUInt32LE(dataOffset, signatureCommand + 8)
  buffer.writeUInt32LE(signatureBytes.length, signatureCommand + 12)
  payloadBytes.copy(buffer, headerBytes + commandBytes)
  signatureBytes.copy(buffer, dataOffset)
  return buffer
}

function app(name: string, payload = "same-payload", resource = "same-resource"): string {
  const path = join(root, name, "Simulator.app")
  mkdirSync(join(path, "Contents", "MacOS"), { recursive: true })
  mkdirSync(join(path, "Contents", "_CodeSignature"), { recursive: true })
  mkdirSync(join(path, "Contents", "Resources"), { recursive: true })
  writeFileSync(join(path, "Contents", "MacOS", "Simulator"), machO(payload, `${name}-different-signature-size`), { mode: 0o755 })
  chmodSync(join(path, "Contents", "MacOS", "Simulator"), 0o755)
  writeFileSync(join(path, "Contents", "Resources", "resource.txt"), resource)
  writeFileSync(join(path, "Contents", "_CodeSignature", "CodeResources"), `${name}-signature-metadata`)
  symlinkSync("MacOS/Simulator", join(path, "Contents", "Simulator-link"))
  return path
}

function compare(before: string, after: string) {
  const output = join(root, "report.json")
  return spawnSync("python3", [script, before, after, output], { encoding: "utf8" })
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("macOS signed/Engineering RC app payload equivalence", () => {
  test("accepts exact resources and normalized Mach-O payloads while allowing only signature metadata to differ", () => {
    const result = compare(app("baseline"), app("candidate"))
    expect(result.status).toBe(0)
    const report = JSON.parse(require("node:fs").readFileSync(join(root, "report.json"), "utf8"))
    expect(report).toMatchObject({
      schemaVersion: 1,
      equivalent: true,
      policy: "macos-app-payload-excluding-signature-metadata-v1",
      normalizedMachOFiles: 1,
      signatureMetadataFiles: 1,
      exactFiles: 1,
    })
    expect(report.baselineCanonicalInventorySha256).toBe(report.candidateCanonicalInventorySha256)
  })

  test("exposes one deterministic canonical Mach-O digest independent of signature and __LINKEDIT allocation size", () => {
    const first = join(root, "first")
    const second = join(root, "second")
    mkdirSync(root, { recursive: true })
    writeFileSync(first, machO("same-payload", "short"), { mode: 0o755 })
    writeFileSync(second, machO("same-payload", "a-much-longer-developer-id-cms"), { mode: 0o755 })
    const firstResult = spawnSync("python3", [script, "canonical-macho", first], { encoding: "utf8" })
    const secondResult = spawnSync("python3", [script, "canonical-macho", second], { encoding: "utf8" })
    expect(firstResult.status).toBe(0)
    expect(secondResult.status).toBe(0)
    const firstEvidence = JSON.parse(firstResult.stdout)
    const secondEvidence = JSON.parse(secondResult.stdout)
    expect(firstEvidence.policy).toBe("thin-arm64-macho-terminal-code-signature-v1")
    expect(firstEvidence.canonicalSha256).toBe(secondEvidence.canonicalSha256)
    expect(firstEvidence.canonicalBytes).toBe(secondEvidence.canonicalBytes)
    expect(firstEvidence.signatureBytes).not.toBe(secondEvidence.signatureBytes)
  })

  test("exposes an exact full-tree digest that includes signature metadata and file bytes", () => {
    const before = app("baseline")
    const first = spawnSync("python3", [script, "exact-tree", before], { encoding: "utf8" })
    expect(first.status).toBe(0)
    const firstEvidence = JSON.parse(first.stdout)
    expect(firstEvidence.policy).toBe("exact-tree-path-type-mode-symlink-content-v1")
    writeFileSync(join(before, "Contents", "_CodeSignature", "CodeResources"), "changed-signature-metadata")
    const second = spawnSync("python3", [script, "exact-tree", before], { encoding: "utf8" })
    expect(second.status).toBe(0)
    expect(JSON.parse(second.stdout).inventorySha256).not.toBe(firstEvidence.inventorySha256)
  })

  test("rejects a non-signature resource difference", () => {
    const result = compare(app("baseline"), app("candidate", "same-payload", "changed-resource"))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Non-signature file bytes differ")
  })

  test("rejects a Mach-O payload difference even when signatures also differ", () => {
    const result = compare(app("baseline"), app("candidate", "changed-payload"))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Mach-O payload differs")
  })

  test("rejects path, mode, and malformed signature-region drift", () => {
    const baseline = app("baseline")
    const candidate = app("candidate")
    chmodSync(join(candidate, "Contents", "Resources", "resource.txt"), 0o600)
    expect(compare(baseline, candidate).stderr).toContain("Type or mode differs")
    rmSync(root, { recursive: true, force: true })
    const malformedBaseline = app("baseline")
    const malformedCandidate = app("candidate")
    const binary = join(malformedCandidate, "Contents", "MacOS", "Simulator")
    const bytes = require("node:fs").readFileSync(binary)
    bytes.writeUInt32LE(bytes.length + 10, 32 + 72 + 8)
    writeFileSync(binary, bytes, { mode: 0o755 })
    expect(compare(malformedBaseline, malformedCandidate).stderr).toContain("signature blob")
  })
})
