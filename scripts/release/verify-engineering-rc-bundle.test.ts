import { afterEach, describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { verifyEngineeringRcBundle, type EngineeringRcBundlePhase } from "./verify-engineering-rc-bundle"

const root = join(import.meta.dir, ".tmp-engineering-rc-bundle")
const sourceSha = "a".repeat(40)
const rcLabel = "0.12.0-rc.1"
const productVersion = "0.12.0"
const inputArtifactId = "12345"
const inputArtifactDigest = "d".repeat(64)

afterEach(() => rmSync(root, { recursive: true, force: true }))

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content)
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function mutateJson(name: string, mutate: (value: Record<string, any>) => void): void {
  const path = join(root, name)
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
  mutate(value)
  write(path, canonicalJson(value))
}

function makeBundle(phase: EngineeringRcBundlePhase, packagedPaths = ["Contents/MacOS/Simulator"]): void {
  mkdirSync(root, { recursive: true })
  const dmg = "dmg-bytes"
  const zip = "zip-bytes"
  const verificationCode = "b".repeat(40)
  const packagedFiles = packagedPaths.map((path, index) => ({
    path,
    sha256: index.toString(16).padStart(64, "0"),
    spdxId: `SPDXRef-File-${index + 1}`,
  }))
  const signatureObjects = [
    {
      path: ".",
      kind: "adhoc",
      architectures: [],
      strictVerification: { required: true, exitCode: 0 },
    },
    ...Array.from({ length: 19 }, (_, index) => ({
      path: `Contents/Frameworks/helper-${index}.dylib`,
      kind: "adhoc",
      architectures: ["arm64"],
      strictVerification: { required: true, exitCode: 0 },
    })),
    {
      path: "Contents/MacOS/Simulator",
      kind: "adhoc",
      architectures: ["arm64"],
      strictVerification: { required: true, exitCode: 0 },
    },
  ]
  const signatureEvidence = canonicalJson({
    ok: true,
    policy: "unsigned-or-strictly-verified-adhoc",
    machOCount: 20,
    requiredArm64MachOPath: "Contents/MacOS/Simulator",
    requiredArm64MachOFileType: "EXECUTE",
    kinds: signatureObjects.map((entry) => entry.kind),
    objects: signatureObjects,
  })
  const base = new Map<string, string>([
    ["RELEASE_NOTES.md", "# Simulator 0.12.0\n\n- Test release.\n"],
    ["Simulator-arm64.dmg", dmg],
    ["Simulator-arm64.zip", zip],
    ["app-inventory.jsonl", "{\"path\":\".\"}\n"],
    ["bundle-metadata.json", canonicalJson({
      schemaVersion: 1,
      rcLabel,
      productVersion,
      sourceSha,
      inputArtifactId,
      inputArtifactDigest,
      signed: false,
      channel: "engineering-rc",
    })],
    ["dmg-app-inventory.raw.jsonl", "{\"path\":\".\"}\n"],
    ["dmg-signatures.json", signatureEvidence],
    ["package-verification-code.txt", `${verificationCode}\n`],
    ["packaged-files.sha256", packagedFiles.map((file) => `${file.sha256}  ${file.path}\n`).join("")],
    ["rc-validation.json", canonicalJson({
      schemaVersion: 1,
      ok: true,
      rcLabel,
      productVersion,
      ref: sourceSha,
      sourceSha,
      mainSha: sourceSha,
      checks: [{ id: "repository.exact-main", ok: true, message: "ok" }],
    })],
    ["sbom.spdx.json", canonicalJson({
      spdxVersion: "SPDX-2.3",
      name: `Simulator-${productVersion}`,
      packages: [{
        name: "Simulator",
        SPDXID: "SPDXRef-Package-Simulator",
        versionInfo: productVersion,
        downloadLocation: `git+https://github.com/Jiachi-Deng/Simulator.git@${sourceSha}`,
        filesAnalyzed: true,
        packageVerificationCode: { packageVerificationCodeValue: verificationCode },
        hasFiles: packagedFiles.map((file) => file.spdxId),
      }],
      files: packagedFiles.map((file) => ({
        fileName: `./app/${file.path}`,
        SPDXID: file.spdxId,
        checksums: [{ algorithm: "SHA256", checksumValue: file.sha256 }],
      })),
      relationships: packagedFiles.map((file) => ({
        spdxElementId: "SPDXRef-Package-Simulator",
        relationshipType: "CONTAINS",
        relatedSpdxElement: file.spdxId,
      })),
    })],
    ["transport-normalization-policy.json", "{\"schemaVersion\":1}\n"],
    ["verification-input.json", canonicalJson({
      schemaVersion: 1,
      files: [
        { name: "Simulator-arm64.dmg", size: dmg.length, sha256: sha256(dmg) },
        { name: "Simulator-arm64.zip", size: zip.length, sha256: sha256(zip) },
      ],
    })],
    ["zip-app-inventory.raw.jsonl", "{\"path\":\".\"}\n"],
    ["zip-signatures.json", signatureEvidence],
  ])
  if (phase === "final") {
    base.set("attestations/provenance.sigstore.json", "{\"mediaType\":\"application/vnd.dev.sigstore.bundle.v0.3+json\"}\n")
    base.set("attestations/sbom.sigstore.json", "{\"mediaType\":\"application/vnd.dev.sigstore.bundle.v0.3+json\"}\n")
  }
  for (const [name, content] of base) write(join(root, name), content)

  const summed = phase === "final"
    ? [...base.keys()].sort()
    : ["Simulator-arm64.dmg", "Simulator-arm64.zip"]
  write(join(root, "SHA256SUMS"), `${summed.map((name) => `${sha256(base.get(name)!)}  ${name}`).join("\n")}\n`)
}

