import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

type FixtureVariant = "safe" | "extra" | "missing" | "duplicate" | "traversal" | "backslash" | "symlink"
  | "unsupported" | "encrypted" | "zero" | "oversized" | "huge-directory"

const PRE_FILES = [
  "RELEASE_NOTES.md",
  "SHA256SUMS",
  "Simulator-arm64.dmg",
  "Simulator-arm64.zip",
  "app-inventory.jsonl",
  "bundle-metadata.json",
  "dmg-app-inventory.raw.jsonl",
  "dmg-signatures.json",
  "package-verification-code.txt",
  "packaged-files.sha256",
  "rc-validation.json",
  "sbom.spdx.json",
  "transport-normalization-policy.json",
  "verification-input.json",
  "zip-app-inventory.raw.jsonl",
  "zip-signatures.json",
] as const

const SIGNED_HOST_PRE_FILES = [
  "Simulator-arm64.dmg",
  "Simulator-arm64.zip",
  "app-notarization.json",
  "dmg-notarization.json",
  "dmg-signatures.json",
  "h3-human-observation-v1.schema.json",
  "h3-post-install-authority-v1.schema.json",
  "h3-post-install-v1.schema.json",
  "payload-equivalence.json",
  "signed-host-manifest.json",
  "signed-host-provenance.json",
  "zip-signatures.json",
] as const
const SIGNED_HOST_FINAL_FILES = [
  "SHA256SUMS",
  ...SIGNED_HOST_PRE_FILES,
  "attestations/provenance.sigstore.json",
] as const
const OPEN_DESIGN_ACCEPTANCE_FILES = [
  "SHA256SUMS",
  "open-design-rc-acceptance-evidence.json",
  "open-design-rc-acceptance-intake.json",
] as const

function fixture(variant: FixtureVariant) {
  root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-rc-extractor-")))
  const archive = join(root, "artifact.zip")
  const destination = join(root, "output")
  mkdirSync(destination)
  chmodSync(destination, 0o700)
  const source = String.raw`
import stat, sys, zipfile
archive, variant = sys.argv[1:]
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
    output.writestr("Simulator-arm64.dmg", b"" if variant == "zero" else b"dmg",
                    compress_type=zipfile.ZIP_BZIP2 if variant == "unsupported" else zipfile.ZIP_DEFLATED)
    if variant == "traversal": output.writestr("../escape", b"escape")
    elif variant == "backslash": output.writestr(r"folder\\escape", b"escape")
    if variant == "symlink":
        info = zipfile.ZipInfo("Simulator-arm64.zip")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        output.writestr(info, b"Simulator-arm64.dmg")
    elif variant != "missing" and variant not in {"traversal", "backslash"}:
        output.writestr("Simulator-arm64.zip", b"zip")
    if variant == "extra": output.writestr("extra.txt", b"extra")
    if variant == "duplicate": output.writestr("Simulator-arm64.dmg", b"duplicate")
if variant in {"encrypted", "oversized", "huge-directory"}:
    import struct
    data = bytearray(open(archive, "rb").read())
    local = data.index(bytes.fromhex("504b0304"))
    central = data.index(bytes.fromhex("504b0102"))
    eocd = data.rindex(bytes.fromhex("504b0506"))
    if variant == "encrypted":
        struct.pack_into("<H", data, local + 6, struct.unpack_from("<H", data, local + 6)[0] | 1)
        struct.pack_into("<H", data, central + 8, struct.unpack_from("<H", data, central + 8)[0] | 1)
    elif variant == "oversized":
        struct.pack_into("<I", data, local + 22, 0x60000000)
        struct.pack_into("<I", data, central + 24, 0x60000000)
    else:
        struct.pack_into("<H", data, eocd + 8, 0xffff)
        struct.pack_into("<H", data, eocd + 10, 0xffff)
    open(archive, "wb").write(data)
`
  const created = spawnSync("python3", ["-c", source, archive, variant], { encoding: "utf8" })
  if (created.status !== 0) throw new Error(created.stderr)
  return { archive, destination }
}

function extract(archive: string, destination: string, phase: "input" | "pre" | "final" | "zip-sbom" | "signed-host-pre" | "signed-host-final" | "open-design-acceptance" = "input") {
  return spawnSync("python3", [
    join(import.meta.dir, "extract-engineering-rc-artifact.py"),
    phase,
    archive,
    destination,
  ], { encoding: "utf8" })
}

