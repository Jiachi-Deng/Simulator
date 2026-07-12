import { spawnSync } from "node:child_process"
import { join } from "node:path"

export function validateUpdatesDisabledMarker(envValue: string | undefined, plistValue?: string): string[] {
  const errors: string[] = []
  if (envValue !== "1") errors.push("SIMULATOR_UPDATES_DISABLED must equal 1")
  if (plistValue !== undefined && plistValue !== "true" && plistValue !== "1") {
    errors.push("Info.plist SimulatorUpdatesDisabled must be true")
  }
  return errors
}

function plistMarker(appPath: string): string {
  const plist = join(appPath, "Contents", "Info.plist")
  const result = spawnSync("plutil", ["-extract", "SimulatorUpdatesDisabled", "raw", "-o", "-", plist], { encoding: "utf8" })
  if (result.status !== 0) return "<missing>"
  return result.stdout.trim()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const appIndex = args.indexOf("--app")
  const plistValue = appIndex >= 0 && args[appIndex + 1] ? plistMarker(args[appIndex + 1]) : undefined
  const errors = validateUpdatesDisabledMarker(process.env.SIMULATOR_UPDATES_DISABLED, plistValue)
  console.log(JSON.stringify({ ok: errors.length === 0, environment: process.env.SIMULATOR_UPDATES_DISABLED ?? null, plistMarker: plistValue ?? null, errors }, null, 2))
  process.exit(errors.length ? 1 : 0)
}
