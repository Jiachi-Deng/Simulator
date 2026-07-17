import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import Ajv2020 from "ajv-formats/node_modules/ajv/dist/2020"
import sharp from "sharp"
import {
  H3_HUMAN_OBSERVATION_CLOSURE,
  canonicalH3HumanObservationInput,
  validateH3HumanObservationEvidence,
  validateH3HumanObservationInput,
  verifyH3HumanObservationEvidence,
  writeH3HumanObservationEvidence,
  type H3HumanObservationDependencies,
  type H3HumanObservationInput,
} from "./h3-human-observation-evidence"
import {
  H3_POST_INSTALL_AUTHORITY_CLOSURE,
  verifyH3PostInstallAuthorityClosure,
  writeH3PostInstallAuthorityClosure,
  type H3AuthenticatedCandidateAuthority,
  type H3AuthorityAuthenticator,
} from "./h3-post-install-authority"
import {
  canonicalH3PostInstallEvidence,
  validateH3PostInstallEvidence,
  type H3PostInstallInspector,
} from "./h3-post-install-evidence"

const root = join(import.meta.dir, ".tmp-h3-human-observation")
const sourceSha = "a".repeat(40)
const artifactName = `simulator-host-0.12.0-macos-arm64-developer-id-candidate-${sourceSha}`
let baseMs = 0

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(12 + data.length)
  result.writeUInt32BE(data.length, 0)
  result.write(type, 4, 4, "ascii")
  data.copy(result, 8)
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length)
  return result
}

function findChunk(bytes: Buffer, expected: string): { start: number; dataStart: number; dataEnd: number; end: number } {
  let offset = 8
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii")
    const end = offset + 12 + length
    if (type === expected) return { start: offset, dataStart: offset + 8, dataEnd: offset + 8 + length, end }
    offset = end
  }
  throw new Error(`missing ${expected}`)
}

function time(offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString()
}

