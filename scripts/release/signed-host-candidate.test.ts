import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ENGINEERING_RC_NAME_PATTERN, SIGNED_CANDIDATE_CLOSURE, SIGNED_CANDIDATE_NAME_PATTERN, SIGNED_CANDIDATE_PRE_ATTESTATION_CLOSURE, validateSignedHostManifest, verifyPreAttestationSignedHostCandidate, verifySignedHostCandidate, writeCanonicalSignedHostManifest } from "./signed-host-candidate"

const root = join(import.meta.dir, ".tmp-signed-host-candidate")
const sourceSha = "a".repeat(40)
const runId = "12345"
const artifactName = `simulator-host-0.12.0-macos-arm64-developer-id-candidate-${sourceSha}`
const authority = "Developer ID Application: Example Corporation (ABCDE12345)"

function sha(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const item = value as Record<string, unknown>
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stable(item[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`)
}

function file(name: string) {
  const bytes = readFileSync(join(root, name))
  return { path: name, bytes: bytes.length, sha256: sha(bytes) }
}

function makeCandidate(mutateSignature?: (signature: any) => void): Record<string, unknown> {
  mkdirSync(join(root, "attestations"), { recursive: true })
  writeFileSync(join(root, "Simulator-arm64.dmg"), "signed-stapled-dmg")
  writeFileSync(join(root, "Simulator-arm64.zip"), "signed-stapled-app-zip")
  const signature = {
    ok: true,
    policy: "developer-id-strict",
    requiredArm64MachOPath: "Contents/MacOS/Simulator",
    requiredArm64MachOFileType: "EXECUTE",
    machOCount: 1,
    kinds: ["developer-id", "developer-id"],
    developerId: {
      authority,
      teamIdentifier: "ABCDE12345",
      bundleIdentifier: "com.example.simulator",
      entitlementsSha256: "7".repeat(64),
    },
    objects: [".", "Contents/MacOS/Simulator"].map((path) => ({
      path,
      kind: "developer-id",
      architectures: path === "." ? [] : ["arm64"],
      strictVerification: { required: true, exitCode: 0 },
      developerId: { authority, teamIdentifier: "ABCDE12345", timestamped: true, hardenedRuntime: true, entitlements: [] },
    })),
  }
  mutateSignature?.(signature)
  writeJson("dmg-signatures.json", signature)
  writeJson("zip-signatures.json", signature)
  const appNotaryId = "12345678-1234-4123-8123-123456789abc"
  const dmgNotaryId = "abcdefab-cdef-4abc-9def-abcdefabcdef"
  writeJson("app-notarization.json", { schemaVersion: 1, artifactKind: "app", id: appNotaryId, status: "Accepted", submittedArtifactSha256: "1".repeat(64) })
  writeJson("dmg-notarization.json", { schemaVersion: 1, artifactKind: "dmg", id: dmgNotaryId, status: "Accepted", submittedArtifactSha256: "2".repeat(64) })
  const containerEquivalence = {
    schemaVersion: 1,
    equivalent: true,
    policy: "macos-app-payload-excluding-signature-metadata-v1",
    baselineRootName: "Simulator.app",
    candidateRootName: "Simulator.app",
    pathCount: 102,
    baselineCanonicalInventorySha256: "3".repeat(64),
    candidateCanonicalInventorySha256: "3".repeat(64),
    directories: 10,
    symlinks: 2,
    exactFiles: 80,
    normalizedMachOFiles: 8,
    signatureMetadataFiles: 2,
  }
  const equivalence = {
    schemaVersion: 1,
    equivalent: true,
    policy: "macos-dual-container-app-payload-equivalence-v1",
    canonicalInventorySha256: containerEquivalence.baselineCanonicalInventorySha256,
    normalizedMachOFiles: containerEquivalence.normalizedMachOFiles,
    containers: { dmg: containerEquivalence, zip: containerEquivalence },
  }
  writeJson("payload-equivalence.json", equivalence)
  writeFileSync(join(root, "h3-post-install-v1.schema.json"), readFileSync(join(import.meta.dir, "schemas", "h3-post-install-v1.schema.json")))
  writeFileSync(join(root, "attestations", "provenance.sigstore.json"), "{}\n")
  const workflow = { name: "signed-macos-host-acceptance.yml", runId, runAttempt: 1, environment: "signed-host-acceptance" }
  const engineeringRc = {
    rcLabel: "0.12.0-rc.3",
    runId: "11111",
    artifactId: "22222",
    artifactDigest: `sha256:${"4".repeat(64)}`,
    artifactName: "simulator-0.12.0-rc.3-macos-arm64-unsigned",
    dmgSha256: "5".repeat(64),
    zipSha256: "6".repeat(64),
  }
  const openDesignAcceptance = {
    workflowPath: ".github/workflows/open-design-rc-acceptance.yml",
    runId: "33333",
    artifactId: "44444",
    artifactDigest: `sha256:${"8".repeat(64)}`,
    artifactName: "open-design-rc-acceptance-evidence",
    summarySha256: "9".repeat(64),
    machineRunId: "55555",
    visualRunId: "66666",
  }
  const identity = {
    bundleIdentifier: "com.example.simulator",
    developerIdApplication: authority,
    teamId: "ABCDE12345",
    entitlementsSha256: "7".repeat(64),
  }
  const provenance = {
    schemaVersion: 1,
    kind: "simulator-macos-arm64-developer-id-candidate-provenance",
    repository: "Jiachi-Deng/Simulator",
    sourceSha,
    hostVersion: "0.12.0",
    workflow,
    engineeringRc,
    openDesignAcceptance,
    identity,
    signed: true,
    createdAt: "2026-07-17T12:34:56.789Z",
    outputs: {
      dmgSha256: file("Simulator-arm64.dmg").sha256,
      zipSha256: file("Simulator-arm64.zip").sha256,
      payloadEquivalenceSha256: file("payload-equivalence.json").sha256,
    },
  }
  writeJson("signed-host-provenance.json", provenance)
  const files = {
    dmg: file("Simulator-arm64.dmg"),
    zip: file("Simulator-arm64.zip"),
    payloadEquivalence: file("payload-equivalence.json"),
    dmgSignatures: file("dmg-signatures.json"),
    zipSignatures: file("zip-signatures.json"),
    appNotarization: file("app-notarization.json"),
    dmgNotarization: file("dmg-notarization.json"),
    provenance: file("signed-host-provenance.json"),
    h3PostInstallSchema: file("h3-post-install-v1.schema.json"),
  }
  const manifest = {
    schemaVersion: 1,
    kind: "simulator-macos-arm64-developer-id-candidate",
    repository: "Jiachi-Deng/Simulator",
    sourceSha,
    hostVersion: "0.12.0",
    artifactName,
    workflow,
    engineeringRc,
    openDesignAcceptance,
    identity,
    notarization: {
      app: { id: appNotaryId, status: "Accepted", submittedSha256: "1".repeat(64), stapled: true, validated: true },
      dmg: { id: dmgNotaryId, status: "Accepted", submittedSha256: "2".repeat(64), stapled: true, validated: true },
    },
    gatekeeper: { app: "PASS", dmg: "PASS" },
    payloadEquivalence: {
      equivalent: true,
      policy: equivalence.policy,
      canonicalInventorySha256: equivalence.canonicalInventorySha256,
      normalizedMachOFiles: equivalence.normalizedMachOFiles,
      reportSha256: files.payloadEquivalence.sha256,
    },
    files,
  }
  const input = join(root, "manifest-input.json")
  writeFileSync(input, JSON.stringify(manifest))
  writeCanonicalSignedHostManifest(input, join(root, "signed-host-manifest.json"))
  rmSync(input)
  const sums = SIGNED_CANDIDATE_CLOSURE.filter((path) => path !== "SHA256SUMS")
    .map((path) => `${sha(readFileSync(join(root, path)))}  ${path}`).join("\n") + "\n"
  writeFileSync(join(root, "SHA256SUMS"), sums)
  return manifest
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("signed Host Candidate evidence", () => {
  test("defines exact unsigned input and signed output Artifact name regexes and closure", () => {
    expect(ENGINEERING_RC_NAME_PATTERN.test("simulator-0.12.0-rc.3-macos-arm64-unsigned")).toBe(true)
    expect(SIGNED_CANDIDATE_NAME_PATTERN.test(artifactName)).toBe(true)
    expect(SIGNED_CANDIDATE_CLOSURE).toEqual([...SIGNED_CANDIDATE_CLOSURE].sort())
    expect(SIGNED_CANDIDATE_CLOSURE).toContain("attestations/provenance.sigstore.json")
    expect(SIGNED_CANDIDATE_PRE_ATTESTATION_CLOSURE).not.toContain("attestations/provenance.sigstore.json")
    expect(SIGNED_CANDIDATE_PRE_ATTESTATION_CLOSURE).not.toContain("SHA256SUMS")
  })

  test("validates strict authority and forbids reuse of unsigned digests", () => {
    const manifest = makeCandidate()
    expect(validateSignedHostManifest(manifest).artifactName).toBe(artifactName)
    const files = manifest.files as Record<string, Record<string, unknown>>
    const engineeringRc = manifest.engineeringRc as Record<string, unknown>
    files.dmg.sha256 = engineeringRc.dmgSha256
    expect(() => validateSignedHostManifest(manifest)).toThrow("reuses unsigned")
    engineeringRc.dmgSha256 = "5".repeat(64)
    engineeringRc.rcLabel = "0.13.0-rc.1"
    engineeringRc.artifactName = "simulator-0.13.0-rc.1-macos-arm64-unsigned"
    expect(() => validateSignedHostManifest(manifest)).toThrow("version differs")
    engineeringRc.rcLabel = "0.12.0-rc.3"
    engineeringRc.artifactName = "simulator-0.12.0-rc.3-macos-arm64-unsigned"
    const acceptance = manifest.openDesignAcceptance as Record<string, unknown>
    acceptance.machineRunId = acceptance.runId
    expect(() => validateSignedHostManifest(manifest)).toThrow("run identities overlap")
  })

  test("verifies exact closure, every file digest, signature/notary/equivalence/provenance fields, and checksums", () => {
    makeCandidate()
    expect(verifySignedHostCandidate(root, sourceSha, runId, artifactName).sourceSha).toBe(sourceSha)
    writeFileSync(join(root, "Simulator-arm64.dmg"), "tampered")
    expect(() => verifySignedHostCandidate(root, sourceSha, runId, artifactName)).toThrow("file evidence differs")
  })

  test("validates the exact secret-free pre-attestation handoff closure", () => {
    makeCandidate()
    rmSync(join(root, "SHA256SUMS"))
    rmSync(join(root, "attestations"), { recursive: true })
    expect(verifyPreAttestationSignedHostCandidate(root, sourceSha, runId, artifactName).sourceSha).toBe(sourceSha)
  })

  test("rejects nested architecture or entitlement evidence outside the app policy closure", () => {
    makeCandidate((signature) => {
      signature.objects[0].developerId.entitlements = ["reviewed"]
      signature.objects[1].architectures = ["x86_64"]
      signature.objects[1].developerId.entitlements = ["unreviewed"]
    })
    expect(() => verifySignedHostCandidate(root, sourceSha, runId, artifactName)).toThrow("architecture differs")
    rmSync(root, { recursive: true })
    makeCandidate((signature) => {
      signature.objects[0].developerId.entitlements = ["reviewed"]
      signature.objects[1].developerId.entitlements = ["unreviewed"]
    })
    expect(() => verifySignedHostCandidate(root, sourceSha, runId, artifactName)).toThrow("not a subset")
  })

  test("rejects a caller-supplied symlink Candidate root before reading evidence", () => {
    makeCandidate()
    const alias = join(import.meta.dir, ".tmp-signed-host-candidate-alias")
    symlinkSync(root, alias)
    try {
      expect(() => verifySignedHostCandidate(alias, sourceSha, runId, artifactName)).toThrow("real directory")
    } finally {
      rmSync(alias)
    }
  })

  test("fails closed on extra closure entries and noncanonical manifest JSON", () => {
    makeCandidate()
    writeFileSync(join(root, "extra.txt"), "unexpected")
    expect(() => verifySignedHostCandidate(root, sourceSha, runId, artifactName)).toThrow("closure differs")
    rmSync(join(root, "extra.txt"))
    const manifestPath = join(root, "signed-host-manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    expect(() => verifySignedHostCandidate(root, sourceSha, runId, artifactName)).toThrow("not canonical")
  })
})
