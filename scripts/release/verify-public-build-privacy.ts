import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs"
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

function readStableRegularFile(path: string): Buffer {
  const pathBefore = lstatSync(path)
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw new Error(`Packaged privacy input must be a regular file: ${path}`)
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(descriptor)
    const contents = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    const pathAfter = lstatSync(path)
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || pathBefore.dev !== pathAfter.dev
      || pathBefore.ino !== pathAfter.ino
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino
    ) {
      throw new Error(`Packaged privacy input changed during verification: ${path}`)
    }
    return contents
  } finally {
    closeSync(descriptor)
  }
}

function parseBuildPolicy(contentRoot: string): BuildPolicy {
  const path = join(contentRoot, "resources", "build-policy.json")
  const value = JSON.parse(readStableRegularFile(path).toString("utf8")) as Partial<BuildPolicy>
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
  const contentRoot = join(trustedRoot, "Contents", "Resources", "app", "dist")
  const contentStat = lstatSync(contentRoot)
  if (!contentStat.isDirectory() || contentStat.isSymbolicLink() || realpathSync(contentRoot) !== contentRoot) {
    throw new Error(`Packaged dist root must be a real directory: ${contentRoot}`)
  }
  parseBuildPolicy(contentRoot)

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
      if (stat.isSymbolicLink()) {
        throw new Error(`Packaged dist must not contain symlinks: ${path}`)
      }
      if (stat.isDirectory()) {
        if (realpathSync(path) !== path) throw new Error(`Packaged dist directory changed during verification: ${path}`)
        visit(path)
        continue
      }
      if (!stat.isFile()) continue
      scannedFiles += 1
      const contents = readStableRegularFile(path)
      for (const needle of needles) {
        if (contents.indexOf(needle.bytes) !== -1) {
          forbiddenMatches.push(`${path}: ${needle.text}`)
        }
      }
    }
  }
  visit(contentRoot)

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
