import { afterEach, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { updaterLeaks } from "./verify-bundle-policy"

const root = join(import.meta.dir, ".tmp-bundle-policy")
afterEach(() => rmSync(root, { recursive: true, force: true }))

test("rejects updater manifest leakage deterministically", () => {
  mkdirSync(join(root, "nested"), { recursive: true })
  writeFileSync(join(root, "Simulator-arm64.dmg"), "artifact")
  writeFileSync(join(root, "latest-mac.yml"), "updater")
  writeFileSync(join(root, "nested", "Simulator.zip.blockmap"), "updater")
  expect(updaterLeaks(root)).toEqual([
    join(root, "latest-mac.yml"),
    join(root, "nested", "Simulator.zip.blockmap"),
  ])
})
