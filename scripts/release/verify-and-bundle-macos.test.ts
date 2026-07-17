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

  test("bounds both release containers before native parsing and both app trees before recursive verification", () => {
    const dmgPreflight = 'preflight-macos-release-artifact.py" dmg "$DMG"'
    const zipPreflight = 'preflight-macos-release-artifact.py" zip "$ZIP"'
    expect(script).toContain(dmgPreflight)
    expect(script).toContain(zipPreflight)
    expect(script.indexOf(dmgPreflight)).toBeLessThan(script.indexOf('hdiutil verify "$DMG"'))
    expect(script.indexOf(zipPreflight)).toBeLessThan(script.indexOf('ditto -x -k "$ZIP"'))
    expect(script.indexOf('container-tree "$RELEASE_DIR"')).toBeLessThan(
      script.indexOf('assert_no_updater_metadata "$RELEASE_DIR"'),
    )
    expect(script.indexOf('container-tree "$MOUNT"')).toBeLessThan(
      script.indexOf('assert_no_updater_metadata "$MOUNT"'),
    )
    expect(script.indexOf('container-tree "$UNZIP"')).toBeLessThan(
      script.indexOf('assert_no_updater_metadata "$UNZIP"'),
    )
    expect(script.match(/preflight-macos-release-artifact\.py" tree/g)).toHaveLength(2)
    expect(script).toContain('verify-macos-container-root.py" dmg "$MOUNT"')
    expect(script).toContain('verify-macos-container-root.py" zip "$UNZIP"')
    expect(script.indexOf('preflight-macos-release-artifact.py" tree')).toBeLessThan(
      script.indexOf('verify_app "$DMG_APP"'),
    )
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
    expect(script).toContain('WORK=$(cd "$WORK" && pwd -P)')
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

  test("binds the packaged Electron manifest, main entry, and arm64 executable without launching the GUI as a CLI", () => {
    expect(script).toContain('verify-packaged-electron-identity.ts" "$app" "$VERSION"')
    expect(script).toContain('verify-macos-signatures.ts" "$app" "Contents/MacOS/$executable_name"')
    expect(script).not.toContain("--version")
  })

  test("fails closed when packaged Pi or session server resources are incomplete", () => {
    expect(script).toContain('bun "$SCRIPT_DIR/../packaged-server-resources.ts" --app "$app"')
  })

  test("binds packaged Bun and uv to independently reference-signed pinned inputs", () => {
    expect(script).toContain('"$SCRIPT_DIR/verify-packaged-macos-runtimes.sh" "$app"')
    expect(script.indexOf("verify-packaged-macos-runtimes.sh")).toBeLessThan(
      script.indexOf("verify-macos-signatures.ts"),
    )
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

  test("creates a new owner-only output instead of clearing an existing path", () => {
    expect(script).toContain('[[ ! -e "$BUNDLE_DIR" ]]')
    expect(script).toContain('mkdir -m 700 "$BUNDLE_DIR"')
    expect(script).not.toContain('rm -rf "$BUNDLE_DIR"')
  })
})
