import { lstatSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { sign } from "@electron/osx-sign"

export interface SignEngineeringRcMacOsAppOptions {
  app: string
  identity: string
  teamId: string
  keychain: string
  entitlements: string
}

export function validateSignEngineeringRcOptions(options: SignEngineeringRcMacOsAppOptions): SignEngineeringRcMacOsAppOptions {
  if (!options.identity.startsWith("Developer ID Application: ") || !options.identity.endsWith(`(${options.teamId})`)) {
    throw new Error("Identity must be the exact parameterized Developer ID Application subject")
  }
  if (!/^[A-Z0-9]{10}$/.test(options.teamId)) throw new Error("Team ID must be 10 uppercase letters or digits")
  for (const [label, input, type] of [
    ["App", options.app, "directory"],
    ["Keychain", options.keychain, "file"],
    ["Entitlements", options.entitlements, "file"],
  ] as const) {
    const path = resolve(input)
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink() || (type === "directory" ? !metadata.isDirectory() : !metadata.isFile())) {
      throw new Error(`${label} must be a real ${type}`)
    }
    if (realpathSync(path) !== path) throw new Error(`${label} path must not traverse aliases or symlinks`)
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error(`${label} must be owned by the current runner user`)
    }
    if (type === "file" && metadata.nlink !== 1) throw new Error(`${label} must not be hard linked`)
    if (label === "Keychain" && (metadata.mode & 0o077) !== 0) {
      throw new Error("Keychain must be owner-only")
    }
  }
  return options
}

export async function signEngineeringRcMacOsApp(options: SignEngineeringRcMacOsAppOptions): Promise<void> {
  validateSignEngineeringRcOptions(options)
  await sign({
    app: realpathSync(resolve(options.app)),
    identity: options.identity,
    keychain: realpathSync(resolve(options.keychain)),
    platform: "darwin",
    identityValidation: true,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
    optionsForFile: () => ({
      entitlements: realpathSync(resolve(options.entitlements)),
      hardenedRuntime: true,
    }),
  })
}

if (import.meta.main) {
  const [app, identity, teamId, keychain, entitlements, ...extra] = process.argv.slice(2)
  if (!app || !identity || !teamId || !keychain || !entitlements || extra.length > 0) {
    throw new Error("Usage: sign-engineering-rc-macos-app.ts APP IDENTITY TEAM_ID KEYCHAIN ENTITLEMENTS")
  }
  await signEngineeringRcMacOsApp({ app, identity, teamId, keychain, entitlements })
  console.log(JSON.stringify({ ok: true }))
}
