import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const script = readFileSync(join(import.meta.dir, "verify-and-bundle-macos.sh"), "utf8")

describe("macOS RC bundle verification", () => {
  test("rejects updater metadata in the release, mounted DMG, and extracted ZIP roots", () => {
    expect(script).toContain("assert_no_updater_metadata \"$RELEASE_DIR\" \"release directory\"")
    expect(script).toContain("assert_no_updater_metadata \"$MOUNT\" \"DMG mount root\"")
    expect(script).toContain("assert_no_updater_metadata \"$UNZIP\" \"ZIP extraction root\"")
    expect(script).toContain("-iname 'latest*.yaml'")
    expect(script).toContain("-iname '*.blockmap'")
  })

  test("compares complete filesystem inventories while retaining a file-only SPDX input", () => {
    expect(script).toContain("write-app-inventory.py")
    expect(script).toContain("dmg-app-inventory.jsonl")
    expect(script).toContain("zip-app-inventory.jsonl")
    expect(script).toContain("app-inventory.jsonl")
    expect(script).toContain("packaged-files.sha256")
    expect(script).toContain("package-verification-code.txt")
  })

  test("uses lstat to reject symlinked app roots and critical app paths", () => {
    expect(script).toContain("os.lstat(path)")
    expect(script).toContain('assert_lstat_type "$app" "directory" "app bundle root"')
    expect(script).toContain('assert_lstat_type "$app/Contents" "directory" "app Contents directory"')
    expect(script).toContain('assert_lstat_type "$plist" "regular file" "Info.plist"')
    expect(script).toContain('assert_lstat_type "$app/Contents/MacOS" "directory" "app MacOS directory"')
    expect(script).toContain('assert_lstat_type "$executable" "regular file" "app executable"')
    expect(script).toContain('[[ "$executable_name" != */*')
  })
})
