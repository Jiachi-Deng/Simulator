import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const BUILD_POLICY_RELATIVE_PATH = "Contents/Resources/app/dist/resources/build-policy.json"

export function validateUpdatesDisabledMarker(
  envValue: string | undefined,
  markerContent: string | null = null,
  requirePackagedMarker = false,
): string[] {
  const errors: string[] = []
  if (envValue !== "1") errors.push("SIMULATOR_DISABLE_UPDATES must equal 1")
  if (!requirePackagedMarker) return errors
  if (markerContent === null) {
    errors.push(`Packaged marker is missing: ${BUILD_POLICY_RELATIVE_PATH}`)
    return errors
  }

  let marker: unknown
  try {
    marker = JSON.parse(markerContent)
  } catch {
    errors.push(`Packaged marker is malformed JSON: ${BUILD_POLICY_RELATIVE_PATH}`)
    return errors
  }

  const keys = marker && typeof marker === "object" && !Array.isArray(marker)
    ? Object.keys(marker).sort()
    : []
  const record = marker as Record<string, unknown> | null
  if (
    !record
    || keys.length !== 2
    || keys[0] !== "schemaVersion"
    || keys[1] !== "updatesDisabled"
    || record.schemaVersion !== 1
    || record.updatesDisabled !== true
  ) {
    errors.push("Packaged build policy must exactly equal {schemaVersion:1, updatesDisabled:true}")
  }
  return errors
}

function packagedMarker(appPath: string): string | null {
  const path = join(appPath, BUILD_POLICY_RELATIVE_PATH)
  return existsSync(path) ? readFileSync(path, "utf8") : null
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const appIndex = args.indexOf("--app")
  const appPath = appIndex >= 0 ? args[appIndex + 1] : undefined
  if (appIndex >= 0 && !appPath) throw new Error("--app requires an app path")
  const markerContent = appPath ? packagedMarker(appPath) : null
  const errors = validateUpdatesDisabledMarker(process.env.SIMULATOR_DISABLE_UPDATES, markerContent, Boolean(appPath))
  console.log(JSON.stringify({
    ok: errors.length === 0,
    environment: process.env.SIMULATOR_DISABLE_UPDATES ?? null,
    markerPath: appPath ? join(appPath, BUILD_POLICY_RELATIVE_PATH) : null,
    errors,
  }, null, 2))
  process.exit(errors.length ? 1 : 0)
}