const verify = (phase: EngineeringRcBundlePhase): Promise<void> => verifyEngineeringRcBundle({
  phase,
  bundleDirectory: root,
  rcLabel,
  productVersion,
  sourceSha,
  inputArtifactId,
  inputArtifactDigest,
})

describe("Engineering RC bundle closure", () => {
  test.each(["pre", "final"] as const)("accepts an exact %s bundle", async (phase) => {
    makeBundle(phase)
    await expect(verify(phase)).resolves.toBeUndefined()
  })

  test("accepts canonical UTF-8 byte order across underscore, case, and Unicode paths", async () => {
    makeBundle("pre", [
      "Contents/Frameworks/A.dylib",
      "Contents/Info.plist",
      "Contents/_CodeSignature/CodeResources",
      "Contents/a.txt",
      "Contents/\u{e000}.txt",
      "Contents/\u{1f600}.txt",
    ])
    await expect(verify("pre")).resolves.toBeUndefined()
  })

  test("rejects UTF-16-sorted paths that are not in canonical UTF-8 byte order", async () => {
    makeBundle("pre", ["Contents/\u{1f600}.txt", "Contents/\u{e000}.txt"])
    await expect(verify("pre")).rejects.toThrow("canonical UTF-8 byte order")
  })

  test("rejects invalid raw UTF-8 in packaged-files.sha256", async () => {
    makeBundle("pre")
    writeFileSync(join(root, "packaged-files.sha256"), Buffer.concat([
      Buffer.from(`${"c".repeat(64)}  Contents/`, "utf8"),
      Buffer.from([0x80]),
      Buffer.from("\n", "utf8"),
    ]))
    await expect(verify("pre")).rejects.toThrow("packaged-files.sha256 must be valid UTF-8")

    makeBundle("pre")
    const canonical = readFileSync(join(root, "packaged-files.sha256"))
    writeFileSync(join(root, "packaged-files.sha256"), Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      canonical,
    ]))
    await expect(verify("pre")).rejects.toThrow("packaged-files.sha256 contains an unsafe entry")
  })

  test("rejects an unexpected artifact member", async () => {
    makeBundle("final")
    write(join(root, "unexpected.txt"), "unexpected")
    await expect(verify("final")).rejects.toThrow("file closure mismatch")
  })

  test("rejects a final checksum mismatch", async () => {
    makeBundle("final")
    write(join(root, "RELEASE_NOTES.md"), "changed")
    await expect(verify("final")).rejects.toThrow("digest mismatch")
  })

  test("rejects non-ad-hoc signature evidence", async () => {
    makeBundle("pre")
    mutateJson("dmg-signatures.json", (evidence) => { evidence.objects[0].kind = "unsigned" })
    await expect(verify("pre")).rejects.toThrow("strict ad-hoc")
  })

  test("rejects any non-arm64 Mach-O object", async () => {
    makeBundle("pre")
    mutateJson("dmg-signatures.json", (evidence) => { evidence.objects[1].architectures = ["x86_64"] })
    await expect(verify("pre")).rejects.toThrow("strict ad-hoc arm64")
  })

  test("rejects a DMG and ZIP signature-object path mismatch", async () => {
    makeBundle("pre")
    mutateJson("zip-signatures.json", (evidence) => { evidence.objects[1].path = "Contents/Frameworks/other.dylib" })
    await expect(verify("pre")).rejects.toThrow("signature object paths differ")
  })

  test("rejects a malformed signature-object schema", async () => {
    makeBundle("pre")
    mutateJson("dmg-signatures.json", (evidence) => { evidence.objects[1].untrusted = true })
    await expect(verify("pre")).rejects.toThrow("strict ad-hoc arm64")
  })

  test("rejects an SBOM checksum that diverges from packaged-files.sha256", async () => {
    makeBundle("pre")
    mutateJson("sbom.spdx.json", (sbom) => { sbom.files[0].checksums[0].checksumValue = "d".repeat(64) })
    await expect(verify("pre")).rejects.toThrow("SPDX files do not exactly match")
  })

  test("rejects an SBOM relationship that diverges from packaged-files.sha256", async () => {
    makeBundle("pre")
    mutateJson("sbom.spdx.json", (sbom) => { sbom.relationships = [] })
    await expect(verify("pre")).rejects.toThrow("SPDX CONTAINS relationships")
  })

  test("rejects metadata for a different source SHA", async () => {
    makeBundle("pre")
    mutateJson("bundle-metadata.json", (metadata) => { metadata.sourceSha = "d".repeat(40) })
    await expect(verify("pre")).rejects.toThrow("does not match the requested Engineering RC")
  })

  test("rejects metadata for a different raw build artifact", async () => {
    makeBundle("pre")
    mutateJson("bundle-metadata.json", (metadata) => { metadata.inputArtifactDigest = "e".repeat(64) })
    await expect(verify("pre")).rejects.toThrow("does not match the requested Engineering RC")
  })

  test("rejects RC validation that does not prove the exact main SHA", async () => {
    makeBundle("pre")
    mutateJson("rc-validation.json", (validation) => { validation.mainSha = "d".repeat(40) })
    await expect(verify("pre")).rejects.toThrow("does not prove an exact successful main build")
  })

  test("rejects verification input whose artifact digest is stale", async () => {
    makeBundle("pre")
    mutateJson("verification-input.json", (input) => { input.files[0].sha256 = "d".repeat(64) })
    await expect(verify("pre")).rejects.toThrow("artifact changed")
  })

  test("rejects symlink substitution", async () => {
    makeBundle("pre")
    rmSync(join(root, "RELEASE_NOTES.md"))
    symlinkSync("bundle-metadata.json", join(root, "RELEASE_NOTES.md"))
    await expect(verify("pre")).rejects.toThrow("symlink")
  })

  test("rejects an oversized bundle member before hashing it", async () => {
    makeBundle("pre")
    truncateSync(join(root, "RELEASE_NOTES.md"), 32 * 1024 * 1024 + 1)
    await expect(verify("pre")).rejects.toThrow("size limit")
  })
})
