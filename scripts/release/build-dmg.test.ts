import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const script = readFileSync(join(import.meta.dir, "../../apps/electron/scripts/build-dmg.sh"), "utf8")

describe("DMG packaging", () => {
  test("explicitly disables electron-builder publication", () => {
    expect(script).toContain('BUILDER_ARGS=(--mac "--${ARCH}" --publish never)')
    expect(script).toContain('npx electron-builder "${BUILDER_ARGS[@]}"')
  })

  test("forces signed and unsigned builds to strip crash ingest and disable updates", () => {
    expect(script).toContain('PUBLIC_PRIVACY_SENTINEL="SIMULATOR_PUBLIC_BUILD_MUST_STRIP_CRASH_INGEST_2026"')
    expect(script).toContain('export SENTRY_ELECTRON_INGEST_URL="$PUBLIC_PRIVACY_SENTINEL"')
    expect(script).toContain("export SIMULATOR_PUBLIC_BUILD=1")
    expect(script).toContain("export SIMULATOR_DISABLE_UPDATES=1")
    expect(script).toContain('verify-public-build-privacy.ts')
    expect(script).toContain('APP_ROOT="$ELECTRON_DIR/release/mac-arm64/Simulator.app"')
    expect(script).toContain('APP_ROOT="$ELECTRON_DIR/release/mac/Simulator.app"')

    const publicEnvironment = script.indexOf('export SIMULATOR_PUBLIC_BUILD=1')
    const build = script.indexOf('bun run electron:build')
    const packagedApp = script.indexOf('require_path "$APP_ROOT" "app bundle"')
    const privacyVerification = script.indexOf('bun "$ROOT_DIR/scripts/release/verify-public-build-privacy.ts"')
    expect(publicEnvironment).toBeGreaterThan(-1)
    expect(publicEnvironment).toBeLessThan(build)
    expect(script.match(/bun run electron:build/g)).toHaveLength(1)
    expect(privacyVerification).toBeGreaterThan(packagedApp)
    expect(script.match(/verify-public-build-privacy\.ts/g)).toHaveLength(1)
    expect(script).not.toContain(
      'if [ "$UNSIGNED" = true ]; then\n    bun "$ROOT_DIR/scripts/release/verify-public-build-privacy.ts"',
    )
  })

  test("prevents unsigned builds from importing signing or notarization credentials", () => {
    expect(script).toContain("export CSC_IDENTITY_AUTO_DISCOVERY=false")
    expect(script).toContain("unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME CSC_KEYCHAIN")
    expect(script).toContain("unset CSC_INSTALLER_LINK CSC_INSTALLER_KEY_PASSWORD")
    expect(script).toContain("unset APPLE_SIGNING_IDENTITY APPLE_ID APPLE_TEAM_ID APPLE_APP_SPECIFIC_PASSWORD")
    expect(script).toContain("unset APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER")
    expect(script).toContain("unset APPLE_KEYCHAIN APPLE_KEYCHAIN_PROFILE")
    const credentialCleanup = script.indexOf("unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME CSC_KEYCHAIN")
    expect(credentialCleanup).toBeGreaterThan(-1)
    expect(credentialCleanup).toBeLessThan(script.indexOf("bun install --frozen-lockfile"))
    expect(credentialCleanup).toBeLessThan(script.indexOf('npx electron-builder "${BUILDER_ARGS[@]}"'))
  })

  test("verifies packaged Pi and session server resources before accepting the app", () => {
    expect(script).toContain('bun "$ELECTRON_DIR/scripts/validate-assets.ts" --packaged-app "$APP_ROOT"')
    expect(script).toContain('bun "$ROOT_DIR/scripts/packaged-server-resources.ts" --app "$APP_ROOT"')
    expect(script.indexOf('validate-assets.ts')).toBeLessThan(script.indexOf('packaged-server-resources.ts'))
    expect(script.indexOf('packaged-server-resources.ts')).toBeLessThan(script.indexOf('verify-public-build-privacy.ts'))
  })

  test("stages and independently reference-verifies pinned arm64 Bun and uv", () => {
    expect(script).toContain('"$ROOT_DIR/scripts/release/stage-pinned-macos-arm64-runtimes.sh"')
    expect(script).toContain('"$ROOT_DIR/scripts/release/verify-packaged-macos-runtimes.sh" "$APP_ROOT"')
    expect(script.indexOf("stage-pinned-macos-arm64-runtimes.sh")).toBeLessThan(
      script.indexOf("bun run electron:build"),
    )
    expect(script.indexOf('npx electron-builder "${BUILDER_ARGS[@]}"')).toBeLessThan(
      script.indexOf("verify-packaged-macos-runtimes.sh"),
    )
  })
})