function sha256(bytes: string | Buffer): string {
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

const authenticator: H3AuthorityAuthenticator = {
  authenticate() {
    return {
      repository: "Jiachi-Deng/Simulator",
      repositoryId: 1_298_254_148,
      sourceSha,
      headBranch: "main",
      runId: "12345",
      runAttempt: 1,
      workflowPath: ".github/workflows/signed-macos-host-acceptance.yml",
      workflowDisplayName: "Signed macOS Host acceptance Candidate",
      candidateWorkflowName: "signed-macos-host-acceptance.yml",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      artifactId: "67890",
      artifactName,
      artifactServiceDigest: `sha256:${"b".repeat(64)}`,
      artifactExpired: false,
      rawCandidateBytes: 123456,
      rawCandidateSha256: "b".repeat(64),
      candidateDmgBytes: 98765,
      candidateDmgSha256: "c".repeat(64),
      githubClient: {
        linkPath: "/opt/homebrew/bin/gh",
        realPath: "/opt/homebrew/Cellar/gh/2.86.0/bin/gh",
        version: "gh version 2.86.0 (2026-01-21)",
        bytes: 35_925_986,
        sha256: "9".repeat(64),
      },
      authenticatedAt: time(-1_000),
    } satisfies H3AuthenticatedCandidateAuthority
  },
}

const postInspector: H3PostInstallInspector = {
  inspect() {
    return {
      sourceSha,
      hostBuildRunId: "12345",
      artifactName,
      dmgPath: "/verified/Simulator-arm64.dmg",
      dmgBytes: 98765,
      dmgSha256: "c".repeat(64),
      macOSVersion: "15.5 (24F74)",
      bundleIdentifier: "com.example.simulator",
      hostVersion: "0.12.0",
      appBundleVersion: "0.12.0",
      canonicalInventorySha256: "d".repeat(64),
      installedAppIdentitySha256: "e".repeat(64),
      backupIdentitySha256: "N/A",
      developerIdApplication: "Developer ID Application: Example Corporation (ABCDE12345)",
      teamId: "ABCDE12345",
    }
  },
}

async function setup(): Promise<{
  authorityRoot: string
  authoritySha256: string
  outputRoot: string
  inputPath: string
  input: H3HumanObservationInput
  screenshots: string[]
  dependencies: H3HumanObservationDependencies
}> {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { mode: 0o700 })
  chmodSync(root, 0o700)
  const authorityRoot = join(root, "authority")
  const outputRoot = join(root, "human-evidence")
  mkdirSync(authorityRoot, { mode: 0o700 })
  mkdirSync(outputRoot, { mode: 0o700 })
  chmodSync(authorityRoot, 0o700)
  chmodSync(outputRoot, 0o700)
  const postHumanPath = join(root, "post-human.json")
  writeFileSync(postHumanPath, JSON.stringify({
    environmentKind: "clean-vm",
    existingAppBeforeInstall: false,
    backupPath: "N/A",
    restoreStatus: "NOT NEEDED",
  }), { mode: 0o600 })
  const authorityClosure = writeH3PostInstallAuthorityClosure(
    "/verified/raw-candidate.zip",
    "/verified/Simulator-arm64.dmg",
    postHumanPath,
    authorityRoot,
    { authenticator, inspector: postInspector, now: () => new Date(baseMs) },
  )
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
  }).png().toBuffer()
  const screenshots = ["CraftVisible", "OpenDesignModuleEntryVisible", "OpenDesignSecondLoginAbsent"].map((id) => {
    const path = join(root, `${id}-source.png`)
    writeFileSync(path, png, { mode: 0o600 })
    return path
  })
  const input: H3HumanObservationInput = {
    schemaVersion: 1,
    observations: [
      { id: "CraftVisible", passed: true, observedAt: time(1_000), screenshotPath: screenshots[0]! },
      { id: "OpenDesignModuleEntryVisible", passed: true, observedAt: time(2_000), screenshotPath: screenshots[1]! },
      { id: "OpenDesignSecondLoginAbsent", passed: true, observedAt: time(3_000), screenshotPath: screenshots[2]! },
    ],
  }
  const inputPath = join(root, "human-input.json")
  writeFileSync(inputPath, canonicalH3HumanObservationInput(input), { mode: 0o600 })
  return {
    authorityRoot,
    authoritySha256: authorityClosure.authoritySha256,
    outputRoot,
    inputPath,
    input,
    screenshots,
    dependencies: {
      recoveryInspector: { exactTreeSha256: () => { throw new Error("not needed") } },
      authenticator,
      now: () => new Date(baseMs + 5_000),
    },
  }
}

