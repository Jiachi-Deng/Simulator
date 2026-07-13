import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const script = readFileSync(join(import.meta.dir, "../../apps/electron/scripts/build-dmg.sh"), "utf8")

describe("DMG packaging", () => {
  test("explicitly disables electron-builder publication", () => {
    expect(script).toContain('BUILDER_ARGS=(--mac "--${ARCH}" --publish never)')
    expect(script).toContain('npx electron-builder "${BUILDER_ARGS[@]}"')
  })
})
