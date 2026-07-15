import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const script = readFileSync(join(import.meta.dir, "../../apps/electron/scripts/build-dmg.sh"), "utf8")

describe("DMG packaging", () => {
  test("explicitly disables electron-builder publication", () => {
    expect(script).toContain('BUILDER_ARGS=(--mac "--${ARCH}" --publish never)')
    expect(script).toContain('npx electron-builder "${BUILDER_ARGS[@]}"')
  })

  test("forces unsigned builds to strip crash ingest and disable updates", () => {
    expect(script).toContain('PUBLIC_PRIVACY_SENTINEL="SIMULATOR_PUBLIC_BUILD_MUST_STRIP_CRASH_INGEST_2026"')
    expect(script).toContain('SENTRY_ELECTRON_INGEST_URL="$PUBLIC_PRIVACY_SENTINEL"')
    expect(script).toContain("SIMULATOR_PUBLIC_BUILD=1")
    expect(script).toContain("SIMULATOR_DISABLE_UPDATES=1")
    expect(script).toContain('verify-public-build-privacy.ts')
    expect(script).toContain('APP_ROOT="$ELECTRON_DIR/release/mac-arm64/Simulator.app"')
    expect(script).toContain('APP_ROOT="$ELECTRON_DIR/release/mac/Simulator.app"')
  })

  test("verifies packaged Pi and session server resources before accepting the app", () => {
    expect(script).toContain('bun "$ROOT_DIR/scripts/packaged-server-resources.ts" --app "$APP_ROOT"')
    expect(script.indexOf('packaged-server-resources.ts')).toBeLessThan(script.indexOf('verify-public-build-privacy.ts'))
  })
})