beforeEach(() => { baseMs = Date.now() - 30_000 })
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("H3 human observation authority and PNG closure", () => {
  test("the generate CLI rejects every trailing argument", () => {
    const result = spawnSync(process.execPath, [
      join(import.meta.dir, "h3-human-observation-evidence.ts"),
      "generate", "stage1", "raw.zip", "a".repeat(64), "human.json", "output", "unexpected",
    ], { encoding: "utf8" })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Usage: h3-human-observation-evidence.ts")
  })

  test("the Candidate human-observation schema compiles with Ajv 2020 strict mode", () => {
    const schema = JSON.parse(readFileSync(
      join(import.meta.dir, "schemas", "h3-human-observation-v1.schema.json"),
      "utf8",
    ))
    const ajv = new Ajv2020({ strict: true, allErrors: true })
    expect(() => ajv.compile(schema)).not.toThrow()
    for (const definition of [
      "craftVisible", "openDesignModuleEntryVisible", "openDesignSecondLoginAbsent",
    ]) {
      expect(schema.$defs[definition].properties.screenshot.type).toBe("object")
    }
  })

  test("recovery uses the fixed hardened H3 system command boundary without a runner injection seam", () => {
    const source = readFileSync(join(import.meta.dir, "h3-human-observation-evidence.ts"), "utf8")
    expect(source).not.toContain("spawnSync")
    expect(source).toContain("runH3SystemCommand(")
    expect(source).toContain("H3_SYSTEM_EXECUTABLES.python3")
    expect(source).toContain('[join(import.meta.dir, "compare-macos-app-payloads.py"), "exact-tree", app]')
    expect(source).toContain('"Restored App exact-tree inspection"')
    expect(source).toContain('"heavy"')
  })

  test("seals exactly three PASS observations after independent Stage-2 authority authentication", async () => {
    const fixture = await setup()
    const result = await writeH3HumanObservationEvidence(
      fixture.authorityRoot,
      "/verified/raw-candidate.zip",
      fixture.authoritySha256,
      fixture.inputPath,
      fixture.outputRoot,
      fixture.dependencies,
    )
    expect(result.evidence.observations.map((item) => item.id)).toEqual([
      "CraftVisible", "OpenDesignModuleEntryVisible", "OpenDesignSecondLoginAbsent",
    ])
    expect(H3_HUMAN_OBSERVATION_CLOSURE).toEqual([
      "SHA256SUMS",
      "human-observation.json",
      "screenshots/CraftVisible.png",
      "screenshots/OpenDesignModuleEntryVisible.png",
      "screenshots/OpenDesignSecondLoginAbsent.png",
    ])
    expect(result.evidence.authority).toMatchObject({
      sourceSha,
      artifactId: "67890",
      rawCandidateSha256: "b".repeat(64),
      postInstallAuthoritySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      postInstallSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(await verifyH3HumanObservationEvidence(
      fixture.outputRoot,
      fixture.authorityRoot,
      "/verified/raw-candidate.zip",
      fixture.authoritySha256,
      fixture.dependencies,
    )).toMatchObject({ sha256: result.sha256 })
    await expect(verifyH3HumanObservationEvidence(
      fixture.outputRoot,
      fixture.authorityRoot,
      "/verified/raw-candidate.zip",
      "f".repeat(64),
      fixture.dependencies,
    )).rejects.toThrow("pre-restore frozen value")
  })

  test("rejects incomplete, false, reordered, and noncanonical human claims", async () => {
    const fixture = await setup()
    expect(() => validateH3HumanObservationInput({ ...fixture.input, observations: fixture.input.observations.slice(0, 2) })).toThrow("exactly three")
    expect(() => validateH3HumanObservationInput({
      ...fixture.input,
      observations: [fixture.input.observations[1], fixture.input.observations[0], fixture.input.observations[2]],
    })).toThrow("canonical order")
    expect(() => validateH3HumanObservationInput({
      ...fixture.input,
      observations: fixture.input.observations.map((item, index) => index === 0 ? { ...item, passed: false } : item),
    })).toThrow("explicit PASS")
    writeFileSync(fixture.inputPath, `${JSON.stringify(fixture.input, null, 2)}\n`, { mode: 0o600 })
    await expect(writeH3HumanObservationEvidence(
      fixture.authorityRoot, "/verified/raw-candidate.zip", fixture.authoritySha256, fixture.inputPath, fixture.outputRoot, fixture.dependencies,
    )).rejects.toThrow("not canonical")
  })

  test("fully decodes a real PNG and rejects signature-plus-text and structural corruption", async () => {
    expect(sharp.versions.sharp).toBe("0.34.5")
    const cases: Array<[string, (valid: Buffer) => Buffer, RegExp]> = [
      ["header-plus-text", () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not an image")]), /truncated|missing/],
      ["truncated-idat", (valid) => valid.subarray(0, findChunk(valid, "IDAT").dataEnd - 1), /truncated|missing/],
      ["bad-crc", (valid) => { const copy = Buffer.from(valid); copy[findChunk(copy, "IDAT").dataStart] ^= 1; return copy }, /bad PNG CRC/],
      ["missing-iend", (valid) => valid.subarray(0, findChunk(valid, "IEND").start), /missing/],
      ["trailing-bytes", (valid) => Buffer.concat([valid, Buffer.from("trailing")]), /trailing bytes/],
      ["pixel-bomb", (valid) => {
        const copy = Buffer.from(valid)
        const ihdr = findChunk(copy, "IHDR")
        copy.writeUInt32BE(9000, ihdr.dataStart)
        copy.writeUInt32BE(crc32(copy.subarray(ihdr.start + 4, ihdr.dataEnd)), ihdr.dataEnd)
        return copy
      }, /dimension or pixel bound/],
      ["apng", (valid) => {
        const idat = findChunk(valid, "IDAT")
        const animationControl = Buffer.alloc(8)
        animationControl.writeUInt32BE(1, 0)
        animationControl.writeUInt32BE(0, 4)
        return Buffer.concat([valid.subarray(0, idat.start), chunk("acTL", animationControl), valid.subarray(idat.start)])
      }, /animated PNG/],
    ]
    for (const [label, mutate, error] of cases) {
      const fixture = await setup()
      writeFileSync(fixture.screenshots[0]!, mutate(readFileSync(fixture.screenshots[0]!)), { mode: 0o600 })
      await expect(writeH3HumanObservationEvidence(
        fixture.authorityRoot, "/verified/raw-candidate.zip", fixture.authoritySha256, fixture.inputPath, fixture.outputRoot, fixture.dependencies,
      )).rejects.toThrow(error)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("normalizes a valid PNG without metadata while preserving every decoded pixel", async () => {
    const fixture = await setup()
    const source = readFileSync(fixture.screenshots[0]!)
    const idat = findChunk(source, "IDAT")
    const secret = "Comment\0ghp_abcdefghijklmnopqrstuvwxyz123456"
    const withMetadata = Buffer.concat([
      source.subarray(0, idat.start),
      chunk("tEXt", Buffer.from(secret, "latin1")),
      source.subarray(idat.start),
    ])
    writeFileSync(fixture.screenshots[0]!, withMetadata, { mode: 0o600 })
    const sourcePixels = await sharp(withMetadata).raw().toBuffer()
    await writeH3HumanObservationEvidence(
      fixture.authorityRoot,
      "/verified/raw-candidate.zip",
      fixture.authoritySha256,
      fixture.inputPath,
      fixture.outputRoot,
      fixture.dependencies,
    )
    const sealed = readFileSync(join(fixture.outputRoot, "screenshots", "CraftVisible.png"))
    expect(sealed.includes(Buffer.from("ghp_", "ascii"))).toBe(false)
    expect(() => findChunk(sealed, "tEXt")).toThrow("missing tEXt")
    expect(() => findChunk(sealed, "pHYs")).toThrow("missing pHYs")
    const sealedMetadata = await sharp(sealed).metadata()
    expect(sealedMetadata.comments).toBeUndefined()
    expect(await sharp(sealed).raw().toBuffer()).toEqual(sourcePixels)
  })

  test("rejects a synchronously resealed Stage-1 closure when its pre-restore authority hash is frozen", async () => {
    const fixture = await setup()
    const postPath = join(fixture.authorityRoot, "post-install.json")
    const post = JSON.parse(readFileSync(postPath, "utf8"))
    post.installedAppIdentitySha256 = "f".repeat(64)
    const postBytes = canonicalH3PostInstallEvidence(validateH3PostInstallEvidence(post))
    writeFileSync(postPath, postBytes, { mode: 0o600 })
    const authorityPath = join(fixture.authorityRoot, "post-install-authority.json")
    const authorityValue = JSON.parse(readFileSync(authorityPath, "utf8"))
    authorityValue.postInstall.bytes = Buffer.byteLength(postBytes)
    authorityValue.postInstall.sha256 = sha256(postBytes)
    writeFileSync(authorityPath, `${stable(authorityValue)}\n`, { mode: 0o600 })
    const sums = `${H3_POST_INSTALL_AUTHORITY_CLOSURE.filter((path) => path !== "SHA256SUMS")
      .map((path) => `${sha256(readFileSync(join(fixture.authorityRoot, path)))}  ${path}`).join("\n")}\n`
    writeFileSync(join(fixture.authorityRoot, "SHA256SUMS"), sums, { mode: 0o600 })
    expect(verifyH3PostInstallAuthorityClosure(
      fixture.authorityRoot,
      "/verified/raw-candidate.zip",
      authenticator,
    ).authoritySha256).not.toBe(fixture.authoritySha256)
    await expect(writeH3HumanObservationEvidence(
      fixture.authorityRoot,
      "/verified/raw-candidate.zip",
      fixture.authoritySha256,
      fixture.inputPath,
      fixture.outputRoot,
      fixture.dependencies,
    )).rejects.toThrow("pre-restore frozen value")
  })

  test("rejects loose or linked screenshots and tampered final PNG bytes", async () => {
    const loose = await setup()
    chmodSync(loose.screenshots[0]!, 0o644)
    await expect(writeH3HumanObservationEvidence(
      loose.authorityRoot, "/verified/raw-candidate.zip", loose.authoritySha256, loose.inputPath, loose.outputRoot, loose.dependencies,
    )).rejects.toThrow("owner-only")

    rmSync(root, { recursive: true, force: true })
    const linked = await setup()
    linkSync(linked.screenshots[0]!, join(root, "extra-hardlink.png"))
    await expect(writeH3HumanObservationEvidence(
      linked.authorityRoot, "/verified/raw-candidate.zip", linked.authoritySha256, linked.inputPath, linked.outputRoot, linked.dependencies,
    )).rejects.toThrow("owner-only")

    rmSync(root, { recursive: true, force: true })
    const sealed = await setup()
    await writeH3HumanObservationEvidence(
      sealed.authorityRoot, "/verified/raw-candidate.zip", sealed.authoritySha256, sealed.inputPath, sealed.outputRoot, sealed.dependencies,
    )
    const sealedPng = join(sealed.outputRoot, "screenshots", "CraftVisible.png")
    const bytes = readFileSync(sealedPng)
    bytes[findChunk(bytes, "IDAT").dataStart] ^= 1
    writeFileSync(sealedPng, bytes, { mode: 0o600 })
    await expect(verifyH3HumanObservationEvidence(
      sealed.outputRoot, sealed.authorityRoot, "/verified/raw-candidate.zip", sealed.authoritySha256, sealed.dependencies,
    )).rejects.toThrow(/bad PNG CRC|differs/)
  })

  test("cannot verify against a hand-written canonical post-install JSON without the authenticated closure", async () => {
    const fixture = await setup()
    await writeH3HumanObservationEvidence(
      fixture.authorityRoot, "/verified/raw-candidate.zip", fixture.authoritySha256, fixture.inputPath, fixture.outputRoot, fixture.dependencies,
    )
    rmSync(join(fixture.authorityRoot, "post-install-authority.json"))
    await expect(verifyH3HumanObservationEvidence(
      fixture.outputRoot, fixture.authorityRoot, "/verified/raw-candidate.zip", fixture.authoritySha256, fixture.dependencies,
    )).rejects.toThrow()
  })

  test("strict evidence validator rejects missing Stage-1 authority hashes", async () => {
    const fixture = await setup()
    const result = await writeH3HumanObservationEvidence(
      fixture.authorityRoot, "/verified/raw-candidate.zip", fixture.authoritySha256, fixture.inputPath, fixture.outputRoot, fixture.dependencies,
    )
    const authority = { ...result.evidence.authority } as Record<string, unknown>
    delete authority.postInstallAuthoritySha256
    expect(() => validateH3HumanObservationEvidence({ ...result.evidence, authority })).toThrow("keys differ")
  })
})
