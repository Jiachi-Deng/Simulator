import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function hash(algorithm: "sha1" | "sha256", content: string): string {
  return createHash(algorithm).update(content).digest("hex")
}

function fixture(extraRoot = false) {
  root = realpathSync(mkdtempSync(join(tmpdir(), "zip-spdx-evidence-")))
  const archive = join(root, "Simulator-arm64.zip")
  const checksums = join(root, "packaged-files.sha256")
  const code = join(root, "package-verification-code.txt")
  const source = String.raw`
import stat, sys, zipfile
archive, extra = sys.argv[1:]
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
    output.writestr("Simulator.app/", b"")
    output.writestr("Simulator.app/Contents/a.txt", b"alpha")
    output.writestr("Simulator.app/Contents/b.txt", b"beta")
    link = zipfile.ZipInfo("Simulator.app/Contents/current")
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    output.writestr(link, b"a.txt")
    if extra == "true": output.writestr("outside.txt", b"outside")
`
  const generated = spawnSync("python3", ["-c", source, archive, String(extraRoot)], { encoding: "utf8" })
  if (generated.status !== 0) throw new Error(generated.stderr)
  const files = [["Contents/a.txt", "alpha"], ["Contents/b.txt", "beta"]] as const
  writeFileSync(checksums, files.map(([path, content]) => `${hash("sha256", content)}  ${path}\n`).join(""))
  writeFileSync(code, `${hash("sha1", files.map(([, content]) => hash("sha1", content)).sort().join(""))}\n`)
  return { archive, checksums, code }
}

function verify(paths: ReturnType<typeof fixture>) {
  return spawnSync("python3", [
    join(import.meta.dir, "verify-zip-spdx-evidence.py"), "verify", paths.archive, paths.checksums, paths.code,
  ], { encoding: "utf8" })
}

describe("original ZIP SPDX derivation", () => {
  test("accepts exact regular-file checksums and package verification code", () => {
    const result = verify(fixture())
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, regularFiles: 2 })
  })

  test("derives owner-only canonical evidence into an empty destination", () => {
    const paths = fixture()
    const destination = join(root!, "derived")
    const created = spawnSync("mkdir", ["-m", "700", destination])
    expect(created.status).toBe(0)
    const result = spawnSync("python3", [
      join(import.meta.dir, "verify-zip-spdx-evidence.py"), "derive", paths.archive, destination,
    ], { encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(readFileSync(join(destination, "packaged-files.sha256"), "utf8"))
      .toBe(readFileSync(paths.checksums, "utf8"))
    expect(readFileSync(join(destination, "package-verification-code.txt"), "utf8"))
      .toBe(readFileSync(paths.code, "utf8"))
  })

  test("rejects a stale file checksum or package verification code", () => {
    const paths = fixture()
    const originalChecksums = readFileSync(paths.checksums, "utf8")
    writeFileSync(paths.checksums, originalChecksums.replace(/[0-9a-f]/, "f"))
    expect(verify(paths).stderr).toContain("does not derive")
    writeFileSync(paths.checksums, originalChecksums)
    writeFileSync(paths.code, `${"0".repeat(40)}\n`)
    expect(verify(paths).stderr).toContain("verification code does not derive")
  })

  test("rejects payload outside the exact Simulator.app ZIP root", () => {
    const result = verify(fixture(true))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("outside Simulator.app")
  })
})
