import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { basename, join, resolve } from "node:path"

interface BuildPolicy {
  readonly schemaVersion: 1
  readonly updatesDisabled: boolean
}

export interface PublicBuildPrivacyVerification {
  readonly scannedFiles: number
  readonly forbiddenMatches: readonly string[]
  readonly updatesDisabled: true
}

function parseBuildPolicy(appRoot: string): BuildPolicy {
  const path = join(appRoot, "Contents", "Resources", "app", "dist", "resources", "build-policy.json")
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<BuildPolicy>
  if (value.schemaVersion !== 1 || value.updatesDisabled !== true) {
    throw new Error(`Public build must carry an updates-disabled build policy: ${path}`)
  }
  return { schemaVersion: 1, updatesDisabled: true }
}

export function verifyPublicBuildPrivacy(
  appRoot: string,
  forbiddenValues: readonly string[],
): PublicBuildPrivacyVerification {
  const requestedRoot = resolve(appRoot)
  const rootStat = lstatSync(requestedRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`App root must be a real directory: ${requestedRoot}`)
  }
  const trustedRoot = realpathSync(requestedRoot)
  parseBuildPolicy(trustedRoot)

  const needles = [...new Set(forbiddenValues.filter((value) => value.length > 0))].map((value) => ({
    text: value,
    bytes: Buffer.from(value),
  }))
  const forbiddenMatches: string[] = []
  let scannedFiles = 0

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        visit(path)
        continue
      }
      if (!stat.isFile()) continue
      scannedFiles += 1
      const contents = readFileSync(path)
      for (const needle of needles) {
        if (contents.indexOf(needle.bytes) !== -1) {
          forbiddenMatches.push(`${path}: ${needle.text}`)
        }
      }
    }
  }
  visit(trustedRoot)

  forbiddenMatches.sort()
  if (forbiddenMatches.length > 0) {
    throw new Error(`Public build contains forbidden embedded values:\n${forbiddenMatches.join("\n")}`)
  }
  return { scannedFiles, forbiddenMatches, updatesDisabled: true }
}

if (import.meta.main) {
  const [appRoot, ...forbiddenValues] = process.argv.slice(2)
  if (!appRoot || forbiddenValues.length === 0) {
    throw new Error(`Usage: ${basename(process.argv[1])} APP_ROOT FORBIDDEN_VALUE [...]`)
  }
  console.log(JSON.stringify(verifyPublicBuildPrivacy(appRoot, forbiddenValues), null, 2))
}
