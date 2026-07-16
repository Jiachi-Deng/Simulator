import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const script = readFileSync(join(import.meta.dir, "verify-and-bundle-macos.sh"), "utf8")
const inventoryWriter = readFileSync(join(import.meta.dir, "write-app-inventory.py"), "utf8")

describe("macOS RC bundle verification", () => {
  test("rejects updater metadata in the release, mounted DMG, and extracted ZIP roots", () => {
    expect(script).toContain("assert_no_updater_metadata \"$RELEASE_DIR\" \"release directory\"")
    expect(script).toContain("assert_no_updater_metadata \"$MOUNT\" \"DMG mount root\"")
    expect(script).toContain("assert_no_updater_metadata \"$UNZIP\" \"ZIP extraction root\"")
    expect(script).toContain("-iname 'latest*.yaml'")
    expect(script).toContain("-iname '*.blockmap'")
  })

  test("compares canonical filesystem inventories while retaining raw forensic inventories and a file-only SPDX input", () => {
    expect(script).toContain("write-app-inventory.py")
    expect(script).toContain("dmg-app-inventory.jsonl")
    expect(script).toContain("zip-app-inventory.jsonl")
    expect(script).toContain("app-inventory.jsonl")
    expect(script).toContain("dmg-app-inventory.raw.jsonl")
    expect(script).toContain("zip-app-inventory.raw.jsonl")
    expect(script).toContain("dmg-signatures.json")
    expect(script).toContain("zip-signatures.json")
    expect(script).toContain("transport-normalization-policy.json")
    expect(script).toContain("unsigned-or-strictly-verified-adhoc")
    expect(readFileSync(join(import.meta.dir, "verify-macos-signatures.ts"), "utf8")).toContain("objects: SignatureObjectEvidence[]")
    expect(script).toContain("--raw-inventory")
    expect(script).toContain("--transport-canonicalization-policy macos-dmg-zip-v1")
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

  test("requires both macOS bundle version fields to remain the Host product version", () => {
    expect(script).toContain("Print :CFBundleShortVersionString")
    expect(script).toContain("Print :CFBundleVersion")
    expect(script.match(/== \"\$VERSION\"/g)).toHaveLength(2)
  })

  test("fails closed when packaged Pi or session server resources are incomplete", () => {
    expect(script).toContain('bun "$SCRIPT_DIR/../packaged-server-resources.ts" --app "$app"')
  })

  test("keeps the transport xattr allowlist and scope synchronized with the inventory writer", () => {
    for (const name of [
      "com.apple.cs.CodeDirectory",
      "com.apple.cs.CodeRequirements",
      "com.apple.cs.CodeRequirements-1",
      "com.apple.cs.CodeSignature",
    ]) {
      expect(script).toContain(name)
      expect(inventoryWriter).toContain(name)
    }
    expect(script).toContain('"ignoredExtendedAttributeScope": "non-executable regular files only"')
    expect(inventoryWriter).toContain('raw_entry["type"] == "file" and mode & 0o111 == 0')
  })
})
