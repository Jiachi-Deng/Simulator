import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"

const script = readFileSync(join(import.meta.dir, "package-stapled-macos-host.sh"), "utf8")
const builder = parse(readFileSync(join(import.meta.dir, "..", "..", "apps", "electron", "electron-builder.yml"), "utf8")) as Record<string, any>

describe("stapled macOS Host transport packaging", () => {
  test("requires a parameterized Developer ID identity and verifies the stapled app before packaging", () => {
    expect(script).toContain('[[ "$AUTHORITY" == "Developer ID Application: "* ]]')
    expect(script).toContain('[[ "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]')
    expect(script).toContain("--mode developer-id")
    expect(script).toContain('xcrun stapler validate "$APP"')
    expect(script).toContain('spctl --assess --type execute --verbose=4 "$APP"')
  })

  test("uses prepackaged mode and proves it did not mutate app signature evidence", () => {
    expect(script).toContain('--prepackaged "$APP"')
    expect(script).toContain("--mac dmg zip --arm64 --publish never")
    expect(script.match(/verify-macos-signatures\.ts/g)).toHaveLength(2)
    expect(script).toContain('cmp -s "$before" "$after"')
    expect(script.match(/compare-macos-app-payloads\.py" exact-tree/g)).toHaveLength(2)
    expect(script).toContain('cmp -s "$before_tree" "$after_tree"')
    expect(script).toContain("CSC_IDENTITY_AUTO_DISCOVERY=false")
    expect(script).toContain('"$ROOT_DIR/node_modules/.bin/electron-builder"')
  })

  test("builds in private scratch and copies an exact DMG/ZIP closure using configured names", () => {
    expect(script).toContain('[[ ! -e "$OUTPUT" ]]')
    expect(script).toContain('mkdir -m 700 "$OUTPUT"')
    expect(script).toContain('BUILD_OUTPUT="$WORK/electron-builder-output"')
    expect(script).toContain('--config.directories.output="$BUILD_OUTPUT"')
    expect(script).toContain('Simulator-arm64.dmg')
    expect(script).toContain('Simulator-arm64.zip')
    expect(builder.mac.artifactName).toBe("Simulator-${arch}.${ext}")
    expect(builder.dmg.artifactName).toBe("Simulator-${arch}.dmg")
    expect(builder.mac.target).toEqual(["dmg", "zip"])
    expect(script).toContain('hdiutil verify "$OUTPUT/Simulator-arm64.dmg"')
    const dmgPreflight = script.indexOf('preflight-macos-release-artifact.py" dmg "$source"')
    const zipPreflight = script.indexOf('preflight-macos-release-artifact.py" zip "$source"')
    const artifactCopy = script.indexOf('cp "$source" "$OUTPUT/$artifact"')
    expect(dmgPreflight).toBeGreaterThanOrEqual(0)
    expect(dmgPreflight).toBeLessThan(artifactCopy)
    expect(zipPreflight).toBeGreaterThanOrEqual(0)
    expect(zipPreflight).toBeLessThan(artifactCopy)
  })
})