function closureFixture(phase: "pre" | "final" | "zip-sbom" | "signed-host-pre" | "signed-host-final" | "open-design-acceptance") {
  root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-rc-extractor-closure-")))
  const archive = join(root, `${phase}.zip`)
  const destination = join(root, "output")
  mkdirSync(destination)
  chmodSync(destination, 0o700)
  const files = phase === "final"
    ? [...PRE_FILES, "attestations/provenance.sigstore.json", "attestations/sbom.sigstore.json"]
    : phase === "zip-sbom"
      ? ["package-verification-code.txt", "packaged-files.sha256", "sbom.spdx.json", "zip-sbom-lineage.json"]
      : phase === "signed-host-pre"
        ? [...SIGNED_HOST_PRE_FILES]
        : phase === "signed-host-final"
          ? [...SIGNED_HOST_FINAL_FILES]
          : phase === "open-design-acceptance"
            ? [...OPEN_DESIGN_ACCEPTANCE_FILES]
            : [...PRE_FILES]
  const source = String.raw`
import json, stat, sys, zipfile
archive, phase, files_json = sys.argv[1:]
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
    for name in json.loads(files_json): output.writestr(name, b"evidence")
`
  const created = spawnSync("python3", ["-c", source, archive, phase, JSON.stringify(files)], { encoding: "utf8" })
  if (created.status !== 0) throw new Error(created.stderr)
  return { archive, destination }
}

describe("Engineering RC raw artifact extractor", () => {
  test("extracts only the exact owner-only DMG and ZIP input", () => {
    const { archive, destination } = fixture("safe")
    const result = extract(archive, destination)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, phase: "input", files: 2, directories: 0 })
    for (const name of ["Simulator-arm64.dmg", "Simulator-arm64.zip"]) {
      expect(statSync(join(destination, name)).mode & 0o777).toBe(0o600)
    }
  })

  test.each(["pre", "final"] as const)("extracts the exact %s evidence closure", (phase) => {
    const { archive, destination } = closureFixture(phase)
    const result = extract(archive, destination, phase)
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      phase,
      files: phase === "final" ? 18 : 16,
      directories: 0,
    })
    expect(statSync(join(destination, "Simulator-arm64.dmg")).mode & 0o777).toBe(0o600)
    if (phase === "final") expect(statSync(join(destination, "attestations")).mode & 0o777).toBe(0o700)
  })

  test("extracts the exact independent ZIP SBOM closure", () => {
    const { archive, destination } = closureFixture("zip-sbom")
    const result = extract(archive, destination, "zip-sbom")
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      phase: "zip-sbom",
      files: 4,
      directories: 0,
    })
  })

  test("extracts the exact signed Host pre-attestation closure", () => {
    const { archive, destination } = closureFixture("signed-host-pre")
    const result = extract(archive, destination, "signed-host-pre")
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      phase: "signed-host-pre",
      files: SIGNED_HOST_PRE_FILES.length,
      directories: 0,
    })
  })

  test("extracts the exact final signed Host closure", () => {
    const { archive, destination } = closureFixture("signed-host-final")
    const result = extract(archive, destination, "signed-host-final")
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      phase: "signed-host-final",
      files: SIGNED_HOST_FINAL_FILES.length,
      directories: 0,
    })
    expect(statSync(join(destination, "attestations")).mode & 0o777).toBe(0o700)
    expect(statSync(join(destination, "SHA256SUMS")).mode & 0o777).toBe(0o600)
  })

  test("extracts the exact final OpenDesign acceptance closure", () => {
    const { archive, destination } = closureFixture("open-design-acceptance")
    const result = extract(archive, destination, "open-design-acceptance")
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      phase: "open-design-acceptance",
      files: OPEN_DESIGN_ACCEPTANCE_FILES.length,
      directories: 0,
    })
    expect(statSync(join(destination, "SHA256SUMS")).mode & 0o777).toBe(0o600)
  })

  test.each([
    "extra", "missing", "duplicate", "traversal", "backslash", "symlink", "unsupported",
    "encrypted", "zero", "oversized", "huge-directory",
  ] as const)(
    "rejects %s members",
    (variant) => {
      const { archive, destination } = fixture(variant)
      const result = extract(archive, destination)
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/closure|duplicate|encrypted|entry count|size limit|unexpected|unsafe|non-regular|unsupported|ZIP64/)
    },
  )

  test("rejects a destination that is not owner-only", () => {
    const { archive, destination } = fixture("safe")
    chmodSync(destination, 0o755)
    const result = extract(archive, destination)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("owner-only")
  })

  test("rejects a non-empty or symlinked destination", () => {
    const { archive, destination } = fixture("safe")
    writeFileSync(join(destination, "existing"), "existing")
    expect(extract(archive, destination).status).toBe(1)

    rmSync(destination, { recursive: true })
    symlinkSync(root!, destination)
    expect(extract(archive, destination).status).toBe(1)
  })

  test("rejects an empty, symlinked, or hard-linked raw archive", () => {
    const { archive, destination } = fixture("safe")
    const empty = join(root!, "empty.zip")
    writeFileSync(empty, "")
    expect(extract(empty, destination).status).toBe(1)

    const alias = join(root!, "alias.zip")
    symlinkSync(archive, alias)
    expect(extract(alias, destination).status).toBe(1)

    const hardlink = join(root!, "hardlink.zip")
    linkSync(archive, hardlink)
    expect(extract(archive, destination).status).toBe(1)
  })
})
