import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
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

type ZipVariant = "safe" | "unsafe-path" | "encrypted" | "oversized" | "huge-directory" | "unsupported"
  | "safe-symlink" | "symlink-escape" | "symlink-parent"

function fixtureRoot(): string {
  root = realpathSync(mkdtempSync(join(tmpdir(), "macos-release-preflight-")))
  return root
}

function makeZip(variant: ZipVariant): string {
  const directory = root ?? fixtureRoot()
  const archive = join(directory, `${variant}.zip`)
  const source = String.raw`
import stat, struct, sys, zipfile
archive, variant = sys.argv[1:]
compression = zipfile.ZIP_BZIP2 if variant == "unsupported" else zipfile.ZIP_DEFLATED
name = "../escape" if variant == "unsafe-path" else "Simulator.app/Contents/MacOS/Simulator"
with zipfile.ZipFile(archive, "w", compression=compression) as output:
    if variant in {"safe-symlink", "symlink-escape", "symlink-parent"}:
        link = zipfile.ZipInfo("Simulator.app/Versions/Current" if variant == "safe-symlink" else "Simulator.app/Contents")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        output.writestr(link, b"A" if variant == "safe-symlink" else b"/tmp" if variant == "symlink-escape" else b"RealContents")
        if variant == "safe-symlink":
            output.writestr("Simulator.app/Versions/A/app", b"app")
        if variant == "symlink-parent":
            output.writestr(name, b"app")
    else:
        output.writestr(name, b"app")
if variant in {"encrypted", "oversized", "huge-directory"}:
    data = bytearray(open(archive, "rb").read())
    local = data.index(bytes.fromhex("504b0304"))
    central = data.index(bytes.fromhex("504b0102"))
    eocd = data.rindex(bytes.fromhex("504b0506"))
    if variant == "encrypted":
        struct.pack_into("<H", data, local + 6, struct.unpack_from("<H", data, local + 6)[0] | 1)
        struct.pack_into("<H", data, central + 8, struct.unpack_from("<H", data, central + 8)[0] | 1)
    elif variant == "oversized":
        struct.pack_into("<I", data, local + 22, 0x90000000)
        struct.pack_into("<I", data, central + 24, 0x90000000)
    else:
        struct.pack_into("<H", data, eocd + 8, 0xffff)
        struct.pack_into("<H", data, eocd + 10, 0xffff)
    open(archive, "wb").write(data)
`
  const result = spawnSync("python3", ["-c", source, archive, variant], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr)
  return archive
}

function preflight(mode: "dmg" | "zip" | "tree" | "container-tree", path: string) {
  return spawnSync("python3", [
    join(import.meta.dir, "preflight-macos-release-artifact.py"),
    mode,
    path,
  ], { encoding: "utf8" })
}

describe("macOS release artifact resource preflight", () => {
  test("accepts a bounded DMG, ZIP, and app tree", () => {
    const directory = fixtureRoot()
    const dmg = join(directory, "Simulator-arm64.dmg")
    writeFileSync(dmg, "dmg")
    const zip = makeZip("safe")
    const app = join(directory, "Simulator.app")
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true })
    writeFileSync(join(app, "Contents", "MacOS", "Simulator"), "app")
    symlinkSync("MacOS", join(app, "Contents", "Current"))

    expect(preflight("dmg", dmg).status).toBe(0)
    const zipResult = preflight("zip", zip)
    expect(zipResult.status).toBe(0)
    expect(JSON.parse(zipResult.stdout)).toMatchObject({ ok: true, kind: "zip", entries: 1, expandedBytes: 3 })
    expect(preflight("zip", makeZip("safe-symlink")).status).toBe(0)
    expect(preflight("tree", app).status).toBe(0)
  })

  test.each([
    ["unsafe-path", /unsafe/],
    ["encrypted", /encrypted/],
    ["oversized", /expanded-size/],
    ["huge-directory", /ZIP64|entry count/],
    ["unsupported", /unsupported/],
    ["symlink-escape", /symlink target escapes/],
    ["symlink-parent", /traverses a non-directory/],
  ] as const)("rejects %s ZIP input", (variant, message) => {
    fixtureRoot()
    const result = preflight("zip", makeZip(variant))
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(message)
  })

  test("rejects empty, symlinked, and hard-linked archives", () => {
    const directory = fixtureRoot()
    const empty = join(directory, "empty.dmg")
    writeFileSync(empty, "")
    expect(preflight("dmg", empty).status).toBe(1)

    const archive = makeZip("safe")
    const alias = join(directory, "alias.zip")
    symlinkSync(archive, alias)
    expect(preflight("zip", alias).status).toBe(1)

    const hardlink = join(directory, "hardlink.zip")
    linkSync(archive, hardlink)
    expect(preflight("zip", archive).status).toBe(1)
  })

  test("rejects an app-tree symlink that escapes its root", () => {
    const directory = fixtureRoot()
    const app = join(directory, "Simulator.app")
    mkdirSync(app)
    symlinkSync("/tmp", join(app, "escape"))
    const result = preflight("tree", app)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("unsafe symlink")
    expect(preflight("container-tree", app).status).toBe(0)
  })

  test("rejects hard-linked regular files in an app tree", () => {
    const directory = fixtureRoot()
    const app = join(directory, "Simulator.app")
    mkdirSync(app)
    writeFileSync(join(app, "binary"), "app")
    linkSync(join(app, "binary"), join(app, "binary-alias"))
    const result = preflight("tree", app)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("hard-linked")
  })
})
