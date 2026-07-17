import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const stage = readFileSync(join(import.meta.dir, "stage-pinned-macos-arm64-runtimes.sh"), "utf8")
const build = readFileSync(join(import.meta.dir, "../../apps/electron/scripts/build-dmg.sh"), "utf8")

describe("pinned macOS arm64 packaged runtime staging", () => {
  test("pins both transport archives and raw executable identities", () => {
    for (const value of [
      "82034e87c9d9b4398ea619aee2eed5d2a68c8157e9a6ae2d1052d84d533ccd8d",
      "14b0008f960ea480de5d25df5ea0ada0fefa086a15e360ef2d305f44cae8f904",
      "3993249d8f51deaf34cfce037e57e294e82267ff1f9dc45b7983a17afaf065b4",
      "240a5881367c38cbdfac25cad5d8cff2459a730339225e9373028d4453bebe05",
      'BUN_ASSET_BYTES="22289708"',
      'BUN_BINARY_BYTES="60953744"',
      'UV_ASSET_BYTES="19303315"',
      'UV_BINARY_BYTES="44269216"',
      "1.3.10+30e609e08",
      "uv 0.10.6 (a91bcf268 2026-02-24)",
    ]) expect(stage).toContain(value)
    expect(stage).not.toContain("SHASUMS256.txt")
    expect(stage).not.toContain(".sha256\"")
  })

  test("validates exact archive closure before extracting", () => {
    const bunHash = stage.indexOf('printf \'%s  %s\\n\' "$expected_sha256"')
    const bunExtract = stage.indexOf('ditto -x -k "$bun_archive"')
    const uvHash = stage.indexOf('download_exact "$UV_ASSET_URL"')
    const uvExtract = stage.indexOf('tar -xzf "$uv_archive"')
    expect(bunHash).toBeGreaterThan(-1)
    expect(bunHash).toBeLessThan(bunExtract)
    expect(stage).toContain("bun-darwin-aarch64/bun")
    expect(stage).toContain("uv-aarch64-apple-darwin/uvx")
    expect(stage).toContain('member.isdir()')
    expect(stage).toContain('member.isfile()')
    expect(uvHash).toBeLessThan(uvExtract)
  })

  test("stages the same trusted inputs consumed by the arm64 packager", () => {
    expect(stage).toContain('BUN_TARGET="$ELECTRON_DIR/vendor/bun/bun"')
    expect(stage).toContain('UV_TARGET="$ELECTRON_DIR/resources/bin/darwin-arm64/uv"')
    expect(stage).toContain('bun_source="${TRUSTED_BUN:-}"')
    expect(build).toContain('"$ROOT_DIR/scripts/release/stage-pinned-macos-arm64-runtimes.sh"')
    expect(build.indexOf("stage-pinned-macos-arm64-runtimes.sh")).toBeLessThan(
      build.indexOf("bun run electron:build"),
    )
  })
})
